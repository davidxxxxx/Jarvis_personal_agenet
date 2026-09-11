const ApplicationAudioPolicy = require("../ApplicationAudioPolicy");
const MIN_APPLICATION_DIARIZATION_AUDIO_MS = 60_000;
const EXACT_APPLICATION_SYSTEM_MIX_COVERAGE_THRESHOLD = 0.8;
const PUBLIC_SPEAKER_MIN_SPEECH_MS = 5_000;
const PUBLIC_SPEAKER_MIN_WINDOWS = 3;
const PUBLIC_SPEAKER_MIN_QUALITY = 0.72;

function isPublicSpeakerCluster(cluster) {
  return Boolean(
    cluster &&
    (cluster.linkState === "confirmed" ||
      (cluster.speechMs >= PUBLIC_SPEAKER_MIN_SPEECH_MS &&
        cluster.windowCount >= PUBLIC_SPEAKER_MIN_WINDOWS &&
        cluster.qualityScore >= PUBLIC_SPEAKER_MIN_QUALITY))
  );
}

function mergeAudioRanges(chunks) {
  const ranges = chunks
    .map((chunk) => [chunk.started_at, chunk.ended_at])
    .filter(
      ([startedAt, endedAt]) =>
        Number.isSafeInteger(startedAt) && Number.isSafeInteger(endedAt) && endedAt > startedAt
    )
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) {
      merged.push([...range]);
    } else {
      previous[1] = Math.max(previous[1], range[1]);
    }
  }
  return merged;
}

function coveredAudioRatio(targetChunks, coveringChunks) {
  const targets = mergeAudioRanges(targetChunks);
  const coverings = mergeAudioRanges(coveringChunks);
  const targetMs = targets.reduce((total, range) => total + range[1] - range[0], 0);
  if (targetMs <= 0 || coverings.length === 0) return 0;
  let coveredMs = 0;
  let coveringIndex = 0;
  for (const target of targets) {
    while (coveringIndex < coverings.length && coverings[coveringIndex][1] <= target[0]) {
      coveringIndex += 1;
    }
    for (let index = coveringIndex; index < coverings.length; index += 1) {
      const covering = coverings[index];
      if (covering[0] >= target[1]) break;
      coveredMs += Math.max(0, Math.min(target[1], covering[1]) - Math.max(target[0], covering[0]));
    }
  }
  return Math.min(1, coveredMs / targetMs);
}

function selectLogicalAudioChunks(chunks) {
  const selected = [];
  for (const chunk of [...chunks].sort(
    (left, right) =>
      left.started_at - right.started_at ||
      right.ended_at - left.ended_at ||
      left.id.localeCompare(right.id)
  )) {
    const previous = selected.at(-1);
    if (!previous) {
      selected.push(chunk);
      continue;
    }
    if (chunk.started_at <= previous.started_at && chunk.ended_at >= previous.ended_at) {
      selected[selected.length - 1] = chunk;
      continue;
    }
    if (previous.started_at <= chunk.started_at && previous.ended_at >= chunk.ended_at) {
      continue;
    }
    selected.push(chunk);
  }
  return selected;
}

function preferredSpeakerEvidenceTracks(
  tracks,
  chunks,
  { completedApplicationTrackIds = new Set() } = {}
) {
  const audioMsByTrack = new Map();
  for (const chunk of chunks) {
    audioMsByTrack.set(
      chunk.track_id,
      (audioMsByTrack.get(chunk.track_id) ?? 0) + Math.max(0, chunk.duration_ms ?? 0)
    );
  }
  const applicationTracks = tracks
    .filter(
      (track) =>
        track.track_kind === "application" &&
        track.attribution_state === "exact" &&
        !ApplicationAudioPolicy.isVirtualAudioInfrastructure({
          applicationKey: track.application_key,
          applicationDisplayName: track.application_display_name,
        })
    )
    .sort(
      (left, right) =>
        (left.capture_generation ?? 0) - (right.capture_generation ?? 0) ||
        (left.started_at ?? 0) - (right.started_at ?? 0) ||
        left.id.localeCompare(right.id)
    );
  const applicationTracksByKey = new Map();
  for (const track of applicationTracks) {
    const members = applicationTracksByKey.get(track.application_key) ?? [];
    members.push(track);
    applicationTracksByKey.set(track.application_key, members);
  }
  const preferredApplicationByKey = new Map();
  const logicalMemberTrackIdsByCanonical = new Map();
  const logicalCanonicalTrackIdByMember = new Map();
  for (const [applicationKey, members] of applicationTracksByKey) {
    const aggregateAudioMs = members.reduce(
      (total, member) => total + (audioMsByTrack.get(member.id) ?? 0),
      0
    );
    if (
      aggregateAudioMs < MIN_APPLICATION_DIARIZATION_AUDIO_MS &&
      !members.some((member) => completedApplicationTrackIds.has(member.id))
    ) {
      continue;
    }
    const canonical = members[0];
    preferredApplicationByKey.set(applicationKey, canonical);
    audioMsByTrack.set(canonical.id, aggregateAudioMs);
    const memberIds = new Set(members.map((member) => member.id));
    logicalMemberTrackIdsByCanonical.set(canonical.id, memberIds);
    for (const memberId of memberIds) {
      logicalCanonicalTrackIdByMember.set(memberId, canonical.id);
    }
  }
  const qualifiedApplicationTrackIds = new Set(
    [...preferredApplicationByKey.values()].map((track) => track.id)
  );
  const exactApplicationChunks = chunks.filter((chunk) =>
    logicalCanonicalTrackIdByMember.has(chunk.track_id)
  );
  const coverageBySystemTrack = new Map();
  const preferred = tracks.filter((track) => {
    if (track.track_kind === "application") {
      return qualifiedApplicationTrackIds.has(track.id);
    }
    if (track.track_kind !== "system_mix") return true;
    const ratio = coveredAudioRatio(
      chunks.filter((chunk) => chunk.track_id === track.id),
      exactApplicationChunks
    );
    coverageBySystemTrack.set(track.id, ratio);
    return ratio < EXACT_APPLICATION_SYSTEM_MIX_COVERAGE_THRESHOLD;
  });
  return {
    preferred,
    coverageBySystemTrack,
    qualifiedApplicationTrackIds,
    logicalMemberTrackIdsByCanonical,
    logicalCanonicalTrackIdByMember,
    audioMsByTrack,
  };
}

module.exports = {
  MIN_APPLICATION_DIARIZATION_AUDIO_MS,
  PUBLIC_SPEAKER_MIN_SPEECH_MS,
  PUBLIC_SPEAKER_MIN_WINDOWS,
  PUBLIC_SPEAKER_MIN_QUALITY,
  isPublicSpeakerCluster,
  mergeAudioRanges,
  coveredAudioRatio,
  selectLogicalAudioChunks,
  preferredSpeakerEvidenceTracks,
};
