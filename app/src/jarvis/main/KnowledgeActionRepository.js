"use strict";

const {
  KnowledgeActionLifecycleError,
  buildKnowledgeActionEvent,
  validateKnowledgeActionCommand,
  validateKnowledgeActionEvent,
} = require("./KnowledgeActionLifecycle");
const { canonicalTupleHash, canonicalizeText } = require("./MemoryMerger");

function fail(code, message) {
  throw new KnowledgeActionLifecycleError(code, message);
}

function requireSingleMetadataUpdate(result, entityKind) {
  if (result?.changes !== 1) {
    fail("KNOWLEDGE_ACTION_INVALID_STATE", `${entityKind} action metadata is unavailable`);
  }
}

function parseStoredEvent(row) {
  if (!row) return null;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    fail("KNOWLEDGE_ACTION_CORRUPT_EVENT", "stored knowledge action payload is invalid");
  }
  return validateKnowledgeActionEvent({
    schemaVersion: row.schema_version,
    commandId: row.command_id,
    commandFingerprint: row.command_fingerprint,
    type: row.action_type,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    at: row.occurred_at,
    payload,
  });
}

function publicReceipt(status, event) {
  return {
    status,
    commandId: event.commandId,
    type: event.type,
    entityKind: event.entityKind,
    entityId: event.entityId,
    occurredAt: event.at,
    todoId: event.payload.todoId ?? (event.entityKind === "todo" ? event.entityId : null),
  };
}

