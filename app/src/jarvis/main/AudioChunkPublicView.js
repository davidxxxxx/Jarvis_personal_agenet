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
  "sample_rate",
  "channels",
  "started_at",
  "ended_at",
  "state",
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
  RENDERER_AUDIO_GAP_FIELDS,
  toPublicAudioChunk,
  toRendererAudioChunk,
  toRendererAudioGap,
  toRendererAudioTrack,
  toRendererSession,
  toPublicSessionDetail,
  toRendererSessionTimeline,
};
