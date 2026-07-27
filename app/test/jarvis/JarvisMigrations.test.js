const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  applyJarvisMigrations,
  TARGET_VERSION,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
} = require("../../src/jarvis/main/JarvisMigrations");

function columnNames(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

test("current migration retains the idempotent local-midnight continuation relation", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES
        ('day-1', 10, 'completed', 10),
        ('day-2', 20, 'recording', 20);
      DROP TABLE session_continuations;
      PRAGMA user_version = 15;
    `);

    const result = applyJarvisMigrations(db, { now: () => 200 });

    assert.deepEqual(result, { fromVersion: 15, toVersion: TARGET_VERSION });
    db.prepare(
      `INSERT INTO session_continuations (
        source_session_id, destination_session_id, reason, boundary_at,
        destination_local_date
      ) VALUES ('day-1', 'day-2', 'local_midnight', 20, '2026-07-15')`
    ).run();
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO session_continuations (
          source_session_id, destination_session_id, reason, boundary_at,
          destination_local_date
        ) VALUES ('day-1', 'day-2', 'local_midnight', 21, '2026-07-15')`
        )
        .run()
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 300 }), {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });
  } finally {
    db.close();
  }
});

test("clean migration creates the continuation table with foreign keys", () => {
  const db = new Database(":memory:");
  try {
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 100 }), {
      fromVersion: 0,
      toVersion: TARGET_VERSION,
    });
    assert.ok(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("session_continuations")
    );
    assert.equal(db.pragma("foreign_key_list(session_continuations)").length, 2);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

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
        ('g1', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 1, '', 40);
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
        ) VALUES ('g2', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 1, '', 50)`
        )
        .run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('g3', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 1, 'model-2', 60)`
    ).run();
  } finally {
    db.close();
  }
});

