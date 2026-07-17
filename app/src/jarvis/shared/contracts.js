const CHANNELS = Object.freeze({
  createSession: "jarvis:session:create",
  setSessionStatus: "jarvis:session:set-status",
  getSession: "jarvis:session:get",
  listSessions: "jarvis:session:list",
  upsertSegments: "jarvis:segments:upsert",
  syncSegments: "jarvis:segments:sync",
  listSegments: "jarvis:segments:list",
  renamePerson: "jarvis:person:rename",
  listPeople: "jarvis:person:list",
  listSessionSpeakerClusters: "jarvis:speaker:list-session",
  confirmSpeaker: "jarvis:speaker:confirm",
  rejectSpeaker: "jarvis:speaker:reject",
  undoSpeakerCorrection: "jarvis:speaker:undo",
  listSpeakerCorrections: "jarvis:speaker:corrections",
  mergePeople: "jarvis:people:merge",
  listAudioChunks: "jarvis:audio:list",
  readAudioChunk: "jarvis:audio:read",
  getSessionDetail: "jarvis:memory:session-detail",
  getSessionTimeline: "jarvis:memory:session-timeline",
  getRuntimeStatus: "jarvis:runtime:status",
  searchMemory: "jarvis:memory:search",
  listPeopleOverview: "jarvis:memory:people",
  getPersonDetail: "jarvis:memory:person-detail",
  listTopics: "jarvis:memory:topics",
  getTopicDetail: "jarvis:memory:topic-detail",
  renameTopic: "jarvis:memory:topic-rename",
  listTodos: "jarvis:memory:todos",
  setTodoStatus: "jarvis:memory:todo-status",
  listMemories: "jarvis:memory:list",
  getTodayInsights: "jarvis:memory:today-insights",
  getDailyDigest: "jarvis:memory:daily-digest",
  getKnowledgeOverview: "jarvis:memory:v2-overview",
  decideKnowledgeSuggestion: "jarvis:memory:v2-suggestion-decision",
  resolveKnowledgeConflict: "jarvis:memory:v2-conflict-resolve",
  completeKnowledgeTodo: "jarvis:memory:v2-todo-complete",
  getEvidenceContext: "jarvis:evidence:get-context",
  analyzeSession: "jarvis:analysis:run",
  regenerateDailyDigest: "jarvis:analysis:daily-digest:regenerate",
  getAnalysisStatus: "jarvis:analysis:status",
  getMiniMaxConfig: "jarvis:minimax:get-config",
  setMiniMaxKey: "jarvis:minimax:set-key",
  startCapture: "jarvis:capture:start",
  setRetentionMode: "jarvis:capture:set-retention-mode",
  sourceInterrupted: "jarvis:capture:source-interrupted",
  sourceRestored: "jarvis:capture:source-restored",
  pauseCapture: "jarvis:capture:pause",
  resumeCapture: "jarvis:capture:resume",
  finishCapture: "jarvis:capture:finish",
  failCapture: "jarvis:capture:fail",
  beginVoiceEnrollment: "jarvis:voice-enrollment:begin",
  getVoiceEnrollmentStatus: "jarvis:voice-enrollment:status",
  completeVoiceEnrollment: "jarvis:voice-enrollment:complete",
  cancelVoiceEnrollment: "jarvis:voice-enrollment:cancel",
  getCloudBudget: "jarvis:cloud-budget:get",
  setCloudBudget: "jarvis:cloud-budget:set",
  getStorageStatus: "jarvis:storage:status",
  pickStorageDirectory: "jarvis:storage:pick-directory",
  migrateStorage: "jarvis:storage:migrate",
  control: "jarvis:control",
  stateChanged: "jarvis:state-changed",
});

const { assertCaptureMode, assertSourceType, assertRetentionMode } = require("./captureModes");

const SESSION_STATUSES = new Set([
  "recording",
  "paused",
  "finalizing",
  "completed",
  "recovered",
  "failed",
]);

function assertId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function normalizeSpeakerConfirmationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("speaker confirmation input must be an object");
  }
  const allowed = new Set(["clusterId", "personId", "newPersonName", "scope"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new TypeError(`speaker confirmation input has unknown key: ${key}`);
  }
  if (input.scope !== "session" && input.scope !== "persistent") {
    throw new TypeError("invalid speaker correction scope");
  }
  const hasPersonId = Object.prototype.hasOwnProperty.call(input, "personId");
  const hasNewPersonName = Object.prototype.hasOwnProperty.call(input, "newPersonName");
  if (hasPersonId === hasNewPersonName) {
    throw new TypeError("speaker confirmation must provide exactly one target");
  }
  const normalized = {
    clusterId: assertId(input.clusterId, "clusterId"),
    scope: input.scope,
  };
  if (hasPersonId) {
    normalized.personId = assertId(input.personId, "personId");
  } else {
    if (typeof input.newPersonName !== "string") {
      throw new TypeError("newPersonName must be a string");
    }
    const displayName = input.newPersonName.trim().replace(/\s+/gu, " ");
    if (!displayName) throw new TypeError("newPersonName must not be empty");
    if (Array.from(displayName).length > 80) {
      throw new RangeError("newPersonName must contain at most 80 Unicode code points");
    }
    normalized.newPersonName = displayName;
  }
  return normalized;
}

function assertSessionStatus(value) {
  if (!SESSION_STATUSES.has(value)) throw new TypeError("invalid session status");
  return value;
}

function normalizeDailyDigestDateRequest(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "localDate")
  ) {
    throw new TypeError("daily digest request must contain only localDate");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.localDate);
  if (!match) throw new TypeError("daily digest localDate must use YYYY-MM-DD");
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new TypeError("daily digest localDate must be a valid calendar date");
  }
  return { localDate: input.localDate };
}

