const { randomUUID } = require("node:crypto");

const { resampleLinear } = require("../../helpers/speakerEmbeddings");
const { DUAL_SELF_PROFILE_POLICY } = require("./VoiceEnrollmentService");

const CAPTURE_SAMPLE_RATE = 24_000;
const EMBEDDING_SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = 10;
const WINDOW_SAMPLES = CAPTURE_SAMPLE_RATE * WINDOW_SECONDS;
const GAP_SAMPLES = Math.round(CAPTURE_SAMPLE_RATE * 0.2);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeEmbedding(value, dimension) {
  if (!(value instanceof Float32Array) || value.length !== dimension) return null;
  let squared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) return null;
    squared += item * item;
  }
  if (!Number.isFinite(squared) || squared <= 0) return null;
  const norm = Math.sqrt(squared);
  return Float32Array.from(value, (item) => item / norm);
}

function normalizedCentroid(embeddings, dimension) {
  const sum = new Float32Array(dimension);
  for (const embedding of embeddings) {
    for (let index = 0; index < dimension; index += 1) sum[index] += embedding[index];
  }
  const result = normalizeEmbedding(sum, dimension);
  sum.fill(0);
  return result;
}

function cosine(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return Math.max(-1, Math.min(1, value));
}

function parseTurnGroups(turnGroups) {
  if (!Array.isArray(turnGroups) || turnGroups.length !== 3) {
    throw new TypeError("historical recovery requires exactly three turn groups");
  }
  const seen = new Set();
  return turnGroups.map((group) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 3) {
      throw new TypeError("each historical recovery group requires one to three turns");
    }
    return group.map((turnId) => {
      if (typeof turnId !== "string" || !SAFE_ID.test(turnId)) {
        throw new TypeError("historical recovery turn id is invalid");
      }
      if (seen.has(turnId)) throw new TypeError("historical recovery turns must be unique");
      seen.add(turnId);
      return turnId;
    });
  });
}

function assertSafeTurn(turn) {
  if (
    !turn ||
    turn.sourceType !== "mic" ||
    typeof turn.micDeviceId !== "string" ||
    turn.micDeviceId.length === 0 ||
    turn.overlapDetected === true ||
    turn.echoDetected === true ||
    turn.excludedFromCentroid === true ||
    !Number.isSafeInteger(turn.startMs) ||
    !Number.isSafeInteger(turn.endMs) ||
    turn.endMs <= turn.startMs ||
    !turn.chunk
  ) {
    throw new Error("historical voice evidence is not safe");
  }
  return turn;
}

function pcm16Segment(pcm, turn) {
  if (
    !pcm ||
    !Buffer.isBuffer(pcm.bytes) ||
    !Number.isSafeInteger(pcm.sampleRate) ||
    pcm.sampleRate <= 0 ||
    !Number.isSafeInteger(pcm.channels) ||
    pcm.channels <= 0
  ) {
    throw new TypeError("historical PCM evidence is invalid");
  }
  const relativeStartMs = turn.startMs - turn.chunk.started_at;
  const relativeEndMs = turn.endMs - turn.chunk.started_at;
  if (relativeStartMs < 0 || relativeEndMs <= relativeStartMs) {
    throw new Error("historical voice evidence falls outside its chunk");
  }
  const frameCount = Math.floor(pcm.bytes.length / (pcm.channels * 2));
  const startFrame = Math.max(0, Math.round((relativeStartMs * pcm.sampleRate) / 1_000));
  const endFrame = Math.min(frameCount, Math.round((relativeEndMs * pcm.sampleRate) / 1_000));
  if (endFrame <= startFrame) throw new Error("historical voice evidence is empty");
  const samples = new Float32Array(endFrame - startFrame);
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < pcm.channels; channel += 1) {
      sum += pcm.bytes.readInt16LE((frame * pcm.channels + channel) * 2) / 32_768;
    }
    samples[frame - startFrame] = sum / pcm.channels;
  }
  if (pcm.sampleRate === CAPTURE_SAMPLE_RATE) return samples;
  const resampled = resampleLinear(samples, pcm.sampleRate, CAPTURE_SAMPLE_RATE);
  samples.fill(0);
  return resampled;
}

function composeWindow(segments) {
  const contentSamples =
    segments.reduce((total, segment) => total + segment.length, 0) +
    Math.max(0, segments.length - 1) * GAP_SAMPLES;
  if (contentSamples > WINDOW_SAMPLES) {
    throw new Error("historical recovery group exceeds ten seconds");
  }
  const output = new Float32Array(WINDOW_SAMPLES);
  let offset = WINDOW_SAMPLES - contentSamples;
  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.length + GAP_SAMPLES;
  }
  return output;
}

