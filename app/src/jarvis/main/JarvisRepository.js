const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const { assertCaptureMode, assertId, assertSessionStatus } = require("../shared/contracts");
const {
  RETENTION_MODES,
  assertRetentionMode,
  normalizeCapturePolicy,
} = require("../shared/captureModes");
const CaptureEvidenceStore = require("./CaptureEvidenceStore");
const { applyJarvisMigrations } = require("./JarvisMigrations");
const { toPublicAudioChunk } = require("./AudioChunkPublicView");

const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const SEGMENT_SESSION_MISMATCH_MESSAGE = "segment belongs to a different session";
const MAX_SPEAKER_NAME_CODE_POINTS = 80;
const DEFAULT_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MIN_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MAX_CLOUD_LIMIT_MICROUSD = 10_000_000;
const CLOUD_RESERVATION_MICROUSD = 100_000;
const LEGACY_TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  recording: "active",
  finalizing: "active",
  paused: "paused",
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});

function legacyTrackLifecycle(session) {
  const state = LEGACY_TRACK_STATE_BY_SESSION_STATUS[session.status];
  if (!state) throw new Error(`unsupported legacy session status: ${session.status}`);
  const terminal = state === "ended" || state === "recovered" || state === "failed";
  return {
    state,
    endedAt: terminal ? (session.ended_at ?? session.started_at) : null,
  };
}

function compareStableIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSpeakerName(value) {
  if (typeof value !== "string") throw new TypeError("displayName must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("displayName must not be empty");
  if (Array.from(trimmed).length > MAX_SPEAKER_NAME_CODE_POINTS) {
    throw new RangeError("displayName must contain at most 80 Unicode code points");
  }
  return trimmed;
}

const SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS cloud_budget_settings (
    provider TEXT PRIMARY KEY,
    monthly_limit_microusd INTEGER NOT NULL
      CHECK(monthly_limit_microusd BETWEEN 5000000 AND 10000000),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cloud_usage (
    id TEXT PRIMARY KEY,
    month_utc TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    audio_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    price_version TEXT NOT NULL,
    reserved_microusd INTEGER NOT NULL,
    actual_microusd INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('reserved','settled','released','unknown')),
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS transcript_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    audio_source TEXT NOT NULL CHECK(audio_source IN ('mic','system')),
    person_id TEXT,
    speaker_label TEXT NOT NULL,
    original_text TEXT NOT NULL,
    current_text TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source = 'openai_correction'),
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    corrected_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('incremental','final')),
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','retry','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    response_json TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE(session_id, kind, input_hash)
  );
  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '[]',
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 0 CHECK(is_final IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    canonical_title TEXT NOT NULL,
    normalized_title TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_topics (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    PRIMARY KEY(session_id, topic_id)
  );
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    owner_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
    due_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
    confidence REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('fact','decision','commitment','opinion')),
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    needs_confirmation INTEGER NOT NULL DEFAULT 0 CHECK(needs_confirmation IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    PRIMARY KEY(memory_id, segment_id)
  );
  INSERT OR IGNORE INTO cloud_budget_settings (
    provider, monthly_limit_microusd, enabled, updated_at
  ) VALUES ('openai', 5000000, 0, 0);
  CREATE INDEX IF NOT EXISTS idx_segments_session_time
    ON transcript_segments(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_audio_expiry ON audio_chunks(expires_at);
  CREATE INDEX IF NOT EXISTS idx_cloud_usage_month ON cloud_usage(month_utc, provider, status);
  CREATE INDEX IF NOT EXISTS idx_analysis_session ON analysis_runs(session_id, window_end);
  CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_last_seen ON memories(last_seen_at DESC);
`;

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, name) {
  assertInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
  return value;
}

function assertMonthUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError("monthUtc must use YYYY-MM");
  }
  return value;
}

function monthUtcFromTimestamp(at) {
  assertInteger(at, "at");
  return new Date(at).toISOString().slice(0, 7);
}

function normalizeDerivedText(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty`);
  if (Array.from(trimmed).length > 2_000) throw new RangeError(`${name} is too long`);
  return trimmed.replace(/\s+/g, " ");
}

