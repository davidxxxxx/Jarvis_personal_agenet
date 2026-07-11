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
      insertTranscriptionJob: db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, input_hash, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId,
          'transcribe_chunk', 'pending', @inputHash, @createdAt
        )
      `),
      getTranscriptionJobByInput: db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'transcribe_chunk' AND input_hash = ?
      `),
      tombstoneChunk: db.prepare(`
        UPDATE audio_chunks
        SET path = '', deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
    };

    this.commitChunkTransaction = db.transaction((chunk) => {
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
    const existing = this.statements.getTranscriptionJobByInput.get(chunk.sha256);
    return existing ?? this._insertChunkTranscription(chunk);
  }

  _insertChunkTranscription(chunk) {
    this.statements.insertTranscriptionJob.run({
      id: this.createId("job"),
      sessionId: chunk.sessionId,
      trackId: chunk.trackId,
      chunkId: chunk.id,
      inputHash: chunk.sha256,
      createdAt: this.now(),
    });
    return this.statements.getTranscriptionJobByInput.get(chunk.sha256);
  }
}

module.exports = CaptureEvidenceStore;
