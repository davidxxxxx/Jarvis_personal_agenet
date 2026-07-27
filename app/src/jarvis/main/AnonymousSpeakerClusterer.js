const crypto = require("node:crypto");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");

function normalize(value) {
  if (!(value instanceof Float32Array) || value.length === 0) return null;
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
  if (!left || !right || left.length !== right.length) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return Math.max(-1, Math.min(1, score));
}

function pairEvidence(left, right, thresholds) {
  const primary = cosine(left.models.primary, right.models.primary);
  const review = cosine(left.models.review, right.models.review);
  return {
    primary,
    review,
    score: Math.min(primary, review),
    passed:
      primary >= thresholds.primary.similarity &&
      review >= thresholds.review.similarity,
  };
}

function bestPeer(candidate, candidates, thresholds) {
  const ranked = candidates
    .filter(
      (other) =>
        other.clusterId !== candidate.clusterId &&
        other.trackId !== candidate.trackId
    )
    .map((other) => ({
      candidate: other,
      evidence: pairEvidence(candidate, other, thresholds),
    }))
    .filter((entry) => entry.evidence.passed)
    .sort(
      (left, right) =>
        right.evidence.score - left.evidence.score ||
        left.candidate.clusterId.localeCompare(right.candidate.clusterId, "en")
    );
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const second = ranked[1]?.evidence.score ?? 0;
  const margin = top.evidence.score - second;
  if (margin < Math.max(thresholds.primary.margin, thresholds.review.margin)) return null;
  return { ...top, margin };
}

function groupReference(members) {
  const anchor = [...members].sort(
    (left, right) =>
      right.qualityScore - left.qualityScore ||
      right.speechMs - left.speechMs ||
      left.clusterId.localeCompare(right.clusterId, "en")
  )[0];
  return `anonymous-speaker-${crypto
    .createHash("sha256")
    .update(anchor.clusterId)
    .digest("hex")
    .slice(0, 32)}`;
}

function clusterAnonymousSpeakers(
  candidates,
  {
    primaryManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY),
    reviewManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW),
  } = {}
) {
  const thresholds = {
    primary: primaryManifest.thresholds,
    review: reviewManifest.thresholds,
  };
  const safe = candidates
    .map((candidate) => ({
      ...candidate,
      models: {
        primary: normalize(candidate?.models?.primary),
        review: normalize(candidate?.models?.review),
      },
    }))
    .filter(
      (candidate) =>
        typeof candidate.clusterId === "string" &&
        candidate.clusterId &&
        typeof candidate.trackId === "string" &&
        candidate.trackId &&
        candidate.models.primary &&
        candidate.models.review &&
        Number.isSafeInteger(candidate.speechMs) &&
        candidate.speechMs >= 12_000 &&
        Number.isSafeInteger(candidate.windowCount) &&
        candidate.windowCount >=
          Math.max(
            thresholds.primary.minimumContiguousWindows,
            thresholds.review.minimumContiguousWindows
          ) &&
        typeof candidate.qualityScore === "number" &&
        candidate.qualityScore >=
          Math.max(thresholds.primary.minimumQuality, thresholds.review.minimumQuality)
    )
    .sort((left, right) => left.clusterId.localeCompare(right.clusterId, "en"));
  const best = new Map(
    safe.map((candidate) => [candidate.clusterId, bestPeer(candidate, safe, thresholds)])
  );
  const groups = [];
  const assigned = new Set();
  for (const candidate of safe) {
    if (assigned.has(candidate.clusterId)) continue;
    const peer = best.get(candidate.clusterId);
    if (!peer || assigned.has(peer.candidate.clusterId)) continue;
    const reverse = best.get(peer.candidate.clusterId);
    if (reverse?.candidate.clusterId !== candidate.clusterId) continue;
    groups.push([candidate, peer.candidate]);
    assigned.add(candidate.clusterId);
    assigned.add(peer.candidate.clusterId);
  }

  for (const candidate of safe) {
    if (assigned.has(candidate.clusterId)) continue;
    const rankedGroups = groups
      .map((members) => {
        const evidence = members.map((member) =>
          pairEvidence(candidate, member, thresholds)
        );
        return {
          members,
          passed:
            members.some((member) => member.trackId !== candidate.trackId) &&
            evidence.every((item) => item.passed),
          score: Math.min(...evidence.map((item) => item.score)),
        };
      })
      .filter((entry) => entry.passed)
      .sort((left, right) => right.score - left.score);
    if (rankedGroups.length === 0) continue;
    const margin = rankedGroups[0].score - (rankedGroups[1]?.score ?? 0);
    if (margin < Math.max(thresholds.primary.margin, thresholds.review.margin)) continue;
    rankedGroups[0].members.push(candidate);
    assigned.add(candidate.clusterId);
  }

  const assignments = new Map();
  for (const members of groups) {
    if (new Set(members.map((member) => member.trackId)).size < 2) continue;
    const candidatePersonRef = groupReference(members);
    for (const member of members) {
      const peerScores = members
        .filter((candidate) => candidate.clusterId !== member.clusterId)
        .map((candidate) => pairEvidence(member, candidate, thresholds).score);
      assignments.set(member.clusterId, {
        candidatePersonRef,
        score: Math.min(...peerScores),
        margin: best.get(member.clusterId)?.margin ?? null,
      });
    }
  }
  for (const candidate of safe) {
    candidate.models.primary.fill(0);
    candidate.models.review.fill(0);
  }
  return assignments;
}

module.exports = {
  clusterAnonymousSpeakers,
};