class KnowledgeActionRepository {
  constructor(db, { createId, feedbackRepository = null } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("database must be a live better-sqlite3 connection");
    }
    if (typeof createId !== "function") throw new TypeError("createId must be a function");
    if (
      feedbackRepository !== null &&
      (!feedbackRepository || typeof feedbackRepository !== "object")
    ) {
      throw new TypeError("feedbackRepository must be an object or null");
    }
    this.db = db;
    this.createId = createId;
    this.feedbackRepository = feedbackRepository;
  }

  _recordFeedback(method, input) {
    try {
      this.feedbackRepository?.[method]?.(input);
    } catch {
      // Learning is local and best-effort. It must never reverse an explicit user action.
    }
  }

  _nextId(prefix) {
    const value = this.createId(prefix);
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)) {
      throw new TypeError(`${prefix} id is invalid`);
    }
    return value;
  }

  _insertEvent(event) {
    const result = this.db
      .prepare(
        `INSERT INTO knowledge_action_events (
           command_id, schema_version, command_fingerprint, action_type,
           entity_kind, entity_id, payload_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.commandId,
        event.schemaVersion,
        event.commandFingerprint,
        event.type,
        event.entityKind,
        event.entityId,
        JSON.stringify(event.payload),
        event.at
      );
    return Number(result.lastInsertRowid);
  }

  _existingEvent(commandId) {
    return parseStoredEvent(
      this.db
        .prepare(
          `SELECT command_id, schema_version, command_fingerprint, action_type,
                  entity_kind, entity_id, payload_json, occurred_at
           FROM knowledge_action_events WHERE command_id = ?`
        )
        .get(commandId)
    );
  }

  _todo(todoId) {
    return this.db
      .prepare(
        `SELECT todo.id,
                COALESCE(
                  (SELECT revision.title FROM todo_revisions AS revision
                   WHERE revision.todo_instance_id = todo.id
                   ORDER BY revision.revision DESC LIMIT 1),
                  todo.title
                ) AS title,
                todo.status, todo.provenance,
                metadata.source_kind, metadata.source_session_id,
                metadata.pinned, metadata.urgency, metadata.user_modified,
                metadata.dismissed_from_verification_state,
                metadata.suppressed
         FROM todos_v2 AS todo
         LEFT JOIN todo_action_metadata AS metadata
           ON metadata.todo_instance_id = todo.id
         WHERE todo.id = ?`
      )
      .get(todoId);
  }

  _suggestion(suggestionId) {
    return this.db
      .prepare(
        `SELECT suggestion.id, suggestion.title, suggestion.state,
                COALESCE(metadata.effective_state, suggestion.state) AS effective_state,
                metadata.converted_todo_id, metadata.acceptance_undone
         FROM suggestions_v2 AS suggestion
         LEFT JOIN suggestion_action_metadata AS metadata
           ON metadata.suggestion_id = suggestion.id
         WHERE suggestion.id = ?`
      )
      .get(suggestionId);
  }

  _latestVerification(todoId) {
    return this.db
      .prepare(
        `SELECT effective_state AS state, reason, actor, occurred_at
         FROM todo_effective_verification WHERE todo_instance_id = ?`
      )
      .get(todoId);
  }

  _insertUserVerification(todoId, state, at) {
    this.db
      .prepare(
        `INSERT INTO todo_verification_decisions (
           id, todo_instance_id, state, reason, actor,
           source_analysis_input_id, occurred_at,
           trust_policy_id, trust_snapshot_state
         ) VALUES (
           ?, ?, ?, ?, 'user', NULL, ?,
           'user-authority-v1', 'user_override'
         )`
      )
      .run(
        this._nextId("todo_verification"),
        todoId,
        state,
        state === "dismissed" ? "user_dismissed" : "user_confirmed",
        at
      );
  }

  _insertTodo({ todoId, title, dueText, provenance, sourceKind, sessionId, at, eventSequence }) {
    const canonicalBaseKey = canonicalTupleHash(["todo", canonicalizeText(title), null]);
    const instanceKey = canonicalTupleHash(["knowledge_action", sourceKind, todoId, eventSequence]);
    this.db
      .prepare(
        `INSERT INTO todos_v2 (
           id, canonical_base_key, instance_key, title, owner_subject_kind,
           owner_subject_id, owner_display_name_snapshot, status,
           source_analysis_input_id, provenance, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'open', NULL, ?, ?, ?)`
      )
      .run(todoId, canonicalBaseKey, instanceKey, title, provenance, at, at);
    const revisionId = this._nextId("todo_revision");
    this.db
      .prepare(
        `INSERT INTO todo_revisions (
           id, todo_instance_id, revision, previous_revision_id, title, due_text,
           source_analysis_input_id, provenance, created_at
         ) VALUES (?, ?, 1, NULL, ?, ?, NULL, ?, ?)`
      )
      .run(revisionId, todoId, title, dueText, provenance, at);
    this.db
      .prepare(
        `INSERT INTO todo_action_metadata (
           todo_instance_id, source_kind, source_session_id, pinned, urgency,
           user_modified, dismissed_from_verification_state, dismiss_reason_code,
           dismiss_local_note, suppressed, updated_at, last_event_sequence
         ) VALUES (?, ?, ?, 0, 'normal', 0, NULL, NULL, NULL, 0, ?, ?)`
      )
      .run(todoId, sourceKind, sessionId, at, eventSequence);
    this._insertUserVerification(todoId, "confirmed", at);
    return revisionId;
  }

  _createManualTodo(command, eventSequence) {
    if (this._todo(command.todoId)) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "Todo already exists");
    }
    this._insertTodo({
      todoId: command.todoId,
      title: command.title,
      dueText: command.dueText,
      provenance: "legacy_unverified",
      sourceKind: "manual",
      sessionId: null,
      at: command.at,
      eventSequence,
    });
  }

  _transcriptSegments(command) {
    const placeholders = command.segmentIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                segment.text, segment.chunk_id, segment.track_id, segment.result_kind,
                segment.is_stable, segment.superseded_by, chunk.deleted_at
         FROM transcript_segments AS segment
         LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
         WHERE segment.id IN (${placeholders})`
      )
      .all(...command.segmentIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = command.segmentIds.map((segmentId) => byId.get(segmentId));
    if (
      ordered.some(
        (row) =>
          !row ||
          row.session_id !== command.sessionId ||
          row.result_kind !== "final" ||
          row.is_stable !== 1 ||
          row.superseded_by !== null
      )
    ) {
      fail(
        "KNOWLEDGE_ACTION_TRANSCRIPT_EVIDENCE_INVALID",
        "transcript Todo evidence must be stable final text from one session"
      );
    }
    return ordered;
  }

  _createTranscriptTodo(command, eventSequence) {
    if (this._todo(command.todoId)) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "Todo already exists");
    }
    const segments = this._transcriptSegments(command);
    const revisionId = this._insertTodo({
      todoId: command.todoId,
      title: command.title,
      dueText: command.dueText,
      provenance: "evidence_linked",
      sourceKind: "transcript",
      sessionId: command.sessionId,
      at: command.at,
      eventSequence,
    });
    const occurrenceId = this._nextId("todo_occurrence");
    const startedAt = Math.min(...segments.map((segment) => segment.started_at));
    const endedAt = Math.max(...segments.map((segment) => segment.ended_at));
    const fingerprint = canonicalTupleHash([
      "user_transcript_todo",
      command.todoId,
      command.title,
      command.dueText,
      command.segmentIds,
    ]);
    this.db
      .prepare(
        `INSERT INTO todo_occurrences (
           id, todo_instance_id, todo_revision_id, analysis_input_id, legacy_session_id,
           occurrence_key, candidate_item_fingerprint, started_at, ended_at, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        occurrenceId,
        command.todoId,
        revisionId,
        command.sessionId,
        canonicalTupleHash(["user_transcript_todo_occurrence", command.commandId]),
        fingerprint,
        startedAt,
        endedAt,
        command.at
      );
    const insertSegment = this.db.prepare(
      `INSERT INTO todo_action_segments (todo_instance_id, ordinal, segment_id)
       VALUES (?, ?, ?)`
    );
    const insertEvidence = this.db.prepare(
      `INSERT INTO evidence_refs (
         id, entity_type, entity_id, source_analysis_input_id, session_id,
         transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
         quote_text, audio_state, created_at
       ) VALUES (?, 'todo_occurrence', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    segments.forEach((segment, ordinal) => {
      insertSegment.run(command.todoId, ordinal, segment.id);
      insertEvidence.run(
        this._nextId("evidence"),
        occurrenceId,
        command.sessionId,
        segment.id,
        segment.chunk_id,
        segment.track_id,
        segment.started_at,
        segment.ended_at,
        segment.text,
        segment.chunk_id === null
          ? "missing"
          : segment.deleted_at === null
            ? "available"
            : "expired",
        command.at
      );
    });
  }

  _dismissTodo(command, eventSequence) {
    const todo = this._todo(command.todoId);
    if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
    if (todo.status !== "open" || todo.suppressed === 1) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "todo_dismiss requires an open Todo");
    }
    const verification = this._latestVerification(command.todoId);
    const priorState = verification?.state === "confirmed" ? "confirmed" : "pending_confirmation";
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET user_modified = 1,
             dismissed_from_verification_state = ?, dismiss_reason_code = ?,
             dismiss_local_note = ?, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(
          priorState,
          command.reasonCode,
          command.localNote,
          command.at,
          eventSequence,
          command.todoId
        ),
      "Todo"
    );
    this._insertUserVerification(command.todoId, "dismissed", command.at);
    this.db
      .prepare(
        `INSERT INTO todo_state_transitions (
           id, todo_instance_id, from_status, to_status, reason,
           source_analysis_input_id, actor, occurred_at
         ) VALUES (?, ?, 'open', 'dismissed', 'user_action', NULL, 'user', ?)`
      )
      .run(this._nextId("todo_transition"), command.todoId, command.at);
    this._recordFeedback("recordTodoDismissal", {
      todoId: command.todoId,
      title: todo.title,
      sourceKind: todo.source_kind ?? "unknown",
      reasonCode: command.reasonCode,
      occurredAt: command.at,
      eventId: command.commandId,
    });
  }

  _restoreTodo(command, eventSequence) {
    const todo = this._todo(command.todoId);
    if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
    if (todo.status !== "dismissed" || todo.suppressed === 1) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "todo_restore requires a dismissed Todo");
    }
    if (
      !new Set(["pending_confirmation", "confirmed"]).has(todo.dismissed_from_verification_state)
    ) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "Todo dismissal provenance is unavailable");
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET dismiss_reason_code = NULL, dismiss_local_note = NULL,
             user_modified = 1, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(command.at, eventSequence, command.todoId),
      "Todo"
    );
    this.db
      .prepare(
        `INSERT INTO todo_state_transitions (
           id, todo_instance_id, from_status, to_status, reason,
           source_analysis_input_id, actor, occurred_at
         ) VALUES (?, ?, 'dismissed', 'open', 'user_action', NULL, 'user', ?)`
      )
      .run(this._nextId("todo_transition"), command.todoId, command.at);
    if (todo.dismissed_from_verification_state === "confirmed") {
      this._insertUserVerification(command.todoId, "confirmed", command.at);
    }
    this._recordFeedback("recordTodoRestoration", {
      todoId: command.todoId,
      title: todo.title,
      sourceKind: todo.source_kind ?? "unknown",
      occurredAt: command.at,
      eventId: command.commandId,
    });
  }

  _setTodoFlag(command, eventSequence) {
    const todo = this._todo(command.todoId);
    if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
    if (todo.status !== "open" || todo.suppressed === 1) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", `${command.type} requires an open Todo`);
    }
    const pinned = command.type === "todo_pin" ? 1 : 0;
    if (todo.pinned === pinned) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", `${command.type} would not change the Todo`);
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET pinned = ?, user_modified = 1, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(pinned, command.at, eventSequence, command.todoId),
      "Todo"
    );
  }

  _setUrgency(command, eventSequence) {
    const todo = this._todo(command.todoId);
    if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
    if (todo.status !== "open" || todo.suppressed === 1) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "urgency_set requires an open Todo");
    }
    if (todo.urgency === command.urgency) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "urgency_set would not change the Todo");
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET urgency = ?, user_modified = 1, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(command.urgency, command.at, eventSequence, command.todoId),
      "Todo"
    );
  }

  _editTodo(command, eventSequence) {
    const todo = this._todo(command.todoId);
    if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
    if (todo.status !== "open" || todo.suppressed === 1) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "title_due_edit requires an open Todo");
    }
    const previous = this.db
      .prepare(
        `SELECT id, revision, title, due_text, provenance
         FROM todo_revisions WHERE todo_instance_id = ?
         ORDER BY revision DESC LIMIT 1`
      )
      .get(command.todoId);
    if (!previous) fail("KNOWLEDGE_ACTION_INVALID_STATE", "Todo revision is unavailable");
    const title = Object.prototype.hasOwnProperty.call(command, "title")
      ? command.title
      : previous.title;
    const dueText = Object.prototype.hasOwnProperty.call(command, "dueText")
      ? command.dueText
      : previous.due_text;
    if (title === previous.title && dueText === previous.due_text) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "title_due_edit would not change the Todo");
    }
    this.db
      .prepare(
        `INSERT INTO todo_revisions (
           id, todo_instance_id, revision, previous_revision_id, title, due_text,
           source_analysis_input_id, provenance, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        this._nextId("todo_revision"),
        command.todoId,
        previous.revision + 1,
        previous.id,
        title,
        dueText,
        previous.provenance,
        command.at
      );
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET user_modified = 1, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(command.at, eventSequence, command.todoId),
      "Todo"
    );
    this._recordFeedback("recordTodoEdit", {
      todoId: command.todoId,
      previousTitle: previous.title,
      nextTitle: title,
      sourceKind: todo.source_kind ?? "unknown",
      titleChanged: title !== previous.title,
      dueChanged: dueText !== previous.due_text,
      occurredAt: command.at,
      eventId: command.commandId,
    });
  }

  _dismissSuggestion(command, eventSequence) {
    const suggestion = this._suggestion(command.suggestionId);
    if (!suggestion) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "suggestion was not found");
    if (suggestion.effective_state !== "proposed") {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a proposed suggestion can be dismissed");
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE suggestion_action_metadata
         SET effective_state = 'dismissed', dismiss_reason_code = ?,
             updated_at = ?, last_event_sequence = ?
         WHERE suggestion_id = ?`
        )
        .run(command.reasonCode, command.at, eventSequence, command.suggestionId),
      "Suggestion"
    );
    this.db
      .prepare(
        `UPDATE suggestions_v2
         SET state = 'dismissed', decided_at = ?, updated_at = MAX(updated_at, ?)
         WHERE id = ?`
      )
      .run(command.at, command.at, command.suggestionId);
    this._recordFeedback("recordSuggestionDismissal", {
      suggestionId: command.suggestionId,
      summary: suggestion.title,
      reasonCode: command.reasonCode,
      occurredAt: command.at,
      eventId: command.commandId,
    });
  }

  _restoreSuggestion(command, eventSequence) {
    const suggestion = this._suggestion(command.suggestionId);
    if (!suggestion) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "suggestion was not found");
    if (suggestion.effective_state !== "dismissed") {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a dismissed suggestion can be restored");
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE suggestion_action_metadata
         SET effective_state = 'proposed', dismiss_reason_code = NULL,
             updated_at = ?, last_event_sequence = ?
         WHERE suggestion_id = ?`
        )
        .run(command.at, eventSequence, command.suggestionId),
      "Suggestion"
    );
    this.db
      .prepare(
        `UPDATE suggestions_v2
         SET state = 'proposed', decided_at = NULL, updated_at = MAX(updated_at, ?)
         WHERE id = ?`
      )
      .run(command.at, command.suggestionId);
    this._recordFeedback("recordSuggestionRestoration", {
      suggestionId: command.suggestionId,
      summary: suggestion.title,
      occurredAt: command.at,
      eventId: command.commandId,
    });
  }

  _acceptSuggestion(command, eventSequence) {
    const suggestion = this._suggestion(command.suggestionId);
    if (!suggestion) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "suggestion was not found");
    if (suggestion.effective_state !== "proposed") {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a proposed suggestion can be accepted");
    }
    const existingAcceptance = this.db
      .prepare(`SELECT todo_instance_id FROM suggestion_acceptances WHERE suggestion_id = ?`)
      .get(command.suggestionId);
    if (existingAcceptance && existingAcceptance.todo_instance_id !== command.todoId) {
      fail(
        "KNOWLEDGE_ACTION_INVALID_TRANSITION",
        "a restored suggestion must reuse its original converted Todo"
      );
    }
    if (!existingAcceptance && this._todo(command.todoId)) {
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "converted Todo already exists");
    }
    if (!existingAcceptance) {
      this._insertTodo({
        todoId: command.todoId,
        title: command.title,
        dueText: command.dueText,
        provenance: "suggestion",
        sourceKind: "suggestion",
        sessionId: null,
        at: command.at,
        eventSequence,
      });
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE suggestion_action_metadata
         SET effective_state = 'accepted', dismiss_reason_code = NULL,
             converted_todo_id = ?, acceptance_undone = 0,
             updated_at = ?, last_event_sequence = ?
         WHERE suggestion_id = ?`
        )
        .run(command.todoId, command.at, eventSequence, command.suggestionId),
      "Suggestion"
    );
    this.db
      .prepare(
        `UPDATE suggestions_v2
         SET state = 'accepted', decided_at = ?, updated_at = MAX(updated_at, ?)
         WHERE id = ?`
      )
      .run(command.at, command.at, command.suggestionId);

    if (!existingAcceptance) {
      this.db
        .prepare(
          `INSERT INTO suggestion_acceptances (
             suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
           ) VALUES (?, ?, ?, 'user', ?)`
        )
        .run(command.suggestionId, command.todoId, command.commandId, command.at);
      return;
    }

    const todo = this._todo(command.todoId);
    if (!todo || todo.status !== "dismissed" || todo.suppressed !== 1) {
      fail("KNOWLEDGE_ACTION_INVALID_STATE", "undone suggestion Todo is not restorable");
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET suppressed = 0, updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(command.at, eventSequence, command.todoId),
      "Todo"
    );
    this.db
      .prepare(
        `INSERT INTO todo_state_transitions (
           id, todo_instance_id, from_status, to_status, reason,
           source_analysis_input_id, actor, occurred_at
         ) VALUES (?, ?, 'dismissed', 'open', 'user_action', NULL, 'user', ?)`
      )
      .run(this._nextId("todo_transition"), command.todoId, command.at);
    this._insertUserVerification(command.todoId, "confirmed", command.at);
  }

  _undoSuggestionAcceptance(command, eventSequence) {
    const suggestion = this._suggestion(command.suggestionId);
    if (!suggestion) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "suggestion was not found");
    if (suggestion.effective_state !== "accepted" || !suggestion.converted_todo_id) {
      fail(
        "KNOWLEDGE_ACTION_INVALID_TRANSITION",
        "suggestion_accept_undo requires an accepted suggestion"
      );
    }
    const todo = this._todo(suggestion.converted_todo_id);
    const reminder = this.db
      .prepare("SELECT 1 FROM todo_reminders WHERE todo_instance_id = ?")
      .get(suggestion.converted_todo_id);
    if (
      !todo ||
      todo.status !== "open" ||
      todo.suppressed === 1 ||
      todo.user_modified === 1 ||
      reminder
    ) {
      fail(
        "KNOWLEDGE_ACTION_ACCEPT_UNDO_BLOCKED",
        "the converted Todo is no longer safe to remove"
      );
    }
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE todo_action_metadata
         SET suppressed = 1,
             dismissed_from_verification_state = 'confirmed',
             dismiss_reason_code = NULL, dismiss_local_note = NULL,
             updated_at = ?, last_event_sequence = ?
         WHERE todo_instance_id = ?`
        )
        .run(command.at, eventSequence, todo.id),
      "Todo"
    );
    this._insertUserVerification(todo.id, "dismissed", command.at);
    this.db
      .prepare(
        `INSERT INTO todo_state_transitions (
           id, todo_instance_id, from_status, to_status, reason,
           source_analysis_input_id, actor, occurred_at
         ) VALUES (?, ?, 'open', 'dismissed', 'user_action', NULL, 'user', ?)`
      )
      .run(this._nextId("todo_transition"), todo.id, command.at);
    requireSingleMetadataUpdate(
      this.db
        .prepare(
          `UPDATE suggestion_action_metadata
         SET effective_state = 'proposed', acceptance_undone = 1,
             updated_at = ?, last_event_sequence = ?
         WHERE suggestion_id = ?`
        )
        .run(command.at, eventSequence, command.suggestionId),
      "Suggestion"
    );
    this.db
      .prepare(
        `UPDATE suggestions_v2
         SET state = 'proposed', decided_at = NULL, updated_at = MAX(updated_at, ?)
         WHERE id = ?`
      )
      .run(command.at, command.suggestionId);
  }

  _applyCommand(command, eventSequence) {
    switch (command.type) {
      case "manual_create":
        return this._createManualTodo(command, eventSequence);
      case "transcript_create":
        return this._createTranscriptTodo(command, eventSequence);
      case "todo_dismiss":
        return this._dismissTodo(command, eventSequence);
      case "todo_restore":
        return this._restoreTodo(command, eventSequence);
      case "todo_pin":
      case "todo_unpin":
        return this._setTodoFlag(command, eventSequence);
      case "urgency_set":
        return this._setUrgency(command, eventSequence);
      case "title_due_edit":
        return this._editTodo(command, eventSequence);
      case "suggestion_dismiss":
        return this._dismissSuggestion(command, eventSequence);
      case "suggestion_restore":
        return this._restoreSuggestion(command, eventSequence);
      case "suggestion_accept":
        return this._acceptSuggestion(command, eventSequence);
      case "suggestion_accept_undo":
        return this._undoSuggestionAcceptance(command, eventSequence);
      default:
        fail("KNOWLEDGE_ACTION_INVALID_COMMAND", "knowledge action command type is invalid");
    }
  }

  apply(input) {
    const command = validateKnowledgeActionCommand(input);
    const event = buildKnowledgeActionEvent(command);
    const transaction = this.db.transaction(() => {
      const existing = this._existingEvent(event.commandId);
      if (existing) {
        if (existing.commandFingerprint !== event.commandFingerprint) {
          fail(
            "KNOWLEDGE_ACTION_COMMAND_ID_CONFLICT",
            "commandId was already used for a different action"
          );
        }
        return publicReceipt("already_applied", existing);
      }
      const eventSequence = this._insertEvent(event);
      this._applyCommand(command, eventSequence);
      return publicReceipt("applied", event);
    });
    return transaction.immediate();
  }
}

module.exports = { KnowledgeActionRepository };
