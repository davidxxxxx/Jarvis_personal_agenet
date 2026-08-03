const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function removeV49Schema(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS action_center_delta_todo_occurrence_insert;
    DROP TRIGGER IF EXISTS action_center_delta_suggestion_occurrence_insert;
    DROP TABLE IF EXISTS action_center_read_state;
    DROP TABLE IF EXISTS action_center_events;
    PRAGMA user_version = 48;
  `);
}

function insertLegacyActions(db) {
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('delta-session', 1000, 2000, 'completed', 1000);

    INSERT INTO todos_v2 (
      id, canonical_base_key, instance_key, title, status, provenance, created_at, updated_at
    ) VALUES (
      'delta-old-todo', '${HASH_A}', '${HASH_B}', 'Existing todo', 'open',
      'legacy_unverified', 1500, 1500
    );
    INSERT INTO todo_revisions (
      id, todo_instance_id, revision, title, provenance, created_at
    ) VALUES (
      'delta-old-todo-revision', 'delta-old-todo', 1, 'Existing todo',
      'legacy_unverified', 1500
    );
    INSERT INTO todo_occurrences (
      id, todo_instance_id, todo_revision_id, legacy_session_id,
      occurrence_key, candidate_item_fingerprint, created_at
    ) VALUES (
      'delta-old-todo-occurrence', 'delta-old-todo', 'delta-old-todo-revision',
      'delta-session', '${HASH_C}', '${HASH_D}', 1500
    );

    INSERT INTO suggestions_v2 (
      id, canonical_key, title, rationale, state, provenance, created_at, updated_at
    ) VALUES (
      'delta-old-suggestion', '${HASH_B}', 'Existing suggestion', 'Existing rationale',
      'proposed', 'legacy_unverified', 1600, 1600
    );
    INSERT INTO suggestion_occurrences (
      id, suggestion_id, legacy_session_id, occurrence_key,
      candidate_item_fingerprint, created_at
    ) VALUES (
      'delta-old-suggestion-occurrence', 'delta-old-suggestion', 'delta-session',
      '${HASH_A}', '${HASH_C}', 1600
    );
  `);
}

test("v49 creates a durable per-session action ledger and last-seen singleton", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });

    assert.ok(TARGET_VERSION >= 49);
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
    assert.deepEqual(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('action_center_events','action_center_read_state')
           ORDER BY name`
        )
        .all()
        .map((row) => row.name),
      ["action_center_events", "action_center_read_state"]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'action_center_delta_%'
           ORDER BY name`
        )
        .all()
        .map((row) => row.name),
      [
        "action_center_delta_suggestion_occurrence_insert",
        "action_center_delta_todo_occurrence_insert",
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v48 upgrade backfills a read baseline and tracks only later actions as unread", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db, { now: () => 1_000 });
    removeV49Schema(db);
    insertLegacyActions(db);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 3_000 }), {
      fromVersion: 48,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT action_kind, action_id, session_id, created_at
           FROM action_center_events ORDER BY sequence`
        )
        .all(),
      [
        {
          action_kind: "todo",
          action_id: "delta-old-todo",
          session_id: "delta-session",
          created_at: 1500,
        },
        {
          action_kind: "suggestion",
          action_id: "delta-old-suggestion",
          session_id: "delta-session",
          created_at: 1600,
        },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT last_seen_sequence, updated_at
           FROM action_center_read_state WHERE singleton = 1`
        )
        .get(),
      { last_seen_sequence: 2, updated_at: 3000 }
    );

    db.exec(`
      INSERT INTO suggestions_v2 (
        id, canonical_key, title, rationale, state, provenance, created_at, updated_at
      ) VALUES (
        'delta-new-suggestion', '${HASH_D}', 'New suggestion', 'New rationale',
        'proposed', 'legacy_unverified', 4000, 4000
      );
      INSERT INTO suggestion_occurrences (
        id, suggestion_id, legacy_session_id, occurrence_key,
        candidate_item_fingerprint, created_at
      ) VALUES (
        'delta-new-suggestion-occurrence', 'delta-new-suggestion', 'delta-session',
        '${HASH_B}', '${HASH_D}', 4000
      );
    `);
    assert.deepEqual(
      db
        .prepare(
          `SELECT sequence, action_kind, action_id, session_id
           FROM action_center_events WHERE sequence > (
             SELECT last_seen_sequence FROM action_center_read_state WHERE singleton = 1
           )`
        )
        .all(),
      [
        {
          sequence: 3,
          action_kind: "suggestion",
          action_id: "delta-new-suggestion",
          session_id: "delta-session",
        },
      ]
    );
  } finally {
    db.close();
  }
});