function exactPlainObject(input, keys, name) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    throw new TypeError(`${name} must contain exact keys`);
  }
  return input;
}

function normalizeSuggestionDecisionInput(input) {
  exactPlainObject(input, ["suggestionId", "action"], "suggestion decision input");
  if (input.action !== "accept" && input.action !== "dismiss") {
    throw new TypeError("suggestion decision action is invalid");
  }
  return {
    suggestionId: assertId(input.suggestionId, "suggestionId"),
    action: input.action,
  };
}

function normalizeMemoryConflictResolutionInput(input) {
  exactPlainObject(
    input,
    ["conflictGroupId", "selectedMemoryItemId"],
    "memory conflict resolution input"
  );
  return {
    conflictGroupId: assertId(input.conflictGroupId, "conflictGroupId"),
    selectedMemoryItemId: assertId(input.selectedMemoryItemId, "selectedMemoryItemId"),
  };
}

function normalizeKnowledgeTodoCompletionInput(input) {
  exactPlainObject(input, ["todoId"], "knowledge todo completion input");
  return { todoId: assertId(input.todoId, "todoId") };
}

const EVIDENCE_OWNER_TYPES = new Set([
  "memory_value",
  "topic_revision",
  "todo_instance",
  "session_summary_revision",
  "daily_digest_item",
  "suggestion",
  "speaker_cluster",
]);

function exactEnumerableObject(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name} must contain exact keys`);
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must contain exact keys`);
  }
  return input;
}

function normalizeEvidenceContextRequest(input) {
  exactEnumerableObject(input, ["ownerType", "ownerId", "evidenceId"], "evidence context request");
  if (!EVIDENCE_OWNER_TYPES.has(input.ownerType)) {
    throw new TypeError("evidence context ownerType is invalid");
  }
  return {
    ownerType: input.ownerType,
    ownerId: assertId(input.ownerId, "ownerId"),
    evidenceId: assertId(input.evidenceId, "evidenceId"),
  };
}

function evidenceResponseTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("evidence context response is invalid");
  }
  return value;
}

function nullableEvidenceId(value, name) {
  return value === null ? null : assertId(value, name);
}

function normalizeEvidenceContextResponse(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("evidence context response is invalid");
  }
  const required = [
    "ownerType",
    "ownerId",
    "evidenceId",
    "sessionId",
    "sessionStartedAt",
    "sessionEndedAt",
    "transcriptSegmentId",
    "transcriptState",
    "trackId",
    "sourceType",
    "startedAt",
    "endedAt",
    "quoteText",
    "audioState",
  ];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new TypeError("evidence context response is invalid");
  }
  if (!EVIDENCE_OWNER_TYPES.has(input.ownerType)) {
    throw new TypeError("evidence context response is invalid");
  }
  const sessionStartedAt = evidenceResponseTime(input.sessionStartedAt);
  const sessionEndedAt =
    input.sessionEndedAt === null ? null : evidenceResponseTime(input.sessionEndedAt);
  const startedAt = evidenceResponseTime(input.startedAt);
  const endedAt = evidenceResponseTime(input.endedAt);
  if (
    startedAt < sessionStartedAt ||
    endedAt <= startedAt ||
    (sessionEndedAt !== null && (sessionEndedAt < sessionStartedAt || endedAt > sessionEndedAt))
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (input.transcriptState !== "available" && input.transcriptState !== "missing") {
    throw new TypeError("evidence context response is invalid");
  }
  const transcriptSegmentId = nullableEvidenceId(input.transcriptSegmentId, "transcriptSegmentId");
  if (
    (input.transcriptState === "available" && transcriptSegmentId === null) ||
    (input.transcriptState === "missing" && transcriptSegmentId !== null)
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (
    input.quoteText !== null &&
    (typeof input.quoteText !== "string" ||
      !input.quoteText.trim() ||
      Array.from(input.quoteText).length > 4_096)
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (
    (input.transcriptState === "available" && input.quoteText === null) ||
    (input.transcriptState === "missing" && input.quoteText !== null)
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (input.sourceType !== null && input.sourceType !== "mic" && input.sourceType !== "system") {
    throw new TypeError("evidence context response is invalid");
  }
  if (!new Set(["available", "expired", "missing"]).has(input.audioState)) {
    throw new TypeError("evidence context response is invalid");
  }
  return {
    ownerType: input.ownerType,
    ownerId: assertId(input.ownerId, "ownerId"),
    evidenceId: assertId(input.evidenceId, "evidenceId"),
    sessionId: assertId(input.sessionId, "sessionId"),
    sessionStartedAt,
    sessionEndedAt,
    transcriptSegmentId,
    transcriptState: input.transcriptState,
    trackId: nullableEvidenceId(input.trackId, "trackId"),
    sourceType: input.sourceType,
    startedAt,
    endedAt,
    quoteText: input.quoteText,
    audioState: input.audioState,
  };
}

const CAPTURE_FAILURE_CODES = new Set([
  "MIC_PERMISSION",
  "MIC_DISCONNECTED",
  "capture_source_unavailable",
  "capture_start_failed",
  "capture_pause_failed",
  "capture_finish_failed",
  "upstream_start_failed",
  "capture_activation_cancelled",
]);

function assertCaptureFailureCode(value) {
  if (!CAPTURE_FAILURE_CODES.has(value)) throw new TypeError("invalid capture failure code");
  return value;
}

module.exports = {
  CHANNELS,
  SESSION_STATUSES,
  assertId,
  normalizeSpeakerConfirmationInput,
  normalizeDailyDigestDateRequest,
  normalizeSuggestionDecisionInput,
  normalizeMemoryConflictResolutionInput,
  normalizeKnowledgeTodoCompletionInput,
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
  assertSessionStatus,
  assertCaptureFailureCode,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
};
