const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");
const {
  evaluateSpeakerIdentityRelease,
} = require("./SpeakerIdentityReleaseGate");

const SELF_ENROLLMENT_MINIMUM_SAMPLES = 3;
const SELF_ENROLLMENT_MINIMUM_SPEECH_MS = 15_000;
const SELF_ENROLLMENT_MINIMUM_CONSISTENCY = 0.88;

function unknown(reason, evidence = {}) {
  return {
    state: "unknown",
    candidatePersonId: evidence.candidatePersonId ?? null,
    candidatePersonRef: evidence.candidatePersonRef ?? null,
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
    const candidatePersonRef = sample?.candidatePersonRef ?? sample?.personId;
    if (
      !sample ||
      sample.modelId !== manifest.modelId ||
      typeof candidatePersonRef !== "string" ||
      !candidatePersonRef ||
      rejected.has(candidatePersonRef)
    ) {
      continue;
    }
    const embedding = normalize(sample.embedding, manifest.embeddingDimension);
    if (!embedding) continue;
    const list = grouped.get(candidatePersonRef) ?? [];
    list.push(embedding);
    grouped.set(candidatePersonRef, list);
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
  const ranked = [...centroids].map(([candidatePersonRef, embedding]) => ({
    candidatePersonRef,
    score: cosine(observed, embedding),
  }));
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidatePersonRef.localeCompare(right.candidatePersonRef, "en")
  );
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const margin = top.score - (ranked[1]?.score ?? 0);
  return Object.freeze({
    modelId: manifest.modelId,
    artifactVersion: manifest.artifactVersion,
    embeddingSpace: manifest.embeddingSpace,
    candidatePersonRef: top.candidatePersonRef,
    similarity: top.score,
    margin: Math.max(0, margin),
    passed:
      top.score >= manifest.thresholds.similarity &&
      margin >= manifest.thresholds.margin,
  });
}

function candidateMetadata(samples, candidatePersonRef) {
  const matching = samples.filter(
    (sample) => (sample?.candidatePersonRef ?? sample?.personId) === candidatePersonRef
  );
  const personIds = [
    ...new Set(
      matching
        .map((sample) => sample?.personId)
        .filter((personId) => typeof personId === "string" && personId)
    ),
  ];
  return {
    candidatePersonId: personIds.length === 1 ? personIds[0] : null,
    isSelf:
      personIds.length === 1 &&
      matching.some(
        (sample) => sample?.personId === personIds[0] && sample?.isSelf === true
      ),
  };
}

function enrollmentConsistency(samples, candidatePersonRef, manifest) {
  const enrolled = samples.filter(
    (sample) =>
      (sample?.candidatePersonRef ?? sample?.personId) === candidatePersonRef &&
      sample?.isSelf === true &&
      sample?.sourceKind === "enrollment" &&
      sample?.modelId === manifest.modelId
  );
  if (
    enrolled.length < SELF_ENROLLMENT_MINIMUM_SAMPLES ||
    enrolled.reduce(
      (total, sample) =>
        total + (Number.isSafeInteger(sample.speechMs) ? sample.speechMs : 0),
      0
    ) < SELF_ENROLLMENT_MINIMUM_SPEECH_MS ||
    enrolled.reduce(
      (total, sample) =>
        total + (Number.isSafeInteger(sample.windowCount) ? sample.windowCount : 0),
      0
    ) < SELF_ENROLLMENT_MINIMUM_SAMPLES
  ) {
    return null;
  }
  const vectors = enrolled
    .map((sample) => normalize(sample.embedding, manifest.embeddingDimension))
    .filter(Boolean);
  if (vectors.length !== enrolled.length) return null;
  const sum = new Float32Array(manifest.embeddingDimension);
  for (const vector of vectors) {
    for (let index = 0; index < sum.length; index += 1) sum[index] += vector[index];
  }
  const centroid = normalize(sum, manifest.embeddingDimension);
  sum.fill(0);
  if (!centroid) return null;
  return Math.min(...vectors.map((vector) => cosine(vector, centroid)));
}

function hasTrustedSelfEnrollment(samples, candidatePersonRef, primaryManifest, reviewManifest) {
  const primaryConsistency = enrollmentConsistency(
    samples,
    candidatePersonRef,
    primaryManifest
  );
  const reviewConsistency = enrollmentConsistency(
    samples,
    candidatePersonRef,
    reviewManifest
  );
  return (
    primaryConsistency !== null &&
    reviewConsistency !== null &&
    primaryConsistency >= SELF_ENROLLMENT_MINIMUM_CONSISTENCY &&
    reviewConsistency >= SELF_ENROLLMENT_MINIMUM_CONSISTENCY
  );
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
    if (primary.candidatePersonRef !== review.candidatePersonRef) {
      return unknown("models_disagree", { models });
    }
    const candidate = candidateMetadata(samples, primary.candidatePersonRef);
    const candidatePersonRef = primary.candidatePersonRef;
    const evidence = {
      candidatePersonId: candidate.candidatePersonId,
      candidatePersonRef,
      score: Math.min(primary.similarity, review.similarity),
      margin: Math.min(primary.margin, review.margin),
      models,
    };
    if (!primary.passed) return unknown("primary_gate_failed", evidence);
    if (!review.passed) return unknown("review_gate_failed", evidence);
    if (candidate.candidatePersonId === null) {
      return unknown("dual_model_anonymous_profile", evidence);
    }
    if (
      candidate.isSelf &&
      cluster.sourceKind === "mic" &&
      hasTrustedSelfEnrollment(
        samples,
        candidatePersonRef,
        this.primaryManifest,
        this.reviewManifest
      )
    ) {
      return {
        state: "confirmed",
        ...evidence,
        reason: "dual_model_self_enrollment_confirmed",
      };
    }
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
module.exports.hasTrustedSelfEnrollment = hasTrustedSelfEnrollment;
