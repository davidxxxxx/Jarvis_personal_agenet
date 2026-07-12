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

function toPublicSessionDetail(detail) {
  if (!detail || typeof detail !== "object" || !Array.isArray(detail.audioChunks)) return detail;
  return {
    ...detail,
    audioChunks: detail.audioChunks.map(toPublicAudioChunk),
  };
}

module.exports = { PUBLIC_AUDIO_CHUNK_FIELDS, toPublicAudioChunk, toPublicSessionDetail };
