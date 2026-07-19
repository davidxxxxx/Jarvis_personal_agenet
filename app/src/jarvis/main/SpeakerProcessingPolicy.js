const crypto = require("node:crypto");
const { SPEAKER_IDENTITY_MODEL_POLICY } = require("./SessionDiarizationPolicy");

const TERMINAL_SESSION_STATES = new Set(["completed", "recovered", "failed"]);
const TERMINAL_TRACK_STATES = new Set(["ended", "recovered", "failed"]);

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneRow(row) {
  return row && typeof row === "object" ? { ...row } : row;
}

function safeInteger(value) {
  return Number.isSafeInteger(value);
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareChunks(left, right) {
  const sequence = left.audioChunk?.sequence_number - right.audioChunk?.sequence_number;
  return sequence || compareText(left.audioChunk?.id, right.audioChunk?.id);
}

function compareSegments(left, right) {
  return (
    left.started_at - right.started_at ||
    left.ended_at - right.ended_at ||
    compareText(left.id, right.id)
  );
}

function pcmHash(chunk) {
  return chunk.pcm_sha256 ?? chunk.sha256;
}

function terminalSession(session) {
  return Boolean(
    session &&
    TERMINAL_SESSION_STATES.has(session.status) &&
    safeInteger(session.started_at) &&
    safeInteger(session.ended_at) &&
    session.ended_at >= session.started_at
  );
}

function terminalTrack(track) {
  return Boolean(
    track &&
    TERMINAL_TRACK_STATES.has(track.state) &&
    safeInteger(track.started_at) &&
    safeInteger(track.ended_at) &&
    track.ended_at >= track.started_at
  );
}

function completeAudio(session, track, entries) {
  if (entries.length === 0) return false;
  let previous = null;
  for (let index = 0; index < entries.length; index += 1) {
    const chunk = entries[index].audioChunk;
    if (
      !chunk ||
      chunk.sequence_number !== index ||
      chunk.session_id !== session.id ||
      chunk.track_id !== track.id ||
      chunk.source_type !== track.source_type ||
      chunk.write_state !== "committed" ||
      !safeInteger(chunk.started_at) ||
      !safeInteger(chunk.ended_at) ||
      !safeInteger(chunk.duration_ms) ||
      chunk.started_at < track.started_at ||
      chunk.ended_at > track.ended_at ||
      chunk.ended_at <= chunk.started_at ||
      chunk.duration_ms !== chunk.ended_at - chunk.started_at ||
      typeof pcmHash(chunk) !== "string" ||
      pcmHash(chunk).length === 0 ||
      !safeInteger(chunk.sample_rate) ||
      chunk.sample_rate <= 0 ||
      !safeInteger(chunk.channels) ||
      chunk.channels <= 0 ||
      (previous && chunk.started_at < previous.ended_at)
    ) {
      return false;
    }
    previous = chunk;
  }
  return true;
}

function audioDeleted(entries) {
  return entries.some(({ audioChunk }) => {
    const path = audioChunk?.path;
    return audioChunk?.deleted_at !== null && audioChunk?.deleted_at !== undefined
      ? true
      : typeof path === "string" && path.startsWith("tombstone:");
  });
}

function audioExpired(entries, observedAt) {
  return entries.some(
    ({ audioChunk }) => !safeInteger(audioChunk?.expires_at) || audioChunk.expires_at <= observedAt
  );
}

function stableAudioInput(session, track, entries) {
  return {
    version: 1,
    session: {
      id: session.id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      status: session.status,
    },
    track: {
      id: track.id,
      sessionId: track.session_id,
      sourceType: track.source_type,
      startedAt: track.started_at,
      endedAt: track.ended_at,
      state: track.state,
    },
    chunks: entries.map(({ audioChunk: chunk }) => [
      chunk.id,
      chunk.source_type,
      chunk.sequence_number,
      chunk.started_at,
      chunk.ended_at,
      chunk.duration_ms,
      pcmHash(chunk),
      chunk.sample_rate,
      chunk.channels,
    ]),
  };
}

function validJob(job, session, track, chunk) {
  return Boolean(
    job &&
    job.session_id === session.id &&
    job.track_id === track.id &&
    job.chunk_id === chunk.id &&
    job.job_type === "transcribe_chunk"
  );
}

function validFinalSegments(segments, session, track, chunk, modelVersion) {
  if (segments.length === 0) return false;
  let coveredUntil = chunk.started_at;
  for (const segment of segments) {
    if (
      segment.session_id !== session.id ||
      segment.track_id !== track.id ||
      segment.chunk_id !== chunk.id ||
      segment.source_type !== chunk.source_type ||
      segment.result_kind !== "final" ||
      segment.is_stable !== 1 ||
      segment.model_version !== modelVersion ||
      (segment.superseded_by !== null && segment.superseded_by !== undefined) ||
      !safeInteger(segment.started_at) ||
      !safeInteger(segment.ended_at) ||
      segment.ended_at <= segment.started_at ||
      segment.started_at > coveredUntil
    ) {
      return false;
    }
    coveredUntil = Math.max(coveredUntil, segment.ended_at);
  }
  return segments[0].started_at <= chunk.started_at && coveredUntil >= chunk.ended_at;
}

function segmentRevisionRow(segment) {
  return [
    segment.id,
    segment.started_at,
    segment.ended_at,
    segment.source_type,
    segment.text,
    segment.confidence,
    segment.version,
    segment.model_version,
    segment.echo_score ?? null,
    segment.duplicate_of ?? null,
    segment.superseded_by ?? null,
  ];
}

class SpeakerProcessingPolicy {
  constructor({
    transcriptionInputVersion = 1,
    transcriptionModelVersion,
    identityModelPolicy = SPEAKER_IDENTITY_MODEL_POLICY,
  } = {}) {
    if (!Number.isSafeInteger(transcriptionInputVersion) || transcriptionInputVersion < 1) {
      throw new TypeError("transcriptionInputVersion must be a positive safe integer");
    }
    if (typeof transcriptionModelVersion !== "string" || !transcriptionModelVersion.trim()) {
      throw new TypeError("transcriptionModelVersion must be a non-empty string");
    }
    if (
      !identityModelPolicy ||
      !Object.isFrozen(identityModelPolicy) ||
      identityModelPolicy.primary?.embeddingSpace === identityModelPolicy.review?.embeddingSpace
    ) {
      throw new TypeError("identityModelPolicy must contain immutable isolated model spaces");
    }
    this.transcriptionInputVersion = transcriptionInputVersion;
    this.transcriptionModelVersion = transcriptionModelVersion.trim();
    this.identityModelPolicy = identityModelPolicy;
    Object.freeze(this);
  }

  evaluate(trackEvidence = {}) {
    const observedAt = trackEvidence.observedAt;
    if (!safeInteger(observedAt) || observedAt < 0) {
      throw new TypeError("trackEvidence.observedAt must be a non-negative safe integer");
    }
    const session = cloneRow(trackEvidence.session);
    const track = cloneRow(trackEvidence.track);
    const rawEntries = Array.isArray(trackEvidence.chunks) ? trackEvidence.chunks : [];
    const entries = rawEntries
      .map((entry) => ({
        audioChunk: cloneRow(entry?.audioChunk),
        latestTranscriptionJob: cloneRow(entry?.latestTranscriptionJob),
        transcriptSegments: Array.isArray(entry?.transcriptSegments)
          ? entry.transcriptSegments.map(cloneRow).sort(compareSegments)
          : [],
      }))
      .sort(compareChunks);

    const rejectAudio = (reason) =>
      deepFreeze({
        eligible: false,
        reason,
        stableAudioRevision: null,
        transcriptRevision: null,
        evidenceRevision: null,
        session,
        track,
        chunks: [],
      });
    if (!terminalSession(session)) return rejectAudio("session_not_terminal");
    if (!terminalTrack(track) || track.session_id !== session.id) {
      return rejectAudio("track_not_terminal");
    }
    if (!completeAudio(session, track, entries)) return rejectAudio("final_audio_incomplete");
    if (audioDeleted(entries)) return rejectAudio("final_audio_deleted");
    if (audioExpired(entries, observedAt)) return rejectAudio("final_audio_expired");

    const stableAudioRevision = sha256(stableAudioInput(session, track, entries));
    const selected = [];
    const rejectTranscript = (reason) =>
      deepFreeze({
        eligible: false,
        reason,
        stableAudioRevision,
        transcriptRevision: null,
        evidenceRevision: null,
        session,
        track,
        chunks: selected,
      });

    for (const entry of entries) {
      const chunk = entry.audioChunk;
      const job = entry.latestTranscriptionJob;
      if (!job) return rejectTranscript("final_transcript_missing");
      if (!validJob(job, session, track, chunk) || job.state !== "completed") {
        return rejectTranscript("final_transcript_pending");
      }
      if (
        job.input_hash !== pcmHash(chunk) ||
        job.input_version !== this.transcriptionInputVersion
      ) {
        return rejectTranscript("final_transcript_stale");
      }
      if (job.model_version !== this.transcriptionModelVersion) {
        return rejectTranscript("final_transcript_model_mismatch");
      }

      const currentSegments = entry.transcriptSegments.filter(
        (segment) => segment.model_version === this.transcriptionModelVersion
      );
      let transcriptionResult;
      if (chunk.transcription_status === "no_speech") {
        if (currentSegments.length !== 0) {
          return rejectTranscript("final_transcript_invalid");
        }
        transcriptionResult = "no_speech";
      } else if (chunk.transcription_status === "completed") {
        if (
          !validFinalSegments(
            currentSegments,
            session,
            track,
            chunk,
            this.transcriptionModelVersion
          )
        ) {
          return rejectTranscript("final_transcript_invalid");
        }
        transcriptionResult = "final";
      } else {
        return rejectTranscript("final_transcript_invalid");
      }
      selected.push({ ...entry, transcriptSegments: currentSegments, transcriptionResult });
    }

    const transcriptRevision = sha256({
      version: 1,
      transcriptionInputVersion: this.transcriptionInputVersion,
      transcriptionModelVersion: this.transcriptionModelVersion,
      chunks: selected.map((entry) => [
        entry.audioChunk.id,
        entry.latestTranscriptionJob.input_hash,
        entry.latestTranscriptionJob.input_version,
        entry.latestTranscriptionJob.model_version,
        entry.transcriptionResult,
        entry.transcriptSegments.map(segmentRevisionRow),
      ]),
    });
    const evidenceRevision = sha256({
      version: 1,
      stableAudioRevision,
      transcriptRevision,
    });
    return deepFreeze({
      eligible: true,
      reason: null,
      stableAudioRevision,
      transcriptRevision,
      evidenceRevision,
      session,
      track,
      chunks: selected,
    });
  }
}

module.exports = SpeakerProcessingPolicy;
module.exports.SpeakerProcessingPolicy = SpeakerProcessingPolicy;
