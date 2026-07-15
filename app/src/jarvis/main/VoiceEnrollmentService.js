const { randomUUID } = require("node:crypto");
const { SPEAKER_EMBEDDING_MODEL_ID } = require("../../helpers/speakerEmbeddings");

const CAPTURE_SAMPLE_RATE = 24_000;
const EMBEDDING_SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "float32";
const TARGET_DURATION_SECONDS = 32;
const MIN_CAPTURE_SECONDS = 30;
const MAX_CAPTURE_SECONDS = 34;
const REQUIRED_WINDOWS = 3;
const WINDOW_SECONDS = 10;
const DEFAULT_SESSION_TTL_MS = 120_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const EXPECTED_EMBEDDING_DIMENSION = 512;
const MIN_REAL_CAPTURE_MS = MIN_CAPTURE_SECONDS * 1_000;
// Source identifier in the legacy speaker_profiles database only.
const SELF_VOICE_PROFILE_ID = -1;

const SELF_PROFILE_POLICY = Object.freeze({
  modelId: SPEAKER_EMBEDDING_MODEL_ID,
  minimumSpeechMs: 30_000,
  minimumWindows: 3,
  minimumSelfConsistency: 0.78,
});

function result(status, acceptedSpeechMs = 0, windowCount = 0, selfConsistency = null) {
  return {
    status,
    modelId: SELF_PROFILE_POLICY.modelId,
    acceptedSpeechMs,
    windowCount,
    selfConsistency,
  };
}

function requireOwnerId(ownerId) {
  if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
    throw new TypeError("renderer owner id is required");
  }
  return ownerId;
}

function downsampleForEmbedding(samples) {
  const outputLength = Math.floor((samples.length * EMBEDDING_SAMPLE_RATE) / CAPTURE_SAMPLE_RATE);
  const output = new Float32Array(outputLength);
  const ratio = CAPTURE_SAMPLE_RATE / EMBEDDING_SAMPLE_RATE;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("voice enrollment payload is required");
  }
  if (
    payload.sampleRate !== CAPTURE_SAMPLE_RATE ||
    payload.channels !== CHANNELS ||
    payload.format !== SAMPLE_FORMAT
  ) {
    throw new TypeError("voice enrollment requires 24 kHz mono Float32 PCM");
  }
  if (
    !Number.isSafeInteger(payload.recordedSampleCount) ||
    payload.recordedSampleCount < CAPTURE_SAMPLE_RATE * MIN_CAPTURE_SECONDS ||
    payload.recordedSampleCount > CAPTURE_SAMPLE_RATE * MAX_CAPTURE_SECONDS
  ) {
    throw new RangeError("voice enrollment capture must be approximately 32 seconds");
  }
  if (!Array.isArray(payload.windows) || payload.windows.length !== REQUIRED_WINDOWS) {
    throw new TypeError("voice enrollment requires exactly three sample windows");
  }
  const requiredWindowSamples = CAPTURE_SAMPLE_RATE * WINDOW_SECONDS;
  const windows = payload.windows
    .map((window, index) => {
      if (!window || typeof window !== "object") {
        throw new TypeError(`sample window ${index + 1} is required`);
      }
      const { startSample, endSample, samples } = window;
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)) {
        throw new TypeError("sample window boundaries must be safe integers");
      }
      if (!(samples instanceof Float32Array) || samples.length !== requiredWindowSamples) {
        throw new TypeError("each voice enrollment window must contain exactly ten seconds");
      }
      if (
        startSample < 0 ||
        endSample <= startSample ||
        endSample - startSample !== samples.length ||
        endSample > payload.recordedSampleCount
      ) {
        throw new TypeError("sample window boundaries must match the guided capture");
      }
      for (const sample of samples) {
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
          throw new TypeError("voice enrollment samples must be finite normalized PCM");
        }
      }
      return { startSample, endSample, samples };
    })
    .sort((left, right) => left.startSample - right.startSample);
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].startSample < windows[index - 1].endSample) {
      throw new TypeError("voice enrollment sample windows must not overlap");
    }
  }
  return windows;
}

