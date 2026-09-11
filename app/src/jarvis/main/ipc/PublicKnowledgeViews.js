const { assertId, normalizeEvidenceContextRequest } = require("../../shared/contracts");
const { NORMALIZED_APPLICATIONS } = require("../ActivityClassificationInputBuilder");

const KNOWLEDGE_LIST_LIMIT = 100;
const KNOWLEDGE_HISTORY_LIMIT = 20;
const KNOWLEDGE_EVIDENCE_LIMIT = 8;
const PUBLIC_TODO_PROVENANCE = new Set([
  "evidence_linked",
  "legacy_unverified",
  "suggestion",
  "source_deleted",
]);
const PUBLIC_KNOWLEDGE_SOURCE_KINDS = new Set(["existing", "manual", "transcript", "suggestion"]);
const PUBLIC_KNOWLEDGE_DISMISS_REASONS = new Set([
  "not_relevant",
  "already_done",
  "not_mine",
  "wrong_context",
  "low_value",
  "other",
]);
const PUBLIC_TRUST_SNAPSHOT_STATES = new Set(["captured", "legacy_unverified", "user_override"]);
const PUBLIC_ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
const PUBLIC_ACTIVITY_DECISIONS = new Set(["adopted", "tentative", "unknown"]);
const PUBLIC_SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const PUBLIC_CARD_APPLICATION_NAMES = new Set(Object.values(NORMALIZED_APPLICATIONS));

function limited(items, limit) {
  return (Array.isArray(items) ? items : []).slice(0, limit);
}

