const { assertId, normalizeLearningGoalCreateInput } = require("../../shared/contracts");
const { toRendererSession } = require("../AudioChunkPublicView");

function toRendererSessionTimelineStatus(status) {
  if (!status || typeof status !== "object") return null;
  const counts = status.processing_counts ?? {};
  return {
    session_id: status.session_id,
    status: status.status,
    processing_state: status.processing_state,
    timeline_version: status.timeline_version,
    finalized_at: status.finalized_at,
    ready_at: status.ready_at,
    processing_counts: {
      pending: counts.pending ?? 0,
      leased: counts.leased ?? 0,
      retry: counts.retry ?? 0,
      blocked: counts.blocked ?? 0,
      completed: counts.completed ?? 0,
      total: counts.total ?? 0,
    },
  };
}

const PUBLIC_TOPIC_FIELDS = Object.freeze([
  "id",
  "canonical_title",
  "normalized_title",
  "description",
  "status",
  "created_at",
  "last_seen_at",
  "session_count",
  "open_todo_count",
]);
const PUBLIC_TOPIC_PERSON_FIELDS = Object.freeze([
  "id",
  "display_name",
  "is_self",
  "voice_profile_id",
  "voice_confidence",
  "created_at",
  "last_seen_at",
]);
const PUBLIC_TOPIC_TODO_FIELDS = Object.freeze([
  "id",
  "content",
  "owner_person_id",
  "owner_name",
  "topic_id",
  "topic_title",
  "due_at",
  "status",
  "updated_at",
  "completed_at",
  "source_session_id",
  "source_segment_id",
]);
const PUBLIC_TOPIC_MEMORY_FIELDS = Object.freeze([
  "id",
  "type",
  "content",
  "person_id",
  "person_name",
  "topic_id",
  "topic_title",
  "confidence",
  "last_seen_at",
  "occurrence_count",
  "needs_confirmation",
]);

function projectTopicFields(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) result[field] = input[field];
  }
  return result;
}

function projectTopicRows(rows, fields) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => projectTopicFields(row, fields)).filter(Boolean);
}

function toPublicTopicDetail(detail) {
  if (detail === null) return null;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new TypeError("topic detail is invalid");
  }
  const topic = projectTopicFields(detail.topic, PUBLIC_TOPIC_FIELDS);
  if (!topic) throw new TypeError("topic detail is invalid");
  const decisions = Array.isArray(detail.decisions)
    ? detail.decisions.map((decision) => {
        if (
          !decision ||
          typeof decision !== "object" ||
          Array.isArray(decision) ||
          typeof decision.content !== "string"
        ) {
          throw new TypeError("topic decision is invalid");
        }
        return {
          sessionId: assertId(decision.sessionId, "decisionSessionId"),
          content: decision.content,
        };
      })
    : [];
  return {
    topic,
    people: projectTopicRows(detail.people, PUBLIC_TOPIC_PERSON_FIELDS),
    sessions: Array.isArray(detail.sessions) ? detail.sessions.map(toRendererSession) : [],
    decisions,
    todos: projectTopicRows(detail.todos, PUBLIC_TOPIC_TODO_FIELDS),
    memories: projectTopicRows(detail.memories, PUBLIC_TOPIC_MEMORY_FIELDS),
  };
}

