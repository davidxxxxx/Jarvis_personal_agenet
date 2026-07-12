const MAX_CHUNK_DURATION_MS = 60_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TRACK_STATES = new Set(["ended", "recovered", "failed"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});

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
      getGap: db.prepare("SELECT * FROM audio_gaps WHERE id = ?"),
      getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      listTracksForSession: db.prepare("SELECT * FROM audio_tracks WHERE session_id = ?"),
      getOpenGapForTrack: db.prepare(
        "SELECT * FROM audio_gaps WHERE track_id = ? AND ended_at IS NULL"
      ),
      listOpenGapsForTrack: db.prepare(
        "SELECT * FROM audio_gaps WHERE track_id = ? AND ended_at IS NULL ORDER BY started_at, id"
      ),
      finalizeSession: db.prepare(`
        UPDATE sessions
        SET status = @sessionStatus, ended_at = @at
        WHERE id = @sessionId
      `),
      transitionSession: db.prepare(`
        UPDATE sessions
        SET status = @status, ended_at = @endedAt
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
    this.createTracksTransaction = db.transaction((tracks) =>
      tracks.map((track) => this.createTrack(track))
    );
    this.interruptTrackTransaction = db.transaction(({ trackId, gap }) => {
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
      return { trackId, gapId: gap.id };
    });
    this.restoreTrackTransaction = db.transaction(
      ({ trackId, gapId, endedAt, recoveryAttempts = 1 }) => {
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
        const closed = this.closeGap(gapId, endedAt, recoveryAttempts);
        if (closed.changes !== 1) throw new Error(`gap ${gapId} is not open`);
        const updated = this.setTrackState(trackId, "active", null);
        if (updated.changes !== 1) throw new Error(`track ${trackId} was not updated`);
        return { trackId, gapId };
      }
    );
    this.pauseCaptureTransaction = db.transaction(({ sessionId, sources, at }) => {
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
      const paused = this.statements.transitionSession.run({
        sessionId,
        status: "paused",
        endedAt: null,
      });
      if (paused.changes !== 1) throw new Error(`session ${sessionId} was not paused`);
      return { sessionId, status: "paused" };
    });
    this.resumeCaptureTransaction = db.transaction(({ sessionId, sources, at }) => {
      const evidence = this._assertLifecycleTransition({
        sessionId,
        sources,
        at,
        sessionState: "paused",
        sourceStates: new Set(["paused", "recovering"]),
      });
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

  interruptTrack(input) {
    return this.interruptTrackTransaction(input);
  }

  closeGap(id, endedAt, recoveryAttempts = null) {
    return this.statements.closeGap.run({ id, endedAt, recoveryAttempts });
  }

  restoreTrack(input) {
    return this.restoreTrackTransaction(input);
  }

  pauseCapture(input) {
    return this.pauseCaptureTransaction(input);
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
      return { track, openGap };
    });
    if (sessionTracks.some((track) => !seenTrackIds.has(track.id))) {
      throw new Error("transition must include every session track exactly once");
    }
    return evidence;
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
