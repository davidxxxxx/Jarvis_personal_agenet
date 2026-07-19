const crypto = require("node:crypto");
const {
  SESSION_DIARIZATION_POLICY,
  parseDiarizationJobKey,
} = require("./SessionDiarizationPolicy");

const SHA256 = /^[0-9a-f]{64}$/;
const RAW_LABEL = /^[A-Za-z0-9_.-]{1,128}$/;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deterministicId(prefix, ...parts) {
  return `${prefix}_${crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeEmbedding(value, dimension) {
  let input;
  if (value instanceof Float32Array || value instanceof Float64Array) input = value;
  else if (Array.isArray(value)) input = Float32Array.from(value);
  else if (Buffer.isBuffer(value) && value.byteLength === dimension * 4) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    input = new Float32Array(dimension);
    for (let index = 0; index < dimension; index += 1) {
      input[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    }
  } else {
    throw codedError("DIARIZATION_EMBEDDING_MISSING");
  }
  if (input.length !== dimension) {
    throw codedError("DIARIZATION_EMBEDDING_DIMENSION_MISMATCH");
  }
  let normSquared = 0;
  for (const component of input) {
    if (!Number.isFinite(component)) throw codedError("DIARIZATION_EMBEDDING_NONFINITE");
    normSquared += component * component;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw codedError("DIARIZATION_EMBEDDING_ZERO_NORM");
  }
  const norm = Math.sqrt(normSquared);
  const normalized = new Float32Array(dimension);
  for (let index = 0; index < dimension; index += 1) normalized[index] = input[index] / norm;
  return normalized;
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function normalizedTurn(raw, chunk, policy) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw codedError("DIARIZATION_INVALID_TURN");
  }
  const rawLabel = raw.speaker ?? raw.label ?? raw.rawLabel;
  if (typeof rawLabel !== "string" || !RAW_LABEL.test(rawLabel)) {
    throw codedError("DIARIZATION_INVALID_TURN");
  }
  const startMs = raw.startMs ?? raw.start * 1000;
  const endMs = raw.endMs ?? raw.end * 1000;
  const boundaryToleranceMs = Number.isSafeInteger(policy.turnBoundaryToleranceMs)
    ? policy.turnBoundaryToleranceMs
    : 0;
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > chunk.duration_ms + boundaryToleranceMs
  ) {
    throw codedError("DIARIZATION_INVALID_TURN");
  }
  const roundedStart = Math.round(startMs);
  const roundedEnd = Math.min(chunk.duration_ms, Math.round(endMs));
  if (roundedEnd <= roundedStart) {
    throw codedError("DIARIZATION_INVALID_TURN");
  }
  const rawDurationMs = roundedEnd - roundedStart;
  const embeddingDurationMs = Math.min(
    policy.maximumEmbeddingMs,
    Math.max(policy.minimumEmbeddingMs, rawDurationMs)
  );
  if (chunk.duration_ms < embeddingDurationMs) {
    throw codedError("DIARIZATION_INSUFFICIENT_AUDIO");
  }
  const centeredStart = Math.round((roundedStart + roundedEnd - embeddingDurationMs) / 2);
  const embeddingStartMs = Math.max(
    0,
    Math.min(centeredStart, chunk.duration_ms - embeddingDurationMs)
  );
  return {
    rawLabel,
    startMs: roundedStart,
    endMs: roundedEnd,
    embeddingStartMs,
    embeddingEndMs: embeddingStartMs + embeddingDurationMs,
  };
}

function overlappingSegments(segments, startedAt, endedAt) {
  let best = null;
  let bestOverlap = 0;
  const matches = [];
  for (const segment of segments) {
    const overlap = Math.max(
      0,
      Math.min(endedAt, segment.ended_at) - Math.max(startedAt, segment.started_at)
    );
    if (overlap <= 0) continue;
    matches.push(segment);
    if (overlap > bestOverlap || (overlap === bestOverlap && best && segment.id < best.id)) {
      best = segment;
      bestOverlap = overlap;
    }
  }
  return { primary: bestOverlap > 0 ? best : null, matches };
}

function echoEvidence(turn, embedding, segment, candidates, policy) {
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (
      !(candidate.embedding instanceof Float32Array) ||
      candidate.embedding.length !== embedding.length
    ) {
      continue;
    }
    if (candidate.started_at >= turn.endedAt || turn.startedAt >= candidate.ended_at) continue;
    const score = cosine(embedding, candidate.embedding);
    if (score >= policy.echoSimilarityThreshold && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const confirmedByTranscript = typeof segment?.duplicate_of === "string";
  if (confirmedByTranscript) {
    const confirmed = candidates.find(
      (candidate) => candidate.transcript_segment_id === segment.duplicate_of
    );
    return {
      echoState: "confirmed",
      duplicateOfTurnId: confirmed?.id ?? best?.id ?? null,
      excludedFromCentroid: true,
    };
  }
  if (best) {
    return {
      echoState: "possible",
      duplicateOfTurnId: best.id,
      excludedFromCentroid: false,
    };
  }
  return { echoState: "none", duplicateOfTurnId: null, excludedFromCentroid: false };
}

class SessionDiarizationWorker {
  constructor({
    repository,
    audioEvidenceReader,
    diarizeAudio,
    embedWindow,
    modelArtifactSha256,
    policy = SESSION_DIARIZATION_POLICY,
    speakerProcessingPolicy,
    clock = Date.now,
  } = {}) {
    const repositoryMethods = [
      "getDiarizationEvidenceSnapshot",
      "getDiarizationRun",
      "listDiarizationEchoCandidates",
      "commitDiarizationRun",
    ];
    if (
      !repository ||
      repositoryMethods.some((method) => typeof repository[method] !== "function")
    ) {
      throw new TypeError("repository must implement the durable diarization interface");
    }
    if (!audioEvidenceReader || typeof audioEvidenceReader.withVerifiedWav !== "function") {
      throw new TypeError("audioEvidenceReader.withVerifiedWav is required");
    }
    if (typeof diarizeAudio !== "function" || typeof embedWindow !== "function") {
      throw new TypeError("diarizeAudio and embedWindow must be functions");
    }
    if (!(
      (typeof modelArtifactSha256 === "string" && SHA256.test(modelArtifactSha256)) ||
      typeof modelArtifactSha256 === "function"
    )) {
      throw new TypeError("modelArtifactSha256 must be a digest or provider function");
    }
    if (!policy || typeof policy !== "object" || !Object.isFrozen(policy)) {
      throw new TypeError("policy must be immutable");
    }
    if (
      !speakerProcessingPolicy ||
      typeof speakerProcessingPolicy.evaluate !== "function" ||
      !Object.isFrozen(speakerProcessingPolicy)
    ) {
      throw new TypeError("speakerProcessingPolicy must be immutable and implement evaluate");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.repository = repository;
    this.audioEvidenceReader = audioEvidenceReader;
    this.diarizeAudio = diarizeAudio;
    this.embedWindow = embedWindow;
    this.modelArtifactSha256 = modelArtifactSha256;
    this.policy = policy;
    this.speakerProcessingPolicy = speakerProcessingPolicy;
    this.clock = clock;
  }

  async run(job, context = null) {
    if (!job || typeof job !== "object") throw new TypeError("job is required");
    const identity = parseDiarizationJobKey(job.input_hash);
    if (
      identity.sessionId !== job.session_id ||
      identity.trackId !== job.track_id ||
      identity.policyId !== this.policy.policyId ||
      job.model_version !== this.policy.policyId
    ) {
      throw codedError("DIARIZATION_STALE_INPUT");
    }
    const existing = this.repository.getDiarizationRun({
      sessionId: identity.sessionId,
      trackId: identity.trackId,
      evidenceRevision: identity.evidenceRevision,
      policyId: identity.policyId,
    });
    if (existing) return { executionDevice: "cpu", status: "already_completed" };
    const snapshot = this.repository.getDiarizationEvidenceSnapshot({
      sessionId: identity.sessionId,
      trackId: identity.trackId,
      at: this.clock(),
      speakerProcessingPolicy: this.speakerProcessingPolicy,
    });
    if (!snapshot.eligible) {
      throw codedError(
        snapshot.reason === "final_audio_expired"
          ? "DIARIZATION_AUDIO_EXPIRED"
          : "DIARIZATION_STALE_INPUT"
      );
    }
    if (snapshot.evidenceRevision !== identity.evidenceRevision) {
      throw codedError("DIARIZATION_SUPERSEDED");
    }
    const renewLease = async () => {
      if (typeof context?.renewLease === "function") await context.renewLease();
    };
    const modelArtifactSha256 =
      typeof this.modelArtifactSha256 === "function"
        ? await this.modelArtifactSha256()
        : this.modelArtifactSha256;
    if (typeof modelArtifactSha256 !== "string" || !SHA256.test(modelArtifactSha256)) {
      throw codedError("DIARIZATION_MODEL_ARTIFACT_INVALID");
    }

    const echoCandidates = this.repository
      .listDiarizationEchoCandidates({
        sessionId: identity.sessionId,
        excludeTrackId: identity.trackId,
        policyId: identity.policyId,
      })
      .map((candidate) => ({
        ...candidate,
        embedding: normalizeEmbedding(candidate.embedding, this.policy.embeddingDimension),
      }));
    const clusters = [];
    const turns = [];
    const segmentLinks = new Map();

    const admittedChunks = snapshot.chunks.map((entry) =>
      entry?.audioChunk
        ? {
            ...entry.audioChunk,
            transcriptionResult: entry.transcriptionResult,
            transcriptionJob: entry.latestTranscriptionJob,
            finalSegments: entry.transcriptSegments,
          }
        : entry
    );
    for (const chunk of admittedChunks) {
      await renewLease();
      if (chunk.transcriptionResult === "no_speech") {
        await this.audioEvidenceReader.withVerifiedWav(chunk, async () => undefined);
        await renewLease();
        continue;
      }
      await this.audioEvidenceReader.withVerifiedWav(chunk, async (wavPath) => {
        await renewLease();
        const rawTurns = await this.diarizeAudio({ wavPath, chunk, policy: this.policy });
        await renewLease();
        if (!Array.isArray(rawTurns)) throw codedError("DIARIZATION_INVALID_TURN");
        const normalizedTurns = rawTurns
          .map((raw) => normalizedTurn(raw, chunk, this.policy))
          .sort(
            (left, right) =>
              left.startMs - right.startMs ||
              left.endMs - right.endMs ||
              (left.rawLabel < right.rawLabel ? -1 : left.rawLabel > right.rawLabel ? 1 : 0)
          )
          .map((turn, index) => ({ ...turn, index }));
        const localLabels = new Map();
        for (let turnIndex = 0; turnIndex < normalizedTurns.length; turnIndex += 1) {
          const rawTurn = normalizedTurns[turnIndex];
          await renewLease();
          const embedding = normalizeEmbedding(
            await this.embedWindow({ wavPath, chunk, turn: rawTurn, policy: this.policy }),
            this.policy.embeddingDimension
          );
          await renewLease();
          const startedAt = chunk.started_at + rawTurn.startMs;
          const endedAt = chunk.started_at + rawTurn.endMs;
          const overlaps = overlappingSegments(chunk.finalSegments, startedAt, endedAt);
          const segment = overlaps.primary;
          const echoSegment =
            overlaps.matches.find((candidate) => typeof candidate.duplicate_of === "string") ??
            segment;
          const echo = echoEvidence(
            { startedAt, endedAt },
            embedding,
            echoSegment,
            echoCandidates,
            this.policy
          );
          let cluster = localLabels.get(rawTurn.rawLabel) ?? null;
          if (!cluster) {
            let best = null;
            let bestScore = -1;
            for (const candidate of clusters) {
              if (!(candidate.centroid instanceof Float32Array)) continue;
              const score = cosine(embedding, candidate.centroid);
              if (
                score > bestScore ||
                (score === bestScore && best && candidate.localLabel < best.localLabel)
              ) {
                best = candidate;
                bestScore = score;
              }
            }
            if (best && bestScore >= this.policy.clusterSimilarityThreshold) {
              cluster = best;
            } else {
              const localLabel = `speaker_${clusters.length + 1}`;
              cluster = {
                id: deterministicId(
                  "speaker_cluster",
                  identity.sessionId,
                  identity.trackId,
                  localLabel
                ),
                localLabel,
                sum: new Float64Array(this.policy.embeddingDimension),
                centroid: null,
                memberEmbeddings: [],
                speechMs: 0,
                windowCount: 0,
                firstAppearanceAt: chunk.started_at + rawTurn.startMs,
              };
              clusters.push(cluster);
            }
            localLabels.set(rawTurn.rawLabel, cluster);
          }

          if (!echo.excludedFromCentroid) {
            for (let index = 0; index < embedding.length; index += 1) {
              cluster.sum[index] += embedding[index];
            }
            cluster.windowCount += 1;
            cluster.speechMs += rawTurn.endMs - rawTurn.startMs;
            cluster.memberEmbeddings.push(embedding);
            cluster.centroid = normalizeEmbedding(cluster.sum, this.policy.embeddingDimension);
          }
          const id = deterministicId(
            "speaker_turn",
            identity.evidenceRevision,
            chunk.id,
            String(turnIndex)
          );
          turns.push({
            id,
            chunkId: chunk.id,
            transcriptSegmentId: segment?.id ?? null,
            turnIndex,
            rawLabel: rawTurn.rawLabel,
            localLabel: cluster.localLabel,
            clusterId: cluster.id,
            startedAt,
            endedAt,
            embedding,
            ...echo,
          });
          for (const matchedSegment of overlaps.matches) {
            segmentLinks.set(`${cluster.id}\0${matchedSegment.id}`, {
              clusterId: cluster.id,
              transcriptSegmentId: matchedSegment.id,
            });
          }
        }
      });
      await renewLease();
    }

    await renewLease();
    const precommit = this.repository.getDiarizationEvidenceSnapshot({
      sessionId: identity.sessionId,
      trackId: identity.trackId,
      at: this.clock(),
      speakerProcessingPolicy: this.speakerProcessingPolicy,
    });
    if (
      !precommit.eligible ||
      precommit.stableAudioRevision !== snapshot.stableAudioRevision ||
      precommit.transcriptRevision !== snapshot.transcriptRevision ||
      precommit.evidenceRevision !== snapshot.evidenceRevision
    ) {
      throw codedError("DIARIZATION_SUPERSEDED");
    }
    const completedAt = this.clock();
    const runId = deterministicId(
      "diarization_run",
      identity.sessionId,
      identity.trackId,
      identity.evidenceRevision,
      identity.policyId
    );
    const committed = this.repository.commitDiarizationRun({
      expectedRevision: identity.evidenceRevision,
      validatedAt: completedAt,
      speakerProcessingPolicy: this.speakerProcessingPolicy,
      run: {
        id: runId,
        sessionId: identity.sessionId,
        trackId: identity.trackId,
        evidenceRevision: identity.evidenceRevision,
        policyId: identity.policyId,
        diarizerModelId: this.policy.diarizerModelId,
        embeddingModelId: this.policy.embeddingModelId,
        modelArtifactSha256,
        embeddingDimension: this.policy.embeddingDimension,
        sampleRate: this.policy.sampleRate,
        inputVersion: this.policy.inputVersion,
        executionDevice: "cpu",
        createdAt: completedAt,
        completedAt,
      },
      clusters: clusters.map((cluster) => {
        const qualityScore =
          cluster.windowCount > 0
            ? Math.max(
                0,
                Math.min(
                  1,
                  ...cluster.memberEmbeddings.map((embedding) =>
                    cosine(embedding, cluster.centroid)
                  )
                )
              )
            : null;
        return {
          id: cluster.id,
          localLabel: cluster.localLabel,
          embedding: cluster.centroid,
          speechMs: cluster.speechMs,
          windowCount: cluster.windowCount,
          qualityScore,
          firstAppearanceAt: cluster.firstAppearanceAt,
        };
      }),
      turns,
      segmentLinks: [...segmentLinks.values()],
    });
    return {
      executionDevice: "cpu",
      status: committed?.status === "already_completed" ? "already_completed" : "completed",
    };
  }
}

module.exports = SessionDiarizationWorker;
module.exports.normalizeEmbedding = normalizeEmbedding;