test("current migration preserves v15 resource metadata while adding session continuations", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('s1', 10, 'recording', 10);
      INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash, input_version,
        model_version, attempt_count, created_at
      ) VALUES ('j1', 's1', 'transcribe_chunk', 'retry', 30, 'hash', 2, 'model', 3, 20);
      ALTER TABLE processing_jobs DROP COLUMN blocked_reason;
      ALTER TABLE processing_jobs DROP COLUMN execution_device;
      PRAGMA user_version = 14;
    `);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 200 }), {
      fromVersion: 14,
      toVersion: TARGET_VERSION,
    });
    assert.ok(columnNames(db, "processing_jobs").includes("blocked_reason"));
    assert.ok(columnNames(db, "processing_jobs").includes("execution_device"));
    assert.deepEqual(
      db
        .prepare(
          `
        SELECT id, state, priority, input_hash, input_version, model_version,
               attempt_count, blocked_reason, execution_device
        FROM processing_jobs WHERE id = 'j1'
      `
        )
        .get(),
      {
        id: "j1",
        state: "retry",
        priority: 30,
        input_hash: "hash",
        input_version: 2,
        model_version: "model",
        attempt_count: 3,
        blocked_reason: null,
        execution_device: null,
      }
    );
    db.prepare("UPDATE processing_jobs SET execution_device = 'cuda' WHERE id = 'j1'").run();
    assert.throws(() =>
      db.prepare("UPDATE processing_jobs SET execution_device = 'metal' WHERE id = 'j1'").run()
    );
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
        ('g1', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 20);
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
        ) VALUES ('g2', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 1, '', 40)`
        )
        .run()
    );
    db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, created_at
      ) VALUES ('g3', 's1', NULL, NULL, 'future_global_job', 'pending', 'global', 1, 'model-2', 50)`
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
      db
        .prepare(
          `
        SELECT kind, bytes, delta_bytes, occurred_at
        FROM storage_usage_events ORDER BY occurred_at
      `
        )
        .all(),
      [
        { kind: "wav_written", bytes: 144, delta_bytes: 144, occurred_at: 20 },
        { kind: "flac_written", bytes: 40, delta_bytes: 40, occurred_at: 30 },
      ]
    );
    assert.throws(
      () =>
        db
          .prepare(
            `
          INSERT INTO storage_usage_events
            (kind, chunk_id, bytes, delta_bytes, occurred_at)
          VALUES ('retention_deleted', 'c1', 40, 40, 40)
        `
          )
          .run(),
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
      db
        .prepare(
          `
        SELECT track_id, chunk_id, source_type, result_kind, version,
               model_version, completed_at, superseded_by
        FROM transcript_segments WHERE id = 'legacy'
      `
        )
        .get(),
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
      db
        .prepare(
          "SELECT confidence, is_stable, result_kind FROM transcript_segments WHERE id = 'legacy-invalid'"
        )
        .get(),
      { confidence: null, is_stable: 0, result_kind: "provisional" }
    );
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "link-1", segment_id: "legacy" },
    ]);
    assert.doesNotMatch(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'segment_links'").get().sql,
      /transcript_segments_v11/
    );
    db.prepare(
      `
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, state
      ) VALUES ('lineage-track', 's1', 'system', 24000, 1, 10, 'ended')
    `
    ).run();
    db.prepare(
      `
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES (
        'lineage-chunk', 's1', 'lineage-track', 'system', 0, 'lineage.wav',
        10, 20, 10, 'pcm-hash', 100
      )
    `
    ).run();
    const insert = (overrides = {}) =>
      db
        .prepare(
          `
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, speaker_label, text,
          confidence, is_stable, track_id, chunk_id, source_type,
          result_kind, version, model_version, completed_at
        ) VALUES (
          @id, 's1', 10, 20, 'system', 'text', @confidence, @isStable,
          @trackId, @chunkId, @sourceType, @resultKind, @version,
          @modelVersion, @completedAt
        )
      `
        )
        .run({
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
    assert.deepEqual(
      db.prepare("SELECT * FROM transcript_segments WHERE id = ?").get("v12-final"),
      {
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
      }
    );
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "evidence-1", segment_id: "v12-final" },
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);

    db.prepare(
      `
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text,
        confidence, is_stable, track_id, source_type, superseded_by
      ) VALUES (
        'migrated-preview', 'v12-session', 120, 180, 'system', 'preview',
        0.5, 1, 'v12-track', 'system', 'v12-final'
      )
    `
    ).run();
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
      db
        .prepare(
          `
        SELECT id, superseded_by, echo_score, duplicate_of
        FROM transcript_segments ORDER BY id
      `
        )
        .all(),
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

test("v15 leaves every genuine v14 transcript row and schema relationship unchanged", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      ${transcriptSegmentsSchema("transcript_segments", { ifNotExists: true })}
      ${TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS}
      CREATE TABLE segment_links (
        id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      ALTER TABLE processing_jobs DROP COLUMN execution_device;
      ALTER TABLE processing_jobs DROP COLUMN blocked_reason;

      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('v14-session', 10, 300, 'completed', 10);
      INSERT INTO people (id, display_name, created_at, last_seen_at)
      VALUES ('v14-person', 'Alice', 10, 300);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES
        ('v14-system-track', 'v14-session', 'system', 24000, 1, 10, 300, 'ended'),
        ('v14-mic-track', 'v14-session', 'mic', 24000, 1, 10, 300, 'ended');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, write_state, format, file_sha256, sample_rate, channels
      ) VALUES
        (
          'v14-system-chunk', 'v14-session', 'v14-system-track', 'system', 0,
          'v14-system.wav', 100, 200, 100, 'system-sha', 10000,
          'completed', 'committed', 'wav', 'system-file', 24000, 1
        ),
        (
          'v14-mic-chunk', 'v14-session', 'v14-mic-track', 'mic', 0,
          'v14-mic.wav', 110, 190, 80, 'mic-sha', 10000,
          'completed', 'committed', 'wav', 'mic-file', 24000, 1
        );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text,
        confidence, is_stable, analysis_state, track_id, chunk_id, source_type,
        result_kind, version, model_version, completed_at, echo_score
      ) VALUES (
        'v14-system-final', 'v14-session', 100, 200, 'v14-person', 'System',
        'system words', 0.91, 1, 'ready', 'v14-system-track', 'v14-system-chunk',
        'system', 'final', 7, 'model-v7', 250, 0.25
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text,
        confidence, is_stable, analysis_state, track_id, chunk_id, source_type,
        result_kind, version, model_version, completed_at, echo_score, duplicate_of
      ) VALUES (
        'v14-mic-final', 'v14-session', 110, 190, 'v14-person', 'Alice',
        'system words', 0.88, 1, 'ready', 'v14-mic-track', 'v14-mic-chunk',
        'mic', 'final', 8, 'model-v8', 251, 0.95, 'v14-system-final'
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, analysis_state, track_id, source_type, result_kind, version,
        superseded_by, echo_score
      ) VALUES (
        'v14-preview', 'v14-session', 120, 180, 'Alice', 'preview words', 0.51,
        0, 'pending', 'v14-mic-track', 'mic', 'provisional', 2,
        'v14-mic-final', 0.75
      );
      INSERT INTO segment_links (id, segment_id) VALUES ('v14-link', 'v14-mic-final');
      PRAGMA user_version = 14;
    `);

    const rowsBefore = db.prepare("SELECT * FROM transcript_segments ORDER BY id").all();
    const schemaBefore = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE tbl_name = 'transcript_segments' AND type IN ('table','index','trigger')
         ORDER BY type, name`
      )
      .all();
    const transcriptForeignKeysBefore = db.pragma("foreign_key_list(transcript_segments)");
    const dependentForeignKeysBefore = db.pragma("foreign_key_list(segment_links)");

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 14,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(db.prepare("SELECT * FROM transcript_segments ORDER BY id").all(), rowsBefore);
    assert.deepEqual(
      db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE tbl_name = 'transcript_segments' AND type IN ('table','index','trigger')
           ORDER BY type, name`
        )
        .all(),
      schemaBefore
    );
    assert.deepEqual(
      db.pragma("foreign_key_list(transcript_segments)"),
      transcriptForeignKeysBefore
    );
    assert.deepEqual(db.pragma("foreign_key_list(segment_links)"), dependentForeignKeysBefore);
    assert.deepEqual(db.prepare("SELECT * FROM segment_links").all(), [
      { id: "v14-link", segment_id: "v14-mic-final" },
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v29 creates immutable digest inputs candidates and sessionless digest job identity", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db, { now: () => 1_000 });

    assert.ok(TARGET_VERSION >= 29);
    assert.deepEqual(columnNames(db, "daily_digest_inputs"), [
      "id",
      "local_date",
      "timezone",
      "source_hash",
      "contract_version",
      "completeness",
      "input_watermark_json",
      "cloud_payload_json",
      "input_bytes",
      "model_version",
      "created_at",
    ]);
    assert.deepEqual(columnNames(db, "daily_digest_response_candidates"), [
      "id",
      "job_id",
      "digest_input_id",
      "budget_attempt_id",
      "response_schema_version",
      "candidate_json",
      "candidate_bytes",
      "candidate_hash",
      "state",
      "created_at",
      "disposition_at",
    ]);
    assert.ok(columnNames(db, "processing_jobs").includes("digest_input_id"));
    assert.equal(
      db
        .pragma("foreign_key_list(daily_digest_response_candidates)")
        .find((fk) => fk.from === "job_id").on_delete,
      "RESTRICT"
    );
    assert.equal(
      db.pragma("foreign_key_list(processing_jobs)").find((fk) => fk.from === "digest_input_id")
        .on_delete,
      "RESTRICT"
    );
    assert.match(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
         WHERE type = 'trigger'
           AND name = 'daily_digest_response_candidates_validate_insert'`
        )
        .get().sql,
      /attempt\.state = 'reconciled'/
    );

    const watermark = JSON.stringify({ schemaVersion: "jarvis-daily-digest-watermark-v1" });
    const payload = JSON.stringify({
      schemaVersion: "jarvis-daily-digest-input-v1",
      sessions: [],
      peopleInteractions: [],
      topics: [],
      decisions: [],
      commitments: [],
      todosCreated: [],
      todosCompleted: [],
      unresolvedConflicts: [],
      transcriptCoverage: { segmentCount: 0 },
    });
    db.prepare(
      `INSERT INTO daily_digest_inputs (
         id, local_date, timezone, source_hash, contract_version, completeness,
         input_watermark_json, cloud_payload_json, input_bytes, model_version, created_at
       ) VALUES (?, '2026-07-17', 'Asia/Shanghai', ?,
         'jarvis-daily-digest-input-v1', 'final', ?, ?, ?, 'MiniMax-M2.7', 1000)`
    ).run("digest-input-1", "a".repeat(64), watermark, payload, Buffer.byteLength(payload));
    db.prepare(
      `INSERT INTO processing_jobs (
         id, session_id, job_type, state, priority, input_hash, input_version,
         model_version, attempt_count, lane, digest_input_id, created_at
       ) VALUES (
         'digest-job-1', NULL, 'generate_daily_digest', 'pending', 80, ?, 1,
         'MiniMax-M2.7', 0, 'cloud', 'digest-input-1', 1000
       )`
    ).run("a".repeat(64));
    assert.deepEqual(
      db
        .prepare(
          `SELECT session_id, lane, priority, digest_input_id, analysis_input_id, desired_head_hash
         FROM processing_jobs WHERE id = 'digest-job-1'`
        )
        .get(),
      {
        session_id: null,
        lane: "cloud",
        priority: 80,
        digest_input_id: "digest-input-1",
        analysis_input_id: null,
        desired_head_hash: null,
      }
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE daily_digest_inputs SET completeness = 'partial' WHERE id = ?")
          .run("digest-input-1"),
      /immutable/i
    );
    assert.throws(
      () => db.prepare("DELETE FROM daily_digest_inputs WHERE id = ?").run("digest-input-1"),
      /immutable|foreign key/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO processing_jobs (
             id, session_id, job_type, state, priority, input_hash, input_version,
             model_version, lane, digest_input_id, created_at
           ) VALUES ('bad-digest-session', 'missing', 'generate_daily_digest', 'pending', 80,
             ?, 1, 'MiniMax-M2.7', 'cloud', 'digest-input-1', 1000)`
          )
          .run("a".repeat(64)),
      /invalid|foreign key|check constraint/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO processing_jobs (
             id, session_id, job_type, state, priority, input_hash, input_version,
             model_version, lane, created_at
           ) VALUES ('bad-local-session', NULL, 'transcribe_chunk', 'pending', 30,
             'local-input', 1, 'model', 'local', 1000)`
          )
          .run(),
      /invalid|not null|constraint/i
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v29 preserves custom processing objects and rolls back hostile owned-name collisions", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      CREATE INDEX custom_processing_state ON processing_jobs(state, created_at);
      CREATE TRIGGER custom_processing_guard
      BEFORE UPDATE OF id ON processing_jobs
      BEGIN
        SELECT RAISE(ABORT, 'custom processing identity is immutable');
      END;
      PRAGMA user_version = 28;
    `);
    applyJarvisMigrations(db, { now: () => 2_000 });
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='custom_processing_state'"
        )
        .get()
    );
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='custom_processing_guard'"
        )
        .get()
    );

    db.exec(`
      CREATE TABLE hostile_trigger_owner (id INTEGER PRIMARY KEY);
      DROP TRIGGER daily_digest_inputs_immutable_update;
      CREATE TRIGGER daily_digest_inputs_immutable_update
      BEFORE INSERT ON hostile_trigger_owner
      BEGIN
        SELECT RAISE(ABORT, 'hostile same-name trigger');
      END;
      PRAGMA user_version = 28;
    `);
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    assert.throws(() => applyJarvisMigrations(db, { now: () => 3_000 }), /collision/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v29 repairs missing or modified same-target owned objects before accepting an exact-column schema", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      DROP TRIGGER daily_digest_inputs_immutable_update;
      DROP INDEX idx_daily_digest_candidates_recovery;
      DROP INDEX idx_transcript_segments_digest_active_day;
      CREATE INDEX idx_transcript_segments_digest_active_day
      ON transcript_segments(ended_at);
      DROP INDEX idx_processing_jobs_digest_pending_session;
      DROP TRIGGER daily_digest_response_candidates_validate_insert;
      CREATE TRIGGER daily_digest_response_candidates_validate_insert
      BEFORE INSERT ON daily_digest_response_candidates
      BEGIN
        SELECT 1;
      END;
      PRAGMA user_version = 28;
    `);

    applyJarvisMigrations(db, { now: () => 2_000 });

    const immutable = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='daily_digest_inputs_immutable_update'"
      )
      .get()?.sql;
    const candidateGuard = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='daily_digest_response_candidates_validate_insert'"
      )
      .get()?.sql;
    assert.match(immutable ?? "", /RAISE\(ABORT, 'daily digest input is immutable'\)/);
    assert.match(candidateGuard ?? "", /daily digest candidate identity mismatch/);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_daily_digest_candidates_recovery'"
        )
        .get()
    );
    const activeDayIndex = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_transcript_segments_digest_active_day'"
      )
      .get()?.sql;
    const pendingSessionIndex = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_processing_jobs_digest_pending_session'"
      )
      .get()?.sql;
    assert.match(activeDayIndex ?? "", /started_at, ended_at, id/);
    assert.match(activeDayIndex ?? "", /superseded_by IS NULL/);
    assert.match(pendingSessionIndex ?? "", /session_id, job_type, input_hash/);
    assert.match(pendingSessionIndex ?? "", /completed_at IS NULL/);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v29 rejects exact-column daily tables whose normalized SQL weakens checks or foreign keys", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-v29-hostile-table-"));
  const filename = path.join(directory, "hostile.sqlite3");
  let db = new Database(filename);
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.unsafeMode(true);
    db.pragma("writable_schema = ON");
    db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, ?, ?)
       WHERE type = 'table' AND name = 'daily_digest_inputs'`
    ).run("completeness IN ('partial','final')", "completeness IN ('partial','final','hostile')");
    db.pragma("user_version = 28");
    db.pragma("writable_schema = OFF");
    db.close();
    db = new Database(filename);
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();

    assert.throws(() => applyJarvisMigrations(db, { now: () => 2_000 }), /collision/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v29 installs digest day-range indexes that the planner uses", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    const transcriptPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM transcript_segments
         WHERE started_at < ? AND ended_at > ?
           AND result_kind = 'final' AND is_stable = 1
           AND superseded_by IS NULL AND duplicate_of IS NULL
         ORDER BY started_at, id`
      )
      .all(2_000, 1_000)
      .map((row) => row.detail)
      .join(" ");
    const incompletePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT count(*) FROM transcript_segments
         WHERE started_at < ? AND ended_at > ?
           AND superseded_by IS NULL
           AND duplicate_of IS NULL
           AND (result_kind <> 'final' OR is_stable <> 1)`
      )
      .all(2_000, 1_000)
      .map((row) => row.detail)
      .join(" ");
    const evidencePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT transcript_segment_id FROM evidence_refs
         WHERE entity_type = ? AND started_at < ? AND ended_at > ?
         ORDER BY started_at, transcript_segment_id`
      )
      .all("memory_occurrence", 2_000, 1_000)
      .map((row) => row.detail)
      .join(" ");
    const pendingPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT session_id, job_type, input_hash, input_version, model_version
         FROM processing_jobs
         WHERE session_id IN (?)
           AND job_type <> 'generate_daily_digest'
           AND completed_at IS NULL
           AND state NOT IN (
             'completed','failed','cancelled','superseded','audio_expired_before_processing'
           )
         ORDER BY session_id, job_type, input_hash, input_version, model_version`
      )
      .all("session-1")
      .map((row) => row.detail)
      .join(" ");
    assert.match(transcriptPlan, /idx_transcript_segments_digest_day/);
    assert.match(incompletePlan, /idx_transcript_segments_digest_active_day/);
    assert.match(evidencePlan, /idx_evidence_refs_digest_day/);
    assert.match(pendingPlan, /idx_processing_jobs_digest_pending_session/);
  } finally {
    db.close();
  }
});

