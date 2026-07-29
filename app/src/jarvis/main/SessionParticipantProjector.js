const ApplicationAudioPolicy = require("./ApplicationAudioPolicy");

const SESSION_MINIMUM_SPEECH_MS = 5_000;
const SESSION_MINIMUM_SEGMENTS = 3;
const LONG_TERM_MINIMUM_SPEECH_MS = 20_000;
const LONG_TERM_MINIMUM_SEGMENTS = 3;
const SESSION_SIMILARITY_THRESHOLD = 0.86;
const MAXIMUM_PUBLIC_EVIDENCE_CLUSTERS = 64;
const MAXIMUM_PUBLIC_PARTICIPANT_COUNT = 24;
const PROJECTOR_VERSION = "session-participants-v1";
const INTERACTION_CATEGORIES = new Set([
  "work_meeting",
  "social_call",
  "in_person_conversation",
]);
const MEDIA_CATEGORIES = new Set(["gaming", "entertainment", "learning"]);

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function trackKind(track) {
  if (track?.source_type === "mic") return "mic";
  if (typeof track?.application_key === "string" && track.application_key) {
    return "application";
  }
  return "system_mix";
}

function sourceGroup(track) {
  const applicationKey =
    typeof track?.application_key === "string"
      ? track.application_key.trim().toLocaleLowerCase()
      : "";
  if (applicationKey) return `application:${applicationKey}`;
  return trackKind(track);
}

function displaySource(track) {
  if (typeof track?.application_display_name === "string" && track.application_display_name) {
    return track.application_display_name;
  }
  if (trackKind(track) === "mic") return "麦克风";
  return "系统音频";
}

function normalizeEmbedding(value) {
  if (!(value instanceof Float32Array) && !(value instanceof Float64Array)) return null;
  if (value.length === 0) return null;
  let squared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) return null;
    squared += item * item;
  }
  if (squared <= 0) return null;
  const norm = Math.sqrt(squared);
  return Float64Array.from(value, (item) => item / norm);
}

function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(-1, Math.min(1, score));
}

function overlaps(left, right) {
  const leftStart = finiteInteger(left?.started_at);
  const leftEnd = finiteInteger(left?.ended_at, Number.MAX_SAFE_INTEGER);
  const rightStart = finiteInteger(right?.started_at);
  const rightEnd = finiteInteger(right?.ended_at, Number.MAX_SAFE_INTEGER);
  return Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart) > 1_000;
}

function activityContext(cluster, track, activities, applicationPolicy) {
  if (cluster?.reviewOverride?.disposition === "media") return "media";
  if (cluster?.reviewOverride?.disposition === "social") return "interaction";
  if (cluster?.linkState === "confirmed" && cluster?.person) return "interaction";
  const kind = trackKind(track);
  if (kind === "mic") return "interaction";
  const applicationClass = applicationPolicy.classify(track?.application_key);
  if (applicationClass === "communication") return "interaction";
  if (applicationClass === "game_or_media") return "media";
  const segments = Array.isArray(cluster?.evidenceSegments) ? cluster.evidenceSegments : [];
  const relevant = activities.filter((activity) => {
    const confidence = Number(activity?.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.55) return false;
    if (segments.length === 0) return true;
    const startedAt = finiteInteger(activity?.started_at ?? activity?.startedAt);
    const endedAt = finiteInteger(activity?.ended_at ?? activity?.endedAt);
    return segments.some(
      (segment) =>
        Math.min(finiteInteger(segment.ended_at), endedAt) -
          Math.max(finiteInteger(segment.started_at), startedAt) >
        0
    );
  });
  if (
    relevant.some((activity) =>
      INTERACTION_CATEGORIES.has(activity?.category)
    )
  ) {
    return "interaction";
  }
  if (relevant.some((activity) => MEDIA_CATEGORIES.has(activity?.category))) {
    return "media";
  }
  return kind === "system_mix" ? "system_mix" : "uncertain";
}

