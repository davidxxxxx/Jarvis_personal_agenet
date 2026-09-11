const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const SHA = "a".repeat(64);

function seedRun(db) {
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-1', 1, 2, 'completed', 1);
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES ('track-1', 'session-1', 'mic', 24000, 1, 1, 2, 'ended');
  `);
  db.prepare(
    `
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'run-v1', 'session-1', 'track-1', ?, 'jarvis-session-diarization-v1',
      'legacy-diarizer', 'legacy-embedding', ?, 512, 16000, 1, 'cpu', 1, 1, 2
    )
  `
  ).run(SHA, SHA);
}

function downgradeRunTableToV35(db) {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    DROP INDEX IF EXISTS idx_diarization_run_revision;
    DROP INDEX IF EXISTS idx_diarization_runs_session_sequence;
    ALTER TABLE speaker_diarization_runs RENAME TO speaker_diarization_runs_v36_fixture;
    CREATE TABLE speaker_diarization_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
      transcript_revision TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      diarizer_model_id TEXT NOT NULL,
      embedding_model_id TEXT NOT NULL,
      model_artifact_sha256 TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL CHECK(embedding_dimension = 512),
      sample_rate INTEGER NOT NULL CHECK(sample_rate = 16000),
      input_version INTEGER NOT NULL CHECK(input_version = 1),
      execution_device TEXT NOT NULL CHECK(execution_device = 'cpu'),
      commit_sequence INTEGER NOT NULL UNIQUE CHECK(commit_sequence > 0),
      created_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      UNIQUE(session_id, track_id, transcript_revision, policy_id)
    );
    INSERT INTO speaker_diarization_runs
    SELECT id, session_id, track_id, transcript_revision, policy_id,
           diarizer_model_id, embedding_model_id, model_artifact_sha256,
           embedding_dimension, sample_rate, input_version, execution_device,
           commit_sequence, created_at, completed_at
    FROM speaker_diarization_runs_v36_fixture;
    DROP TABLE speaker_diarization_runs_v36_fixture;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA user_version = 35;
    PRAGMA foreign_keys = ON;
  `);
}

test("v36 preserves v1 runs and adds versioned CUDA hybrid metadata", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1 });
    seedRun(db);
    downgradeRunTableToV35(db);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2 }), {
      fromVersion: 35,
      toVersion: TARGET_VERSION,
    });
    const legacy = db.prepare("SELECT * FROM speaker_diarization_runs WHERE id = 'run-v1'").get();
    assert.equal(legacy.pipeline_metadata_json, "{}");
    assert.equal(legacy.speaker_count_min, null);
    assert.equal(legacy.execution_device, "cpu");

    db.prepare(
      `
      INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        pipeline_metadata_json, speaker_count_min, speaker_count_max,
        speaker_count_confidence, overlap_ms, overlap_separation_state,
        model_pack_version, commit_sequence, created_at, completed_at
      ) VALUES (
        'run-v2', 'session-1', 'track-1', ?, 'jarvis-hybrid-diarization-v2',
        'hybrid-diarizer', 'hybrid-embedding', ?, 512, 16000, 2, 'cuda',
        '{"schemaVersion":1}', 2, 3, 0.55, 1200, 'completed',
        'jarvis-ai-model-pack-2026.07.1', 2, 2, 3
      )
    `
    ).run("b".repeat(64), SHA);
    assert.equal(
      db.prepare("SELECT speaker_count_max FROM speaker_diarization_runs WHERE id = 'run-v2'").get()
        .speaker_count_max,
      3
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v36 rejects mismatched hybrid device and malformed count ranges", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1 });
    seedRun(db);
    assert.throws(() =>
      db
        .prepare(
          `
        INSERT INTO speaker_diarization_runs (
          id, session_id, track_id, transcript_revision, policy_id,
          diarizer_model_id, embedding_model_id, model_artifact_sha256,
          embedding_dimension, sample_rate, input_version, execution_device,
          pipeline_metadata_json, speaker_count_min, speaker_count_max,
          commit_sequence, created_at, completed_at
        ) VALUES (
          'bad', 'session-1', 'track-1', ?, 'bad-policy', 'bad-model', 'bad-embedding', ?,
          512, 16000, 3, 'cpu', '{}', 3, 2, 2, 2, 3
        )
      `
        )
        .run("b".repeat(64), SHA)
    );
  } finally {
    db.close();
  }
});
