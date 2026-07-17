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
  assertSessionStatus,
  assertCaptureFailureCode,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
};