function normalizeEmbedding(value) {
  if (!(value instanceof Float32Array) || value.length !== EXPECTED_EMBEDDING_DIMENSION) {
    return null;
  }
  let normSquared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) return null;
    normSquared += item * item;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) return null;
  const norm = Math.sqrt(normSquared);
  const normalized = new Float32Array(value.length);
  for (let index = 0; index < value.length; index += 1) normalized[index] = value[index] / norm;
  return normalized;
}

function normalizedCentroid(embeddings) {
  const centroid = new Float32Array(EXPECTED_EMBEDDING_DIMENSION);
  for (const embedding of embeddings) {
    for (let index = 0; index < centroid.length; index += 1) centroid[index] += embedding[index];
  }
  return normalizeEmbedding(centroid);
}

function cosineSimilarity(left, right) {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return Math.max(-1, Math.min(1, dot));
}

function zeroPayloadSamples(payload) {
  if (!Array.isArray(payload?.windows)) return;
  for (const entry of payload.windows) {
    if (entry?.samples instanceof Float32Array) entry.samples.fill(0);
  }
}

class VoiceEnrollmentService {
  constructor({
    speakerEmbeddings,
    speechDurationMeasurer,
    voiceProfileStore,
    createId = randomUUID,
    now = Date.now,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    maxActiveSessions = DEFAULT_MAX_ACTIVE_SESSIONS,
  }) {
    if (!speakerEmbeddings || typeof speakerEmbeddings.extractEmbeddingFromSamples !== "function") {
      throw new TypeError("speakerEmbeddings is required");
    }
    if (!speechDurationMeasurer || typeof speechDurationMeasurer.measureSpeechMs !== "function") {
      throw new TypeError("speechDurationMeasurer is required");
    }
    if (
      !voiceProfileStore ||
      typeof voiceProfileStore.getStatus !== "function" ||
      typeof voiceProfileStore.saveEnrollment !== "function"
    ) {
      throw new TypeError("voiceProfileStore is required");
    }
    if (typeof createId !== "function" || typeof now !== "function") {
      throw new TypeError("enrollment clock and id factory are required");
    }
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
      throw new TypeError("sessionTtlMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(maxActiveSessions) ||
      maxActiveSessions < 1 ||
      maxActiveSessions > 32
    ) {
      throw new TypeError("maxActiveSessions must be a safe integer between 1 and 32");
    }
    this.speakerEmbeddings = speakerEmbeddings;
    this.speechDurationMeasurer = speechDurationMeasurer;
    this.voiceProfileStore = voiceProfileStore;
    this.createId = createId;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.maxActiveSessions = maxActiveSessions;
    this.sessions = new Map();
    this.ownerSessions = new Map();
  }

  getStatus() {
    return this.voiceProfileStore.getStatus();
  }

