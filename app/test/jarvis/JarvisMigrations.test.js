const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

function columnNames(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

test("creates dual-track evidence schema idempotently in an empty database", () => {
  const db = new Database(":memory:");

  try {
    const first = applyJarvisMigrations(db, { now: () => 1000 });
    const second = applyJarvisMigrations(db, { now: () => 2000 });

    assert.deepEqual(first, { fromVersion: 0, toVersion: TARGET_VERSION });
    assert.deepEqual(second, {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    assert.ok(tables.includes("sessions"));
    assert.ok(tables.includes("audio_chunks"));
    assert.ok(tables.includes("audio_tracks"));
    assert.ok(tables.includes("audio_gaps"));
    assert.ok(tables.includes("processing_jobs"));
    assert.ok(
      db
        .prepare("PRAGMA index_list(audio_gaps)")
        .all()
        .some((index) => index.name === "idx_audio_gaps_track_ended_started")
    );

    assert.deepEqual(
      columnNames(db, "sessions").filter((name) =>
        [
          "capture_mode",
          "processing_state",
          "timeline_version",
          "finalized_at",
          "ready_at",
        ].includes(name)
      ),
      ["capture_mode", "processing_state", "timeline_version", "finalized_at", "ready_at"]
    );
    assert.deepEqual(
      columnNames(db, "audio_chunks").filter((name) =>
        ["track_id", "source_type", "sequence_number", "write_state", "deleted_at"].includes(name)
      ),
      ["track_id", "source_type", "sequence_number", "write_state", "deleted_at"]
    );

    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 10, 'recording', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'system', 24000, 1, 10, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES
        ('c1', 's1', 't1', 'system', 0, 'c1.wav', 10, 20, 10, 'same', 30),
        ('c2', 's1', 't1', 'system', 1, 'c2.wav', 20, 30, 10, 'same', 40);
      INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES
        ('j1', 's1', 't1', 'c1', 'transcribe_chunk', 'pending', 'same', 1, '', 20),
        ('j2', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 30),
        ('g1', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, '', 40);
    `);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('j3', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 50)`
        )
        .run()
    );
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('g2', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, '', 50)`
        )
        .run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('g3', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, 'model-2', 60)`
    ).run();
  } finally {
    db.close();
  }
});

test("preserves legacy sessions and chunks while backfilling evidence defaults", () => {
  const db = new Database(":memory:");

  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        transcription_status TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO sessions VALUES ('s1', 10, 'completed')").run();
    db.prepare(
      "INSERT INTO audio_chunks VALUES ('c1', 's1', 'x.wav', 10, 20, 10, 'abc', 30, 'pending')"
    ).run();
    db.prepare(
      "INSERT INTO audio_chunks VALUES ('c2', 's1', 'y.wav', 20, 30, 10, 'def', 40, 'pending')"
    ).run();

    applyJarvisMigrations(db, { now: () => 1000 });

    assert.deepEqual(db.prepare("SELECT * FROM sessions WHERE id = 's1'").get(), {
      id: "s1",
      started_at: 10,
      status: "completed",
      capture_mode: "mic",
      retention_mode: "continuous",
      capture_policy_json:
        '{"schemaVersion":1,"preRollMs":2000,"postRollMs":3000,"mergeGapMs":3000}',
      processing_state: "pending",
      timeline_version: 1,
      finalized_at: null,
      ready_at: null,
      stop_reason: null,
      durable_boundary_at: null,
    });
    assert.deepEqual(db.prepare("SELECT * FROM audio_chunks WHERE id = 'c1'").get(), {
      id: "c1",
      session_id: "s1",
      path: "x.wav",
      started_at: 10,
      ended_at: 20,
      duration_ms: 10,
      sha256: "abc",
      expires_at: 30,
      transcription_status: "pending",
      track_id: null,
      source_type: "mic",
      sequence_number: 0,
      write_state: "committed",
      deleted_at: null,
      format: "wav",
      file_sha256: null,
      sample_rate: 24000,
      channels: 1,
      retired_path: null,
      retired_format: null,
      retired_file_sha256: null,
    });
    assert.equal(db.prepare("SELECT count(*) AS count FROM audio_chunks").get().count, 2);
  } finally {
    db.close();
  }
});

