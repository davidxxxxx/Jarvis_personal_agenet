const MAX_CHUNK_DURATION_MS = 60_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TRACK_STATES = new Set(["ended", "recovered", "failed"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const RESTORATION_TARGET_STATES = new Set(["active", "paused"]);
const SOURCE_LIFECYCLE_SESSION_STATUSES = new Set(["recording", "paused"]);
const APPLICATION_KEY_PATTERN = /^[a-z0-9._-]{1,64}$/;
const APPLICATION_FAILURE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});

const { toPublicAudioChunk } = require("./AudioChunkPublicView");

const LOCAL_PROCESSING_JOB_TYPES = Object.freeze([
  "transcribe_chunk",
  "preview_transcription",
  "speaker",
  "diarize_track",
  "resolve_identities",
  "compress_chunk",
]);

function assertExactPlainObject(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  return value;
}

class CaptureEvidenceStore {
  constructor(db, { createId, now = Date.now }) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("db must be a better-sqlite3 database");
    }
    if (typeof createId !== "function" || typeof now !== "function") {
      throw new TypeError("createId and now must be functions");
    }

    this.db = db;
    this.createId = createId;
    this.now = now;
    this.statements = {
      createTrack: db.prepare(`
        INSERT INTO audio_tracks (
          id, session_id, source_type, application_key, application_display_name,
          capture_generation, device_id, device_label, strategy,
          sample_rate, channels, started_at, state, failure_code
        ) VALUES (
          @id, @sessionId, @sourceType, @applicationKey, @applicationDisplayName,
          @captureGeneration, @deviceId, @deviceLabel, @strategy,
          @sampleRate, @channels, @startedAt, @state, @failureCode
        )
      `),
      createApplicationAudioInterval: db.prepare(`
        INSERT INTO application_audio_intervals (
          id, session_id, track_id, interval_kind, application_key,
          attribution_state, capture_generation, started_at, ended_at, reason,
          failure_code, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @intervalKind, @applicationKey,
          @attributionState, @captureGeneration, @startedAt, @endedAt, @reason,
          @failureCode, @createdAt
        )
      `),
      createApplicationAudioFallbackEvidence: db.prepare(`
        INSERT INTO application_audio_fallback_evidence (
          interval_id, attempted_application_key,
          attempted_application_display_name, reason, failure_code,
          capture_generation, created_at
        ) VALUES (
          @intervalId, @attemptedApplicationKey,
          @attemptedApplicationDisplayName, @reason, @failureCode,
          @captureGeneration, @createdAt
        )
      `),
      closeApplicationAudioInterval: db.prepare(`
        UPDATE application_audio_intervals
        SET ended_at = @endedAt
        WHERE id = @id AND ended_at IS NULL AND @endedAt > started_at
      `),
      getApplicationAudioInterval: db.prepare(
        "SELECT * FROM application_audio_intervals WHERE id = ?"
      ),
      listApplicationAudioIntervals: db.prepare(`
        SELECT * FROM application_audio_intervals
        WHERE session_id = ?
        ORDER BY started_at, id
      `),
      setTrackState: db.prepare(`
        UPDATE audio_tracks
        SET state = @state, ended_at = @endedAt, failure_code = @failureCode
        WHERE id = @id
      `),
      openGap: db.prepare(`
        INSERT INTO audio_gaps (
          id, track_id, started_at, reason, recovery_attempts
        ) VALUES (
          @id, @trackId, @startedAt, @reason, @recoveryAttempts
        )
      `),
      recordEvidenceGap: db.prepare(`
        INSERT INTO audio_gaps (
          id, track_id, started_at, ended_at, reason, recovery_attempts,
          average_level, peak_level
        ) VALUES (
          @id, @trackId, @startedAt, @endedAt, @reason, 0,
          @averageLevel, @peakLevel
        )
      `),
      closeGap: db.prepare(`
        UPDATE audio_gaps
        SET ended_at = @endedAt,
            recovery_attempts = COALESCE(@recoveryAttempts, recovery_attempts),
            restored_device_id = @restoredDeviceId,
            restored_device_label = @restoredDeviceLabel,
            restored_strategy = @restoredStrategy
        WHERE id = @id AND ended_at IS NULL
      `),
      confirmClosedGapRestoration: db.prepare(`
        UPDATE audio_gaps
        SET restored_device_id = @restoredDeviceId,
            restored_device_label = @restoredDeviceLabel,
            restored_strategy = @restoredStrategy
        WHERE id = @id AND track_id = @trackId AND ended_at = @endedAt
      `),
      getTrack: db.prepare("SELECT * FROM audio_tracks WHERE id = ?"),
      getGap: db.prepare("SELECT * FROM audio_gaps WHERE id = ?"),
      getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      invalidateSessionReadiness: db.prepare(`
        UPDATE sessions
        SET processing_state = 'processing', ready_at = NULL,
            timeline_version = timeline_version + 1
        WHERE id = @sessionId
          AND (processing_state = 'ready' OR ready_at IS NOT NULL)
      `),
      listTracksForSession: db.prepare("SELECT * FROM audio_tracks WHERE session_id = ?"),
      getOpenGapForTrack: db.prepare(
        "SELECT * FROM audio_gaps WHERE track_id = ? AND ended_at IS NULL"
      ),
      listOpenGapsForTrack: db.prepare(
        "SELECT * FROM audio_gaps WHERE track_id = ? AND ended_at IS NULL ORDER BY started_at, id"
      ),
      finalizeSession: db.prepare(`
        UPDATE sessions
        SET status = @sessionStatus, ended_at = @at,
            stop_reason = NULL, durable_boundary_at = NULL,
            processing_state = 'processing', finalized_at = @at, ready_at = NULL,
            timeline_version = timeline_version + 1
        WHERE id = @sessionId
      `),
      transitionSession: db.prepare(`
        UPDATE sessions
        SET status = @status, ended_at = @endedAt,
            stop_reason = NULL, durable_boundary_at = NULL
        WHERE id = @sessionId
      `),
      pauseSessionForLowDisk: db.prepare(`
        UPDATE sessions
        SET status = 'paused', ended_at = NULL,
            stop_reason = 'capture_stopped_low_disk', durable_boundary_at = @at
        WHERE id = @sessionId
      `),
      findChunkSequence: db.prepare(`
        SELECT id FROM audio_chunks
        WHERE track_id = ? AND sequence_number = ?
      `),
      insertChunk: db.prepare(`
        INSERT INTO audio_chunks (
          id, session_id, track_id, source_type, sequence_number, path,
          started_at, ended_at, duration_ms, sha256, expires_at,
          transcription_status, write_state, format, file_sha256, sample_rate, channels
        ) VALUES (
          @id, @sessionId, @trackId, @sourceType, @sequenceNumber, @path,
          @startedAt, @endedAt, @durationMs, @sha256, @expiresAt,
          'pending', 'committed', @format, @fileSha256, @sampleRate, @channels
        )
      `),
      getChunk: db.prepare("SELECT * FROM audio_chunks WHERE id = ?"),
      recordStorageUsage: db.prepare(`
        INSERT OR IGNORE INTO storage_usage_events
          (kind, chunk_id, bytes, delta_bytes, occurred_at)
        VALUES (@kind, @chunkId, @bytes, @deltaBytes, @occurredAt)
      `),
      getCurrentStorageBytes: db.prepare(`
        SELECT bytes FROM storage_usage_events
        WHERE chunk_id = @chunkId
          AND kind = CASE @format
            WHEN 'flac' THEN 'flac_written'
            ELSE 'wav_written'
          END
      `),
      insertTranscriptionJob: db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          priority, input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId,
          'transcribe_chunk', 'pending',
          CASE (
            SELECT track.track_kind FROM audio_tracks AS track WHERE track.id = @trackId
          )
            WHEN 'mic' THEN 20
            WHEN 'system_mix' THEN 24
            ELSE 30
          END,
          @inputHash, @inputVersion, @modelVersion, @createdAt
        )
      `),
      getTranscriptionJobByInput: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'transcribe_chunk'
          AND chunk_id = @chunkId
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
      `),
      listChunksMissingCurrentTranscription: db.prepare(`
        SELECT chunk.*
        FROM audio_chunks AS chunk
        WHERE chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
          AND chunk.expires_at > @at
          AND EXISTS (
            SELECT 1 FROM processing_jobs AS historical
            WHERE historical.chunk_id = chunk.id
              AND historical.job_type = 'transcribe_chunk'
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM processing_jobs AS current
              WHERE current.chunk_id = chunk.id
                AND current.job_type = 'transcribe_chunk'
                AND current.input_hash = chunk.sha256
                AND current.input_version = @inputVersion
                AND current.model_version = @modelVersion
                AND current.state <> 'superseded'
            )
            OR EXISTS (
              SELECT 1 FROM processing_jobs AS stale
              WHERE stale.chunk_id = chunk.id
                AND stale.job_type = 'transcribe_chunk'
                AND stale.completed_at IS NULL
                AND stale.state IN ('pending', 'retry', 'retention_urgent')
                AND NOT (
                  stale.input_hash = chunk.sha256
                  AND stale.input_version = @inputVersion
                  AND stale.model_version = @modelVersion
                )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS active
            WHERE active.chunk_id = chunk.id
              AND active.job_type = 'transcribe_chunk'
              AND active.state = 'running'
              AND active.completed_at IS NULL
              AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at > @at
              AND NOT (
                active.input_hash = chunk.sha256
                AND active.input_version = @inputVersion
                AND active.model_version = @modelVersion
              )
          )
        ORDER BY chunk.ended_at, chunk.id
        LIMIT @limit
      `),
      supersedeStaleTranscriptionJobs: db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            completed_at = @at,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'TRANSCRIPTION_MODEL_SUPERSEDED',
            blocked_reason = NULL,
            execution_device = NULL
        WHERE chunk_id = @chunkId
          AND job_type = 'transcribe_chunk'
          AND completed_at IS NULL
          AND state IN ('pending', 'retry', 'retention_urgent')
          AND NOT (
            input_hash = @inputHash
            AND input_version = @inputVersion
            AND model_version = @modelVersion
          )
      `),
      reactivateSupersededTranscriptionJob: db.prepare(`
        UPDATE processing_jobs
        SET state = CASE WHEN attempt_count > 0 THEN 'retry' ELSE 'pending' END,
            priority = CASE (
              SELECT track.track_kind
              FROM audio_chunks AS chunk
              JOIN audio_tracks AS track ON track.id = chunk.track_id
              WHERE chunk.id = @chunkId
            )
              WHEN 'mic' THEN 20
              WHEN 'system_mix' THEN 24
              ELSE 30
            END,
            completed_at = NULL,
            next_retry_at = CASE WHEN attempt_count > 0 THEN @at ELSE NULL END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            blocked_reason = NULL,
            execution_device = NULL
        WHERE chunk_id = @chunkId
          AND job_type = 'transcribe_chunk'
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
          AND state = 'superseded'
      `),
      reprioritizeActiveTranscriptionJobs: db.prepare(`
        UPDATE processing_jobs AS job
        SET priority = CASE (
          SELECT track.track_kind FROM audio_tracks AS track WHERE track.id = job.track_id
        )
          WHEN 'mic' THEN 20
          WHEN 'system_mix' THEN 24
          ELSE 30
        END
        WHERE job.job_type = 'transcribe_chunk'
          AND job.state IN ('pending', 'retry')
          AND job.completed_at IS NULL
          AND job.priority <> 0
      `),
      insertCompressionJob: db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          priority, input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId,
          'compress_chunk', 'pending', 60, @inputHash, 1, @modelVersion, @createdAt
        )
      `),
      getCompressionJobByInput: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND model_version = @modelVersion
      `),
      getCompressionJob: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE id = ? AND job_type = 'compress_chunk'
      `),
      listCompressionChunks: db.prepare(`
        SELECT * FROM audio_chunks
        WHERE EXISTS (
            SELECT 1 FROM processing_jobs
            WHERE processing_jobs.chunk_id = audio_chunks.id
              AND processing_jobs.job_type = 'compress_chunk'
          )
        ORDER BY id
      `),
      listRetiredArtifactBacklog: db.prepare(`
        SELECT * FROM audio_chunks
        WHERE retired_path IS NOT NULL
        ORDER BY id
      `),
      getCompressionJobForChunk: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE chunk_id = ? AND job_type = 'compress_chunk'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      promoteChunkToFlac: db.prepare(`
        UPDATE audio_chunks
        SET path = @flacPath,
            format = 'flac',
            file_sha256 = @fileSha256,
            sample_rate = @sampleRate,
            channels = @channels
        WHERE id = @chunkId
          AND path = @wavPath
          AND format = 'wav'
          AND sha256 = @pcmSha256
          AND deleted_at IS NULL
          AND expires_at > @completedAt
          AND write_state = 'committed'
      `),
      promoteLeasedChunkToFlac: db.prepare(`
        UPDATE audio_chunks
        SET path = @flacPath,
            format = 'flac',
            file_sha256 = @fileSha256,
            sample_rate = @sampleRate,
            channels = @channels
        WHERE id = @chunkId
          AND path = @wavPath
          AND format = 'wav'
          AND sha256 = @pcmSha256
          AND deleted_at IS NULL
          AND expires_at > @completedAt
          AND write_state = 'committed'
          AND EXISTS (
            SELECT 1 FROM processing_jobs
            WHERE id = @jobId
              AND job_type = 'compress_chunk'
              AND chunk_id = @chunkId
              AND input_hash = @pcmSha256
              AND model_version = @encoderVersion
              AND state = 'running'
              AND completed_at IS NULL
              AND lease_owner = @owner
              AND lease_expires_at > @completedAt
          )
      `),
      completeCompressionJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'completed', completed_at = @completedAt,
            next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = NULL, blocked_reason = NULL, execution_device = 'cpu'
        WHERE id = @jobId
          AND job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND input_hash = @pcmSha256
          AND model_version = @encoderVersion
      `),
      rollbackChunkToWav: db.prepare(`
        UPDATE audio_chunks
        SET path = @wavPath,
            format = 'wav',
            file_sha256 = NULL,
            retired_path = @flacPath,
            retired_format = 'flac',
            retired_file_sha256 = @retiredFileSha256
        WHERE id = @chunkId
          AND path = @flacPath
          AND format = 'flac'
          AND sha256 = @pcmSha256
          AND file_sha256 = @fileSha256
          AND deleted_at IS NULL
          AND write_state = 'committed'
      `),
      clearRetiredArtifact: db.prepare(`
        UPDATE audio_chunks
        SET retired_path = NULL,
            retired_format = NULL,
            retired_file_sha256 = NULL
        WHERE id = @chunkId
          AND retired_path = @retiredPath
          AND retired_file_sha256 IS @retiredFileSha256
      `),
      setRetiredArtifactHash: db.prepare(`
        UPDATE audio_chunks
        SET retired_file_sha256 = @retiredFileSha256
        WHERE id = @chunkId
          AND retired_path = @retiredPath
          AND retired_format IS @retiredFormat
          AND retired_file_sha256 IS NULL
          AND path <> @retiredPath
      `),
      retryCompressionJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry', completed_at = NULL,
            next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'flac_authority_invalid_recovered'
        WHERE id = @jobId
          AND job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND model_version = @encoderVersion
      `),
      failCompressionRecovery: db.prepare(`
        UPDATE processing_jobs
        SET state = 'failed', error_code = 'flac_authority_invalid',
            completed_at = @failedAt,
            next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = @jobId
          AND job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND model_version = @encoderVersion
      `),
      retryUnreadableFlacRecovery: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry', error_code = 'flac_authority_temporarily_unreadable',
            completed_at = NULL, next_retry_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL
        WHERE id = @jobId
          AND job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND model_version = @encoderVersion
          AND EXISTS (
            SELECT 1 FROM audio_chunks
            WHERE id = @chunkId
              AND path = @flacPath
              AND format = 'flac'
              AND file_sha256 IS @fileSha256
              AND deleted_at IS NULL
          )
      `),
      completeUnreadableFlacRecovery: db.prepare(`
        UPDATE processing_jobs
        SET state = 'completed', error_code = NULL,
            completed_at = @verifiedAt, next_retry_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL
        WHERE id = @jobId
          AND job_type = 'compress_chunk'
          AND chunk_id = @chunkId
          AND model_version = @encoderVersion
          AND state = 'retry'
          AND error_code = 'flac_authority_temporarily_unreadable'
      `),
      tombstoneChunk: db.prepare(`
        UPDATE audio_chunks
        SET retired_path = COALESCE(retired_path, path),
            retired_format = COALESCE(retired_format, format),
            retired_file_sha256 = COALESCE(
              retired_file_sha256,
              CASE WHEN format = 'flac' THEN file_sha256 ELSE NULL END
            ),
            path = 'tombstone:' || id,
            deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
      expireUnfinishedChunkJobs: db.prepare(`
        UPDATE processing_jobs
        SET state = 'audio_expired_before_processing',
            error_code = 'audio_expired_before_processing',
            completed_at = @completedAt,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE chunk_id = @chunkId
          AND completed_at IS NULL
          AND state NOT IN (
            'completed', 'failed', 'cancelled', 'audio_expired_before_processing'
          )
      `),
      promoteSoonExpiringAudioJobs: db.prepare(`
        UPDATE processing_jobs
        SET state = CASE
              WHEN state IN ('pending', 'retry') THEN 'retention_urgent'
              ELSE state
            END,
            priority = 0
        WHERE job_type = 'transcribe_chunk'
          AND completed_at IS NULL
          AND state NOT IN (
            'completed', 'failed', 'cancelled', 'audio_expired_before_processing'
          )
          AND chunk_id IN (
            SELECT id FROM audio_chunks
            WHERE deleted_at IS NULL
              AND expires_at > @after
              AND expires_at <= @before
          )
          AND (
            priority <> 0
            OR state IN ('pending', 'retry')
          )
      `),
      promoteCompressionJobsForStoragePressure: db.prepare(`
        UPDATE processing_jobs
        SET state = 'storage_recovery_compress',
            priority = 10,
            next_retry_at = CASE
              WHEN next_retry_at IS NULL OR next_retry_at > @at THEN @at
              ELSE next_retry_at
            END,
            error_code = NULL,
            blocked_reason = NULL
        WHERE job_type = 'compress_chunk'
          AND state IN ('pending', 'retry', 'storage_recovery_compress')
          AND priority > 10
          AND completed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM audio_chunks
            WHERE audio_chunks.id = processing_jobs.chunk_id
              AND audio_chunks.format = 'wav'
              AND audio_chunks.write_state = 'committed'
              AND audio_chunks.deleted_at IS NULL
              AND audio_chunks.expires_at > @at
          )
      `),
      listClaimableJobs: db.prepare(`
        SELECT job.* FROM processing_jobs AS job
        WHERE job.lane = 'local'
          AND job.job_type IN (
            'transcribe_chunk','preview_transcription','speaker',
            'diarize_track','resolve_identities','compress_chunk'
          )
          AND job.state IN ('pending', 'retry', 'retention_urgent', 'storage_recovery_compress')
          AND job.completed_at IS NULL
          AND (job.next_retry_at IS NULL OR job.next_retry_at <= @at)
          AND job.priority < @priorityBefore
          AND NOT (
            job.job_type = 'diarize_track'
            AND EXISTS (
              SELECT 1 FROM audio_tracks AS application_track
              WHERE application_track.id = job.track_id
                AND application_track.track_kind = 'application'
            )
            AND EXISTS (
              SELECT 1
              FROM processing_jobs AS primary_job
              JOIN audio_tracks AS primary_track ON primary_track.id = primary_job.track_id
              WHERE primary_job.job_type = 'diarize_track'
                AND primary_job.session_id = job.session_id
                AND primary_job.completed_at IS NULL
                AND primary_job.state NOT IN ('completed', 'superseded')
                AND primary_track.track_kind = 'mic'
            )
          )
          AND NOT (
            job.job_type = 'diarize_track'
            AND EXISTS (
              SELECT 1 FROM audio_tracks AS system_track
              WHERE system_track.id = job.track_id
                AND system_track.track_kind = 'system_mix'
            )
            AND EXISTS (
              SELECT 1
              FROM processing_jobs AS preferred_job
              JOIN audio_tracks AS preferred_track ON preferred_track.id = preferred_job.track_id
              WHERE preferred_job.job_type = 'diarize_track'
                AND preferred_job.session_id = job.session_id
                AND preferred_job.completed_at IS NULL
                AND preferred_job.state NOT IN ('completed', 'superseded')
                AND preferred_track.track_kind IN ('mic', 'application')
            )
          )
        ORDER BY job.priority ASC,
          CASE
            WHEN job.job_type = 'diarize_track' THEN COALESCE(
              (
                SELECT COALESCE(session.ended_at, session.started_at)
                FROM sessions AS session
                WHERE session.id = job.session_id
              ),
              job.created_at
            )
          END DESC,
          job.created_at ASC,
          job.id ASC
        LIMIT @limit
      `),
      claimJob: db.prepare(`
        UPDATE processing_jobs AS job
        SET state = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = @owner,
            lease_expires_at = @leaseExpiresAt
        WHERE job.id = @id
          AND job.lane = 'local'
          AND job.job_type IN (
            'transcribe_chunk','preview_transcription','speaker',
            'diarize_track','resolve_identities','compress_chunk'
          )
          AND job.state IN ('pending', 'retry', 'retention_urgent', 'storage_recovery_compress')
          AND job.completed_at IS NULL
          AND (job.next_retry_at IS NULL OR job.next_retry_at <= @at)
          AND job.priority < @priorityBefore
          AND NOT (
            job.job_type = 'diarize_track'
            AND EXISTS (
              SELECT 1 FROM audio_tracks AS application_track
              WHERE application_track.id = job.track_id
                AND application_track.track_kind = 'application'
            )
            AND EXISTS (
              SELECT 1
              FROM processing_jobs AS primary_job
              JOIN audio_tracks AS primary_track ON primary_track.id = primary_job.track_id
              WHERE primary_job.job_type = 'diarize_track'
                AND primary_job.session_id = job.session_id
                AND primary_job.completed_at IS NULL
                AND primary_job.state NOT IN ('completed', 'superseded')
                AND primary_track.track_kind = 'mic'
            )
          )
          AND NOT (
            job.job_type = 'diarize_track'
            AND EXISTS (
              SELECT 1 FROM audio_tracks AS system_track
              WHERE system_track.id = job.track_id
                AND system_track.track_kind = 'system_mix'
            )
            AND EXISTS (
              SELECT 1
              FROM processing_jobs AS preferred_job
              JOIN audio_tracks AS preferred_track ON preferred_track.id = preferred_job.track_id
              WHERE preferred_job.job_type = 'diarize_track'
                AND preferred_job.session_id = job.session_id
                AND preferred_job.completed_at IS NULL
                AND preferred_job.state NOT IN ('completed', 'superseded')
                AND preferred_track.track_kind IN ('mic', 'application')
            )
          )
      `),
      getProcessingJob: db.prepare("SELECT * FROM processing_jobs WHERE id = ?"),
      recoverExpiredJobLeases: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            next_retry_at = @at,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'LEASE_EXPIRED',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = NULL
        WHERE state = 'running'
          AND lane = 'local'
          AND job_type IN (
            'transcribe_chunk','preview_transcription','speaker',
            'diarize_track','resolve_identities','compress_chunk'
          )
          AND completed_at IS NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @at
      `),
      wakeResourceDeferredJobs: db.prepare(`
        UPDATE processing_jobs
        SET next_retry_at = @at
        WHERE lane = 'local'
          AND state = 'retry'
          AND completed_at IS NULL
          AND blocked_reason IN ('external_gpu_busy', 'gpu_utilization_high')
          AND next_retry_at IS NOT NULL
          AND next_retry_at > @at
      `),
      insertCloudJob: db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, attempt_count,
          lane, analysis_input_id, desired_head_hash, digest_input_id, created_at
        ) VALUES (
          @id, @sessionId, NULL, NULL, @jobType, 'pending', @priority,
          @inputHash, @inputVersion, @modelVersion, 0,
          'cloud', @analysisInputId, @desiredHeadHash, NULL, @createdAt
        )
      `),
      getCloudJobByIdentity: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = @jobType
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
          AND analysis_input_id IS @analysisInputId
          AND desired_head_hash IS @desiredHeadHash
          AND digest_input_id IS NULL
          AND chunk_id IS NULL
      `),
      authorizeManualAnalysisRetry: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            completed_at = NULL,
            next_retry_at = @at,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'ANALYSIS_MANUAL_RETRY_AUTHORIZED',
            blocked_reason = NULL,
            execution_device = NULL
        WHERE id = @id
          AND lane = 'cloud'
          AND job_type = 'analyze_session'
          AND state = 'blocked'
          AND completed_at IS NOT NULL
          AND (
            error_code IN (
              'analysis_invalid_response',
              'analysis_reconciled_without_candidate',
              'analysis_candidate_apply_failed'
            )
            OR (
              @allowUsageUnknown = 1
              AND error_code = 'analysis_usage_unknown'
            )
          )
      `),
      getDailyDigestInputIdentity: db.prepare(`
        SELECT id, source_hash, model_version
        FROM daily_digest_inputs
        WHERE id = ?
      `),
      insertDailyDigestJob: db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, attempt_count,
          lane, analysis_input_id, desired_head_hash, digest_input_id, created_at
        ) VALUES (
          @id, NULL, NULL, NULL, 'generate_daily_digest', 'pending', 80,
          @inputHash, @inputVersion, @modelVersion, 0,
          'cloud', NULL, NULL, @digestInputId, @createdAt
        )
      `),
      getDailyDigestJobByInput: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'generate_daily_digest'
          AND digest_input_id = ?
      `),
      wakeDailyDigestJob: db.prepare(`
        UPDATE processing_jobs
        SET next_retry_at = @at
        WHERE job_type = 'generate_daily_digest'
          AND digest_input_id = @digestInputId
          AND state IN ('pending','retry')
          AND completed_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at > @at)
      `),
      authorizeManualDailyDigestRetry: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            completed_at = NULL,
            next_retry_at = @at,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED',
            blocked_reason = NULL,
            execution_device = NULL
        WHERE id = @id
          AND lane = 'cloud'
          AND job_type = 'generate_daily_digest'
          AND state = 'blocked'
          AND completed_at IS NOT NULL
          AND (
            error_code IN (
              'daily_digest_invalid_response',
              'daily_digest_reconciled_without_candidate'
            )
            OR (
              @allowUsageUnknown = 1
              AND error_code = 'daily_digest_usage_unknown'
            )
          )
      `),
      listClaimableCloudJobs: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE lane = 'cloud'
          AND job_type IN ('analyze_session','generate_daily_digest')
          AND state IN ('pending','retry')
          AND completed_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at <= @at)
          AND priority < @priorityBefore
          AND (
            (job_type = 'generate_daily_digest' AND digest_input_id IS NOT NULL)
            OR (analysis_input_id IS NOT NULL AND desired_head_hash IS NOT NULL)
          )
        ORDER BY priority ASC, created_at ASC, id ASC
        LIMIT @limit
      `),
      claimCloudJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = @owner,
            lease_expires_at = @leaseExpiresAt
        WHERE id = @id
          AND lane = 'cloud'
          AND job_type IN ('analyze_session','generate_daily_digest')
          AND state IN ('pending','retry')
          AND completed_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at <= @at)
          AND priority < @priorityBefore
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS active
            WHERE active.lane = 'cloud'
              AND active.state = 'running'
              AND active.completed_at IS NULL
              AND active.lease_expires_at > @at
              AND active.id <> processing_jobs.id
          )
          AND (
            (job_type = 'generate_daily_digest' AND digest_input_id IS NOT NULL)
            OR (analysis_input_id IS NOT NULL AND desired_head_hash IS NOT NULL)
          )
      `),
      recoverExpiredCloudCandidateLease: db.prepare(`
        UPDATE processing_jobs
        SET lease_owner = @owner,
            lease_expires_at = @leaseExpiresAt
        WHERE id = @id
          AND lane = 'cloud'
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @at
          AND priority < @priorityBefore
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS active
            WHERE active.lane = 'cloud'
              AND active.state = 'running'
              AND active.completed_at IS NULL
              AND active.lease_expires_at > @at
              AND active.id <> processing_jobs.id
          )
          AND (
            (
              job_type = 'analyze_session'
              AND EXISTS (
                SELECT 1
                FROM analysis_response_candidates AS candidate
                JOIN analysis_budget_attempts AS attempt
                  ON attempt.request_id = candidate.budget_attempt_id
                WHERE candidate.job_id = processing_jobs.id
                  AND candidate.analysis_input_id = processing_jobs.analysis_input_id
                  AND candidate.desired_vector_hash = processing_jobs.desired_head_hash
                  AND candidate.state IN ('validated','applied','superseded')
                  AND attempt.job_id = processing_jobs.id
                  AND attempt.provider = 'minimax'
                  AND attempt.model = processing_jobs.model_version
                  AND attempt.operation = 'session_analysis'
                  AND attempt.state = 'reconciled'
              )
            )
            OR (
              job_type = 'generate_daily_digest'
              AND digest_input_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM daily_digest_response_candidates AS candidate
                JOIN daily_digest_inputs AS input ON input.id = candidate.digest_input_id
                JOIN analysis_budget_attempts AS attempt
                  ON attempt.request_id = candidate.budget_attempt_id
                WHERE candidate.job_id = processing_jobs.id
                  AND candidate.digest_input_id = processing_jobs.digest_input_id
                  AND input.id = processing_jobs.digest_input_id
                  AND processing_jobs.input_hash = input.source_hash
                  AND candidate.state IN ('validated','applied','superseded')
                  AND attempt.job_id = processing_jobs.id
                  AND attempt.provider = 'minimax'
                  AND attempt.model = processing_jobs.model_version
                  AND attempt.operation = 'daily_digest'
                  AND attempt.state = 'reconciled'
              )
            )
          )
      `),
      listExpiredCloudCandidateLeases: db.prepare(`
        SELECT job_id, job_type, candidate_id, candidate_state
        FROM (
          SELECT job.id AS job_id, job.job_type AS job_type, candidate.id AS candidate_id,
                 candidate.state AS candidate_state, job.priority, candidate.created_at
          FROM processing_jobs AS job
          JOIN analysis_response_candidates AS candidate ON candidate.job_id = job.id
          JOIN analysis_budget_attempts AS attempt
            ON attempt.request_id = candidate.budget_attempt_id
          WHERE job.lane = 'cloud'
            AND job.job_type = 'analyze_session'
            AND job.state = 'running'
            AND job.completed_at IS NULL
            AND job.lease_expires_at IS NOT NULL
            AND job.lease_expires_at <= @at
            AND job.priority < @priorityBefore
            AND candidate.analysis_input_id = job.analysis_input_id
            AND candidate.desired_vector_hash = job.desired_head_hash
            AND candidate.state IN ('validated','applied','superseded')
            AND attempt.job_id = job.id
            AND attempt.provider = 'minimax'
            AND attempt.model = job.model_version
            AND attempt.operation = 'session_analysis'
            AND attempt.state = 'reconciled'
          UNION ALL
          SELECT job.id AS job_id, job.job_type AS job_type, candidate.id AS candidate_id,
                 candidate.state AS candidate_state, job.priority, candidate.created_at
          FROM processing_jobs AS job
          JOIN daily_digest_response_candidates AS candidate ON candidate.job_id = job.id
          JOIN daily_digest_inputs AS input ON input.id = candidate.digest_input_id
          JOIN analysis_budget_attempts AS attempt
            ON attempt.request_id = candidate.budget_attempt_id
          WHERE job.lane = 'cloud'
            AND job.job_type = 'generate_daily_digest'
            AND job.state = 'running'
            AND job.completed_at IS NULL
            AND job.lease_expires_at IS NOT NULL
            AND job.lease_expires_at <= @at
            AND job.priority < @priorityBefore
            AND job.digest_input_id IS NOT NULL
            AND candidate.digest_input_id = job.digest_input_id
            AND input.id = job.digest_input_id
            AND job.input_hash = input.source_hash
            AND candidate.state IN ('validated','applied','superseded')
            AND attempt.job_id = job.id
            AND attempt.provider = 'minimax'
            AND attempt.model = job.model_version
            AND attempt.operation = 'daily_digest'
            AND attempt.state = 'reconciled'
        )
        ORDER BY priority ASC, created_at ASC, candidate_id ASC
        LIMIT @limit
      `),
      recoverExpiredCloudPrestartLease: db.prepare(`
        UPDATE processing_jobs
        SET lease_owner = @owner,
            lease_expires_at = @leaseExpiresAt
        WHERE id = @id
          AND lane = 'cloud'
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @at
          AND priority < @priorityBefore
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS active
            WHERE active.lane = 'cloud'
              AND active.state = 'running'
              AND active.completed_at IS NULL
              AND active.lease_expires_at > @at
              AND active.id <> processing_jobs.id
          )
          AND (
            (
              job_type = 'analyze_session'
              AND analysis_input_id IS NOT NULL
              AND desired_head_hash IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM analysis_response_candidates AS candidate
                WHERE candidate.job_id = processing_jobs.id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS attempt
                  WHERE attempt.job_id = processing_jobs.id
                )
                OR EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS latest
                  WHERE latest.job_id = processing_jobs.id
                    AND latest.attempt_number = (
                      SELECT MAX(attempt.attempt_number)
                      FROM analysis_budget_attempts AS attempt
                      WHERE attempt.job_id = processing_jobs.id
                    )
                    AND latest.provider = 'minimax'
                    AND latest.model = processing_jobs.model_version
                    AND latest.operation = 'session_analysis'
                    AND (
                      latest.state IN ('started','usage_unknown','released')
                      OR (
                        latest.state = 'reconciled'
                        AND latest.actual_input_tokens IS NOT NULL
                        AND latest.actual_output_tokens IS NOT NULL
                        AND latest.actual_microusd IS NOT NULL
                      )
                    )
                )
              )
            )
            OR (
              job_type = 'generate_daily_digest'
              AND digest_input_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM daily_digest_inputs AS input
                WHERE input.id = processing_jobs.digest_input_id
                  AND input.source_hash = processing_jobs.input_hash
              )
              AND NOT EXISTS (
                SELECT 1 FROM daily_digest_response_candidates AS candidate
                WHERE candidate.job_id = processing_jobs.id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS attempt
                  WHERE attempt.job_id = processing_jobs.id
                )
                OR EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS latest
                  WHERE latest.job_id = processing_jobs.id
                    AND latest.attempt_number = (
                      SELECT MAX(attempt.attempt_number)
                      FROM analysis_budget_attempts AS attempt
                      WHERE attempt.job_id = processing_jobs.id
                    )
                    AND latest.provider = 'minimax'
                    AND latest.model = processing_jobs.model_version
                    AND latest.operation = 'daily_digest'
                    AND (
                      latest.state IN ('started','usage_unknown','released')
                      OR (
                        latest.state = 'reconciled'
                        AND latest.actual_input_tokens IS NOT NULL
                        AND latest.actual_output_tokens IS NOT NULL
                        AND latest.actual_microusd IS NOT NULL
                      )
                    )
                )
              )
            )
          )
      `),
      listExpiredCloudPrestartLeases: db.prepare(`
        SELECT job.id
        FROM processing_jobs AS job
        WHERE job.lane = 'cloud'
          AND job.state = 'running'
          AND job.completed_at IS NULL
          AND job.lease_expires_at IS NOT NULL
          AND job.lease_expires_at <= @at
          AND job.priority < @priorityBefore
          AND (
            (
              job.job_type = 'analyze_session'
              AND job.analysis_input_id IS NOT NULL
              AND job.desired_head_hash IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM analysis_response_candidates AS candidate
                WHERE candidate.job_id = job.id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS attempt
                  WHERE attempt.job_id = job.id
                )
                OR EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS latest
                  WHERE latest.job_id = job.id
                    AND latest.attempt_number = (
                      SELECT MAX(attempt.attempt_number)
                      FROM analysis_budget_attempts AS attempt
                      WHERE attempt.job_id = job.id
                    )
                    AND latest.provider = 'minimax'
                    AND latest.model = job.model_version
                    AND latest.operation = 'session_analysis'
                    AND (
                      latest.state IN ('started','usage_unknown','released')
                      OR (
                        latest.state = 'reconciled'
                        AND latest.actual_input_tokens IS NOT NULL
                        AND latest.actual_output_tokens IS NOT NULL
                        AND latest.actual_microusd IS NOT NULL
                      )
                    )
                )
              )
            )
            OR (
              job.job_type = 'generate_daily_digest'
              AND job.digest_input_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM daily_digest_inputs AS input
                WHERE input.id = job.digest_input_id
                  AND input.source_hash = job.input_hash
              )
              AND NOT EXISTS (
                SELECT 1 FROM daily_digest_response_candidates AS candidate
                WHERE candidate.job_id = job.id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS attempt
                  WHERE attempt.job_id = job.id
                )
                OR EXISTS (
                  SELECT 1 FROM analysis_budget_attempts AS latest
                  WHERE latest.job_id = job.id
                    AND latest.attempt_number = (
                      SELECT MAX(attempt.attempt_number)
                      FROM analysis_budget_attempts AS attempt
                      WHERE attempt.job_id = job.id
                    )
                    AND latest.provider = 'minimax'
                    AND latest.model = job.model_version
                    AND latest.operation = 'daily_digest'
                    AND (
                      latest.state IN ('started','usage_unknown','released')
                      OR (
                        latest.state = 'reconciled'
                        AND latest.actual_input_tokens IS NOT NULL
                        AND latest.actual_output_tokens IS NOT NULL
                        AND latest.actual_microusd IS NOT NULL
                      )
                    )
                )
              )
            )
          )
        ORDER BY job.priority ASC, job.created_at ASC, job.id ASC
        LIMIT @limit
      `),
      listAgentAdmissionBacklog: db.prepare(`
        SELECT job_type, lane, state, priority, next_retry_at
        FROM processing_jobs
        WHERE (
            (
              lane = 'local'
              AND job_type IN (
                'transcribe_chunk','preview_transcription','speaker',
                'diarize_track','resolve_identities','compress_chunk'
              )
            )
            OR (lane = 'cloud' AND job_type = 'analyze_session')
          )
          AND state IN ('pending','running','retry','retention_urgent','storage_recovery_compress')
          AND completed_at IS NULL
          AND priority < @priorityBefore
          AND (@excludeJobId IS NULL OR id <> @excludeJobId)
        ORDER BY priority ASC, created_at ASC, id ASC
      `),
      countCloudLaneInFlight: db.prepare(`
        SELECT count(*) AS count FROM processing_jobs
        WHERE lane = 'cloud'
          AND job_type IN ('analyze_session','generate_daily_digest')
          AND state = 'running'
          AND completed_at IS NULL
          AND (@excludeJobId IS NULL OR id <> @excludeJobId)
      `),
      recoverExpiredTranscriptionJobLeases: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            next_retry_at = @at,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'LEASE_EXPIRED',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = NULL
        WHERE job_type = 'transcribe_chunk'
          AND state = 'running'
          AND completed_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= @at)
      `),
      renewLeasedJob: db.prepare(`
        UPDATE processing_jobs
        SET lease_expires_at = @leaseExpiresAt
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > @at
      `),
      recordLeasedJobExecutionDevice: db.prepare(`
        UPDATE processing_jobs
        SET execution_device = @executionDevice
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > @at
          AND (execution_device IS NULL OR execution_device = @executionDevice)
      `),
      completeLeasedJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'completed',
            completed_at = @at,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            blocked_reason = NULL,
            execution_device = @executionDevice
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
      supersedeLeasedAnalysisJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            completed_at = @at,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'ANALYSIS_SUPERSEDED',
            blocked_reason = NULL
        WHERE id = @id
          AND lane = 'cloud'
          AND job_type = 'analyze_session'
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
      supersedeLeasedDailyDigestJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            completed_at = @at,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'DAILY_DIGEST_SUPERSEDED',
            blocked_reason = NULL
        WHERE id = @id
          AND lane = 'cloud'
          AND job_type = 'generate_daily_digest'
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
      retryLeasedJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            completed_at = NULL,
            next_retry_at = @nextRetryAt,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = @errorCode,
            blocked_reason = NULL,
            execution_device = NULL
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
      deferLeasedJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'retry',
            attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
            completed_at = NULL,
            next_retry_at = @nextRetryAt,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = CASE
              WHEN @preserveManualRetry = 1
              THEN 'ANALYSIS_MANUAL_RETRY_AUTHORIZED'
              ELSE NULL
            END,
            blocked_reason = @reason,
            execution_device = NULL
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
      blockLeasedJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'blocked',
            completed_at = @at,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = @errorCode,
            blocked_reason = @blockedReason,
            execution_device = NULL
        WHERE id = @id
          AND state = 'running'
          AND completed_at IS NULL
          AND lease_owner = @owner
          AND lease_expires_at > @at
      `),
    };

    this.commitChunkTransaction = db.transaction((chunk) => {
      this._assertChunk(chunk);
      if (this.statements.findChunkSequence.get(chunk.trackId, chunk.sequenceNumber)) {
        throw new Error(
          `chunk sequence ${chunk.sequenceNumber} already exists for track ${chunk.trackId}`
        );
      }
      this.statements.insertChunk.run({
        ...chunk,
        format: chunk.format ?? "wav",
        fileSha256: chunk.fileSha256 ?? null,
        sampleRate: chunk.sampleRate ?? 24_000,
        channels: chunk.channels ?? 1,
      });
      if (chunk.fileBytes !== undefined) {
        this._assertPositiveSafeInteger(chunk.fileBytes, "chunk fileBytes");
        this.statements.recordStorageUsage.run({
          kind: "wav_written",
          chunkId: chunk.id,
          bytes: chunk.fileBytes,
          deltaBytes: chunk.fileBytes,
          occurredAt: chunk.endedAt,
        });
      }
      const transcription = this._insertChunkTranscription(chunk);
      if (chunk.encoderVersion !== undefined) this._insertChunkCompression(chunk);
      this.statements.invalidateSessionReadiness.run({ sessionId: chunk.sessionId });
      return transcription;
    });
    this.createTracksTransaction = db.transaction((tracks) =>
      tracks.map((track) => this.createTrack(track))
    );
    this.claimJobsTransaction = db.transaction(
      ({ owner, at, leaseExpiresAt, limit, priorityBefore }) => {
        const candidates = this.statements.listClaimableJobs.all({ at, limit, priorityBefore });
        const claimed = [];
        for (const candidate of candidates) {
          const result = this.statements.claimJob.run({
            id: candidate.id,
            owner,
            at,
            leaseExpiresAt,
            priorityBefore,
          });
          if (result.changes === 1) {
            claimed.push({
              ...this.statements.getProcessingJob.get(candidate.id),
              claimed_from_state: candidate.state,
            });
          }
        }
        return claimed;
      }
    );
    this.claimCloudJobsTransaction = db.transaction(
      ({ owner, at, leaseExpiresAt, limit, priorityBefore }) => {
        const candidates = this.statements.listClaimableCloudJobs.all({
          at,
          limit,
          priorityBefore,
        });
        const claimed = [];
        for (const candidate of candidates) {
          const result = this.statements.claimCloudJob.run({
            id: candidate.id,
            owner,
            at,
            leaseExpiresAt,
            priorityBefore,
          });
          if (result.changes === 1) {
            claimed.push({
              ...this.statements.getProcessingJob.get(candidate.id),
              claimed_from_state: candidate.state,
            });
          }
        }
        return claimed;
      }
    );
    this.recoverExpiredCloudCandidateLeasesTransaction = db.transaction(
      ({ owner, at, leaseExpiresAt, limit, priorityBefore }) => {
        const candidates = this.statements.listExpiredCloudCandidateLeases.all({
          at,
          limit,
          priorityBefore,
        });
        const recovered = [];
        for (const candidate of candidates) {
          const result = this.statements.recoverExpiredCloudCandidateLease.run({
            id: candidate.job_id,
            owner,
            at,
            leaseExpiresAt,
            priorityBefore,
          });
          if (result.changes === 1) {
            recovered.push({
              jobId: candidate.job_id,
              jobType: candidate.job_type,
              candidateId: candidate.candidate_id,
              candidateState: candidate.candidate_state,
              leaseOwner: owner,
              leaseExpiresAt,
            });
          }
        }
        return recovered;
      }
    );
    this.recoverExpiredCloudPrestartLeasesTransaction = db.transaction(
      ({ owner, at, leaseExpiresAt, limit, priorityBefore }) => {
        const candidates = this.statements.listExpiredCloudPrestartLeases.all({
          at,
          limit,
          priorityBefore,
        });
        const recovered = [];
        for (const candidate of candidates) {
          const result = this.statements.recoverExpiredCloudPrestartLease.run({
            id: candidate.id,
            owner,
            at,
            leaseExpiresAt,
            priorityBefore,
          });
          if (result.changes === 1) {
            recovered.push(this.statements.getProcessingJob.get(candidate.id));
          }
        }
        return recovered;
      }
    );
    this.clearRetiredArtifactTransaction = db.transaction((input) => {
      this._assertSafeInteger(input.occurredAt, "retired artifact occurredAt");
      let fileBytes = input.fileBytes;
      if (fileBytes === undefined) {
        fileBytes = this.statements.getCurrentStorageBytes.get({
          chunkId: input.chunkId,
          format: input.retiredFormat,
        })?.bytes;
      }
      const cleared = this.statements.clearRetiredArtifact.run(input);
      if (cleared.changes === 1 && fileBytes !== undefined) {
        this._assertPositiveSafeInteger(fileBytes, "retired artifact fileBytes");
        this.statements.recordStorageUsage.run({
          kind: "retired_deleted",
          chunkId: input.chunkId,
          bytes: fileBytes,
          deltaBytes: -fileBytes,
          occurredAt: input.occurredAt,
        });
      }
      return cleared.changes;
    });
    this.tombstoneChunkTransaction = db.transaction((id, deletedAt, { storageDeleted }) => {
      this._assertIdentifier(id, "chunkId");
      this._assertSafeInteger(deletedAt, "deletedAt");
      const chunk = this.statements.getChunk.get(id);
      if (!chunk) return { changes: 0, jobsTerminated: 0 };
      const tombstone = this.statements.tombstoneChunk.run(deletedAt, id);
      if (tombstone.changes === 1 && storageDeleted) {
        const storage = this.statements.getCurrentStorageBytes.get({
          chunkId: id,
          format: chunk.format,
        });
        if (storage) {
          this.statements.recordStorageUsage.run({
            kind: "retention_deleted",
            chunkId: id,
            bytes: storage.bytes,
            deltaBytes: -storage.bytes,
            occurredAt: deletedAt,
          });
        }
      }
      const jobs = this.statements.expireUnfinishedChunkJobs.run({
        chunkId: id,
        completedAt: chunk.deleted_at ?? deletedAt,
      });
      return { changes: tombstone.changes, jobsTerminated: jobs.changes };
    });
    this.enqueueChunkTranscriptionTransaction = db.transaction((chunk) => {
      const persisted = this.statements.getChunk.get(chunk.id);
      if (!persisted) throw new Error(`chunk ${chunk.id} does not exist`);
      if (persisted.deleted_at !== null) {
        throw new Error(`chunk ${chunk.id} audio is deleted`);
      }
      if (persisted.session_id !== chunk.sessionId) throw new Error("chunk session does not match");
      if (persisted.track_id !== chunk.trackId) throw new Error("chunk track does not match");
      if (persisted.source_type !== chunk.sourceType)
        throw new Error("chunk source does not match");
      if (persisted.sha256 !== chunk.sha256) throw new Error("chunk input hash does not match");
      this._assertChunk(chunk);

      const input = this._transcriptionInput(chunk);
      const existing = this.statements.getTranscriptionJobByInput.get(input);
      if (existing) return existing;
      const inserted = this._insertChunkTranscription(chunk);
      this.statements.invalidateSessionReadiness.run({ sessionId: chunk.sessionId });
      return inserted;
    });
    this.enqueueCurrentModelTranscriptionJobsTransaction = db.transaction(
      ({ inputVersion, modelVersion, at, limit }) => {
        this.statements.recoverExpiredTranscriptionJobLeases.run({ at });
        this.statements.reprioritizeActiveTranscriptionJobs.run();
        const chunks = this.statements.listChunksMissingCurrentTranscription.all({
          inputVersion,
          modelVersion,
          at,
          limit,
        });
        let enqueued = 0;
        let superseded = 0;
        for (const row of chunks) {
          const supersededForChunk = this.statements.supersedeStaleTranscriptionJobs.run({
            chunkId: row.id,
            inputHash: row.sha256,
            inputVersion,
            modelVersion,
            at,
          }).changes;
          superseded += supersededForChunk;
          const currentInput = {
            chunkId: row.id,
            inputHash: row.sha256,
            inputVersion,
            modelVersion,
          };
          const exactCurrent = this.statements.getTranscriptionJobByInput.get(currentInput);
          let enqueuedForChunk = 0;
          if (!exactCurrent || exactCurrent.state === "superseded") {
            const reactivated = this.statements.reactivateSupersededTranscriptionJob.run({
              ...currentInput,
              at,
            }).changes;
            if (reactivated === 0) {
              this.statements.insertTranscriptionJob.run({
                id: this.createId("job"),
                sessionId: row.session_id,
                trackId: row.track_id,
                ...currentInput,
                createdAt: at,
              });
            }
            enqueuedForChunk = 1;
            enqueued += 1;
          }
          if (enqueuedForChunk > 0 || supersededForChunk > 0) {
            this.statements.invalidateSessionReadiness.run({ sessionId: row.session_id });
          }
        }
        return { enqueued, superseded };
      }
    );
    this.promoteChunkToFlacTransaction = db.transaction((input) => {
      const chunk = this.statements.getChunk.get(input.chunkId);
      if (!chunk) throw new Error(`chunk ${input.chunkId} does not exist`);
      if (chunk.deleted_at !== null) throw new Error(`chunk ${input.chunkId} audio is deleted`);
      if (chunk.expires_at <= input.completedAt) {
        throw new Error(`chunk ${input.chunkId} audio_expired`);
      }
      const updated = this.statements.promoteChunkToFlac.run(input);
      if (updated.changes !== 1) throw new Error("WAV authority changed before FLAC commit");
      const completed = this.statements.completeCompressionJob.run(input);
      if (completed.changes !== 1)
        throw new Error("compression job does not match chunk authority");
      if (input.fileBytes !== undefined) {
        this._assertPositiveSafeInteger(input.fileBytes, "FLAC fileBytes");
        this.statements.recordStorageUsage.run({
          kind: "flac_written",
          chunkId: input.chunkId,
          bytes: input.fileBytes,
          deltaBytes: input.fileBytes,
          occurredAt: input.completedAt,
        });
      }
      return this._chunkResult(this.statements.getChunk.get(input.chunkId));
    });
    this.promoteLeasedChunkToFlacTransaction = db.transaction((input) => {
      const updated = this.statements.promoteLeasedChunkToFlac.run(input);
      if (updated.changes !== 1) return null;
      if (input.fileBytes !== undefined) {
        this._assertPositiveSafeInteger(input.fileBytes, "FLAC fileBytes");
        this.statements.recordStorageUsage.run({
          kind: "flac_written",
          chunkId: input.chunkId,
          bytes: input.fileBytes,
          deltaBytes: input.fileBytes,
          occurredAt: input.completedAt,
        });
      }
      return this._chunkResult(this.statements.getChunk.get(input.chunkId));
    });
    this.rollbackChunkToWavTransaction = db.transaction((input) => {
      const rolledBack = this.statements.rollbackChunkToWav.run(input);
      if (rolledBack.changes !== 1) throw new Error("FLAC authority changed before WAV rollback");
      const retried = this.statements.retryCompressionJob.run(input);
      if (retried.changes !== 1) throw new Error("compression job cannot be restored for retry");
      return this._chunkResult(this.statements.getChunk.get(input.chunkId));
    });
    this.interruptTrackTransaction = db.transaction(
      ({ trackId, gap, sessionId = undefined, sessionStatus = undefined }) => {
        this._assertIdentifier(trackId, "trackId");
        if (!gap || typeof gap !== "object") throw new TypeError("gap is required");
        this._assertIdentifier(gap.id, "gap id");
        this._assertSafeInteger(gap.startedAt, "gap startedAt");
        this._assertNonNegativeSafeInteger(gap.recoveryAttempts ?? 0, "gap recoveryAttempts");
        if (typeof gap.reason !== "string" || gap.reason.length === 0) {
          throw new TypeError("gap reason must be a non-empty string");
        }
        const track = this.statements.getTrack.get(trackId);
        if (!track) throw new Error(`track ${trackId} does not exist`);
        if (gap.trackId !== trackId) throw new Error("gap track does not match transition track");
        if (track.state !== "active" || track.ended_at !== null) {
          throw new Error(`track ${trackId} must be active before interruption`);
        }
        if (gap.startedAt < track.started_at) {
          throw new RangeError("gap startedAt must not be before track startedAt");
        }
        if (this.statements.getOpenGapForTrack.get(trackId)) {
          throw new Error(`track ${trackId} already has an open gap`);
        }
        const updated = this.setTrackState(trackId, "recovering", gap.startedAt);
        if (updated.changes !== 1) throw new Error(`track ${trackId} was not updated`);
        this.openGap(gap);
        this._transitionSourceSession({
          track,
          sessionId,
          sessionStatus,
        });
        return { trackId, gapId: gap.id };
      }
    );
    this.restoreTrackTransaction = db.transaction(
      ({
        trackId,
        gapId,
        endedAt,
        recoveryAttempts = 1,
        targetState = "active",
        sessionId = undefined,
        sessionStatus = undefined,
        deviceId = undefined,
        deviceLabel = undefined,
        strategy = undefined,
      }) => {
        if (!RESTORATION_TARGET_STATES.has(targetState)) {
          throw new TypeError("invalid restoration target state");
        }
        this._assertIdentifier(trackId, "trackId");
        this._assertIdentifier(gapId, "gapId");
        this._assertSafeInteger(endedAt, "restoration endedAt");
        this._assertNonNegativeSafeInteger(recoveryAttempts, "recoveryAttempts");
        const track = this.statements.getTrack.get(trackId);
        if (!track) throw new Error(`track ${trackId} does not exist`);
        const gap = this.statements.getGap.get(gapId);
        if (!gap) throw new Error(`gap ${gapId} does not exist`);
        if (gap.track_id !== trackId) throw new Error("gap track does not match transition track");
        if (track.state !== "recovering") {
          throw new Error(`track ${trackId} must be recovering before restoration`);
        }
        if (gap.ended_at !== null) throw new Error(`gap ${gapId} is not open`);
        if (endedAt < gap.started_at) {
          throw new RangeError("restoration endedAt must not be before gap startedAt");
        }
        const restoredMetadata = {
          deviceId: deviceId === undefined ? track.device_id : deviceId,
          deviceLabel: deviceLabel === undefined ? track.device_label : deviceLabel,
          strategy: strategy === undefined ? track.strategy : strategy,
        };
        for (const [name, value] of Object.entries(restoredMetadata)) {
          if (value !== null && (typeof value !== "string" || value.length > 512)) {
            throw new TypeError(`${name} must be a string of at most 512 characters or null`);
          }
        }
        const closed = this.closeGap(gapId, endedAt, recoveryAttempts, restoredMetadata);
        if (closed.changes !== 1) throw new Error(`gap ${gapId} is not open`);
        const updated = this.setTrackState(
          trackId,
          targetState,
          targetState === "paused" ? endedAt : null
        );
        if (updated.changes !== 1) throw new Error(`track ${trackId} was not updated`);
        this._transitionSourceSession({
          track,
          sessionId,
          sessionStatus,
        });
        return { trackId, gapId, targetState };
      }
    );
    const pauseCapture = ({ sessionId, sources, at }, lowDisk) => {
      const evidence = this._assertLifecycleTransition({
        sessionId,
        sources,
        at,
        sessionState: "recording",
        sourceStates: new Set(["active", "recovering"]),
      });
      for (const { track } of evidence) {
        if (track.state !== "active") continue;
        const updated = this.setTrackState(track.id, "paused", at);
        if (updated.changes !== 1) throw new Error(`track ${track.id} was not paused`);
      }
      const paused = lowDisk
        ? this.statements.pauseSessionForLowDisk.run({ sessionId, at })
        : this.statements.transitionSession.run({
            sessionId,
            status: "paused",
            endedAt: null,
          });
      if (paused.changes !== 1) throw new Error(`session ${sessionId} was not paused`);
      return {
        sessionId,
        status: "paused",
        stopReason: lowDisk ? "capture_stopped_low_disk" : null,
        durableBoundaryAt: lowDisk ? at : null,
      };
    };
    this.pauseCaptureTransaction = db.transaction((input) => pauseCapture(input, false));
    this.pauseCaptureForLowDiskTransaction = db.transaction((input) => pauseCapture(input, true));
    this.suspendCaptureForPowerTransaction = db.transaction(({ sessionId, sources, at }) => {
      const evidence = this._assertLifecycleTransition({
        sessionId,
        sources,
        at,
        sessionState: "recording",
        sourceStates: new Set(["active", "recovering"]),
      });
      const suspendedSources = [];
      for (const { track } of evidence) {
        if (track.state !== "active") {
          suspendedSources.push({ trackId: track.id, gapId: null, previouslyRecovering: true });
          continue;
        }
        if (this.statements.getOpenGapForTrack.get(track.id)) {
          throw new Error(`track ${track.id} already has an open gap`);
        }
        const gapId = this.createId("gap");
        const updated = this.setTrackState(track.id, "recovering", at);
        if (updated.changes !== 1) throw new Error(`track ${track.id} was not suspended`);
        this.openGap({
          id: gapId,
          trackId: track.id,
          startedAt: at,
          reason: "system_suspend",
          recoveryAttempts: 0,
        });
        suspendedSources.push({ trackId: track.id, gapId, previouslyRecovering: false });
      }
      const paused = this.statements.transitionSession.run({
        sessionId,
        status: "paused",
        endedAt: null,
      });
      if (paused.changes !== 1) throw new Error(`session ${sessionId} was not suspended`);
      return { sessionId, status: "paused", sources: suspendedSources };
    });
    this.resumeCaptureAfterPowerTransaction = db.transaction(
      ({ sessionId, sources, restorations = {}, at }) => {
        const evidence = this._assertLifecycleTransition({
          sessionId,
          sources,
          at,
          sessionState: "paused",
          sourceStates: new Set(["recovering"]),
        });
        for (const { track, openGap, source } of evidence) {
          const restored = restorations[track.source_type];
          if (source.gapId === null && track.state === "recovering") {
            if (!restored || source.recoveryGapId !== openGap?.id) continue;
            const closed = this.closeGap(openGap.id, at, 1, {
              deviceId: restored.deviceId === undefined ? track.device_id : restored.deviceId,
              deviceLabel:
                restored.deviceLabel === undefined ? track.device_label : restored.deviceLabel,
              strategy: restored.strategy === undefined ? track.strategy : restored.strategy,
            });
            if (closed.changes !== 1) throw new Error(`gap ${openGap.id} is not open`);
            const updated = this.setTrackState(track.id, "active", null);
            if (updated.changes !== 1) throw new Error(`track ${track.id} was not resumed`);
            continue;
          }
          this._assertIdentifier(source.gapId, "suspend gapId");
          const gap = this.statements.getGap.get(source.gapId);
          if (!gap || gap.track_id !== track.id || gap.reason !== "system_suspend") {
            throw new Error(`track ${track.id} does not have the requested suspend gap`);
          }
          if (gap.ended_at !== null) throw new Error(`gap ${source.gapId} is not open`);
          const restoration = restored ?? {};
          const closed = this.closeGap(source.gapId, at, 1, {
            deviceId: restoration.deviceId === undefined ? track.device_id : restoration.deviceId,
            deviceLabel:
              restoration.deviceLabel === undefined ? track.device_label : restoration.deviceLabel,
            strategy: restoration.strategy === undefined ? track.strategy : restoration.strategy,
          });
          if (closed.changes !== 1) throw new Error(`gap ${source.gapId} was not closed`);
          const updated = this.setTrackState(track.id, "active", null);
          if (updated.changes !== 1) throw new Error(`track ${track.id} was not resumed`);
        }
        const resumed = this.statements.transitionSession.run({
          sessionId,
          status: "recording",
          endedAt: null,
        });
        if (resumed.changes !== 1) throw new Error(`session ${sessionId} was not resumed`);
        return { sessionId, status: "recording" };
      }
    );
    this.confirmPowerRestorationsTransaction = db.transaction(({ sessionId, sources, at }) => {
      this._assertIdentifier(sessionId, "sessionId");
      this._assertSafeInteger(at, "transition at");
      if (!Array.isArray(sources)) throw new TypeError("transition sources must be an array");
      const session = this.statements.getSession.get(sessionId);
      if (!session || session.status !== "recording") {
        throw new Error(`session ${sessionId} must be recording`);
      }
      const tracks = this.statements.listTracksForSession
        .all(sessionId)
        .filter((track) => !TERMINAL_TRACK_STATES.has(track.state));
      if (sources.length !== tracks.length) {
        throw new Error(
          "power restoration must include every session track that is open exactly once"
        );
      }
      const seen = new Set();
      for (const source of sources) {
        this._assertIdentifier(source.trackId, "trackId");
        this._assertIdentifier(source.gapId, "gapId");
        if (seen.has(source.trackId)) throw new Error("power restoration track is duplicated");
        seen.add(source.trackId);
        const track = this.statements.getTrack.get(source.trackId);
        const gap = this.statements.getGap.get(source.gapId);
        if (!track || track.session_id !== sessionId || track.state !== "active") {
          throw new Error(`track ${source.trackId} is not active in ${sessionId}`);
        }
        if (!gap || gap.track_id !== track.id || gap.ended_at !== at) {
          throw new Error(`gap ${source.gapId} is not the completed wake restoration`);
        }
        for (const [name, value] of Object.entries(source.restoration ?? {})) {
          if (value !== null && (typeof value !== "string" || value.length > 512)) {
            throw new TypeError(`${name} must be a string of at most 512 characters or null`);
          }
        }
        const updated = this.statements.confirmClosedGapRestoration.run({
          id: gap.id,
          trackId: track.id,
          endedAt: at,
          restoredDeviceId: source.restoration?.deviceId ?? null,
          restoredDeviceLabel: source.restoration?.deviceLabel ?? null,
          restoredStrategy: source.restoration?.strategy ?? null,
        });
        if (updated.changes !== 1) throw new Error(`gap ${gap.id} restoration changed`);
      }
      return { sessionId, status: "recording" };
    });
    this.resumeCaptureTransaction = db.transaction(({ sessionId, sources, at }) => {
      const evidence = this._assertLifecycleTransition({
        sessionId,
        sources,
        at,
        sessionState: "paused",
        sourceStates: new Set(["paused", "recovering"]),
      });
      if (!evidence.some(({ track }) => track.state === "paused")) {
        throw new Error("resume requires at least one paused track");
      }
      for (const { track } of evidence) {
        if (track.state !== "paused") continue;
        const updated = this.setTrackState(track.id, "active", null);
        if (updated.changes !== 1) throw new Error(`track ${track.id} was not resumed`);
      }
      const resumed = this.statements.transitionSession.run({
        sessionId,
        status: "recording",
        endedAt: null,
      });
      if (resumed.changes !== 1) throw new Error(`session ${sessionId} was not resumed`);
      return { sessionId, status: "recording" };
    });
    this.finalizeCaptureTransaction = db.transaction(
      ({ sessionId, sources, trackState, sessionStatus, at }) => {
        this._assertIdentifier(sessionId, "sessionId");
        this._assertSafeInteger(at, "finalization at");
        if (!Array.isArray(sources)) throw new TypeError("finalization sources must be an array");
        if (!TERMINAL_TRACK_STATES.has(trackState)) {
          throw new TypeError("invalid terminal track state");
        }
        if (!TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
          throw new TypeError("invalid terminal session status");
        }
        if (TRACK_STATE_BY_SESSION_STATUS[sessionStatus] !== trackState) {
          throw new TypeError("terminal track state does not match session status");
        }
        const session = this.statements.getSession.get(sessionId);
        if (!session) throw new Error(`session ${sessionId} does not exist`);
        if (TERMINAL_SESSION_STATUSES.has(session.status)) {
          throw new Error(`session ${sessionId} is already terminal`);
        }
        if (at < session.started_at) {
          throw new RangeError("finalization at must not be before session startedAt");
        }
        const sessionTracks = this.statements.listTracksForSession.all(sessionId);
        if (sources.length !== sessionTracks.length) {
          throw new Error("finalization must include every session track exactly once");
        }

        const seenTrackIds = new Set();
        const evidence = sources.map((source) => {
          if (!source || typeof source !== "object") {
            throw new TypeError("finalization source is required");
          }
          this._assertIdentifier(source.trackId, "trackId");
          if (seenTrackIds.has(source.trackId)) {
            throw new Error(`track ${source.trackId} is duplicated in finalization`);
          }
          seenTrackIds.add(source.trackId);
          const track = this.statements.getTrack.get(source.trackId);
          if (!track) throw new Error(`track ${source.trackId} does not exist`);
          if (track.session_id !== sessionId) {
            throw new Error(`track ${source.trackId} does not belong to session ${sessionId}`);
          }
          if (at < track.started_at) {
            throw new RangeError("finalization at must not be before track startedAt");
          }
          if (track.ended_at !== null && at < track.ended_at) {
            throw new RangeError("finalization at must not be before track endedAt");
          }
          const gaps = this.statements.listOpenGapsForTrack.all(source.trackId);
          if (source.gapId !== null && source.gapId !== undefined) {
            this._assertIdentifier(source.gapId, "gapId");
            if (!gaps.some((gap) => gap.id === source.gapId)) {
              throw new Error(`gap ${source.gapId} is not open for finalization track`);
            }
          }
          if (gaps.some((gap) => at < gap.started_at)) {
            throw new RangeError("finalization at must not be before gap startedAt");
          }
          return { track, gaps };
        });
        if (sessionTracks.some((track) => !seenTrackIds.has(track.id))) {
          throw new Error("finalization must include every session track exactly once");
        }

        for (const { track, gaps } of evidence) {
          for (const gap of gaps) {
            const closed = this.closeGap(gap.id, at, null);
            if (closed.changes !== 1) throw new Error(`gap ${gap.id} was not finalized`);
          }
          if (!TERMINAL_TRACK_STATES.has(track.state)) {
            const updated = this.setTrackState(track.id, trackState, at);
            if (updated.changes !== 1) throw new Error(`track ${track.id} was not finalized`);
          }
        }
        const finalized = this.statements.finalizeSession.run({ sessionId, sessionStatus, at });
        if (finalized.changes !== 1) throw new Error(`session ${sessionId} was not finalized`);
        return { sessionId, sessionStatus, trackState };
      }
    );
  }

  createTrack(track) {
    if (track.sampleRate !== 24_000) {
      throw new RangeError("capture evidence tracks must use 24 kHz sample rate");
    }
    if (track.channels !== 1) {
      throw new RangeError("capture evidence tracks must be mono");
    }
    const applicationKey = track.applicationKey ?? null;
    const applicationDisplayName = track.applicationDisplayName ?? null;
    if (
      track.sourceType === "mic" &&
      (applicationKey !== null || applicationDisplayName !== null)
    ) {
      throw new TypeError("microphone tracks cannot have application attribution");
    }
    if ((applicationKey === null) !== (applicationDisplayName === null)) {
      throw new TypeError("application key and display name must be provided together");
    }
    if (applicationKey !== null && !APPLICATION_KEY_PATTERN.test(applicationKey)) {
      throw new TypeError("application key must be a canonical lowercase identifier");
    }
    if (
      applicationDisplayName !== null &&
      (typeof applicationDisplayName !== "string" ||
        applicationDisplayName.trim().length < 1 ||
        applicationDisplayName.trim().length > 80 ||
        /[\\/:]/u.test(applicationDisplayName))
    ) {
      throw new TypeError("application display name must not contain path data");
    }
    const captureGeneration = track.captureGeneration ?? 0;
    this._assertNonNegativeSafeInteger(captureGeneration, "captureGeneration");
    const state = track.state ?? "active";
    let failureCode = track.failureCode ?? null;
    if (failureCode !== null && !APPLICATION_FAILURE_CODE_PATTERN.test(failureCode)) {
      throw new TypeError("application failure code must be a safe bounded identifier");
    }
    if (state !== "failed") failureCode = null;
    return this.statements.createTrack.run({
      ...track,
      applicationKey,
      applicationDisplayName,
      captureGeneration,
      deviceId: track.deviceId ?? null,
      deviceLabel: track.deviceLabel ?? null,
      strategy: track.strategy ?? null,
      state,
      failureCode,
    });
  }

  createTracks(tracks) {
    if (!Array.isArray(tracks)) throw new TypeError("tracks must be an array");
    return this.createTracksTransaction(tracks);
  }

  createApplicationAudioInterval(interval) {
    if (!interval || typeof interval !== "object" || Array.isArray(interval)) {
      throw new TypeError("application audio interval is required");
    }
    const id = interval.id ?? this.createId("application-audio-interval");
    this._assertIdentifier(id, "intervalId");
    this._assertIdentifier(interval.sessionId, "sessionId");
    this._assertIdentifier(interval.trackId, "trackId");
    this._assertNonNegativeSafeInteger(interval.captureGeneration ?? 0, "captureGeneration");
    this._assertNonNegativeSafeInteger(interval.startedAt, "interval startedAt");
    const endedAt = interval.endedAt ?? null;
    if (endedAt !== null) {
      this._assertNonNegativeSafeInteger(endedAt, "interval endedAt");
      if (endedAt <= interval.startedAt) {
        throw new RangeError("application audio interval endedAt must be after startedAt");
      }
    }
    const applicationKey = interval.applicationKey ?? null;
    if (applicationKey !== null && !APPLICATION_KEY_PATTERN.test(applicationKey)) {
      throw new TypeError("application key must be a canonical lowercase identifier");
    }
    const createdAt = interval.createdAt ?? this.now();
    this._assertNonNegativeSafeInteger(createdAt, "interval createdAt");
    const failureCode = interval.failureCode ?? null;
    if (failureCode !== null && !APPLICATION_FAILURE_CODE_PATTERN.test(failureCode)) {
      throw new TypeError("application failure code must be a safe bounded identifier");
    }
    const attemptedApplicationKey = interval.attemptedApplicationKey ?? null;
    const attemptedApplicationDisplayName = interval.attemptedApplicationDisplayName ?? null;
    if ((attemptedApplicationKey === null) !== (attemptedApplicationDisplayName === null)) {
      throw new TypeError("fallback application key and display name must be provided together");
    }
    if (
      attemptedApplicationKey !== null &&
      !APPLICATION_KEY_PATTERN.test(attemptedApplicationKey)
    ) {
      throw new TypeError("fallback application key must be a canonical lowercase identifier");
    }
    if (
      attemptedApplicationDisplayName !== null &&
      (typeof attemptedApplicationDisplayName !== "string" ||
        attemptedApplicationDisplayName.trim().length < 1 ||
        attemptedApplicationDisplayName.trim().length > 80 ||
        /[\\/:]/u.test(attemptedApplicationDisplayName))
    ) {
      throw new TypeError("fallback application display name must not contain path data");
    }
    if (
      interval.attributionState === "exact" &&
      (attemptedApplicationKey !== null || attemptedApplicationDisplayName !== null)
    ) {
      throw new TypeError("exact attribution cannot contain fallback evidence");
    }
    const persist = this.db.transaction(() => {
      this.statements.createApplicationAudioInterval.run({
        id,
        sessionId: interval.sessionId,
        trackId: interval.trackId,
        intervalKind: interval.intervalKind,
        applicationKey,
        attributionState: interval.attributionState,
        captureGeneration: interval.captureGeneration ?? 0,
        startedAt: interval.startedAt,
        endedAt,
        reason: interval.reason ?? null,
        failureCode,
        createdAt,
      });
      if (interval.attributionState === "mixed_unknown") {
        this.statements.createApplicationAudioFallbackEvidence.run({
          intervalId: id,
          attemptedApplicationKey,
          attemptedApplicationDisplayName,
          reason: interval.reason,
          failureCode,
          captureGeneration: interval.captureGeneration ?? 0,
          createdAt,
        });
      }
    });
    persist();
    return this.statements.getApplicationAudioInterval.get(id);
  }

  closeApplicationAudioInterval(id, endedAt) {
    this._assertIdentifier(id, "intervalId");
    this._assertNonNegativeSafeInteger(endedAt, "interval endedAt");
    const result = this.statements.closeApplicationAudioInterval.run({ id, endedAt });
    return {
      changes: result.changes,
      interval: this.statements.getApplicationAudioInterval.get(id) ?? null,
    };
  }

  listApplicationAudioIntervals(sessionId) {
    this._assertIdentifier(sessionId, "sessionId");
    return this.statements.listApplicationAudioIntervals.all(sessionId);
  }

  setTrackState(id, state, endedAt = null, failureCode = null) {
    if (failureCode !== null && !APPLICATION_FAILURE_CODE_PATTERN.test(failureCode)) {
      throw new TypeError("application failure code must be a safe bounded identifier");
    }
    if (state !== "failed") failureCode = null;
    return this.statements.setTrackState.run({ id, state, endedAt, failureCode });
  }

  openGap(gap) {
    return this.statements.openGap.run({
      ...gap,
      recoveryAttempts: gap.recoveryAttempts ?? 0,
    });
  }

  recordEvidenceGap(gap) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      throw new TypeError("evidence gap is required");
    }
    this._assertIdentifier(gap.id, "gapId");
    this._assertIdentifier(gap.trackId, "trackId");
    this._assertSafeInteger(gap.startedAt, "gap startedAt");
    this._assertSafeInteger(gap.endedAt, "gap endedAt");
    if (gap.endedAt <= gap.startedAt) {
      throw new RangeError("evidence gap endedAt must be after startedAt");
    }
    if (gap.reason !== "silence_suppressed" && gap.reason !== "vad_degraded") {
      throw new TypeError("invalid evidence gap reason");
    }
    for (const [name, value] of [
      ["averageLevel", gap.averageLevel],
      ["peakLevel", gap.peakLevel],
    ]) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`${name} must be between zero and one`);
      }
    }
    if (gap.averageLevel > gap.peakLevel) {
      throw new RangeError("averageLevel must not exceed peakLevel");
    }
    return this.statements.recordEvidenceGap.run(gap);
  }

  interruptTrack(input) {
    return this.interruptTrackTransaction(input);
  }

  closeGap(id, endedAt, recoveryAttempts = null, restoredSource = null) {
    return this.statements.closeGap.run({
      id,
      endedAt,
      recoveryAttempts,
      restoredDeviceId: restoredSource?.deviceId ?? null,
      restoredDeviceLabel: restoredSource?.deviceLabel ?? null,
      restoredStrategy: restoredSource?.strategy ?? null,
    });
  }

  restoreTrack(input) {
    return this.restoreTrackTransaction(input);
  }

  pauseCapture(input) {
    return this.pauseCaptureTransaction(input);
  }

  pauseCaptureForLowDisk(input) {
    return this.pauseCaptureForLowDiskTransaction(input);
  }

  suspendCaptureForPower(input) {
    return this.suspendCaptureForPowerTransaction(input);
  }

  resumeCaptureAfterPower(input) {
    return this.resumeCaptureAfterPowerTransaction(input);
  }

  confirmPowerRestorations(input) {
    return this.confirmPowerRestorationsTransaction(input);
  }

  resumeCapture(input) {
    return this.resumeCaptureTransaction(input);
  }

  finalizeCapture(input) {
    return this.finalizeCaptureTransaction(input);
  }

  commitChunk(chunk) {
    return this.commitChunkTransaction(chunk);
  }

  getChunk(id) {
    this._assertIdentifier(id, "chunkId");
    const row = this.statements.getChunk.get(id);
    return row ? this._chunkResult(row) : null;
  }

  getChunkForMaintenance(id) {
    this._assertIdentifier(id, "chunkId");
    const row = this.statements.getChunk.get(id);
    return row ? this._maintenanceChunkResult(row) : null;
  }

  promoteChunkToFlac(input) {
    return this.promoteChunkToFlacTransaction(input);
  }

  promoteLeasedChunkToFlac(input) {
    this._assertIdentifier(input?.owner, "owner");
    this._assertNonNegativeSafeInteger(input?.completedAt, "completedAt");
    return this.promoteLeasedChunkToFlacTransaction(input);
  }

  rollbackChunkToWav(input) {
    return this.rollbackChunkToWavTransaction(input);
  }

  markCompressionRecoveryFailure(input) {
    const failed = this.statements.failCompressionRecovery.run(input);
    if (failed.changes !== 1) throw new Error("compression recovery failure was not recorded");
    return this.getCompressionJob(input.jobId);
  }

  clearRetiredArtifact(input) {
    return this.clearRetiredArtifactTransaction({
      ...input,
      occurredAt: input.occurredAt ?? this.now(),
    });
  }

  setRetiredArtifactHash(input) {
    return this.statements.setRetiredArtifactHash.run(input).changes;
  }

  markCompressionRecoveryRetry(input) {
    const retried = this.statements.retryUnreadableFlacRecovery.run(input);
    if (retried.changes !== 1) throw new Error("compression recovery retry was not recorded");
    return this.getCompressionJob(input.jobId);
  }

  markCompressionRecoveryVerified(input) {
    return this.statements.completeUnreadableFlacRecovery.run(input).changes;
  }

  getCompressionJob(id) {
    this._assertIdentifier(id, "compressionJobId");
    return this.statements.getCompressionJob.get(id) ?? null;
  }

  listCompressionRecoveryCandidates() {
    return this.statements.listCompressionChunks.all().map((row) => ({
      chunk: this._maintenanceChunkResult(row),
      job: this.statements.getCompressionJobForChunk.get(row.id),
    }));
  }

  listRetiredArtifactBacklog() {
    return this.statements.listRetiredArtifactBacklog
      .all()
      .map((row) => this._maintenanceChunkResult(row));
  }

  tombstoneChunk(id, deletedAt = this.now(), { storageDeleted = false } = {}) {
    if (typeof storageDeleted !== "boolean") throw new TypeError("storageDeleted must be boolean");
    return this.tombstoneChunkTransaction(id, deletedAt, { storageDeleted });
  }

  promoteSoonExpiringAudioJobs(after, before) {
    this._assertSafeInteger(after, "retention urgency after");
    this._assertSafeInteger(before, "retention urgency before");
    if (before <= after) {
      throw new RangeError("retention urgency before must be greater than after");
    }
    return this.statements.promoteSoonExpiringAudioJobs.run({ after, before }).changes;
  }

  promoteCompressionJobsForStoragePressure(at) {
    this._assertNonNegativeSafeInteger(at, "storage pressure at");
    return this.statements.promoteCompressionJobsForStoragePressure.run({ at }).changes;
  }

  enqueueCloudJob({
    sessionId,
    jobType,
    analysisInputId = null,
    desiredHeadHash = null,
    inputHash,
    inputVersion = 1,
    modelVersion,
  } = {}) {
    this._assertIdentifier(sessionId, "sessionId");
    if (jobType !== "analyze_session") {
      throw new TypeError("enqueueCloudJob accepts only fixed cloud analysis work");
    }
    this._assertHash(inputHash, "inputHash");
    this._assertPositiveSafeInteger(inputVersion, "inputVersion");
    this._assertText(modelVersion, "modelVersion", 128);
    this._assertIdentifier(analysisInputId, "analysisInputId");
    this._assertHash(desiredHeadHash, "desiredHeadHash");
    const priority = 70;
    const createdAt = this.now();
    this._assertNonNegativeSafeInteger(createdAt, "createdAt");
    const id = this.createId("job_analysis");
    this._assertIdentifier(id, "jobId");
    this.statements.insertCloudJob.run({
      id,
      sessionId,
      jobType,
      priority,
      inputHash,
      inputVersion,
      modelVersion,
      analysisInputId,
      desiredHeadHash,
      createdAt,
    });
    const row = this.statements.getCloudJobByIdentity.get({
      jobType,
      inputHash,
      inputVersion,
      modelVersion,
      analysisInputId,
      desiredHeadHash,
    });
    if (
      !row ||
      row.session_id !== sessionId ||
      row.lane !== "cloud" ||
      row.priority !== priority ||
      row.analysis_input_id !== analysisInputId ||
      row.desired_head_hash !== desiredHeadHash
    ) {
      const error = new Error("CLOUD_JOB_IDENTITY_COLLISION");
      error.code = "CLOUD_JOB_IDENTITY_COLLISION";
      throw error;
    }
    return row;
  }

  authorizeManualAnalysisRetry(id, { allowUsageUnknown = false, at = this.now() } = {}) {
    this._assertIdentifier(id, "jobId");
    if (typeof allowUsageUnknown !== "boolean") {
      throw new TypeError("allowUsageUnknown must be a boolean");
    }
    this._assertNonNegativeSafeInteger(at, "manual retry at");
    const changed = this.statements.authorizeManualAnalysisRetry.run({
      id,
      allowUsageUnknown: allowUsageUnknown ? 1 : 0,
      at,
    }).changes;
    return changed === 1 ? this.statements.getProcessingJob.get(id) : null;
  }

  enqueueDailyDigestJob(inputRequest) {
    assertExactPlainObject(
      inputRequest,
      ["digestInputId", "inputHash", "inputVersion", "modelVersion"],
      "daily digest job input"
    );
    const { digestInputId, inputHash, inputVersion, modelVersion } = inputRequest;
    this._assertIdentifier(digestInputId, "digestInputId");
    this._assertHash(inputHash, "inputHash");
    this._assertPositiveSafeInteger(inputVersion, "inputVersion");
    this._assertText(modelVersion, "modelVersion", 128);
    const input = this.statements.getDailyDigestInputIdentity.get(digestInputId);
    if (!input || input.source_hash !== inputHash) {
      const error = new Error("DAILY_DIGEST_INPUT_IDENTITY_MISMATCH");
      error.code = "DAILY_DIGEST_INPUT_IDENTITY_MISMATCH";
      throw error;
    }
    const createdAt = this.now();
    this._assertNonNegativeSafeInteger(createdAt, "createdAt");
    const id = this.createId("job_digest");
    this._assertIdentifier(id, "jobId");
    this.statements.insertDailyDigestJob.run({
      id,
      digestInputId,
      inputHash,
      inputVersion,
      modelVersion,
      createdAt,
    });
    const row = this.statements.getDailyDigestJobByInput.get(digestInputId);
    if (
      !row ||
      row.session_id !== null ||
      row.input_hash !== inputHash ||
      row.input_version !== inputVersion ||
      row.model_version !== modelVersion ||
      row.lane !== "cloud" ||
      row.priority !== 80 ||
      row.analysis_input_id !== null ||
      row.desired_head_hash !== null
    ) {
      const error = new Error("DAILY_DIGEST_JOB_IDENTITY_COLLISION");
      error.code = "DAILY_DIGEST_JOB_IDENTITY_COLLISION";
      throw error;
    }
    return row;
  }

  getDailyDigestJobByInput(digestInputId) {
    this._assertIdentifier(digestInputId, "digestInputId");
    return this.statements.getDailyDigestJobByInput.get(digestInputId) ?? null;
  }

  wakeDailyDigestJob(inputRequest) {
    assertExactPlainObject(inputRequest, ["digestInputId", "at"], "daily digest wake input");
    const { digestInputId, at } = inputRequest;
    this._assertIdentifier(digestInputId, "digestInputId");
    this._assertNonNegativeSafeInteger(at, "at");
    const existing = this.statements.getDailyDigestJobByInput.get(digestInputId);
    if (!existing) throw new Error(`daily digest job for ${digestInputId} does not exist`);
    this.statements.wakeDailyDigestJob.run({ digestInputId, at });
    return this.statements.getDailyDigestJobByInput.get(digestInputId);
  }

  authorizeManualDailyDigestRetry(id, { allowUsageUnknown = false, at = this.now() } = {}) {
    this._assertIdentifier(id, "jobId");
    if (typeof allowUsageUnknown !== "boolean") {
      throw new TypeError("allowUsageUnknown must be a boolean");
    }
    this._assertNonNegativeSafeInteger(at, "manual retry at");
    const changed = this.statements.authorizeManualDailyDigestRetry.run({
      id,
      allowUsageUnknown: allowUsageUnknown ? 1 : 0,
      at,
    }).changes;
    return changed === 1 ? this.statements.getProcessingJob.get(id) : null;
  }

  claimJobs({ owner, at, leaseMs, limit, priorityBefore = Number.MAX_SAFE_INTEGER }) {
    this._assertIdentifier(owner, "owner");
    this._assertNonNegativeSafeInteger(at, "at");
    this._assertPositiveSafeInteger(leaseMs, "leaseMs");
    this._assertPositiveSafeInteger(limit, "limit");
    this._assertPositiveSafeInteger(priorityBefore, "priorityBefore");
    if (limit > 1_000) throw new RangeError("limit must not exceed 1000");
    const leaseExpiresAt = at + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) {
      throw new RangeError("lease expiry must be a safe integer");
    }
    return this.claimJobsTransaction({ owner, at, leaseExpiresAt, limit, priorityBefore });
  }

  claimCloudJobs({ owner, at, leaseMs, limit = 1, priorityBefore = Number.MAX_SAFE_INTEGER }) {
    this._assertIdentifier(owner, "owner");
    this._assertNonNegativeSafeInteger(at, "at");
    this._assertPositiveSafeInteger(leaseMs, "leaseMs");
    this._assertPositiveSafeInteger(limit, "limit");
    this._assertPositiveSafeInteger(priorityBefore, "priorityBefore");
    if (limit > 1_000) throw new RangeError("limit must not exceed 1000");
    const leaseExpiresAt = at + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) {
      throw new RangeError("lease expiry must be a safe integer");
    }
    return this.claimCloudJobsTransaction({
      owner,
      at,
      leaseExpiresAt,
      limit,
      priorityBefore,
    });
  }

  recoverExpiredCloudCandidateLeases({
    owner,
    at,
    leaseMs,
    limit = 100,
    priorityBefore = Number.MAX_SAFE_INTEGER,
  } = {}) {
    this._assertIdentifier(owner, "owner");
    this._assertNonNegativeSafeInteger(at, "at");
    this._assertPositiveSafeInteger(leaseMs, "leaseMs");
    this._assertPositiveSafeInteger(limit, "limit");
    this._assertPositiveSafeInteger(priorityBefore, "priorityBefore");
    if (limit > 1_000) throw new RangeError("limit must not exceed 1000");
    const leaseExpiresAt = at + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new RangeError("lease expiry overflow");
    return this.recoverExpiredCloudCandidateLeasesTransaction({
      owner,
      at,
      leaseExpiresAt,
      limit,
      priorityBefore,
    });
  }

  recoverExpiredCloudPrestartLeases({
    owner,
    at,
    leaseMs,
    limit = 1,
    priorityBefore = Number.MAX_SAFE_INTEGER,
  } = {}) {
    this._assertIdentifier(owner, "owner");
    this._assertNonNegativeSafeInteger(at, "at");
    this._assertPositiveSafeInteger(leaseMs, "leaseMs");
    this._assertPositiveSafeInteger(limit, "limit");
    this._assertPositiveSafeInteger(priorityBefore, "priorityBefore");
    if (limit > 1_000) throw new RangeError("limit must not exceed 1000");
    const leaseExpiresAt = at + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new RangeError("lease expiry overflow");
    return this.recoverExpiredCloudPrestartLeasesTransaction({
      owner,
      at,
      leaseExpiresAt,
      limit,
      priorityBefore,
    });
  }

  listAgentAdmissionBacklog({ priorityBefore = 70, excludeJobId = null } = {}) {
    this._assertPositiveSafeInteger(priorityBefore, "priorityBefore");
    if (excludeJobId !== null) this._assertIdentifier(excludeJobId, "excludeJobId");
    return this.statements.listAgentAdmissionBacklog
      .all({ priorityBefore, excludeJobId })
      .map((row) => ({
        jobType: row.job_type,
        lane: row.lane,
        state: ["retention_urgent", "storage_recovery_compress"].includes(row.state)
          ? "pending"
          : row.state,
        priority: row.priority,
        nextRetryAt: row.next_retry_at,
      }));
  }

  countCloudLaneInFlight({ excludeJobId = null } = {}) {
    if (excludeJobId !== null) this._assertIdentifier(excludeJobId, "excludeJobId");
    return this.statements.countCloudLaneInFlight.get({ excludeJobId }).count;
  }

  recoverExpiredLeases(at) {
    this._assertNonNegativeSafeInteger(at, "at");
    return this.statements.recoverExpiredJobLeases.run({ at }).changes;
  }

  wakeResourceDeferredJobs(at) {
    this._assertNonNegativeSafeInteger(at, "at");
    return this.statements.wakeResourceDeferredJobs.run({ at }).changes;
  }

  renewJobLease(id, { owner, at, leaseMs }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertPositiveSafeInteger(leaseMs, "leaseMs");
    const leaseExpiresAt = at + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new RangeError("lease expiry overflow");
    return this.statements.renewLeasedJob.run({ ...input, leaseExpiresAt }).changes === 1;
  }

  recordJobExecutionDevice(id, { owner, at, executionDevice }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    if (!["cuda", "cpu", "cloud"].includes(executionDevice)) {
      throw new TypeError("executionDevice must be cuda, cpu, or cloud");
    }
    return (
      this.statements.recordLeasedJobExecutionDevice.run({
        ...input,
        executionDevice,
      }).changes === 1
    );
  }

  completeJob(id, { owner, at, executionDevice = null }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    if (executionDevice !== null && !["cuda", "cpu", "cloud"].includes(executionDevice)) {
      throw new TypeError("executionDevice must be cuda, cpu, cloud, or null");
    }
    return this.statements.completeLeasedJob.run({ ...input, executionDevice }).changes === 1;
  }

  supersedeAnalysisJob(id, { owner, at }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    return this.statements.supersedeLeasedAnalysisJob.run(input).changes === 1;
  }

  supersedeDailyDigestJob(id, { owner, at }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    return this.statements.supersedeLeasedDailyDigestJob.run(input).changes === 1;
  }

  retryJob(id, { owner, at, nextRetryAt = at, errorCode }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(errorCode, "errorCode");
    this._assertNonNegativeSafeInteger(nextRetryAt, "nextRetryAt");
    if (nextRetryAt < at) throw new RangeError("nextRetryAt must not be before at");
    return this.statements.retryLeasedJob.run({ ...input, nextRetryAt, errorCode }).changes === 1;
  }

  deferJob(id, { owner, at, nextRetryAt = at + 15_000, reason, preserveManualRetry = false }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(reason, "reason");
    if (typeof preserveManualRetry !== "boolean") {
      throw new TypeError("preserveManualRetry must be a boolean");
    }
    this._assertNonNegativeSafeInteger(nextRetryAt, "nextRetryAt");
    if (nextRetryAt < at) throw new RangeError("nextRetryAt must not be before at");
    return (
      this.statements.deferLeasedJob.run({
        ...input,
        nextRetryAt,
        reason,
        preserveManualRetry: preserveManualRetry ? 1 : 0,
      }).changes === 1
    );
  }

  blockJob(id, { owner, at, errorCode, blockedReason = null }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(errorCode, "errorCode");
    if (blockedReason !== null) this._assertIdentifier(blockedReason, "blockedReason");
    return this.statements.blockLeasedJob.run({ ...input, errorCode, blockedReason }).changes === 1;
  }

  enqueueChunkTranscription(chunk) {
    return this.enqueueChunkTranscriptionTransaction(chunk);
  }

  enqueueCurrentModelTranscriptionJobs({
    inputVersion = 1,
    modelVersion,
    at = this.now(),
    limit = 1_000,
  } = {}) {
    this._assertPositiveSafeInteger(inputVersion, "inputVersion");
    if (typeof modelVersion !== "string" || !modelVersion.trim() || modelVersion.length > 128) {
      throw new TypeError("modelVersion must be a non-empty string of at most 128 characters");
    }
    this._assertNonNegativeSafeInteger(at, "at");
    this._assertPositiveSafeInteger(limit, "limit");
    return this.enqueueCurrentModelTranscriptionJobsTransaction({
      inputVersion,
      modelVersion: modelVersion.trim(),
      at,
      limit,
    });
  }

  _insertChunkTranscription(chunk) {
    const input = this._transcriptionInput(chunk);
    this.statements.insertTranscriptionJob.run({
      id: this.createId("job"),
      sessionId: chunk.sessionId,
      trackId: chunk.trackId,
      ...input,
      createdAt: this.now(),
    });
    return this.statements.getTranscriptionJobByInput.get(input);
  }

  _insertChunkCompression(chunk) {
    if (typeof chunk.encoderVersion !== "string" || chunk.encoderVersion.length === 0) {
      throw new TypeError("encoderVersion must be a non-empty string");
    }
    const input = {
      chunkId: chunk.id,
      inputHash: chunk.sha256,
      modelVersion: chunk.encoderVersion,
    };
    const existing = this.statements.getCompressionJobByInput.get(input);
    if (existing) return existing;
    this.statements.insertCompressionJob.run({
      id: this.createId("job"),
      sessionId: chunk.sessionId,
      trackId: chunk.trackId,
      ...input,
      createdAt: this.now(),
    });
    return this.statements.getCompressionJobByInput.get(input);
  }

  _chunkResult(row) {
    return toPublicAudioChunk(this._maintenanceChunkResult(row));
  }

  _maintenanceChunkResult(row) {
    return {
      ...row,
      format: row.format ?? "wav",
      pcm_sha256: row.sha256,
      file_sha256: row.file_sha256 ?? null,
      retired_path: row.retired_path ?? null,
      retired_format: row.retired_format ?? null,
      retired_file_sha256: row.retired_file_sha256 ?? null,
      sample_rate: row.sample_rate ?? 24_000,
      channels: row.channels ?? 1,
    };
  }

  _transcriptionInput(chunk) {
    return {
      chunkId: chunk.id,
      inputHash: chunk.sha256,
      inputVersion: chunk.inputVersion ?? 1,
      modelVersion: chunk.modelVersion ?? "",
    };
  }

  _assertIdentifier(value, name) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      throw new TypeError(`${name} must be a safe identifier`);
    }
  }

  _assertHash(value, name) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new TypeError(`${name} must be a lowercase SHA-256 hash`);
    }
  }

  _assertText(value, name, maxLength) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw new TypeError(`${name} must be non-empty text of at most ${maxLength} characters`);
    }
  }

  _assertSafeInteger(value, name) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }

  _assertNonNegativeSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }

  _assertPositiveSafeInteger(value, name) {
    this._assertSafeInteger(value, name);
    if (value <= 0) throw new RangeError(`${name} must be positive`);
  }

  _assertJobLeaseTransition(id, { owner, at } = {}) {
    this._assertIdentifier(id, "jobId");
    this._assertIdentifier(owner, "owner");
    this._assertNonNegativeSafeInteger(at, "at");
    return { id, owner, at };
  }

  _assertLifecycleTransition({ sessionId, sources, at, sessionState, sourceStates }) {
    this._assertIdentifier(sessionId, "sessionId");
    this._assertSafeInteger(at, "transition at");
    if (!Array.isArray(sources)) throw new TypeError("transition sources must be an array");
    const session = this.statements.getSession.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} does not exist`);
    if (session.status !== sessionState) {
      throw new Error(`session ${sessionId} must be ${sessionState}`);
    }
    if (at < session.started_at) {
      throw new RangeError("transition at must not be before session startedAt");
    }
    const sessionTracks = this.statements.listTracksForSession
      .all(sessionId)
      .filter((track) => !TERMINAL_TRACK_STATES.has(track.state));
    if (sources.length !== sessionTracks.length) {
      throw new Error("transition must include every session track that is open exactly once");
    }

    const seenTrackIds = new Set();
    const evidence = sources.map((source) => {
      if (!source || typeof source !== "object") {
        throw new TypeError("transition source is required");
      }
      this._assertIdentifier(source.trackId, "trackId");
      if (!sourceStates.has(source.expectedState)) {
        throw new TypeError("invalid transition expected state");
      }
      if (seenTrackIds.has(source.trackId)) {
        throw new Error(`track ${source.trackId} is duplicated in transition`);
      }
      seenTrackIds.add(source.trackId);
      const track = this.statements.getTrack.get(source.trackId);
      if (!track) throw new Error(`track ${source.trackId} does not exist`);
      if (track.session_id !== sessionId) {
        throw new Error(`track ${source.trackId} does not belong to session ${sessionId}`);
      }
      if (track.state !== source.expectedState) {
        throw new Error(`track ${source.trackId} does not match its expected state`);
      }
      if (at < track.started_at) {
        throw new RangeError("transition at must not be before track startedAt");
      }
      if (track.ended_at !== null && at < track.ended_at) {
        throw new RangeError("transition at must not be before track endedAt");
      }
      const openGap = this.statements.getOpenGapForTrack.get(track.id);
      if (track.state === "recovering" && !openGap) {
        throw new Error(`recovering track ${track.id} must have an open gap`);
      }
      if (track.state !== "recovering" && openGap) {
        throw new Error(`non-recovering track ${track.id} must not have an open gap`);
      }
      return { track, openGap, source };
    });
    if (sessionTracks.some((track) => !seenTrackIds.has(track.id))) {
      throw new Error("transition must include every session track that is open exactly once");
    }
    return evidence;
  }

  _transitionSourceSession({ track, sessionId, sessionStatus }) {
    const hasSessionTransition = sessionId !== undefined || sessionStatus !== undefined;
    if (!hasSessionTransition) return;
    this._assertIdentifier(sessionId, "sessionId");
    if (!SOURCE_LIFECYCLE_SESSION_STATUSES.has(sessionStatus)) {
      throw new TypeError("invalid source lifecycle session status");
    }
    if (track.session_id !== sessionId) {
      throw new Error(`track ${track.id} does not belong to session ${sessionId}`);
    }
    const session = this.statements.getSession.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} does not exist`);
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      throw new Error(`session ${sessionId} is already terminal`);
    }
    const transitioned = this.statements.transitionSession.run({
      sessionId,
      status: sessionStatus,
      endedAt: null,
    });
    if (transitioned.changes !== 1) {
      throw new Error(`session ${sessionId} was not updated`);
    }
  }

  _assertChunk(chunk) {
    const format = chunk.format ?? "wav";
    if (format !== "wav") throw new TypeError("committed audio evidence must be WAV");
    const sampleRate = chunk.sampleRate ?? 24_000;
    if (sampleRate !== 24_000) {
      throw new RangeError("committed audio evidence must use 24 kHz sample rate");
    }
    const channels = chunk.channels ?? 1;
    if (channels !== 1) throw new RangeError("committed audio evidence must be mono");
    const track = this.statements.getTrack.get(chunk.trackId);
    if (!track) throw new Error(`track ${chunk.trackId} does not exist`);
    if (track.session_id !== chunk.sessionId) throw new Error("chunk session does not match track");
    if (track.source_type !== chunk.sourceType)
      throw new Error("chunk source does not match track");
    const session = this.statements.getSession.get(chunk.sessionId);
    if (!session) throw new Error(`session ${chunk.sessionId} does not exist`);
    if (!Number.isSafeInteger(chunk.startedAt) || !Number.isSafeInteger(chunk.endedAt)) {
      throw new TypeError("chunk timestamps must be safe integers");
    }
    if (chunk.startedAt < track.started_at || chunk.startedAt < session.started_at) {
      throw new RangeError("chunk startedAt must not be before its track or session startedAt");
    }
    if (
      (track.ended_at !== null && chunk.endedAt > track.ended_at) ||
      (session.ended_at !== null && chunk.endedAt > session.ended_at)
    ) {
      throw new RangeError("chunk endedAt must not be after its track or session endedAt");
    }
    const captureSpanMs = chunk.endedAt - chunk.startedAt;
    if (captureSpanMs <= 0) {
      throw new RangeError("chunk capture span must be positive");
    }
    if (captureSpanMs > MAX_CHUNK_DURATION_MS) {
      throw new RangeError("chunk capture span must not exceed 60000 ms");
    }
    if (!Number.isSafeInteger(chunk.durationMs) || chunk.durationMs <= 0) {
      throw new RangeError("chunk duration must be a positive integer");
    }
    if (chunk.durationMs > MAX_CHUNK_DURATION_MS) {
      throw new RangeError("chunk duration must not exceed 60000 ms");
    }
    if (chunk.durationMs !== captureSpanMs) {
      throw new RangeError("chunk durationMs must equal the integer capture span");
    }
    if (!Number.isSafeInteger(chunk.expiresAt)) {
      throw new TypeError("chunk expiresAt must be a safe integer");
    }
    if (chunk.expiresAt < chunk.endedAt || chunk.expiresAt > chunk.endedAt + MAX_RETENTION_MS) {
      throw new RangeError("chunk expiry must be no later than seven days after endedAt");
    }
  }
}

module.exports = CaptureEvidenceStore;