function toPublicActivityClassification(entry) {
  const applications = (
    Array.isArray(entry?.evidence?.applicationKeys) ? entry.evidence.applicationKeys : []
  )
    .filter(
      (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$/.test(value)
    )
    .slice(0, 8);
  const evidenceSegmentIds = (
    Array.isArray(entry?.evidence?.evidenceSegmentIds) ? entry.evidence.evidenceSegmentIds : []
  )
    .slice(0, 100)
    .map((value) => assertId(value, "evidenceSegmentId"));
  return {
    id: assertId(entry?.id, "activityClassificationId"),
    sessionId: assertId(entry?.sessionId, "sessionId"),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    category: entry.category,
    confidence: entry.confidence,
    decision: entry.decision,
    source: entry.source,
    reason: entry.reason,
    sourceAttribution: entry.sourceAttribution,
    applications,
    allowSummary: entry?.evidence?.allowSummary === true,
    allowSuggestions: entry?.evidence?.allowSuggestions === true,
    allowTodos: entry?.evidence?.allowTodos === true,
    evidenceSegmentIds,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toPublicPersonalizationRule(entry) {
  return {
    id: assertId(entry?.id, "personalizationRuleId"),
    domain: entry?.domain,
    targetValue: entry?.targetValue,
    label: entry?.label,
    supportCount: entry?.supportCount,
    state: entry?.state,
    conditions: {
      applicationKeys: Array.isArray(entry?.rule?.features?.applicationKeys)
        ? entry.rule.features.applicationKeys.slice(0, 8)
        : [],
      selfParticipated: entry?.rule?.features?.selfParticipated === true,
      speakerCountBucket: entry?.rule?.features?.speakerCountBucket ?? "none",
      timeBucket: entry?.rule?.features?.timeBucket ?? "unknown",
    },
    createdAt: entry?.createdAt,
    updatedAt: entry?.updatedAt,
  };
}

const LEARNING_GOAL_STATES = new Set(["confirmed", "archived", "deleted"]);
const LEARNING_GOAL_RESULT_STATUSES = new Set([
  "created",
  "existing",
  "edited",
  "unchanged",
  "archived",
  "already_archived",
  "restored",
  "already_confirmed",
  "deleted",
]);

function toPublicLearningGoal(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("learning goal is unavailable");
  }
  if (!LEARNING_GOAL_STATES.has(entry.state)) {
    throw new TypeError("learning goal state is invalid");
  }
  for (const key of ["createdAt", "updatedAt", "confirmedAt"]) {
    if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) {
      throw new TypeError(`learning goal ${key} is invalid`);
    }
  }
  for (const key of ["archivedAt"]) {
    if (entry[key] !== null && (!Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new TypeError(`learning goal ${key} is invalid`);
    }
  }
  return {
    id: assertId(entry.id, "learningGoalId"),
    title: normalizeLearningGoalCreateInput({ title: entry.title }).title,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    confirmedAt: entry.confirmedAt,
    archivedAt: entry.archivedAt,
  };
}

function toPublicLearningGoalResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !LEARNING_GOAL_RESULT_STATUSES.has(result.status)
  ) {
    throw new TypeError("learning goal result is invalid");
  }
  return { status: result.status, goal: toPublicLearningGoal(result.goal) };
}

function toPublicActionCenterWatermark(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Action center watermark is unavailable");
  }
  if (typeof value.revision !== "string" || !/^[0-9a-f]{64}$/u.test(value.revision)) {
    throw new TypeError("Action center watermark revision is invalid");
  }
  for (const key of ["todoCount", "suggestionCount"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new TypeError(`Action center watermark ${key} is invalid`);
    }
  }
  if (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) {
    throw new TypeError("Action center watermark updatedAt is invalid");
  }
  return {
    revision: value.revision,
    todoCount: value.todoCount,
    suggestionCount: value.suggestionCount,
    updatedAt: value.updatedAt,
  };
}

function toPublicActionCenterDelta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Action center delta is unavailable");
  }
  for (const key of [
    "throughSequence",
    "lastSeenSequence",
    "confirmedTodoCount",
    "pendingTodoCount",
    "suggestionCount",
    "total",
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new TypeError(`Action center delta ${key} is invalid`);
    }
  }
  if (
    value.lastSeenSequence > value.throughSequence ||
    value.total !== value.confirmedTodoCount + value.pendingTodoCount + value.suggestionCount ||
    !Array.isArray(value.sessions)
  ) {
    throw new TypeError("Action center delta totals are invalid");
  }
  const sessions = value.sessions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Action center session delta is invalid");
    }
    for (const key of ["confirmedTodoCount", "pendingTodoCount", "suggestionCount", "total"]) {
      if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) {
        throw new TypeError(`Action center session delta ${key} is invalid`);
      }
    }
    if (entry.total !== entry.confirmedTodoCount + entry.pendingTodoCount + entry.suggestionCount) {
      throw new TypeError("Action center session delta totals are invalid");
    }
    return {
      sessionId: assertId(entry.sessionId, "sessionId"),
      confirmedTodoCount: entry.confirmedTodoCount,
      pendingTodoCount: entry.pendingTodoCount,
      suggestionCount: entry.suggestionCount,
      total: entry.total,
    };
  });
  const sums = sessions.reduce(
    (result, entry) => ({
      confirmedTodoCount: result.confirmedTodoCount + entry.confirmedTodoCount,
      pendingTodoCount: result.pendingTodoCount + entry.pendingTodoCount,
      suggestionCount: result.suggestionCount + entry.suggestionCount,
    }),
    { confirmedTodoCount: 0, pendingTodoCount: 0, suggestionCount: 0 }
  );
  if (
    sums.confirmedTodoCount !== value.confirmedTodoCount ||
    sums.pendingTodoCount !== value.pendingTodoCount ||
    sums.suggestionCount !== value.suggestionCount
  ) {
    throw new TypeError("Action center session deltas do not match totals");
  }
  return {
    throughSequence: value.throughSequence,
    lastSeenSequence: value.lastSeenSequence,
    confirmedTodoCount: value.confirmedTodoCount,
    pendingTodoCount: value.pendingTodoCount,
    suggestionCount: value.suggestionCount,
    total: value.total,
    sessions,
  };
}

