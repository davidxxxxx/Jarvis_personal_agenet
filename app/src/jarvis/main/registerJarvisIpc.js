const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertCaptureFailureCode,
  assertSourceType,
  assertRetentionMode,
  normalizeSpeakerConfirmationInput,
  normalizeDailyDigestDateRequest,
  normalizeDailyDigestRegenerateRequest,
  normalizeSuggestionDecisionInput,
  normalizeMemoryConflictResolutionInput,
  normalizeKnowledgeTodoCompletionInput,
  normalizeKnowledgeTodoDecisionInput,
  normalizeActivityCorrectionInput,
  normalizePersonalizationRuleDecisionInput,
  normalizeNotificationPreferencesInput,
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
  normalizeMiniMaxKeyInput,
  normalizeMiniMaxConfig,
  normalizeResourceGovernanceSettings,
  normalizeApplicationAudioSettings,
  normalizeAnalysisBudgetInput,
  normalizeAnalysisBudgetStatus,
  normalizeAnalysisStatus,
} = require("../shared/contracts");
const { normalizeCaptureStartInput } = require("../shared/captureModes");
const {
  toRendererAudioChunk,
  toRendererSession,
  toPublicSessionDetail,
  toRendererSessionTimeline,
} = require("./AudioChunkPublicView");
const path = require("node:path");

const REQUIRED_REPOSITORY_METHODS = [
  "createSession",
  "setSessionStatus",
  "getSession",
  "listSessions",
  "upsertTranscriptSegments",
  "syncTranscriptSegments",
  "listTranscriptSegments",
  "renamePerson",
  "listPeople",
  "listAudioChunks",
  "getSessionTimeline",
  "getCloudBudgetStatus",
  "setCloudBudgetSettings",
];

const REQUIRED_SERVICE_METHODS = [
  "startCapture",
  "setRetentionMode",
  "sourceInterrupted",
  "sourceRestored",
  "pauseCapture",
  "resumeCapture",
  "finishCapture",
  "failCapture",
];

const REQUIRED_SPEAKER_CORRECTION_METHODS = [
  "listSessionClusters",
  "confirm",
  "reject",
  "undo",
  "listCorrections",
  "mergePeople",
];

function assertExactKeys(input, expected, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(input).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new TypeError(`${name} has an invalid structure`);
  }
}

function normalizeTimelinePage(input) {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("session timeline page must be an object");
  }
  const allowed = new Set(["trackOffset", "trackLimit", "intervalOffset", "intervalLimit"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("session timeline page has an invalid structure");
  }
  const page = {};
  for (const key of allowed) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError(`session timeline ${key} must be a non-negative safe integer`);
    }
    page[key] = input[key];
  }
  return page;
}

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

function toPublicNotificationPreferences(entry) {
  return {
    focusMode: entry?.focusMode === true,
    mutedUntil: Number.isSafeInteger(entry?.mutedUntil) ? entry.mutedUntil : null,
    updatedAt: Number.isSafeInteger(entry?.updatedAt) ? entry.updatedAt : 0,
    effectiveMuted: entry?.effectiveMuted === true,
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

function assertLifecycleTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("source lifecycle at must be a non-negative safe integer");
  }
  return value;
}

