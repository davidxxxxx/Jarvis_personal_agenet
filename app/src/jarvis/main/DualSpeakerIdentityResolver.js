const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");
const {
  evaluateSpeakerIdentityRelease,
} = require("./SpeakerIdentityReleaseGate");

function unknown(reason, evidence = {}) {
  return {
    state: "unknown",
    candidatePersonId: evidence.candidatePersonId ?? null,
    score: evidence.score ?? null,
    margin: evidence.margin ?? null,
    reason,
    models: evidence.models ?? null,
  };
}

function normalize(value, dimension) {
  if (!(value instanceof Float32Array) || value.length !== dimension) return null;
  let squared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) return null;
    squared += item * item;
  }
  if (!Number.isFinite(squared) || squared <= 0) return null;
  const norm = Math.sqrt(squared);
  return Float64Array.from(value, (item) => item / norm);
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(-1, Math.min(1, score));
}

function profileCentroids(samples, manifest, rejected) {
  const grouped = new Map();
  for (const sample of samples) {
    if (
      !sample ||
      sample.modelId !== manifest.modelId ||
      typeof sample.personId !== "string" ||
      !sample.personId ||
      rejected.has(sample.personId)
    ) {
      continue;
    }
    const embedding = normalize(sample.embedding, manifest.embeddingDimension);
    if (!embedding) continue;
    const list = grouped.get(sample.personId) ?? [];
    list.push(embedding);
    grouped.set(sample.personId, list);
  }
  const result = new Map();
  for (const [personId, embeddings] of grouped) {
    const sum = new Float32Array(manifest.embeddingDimension);
    for (const embedding of embeddings) {
      for (let index = 0; index < sum.length; index += 1) sum[index] += embedding[index];
    }
    const centroid = normalize(sum, manifest.embeddingDimension);
    sum.fill(0);
    if (centroid) result.set(personId, centroid);
  }
  return result;
}

function rankStage(observed, centroids, manifest) {
  const ranked = [...centroids].map(([personId, embedding]) => ({
    personId,
    score: cosine(observed, embedding),
  }));
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.personId.localeCompare(right.personId, "en")
  );
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const margin = top.score - (ranked[1]?.score ?? 0);
  return Object.freeze({
    modelId: manifest.modelId,
    artifactVersion: manifest.artifactVersion,
    embeddingSpace: manifest.embeddingSpace,
    candidatePersonId: top.personId,
    similarity: top.score,
    margin: Math.max(0, margin),
    passed:
      top.score >= manifest.thresholds.similarity &&
      margin >= manifest.thresholds.margin,
  });
}

function observedStage(cluster, role, manifest) {
  const entry = cluster.models?.[role];
  if (
    !entry ||
    entry.modelId !== manifest.modelId ||
    entry.embeddingSpace !== manifest.embeddingSpace
  ) {
    return null;
  }
  return normalize(entry.embedding, manifest.embeddingDimension);
}

class DualSpeakerIdentityResolver {
  constructor({
    primaryManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY),
    reviewManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW),
    releaseEvidence = null,
  } = {}) {
    if (primaryManifest.embeddingSpace === reviewManifest.embeddingSpace) {
      throw new TypeError("dual speaker identity models must use separate embedding spaces");
    }
    this.primaryManifest = primaryManifest;
    this.reviewManifest = reviewManifest;
    this.release = evaluateSpeakerIdentityRelease(releaseEvidence);
  }

  resolveCluster({ cluster, samples, rejectedPersonIds = [] } = {}) {
    if (!cluster || typeof cluster !== "object") throw new TypeError("cluster is required");
    if (!Array.isArray(samples)) throw new TypeError("samples must be an array");
    if (!Array.isArray(rejectedPersonIds)) {
      throw new TypeError("rejectedPersonIds must be an array");
    }
    if (cluster.attributionState !== "exact") return unknown("source_unknown");
    if (cluster.overlapDetected === true) return unknown("overlapping_speech");
    if (cluster.echoDetected === true) return unknown("echo_detected");
    const minimumQuality = Math.max(
      this.primaryManifest.thresholds.minimumQuality,
      this.reviewManifest.thresholds.minimumQuality
    );
    const minimumWindows = Math.max(
      this.primaryManifest.thresholds.minimumContiguousWindows,
      this.reviewManifest.thresholds.minimumContiguousWindows
    );
    if (!Number.isSafeInteger(cluster.speechMs) || cluster.speechMs < 12_000) {
      return unknown("insufficient_speech");
    }
    if (!Number.isSafeInteger(cluster.windowCount) || cluster.windowCount < minimumWindows) {
      return unknown("insufficient_windows");
    }
    if (
      typeof cluster.qualityScore !== "number" ||
      !Number.isFinite(cluster.qualityScore) ||
      cluster.qualityScore < minimumQuality
    ) {
      return unknown("low_quality");
    }

    const primaryObserved = observedStage(cluster, "primary", this.primaryManifest);
    const reviewObserved = observedStage(cluster, "review", this.reviewManifest);
    if (!primaryObserved || !reviewObserved) return unknown("dual_embedding_missing");
    const rejected = new Set(rejectedPersonIds);
    const primary = rankStage(
      primaryObserved,
      profileCentroids(samples, this.primaryManifest, rejected),
      this.primaryManifest
    );
    const review = rankStage(
      reviewObserved,
      profileCentroids(samples, this.reviewManifest, rejected),
      this.reviewManifest
    );
    if (!primary || !review) return unknown("no_dual_candidate");
    const models = { primary, review };
    if (primary.candidatePersonId !== review.candidatePersonId) {
      return unknown("models_disagree", { models });
    }
    const evidence = {
      candidatePersonId: primary.candidatePersonId,
      score: Math.min(primary.similarity, review.similarity),
      margin: Math.min(primary.margin, review.margin),
      models,
    };
    if (!primary.passed) return unknown("primary_gate_failed", evidence);
    if (!review.passed) return unknown("review_gate_failed", evidence);
    if (!this.release.automaticAssociationEnabled) {
      return {
        state: "suggested",
        ...evidence,
        reason: this.release.reason,
      };
    }
    return {
      state: "confirmed",
      ...evidence,
      reason: "dual_model_auto_confirmed",
    };
  }
}

module.exports = DualSpeakerIdentityResolver;
module.exports.profileCentroids = profileCentroids;
