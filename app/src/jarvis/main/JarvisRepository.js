const Database = require("better-sqlite3");
const { assertId, assertSessionStatus } = require("../shared/contracts");

const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('recording','paused','finalizing','completed','recovered','failed')),
    mic_device_id TEXT,
    language TEXT NOT NULL DEFAULT 'zh',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 0,
    voice_profile_id INTEGER,
    voice_confidence REAL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    speaker_label TEXT NOT NULL,
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    is_stable INTEGER NOT NULL,
    analysis_state TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS audio_chunks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    transcription_status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_segments_session_time
    ON transcript_segments(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_audio_expiry ON audio_chunks(expires_at);
`;

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

class JarvisRepository {
  constructor(dbPath) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("dbPath must be a non-empty string");
    }

    this.db = new Database(dbPath);
    try {
      this.db.pragma("foreign_keys = ON");
      if (dbPath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
      }
      this.db.transaction(() => this.db.exec(SCHEMA))();
      this._prepareStatements();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  _prepareStatements() {
    this.statements = {
      createSession: this.db.prepare(`
        INSERT INTO sessions (
          id, started_at, status, mic_device_id, language, created_at
        ) VALUES (
          @id, @startedAt, 'recording', @micDeviceId, @language, @createdAt
        )
      `),
      setSessionStatus: this.db.prepare(`
        UPDATE sessions
        SET status = @status, ended_at = @endedAt
        WHERE id = @id
      `),
      getSession: this.db.prepare("SELECT * FROM sessions WHERE id = ?"),
      listSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE started_at >= @from AND started_at <= @to
        ORDER BY started_at DESC, id DESC
        LIMIT @limit
      `),
      insertPerson: this.db.prepare(`
        INSERT OR IGNORE INTO people (
          id, display_name, is_self, created_at, last_seen_at
        ) VALUES (
          @id, @displayName, 0, @createdAt, @lastSeenAt
        )
      `),
      upsertSegment: this.db.prepare(`
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, person_id, speaker_label,
          text, confidence, is_stable
        ) VALUES (
          @id, @sessionId, @startedAt, @endedAt, @personId, @speakerLabel,
          @text, @confidence, @isStable
        )
        ON CONFLICT(id) DO UPDATE SET
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          person_id = excluded.person_id,
          speaker_label = excluded.speaker_label,
          text = excluded.text,
          confidence = excluded.confidence,
          is_stable = excluded.is_stable
      `),
      listSegments: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC
      `),
      clearSelf: this.db.prepare("UPDATE people SET is_self = 0 WHERE is_self <> 0"),
      renamePerson: this.db.prepare(`
        INSERT INTO people (
          id, display_name, is_self, voice_profile_id, created_at, last_seen_at
        ) VALUES (
          @personId, @displayName, @isSelf, @voiceProfileId, @now, @now
        )
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          is_self = excluded.is_self,
          voice_profile_id = excluded.voice_profile_id,
          last_seen_at = excluded.last_seen_at
      `),
      getPerson: this.db.prepare("SELECT * FROM people WHERE id = ?"),
      listPeople: this.db.prepare(`
        SELECT * FROM people
        ORDER BY is_self DESC, display_name COLLATE NOCASE ASC, id ASC
      `),
      insertAudioChunk: this.db.prepare(`
        INSERT INTO audio_chunks (
          id, session_id, path, started_at, ended_at, duration_ms,
          sha256, expires_at, transcription_status
        ) VALUES (
          @id, @sessionId, @path, @startedAt, @endedAt, @durationMs,
          @sha256, @expiresAt, @transcriptionStatus
        )
      `),
      getAudioChunk: this.db.prepare("SELECT * FROM audio_chunks WHERE id = ?"),
      listAudioChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC
      `),
      listExpiredAudioChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE expires_at <= ?
        ORDER BY expires_at ASC, id ASC
      `),
      deleteAudioChunk: this.db.prepare("DELETE FROM audio_chunks WHERE id = ?"),
      recoverOpenSessions: this.db.prepare(`
        UPDATE sessions
        SET status = 'recovered', ended_at = @at
        WHERE status IN ('recording', 'paused', 'finalizing')
      `),
    };

    this._upsertTranscriptSegments = this.db.transaction((sessionId, segments) => {
      for (const segment of segments) {
        if (segment.personId !== null && segment.personId !== undefined) {
          const personId = assertId(segment.personId, "personId");
          this.statements.insertPerson.run({
            id: personId,
            displayName: segment.speakerLabel,
            createdAt: segment.startedAt,
            lastSeenAt: segment.endedAt,
          });
        }

        this.statements.upsertSegment.run({
          id: assertId(segment.id, "segmentId"),
          sessionId,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          personId: segment.personId ?? null,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          confidence: segment.confidence,
          isStable: segment.isStable ? 1 : 0,
        });
      }
    });

    this._renamePerson = this.db.transaction((input) => {
      if (input.isSelf) this.statements.clearSelf.run();
      this.statements.renamePerson.run(input);
    });
  }

  createSession({ id, startedAt, micDeviceId, language = "zh" }) {
    const sessionId = assertId(id, "sessionId");
    assertInteger(startedAt, "startedAt");
    if (micDeviceId !== null && micDeviceId !== undefined && typeof micDeviceId !== "string") {
      throw new TypeError("micDeviceId must be a string or null");
    }
    if (typeof language !== "string" || language.length === 0 || language.length > 32) {
      throw new TypeError("language must be a non-empty string of at most 32 characters");
    }

    this.statements.createSession.run({
      id: sessionId,
      startedAt,
      micDeviceId: micDeviceId ?? null,
      language,
      createdAt: Date.now(),
    });
    return this.getSession(sessionId);
  }

  setSessionStatus(id, status, at = Date.now()) {
    const sessionId = assertId(id, "sessionId");
    const sessionStatus = assertSessionStatus(status);
    assertInteger(at, "at");
    this.statements.setSessionStatus.run({
      id: sessionId,
      status: sessionStatus,
      endedAt: TERMINAL_SESSION_STATUSES.has(sessionStatus) ? at : null,
    });
    return this.getSession(sessionId);
  }

  getSession(id) {
    return this.statements.getSession.get(assertId(id, "sessionId")) ?? null;
  }

  listSessions({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
    assertInteger(from, "from");
    assertInteger(to, "to");
    assertInteger(limit, "limit");
    if (from > to) throw new RangeError("from must not be greater than to");
    if (limit < 1 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
    return this.statements.listSessions.all({ from, to, limit });
  }

  upsertTranscriptSegments(sessionId, segments) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
    this._upsertTranscriptSegments(safeSessionId, segments);
    return this.listTranscriptSegments(safeSessionId);
  }

  listTranscriptSegments(sessionId) {
    return this.statements.listSegments.all(assertId(sessionId, "sessionId"));
  }

  renamePerson({ personId, displayName, isSelf = false, voiceProfileId = null }) {
    const safePersonId = assertId(personId, "personId");
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new TypeError("displayName must not be empty");
    }
    if (typeof isSelf !== "boolean") throw new TypeError("isSelf must be a boolean");
    if (voiceProfileId !== null && !Number.isSafeInteger(voiceProfileId)) {
      throw new TypeError("voiceProfileId must be a safe integer or null");
    }

    const input = {
      personId: safePersonId,
      displayName: displayName.trim(),
      isSelf: isSelf ? 1 : 0,
      voiceProfileId,
      now: Date.now(),
    };
    this._renamePerson(input);
    return this.statements.getPerson.get(safePersonId);
  }

  listPeople() {
    return this.statements.listPeople.all();
  }

  insertAudioChunk(chunk) {
    const input = {
      id: assertId(chunk.id, "audioChunkId"),
      sessionId: assertId(chunk.sessionId, "sessionId"),
      path: chunk.path,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      durationMs: chunk.durationMs,
      sha256: chunk.sha256,
      expiresAt: chunk.expiresAt,
      transcriptionStatus: chunk.transcriptionStatus ?? "pending",
    };
    this.statements.insertAudioChunk.run(input);
    return this.statements.getAudioChunk.get(input.id);
  }

  listAudioChunks(sessionId) {
    return this.statements.listAudioChunks.all(assertId(sessionId, "sessionId"));
  }

  listExpiredAudioChunks(now = Date.now()) {
    return this.statements.listExpiredAudioChunks.all(assertInteger(now, "now"));
  }

  deleteAudioChunk(id) {
    return this.statements.deleteAudioChunk.run(assertId(id, "audioChunkId")).changes;
  }

  recoverOpenSessions(at = Date.now()) {
    return this.statements.recoverOpenSessions.run({ at: assertInteger(at, "at") }).changes;
  }

  close() {
    if (this.db.open) this.db.close();
  }
}

module.exports = JarvisRepository;