function assertLifecycleString(value, name, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new TypeError(`${name} must be non-empty and at most ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeSourceInterruption(input) {
  assertExactKeys(input, ["at", "reason"], "source interruption");
  return {
    at: assertLifecycleTime(input.at),
    reason: assertLifecycleString(input.reason, "source interruption reason", 128),
  };
}

function normalizeSourceRestoration(input) {
  assertExactKeys(input, ["at", "deviceId", "deviceLabel", "strategy"], "source restoration");
  return {
    at: assertLifecycleTime(input.at),
    deviceId: assertLifecycleString(input.deviceId, "source deviceId", 512, {
      nullable: true,
    }),
    deviceLabel: assertLifecycleString(input.deviceLabel, "source deviceLabel", 512, {
      nullable: true,
    }),
    strategy: assertLifecycleString(input.strategy, "source strategy", 128, {
      nullable: true,
    }),
  };
}

function unavailableProcessingStatus() {
  return {
    pending: 0,
    running: 0,
    retry: 0,
    blocked: 0,
    total: 0,
    byStage: {},
    deferrals: [],
    backlogMs: 0,
    oldestCreatedAt: null,
    activeExecutionDevice: null,
    finalCoveragePct: null,
    provisionalCoveragePct: null,
  };
}

function nextRecoveryAction({ capture, resources, queue, disk }) {
  if (disk.state === "critical" || disk.state === "stopped") return "free_disk";
  if (capture.status === "degraded") return "restore_microphone";
  if (capture.status === "failed") {
    return typeof capture.errorCode === "string" && capture.errorCode.startsWith("MIC_")
      ? "restore_microphone"
      : "retry_jobs";
  }
  const deferralReasons = new Set(queue.deferrals.map(({ reason }) => reason));
  if (deferralReasons.has("external_gpu_busy")) return "wait_for_gpu";
  if (queue.deferrals.length > 0) return "retry_jobs";
  if (resources.state === "busy") return "wait_for_gpu";
  if (resources.state === "unavailable") return "check_cuda";
  if (queue.blocked > 0 || queue.retry > 0) return "retry_jobs";
  return null;
}

function toPublicDailyDigestContent(content) {
  const factual = (items) =>
    (Array.isArray(items) ? items : []).map((item) => ({
      text: item.text,
      evidenceSegmentIds: [...item.evidenceSegmentIds],
    }));
  return {
    schemaVersion: content.schemaVersion,
    sections: {
      today: factual(content.sections.today),
      interactions: content.sections.interactions.map((item) => ({
        subjectRef: item.subjectRef,
        text: item.text,
        evidenceSegmentIds: [...item.evidenceSegmentIds],
      })),
      topicsAndDecisions: factual(content.sections.topicsAndDecisions),
      commitmentsAndTodos: factual(content.sections.commitmentsAndTodos),
      worthRemembering: factual(content.sections.worthRemembering),
      tomorrowSuggestions: content.sections.tomorrowSuggestions.map((item) => ({
        text: item.text,
        rationale: item.rationale,
        evidenceSegmentIds: [...item.evidenceSegmentIds],
        allowedActions: [...item.allowedActions],
      })),
    },
    processing: {
      completeness: content.processing.completeness,
      missingStages: [...content.processing.missingStages],
      transcriptCoverage: {
        selectedSegmentCount: content.processing.transcriptCoverage.selectedSegmentCount,
        incompleteSegmentCount: content.processing.transcriptCoverage.incompleteSegmentCount,
        sessionCount: content.processing.transcriptCoverage.sessionCount,
        startsAt: content.processing.transcriptCoverage.startsAt,
        endsAt: content.processing.transcriptCoverage.endsAt,
      },
    },
  };
}

function toPublicDailyDigest(digest) {
  if (!digest) return null;
  return {
    localDate: digest.localDate,
    revision: digest.revision,
    completeness: digest.completeness,
    content: toPublicDailyDigestContent(digest.content),
    evidence: digest.evidence.map((entry) => ({
      sessionId: entry.sessionId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      quote: entry.quote,
      audioState: entry.audioState,
      handle: normalizeEvidenceContextRequest(entry.handle),
    })),
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
  };
}

function toPublicDailyDigestStatus(status) {
  const states = new Set([
    "not_generated",
    "empty",
    "queued",
    "running",
    "retry_needed",
    "ready",
    "blocked",
  ]);
  const errorCodes = new Set([
    "offline",
    "budget_unavailable",
    "usage_unknown",
    "invalid_response",
    "runtime_unavailable",
    "generation_failed",
  ]);
  if (!status || !states.has(status.state)) {
    return {
      state: "blocked",
      retryable: false,
      errorCode: "generation_failed",
      nextRetryAt: null,
      attemptCount: 0,
    };
  }
  return {
    state: status.state,
    retryable: status.retryable === true,
    errorCode: errorCodes.has(status.errorCode) ? status.errorCode : null,
    nextRetryAt: Number.isSafeInteger(status.nextRetryAt) ? status.nextRetryAt : null,
    attemptCount:
      Number.isSafeInteger(status.attemptCount) && status.attemptCount >= 0
        ? status.attemptCount
        : 0,
  };
}

const KNOWLEDGE_LIST_LIMIT = 100;
const KNOWLEDGE_HISTORY_LIMIT = 20;
const KNOWLEDGE_EVIDENCE_LIMIT = 8;
const PUBLIC_TODO_PROVENANCE = new Set([
  "evidence_linked",
  "legacy_unverified",
  "suggestion",
  "source_deleted",
]);

function limited(items, limit) {
  return (Array.isArray(items) ? items : []).slice(0, limit);
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
  const todos = limited(snapshot?.todos, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    title: item.title,
    ownerLabel: item.ownerLabel,
    status: item.status,
    completedAt: item.completedAt,
    dismissedAt: item.dismissedAt,
    verificationState: item.verificationState,
    verificationReason: item.verificationReason,
    verificationActor: item.verificationActor,
    provenance: PUBLIC_TODO_PROVENANCE.has(item.provenance)
      ? item.provenance
      : "legacy_unverified",
    sourceSuggestionId: item.sourceSuggestionId,
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
  }));
  const suggestions = limited(snapshot?.suggestions, KNOWLEDGE_LIST_LIMIT).map((item) => ({
    id: item.id,
    title: item.title,
    rationale: item.rationale,
    state: item.state,
    decidedAt: item.decidedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
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

function publicBoundaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toPublicResourceGovernanceSettings(input) {
  return normalizeResourceGovernanceSettings({
    profile: input?.profile,
    externalGpuThresholdPct: input?.externalGpuThresholdPct,
    recoveryWaitMs: input?.recoveryWaitMs,
  });
}

function assertApplicationKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9._-]{1,64}$/.test(value)) {
    throw new TypeError("application audio key is invalid");
  }
  return value;
}

function assertApplicationDisplayName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value.trim()).length > 80 ||
    /[\\/:]/u.test(value)
  ) {
    throw new TypeError("application audio display name is invalid");
  }
  return value.trim();
}

function toPublicApplicationAudioStatus(input) {
  const settings = normalizeApplicationAudioSettings({
    enabled: input?.enabled,
    trackLimit: input?.trackLimit,
  });
  const runtime = input?.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("application audio runtime status is required");
  }
  const activeTracks = Array.isArray(runtime.activeTracks) ? runtime.activeTracks : [];
  const fallbacks = Array.isArray(runtime.fallbacks) ? runtime.fallbacks : [];
  const boundedInteger = (value, name, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} is invalid`);
    }
    return value;
  };
  return {
    ...settings,
    runtime: {
      running: runtime.running === true,
      configuredLimit: boundedInteger(runtime.configuredLimit, "configuredLimit", 1, 8),
      effectiveLimit: boundedInteger(runtime.effectiveLimit, "effectiveLimit", 1, 8),
      fullscreen: runtime.fullscreen === true,
      activeTracks: activeTracks.slice(0, 8).map((track) => ({
        applicationKey: assertApplicationKey(track?.applicationKey),
        applicationDisplayName: assertApplicationDisplayName(track?.applicationDisplayName),
        captureGeneration: boundedInteger(
          track?.captureGeneration,
          "captureGeneration",
          1,
          Number.MAX_SAFE_INTEGER
        ),
        state: "recording",
      })),
      fallbacks: fallbacks.slice(0, 256).map((fallback) => ({
        applicationKey: assertApplicationKey(fallback?.applicationKey),
        applicationDisplayName: assertApplicationDisplayName(fallback?.applicationDisplayName),
        reason:
          typeof fallback?.reason === "string" && /^[a-z0-9_-]{1,64}$/i.test(fallback.reason)
            ? fallback.reason
            : "application_capture_unavailable",
        retryAt:
          Number.isSafeInteger(fallback?.retryAt) && fallback.retryAt >= 0
            ? fallback.retryAt
            : null,
        state: "mixed_unknown",
      })),
    },
  };
}