function toPublicActionCenterReadResult(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.lastSeenSequence) ||
    value.lastSeenSequence < 0 ||
    !Number.isSafeInteger(value.markedAt) ||
    value.markedAt < 0
  ) {
    throw new TypeError("Action center read result is invalid");
  }
  return { lastSeenSequence: value.lastSeenSequence, markedAt: value.markedAt };
}

function toPublicNotificationPreferences(entry) {
  return {
    focusMode: entry?.focusMode === true,
    mutedUntil: Number.isSafeInteger(entry?.mutedUntil) ? entry.mutedUntil : null,
    updatedAt: Number.isSafeInteger(entry?.updatedAt) ? entry.updatedAt : 0,
    effectiveMuted: entry?.effectiveMuted === true,
  };
}

function toPublicTodoReminder(entry) {
  if (!entry) return null;
  const states = new Set(["scheduled", "deferred", "delivered", "cancelled"]);
  if (
    !Number.isSafeInteger(entry.reminderAt) ||
    entry.reminderAt < 0 ||
    entry.reminderSource !== "user" ||
    !states.has(entry.state)
  ) {
    throw new TypeError("todo reminder is invalid");
  }
  return {
    todoId: assertId(entry.todoId, "todoId"),
    reminderAt: entry.reminderAt,
    reminderSource: "user",
    state: entry.state,
    deferredReason:
      typeof entry.deferredReason === "string" && /^[a-z0-9_]{1,128}$/u.test(entry.deferredReason)
        ? entry.deferredReason
        : null,
    deliveredAt: Number.isSafeInteger(entry.deliveredAt) ? entry.deliveredAt : null,
    updatedAt: Number.isSafeInteger(entry.updatedAt) ? entry.updatedAt : 0,
  };
}

function toPublicAmbiguousSpeakerFailure(error) {
  if (error?.code !== "ambiguous_duplicate_name") throw error;
  if (!Array.isArray(error.candidates)) {
    throw new TypeError("ambiguous speaker candidates must be an array");
  }
  const candidates = error.candidates.map((candidate) => {
    const id = assertId(candidate?.id, "candidate personId");
    if (
      typeof candidate?.displayName !== "string" ||
      !candidate.displayName.trim() ||
      Array.from(candidate.displayName).length > 80 ||
      typeof candidate.isSelf !== "boolean"
    ) {
      throw new TypeError("ambiguous speaker candidate is invalid");
    }
    return { id, displayName: candidate.displayName, isSelf: candidate.isSelf };
  });
  return {
    speakerCorrectionError: {
      code: "ambiguous_duplicate_name",
      candidates,
    },
  };
}

module.exports = {
  toRendererSessionTimelineStatus,
  PUBLIC_TOPIC_FIELDS,
  PUBLIC_TOPIC_PERSON_FIELDS,
  PUBLIC_TOPIC_TODO_FIELDS,
  PUBLIC_TOPIC_MEMORY_FIELDS,
  projectTopicFields,
  projectTopicRows,
  toPublicTopicDetail,
  toPublicActivityClassification,
  toPublicPersonalizationRule,
  LEARNING_GOAL_STATES,
  LEARNING_GOAL_RESULT_STATUSES,
  toPublicLearningGoal,
  toPublicLearningGoalResult,
  toPublicActionCenterWatermark,
  toPublicActionCenterDelta,
  toPublicActionCenterReadResult,
  toPublicNotificationPreferences,
  toPublicTodoReminder,
  toPublicAmbiguousSpeakerFailure,
};
