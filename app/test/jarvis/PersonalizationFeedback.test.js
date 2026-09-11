"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const PersonalizationFeedbackRepository = require("../../src/jarvis/main/PersonalizationFeedbackRepository");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

const AT = 1_786_200_000_000;

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db, { now: () => AT - 1_000 });
  return { db, feedback: new PersonalizationFeedbackRepository(db) };
}

test("Todo, suggestion and person feedback remain isolated local domains", () => {
  const { db, feedback } = fixture();
  try {
    feedback.recordTodoDismissal({
      todoId: "todo-feedback-1",
      title: "联系客户",
      sourceKind: "analysis",
      reasonCode: "not_my_task",
      occurredAt: AT,
    });
    feedback.recordPersonCorrection({
      clusterId: "cluster-feedback-1",
      originalPersonId: null,
      correctedPersonId: "person-feedback-1",
      action: "confirmed",
      sourceKind: "mic",
      scope: "persistent",
      occurredAt: AT + 1,
    });
    feedback.recordSuggestionDismissal({
      suggestionId: "suggestion-feedback-1",
      summary: "整理会议纪要",
      reasonCode: "low_value",
      occurredAt: AT + 2,
    });

    const rows = db
      .prepare(
        `SELECT domain, source_entity_id, original_value, corrected_value, feature_json
         FROM personalization_feedback ORDER BY occurred_at, id`
      )
      .all();
    assert.deepEqual(
      rows.map((row) => row.domain),
      ["todo", "person", "suggestion"]
    );
    assert.equal(rows[0].source_entity_id, "todo-feedback-1");
    assert.equal(rows[0].corrected_value, "dismissed:not_my_task");
    assert.deepEqual(Object.keys(JSON.parse(rows[0].feature_json)).sort(), [
      "contentFingerprint",
      "sourceKind",
    ]);
    assert.doesNotMatch(rows[0].feature_json, /客户/u);
    assert.equal(rows[1].source_entity_id, "cluster-feedback-1");
    assert.equal(rows[1].corrected_value, "confirmed:person-feedback-1");
    assert.equal(rows[2].corrected_value, "lower_priority");
  } finally {
    db.close();
  }
});

