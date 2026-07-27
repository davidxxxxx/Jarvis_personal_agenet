const crypto = require("node:crypto");
const {
  SESSION_DIARIZATION_POLICY,
  parseDiarizationJobKey,
} = require("./SessionDiarizationPolicy");

const SHA256 = /^[0-9a-f]{64}$/;
const RAW_LABEL = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_STORED_PIPELINE_CHUNKS = 96;
const MAX_STORED_OVERLAP_WINDOWS_PER_CHUNK = 16;
const LONG_SESSION_SPEAKER_EVIDENCE_MS = 5 * 60 * 1000;
const DURABLE_SPEAKER_MIN_SPEECH_MS = 5_000;
const DURABLE_SPEAKER_MIN_WINDOWS = 3;

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

function consolidateGlobalClusters(clusters, turns, segmentLinks, policy) {
  const aliases = new Map();
  for (;;) {
    let best = null;
    for (let leftIndex = 0; leftIndex < clusters.length - 1; leftIndex += 1) {
      const left = clusters[leftIndex];
      if (!(left.centroid instanceof Float32Array)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
        const right = clusters[rightIndex];
        if (!(right.centroid instanceof Float32Array)) continue;
        const score = cosine(left.centroid, right.centroid);
        if (
          score >= policy.clusterSimilarityThreshold &&
          (!best ||
            score > best.score ||
            (score === best.score &&
              `${left.localLabel}\0${right.localLabel}` <
                `${best.left.localLabel}\0${best.right.localLabel}`))
        ) {
          best = { left, right, rightIndex, score };
        }
      }
    }
    if (!best) break;

    for (let index = 0; index < policy.embeddingDimension; index += 1) {
      best.left.sum[index] += best.right.sum[index];
    }
    best.left.windowCount += best.right.windowCount;
    best.left.speechMs += best.right.speechMs;
    best.left.memberEmbeddings.push(...best.right.memberEmbeddings);
    best.left.firstAppearanceAt = Math.min(
      best.left.firstAppearanceAt,
      best.right.firstAppearanceAt
    );
    best.left.centroid = normalizeEmbedding(best.left.sum, policy.embeddingDimension);
    aliases.set(best.right.id, best.left.id);
    clusters.splice(best.rightIndex, 1);
  }

  const canonicalClusterId = (clusterId) => {
    let canonical = clusterId;
    while (aliases.has(canonical)) canonical = aliases.get(canonical);
    return canonical;
  };
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  for (const turn of turns) {
    const canonicalId = canonicalClusterId(turn.clusterId);
    if (canonicalId === turn.clusterId) continue;
    const cluster = clustersById.get(canonicalId);
    turn.clusterId = canonicalId;
    turn.localLabel = cluster.localLabel;
  }
  const consolidatedLinks = new Map();
  for (const link of segmentLinks.values()) {
    const clusterId = canonicalClusterId(link.clusterId);
    consolidatedLinks.set(`${clusterId}\0${link.transcriptSegmentId}`, {
      clusterId,
      transcriptSegmentId: link.transcriptSegmentId,
    });
  }
  segmentLinks.clear();
  for (const [key, link] of consolidatedLinks) segmentLinks.set(key, link);
}

