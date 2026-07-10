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
const SELF_VOICE_PROFILE_ID = 2_147_483_647;

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

class VoiceEnrollmentService {
  constructor({
    speakerEmbeddings,
    databaseManager,
    repository,
    createId = randomUUID,
    now = Date.now,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
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
    this.speakerEmbeddings = speakerEmbeddings;
    this.databaseManager = databaseManager;
    this.repository = repository;
    this.createId = createId;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
  }

  begin({ ownerId }) {
    const safeOwnerId = requireOwnerId(ownerId);
    const sessionId = this.createId();
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new TypeError("enrollment session id must be opaque and safe");
    }
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(sessionId, { ownerId: safeOwnerId, expiresAt });
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
    const session = this._getSession(ownerId, sessionId);
    this.sessions.delete(sessionId);
    return { cancelled: true, expiresAt: session.expiresAt };
  }

  async complete({ ownerId, sessionId, payload }) {
    this._getSession(ownerId, sessionId);
    const windows = validatePayload(payload);
    this.sessions.delete(sessionId);

    const embeddings = [];
    for (const window of windows) {
      const embedding = await this.speakerEmbeddings.extractEmbeddingFromSamples(
        downsampleForEmbedding(window.samples)
      );
      if (embedding instanceof Float32Array && embedding.length > 0) embeddings.push(embedding);
    }
    if (embeddings.length !== REQUIRED_WINDOWS) {
      throw new Error("voice enrollment requires three valid speech samples");
    }

    const centroid = this.speakerEmbeddings.computeCentroid(embeddings);
    if (!(centroid instanceof Float32Array) || centroid.length === 0) {
      throw new Error("voice enrollment could not create a speaker profile");
    }
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
  }

  _getSession(ownerId, sessionId) {
    const safeOwnerId = requireOwnerId(ownerId);
    if (typeof sessionId !== "string" || !sessionId) {
      throw new TypeError("enrollment session id is required");
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("unknown enrollment session");
    if (session.ownerId !== safeOwnerId) {
      throw new Error("enrollment session does not belong to this renderer");
    }
    if (this.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      throw new Error("enrollment session expired");
    }
    return session;
  }
}

module.exports = VoiceEnrollmentService;
module.exports.CAPTURE_SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
module.exports.SELF_VOICE_PROFILE_ID = SELF_VOICE_PROFILE_ID;
