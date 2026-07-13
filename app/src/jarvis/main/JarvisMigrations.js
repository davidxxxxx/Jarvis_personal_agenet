const TARGET_VERSION = 10;
const FLAC_ENCODER_VERSION = "ffmpeg-flac-v1";

const PROCESSING_JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
    chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL,
    input_version INTEGER NOT NULL DEFAULT 1,
    model_version TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`;

const PROCESSING_JOBS_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_chunk_input
  ON processing_jobs(job_type, chunk_id, input_hash, input_version, model_version)
  WHERE chunk_id IS NOT NULL AND job_type <> 'compress_chunk';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_compress_identity
  ON processing_jobs(chunk_id, model_version)
  WHERE chunk_id IS NOT NULL AND job_type = 'compress_chunk';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_global_input
  ON processing_jobs(job_type, input_hash, input_version, model_version)
  WHERE chunk_id IS NULL;
`;

const MIGRATION_BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('recording','paused','finalizing','completed','recovered','failed')),
    mic_device_id TEXT,
    language TEXT NOT NULL DEFAULT 'zh',
    created_at INTEGER NOT NULL,
    capture_mode TEXT NOT NULL DEFAULT 'mic',
    retention_mode TEXT NOT NULL DEFAULT 'speech_triggered',
    capture_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"preRollMs":2000,"postRollMs":3000,"mergeGapMs":3000}',
    processing_state TEXT NOT NULL DEFAULT 'pending',
    timeline_version INTEGER NOT NULL DEFAULT 1,
    finalized_at INTEGER,
    ready_at INTEGER,
    stop_reason TEXT,
    durable_boundary_at INTEGER
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
    transcription_status TEXT NOT NULL DEFAULT 'pending',
    track_id TEXT,
    source_type TEXT NOT NULL DEFAULT 'mic',
    sequence_number INTEGER NOT NULL DEFAULT 0,
    write_state TEXT NOT NULL DEFAULT 'committed',
    deleted_at INTEGER,
    format TEXT NOT NULL DEFAULT 'wav',
    file_sha256 TEXT,
    sample_rate INTEGER NOT NULL DEFAULT 24000,
    channels INTEGER NOT NULL DEFAULT 1,
    retired_path TEXT,
    retired_format TEXT,
    retired_file_sha256 TEXT
  );