function normalizedKey(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function derivedId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
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
      this.db.transaction(() => {
        applyJarvisMigrations(this.db);
        this.db.exec(SCHEMA);
      })();
      this._prepareStatements();
      this.captureEvidenceStore = new CaptureEvidenceStore(this.db, {
        createId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  _prepareStatements() {
    this.statements = {
      createSession: this.db.prepare(`
        INSERT INTO sessions (
          id, started_at, status, mic_device_id, language, created_at, capture_mode,
          retention_mode, capture_policy_json
        ) VALUES (
          @id, @startedAt, 'recording', @micDeviceId, @language, @createdAt, @captureMode,
          @retentionMode, @capturePolicyJson
        )
      `),
      setSessionRetention: this.db.prepare(`
        UPDATE sessions
        SET retention_mode = @retentionMode, capture_policy_json = @capturePolicyJson
        WHERE id = @id
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
      getSegmentSession: this.db.prepare("SELECT session_id FROM transcript_segments WHERE id = ?"),
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
        WHERE expires_at <= ? AND deleted_at IS NULL
        ORDER BY expires_at ASC, id ASC
      `),
      getSessionSourceTrack: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE session_id = ? AND source_type = ?
      `),
      insertLegacyMicTrack: this.db.prepare(`
        INSERT INTO audio_tracks (
          id, session_id, source_type, device_id, device_label, strategy,
          sample_rate, channels, started_at, ended_at, state
        ) VALUES (
          @id, @sessionId, 'mic', NULL, NULL, 'legacy_backfill',
          24000, 1, @startedAt, @endedAt, @state
        )
      `),
      listUntrackedAudioChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND track_id IS NULL AND deleted_at IS NULL
        ORDER BY started_at ASC, ended_at ASC, id ASC
      `),
      getUntrackedAudioChunk: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE id = ? AND session_id = ? AND track_id IS NULL AND deleted_at IS NULL
      `),
      getLastTrackSequence: this.db.prepare(`
        SELECT COALESCE(MAX(sequence_number), -1) AS sequence_number
        FROM audio_chunks WHERE track_id = ?
      `),
      linkLegacyAudioChunk: this.db.prepare(`
        UPDATE audio_chunks
        SET track_id = @trackId, source_type = 'mic', sequence_number = @sequenceNumber
        WHERE id = @id AND session_id = @sessionId
          AND track_id IS NULL AND deleted_at IS NULL
      `),
      syncChunkJobTrack: this.db.prepare(`
        UPDATE processing_jobs SET track_id = @trackId
        WHERE chunk_id = @chunkId
      `),
      listChunkJobsForLegacyLink: this.db.prepare(`
        SELECT id, session_id, track_id, state
        FROM processing_jobs
        WHERE chunk_id = ?
        ORDER BY id
      `),
      getLegacyChunkTranscriptionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'transcribe_chunk'
          AND chunk_id = @chunkId
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = ''
      `),
      insertLegacyChunkTranscriptionJob: this.db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId, 'transcribe_chunk', 'pending',
          @inputHash, 1, '', @createdAt
        )
      `),
      listOpenSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('recording', 'paused', 'finalizing')
        ORDER BY started_at ASC, id ASC
      `),
      listSessionTracksForRecovery: this.db.prepare(
        "SELECT id FROM audio_tracks WHERE session_id = ? ORDER BY id"
      ),
      getCloudBudgetSettings: this.db.prepare(
        "SELECT provider, monthly_limit_microusd, enabled, updated_at FROM cloud_budget_settings WHERE provider = 'openai'"
      ),
      setCloudBudgetSettings: this.db.prepare(`
        UPDATE cloud_budget_settings
        SET monthly_limit_microusd = @monthlyLimitMicrousd,
            enabled = @enabled,
            updated_at = @at
        WHERE provider = 'openai'
      `),
      getCloudUsageTotals: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_microusd ELSE 0 END), 0) AS spent,
          COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_microusd ELSE 0 END), 0) AS reserved,
          COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count
        FROM cloud_usage
        WHERE provider = 'openai' AND month_utc = ?
      `),
      insertCloudUsage: this.db.prepare(`
        INSERT INTO cloud_usage (
          id, month_utc, provider, model, audio_ms, input_tokens, output_tokens,
          price_version, reserved_microusd, actual_microusd, status, created_at, settled_at
        ) VALUES (
          @id, @monthUtc, 'openai', @model, @audioMs, 0, 0,
          @priceVersion, @reservedMicrousd, 0, 'reserved', @createdAt, NULL
        )
      `),
      getCloudUsage: this.db.prepare("SELECT * FROM cloud_usage WHERE id = ?"),
      settleCloudUsage: this.db.prepare(`
        UPDATE cloud_usage
        SET input_tokens = @inputTokens,
            output_tokens = @outputTokens,
            actual_microusd = @actualMicrousd,
            reserved_microusd = 0,
            status = 'settled',
            settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      releaseCloudUsage: this.db.prepare(`
        UPDATE cloud_usage
        SET reserved_microusd = 0, status = 'released', settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      markCloudUsageUnknown: this.db.prepare(`
        UPDATE cloud_usage
        SET reserved_microusd = 0, status = 'unknown', settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      findSegmentForRevision: this.db.prepare(`
        SELECT person_id, speaker_label
        FROM transcript_segments
        WHERE session_id = @sessionId AND started_at = @startedAt AND text = @originalText
        ORDER BY id ASC
        LIMIT 1
      `),
      insertTranscriptRevision: this.db.prepare(`
        INSERT INTO transcript_revisions (
          id, session_id, started_at, audio_source, person_id, speaker_label,
          original_text, current_text, source, confidence, reason, corrected_at
        ) VALUES (
          @id, @sessionId, @startedAt, @audioSource, @personId, @speakerLabel,
          @originalText, @currentText, 'openai_correction', @confidence, @reason, @correctedAt
        )
      `),
      getTranscriptRevision: this.db.prepare("SELECT * FROM transcript_revisions WHERE id = ?"),
    };

    const writeTranscriptSegments = (sessionId, segments) => {
      for (const segment of segments) {
        const segmentId = assertId(segment.id, "segmentId");
        const existing = this.statements.getSegmentSession.get(segmentId);
        if (existing && existing.session_id !== sessionId) {
          throw new Error(SEGMENT_SESSION_MISMATCH_MESSAGE);
        }

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
          id: segmentId,
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
    };

    this._upsertTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
    });

    this._syncTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
      if (segments.length === 0) {
        this.db.prepare("DELETE FROM transcript_segments WHERE session_id = ?").run(sessionId);
        return;
      }
      const placeholders = segments.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM transcript_segments WHERE session_id = ? AND id NOT IN (${placeholders})`
        )
        .run(sessionId, ...segments.map((segment) => segment.id));
    });

    this._renamePerson = this.db.transaction((input) => {
      if (input.isSelf) this.statements.clearSelf.run();
      this.statements.renamePerson.run(input);
    });

    this._recoverOpenSessions = this.db.transaction((at) => {
      const openSessions = this.statements.listOpenSessions.all();
      for (const session of openSessions) {
        const sources = this.statements.listSessionTracksForRecovery
          .all(session.id)
          .map((track) => ({ trackId: track.id, gapId: null }));
        this.captureEvidenceStore.finalizeCapture({
          sessionId: session.id,
          sources,
          trackState: "recovered",
          sessionStatus: "recovered",
          at,
        });
      }
      return openSessions.map((session) => this.statements.getSession.get(session.id));
    });

    this._backfillLegacyMicChunks = this.db.transaction(
      ({ sessionId, deterministicTrackId, chunkIds, createdAt }) => {
        const session = this.statements.getSession.get(sessionId);
        if (!session) throw new Error(`session ${sessionId} does not exist`);

        let track = this.statements.getSessionSourceTrack.get(sessionId, "mic");
        if (!track) {
          const lifecycle = legacyTrackLifecycle(session);
          this.statements.insertLegacyMicTrack.run({
            id: deterministicTrackId,
            sessionId,
            startedAt: session.started_at,
            endedAt: lifecycle.endedAt,
            state: lifecycle.state,
          });
          track = this.statements.getSessionSourceTrack.get(sessionId, "mic");
        }

        const chunks = chunkIds
          .map((id) => this.statements.getUntrackedAudioChunk.get(id, sessionId))
          .filter(Boolean)
          .filter((chunk) => chunk.source_type === "mic")
          .sort(
            (left, right) =>
              left.started_at - right.started_at ||
              left.ended_at - right.ended_at ||
              compareStableIds(left.id, right.id)
          );
        let sequenceNumber =
          this.statements.getLastTrackSequence.get(track.id).sequence_number + 1;
        let linked = 0;
        let jobsCreated = 0;
        for (const chunk of chunks) {
          const existingJobs = this.statements.listChunkJobsForLegacyLink.all(chunk.id);
          if (existingJobs.some((job) => job.session_id !== sessionId)) {
            throw new Error("processing job session does not match legacy chunk session");
          }
          const link = this.statements.linkLegacyAudioChunk.run({
            id: chunk.id,
            sessionId,
            trackId: track.id,
            sequenceNumber,
          });
          if (link.changes !== 1) continue;
          sequenceNumber += 1;
          linked += 1;
          this.statements.syncChunkJobTrack.run({ chunkId: chunk.id, trackId: track.id });
          const jobInput = { chunkId: chunk.id, inputHash: chunk.sha256 };
          if (!this.statements.getLegacyChunkTranscriptionJob.get(jobInput)) {
            this.statements.insertLegacyChunkTranscriptionJob.run({
              id: `job_${crypto.randomUUID().replaceAll("-", "")}`,
              sessionId,
              trackId: track.id,
              ...jobInput,
              createdAt,
            });
            jobsCreated += 1;
          }
        }
        return { linked, jobsCreated, trackId: track.id };
      }
    );

    this._reserveCloudUsage = this.db.transaction((input) => {
      const settings = this.statements.getCloudBudgetSettings.get();
      const totals = this.statements.getCloudUsageTotals.get(input.monthUtc);
      if (totals.unknown_count > 0) {
        return { ok: false, reason: "usage_unknown" };
      }
      if (!settings.enabled) {
        return { ok: false, reason: "cloud_disabled" };
      }
      if (
        totals.spent + totals.reserved + input.reservedMicrousd >
        settings.monthly_limit_microusd
      ) {
        return { ok: false, reason: "budget_protected" };
      }
      this.statements.insertCloudUsage.run(input);
      return { ok: true, reservationId: input.id };
    });
  }

  createSession({
    id,
    startedAt,
    micDeviceId,
    language = "zh",
    captureMode = "mic",
    retentionMode = RETENTION_MODES.SPEECH_TRIGGERED,
    capturePolicy,
  }) {
    const sessionId = assertId(id, "sessionId");
    assertInteger(startedAt, "startedAt");
    const mode = assertCaptureMode(captureMode);
    const safeRetentionMode = assertRetentionMode(retentionMode);
    const safeCapturePolicy = normalizeCapturePolicy(capturePolicy);
    if (micDeviceId !== null && micDeviceId !== undefined && typeof micDeviceId !== "string") {
      throw new TypeError("micDeviceId must be a string or null");
    }
    if (mode === "system" && micDeviceId !== null && micDeviceId !== undefined) {
      throw new TypeError("system capture cannot persist a microphone device id");
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
      captureMode: mode,
      retentionMode: safeRetentionMode,
      capturePolicyJson: JSON.stringify(safeCapturePolicy),
    });
    return this.getSession(sessionId);
  }

  setSessionRetention(id, retentionMode, capturePolicy) {
    const sessionId = assertId(id, "sessionId");
    const safeRetentionMode = assertRetentionMode(retentionMode);
    const safeCapturePolicy = normalizeCapturePolicy(capturePolicy);
    const result = this.statements.setSessionRetention.run({
      id: sessionId,
      retentionMode: safeRetentionMode,
      capturePolicyJson: JSON.stringify(safeCapturePolicy),
    });
    if (result.changes !== 1) throw new Error(`session ${sessionId} does not exist`);
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

  syncTranscriptSegments(sessionId, segments) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
    this._syncTranscriptSegments(safeSessionId, segments);
    return this.listTranscriptSegments(safeSessionId);
  }

  listTranscriptSegments(sessionId) {
    return this.statements.listSegments.all(assertId(sessionId, "sessionId"));
  }

  renamePerson(input) {
    if (!input || typeof input !== "object") throw new TypeError("person update is required");
    const safePersonId = assertId(input.personId, "personId");
    const existing = this.statements.getPerson.get(safePersonId) ?? null;
    const hasDisplayName = Object.prototype.hasOwnProperty.call(input, "displayName");
    const hasIsSelf = Object.prototype.hasOwnProperty.call(input, "isSelf");
    const hasVoiceProfileId = Object.prototype.hasOwnProperty.call(input, "voiceProfileId");

    const displayName = hasDisplayName ? normalizeSpeakerName(input.displayName) : null;
    if (!hasDisplayName && !existing) {
      throw new TypeError("displayName is required when creating a person");
    }
    if (hasIsSelf && typeof input.isSelf !== "boolean") {
      throw new TypeError("isSelf must be a boolean");
    }
    if (
      hasVoiceProfileId &&
      input.voiceProfileId !== null &&
      !Number.isSafeInteger(input.voiceProfileId)
    ) {
      throw new TypeError("voiceProfileId must be a safe integer or null");
    }

    const update = {
      personId: safePersonId,
      displayName: hasDisplayName ? displayName : existing.display_name,
      isSelf: hasIsSelf ? (input.isSelf ? 1 : 0) : (existing?.is_self ?? 0),
      voiceProfileId: hasVoiceProfileId
        ? (input.voiceProfileId ?? null)
        : (existing?.voice_profile_id ?? null),
      now: Date.now(),
    };
    this._renamePerson(update);
    return this.statements.getPerson.get(safePersonId);
  }

  listPeople() {
    return this.statements.listPeople.all();
  }

  applyAnalysisResult(input) {
    if (!input || typeof input !== "object") throw new TypeError("analysis input is required");
    const safe = {
      runId: assertId(input.runId, "analysisRunId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      kind: input.kind,
      inputHash: normalizeDerivedText(input.inputHash, "inputHash"),
      model: normalizeDerivedText(input.model, "model"),
      windowStart: assertInteger(input.windowStart, "windowStart"),
      windowEnd: assertInteger(input.windowEnd, "windowEnd"),
      completedAt: assertInteger(input.completedAt, "completedAt"),
      result: input.result,
    };
    if (safe.kind !== "incremental" && safe.kind !== "final") {
      throw new TypeError("analysis kind must be incremental or final");
    }
    if (!safe.result || typeof safe.result !== "object" || Array.isArray(safe.result)) {
      throw new TypeError("analysis result is required");
    }
    const summary = normalizeDerivedText(safe.result.summary, "summary");
    const arrays = {};
    for (const key of ["topics", "todos", "memories", "decisions", "suggestions"]) {
      if (!Array.isArray(safe.result[key])) throw new TypeError(`${key} must be an array`);
      if (safe.result[key].length > 100) throw new RangeError(`${key} has too many items`);
      arrays[key] = safe.result[key];
    }

    const transaction = this.db.transaction(() => {
      if (!this.getSession(safe.sessionId)) throw new Error("analysis session does not exist");
      const existingRun = this.db
        .prepare("SELECT * FROM analysis_runs WHERE session_id = ? AND kind = ? AND input_hash = ?")
        .get(safe.sessionId, safe.kind, safe.inputHash);
      if (existingRun?.status === "completed") return this.getSessionDetail(safe.sessionId);

      const allowedSegments = new Set(
        this.listTranscriptSegments(safe.sessionId).map((segment) => segment.id)
      );
      const evidenceFor = (item) => {
        if (!Array.isArray(item.evidenceSegmentIds) || item.evidenceSegmentIds.length === 0) {
          throw new TypeError("analysis item requires evidence segment ids");
        }
        const ids = item.evidenceSegmentIds.map((id) => assertId(id, "evidenceSegmentId"));
        for (const id of ids) {
          if (!allowedSegments.has(id)) throw new Error(`evidence segment ${id} is not in session`);
        }
        return [...new Set(ids)];
      };

      for (const topic of arrays.topics) {
        normalizeDerivedText(topic.title, "topic title");
        normalizeDerivedText(topic.description, "topic description");
        evidenceFor(topic);
      }
      for (const todo of arrays.todos) {
        normalizeDerivedText(todo.content, "todo content");
        evidenceFor(todo);
      }
      for (const memory of arrays.memories) {
        if (!["fact", "decision", "commitment", "opinion"].includes(memory.type)) {
          throw new TypeError("unsupported memory type");
        }
        normalizeDerivedText(memory.content, "memory content");
        if (
          typeof memory.confidence !== "number" ||
          !Number.isFinite(memory.confidence) ||
          memory.confidence < 0 ||
          memory.confidence > 1
        ) {
          throw new RangeError("memory confidence must be between 0 and 1");
        }
        evidenceFor(memory);
      }

      this.db
        .prepare(
          `
        INSERT INTO analysis_runs (
          id, session_id, kind, window_start, window_end, input_hash, model,
          status, attempt_count, response_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?)
        ON CONFLICT(session_id, kind, input_hash) DO UPDATE SET
          status = 'completed', response_json = excluded.response_json,
          completed_at = excluded.completed_at, error_code = NULL
      `
        )
        .run(
          safe.runId,
          safe.sessionId,
          safe.kind,
          safe.windowStart,
          safe.windowEnd,
          safe.inputHash,
          safe.model,
          JSON.stringify(safe.result),
          safe.completedAt,
          safe.completedAt
        );

      const persistedRun = this.db
        .prepare(
          "SELECT id FROM analysis_runs WHERE session_id = ? AND kind = ? AND input_hash = ?"
        )
        .get(safe.sessionId, safe.kind, safe.inputHash);
      const runId = persistedRun.id;

      this.db
        .prepare(
          `
        INSERT INTO session_summaries (
          session_id, summary, decisions_json, suggestions_json,
          analysis_run_id, updated_at, is_final
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary = excluded.summary,
          decisions_json = excluded.decisions_json,
          suggestions_json = excluded.suggestions_json,
          analysis_run_id = excluded.analysis_run_id,
          updated_at = excluded.updated_at,
          is_final = MAX(session_summaries.is_final, excluded.is_final)
      `
        )
        .run(
          safe.sessionId,
          summary,
          JSON.stringify(arrays.decisions),
          JSON.stringify(arrays.suggestions),
          runId,
          safe.completedAt,
          safe.kind === "final" ? 1 : 0
        );

      const topicIds = new Map();
      for (const topic of arrays.topics) {
        const title = normalizeDerivedText(topic.title, "topic title");
        const key = normalizedKey(title);
        const id = derivedId("topic", key);
        this.db
          .prepare(
            `
          INSERT INTO topics (
            id, canonical_title, normalized_title, description, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(normalized_title) DO UPDATE SET
            description = excluded.description, last_seen_at = excluded.last_seen_at
        `
          )
          .run(
            id,
            title,
            key,
            normalizeDerivedText(topic.description, "topic description"),
            safe.completedAt,
            safe.completedAt
          );
        const persistedTopic = this.db
          .prepare("SELECT id FROM topics WHERE normalized_title = ?")
          .get(key);
        topicIds.set(key, persistedTopic.id);
        this.db
          .prepare(
            `
          INSERT INTO session_topics (session_id, topic_id, analysis_run_id)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id, topic_id) DO UPDATE SET analysis_run_id = excluded.analysis_run_id
        `
          )
          .run(safe.sessionId, persistedTopic.id, runId);
      }

      const resolveTopicId = (title) => {
        if (typeof title !== "string" || !title.trim()) return null;
        const key = normalizedKey(title);
        if (topicIds.has(key)) return topicIds.get(key);
        return (
          this.db.prepare("SELECT id FROM topics WHERE normalized_title = ?").get(key)?.id ?? null
        );
      };
      const resolvePersonId = (personRef) => {
        if (typeof personRef !== "string" || !personRef) return null;
        return this.statements.getPerson.get(personRef)?.id ?? null;
      };

      for (const todo of arrays.todos) {
        const content = normalizeDerivedText(todo.content, "todo content");
        const ownerId = resolvePersonId(todo.ownerRef);
        const topicId = resolveTopicId(todo.topicRef);
        const evidence = evidenceFor(todo);
        let dueAt = null;
        if (todo.dueDate !== null && todo.dueDate !== undefined && todo.dueDate !== "") {
          if (typeof todo.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(todo.dueDate)) {
            throw new TypeError("todo dueDate must be YYYY-MM-DD or null");
          }
          dueAt = Date.parse(`${todo.dueDate}T00:00:00.000Z`);
          if (!Number.isSafeInteger(dueAt)) throw new TypeError("todo dueDate is invalid");
        }
        const key = normalizedKey(content);
        const id = derivedId("todo", safe.sessionId, key, ownerId ?? "", topicId ?? "");
        this.db
          .prepare(
            `
          INSERT INTO todos (
            id, content, normalized_content, owner_person_id, topic_id, due_at,
            created_at, updated_at, source_session_id, source_segment_id, analysis_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content, due_at = COALESCE(excluded.due_at, todos.due_at),
            updated_at = excluded.updated_at, analysis_run_id = excluded.analysis_run_id
        `
          )
          .run(
            id,
            content,
            key,
            ownerId,
            topicId,
            dueAt,
            safe.completedAt,
            safe.completedAt,
            safe.sessionId,
            evidence[0],
            runId
          );
      }

      for (const memory of arrays.memories) {
        const content = normalizeDerivedText(memory.content, "memory content");
        const personId = resolvePersonId(memory.personRef);
        const topicId = resolveTopicId(memory.topicRef);
        const key = normalizedKey(content);
        const id = derivedId("memory", memory.type, key, personId ?? "", topicId ?? "");
        this.db
          .prepare(
            `
          INSERT INTO memories (
            id, type, content, normalized_content, person_id, topic_id, confidence,
            first_seen_at, last_seen_at, needs_confirmation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence = MAX(memories.confidence, excluded.confidence),
            last_seen_at = excluded.last_seen_at,
            occurrence_count = memories.occurrence_count + 1,
            needs_confirmation = MIN(memories.needs_confirmation, excluded.needs_confirmation)
        `
          )
          .run(
            id,
            memory.type,
            content,
            key,
            personId,
            topicId,
            memory.confidence,
            safe.completedAt,
            safe.completedAt,
            memory.confidence < 0.7 ? 1 : 0
          );
        for (const segmentId of evidenceFor(memory)) {
          this.db
            .prepare(
              `
            INSERT OR IGNORE INTO memory_evidence (memory_id, segment_id, analysis_run_id)
            VALUES (?, ?, ?)
          `
            )
            .run(id, segmentId, runId);
        }
      }
      return this.getSessionDetail(safe.sessionId);
    });
    return transaction();
  }

  getSessionDetail(id) {
    const sessionId = assertId(id, "sessionId");
    const session = this.getSession(sessionId);
    if (!session) return null;
    const summary =
      this.db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(sessionId) ??
      null;
    return {
      session,
      summary,
      segments: this.listTranscriptSegments(sessionId),
      audioChunks: this.listAudioChunks(sessionId),
      topics: this.db
        .prepare(
          `
        SELECT t.* FROM topics t JOIN session_topics st ON st.topic_id = t.id
        WHERE st.session_id = ? ORDER BY t.last_seen_at DESC, t.canonical_title
      `
        )
        .all(sessionId),
      todos: this.db
        .prepare(
          `
        SELECT td.*, p.display_name AS owner_name, t.canonical_title AS topic_title
        FROM todos td LEFT JOIN people p ON p.id = td.owner_person_id
        LEFT JOIN topics t ON t.id = td.topic_id
        WHERE td.source_session_id = ? ORDER BY td.updated_at DESC
      `
        )
        .all(sessionId),
      memories: this.db
        .prepare(
          `
        SELECT DISTINCT m.*, p.display_name AS person_name, t.canonical_title AS topic_title
        FROM memories m JOIN memory_evidence me ON me.memory_id = m.id
        JOIN transcript_segments ts ON ts.id = me.segment_id
        LEFT JOIN people p ON p.id = m.person_id LEFT JOIN topics t ON t.id = m.topic_id
        WHERE ts.session_id = ? ORDER BY m.last_seen_at DESC
      `
        )
        .all(sessionId),
    };
  }

  listPeopleOverview() {
    return this.db
      .prepare(
        `
      SELECT p.*,
        COUNT(DISTINCT ts.session_id) AS session_count,
        COUNT(DISTINCT CASE WHEN td.status = 'open' THEN td.id END) AS open_todo_count,
        MAX(ts.ended_at) AS last_interaction_at
      FROM people p
      LEFT JOIN transcript_segments ts ON ts.person_id = p.id
      LEFT JOIN todos td ON td.owner_person_id = p.id
      GROUP BY p.id
      ORDER BY p.is_self DESC, COALESCE(last_interaction_at, p.last_seen_at) DESC, p.display_name
    `
      )
      .all();
  }

  getPersonDetail(id) {
    const personId = assertId(id, "personId");
    const person = this.db.prepare("SELECT * FROM people WHERE id = ?").get(personId);
    if (!person) return null;
    return {
      person,
      sessions: this.db
        .prepare(
          `
        SELECT DISTINCT s.* FROM sessions s JOIN transcript_segments ts ON ts.session_id = s.id
        WHERE ts.person_id = ? ORDER BY s.started_at DESC
      `
        )
        .all(personId),
      todos: this.db
        .prepare("SELECT * FROM todos WHERE owner_person_id = ? ORDER BY updated_at DESC")
        .all(personId),
      memories: this.db
        .prepare("SELECT * FROM memories WHERE person_id = ? ORDER BY last_seen_at DESC")
        .all(personId),
      topics: this.db
        .prepare(
          `
        SELECT DISTINCT t.* FROM topics t JOIN session_topics st ON st.topic_id = t.id
        JOIN transcript_segments ts ON ts.session_id = st.session_id
        WHERE ts.person_id = ? ORDER BY t.last_seen_at DESC
      `
        )
        .all(personId),
    };
  }

  listTopics() {
    return this.db
      .prepare(
        `
      SELECT t.*, COUNT(DISTINCT st.session_id) AS session_count,
        COUNT(DISTINCT CASE WHEN td.status = 'open' THEN td.id END) AS open_todo_count
      FROM topics t LEFT JOIN session_topics st ON st.topic_id = t.id
      LEFT JOIN todos td ON td.topic_id = t.id
      GROUP BY t.id ORDER BY t.last_seen_at DESC, t.canonical_title
    `
      )
      .all();
  }

  getTopicDetail(id) {
    const topicId = assertId(id, "topicId");
    const topic = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
    if (!topic) return null;
    return {
      topic,
      sessions: this.db
        .prepare(
          `SELECT s.* FROM sessions s JOIN session_topics st ON st.session_id=s.id WHERE st.topic_id=? ORDER BY s.started_at DESC`
        )
        .all(topicId),
      todos: this.db
        .prepare("SELECT * FROM todos WHERE topic_id = ? ORDER BY updated_at DESC")
        .all(topicId),
      memories: this.db
        .prepare("SELECT * FROM memories WHERE topic_id = ? ORDER BY last_seen_at DESC")
        .all(topicId),
    };
  }

  renameTopic(id, title, at = Date.now()) {
    const topicId = assertId(id, "topicId");
    const canonical = normalizeDerivedText(title, "topic title");
    this.db
      .prepare(`UPDATE topics SET canonical_title=?, normalized_title=?, last_seen_at=? WHERE id=?`)
      .run(canonical, normalizedKey(canonical), assertInteger(at, "at"), topicId);
    return this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) ?? null;
  }

  listTodos(status = null) {
    if (status !== null && status !== "open" && status !== "completed")
      throw new TypeError("invalid todo status");
    return this.db
      .prepare(
        `
      SELECT td.*, p.display_name AS owner_name, t.canonical_title AS topic_title
      FROM todos td LEFT JOIN people p ON p.id=td.owner_person_id
      LEFT JOIN topics t ON t.id=td.topic_id
      WHERE (? IS NULL OR td.status = ?)
      ORDER BY CASE td.status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(td.due_at, 9223372036854775807), td.updated_at DESC
    `
      )
      .all(status, status);
  }

  setTodoStatus(id, status, at = Date.now()) {
    const todoId = assertId(id, "todoId");
    if (status !== "open" && status !== "completed") throw new TypeError("invalid todo status");
    const when = assertInteger(at, "at");
    this.db
      .prepare(`UPDATE todos SET status=?, updated_at=?, completed_at=? WHERE id=?`)
      .run(status, when, status === "completed" ? when : null, todoId);
    return this.db.prepare("SELECT * FROM todos WHERE id = ?").get(todoId) ?? null;
  }

  listMemories(limit = 200) {
    assertInteger(limit, "limit");
    return this.db
      .prepare(
        `
      SELECT m.*, p.display_name AS person_name, t.canonical_title AS topic_title
      FROM memories m LEFT JOIN people p ON p.id=m.person_id LEFT JOIN topics t ON t.id=m.topic_id
      ORDER BY m.last_seen_at DESC LIMIT ?
    `
      )
      .all(limit);
  }

  searchMemory(query, limit = 100) {
    const term = normalizeDerivedText(query, "query");
    assertInteger(limit, "limit");
    if (limit < 1 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db
      .prepare(
        `
      SELECT DISTINCT s.* FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id=s.id
      WHERE ss.summary LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.session_id=s.id AND ts.text LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM session_topics st JOIN topics t ON t.id=st.topic_id WHERE st.session_id=s.id AND (t.canonical_title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM transcript_segments ts JOIN people p ON p.id=ts.person_id WHERE ts.session_id=s.id AND p.display_name LIKE ? ESCAPE '\\')
      ORDER BY s.started_at DESC LIMIT ?
    `
      )
      .all(like, like, like, like, like, limit);
  }

  getTodayInsights(sessionId) {
    const detail = this.getSessionDetail(sessionId);
    if (!detail) return null;
    return {
      summary: detail.summary,
      topics: detail.topics,
      todos: detail.todos,
      memories: detail.memories,
    };
  }

  getCloudBudgetSettings() {
    return this.statements.getCloudBudgetSettings.get();
  }

  setCloudBudgetSettings({ enabled, monthlyLimitMicrousd, at = Date.now() }) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    assertInteger(monthlyLimitMicrousd, "monthlyLimitMicrousd");
    if (
      monthlyLimitMicrousd < MIN_CLOUD_LIMIT_MICROUSD ||
      monthlyLimitMicrousd > MAX_CLOUD_LIMIT_MICROUSD
    ) {
      throw new RangeError("monthlyLimitMicrousd must be between 5000000 and 10000000");
    }
    assertInteger(at, "at");
    this.statements.setCloudBudgetSettings.run({
      enabled: enabled ? 1 : 0,
      monthlyLimitMicrousd,
      at,
    });
    return this.getCloudBudgetSettings();
  }

  getCloudBudgetStatus(at = Date.now()) {
    const monthUtc = monthUtcFromTimestamp(at);
    const settings = this.getCloudBudgetSettings();
    const totals = this.statements.getCloudUsageTotals.get(monthUtc);
    const remaining = Math.max(0, settings.monthly_limit_microusd - totals.spent - totals.reserved);
    let blockedReason = null;
    if (totals.unknown_count > 0) blockedReason = "usage_unknown";
    else if (!settings.enabled) blockedReason = "cloud_disabled";
    else if (remaining < CLOUD_RESERVATION_MICROUSD) blockedReason = "budget_protected";
    return {
      monthUtc,
      enabled: settings.enabled === 1,
      monthlyLimitMicrousd: settings.monthly_limit_microusd,
      spentMicrousd: totals.spent,
      reservedMicrousd: totals.reserved,
      remainingMicrousd: remaining,
      blockedReason,
    };
  }

  reserveCloudUsage(input) {
    const safe = {
      id: assertId(input.id, "cloudUsageId"),
      monthUtc: assertMonthUtc(input.monthUtc),
      model: input.model,
      audioMs: assertNonNegativeInteger(input.audioMs, "audioMs"),
      reservedMicrousd: assertNonNegativeInteger(input.reservedMicrousd, "reservedMicrousd"),
      priceVersion: input.priceVersion,
      createdAt: assertInteger(input.createdAt, "createdAt"),
    };
    if (typeof safe.model !== "string" || !safe.model) throw new TypeError("model is required");
    if (typeof safe.priceVersion !== "string" || !safe.priceVersion) {
      throw new TypeError("priceVersion is required");
    }
    return this._reserveCloudUsage(safe);
  }

  settleCloudUsage({ id, inputTokens, outputTokens, actualMicrousd, settledAt = Date.now() }) {
    const safe = {
      id: assertId(id, "cloudUsageId"),
      inputTokens: assertNonNegativeInteger(inputTokens, "inputTokens"),
      outputTokens: assertNonNegativeInteger(outputTokens, "outputTokens"),
      actualMicrousd: assertNonNegativeInteger(actualMicrousd, "actualMicrousd"),
      settledAt: assertInteger(settledAt, "settledAt"),
    };
    if (safe.actualMicrousd > CLOUD_RESERVATION_MICROUSD) {
      throw new RangeError("actualMicrousd exceeds the reserved request maximum");
    }
    this.statements.settleCloudUsage.run(safe);
    return this.statements.getCloudUsage.get(safe.id) ?? null;
  }

  releaseCloudUsage({ id, settledAt = Date.now() }) {
    const safeId = assertId(id, "cloudUsageId");
    this.statements.releaseCloudUsage.run({
      id: safeId,
      settledAt: assertInteger(settledAt, "settledAt"),
    });
    return this.statements.getCloudUsage.get(safeId) ?? null;
  }

  markCloudUsageUnknown({ id, settledAt = Date.now() }) {
    const safeId = assertId(id, "cloudUsageId");
    this.statements.markCloudUsageUnknown.run({
      id: safeId,
      settledAt: assertInteger(settledAt, "settledAt"),
    });
    return this.statements.getCloudUsage.get(safeId) ?? null;
  }

  addTranscriptRevision(input) {
    const safe = {
      id: assertId(input.id, "revisionId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      startedAt: assertInteger(input.startedAt, "startedAt"),
      audioSource: input.source,
      originalText: input.originalText,
      currentText: input.currentText,
      confidence: input.confidence,
      reason: input.reason,
      correctedAt: assertInteger(input.correctedAt, "correctedAt"),
    };
    if (safe.audioSource !== "mic" && safe.audioSource !== "system") {
      throw new TypeError("source must be mic or system");
    }
    for (const [name, value] of [
      ["originalText", safe.originalText],
      ["currentText", safe.currentText],
      ["reason", safe.reason],
    ]) {
      if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
    }
    if (
      typeof safe.confidence !== "number" ||
      !Number.isFinite(safe.confidence) ||
      safe.confidence < 0 ||
      safe.confidence > 1
    ) {
      throw new RangeError("confidence must be between 0 and 1");
    }
    const segment = this.statements.findSegmentForRevision.get(safe);
    if (!segment) return null;
    this.statements.insertTranscriptRevision.run({
      ...safe,
      personId: segment.person_id,
      speakerLabel: segment.speaker_label,
    });
    return this.statements.getTranscriptRevision.get(safe.id);
  }

  createTrack(track) {
    return this.captureEvidenceStore.createTrack(track);
  }

  createTracks(tracks) {
    return this.captureEvidenceStore.createTracks(tracks);
  }

  setTrackState(id, state, endedAt) {
    return this.captureEvidenceStore.setTrackState(id, state, endedAt);
  }

  openGap(gap) {
    return this.captureEvidenceStore.openGap(gap);
  }

  recordEvidenceGap(gap) {
    return this.captureEvidenceStore.recordEvidenceGap(gap);
  }

  interruptTrack(input) {
    return this.captureEvidenceStore.interruptTrack(input);
  }

  closeGap(id, endedAt, recoveryAttempts) {
    return this.captureEvidenceStore.closeGap(id, endedAt, recoveryAttempts);
  }

  restoreTrack(input) {
    return this.captureEvidenceStore.restoreTrack(input);
  }

  pauseCapture(input) {
    return this.captureEvidenceStore.pauseCapture(input);
  }

  resumeCapture(input) {
    return this.captureEvidenceStore.resumeCapture(input);
  }

  finalizeCapture(input) {
    return this.captureEvidenceStore.finalizeCapture(input);
  }

  commitChunk(chunk) {
    return this.captureEvidenceStore.commitChunk(chunk);
  }

  tombstoneChunk(id, deletedAt = Date.now()) {
    return this.captureEvidenceStore.tombstoneChunk(
      assertId(id, "audioChunkId"),
      assertInteger(deletedAt, "deletedAt")
    );
  }

  promoteSoonExpiringAudioJobs(after, before) {
    return this.captureEvidenceStore.promoteSoonExpiringAudioJobs(
      assertInteger(after, "after"),
      assertInteger(before, "before")
    );
  }

  enqueueChunkTranscription(chunk) {
    return this.captureEvidenceStore.enqueueChunkTranscription(chunk);
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
    return toPublicAudioChunk(this.statements.getAudioChunk.get(input.id));
  }

  listAudioChunks(sessionId) {
    return this.statements.listAudioChunks
      .all(assertId(sessionId, "sessionId"))
      .map(toPublicAudioChunk);
  }

  listUntrackedAudioChunks(sessionId) {
    return this.statements.listUntrackedAudioChunks
      .all(assertId(sessionId, "sessionId"))
      .map(toPublicAudioChunk);
  }

  backfillLegacyMicChunks({ sessionId, deterministicTrackId, chunkIds, createdAt = Date.now() }) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(deterministicTrackId, "deterministicTrackId");
    if (!Array.isArray(chunkIds)) throw new TypeError("chunkIds must be an array");
    const safeChunkIds = [...new Set(chunkIds.map((id) => assertId(id, "audioChunkId")))];
    return this._backfillLegacyMicChunks({
      sessionId: safeSessionId,
      deterministicTrackId: safeTrackId,
      chunkIds: safeChunkIds,
      createdAt: assertInteger(createdAt, "createdAt"),
    });
  }

  getAudioChunk(id) {
    const row = this.statements.getAudioChunk.get(assertId(id, "audioChunkId"));
    return row ? toPublicAudioChunk(row) : null;
  }

  listExpiredAudioChunks(now = Date.now()) {
    return this.statements.listExpiredAudioChunks
      .all(assertInteger(now, "now"))
      .map(toPublicAudioChunk);
  }

  recoverOpenSessions(at = Date.now()) {
    return this._recoverOpenSessions(assertInteger(at, "at"));
  }

  close() {
    if (this.db.open) this.db.close();
  }
}

module.exports = JarvisRepository;
