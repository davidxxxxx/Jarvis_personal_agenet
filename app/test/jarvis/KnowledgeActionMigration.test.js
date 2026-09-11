const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const {
  applyJarvisMigrations,
  TARGET_VERSION,
  upgradeTodoActionsV41,
} = require("../../src/jarvis/main/JarvisMigrations");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function insertTodo(db, id, { status = "open", at = 1 } = {}) {
  const completedAt = status === "completed" ? at : null;
  const dismissedAt = status === "dismissed" ? at : null;
  db.prepare(
    `INSERT INTO todos_v2 (
       id, canonical_base_key, instance_key, title, status,
       completed_at, dismissed_at, provenance, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'legacy_unverified', ?, ?)`
  ).run(
    id,
    hash(`base:${id}`),
    hash(`instance:${id}`),
    `Todo ${id}`,
    status,
    completedAt,
    dismissedAt,
    at,
    at
  );
}

function insertSuggestion(db, id, { state = "proposed", at = 1 } = {}) {
  db.prepare(
    `INSERT INTO suggestions_v2 (
       id, canonical_key, title, rationale, state, provenance,
       decided_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'Local rationale', ?, 'legacy_unverified', ?, ?, ?)`
  ).run(
    id,
    hash(`suggestion:${id}`),
    `Suggestion ${id}`,
    state,
    state === "proposed" ? null : at,
    at,
    at
  );
}

