"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const MemoryRepository = require("../../src/jarvis/main/MemoryRepository");
const { canonicalTupleHash } = require("../../src/jarvis/main/MemoryMerger");
const { KnowledgeActionLifecycleError } = require("../../src/jarvis/main/KnowledgeActionLifecycle");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BASE_AT = 1_786_100_000_000;

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db, { now: () => BASE_AT - 10_000 });
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-action-1', 1000, 8000, 'completed', 1000);
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-action-mic', 'session-action-1', 'mic', 24000, 1, 1000, 8000, 'stopped'
    );
    INSERT INTO audio_chunks (
      id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, track_id, source_type, sequence_number, write_state
    ) VALUES
      ('chunk-action-1', 'session-action-1', 'action-1.flac', 1200, 3400, 2200,
       '${HASH_A}', ${BASE_AT + 100_000}, 'completed', 'track-action-mic', 'mic', 0, 'committed'),
      ('chunk-action-2', 'session-action-1', 'action-2.flac', 3600, 5200, 1600,
       '${HASH_B}', ${BASE_AT + 100_000}, 'completed', 'track-action-mic', 'mic', 1, 'committed');
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
      is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
      version, model_version, completed_at
    ) VALUES
      ('segment-action-1', 'session-action-1', 1200, 3400, NULL, 'SELF',
       '我来整理会议纪要', 0.96, 1, 'analyzed', 'track-action-mic', 'chunk-action-1',
       'mic', 'final', 1, 'whisper-v1', 3400),
      ('segment-action-2', 'session-action-1', 3600, 5200, NULL, 'SELF',
       '明天发送给团队', 0.95, 1, 'analyzed', 'track-action-mic', 'chunk-action-2',
       'mic', 'final', 1, 'whisper-v1', 5200);
  `);
  const counters = new Map();
  const repository = new MemoryRepository(db, {
    createId(prefix) {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-action-${next}`;
    },
    now: () => BASE_AT,
    validateRedactedCloudPayload: () => true,
  });
  return { db, repository };
}

function command(type, overrides = {}) {
  return {
    commandId: `command-${type}-${overrides.todoId ?? overrides.suggestionId ?? "1"}`,
    type,
    at: BASE_AT,
    ...overrides,
  };
}

function insertSuggestion(db, id = "suggestion-action-1") {
  db.prepare(
    `INSERT INTO suggestions_v2 (
       id, canonical_key, title, rationale, state, source_analysis_input_id,
       provenance, decided_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'proposed', NULL, 'legacy_unverified', NULL, ?, ?)`
  ).run(
    id,
    canonicalTupleHash(["knowledge-action-suggestion", id]),
    "整理会议纪要",
    "这是经过允许场景门禁后的候选建议",
    BASE_AT - 100,
    BASE_AT - 100
  );
  db.prepare(
    `INSERT INTO suggestion_action_metadata (
       suggestion_id, effective_state, dismiss_reason_code, converted_todo_id,
       acceptance_undone, updated_at, last_event_sequence
     ) VALUES (?, 'proposed', NULL, NULL, 0, ?, NULL)`
  ).run(id, BASE_AT - 100);
}

function insertTodoWithoutActionMetadata(db, id = "todo-missing-action-metadata") {
  db.prepare(
    `INSERT INTO todos_v2 (
       id, canonical_base_key, instance_key, title, status,
       provenance, created_at, updated_at
     ) VALUES (?, ?, ?, 'Original title', 'open', 'legacy_unverified', ?, ?)`
  ).run(
    id,
    canonicalTupleHash(["missing-action-metadata-base", id]),
    canonicalTupleHash(["missing-action-metadata-instance", id]),
    BASE_AT - 100,
    BASE_AT - 100
  );
  db.prepare(
    `INSERT INTO todo_revisions (
       id, todo_instance_id, revision, previous_revision_id, title, due_text,
       source_analysis_input_id, provenance, created_at
     ) VALUES (?, ?, 1, NULL, 'Original title', NULL, NULL, 'legacy_unverified', ?)`
  ).run(`revision-${id}`, id, BASE_AT - 100);
}

