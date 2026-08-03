const CHANNELS = Object.freeze({
  createSession: "jarvis:session:create",
  setSessionStatus: "jarvis:session:set-status",
  getSession: "jarvis:session:get",
  listSessions: "jarvis:session:list",
  upsertSegments: "jarvis:segments:upsert",
  syncSegments: "jarvis:segments:sync",
  listSegments: "jarvis:segments:list",
  listActivityClassifications: "jarvis:activity:list-session",
  correctActivityClassification: "jarvis:activity:correct",
  getPersonalizationSettings: "jarvis:personalization:get",
  decidePersonalizationRule: "jarvis:personalization:rule-decision",
  resetPersonalizationRules: "jarvis:personalization:reset",
  listLearningGoals: "jarvis:learning-goals:list",
  createLearningGoal: "jarvis:learning-goals:create",
  editLearningGoal: "jarvis:learning-goals:edit",
  archiveLearningGoal: "jarvis:learning-goals:archive",
  restoreLearningGoal: "jarvis:learning-goals:restore",
  deleteLearningGoal: "jarvis:learning-goals:delete",
  setNotificationPreferences: "jarvis:notification-preferences:set",
  getTodoReminder: "jarvis:todo-reminder:get",
  setTodoReminder: "jarvis:todo-reminder:set",
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
  getSessionTimelineStatus: "jarvis:memory:session-timeline-status",
  getRuntimeStatus: "jarvis:runtime:status",
  searchMemory: "jarvis:memory:search",
  listPeopleOverview: "jarvis:memory:people",
  listPeopleReviewOverview: "jarvis:memory:people-review",
  previewParticipantReview: "jarvis:participant-review:preview",
  applyParticipantReview: "jarvis:participant-review:apply",
  undoParticipantReview: "jarvis:participant-review:undo",
  listParticipantReviewHistory: "jarvis:participant-review:history",
  getPersonDetail: "jarvis:memory:person-detail",
  listTopics: "jarvis:memory:topics",
  getTopicDetail: "jarvis:memory:topic-detail",
  renameTopic: "jarvis:memory:topic-rename",
  listTodos: "jarvis:memory:todos",
  setTodoStatus: "jarvis:memory:todo-status",
  listMemories: "jarvis:memory:list",
  getTodayInsights: "jarvis:memory:today-insights",
  getDailyDigest: "jarvis:memory:daily-digest",
  getActionCenterWatermark: "jarvis:memory:v2-action-watermark",
  getActionCenterDelta: "jarvis:memory:v2-action-delta",
  markActionCenterRead: "jarvis:memory:v2-action-read",
  getKnowledgeOverview: "jarvis:memory:v2-overview",
  decideKnowledgeSuggestion: "jarvis:memory:v2-suggestion-decision",
  resolveKnowledgeConflict: "jarvis:memory:v2-conflict-resolve",
  completeKnowledgeTodo: "jarvis:memory:v2-todo-complete",
  decideKnowledgeTodo: "jarvis:memory:v2-todo-decision",
  applyKnowledgeAction: "jarvis:memory:v2-knowledge-action",
  getEvidenceContext: "jarvis:evidence:get-context",
  analyzeSession: "jarvis:analysis:run",
  regenerateDailyDigest: "jarvis:analysis:daily-digest:regenerate",
  getAnalysisStatus: "jarvis:analysis:status",
  getAnalysisBudget: "jarvis:analysis-budget:get",
  setAnalysisBudget: "jarvis:analysis-budget:set",
  getResourceGovernance: "jarvis:resource-governance:get",
  setResourceGovernance: "jarvis:resource-governance:set",
  getApplicationAudioSettings: "jarvis:application-audio:get",
  setApplicationAudioSettings: "jarvis:application-audio:set",
  getRolloutFlags: "jarvis:rollout-flags:get",
  getMiniMaxConfig: "jarvis:minimax:get-config",
  setMiniMaxKey: "jarvis:minimax:set-key",
  clearMiniMaxKey: "jarvis:minimax:clear-key",
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

function normalizeDailyDigestRegenerateRequest(input) {
  exactPlainObject(input, ["localDate", "allowUsageUnknown"], "daily digest regenerate request");
  if (typeof input.allowUsageUnknown !== "boolean") {
    throw new TypeError("allowUsageUnknown must be a boolean");
  }
  return {
    ...normalizeDailyDigestDateRequest({ localDate: input.localDate }),
    allowUsageUnknown: input.allowUsageUnknown,
  };
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

const LEARNING_GOAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function normalizeLearningGoalTitle(value) {
  if (typeof value !== "string") {
    throw new TypeError("learning goal title must be a string");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !normalized ||
    Array.from(normalized).length > 500 ||
    LEARNING_GOAL_CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new TypeError("learning goal title must contain 1 to 500 safe characters");
  }
  return normalized;
}

function normalizeLearningGoalCreateInput(input) {
  exactPlainObject(input, ["title"], "learning goal create input");
  return { title: normalizeLearningGoalTitle(input.title) };
}

function normalizeLearningGoalEditInput(input) {
  exactPlainObject(input, ["goalId", "title"], "learning goal edit input");
  return {
    goalId: assertId(input.goalId, "learningGoalId"),
    title: normalizeLearningGoalTitle(input.title),
  };
}

function normalizeLearningGoalIdInput(input) {
  exactPlainObject(input, ["goalId"], "learning goal decision input");
  return { goalId: assertId(input.goalId, "learningGoalId") };
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

function normalizeKnowledgeTodoDecisionInput(input) {
  exactPlainObject(input, ["todoId", "action"], "knowledge todo decision input");
  if (!["confirm", "dismiss", "reopen"].includes(input.action)) {
    throw new TypeError("knowledge todo decision action is invalid");
  }
  return {
    todoId: assertId(input.todoId, "todoId"),
    action: input.action,
  };
}

const KNOWLEDGE_ACTION_TYPES = new Set([
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
const KNOWLEDGE_DISMISS_REASONS = new Set([
  "not_relevant",
  "already_done",
  "not_mine",
  "wrong_context",
  "low_value",
  "other",
]);

function boundedKnowledgeText(value, name, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function knowledgeActionShape(input, required, optional = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("knowledge action input is invalid");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError("knowledge action input has invalid keys");
  }
  return input;
}

function normalizeKnowledgeActionInput(input) {
  if (!input || !KNOWLEDGE_ACTION_TYPES.has(input.type)) {
    throw new TypeError("knowledge action type is invalid");
  }
  const common = {
    commandId: assertId(input.commandId, "commandId"),
    type: input.type,
  };
  switch (input.type) {
    case "manual_create":
      knowledgeActionShape(input, ["commandId", "type", "todoId", "title", "dueText"]);
      return {
        ...common,
        todoId: assertId(input.todoId, "todoId"),
        title: boundedKnowledgeText(input.title, "title", 512),
        dueText: boundedKnowledgeText(input.dueText, "dueText", 256, { nullable: true }),
      };
    case "transcript_create": {
      knowledgeActionShape(input, [
        "commandId",
        "type",
        "todoId",
        "title",
        "dueText",
        "sessionId",
        "segmentIds",
      ]);
      if (
        !Array.isArray(input.segmentIds) ||
        input.segmentIds.length === 0 ||
        input.segmentIds.length > 512
      ) {
        throw new TypeError("segmentIds are invalid");
      }
      const segmentIds = input.segmentIds.map((value) => assertId(value, "segmentId"));
      if (new Set(segmentIds).size !== segmentIds.length) {
        throw new TypeError("segmentIds must be unique");
      }
      return {
        ...common,
        todoId: assertId(input.todoId, "todoId"),
        title: boundedKnowledgeText(input.title, "title", 512),
        dueText: boundedKnowledgeText(input.dueText, "dueText", 256, { nullable: true }),
        sessionId: assertId(input.sessionId, "sessionId"),
        segmentIds,
      };
    }
    case "todo_dismiss":
      knowledgeActionShape(input, ["commandId", "type", "todoId", "reasonCode"], ["localNote"]);
      if (!KNOWLEDGE_DISMISS_REASONS.has(input.reasonCode)) {
        throw new TypeError("knowledge action reason is invalid");
      }
      return {
        ...common,
        todoId: assertId(input.todoId, "todoId"),
        reasonCode: input.reasonCode,
        localNote:
          input.localNote === undefined || input.localNote === null
            ? null
            : boundedKnowledgeText(input.localNote, "localNote", 500),
      };
    case "todo_restore":
    case "todo_pin":
    case "todo_unpin":
      knowledgeActionShape(input, ["commandId", "type", "todoId"]);
      return { ...common, todoId: assertId(input.todoId, "todoId") };
    case "suggestion_dismiss":
      knowledgeActionShape(input, ["commandId", "type", "suggestionId", "reasonCode"]);
      if (!KNOWLEDGE_DISMISS_REASONS.has(input.reasonCode)) {
        throw new TypeError("knowledge action reason is invalid");
      }
      return {
        ...common,
        suggestionId: assertId(input.suggestionId, "suggestionId"),
        reasonCode: input.reasonCode,
      };
    case "suggestion_restore":
    case "suggestion_accept_undo":
      knowledgeActionShape(input, ["commandId", "type", "suggestionId"]);
      return { ...common, suggestionId: assertId(input.suggestionId, "suggestionId") };
    case "suggestion_accept":
      knowledgeActionShape(input, [
        "commandId",
        "type",
        "suggestionId",
        "todoId",
        "title",
        "dueText",
      ]);
      return {
        ...common,
        suggestionId: assertId(input.suggestionId, "suggestionId"),
        todoId: assertId(input.todoId, "todoId"),
        title: boundedKnowledgeText(input.title, "title", 512),
        dueText: boundedKnowledgeText(input.dueText, "dueText", 256, { nullable: true }),
      };
    case "urgency_set":
      knowledgeActionShape(input, ["commandId", "type", "todoId", "urgency"]);
      if (!new Set(["normal", "urgent"]).has(input.urgency)) {
        throw new TypeError("knowledge action urgency is invalid");
      }
      return {
        ...common,
        todoId: assertId(input.todoId, "todoId"),
        urgency: input.urgency,
      };
    case "title_due_edit": {
      knowledgeActionShape(input, ["commandId", "type", "todoId"], ["title", "dueText"]);
      const hasTitle = Object.prototype.hasOwnProperty.call(input, "title");
      const hasDueText = Object.prototype.hasOwnProperty.call(input, "dueText");
      if (!hasTitle && !hasDueText) throw new TypeError("knowledge action edit is empty");
      return {
        ...common,
        todoId: assertId(input.todoId, "todoId"),
        ...(hasTitle ? { title: boundedKnowledgeText(input.title, "title", 512) } : {}),
        ...(hasDueText
          ? {
              dueText: boundedKnowledgeText(input.dueText, "dueText", 256, {
                nullable: true,
              }),
            }
          : {}),
      };
    }
    default:
      throw new TypeError("knowledge action type is invalid");
  }
}

function normalizeActionCenterReadInput(input) {
  exactPlainObject(input, ["throughSequence"], "action center read input");
  if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
    throw new TypeError("action center read sequence is invalid");
  }
  return { throughSequence: input.throughSequence };
}

const ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);

function normalizeActivityCorrectionInput(input) {
  exactPlainObject(input, ["classificationId", "category"], "activity correction input");
  if (!ACTIVITY_CATEGORIES.has(input.category)) {
    throw new TypeError("activity correction category is invalid");
  }
  return {
    classificationId: assertId(input.classificationId, "classificationId"),
    category: input.category,
  };
}

function normalizePersonalizationRuleDecisionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("personalization rule decision input must be an object");
  }
  const action = input.action;
  if (!["enable", "disable", "delete", "edit"].includes(action)) {
    throw new TypeError("personalization rule action is invalid");
  }
  const expectedKeys =
    action === "edit"
      ? ["ruleId", "action", "label", "targetValue", "conditions"]
      : ["ruleId", "action"];
  exactPlainObject(input, expectedKeys, "personalization rule decision input");
  const normalized = {
    ruleId: assertId(input.ruleId, "ruleId"),
    action,
  };
  if (action === "edit") {
    if (typeof input.label !== "string" || !input.label.trim()) {
      throw new TypeError("personalization rule label must be a non-empty string");
    }
    const label = input.label.trim().replace(/\s+/gu, " ");
    if (Array.from(label).length > 500) {
      throw new RangeError("personalization rule label is too long");
    }
    if (!ACTIVITY_CATEGORIES.has(input.targetValue)) {
      throw new TypeError("personalization rule target category is invalid");
    }
    exactPlainObject(
      input.conditions,
      ["applicationKeys", "selfParticipated", "speakerCountBucket", "timeBucket"],
      "personalization rule conditions"
    );
    if (
      !Array.isArray(input.conditions.applicationKeys) ||
      input.conditions.applicationKeys.length > 8 ||
      input.conditions.applicationKeys.some(
        (entry) => typeof entry !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(entry)
      ) ||
      new Set(input.conditions.applicationKeys).size !== input.conditions.applicationKeys.length
    ) {
      throw new TypeError("personalization rule application keys are invalid");
    }
    if (typeof input.conditions.selfParticipated !== "boolean") {
      throw new TypeError("personalization rule SELF condition is invalid");
    }
    if (!new Set(["none", "one", "multiple"]).has(input.conditions.speakerCountBucket)) {
      throw new TypeError("personalization rule speaker count condition is invalid");
    }
    if (!new Set(["night", "morning", "afternoon", "evening"]).has(input.conditions.timeBucket)) {
      throw new TypeError("personalization rule time condition is invalid");
    }
    normalized.label = label;
    normalized.targetValue = input.targetValue;
    normalized.conditions = {
      applicationKeys: [...input.conditions.applicationKeys].sort(),
      selfParticipated: input.conditions.selfParticipated,
      speakerCountBucket: input.conditions.speakerCountBucket,
      timeBucket: input.conditions.timeBucket,
    };
  }
  return normalized;
}

function normalizeNotificationPreferencesInput(input) {
  exactPlainObject(input, ["focusMode", "mutedUntil"], "notification preferences input");
  if (typeof input.focusMode !== "boolean") {
    throw new TypeError("notification focusMode must be a boolean");
  }
  if (
    input.mutedUntil !== null &&
    (!Number.isSafeInteger(input.mutedUntil) || input.mutedUntil < 0)
  ) {
    throw new TypeError("notification mutedUntil must be null or a non-negative integer");
  }
  return {
    focusMode: input.focusMode,
    mutedUntil: input.mutedUntil,
  };
}

function normalizeTodoReminderInput(input) {
  exactPlainObject(input, ["todoId", "reminderAt"], "todo reminder input");
  if (
    input.reminderAt !== null &&
    (!Number.isSafeInteger(input.reminderAt) || input.reminderAt < 0)
  ) {
    throw new TypeError("todo reminderAt must be null or a non-negative safe integer");
  }
  return {
    todoId: assertId(input.todoId, "todoId"),
    reminderAt: input.reminderAt,
  };
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

function nullableEvidenceConfidence(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("evidence context response is invalid");
  }
  return value;
}

function normalizeActionEvidenceAttribution(input) {
  if (input === null || input === undefined) return null;
  exactEnumerableObject(
    input,
    [
      "basis",
      "applicationKey",
      "applicationName",
      "sourceAttribution",
      "speakerRelation",
      "semanticConfidence",
      "voiceConfidence",
      "transcriptConfidence",
      "activityClassification",
    ],
    "action evidence attribution"
  );
  if (!new Set(["captured_todo_snapshot", "current_local_state"]).has(input.basis)) {
    throw new TypeError("evidence context response is invalid");
  }
  if (
    input.applicationKey !== null &&
    (typeof input.applicationKey !== "string" || !/^[a-z0-9._-]{1,64}$/u.test(input.applicationKey))
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (
    typeof input.applicationName !== "string" ||
    !input.applicationName.trim() ||
    Array.from(input.applicationName).length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(input.applicationName)
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  if (
    !new Set(["application", "microphone", "application_and_microphone", "mixed_unknown"]).has(
      input.sourceAttribution
    ) ||
    !/^(?:SELF|P[1-9][0-9]*|UNKNOWN)$/u.test(input.speakerRelation)
  ) {
    throw new TypeError("evidence context response is invalid");
  }
  let activityClassification = null;
  if (input.activityClassification !== null) {
    exactEnumerableObject(
      input.activityClassification,
      ["id", "category", "confidence", "decision", "source", "reason"],
      "action evidence activity classification"
    );
    if (
      !new Set([
        "work_meeting",
        "learning",
        "social_call",
        "in_person_conversation",
        "entertainment",
        "gaming",
        "other",
        "unknown",
      ]).has(input.activityClassification.category) ||
      !new Set(["adopted", "tentative", "unknown"]).has(input.activityClassification.decision) ||
      !new Set(["local", "minimax", "user", "captured_snapshot"]).has(
        input.activityClassification.source
      ) ||
      (input.activityClassification.reason !== null &&
        (typeof input.activityClassification.reason !== "string" ||
          Array.from(input.activityClassification.reason).length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(input.activityClassification.reason)))
    ) {
      throw new TypeError("evidence context response is invalid");
    }
    const capturedClassification = input.basis === "captured_todo_snapshot";
    if (
      capturedClassification !== (input.activityClassification.source === "captured_snapshot") ||
      capturedClassification !== (input.activityClassification.id === null)
    ) {
      throw new TypeError("evidence context response is invalid");
    }
    activityClassification = {
      id:
        input.activityClassification.id === null
          ? null
          : assertId(input.activityClassification.id, "activityClassificationId"),
      category: input.activityClassification.category,
      confidence: nullableEvidenceConfidence(input.activityClassification.confidence),
      decision: input.activityClassification.decision,
      source: input.activityClassification.source,
      reason: input.activityClassification.reason,
    };
  }
  return {
    basis: input.basis,
    applicationKey: input.applicationKey,
    applicationName: input.applicationName,
    sourceAttribution: input.sourceAttribution,
    speakerRelation: input.speakerRelation,
    semanticConfidence: nullableEvidenceConfidence(input.semanticConfidence),
    voiceConfidence: nullableEvidenceConfidence(input.voiceConfidence),
    transcriptConfidence: nullableEvidenceConfidence(input.transcriptConfidence),
    activityClassification,
  };
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
  const rawTranscriptContext = input.transcriptContext ?? [];
  if (!Array.isArray(rawTranscriptContext) || rawTranscriptContext.length > 7) {
    throw new TypeError("evidence context response is invalid");
  }
  const seenContextSegments = new Set();
  const transcriptContext = rawTranscriptContext.map((entry) => {
    exactEnumerableObject(
      entry,
      [
        "segmentId",
        "startedAt",
        "endedAt",
        "text",
        "speakerRelation",
        "applicationName",
        "isEvidence",
      ],
      "evidence transcript context"
    );
    const segmentId = assertId(entry.segmentId, "transcriptContextSegmentId");
    const contextStartedAt = evidenceResponseTime(entry.startedAt);
    const contextEndedAt = evidenceResponseTime(entry.endedAt);
    if (
      seenContextSegments.has(segmentId) ||
      contextStartedAt < sessionStartedAt ||
      contextEndedAt <= contextStartedAt ||
      (sessionEndedAt !== null && contextEndedAt > sessionEndedAt) ||
      typeof entry.text !== "string" ||
      !entry.text.trim() ||
      Array.from(entry.text).length > 2_048 ||
      !/^(?:SELF|P[1-9][0-9]*|UNKNOWN)$/u.test(entry.speakerRelation) ||
      (entry.applicationName !== null &&
        (typeof entry.applicationName !== "string" ||
          !entry.applicationName.trim() ||
          Array.from(entry.applicationName).length > 80 ||
          /[\u0000-\u001f\u007f]/u.test(entry.applicationName))) ||
      typeof entry.isEvidence !== "boolean"
    ) {
      throw new TypeError("evidence context response is invalid");
    }
    seenContextSegments.add(segmentId);
    return {
      segmentId,
      startedAt: contextStartedAt,
      endedAt: contextEndedAt,
      text: entry.text,
      speakerRelation: entry.speakerRelation,
      applicationName: entry.applicationName,
      isEvidence: entry.isEvidence,
    };
  });
  const focalContext = transcriptContext.filter((entry) => entry.isEvidence);
  if (
    (input.transcriptState === "missing" && transcriptContext.length > 0) ||
    focalContext.length > 1 ||
    (transcriptContext.length > 0 &&
      (focalContext.length !== 1 || focalContext[0].segmentId !== transcriptSegmentId))
  ) {
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
    transcriptContext,
    actionAttribution: normalizeActionEvidenceAttribution(input.actionAttribution),
  };
}

function normalizeMiniMaxKeyInput(input) {
  exactEnumerableObject(input, ["key"], "MiniMax key input");
  if (typeof input.key !== "string") {
    throw new TypeError("MiniMax key must be a string");
  }
  const key = input.key.trim();
  if (!key || key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new TypeError("MiniMax key must be a bounded non-empty string");
  }
  return { key };
}

const PUBLIC_MINIMAX_MODELS = new Set(["MiniMax-M2.7"]);
const PUBLIC_MINIMAX_MODEL_STATUSES = new Set([
  "not_configured",
  "ready",
  "unavailable",
  "model_unavailable",
]);

function normalizeMiniMaxConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("MiniMax config response is invalid");
  }
  exactEnumerableObject(
    input,
    ["keyConfigured", "model", "modelStatus", "fallbackUsed", "checkedAt"],
    "MiniMax config response"
  );
  if (
    typeof input.keyConfigured !== "boolean" ||
    !PUBLIC_MINIMAX_MODELS.has(input.model) ||
    !PUBLIC_MINIMAX_MODEL_STATUSES.has(input.modelStatus) ||
    typeof input.fallbackUsed !== "boolean" ||
    (input.checkedAt !== null && (!Number.isSafeInteger(input.checkedAt) || input.checkedAt < 0)) ||
    (!input.keyConfigured &&
      (input.modelStatus !== "not_configured" || input.fallbackUsed || input.checkedAt !== null)) ||
    (input.keyConfigured && input.modelStatus === "not_configured")
  ) {
    throw new TypeError("MiniMax config response is invalid");
  }
  return {
    keyConfigured: input.keyConfigured,
    model: input.model,
    modelStatus: input.modelStatus,
    fallbackUsed: input.fallbackUsed,
    checkedAt: input.checkedAt,
  };
}

const RESOURCE_GOVERNANCE_PRESETS = Object.freeze({
  game_priority: Object.freeze({
    profile: "game_priority",
    externalGpuThresholdPct: 20,
    recoveryWaitMs: 120_000,
  }),
  balanced: Object.freeze({
    profile: "balanced",
    externalGpuThresholdPct: 45,
    recoveryWaitMs: 60_000,
  }),
  processing_priority: Object.freeze({
    profile: "processing_priority",
    externalGpuThresholdPct: 75,
    recoveryWaitMs: 15_000,
  }),
});

function normalizeResourceGovernanceSettings(input) {
  exactEnumerableObject(
    input,
    ["profile", "externalGpuThresholdPct", "recoveryWaitMs"],
    "resource governance settings"
  );
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_GOVERNANCE_PRESETS, input.profile)) {
    throw new TypeError("resource governance profile is invalid");
  }
  if (
    !Number.isSafeInteger(input.externalGpuThresholdPct) ||
    input.externalGpuThresholdPct < 10 ||
    input.externalGpuThresholdPct > 85
  ) {
    throw new RangeError("externalGpuThresholdPct must be between 10 and 85");
  }
  if (
    !Number.isSafeInteger(input.recoveryWaitMs) ||
    input.recoveryWaitMs < 15_000 ||
    input.recoveryWaitMs > 300_000
  ) {
    throw new RangeError("recoveryWaitMs must be between 15000 and 300000");
  }
  return {
    profile: input.profile,
    externalGpuThresholdPct: input.externalGpuThresholdPct,
    recoveryWaitMs: input.recoveryWaitMs,
  };
}