test("v30 indexes bounded public knowledge reads without full scans or top-level temp sorts", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    assert.equal(TARGET_VERSION, 42);

    const explain = (sql, ...params) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => row.detail)
        .join(" ");
    const plans = {
      memories: explain("SELECT id FROM memory_items_v2 ORDER BY updated_at DESC, id LIMIT ?", 101),
      topics: explain("SELECT id FROM topics_v2 ORDER BY updated_at DESC, id LIMIT ?", 101),
      todos: explain("SELECT id FROM todos_v2 ORDER BY updated_at DESC, id LIMIT ?", 101),
      suggestions: explain(
        "SELECT id FROM suggestions_v2 ORDER BY updated_at DESC, id LIMIT ?",
        101
      ),
      conflicts: explain(
        "SELECT id FROM memory_conflict_groups ORDER BY created_at DESC, id LIMIT ?",
        101
      ),
      suggestionHistory: explain(
        `SELECT id FROM suggestion_occurrences
         WHERE suggestion_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        "suggestion-1",
        20
      ),
      todoTransitions: explain(
        `SELECT id FROM todo_state_transitions
         WHERE todo_instance_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        "todo-1",
        20
      ),
    };

    assert.match(plans.memories, /idx_memory_items_public_updated/);
    assert.match(plans.topics, /idx_topics_public_updated/);
    assert.match(plans.todos, /idx_todos_public_updated/);
    assert.match(plans.suggestions, /idx_suggestions_public_updated/);
    assert.match(plans.conflicts, /idx_memory_conflicts_public_created/);
    assert.match(plans.suggestionHistory, /idx_suggestion_occurrences_public_history/);
    assert.match(plans.todoTransitions, /idx_todo_transitions_public_history/);
    for (const plan of Object.values(plans)) {
      assert.doesNotMatch(plan, /SCAN (suggestion_occurrences|todo_state_transitions)/);
      assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/);
    }
  } finally {
    db.close();
  }
});