function eligibleCluster(cluster) {
  if (cluster?.linkState === "confirmed") return true;
  if (new Set(["social", "media"]).has(cluster?.reviewOverride?.disposition)) return true;
  const speechMs = finiteInteger(cluster?.speechMs);
  const segmentCount = Array.isArray(cluster?.evidenceSegments)
    ? cluster.evidenceSegments.length
    : Array.isArray(cluster?.evidenceSegmentIds)
      ? cluster.evidenceSegmentIds.length
      : 0;
  return speechMs >= SESSION_MINIMUM_SPEECH_MS || segmentCount >= SESSION_MINIMUM_SEGMENTS;
}

function stableGroupKey(cluster) {
  if (
    cluster?.reviewOverride?.disposition === "social" &&
    typeof cluster.reviewOverride.groupRef === "string" &&
    cluster.reviewOverride.groupRef
  ) {
    return `review:${cluster.reviewOverride.groupRef}`;
  }
  if (cluster?.linkState === "confirmed" && cluster?.person?.id) {
    return `person:${cluster.person.id}`;
  }
  if (
    typeof cluster?.candidatePersonRef === "string" &&
    cluster.candidatePersonRef.startsWith("anonymous-speaker-") &&
    new Set(["dual_model_anonymous_group", "dual_model_anonymous_profile"]).has(cluster.reason)
  ) {
    return `anonymous:${cluster.candidatePersonRef}`;
  }
  return null;
}

function canSessionMerge(left, right) {
  if (left.sourceGroup !== right.sourceGroup) return false;
  if (left.track.id === right.track.id || overlaps(left.track, right.track)) return false;
  const similarity = cosine(left.embedding, right.embedding);
  return similarity >= SESSION_SIMILARITY_THRESHOLD;
}

function mergeTemporaryCandidates(candidates) {
  const groups = [];
  for (const candidate of candidates) {
    const compatible = groups
      .map((members, index) => ({
        index,
        compatible: members.every((member) => canSessionMerge(candidate, member)),
        score: Math.min(
          ...members.map((member) => cosine(candidate.embedding, member.embedding))
        ),
      }))
      .filter((entry) => entry.compatible)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if (compatible.length === 0) groups.push([candidate]);
    else groups[compatible[0].index].push(candidate);
  }
  return groups;
}

function uniqueSegments(members) {
  const seen = new Set();
  const segments = [];
  for (const member of members) {
    for (const segment of member.cluster.evidenceSegments ?? []) {
      if (!segment?.id || seen.has(segment.id)) continue;
      seen.add(segment.id);
      segments.push({
        clusterId: member.cluster.baseClusterId ?? member.cluster.id,
        ...segment,
        sourceName: displaySource(member.track),
      });
    }
  }
  return segments;
}

function publicCluster(cluster) {
  const {
    embedding: _embedding,
    _embedding: _privateEmbedding,
    evidenceSegments: _evidenceSegments,
    resolutionModels: _resolutionModels,
    reviewOverride: _reviewOverride,
    ...safe
  } = cluster;
  return safe;
}

function selectRepresentativeSegments(segments) {
  const safe = [...segments]
    .filter(
      (segment) =>
        typeof segment?.id === "string" &&
        Number.isSafeInteger(segment.started_at) &&
        Number.isSafeInteger(segment.ended_at) &&
        segment.ended_at > segment.started_at
    )
    .sort((left, right) => left.started_at - right.started_at || left.id.localeCompare(right.id));
  if (safe.length <= 3) return safe;
  const best = [...safe].sort((left, right) => {
    const confidence = Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
    if (confidence !== 0) return confidence;
    const duration =
      right.ended_at -
      right.started_at -
      (left.ended_at - left.started_at);
    return duration || left.started_at - right.started_at;
  })[0];
  const selected = [safe[0], best, safe.at(-1)];
  const unique = [...new Map(selected.map((segment) => [segment.id, segment])).values()];
  for (const segment of safe) {
    if (unique.length >= 3) break;
    if (!unique.some((entry) => entry.id === segment.id)) unique.push(segment);
  }
  return unique.sort(
    (left, right) => left.started_at - right.started_at || left.id.localeCompare(right.id)
  );
}