function normalizeApplicationAudioSettings(input) {
  exactEnumerableObject(
    input,
    ["enabled", "trackLimit", "fallbackPolicy"],
    "application audio settings"
  );
  if (typeof input.enabled !== "boolean") {
    throw new TypeError("application audio enabled must be a boolean");
  }
  if (!Number.isSafeInteger(input.trackLimit) || input.trackLimit < 1 || input.trackLimit > 8) {
    throw new RangeError("application audio trackLimit must be between 1 and 8");
  }
  if (!new Set(["conservative", "transcript_only"]).has(input.fallbackPolicy)) {
    throw new TypeError("application audio fallbackPolicy is invalid");
  }
  return {
    enabled: input.enabled,
    trackLimit: input.trackLimit,
    fallbackPolicy: input.fallbackPolicy,
  };
}

function normalizeJarvisRolloutFlags(input) {
  const keys = [
    "applicationAudioV1",
    "dualSpeakerVerificationV1",
    "activityClassificationV1",
    "actionCenterV1",
  ];
  exactEnumerableObject(input, keys, "Jarvis rollout flags");
  for (const key of keys) {
    if (typeof input[key] !== "boolean") {
      throw new TypeError(`Jarvis rollout flag ${key} must be a boolean`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, input[key]]));
}

function normalizeAnalysisBudgetInput(input) {
  const hasMode =
    input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "mode");
  exactEnumerableObject(
    input,
    hasMode ? ["mode", "monthlyLimitMicrousd", "timezone"] : ["monthlyLimitMicrousd", "timezone"],
    "analysis budget input"
  );
  if (
    !Number.isSafeInteger(input.monthlyLimitMicrousd) ||
    input.monthlyLimitMicrousd < 0 ||
    input.monthlyLimitMicrousd > 1_000_000_000_000
  ) {
    throw new RangeError("monthlyLimitMicrousd must be between 0 and 1000000000000");
  }
  const mode = hasMode ? input.mode : input.monthlyLimitMicrousd === 0 ? "off" : "capped";
  if (!new Set(["off", "capped", "unlimited"]).has(mode)) {
    throw new TypeError("analysis budget mode is invalid");
  }
  if (mode === "off" && input.monthlyLimitMicrousd !== 0) {
    throw new TypeError("off mode requires a zero monthly limit");
  }
  if (
    typeof input.timezone !== "string" ||
    !input.timezone ||
    input.timezone !== input.timezone.trim() ||
    input.timezone.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input.timezone)
  ) {
    throw new TypeError("timezone must be a bounded non-empty string");
  }
  return {
    mode,
    monthlyLimitMicrousd: input.monthlyLimitMicrousd,
    timezone: input.timezone,
  };
}