test("v38 indexes per-chunk runtime status lookups instead of scanning every processing job", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      DROP INDEX idx_processing_jobs_chunk_type_order;
      PRAGMA user_version = 37;
    `);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 37,
      toVersion: TARGET_VERSION,
    });
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id
         FROM processing_jobs
         WHERE chunk_id = ?
           AND job_type = 'transcribe_chunk'
           AND state NOT IN ('completed','superseded','audio_expired_before_processing')
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .all("chunk-1")
      .map((row) => row.detail)
      .join(" ");

    assert.match(plan, /idx_processing_jobs_chunk_type_order/);
    assert.doesNotMatch(plan, /SCAN processing_jobs/);
  } finally {
    db.close();
  }
});

test("v29 fails closed without dropping an extra constrained processing_jobs column or its data", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('custom-column-session', 1, 'recording', 1);
      ALTER TABLE processing_jobs ADD COLUMN custom_tag TEXT NOT NULL DEFAULT 'kept'
        CHECK(custom_tag = 'kept');
      INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash, input_version,
        model_version, lane, created_at, custom_tag
      ) VALUES (
        'custom-column-job', 'custom-column-session', 'transcribe_chunk', 'pending',
        30, 'custom-column-input', 1, 'model-v1', 'local', 10, 'kept'
      );
      PRAGMA user_version = 28;
    `);
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const dataBefore = db.prepare("SELECT * FROM processing_jobs").all();

    assert.throws(() => applyJarvisMigrations(db, { now: () => 2_000 }), /collision/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
    assert.deepEqual(db.prepare("SELECT * FROM processing_jobs").all(), dataBefore);
  } finally {
    db.close();
  }
});