function insertSuggestionWithoutActionMetadata(db, id = "suggestion-missing-action-metadata") {
  db.prepare(
    `INSERT INTO suggestions_v2 (
       id, canonical_key, title, rationale, state, source_analysis_input_id,
       provenance, decided_at, created_at, updated_at
     ) VALUES (?, ?, 'Original suggestion', 'Local rationale', 'proposed', NULL,
               'legacy_unverified', NULL, ?, ?)`
  ).run(
    id,
    canonicalTupleHash(["missing-action-metadata-suggestion", id]),
    BASE_AT - 100,
    BASE_AT - 100
  );
}

test("manual Todo lifecycle is durable, editable and command-idempotent", () => {
  const { db, repository } = fixture();
  try {
    const create = command("manual_create", {
      todoId: "todo-manual-action-1",
      title: "整理会议纪要",
      dueText: null,
    });
    assert.equal(repository.applyKnowledgeAction(create).status, "applied");
    assert.equal(repository.applyKnowledgeAction(create).status, "already_applied");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_action_events").get().count,
      1
    );

    repository.applyKnowledgeAction(
      command("todo_pin", {
        commandId: "command-pin-manual-1",
        todoId: "todo-manual-action-1",
        at: BASE_AT + 1,
      })
    );
    repository.applyKnowledgeAction(
      command("urgency_set", {
        commandId: "command-urgent-manual-1",
        todoId: "todo-manual-action-1",
        urgency: "urgent",
        at: BASE_AT + 2,
      })
    );
    repository.applyKnowledgeAction(
      command("title_due_edit", {
        commandId: "command-edit-manual-1",
        todoId: "todo-manual-action-1",
        title: "整理并发送会议纪要",
        dueText: "明天",
        at: BASE_AT + 3,
      })
    );

    const todo = repository
      .readPublicSnapshot()
      .todos.find((entry) => entry.id === "todo-manual-action-1");
    assert.deepEqual(
      {
        title: todo.title,
        sourceKind: todo.sourceKind,
        pinned: todo.pinned,
        urgency: todo.urgency,
        userModified: todo.userModified,
        verificationState: todo.verificationState,
        dueText: todo.revisions.at(-1).dueText,
      },
      {
        title: "整理并发送会议纪要",
        sourceKind: "manual",
        pinned: true,
        urgency: "urgent",
        userModified: true,
        verificationState: "confirmed",
        dueText: "明天",
      }
    );
    const editFeedback = db
      .prepare(
        `SELECT corrected_value, feature_json
         FROM personalization_feedback_events
         WHERE domain = 'todo' AND source_entity_id = ?
         ORDER BY occurred_at DESC, id DESC LIMIT 1`
      )
      .get("todo-manual-action-1");
    assert.equal(editFeedback.corrected_value, "edited:title+due");
    const editFeatures = JSON.parse(editFeedback.feature_json);
    assert.deepEqual(Object.keys(editFeatures).sort(), [
      "dueChanged",
      "nextContentFingerprint",
      "previousContentFingerprint",
      "sourceKind",
      "titleChanged",
    ]);
    assert.equal(editFeatures.dueChanged, true);
    assert.equal(editFeatures.titleChanged, true);
    assert.equal(editFeatures.sourceKind, "manual");
    assert.match(editFeatures.previousContentFingerprint, /^[0-9a-f]{64}$/u);
    assert.match(editFeatures.nextContentFingerprint, /^[0-9a-f]{64}$/u);
    assert.notEqual(editFeatures.previousContentFingerprint, editFeatures.nextContentFingerprint);
    assert.doesNotMatch(editFeedback.feature_json, /会议纪要/u);

    assert.throws(
      () =>
        repository.applyKnowledgeAction({
          ...create,
          title: "复用 commandId 篡改内容",
        }),
      (error) =>
        error instanceof KnowledgeActionLifecycleError &&
        error.code === "KNOWLEDGE_ACTION_COMMAND_ID_CONFLICT"
    );
  } finally {
    db.close();
  }
});