const ANALYSIS_BUDGET_BLOCKED_REASONS = new Set([
  null,
  "disabled",
  "budget_exceeded",
  "usage_unknown",
  "over_limit",
]);

function normalizeAnalysisBudgetStatus(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("analysis budget response is invalid");
  }
  if (
    typeof input.monthKey !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/u.test(input.monthKey) ||
    typeof input.timezone !== "string" ||
    !input.timezone ||
    input.timezone.length > 128 ||
    !new Set(["off", "capped", "unlimited"]).has(input.mode) ||
    input.currency !== "USD" ||
    !ANALYSIS_BUDGET_BLOCKED_REASONS.has(input.blockedReason)
  ) {
    throw new TypeError("analysis budget response is invalid");
  }
  for (const key of ["monthlyLimitMicrousd", "spentMicrousd", "reservedMicrousd"]) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError("analysis budget response is invalid");
    }
  }
  if (
    (input.mode === "unlimited" && input.remainingMicrousd !== null) ||
    (input.mode !== "unlimited" &&
      (!Number.isSafeInteger(input.remainingMicrousd) || input.remainingMicrousd < 0))
  ) {
    throw new TypeError("analysis budget response is invalid");
  }
  return {
    mode: input.mode,
    monthKey: input.monthKey,
    timezone: input.timezone,
    currency: "USD",
    monthlyLimitMicrousd: input.monthlyLimitMicrousd,
    spentMicrousd: input.spentMicrousd,
    reservedMicrousd: input.reservedMicrousd,
    remainingMicrousd: input.remainingMicrousd,
    blockedReason: input.blockedReason,
  };
}