class HistoricalSelfVoiceRecoveryService {
  constructor({
    repository,
    audioEvidenceReader,
    primarySpeakerEmbeddings,
    reviewSpeakerEmbeddings,
    speechDurationMeasurer,
    voiceProfileStore,
    createSessionId = () => `historical-${randomUUID()}`,
  } = {}) {
    if (!repository || typeof repository.getHistoricalVoiceTurn !== "function") {
      throw new TypeError("repository.getHistoricalVoiceTurn is required");
    }
    if (!audioEvidenceReader || typeof audioEvidenceReader.readVerifiedPcm !== "function") {
      throw new TypeError("audioEvidenceReader.readVerifiedPcm is required");
    }
    for (const [name, runtime] of [
      ["primary", primarySpeakerEmbeddings],
      ["review", reviewSpeakerEmbeddings],
    ]) {
      if (!runtime || typeof runtime.extractEmbeddingFromSamples !== "function") {
        throw new TypeError(`${name} speaker embedding runtime is required`);
      }
    }
    if (!speechDurationMeasurer || typeof speechDurationMeasurer.measureSpeechMs !== "function") {
      throw new TypeError("speechDurationMeasurer is required");
    }
    if (
      !voiceProfileStore ||
      typeof voiceProfileStore.getDualStatus !== "function" ||
      typeof voiceProfileStore.saveDualEnrollment !== "function"
    ) {
      throw new TypeError("voiceProfileStore dual persistence is required");
    }
    if (typeof createSessionId !== "function") throw new TypeError("createSessionId is required");
    this.repository = repository;
    this.audioEvidenceReader = audioEvidenceReader;
    this.primarySpeakerEmbeddings = primarySpeakerEmbeddings;
    this.reviewSpeakerEmbeddings = reviewSpeakerEmbeddings;
    this.speechDurationMeasurer = speechDurationMeasurer;
    this.voiceProfileStore = voiceProfileStore;
    this.createSessionId = createSessionId;
  }

  async recover({ turnGroups } = {}) {
    if (this.voiceProfileStore.getDualStatus().enrolled) {
      return { status: "already_enrolled" };
    }
    const groups = parseTurnGroups(turnGroups);
    const windows = [];
    const sessionId = this.createSessionId();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("historical recovery session id is invalid");
    }
    try {
      for (const group of groups) {
        const segments = [];
        try {
          for (const turnId of group) {
            const turn = assertSafeTurn(this.repository.getHistoricalVoiceTurn(turnId));
            const pcm = await this.audioEvidenceReader.readVerifiedPcm(turn.chunk);
            try {
              segments.push(pcm16Segment(pcm, turn));
            } finally {
              pcm?.bytes?.fill?.(0);
            }
          }
          windows.push(composeWindow(segments));
        } finally {
          for (const segment of segments) segment.fill(0);
        }
      }

      const sampleSpeechMs = [];
      const modelEntries = [
        {
          role: "primary",
          policy: DUAL_SELF_PROFILE_POLICY.primary,
          runtime: this.primarySpeakerEmbeddings,
          samples: [],
        },
        {
          role: "review",
          policy: DUAL_SELF_PROFILE_POLICY.review,
          runtime: this.reviewSpeakerEmbeddings,
          samples: [],
        },
      ];
      const centroids = [];
      try {
        for (const [windowIndex, window] of windows.entries()) {
          sampleSpeechMs.push(
            await this.speechDurationMeasurer.measureSpeechMs({
              sessionId,
              windowIndex,
              sampleRate: CAPTURE_SAMPLE_RATE,
              samples: window,
            })
          );
          const downsampled = resampleLinear(window, CAPTURE_SAMPLE_RATE, EMBEDDING_SAMPLE_RATE);
          try {
            for (const entry of modelEntries) {
              const raw = await entry.runtime.extractEmbeddingFromSamples(downsampled);
              if (raw === null || raw === undefined) {
                return { status: "model_error" };
              }
              try {
                const normalized = normalizeEmbedding(raw, entry.policy.embeddingDimension);
                if (!normalized) return { status: "model_error" };
                entry.samples.push(normalized);
              } finally {
                raw.fill(0);
              }
            }
          } finally {
            downsampled.fill(0);
          }
        }
        const acceptedSpeechMs = sampleSpeechMs.reduce((sum, value) => sum + value, 0);
        if (
          sampleSpeechMs.some(
            (value) =>
              !Number.isSafeInteger(value) ||
              value < DUAL_SELF_PROFILE_POLICY.minimumSpeechMsPerWindow
          ) ||
          acceptedSpeechMs < DUAL_SELF_PROFILE_POLICY.minimumSpeechMs
        ) {
          return { status: "insufficient_speech", sampleSpeechMs, acceptedSpeechMs };
        }
        const models = [];
        for (const entry of modelEntries) {
          const centroid = normalizedCentroid(entry.samples, entry.policy.embeddingDimension);
          if (!centroid) return { status: "model_error" };
          centroids.push(centroid);
          const selfConsistency = Math.min(
            ...entry.samples.map((sample) => cosine(sample, centroid))
          );
          if (
            !Number.isFinite(selfConsistency) ||
            selfConsistency < DUAL_SELF_PROFILE_POLICY.minimumSelfConsistency
          ) {
            return { status: "inconsistent_samples", sampleSpeechMs, acceptedSpeechMs };
          }
          models.push({
            role: entry.role,
            modelId: entry.policy.modelId,
            embeddingSpace: entry.policy.embeddingSpace,
            samples: entry.samples,
            centroid,
            selfConsistency,
          });
        }
        this.voiceProfileStore.saveDualEnrollment({
          policyId: DUAL_SELF_PROFILE_POLICY.policyId,
          models,
          sampleSpeechMs,
          acceptedSpeechMs,
          windowCount: windows.length,
        });
        return {
          status: "accepted",
          sampleSpeechMs,
          acceptedSpeechMs,
          selfConsistency: Math.min(...models.map((model) => model.selfConsistency)),
          turnGroups: groups,
        };
      } finally {
        for (const entry of modelEntries) {
          for (const sample of entry.samples) sample.fill(0);
        }
        for (const centroid of centroids) centroid.fill(0);
      }
    } finally {
      for (const window of windows) window.fill(0);
    }
  }
}

module.exports = HistoricalSelfVoiceRecoveryService;
module.exports.composeWindow = composeWindow;
module.exports.pcm16Segment = pcm16Segment;