function safePublicCall(operation, normalize, code, message) {
  try {
    return normalize(operation());
  } catch {
    throw publicBoundaryError(code, message);
  }
}

async function safePublicCallAsync(operation, normalize, code, message) {
  try {
    return normalize(await operation());
  } catch {
    throw publicBoundaryError(code, message);
  }
}

function registerJarvisIpc({
  ipcMain,
  repository,
  service,
  speakerCorrectionService,
  voiceEnrollmentService,
  environmentManager,
  analysisScheduler,
  analysisBudgetGuard = null,
  resourceSettings = null,
  applicationAudioSettings = null,
  dailyDigestScheduler = null,
  audioEvidenceReader,
  storageManager,
  pickStorageDirectory,
  processingLifecycle = null,
  now = Date.now,
}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("ipcMain with a handle method is required");
  }
  if (!repository || typeof repository !== "object") {
    throw new TypeError("repository is required");
  }
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
  if (!service || typeof service !== "object") {
    throw new TypeError("service is required");
  }
  for (const method of REQUIRED_SERVICE_METHODS) {
    if (typeof service[method] !== "function") {
      throw new TypeError(`service.${method} must be a function`);
    }
  }
  for (const method of REQUIRED_SPEAKER_CORRECTION_METHODS) {
    if (!speakerCorrectionService || typeof speakerCorrectionService[method] !== "function") {
      throw new TypeError(`speakerCorrectionService.${method} must be a function`);
    }
  }
  for (const method of ["getStatus", "begin", "complete", "cancel", "cancelOwner"]) {
    if (!voiceEnrollmentService || typeof voiceEnrollmentService[method] !== "function") {
      throw new TypeError(`voiceEnrollmentService.${method} must be a function`);
    }
  }
  if (!environmentManager || typeof environmentManager.getOpenAIKey !== "function") {
    throw new TypeError("environmentManager.getOpenAIKey must be a function");
  }
  if (
    dailyDigestScheduler !== null &&
    (typeof dailyDigestScheduler.getLatest !== "function" ||
      typeof dailyDigestScheduler.getPublicStatus !== "function" ||
      typeof dailyDigestScheduler.regenerate !== "function")
  ) {
    throw new TypeError("dailyDigestScheduler public methods are required");
  }
  if (
    analysisBudgetGuard !== null &&
    (typeof analysisBudgetGuard.getStatus !== "function" ||
      typeof analysisBudgetGuard.setPolicy !== "function")
  ) {
    throw new TypeError("analysisBudgetGuard public methods are required");
  }
  if (
    resourceSettings !== null &&
    (typeof resourceSettings.getStatus !== "function" ||
      typeof resourceSettings.setPolicy !== "function")
  ) {
    throw new TypeError("resourceSettings public methods are required");
  }
  if (
    applicationAudioSettings !== null &&
    (typeof applicationAudioSettings.getStatus !== "function" ||
      typeof applicationAudioSettings.setPolicy !== "function")
  ) {
    throw new TypeError("applicationAudioSettings public methods are required");
  }

  const cloudBudgetStatus = () => ({
    ...repository.getCloudBudgetStatus(),
    keyConfigured: Boolean(environmentManager.getOpenAIKey()),
  });

  const enrollmentOwnerListeners = new WeakSet();
  const bindEnrollmentOwner = (event) => {
    const sender = event?.sender;
    if (!sender || typeof sender !== "object" || enrollmentOwnerListeners.has(sender)) return;
    if (typeof sender.once !== "function") return;
    const ownerId = sender.id;
    enrollmentOwnerListeners.add(sender);
    sender.once("destroyed", () => {
      try {
        voiceEnrollmentService.cancelOwner(ownerId);
      } catch {
        // Renderer destruction cleanup is best-effort and must not escape Electron's event loop.
      }
    });
  };

  ipcMain.handle(CHANNELS.createSession, (_event, input) =>
    toRendererSession(repository.createSession(input))
  );
  ipcMain.handle(CHANNELS.setSessionStatus, (_event, id, status, at) =>
    repository.setSessionStatus(assertId(id, "sessionId"), assertSessionStatus(status), at)
  );
  ipcMain.handle(CHANNELS.getSession, (_event, id) =>
    toRendererSession(repository.getSession(assertId(id, "sessionId")))
  );
  ipcMain.handle(CHANNELS.listSessions, (_event, query) =>
    repository.listSessions(query).map(toRendererSession)
  );
  ipcMain.handle(CHANNELS.upsertSegments, (_event, sessionId, segments) =>
    repository.upsertTranscriptSegments(assertId(sessionId, "sessionId"), segments)
  );
  ipcMain.handle(CHANNELS.syncSegments, (_event, sessionId, segments) =>
    repository.syncTranscriptSegments(assertId(sessionId, "sessionId"), segments)
  );
  ipcMain.handle(CHANNELS.listSegments, (_event, sessionId) =>
    repository.listTranscriptSegments(assertId(sessionId, "sessionId"))
  );
  ipcMain.handle(CHANNELS.listActivityClassifications, (_event, ...args) => {
    if (args.length !== 1) {
      throw new TypeError("activity classification request requires one sessionId");
    }
    if (typeof repository.listSessionActivityClassifications !== "function") {
      throw new Error("Activity classification is unavailable");
    }
    return repository
      .listSessionActivityClassifications(assertId(args[0], "sessionId"))
      .map(toPublicActivityClassification);
  });
  if (
    typeof repository.correctActivityClassification === "function" &&
    typeof repository.listPersonalizationRules === "function" &&
    typeof repository.decidePersonalizationRule === "function" &&
    typeof repository.resetPersonalizationRules === "function" &&
    typeof repository.getNotificationPreferences === "function" &&
    typeof repository.setNotificationPreferences === "function"
  ) {
    ipcMain.handle(CHANNELS.correctActivityClassification, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("activity correction requires one argument");
      const input = normalizeActivityCorrectionInput(args[0]);
      const result = repository.correctActivityClassification({ ...input, correctedAt: now() });
      return {
        classification: toPublicActivityClassification(result.classification),
        proposedRule: result.proposedRule
          ? toPublicPersonalizationRule(result.proposedRule)
          : null,
        supportCount: result.supportCount,
      };
    });
    ipcMain.handle(CHANNELS.getPersonalizationSettings, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("personalization settings take no arguments");
      return {
        rules: repository.listPersonalizationRules().map(toPublicPersonalizationRule),
        notifications: toPublicNotificationPreferences(
          repository.getNotificationPreferences()
        ),
      };
    });
    ipcMain.handle(CHANNELS.decidePersonalizationRule, (_event, ...args) => {
      if (args.length !== 1)
        throw new TypeError("personalization rule decision requires one argument");
      const input = normalizePersonalizationRuleDecisionInput(args[0]);
      return toPublicPersonalizationRule(
        repository.decidePersonalizationRule({ ...input, at: now() })
      );
    });
    ipcMain.handle(CHANNELS.resetPersonalizationRules, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("personalization reset takes no arguments");
      return repository.resetPersonalizationRules({ at: now() });
    });
    ipcMain.handle(CHANNELS.setNotificationPreferences, (_event, ...args) => {
      if (args.length !== 1)
        throw new TypeError("notification preferences require one argument");
      const input = normalizeNotificationPreferencesInput(args[0]);
      return toPublicNotificationPreferences(
        repository.setNotificationPreferences({ ...input, at: now() })
      );
    });
  }
  ipcMain.handle(CHANNELS.renamePerson, (_event, input) => repository.renamePerson(input));
  ipcMain.handle(CHANNELS.listPeople, () => repository.listPeople());
  ipcMain.handle(CHANNELS.listSessionSpeakerClusters, (_event, sessionId) =>
    speakerCorrectionService.listSessionClusters(assertId(sessionId, "sessionId"))
  );
  ipcMain.handle(CHANNELS.confirmSpeaker, (_event, input) => {
    const normalized = normalizeSpeakerConfirmationInput(input);
    try {
      return Promise.resolve(speakerCorrectionService.confirm(normalized)).catch(
        toPublicAmbiguousSpeakerFailure
      );
    } catch (error) {
      return toPublicAmbiguousSpeakerFailure(error);
    }
  });
  ipcMain.handle(CHANNELS.rejectSpeaker, (_event, clusterId, personId) =>
    speakerCorrectionService.reject(
      assertId(clusterId, "clusterId"),
      assertId(personId, "personId")
    )
  );
  ipcMain.handle(CHANNELS.undoSpeakerCorrection, (_event, clusterId) =>
    speakerCorrectionService.undo(assertId(clusterId, "clusterId"))
  );
  ipcMain.handle(CHANNELS.listSpeakerCorrections, (_event, clusterId) =>
    speakerCorrectionService.listCorrections(assertId(clusterId, "clusterId"))
  );
  ipcMain.handle(CHANNELS.mergePeople, (_event, sourcePersonId, targetPersonId) => {
    const sourceId = assertId(sourcePersonId, "sourcePersonId");
    const targetId = assertId(targetPersonId, "targetPersonId");
    if (sourceId === targetId) throw new TypeError("source and target people must be different");
    return speakerCorrectionService.mergePeople(sourceId, targetId);
  });
  ipcMain.handle(CHANNELS.listAudioChunks, (_event, sessionId) =>
    repository.listAudioChunks(assertId(sessionId, "sessionId")).map(toRendererAudioChunk)
  );
  ipcMain.handle(CHANNELS.readAudioChunk, async (_event, audioChunkId) => {
    const chunk = repository.getAudioChunk(assertId(audioChunkId, "audioChunkId"));
    if (!chunk || chunk.deleted_at != null) return null;
    try {
      const currentReader = service.audioEvidenceReader ?? audioEvidenceReader;
      if (!currentReader || typeof currentReader.readPlayableWav !== "function") {
        throw new Error("verified audio reader is unavailable");
      }
      return await currentReader.readPlayableWav(chunk);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle(CHANNELS.getSessionDetail, (_event, sessionId) =>
    toPublicSessionDetail(
      repository.getSessionDetail(assertId(sessionId, "sessionId"), {
        // Memory playback uses the paged timeline as its single audio-chunk source.
        // Avoid serializing the same potentially thousands-long chunk list twice.
        includeAudioChunks: false,
      })
    )
  );
  ipcMain.handle(CHANNELS.getSessionTimeline, (_event, sessionId, page) => {
    const timeline = repository.getSessionTimeline(
      assertId(sessionId, "sessionId"),
      normalizeTimelinePage(page)
    );
    if (!timeline) return null;
    const activeCapture = typeof service.getState === "function" ? service.getState() : null;
    const activelyRecording =
      activeCapture?.status === "recording" || activeCapture?.status === "degraded";
    const previewStatus =
      timeline.status === "recording" &&
      activelyRecording &&
      activeCapture.sessionId === timeline.session_id
        ? (processingLifecycle?.runtime?.previewStatus?.() ?? null)
        : null;
    return toRendererSessionTimeline(timeline, previewStatus);
  });
  ipcMain.handle(CHANNELS.getSessionTimelineStatus, (_event, sessionId) => {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof repository.getSessionTimelineStatus === "function") {
      return toRendererSessionTimelineStatus(repository.getSessionTimelineStatus(safeSessionId));
    }
    const timeline = repository.getSessionTimeline(safeSessionId);
    if (!timeline) return null;
    return toRendererSessionTimelineStatus({
      session_id: timeline.session_id,
      status: timeline.status,
      processing_state: timeline.processing_state,
      timeline_version: timeline.timeline_version,
      finalized_at: timeline.finalized_at,
      ready_at: timeline.ready_at,
      processing_counts: timeline.processing_counts,
    });
  });
  ipcMain.handle(CHANNELS.getRuntimeStatus, async () => {
    const observedAt = now();
    const captureState = typeof service.getState === "function" ? service.getState() : null;
    const capture = {
      sessionId: captureState?.sessionId ?? null,
      status: captureState?.status ?? "idle",
      captureMode: captureState?.captureMode ?? null,
      retentionMode: captureState?.retentionMode ?? null,
      errorCode: captureState?.errorCode ?? null,
    };
    const runtime = processingLifecycle?.runtime ?? null;
    const preview = runtime?.previewStatus?.() ?? null;
    const resourceSnapshot = runtime?.governor?.latestSnapshot ?? null;
    const resources = resourceSnapshot
      ? {
          sampledAt: resourceSnapshot.sampledAt ?? null,
          state: resourceSnapshot.state ?? "unavailable",
          reason: resourceSnapshot.reason ?? "unknown",
          cudaInstalled: resourceSnapshot.cudaInstalled === true,
          cudaVerified: resourceSnapshot.cudaVerified === true,
          cudaQuarantined: resourceSnapshot.cudaQuarantined === true,
        }
      : {
          sampledAt: null,
          state: "unavailable",
          reason: "not_sampled",
          cudaInstalled: null,
          cudaVerified: null,
          cudaQuarantined: null,
        };
    const processing =
      typeof repository.getRuntimeProcessingStatus === "function"
        ? repository.getRuntimeProcessingStatus(observedAt)
        : unavailableProcessingStatus();
    const queue = {
      pending: processing.pending,
      running: processing.running,
      retry: processing.retry,
      blocked: processing.blocked,
      total: processing.total,
      byStage: processing.byStage,
      deferrals: processing.deferrals ?? [],
      backlogMinutes: processing.backlogMs / 60_000,
      oldestJobAgeMs:
        processing.oldestCreatedAt === null
          ? null
          : Math.max(0, observedAt - processing.oldestCreatedAt),
      finalCoveragePct: processing.finalCoveragePct,
      provisionalCoveragePct: processing.provisionalCoveragePct,
    };
    const storage =
      storageManager && typeof storageManager.getStatus === "function"
        ? await storageManager.getStatus()
        : null;
    const disk = {
      state: storage?.state ?? "unavailable",
      freeBytes: storage?.freeBytes ?? null,
      remainingDays: storage?.remainingDays ?? null,
      recoveryAction: storage?.recoveryAction ?? null,
    };
    const backend = {
      actualBackend:
        preview?.running > 0 && preview.executionDevice
          ? preview.executionDevice
          : (processing.activeExecutionDevice ?? null),
      cudaGpuUuid:
        resourceSnapshot?.cudaVerified === true ? (resourceSnapshot.selectedGpuUuid ?? null) : null,
    };
    return {
      observedAt,
      capture,
      backend,
      resources,
      queue,
      preview,
      disk,
      nextRecoveryAction: nextRecoveryAction({ capture, resources, queue, disk }),
    };
  });
  ipcMain.handle(CHANNELS.searchMemory, (_event, query, limit) => {
    if (typeof query !== "string") throw new TypeError("query must be a string");
    const sessions = query.trim()
      ? repository.searchMemory(query, limit)
      : repository.listSessions({ limit: limit ?? 100 });
    return sessions.map(toRendererSession);
  });
  ipcMain.handle(CHANNELS.listPeopleOverview, () => repository.listPeopleOverview());
  ipcMain.handle(CHANNELS.getPersonDetail, (_event, personId) =>
    repository.getPersonDetail(assertId(personId, "personId"))
  );
  ipcMain.handle(CHANNELS.listTopics, () => repository.listTopics());
  ipcMain.handle(CHANNELS.getTopicDetail, (_event, topicId) =>
    repository.getTopicDetail(assertId(topicId, "topicId"))
  );
  ipcMain.handle(CHANNELS.renameTopic, (_event, topicId, title) =>
    repository.renameTopic(assertId(topicId, "topicId"), title)
  );
  ipcMain.handle(CHANNELS.listTodos, (_event, status) => repository.listTodos(status ?? null));
  ipcMain.handle(CHANNELS.setTodoStatus, (_event, todoId, status) => {
    if (status !== "open" && status !== "completed") throw new TypeError("invalid todo status");
    return repository.setTodoStatus(assertId(todoId, "todoId"), status);
  });
  ipcMain.handle(CHANNELS.listMemories, (_event, limit) => repository.listMemories(limit ?? 200));
  ipcMain.handle(CHANNELS.getTodayInsights, (_event, sessionId) =>
    repository.getTodayInsights(assertId(sessionId, "sessionId"))
  );
  if (repository.memoryRepository) {
    const currentKnowledgeRepository = () => {
      const memoryRepository = repository.memoryRepository;
      for (const method of [
        "readPublicSnapshot",
        "acceptSuggestion",
        "dismissSuggestion",
        "resolveMemoryConflict",
        "completeTodo",
        "decideTodo",
        "getEvidenceContext",
      ]) {
        if (!memoryRepository || typeof memoryRepository[method] !== "function") {
          throw new Error("Knowledge repository is unavailable");
        }
      }
      return memoryRepository;
    };
    ipcMain.handle(CHANNELS.getKnowledgeOverview, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("knowledge overview takes no arguments");
      const overview = toPublicKnowledgeOverview(
        currentKnowledgeRepository().readPublicSnapshot()
      );
      if (typeof repository.getSuggestionPersonalizationPenalty === "function") {
        overview.suggestions.sort(
          (left, right) =>
            repository.getSuggestionPersonalizationPenalty(left.title) -
              repository.getSuggestionPersonalizationPenalty(right.title) ||
            right.createdAt - left.createdAt ||
            left.id.localeCompare(right.id)
        );
      }
      return overview;
    });
    ipcMain.handle(CHANNELS.decideKnowledgeSuggestion, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("suggestion decision requires one argument");
      const input = normalizeSuggestionDecisionInput(args[0]);
      const suggestion =
        input.action === "dismiss"
          ? currentKnowledgeRepository()
              .readPublicSnapshot()
              .suggestions?.find((entry) => entry.id === input.suggestionId)
          : null;
      const result = currentKnowledgeRepository()[
        input.action === "accept" ? "acceptSuggestion" : "dismissSuggestion"
      ]({ suggestionId: input.suggestionId, at: now() });
      if (
        input.action === "dismiss" &&
        result.status === "dismissed" &&
        suggestion &&
        typeof repository.recordSuggestionDismissalFeedback === "function"
      ) {
        try {
          repository.recordSuggestionDismissalFeedback({
            suggestionId: input.suggestionId,
            summary:
              suggestion.title ??
              suggestion.summary ??
              suggestion.text ??
              input.suggestionId,
            occurredAt: now(),
          });
        } catch {
          // Local learning is best-effort and must never block the user's dismissal.
        }
      }
      return {
        status: result.status,
        suggestionId: result.suggestionId,
        decidedAt: result.decidedAt,
        todoId: result.todoId,
      };
    });
    ipcMain.handle(CHANNELS.resolveKnowledgeConflict, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("conflict resolution requires one argument");
      const input = normalizeMemoryConflictResolutionInput(args[0]);
      const result = currentKnowledgeRepository().resolveMemoryConflict(input);
      return {
        status: result.status,
        conflictGroupId: result.conflictGroupId,
        selectedMemoryItemId: result.selectedMemoryItemId,
      };
    });
    ipcMain.handle(CHANNELS.completeKnowledgeTodo, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("todo completion requires one argument");
      const input = normalizeKnowledgeTodoCompletionInput(args[0]);
      const result = currentKnowledgeRepository().completeTodo(input);
      return {
        status: result.status,
        todoId: result.todoId,
        completedAt: result.completedAt,
      };
    });
    ipcMain.handle(CHANNELS.decideKnowledgeTodo, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("todo decision requires one argument");
      const input = normalizeKnowledgeTodoDecisionInput(args[0]);
      return currentKnowledgeRepository().decideTodo(input);
    });
    ipcMain.handle(CHANNELS.getEvidenceContext, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("evidence context requires one argument");
      const input = normalizeEvidenceContextRequest(args[0]);
      try {
        return normalizeEvidenceContextResponse(
          currentKnowledgeRepository().getEvidenceContext(input)
        );
      } catch {
        const error = new Error("Evidence context is unavailable");
        error.code = "EVIDENCE_CONTEXT_UNAVAILABLE";
        throw error;
      }
    });
  }
  if (dailyDigestScheduler) {
    ipcMain.handle(CHANNELS.getDailyDigest, async (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("daily digest request requires one argument");
      const input = normalizeDailyDigestDateRequest(args[0]);
      const digest = await Promise.resolve(dailyDigestScheduler.getLatest(input));
      const status = await Promise.resolve(dailyDigestScheduler.getPublicStatus(input));
      return { digest: toPublicDailyDigest(digest), status: toPublicDailyDigestStatus(status) };
    });
    ipcMain.handle(CHANNELS.regenerateDailyDigest, async (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("daily digest request requires one argument");
      const input = normalizeDailyDigestRegenerateRequest(args[0]);
      await Promise.resolve(dailyDigestScheduler.regenerate(input));
      return toPublicDailyDigestStatus(
        await Promise.resolve(dailyDigestScheduler.getPublicStatus(input))
      );
    });
  }
  if (analysisScheduler) {
    ipcMain.handle(CHANNELS.analyzeSession, async (_event, ...args) => {
      if (args.length < 1 || args.length > 2) {
        throw new TypeError("analysis request requires sessionId and optional kind");
      }
      const sessionId = assertId(args[0], "sessionId");
      const kind = args[1] ?? "incremental";
      if (kind !== "incremental" && kind !== "final") {
        throw new TypeError("invalid analysis kind");
      }
      const allowUsageUnknown =
        kind === "final" && analysisBudgetGuard?.getStatus?.({})?.mode === "unlimited";
      return safePublicCallAsync(
        () =>
          analysisScheduler.analyzeSession(sessionId, kind, {
            manual: true,
            allowUsageUnknown,
          }),
        normalizeAnalysisStatus,
        "ANALYSIS_STATUS_UNAVAILABLE",
        "Analysis status is unavailable"
      );
    });
    ipcMain.handle(CHANNELS.getAnalysisStatus, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("analysis status requires sessionId");
      const sessionId = assertId(args[0], "sessionId");
      return safePublicCall(
        () => analysisScheduler.getStatus(sessionId),
        normalizeAnalysisStatus,
        "ANALYSIS_STATUS_UNAVAILABLE",
        "Analysis status is unavailable"
      );
    });
  }
  if (analysisBudgetGuard) {
    ipcMain.handle(CHANNELS.getAnalysisBudget, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("analysis budget status takes no arguments");
      return safePublicCall(
        () => analysisBudgetGuard.getStatus({}),
        normalizeAnalysisBudgetStatus,
        "ANALYSIS_BUDGET_UNAVAILABLE",
        "Analysis budget is unavailable"
      );
    });
    ipcMain.handle(CHANNELS.setAnalysisBudget, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("analysis budget update requires one argument");
      const input = normalizeAnalysisBudgetInput(args[0]);
      return safePublicCall(
        () => analysisBudgetGuard.setPolicy(input),
        normalizeAnalysisBudgetStatus,
        "ANALYSIS_BUDGET_UNAVAILABLE",
        "Analysis budget is unavailable"
      );
    });
  }
  if (resourceSettings) {
    ipcMain.handle(CHANNELS.getResourceGovernance, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("resource governance status takes no arguments");
      return safePublicCall(
        () => resourceSettings.getStatus(),
        toPublicResourceGovernanceSettings,
        "RESOURCE_GOVERNANCE_UNAVAILABLE",
        "Resource governance settings are unavailable"
      );
    });
    ipcMain.handle(CHANNELS.setResourceGovernance, (_event, ...args) => {
      if (args.length !== 1)
        throw new TypeError("resource governance update requires one argument");
      const input = normalizeResourceGovernanceSettings(args[0]);
      return safePublicCallAsync(
        () => resourceSettings.setPolicy(input),
        toPublicResourceGovernanceSettings,
        "RESOURCE_GOVERNANCE_UNAVAILABLE",
        "Resource governance settings are unavailable"
      );
    });
  }
  if (applicationAudioSettings) {
    ipcMain.handle(CHANNELS.getApplicationAudioSettings, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("application audio status takes no arguments");
      return safePublicCall(
        () => applicationAudioSettings.getStatus(),
        toPublicApplicationAudioStatus,
        "APPLICATION_AUDIO_SETTINGS_UNAVAILABLE",
        "Application audio settings are unavailable"
      );
    });
    ipcMain.handle(CHANNELS.setApplicationAudioSettings, (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("application audio update requires one argument");
      const input = normalizeApplicationAudioSettings(args[0]);
      return safePublicCallAsync(
        () => applicationAudioSettings.setPolicy(input),
        toPublicApplicationAudioStatus,
        "APPLICATION_AUDIO_SETTINGS_UNAVAILABLE",
        "Application audio settings are unavailable"
      );
    });
  }
  if (
    typeof environmentManager.getMiniMaxKey === "function" &&
    typeof environmentManager.saveMiniMaxKey === "function" &&
    typeof environmentManager.clearMiniMaxKey === "function"
  ) {
    const miniMaxConfig = () =>
      normalizeMiniMaxConfig({
        keyConfigured: Boolean(environmentManager.getMiniMaxKey()),
        model: "MiniMax-M2.7",
      });
    ipcMain.handle(CHANNELS.getMiniMaxConfig, (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("MiniMax config takes no arguments");
      return safePublicCall(
        miniMaxConfig,
        normalizeMiniMaxConfig,
        "MINIMAX_SETTINGS_UNAVAILABLE",
        "MiniMax settings are unavailable"
      );
    });
    ipcMain.handle(CHANNELS.setMiniMaxKey, async (_event, ...args) => {
      if (args.length !== 1) throw new TypeError("MiniMax key update requires one argument");
      const { key } = normalizeMiniMaxKeyInput(args[0]);
      return safePublicCallAsync(
        async () => {
          await environmentManager.saveMiniMaxKey(key);
          return miniMaxConfig();
        },
        normalizeMiniMaxConfig,
        "MINIMAX_SETTINGS_UNAVAILABLE",
        "MiniMax settings are unavailable"
      );
    });
    ipcMain.handle(CHANNELS.clearMiniMaxKey, async (_event, ...args) => {
      if (args.length !== 0) throw new TypeError("MiniMax key clear takes no arguments");
      return safePublicCallAsync(
        async () => {
          await environmentManager.clearMiniMaxKey();
          return miniMaxConfig();
        },
        normalizeMiniMaxConfig,
        "MINIMAX_SETTINGS_UNAVAILABLE",
        "MiniMax settings are unavailable"
      );
    });
  }
  ipcMain.handle(CHANNELS.startCapture, (_event, input) =>
    service.startCapture(normalizeCaptureStartInput(input))
  );
  ipcMain.handle(CHANNELS.setRetentionMode, (_event, id, retentionMode, at) =>
    service.setRetentionMode(assertId(id, "sessionId"), assertRetentionMode(retentionMode), at)
  );
  ipcMain.handle(CHANNELS.sourceInterrupted, (_event, id, sourceType, input) =>
    service.sourceInterrupted(
      assertId(id, "sessionId"),
      assertSourceType(sourceType),
      normalizeSourceInterruption(input)
    )
  );
  ipcMain.handle(CHANNELS.sourceRestored, (_event, id, sourceType, input) =>
    service.sourceRestored(
      assertId(id, "sessionId"),
      assertSourceType(sourceType),
      normalizeSourceRestoration(input)
    )
  );
  ipcMain.handle(CHANNELS.pauseCapture, (_event, id, at, errorCode) =>
    service.pauseCapture(assertId(id, "sessionId"), at, errorCode)
  );
  ipcMain.handle(CHANNELS.resumeCapture, (_event, id, at) =>
    service.resumeCapture(assertId(id, "sessionId"), at)
  );
  ipcMain.handle(CHANNELS.finishCapture, (_event, id, at) =>
    service.finishCapture(assertId(id, "sessionId"), at)
  );
  ipcMain.handle(CHANNELS.failCapture, (_event, id, errorCode, at) =>
    service.failCapture(assertId(id, "sessionId"), assertCaptureFailureCode(errorCode), at)
  );
  ipcMain.handle(CHANNELS.beginVoiceEnrollment, (event) => {
    bindEnrollmentOwner(event);
    return voiceEnrollmentService.begin({ ownerId: event?.sender?.id });
  });
  ipcMain.handle(CHANNELS.getVoiceEnrollmentStatus, () => voiceEnrollmentService.getStatus());
  ipcMain.handle(CHANNELS.completeVoiceEnrollment, (event, sessionId, payload) =>
    voiceEnrollmentService.complete({ ownerId: event?.sender?.id, sessionId, payload })
  );
  ipcMain.handle(CHANNELS.cancelVoiceEnrollment, (event, sessionId) =>
    voiceEnrollmentService.cancel({ ownerId: event?.sender?.id, sessionId })
  );
  ipcMain.handle(CHANNELS.getCloudBudget, cloudBudgetStatus);
  ipcMain.handle(CHANNELS.setCloudBudget, (_event, input) => {
    if (!input || typeof input !== "object") throw new TypeError("cloud budget input is required");
    if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    if (
      !Number.isSafeInteger(input.monthlyLimitMicrousd) ||
      input.monthlyLimitMicrousd < 5_000_000 ||
      input.monthlyLimitMicrousd > 10_000_000
    ) {
      throw new RangeError("monthlyLimitMicrousd must be between 5000000 and 10000000");
    }
    repository.setCloudBudgetSettings({
      enabled: input.enabled,
      monthlyLimitMicrousd: input.monthlyLimitMicrousd,
    });
    return cloudBudgetStatus();
  });
  if (storageManager !== undefined) {
    if (
      !storageManager ||
      typeof storageManager.getStatus !== "function" ||
      typeof storageManager.migrate !== "function"
    ) {
      throw new TypeError("storageManager must provide getStatus and migrate methods");
    }
    if (typeof pickStorageDirectory !== "function") {
      throw new TypeError("pickStorageDirectory is required with storageManager");
    }
    ipcMain.handle(CHANNELS.getStorageStatus, () => storageManager.getStatus());
    ipcMain.handle(CHANNELS.pickStorageDirectory, async () => {
      const selected = await pickStorageDirectory();
      if (selected === null) return null;
      if (typeof selected !== "string" || !path.isAbsolute(selected) || selected.includes("\0")) {
        throw new Error("storage directory picker returned an invalid path");
      }
      return path.resolve(selected);
    });
    ipcMain.handle(CHANNELS.migrateStorage, async (_event, input) => {
      try {
        assertExactKeys(input, ["to"], "storage migration request");
        if (
          typeof input.to !== "string" ||
          input.to.length === 0 ||
          input.to.length > 1024 ||
          !path.isAbsolute(input.to) ||
          input.to.includes("\0")
        ) {
          throw new TypeError("invalid storage migration request");
        }
      } catch {
        throw new TypeError("invalid storage migration request");
      }
      const state = typeof service.getState === "function" ? service.getState() : null;
      if (["recording", "degraded", "paused", "finalizing"].includes(state?.status)) {
        throw new Error("capture must be inactive before storage migration");
      }
      try {
        return await storageManager.migrate({ to: path.resolve(input.to) });
      } catch (error) {
        if (
          typeof error?.message === "string" &&
          /^(migration already in progress|destination is unsafe|migration interrupted)/.test(
            error.message
          )
        ) {
          throw error;
        }
        throw new Error("storage migration failed; the current data directory is unchanged");
      }
    });
  }
}

module.exports = registerJarvisIpc;
