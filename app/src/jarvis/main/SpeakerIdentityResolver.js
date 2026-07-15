const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
} = require("./SpeakerIdentityResolutionPolicy");

function meetsMinimum(value, minimum) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    typeof minimum === "number" &&
    Number.isFinite(minimum) &&
    value >= minimum
  );
}

function normalize(value, expectedDimension = 512) {
  if (!(value instanceof Float32Array) && !(value instanceof Float64Array)) return null;
  if (value.length !== expectedDimension) return null;
  let squaredNorm = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) return null;
    squaredNorm += component * component;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) return null;
  const norm = Math.sqrt(squaredNorm);
  const normalized = new Float64Array(expectedDimension);
  for (let index = 0; index < expectedDimension; index += 1) {
    normalized[index] = value[index] / norm;
  }
  return normalized;
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(-1, Math.min(1, score));
}

function personCentroids(samples, policy, rejectedPersonIds) {
  const rejected = new Set(rejectedPersonIds);
  const grouped = new Map();
  const orderedSamples = [...samples].sort((left, right) => {
    const leftPerson = typeof left?.personId === "string" ? left.personId : "";
    const rightPerson = typeof right?.personId === "string" ? right.personId : "";
    if (leftPerson !== rightPerson) return leftPerson < rightPerson ? -1 : 1;
    const leftId = typeof left?.id === "string" ? left.id : "";
    const rightId = typeof right?.id === "string" ? right.id : "";
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
  });
  for (const sample of orderedSamples) {
    if (
      !sample ||
      sample.modelId !== policy.modelId ||
      typeof sample.personId !== "string" ||
      !sample.personId ||
      rejected.has(sample.personId)
    ) {
      continue;
    }
    const embedding = normalize(sample.embedding);
    if (!embedding) continue;
    const entries = grouped.get(sample.personId) ?? [];
    entries.push(embedding);
    grouped.set(sample.personId, entries);
  }
  const centroids = [];
  for (const [personId, entries] of grouped) {
    const sum = new Float64Array(512);
    for (const embedding of entries) {
      for (let index = 0; index < sum.length; index += 1) sum[index] += embedding[index];
    }
    const centroid = normalize(sum);
    if (centroid) centroids.push({ personId, embedding: centroid });
  }
  return centroids;
}

function unknown(reason, { candidatePersonId = null, score = null, margin = null } = {}) {
  return { state: "unknown", candidatePersonId, score, margin, reason };
}

class SpeakerIdentityResolver {
  constructor({ policy = SPEAKER_IDENTITY_RESOLUTION_POLICY } = {}) {
    this.policy = assertExactIdentityResolutionPolicy(policy);
  }

  resolveCluster({ cluster, samples, rejectedPersonIds = [] } = {}) {
    if (!cluster || typeof cluster !== "object") throw new TypeError("cluster is required");
    if (!Array.isArray(samples)) throw new TypeError("samples must be an array");
    if (!Array.isArray(rejectedPersonIds)) {
      throw new TypeError("rejectedPersonIds must be an array");
    }
    const policy = this.policy;
    if (!meetsMinimum(cluster.speechMs, policy.minimumSpeechMs)) {
      return unknown("insufficient_speech");
    }
    if (!meetsMinimum(cluster.windowCount, policy.minimumWindows)) {
      return unknown("insufficient_windows");
    }
    if (!meetsMinimum(cluster.qualityScore, policy.minimumQualityScore)) {
      return unknown("low_quality");
    }
    if (cluster.modelId !== policy.modelId) return unknown("model_mismatch");
    const clusterEmbedding = normalize(cluster.embedding);
    if (!clusterEmbedding) return unknown("invalid_cluster_embedding");
    const candidates = personCentroids(samples, policy, rejectedPersonIds)
      .map((candidate) => ({
        personId: candidate.personId,
        score: cosine(clusterEmbedding, candidate.embedding),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          (left.personId === right.personId ? 0 : left.personId < right.personId ? -1 : 1)
      );
    if (candidates.length === 0) return unknown("no_candidate");
    const top = candidates[0];
    const secondScore = candidates[1]?.score ?? 0;
    const rawMargin = top.score - secondScore;
    const margin = Math.abs(rawMargin) <= Number.EPSILON * 8 ? 0 : Math.max(0, rawMargin);
    const evidence = { candidatePersonId: top.personId, score: top.score, margin };
    if (!meetsMinimum(top.score, policy.suggestSimilarity)) {
      return unknown("below_suggest_similarity", evidence);
    }
    if (!meetsMinimum(margin, policy.minimumMargin)) {
      return unknown("insufficient_margin", evidence);
    }
    if (meetsMinimum(top.score, policy.autoConfirmSimilarity)) {
      return { state: "confirmed", ...evidence, reason: "auto_confirmed" };
    }
    return { state: "suggested", ...evidence, reason: "suggested" };
  }
}

module.exports = SpeakerIdentityResolver;
module.exports.meetsMinimum = meetsMinimum;
module.exports.normalizeEmbedding = normalize;
module.exports.personCentroids = personCentroids;