test("suggestion dismissal is idempotent and restoration neutralizes its local penalty", () => {
  const { db, feedback } = fixture();
  try {
    const input = {
      suggestionId: "suggestion-feedback-2",
      summary: "复习英语口语",
      reasonCode: "not_relevant",
      occurredAt: AT,
    };
    feedback.recordSuggestionDismissal(input);
    feedback.recordSuggestionDismissal(input);
    assert.equal(feedback.suggestionPenalty(input.summary), 0.15);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM personalization_feedback").get().count,
      1
    );

    feedback.recordSuggestionRestoration({
      suggestionId: input.suggestionId,
      summary: input.summary,
      occurredAt: AT + 1,
    });
    assert.equal(feedback.suggestionPenalty(input.summary), 0);
    assert.deepEqual(
      db
        .prepare(
          `SELECT corrected_value FROM personalization_feedback
           WHERE domain = 'suggestion' ORDER BY occurred_at, id`
        )
        .all()
        .map((row) => row.corrected_value),
      ["lower_priority", "restored"]
    );

    feedback.recordSuggestionDismissal({
      ...input,
      occurredAt: AT + 2,
    });
    assert.equal(feedback.suggestionPenalty(input.summary), 0.15);
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS count FROM personalization_feedback_events
           WHERE domain = 'suggestion' AND source_entity_id = ?`
        )
        .get(input.suggestionId).count,
      3
    );
  } finally {
    db.close();
  }
});

test("only active strong Todo feedback suppresses an exact repeated candidate", () => {
  const { db, feedback } = fixture();
  try {
    const input = {
      todoId: "todo-feedback-repeat",
      title: "联系客户确认合同",
      sourceKind: "existing",
      reasonCode: "wrong_context",
      occurredAt: AT,
    };
    feedback.recordTodoDismissal(input);
    assert.equal(feedback.shouldSuppressTodo(input.title), true);
    assert.equal(feedback.shouldSuppressTodo("联系客户确认发票"), false);

    feedback.recordTodoRestoration({
      todoId: input.todoId,
      title: input.title,
      sourceKind: input.sourceKind,
      occurredAt: AT + 1,
    });
    assert.equal(feedback.shouldSuppressTodo(input.title), false);

    feedback.recordTodoDismissal({ ...input, occurredAt: AT + 2 });
    assert.equal(feedback.shouldSuppressTodo(input.title), true);

    feedback.recordTodoRestoration({
      todoId: input.todoId,
      title: input.title,
      sourceKind: input.sourceKind,
      occurredAt: AT + 3,
    });
    feedback.recordTodoDismissal({
      ...input,
      reasonCode: "already_done",
      occurredAt: AT + 4,
    });
    assert.equal(feedback.shouldSuppressTodo(input.title), false);
  } finally {
    db.close();
  }
});

test("only persistent user speaker corrections enter the person feedback domain", (t) => {
  let nextId = 0;
  let now = AT;
  const repository = new JarvisRepository(":memory:", {
    createId: (prefix) => `${prefix}-feedback-${++nextId}`,
    now: () => ++now,
  });
  t.after(() => repository.close());
  repository.createSession({ id: "session-person-feedback", startedAt: 1_000 });
  repository.createTrack({
    id: "track-person-feedback",
    sessionId: "session-person-feedback",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repository.createSpeakerCluster({
    id: "cluster-person-feedback",
    sessionId: "session-person-feedback",
    trackId: "track-person-feedback",
    localLabel: "speaker_1",
    modelId: "campplus-v1",
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    speechMs: 18_000,
    windowCount: 4,
    qualityScore: 0.9,
    createdAt: AT,
  });
  repository.renamePerson({ personId: "person-feedback-target", displayName: "人物 1" });

  repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-person-feedback",
    personId: "person-feedback-target",
    scope: "session",
    actor: "user",
  });
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM personalization_feedback_events WHERE domain = 'person'"
      )
      .get().count,
    0
  );
  repository.undoSpeakerCorrection("cluster-person-feedback");

  repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-person-feedback",
    personId: "person-feedback-target",
    scope: "persistent",
    actor: "user",
  });
  repository.undoSpeakerCorrection("cluster-person-feedback");
  repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-person-feedback",
    personId: "person-feedback-target",
    scope: "persistent",
    actor: "user",
  });

  const events = repository.db
    .prepare(
      `SELECT event_state, corrected_value, feature_json
       FROM personalization_feedback_events
       WHERE domain = 'person' AND source_entity_id = ?
       ORDER BY occurred_at, id`
    )
    .all("cluster-person-feedback");
  assert.deepEqual(
    events.map((entry) => entry.event_state),
    ["active", "retracted", "active"]
  );
  assert.equal(events[0].corrected_value, "confirmed:person-feedback-target");
  assert.deepEqual(JSON.parse(events[0].feature_json), {
    action: "confirmed",
    scope: "persistent",
    sourceKind: "mic",
  });
  assert.doesNotMatch(events.map((entry) => entry.feature_json).join("\n"), /人物 1/u);
});

test("a user-confirmed person merge records only anonymous persistent feedback", (t) => {
  let nextId = 0;
  let now = AT;
  const repository = new JarvisRepository(":memory:", {
    createId: (prefix) => `${prefix}-merge-feedback-${++nextId}`,
    now: () => ++now,
  });
  t.after(() => repository.close());

  repository.renamePerson({ personId: "person-merge-source", displayName: "张三" });
  repository.renamePerson({ personId: "person-merge-target", displayName: "李四" });
  repository.mergeSpeakerPeople({
    sourcePersonId: "person-merge-source",
    targetPersonId: "person-merge-target",
    actor: "user",
  });

  const events = repository.db
    .prepare(
      `SELECT source_entity_id, original_value, corrected_value, feature_json
       FROM personalization_feedback_events
       WHERE domain = 'person'
       ORDER BY occurred_at, id`
    )
    .all();
  assert.deepEqual(events, [
    {
      source_entity_id: "person-merge-source",
      original_value: "person-merge-source",
      corrected_value: "merged:person-merge-target",
      feature_json: JSON.stringify({
        action: "merged",
        scope: "persistent",
        sourceKind: "person_profile",
      }),
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /张三|李四/u);
});