function participantFromMembers(members, kind, index) {
  const clusters = members.map((member) => member.cluster);
  const reviewedGroupRef =
    clusters.find(
      (cluster) =>
        cluster?.reviewOverride?.disposition === "social" &&
        typeof cluster.reviewOverride.groupRef === "string" &&
        cluster.reviewOverride.groupRef
    )?.reviewOverride.groupRef ?? null;
  const person = clusters.find((cluster) => cluster.person)?.person ?? null;
  const anonymousRef =
    clusters.find(
      (cluster) =>
        typeof cluster.candidatePersonRef === "string" &&
        cluster.candidatePersonRef.startsWith("anonymous-speaker-")
    )?.candidatePersonRef ?? null;
  const speechMs = clusters.reduce(
    (total, cluster) => total + finiteInteger(cluster.speechMs),
    0
  );
  const segmentCount = new Set(
    clusters.flatMap((cluster) =>
      (cluster.evidenceSegments ?? []).map((segment) => segment.id)
    )
  ).size;
  const sourceNames = [...new Set(members.map((member) => displaySource(member.track)))];
  const stable =
    kind === "self" || kind === "known" || kind === "anonymous" || kind === "reviewed";
  const displayName =
    kind === "self"
      ? "我"
      : person?.displayName ??
        `${
          kind === "media" ? "媒体声音" : kind === "reviewed" ? "已复核人物" : "人物"
        } ${String.fromCharCode(65 + (index % 26))}`;
  return {
    id:
      (kind === "reviewed" && reviewedGroupRef
        ? `review:${reviewedGroupRef}`
        : null) ??
      person?.id ??
      anonymousRef ??
      `${kind}:${clusters
        .map((cluster) => cluster.projectionRef ?? cluster.id)
        .sort()
        .join("+")}`,
    kind,
    displayName,
    person,
    candidatePersonRef: anonymousRef,
    reviewState: stable ? "confirmed" : kind === "media" ? "media" : "needs_review",
    durable:
      kind === "self" ||
      kind === "known" ||
      (kind === "anonymous" &&
        speechMs >= LONG_TERM_MINIMUM_SPEECH_MS &&
        segmentCount >= LONG_TERM_MINIMUM_SEGMENTS),
    speechMs,
    segmentCount,
    clusterCount: clusters.length,
    clusterIds: [
      ...new Set(clusters.map((cluster) => cluster.baseClusterId ?? cluster.id)),
    ],
    segmentIds: [
      ...new Set(
        clusters.flatMap((cluster) =>
          (cluster.evidenceSegments ?? []).map((segment) => segment.id)
        )
      ),
    ],
    sourceNames,
    minimumCount: 1,
    maximumCount: stable ? 1 : clusters.length,
    score:
      clusters
        .map((cluster) => cluster.score)
        .filter((score) => typeof score === "number")
        .sort((left, right) => left - right)[0] ?? null,
    representativeSegments: selectRepresentativeSegments(uniqueSegments(members)),
    representativeCluster: publicCluster(clusters[0]),
  };
}

