const Database = require("better-sqlite3");
const { assertId, assertSessionStatus } = require("../shared/contracts");

const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const SEGMENT_SESSION_MISMATCH_MESSAGE = "segment belongs to a different session";
const MAX_SPEAKER_NAME_CODE_POINTS = 80;
const DEFAULT_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MIN_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MAX_CLOUD_LIMIT_MICROUSD = 10_000_000;
const CLOUD_RESERVATION_MICROUSD = 100_000;

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
  INSERT OR IGNORE INTO cloud_budget_settings (
    provider, monthly_limit_microusd, enabled, updated_at
  ) VALUES ('openai', 5000000, 0, 0);
  CREATE INDEX IF NOT EXISTS idx_segments_session_time
    ON transcript_segments(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_audio_expiry ON audio_chunks(expires_at);
  CREATE INDEX IF NOT EXISTS idx_cloud_usage_month ON cloud_usage(month_utc, provider, status);
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
        WHERE expires_at <= ?
        ORDER BY expires_at ASC, id ASC
      `),
      deleteAudioChunk: this.db.prepare("DELETE FROM audio_chunks WHERE id = ?"),
      listOpenSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('recording', 'paused', 'finalizing')
        ORDER BY started_at ASC, id ASC
      `),
      recoverOpenSessions: this.db.prepare(`
        UPDATE sessions
        SET status = 'recovered', ended_at = @at
        WHERE status IN ('recording', 'paused', 'finalizing')
      `),
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
      this.statements.recoverOpenSessions.run({ at });
      return openSessions.map((session) => this.statements.getSession.get(session.id));
    });

    this._reserveCloudUsage = this.db.transaction((input) => {
      const settings = this.statements.getCloudBudgetSettings.get();
      const totals = this.statements.getCloudUsageTotals.get(input.monthUtc);
      if (totals.unknown_count > 0) {
        return { ok: false, reason: "usage_unknown" };
      }
      if (!settings.enabled) {
        return { ok: false, reason: "cloud_disabled" };
      }
      if (totals.spent + totals.reserved + input.reservedMicrousd > settings.monthly_limit_microusd) {
        return { ok: false, reason: "budget_protected" };
      }
      this.statements.insertCloudUsage.run(input);
      return { ok: true, reservationId: input.id };
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
    const remaining = Math.max(
      0,
      settings.monthly_limit_microusd - totals.spent - totals.reserved
    );
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
      reservedMicrousd: assertNonNegativeInteger(
        input.reservedMicrousd,
        "reservedMicrousd"
      ),
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
    return this._recoverOpenSessions(assertInteger(at, "at"));
  }

  close() {
    if (this.db.open) this.db.close();
  }
}

module.exports = JarvisRepository;
