const test = require("node:test");
const assert = require("node:assert/strict");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

test("v37 retires short application diarization and prioritizes continuous tracks", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const db = repository.db;
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-v37', 1000, 70000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('mic-v37', 'session-v37', 'mic', NULL, NULL, 0, 24000, 1, 1000, 20000, 'ended'),
      ('mix-v37', 'session-v37', 'system', NULL, NULL, 0, 24000, 1, 1000, 20000, 'ended'),
      ('short-v37', 'session-v37', 'system', 'chrome', 'Chrome', 1, 24000, 1, 1000, 2000, 'ended'),
      ('long-v37', 'session-v37', 'system', 'kook', 'KOOK', 2, 24000, 1, 1000, 61000, 'ended');

    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES
      ('short-chunk-v37', 'session-v37', 'short-v37', 'system', 0, 'short.wav',
       1000, 2000, 1000, '${"a".repeat(64)}', 50000, 'completed', 'committed', 'wav', 24000, 1),
      ('long-chunk-v37', 'session-v37', 'long-v37', 'system', 0, 'long.wav',
       1000, 61000, 60000, '${"b".repeat(64)}', 100000, 'completed', 'committed', 'wav', 24000, 1);

    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at
    ) VALUES
      ('mic-job-v37', 'session-v37', 'mic-v37', 'diarize_track', 'pending', 40,
       '${"1".repeat(64)}', 2, 'hybrid', 9000),
      ('mix-job-v37', 'session-v37', 'mix-v37', 'diarize_track', 'pending', 40,
       '${"2".repeat(64)}', 2, 'hybrid', 9000),
      ('short-job-v37', 'session-v37', 'short-v37', 'diarize_track', 'retry', 40,
       '${"3".repeat(64)}', 2, 'hybrid', 9000),
      ('short-running-job-v37', 'session-v37', 'short-v37', 'diarize_track', 'running', 99,
       '${"5".repeat(64)}', 2, 'hybrid', 9000),
      ('long-job-v37', 'session-v37', 'long-v37', 'diarize_track', 'pending', 40,
       '${"4".repeat(64)}', 2, 'hybrid', 9000);

    UPDATE processing_jobs
    SET state = 'running', priority = 99, lease_owner = 'dead-worker', lease_expires_at = 99999
    WHERE id = 'mic-job-v37';

    UPDATE processing_jobs
    SET lease_owner = 'dead-worker', lease_expires_at = 99999
    WHERE id = 'short-running-job-v37';
  `);
  db.pragma("user_version = 36");

  assert.deepEqual(applyJarvisMigrations(db, { now: () => 12_345 }), {
    fromVersion: 36,
    toVersion: TARGET_VERSION,
  });
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, priority, error_code, completed_at
      FROM processing_jobs WHERE job_type = 'diarize_track' ORDER BY id
    `
      )
      .all(),
    [
      { id: "long-job-v37", state: "pending", priority: 35, error_code: null, completed_at: null },
      { id: "mic-job-v37", state: "pending", priority: 34, error_code: null, completed_at: null },
      { id: "mix-job-v37", state: "pending", priority: 45, error_code: null, completed_at: null },
      {
        id: "short-job-v37",
        state: "superseded",
        priority: 40,
        error_code: "SPEAKER_AUDIO_TOO_SHORT",
        completed_at: 12_345,
      },
      {
        id: "short-running-job-v37",
        state: "superseded",
        priority: 99,
        error_code: "SPEAKER_AUDIO_TOO_SHORT",
        completed_at: 12_345,
      },
    ]
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM processing_jobs
       WHERE id IN ('mic-job-v37','short-running-job-v37')
         AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)`
      )
      .get().count,
    0
  );
});

test("v39 retires medium application fragments and wakes primary speaker work", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const db = repository.db;
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-v39', 1000, 20000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('mic-v39', 'session-v39', 'mic', NULL, NULL, 0, 24000, 1, 1000, 20000, 'ended'),
      ('mix-v39', 'session-v39', 'system', NULL, NULL, 0, 24000, 1, 1000, 20000, 'ended'),
      ('medium-v39', 'session-v39', 'system', 'chrome', 'Chrome', 1, 24000, 1, 1000, 15000, 'ended');

    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'medium-chunk-v39', 'session-v39', 'medium-v39', 'system', 0, 'medium.wav',
      1000, 15000, 14000, '${"c".repeat(64)}', 50000,
      'completed', 'committed', 'wav', 24000, 1
    );

    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at, next_retry_at,
      error_code, blocked_reason
    ) VALUES
      ('mic-job-v39', 'session-v39', 'mic-v39', 'diarize_track', 'retry', 99,
       '${"6".repeat(64)}', 2, 'hybrid', 9000, 99999, 'JOB_RESOURCE_YIELD', 'recovery_hysteresis'),
      ('mix-job-v39', 'session-v39', 'mix-v39', 'diarize_track', 'blocked', 99,
       '${"7".repeat(64)}', 2, 'hybrid', 9000, NULL, 'CUDA_UNAVAILABLE', 'cuda_unavailable'),
      ('medium-job-v39', 'session-v39', 'medium-v39', 'diarize_track', 'retry', 40,
       '${"8".repeat(64)}', 2, 'hybrid', 9000, 99999, 'JOB_RESOURCE_YIELD', 'recovery_hysteresis');
  `);
  db.pragma("user_version = 38");

  assert.deepEqual(applyJarvisMigrations(db, { now: () => 23_456 }), {
    fromVersion: 38,
    toVersion: TARGET_VERSION,
  });
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, priority, next_retry_at, error_code, blocked_reason, completed_at
         FROM processing_jobs WHERE job_type = 'diarize_track' ORDER BY id`
      )
      .all(),
    [
      {
        id: "medium-job-v39",
        state: "superseded",
        priority: 40,
        next_retry_at: null,
        error_code: "SPEAKER_AUDIO_TOO_SHORT",
        blocked_reason: null,
        completed_at: 23_456,
      },
      {
        id: "mic-job-v39",
        state: "pending",
        priority: 34,
        next_retry_at: null,
        error_code: null,
        blocked_reason: null,
        completed_at: null,
      },
      {
        id: "mix-job-v39",
        state: "pending",
        priority: 45,
        next_retry_at: null,
        error_code: null,
        blocked_reason: null,
        completed_at: null,
      },
    ]
  );
});

test("v40 retires sub-minute application fragments and prioritizes identity completion", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const db = repository.db;
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-v40', 1000, 70000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('mix-v40', 'session-v40', 'system', NULL, NULL, 0, 24000, 1, 1000, 70000, 'ended'),
      ('short-v40', 'session-v40', 'system', 'chrome', 'Chrome', 1, 24000, 1, 1000, 60000, 'ended'),
      ('long-v40', 'session-v40', 'system', 'kook', 'KOOK', 2, 24000, 1, 1000, 61000, 'ended');

    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES
      ('short-chunk-v40', 'session-v40', 'short-v40', 'system', 0, 'short-v40.wav',
       1000, 60000, 59000, '${"d".repeat(64)}', 100000,
       'completed', 'committed', 'wav', 24000, 1),
      ('long-chunk-v40', 'session-v40', 'long-v40', 'system', 0, 'long-v40.wav',
       1000, 61000, 60000, '${"e".repeat(64)}', 100000,
       'completed', 'committed', 'wav', 24000, 1);

    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at,
      lease_owner, lease_expires_at, execution_device
    ) VALUES
      ('mix-job-v40', 'session-v40', 'mix-v40', 'diarize_track', 'running', 36,
       '${"9".repeat(64)}', 2, 'hybrid', 9000, 'dead-worker', 99999, 'cuda'),
      ('short-job-v40', 'session-v40', 'short-v40', 'diarize_track', 'retry', 40,
       '${"a".repeat(64)}', 2, 'hybrid', 9000, NULL, NULL, NULL),
      ('long-job-v40', 'session-v40', 'long-v40', 'diarize_track', 'pending', 40,
       '${"b".repeat(64)}', 2, 'hybrid', 9000, NULL, NULL, NULL),
      ('identity-job-v40', 'session-v40', NULL, 'resolve_identities', 'running', 45,
       '${"c".repeat(64)}', 1, 'identity-v1', 9000, 'dead-worker', 99999, 'cuda');
  `);
  db.pragma("user_version = 39");

  assert.deepEqual(applyJarvisMigrations(db, { now: () => 34_567 }), {
    fromVersion: 39,
    toVersion: TARGET_VERSION,
  });
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, priority, error_code, lease_owner, execution_device, completed_at
         FROM processing_jobs
         WHERE job_type IN ('diarize_track','resolve_identities')
         ORDER BY id`
      )
      .all(),
    [
      {
        id: "identity-job-v40",
        state: "pending",
        priority: 37,
        error_code: null,
        lease_owner: null,
        execution_device: null,
        completed_at: null,
      },
      {
        id: "long-job-v40",
        state: "pending",
        priority: 35,
        error_code: null,
        lease_owner: null,
        execution_device: null,
        completed_at: null,
      },
      {
        id: "mix-job-v40",
        state: "pending",
        priority: 45,
        error_code: null,
        lease_owner: null,
        execution_device: null,
        completed_at: null,
      },
      {
        id: "short-job-v40",
        state: "superseded",
        priority: 40,
        error_code: "SPEAKER_AUDIO_TOO_SHORT",
        lease_owner: null,
        execution_device: null,
        completed_at: 34_567,
      },
    ]
  );
});

test("v44 wakes only recoverable speaker work and preserves deterministic failures", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const db = repository.db;
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-v44', 1000, 70000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('app-v44', 'session-v44', 'system', 'tencent-meeting', '腾讯会议',
       1, 24000, 1, 1000, 70000, 'ended'),
      ('mix-v44', 'session-v44', 'system', NULL, NULL,
       0, 24000, 1, 1000, 70000, 'ended'),
      ('bad-v44', 'session-v44', 'system', 'chrome', 'Chrome',
       1, 24000, 1, 1000, 70000, 'ended');

    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at, next_retry_at,
      error_code, blocked_reason
    ) VALUES
      ('app-job-v44', 'session-v44', 'app-v44', 'diarize_track', 'retry', 40,
       '${"d".repeat(64)}', 3, 'hybrid', 9000, 99999, NULL, 'recovery_hysteresis'),
      ('mix-job-v44', 'session-v44', 'mix-v44', 'diarize_track', 'blocked', 36,
       '${"e".repeat(64)}', 3, 'hybrid', 9000, NULL, 'CUDA_UNAVAILABLE', 'cuda_unavailable'),
      ('bad-job-v44', 'session-v44', 'bad-v44', 'diarize_track', 'blocked', 40,
       '${"f".repeat(64)}', 3, 'hybrid', 9000, NULL,
       'DIARIZATION_VALIDATION_FAILED', 'deterministic_failure');
  `);
  db.pragma("user_version = 43");

  assert.deepEqual(applyJarvisMigrations(db, { now: () => 45_678 }), {
    fromVersion: 43,
    toVersion: TARGET_VERSION,
  });
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, priority, next_retry_at, error_code, blocked_reason
         FROM processing_jobs WHERE job_type = 'diarize_track' ORDER BY id`
      )
      .all(),
    [
      {
        id: "app-job-v44",
        state: "pending",
        priority: 35,
        next_retry_at: null,
        error_code: null,
        blocked_reason: null,
      },
      {
        id: "bad-job-v44",
        state: "blocked",
        priority: 35,
        next_retry_at: null,
        error_code: "DIARIZATION_VALIDATION_FAILED",
        blocked_reason: "deterministic_failure",
      },
      {
        id: "mix-job-v44",
        state: "pending",
        priority: 45,
        next_retry_at: null,
        error_code: null,
        blocked_reason: null,
      },
    ]
  );
});
