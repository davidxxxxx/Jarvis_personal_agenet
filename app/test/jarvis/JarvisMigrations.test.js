const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  applyJarvisMigrations,
  TARGET_VERSION,
} = require("../../src/jarvis/main/JarvisMigrations");

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
      [
        "capture_mode",
        "processing_state",
        "timeline_version",
        "finalized_at",
        "ready_at",
      ]
    );
    assert.deepEqual(
      columnNames(db, "audio_chunks").filter((name) =>
        ["track_id", "source_type", "sequence_number", "write_state", "deleted_at"].includes(
          name
        )
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
      db.prepare(
        `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('j3', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 50)`
      ).run()
    );
    assert.throws(() =>
      db.prepare(
        `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('g2', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, '', 50)`
      ).run()
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
    assert.equal(db.prepare("SELECT model_version FROM processing_jobs WHERE id = 'j1'").get().model_version, "");
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('j2', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 30)`
    ).run();
    assert.throws(() =>
      db.prepare(
        `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('j3', 's1', 't1', 'c2', 'transcribe_chunk', 'pending', 'same', 1, '', 40)`
      ).run()
    );
    assert.throws(() =>
      db.prepare(
        `INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES ('g2', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, '', 40)`
      ).run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('g3', 's1', NULL, NULL, 'analyze_session', 'pending', 'global', 1, 'model-2', 50)`
    ).run();
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO audio_chunks (
            id, session_id, track_id, source_type, sequence_number, path,
            started_at, ended_at, duration_ms, sha256, expires_at
          ) VALUES ('c3', 's1', 't1', 'system', 1, 'c3.wav', 30, 40, 10, 'other', 50)`
        ).run(),
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
