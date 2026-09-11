"use strict";

const crypto = require("node:crypto");

/**
 * Pure append-only lifecycle rules for user-visible Todo and suggestion actions.
 *
 * The repository layer owns IDs, transactions and persistence. This module owns
 * closed command/event validation and deterministic state transitions so v52 can
 * replay the action log without consulting Electron, SQLite or cloud services.
 */

const KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION = 1;
const DISMISS_REASON_CODES = Object.freeze([
  "not_relevant",
  "already_done",
  "not_mine",
  "wrong_context",
  "low_value",
  "other",
]);
const DISMISS_REASON_SET = new Set(DISMISS_REASON_CODES);
const COMMAND_TYPES = Object.freeze([
  "manual_create",
  "transcript_create",
  "todo_dismiss",
  "todo_restore",
  "suggestion_dismiss",
  "suggestion_restore",
  "suggestion_accept",
  "suggestion_accept_undo",
  "todo_pin",
  "todo_unpin",
  "urgency_set",
  "title_due_edit",
]);
const COMMAND_TYPE_SET = new Set(COMMAND_TYPES);
const TODO_STATUS_SET = new Set(["open", "completed", "dismissed"]);
const TODO_VERIFICATION_SET = new Set(["pending_confirmation", "confirmed", "dismissed"]);
const TODO_URGENCY_SET = new Set(["normal", "urgent"]);
const TODO_SOURCE_KIND_SET = new Set(["manual", "transcript", "suggestion", "existing"]);
const SUGGESTION_STATE_SET = new Set(["proposed", "accepted", "dismissed"]);
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const COMMAND_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TITLE_MAX_LENGTH = 512;
const DUE_TEXT_MAX_LENGTH = 256;
const LOCAL_NOTE_MAX_LENGTH = 500;
const MAX_SEGMENT_REFERENCES = 512;

class KnowledgeActionLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KnowledgeActionLifecycleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new KnowledgeActionLifecycleError(code, message);
}

function plainObject(value, name, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${name} must be an object`);
  }
  return value;
}

function exactKeys(value, required, optional, name, code) {
  const object = plainObject(value, name, code);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(object, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    fail(code, `${name} has an invalid shape`);
  }
  return object;
}

function identifier(value, name, code) {
  if (typeof value !== "string" || !ENTITY_ID_PATTERN.test(value)) {
    fail(code, `${name} is invalid`);
  }
  return value;
}

function timestamp(value, name, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${name} is invalid`);
  }
  return value;
}

