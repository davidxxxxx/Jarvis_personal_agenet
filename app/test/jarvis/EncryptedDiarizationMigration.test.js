const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const VoiceEmbeddingCipher = require("../../src/jarvis/main/VoiceEmbeddingCipher");

const {
  TARGET_VERSION,
  applyJarvisMigrations,
} = require("../../src/jarvis/main/JarvisMigrations");

function encryptedVoiceCipher() {
  return new VoiceEmbeddingCipher({
    secretCrypto: {
      isAvailable: () => true,
      encrypt(value) {
        return Buffer.from(`sealed:${value}`, "utf8");
      },
      decrypt(value) {
        const text = Buffer.from(value).toString("utf8");
        if (!text.startsWith("sealed:")) throw new Error("invalid test ciphertext");
        return { value: text.slice("sealed:".length), needsReencrypt: false };
      },
    },
  });
}

test("v35 admits encrypted diarization evidence, repairs app-track generations, and requeues the known constraint failure", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (
        id, started_at, ended_at, status, created_at, finalized_at, processing_state
      ) VALUES ('session-v35', 1000, 5000, 'completed', 1000, 5000, 'processing');
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('mic-v35', 'session-v35', 'mic', 24000, 1, 1000, 5000, 'ended');
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('system-v35', 'session-v35', 'system', 24000, 1, 1000, 5000, 'ended');
      INSERT INTO audio_tracks (
        id, session_id, source_type, application_key, application_display_name,
        capture_generation, strategy, sample_rate, channels, started_at, ended_at, state
      ) VALUES (
        'app-v35-1', 'session-v35', 'system', 'chrome', 'Chrome', 7,
        'wasapi-application-loopback', 24000, 1, 2000, 2000, 'failed'
      );
      INSERT INTO application_audio_intervals (
        id, session_id, track_id, interval_kind, application_key, attribution_state,
        capture_generation, started_at, ended_at, reason, created_at
      ) VALUES (
        'prebuffer-v35', 'session-v35', 'system-v35', 'mixed_fallback', NULL,
        'mixed_unknown', 7, 1000, 2000, 'dynamic_start_prebuffer', 1000
      );
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, write_state, format, sample_rate, channels
      ) VALUES (
        'chunk-v35', 'session-v35', 'mic-v35', 'mic', 0, 'chunk.wav',
        1000, 5000, 4000, '${"a".repeat(64)}', 20000,
        'completed', 'committed', 'wav', 24000, 1
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, track_id, chunk_id, source_type, result_kind, version,
        model_version, completed_at
      ) VALUES (
        'segment-v35', 'session-v35', 1000, 5000, 'mic', 'hello', 0.9,
        1, 'mic-v35', 'chunk-v35', 'mic', 'final', 1, 'whisper-v1', 5000
      );
      INSERT INTO speaker_clusters (
        id, session_id, track_id, local_label, model_id, embedding,
        speech_ms, window_count, quality_score, created_at, updated_at
      ) VALUES (
        'cluster-v35', 'session-v35', 'mic-v35', 'speaker_1',
        '3dspeaker-campplus-voxceleb-16k-v1', zeroblob(2048),
        3000, 2, 0.9, 5000, 5000
      );
      INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        commit_sequence, created_at, completed_at
      ) VALUES (
        'run-v35', 'session-v35', 'mic-v35', '${"b".repeat(64)}',
        'jarvis-session-diarization-v1', 'sherpa-segmentation+3dspeaker-campplus',
        '3dspeaker-campplus-voxceleb-16k-v1', '${"c".repeat(64)}',
        512, 16000, 1, 'cpu', 1, 5000, 5000
      );
      INSERT INTO speaker_diarization_run_clusters (
        run_id, cluster_id, local_label, embedding, speech_ms, window_count,
        quality_score, first_appearance_at
      ) VALUES ('run-v35', 'cluster-v35', 'speaker_1', zeroblob(2048), 3000, 2, 0.9, 1000);
      INSERT INTO speaker_turns (
        id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
        raw_label, started_at, ended_at, embedding, created_at
      ) VALUES (
        'turn-v35', 'run-v35', 'cluster-v35', 'chunk-v35', 'segment-v35', 0,
        'speaker_1', 1000, 4000, zeroblob(2048), 5000
      );
      INSERT INTO processing_jobs (
        id, session_id, track_id, job_type, state, priority, input_hash,
        input_version, model_version, attempt_count, next_retry_at,
        error_code, lane, created_at
      ) VALUES (
        'job-v35', 'session-v35', 'mic-v35', 'diarize_track', 'retry', 40,
        '${"d".repeat(64)}', 1, 'jarvis-session-diarization-v1', 23, 999999,
        'SQLITE_CONSTRAINT_CHECK', 'local', 5000
      );

      DROP INDEX idx_audio_tracks_session_application;
      CREATE UNIQUE INDEX idx_audio_tracks_session_application
        ON audio_tracks(session_id, application_key)
        WHERE track_kind = 'application';
      PRAGMA user_version = 34;
    `);

    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: 34,
      toVersion: TARGET_VERSION,
    });
    assert.equal(TARGET_VERSION, 42);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(
      db
        .prepare(
          `SELECT state, attempt_count, next_retry_at, error_code, lease_owner,
                  lease_expires_at, completed_at
           FROM processing_jobs WHERE id = 'job-v35'`
        )
        .get(),
      {
        state: "pending",
        attempt_count: 23,
        next_retry_at: null,
        error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: null,
      }
    );
    assert.equal(
      db.prepare("SELECT failure_code FROM audio_tracks WHERE id = 'app-v35-1'").get()
        .failure_code,
      "evidence_registration_failed_invalid_interval_reason_v34"
    );

    db.exec(`
      INSERT INTO audio_tracks (
        id, session_id, source_type, application_key, application_display_name,
        capture_generation, strategy, sample_rate, channels, started_at, ended_at, state
      ) VALUES (
        'app-v35-2', 'session-v35', 'system', 'chrome', 'Chrome', 8,
        'wasapi-application-loopback', 24000, 1, 3000, 4000, 'ended'
      );
      UPDATE speaker_diarization_run_clusters
      SET embedding = X'4A56453101020304' WHERE run_id = 'run-v35';
      UPDATE speaker_turns
      SET embedding = X'4A56453101020304' WHERE id = 'turn-v35';
    `);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE speaker_turns SET embedding = zeroblob(12) WHERE id = 'turn-v35'"
          )
          .run(),
      /CHECK constraint failed/
    );
  } finally {
    db.close();
  }
});

test("repository startup encrypts legacy profile samples and aggregates as well as diarization evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-encryption-"));
  const dbPath = path.join(root, "jarvis.db");

  const plaintext = new JarvisRepository(dbPath);
  plaintext.db.exec(`
    INSERT OR IGNORE INTO people (
      id, display_name, is_self, voice_profile_id, created_at, last_seen_at
    ) VALUES ('self', 'Me', 1, -1, 1, 1);
    INSERT INTO voice_profile_samples (
      id, person_id, model_id, embedding, source_cluster_id,
      source_kind, speech_ms, window_count, created_at
    ) VALUES (
      'legacy-sample', 'self', 'legacy-unversioned', zeroblob(2048), NULL,
      'enrollment', 0, 0, 1
    );
    INSERT INTO voice_profile_aggregates (
      person_id, model_id, embedding, accepted_speech_ms,
      window_count, self_consistency, updated_at
    ) VALUES ('self', 'legacy-unversioned', zeroblob(2048), 0, 0, NULL, 1);
  `);
  plaintext.close();

  const encrypted = new JarvisRepository(dbPath, { embeddingCipher: encryptedVoiceCipher() });
  t.after(() => {
    encrypted.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rows = encrypted.db
    .prepare(
      `SELECT embedding FROM voice_profile_samples WHERE id = 'legacy-sample'
       UNION ALL
       SELECT embedding FROM voice_profile_aggregates
       WHERE person_id = 'self' AND model_id = 'legacy-unversioned'`
    )
    .all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.embedding.subarray(0, 4).toString("ascii"), "JVE1");
  }
  assert.equal(encrypted.listVoiceProfiles("legacy-unversioned").length, 1);
  assert.equal(
    encrypted.getVoiceProfileAggregate("self", "legacy-unversioned").embedding.length,
    512
  );
});
