const MAX_CHUNK_DURATION_MS = 60_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TRACK_STATES = new Set(["ended", "recovered", "failed"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const RESTORATION_TARGET_STATES = new Set(["active", "paused"]);
const SOURCE_LIFECYCLE_SESSION_STATUSES = new Set(["recording", "paused"]);
const TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});

const { toPublicAudioChunk } = require("./AudioChunkPublicView");

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
          id, session_id, source_type, device_id, device_label, strategy,
          sample_rate, channels, started_at, state
        ) VALUES (
          @id, @sessionId, @sourceType, @deviceId, @deviceLabel, @strategy,
          @sampleRate, @channels, @startedAt, @state
        )
      `),
      setTrackState: db.prepare(`
        UPDATE audio_tracks
        SET state = @state, ended_at = @endedAt
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
          'transcribe_chunk', 'pending', 30, @inputHash, @inputVersion, @modelVersion, @createdAt
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
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS current
            WHERE current.chunk_id = chunk.id
              AND current.job_type = 'transcribe_chunk'
              AND current.input_hash = chunk.sha256
              AND current.input_version = @inputVersion
              AND current.model_version = @modelVersion
          )
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS active
            WHERE active.chunk_id = chunk.id
              AND active.job_type = 'transcribe_chunk'
              AND active.state = 'running'
              AND active.completed_at IS NULL
              AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at > @at
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
        SELECT * FROM processing_jobs
        WHERE state IN ('pending', 'retry', 'retention_urgent', 'storage_recovery_compress')
          AND completed_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at <= @at)
          AND priority < @priorityBefore
        ORDER BY priority ASC,
          created_at ASC,
          id ASC
        LIMIT @limit
      `),
      claimJob: db.prepare(`
        UPDATE processing_jobs
        SET state = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = @owner,
            lease_expires_at = @leaseExpiresAt
        WHERE id = @id
          AND state IN ('pending', 'retry', 'retention_urgent', 'storage_recovery_compress')
          AND completed_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at <= @at)
          AND priority < @priorityBefore
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
          AND completed_at IS NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @at
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
            error_code = NULL,
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
            blocked_reason = NULL,
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
        const chunks = this.statements.listChunksMissingCurrentTranscription.all({
          inputVersion,
          modelVersion,
          at,
          limit,
        });
        let enqueued = 0;
        let superseded = 0;
        for (const row of chunks) {
          superseded += this.statements.supersedeStaleTranscriptionJobs.run({
            chunkId: row.id,
            inputHash: row.sha256,
            inputVersion,
            modelVersion,
            at,
          }).changes;
          this.statements.insertTranscriptionJob.run({
            id: this.createId("job"),
            sessionId: row.session_id,
            trackId: row.track_id,
            chunkId: row.id,
            inputHash: row.sha256,
            inputVersion,
            modelVersion,
            createdAt: at,
          });
          this.statements.invalidateSessionReadiness.run({ sessionId: row.session_id });
          enqueued += 1;
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
      const tracks = this.statements.listTracksForSession.all(sessionId);
      if (sources.length !== tracks.length) {
        throw new Error("power restoration must include every session track exactly once");
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
          const updated = this.setTrackState(track.id, trackState, at);
          if (updated.changes !== 1) throw new Error(`track ${track.id} was not finalized`);
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
    return this.statements.createTrack.run({
      ...track,
      deviceId: track.deviceId ?? null,
      deviceLabel: track.deviceLabel ?? null,
      strategy: track.strategy ?? null,
      state: track.state ?? "active",
    });
  }

  createTracks(tracks) {
    if (!Array.isArray(tracks)) throw new TypeError("tracks must be an array");
    return this.createTracksTransaction(tracks);
  }

  setTrackState(id, state, endedAt = null) {
    return this.statements.setTrackState.run({ id, state, endedAt });
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

  recoverExpiredLeases(at) {
    this._assertNonNegativeSafeInteger(at, "at");
    return this.statements.recoverExpiredJobLeases.run({ at }).changes;
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

  retryJob(id, { owner, at, nextRetryAt = at, errorCode }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(errorCode, "errorCode");
    this._assertNonNegativeSafeInteger(nextRetryAt, "nextRetryAt");
    if (nextRetryAt < at) throw new RangeError("nextRetryAt must not be before at");
    return this.statements.retryLeasedJob.run({ ...input, nextRetryAt, errorCode }).changes === 1;
  }

  deferJob(id, { owner, at, nextRetryAt = at + 15_000, reason }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(reason, "reason");
    this._assertNonNegativeSafeInteger(nextRetryAt, "nextRetryAt");
    if (nextRetryAt < at) throw new RangeError("nextRetryAt must not be before at");
    return this.statements.deferLeasedJob.run({ ...input, nextRetryAt, reason }).changes === 1;
  }

  blockJob(id, { owner, at, errorCode }) {
    const input = this._assertJobLeaseTransition(id, { owner, at });
    this._assertIdentifier(errorCode, "errorCode");
    return this.statements.blockLeasedJob.run({ ...input, errorCode }).changes === 1;
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
    const sessionTracks = this.statements.listTracksForSession.all(sessionId);
    if (sources.length !== sessionTracks.length) {
      throw new Error("transition must include every session track exactly once");
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
      throw new Error("transition must include every session track exactly once");
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