test("upgrades v4 databases with the bounded open-gap lookup index", () => {
  const db = new Database(":memory:");

  try {
    applyJarvisMigrations(db);
    db.exec(`
      DROP INDEX idx_audio_gaps_track_ended_started;
      PRAGMA user_version = 4;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 4, toVersion: TARGET_VERSION });
    assert.ok(
      db
        .prepare("PRAGMA index_list(audio_gaps)")
        .all()
        .some((index) => index.name === "idx_audio_gaps_track_ended_started")
    );
  } finally {
    db.close();
  }
});

test("upgrades committed WAV rows with one idempotent compression job", () => {
  const db = new Database(":memory:");

  try {
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 10, 'completed', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 10, 20, 'ended');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at, format,
        sample_rate, channels
      ) VALUES (
        'c1', 's1', 't1', 'mic', 0, 'c1.wav', 10, 20, 10, 'pcm-hash', 30,
        'wav', 24000, 1
      );
      PRAGMA user_version = 5;
    `);

    applyJarvisMigrations(db, { now: () => 25 });
    db.pragma("user_version = 5");
    applyJarvisMigrations(db, { now: () => 26 });

    assert.deepEqual(
      db
        .prepare(
          `SELECT chunk_id, job_type, state, input_hash, model_version, created_at
           FROM processing_jobs`
        )
        .all(),
      [
        {
          chunk_id: "c1",
          job_type: "compress_chunk",
          state: "pending",
          input_hash: "pcm-hash",
          model_version: "ffmpeg-flac-v1",
          created_at: 25,
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("compression identity rejects the same chunk and encoder version with a different hash", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 0, 'recording', 0);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 0, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES ('c1', 's1', 't1', 'mic', 0, 'c1.wav', 0, 10, 10, 'hash-a', 1000);
      INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('compress-a', 's1', 't1', 'c1', 'compress_chunk', 'pending',
        'hash-a', 1, 'ffmpeg-flac-v1', 10);
    `);

    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (
            id, session_id, track_id, chunk_id, job_type, state,
            input_hash, input_version, model_version, created_at
          ) VALUES ('compress-b', 's1', 't1', 'c1', 'compress_chunk', 'pending',
            'hash-b', 1, 'ffmpeg-flac-v1', 20)`
        )
        .run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('transcribe-b', 's1', 't1', 'c1', 'transcribe_chunk', 'pending',
        'hash-b', 1, 'model-a', 20)`
    ).run();
  } finally {
    db.close();
  }
});

test("v7 deterministically merges duplicate compression identities without touching transcription", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      DROP INDEX idx_processing_jobs_compress_identity;
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 0, 'recording', 0);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 0, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES ('c1', 's1', 't1', 'mic', 0, 'c1.wav', 0, 10, 10, 'hash-a', 1000);
      INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, input_hash,
        input_version, model_version, attempt_count, error_code, created_at, completed_at
      ) VALUES
        ('compress-complete', 's1', 't1', 'c1', 'compress_chunk', 'completed',
          'hash-a', 1, 'ffmpeg-flac-v1', 1, NULL, 10, 30),
        ('compress-retry', 's1', 't1', 'c1', 'compress_chunk', 'retry',
          'hash-b', 1, 'ffmpeg-flac-v1', 4, 'retry-diagnostic', 20, NULL),
        ('transcribe', 's1', 't1', 'c1', 'transcribe_chunk', 'pending',
          'hash-a', 1, 'model-a', 0, NULL, 10, NULL);
      PRAGMA user_version = 6;
    `);

    applyJarvisMigrations(db, { now: () => 200 });

    assert.deepEqual(
      db
        .prepare(
          `SELECT id, state, attempt_count, error_code
           FROM processing_jobs WHERE job_type = 'compress_chunk'`
        )
        .all(),
      [
        {
          id: "compress-complete",
          state: "completed",
          attempt_count: 4,
          error_code: "retry-diagnostic",
        },
      ]
    );
    assert.equal(
      db
        .prepare("SELECT count(*) count FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
        .get().count,
      1
    );
  } finally {
    db.close();
  }
});

test("v7 backfills only complete live committed authoritative WAV metadata", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 0, 'recording', 0);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 0, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at, write_state,
        deleted_at, format, sample_rate, channels
      ) VALUES
        ('valid', 's1', 't1', 'mic', 0, 'valid.wav', 0, 10, 10, 'hash-v', 1000, 'committed', NULL, 'wav', 24000, 1),
        ('writing', 's1', 't1', 'mic', 1, 'writing.wav', 10, 20, 10, 'hash-w', 1000, 'writing', NULL, 'wav', 24000, 1),
        ('failed', 's1', 't1', 'mic', 2, 'failed.wav', 20, 30, 10, 'hash-f', 1000, 'failed', NULL, 'wav', 24000, 1),
        ('deleted', 's1', 't1', 'mic', 3, 'deleted.wav', 30, 40, 10, 'hash-d', 1000, 'committed', 50, 'wav', 24000, 1),
        ('expired', 's1', 't1', 'mic', 4, 'expired.wav', 40, 50, 10, 'hash-e', 200, 'committed', NULL, 'wav', 24000, 1),
        ('flac', 's1', 't1', 'mic', 5, 'flac.flac', 50, 60, 10, 'hash-l', 1000, 'committed', NULL, 'flac', 24000, 1),
        ('incomplete', 's1', NULL, 'mic', 6, 'incomplete.wav', 60, 70, 10, 'hash-i', 1000, 'committed', NULL, 'wav', 24000, 1);
      PRAGMA user_version = 6;
    `);

    applyJarvisMigrations(db, { now: () => 200 });

    assert.deepEqual(
      db
        .prepare(
          "SELECT chunk_id FROM processing_jobs WHERE job_type = 'compress_chunk' ORDER BY chunk_id"
        )
        .all(),
      [{ chunk_id: "valid" }]
    );
  } finally {
    db.close();
  }
});

test("upgrades v1 job identity and enforces track sequence uniqueness in the database", () => {
  const db = new Database(":memory:");

  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        mic_device_id TEXT,
        language TEXT NOT NULL DEFAULT 'zh',
        created_at INTEGER NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'mic',
        processing_state TEXT NOT NULL DEFAULT 'pending',
        timeline_version INTEGER NOT NULL DEFAULT 1,
        finalized_at INTEGER,
        ready_at INTEGER
      );
      CREATE TABLE audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
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
      CREATE TABLE audio_chunks (
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
      CREATE TABLE processing_jobs (
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
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 10, 'recording', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'system', 24000, 1, 10, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES
        ('c1', 's1', 't1', 'system', 0, 'c1.wav', 10, 20, 10, 'same', 30),
        ('c2', 's1', 't1', 'system', 1, 'c2.wav', 20, 30, 10, 'same', 40);
      INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, input_hash, created_at
      ) VALUES
        ('j1', 's1', 't1', 'c1', 'transcribe_chunk', 'pending', 'same', 20),
        ('g1', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 20);
      PRAGMA user_version = 1;
    `);

    const result = applyJarvisMigrations(db);

    assert.deepEqual(result, { fromVersion: 1, toVersion: TARGET_VERSION });
    assert.equal(
      db.prepare("SELECT model_version FROM processing_jobs WHERE id = 'j1'").get().model_version,
      ""
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('j2', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 30)`
    ).run();
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('j3', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 40)`
        )
        .run()
    );
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('g2', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, '', 40)`
        )
        .run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('g3', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, 'model-2', 50)`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO audio_chunks (
            id, session_id, track_id, source_type, sequence_number, path,
            started_at, ended_at, duration_ms, sha256, expires_at
          ) VALUES ('c3', 's1', 't1', 'system', 1, 'c3.wav', 30, 40, 10, 'other', 50)`
          )
          .run(),
      /track_id, audio_chunks.sequence_number/
    );
    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });
  } finally {
    db.close();
  }
});

test("upgrades v2 gaps with timestamped restoration binding columns without losing evidence", () => {
  const db = new Database(":memory:");

  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        mic_device_id TEXT,
        language TEXT NOT NULL DEFAULT 'zh',
        created_at INTEGER NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'mic',
        processing_state TEXT NOT NULL DEFAULT 'pending',
        timeline_version INTEGER NOT NULL DEFAULT 1,
        finalized_at INTEGER,
        ready_at INTEGER
      );
      CREATE TABLE audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
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
      CREATE TABLE audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
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
      CREATE TABLE audio_gaps (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reason TEXT NOT NULL,
        recovery_attempts INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions (id, started_at, status, created_at)
        VALUES ('s1', 10, 'recording', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, device_id, device_label, strategy,
        sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'mic', 'mic-old', 'Old mic', 'web-audio', 24000, 1, 10, 'recovering');
      INSERT INTO audio_gaps (id, track_id, started_at, reason, recovery_attempts)
        VALUES ('g1', 't1', 20, 'device-change', 2);
      PRAGMA user_version = 2;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 2, toVersion: TARGET_VERSION });
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
    assert.deepEqual(
      columnNames(db, "audio_gaps").filter((name) => name.startsWith("restored_")),
      ["restored_device_id", "restored_device_label", "restored_strategy"]
    );
    assert.deepEqual(db.prepare("SELECT * FROM audio_gaps WHERE id = 'g1'").get(), {
      id: "g1",
      track_id: "t1",
      started_at: 20,
      ended_at: null,
      reason: "device-change",
      recovery_attempts: 2,
      restored_device_id: null,
      restored_device_label: null,
      restored_strategy: null,
      average_level: null,
      peak_level: null,
    });
  } finally {
    db.close();
  }
});

test("upgrades v10 storage telemetry to signed deltas without losing existing writes", () => {
  const db = new Database(":memory:");

  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('s1', 10, 'recording', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 10, 'active');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES ('c1', 's1', 't1', 'mic', 0, 'c1.flac', 10, 20, 10, 'pcm', 1000);
      ALTER TABLE storage_usage_events RENAME TO storage_usage_events_new_shape;
      CREATE TABLE storage_usage_events (
        kind TEXT NOT NULL CHECK(kind IN ('wav_written','flac_written')),
        chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
        bytes INTEGER NOT NULL CHECK(bytes > 0),
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(kind, chunk_id)
      );
      INSERT INTO storage_usage_events (kind, chunk_id, bytes, occurred_at)
      VALUES ('wav_written', 'c1', 144, 20), ('flac_written', 'c1', 40, 30);
      DROP TABLE storage_usage_events_new_shape;
      PRAGMA user_version = 10;
    `);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 200 }), {
      fromVersion: 10,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db.prepare(`
        SELECT kind, bytes, delta_bytes, occurred_at
        FROM storage_usage_events ORDER BY occurred_at
      `).all(),
      [
        { kind: "wav_written", bytes: 144, delta_bytes: 144, occurred_at: 20 },
        { kind: "flac_written", bytes: 40, delta_bytes: 40, occurred_at: 30 },
      ]
    );
    assert.throws(
      () =>
        db.prepare(`
          INSERT INTO storage_usage_events
            (kind, chunk_id, bytes, delta_bytes, occurred_at)
          VALUES ('retention_deleted', 'c1', 40, 40, 40)
        `).run(),
      /check constraint/i
    );
  } finally {
    db.close();
  }
});