`;

function columns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  );
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columns(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function rebuildLegacyProcessingJobs(db) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processing_jobs'")
    .get()?.sql;
  if (!sql?.replace(/\s+/g, "").includes("UNIQUE(job_type,input_hash)")) return;

  db.exec(`
    ALTER TABLE processing_jobs RENAME TO processing_jobs_v1;
    ${PROCESSING_JOBS_SCHEMA}
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, next_retry_at,
      lease_owner, lease_expires_at, error_code, created_at, completed_at
    )
    SELECT
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, COALESCE(model_version, ''), attempt_count, next_retry_at,
      lease_owner, lease_expires_at, error_code, created_at, completed_at
    FROM processing_jobs_v1;
    DROP TABLE processing_jobs_v1;
  `);
}

function deduplicateCompressionJobs(db) {
  const groups = db
    .prepare(
      `SELECT chunk_id, model_version
       FROM processing_jobs
       WHERE job_type = 'compress_chunk' AND chunk_id IS NOT NULL
       GROUP BY chunk_id, model_version
       HAVING count(*) > 1
       ORDER BY chunk_id, model_version`
    )
    .all();
  const list = db.prepare(
    `SELECT * FROM processing_jobs
     WHERE job_type = 'compress_chunk' AND chunk_id = ? AND model_version = ?`
  );
  const update = db.prepare(
    `UPDATE processing_jobs
     SET attempt_count = ?, error_code = ?
     WHERE id = ?`
  );
  const remove = db.prepare("DELETE FROM processing_jobs WHERE id = ?");
  const terminalRank = (job) => {
    if (job.state === "completed") return 0;
    if (["failed", "cancelled", "audio_expired_before_processing"].includes(job.state)) return 1;
    return 2;
  };
  for (const group of groups) {
    const jobs = list.all(group.chunk_id, group.model_version).sort((left, right) => {
      const rank = terminalRank(left) - terminalRank(right);
      if (rank !== 0) return rank;
      const completion = (right.completed_at ?? -1) - (left.completed_at ?? -1);
      if (completion !== 0) return completion;
      const created = right.created_at - left.created_at;
      return created !== 0 ? created : left.id.localeCompare(right.id);
    });
    const keeper = jobs[0];
    const attemptCount = Math.max(...jobs.map((job) => job.attempt_count));
    const diagnostic = jobs.find((job) => job.error_code !== null)?.error_code ?? null;
    update.run(attemptCount, keeper.error_code ?? diagnostic, keeper.id);
    for (const duplicate of jobs.slice(1)) remove.run(duplicate.id);
  }
}

function applyJarvisMigrations(db, { now = Date.now } = {}) {
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion >= TARGET_VERSION) {
    return { fromVersion, toVersion: fromVersion };
  }

  db.transaction(() => {
    const migratedAt = now();
    db.exec(MIGRATION_BASE_SCHEMA);

    addColumn(db, "sessions", "capture_mode TEXT NOT NULL DEFAULT 'mic'");
    // Existing sessions were captured continuously. Keep that historical meaning while
    // repository-created sessions explicitly opt into the new speech-triggered default.
    addColumn(db, "sessions", "retention_mode TEXT NOT NULL DEFAULT 'continuous'");
    addColumn(
      db,
      "sessions",
      `capture_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"preRollMs":2000,"postRollMs":3000,"mergeGapMs":3000}'`
    );
    addColumn(db, "sessions", "processing_state TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, "sessions", "timeline_version INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "sessions", "finalized_at INTEGER");
    addColumn(db, "sessions", "ready_at INTEGER");
    addColumn(db, "sessions", "stop_reason TEXT");
    addColumn(db, "sessions", "durable_boundary_at INTEGER");
    addColumn(db, "audio_chunks", "track_id TEXT");
    addColumn(db, "audio_chunks", "source_type TEXT NOT NULL DEFAULT 'mic'");
    addColumn(db, "audio_chunks", "sequence_number INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "audio_chunks", "write_state TEXT NOT NULL DEFAULT 'committed'");
    addColumn(db, "audio_chunks", "deleted_at INTEGER");
    addColumn(db, "audio_chunks", "format TEXT NOT NULL DEFAULT 'wav'");
    addColumn(db, "audio_chunks", "file_sha256 TEXT");
    addColumn(db, "audio_chunks", "sample_rate INTEGER NOT NULL DEFAULT 24000");
    addColumn(db, "audio_chunks", "channels INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "audio_chunks", "retired_path TEXT");
    addColumn(db, "audio_chunks", "retired_format TEXT");
    addColumn(db, "audio_chunks", "retired_file_sha256 TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('mic','system')),
        device_id TEXT,
        device_label TEXT,
        strategy TEXT,
        sample_rate INTEGER NOT NULL,
        channels INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        state TEXT NOT NULL,
        UNIQUE(session_id, source_type)
      );
      CREATE TABLE IF NOT EXISTS audio_gaps (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reason TEXT NOT NULL,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        restored_device_id TEXT,
        restored_device_label TEXT,
        restored_strategy TEXT,
        average_level REAL,
        peak_level REAL
      );
    `);
    addColumn(db, "audio_gaps", "restored_device_id TEXT");
    addColumn(db, "audio_gaps", "restored_device_label TEXT");
    addColumn(db, "audio_gaps", "restored_strategy TEXT");
    addColumn(db, "audio_gaps", "average_level REAL");
    addColumn(db, "audio_gaps", "peak_level REAL");
    db.exec(PROCESSING_JOBS_SCHEMA);
    rebuildLegacyProcessingJobs(db);
    deduplicateCompressionJobs(db);
    db.exec(`
      DROP INDEX IF EXISTS idx_processing_jobs_chunk_input;
      DROP INDEX IF EXISTS idx_processing_jobs_compress_identity;
    `);
    db.exec(PROCESSING_JOBS_INDEXES);
    db.prepare(
      `INSERT OR IGNORE INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      )
      SELECT
        'job_compress_' || lower(hex(randomblob(16))),
        session_id, track_id, id, 'compress_chunk', 'pending',
        sha256, 1, ?, ?
      FROM audio_chunks
      WHERE deleted_at IS NULL
        AND expires_at > ?
        AND format = 'wav'
        AND write_state = 'committed'
        AND track_id IS NOT NULL
        AND length(path) > 0
        AND length(sha256) > 0
        AND duration_ms > 0
        AND sample_rate = 24000
        AND channels = 1`
    ).run(FLAC_ENCODER_VERSION, migratedAt, migratedAt);
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_usage_events (
        kind TEXT NOT NULL CHECK(kind IN ('wav_written','flac_written')),
        chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
        bytes INTEGER NOT NULL CHECK(bytes > 0),
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(kind, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_storage_usage_events_time
      ON storage_usage_events(occurred_at, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_chunks_track_sequence
      ON audio_chunks(track_id, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_audio_gaps_track_ended_started
      ON audio_gaps(track_id, ended_at, started_at);
    `);

    db.pragma(`user_version = ${TARGET_VERSION}`);
  })();

  return { fromVersion, toVersion: TARGET_VERSION };
}

module.exports = { applyJarvisMigrations, TARGET_VERSION, FLAC_ENCODER_VERSION };
