const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const path = require("node:path");
const { assertCaptureMode, assertId, assertSessionStatus } = require("../shared/contracts");
const {
  RETENTION_MODES,
  assertRetentionMode,
  normalizeCapturePolicy,
} = require("../shared/captureModes");
const CaptureEvidenceStore = require("./CaptureEvidenceStore");
const SpeakerIdentityRepository = require("./SpeakerIdentityRepository");
const {
  applyJarvisMigrations,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
} = require("./JarvisMigrations");
const { toPublicAudioChunk } = require("./AudioChunkPublicView");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("./SessionDiarizationPolicy");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
  buildIdentityResolutionJobKey,
} = require("./SpeakerIdentityResolutionPolicy");

const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const SEGMENT_SESSION_MISMATCH_MESSAGE = "segment belongs to a different session";
const MAX_SPEAKER_NAME_CODE_POINTS = 80;
const DEFAULT_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MIN_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MAX_CLOUD_LIMIT_MICROUSD = 10_000_000;
const CLOUD_RESERVATION_MICROUSD = 100_000;
const TRANSCRIPT_PROMPT_CODE_POINT_LIMIT = 1_024;
const TRANSCRIPT_CONTEXT_CODE_POINT_LIMIT = 800;
const STABLE_CLUSTER_REUSE_THRESHOLD = 0.82;
const STABLE_CLUSTER_REUSE_MARGIN = 0.05;
const LEGACY_TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  recording: "active",
  finalizing: "active",
  paused: "paused",
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});

function runtimeJobStage({ job_type: jobType, state, priority }) {
  if (state === "retention_urgent" || (jobType === "transcribe_chunk" && priority === 0)) {
    return "retention_urgent";
  }
  if (state === "storage_recovery_compress" || (jobType === "compress_chunk" && priority === 10)) {
    return "storage_recovery_compress";
  }
  if (jobType === "transcribe_chunk") return "final_transcription";
  if (jobType === "preview_transcription") return "preview";
  if (["speaker", "diarize_track", "resolve_identities"].includes(jobType)) return "speaker";
  if (jobType === "analyze_session") return "analysis";
  if (jobType === "compress_chunk") return "compression";
  return jobType;
}

function runtimeQueueState(state) {
  if (state === "running" || state === "retry" || state === "blocked") return state;
  return "pending";
}

function emptyRuntimeCounts() {
  return { pending: 0, running: 0, retry: 0, blocked: 0, total: 0 };
}

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

function l2NormalizeEmbedding(embedding) {
  let squaredNorm = 0;
  for (const value of embedding) {
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= Number.EPSILON) return null;
  const norm = Math.sqrt(squaredNorm);
  return Float64Array.from(embedding, (value) => value / norm);
}