test("upgrades v11 transcript rows with final-evidence lineage columns", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE people (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        person_id TEXT,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL NOT NULL,
        is_stable INTEGER NOT NULL,
        analysis_state TEXT NOT NULL DEFAULT 'pending'
      );
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('s1', 10, 'completed', 10);
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence, is_stable
      ) VALUES ('legacy', 's1', 10, 20, 'mic', 'legacy text', 0.5, 1);
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence, is_stable
      ) VALUES ('legacy-invalid', 's1', 20, 30, 'mic', 'preserve safely', 2, 7);
      CREATE TABLE segment_links (
        id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE
      );
      INSERT INTO segment_links (id, segment_id) VALUES ('link-1', 'legacy');
      PRAGMA user_version = 11;
    `);

    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: 11,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db.prepare(`
        SELECT track_id, chunk_id, source_type, result_kind, version,
               model_version, completed_at, superseded_by
        FROM transcript_segments WHERE id = 'legacy'
      `).get(),
      {
        track_id: null,
        chunk_id: null,
        source_type: "mic",
        result_kind: "provisional",
        version: 1,
        model_version: null,
        completed_at: null,
        superseded_by: null,
      }
    );
    assert.ok(
      db
        .pragma("foreign_key_list(transcript_segments)")
        .some(
          (foreignKey) =>
            foreignKey.from === "superseded_by" && foreignKey.table === "transcript_segments"
        )
    );
    assert.deepEqual(
      db.prepare(
        "SELECT confidence, is_stable, result_kind FROM transcript_segments WHERE id = 'legacy-invalid'"
      ).get(),
      { confidence: null, is_stable: 0, result_kind: "provisional" }
    );
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "link-1", segment_id: "legacy" },
    ]);
    assert.doesNotMatch(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'segment_links'").get().sql,
      /transcript_segments_v11/
    );
    db.prepare(`
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('lineage-track', 's1', 'system', 24000, 1, 10, 'ended')
    `).run();
    db.prepare(`
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES (
        'lineage-chunk', 's1', 'lineage-track', 'system', 0, 'lineage.wav',
        10, 20, 10, 'pcm-hash', 100
      )
    `).run();
    const insert = (overrides = {}) =>
      db.prepare(`
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, speaker_label, text,
          confidence, is_stable, track_id, chunk_id, source_type,
          result_kind, version, model_version, completed_at
        ) VALUES (
          @id, 's1', 10, 20, 'system', 'text', @confidence, @isStable,
          @trackId, @chunkId, @sourceType, @resultKind, @version,
          @modelVersion, @completedAt
        )
      `).run({
        id: "migrated-row",
        confidence: 0.5,
        isStable: 1,
        trackId: "lineage-track",
        chunkId: "lineage-chunk",
        sourceType: "system",
        resultKind: "final",
        version: 1,
        modelVersion: "large-v3-turbo",
        completedAt: 30,
        ...overrides,
      });

    for (const [name, overrides] of [
      ["source", { sourceType: "cloud" }],
      ["kind", { resultKind: "draft" }],
      ["version", { version: 0 }],
      ["confidence", { confidence: -0.1 }],
      ["stability", { isStable: 2 }],
      ["track foreign key", { trackId: "missing" }],
      ["chunk foreign key", { chunkId: "missing" }],
      ["final completeness", { modelVersion: null }],
    ]) {
      assert.throws(() => insert({ id: `bad-${name}`, ...overrides }), undefined, name);
    }
    insert({
      id: "migrated-provisional",
      confidence: null,
      isStable: 0,
      trackId: null,
      chunkId: null,
      sourceType: "mic",
      resultKind: "provisional",
      modelVersion: null,
      completedAt: null,
    });
    insert({ id: "migrated-final" });
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v13 preserves every valid v12 final field, dependent evidence, and semantic guards", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
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
      CREATE TABLE audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        transcription_status TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
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
      CREATE TABLE transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL,
        is_stable INTEGER NOT NULL,
        analysis_state TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
        chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL DEFAULT 'mic',
        result_kind TEXT NOT NULL DEFAULT 'provisional',
        version INTEGER NOT NULL DEFAULT 1,
        model_version TEXT,
        completed_at INTEGER
      );
      CREATE TABLE segment_links (
        id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE
      );
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('v12-session', 10, 300, 'completed', 10);
      INSERT INTO people (id, display_name, created_at, last_seen_at)
      VALUES ('person-1', 'Alice', 10, 200);
      INSERT INTO audio_tracks (
        id, session_id, source_type, device_label, strategy,
        sample_rate, channels, started_at, ended_at, state
      ) VALUES (
        'v12-track', 'v12-session', 'system', 'PC audio', 'wasapi-loopback',
        24000, 1, 10, 300, 'ended'
      );
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, write_state, format, file_sha256, sample_rate, channels
      ) VALUES (
        'v12-chunk', 'v12-session', 'v12-track', 'system', 4, 'v12.wav',
        100, 200, 100, 'pcm-v12', 1000,
        'completed', 'committed', 'wav', 'file-v12', 24000, 1
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label,
        text, confidence, is_stable, analysis_state, track_id, chunk_id,
        source_type, result_kind, version, model_version, completed_at
      ) VALUES (
        'v12-final', 'v12-session', 100, 200, 'person-1', 'Alice',
        'preserve exact final', 0.87, 1, 'ready', 'v12-track', 'v12-chunk',
        'system', 'final', 7, 'large-v3-turbo-v7', 250
      );
      INSERT INTO segment_links (id, segment_id) VALUES ('evidence-1', 'v12-final');
      PRAGMA user_version = 12;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 12, toVersion: TARGET_VERSION });
    assert.deepEqual(db.prepare("SELECT * FROM transcript_segments WHERE id = ?").get("v12-final"), {
      id: "v12-final",
      session_id: "v12-session",
      started_at: 100,
      ended_at: 200,
      person_id: "person-1",
      speaker_label: "Alice",
      text: "preserve exact final",
      confidence: 0.87,
      is_stable: 1,
      analysis_state: "ready",
      track_id: "v12-track",
      chunk_id: "v12-chunk",
      source_type: "system",
      result_kind: "final",
      version: 7,
      model_version: "large-v3-turbo-v7",
      completed_at: 250,
      superseded_by: null,
      echo_score: null,
      duplicate_of: null,
    });
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "evidence-1", segment_id: "v12-final" },
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);

    db.prepare(`
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text,
        confidence, is_stable, track_id, source_type, superseded_by
      ) VALUES (
        'migrated-preview', 'v12-session', 120, 180, 'system', 'preview',
        0.5, 1, 'v12-track', 'system', 'v12-final'
      )
    `).run();
    assert.throws(
      () =>
        db
          .prepare("UPDATE transcript_segments SET result_kind = 'provisional' WHERE id = ?")
          .run("v12-final"),
      /invalid transcript supersession target/
    );
  } finally {
    db.close();
  }
});

test("v14 preserves v13 transcript lineage and dependent foreign keys exactly", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
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
      CREATE TABLE audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        transcription_status TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
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
      CREATE TABLE transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL,
        is_stable INTEGER NOT NULL,
        analysis_state TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
        chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL DEFAULT 'mic',
        result_kind TEXT NOT NULL DEFAULT 'provisional',
        version INTEGER NOT NULL DEFAULT 1,
        model_version TEXT,
        completed_at INTEGER,
        superseded_by TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL
      );
      CREATE TABLE segment_links (
        id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE
      );
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('v13-session', 10, 300, 'completed', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, device_label, strategy,
        sample_rate, channels, started_at, ended_at, state
      ) VALUES (
        'v13-track', 'v13-session', 'mic', 'Mic', 'web-audio',
        24000, 1, 10, 300, 'ended'
      );
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, write_state, format, file_sha256, sample_rate, channels
      ) VALUES (
        'v13-chunk', 'v13-session', 'v13-track', 'mic', 0, 'v13.wav',
        100, 200, 100, 'pcm-v13', 1000,
        'completed', 'committed', 'wav', 'file-v13', 24000, 1
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text,
        confidence, is_stable, analysis_state, track_id, chunk_id,
        source_type, result_kind, version, model_version, completed_at
      ) VALUES (
        'v13-final', 'v13-session', 100, 200, 'mic', 'final text',
        0.9, 1, 'ready', 'v13-track', 'v13-chunk',
        'mic', 'final', 3, 'model-v3', 250
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text,
        confidence, is_stable, track_id, source_type, result_kind, superseded_by
      ) VALUES (
        'v13-preview', 'v13-session', 110, 190, 'mic', 'preview text',
        0.6, 1, 'v13-track', 'mic', 'provisional', 'v13-final'
      );
      INSERT INTO segment_links (id, segment_id) VALUES ('link-v13', 'v13-preview');
      PRAGMA user_version = 13;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 13, toVersion: TARGET_VERSION });
    assert.deepEqual(
      db.prepare(`
        SELECT id, superseded_by, echo_score, duplicate_of
        FROM transcript_segments ORDER BY id
      `).all(),
      [
        { id: "v13-final", superseded_by: null, echo_score: null, duplicate_of: null },
        {
          id: "v13-preview",
          superseded_by: "v13-final",
          echo_score: null,
          duplicate_of: null,
        },
      ]
    );
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "link-v13", segment_id: "v13-preview" },
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