const ANALYSIS_STATUS_STATES = new Set([
  "waiting",
  "preparing",
  "queued",
  "analyzing",
  "ready",
  "quota_limited",
  "retry_needed",
  "blocked",
]);
const ANALYSIS_STATUS_ERROR_CODES = new Set([
  null,
  "analysis_runtime_not_ready",
  "analysis_input_empty",
  "analysis_input_invalid",
  "analysis_input_state_invalid",
  "analysis_desired_head_invalid",
  "analysis_cloud_job_invalid",
  "analysis_failed",
  "offline",
  "budget_exceeded",
  "usage_unknown",
  "over_limit",
  "rate_limit",
  "invalid_response",
]);

function normalizeAnalysisStatus(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("analysis status response is invalid");
  }
  if (
    !ANALYSIS_STATUS_STATES.has(input.state) ||
    !ANALYSIS_STATUS_ERROR_CODES.has(input.errorCode) ||
    (input.updatedAt !== null && (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0))
  ) {
    throw new TypeError("analysis status response is invalid");
  }
  return {
    sessionId: assertId(input.sessionId, "sessionId"),
    state: input.state,
    errorCode: input.errorCode,
    updatedAt: input.updatedAt,
  };
}

const CAPTURE_FAILURE_CODES = new Set([
  "MIC_PERMISSION",
  "MIC_DISCONNECTED",
  "capture_source_unavailable",
  "capture_start_failed",
  "capture_start_timeout",
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
  normalizeDailyDigestRegenerateRequest,
  normalizeSuggestionDecisionInput,
  normalizeMemoryConflictResolutionInput,
  normalizeKnowledgeTodoCompletionInput,
  normalizeKnowledgeTodoDecisionInput,
  normalizeKnowledgeActionInput,
  normalizeActionCenterReadInput,
  normalizeActivityCorrectionInput,
  normalizePersonalizationRuleDecisionInput,
  normalizeLearningGoalCreateInput,
  normalizeLearningGoalEditInput,
  normalizeLearningGoalIdInput,
  normalizeNotificationPreferencesInput,
  normalizeTodoReminderInput,
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
  normalizeMiniMaxKeyInput,
  normalizeMiniMaxConfig,
  RESOURCE_GOVERNANCE_PRESETS,
  normalizeResourceGovernanceSettings,
  normalizeApplicationAudioSettings,
  normalizeJarvisRolloutFlags,
  normalizeAnalysisBudgetInput,
  normalizeAnalysisBudgetStatus,
  normalizeAnalysisStatus,
  assertSessionStatus,
  assertCaptureFailureCode,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
};
