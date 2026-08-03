const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

test("v41 persists todo verification and permits only user completed-to-open undo", () => {
  const db = new Database(":memory:");
  try {
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 1_000 }), {
      fromVersion: 0,
      toVersion: TARGET_VERSION,
    });
    assert.ok(TARGET_VERSION >= 41);
    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title, status, provenance,
         created_at, updated_at
       ) VALUES ('todo-v41', ?, ?, 'Ship alpha', 'open', 'suggestion', 1, 1)`
    ).run("a".repeat(64), "b".repeat(64));
    db.exec(`
      INSERT INTO todo_verification_decisions (
        id, todo_instance_id, state, reason, actor, occurred_at
      ) VALUES (
        'verification-v41', 'todo-v41', 'confirmed', 'user_confirmed', 'user', 2
      );
      INSERT INTO todo_state_transitions (
        id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
      ) VALUES (
        'complete-v41', 'todo-v41', 'open', 'completed', 'user_action', 'user', 3
      );
      INSERT INTO todo_state_transitions (
        id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
      ) VALUES (
        'reopen-v41', 'todo-v41', 'completed', 'open', 'user_action', 'user', 4
      );
    `);
    assert.deepEqual(db.prepare("SELECT status, completed_at, dismissed_at FROM todos_v2").get(), {
      status: "open",
      completed_at: null,
      dismissed_at: null,
    });
    assert.throws(
      () =>
        db
          .prepare("UPDATE todo_verification_decisions SET state = 'dismissed' WHERE id = ?")
          .run("verification-v41"),
      /immutable/u
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_state_transitions (
               id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
             ) VALUES (
               'system-complete-v41', 'todo-v41', 'open', 'completed',
               'analysis_created', 'system', 5
             )`
          )
          .run(),
      /reason contract/u
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
