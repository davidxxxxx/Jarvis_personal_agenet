const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  applyJarvisMigrations,
  TARGET_VERSION,
} = require("../../src/jarvis/main/JarvisMigrations");

const V34_TABLES = [
  "speaker_cluster_model_embeddings",
  "speaker_identity_resolution_model_evidence",
  "activity_classifications",
];

test("v34 adds encrypted dual-speaker evidence and activity classification history", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(TARGET_VERSION, 34);
    applyJarvisMigrations(db);
    for (const table of V34_TABLES) {
      assert.ok(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table),
        `${table} should exist`
      );
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v33 upgrades in place to v34 without changing existing sessions", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('preserved-v33', 1000, 2000, 'completed', 1000);
      DROP TABLE speaker_identity_resolution_model_evidence;
      DROP TABLE speaker_cluster_model_embeddings;
      DROP TABLE activity_classifications;
      PRAGMA user_version = 33;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 33, toVersion: 34 });
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = 'preserved-v33'").get());
    for (const table of V34_TABLES) {
      assert.ok(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table)
      );
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v34 rejects unsafe attribution and cross-cluster model evidence", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-v34', 1000, 20000, 'completed', 1000);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES (
        'track-v34', 'session-v34', 'mic', 24000, 1, 1000, 20000, 'ended'
      );
      INSERT INTO speaker_clusters (
        id, session_id, track_id, local_label, model_id, speech_ms,
        window_count, link_state, created_at, updated_at
      ) VALUES (
        'cluster-v34', 'session-v34', 'track-v34', 'speaker_1', 'legacy',
        14000, 3, 'unknown', 20000, 20000
      );
    `);
    assert.throws(
      () =>
        db
          .prepare(
            `
            INSERT INTO speaker_cluster_model_embeddings (
              cluster_id, model_id, artifact_version, embedding_space, embedding,
              source_kind, attribution_state, speech_ms, window_count,
              quality_score, overlap_detected, echo_detected, created_at
            ) VALUES (
              'cluster-v34', 'model', 'v1', 'space', zeroblob(8),
              'system_mix', 'exact', 14000, 3, 0.9, 0, 0, 20000
            )
          `
          )
          .run(),
      /CHECK constraint failed/
    );
  } finally {
    db.close();
  }
});

test("v34 upgrades the existing shared budget price parent without breaking its foreign keys", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TRIGGER analysis_budget_price_versions_no_update;
      DROP TRIGGER analysis_budget_price_versions_no_replacement;
      DROP TRIGGER analysis_budget_price_versions_no_delete;
      DROP TRIGGER analysis_budget_attempts_validate_snapshot;
      CREATE TABLE analysis_budget_price_versions_v33 (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('session_analysis','daily_digest')),
        price_version TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency = 'USD'),
        input_per_million_microusd INTEGER NOT NULL,
        output_per_million_microusd INTEGER NOT NULL,
        billing_basis TEXT NOT NULL CHECK(billing_basis = 'paygo_list_price_equivalent'),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(provider, model, operation, price_version)
      );
      INSERT INTO analysis_budget_price_versions_v33
      SELECT * FROM analysis_budget_price_versions
      WHERE operation <> 'activity_classification';
      DROP TABLE analysis_budget_price_versions;
      ALTER TABLE analysis_budget_price_versions_v33
        RENAME TO analysis_budget_price_versions;
      CREATE TRIGGER analysis_budget_price_versions_no_update
      BEFORE UPDATE ON analysis_budget_price_versions
      BEGIN SELECT RAISE(ABORT, 'analysis budget price history is immutable'); END;
      CREATE TRIGGER analysis_budget_price_versions_no_replacement
      BEFORE INSERT ON analysis_budget_price_versions
      WHEN EXISTS (
        SELECT 1 FROM analysis_budget_price_versions
        WHERE provider = NEW.provider AND model = NEW.model
          AND operation = NEW.operation AND price_version = NEW.price_version
      )
      BEGIN SELECT RAISE(ABORT, 'analysis budget price replacement is forbidden'); END;
      CREATE TRIGGER analysis_budget_price_versions_no_delete
      BEFORE DELETE ON analysis_budget_price_versions
      BEGIN SELECT RAISE(ABORT, 'analysis budget price history is immutable'); END;
      CREATE TRIGGER analysis_budget_attempts_validate_snapshot
      BEFORE INSERT ON analysis_budget_attempts
      WHEN NOT EXISTS (
        SELECT 1 FROM analysis_budget_price_versions AS price
        WHERE price.provider = NEW.provider AND price.model = NEW.model
          AND price.operation = NEW.operation
          AND price.price_version = NEW.price_version
          AND price.currency = NEW.currency
          AND price.input_per_million_microusd = NEW.input_per_million_microusd
          AND price.output_per_million_microusd = NEW.output_per_million_microusd
      )
      BEGIN SELECT RAISE(ABORT, 'analysis budget price snapshot mismatch'); END;
      PRAGMA user_version = 33;
    `);
    db.pragma("foreign_keys = ON");

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 33, toVersion: 34 });
    assert.deepEqual(
      db
        .prepare(
          `SELECT operation FROM analysis_budget_price_versions
           WHERE provider = 'minimax' ORDER BY operation`
        )
        .all()
        .map((row) => row.operation),
      ["activity_classification", "daily_digest", "session_analysis"]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
