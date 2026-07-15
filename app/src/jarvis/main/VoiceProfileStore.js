const { SPEAKER_EMBEDDING_MODEL_ID } = require("../../helpers/speakerEmbeddings");
const {
  EXPECTED_EMBEDDING_DIMENSION,
  SELF_PROFILE_POLICY,
  SELF_VOICE_PROFILE_ID,
} = require("./VoiceEnrollmentService");

const SELF_PERSON_ID = "self";
const LEGACY_MODEL_ID = "legacy-unversioned";
const LEGACY_IMPORT_MARKER = "speaker_profiles:self:-1:v1";

class InvalidLegacyVoiceProfileError extends Error {
  constructor() {
    super("legacy voice profile is invalid");
    this.name = "InvalidLegacyVoiceProfileError";
  }
}

function decodeLegacyEmbedding(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("legacy self profile embedding must be binary");
  }
  if (value.byteLength === 0 || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError("legacy self profile embedding has an invalid byte length");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const embedding = new Float32Array(value.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < embedding.length; index += 1) {
    const item = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(item)) throw new TypeError("legacy self profile embedding is invalid");
    embedding[index] = item;
  }
  return embedding;
}

function embeddingNorm(value, label) {
  if (!(value instanceof Float32Array) || value.length !== EXPECTED_EMBEDDING_DIMENSION) {
    throw new TypeError(`${label} embedding must contain 512 Float32 values`);
  }
  let squared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) throw new TypeError(`${label} embedding must be finite`);
    squared += item * item;
  }
  if (!Number.isFinite(squared) || squared <= 0) {
    throw new TypeError(`${label} embedding must be non-zero`);
  }
  return Math.sqrt(squared);
}

function validateEnrollmentEvidence(input) {
  if (
    !Array.isArray(input.samples) ||
    input.samples.length !== SELF_PROFILE_POLICY.minimumWindows
  ) {
    throw new TypeError("voice enrollment evidence requires three embeddings");
  }
  for (const sample of input.samples) embeddingNorm(sample, "sample");
  const centroidNorm = embeddingNorm(input.centroid, "centroid");
  if (Math.abs(centroidNorm - 1) > 1e-4) {
    throw new TypeError("voice enrollment centroid embedding must be normalized");
  }
  if (
    !Array.isArray(input.sampleSpeechMs) ||
    input.sampleSpeechMs.length !== input.samples.length ||
    input.sampleSpeechMs.some((speechMs) => !Number.isSafeInteger(speechMs) || speechMs <= 0)
  ) {
    throw new TypeError("voice enrollment evidence requires speech duration for each sample");
  }
  const acceptedSpeechMs = input.sampleSpeechMs.reduce((sum, speechMs) => sum + speechMs, 0);
  if (
    input.acceptedSpeechMs !== acceptedSpeechMs ||
    acceptedSpeechMs < SELF_PROFILE_POLICY.minimumSpeechMs ||
    input.windowCount !== input.samples.length ||
    input.windowCount < SELF_PROFILE_POLICY.minimumWindows
  ) {
    throw new TypeError("voice enrollment evidence does not satisfy the quality policy");
  }
  if (
    typeof input.selfConsistency !== "number" ||
    !Number.isFinite(input.selfConsistency) ||
    input.selfConsistency < SELF_PROFILE_POLICY.minimumSelfConsistency ||
    input.selfConsistency > 1
  ) {
    throw new TypeError("voice enrollment evidence self-consistency is below the quality policy");
  }
}

class VoiceProfileStore {
  constructor({ repository, legacyProfileReader = null, now = Date.now }) {
    if (
      !repository ||
      typeof repository.getVoiceProfileAggregate !== "function" ||
      typeof repository.replaceVoiceEnrollmentSamples !== "function" ||
      typeof repository.importLegacyVoiceProfile !== "function" ||
      typeof repository.hasVoiceProfileImportMarker !== "function"
    ) {
      throw new TypeError("repository must provide the voice profile persistence interface");
    }
    if (
      legacyProfileReader !== null &&
      typeof legacyProfileReader.getSpeakerProfileById !== "function"
    ) {
      throw new TypeError("legacyProfileReader must provide getSpeakerProfileById");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.repository = repository;
    this.legacyProfileReader = legacyProfileReader;
    this.now = now;
  }

  getStatus() {
    const aggregate = this.repository.getVoiceProfileAggregate(
      SELF_PERSON_ID,
      SPEAKER_EMBEDDING_MODEL_ID
    );
    if (!aggregate) {
      return {
        enrolled: false,
        modelId: SPEAKER_EMBEDDING_MODEL_ID,
        acceptedSpeechMs: 0,
        windowCount: 0,
        selfConsistency: null,
        updatedAt: null,
      };
    }
    return {
      enrolled: true,
      modelId: aggregate.modelId,
      acceptedSpeechMs: aggregate.acceptedSpeechMs,
      windowCount: aggregate.windowCount,
      selfConsistency: aggregate.selfConsistency,
      updatedAt: aggregate.updatedAt,
    };
  }

  saveEnrollment(input) {
    if (!input || input.modelId !== SPEAKER_EMBEDDING_MODEL_ID) {
      throw new TypeError("voice enrollment model does not match the current model");
    }
    validateEnrollmentEvidence(input);
    return this.repository.replaceVoiceEnrollmentSamples({
      personId: SELF_PERSON_ID,
      modelId: input.modelId,
      samples: input.samples,
      centroid: input.centroid,
      sampleSpeechMs: input.sampleSpeechMs,
      acceptedSpeechMs: input.acceptedSpeechMs,
      windowCount: input.windowCount,
      selfConsistency: input.selfConsistency,
      updatedAt: this.now(),
    });
  }

  importLegacySelfProfile() {
    if (!this.legacyProfileReader) return false;
    if (this.repository.hasVoiceProfileImportMarker(LEGACY_IMPORT_MARKER)) return false;
    const profile = this.legacyProfileReader.getSpeakerProfileById(SELF_VOICE_PROFILE_ID, true);
    if (!profile || profile.id !== SELF_VOICE_PROFILE_ID) return false;
    let embedding;
    try {
      embedding = decodeLegacyEmbedding(profile.embedding);
    } catch {
      throw new InvalidLegacyVoiceProfileError();
    }
    return this.repository.importLegacyVoiceProfile({
      markerKey: LEGACY_IMPORT_MARKER,
      personId: SELF_PERSON_ID,
      modelId: LEGACY_MODEL_ID,
      embedding,
      importedAt: this.now(),
    });
  }

  importLegacySelfProfileSafely(log = () => {}) {
    if (typeof log !== "function") throw new TypeError("legacy import logger must be a function");
    try {
      const imported = this.importLegacySelfProfile();
      return { imported, status: imported ? "imported" : "not_imported" };
    } catch (error) {
      if (!(error instanceof InvalidLegacyVoiceProfileError)) throw error;
      log({ code: "legacy_voice_profile_invalid" });
      return { imported: false, status: "invalid_legacy_profile" };
    }
  }
}

module.exports = VoiceProfileStore;
module.exports.LEGACY_IMPORT_MARKER = LEGACY_IMPORT_MARKER;
module.exports.LEGACY_MODEL_ID = LEGACY_MODEL_ID;
module.exports.SELF_PERSON_ID = SELF_PERSON_ID;
