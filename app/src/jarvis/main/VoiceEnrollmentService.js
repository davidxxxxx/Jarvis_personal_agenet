const { randomUUID } = require("node:crypto");

const CAPTURE_SAMPLE_RATE = 24_000;
const EMBEDDING_SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "float32";
const TARGET_DURATION_SECONDS = 30;
const MIN_CAPTURE_SECONDS = 29;
const MAX_CAPTURE_SECONDS = 31;
const REQUIRED_WINDOWS = 3;
const MIN_WINDOW_TOTAL_SECONDS = 24;
const MAX_PAYLOAD_SECONDS = 25;
const DEFAULT_SESSION_TTL_MS = 120_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const EXPECTED_EMBEDDING_DIMENSION = 512;
const MIN_REAL_CAPTURE_MS = MIN_CAPTURE_SECONDS * 1_000;
const SELF_VOICE_PROFILE_ID = -1;

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
    throw new RangeError("voice enrollment capture must be approximately 30 seconds");
  }
  if (!Array.isArray(payload.windows) || payload.windows.length !== REQUIRED_WINDOWS) {
    throw new TypeError("voice enrollment requires exactly three sample windows");
  }

  const windows = payload.windows
    .map((window, index) => {
      if (!window || typeof window !== "object") {
        throw new TypeError(`sample window ${index + 1} is required`);
      }
      const { startSample, endSample, samples } = window;
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)) {
        throw new TypeError("sample window boundaries must be safe integers");
      }
      if (!(samples instanceof Float32Array) || samples.length === 0) {
        throw new TypeError("sample window samples must be a non-empty Float32Array");
      }
      if (
        startSample < 0 ||
        endSample <= startSample ||
        endSample - startSample !== samples.length ||
        endSample > payload.recordedSampleCount
      ) {
        throw new TypeError("sample window boundaries must match the guided capture");
      }
      return { startSample, endSample, samples };
    })
    .sort((left, right) => left.startSample - right.startSample);

  const totalSamples = windows.reduce((sum, window) => sum + window.samples.length, 0);
  if (totalSamples > CAPTURE_SAMPLE_RATE * MAX_PAYLOAD_SECONDS) {
    throw new RangeError("voice enrollment exceeds the local PCM payload cap");
  }
  if (totalSamples < CAPTURE_SAMPLE_RATE * MIN_WINDOW_TOTAL_SECONDS) {
    throw new RangeError("voice enrollment requires at least 24 seconds of speech");
  }
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].startSample < windows[index - 1].endSample) {
      throw new TypeError("voice enrollment sample windows must not overlap");
    }
  }
  for (const window of windows) {
    for (const sample of window.samples) {
      if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
        throw new TypeError("voice enrollment samples must be finite normalized PCM");
      }
    }
  }
  return windows;
}

function validateEmbedding(value, label) {
  if (!(value instanceof Float32Array) || value.length !== EXPECTED_EMBEDDING_DIMENSION) {
    throw new Error(
      `voice enrollment ${label} must contain ${EXPECTED_EMBEDDING_DIMENSION} finite Float32 values`
    );
  }
  for (const item of value) {
    if (!Number.isFinite(item)) {
      throw new Error(
        `voice enrollment ${label} must contain ${EXPECTED_EMBEDDING_DIMENSION} finite Float32 values`
      );
    }
  }
  return value;
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
    databaseManager,
    repository,
    createId = randomUUID,
    now = Date.now,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    maxActiveSessions = DEFAULT_MAX_ACTIVE_SESSIONS,
  }) {
    if (
      !speakerEmbeddings ||
      typeof speakerEmbeddings.extractEmbeddingFromSamples !== "function" ||
      typeof speakerEmbeddings.computeCentroid !== "function"
    ) {
      throw new TypeError("speakerEmbeddings is required");
    }
    if (!databaseManager || typeof databaseManager.upsertSpeakerProfile !== "function") {
      throw new TypeError("databaseManager is required");
    }
    if (!repository || typeof repository.renamePerson !== "function") {
      throw new TypeError("repository is required");
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
    this.databaseManager = databaseManager;
    this.repository = repository;
    this.createId = createId;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.maxActiveSessions = maxActiveSessions;
    this.sessions = new Map();
    this.ownerSessions = new Map();
  }

  begin({ ownerId }) {
    const safeOwnerId = requireOwnerId(ownerId);
    const startedAt = this.now();
    this._sweepExpired(startedAt);
    if (this.ownerSessions.has(safeOwnerId)) {
      throw new Error("renderer already active enrollment session");
    }
    if (this.sessions.size >= this.maxActiveSessions) {
      throw new Error("voice enrollment session capacity reached");
    }
    const sessionId = this.createId();
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new TypeError("enrollment session id must be opaque and safe");
    }
    if (this.sessions.has(sessionId)) {
      throw new Error("enrollment session id collision");
    }
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
    const { session, now } = this._resolveSession(ownerId, sessionId);
    if (now - session.startedAt < MIN_REAL_CAPTURE_MS) {
      throw new Error("voice enrollment has not reached the minimum real capture duration");
    }
    this._deleteSession(sessionId, session);
    try {
      const windows = validatePayload(payload);

      const embeddings = [];
      for (const window of windows) {
        const embedding = await this.speakerEmbeddings.extractEmbeddingFromSamples(
          downsampleForEmbedding(window.samples)
        );
        if (!(embedding instanceof Float32Array)) {
          throw new Error("voice enrollment requires three valid speech samples");
        }
        embeddings.push(validateEmbedding(embedding, "embedding"));
      }
      if (embeddings.length !== REQUIRED_WINDOWS) {
        throw new Error("voice enrollment requires three valid speech samples");
      }

      const centroid = validateEmbedding(
        this.speakerEmbeddings.computeCentroid(embeddings),
        "centroid"
      );
      const profile = this.databaseManager.upsertSpeakerProfile(
        "我",
        null,
        Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
        SELF_VOICE_PROFILE_ID
      );
      if (!profile || profile.id !== SELF_VOICE_PROFILE_ID) {
        throw new Error("database did not return the reserved self profile");
      }
      await this.repository.renamePerson({
        personId: "self",
        displayName: "我",
        isSelf: true,
        voiceProfileId: SELF_VOICE_PROFILE_ID,
      });
      return { profileId: SELF_VOICE_PROFILE_ID };
    } finally {
      zeroPayloadSamples(payload);
    }
  }

  _resolveSession(ownerId, sessionId) {
    const safeOwnerId = requireOwnerId(ownerId);
    if (typeof sessionId !== "string" || !sessionId) {
      throw new TypeError("enrollment session id is required");
    }
    const now = this.now();
    const expired = this._sweepExpired(now);
    if (expired.has(sessionId)) throw new Error("enrollment session expired");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("unknown enrollment session");
    if (session.ownerId !== safeOwnerId) {
      throw new Error("enrollment session does not belong to this renderer");
    }
    return { session, now };
  }

  _deleteSession(sessionId, session) {
    this.sessions.delete(sessionId);
    if (this.ownerSessions.get(session.ownerId) === sessionId) {
      this.ownerSessions.delete(session.ownerId);
    }
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
module.exports.SELF_VOICE_PROFILE_ID = SELF_VOICE_PROFILE_ID;
