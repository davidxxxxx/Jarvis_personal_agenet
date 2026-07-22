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
    VALUES ('session-v37', 1000, 10000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('mic-v37', 'session-v37', 'mic', NULL, NULL, 0, 24000, 1, 1000, 10000, 'ended'),
      ('mix-v37', 'session-v37', 'system', NULL, NULL, 0, 24000, 1, 1000, 10000, 'ended'),
      ('short-v37', 'session-v37', 'system', 'chrome', 'Chrome', 1, 24000, 1, 1000, 2000, 'ended'),
      ('long-v37', 'session-v37', 'system', 'kook', 'KOOK', 2, 24000, 1, 1000, 10000, 'ended');

    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES
      ('short-chunk-v37', 'session-v37', 'short-v37', 'system', 0, 'short.wav',
       1000, 2000, 1000, '${"a".repeat(64)}', 50000, 'completed', 'committed', 'wav', 24000, 1),
      ('long-chunk-v37', 'session-v37', 'long-v37', 'system', 0, 'long.wav',
       1000, 7000, 6000, '${"b".repeat(64)}', 50000, 'completed', 'committed', 'wav', 24000, 1);

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
      { id: "long-job-v37", state: "pending", priority: 40, error_code: null, completed_at: null },
      { id: "mic-job-v37", state: "pending", priority: 35, error_code: null, completed_at: null },
      { id: "mix-job-v37", state: "pending", priority: 36, error_code: null, completed_at: null },
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