function boundedText(value, name, maxLength, code) {
  if (typeof value !== "string") fail(code, `${name} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    fail(code, `${name} is invalid`);
  }
  return normalized;
}

function nullableText(value, name, maxLength, code) {
  if (value === null) return null;
  return boundedText(value, name, maxLength, code);
}

function optionalLocalNote(value, code) {
  if (value === undefined || value === null) return null;
  return boundedText(value, "localNote", LOCAL_NOTE_MAX_LENGTH, code);
}

function booleanValue(value, fallback, name, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(code, `${name} is invalid`);
  return value;
}

function enumValue(value, allowed, name, code) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(code, `${name} is invalid`);
  }
  return value;
}

function segmentReferences(value, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEGMENT_REFERENCES) {
    fail(code, "segmentIds are invalid");
  }
  const normalized = value.map((entry) => identifier(entry, "segmentId", code));
  if (new Set(normalized).size !== normalized.length) {
    fail(code, "segmentIds must be unique");
  }
  return normalized;
}

function reasonCode(value, code) {
  if (typeof value !== "string" || !DISMISS_REASON_SET.has(value)) {
    fail(code, "reasonCode is invalid");
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function commandFingerprint(command) {
  return crypto.createHash("sha256").update(canonical(command)).digest("hex");
}

function validateKnowledgeActionCommand(value) {
  const code = "KNOWLEDGE_ACTION_INVALID_COMMAND";
  const base = plainObject(value, "knowledge action command", code);
  if (!COMMAND_TYPE_SET.has(base.type)) fail(code, "knowledge action command type is invalid");

  const common = {
    commandId: identifier(base.commandId, "commandId", code),
    type: base.type,
    at: timestamp(base.at, "command timestamp", code),
  };
  switch (base.type) {
    case "manual_create": {
      exactKeys(
        base,
        ["commandId", "type", "at", "todoId", "title", "dueText"],
        [],
        "manual_create command",
        code
      );
      return {
        ...common,
        todoId: identifier(base.todoId, "todoId", code),
        title: boundedText(base.title, "title", TITLE_MAX_LENGTH, code),
        dueText: nullableText(base.dueText, "dueText", DUE_TEXT_MAX_LENGTH, code),
      };
    }
    case "transcript_create": {
      exactKeys(
        base,
        ["commandId", "type", "at", "todoId", "title", "dueText", "sessionId", "segmentIds"],
        [],
        "transcript_create command",
        code
      );
      return {
        ...common,
        todoId: identifier(base.todoId, "todoId", code),
        title: boundedText(base.title, "title", TITLE_MAX_LENGTH, code),
        dueText: nullableText(base.dueText, "dueText", DUE_TEXT_MAX_LENGTH, code),
        sessionId: identifier(base.sessionId, "sessionId", code),
        segmentIds: segmentReferences(base.segmentIds, code),
      };
    }
    case "todo_dismiss": {
      exactKeys(
        base,
        ["commandId", "type", "at", "todoId", "reasonCode"],
        ["localNote"],
        "todo_dismiss command",
        code
      );
      return {
        ...common,
        todoId: identifier(base.todoId, "todoId", code),
        reasonCode: reasonCode(base.reasonCode, code),
        localNote: optionalLocalNote(base.localNote, code),
      };
    }
    case "todo_restore":
    case "todo_pin":
    case "todo_unpin": {
      exactKeys(base, ["commandId", "type", "at", "todoId"], [], `${base.type} command`, code);
      return { ...common, todoId: identifier(base.todoId, "todoId", code) };
    }
    case "suggestion_dismiss": {
      exactKeys(
        base,
        ["commandId", "type", "at", "suggestionId", "reasonCode"],
        [],
        "suggestion_dismiss command",
        code
      );
      return {
        ...common,
        suggestionId: identifier(base.suggestionId, "suggestionId", code),
        reasonCode: reasonCode(base.reasonCode, code),
      };
    }
    case "suggestion_restore":
    case "suggestion_accept_undo": {
      exactKeys(
        base,
        ["commandId", "type", "at", "suggestionId"],
        [],
        `${base.type} command`,
        code
      );
      return { ...common, suggestionId: identifier(base.suggestionId, "suggestionId", code) };
    }
    case "suggestion_accept": {
      exactKeys(
        base,
        ["commandId", "type", "at", "suggestionId", "todoId", "title", "dueText"],
        [],
        "suggestion_accept command",
        code
      );
      return {
        ...common,
        suggestionId: identifier(base.suggestionId, "suggestionId", code),
        todoId: identifier(base.todoId, "todoId", code),
        title: boundedText(base.title, "title", TITLE_MAX_LENGTH, code),
        dueText: nullableText(base.dueText, "dueText", DUE_TEXT_MAX_LENGTH, code),
      };
    }
    case "urgency_set": {
      exactKeys(
        base,
        ["commandId", "type", "at", "todoId", "urgency"],
        [],
        "urgency_set command",
        code
      );
      return {
        ...common,
        todoId: identifier(base.todoId, "todoId", code),
        urgency: enumValue(base.urgency, TODO_URGENCY_SET, "urgency", code),
      };
    }
    case "title_due_edit": {
      exactKeys(
        base,
        ["commandId", "type", "at", "todoId"],
        ["title", "dueText"],
        "title_due_edit command",
        code
      );
      const hasTitle = Object.prototype.hasOwnProperty.call(base, "title");
      const hasDueText = Object.prototype.hasOwnProperty.call(base, "dueText");
      if (!hasTitle && !hasDueText) fail(code, "title_due_edit requires title or dueText");
      return {
        ...common,
        todoId: identifier(base.todoId, "todoId", code),
        ...(hasTitle ? { title: boundedText(base.title, "title", TITLE_MAX_LENGTH, code) } : {}),
        ...(hasDueText
          ? { dueText: nullableText(base.dueText, "dueText", DUE_TEXT_MAX_LENGTH, code) }
          : {}),
      };
    }
    default:
      fail(code, "knowledge action command type is invalid");
  }
}

function entityKindForType(type) {
  return type.startsWith("suggestion_") ? "suggestion" : "todo";
}

function entityIdForCommand(command) {
  return command.suggestionId ?? command.todoId;
}

function payloadForCommand(command) {
  switch (command.type) {
    case "manual_create":
      return { title: command.title, dueText: command.dueText };
    case "transcript_create":
      return {
        title: command.title,
        dueText: command.dueText,
        sessionId: command.sessionId,
        segmentIds: [...command.segmentIds],
      };
    case "todo_dismiss":
      return { reasonCode: command.reasonCode, localNote: command.localNote };
    case "suggestion_dismiss":
      return { reasonCode: command.reasonCode };
    case "suggestion_accept":
      return { todoId: command.todoId, title: command.title, dueText: command.dueText };
    case "urgency_set":
      return { urgency: command.urgency };
    case "title_due_edit":
      return {
        ...(Object.prototype.hasOwnProperty.call(command, "title") ? { title: command.title } : {}),
        ...(Object.prototype.hasOwnProperty.call(command, "dueText")
          ? { dueText: command.dueText }
          : {}),
      };
    default:
      return {};
  }
}

function buildKnowledgeActionEvent(value) {
  const command = validateKnowledgeActionCommand(value);
  return {
    schemaVersion: KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION,
    commandId: command.commandId,
    commandFingerprint: commandFingerprint(command),
    type: command.type,
    entityKind: entityKindForType(command.type),
    entityId: entityIdForCommand(command),
    at: command.at,
    payload: payloadForCommand(command),
  };
}

function commandFromEvent(value) {
  const code = "KNOWLEDGE_ACTION_INVALID_EVENT";
  const event = exactKeys(
    value,
    [
      "schemaVersion",
      "commandId",
      "commandFingerprint",
      "type",
      "entityKind",
      "entityId",
      "at",
      "payload",
    ],
    [],
    "knowledge action event",
    code
  );
  if (event.schemaVersion !== KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION) {
    fail(code, "knowledge action event schema is unsupported");
  }
  if (!COMMAND_TYPE_SET.has(event.type)) fail(code, "knowledge action event type is invalid");
  identifier(event.commandId, "event commandId", code);
  identifier(event.entityId, "event entityId", code);
  timestamp(event.at, "event timestamp", code);
  if (
    typeof event.commandFingerprint !== "string" ||
    !COMMAND_FINGERPRINT_PATTERN.test(event.commandFingerprint)
  ) {
    fail(code, "knowledge action command fingerprint is invalid");
  }
  const expectedKind = entityKindForType(event.type);
  if (event.entityKind !== expectedKind) fail(code, "knowledge action entity kind is invalid");
  const payload = plainObject(event.payload, "knowledge action event payload", code);
  let candidate;
  switch (event.type) {
    case "manual_create":
      exactKeys(payload, ["title", "dueText"], [], "manual_create event payload", code);
      candidate = { todoId: event.entityId, ...payload };
      break;
    case "transcript_create":
      exactKeys(
        payload,
        ["title", "dueText", "sessionId", "segmentIds"],
        [],
        "transcript_create event payload",
        code
      );
      candidate = { todoId: event.entityId, ...payload };
      break;
    case "todo_dismiss":
      exactKeys(payload, ["reasonCode", "localNote"], [], "todo_dismiss event payload", code);
      candidate = { todoId: event.entityId, ...payload };
      break;
    case "todo_restore":
    case "todo_pin":
    case "todo_unpin":
      exactKeys(payload, [], [], `${event.type} event payload`, code);
      candidate = { todoId: event.entityId };
      break;
    case "suggestion_dismiss":
      exactKeys(payload, ["reasonCode"], [], "suggestion_dismiss event payload", code);
      candidate = { suggestionId: event.entityId, ...payload };
      break;
    case "suggestion_restore":
    case "suggestion_accept_undo":
      exactKeys(payload, [], [], `${event.type} event payload`, code);
      candidate = { suggestionId: event.entityId };
      break;
    case "suggestion_accept":
      exactKeys(
        payload,
        ["todoId", "title", "dueText"],
        [],
        "suggestion_accept event payload",
        code
      );
      candidate = { suggestionId: event.entityId, ...payload };
      break;
    case "urgency_set":
      exactKeys(payload, ["urgency"], [], "urgency_set event payload", code);
      candidate = { todoId: event.entityId, ...payload };
      break;
    case "title_due_edit":
      exactKeys(payload, [], ["title", "dueText"], "title_due_edit event payload", code);
      candidate = { todoId: event.entityId, ...payload };
      break;
    default:
      fail(code, "knowledge action event type is invalid");
  }
  try {
    const command = validateKnowledgeActionCommand({
      commandId: event.commandId,
      type: event.type,
      at: event.at,
      ...candidate,
    });
    if (entityIdForCommand(command) !== event.entityId) {
      fail(code, "knowledge action event entity does not match command");
    }
    return command;
  } catch (error) {
    if (error instanceof KnowledgeActionLifecycleError && error.code === code) throw error;
    fail(code, "knowledge action event payload is invalid");
  }
}

function validateKnowledgeActionEvent(value) {
  const code = "KNOWLEDGE_ACTION_INVALID_EVENT";
  const command = commandFromEvent(value);
  const expected = buildKnowledgeActionEvent(command);
  if (value.commandFingerprint !== expected.commandFingerprint) {
    fail(code, "knowledge action event fingerprint does not match its payload");
  }
  return expected;
}

function normalizeTodoSeed(value) {
  const code = "KNOWLEDGE_ACTION_INVALID_STATE";
  const seed = exactKeys(
    value,
    ["id", "title"],
    [
      "dueText",
      "status",
      "verificationState",
      "pinned",
      "urgency",
      "sourceKind",
      "sourceSessionId",
      "sourceSegmentIds",
      "sourceSuggestionId",
      "convertedFromSuggestion",
      "hasReminder",
      "userModified",
      "dismissedFromVerificationState",
      "dismissReasonCode",
      "dismissLocalNote",
    ],
    "Todo seed",
    code
  );
  const status = enumValue(seed.status ?? "open", TODO_STATUS_SET, "Todo status", code);
  const verificationState = enumValue(
    seed.verificationState ?? (status === "dismissed" ? "dismissed" : "confirmed"),
    TODO_VERIFICATION_SET,
    "Todo verification state",
    code
  );
  if ((status === "dismissed") !== (verificationState === "dismissed")) {
    fail(code, "dismissed Todo status and verification state must agree");
  }
  const pinned = booleanValue(seed.pinned, false, "Todo pinned state", code);
  if (pinned && status !== "open") fail(code, "only an open Todo can be pinned");
  const sourceKind = enumValue(
    seed.sourceKind ?? "existing",
    TODO_SOURCE_KIND_SET,
    "Todo source kind",
    code
  );
  const sourceSessionId =
    seed.sourceSessionId === undefined || seed.sourceSessionId === null
      ? null
      : identifier(seed.sourceSessionId, "sourceSessionId", code);
  const sourceSegmentIds =
    seed.sourceSegmentIds === undefined || seed.sourceSegmentIds === null
      ? []
      : segmentReferences(seed.sourceSegmentIds, code);
  const sourceSuggestionId =
    seed.sourceSuggestionId === undefined || seed.sourceSuggestionId === null
      ? null
      : identifier(seed.sourceSuggestionId, "sourceSuggestionId", code);
  const convertedFromSuggestion = booleanValue(
    seed.convertedFromSuggestion,
    sourceKind === "suggestion",
    "convertedFromSuggestion",
    code
  );
  if (
    convertedFromSuggestion !== (sourceKind === "suggestion") ||
    convertedFromSuggestion !== (sourceSuggestionId !== null)
  ) {
    fail(code, "suggestion Todo provenance is inconsistent");
  }
  if (sourceKind === "transcript" && (sourceSessionId === null || sourceSegmentIds.length === 0)) {
    fail(code, "transcript Todo source references are required");
  }
  if (sourceKind !== "transcript" && (sourceSessionId !== null || sourceSegmentIds.length > 0)) {
    fail(code, "non-transcript Todo cannot contain transcript source references");
  }
  const dismissedFromVerificationState =
    status === "dismissed"
      ? enumValue(
          seed.dismissedFromVerificationState ?? "confirmed",
          new Set(["pending_confirmation", "confirmed"]),
          "dismissed Todo prior verification state",
          code
        )
      : null;
  const dismissReasonCode =
    status === "dismissed" &&
    seed.dismissReasonCode !== undefined &&
    seed.dismissReasonCode !== null
      ? reasonCode(seed.dismissReasonCode, code)
      : null;
  const dismissLocalNote =
    status === "dismissed" ? optionalLocalNote(seed.dismissLocalNote, code) : null;
  return {
    id: identifier(seed.id, "Todo id", code),
    title: boundedText(seed.title, "Todo title", TITLE_MAX_LENGTH, code),
    dueText:
      seed.dueText === undefined
        ? null
        : nullableText(seed.dueText, "Todo dueText", DUE_TEXT_MAX_LENGTH, code),
    status,
    verificationState,
    pinned,
    urgency: enumValue(seed.urgency ?? "normal", TODO_URGENCY_SET, "Todo urgency", code),
    sourceKind,
    sourceSessionId,
    sourceSegmentIds,
    sourceSuggestionId,
    convertedFromSuggestion,
    hasReminder: booleanValue(seed.hasReminder, false, "Todo reminder state", code),
    userModified: booleanValue(seed.userModified, false, "Todo modified state", code),
    dismissedFromVerificationState,
    dismissReasonCode,
    dismissLocalNote,
  };
}

function normalizeSuggestionSeed(value) {
  const code = "KNOWLEDGE_ACTION_INVALID_STATE";
  const seed = exactKeys(
    value,
    ["id"],
    ["state", "convertedTodoId", "dismissReasonCode"],
    "suggestion seed",
    code
  );
  const state = enumValue(seed.state ?? "proposed", SUGGESTION_STATE_SET, "suggestion state", code);
  const convertedTodoId =
    seed.convertedTodoId === undefined || seed.convertedTodoId === null
      ? null
      : identifier(seed.convertedTodoId, "convertedTodoId", code);
  if ((state === "accepted") !== (convertedTodoId !== null)) {
    fail(code, "accepted suggestion must reference exactly one converted Todo");
  }
  const dismissReasonCode =
    state === "dismissed" && seed.dismissReasonCode !== undefined && seed.dismissReasonCode !== null
      ? reasonCode(seed.dismissReasonCode, code)
      : null;
  return {
    id: identifier(seed.id, "suggestion id", code),
    state,
    convertedTodoId,
    dismissReasonCode,
  };
}

function blankState() {
  return {
    schemaVersion: KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION,
    todos: {},
    suggestions: {},
    appliedCommands: {},
    events: [],
  };
}

function createKnowledgeActionState(value = {}) {
  const code = "KNOWLEDGE_ACTION_INVALID_STATE";
  const input = exactKeys(
    value,
    [],
    ["todos", "suggestions", "events"],
    "knowledge action state seed",
    code
  );
  if (input.todos !== undefined && !Array.isArray(input.todos))
    fail(code, "todos must be an array");
  if (input.suggestions !== undefined && !Array.isArray(input.suggestions)) {
    fail(code, "suggestions must be an array");
  }
  if (input.events !== undefined && !Array.isArray(input.events))
    fail(code, "events must be an array");
  let state = blankState();
  for (const value of input.todos ?? []) {
    const todo = normalizeTodoSeed(value);
    if (state.todos[todo.id]) fail(code, "Todo seed ids must be unique");
    state.todos[todo.id] = todo;
  }
  for (const value of input.suggestions ?? []) {
    const suggestion = normalizeSuggestionSeed(value);
    if (state.suggestions[suggestion.id]) fail(code, "suggestion seed ids must be unique");
    state.suggestions[suggestion.id] = suggestion;
  }
  for (const suggestion of Object.values(state.suggestions)) {
    if (suggestion.state !== "accepted") continue;
    const todo = state.todos[suggestion.convertedTodoId];
    if (!todo || !todo.convertedFromSuggestion || todo.sourceSuggestionId !== suggestion.id) {
      fail(code, "accepted suggestion and converted Todo seed are inconsistent");
    }
  }
  if ((input.events ?? []).length > 0) {
    state = reduceKnowledgeActionEvents(state, input.events);
  }
  return state;
}

function assertLifecycleState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION ||
    !value.todos ||
    !value.suggestions ||
    !value.appliedCommands ||
    !Array.isArray(value.events)
  ) {
    fail("KNOWLEDGE_ACTION_INVALID_STATE", "knowledge action state is invalid");
  }
  return value;
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    todos: Object.fromEntries(
      Object.entries(state.todos).map(([id, todo]) => [
        id,
        { ...todo, sourceSegmentIds: [...todo.sourceSegmentIds] },
      ])
    ),
    suggestions: Object.fromEntries(
      Object.entries(state.suggestions).map(([id, suggestion]) => [id, { ...suggestion }])
    ),
    appliedCommands: Object.fromEntries(
      Object.entries(state.appliedCommands).map(([id, receipt]) => [id, { ...receipt }])
    ),
    events: [...state.events],
  };
}

function todoOrFail(state, todoId) {
  const todo = state.todos[todoId];
  if (!todo) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "Todo was not found");
  return todo;
}

function suggestionOrFail(state, suggestionId) {
  const suggestion = state.suggestions[suggestionId];
  if (!suggestion) fail("KNOWLEDGE_ACTION_ENTITY_NOT_FOUND", "suggestion was not found");
  return suggestion;
}

function requireOpenTodo(todo, action) {
  if (todo.status !== "open") {
    fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", `${action} requires an open Todo`);
  }
}

function createdTodo({
  id,
  title,
  dueText,
  sourceKind,
  sessionId = null,
  segmentIds = [],
  suggestionId = null,
}) {
  return {
    id,
    title,
    dueText,
    status: "open",
    verificationState: "confirmed",
    pinned: false,
    urgency: "normal",
    sourceKind,
    sourceSessionId: sessionId,
    sourceSegmentIds: [...segmentIds],
    sourceSuggestionId: suggestionId,
    convertedFromSuggestion: sourceKind === "suggestion",
    hasReminder: false,
    userModified: false,
    dismissedFromVerificationState: null,
    dismissReasonCode: null,
    dismissLocalNote: null,
  };
}

function applyTransition(state, command) {
  switch (command.type) {
    case "manual_create":
    case "transcript_create": {
      if (state.todos[command.todoId]) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "Todo already exists");
      }
      state.todos[command.todoId] = createdTodo({
        id: command.todoId,
        title: command.title,
        dueText: command.dueText,
        sourceKind: command.type === "manual_create" ? "manual" : "transcript",
        sessionId: command.type === "transcript_create" ? command.sessionId : null,
        segmentIds: command.type === "transcript_create" ? command.segmentIds : [],
      });
      break;
    }
    case "todo_dismiss": {
      const todo = todoOrFail(state, command.todoId);
      requireOpenTodo(todo, "todo_dismiss");
      todo.dismissedFromVerificationState = todo.verificationState;
      todo.status = "dismissed";
      todo.verificationState = "dismissed";
      todo.pinned = false;
      todo.dismissReasonCode = command.reasonCode;
      todo.dismissLocalNote = command.localNote;
      todo.userModified = true;
      break;
    }
    case "todo_restore": {
      const todo = todoOrFail(state, command.todoId);
      if (
        todo.status !== "dismissed" ||
        !new Set(["pending_confirmation", "confirmed"]).has(todo.dismissedFromVerificationState)
      ) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "todo_restore requires a dismissed Todo");
      }
      todo.status = "open";
      todo.verificationState = todo.dismissedFromVerificationState;
      todo.dismissedFromVerificationState = null;
      todo.dismissReasonCode = null;
      todo.dismissLocalNote = null;
      todo.userModified = true;
      break;
    }
    case "suggestion_dismiss": {
      const suggestion = suggestionOrFail(state, command.suggestionId);
      if (suggestion.state !== "proposed") {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a proposed suggestion can be dismissed");
      }
      suggestion.state = "dismissed";
      suggestion.dismissReasonCode = command.reasonCode;
      break;
    }
    case "suggestion_restore": {
      const suggestion = suggestionOrFail(state, command.suggestionId);
      if (suggestion.state !== "dismissed") {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a dismissed suggestion can be restored");
      }
      suggestion.state = "proposed";
      suggestion.dismissReasonCode = null;
      break;
    }
    case "suggestion_accept": {
      const suggestion = suggestionOrFail(state, command.suggestionId);
      if (suggestion.state !== "proposed") {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "only a proposed suggestion can be accepted");
      }
      if (state.todos[command.todoId]) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "converted Todo already exists");
      }
      state.todos[command.todoId] = createdTodo({
        id: command.todoId,
        title: command.title,
        dueText: command.dueText,
        sourceKind: "suggestion",
        suggestionId: command.suggestionId,
      });
      suggestion.state = "accepted";
      suggestion.convertedTodoId = command.todoId;
      suggestion.dismissReasonCode = null;
      break;
    }
    case "suggestion_accept_undo": {
      const suggestion = suggestionOrFail(state, command.suggestionId);
      if (suggestion.state !== "accepted" || suggestion.convertedTodoId === null) {
        fail(
          "KNOWLEDGE_ACTION_INVALID_TRANSITION",
          "suggestion_accept_undo requires an accepted suggestion"
        );
      }
      const todo = todoOrFail(state, suggestion.convertedTodoId);
      if (
        todo.status !== "open" ||
        todo.userModified ||
        todo.hasReminder ||
        !todo.convertedFromSuggestion ||
        todo.sourceSuggestionId !== suggestion.id
      ) {
        fail(
          "KNOWLEDGE_ACTION_ACCEPT_UNDO_BLOCKED",
          "the converted Todo is no longer safe to remove"
        );
      }
      delete state.todos[todo.id];
      suggestion.state = "proposed";
      suggestion.convertedTodoId = null;
      suggestion.dismissReasonCode = null;
      break;
    }
    case "todo_pin":
    case "todo_unpin": {
      const todo = todoOrFail(state, command.todoId);
      requireOpenTodo(todo, command.type);
      const expected = command.type === "todo_pin";
      if (todo.pinned === expected) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", `${command.type} would not change the Todo`);
      }
      todo.pinned = expected;
      todo.userModified = true;
      break;
    }
    case "urgency_set": {
      const todo = todoOrFail(state, command.todoId);
      requireOpenTodo(todo, command.type);
      if (todo.urgency === command.urgency) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "urgency_set would not change the Todo");
      }
      todo.urgency = command.urgency;
      todo.userModified = true;
      break;
    }
    case "title_due_edit": {
      const todo = todoOrFail(state, command.todoId);
      requireOpenTodo(todo, command.type);
      const titleChanged =
        Object.prototype.hasOwnProperty.call(command, "title") && command.title !== todo.title;
      const dueTextChanged =
        Object.prototype.hasOwnProperty.call(command, "dueText") &&
        command.dueText !== todo.dueText;
      if (!titleChanged && !dueTextChanged) {
        fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "title_due_edit would not change the Todo");
      }
      if (titleChanged) todo.title = command.title;
      if (dueTextChanged) todo.dueText = command.dueText;
      todo.userModified = true;
      break;
    }
    default:
      fail("KNOWLEDGE_ACTION_INVALID_TRANSITION", "unsupported knowledge action transition");
  }
}

function reduceKnowledgeActionEvent(value, eventValue) {
  const state = assertLifecycleState(value);
  const event = validateKnowledgeActionEvent(eventValue);
  const existing = state.appliedCommands[event.commandId];
  if (existing) {
    if (existing.commandFingerprint !== event.commandFingerprint) {
      fail(
        "KNOWLEDGE_ACTION_COMMAND_ID_CONFLICT",
        "commandId was already used for a different action"
      );
    }
    return state;
  }
  const command = commandFromEvent(event);
  const next = cloneState(state);
  applyTransition(next, command);
  const eventIndex = next.events.length;
  next.events.push(event);
  next.appliedCommands[event.commandId] = {
    commandFingerprint: event.commandFingerprint,
    eventIndex,
  };
  return next;
}

function reduceKnowledgeActionEvents(value, events) {
  if (!Array.isArray(events)) {
    fail("KNOWLEDGE_ACTION_INVALID_EVENT", "knowledge action events must be an array");
  }
  return events.reduce((state, event) => reduceKnowledgeActionEvent(state, event), value);
}

function applyKnowledgeActionCommand(value, commandValue) {
  const state = assertLifecycleState(value);
  const command = validateKnowledgeActionCommand(commandValue);
  const fingerprint = commandFingerprint(command);
  const existing = state.appliedCommands[command.commandId];
  if (existing) {
    if (existing.commandFingerprint !== fingerprint) {
      fail(
        "KNOWLEDGE_ACTION_COMMAND_ID_CONFLICT",
        "commandId was already used for a different action"
      );
    }
    return {
      status: "already_applied",
      state,
      event: state.events[existing.eventIndex],
    };
  }
  const event = buildKnowledgeActionEvent(command);
  return {
    status: "applied",
    state: reduceKnowledgeActionEvent(state, event),
    event,
  };
}

function toKnowledgeActionNonSensitiveMetadata(value) {
  const event = validateKnowledgeActionEvent(value);
  return {
    schemaVersion: event.schemaVersion,
    type: event.type,
    entityKind: event.entityKind,
    reasonCode: event.payload.reasonCode ?? null,
  };
}

module.exports = {
  COMMAND_TYPES,
  DISMISS_REASON_CODES,
  KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION,
  KnowledgeActionLifecycleError,
  applyKnowledgeActionCommand,
  buildKnowledgeActionEvent,
  createKnowledgeActionState,
  reduceKnowledgeActionEvent,
  reduceKnowledgeActionEvents,
  toKnowledgeActionNonSensitiveMetadata,
  validateKnowledgeActionCommand,
  validateKnowledgeActionEvent,
};