  begin({ ownerId }) {
    const safeOwnerId = requireOwnerId(ownerId);
    const startedAt = this.now();
    this._sweepExpired(startedAt);
    if (this.ownerSessions.has(safeOwnerId))
      throw new Error("renderer already active enrollment session");
    if (this.sessions.size >= this.maxActiveSessions)
      throw new Error("voice enrollment session capacity reached");
    const sessionId = this.createId();
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new TypeError("enrollment session id must be opaque and safe");
    }
    if (this.sessions.has(sessionId)) throw new Error("enrollment session id collision");
    const expiresAt = startedAt + this.sessionTtlMs;
    this.sessions.set(sessionId, { ownerId: safeOwnerId, startedAt, expiresAt });
    this.ownerSessions.set(safeOwnerId, sessionId);
    return {
      sessionId,
      expiresAt,
      sampleRate: CAPTURE_SAMPLE_RATE,
      channels: CHANNELS,
      format: SAMPLE_FORMAT,
      targetDurationSeconds: TARGET_DURATION_SECONDS,
    };
  }

  cancel({ ownerId, sessionId }) {
    const { session } = this._resolveSession(ownerId, sessionId);
    this._deleteSession(sessionId, session);
    return { cancelled: true, expiresAt: session.expiresAt };
  }

  cancelOwner(ownerId) {
    const safeOwnerId = requireOwnerId(ownerId);
    this._sweepExpired(this.now());
    const sessionId = this.ownerSessions.get(safeOwnerId);
    if (!sessionId) return 0;
    const session = this.sessions.get(sessionId);
    if (session) this._deleteSession(sessionId, session);
    else this.ownerSessions.delete(safeOwnerId);
    return session ? 1 : 0;
  }

  async complete({ ownerId, sessionId, payload }) {
    try {
      const { session, now } = this._resolveSession(ownerId, sessionId);
      if (now - session.startedAt < MIN_REAL_CAPTURE_MS) {
        throw new Error("voice enrollment has not reached the minimum real capture duration");
      }
      this._deleteSession(sessionId, session);
      const windows = validatePayload(payload);
      const embeddings = [];
      const sampleSpeechMs = [];
      try {
        for (const [windowIndex, window] of windows.entries()) {
          const speechMs = await this.speechDurationMeasurer.measureSpeechMs({
            sessionId,
            windowIndex,
            sampleRate: CAPTURE_SAMPLE_RATE,
            samples: window.samples,
          });
          if (
            !Number.isSafeInteger(speechMs) ||
            speechMs < 0 ||
            speechMs > WINDOW_SECONDS * 1_000
          ) {
            return result("model_error");
          }
          const downsampled = downsampleForEmbedding(window.samples);
          let raw;
          try {
            raw = await this.speakerEmbeddings.extractEmbeddingFromSamples(downsampled);
          } finally {
            downsampled.fill(0);
          }
          if (raw === null || raw === undefined) continue;
          const normalized = normalizeEmbedding(raw);
          if (!normalized) return result("model_error");
          embeddings.push(normalized);
          sampleSpeechMs.push(speechMs);
        }
      } catch {
        return result("model_error");
      }
      const acceptedSpeechMs = sampleSpeechMs.reduce((sum, value) => sum + value, 0);
      if (
        embeddings.length < SELF_PROFILE_POLICY.minimumWindows ||
        acceptedSpeechMs < SELF_PROFILE_POLICY.minimumSpeechMs
      ) {
        return result("insufficient_speech", acceptedSpeechMs, embeddings.length);
      }
      const centroid = normalizedCentroid(embeddings);
      if (!centroid) return result("model_error");
      const selfConsistency = Math.min(
        ...embeddings.map((embedding) => cosineSimilarity(embedding, centroid))
      );
      if (!Number.isFinite(selfConsistency)) return result("model_error");
      if (selfConsistency < SELF_PROFILE_POLICY.minimumSelfConsistency) {
        return result("inconsistent_samples", acceptedSpeechMs, embeddings.length, selfConsistency);
      }
      this.voiceProfileStore.saveEnrollment({
        modelId: SELF_PROFILE_POLICY.modelId,
        samples: embeddings,
        centroid,
        sampleSpeechMs,
        acceptedSpeechMs,
        windowCount: embeddings.length,
        selfConsistency,
      });
      return result("accepted", acceptedSpeechMs, embeddings.length, selfConsistency);
    } finally {
      zeroPayloadSamples(payload);
    }
  }

  _resolveSession(ownerId, sessionId) {
    const safeOwnerId = requireOwnerId(ownerId);
    if (typeof sessionId !== "string" || !sessionId)
      throw new TypeError("enrollment session id is required");
    const now = this.now();
    const expired = this._sweepExpired(now);
    if (expired.has(sessionId)) throw new Error("enrollment session expired");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("unknown enrollment session");
    if (session.ownerId !== safeOwnerId)
      throw new Error("enrollment session does not belong to this renderer");
    return { session, now };
  }

  _deleteSession(sessionId, session) {
    this.sessions.delete(sessionId);
    if (this.ownerSessions.get(session.ownerId) === sessionId)
      this.ownerSessions.delete(session.ownerId);
  }

  _sweepExpired(now) {
    const expired = new Set();
    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAt) {
        expired.add(sessionId);
        this._deleteSession(sessionId, session);
      }
    }
    return expired;
  }
}

module.exports = VoiceEnrollmentService;
module.exports.CAPTURE_SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
module.exports.EXPECTED_EMBEDDING_DIMENSION = EXPECTED_EMBEDDING_DIMENSION;
module.exports.SELF_PROFILE_POLICY = SELF_PROFILE_POLICY;
module.exports.SELF_VOICE_PROFILE_ID = SELF_VOICE_PROFILE_ID;