test("transcript Todo keeps stable segment evidence and fails closed across sessions", () => {
  const { db, repository } = fixture();
  try {
    repository.applyKnowledgeAction(
      command("transcript_create", {
        todoId: "todo-transcript-action-1",
        title: "发送会议纪要",
        dueText: "明天",
        sessionId: "session-action-1",
        segmentIds: ["segment-action-1", "segment-action-2"],
      })
    );
    const todo = repository
      .readPublicSnapshot()
      .todos.find((entry) => entry.id === "todo-transcript-action-1");
    assert.equal(todo.sourceKind, "transcript");
    assert.equal(todo.sourceSessionId, "session-action-1");
    assert.deepEqual(
      todo.occurrences.flatMap((occurrence) => occurrence.evidence.map((entry) => entry.segmentId)),
      ["segment-action-1", "segment-action-2"]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT segment_id FROM todo_action_segments
           WHERE todo_instance_id = ? ORDER BY ordinal`
        )
        .all("todo-transcript-action-1")
        .map((row) => row.segment_id),
      ["segment-action-1", "segment-action-2"]
    );

    assert.throws(
      () =>
        repository.applyKnowledgeAction(
          command("transcript_create", {
            commandId: "command-cross-session",
            todoId: "todo-transcript-action-invalid",
            title: "错误来源",
            dueText: null,
            sessionId: "missing-session",
            segmentIds: ["segment-action-1"],
          })
        ),
      (error) => error?.code === "KNOWLEDGE_ACTION_TRANSCRIPT_EVIDENCE_INVALID"
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM knowledge_action_events WHERE command_id = ?")
        .get("command-cross-session").count,
      0,
      "the failed command and its audit event must roll back together"
    );
  } finally {
    db.close();
  }
});

test("Todo dismissal records a local reason and restoration preserves prior verification", () => {
  const { db, repository } = fixture();
  try {
    repository.applyKnowledgeAction(
      command("manual_create", {
        todoId: "todo-dismiss-action-1",
        title: "检查录音",
        dueText: null,
      })
    );
    repository.applyKnowledgeAction(
      command("todo_dismiss", {
        commandId: "command-dismiss-action-1",
        todoId: "todo-dismiss-action-1",
        reasonCode: "wrong_context",
        localNote: "这是视频内容，不是我的任务。",
        at: BASE_AT + 1,
      })
    );
    let todo = repository
      .readPublicSnapshot()
      .todos.find((entry) => entry.id === "todo-dismiss-action-1");
    assert.equal(todo.status, "dismissed");
    assert.equal(todo.dismissReasonCode, "wrong_context");
    assert.equal(
      db
        .prepare("SELECT dismiss_local_note FROM todo_action_metadata WHERE todo_instance_id = ?")
        .get(todo.id).dismiss_local_note,
      "这是视频内容，不是我的任务。"
    );
    const todoFeedback = db
      .prepare(
        `SELECT domain, corrected_value, feature_json
         FROM personalization_feedback WHERE source_entity_id = ?`
      )
      .get(todo.id);
    assert.equal(todoFeedback.domain, "todo");
    assert.equal(todoFeedback.corrected_value, "dismissed:wrong_context");
    assert.doesNotMatch(todoFeedback.feature_json, /视频内容/u);

    repository.applyKnowledgeAction(
      command("todo_restore", {
        commandId: "command-restore-action-1",
        todoId: todo.id,
        at: BASE_AT + 2,
      })
    );
    todo = repository.readPublicSnapshot().todos.find((entry) => entry.id === todo.id);
    assert.equal(todo.status, "open");
    assert.equal(todo.verificationState, "confirmed");
    assert.equal(todo.dismissReasonCode, null);
  } finally {
    db.close();
  }
});

test("suggestion dismissal, restoration, acceptance and safe undo remain reversible", () => {
  const { db, repository } = fixture();
  try {
    insertSuggestion(db);
    repository.applyKnowledgeAction(
      command("suggestion_dismiss", {
        suggestionId: "suggestion-action-1",
        reasonCode: "low_value",
      })
    );
    assert.equal(repository.readPublicSnapshot().suggestions[0].state, "dismissed");
    assert.deepEqual(
      db
        .prepare(
          `SELECT domain, corrected_value FROM personalization_feedback
           WHERE source_entity_id = ? ORDER BY occurred_at, id`
        )
        .all("suggestion-action-1"),
      [{ domain: "suggestion", corrected_value: "lower_priority" }]
    );
    repository.applyKnowledgeAction(
      command("suggestion_restore", {
        commandId: "command-suggestion-restore-1",
        suggestionId: "suggestion-action-1",
        at: BASE_AT + 1,
      })
    );
    assert.equal(repository.readPublicSnapshot().suggestions[0].state, "proposed");
    assert.deepEqual(
      db
        .prepare(
          `SELECT corrected_value FROM personalization_feedback
           WHERE source_entity_id = ? ORDER BY occurred_at, id`
        )
        .all("suggestion-action-1")
        .map((row) => row.corrected_value),
      ["lower_priority", "restored"]
    );

    repository.applyKnowledgeAction(
      command("suggestion_accept", {
        commandId: "command-suggestion-accept-1",
        suggestionId: "suggestion-action-1",
        todoId: "todo-from-suggestion-1",
        title: "整理会议纪要",
        dueText: null,
        at: BASE_AT + 2,
      })
    );
    let snapshot = repository.readPublicSnapshot();
    assert.equal(snapshot.suggestions[0].state, "accepted");
    assert.equal(snapshot.suggestions[0].convertedTodoId, "todo-from-suggestion-1");
    assert.ok(snapshot.todos.some((todo) => todo.id === "todo-from-suggestion-1"));

    repository.applyKnowledgeAction(
      command("suggestion_accept_undo", {
        commandId: "command-suggestion-undo-1",
        suggestionId: "suggestion-action-1",
        at: BASE_AT + 3,
      })
    );
    snapshot = repository.readPublicSnapshot();
    assert.equal(snapshot.suggestions[0].state, "proposed");
    assert.equal(snapshot.suggestions[0].acceptanceUndone, true);
    assert.equal(
      snapshot.todos.some((todo) => todo.id === "todo-from-suggestion-1"),
      false
    );

    repository.applyKnowledgeAction(
      command("suggestion_accept", {
        commandId: "command-suggestion-reaccept-1",
        suggestionId: "suggestion-action-1",
        todoId: "todo-from-suggestion-1",
        title: "整理会议纪要",
        dueText: null,
        at: BASE_AT + 4,
      })
    );
    snapshot = repository.readPublicSnapshot();
    assert.equal(snapshot.suggestions[0].state, "accepted");
    assert.equal(
      snapshot.todos.find((todo) => todo.id === "todo-from-suggestion-1").status,
      "open"
    );
  } finally {
    db.close();
  }
});

test("lifecycle commands fail closed and roll back their events when action metadata is missing", () => {
  const { db, repository } = fixture();
  try {
    insertTodoWithoutActionMetadata(db);
    insertSuggestionWithoutActionMetadata(db);

    assert.throws(
      () =>
        repository.applyKnowledgeAction(
          command("title_due_edit", {
            commandId: "command-edit-missing-metadata",
            todoId: "todo-missing-action-metadata",
            title: "Must roll back",
          })
        ),
      (error) =>
        error instanceof KnowledgeActionLifecycleError &&
        error.code === "KNOWLEDGE_ACTION_INVALID_STATE"
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT revision, title FROM todo_revisions
           WHERE todo_instance_id = ? ORDER BY revision`
        )
        .all("todo-missing-action-metadata"),
      [{ revision: 1, title: "Original title" }],
      "the revision written before the metadata check must roll back"
    );

    assert.throws(
      () =>
        repository.applyKnowledgeAction(
          command("suggestion_accept", {
            commandId: "command-accept-missing-metadata",
            suggestionId: "suggestion-missing-action-metadata",
            todoId: "todo-created-before-missing-metadata-check",
            title: "Must also roll back",
            dueText: null,
          })
        ),
      (error) =>
        error instanceof KnowledgeActionLifecycleError &&
        error.code === "KNOWLEDGE_ACTION_INVALID_STATE"
    );
    assert.deepEqual(
      db
        .prepare("SELECT state, decided_at FROM suggestions_v2 WHERE id = ?")
        .get("suggestion-missing-action-metadata"),
      { state: "proposed", decided_at: null }
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM todos_v2 WHERE id = ?")
        .get("todo-created-before-missing-metadata-check").count,
      0,
      "the converted Todo created before the metadata check must roll back"
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM suggestion_acceptances").get().count, 0);
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS count FROM knowledge_action_events
           WHERE command_id IN (?, ?)`
        )
        .get("command-edit-missing-metadata", "command-accept-missing-metadata").count,
      0,
      "failed lifecycle commands must not leave append-only events behind"
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM personalization_feedback_events").get().count,
      0
    );
  } finally {
    db.close();
  }
});
