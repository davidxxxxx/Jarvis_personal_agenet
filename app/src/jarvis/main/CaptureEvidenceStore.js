const MAX_CHUNK_DURATION_MS = 60_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
      closeGap: db.prepare(`
        UPDATE audio_gaps
        SET ended_at = @endedAt,
            recovery_attempts = COALESCE(@recoveryAttempts, recovery_attempts)
        WHERE id = @id AND ended_at IS NULL
      `),
      getTrack: db.prepare("SELECT * FROM audio_tracks WHERE id = ?"),
      findChunkSequence: db.prepare(`
        SELECT id FROM audio_chunks
        WHERE track_id = ? AND sequence_number = ?
      `),
      insertChunk: db.prepare(`
        INSERT INTO audio_chunks (
          id, session_id, track_id, source_type, sequence_number, path,
          started_at, ended_at, duration_ms, sha256, expires_at,
          transcription_status, write_state
        ) VALUES (
          @id, @sessionId, @trackId, @sourceType, @sequenceNumber, @path,
          @startedAt, @endedAt, @durationMs, @sha256, @expiresAt,
          'pending', 'committed'
        )
      `),
      getChunk: db.prepare("SELECT * FROM audio_chunks WHERE id = ?"),
      insertTranscriptionJob: db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId,
          'transcribe_chunk', 'pending', @inputHash, @inputVersion, @modelVersion, @createdAt
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
      tombstoneChunk: db.prepare(`
        UPDATE audio_chunks
        SET path = 'tombstone:' || id, deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
    };

    this.commitChunkTransaction = db.transaction((chunk) => {
      this._assertChunk(chunk);
      if (this.statements.findChunkSequence.get(chunk.trackId, chunk.sequenceNumber)) {
        throw new Error(
          `chunk sequence ${chunk.sequenceNumber} already exists for track ${chunk.trackId}`
        );
      }
      this.statements.insertChunk.run(chunk);
      return this._insertChunkTranscription(chunk);
    });
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

  setTrackState(id, state, endedAt = null) {
    return this.statements.setTrackState.run({ id, state, endedAt });
  }

  openGap(gap) {
    return this.statements.openGap.run({
      ...gap,
      recoveryAttempts: gap.recoveryAttempts ?? 0,
    });
  }

  closeGap(id, endedAt, recoveryAttempts = null) {
    return this.statements.closeGap.run({ id, endedAt, recoveryAttempts });
  }

  commitChunk(chunk) {
    return this.commitChunkTransaction(chunk);
  }

  tombstoneChunk(id, deletedAt = this.now()) {
    return this.statements.tombstoneChunk.run(deletedAt, id);
  }

  enqueueChunkTranscription(chunk) {
    const persisted = this.statements.getChunk.get(chunk.id);
    if (!persisted) throw new Error(`chunk ${chunk.id} does not exist`);
    if (persisted.session_id !== chunk.sessionId) throw new Error("chunk session does not match");
    if (persisted.track_id !== chunk.trackId) throw new Error("chunk track does not match");
    if (persisted.source_type !== chunk.sourceType) throw new Error("chunk source does not match");
    if (persisted.sha256 !== chunk.sha256) throw new Error("chunk input hash does not match");

    const input = this._transcriptionInput(chunk);
    const existing = this.statements.getTranscriptionJobByInput.get(input);
    return existing ?? this._insertChunkTranscription(chunk);
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

  _transcriptionInput(chunk) {
    return {
      chunkId: chunk.id,
      inputHash: chunk.sha256,
      inputVersion: chunk.inputVersion ?? 1,
      modelVersion: chunk.modelVersion ?? "",
    };
  }

  _assertChunk(chunk) {
    const track = this.statements.getTrack.get(chunk.trackId);
    if (!track) throw new Error(`track ${chunk.trackId} does not exist`);
    if (track.session_id !== chunk.sessionId) throw new Error("chunk session does not match track");
    if (track.source_type !== chunk.sourceType) throw new Error("chunk source does not match track");
    if (!Number.isSafeInteger(chunk.startedAt) || !Number.isSafeInteger(chunk.endedAt)) {
      throw new TypeError("chunk timestamps must be safe integers");
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