function toPublicKnowledgeCardContext(input) {
  const fallback = {
    sessionId: null,
    startedAt: null,
    applicationName: null,
    activityCategory: null,
    activityConfidence: null,
    sourceAttribution: "mixed_unknown",
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
  let sessionId = null;
  try {
    sessionId = input.sessionId === null ? null : assertId(input.sessionId, "cardContextSessionId");
  } catch {
    sessionId = null;
  }
  const startedAt =
    sessionId !== null && Number.isSafeInteger(input.startedAt) && input.startedAt >= 0
      ? input.startedAt
      : null;
  const sourceAttribution = PUBLIC_SOURCE_ATTRIBUTIONS.has(input.sourceAttribution)
    ? input.sourceAttribution
    : "mixed_unknown";
  let applicationName = null;
  if (
    sourceAttribution === "microphone" &&
    (input.applicationName === null || input.applicationName === "Microphone")
  ) {
    applicationName = input.applicationName;
  } else if (
    (sourceAttribution === "application" || sourceAttribution === "application_and_microphone") &&
    typeof input.applicationName === "string" &&
    PUBLIC_CARD_APPLICATION_NAMES.has(input.applicationName)
  ) {
    applicationName = input.applicationName;
  }
  const activityCategory =
    input.activityCategory === null || PUBLIC_ACTIVITY_CATEGORIES.has(input.activityCategory)
      ? input.activityCategory
      : null;
  const activityConfidence =
    activityCategory !== null &&
    typeof input.activityConfidence === "number" &&
    Number.isFinite(input.activityConfidence) &&
    input.activityConfidence >= 0 &&
    input.activityConfidence <= 1
      ? input.activityConfidence
      : null;
  return {
    sessionId,
    startedAt,
    applicationName,
    activityCategory,
    activityConfidence,
    sourceAttribution,
  };
}

function toPublicKnowledgeEvidence(entry) {
  return {
    sessionId: entry.sessionId,
    segmentId: entry.segmentId,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    quote: entry.quote,
    audioState: entry.audioState,
    handle: normalizeEvidenceContextRequest(entry.handle),
  };
}

function publicEvidence(items) {
  return limited(items, KNOWLEDGE_EVIDENCE_LIMIT).map(toPublicKnowledgeEvidence);
}

function publicTrustConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function toPublicTodoTrustSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (
    typeof input.policyId !== "string" ||
    !input.policyId.trim() ||
    Array.from(input.policyId).length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input.policyId) ||
    !PUBLIC_TRUST_SNAPSHOT_STATES.has(input.state) ||
    !Array.isArray(input.applicationEvidence) ||
    input.applicationEvidence.length > 100 ||
    !Array.isArray(input.activityEvidence) ||
    input.activityEvidence.length > 100
  ) {
    return null;
  }
  let applicationEvidence;
  let activityEvidence;
  try {
    applicationEvidence = input.applicationEvidence.map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.segmentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.segmentId) ||
        (entry.applicationKey !== null &&
          (typeof entry.applicationKey !== "string" ||
            !/^[a-z0-9._-]{1,64}$/u.test(entry.applicationKey))) ||
        !PUBLIC_SOURCE_ATTRIBUTIONS.has(entry.sourceAttribution) ||
        typeof entry.speakerRelation !== "string" ||
        !/^(?:SELF|P[1-9][0-9]*|UNKNOWN)$/u.test(entry.speakerRelation)
      ) {
        throw new TypeError("todo trust snapshot is invalid");
      }
      return {
        segmentId: entry.segmentId,
        applicationKey: entry.applicationKey,
        sourceAttribution: entry.sourceAttribution,
        speakerRelation: entry.speakerRelation,
      };
    });
    activityEvidence = input.activityEvidence.map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.segmentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.segmentId) ||
        !PUBLIC_ACTIVITY_CATEGORIES.has(entry.category) ||
        !PUBLIC_ACTIVITY_DECISIONS.has(entry.decision)
      ) {
        throw new TypeError("todo trust snapshot is invalid");
      }
      const confidence = publicTrustConfidence(entry.confidence);
      if (confidence === null) throw new TypeError("todo trust snapshot is invalid");
      return {
        segmentId: entry.segmentId,
        category: entry.category,
        confidence,
        decision: entry.decision,
      };
    });
  } catch {
    return null;
  }
  const semanticConfidence = publicTrustConfidence(input.semanticConfidence);
  const voiceprintConfidence = publicTrustConfidence(input.voiceprintConfidence);
  const sceneConfidence = publicTrustConfidence(input.sceneConfidence);
  const transcriptContextConfidence = publicTrustConfidence(input.transcriptContextConfidence);
  const speakerEvidenceVerified =
    typeof input.speakerEvidenceVerified === "boolean" ? input.speakerEvidenceVerified : null;
  const overlapDetected = typeof input.overlapDetected === "boolean" ? input.overlapDetected : null;
  if (
    (input.state === "captured" &&
      (applicationEvidence.length === 0 ||
        activityEvidence.length === 0 ||
        semanticConfidence === null ||
        voiceprintConfidence === null ||
        sceneConfidence === null ||
        transcriptContextConfidence === null ||
        speakerEvidenceVerified !== true ||
        overlapDetected !== false)) ||
    (input.state !== "captured" &&
      (applicationEvidence.length > 0 ||
        activityEvidence.length > 0 ||
        semanticConfidence !== null ||
        voiceprintConfidence !== null ||
        sceneConfidence !== null ||
        transcriptContextConfidence !== null ||
        speakerEvidenceVerified !== null ||
        overlapDetected !== null ||
        input.automaticEligible === true))
  ) {
    return null;
  }
  const automaticEligible =
    input.automaticEligible === true &&
    input.state === "captured" &&
    applicationEvidence.length > 0 &&
    activityEvidence.length > 0 &&
    semanticConfidence !== null &&
    semanticConfidence >= 0.9 &&
    voiceprintConfidence !== null &&
    voiceprintConfidence >= 0.9 &&
    sceneConfidence !== null &&
    sceneConfidence >= 0.9 &&
    transcriptContextConfidence !== null &&
    speakerEvidenceVerified === true &&
    overlapDetected === false &&
    applicationEvidence.every(
      (entry) => entry.speakerRelation === "SELF" && entry.sourceAttribution !== "mixed_unknown"
    ) &&
    activityEvidence.every(
      (entry) =>
        entry.segmentId !== undefined &&
        new Set(["work_meeting", "learning", "social_call", "in_person_conversation"]).has(
          entry.category
        ) &&
        entry.decision === "adopted" &&
        entry.confidence >= 0.9
    ) &&
    new Set(applicationEvidence.map((entry) => entry.segmentId)).size ===
      applicationEvidence.length &&
    new Set(activityEvidence.map((entry) => entry.segmentId)).size === activityEvidence.length &&
    applicationEvidence.every((entry) =>
      activityEvidence.some((activity) => activity.segmentId === entry.segmentId)
    ) &&
    activityEvidence.every((entry) =>
      applicationEvidence.some((application) => application.segmentId === entry.segmentId)
    );
  return {
    policyId: input.policyId,
    state: input.state,
    applicationEvidence,
    activityEvidence,
    semanticConfidence,
    voiceprintConfidence,
    sceneConfidence,
    transcriptContextConfidence,
    speakerEvidenceVerified,
    overlapDetected,
    automaticEligible,
  };
}