test("v29 rejects exact-column processing_jobs tables whose reviewed constraints were altered", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-v29-hostile-processing-"));
  const filename = path.join(directory, "hostile.sqlite3");
  let db = new Database(filename);
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('hostile-processing-session', 1, 'recording', 1);
      INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash, input_version,
        model_version, lane, created_at
      ) VALUES (
        'hostile-processing-job', 'hostile-processing-session', 'transcribe_chunk',
        'pending', 30, 'hostile-input', 1, 'model-v1', 'local', 1
      );
    `);
    db.unsafeMode(true);
    db.pragma("writable_schema = ON");
    db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, ?, ?)
       WHERE type = 'table' AND name = 'processing_jobs'`
    ).run("lane IN ('local','cloud')", "lane IN ('local','cloud','hostile')");
    db.pragma("user_version = 28");
    db.pragma("writable_schema = OFF");
    db.close();
    db = new Database(filename);
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const dataBefore = db.prepare("SELECT * FROM processing_jobs").all();

    assert.throws(() => applyJarvisMigrations(db, { now: () => 2_000 }), /collision/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
    assert.deepEqual(db.prepare("SELECT * FROM processing_jobs").all(), dataBefore);
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v29 rejects a partial digest job whose durable input hash disagrees with its input", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    const payload = JSON.stringify({ schemaVersion: "jarvis-daily-digest-input-v1" });
    db.prepare(
      `INSERT INTO daily_digest_inputs (
         id, local_date, timezone, source_hash, contract_version, completeness,
         input_watermark_json, cloud_payload_json, input_bytes, model_version, created_at
       ) VALUES (
         'mismatch-digest-input', '2026-07-17', 'Asia/Shanghai', ?,
         'jarvis-daily-digest-input-v1', 'final', '{}', ?, ?, 'Model-A', 1
       )`
    ).run("a".repeat(64), payload, Buffer.byteLength(payload));
    db.exec("DROP TRIGGER processing_jobs_cloud_contract_insert");
    db.prepare(
      `INSERT INTO processing_jobs (
         id, session_id, job_type, state, priority, input_hash, input_version,
         model_version, lane, digest_input_id, created_at
       ) VALUES (
         'mismatch-digest-job', NULL, 'generate_daily_digest', 'pending', 80,
         ?, 1, 'Model-B', 'cloud', 'mismatch-digest-input', 1
       )`
    ).run("b".repeat(64));
    db.pragma("user_version = 28");
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const dataBefore = db.prepare("SELECT * FROM processing_jobs").all();

    assert.throws(() => applyJarvisMigrations(db, { now: () => 2_000 }), /identity/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
    assert.deepEqual(db.prepare("SELECT * FROM processing_jobs").all(), dataBefore);
  } finally {
    db.close();
  }
});

