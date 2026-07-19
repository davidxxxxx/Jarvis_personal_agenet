const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");
const {
  evaluateSpeakerIdentityRelease,
} = require("./SpeakerIdentityReleaseGate");

const REVIEW_REASONS = new Set(["idle", "boundary", "high_impact", "enrollment"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSamples(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError("speaker verification samples must be non-empty Float32 PCM");
  }
}

function assertRuntime(runtime, name) {
  if (!runtime || typeof runtime.extractEmbeddingFromSamples !== "function") {
    throw new TypeError(`${name} speaker embedding runtime is required`);
  }
}

function normalizeVector(value, manifest, label) {
  if (!(value instanceof Float32Array) || value.length !== manifest.embeddingDimension) {
    throw codedError(
      "SPEAKER_EMBEDDING_SPACE_MISMATCH",
      `${label} embedding does not match its model space`
    );
  }
  let normSquared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) {
      throw codedError("SPEAKER_EMBEDDING_SPACE_MISMATCH", `${label} embedding is invalid`);
    }
    normSquared += item * item;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw codedError("SPEAKER_EMBEDDING_SPACE_MISMATCH", `${label} embedding is empty`);
  }
  const norm = Math.sqrt(normSquared);
  const normalized = new Float32Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    normalized[index] = value[index] / norm;
  }
  return normalized;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return Math.max(-1, Math.min(1, dot));
}

function validateReference(reference, manifest, label) {
  if (
    !reference ||
    reference.modelId !== manifest.modelId ||
    reference.embeddingSpace !== manifest.embeddingSpace
  ) {
    throw codedError(
      "SPEAKER_EMBEDDING_SPACE_MISMATCH",
      `${label} reference belongs to a different embedding space`
    );
  }
  const embedding = normalizeVector(reference.embedding, manifest, `${label} reference`);
  const nearestOtherSimilarity = reference.nearestOtherSimilarity;
  if (
    typeof nearestOtherSimilarity !== "number" ||
    !Number.isFinite(nearestOtherSimilarity) ||
    nearestOtherSimilarity < -1 ||
    nearestOtherSimilarity > 1
  ) {
    throw new TypeError(`${label} nearestOtherSimilarity must be between -1 and 1`);
  }
  return { embedding, nearestOtherSimilarity };
}

function evaluateStage(embedding, reference, manifest) {
  const normalized = normalizeVector(embedding, manifest, `${manifest.key} observed`);
  const similarity = cosineSimilarity(normalized, reference.embedding);
  const margin = similarity - reference.nearestOtherSimilarity;
  return Object.freeze({
    modelId: manifest.modelId,
    artifactVersion: manifest.artifactVersion,
    embeddingSpace: manifest.embeddingSpace,
    embedding: normalized,
    similarity,
    margin,
    passed:
      similarity >= manifest.thresholds.similarity && margin >= manifest.thresholds.margin,
  });
}

