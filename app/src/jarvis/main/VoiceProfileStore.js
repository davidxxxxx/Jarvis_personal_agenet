const { SPEAKER_EMBEDDING_MODEL_ID } = require("../../helpers/speakerEmbeddings");
const {
  EXPECTED_EMBEDDING_DIMENSION,
  DUAL_SELF_PROFILE_POLICY,
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

function embeddingNorm(value, label, dimension = EXPECTED_EMBEDDING_DIMENSION) {
  if (!(value instanceof Float32Array) || value.length !== dimension) {
    throw new TypeError(`${label} embedding must contain ${dimension} Float32 values`);
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

function validateDualModelEvidence(model, policy, input) {
  if (
    !model ||
    model.role !== input.role ||
    model.modelId !== policy.modelId ||
    model.embeddingSpace !== policy.embeddingSpace
  ) {
    throw new TypeError(`voice enrollment ${input.role} model does not match the policy`);
  }
  if (
    !Array.isArray(model.samples) ||
    model.samples.length !== DUAL_SELF_PROFILE_POLICY.minimumWindows
  ) {
    throw new TypeError("dual voice enrollment requires three embeddings per model");
  }
  for (const sample of model.samples) {
    embeddingNorm(sample, `${input.role} sample`, policy.embeddingDimension);
  }
  const centroidNorm = embeddingNorm(
    model.centroid,
    `${input.role} centroid`,
    policy.embeddingDimension
  );
  if (Math.abs(centroidNorm - 1) > 1e-4) {
    throw new TypeError("dual voice enrollment centroid must be normalized");
  }
  if (
    typeof model.selfConsistency !== "number" ||
    !Number.isFinite(model.selfConsistency) ||
    model.selfConsistency < DUAL_SELF_PROFILE_POLICY.minimumSelfConsistency ||
    model.selfConsistency > 1
  ) {
    throw new TypeError("dual voice enrollment self-consistency is below policy");
  }
}

class VoiceProfileStore {
  constructor({ repository, legacyProfileReader = null, now = Date.now }) {
    if (
      !repository ||
      typeof repository.getVoiceProfileAggregate !== "function" ||
      typeof repository.replaceVoiceEnrollmentSamples !== "function" ||
      typeof repository.replaceVoiceEnrollmentSampleSets !== "function" ||
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

  getDualStatus() {
    const entries = [
      ["primary", DUAL_SELF_PROFILE_POLICY.primary],
      ["review", DUAL_SELF_PROFILE_POLICY.review],
    ].map(([role, policy]) => {
      const aggregate = this.repository.getVoiceProfileAggregate(SELF_PERSON_ID, policy.modelId);
      return {
        role,
        modelId: policy.modelId,
        embeddingSpace: policy.embeddingSpace,
        enrolled: Boolean(aggregate),
        acceptedSpeechMs: aggregate?.acceptedSpeechMs ?? 0,
        windowCount: aggregate?.windowCount ?? 0,
        selfConsistency: aggregate?.selfConsistency ?? null,
        updatedAt: aggregate?.updatedAt ?? null,
      };
    });
    const enrolled = entries.every((entry) => entry.enrolled);
    return {
      enrolled,
      modelId: DUAL_SELF_PROFILE_POLICY.policyId,
      acceptedSpeechMs: enrolled
        ? Math.min(...entries.map((entry) => entry.acceptedSpeechMs))
        : 0,
      windowCount: enrolled ? Math.min(...entries.map((entry) => entry.windowCount)) : 0,
      selfConsistency: enrolled
        ? Math.min(...entries.map((entry) => entry.selfConsistency))
        : null,
      updatedAt: enrolled ? Math.max(...entries.map((entry) => entry.updatedAt)) : null,
      models: entries,
    };
  }

  saveDualEnrollment(input) {
    if (!input || input.policyId !== DUAL_SELF_PROFILE_POLICY.policyId) {
      throw new TypeError("dual voice enrollment policy does not match");
    }
    if (!Array.isArray(input.models) || input.models.length !== 2) {
      throw new TypeError("dual voice enrollment requires primary and review evidence");
    }
    if (
      !Array.isArray(input.sampleSpeechMs) ||
      input.sampleSpeechMs.length !== DUAL_SELF_PROFILE_POLICY.minimumWindows ||
      input.sampleSpeechMs.some(
        (speechMs) => !Number.isSafeInteger(speechMs) || speechMs <= 0
      )
    ) {
      throw new TypeError("dual voice enrollment requires speech duration for each sample");
    }
    const acceptedSpeechMs = input.sampleSpeechMs.reduce((sum, value) => sum + value, 0);
    if (
      acceptedSpeechMs !== input.acceptedSpeechMs ||
      acceptedSpeechMs < DUAL_SELF_PROFILE_POLICY.minimumSpeechMs ||
      input.windowCount !== DUAL_SELF_PROFILE_POLICY.minimumWindows
    ) {
      throw new TypeError("dual voice enrollment does not satisfy the evidence policy");
    }
    const byRole = new Map(input.models.map((entry) => [entry?.role, entry]));
    if (byRole.size !== 2) {
      throw new TypeError("dual voice enrollment model roles must be unique");
    }
    validateDualModelEvidence(
      byRole.get("primary"),
      DUAL_SELF_PROFILE_POLICY.primary,
      { role: "primary" }
    );
    validateDualModelEvidence(
      byRole.get("review"),
      DUAL_SELF_PROFILE_POLICY.review,
      { role: "review" }
    );
    const updatedAt = this.now();
    return this.repository.replaceVoiceEnrollmentSampleSets(
      ["primary", "review"].map((role) => {
        const model = byRole.get(role);
        return {
          personId: SELF_PERSON_ID,
          modelId: model.modelId,
          samples: model.samples,
          centroid: model.centroid,
          sampleSpeechMs: input.sampleSpeechMs,
          acceptedSpeechMs,
          windowCount: input.windowCount,
          selfConsistency: model.selfConsistency,
          updatedAt,
        };
      })
    );
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