function projectSessionParticipants({
  clusters = [],
  tracks = [],
  activityClassifications = [],
  applicationPolicy = new ApplicationAudioPolicy(),
} = {}) {
  if (!Array.isArray(clusters) || !Array.isArray(tracks)) {
    throw new TypeError("clusters and tracks must be arrays");
  }
  const trackById = new Map(tracks.map((entry) => [entry.id, entry]));
  const exactApplicationEvidence = tracks.some(
    (entry) =>
      trackKind(entry) === "application" &&
      clusters.some((cluster) => cluster.trackId === entry.id && eligibleCluster(cluster))
  );
  const excluded = {
    fragmented: 0,
    shadowedSystemMix: 0,
    anomaly: false,
  };
  const classified = [];
  for (const cluster of clusters) {
    const track = trackById.get(cluster.trackId) ?? {
      id: cluster.trackId ?? "unknown",
      source_type: "system",
      application_key: null,
      application_display_name: null,
    };
    if (!eligibleCluster(cluster)) {
      excluded.fragmented += 1;
      continue;
    }
    const context = activityContext(
      cluster,
      track,
      activityClassifications,
      applicationPolicy
    );
    if (
      context === "system_mix" &&
      exactApplicationEvidence &&
      cluster.linkState !== "confirmed"
    ) {
      excluded.shadowedSystemMix += 1;
      continue;
    }
    classified.push({
      cluster,
      track,
      context,
      sourceGroup: sourceGroup(track),
      embedding: normalizeEmbedding(cluster._embedding ?? cluster.embedding),
    });
  }
  excluded.anomaly = classified.length > MAXIMUM_PUBLIC_EVIDENCE_CLUSTERS;
  const bounded = excluded.anomaly
    ? classified.slice(0, MAXIMUM_PUBLIC_EVIDENCE_CLUSTERS)
    : classified;
  const mediaMembers = bounded.filter((entry) => entry.context === "media");
  const socialMembers = bounded.filter((entry) => entry.context !== "media");

  const stable = new Map();
  const temporary = [];
  for (const member of socialMembers) {
    const key = stableGroupKey(member.cluster);
    if (!key) {
      temporary.push(member);
      continue;
    }
    const entries = stable.get(key) ?? [];
    entries.push(member);
    stable.set(key, entries);
  }

  const participantMemberGroups = [
    ...stable.values(),
    ...mergeTemporaryCandidates(temporary),
  ];
  const participants = participantMemberGroups
    .map((members, index) => {
      const first = members[0].cluster;
      const kind =
        stableGroupKey(first)?.startsWith("review:")
          ? "reviewed"
          : first.linkState === "confirmed" && first.person?.isSelf
          ? "self"
          : first.linkState === "confirmed" && first.person
            ? "known"
          : stableGroupKey(first)?.startsWith("anonymous:")
            ? "anonymous"
            : stableGroupKey(first)?.startsWith("review:")
              ? "reviewed"
              : "temporary";
      return participantFromMembers(members, kind, index);
    })
    .sort((left, right) => {
      const priority = { self: 0, known: 1, anonymous: 2, reviewed: 3, temporary: 4 };
      return (
        priority[left.kind] - priority[right.kind] ||
        right.speechMs - left.speechMs ||
        left.id.localeCompare(right.id)
      );
    });
  const mediaVoices = mergeTemporaryCandidates(mediaMembers).map((members, index) =>
    participantFromMembers(members, "media", index)
  );
  const count = participants.reduce(
    (summary, participant) => {
      summary.minimum +=
        participant.kind === "temporary" &&
        socialMembers.find(
          (member) =>
            participant.clusterIds.includes(member.cluster.id) &&
            member.context === "uncertain"
        )
          ? 0
          : participant.minimumCount;
      summary.maximum += participant.maximumCount;
      if (
        participant.kind === "self" ||
        participant.kind === "known" ||
        participant.kind === "reviewed"
      ) {
        summary.confirmed += 1;
      }
      if (participant.kind === "temporary") summary.needsReview += 1;
      if (participant.kind === "self") summary.selfIncluded = true;
      return summary;
    },
    {
      minimum: 0,
      maximum: 0,
      confirmed: 0,
      needsReview: 0,
      selfIncluded: false,
    }
  );
  excluded.anomaly =
    excluded.anomaly || count.maximum > MAXIMUM_PUBLIC_PARTICIPANT_COUNT;
  return {
    projectorVersion: PROJECTOR_VERSION,
    count,
    participants,
    mediaVoices,
    excluded,
  };
}

module.exports = {
  LONG_TERM_MINIMUM_SEGMENTS,
  LONG_TERM_MINIMUM_SPEECH_MS,
  PROJECTOR_VERSION,
  SESSION_MINIMUM_SEGMENTS,
  SESSION_MINIMUM_SPEECH_MS,
  projectSessionParticipants,
  selectRepresentativeSegments,
};
