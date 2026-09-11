"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const AT = 1_786_300_000_000;

function fresh() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db, { now: () => AT });
  return db;
}

test("the current schema retains v55 append-only reversible personalization feedback events", () => {
  const db = fresh();
  try {
    assert.ok(TARGET_VERSION >= 55);
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
    const columns = new Set(
      db.pragma("table_info(personalization_feedback_events)").map((column) => column.name)
    );
    assert.deepEqual(
      [...columns].sort(),
      [
        "corrected_value",
        "domain",
        "event_state",
        "feature_json",
        "id",
        "occurred_at",
        "original_value",
        "pattern_key",
        "source_entity_id",
      ].sort()
    );

    const insert = db.prepare(`
      INSERT INTO personalization_feedback_events (
        id, domain, source_entity_id, event_state, original_value,
        corrected_value, pattern_key, feature_json, occurred_at
      ) VALUES (?, 'suggestion', 'suggestion-v55', ?, ?, ?, ?, ?, ?)
    `);
    const pattern = "a".repeat(64);
    insert.run(
      "feedback-event-v55-1",
      "active",
      "visible",
      "lower_priority",
      pattern,
      '{"contentFingerprint":"' + "b".repeat(64) + '"}',
      AT
    );
    insert.run(
      "feedback-event-v55-2",
      "retracted",
      "lower_priority",
      "restored",
      pattern,
      '{"contentFingerprint":"' + "b".repeat(64) + '"}',
      AT + 1
    );
    insert.run(
      "feedback-event-v55-3",
      "active",
      "visible",
      "lower_priority",
      pattern,
      '{"contentFingerprint":"' + "b".repeat(64) + '"}',
      AT + 2
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE personalization_feedback_events SET occurred_at = ? WHERE id = ?")
          .run(AT + 3, "feedback-event-v55-1"),
      /personalization feedback event is immutable/
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM personalization_feedback_events WHERE id = ?")
          .run("feedback-event-v55-1"),
      /personalization feedback event is immutable/
    );
  } finally {
    db.close();
  }
});

test("a v54 database upgrades through the current schema without changing existing feedback", () => {
  const db = fresh();
  try {
    db.exec("DROP TRIGGER personalization_feedback_events_immutable_update");
    db.exec("DROP TRIGGER personalization_feedback_events_immutable_delete");
    db.exec("DROP TABLE personalization_feedback_events");
    db.pragma("user_version = 54");
    db.prepare(
      `INSERT INTO personalization_feedback (
         id, domain, source_entity_id, original_value, corrected_value,
         pattern_key, feature_json, occurred_at
       ) VALUES ('legacy-feedback-v54', 'suggestion', 'legacy-suggestion-v54',
                 'visible', 'lower_priority', ?, '{"legacy":true}', ?)`
    ).run("c".repeat(64), AT - 1);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => AT }), {
      fromVersion: 54,
      toVersion: TARGET_VERSION,
    });
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM personalization_feedback WHERE id = ?")
        .get("legacy-feedback-v54").count,
      1
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("personalization_feedback_events").count,
      1
    );
    assert.equal(db.pragma("foreign_key_check").length, 0);
  } finally {
    db.close();
  }
});