function toPublicKnowledgeOverview(snapshot) {
  const memories = limited(snapshot?.memories, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    confidence: item.confidence,
    lifecycle: item.lifecycle,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    occurrences: limited(item.occurrences, KNOWLEDGE_HISTORY_LIMIT).map((occurrence) => ({
      id: occurrence.id,
      sessionId: occurrence.sessionId,
      startedAt: occurrence.startedAt,
      endedAt: occurrence.endedAt,
      confidence: occurrence.confidence,
      createdAt: occurrence.createdAt,
      evidence: publicEvidence(occurrence.evidence),
    })),
  }));
  const topics = limited(snapshot?.topics, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    name: item.name,
    lifecycle: item.lifecycle,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revisions: limited(item.revisions, KNOWLEDGE_HISTORY_LIMIT).map((revision) => ({
      id: revision.id,
      revision: revision.revision,
      summary: revision.summary,
      createdAt: revision.createdAt,
    })),
    occurrences: limited(item.occurrences, KNOWLEDGE_HISTORY_LIMIT).map((occurrence) => ({
      id: occurrence.id,
      sessionId: occurrence.sessionId,
      revisionId: occurrence.revisionId,
      createdAt: occurrence.createdAt,
      evidence: publicEvidence(occurrence.evidence),
    })),
  }));
  const todos = limited(snapshot?.todos, KNOWLEDGE_LIST_LIMIT).map((item) => {
    const trustSnapshot = toPublicTodoTrustSnapshot(item.trustSnapshot);
    const verificationState =
      item.verificationActor === "system" &&
      item.verificationState === "confirmed" &&
      trustSnapshot?.automaticEligible !== true
        ? "pending_confirmation"
        : item.verificationState;
    return {
      id: item.id,
      title: item.title,
      ownerLabel: item.ownerLabel,
      status: item.status,
      completedAt: item.completedAt,
      dismissedAt: item.dismissedAt,
      verificationState,
      verificationReason: item.verificationReason,
      verificationActor: item.verificationActor,
      trustSnapshot,
      cardContext: toPublicKnowledgeCardContext(item.cardContext),
      provenance: PUBLIC_TODO_PROVENANCE.has(item.provenance)
        ? item.provenance
        : "legacy_unverified",
      sourceKind: PUBLIC_KNOWLEDGE_SOURCE_KINDS.has(item.sourceKind) ? item.sourceKind : "existing",
      sourceSessionId: typeof item.sourceSessionId === "string" ? item.sourceSessionId : null,
      pinned: item.pinned === true,
      urgency: item.urgency === "urgent" ? "urgent" : "normal",
      userModified: item.userModified === true,
      dismissReasonCode: PUBLIC_KNOWLEDGE_DISMISS_REASONS.has(item.dismissReasonCode)
        ? item.dismissReasonCode
        : null,
      sourceSuggestionId: item.sourceSuggestionId,
      reminder:
        item.reminder && Number.isSafeInteger(item.reminder.reminderAt)
          ? {
              reminderAt: item.reminder.reminderAt,
              reminderSource: "user",
              state: ["scheduled", "deferred", "delivered", "cancelled"].includes(
                item.reminder.state
              )
                ? item.reminder.state
                : "cancelled",
              deferredReason:
                typeof item.reminder.deferredReason === "string" &&
                /^[a-z0-9_]{1,128}$/u.test(item.reminder.deferredReason)
                  ? item.reminder.deferredReason
                  : null,
              deliveredAt: Number.isSafeInteger(item.reminder.deliveredAt)
                ? item.reminder.deliveredAt
                : null,
            }
          : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      revisions: limited(item.revisions, KNOWLEDGE_HISTORY_LIMIT).map((revision) => ({
        id: revision.id,
        revision: revision.revision,
        title: revision.title,
        dueText: revision.dueText,
        createdAt: revision.createdAt,
      })),
      occurrences: limited(item.occurrences, KNOWLEDGE_HISTORY_LIMIT).map((occurrence) => ({
        id: occurrence.id,
        sessionId: occurrence.sessionId,
        revisionId: occurrence.revisionId,
        startedAt: occurrence.startedAt,
        endedAt: occurrence.endedAt,
        createdAt: occurrence.createdAt,
        evidence: publicEvidence(occurrence.evidence),
      })),
      transitions: limited(item.transitions, KNOWLEDGE_HISTORY_LIMIT).map((transition) => ({
        id: transition.id,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        reason: transition.reason,
        actor: transition.actor,
        occurredAt: transition.occurredAt,
      })),
    };
  });
  const suggestions = limited(snapshot?.suggestions, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    title: item.title,
    rationale: item.rationale,
    state: item.state,
    dismissReasonCode: PUBLIC_KNOWLEDGE_DISMISS_REASONS.has(item.dismissReasonCode)
      ? item.dismissReasonCode
      : null,
    convertedTodoId: typeof item.convertedTodoId === "string" ? item.convertedTodoId : null,
    acceptanceUndone: item.acceptanceUndone === true,
    decidedAt: item.decidedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    cardContext: toPublicKnowledgeCardContext(item.cardContext),
    occurrences: limited(item.occurrences, KNOWLEDGE_HISTORY_LIMIT).map((occurrence) => ({
      id: occurrence.id,
      sessionId: occurrence.sessionId,
      createdAt: occurrence.createdAt,
      evidence: publicEvidence(occurrence.evidence),
    })),
  }));
  const conflicts = limited(snapshot?.memoryConflicts, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    episode: item.episode,
    state: item.state,
    selectedMemoryItemId: item.selectedMemoryItemId,
    resolvedAt: item.resolvedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    members: limited(item.members, KNOWLEDGE_HISTORY_LIMIT).map((member) => ({
      memoryItemId: member.memoryItemId,
      title: member.title,
      body: member.body,
      lifecycle: member.lifecycle,
      selected: member.selected === true,
    })),
  }));
  return {
    memories,
    topics,
    todos,
    suggestions,
    conflicts,
    truncated: [
      snapshot?.memories,
      snapshot?.topics,
      snapshot?.todos,
      snapshot?.suggestions,
      snapshot?.memoryConflicts,
    ].some((items) => Array.isArray(items) && items.length > KNOWLEDGE_LIST_LIMIT),
  };
}

module.exports = {
  KNOWLEDGE_LIST_LIMIT,
  KNOWLEDGE_HISTORY_LIMIT,
  KNOWLEDGE_EVIDENCE_LIMIT,
  PUBLIC_TODO_PROVENANCE,
  PUBLIC_KNOWLEDGE_SOURCE_KINDS,
  PUBLIC_KNOWLEDGE_DISMISS_REASONS,
  PUBLIC_TRUST_SNAPSHOT_STATES,
  PUBLIC_ACTIVITY_CATEGORIES,
  PUBLIC_ACTIVITY_DECISIONS,
  PUBLIC_SOURCE_ATTRIBUTIONS,
  PUBLIC_CARD_APPLICATION_NAMES,
  limited,
  toPublicKnowledgeCardContext,
  toPublicKnowledgeEvidence,
  publicEvidence,
  publicTrustConfidence,
  toPublicTodoTrustSnapshot,
  toPublicKnowledgeOverview,
};