function appendEvent(db, { commandId, actionType, entityKind, entityId, payload = {}, at }) {
  return Number(
    db
      .prepare(
        `INSERT INTO knowledge_action_events (
           command_id, schema_version, command_fingerprint, action_type,
           entity_kind, entity_id, payload_json, occurred_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        commandId,
        hash(commandId),
        actionType,
        entityKind,
        entityId,
        JSON.stringify(payload),
        at
      ).lastInsertRowid
  );
}

function returnToV53(db) {
  db.exec(`
    DROP TRIGGER todos_v2_terminal_state;
    DROP TRIGGER todos_v2_require_transition;
    DROP TRIGGER todo_state_transitions_validate_insert;
    DROP TRIGGER todo_state_transitions_validate_state;
    DROP TRIGGER suggestions_v2_terminal_state;
    DROP TABLE todo_action_segments;
    DROP TABLE suggestion_action_metadata;
    DROP TABLE todo_action_metadata;
    DROP TABLE knowledge_action_events;
  `);
  upgradeTodoActionsV41(db);
  db.exec(`
    CREATE TRIGGER suggestions_v2_terminal_state
    BEFORE UPDATE OF state, decided_at ON suggestions_v2
    WHEN OLD.state IN ('accepted','dismissed') AND (
      NEW.state IS NOT OLD.state OR NEW.decided_at IS NOT OLD.decided_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'suggestion terminal state is immutable');
    END;
    PRAGMA user_version = 53;
  `);
}

test("v54 fresh schema installs the append-only action lifecycle", () => {
  const db = new Database(":memory:");
  try {
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 1_000 }), {
      fromVersion: 0,
      toVersion: TARGET_VERSION,
    });
    assert.ok(TARGET_VERSION >= 54);
    assert.deepEqual(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'knowledge_action_events','todo_action_metadata',
             'todo_action_segments','suggestion_action_metadata'
           ) ORDER BY name`
        )
        .all()
        .map((row) => row.name),
      [
        "knowledge_action_events",
        "suggestion_action_metadata",
        "todo_action_metadata",
        "todo_action_segments",
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v53 to v54 backfills existing Todos and suggestions without inventing action events", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    returnToV53(db);

    insertTodo(db, "todo-open", { status: "open", at: 10 });
    insertTodo(db, "todo-dismissed", { status: "dismissed", at: 11 });
    insertTodo(db, "todo-converted", { status: "open", at: 12 });
    insertSuggestion(db, "suggestion-proposed", { state: "proposed", at: 13 });
    insertSuggestion(db, "suggestion-dismissed", { state: "dismissed", at: 14 });
    insertSuggestion(db, "suggestion-accepted", { state: "accepted", at: 15 });
    db.prepare(
      `INSERT INTO suggestion_acceptances (
         suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
       ) VALUES ('suggestion-accepted', 'todo-converted', 'legacy-acceptance', 'user', 15)`
    ).run();

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 53,
      toVersion: TARGET_VERSION,
    });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM knowledge_action_events").get().count,
      0
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT todo_instance_id, source_kind, suppressed, last_event_sequence
           FROM todo_action_metadata ORDER BY todo_instance_id`
        )
        .all(),
      [
        {
          todo_instance_id: "todo-converted",
          source_kind: "existing",
          suppressed: 0,
          last_event_sequence: null,
        },
        {
          todo_instance_id: "todo-dismissed",
          source_kind: "existing",
          suppressed: 1,
          last_event_sequence: null,
        },
        {
          todo_instance_id: "todo-open",
          source_kind: "existing",
          suppressed: 0,
          last_event_sequence: null,
        },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT suggestion_id, effective_state, converted_todo_id,
                  acceptance_undone, last_event_sequence
           FROM suggestion_action_metadata ORDER BY suggestion_id`
        )
        .all(),
      [
        {
          suggestion_id: "suggestion-accepted",
          effective_state: "accepted",
          converted_todo_id: "todo-converted",
          acceptance_undone: 0,
          last_event_sequence: null,
        },
        {
          suggestion_id: "suggestion-dismissed",
          effective_state: "dismissed",
          converted_todo_id: null,
          acceptance_undone: 0,
          last_event_sequence: null,
        },
        {
          suggestion_id: "suggestion-proposed",
          effective_state: "proposed",
          converted_todo_id: null,
          acceptance_undone: 0,
          last_event_sequence: null,
        },
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("a file-backed v56 database upgrades through v58 and keeps action metadata after reopen", () => {
  const directory = path.resolve(__dirname, "../../.tmp-tests/knowledge-action-v57");
  const filename = path.join(directory, `knowledge-action-v56-${process.pid}-${Date.now()}.db`);
  fs.mkdirSync(directory, { recursive: true });
  let db;
  try {
    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db, { now: () => 1_000 });
    insertTodo(db, "todo-created-on-v56", { status: "open", at: 100 });
    insertSuggestion(db, "suggestion-created-on-v56", { state: "proposed", at: 101 });
    assert.deepEqual(
      db
        .prepare(
          `SELECT
             (SELECT count(*) FROM todo_action_metadata) AS todos,
             (SELECT count(*) FROM suggestion_action_metadata) AS suggestions`
        )
        .get(),
      { todos: 0, suggestions: 0 },
      "this fixture represents analysis-created v56 entities before the projection fix"
    );
    db.pragma("user_version = 56");
    db.close();
    db = null;

    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 56,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT todo_instance_id, source_kind, pinned, urgency, user_modified,
                  suppressed, last_event_sequence
           FROM todo_action_metadata`
        )
        .get(),
      {
        todo_instance_id: "todo-created-on-v56",
        source_kind: "existing",
        pinned: 0,
        urgency: "normal",
        user_modified: 0,
        suppressed: 0,
        last_event_sequence: null,
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT suggestion_id, effective_state, converted_todo_id,
                  acceptance_undone, last_event_sequence
           FROM suggestion_action_metadata`
        )
        .get(),
      {
        suggestion_id: "suggestion-created-on-v56",
        effective_state: "proposed",
        converted_todo_id: null,
        acceptance_undone: 0,
        last_event_sequence: null,
      }
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.prepare(
      `INSERT INTO sessions (id, started_at, ended_at, status, created_at)
       VALUES ('session-v57-source', 3000, 4000, 'completed', 3000)`
    ).run();
    insertTodo(db, "todo-v57-source", { status: "open", at: 3_000 });
    db.prepare(
      `INSERT INTO todo_action_metadata (
         todo_instance_id, source_kind, source_session_id, pinned, urgency,
         user_modified, dismissed_from_verification_state, dismiss_reason_code,
         dismiss_local_note, suppressed, updated_at, last_event_sequence
       ) VALUES (
         'todo-v57-source', 'existing', 'session-v57-source', 0, 'normal',
         0, NULL, NULL, NULL, 0, 3000, NULL
       )`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE todo_action_metadata SET source_session_id = NULL
             WHERE todo_instance_id = 'todo-v57-source'`
          )
          .run(),
      /todo action metadata source is immutable/u
    );
    assert.doesNotThrow(() =>
      db.prepare("DELETE FROM sessions WHERE id = 'session-v57-source'").run()
    );
    assert.equal(
      db
        .prepare(
          `SELECT source_session_id FROM todo_action_metadata
           WHERE todo_instance_id = 'todo-v57-source'`
        )
        .get().source_session_id,
      null,
      "ON DELETE SET NULL must not be mistaken for a user lifecycle mutation"
    );
    db.close();
    db = null;

    db = new Database(filename, { readonly: true });
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS count FROM todo_action_metadata").get().count, 2);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM suggestion_action_metadata").get().count,
      1
    );
  } finally {
    db?.close();
    fs.rmSync(filename, { force: true });
  }
});

test("knowledge action events enforce closed payloads, command idempotency, and immutability", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    const sequence = appendEvent(db, {
      commandId: "command-manual-1",
      actionType: "manual_create",
      entityKind: "todo",
      entityId: "todo-manual-1",
      payload: { title: "Create locally", dueText: null },
      at: 10,
    });
    assert.equal(sequence, 1);
    assert.equal(
      db
        .prepare(
          `INSERT OR IGNORE INTO knowledge_action_events (
             command_id, schema_version, command_fingerprint, action_type,
             entity_kind, entity_id, payload_json, occurred_at
           ) VALUES (?, 1, ?, 'manual_create', 'todo', 'todo-manual-1', ?, 10)`
        )
        .run(
          "command-manual-1",
          hash("command-manual-1"),
          JSON.stringify({ title: "Create locally", dueText: null })
        ).changes,
      0
    );

    for (const invalid of [
      {
        commandId: "command-extra-payload",
        actionType: "manual_create",
        entityKind: "todo",
        entityId: "todo-extra",
        payload: { title: "No extras", dueText: null, rawQuote: "private" },
        at: 11,
      },
      {
        commandId: "command-wrong-kind",
        actionType: "todo_restore",
        entityKind: "suggestion",
        entityId: "todo-manual-1",
        payload: {},
        at: 12,
      },
      {
        commandId: "command-duplicate-segments",
        actionType: "transcript_create",
        entityKind: "todo",
        entityId: "todo-transcript",
        payload: {
          title: "Transcript Todo",
          dueText: null,
          sessionId: "session-1",
          segmentIds: ["segment-1", "segment-1"],
        },
        at: 13,
      },
    ]) {
      assert.throws(() => appendEvent(db, invalid), /constraint|payload is invalid/u);
    }
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO knowledge_action_events (
               command_id, schema_version, command_fingerprint, action_type,
               entity_kind, entity_id, payload_json, occurred_at
             ) VALUES ('command-uppercase-hash', 1, ?, 'todo_restore',
                       'todo', 'todo-manual-1', '{}', 14)`
          )
          .run("A".repeat(64)),
      /constraint/u
    );
    assert.throws(
      () =>
        db.prepare("UPDATE knowledge_action_events SET occurred_at = 99 WHERE sequence = 1").run(),
      /immutable/u
    );
    assert.throws(
      () => db.prepare("DELETE FROM knowledge_action_events WHERE sequence = 1").run(),
      /immutable/u
    );
  } finally {
    db.close();
  }
});

