const PUBLIC_AUDIO_CHUNK_FIELDS = Object.freeze([
  "id",
  "session_id",
  "path",
  "started_at",
  "ended_at",
  "duration_ms",
  "sha256",
  "pcm_sha256",
  "expires_at",
  "transcription_status",
  "track_id",
  "source_type",
  "sequence_number",
  "write_state",
  "deleted_at",
  "format",
  "file_sha256",
  "sample_rate",
  "channels",
]);

function toPublicAudioChunk(row) {
  if (!row || typeof row !== "object") return row;
  const result = {};
  for (const field of PUBLIC_AUDIO_CHUNK_FIELDS) {
    if (Object.hasOwn(row, field)) result[field] = row[field];
  }
  return result;
}

const RENDERER_AUDIO_CHUNK_FIELDS = Object.freeze([
  "id",
  "session_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "track_id",
  "source_type",
  "sequence_number",
  "write_state",
  "deleted_at",
  "format",
]);

const RENDERER_AUDIO_TRACK_FIELDS = Object.freeze([
  "id",
  "session_id",
  "source_type",
  "track_kind",
  "application_key",
  "application_display_name",
  "attribution_state",
  "capture_generation",
  "sample_rate",
  "channels",
  "started_at",
  "ended_at",
  "state",
  "failure_code",
]);

const RENDERER_APPLICATION_AUDIO_INTERVAL_FIELDS = Object.freeze([
  "id",
  "session_id",
  "track_id",
  "interval_kind",
  "application_key",
  "attribution_state",
  "capture_generation",
  "started_at",
  "ended_at",
  "reason",
  "failure_code",
]);

const RENDERER_AUDIO_GAP_FIELDS = Object.freeze([
  "id",
  "track_id",
  "started_at",
  "ended_at",
  "reason",
  "recovery_attempts",
  "average_level",
  "peak_level",
]);

function projectFields(row, fields) {
  if (!row || typeof row !== "object") return row;
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(row, field)) result[field] = row[field];
  }
  return result;
}

function toRendererAudioChunk(row) {
  return projectFields(row, RENDERER_AUDIO_CHUNK_FIELDS);
}

function toRendererAudioGap(row) {
  return projectFields(row, RENDERER_AUDIO_GAP_FIELDS);
}

function toRendererAudioTrack(row) {
  if (!row || typeof row !== "object") return row;
  return {
    ...projectFields(row, RENDERER_AUDIO_TRACK_FIELDS),
    gaps: Array.isArray(row.gaps) ? row.gaps.map(toRendererAudioGap) : [],
  };
}

function toRendererApplicationAudioInterval(row) {
  return projectFields(row, RENDERER_APPLICATION_AUDIO_INTERVAL_FIELDS);
}

function summarizeApplicationAudio(intervals) {
  const closed = intervals.filter(
    (interval) =>
      Number.isSafeInteger(interval.started_at) &&
      Number.isSafeInteger(interval.ended_at) &&
      interval.ended_at > interval.started_at
  );
  const exact = closed.filter((interval) => interval.attribution_state === "exact");
  const fallback = closed.filter((interval) => interval.attribution_state === "mixed_unknown");
  const duration = (entries) =>
    entries.reduce((total, interval) => total + interval.ended_at - interval.started_at, 0);
  const exactDurationMs = duration(exact);
  const fallbackDurationMs = duration(fallback);
  const totalDurationMs = exactDurationMs + fallbackDurationMs;
  const recoveryPoints = exact
    .filter((interval) =>
      fallback.some(
        (degraded) =>
          degraded.capture_generation === interval.capture_generation &&
          degraded.ended_at === interval.started_at
      )
    )
    .map((interval) => interval.started_at)
    .filter((at, index, values) => values.indexOf(at) === index)
    .sort((left, right) => left - right);
  return {
    exact_duration_ms: exactDurationMs,
    fallback_duration_ms: fallbackDurationMs,
    exact_coverage_pct:
      totalDurationMs === 0 ? null : Math.round((exactDurationMs * 10_000) / totalDurationMs) / 100,
    degraded_intervals: fallback.map(toRendererApplicationAudioInterval),
    recovery_points: recoveryPoints,
  };
}

function toRendererSession(session) {
  return projectFields(session, [
    "id",
    "started_at",
    "ended_at",
    "status",
    "language",
    "created_at",
    "capture_mode",
    "retention_mode",
    "processing_state",
    "timeline_version",
    "finalized_at",
    "ready_at",
  ]);
}

function toPublicSessionDetail(detail) {
  if (!detail || typeof detail !== "object") return detail;
  return {
    session: toRendererSession(detail.session),
    summary: detail.summary ?? null,
    segments: Array.isArray(detail.segments) ? detail.segments : [],
    audioChunks: Array.isArray(detail.audioChunks)
      ? detail.audioChunks.map(toRendererAudioChunk)
      : [],
    topics: Array.isArray(detail.topics) ? detail.topics : [],
    todos: Array.isArray(detail.todos) ? detail.todos : [],
    memories: Array.isArray(detail.memories) ? detail.memories : [],
    speakerProcessing:
      detail.speakerProcessing && typeof detail.speakerProcessing === "object"
        ? detail.speakerProcessing
        : null,
  };
}

function toRendererPreviewStatus(status) {
  if (!status || typeof status !== "object") return null;
  return {
    ...projectFields(status, [
      "mode",
      "cadenceMs",
      "pending",
      "running",
      "pausedReason",
      "executionDevice",
      "recordingContinues",
    ]),
    lastError: status.lastError ? "preview_failed" : null,
  };
}

function toRendererSessionTimeline(timeline, previewStatus = null) {
  if (!timeline || typeof timeline !== "object") return timeline;
  return {
    ...projectFields(timeline, [
      "session_id",
      "started_at",
      "ended_at",
      "status",
      "processing_state",
      "timeline_version",
      "finalized_at",
      "ready_at",
    ]),
    tracks: Array.isArray(timeline.tracks) ? timeline.tracks.map(toRendererAudioTrack) : [],
    application_audio_intervals: Array.isArray(timeline.application_audio_intervals)
      ? timeline.application_audio_intervals.map(toRendererApplicationAudioInterval)
      : [],
    application_capture: summarizeApplicationAudio(
      Array.isArray(timeline.application_audio_intervals)
        ? timeline.application_audio_intervals
        : []
    ),
    gaps: Array.isArray(timeline.gaps) ? timeline.gaps.map(toRendererAudioGap) : [],
    chunks: Array.isArray(timeline.chunks) ? timeline.chunks.map(toRendererAudioChunk) : [],
    segments: Array.isArray(timeline.segments) ? timeline.segments : [],
    processing_counts: projectFields(timeline.processing_counts, [
      "pending",
      "leased",
      "retry",
      "blocked",
      "completed",
      "total",
    ]),
    preview_status: toRendererPreviewStatus(previewStatus),
  };
}

module.exports = {
  PUBLIC_AUDIO_CHUNK_FIELDS,
  RENDERER_AUDIO_CHUNK_FIELDS,
  RENDERER_AUDIO_TRACK_FIELDS,
  RENDERER_APPLICATION_AUDIO_INTERVAL_FIELDS,
  RENDERER_AUDIO_GAP_FIELDS,
  toPublicAudioChunk,
  toRendererAudioChunk,
  toRendererAudioGap,
  toRendererAudioTrack,
  toRendererApplicationAudioInterval,
  summarizeApplicationAudio,
  toRendererSession,
  toPublicSessionDetail,
  toRendererSessionTimeline,
};
