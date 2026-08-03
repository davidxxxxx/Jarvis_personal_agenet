"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");
const LearningGoalRepository = require("../../src/jarvis/main/LearningGoalRepository");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db, { now: () => 100 });
  let sequence = 0;
  const repository = new LearningGoalRepository(db, {
    createId: (prefix) => `${prefix}-${++sequence}`,
    now: () => 100 + sequence,
  });
  return { db, repository };
}

test("v52 adds local confirmed learning goals without weakening database integrity", () => {
  const { db } = fixture();
  try {
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
    assert.ok(TARGET_VERSION >= 52);
    assert.equal(db.prepare("SELECT count(*) AS count FROM learning_goals").get().count, 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
});

test("user-created learning goals are confirmed, idempotent and fully auditable", () => {
  const { db, repository } = fixture();
  try {
    const created = repository.create({ title: "  提升中英混合口语  ", at: 200 });
    assert.equal(created.status, "created");
    assert.equal(created.goal.state, "confirmed");
    assert.equal(created.goal.title, "提升中英混合口语");

    const duplicate = repository.create({ title: "提升中英混合口语", at: 201 });
    assert.equal(duplicate.status, "existing");
    assert.equal(duplicate.goal.id, created.goal.id);
    assert.equal(repository.listConfirmed().length, 1);

    const edited = repository.decide({
      goalId: created.goal.id,
      action: "edit",
      title: "完成英语演讲训练",
      at: 202,
    });
    assert.equal(edited.goal.title, "完成英语演讲训练");
    assert.equal(
      repository.decide({ goalId: created.goal.id, action: "archive", at: 203 }).goal.state,
      "archived"
    );
    assert.equal(repository.listConfirmed().length, 0);
    assert.equal(
      repository.decide({ goalId: created.goal.id, action: "restore", at: 204 }).goal.state,
      "confirmed"
    );
    assert.equal(repository.listConfirmed().length, 1);
    assert.equal(
      repository.decide({ goalId: created.goal.id, action: "delete", at: 205 }).goal.state,
      "deleted"
    );
    assert.deepEqual(repository.list(), []);

    assert.deepEqual(
      db
        .prepare(
          `SELECT action, actor FROM learning_goal_events
           WHERE learning_goal_id = ? ORDER BY occurred_at, id`
        )
        .all(created.goal.id),
      ["created", "edited", "archived", "restored", "deleted"].map((action) => ({
        action,
        actor: "user",
      }))
    );
    assert.throws(() => db.prepare("DELETE FROM learning_goal_events").run(), /immutable/u);
  } finally {
    db.close();
  }
});

test("Jarvis repository exposes only user-managed confirmed learning goals", (t) => {
  let sequence = 0;
  const repository = new JarvisRepository(":memory:", {
    createId: (prefix) => `${prefix}-${++sequence}`,
    now: () => 500 + sequence,
  });
  t.after(() => repository.close());

  const created = repository.createLearningGoal({ title: "掌握 CUDA 性能分析", at: 600 });
  assert.equal(created.goal.state, "confirmed");
  assert.deepEqual(repository.listConfirmedLearningGoals(), [created.goal]);
  repository.decideLearningGoal({ goalId: created.goal.id, action: "archive", at: 601 });
  assert.deepEqual(repository.listConfirmedLearningGoals(), []);
});