function cosineSimilarity(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

function hasStableReuseMargin(rankedPairs) {
  return (
    rankedPairs.length === 1 ||
    rankedPairs[0].score - rankedPairs[1].score >= STABLE_CLUSTER_REUSE_MARGIN
  );
}

function coveredDurationMs(rows, groupColumn) {
  let total = 0;
  let group = null;
  let rangeStart = null;
  let rangeEnd = null;
  const flush = () => {
    if (rangeStart !== null && rangeEnd !== null) total += Math.max(0, rangeEnd - rangeStart);
  };
  for (const row of rows) {
    const nextGroup = row[groupColumn];
    const startedAt = Number(row.started_at);
    const endedAt = Number(row.ended_at);
    if (nextGroup !== group) {
      flush();
      group = nextGroup;
      rangeStart = startedAt;
      rangeEnd = endedAt;
      continue;
    }
    if (startedAt > rangeEnd) {
      flush();
      rangeStart = startedAt;
      rangeEnd = endedAt;
    } else {
      rangeEnd = Math.max(rangeEnd, endedAt);
    }
  }
  flush();
  return total;
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
  ${transcriptSegmentsSchema("transcript_segments", { ifNotExists: true })}
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
  ${TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS}
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

function takeCodePointTail(value, limit) {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join("");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function encodeDiarizationEmbedding(value) {
  if (!(value instanceof Float32Array) || value.length !== 512) {
    throw new TypeError("diarization embedding must be a 512D Float32Array");
  }
  return SpeakerIdentityRepository.encodeEmbedding(value);
}

function assertOptionalUnitScore(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1 or null`);
  }
  return value;
}

function assertDiarizationModelId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.+:-]{1,200}$/.test(value)) {
    throw new TypeError(`${name} must be a versioned model identifier`);
  }
  return value;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class JarvisRepository {
  constructor(dbPath) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("dbPath must be a non-empty string");
    }

    this.dbPath = dbPath;
    this._open(dbPath);
  }

  _open(dbPath) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("foreign_keys = ON");
      if (dbPath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
      }
      // Evidence migrations are independently transactional and may need to suspend
      // FK enforcement before their transaction for SQLite's documented table-rebuild
      // procedure. Keep repository-only schema initialization atomic in its own step.
      applyJarvisMigrations(this.db);
      this.db.transaction(() => this.db.exec(SCHEMA))();
      this._prepareStatements();
      this.captureEvidenceStore = new CaptureEvidenceStore(this.db, {
        createId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
      });
      this.speakerIdentityRepository = new SpeakerIdentityRepository(this.db, {
        createId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  reopen(dbPath = this.dbPath) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("dbPath must be a non-empty string");
    }
    if (this.db?.open) this.db.close();
    this.dbPath = dbPath;
    this._open(dbPath);
    return this;
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
      getSessionContinuation: this.db.prepare(`
        SELECT source_session_id, destination_session_id, reason, boundary_at,
               destination_local_date
        FROM session_continuations
        WHERE source_session_id = @sourceSessionId
          AND destination_local_date = @destinationLocalDate
      `),
      insertSessionContinuation: this.db.prepare(`
        INSERT OR IGNORE INTO session_continuations (
          source_session_id, destination_session_id, reason, boundary_at,
          destination_local_date
        ) VALUES (
          @sourceSessionId, @destinationSessionId, 'local_midnight', @boundaryAt,
          @destinationLocalDate
        )
      `),
      listSessionContinuations: this.db.prepare(`
        SELECT source_session_id, destination_session_id, reason, boundary_at,
               destination_local_date
        FROM session_continuations
        WHERE source_session_id = ?
        ORDER BY boundary_at, destination_session_id
      `),
      listRotationTracks: this.db.prepare(
        "SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY source_type"
      ),
      listRotationGaps: this.db.prepare(`
        SELECT gap.* FROM audio_gaps AS gap
        JOIN audio_tracks AS track ON track.id = gap.track_id
        WHERE track.session_id = ? AND gap.ended_at IS NULL
        ORDER BY gap.track_id, gap.id
      `),
      deleteRotationDestination: this.db.prepare("DELETE FROM sessions WHERE id = ?"),
      restoreRotationSession: this.db.prepare(`
        UPDATE sessions SET
          status = @status,
          ended_at = @ended_at,
          stop_reason = @stop_reason,
          durable_boundary_at = @durable_boundary_at,
          processing_state = @processing_state,
          finalized_at = @finalized_at,
          ready_at = @ready_at,
          timeline_version = @timeline_version
        WHERE id = @id
      `),
      restoreRotationTrack: this.db.prepare(`
        UPDATE audio_tracks SET state = @state, ended_at = @ended_at WHERE id = @id
      `),
      restoreRotationGap: this.db.prepare(`
        UPDATE audio_gaps SET
          ended_at = @ended_at,
          recovery_attempts = @recovery_attempts,
          restored_device_id = @restored_device_id,
          restored_device_label = @restored_device_label,
          restored_strategy = @restored_strategy
        WHERE id = @id
      `),
      listSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE started_at >= @from AND started_at <= @to
        ORDER BY started_at DESC, id DESC
        LIMIT @limit
      `),
      listProcessingSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('completed', 'recovered')
          AND ended_at IS NOT NULL
          AND (
            @afterSortAt IS NULL
            OR COALESCE(finalized_at, ended_at) > @afterSortAt
            OR (
              COALESCE(finalized_at, ended_at) = @afterSortAt
              AND id > @afterId
            )
          )
          AND (
            processing_state <> 'ready'
            OR EXISTS (
              SELECT 1 FROM audio_chunks AS chunk
              WHERE chunk.session_id = sessions.id
                AND chunk.write_state = 'committed'
                AND chunk.deleted_at IS NULL
                AND (
                  chunk.track_id IS NULL
                  OR chunk.transcription_status NOT IN ('completed', 'no_speech')
                  OR NOT EXISTS (
                    SELECT 1 FROM audio_tracks AS track
                    WHERE track.id = chunk.track_id
                      AND track.session_id = chunk.session_id
                      AND track.source_type = chunk.source_type
                  )
                  OR NOT EXISTS (
                    SELECT 1 FROM processing_jobs AS job
                    WHERE job.chunk_id = chunk.id
                      AND job.job_type = 'transcribe_chunk'
                      AND job.state = 'completed'
                  )
                  OR EXISTS (
                    SELECT 1 FROM processing_jobs AS job
                    WHERE job.chunk_id = chunk.id
                      AND job.job_type = 'transcribe_chunk'
                      AND job.state <> 'completed'
                  )
                  OR (
                    chunk.transcription_status = 'completed'
                    AND NOT EXISTS (
                      SELECT 1 FROM transcript_segments AS segment
                      WHERE segment.chunk_id = chunk.id
                        AND segment.result_kind = 'final'
                        AND segment.started_at <= chunk.started_at
                        AND segment.ended_at >= chunk.ended_at
                    )
                  )
                )
            )
          )
        ORDER BY COALESCE(finalized_at, ended_at) ASC, id ASC
        LIMIT @limit
      `),
      listPendingJobs: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE session_id = ? AND state <> 'completed'
        ORDER BY created_at ASC, id ASC
      `),
      listSessionReadinessTracks: this.db.prepare(`
        SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY source_type, id
      `),
      listSessionReadinessChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND write_state = 'committed' AND deleted_at IS NULL
        ORDER BY track_id, sequence_number, started_at, id
      `),
      listSessionTranscriptionJobs: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE session_id = ? AND job_type = 'transcribe_chunk'
        ORDER BY created_at, id
      `),
      listSessionFinalCoverage: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ? AND result_kind = 'final'
        ORDER BY started_at, id
      `),
      getDiarizationTrack: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE id = @trackId AND session_id = @sessionId
      `),
      listDiarizationChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = @sessionId
          AND track_id = @trackId
        ORDER BY sequence_number, id
      `),
      getLatestChunkTranscriptionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE chunk_id = ? AND job_type = 'transcribe_chunk'
        ORDER BY input_version DESC, created_at DESC, id DESC
        LIMIT 1
      `),
      listDiarizationSegments: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE chunk_id = ?
        ORDER BY started_at, ended_at, id
      `),
      getDiarizationRun: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND transcript_revision = @transcriptRevision
          AND policy_id = @policyId
      `),
      listDiarizationRuns: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = ?
        ORDER BY commit_sequence
      `),
      listDiarizationEchoCandidates: this.db.prepare(`
        SELECT turn.*
        FROM speaker_turns AS turn
        JOIN speaker_diarization_runs AS run ON run.id = turn.run_id
        WHERE run.session_id = @sessionId
          AND run.track_id <> @excludeTrackId
          AND run.policy_id = @policyId
          AND turn.embedding IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM speaker_diarization_runs AS newer
            WHERE newer.session_id = run.session_id
              AND newer.track_id = run.track_id
              AND newer.policy_id = run.policy_id
              AND newer.commit_sequence > run.commit_sequence
          )
        ORDER BY turn.started_at, turn.ended_at, turn.id
      `),
      insertDiarizationRun: this.db.prepare(`
        INSERT INTO speaker_diarization_runs (
          id, session_id, track_id, transcript_revision, policy_id,
          diarizer_model_id, embedding_model_id, model_artifact_sha256,
          embedding_dimension, sample_rate, input_version, execution_device, commit_sequence,
          created_at, completed_at
        ) VALUES (
          @id, @sessionId, @trackId, @transcriptRevision, @policyId,
          @diarizerModelId, @embeddingModelId, @modelArtifactSha256,
          @embeddingDimension, @sampleRate, @inputVersion, @executionDevice, @commitSequence,
          @createdAt, @completedAt
        )
      `),
      nextDiarizationCommitSequence: this.db.prepare(`
        SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value
        FROM speaker_diarization_runs
      `),
      insertDiarizationJob: this.db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, NULL, 'diarize_track', 'pending', 40,
          @inputHash, @inputVersion, @modelVersion, @createdAt
        )
      `),
      getDiarizationJobByIdentity: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
      `),
      insertDiarizationStableCluster: this.db.prepare(`
        INSERT INTO speaker_clusters (
          id, session_id, track_id, local_label, model_id, embedding,
          speech_ms, window_count, quality_score, link_state, created_at, updated_at
        ) VALUES (
          @id, @sessionId, @trackId, @localLabel, @modelId, @embedding,
          @speechMs, @windowCount, @qualityScore, 'unknown', @at, @at
        )
      `),
      getDiarizationStableCluster: this.db.prepare(`
        SELECT * FROM speaker_clusters
        WHERE session_id = @sessionId AND track_id = @trackId AND local_label = @localLabel
      `),
      listDiarizationStableClusters: this.db.prepare(`
        SELECT * FROM speaker_clusters
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND model_id = @modelId
        ORDER BY created_at, id
      `),
      promoteDiarizationStableCluster: this.db.prepare(`
        UPDATE speaker_clusters
        SET embedding = @embedding, speech_ms = @speechMs,
            window_count = @windowCount, quality_score = @qualityScore,
            updated_at = @at
        WHERE id = @id AND embedding IS NULL AND @embedding IS NOT NULL
      `),
      insertDiarizationRunCluster: this.db.prepare(`
        INSERT INTO speaker_diarization_run_clusters (
          run_id, cluster_id, local_label, embedding, speech_ms,
          window_count, quality_score, first_appearance_at
        ) VALUES (
          @runId, @clusterId, @localLabel, @embedding, @speechMs,
          @windowCount, @qualityScore, @firstAppearanceAt
        )
      `),
      insertSpeakerTurn: this.db.prepare(`
        INSERT INTO speaker_turns (
          id, run_id, cluster_id, chunk_id, transcript_segment_id,
          turn_index, raw_label, started_at, ended_at, embedding,
          echo_state, duplicate_of_turn_id, excluded_from_centroid, created_at
        ) VALUES (
          @id, @runId, @clusterId, @chunkId, @transcriptSegmentId,
          @turnIndex, @rawLabel, @startedAt, @endedAt, @embedding,
          @echoState, @duplicateOfTurnId, @excludedFromCentroid, @createdAt
        )
      `),
      insertDiarizationSegmentLink: this.db.prepare(`
        INSERT OR IGNORE INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
        VALUES (@clusterId, @transcriptSegmentId)
      `),
      insertDiarizationRunSegmentLink: this.db.prepare(`
        INSERT INTO speaker_diarization_run_cluster_segments (
          run_id, cluster_id, transcript_segment_id
        ) VALUES (@runId, @clusterId, @transcriptSegmentId)
      `),
      listIdentityResolutionRunClusters: this.db.prepare(`
        SELECT run_cluster.*, run.embedding_model_id
        FROM speaker_diarization_run_clusters AS run_cluster
        JOIN speaker_diarization_runs AS run ON run.id = run_cluster.run_id
        WHERE run_cluster.run_id = ?
        ORDER BY run_cluster.first_appearance_at, run_cluster.cluster_id
      `),
      getLatestIdentityDiarizationRun: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND policy_id = @policyId
          AND embedding_model_id = @modelId
        ORDER BY commit_sequence DESC LIMIT 1
      `),
      listIdentityDiarizationJobs: this.db.prepare(`
        SELECT rowid AS job_sequence, * FROM processing_jobs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND job_type = 'diarize_track'
        ORDER BY rowid
      `),
      getIdentityDiarizationJobByIdentity: this.db.prepare(`
        SELECT rowid AS job_sequence, * FROM processing_jobs
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
      `),
      listIdentityResolutionProfiles: this.db.prepare(`
        SELECT sample.*, person.is_self
        FROM voice_profile_samples AS sample
        JOIN people AS person ON person.id = sample.person_id
        WHERE sample.model_id = ?
        ORDER BY sample.person_id, sample.id
      `),
      insertIdentityResolutionJob: this.db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, NULL, NULL, 'resolve_identities', 'pending', 45,
          @inputHash, 1, @policyId, @createdAt
        )
      `),
      getIdentityResolutionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'resolve_identities'
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = @policyId
      `),
      requeueIdentityResolutionJob: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'pending', attempt_count = 0, next_retry_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
            blocked_reason = NULL, execution_device = NULL, completed_at = NULL
        WHERE job_type = 'resolve_identities'
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = @policyId
          AND state = 'completed'
      `),
      getIdentityResolutionRun: this.db.prepare(`
        SELECT * FROM speaker_identity_resolution_runs
        WHERE session_id = @sessionId
          AND diarization_revision = @diarizationRevision
          AND profile_revision = @profileRevision
          AND policy_id = @policyId
      `),
      countSessionDiarizationJobs: this.db.prepare(`
        SELECT count(*) AS count FROM processing_jobs
        WHERE session_id = ? AND job_type = 'diarize_track'
      `),
      countIdentityResolutionSystemResults: this.db.prepare(`
        SELECT count(*) AS count FROM speaker_identity_resolutions
        WHERE resolution_run_id = ? AND actor = 'system'
      `),
      markSessionProcessing: this.db.prepare(`
        UPDATE sessions
        SET processing_state = 'processing', ready_at = NULL,
            timeline_version = timeline_version + 1
        WHERE id = ?
          AND status IN ('completed', 'recovered')
          AND ended_at IS NOT NULL
          AND (processing_state <> 'processing' OR ready_at IS NOT NULL)
      `),
      setSessionReadiness: this.db.prepare(`
        UPDATE sessions
        SET processing_state = @processingState,
            ready_at = @readyAt,
            timeline_version = timeline_version + 1
        WHERE id = @sessionId
          AND (processing_state <> @processingState OR ready_at IS NOT @readyAt)
      `),
      insertPerson: this.db.prepare(`
        INSERT OR IGNORE INTO people (
          id, display_name, is_self, created_at, last_seen_at
        ) VALUES (
          @id, @displayName, 0, @createdAt, @lastSeenAt
        )
      `),
      getSegmentSession: this.db.prepare(`
        SELECT session_id, result_kind, chunk_id, model_version, superseded_by, duplicate_of
        FROM transcript_segments WHERE id = ?
      `),
      upsertSegment: this.db.prepare(`
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, person_id, speaker_label,
          text, confidence, is_stable, track_id, source_type, result_kind, version,
          echo_score
        ) VALUES (
          @id, @sessionId, @startedAt, @endedAt, @personId, @speakerLabel,
          @text, @confidence, @isStable, @trackId, @sourceType, 'provisional', 1,
          @echoScore
        )
        ON CONFLICT(id) DO UPDATE SET
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          person_id = excluded.person_id,
          speaker_label = excluded.speaker_label,
          text = excluded.text,
          confidence = excluded.confidence,
          is_stable = excluded.is_stable,
          track_id = excluded.track_id,
          source_type = excluded.source_type,
          echo_score = CASE
            WHEN excluded.echo_score IS NULL THEN transcript_segments.echo_score
            WHEN transcript_segments.echo_score IS NULL THEN excluded.echo_score
            ELSE MAX(transcript_segments.echo_score, excluded.echo_score)
          END,
          duplicate_of = CASE
            WHEN transcript_segments.started_at <> excluded.started_at
              OR transcript_segments.ended_at <> excluded.ended_at
              OR transcript_segments.source_type <> excluded.source_type
              OR transcript_segments.text <> excluded.text
            THEN NULL
            ELSE transcript_segments.duplicate_of
          END
        WHERE transcript_segments.session_id = excluded.session_id
          AND transcript_segments.result_kind = 'provisional'
          AND transcript_segments.chunk_id IS NULL
          AND transcript_segments.model_version IS NULL
          AND transcript_segments.superseded_by IS NULL
      `),
      listSegments: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ? AND superseded_by IS NULL AND duplicate_of IS NULL
        ORDER BY started_at ASC, id ASC
      `),
      listTranscriptHistory: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC
      `),
      listPreviewTranscriptContext: this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM transcript_segments
          WHERE session_id = @sessionId
            AND track_id = @trackId
            AND superseded_by IS NULL
            AND duplicate_of IS NULL
            AND ended_at > @from
            AND started_at < @to
            AND length(trim(text)) > 0
          ORDER BY started_at DESC, id DESC
          LIMIT @limit
        )
        ORDER BY started_at ASC, id ASC
      `),
      getTranscriptSegment: this.db.prepare("SELECT * FROM transcript_segments WHERE id = ?"),
      listTranscriptPromptSegments: this.db.prepare(`
        SELECT text FROM transcript_segments
        WHERE session_id = ?
          AND superseded_by IS NULL
          AND duplicate_of IS NULL
          AND is_stable = 1
          AND length(trim(text)) > 0
        ORDER BY ended_at DESC, id DESC
        LIMIT 16
      `),
      supersedeTranscriptSegment: this.db.prepare(`
        UPDATE transcript_segments
        SET superseded_by = @finalId
        WHERE id = @provisionalId
          AND session_id = @sessionId
          AND result_kind = 'provisional'
          AND superseded_by IS NULL
      `),
      findFinalWinnerForRange: this.db.prepare(`
        SELECT id FROM transcript_segments
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND result_kind = 'final'
          AND started_at < @endedAt
          AND @startedAt < ended_at
        ORDER BY version DESC, completed_at DESC, id ASC
        LIMIT 1
      `),
      supersedeOverlappingProvisionals: this.db.prepare(`
        UPDATE transcript_segments
        SET superseded_by = @finalId
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND result_kind = 'provisional'
          AND started_at < @endedAt
          AND @startedAt < ended_at
          AND superseded_by IS NOT @finalId
      `),
      mergeTranscriptEchoScore: this.db.prepare(`
        UPDATE transcript_segments
        SET echo_score = CASE
          WHEN echo_score IS NULL THEN @echoScore
          ELSE MAX(echo_score, @echoScore)
        END
        WHERE id = @finalId AND result_kind = 'final'
      `),
      listTranscriptDedupeCandidates: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ? AND superseded_by IS NULL AND duplicate_of IS NULL
        ORDER BY started_at ASC, id ASC
      `),
      markTranscriptDuplicate: this.db.prepare(`
        UPDATE transcript_segments
        SET duplicate_of = @systemId
        WHERE id = @micId
          AND session_id = @sessionId
          AND source_type = 'mic'
          AND superseded_by IS NULL
          AND duplicate_of IS NULL
      `),
      getChunkForTranscriptCommit: this.db.prepare(`
        SELECT * FROM audio_chunks WHERE id = ?
      `),
      getFinalChunkTranscript: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE chunk_id = ? AND result_kind = 'final' AND model_version = ?
      `),
      insertFinalChunkTranscript: this.db.prepare(`
        INSERT OR IGNORE INTO transcript_segments (
          id, session_id, started_at, ended_at, person_id, speaker_label,
          text, confidence, is_stable, analysis_state, track_id, chunk_id,
          source_type, result_kind, version, model_version, completed_at
        ) VALUES (
          @id, @sessionId, @startedAt, @endedAt, NULL, @speakerLabel,
          @text, @confidence, 1, 'pending', @trackId, @chunkId,
          @sourceType, 'final', 1, @modelVersion, @completedAt
        )
      `),
      setChunkTranscriptionStatus: this.db.prepare(`
        UPDATE audio_chunks
        SET transcription_status = @status
        WHERE id = @chunkId AND write_state = 'committed' AND deleted_at IS NULL
      `),
      clearSelf: this.db.prepare("UPDATE people SET is_self = 0 WHERE is_self <> 0"),
      listSelfProfileModels: this.db.prepare(`
        SELECT DISTINCT sample.model_id
        FROM voice_profile_samples AS sample
        JOIN people AS person ON person.id = sample.person_id
        WHERE person.is_self = 1
        ORDER BY sample.model_id
      `),
      listPersonProfileModels: this.db.prepare(`
        SELECT DISTINCT model_id FROM voice_profile_samples
        WHERE person_id = ? ORDER BY model_id
      `),
      countOtherSelfPeople: this.db.prepare(`
        SELECT count(*) AS count FROM people WHERE is_self = 1 AND id <> ?
      `),
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
      listSessionTimelineTracks: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE session_id = ?
        ORDER BY CASE source_type WHEN 'mic' THEN 0 ELSE 1 END, started_at ASC, id ASC
      `),
      listSessionTimelineGaps: this.db.prepare(`
        SELECT gap.* FROM audio_gaps AS gap
        JOIN audio_tracks AS track ON track.id = gap.track_id
        WHERE track.session_id = ?
        ORDER BY gap.started_at ASC, gap.id ASC
      `),
      listSessionTimelineChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND write_state = 'committed'
        ORDER BY started_at ASC,
          CASE source_type WHEN 'mic' THEN 0 ELSE 1 END,
          sequence_number ASC, id ASC
      `),
      getSessionProcessingCounts: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS leased,
          COALESCE(SUM(CASE WHEN state = 'retry' THEN 1 ELSE 0 END), 0) AS retry,
          COALESCE(SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
          COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COUNT(*) AS total
        FROM processing_jobs
        WHERE session_id = ?
      `),
      listRuntimeProcessingGroups: this.db.prepare(`
        SELECT
          job_type,
          state,
          priority,
          blocked_reason,
          COUNT(*) AS count,
          MIN(next_retry_at) AS next_retry_at
        FROM processing_jobs
        WHERE state <> 'completed'
        GROUP BY job_type, state, priority, blocked_reason
        ORDER BY job_type ASC, state ASC, priority ASC, blocked_reason ASC
      `),
      getRuntimeTranscriptionBacklog: this.db.prepare(`
        SELECT COALESCE(SUM(chunk.duration_ms), 0) AS backlog_ms
        FROM audio_chunks AS chunk
        WHERE chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM processing_jobs AS job
            WHERE job.chunk_id = chunk.id
              AND job.job_type = 'transcribe_chunk'
              AND job.state <> 'completed'
          )
      `),
      getRuntimeOldestProcessingJob: this.db.prepare(`
        SELECT MIN(created_at) AS oldest_created_at
        FROM processing_jobs
        WHERE state <> 'completed'
      `),
      getActiveProcessingExecutionDevice: this.db.prepare(`
        SELECT execution_device
        FROM processing_jobs
        WHERE state = 'running' AND execution_device IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      getRuntimeFinalCoverage: this.db.prepare(`
        SELECT
          COALESCE(SUM(chunk.duration_ms), 0) AS total_ms,
          COALESCE(SUM(CASE WHEN EXISTS (
            SELECT 1 FROM processing_jobs AS job
            WHERE job.chunk_id = chunk.id
              AND job.job_type = 'transcribe_chunk'
              AND job.state = 'completed'
              AND job.id = (
                SELECT current.id
                FROM processing_jobs AS current
                WHERE current.chunk_id = chunk.id
                  AND current.job_type = 'transcribe_chunk'
                ORDER BY current.created_at DESC, current.id DESC
                LIMIT 1
              )
              AND (
                chunk.transcription_status = 'no_speech'
                OR (
                  chunk.transcription_status = 'completed'
                  AND EXISTS (
                    SELECT 1 FROM transcript_segments AS segment
                    WHERE segment.chunk_id = chunk.id
                      AND segment.result_kind = 'final'
                      AND segment.model_version = job.model_version
                      AND segment.started_at <= chunk.started_at
                      AND segment.ended_at >= chunk.ended_at
                  )
                )
              )
          ) THEN chunk.duration_ms ELSE 0 END), 0) AS final_ms
        FROM audio_chunks AS chunk
        WHERE chunk.write_state = 'committed' AND chunk.deleted_at IS NULL
      `),
      listRuntimeProvisionalCoverageRanges: this.db.prepare(`
        SELECT
          chunk.id AS chunk_id,
          MAX(segment.started_at, chunk.started_at) AS started_at,
          MIN(segment.ended_at, chunk.ended_at) AS ended_at
        FROM transcript_segments AS segment
        JOIN audio_chunks AS chunk
          ON chunk.session_id = segment.session_id
          AND chunk.source_type = segment.source_type
          AND (segment.track_id IS NULL OR chunk.track_id = segment.track_id)
          AND segment.started_at < chunk.ended_at
          AND chunk.started_at < segment.ended_at
        WHERE segment.result_kind = 'provisional'
          AND segment.superseded_by IS NULL
          AND segment.duplicate_of IS NULL
          AND chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
        ORDER BY chunk.id ASC, started_at ASC, ended_at ASC
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
      getStorageUsageSince: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'wav_written' THEN bytes ELSE 0 END), 0)
            AS written_bytes,
          COALESCE(SUM(CASE WHEN kind = 'flac_written' THEN bytes ELSE 0 END), 0)
            AS compressed_bytes,
          COALESCE(SUM(delta_bytes), 0) AS net_growth_bytes
        FROM storage_usage_events
        WHERE occurred_at >= ?
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
        const mutableSnapshotRow =
          !existing ||
          (existing.result_kind === "provisional" &&
            existing.chunk_id === null &&
            existing.model_version === null &&
            existing.superseded_by === null);
        if (!mutableSnapshotRow) continue;

        const sourceType = segment.sourceType ?? "mic";
        if (sourceType !== "mic" && sourceType !== "system") {
          throw new TypeError("segment sourceType must be mic or system");
        }
        const echoScore = segment.echoScore ?? null;
        if (
          echoScore !== null &&
          (typeof echoScore !== "number" ||
            !Number.isFinite(echoScore) ||
            echoScore < 0 ||
            echoScore > 1)
        ) {
          throw new RangeError("segment echoScore must be null or between zero and one");
        }
        if (sourceType !== "mic" && echoScore !== null) {
          throw new TypeError("segment echoScore is only valid for mic evidence");
        }
        const sourceTrack = this.statements.getSessionSourceTrack.get(sessionId, sourceType);

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
          trackId: sourceTrack?.id ?? null,
          sourceType,
          echoScore,
        });
        const finalWinner = sourceTrack
          ? this.statements.findFinalWinnerForRange.get({
              sessionId,
              trackId: sourceTrack.id,
              startedAt: segment.startedAt,
              endedAt: segment.endedAt,
            })
          : null;
        if (finalWinner) {
          this.statements.supersedeTranscriptSegment.run({
            sessionId,
            provisionalId: segmentId,
            finalId: finalWinner.id,
          });
        }
      }
    };

    this._upsertTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
    });

    this._syncTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
      if (segments.length === 0) {
        this.db
          .prepare(
            `
          DELETE FROM transcript_segments
          WHERE session_id = ?
            AND result_kind = 'provisional'
            AND chunk_id IS NULL
            AND model_version IS NULL
            AND superseded_by IS NULL
        `
          )
          .run(sessionId);
        return;
      }
      const placeholders = segments.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM transcript_segments
           WHERE session_id = ?
             AND result_kind = 'provisional'
             AND chunk_id IS NULL
             AND model_version IS NULL
             AND superseded_by IS NULL
             AND id NOT IN (${placeholders})`
        )
        .run(sessionId, ...segments.map((segment) => segment.id));
    });

    this._reconcileTranscript = this.db.transaction((sessionId, reconcile) => {
      const history = this.statements.listTranscriptHistory.all(sessionId);
      const provisional = history.filter((row) => row.result_kind === "provisional");
      const final = history.filter((row) => row.result_kind === "final");
      const assignments = reconcile({ provisional, final });
      if (!Array.isArray(assignments)) {
        throw new TypeError("transcript reconciliation must return an array");
      }

      const rowsById = new Map(history.map((row) => [row.id, row]));
      const assigned = new Set();
      let superseded = 0;
      for (const assignment of assignments) {
        const provisionalId = assertId(assignment?.provisionalId, "provisionalSegmentId");
        const finalId = assertId(assignment?.finalId, "finalSegmentId");
        if (assigned.has(provisionalId)) {
          throw new Error("provisional segment has multiple supersession assignments");
        }
        assigned.add(provisionalId);
        const provisionalRow = rowsById.get(provisionalId);
        const finalRow = rowsById.get(finalId);
        if (
          !provisionalRow ||
          provisionalRow.result_kind !== "provisional" ||
          (provisionalRow.superseded_by !== null && provisionalRow.superseded_by !== finalId) ||
          !finalRow ||
          finalRow.result_kind !== "final" ||
          provisionalRow.session_id !== finalRow.session_id ||
          provisionalRow.track_id !== finalRow.track_id ||
          !(provisionalRow.started_at < finalRow.ended_at) ||
          !(finalRow.started_at < provisionalRow.ended_at)
        ) {
          throw new Error("invalid transcript supersession assignment");
        }
        if (provisionalRow.echo_score !== null) {
          this.statements.mergeTranscriptEchoScore.run({
            finalId,
            echoScore: provisionalRow.echo_score,
          });
        }
        if (provisionalRow.superseded_by === null) {
          superseded += this.statements.supersedeTranscriptSegment.run({
            sessionId,
            provisionalId,
            finalId,
          }).changes;
        }
      }
      return {
        inserted: 0,
        superseded,
        unchanged: provisional.length - superseded,
      };
    });
    this._reconcileTranscript = this._reconcileTranscript.immediate;

    this._dedupeTranscript = this.db.transaction((sessionId, selectDuplicates) => {
      const rows = this.statements.listTranscriptDedupeCandidates.all(sessionId);
      const assignments = selectDuplicates(rows);
      if (!Array.isArray(assignments)) {
        throw new TypeError("transcript dedupe must return an array");
      }

      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const assigned = new Set();
      let duplicatesMarked = 0;
      for (const assignment of assignments) {
        const micId = assertId(assignment?.micId, "micSegmentId");
        const systemId = assertId(assignment?.systemId, "systemSegmentId");
        if (assigned.has(micId)) {
          throw new Error("mic segment has multiple duplicate assignments");
        }
        assigned.add(micId);
        const mic = rowsById.get(micId);
        const system = rowsById.get(systemId);
        if (
          !mic ||
          !system ||
          mic.source_type !== "mic" ||
          system.source_type !== "system" ||
          mic.session_id !== system.session_id ||
          mic.echo_score === null ||
          mic.echo_score < 0.8 ||
          !(mic.started_at < system.ended_at) ||
          !(system.started_at < mic.ended_at)
        ) {
          throw new Error("invalid transcript duplicate assignment");
        }
        duplicatesMarked += this.statements.markTranscriptDuplicate.run({
          sessionId,
          micId,
          systemId,
        }).changes;
      }
      return { duplicatesMarked };
    });
    this._dedupeTranscript = this._dedupeTranscript.immediate;

    this._renamePerson = this.db.transaction((input) => {
      if (input.isSelf) this.statements.clearSelf.run();
      this.statements.renamePerson.run(input);
      if (input.wakeModelIds.length > 0) {
        this.speakerIdentityRepository.wakeSessionsForModels(input.wakeModelIds);
      }
    });

    this._rejectSpeakerSuggestion = this.db.transaction((input) => {
      const { cluster, rejection } =
        this.speakerIdentityRepository.rejectSuggestionWithResolution(input);
      if (rejection) {
        const inputHash = buildIdentityResolutionJobKey({
          sessionId: rejection.sessionId,
          diarizationRevision: rejection.diarizationRevision,
          profileRevision: rejection.profileRevision,
          policyId: rejection.policyId,
        });
        this.statements.requeueIdentityResolutionJob.run({
          inputHash,
          policyId: rejection.policyId,
        });
        this.statements.markSessionProcessing.run(rejection.sessionId);
      }
      return cluster;
    });

    this._recoverOpenSessions = this.db.transaction((at) => {
      const openSessions = this.statements.listOpenSessions.all();
      for (const session of openSessions) {
        if (
          session.status === "paused" &&
          session.stop_reason === "capture_stopped_low_disk" &&
          Number.isSafeInteger(session.durable_boundary_at)
        ) {
          continue;
        }
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

    this._rotateCaptureAtLocalDate = this.db.transaction((input) => {
      const existing = this.statements.getSessionContinuation.get(input);
      if (existing) return { continuation: existing, rollback: null };
      const session = this.statements.getSession.get(input.sourceSessionId);
      if (!session) throw new Error(`session ${input.sourceSessionId} does not exist`);
      const tracks = this.statements.listRotationTracks.all(input.sourceSessionId);
      const gaps = this.statements.listRotationGaps.all(input.sourceSessionId);
      this.captureEvidenceStore.finalizeCapture({
        sessionId: input.sourceSessionId,
        sources: tracks.map((track) => ({
          trackId: track.id,
          gapId: gaps.find((gap) => gap.track_id === track.id)?.id ?? null,
        })),
        trackState: "ended",
        sessionStatus: "completed",
        at: input.boundaryAt,
      });
      this.createSession(input.destinationSession);
      const continuation = this.createSessionContinuation(input);
      return { continuation, rollback: { session, tracks, gaps } };
    });

    this._rollbackCaptureAtLocalDate = this.db.transaction((input) => {
      const continuation = this.statements.getSessionContinuation.get(input);
      if (continuation && continuation.destination_session_id !== input.destinationSessionId) {
        throw new Error("local-date continuation destination changed before rollback");
      }
      this.statements.deleteRotationDestination.run(input.destinationSessionId);
      const restoredSession = this.statements.restoreRotationSession.run(input.rollback.session);
      if (restoredSession.changes !== 1) {
        throw new Error(`session ${input.sourceSessionId} could not be restored`);
      }
      for (const track of input.rollback.tracks) {
        if (this.statements.restoreRotationTrack.run(track).changes !== 1) {
          throw new Error(`track ${track.id} could not be restored`);
        }
      }
      for (const gap of input.rollback.gaps) {
        if (this.statements.restoreRotationGap.run(gap).changes !== 1) {
          throw new Error(`gap ${gap.id} could not be restored`);
        }
      }
      return this.statements.getSession.get(input.sourceSessionId);
    });

    this._commitChunkTranscript = this.db.transaction(
      ({ chunk, result, modelVersion, completedAt }) => {
        const current = this.statements.getChunkForTranscriptCommit.get(chunk.id);
        if (
          !current ||
          current.deleted_at !== null ||
          current.write_state !== "committed" ||
          !current.path ||
          current.path.startsWith("tombstone:") ||
          current.session_id !== chunk.session_id ||
          current.track_id !== chunk.track_id ||
          current.source_type !== chunk.source_type ||
          current.sha256 !== chunk.sha256
        ) {
          throw codedError("AUDIO_UNAVAILABLE");
        }

        if (result.noSpeech === true) {
          const updated = this.statements.setChunkTranscriptionStatus.run({
            chunkId: current.id,
            status: "no_speech",
          });
          if (updated.changes !== 1) throw codedError("AUDIO_UNAVAILABLE");
          return null;
        }

        let segment = this.statements.getFinalChunkTranscript.get(current.id, modelVersion);
        if (!segment) {
          const id = derivedId(
            "chunk_transcript",
            current.session_id,
            current.track_id ?? "",
            current.id,
            current.sha256,
            modelVersion
          );
          this.statements.insertFinalChunkTranscript.run({
            id,
            sessionId: current.session_id,
            startedAt: current.started_at,
            endedAt: current.ended_at,
            speakerLabel: current.source_type,
            text: result.text,
            confidence: result.confidence,
            trackId: current.track_id,
            chunkId: current.id,
            sourceType: current.source_type,
            modelVersion,
            completedAt,
          });
          segment = this.statements.getFinalChunkTranscript.get(current.id, modelVersion);
        }
        if (!segment) throw codedError("TRANSCRIPT_COMMIT_FAILED");
        const finalWinner = this.statements.findFinalWinnerForRange.get({
          sessionId: current.session_id,
          trackId: current.track_id,
          startedAt: current.started_at,
          endedAt: current.ended_at,
        });
        if (!finalWinner) throw codedError("TRANSCRIPT_COMMIT_FAILED");
        this.statements.supersedeOverlappingProvisionals.run({
          sessionId: current.session_id,
          trackId: current.track_id,
          startedAt: current.started_at,
          endedAt: current.ended_at,
          finalId: finalWinner.id,
        });
        const updated = this.statements.setChunkTranscriptionStatus.run({
          chunkId: current.id,
          status: "completed",
        });
        if (updated.changes !== 1) throw codedError("AUDIO_UNAVAILABLE");
        return segment;
      }
    );

    this._inspectSessionTranscriptReadiness = (sessionId) => {
      const session = this.statements.getSession.get(sessionId);
      if (!session) throw new Error(`session ${sessionId} does not exist`);
      const isFinalized =
        (session.status === "completed" || session.status === "recovered") &&
        Number.isSafeInteger(session.ended_at);
      const tracks = this.statements.listSessionReadinessTracks.all(sessionId);
      const chunks = this.statements.listSessionReadinessChunks.all(sessionId);
      const jobs = this.statements.listSessionTranscriptionJobs.all(sessionId);
      const coverage = this.statements.listSessionFinalCoverage.all(sessionId);
      const tracksById = new Map(tracks.map((track) => [track.id, track]));
      const jobsByChunk = new Map();
      for (const job of jobs) {
        const rows = jobsByChunk.get(job.chunk_id) ?? [];
        rows.push(job);
        jobsByChunk.set(job.chunk_id, rows);
      }
      const coverageByChunk = new Map();
      for (const segment of coverage) {
        const rows = coverageByChunk.get(segment.chunk_id) ?? [];
        rows.push(segment);
        coverageByChunk.set(segment.chunk_id, rows);
      }

      const complete =
        isFinalized &&
        chunks.every((chunk) => {
          const track = tracksById.get(chunk.track_id);
          if (
            !track ||
            track.session_id !== sessionId ||
            track.source_type !== chunk.source_type ||
            !["completed", "no_speech"].includes(chunk.transcription_status)
          ) {
            return false;
          }
          const chunkJobs = jobsByChunk.get(chunk.id) ?? [];
          if (chunkJobs.length === 0 || chunkJobs.some((job) => job.state !== "completed")) {
            return false;
          }
          if (chunk.transcription_status === "no_speech") return true;
          return (coverageByChunk.get(chunk.id) ?? []).some(
            (segment) =>
              segment.track_id === chunk.track_id &&
              segment.source_type === chunk.source_type &&
              segment.started_at <= chunk.started_at &&
              segment.ended_at >= chunk.ended_at
          );
        });
      return { session, complete, isFinalized };
    };

    this._refreshSessionReadiness = this.db.transaction((sessionId, at) => {
      const { session, complete, isFinalized } = this._inspectSessionTranscriptReadiness(sessionId);
      let fullyProcessed = complete;
      if (complete && this.statements.countSessionDiarizationJobs.get(sessionId).count > 0) {
        const snapshot = this.getSpeakerIdentityResolutionSnapshot({
          sessionId,
          at,
          policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
        });
        fullyProcessed = false;
        if (snapshot.eligible) {
          const inputHash = buildIdentityResolutionJobKey({
            sessionId,
            diarizationRevision: snapshot.diarizationRevision,
            profileRevision: snapshot.profileRevision,
            policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
          });
          const job = this.statements.getIdentityResolutionJob.get({
            inputHash,
            policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
          });
          const run = this.statements.getIdentityResolutionRun.get({
            sessionId,
            diarizationRevision: snapshot.diarizationRevision,
            profileRevision: snapshot.profileRevision,
            policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
          });
          fullyProcessed =
            job?.state === "completed" &&
            Boolean(run) &&
            this.statements.countIdentityResolutionSystemResults.get(run.id).count ===
              run.expected_cluster_count;
        }
      }
      const processingState = fullyProcessed ? "ready" : isFinalized ? "processing" : "pending";
      const readyAt = fullyProcessed ? (session.ready_at ?? at) : null;
      this.statements.setSessionReadiness.run({ sessionId, processingState, readyAt });
      return this.statements.getSession.get(sessionId);
    });

    this._commitDiarizationRun = this.db.transaction((input) => {
      const existing = this.statements.getDiarizationRun.get({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        transcriptRevision: input.expectedRevision,
        policyId: input.run.policyId,
      });
      if (existing) return { status: "already_completed", runId: existing.id };

      const current = this.getDiarizationEvidenceSnapshot({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        at: input.validatedAt,
        speakerProcessingPolicy: input.speakerProcessingPolicy,
      });
      if (!current.eligible || current.evidenceRevision !== input.expectedRevision) {
        throw codedError("DIARIZATION_STALE_INPUT");
      }
      const commitSequence = this.statements.nextDiarizationCommitSequence.get().value;
      this.statements.insertDiarizationRun.run({
        ...input.run,
        transcriptRevision: input.run.evidenceRevision,
        commitSequence,
      });
      const persistedClusterIds = new Map();
      const stableCandidates = this.statements.listDiarizationStableClusters.all({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        modelId: input.run.embeddingModelId,
      });
      const reusableCandidates = stableCandidates
        .filter((candidate) => candidate.embedding !== null)
        .map((candidate) => ({
          ...candidate,
          normalizedEmbedding: l2NormalizeEmbedding(
            SpeakerIdentityRepository.decodeEmbedding(candidate.embedding, 512)
          ),
        }))
        .filter((candidate) => candidate.normalizedEmbedding !== null);
      const incomingWithVoice = input.clusters
        .filter((cluster) => cluster.embedding !== null)
        .map((cluster) => ({
          ...cluster,
          normalizedEmbedding: l2NormalizeEmbedding(
            SpeakerIdentityRepository.decodeEmbedding(cluster.embedding, 512)
          ),
        }))
        .filter((cluster) => cluster.normalizedEmbedding !== null);
      const pairs = [];
      for (const cluster of incomingWithVoice) {
        for (const candidate of reusableCandidates) {
          const score = cosineSimilarity(
            cluster.normalizedEmbedding,
            candidate.normalizedEmbedding
          );
          pairs.push({ cluster, candidate, score });
        }
      }
      const comparePairs = (left, right) =>
        right.score - left.score ||
        left.cluster.firstAppearanceAt - right.cluster.firstAppearanceAt ||
        compareStableIds(left.cluster.localLabel, right.cluster.localLabel) ||
        compareStableIds(left.candidate.id, right.candidate.id);
      const pairsByIncoming = new Map();
      const pairsByStable = new Map();
      for (const pair of pairs) {
        const incomingPairs = pairsByIncoming.get(pair.cluster.id) ?? [];
        incomingPairs.push(pair);
        pairsByIncoming.set(pair.cluster.id, incomingPairs);
        const stablePairs = pairsByStable.get(pair.candidate.id) ?? [];
        stablePairs.push(pair);
        pairsByStable.set(pair.candidate.id, stablePairs);
      }
      for (const ranked of pairsByIncoming.values()) ranked.sort(comparePairs);
      for (const ranked of pairsByStable.values()) ranked.sort(comparePairs);
      const eligiblePairs = [];
      for (const rankedIncoming of pairsByIncoming.values()) {
        const best = rankedIncoming[0];
        if (best.score < STABLE_CLUSTER_REUSE_THRESHOLD || !hasStableReuseMargin(rankedIncoming)) {
          continue;
        }
        const rankedStable = pairsByStable.get(best.candidate.id);
        if (rankedStable[0].cluster.id !== best.cluster.id || !hasStableReuseMargin(rankedStable)) {
          continue;
        }
        eligiblePairs.push(best);
      }
      eligiblePairs.sort(
        (left, right) =>
          right.score - left.score ||
          left.cluster.firstAppearanceAt - right.cluster.firstAppearanceAt ||
          compareStableIds(left.cluster.localLabel, right.cluster.localLabel) ||
          compareStableIds(left.candidate.id, right.candidate.id)
      );
      const assignedIncoming = new Set();
      const assignedStable = new Set();
      for (const pair of eligiblePairs) {
        if (assignedIncoming.has(pair.cluster.id) || assignedStable.has(pair.candidate.id))
          continue;
        assignedIncoming.add(pair.cluster.id);
        assignedStable.add(pair.candidate.id);
        persistedClusterIds.set(pair.cluster.id, pair.candidate.id);
      }

      const usedStableIds = new Set(stableCandidates.map((cluster) => cluster.id));
      const usedStableLabels = new Set(stableCandidates.map((cluster) => cluster.local_label));
      for (const cluster of input.clusters) {
        let stableId = persistedClusterIds.get(cluster.id) ?? null;
        if (!stableId) {
          stableId = cluster.id;
          if (usedStableIds.has(stableId)) {
            stableId = derivedId("speaker_cluster", input.run.id, cluster.id);
          }
          let stableLabel = cluster.localLabel;
          if (usedStableLabels.has(stableLabel)) {
            const base = `${cluster.localLabel}__${derivedId("revision", input.run.id).slice(-12)}`;
            stableLabel = base;
            let suffix = 1;
            while (usedStableLabels.has(stableLabel)) {
              suffix += 1;
              stableLabel = `${base}_${suffix}`;
            }
          }
          this.statements.insertDiarizationStableCluster.run({
            id: stableId,
            sessionId: input.run.sessionId,
            trackId: input.run.trackId,
            localLabel: stableLabel,
            modelId: input.run.embeddingModelId,
            embedding: cluster.embedding,
            speechMs: cluster.speechMs,
            windowCount: cluster.windowCount,
            qualityScore: cluster.qualityScore,
            at: input.run.completedAt,
          });
          usedStableIds.add(stableId);
          usedStableLabels.add(stableLabel);
          persistedClusterIds.set(cluster.id, stableId);
        }
        const stable = this.db.prepare("SELECT * FROM speaker_clusters WHERE id = ?").get(stableId);
        if (!stable || stable.model_id !== input.run.embeddingModelId) {
          throw codedError("DIARIZATION_CLUSTER_MODEL_MISMATCH");
        }
        this.statements.insertDiarizationRunCluster.run({
          runId: input.run.id,
          clusterId: stable.id,
          localLabel: cluster.localLabel,
          embedding: cluster.embedding,
          speechMs: cluster.speechMs,
          windowCount: cluster.windowCount,
          qualityScore: cluster.qualityScore,
          firstAppearanceAt: cluster.firstAppearanceAt,
        });
      }

      const chunks = new Map(
        current.chunks.map((entry) => [entry.audioChunk.id, entry.audioChunk])
      );
      const segmentIdsByChunk = new Map(
        current.chunks.map((entry) => [
          entry.audioChunk.id,
          new Set(entry.transcriptSegments.map((segment) => segment.id)),
        ])
      );
      const segmentIds = new Set(
        current.chunks.flatMap((entry) => entry.transcriptSegments.map((segment) => segment.id))
      );
      for (const turn of input.turns) {
        const chunk = chunks.get(turn.chunkId);
        const clusterId = persistedClusterIds.get(turn.clusterId);
        if (
          !chunk ||
          !clusterId ||
          turn.startedAt < chunk.started_at ||
          turn.endedAt > chunk.ended_at ||
          (turn.transcriptSegmentId !== null &&
            !segmentIdsByChunk.get(turn.chunkId)?.has(turn.transcriptSegmentId))
        ) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        this.statements.insertSpeakerTurn.run({
          ...turn,
          runId: input.run.id,
          clusterId,
          excludedFromCentroid: turn.excludedFromCentroid ? 1 : 0,
          createdAt: input.run.completedAt,
        });
      }
      for (const link of input.segmentLinks) {
        const clusterId = persistedClusterIds.get(link.clusterId);
        if (!clusterId || !segmentIds.has(link.transcriptSegmentId)) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        this.statements.insertDiarizationSegmentLink.run({
          clusterId,
          transcriptSegmentId: link.transcriptSegmentId,
        });
        this.statements.insertDiarizationRunSegmentLink.run({
          runId: input.run.id,
          clusterId,
          transcriptSegmentId: link.transcriptSegmentId,
        });
      }
      return { status: "completed", runId: input.run.id };
    });
    this._commitDiarizationRun = this._commitDiarizationRun.immediate;

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
        let sequenceNumber = this.statements.getLastTrackSequence.get(track.id).sequence_number + 1;
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

  createSessionContinuation({
    sourceSessionId,
    destinationSessionId,
    boundaryAt,
    destinationLocalDate,
  }) {
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSessionId, "destinationSessionId"),
      boundaryAt: assertInteger(boundaryAt, "boundaryAt"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    if (input.sourceSessionId === input.destinationSessionId) {
      throw new TypeError("continuation sessions must be different");
    }
    this.statements.insertSessionContinuation.run(input);
    const continuation = this.statements.getSessionContinuation.get(input);
    if (!continuation) throw new Error("session continuation could not be persisted");
    return continuation;
  }

  getSessionContinuation(sourceSessionId, destinationLocalDate) {
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    return this.statements.getSessionContinuation.get(input) ?? null;
  }

  listSessionContinuations(sourceSessionId) {
    return this.statements.listSessionContinuations.all(
      assertId(sourceSessionId, "sourceSessionId")
    );
  }

  rotateCaptureAtLocalDate({
    sourceSessionId,
    destinationSession,
    boundaryAt,
    destinationLocalDate,
  }) {
    if (!destinationSession || typeof destinationSession !== "object") {
      throw new TypeError("destinationSession is required");
    }
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSession.id, "destinationSessionId"),
      destinationSession,
      boundaryAt: assertInteger(boundaryAt, "boundaryAt"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    return this._rotateCaptureAtLocalDate(input);
  }

  rollbackCaptureAtLocalDate({
    sourceSessionId,
    destinationSessionId,
    destinationLocalDate,
    rollback,
  }) {
    if (!rollback || typeof rollback !== "object") {
      throw new TypeError("rotation rollback evidence is required");
    }
    return this._rollbackCaptureAtLocalDate({
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSessionId, "destinationSessionId"),
      destinationLocalDate,
      rollback,
    });
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

  listProcessingSessions({ after = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError("processing session limit must be between 1 and 1000");
    }
    let afterSortAt = null;
    let afterId = null;
    if (after !== null) {
      if (!after || typeof after !== "object" || Array.isArray(after)) {
        throw new TypeError("processing session cursor must be an object or null");
      }
      afterSortAt = assertInteger(after.sortAt, "processing session cursor sortAt");
      afterId = assertId(after.id, "processing session cursor id");
    }
    return this.statements.listProcessingSessions.all({ afterSortAt, afterId, limit });
  }

  listPendingJobs(sessionId) {
    return this.statements.listPendingJobs.all(assertId(sessionId, "sessionId"));
  }

  getDiarizationTrackEvidence({ sessionId, trackId, observedAt = Date.now() } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(trackId, "trackId");
    const safeObservedAt = assertNonNegativeInteger(observedAt, "observedAt");
    const session = this.statements.getSession.get(safeSessionId);
    const track = this.statements.getDiarizationTrack.get({
      sessionId: safeSessionId,
      trackId: safeTrackId,
    });
    const chunks = this.statements.listDiarizationChunks.all({
      sessionId: safeSessionId,
      trackId: safeTrackId,
    });
    return deepFreeze({
      observedAt: safeObservedAt,
      session: session ?? null,
      track: track ?? null,
      chunks: chunks.map((audioChunk) => ({
        audioChunk,
        latestTranscriptionJob:
          this.statements.getLatestChunkTranscriptionJob.get(audioChunk.id) ?? null,
        transcriptSegments: this.statements.listDiarizationSegments.all(audioChunk.id),
      })),
    });
  }

  getDiarizationEvidenceSnapshot({
    sessionId,
    trackId,
    at = Date.now(),
    speakerProcessingPolicy,
  } = {}) {
    if (!speakerProcessingPolicy || typeof speakerProcessingPolicy.evaluate !== "function") {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    return speakerProcessingPolicy.evaluate(
      this.getDiarizationTrackEvidence({ sessionId, trackId, observedAt: at })
    );
  }

  getDiarizationRun({ sessionId, trackId, evidenceRevision, policyId } = {}) {
    if (typeof evidenceRevision !== "string" || !/^[0-9a-f]{64}$/.test(evidenceRevision)) {
      throw new TypeError("evidenceRevision must be a lowercase SHA-256 digest");
    }
    return (
      this.statements.getDiarizationRun.get({
        sessionId: assertId(sessionId, "sessionId"),
        trackId: assertId(trackId, "trackId"),
        transcriptRevision: evidenceRevision,
        policyId: assertId(policyId, "policyId"),
      }) ?? null
    );
  }

  listDiarizationRuns(sessionId) {
    return this.statements.listDiarizationRuns.all(assertId(sessionId, "sessionId"));
  }

  listDiarizationEchoCandidates({ sessionId, excludeTrackId, policyId } = {}) {
    return this.statements.listDiarizationEchoCandidates
      .all({
        sessionId: assertId(sessionId, "sessionId"),
        excludeTrackId: assertId(excludeTrackId, "excludeTrackId"),
        policyId: assertId(policyId, "policyId"),
      })
      .map((row) => ({
        ...row,
        embedding: SpeakerIdentityRepository.decodeEmbedding(row.embedding, 512),
      }));
  }

  enqueueDiarizationJobs(sessionId, { at = Date.now(), policy, speakerProcessingPolicy } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "at");
    if (
      !policy ||
      typeof policy !== "object" ||
      typeof policy.policyId !== "string" ||
      policy.inputVersion !== 1
    ) {
      throw new TypeError("a versioned diarization policy is required");
    }
    if (!speakerProcessingPolicy || typeof speakerProcessingPolicy.evaluate !== "function") {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    const tracks = this.statements.listSessionReadinessTracks.all(safeSessionId);
    const jobs = [];
    const skipped = [];
    let enqueued = 0;
    const enqueue = this.db.transaction(() => {
      for (const track of tracks) {
        const snapshot = this.getDiarizationEvidenceSnapshot({
          sessionId: safeSessionId,
          trackId: track.id,
          at: safeAt,
          speakerProcessingPolicy,
        });
        if (!snapshot.eligible) {
          skipped.push({ trackId: track.id, reason: snapshot.reason });
          continue;
        }
        const inputHash = buildDiarizationJobKey({
          sessionId: safeSessionId,
          trackId: track.id,
          evidenceRevision: snapshot.evidenceRevision,
          policyId: policy.policyId,
        });
        const identity = {
          sessionId: safeSessionId,
          trackId: track.id,
          inputHash,
          inputVersion: policy.inputVersion,
          modelVersion: policy.policyId,
        };
        const result = this.statements.insertDiarizationJob.run({
          id: derivedId("job_diarize", inputHash),
          ...identity,
          createdAt: safeAt,
        });
        enqueued += result.changes;
        const job = this.statements.getDiarizationJobByIdentity.get(identity);
        if (!job) throw new Error("diarization job insert was not durable");
        jobs.push(job);
      }
    });
    enqueue.immediate();
    return { enqueued, jobs, skipped };
  }

  getSpeakerIdentityResolutionSnapshot({
    sessionId,
    at = Date.now(),
    policy = SPEAKER_IDENTITY_RESOLUTION_POLICY,
    diarizationPolicy = SESSION_DIARIZATION_POLICY,
  } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    assertNonNegativeInteger(at, "at");
    assertExactIdentityResolutionPolicy(policy);
    const session = this.statements.getSession.get(safeSessionId);
    if (!session || !TERMINAL_SESSION_STATUSES.has(session.status)) {
      return { eligible: false, reason: "session_not_terminal" };
    }
    const tracks = this.statements.listSessionReadinessTracks.all(safeSessionId);
    if (tracks.length === 0) return { eligible: false, reason: "no_tracks" };
    const evidenceRuns = [];
    const clusters = [];
    for (const track of tracks) {
      const run = this.statements.getLatestIdentityDiarizationRun.get({
        sessionId: safeSessionId,
        trackId: track.id,
        policyId: diarizationPolicy.policyId,
        modelId: policy.modelId,
      });
      if (!run) return { eligible: false, reason: "diarization_incomplete" };
      const inputHash = buildDiarizationJobKey({
        sessionId: safeSessionId,
        trackId: track.id,
        evidenceRevision: run.transcript_revision,
        policyId: diarizationPolicy.policyId,
      });
      const job = this.statements.getIdentityDiarizationJobByIdentity.get({
        sessionId: safeSessionId,
        trackId: track.id,
        inputHash,
        inputVersion: diarizationPolicy.inputVersion,
        modelVersion: diarizationPolicy.policyId,
      });
      if (!run || !job || job.state !== "completed") {
        return { eligible: false, reason: "diarization_incomplete" };
      }
      const unfinished = this.statements.listIdentityDiarizationJobs
        .all({ sessionId: safeSessionId, trackId: track.id })
        .some(
          (candidate) =>
            candidate.job_sequence > job.job_sequence && candidate.state !== "completed"
        );
      if (unfinished) return { eligible: false, reason: "diarization_incomplete" };
      if (run.embedding_model_id !== policy.modelId) {
        return { eligible: false, reason: "diarization_model_mismatch" };
      }
      const runClusters = this.statements.listIdentityResolutionRunClusters.all(run.id);
      evidenceRuns.push({
        id: run.id,
        trackId: track.id,
        evidenceRevision: run.transcript_revision,
        policyId: run.policy_id,
        embeddingModelId: run.embedding_model_id,
        modelArtifactSha256: run.model_artifact_sha256,
        clusters: runClusters.map((cluster) => ({
          clusterId: cluster.cluster_id,
          embeddingSha256:
            cluster.embedding === null
              ? null
              : crypto.createHash("sha256").update(cluster.embedding).digest("hex"),
          speechMs: cluster.speech_ms,
          windowCount: cluster.window_count,
          qualityScore: cluster.quality_score,
        })),
      });
      for (const cluster of runClusters) {
        let embedding = null;
        try {
          embedding =
            cluster.embedding === null
              ? null
              : SpeakerIdentityRepository.decodeEmbedding(cluster.embedding, 512);
        } catch {
          embedding = null;
        }
        clusters.push({
          evidenceRunId: run.id,
          clusterId: cluster.cluster_id,
          modelId: run.embedding_model_id,
          embedding,
          speechMs: cluster.speech_ms,
          windowCount: cluster.window_count,
          qualityScore: cluster.quality_score,
        });
      }
    }
    evidenceRuns.sort((left, right) => left.trackId.localeCompare(right.trackId));
    clusters.sort(
      (left, right) =>
        left.evidenceRunId.localeCompare(right.evidenceRunId) ||
        left.clusterId.localeCompare(right.clusterId)
    );
    const diarizationRevision = crypto
      .createHash("sha256")
      .update(JSON.stringify(evidenceRuns))
      .digest("hex");
    const rawProfiles = this.statements.listIdentityResolutionProfiles.all(policy.modelId);
    const profileRevisionInput = rawProfiles.map((sample) => ({
      id: sample.id,
      personId: sample.person_id,
      isSelf: sample.is_self === 1,
      modelId: sample.model_id,
      embeddingSha256: crypto.createHash("sha256").update(sample.embedding).digest("hex"),
      sourceClusterId: sample.source_cluster_id,
      sourceKind: sample.source_kind,
      speechMs: sample.speech_ms,
      windowCount: sample.window_count,
      createdAt: sample.created_at,
    }));
    const profileRevision = crypto
      .createHash("sha256")
      .update(JSON.stringify(profileRevisionInput))
      .digest("hex");
    const samples = rawProfiles.map((sample) => {
      let embedding = null;
      try {
        embedding = SpeakerIdentityRepository.decodeEmbedding(sample.embedding, 512);
      } catch {
        embedding = null;
      }
      return {
        id: sample.id,
        personId: sample.person_id,
        isSelf: sample.is_self === 1,
        modelId: sample.model_id,
        embedding,
      };
    });
    return {
      eligible: true,
      reason: null,
      sessionId: safeSessionId,
      diarizationRevision,
      profileRevision,
      evidenceRunIds: evidenceRuns.map((run) => run.id),
      clusters,
      samples,
    };
  }

  enqueueSpeakerIdentityResolutionJob(
    sessionId,
    { at = Date.now(), policy = SPEAKER_IDENTITY_RESOLUTION_POLICY } = {}
  ) {
    const safeAt = assertNonNegativeInteger(at, "at");
    assertExactIdentityResolutionPolicy(policy);
    const snapshot = this.getSpeakerIdentityResolutionSnapshot({ sessionId, at: safeAt, policy });
    if (!snapshot.eligible) return { enqueued: 0, job: null, reason: snapshot.reason };
    const inputHash = buildIdentityResolutionJobKey({
      sessionId: snapshot.sessionId,
      diarizationRevision: snapshot.diarizationRevision,
      profileRevision: snapshot.profileRevision,
      policyId: policy.id,
    });
    const values = {
      id: derivedId("job_resolve_identities", inputHash),
      sessionId: snapshot.sessionId,
      inputHash,
      policyId: policy.id,
      createdAt: safeAt,
    };
    const inserted = this.statements.insertIdentityResolutionJob.run(values).changes;
    const job = this.statements.getIdentityResolutionJob.get(values);
    if (!job) throw new Error("identity resolution job insert was not durable");
    return { enqueued: inserted, job, reason: null, snapshot };
  }

  commitDiarizationRun(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("diarization commit input is required");
    }
    if (
      typeof input.expectedRevision !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.expectedRevision)
    ) {
      throw new TypeError("expectedRevision must be a lowercase SHA-256 digest");
    }
    const validatedAt = assertNonNegativeInteger(input.validatedAt, "validatedAt");
    if (
      !input.speakerProcessingPolicy ||
      typeof input.speakerProcessingPolicy.evaluate !== "function"
    ) {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    const run = input.run;
    if (!run || typeof run !== "object" || Array.isArray(run)) {
      throw new TypeError("diarization run is required");
    }
    const normalizedRun = {
      id: assertId(run.id, "run.id"),
      sessionId: assertId(run.sessionId, "run.sessionId"),
      trackId: assertId(run.trackId, "run.trackId"),
      evidenceRevision: run.evidenceRevision,
      policyId: assertId(run.policyId, "run.policyId"),
      diarizerModelId: assertDiarizationModelId(run.diarizerModelId, "run.diarizerModelId"),
      embeddingModelId: assertDiarizationModelId(run.embeddingModelId, "run.embeddingModelId"),
      modelArtifactSha256: run.modelArtifactSha256,
      embeddingDimension: run.embeddingDimension,
      sampleRate: run.sampleRate,
      inputVersion: run.inputVersion,
      executionDevice: run.executionDevice,
      createdAt: assertNonNegativeInteger(run.createdAt, "run.createdAt"),
      completedAt: assertNonNegativeInteger(run.completedAt, "run.completedAt"),
    };
    if (
      normalizedRun.evidenceRevision !== input.expectedRevision ||
      !/^[0-9a-f]{64}$/.test(normalizedRun.evidenceRevision) ||
      !/^[0-9a-f]{64}$/.test(normalizedRun.modelArtifactSha256) ||
      normalizedRun.embeddingDimension !== 512 ||
      normalizedRun.sampleRate !== 16_000 ||
      normalizedRun.inputVersion !== 1 ||
      normalizedRun.executionDevice !== "cpu" ||
      normalizedRun.completedAt < normalizedRun.createdAt
    ) {
      throw new TypeError("invalid diarization run metadata");
    }
    if (!Array.isArray(input.clusters) || !Array.isArray(input.turns)) {
      throw new TypeError("diarization clusters and turns must be arrays");
    }
    if (input.clusters.length === 0 && input.turns.length > 0) {
      throw new TypeError("diarization turns require clusters");
    }
    const clusterLabels = new Map();
    const clusters = input.clusters.map((cluster) => {
      const id = assertId(cluster?.id, "cluster.id");
      const localLabel = assertId(cluster?.localLabel, "cluster.localLabel");
      const speechMs = assertNonNegativeInteger(cluster.speechMs, "cluster.speechMs");
      const windowCount = assertNonNegativeInteger(cluster.windowCount, "cluster.windowCount");
      const qualityScore = assertOptionalUnitScore(cluster.qualityScore, "cluster.qualityScore");
      const embedding =
        cluster.embedding === null ? null : encodeDiarizationEmbedding(cluster.embedding);
      if (
        (windowCount === 0 && (speechMs !== 0 || embedding !== null || qualityScore !== null)) ||
        (windowCount > 0 && (embedding === null || qualityScore === null))
      ) {
        throw new TypeError("diarization cluster aggregate is inconsistent");
      }
      const normalized = {
        id,
        localLabel,
        embedding,
        speechMs,
        windowCount,
        qualityScore,
        firstAppearanceAt: assertNonNegativeInteger(
          cluster.firstAppearanceAt,
          "cluster.firstAppearanceAt"
        ),
      };
      if (clusterLabels.has(id) || [...clusterLabels.values()].includes(localLabel)) {
        throw new TypeError("diarization clusters must be unique");
      }
      clusterLabels.set(id, localLabel);
      return normalized;
    });
    const turnIds = new Set();
    const turns = input.turns.map((turn) => {
      const id = assertId(turn?.id, "turn.id");
      const clusterId = assertId(turn?.clusterId, "turn.clusterId");
      const localLabel = assertId(turn?.localLabel, "turn.localLabel");
      if (turnIds.has(id) || clusterLabels.get(clusterId) !== localLabel) {
        throw new TypeError("turn cluster identity is invalid");
      }
      turnIds.add(id);
      if (!new Set(["none", "possible", "confirmed"]).has(turn.echoState)) {
        throw new TypeError("invalid turn echo state");
      }
      if ((turn.echoState === "confirmed") !== (turn.excludedFromCentroid === true)) {
        throw new TypeError("confirmed echo must be excluded from the centroid exactly");
      }
      return {
        id,
        clusterId,
        chunkId: assertId(turn.chunkId, "turn.chunkId"),
        transcriptSegmentId:
          turn.transcriptSegmentId === null
            ? null
            : assertId(turn.transcriptSegmentId, "turn.transcriptSegmentId"),
        turnIndex: assertNonNegativeInteger(turn.turnIndex, "turn.turnIndex"),
        rawLabel: assertId(turn.rawLabel, "turn.rawLabel"),
        startedAt: assertNonNegativeInteger(turn.startedAt, "turn.startedAt"),
        endedAt: assertNonNegativeInteger(turn.endedAt, "turn.endedAt"),
        embedding: encodeDiarizationEmbedding(turn.embedding),
        echoState: turn.echoState,
        duplicateOfTurnId:
          turn.duplicateOfTurnId === null
            ? null
            : assertId(turn.duplicateOfTurnId, "turn.duplicateOfTurnId"),
        excludedFromCentroid: turn.excludedFromCentroid === true,
      };
    });
    const rawLinks = input.segmentLinks ?? [];
    if (!Array.isArray(rawLinks)) throw new TypeError("segmentLinks must be an array");
    const segmentLinks = rawLinks.map((link) => ({
      clusterId: assertId(link?.clusterId, "link.clusterId"),
      transcriptSegmentId: assertId(link?.transcriptSegmentId, "link.transcriptSegmentId"),
    }));
    return this._commitDiarizationRun({
      expectedRevision: input.expectedRevision,
      validatedAt,
      speakerProcessingPolicy: input.speakerProcessingPolicy,
      run: normalizedRun,
      clusters,
      turns,
      segmentLinks,
    });
  }

  isSessionReadyForPostProcessing(sessionId) {
    return this._inspectSessionTranscriptReadiness(assertId(sessionId, "sessionId")).complete;
  }

  markSessionProcessing(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    this.statements.markSessionProcessing.run(safeSessionId);
    return this.getSession(safeSessionId);
  }

  refreshSessionReadiness(sessionId, at = Date.now()) {
    return this._refreshSessionReadiness(assertId(sessionId, "sessionId"), assertInteger(at, "at"));
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

  getVisibleTranscript(sessionId) {
    return this.listTranscriptSegments(sessionId);
  }

  listTranscriptHistory(sessionId) {
    return this.statements.listTranscriptHistory.all(assertId(sessionId, "sessionId"));
  }

  listPreviewTranscriptContext({ sessionId, trackId, from, to, limit = 16 } = {}) {
    const safeFrom = assertNonNegativeInteger(from, "from");
    const safeTo = assertNonNegativeInteger(to, "to");
    const safeLimit = assertNonNegativeInteger(limit, "limit");
    if (safeTo <= safeFrom) throw new RangeError("preview context requires from < to");
    if (safeLimit < 1 || safeLimit > 64) {
      throw new RangeError("preview context limit must be between 1 and 64");
    }
    return this.statements.listPreviewTranscriptContext.all({
      sessionId: assertId(sessionId, "sessionId"),
      trackId: assertId(trackId, "trackId"),
      from: safeFrom,
      to: safeTo,
      limit: safeLimit,
    });
  }

  listAllTranscriptSegments(sessionId) {
    return this.listTranscriptHistory(sessionId);
  }

  getTranscriptSegment(segmentId) {
    return this.statements.getTranscriptSegment.get(assertId(segmentId, "segmentId")) ?? null;
  }

  reconcileTranscriptTransaction(sessionId, reconcile) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof reconcile !== "function") throw new TypeError("reconcile must be a function");
    return this._reconcileTranscript(safeSessionId, reconcile);
  }

  dedupeTranscriptTransaction(sessionId, selectDuplicates) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof selectDuplicates !== "function") {
      throw new TypeError("selectDuplicates must be a function");
    }
    return this._dedupeTranscript(safeSessionId, selectDuplicates);
  }

  getTranscriptPrompt(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const chronological = this.statements.listTranscriptPromptSegments
      .all(safeSessionId)
      .reverse()
      .map((row) => row.text.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .join(" ");
    const context = takeCodePointTail(chronological, TRANSCRIPT_CONTEXT_CODE_POINT_LIMIT);
    const instruction =
      "这是真实的中英双语对话。中文写中文，English terms stay in English; do not translate or invent names.";
    return takeCodePointTail(
      context ? `${instruction}\nRecent context: ${context}` : instruction,
      TRANSCRIPT_PROMPT_CODE_POINT_LIMIT
    );
  }

  commitChunkTranscript({ chunk, result, modelVersion, completedAt }) {
    if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
    assertId(chunk.id, "audioChunkId");
    if (!result || typeof result !== "object") throw new TypeError("result is required");
    if (result.noSpeech !== true) {
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new TypeError("transcript text is required");
      }
      if (
        typeof result.confidence !== "number" ||
        !Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 1
      ) {
        throw new RangeError("transcript confidence must be between zero and one");
      }
    }
    if (typeof modelVersion !== "string" || !modelVersion.trim() || modelVersion.length > 128) {
      throw new TypeError("modelVersion must be a non-empty string of at most 128 characters");
    }
    assertInteger(completedAt, "completedAt");
    return this._commitChunkTranscript({
      chunk,
      result:
        result.noSpeech === true
          ? { noSpeech: true }
          : { text: result.text.trim(), confidence: result.confidence },
      modelVersion: modelVersion.trim(),
      completedAt,
    });
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
    let wakeModelIds = [];
    if (hasIsSelf) {
      const selfActuallyChanges = input.isSelf
        ? existing?.is_self !== 1 ||
          this.statements.countOtherSelfPeople.get(safePersonId).count > 0
        : existing?.is_self === 1;
      if (selfActuallyChanges) {
        const models = new Set(
          this.statements.listPersonProfileModels.all(safePersonId).map((row) => row.model_id)
        );
        if (input.isSelf) {
          for (const row of this.statements.listSelfProfileModels.all()) models.add(row.model_id);
        }
        wakeModelIds = [...models].sort();
      }
    }
    this._renamePerson({ ...update, wakeModelIds });
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
      identity: this.speakerIdentityRepository.getPersonIdentityDetail(personId),
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

  pauseCaptureForLowDisk(input) {
    return this.captureEvidenceStore.pauseCaptureForLowDisk(input);
  }

  suspendCaptureForPower(input) {
    return this.captureEvidenceStore.suspendCaptureForPower(input);
  }

  resumeCaptureAfterPower(input) {
    return this.captureEvidenceStore.resumeCaptureAfterPower(input);
  }

  confirmPowerRestorations(input) {
    return this.captureEvidenceStore.confirmPowerRestorations(input);
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

  tombstoneChunk(id, deletedAt = Date.now(), { storageDeleted = false } = {}) {
    if (typeof storageDeleted !== "boolean") throw new TypeError("storageDeleted must be boolean");
    return this.captureEvidenceStore.tombstoneChunk(
      assertId(id, "audioChunkId"),
      assertInteger(deletedAt, "deletedAt"),
      { storageDeleted }
    );
  }

  promoteSoonExpiringAudioJobs(after, before) {
    return this.captureEvidenceStore.promoteSoonExpiringAudioJobs(
      assertInteger(after, "after"),
      assertInteger(before, "before")
    );
  }

  promoteCompressionJobsForStoragePressure(at = Date.now()) {
    return this.captureEvidenceStore.promoteCompressionJobsForStoragePressure(
      assertInteger(at, "at")
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

  listRetiredArtifactBacklog() {
    return this.captureEvidenceStore.listRetiredArtifactBacklog();
  }

  recoverOpenSessions(at = Date.now()) {
    return this._recoverOpenSessions(assertInteger(at, "at"));
  }

  getStorageUsageSince(since) {
    const row = this.statements.getStorageUsageSince.get(assertInteger(since, "since"));
    return {
      writtenBytes24h: row.written_bytes,
      compressedBytes24h: row.compressed_bytes,
      netGrowthBytes24h: row.net_growth_bytes,
    };
  }

  getSessionTimeline(id) {
    const sessionId = assertId(id, "sessionId");
    const session = this.getSession(sessionId);
    if (!session) return null;
    const gaps = this.statements.listSessionTimelineGaps.all(sessionId);
    const gapsByTrack = new Map();
    for (const gap of gaps) {
      const trackGaps = gapsByTrack.get(gap.track_id) ?? [];
      trackGaps.push(gap);
      gapsByTrack.set(gap.track_id, trackGaps);
    }
    const tracks = this.statements.listSessionTimelineTracks
      .all(sessionId)
      .map((track) => ({ ...track, gaps: gapsByTrack.get(track.id) ?? [] }));
    return {
      session_id: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      status: session.status,
      processing_state: session.processing_state,
      timeline_version: session.timeline_version,
      finalized_at: session.finalized_at,
      ready_at: session.ready_at,
      tracks,
      gaps,
      chunks: this.statements.listSessionTimelineChunks.all(sessionId).map(toPublicAudioChunk),
      segments: this.listTranscriptSegments(sessionId),
      processing_counts: this.statements.getSessionProcessingCounts.get(sessionId),
    };
  }

  getRuntimeProcessingStatus() {
    const totals = emptyRuntimeCounts();
    const stages = new Map();
    const deferralGroups = new Map();
    for (const row of this.statements.listRuntimeProcessingGroups.all()) {
      const count = Number(row.count);
      const state = runtimeQueueState(row.state);
      const stage = runtimeJobStage(row);
      const stageCounts = stages.get(stage) ?? emptyRuntimeCounts();
      totals[state] += count;
      totals.total += count;
      stageCounts[state] += count;
      stageCounts.total += count;
      stages.set(stage, stageCounts);

      const reason = typeof row.blocked_reason === "string" ? row.blocked_reason.trim() : "";
      if ((row.state === "retry" || row.state === "blocked") && reason) {
        const key = JSON.stringify([stage, row.job_type, row.state, reason]);
        const existing = deferralGroups.get(key);
        const nextRetryAt = row.next_retry_at === null ? null : Number(row.next_retry_at);
        if (existing) {
          existing.count += count;
          if (
            nextRetryAt !== null &&
            (existing.nextRetryAt === null || nextRetryAt < existing.nextRetryAt)
          ) {
            existing.nextRetryAt = nextRetryAt;
          }
        } else {
          deferralGroups.set(key, {
            stage,
            jobType: row.job_type,
            state: row.state,
            reason,
            count,
            nextRetryAt,
          });
        }
      }
    }
    const byStage = Object.fromEntries(
      [...stages.entries()].sort(([left], [right]) => compareStableIds(left, right))
    );
    const deferrals = [...deferralGroups.values()].sort((left, right) => {
      for (const key of ["stage", "jobType", "reason", "state"]) {
        const result = compareStableIds(left[key], right[key]);
        if (result !== 0) return result;
      }
      return 0;
    });
    const backlog = this.statements.getRuntimeTranscriptionBacklog.get();
    const oldest = this.statements.getRuntimeOldestProcessingJob.get();
    const active = this.statements.getActiveProcessingExecutionDevice.get();
    const coverage = this.statements.getRuntimeFinalCoverage.get();
    const totalMs = Number(coverage.total_ms);
    const provisionalMs = coveredDurationMs(
      this.statements.listRuntimeProvisionalCoverageRanges.all(),
      "chunk_id"
    );
    return {
      ...totals,
      byStage,
      deferrals,
      backlogMs: Number(backlog.backlog_ms),
      oldestCreatedAt: oldest.oldest_created_at ?? null,
      activeExecutionDevice: active?.execution_device ?? null,
      finalCoveragePct:
        totalMs > 0 ? Math.round((Number(coverage.final_ms) / totalMs) * 100) : null,
      provisionalCoveragePct:
        totalMs > 0 ? Math.min(100, Math.round((provisionalMs / totalMs) * 100)) : null,
    };
  }

  checkpointForMigration() {
    if (!this.db?.open) throw new Error("repository is closed");
    if (this.dbPath === ":memory:") return { busy: 0, log: 0, checkpointed: 0 };
    const result = this.db.pragma("wal_checkpoint(TRUNCATE)")[0] ?? {};
    if (Number(result.busy) !== 0) throw new Error("repository WAL checkpoint is busy");
    return result;
  }

  relocateDataRoot({ fromRecordingsRoot, toRecordingsRoot }) {
    if (
      typeof fromRecordingsRoot !== "string" ||
      !path.isAbsolute(fromRecordingsRoot) ||
      typeof toRecordingsRoot !== "string" ||
      !path.isAbsolute(toRecordingsRoot)
    ) {
      throw new TypeError("recordings roots must be absolute");
    }
    const sourceRoot = path.resolve(fromRecordingsRoot);
    const targetRoot = path.resolve(toRecordingsRoot);
    const relativeInside = (root, candidate) => {
      const relative = path.relative(root, candidate);
      return relative !== "" &&
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
        ? relative
        : null;
    };
    const relocate = (locator) => {
      if (locator === null || locator === undefined) return null;
      if (typeof locator !== "string" || !path.isAbsolute(locator)) {
        throw new Error("audio locator escapes the previous recordings root");
      }
      const canonical = path.resolve(locator);
      if (relativeInside(targetRoot, canonical) !== null) return canonical;
      const relative = relativeInside(sourceRoot, canonical);
      if (relative === null) {
        throw new Error("audio locator escapes the previous recordings root");
      }
      return path.resolve(targetRoot, relative);
    };
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, path, retired_path FROM audio_chunks").all();
      const updates = rows.map((row) => ({
        id: row.id,
        path: row.path.startsWith("tombstone:") ? row.path : relocate(row.path),
        retiredPath: relocate(row.retired_path),
      }));
      const update = this.db.prepare(
        "UPDATE audio_chunks SET path = @path, retired_path = @retiredPath WHERE id = @id"
      );
      for (const row of updates) update.run(row);
      return { relocated: updates.length };
    })();
  }

  createSpeakerCluster(input) {
    return this.speakerIdentityRepository.createCluster(input);
  }

  replaceSpeakerClusterSegments(clusterId, transcriptSegmentIds) {
    return this.speakerIdentityRepository.replaceClusterSegments(clusterId, transcriptSegmentIds);
  }

  getSpeakerCluster(clusterId) {
    return this.speakerIdentityRepository.getCluster(clusterId);
  }

  getSpeakerClusterView(clusterId) {
    return this.speakerIdentityRepository.getClusterView(clusterId);
  }

  listSessionSpeakerClusters(sessionId) {
    return this.speakerIdentityRepository.listSessionClusters(sessionId);
  }

  listSessionSpeakerClusterViews(sessionId) {
    return this.speakerIdentityRepository.listSessionClusterViews(sessionId);
  }

  listVoiceProfiles(modelId) {
    return this.speakerIdentityRepository.listProfiles(modelId);
  }

  addVoiceProfileSample(input) {
    return this.speakerIdentityRepository.addProfileSample(input);
  }

  getVoiceProfileAggregate(personId, modelId) {
    return this.speakerIdentityRepository.getProfileAggregate(personId, modelId);
  }

  replaceVoiceEnrollmentSamples(input) {
    return this.speakerIdentityRepository.replaceEnrollmentSamples(input);
  }

  importLegacyVoiceProfile(input) {
    return this.speakerIdentityRepository.importLegacyProfile(input);
  }

  hasVoiceProfileImportMarker(markerKey) {
    return this.speakerIdentityRepository.hasImportMarker(markerKey);
  }

  confirmSpeakerLink(input) {
    return this.speakerIdentityRepository.confirmLink(input);
  }

  confirmSpeakerLinkWithOutcome(input) {
    return this.speakerIdentityRepository.confirmLinkWithOutcome(input);
  }

  runSpeakerCorrectionTransaction(work) {
    if (typeof work !== "function")
      throw new TypeError("speaker correction work must be a function");
    return this.db.transaction(work).immediate();
  }

  rejectSpeakerSuggestion(input) {
    return this._rejectSpeakerSuggestion.immediate(input);
  }

  applySystemSpeakerResolution(input) {
    return this.speakerIdentityRepository.applySystemResolution(input);
  }

  applySystemSpeakerResolutions(input) {
    return this.speakerIdentityRepository.applySystemResolutions(input);
  }

  listRejectedSpeakerPersonIds(clusterId, revision) {
    return this.speakerIdentityRepository.listRejectedPersonIds(clusterId, revision);
  }

  listSpeakerResolutionHistory(clusterId) {
    return this.speakerIdentityRepository.listResolutionHistory(clusterId);
  }

  undoSpeakerCorrection(clusterId) {
    return this.speakerIdentityRepository.undoLastCorrection(clusterId);
  }

  mergeSpeakerPeople(input) {
    return this.speakerIdentityRepository.mergePeople(input);
  }

  listSpeakerCorrections(clusterId) {
    return this.speakerIdentityRepository.listCorrections(clusterId);
  }

  close() {
    if (this.db.open) this.db.close();
  }
}

module.exports = JarvisRepository;
