const TARGET_VERSION = 1;

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
    processing_state TEXT NOT NULL DEFAULT 'pending',
    timeline_version INTEGER NOT NULL DEFAULT 1,
    finalized_at INTEGER,
    ready_at INTEGER
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
    deleted_at INTEGER
  );
`;

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columns(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function applyJarvisMigrations(db, { now = Date.now } = {}) {
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion >= TARGET_VERSION) {
    return { fromVersion, toVersion: fromVersion };
  }

  db.transaction(() => {
    db.exec(MIGRATION_BASE_SCHEMA);

    addColumn(db, "sessions", "capture_mode TEXT NOT NULL DEFAULT 'mic'");
    addColumn(db, "sessions", "processing_state TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, "sessions", "timeline_version INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "sessions", "finalized_at INTEGER");
    addColumn(db, "sessions", "ready_at INTEGER");
    addColumn(db, "audio_chunks", "track_id TEXT");
    addColumn(db, "audio_chunks", "source_type TEXT NOT NULL DEFAULT 'mic'");
    addColumn(db, "audio_chunks", "sequence_number INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "audio_chunks", "write_state TEXT NOT NULL DEFAULT 'committed'");
    addColumn(db, "audio_chunks", "deleted_at INTEGER");

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
        recovery_attempts INTEGER NOT NULL DEFAULT 0
      );
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
        model_version TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(job_type, input_hash)
      );
    `);

    db.pragma(`user_version = ${TARGET_VERSION}`);
    void now();
  })();

  return { fromVersion, toVersion: TARGET_VERSION };
}

module.exports = { applyJarvisMigrations, TARGET_VERSION };