test("dismissed Todo and terminal suggestion restore only through their latest action event", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    insertTodo(db, "todo-restore", { at: 1 });
    db.prepare(
      `INSERT INTO todo_action_metadata (
         todo_instance_id, source_kind, pinned, urgency, user_modified,
         suppressed, updated_at, last_event_sequence
       ) VALUES ('todo-restore', 'existing', 0, 'normal', 0, 0, 1, NULL)`
    ).run();

    const dismissSequence = appendEvent(db, {
      commandId: "command-dismiss-todo",
      actionType: "todo_dismiss",
      entityKind: "todo",
      entityId: "todo-restore",
      payload: { reasonCode: "wrong_context", localNote: "Not my task" },
      at: 10,
    });
    db.prepare(
      `UPDATE todo_action_metadata
       SET pinned = 0,
           user_modified = 1,
           dismissed_from_verification_state = 'confirmed',
           dismiss_reason_code = 'wrong_context',
           dismiss_local_note = 'Not my task',
           suppressed = 0,
           updated_at = 10,
           last_event_sequence = ?
       WHERE todo_instance_id = 'todo-restore'`
    ).run(dismissSequence);
    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
       ) VALUES ('dismiss-transition', 'todo-restore', 'open', 'dismissed',
                 'user_action', 'user', 10)`
    ).run();

    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE todos_v2
             SET status = 'open', dismissed_at = NULL, updated_at = 11
             WHERE id = 'todo-restore'`
          )
          .run(),
      /latest action event|transition history/u
    );

    const restoreSequence = appendEvent(db, {
      commandId: "command-restore-todo",
      actionType: "todo_restore",
      entityKind: "todo",
      entityId: "todo-restore",
      payload: {},
      at: 11,
    });
    db.prepare(
      `UPDATE todo_action_metadata
       SET user_modified = 1,
           dismiss_reason_code = NULL,
           dismiss_local_note = NULL,
           suppressed = 0,
           updated_at = 11,
           last_event_sequence = ?
       WHERE todo_instance_id = 'todo-restore'`
    ).run(restoreSequence);
    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
       ) VALUES ('restore-transition', 'todo-restore', 'dismissed', 'open',
                 'user_action', 'user', 11)`
    ).run();
    assert.equal(
      db.prepare("SELECT status FROM todos_v2 WHERE id = 'todo-restore'").get().status,
      "open"
    );

    insertSuggestion(db, "suggestion-restore", { at: 20 });
    db.prepare(
      `INSERT INTO suggestion_action_metadata (
         suggestion_id, effective_state, acceptance_undone, updated_at, last_event_sequence
       ) VALUES ('suggestion-restore', 'proposed', 0, 20, NULL)`
    ).run();
    const suggestionDismiss = appendEvent(db, {
      commandId: "command-dismiss-suggestion",
      actionType: "suggestion_dismiss",
      entityKind: "suggestion",
      entityId: "suggestion-restore",
      payload: { reasonCode: "low_value" },
      at: 21,
    });
    db.prepare(
      `UPDATE suggestion_action_metadata
       SET effective_state = 'dismissed', dismiss_reason_code = 'low_value',
           updated_at = 21, last_event_sequence = ?
       WHERE suggestion_id = 'suggestion-restore'`
    ).run(suggestionDismiss);
    db.prepare(
      `UPDATE suggestions_v2
       SET state = 'dismissed', decided_at = 21, updated_at = 21
       WHERE id = 'suggestion-restore'`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE suggestions_v2
             SET state = 'proposed', decided_at = NULL, updated_at = 22
             WHERE id = 'suggestion-restore'`
          )
          .run(),
      /latest action event/u
    );

    const suggestionRestore = appendEvent(db, {
      commandId: "command-restore-suggestion",
      actionType: "suggestion_restore",
      entityKind: "suggestion",
      entityId: "suggestion-restore",
      payload: {},
      at: 22,
    });
    db.prepare(
      `UPDATE suggestion_action_metadata
       SET effective_state = 'proposed', dismiss_reason_code = NULL,
           updated_at = 22, last_event_sequence = ?
       WHERE suggestion_id = 'suggestion-restore'`
    ).run(suggestionRestore);
    db.prepare(
      `UPDATE suggestions_v2
       SET state = 'proposed', decided_at = NULL, updated_at = 22
       WHERE id = 'suggestion-restore'`
    ).run();
    assert.equal(
      db.prepare("SELECT state FROM suggestions_v2 WHERE id = 'suggestion-restore'").get().state,
      "proposed"
    );

    insertTodo(db, "todo-accepted-undo", { at: 30 });
    insertSuggestion(db, "suggestion-accepted-undo", { state: "accepted", at: 30 });
    db.prepare(
      `INSERT INTO suggestion_acceptances (
         suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
       ) VALUES (
         'suggestion-accepted-undo', 'todo-accepted-undo',
         'acceptance-before-v54-event', 'user', 30
       )`
    ).run();
    db.prepare(
      `INSERT INTO suggestion_action_metadata (
         suggestion_id, effective_state, converted_todo_id,
         acceptance_undone, updated_at, last_event_sequence
       ) VALUES (
         'suggestion-accepted-undo', 'accepted', 'todo-accepted-undo', 0, 30, NULL
       )`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE suggestions_v2
             SET state = 'proposed', decided_at = NULL, updated_at = 31
             WHERE id = 'suggestion-accepted-undo'`
          )
          .run(),
      /latest action event/u
    );
    const acceptanceUndo = appendEvent(db, {
      commandId: "command-undo-suggestion-acceptance",
      actionType: "suggestion_accept_undo",
      entityKind: "suggestion",
      entityId: "suggestion-accepted-undo",
      payload: {},
      at: 31,
    });
    db.prepare(
      `UPDATE suggestion_action_metadata
       SET effective_state = 'proposed', acceptance_undone = 1,
           updated_at = 31, last_event_sequence = ?
       WHERE suggestion_id = 'suggestion-accepted-undo'`
    ).run(acceptanceUndo);
    db.prepare(
      `UPDATE suggestions_v2
       SET state = 'proposed', decided_at = NULL, updated_at = 31
       WHERE id = 'suggestion-accepted-undo'`
    ).run();
    assert.deepEqual(
      db
        .prepare(
          `SELECT suggestion.state, metadata.effective_state, metadata.acceptance_undone
           FROM suggestions_v2 AS suggestion
           JOIN suggestion_action_metadata AS metadata
             ON metadata.suggestion_id = suggestion.id
           WHERE suggestion.id = 'suggestion-accepted-undo'`
        )
        .get(),
      { state: "proposed", effective_state: "proposed", acceptance_undone: 1 }
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