function summarizeSpeakerCandidates(clusters) {
  const summary = {
    total: clusters.length,
    durable: 0,
    brief: 0,
    overlapOnly: 0,
  };
  for (const cluster of clusters) {
    if (!(cluster.centroid instanceof Float32Array) || cluster.windowCount === 0) {
      summary.overlapOnly += 1;
    } else if (
      cluster.speechMs >= DURABLE_SPEAKER_MIN_SPEECH_MS &&
      cluster.windowCount >= DURABLE_SPEAKER_MIN_WINDOWS
    ) {
      summary.durable += 1;
    } else {
      summary.brief += 1;
    }
  }
  return summary;
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

function overlapsPipelineWindow(turn, metadata) {
  if (!Array.isArray(metadata?.overlapWindows)) return false;
  return metadata.overlapWindows.some(
    (window) =>
      Number.isSafeInteger(window?.startMs) &&
      Number.isSafeInteger(window?.endMs) &&
      window.startMs < turn.endMs &&
      turn.startMs < window.endMs
  );
}

function overlapsDifferentSpeaker(turn, turns) {
  return turns.some(
    (candidate) =>
      candidate !== turn &&
      candidate.rawLabel !== turn.rawLabel &&
      candidate.startMs < turn.endMs &&
      turn.startMs < candidate.endMs
  );
}

function compactPipelineChunkMetadata(metadata) {
  const overlapWindows = Array.isArray(metadata?.overlapWindows)
    ? metadata.overlapWindows
        .filter(
          (window) =>
            Number.isSafeInteger(window?.startMs) &&
            Number.isSafeInteger(window?.endMs) &&
            window.endMs > window.startMs
        )
        .slice(0, MAX_STORED_OVERLAP_WINDOWS_PER_CHUNK)
        .map((window) => ({ startMs: window.startMs, endMs: window.endMs }))
    : [];
  const overlapWindowTotal = Array.isArray(metadata?.overlapWindows)
    ? metadata.overlapWindows.length
    : 0;
  const speakerCount =
    metadata?.speakerCount && typeof metadata.speakerCount === "object"
      ? {
          minimum: metadata.speakerCount.minimum,
          maximum: metadata.speakerCount.maximum,
          preferred: metadata.speakerCount.preferred,
          confidence: metadata.speakerCount.confidence,
          state: metadata.speakerCount.state,
        }
      : null;
  const overlapSeparation =
    metadata?.overlapSeparation && typeof metadata.overlapSeparation === "object"
      ? {
          state: metadata.overlapSeparation.state,
          processed: metadata.overlapSeparation.processed,
          total: metadata.overlapSeparation.total,
        }
      : null;
  const models =
    metadata?.models && typeof metadata.models === "object"
      ? {
          primary: metadata.models.primary,
          verifier: metadata.models.verifier,
          separator: metadata.models.separator,
        }
      : null;
  return {
    chunkId: metadata.chunkId,
    chunkStartedAt: metadata.chunkStartedAt,
    schemaVersion: metadata.schemaVersion,
    stage: metadata.stage,
    pipeline: metadata.pipeline,
    executionDevice: metadata.executionDevice,
    speakerCount,
    overlapWindows,
    overlapWindowsOmitted: Math.max(0, overlapWindowTotal - overlapWindows.length),
    overlapSeparation,
    models,
    overlapCentroidExcludedTurns: metadata.overlapCentroidExcludedTurns,
  };
}

function isImportantPipelineChunk(metadata) {
  return (
    metadata?.speakerCount?.state === "models_disagree" ||
    (Array.isArray(metadata?.overlapWindows) && metadata.overlapWindows.length > 0) ||
    !["not_needed", undefined].includes(metadata?.overlapSeparation?.state) ||
    (metadata?.overlapCentroidExcludedTurns ?? 0) > 0
  );
}

function compactPipelineChunks(allChunks) {
  const indexed = allChunks.map((metadata, index) => ({ metadata, index }));
  const important = indexed.filter(({ metadata }) => isImportantPipelineChunk(metadata));
  const routine = indexed.filter(({ metadata }) => !isImportantPipelineChunk(metadata));
  const selected = [...important, ...routine]
    .slice(0, MAX_STORED_PIPELINE_CHUNKS)
    .sort((left, right) => left.index - right.index)
    .map(({ metadata }) => compactPipelineChunkMetadata(metadata));
  return {
    chunks: selected,
    chunksTotal: allChunks.length,
    chunksOmitted: Math.max(0, allChunks.length - selected.length),
    importantChunksTotal: important.length,
    importantChunksOmitted: Math.max(
      0,
      important.length - Math.min(important.length, MAX_STORED_PIPELINE_CHUNKS)
    ),
  };
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
    releaseResources = null,
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
    if (releaseResources !== null && typeof releaseResources !== "function") {
      throw new TypeError("releaseResources must be a function or null");
    }
    this.repository = repository;
    this.audioEvidenceReader = audioEvidenceReader;
    this.diarizeAudio = diarizeAudio;
    this.embedWindow = embedWindow;
    this.modelArtifactSha256 = modelArtifactSha256;
    this.policy = policy;
    this.speakerProcessingPolicy = speakerProcessingPolicy;
    this.releaseResources = releaseResources;
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
    if (existing) {
      return {
        executionDevice: existing.execution_device ?? this.policy.executionDevice ?? "cpu",
        status: "already_completed",
      };
    }
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
    const checkResources = async () => {
      if (typeof context?.checkResources !== "function") return;
      try {
        await context.checkResources();
      } catch (error) {
        await Promise.resolve(this.releaseResources?.()).catch(() => {});
        throw error;
      }
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
    const chunkPipelineMetadata = [];

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
      await checkResources();
      if (
        chunk.transcriptionResult === "no_speech" ||
        chunk.duration_ms < this.policy.minimumEmbeddingMs
      ) {
        await this.audioEvidenceReader.withVerifiedWav(chunk, async () => undefined);
        await renewLease();
        continue;
      }
      await this.audioEvidenceReader.withVerifiedWav(
        chunk,
        async (wavPath) => {
          await renewLease();
          const rawTurns = await this.diarizeAudio({
            wavPath,
            chunk,
            policy: this.policy,
            executionContext: context,
          });
          await renewLease();
          await checkResources();
          if (!Array.isArray(rawTurns)) throw codedError("DIARIZATION_INVALID_TURN");
          const rawMetadata = rawTurns.metadata;
          let storedChunkMetadata = null;
          if (rawMetadata !== undefined) {
            if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
              throw codedError("DIARIZATION_INVALID_TURN");
            }
            storedChunkMetadata = {
              chunkId: chunk.id,
              chunkStartedAt: chunk.started_at,
              ...rawMetadata,
              overlapCentroidExcludedTurns: 0,
            };
            chunkPipelineMetadata.push(storedChunkMetadata);
          }
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
            await checkResources();
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
            const overlapExcludedFromCentroid =
              this.policy.inputVersion === 2 &&
              overlapsPipelineWindow(rawTurn, rawMetadata) &&
              overlapsDifferentSpeaker(rawTurn, normalizedTurns);
            if (overlapExcludedFromCentroid && storedChunkMetadata) {
              storedChunkMetadata.overlapCentroidExcludedTurns += 1;
            }
            let cluster = localLabels.get(rawTurn.rawLabel) ?? null;
            if (!cluster) {
              let best = null;
              let bestScore = -1;
              if (!overlapExcludedFromCentroid) {
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
                    identity.evidenceRevision,
                    identity.policyId,
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

            if (!echo.excludedFromCentroid && !overlapExcludedFromCentroid) {
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
              identity.policyId,
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
              overlapExcludedFromCentroid,
              ...echo,
            });
            for (const matchedSegment of overlaps.matches) {
              segmentLinks.set(`${cluster.id}\0${matchedSegment.id}`, {
                clusterId: cluster.id,
                transcriptSegmentId: matchedSegment.id,
              });
            }
          }
        },
        { sampleRate: this.policy.sampleRate, channels: 1 }
      );
      await renewLease();
      await checkResources();
    }

    consolidateGlobalClusters(clusters, turns, segmentLinks, this.policy);
    await renewLease();
    await checkResources();
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
    const executionDevice = context?.device ?? this.policy.executionDevice ?? "cpu";
    const speakerCandidates = summarizeSpeakerCandidates(clusters);
    const trackEvidenceMs = admittedChunks.reduce(
      (total, chunk) => total + (Number.isSafeInteger(chunk.duration_ms) ? chunk.duration_ms : 0),
      0
    );
    const filterLongSessionFragments =
      this.policy.inputVersion === 2 && trackEvidenceMs >= LONG_SESSION_SPEAKER_EVIDENCE_MS;
    const finalSpeakerCount = filterLongSessionFragments
      ? speakerCandidates.durable
      : clusters.length;
    const countEvidence = chunkPipelineMetadata
      .map((metadata) => metadata.speakerCount)
      .filter(
        (count) =>
          count &&
          Number.isSafeInteger(count.minimum) &&
          Number.isSafeInteger(count.maximum) &&
          typeof count.confidence === "number"
      );
    const countConfidence =
      countEvidence.length > 0
        ? Math.min(...countEvidence.map((count) => count.confidence))
        : finalSpeakerCount === 0
          ? 1
          : 0.72;
    const speakerCount = filterLongSessionFragments
      ? {
          minimum: finalSpeakerCount,
          maximum: finalSpeakerCount,
          preferred: finalSpeakerCount,
          confidence: countConfidence,
          state:
            speakerCandidates.brief > 0 || speakerCandidates.overlapOnly > 0
              ? "evidence_filtered"
              : "models_agree",
        }
      : {
          minimum: Math.min(finalSpeakerCount, ...countEvidence.map((count) => count.minimum)),
          maximum: Math.max(finalSpeakerCount, ...countEvidence.map((count) => count.maximum)),
          preferred: finalSpeakerCount,
          confidence: countConfidence,
          state: countEvidence.some((count) => count.minimum !== count.maximum)
            ? "models_disagree"
            : countEvidence.length > 0
              ? "models_agree"
              : "primary_only",
        };
    const overlapMs = chunkPipelineMetadata.reduce(
      (total, metadata) =>
        total +
        (Array.isArray(metadata.overlapWindows)
          ? metadata.overlapWindows.reduce(
              (chunkTotal, window) =>
                chunkTotal +
                (Number.isSafeInteger(window?.startMs) && Number.isSafeInteger(window?.endMs)
                  ? Math.max(0, window.endMs - window.startMs)
                  : 0),
              0
            )
          : 0),
      0
    );
    const separationStates = chunkPipelineMetadata.map(
      (metadata) => metadata.overlapSeparation?.state ?? "not_needed"
    );
    const overlapSeparationState = separationStates.includes("failed")
      ? "failed"
      : separationStates.includes("partial") || separationStates.includes("pending")
        ? "partial"
        : separationStates.includes("completed")
          ? "completed"
          : "not_needed";
    const pipelineMetadata = {
      schemaVersion: 1,
      policyId: this.policy.policyId,
      executionDevice,
      speakerCount,
      speakerCandidates,
      overlapMs,
      overlapSeparationState,
      ...compactPipelineChunks(chunkPipelineMetadata),
    };
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
        executionDevice,
        pipelineMetadata,
        speakerCount,
        overlapMs,
        overlapSeparationState,
        modelPackVersion: this.policy.modelPackVersion ?? null,
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
      executionDevice,
      status: committed?.status === "already_completed" ? "already_completed" : "completed",
    };
  }
}

module.exports = SessionDiarizationWorker;
module.exports.normalizeEmbedding = normalizeEmbedding;