test("v29 rejects a partial analysis job whose durable identity disagrees with its desired head", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    const inputHash = "c".repeat(64);
    const payloadHash = "d".repeat(64);
    const desiredHeadHash = "e".repeat(64);
    const transcriptRevision = "a".repeat(64);
    const identityRevision = "b".repeat(64);
    const cloudPayloadJson = JSON.stringify({ inputVersion: "jarvis-analysis-input-v2" });
    const desiredVectorJson = JSON.stringify({
      analysisInputId: "mismatch-analysis-input",
      analysisInputHash: inputHash,
      transcriptRevision,
      identityRevision,
      promptVersion: "jarvis-analysis-v2",
      responseSchemaVersion: "jarvis-analysis-v2",
      pseudonymBindingRevision: 1,
      modelVersion: "Model-A",
      cloudPayloadHash: payloadHash,
      segments: [],
    });
    db.exec(`
      INSERT INTO sessions (id, started_at, status, created_at)
      VALUES ('mismatch-analysis-session', 1, 'recording', 1);
    `);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'mismatch-analysis-input', 'mismatch-analysis-session', ?, ?,
         'jarvis-analysis-v2', ?, 'jarvis-analysis-input-v2', 'jarvis-redaction-v1',
         ?, ?, ?, 1
       )`
    ).run(
      transcriptRevision,
      identityRevision,
      inputHash,
      cloudPayloadJson,
      Buffer.byteLength(cloudPayloadJson),
      payloadHash
    );
    db.prepare(
      `INSERT INTO analysis_desired_heads (
         session_id, analysis_input_id, analysis_input_hash, desired_vector_json,
         desired_vector_hash, head_revision, created_at, updated_at
       ) VALUES (
         'mismatch-analysis-session', 'mismatch-analysis-input', ?, ?, ?, 1, 1, 1
       )`
    ).run(inputHash, desiredVectorJson, desiredHeadHash);
    db.exec("DROP TRIGGER processing_jobs_cloud_contract_insert");
    db.prepare(
      `INSERT INTO processing_jobs (
         id, session_id, job_type, state, priority, input_hash, input_version,
         model_version, lane, analysis_input_id, desired_head_hash, created_at
       ) VALUES (
         'mismatch-analysis-job', 'mismatch-analysis-session', 'analyze_session',
         'pending', 70, ?, 1, 'Model-B', 'cloud', 'mismatch-analysis-input', ?, 1
       )`
    ).run(inputHash, desiredHeadHash);
    db.pragma("user_version = 28");
    const schemaBefore = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const dataBefore = db.prepare("SELECT * FROM processing_jobs").all();

    assert.throws(() => applyJarvisMigrations(db, { now: () => 2_000 }), /identity/i);
    assert.equal(db.pragma("user_version", { simple: true }), 28);
    assert.deepEqual(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      schemaBefore
    );
    assert.deepEqual(db.prepare("SELECT * FROM processing_jobs").all(), dataBefore);
  } finally {
    db.close();
  }
});

test("v29 preserves legacy session-anchored digest jobs as inert terminal history", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('legacy-digest-session', 1, 2, 'completed', 1);
      INSERT INTO audio_tracks (
        id, session_id, source_type, strategy, sample_rate, channels, started_at, state
      ) VALUES (
        'legacy-digest-track', 'legacy-digest-session', 'mic', 'web-audio',
        24000, 1, 1, 'ended'
      );
      INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, track_id, source_type, sequence_number, write_state,
        format, file_sha256, sample_rate, channels
      ) VALUES (
        'legacy-digest-chunk', 'legacy-digest-session', 'G:\\legacy.flac', 1, 2, 1,
        'legacy-pcm', 999, 'completed', 'legacy-digest-track', 'mic', 0, 'committed',
        'flac', 'legacy-file', 24000, 1
      );
      DROP TRIGGER processing_jobs_cloud_contract_insert;
      DROP TRIGGER processing_jobs_cloud_contract_update;
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority, input_hash, input_version,
        model_version, attempt_count, lane, created_at
      ) VALUES (
        'legacy-digest-job', 'legacy-digest-session', 'legacy-digest-track',
        'legacy-digest-chunk', 'generate_daily_digest',
        'pending', 50, 'legacy-source-identity', 1, 'legacy-model', 0, 'local', 123
      );
      PRAGMA ignore_check_constraints = OFF;
      PRAGMA user_version = 28;
    `);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 28,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, session_id, track_id, chunk_id, job_type, state, priority, input_hash, model_version,
                lane, digest_input_id, error_code, completed_at
         FROM processing_jobs WHERE id = 'legacy-digest-job'`
        )
        .get(),
      {
        id: "legacy-digest-job",
        session_id: "legacy-digest-session",
        track_id: null,
        chunk_id: null,
        job_type: "generate_daily_digest",
        state: "superseded",
        priority: 80,
        input_hash: "legacy-source-identity",
        model_version: "legacy-model",
        lane: "cloud",
        digest_input_id: null,
        error_code: "LEGACY_DIGEST_IDENTITY_UNAVAILABLE",
        completed_at: 123,
      }
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