class DualSpeakerVerifier {
  constructor({
    primaryEmbeddings,
    reviewEmbeddings,
    resourceGovernor,
    primaryManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY),
    reviewManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW),
    releaseEvidence = null,
  } = {}) {
    assertRuntime(primaryEmbeddings, "primary");
    assertRuntime(reviewEmbeddings, "review");
    if (!resourceGovernor || typeof resourceGovernor.admit !== "function") {
      throw new TypeError("resourceGovernor.admit is required");
    }
    if (primaryManifest.embeddingSpace === reviewManifest.embeddingSpace) {
      throw new TypeError("speaker verification models must use isolated embedding spaces");
    }
    this.primaryEmbeddings = primaryEmbeddings;
    this.reviewEmbeddings = reviewEmbeddings;
    this.resourceGovernor = resourceGovernor;
    this.primaryManifest = primaryManifest;
    this.reviewManifest = reviewManifest;
    this.release = evaluateSpeakerIdentityRelease(releaseEvidence);
  }

  _admit(runtime, snapshot) {
    const available =
      typeof runtime.isAvailable === "function" ? runtime.isAvailable() === true : true;
    return this.resourceGovernor.admit("speaker", snapshot, {
      available,
      unavailableReason: "speaker_identity_model_unavailable",
      executionDevice: "cpu",
    });
  }

  async screen({ samples, snapshot } = {}) {
    assertSamples(samples);
    const admission = this._admit(this.primaryEmbeddings, snapshot);
    if (admission.action !== "run_cpu" && admission.action !== "run_cuda") {
      return Object.freeze({
        status: "deferred",
        stage: "primary",
        reason: admission.reason,
        modelId: this.primaryManifest.modelId,
        embeddingSpace: this.primaryManifest.embeddingSpace,
      });
    }
    const embedding = await this.primaryEmbeddings.extractEmbeddingFromSamples(samples);
    return Object.freeze({
      status: "completed",
      stage: "primary",
      reason: null,
      modelId: this.primaryManifest.modelId,
      artifactVersion: this.primaryManifest.artifactVersion,
      embeddingSpace: this.primaryManifest.embeddingSpace,
      embedding: normalizeVector(embedding, this.primaryManifest, "primary observed"),
    });
  }

  async verify({
    samples,
    references,
    snapshot,
    reason,
    quality,
    contiguousWindows,
  } = {}) {
    assertSamples(samples);
    if (!REVIEW_REASONS.has(reason)) throw new TypeError("speaker review reason is invalid");
    const primaryReference = validateReference(
      references?.primary,
      this.primaryManifest,
      "primary"
    );
    const reviewReference = validateReference(
      references?.review,
      this.reviewManifest,
      "review"
    );
    if (typeof quality !== "number" || !Number.isFinite(quality) || quality < 0 || quality > 1) {
      throw new TypeError("speaker quality must be between 0 and 1");
    }
    if (!Number.isSafeInteger(contiguousWindows) || contiguousWindows < 0) {
      throw new TypeError("contiguousWindows must be a non-negative safe integer");
    }
    const minimumQuality = Math.max(
      this.primaryManifest.thresholds.minimumQuality,
      this.reviewManifest.thresholds.minimumQuality
    );
    const minimumWindows = Math.max(
      this.primaryManifest.thresholds.minimumContiguousWindows,
      this.reviewManifest.thresholds.minimumContiguousWindows
    );
    if (quality < minimumQuality || contiguousWindows < minimumWindows) {
      return Object.freeze({
        status: "rejected",
        reason: quality < minimumQuality ? "quality_gate_failed" : "window_gate_failed",
        dualPass: false,
        autoAssociate: false,
      });
    }

    const screened = await this.screen({ samples, snapshot });
    if (screened.status !== "completed") {
      return Object.freeze({
        status: "deferred",
        reason: screened.reason,
        dualPass: false,
        autoAssociate: false,
      });
    }
    const primary = evaluateStage(screened.embedding, primaryReference, this.primaryManifest);
    if (!primary.passed) {
      return Object.freeze({
        status: "rejected",
        reason: "primary_gate_failed",
        dualPass: false,
        autoAssociate: false,
        primary,
      });
    }

    const reviewAdmission = this._admit(this.reviewEmbeddings, snapshot);
    if (
      reviewAdmission.action !== "run_cpu" &&
      reviewAdmission.action !== "run_cuda"
    ) {
      return Object.freeze({
        status: "deferred",
        reason: reviewAdmission.reason,
        dualPass: false,
        autoAssociate: false,
        primary,
      });
    }
    const reviewEmbedding =
      await this.reviewEmbeddings.extractEmbeddingFromSamples(samples);
    const review = evaluateStage(reviewEmbedding, reviewReference, this.reviewManifest);
    if (!review.passed) {
      return Object.freeze({
        status: "rejected",
        reason: "review_gate_failed",
        dualPass: false,
        autoAssociate: false,
        primary,
        review,
      });
    }

    const autoAssociate = this.release.automaticAssociationEnabled;
    return Object.freeze({
      status: autoAssociate ? "confirmed" : "candidate",
      reason: autoAssociate ? null : this.release.reason,
      dualPass: true,
      autoAssociate,
      primary,
      review,
    });
  }
}

module.exports = DualSpeakerVerifier;
module.exports.DualSpeakerVerifier = DualSpeakerVerifier;
module.exports.REVIEW_REASONS = REVIEW_REASONS;
