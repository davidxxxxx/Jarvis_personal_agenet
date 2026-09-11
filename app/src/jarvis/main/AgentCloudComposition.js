const crypto = require("node:crypto");
const AgentCloudDispatcher = require("./AgentCloudDispatcher");
const AgentWorkloadPolicy = require("./AgentWorkloadPolicy");
const { freezeAgentAdmissionSnapshot } = require("./AgentWorkloadPolicy");
const AnalysisBudgetGuard = require("./AnalysisBudgetGuard");
const AnalysisBudgetRepository = require("./AnalysisBudgetRepository");
const AnalysisScheduler = require("./AnalysisScheduler");
const DailyDigestScheduler = require("./DailyDigestScheduler");
const DailyDigestService = require("./DailyDigestService");
const JarvisAnalysisWorker = require("./JarvisAnalysisWorker");
const MiniMaxAnalysisClient = require("./MiniMaxAnalysisClient");
const MiniMaxDailyDigestClient = require("./MiniMaxDailyDigestClient");
const MiniMaxActivityClassifier = require("./MiniMaxActivityClassifier");
const ActivityClassificationService = require("./ActivityClassificationService");
const SessionActivityBuilder = require("./SessionActivityBuilder");

const MODEL = MiniMaxAnalysisClient.DEFAULT_MODEL;
const ANALYSIS_ESTIMATED_USAGE = Object.freeze({ inputTokens: 6_000, outputTokens: 8_192 });
const DIGEST_ESTIMATED_USAGE = Object.freeze({ inputTokens: 10_000, outputTokens: 4_096 });

function requiredMethod(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} must be a function`);
  }
}

function revisionFrom(value) {
  return Number.parseInt(
    crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12),
    16
  );
}

function createDesiredIdentity({ prepared }) {
  if (!prepared || !/^[0-9a-f]{64}$/u.test(prepared.identityRevision)) {
    throw new TypeError("prepared identity revision is required");
  }
  if (!Array.isArray(prepared.segments) || prepared.segments.length === 0) {
    throw new TypeError("prepared analysis segments are required");
  }
  return {
    responseSchemaVersion: "jarvis-analysis-v3",
    pseudonymBindingRevision: revisionFrom(prepared.identityRevision),
    modelVersion: MODEL,
    segmentSubjectRevisions: prepared.segments.map((segment) => ({
      segmentId: segment.segmentId,
      subjectRevision: revisionFrom(
        `${prepared.identityRevision}\u0000${segment.segmentId}\u0000${segment.speakerBindingLabel}`
      ),
    })),
  };
}

function createAnalysisManifest(core, desiredHead) {
  if (!core || !desiredHead || !Array.isArray(core.segments)) {
    throw new TypeError("analysis admission state is required");
  }
  if (core.segments.length !== desiredHead.segments?.length) {
    throw new TypeError("analysis admission segment state is stale");
  }
  return {
    manifestVersion: core.manifestVersion,
    sessionId: core.sessionId,
    sessionState: core.sessionState,
    processingState: core.processingState,
    analysisInputId: desiredHead.analysisInputId,
    analysisInputHash: desiredHead.analysisInputHash,
    transcriptRevision: desiredHead.transcriptRevision,
    identityRevision: desiredHead.identityRevision,
    promptVersion: desiredHead.promptVersion,
    responseSchemaVersion: desiredHead.responseSchemaVersion,
    pseudonymBindingRevision: desiredHead.pseudonymBindingRevision,
    modelVersion: desiredHead.modelVersion,
    cloudPayloadHash: desiredHead.cloudPayloadHash,
    segments: core.segments.map((segment, index) => {
      const desired = desiredHead.segments[index];
      if (
        segment.ordinal !== desired.ordinal ||
        segment.segmentId !== desired.segmentId ||
        segment.segmentVersion !== desired.segmentVersion ||
        segment.textHash !== desired.textHash
      ) {
        throw new TypeError("analysis admission segment state is stale");
      }
      return { ...segment, subjectRevision: desired.subjectRevision };
    }),
  };
}

function digestInputIsFinalOnly(input) {
  return Boolean(
    input &&
    input.contractVersion === "jarvis-daily-digest-input-v1" &&
    new Set(["partial", "final"]).has(input.completeness) &&
    input.inputWatermark?.schemaVersion === "jarvis-daily-digest-watermark-v1" &&
    Array.isArray(input.inputWatermark.evidence) &&
    input.inputWatermark.evidence.length > 0
  );
}

function createProductionAgentCloudComposition({
  repository,
  inputBuilder,
  getApiKey,
  fetchImpl = globalThis.fetch,
  governor,
  previewScheduler,
  calendarEventsProvider = () => [],
  timezoneProvider,
  activityClassificationEnabled = true,
  now = Date.now,
  owner = `agent-${process.pid}`,
  createRequestId = () => `agent_${crypto.randomUUID().replaceAll("-", "")}`,
  log = () => {},
} = {}) {
  if (!repository?.db || !repository?.memoryRepository || !repository?.captureEvidenceStore) {
    throw new TypeError("current Jarvis repository handles are required");
  }
  requiredMethod(inputBuilder, "build", "inputBuilder");
  requiredMethod(governor, "cloudPressure", "governor");
  requiredMethod(previewScheduler, "status", "previewScheduler");
  if (typeof getApiKey !== "function") throw new TypeError("getApiKey must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof calendarEventsProvider !== "function") {
    throw new TypeError("calendarEventsProvider must be a function");
  }
  if (typeof timezoneProvider !== "function") {
    throw new TypeError("timezoneProvider must be a function");
  }
  if (typeof activityClassificationEnabled !== "boolean") {
    throw new TypeError("activityClassificationEnabled must be a boolean");
  }
  if (typeof now !== "function" || typeof createRequestId !== "function") {
    throw new TypeError("clock and request id factory are required");
  }
  if (typeof log !== "function") throw new TypeError("log must be a function");

  const memoryRepository = repository.memoryRepository;
  const store = repository.captureEvidenceStore;
  requiredMethod(memoryRepository, "getAnalysisAdmissionManifest", "memoryRepository");
  const budgetRepository = new AnalysisBudgetRepository(repository.db);
  const budgetGuard = new AnalysisBudgetGuard({
    repository: budgetRepository,
    now,
    defaultTimezone: timezoneProvider(),
  });
  budgetGuard.initialize();
  const policy = new AgentWorkloadPolicy();
  const analysisClient = new MiniMaxAnalysisClient({
    fetchImpl,
    getApiKey,
    model: MODEL,
    now,
    logger: (entry) => log({ phase: "analysis_transport", ...entry }),
  });
  const digestClient = new MiniMaxDailyDigestClient({
    fetchImpl,
    getApiKey,
    model: MODEL,
    now,
    logger: (entry) => log({ phase: "daily_digest_transport", ...entry }),
  });
  const activityClient = new MiniMaxActivityClassifier({
    fetchImpl,
    getApiKey,
    model: MODEL,
    now,
    logger: (entry) => log({ phase: "activity_classification_transport", ...entry }),
  });
  const activityClassificationService = new ActivityClassificationService({
    repository: repository.activityClassificationRepository,
    cloudClient: activityClient,
    budgetGuard,
    now,
    createRequestId,
  });
  const activityBuilder = new SessionActivityBuilder(repository.db, { calendarEventsProvider });
  const commonAdmission = (job, priorityBefore) => ({
    backlog: store.listAgentAdmissionBacklog({ priorityBefore, excludeJobId: job.id }),
    captureActive: Boolean(
      repository.db
        .prepare(
          "SELECT 1 FROM sessions WHERE status IN ('recording','paused','finalizing') LIMIT 1"
        )
        .get()
    ),
    previewActive: previewScheduler.status().running > 0,
    pressure: governor.cloudPressure(),
    cloudLaneInFlight: store.countCloudLaneInFlight({ excludeJobId: job.id }),
  });
  const analysisWorker = new JarvisAnalysisWorker({
    store,
    memoryRepository,
    budgetGuard,
    workloadPolicy: policy,
    loadAdmissionSnapshot({ job, desiredHead }) {
      return {
        manifest: createAnalysisManifest(
          memoryRepository.getAnalysisAdmissionManifest(job.analysis_input_id),
          desiredHead
        ),
        ...commonAdmission(job, 70),
      };
    },
    client: analysisClient,
    owner,
    model: MODEL,
    estimatedUsage: ANALYSIS_ESTIMATED_USAGE,
    createRequestId,
    now,
  });
  const digestService = new DailyDigestService({
    memoryRepository,
    store,
    budgetGuard,
    client: digestClient,
    admit(job, input) {
      const decision = policy.evaluate(
        freezeAgentAdmissionSnapshot({
          snapshotVersion: 1,
          kind: "generate_daily_digest",
          sourceCurrent: true,
          sourceFinalOnly: digestInputIsFinalOnly(input),
          ...commonAdmission(job, 80),
        })
      );
      return Object.freeze({ eligible: decision.eligible, reason: decision.reason });
    },
    estimatedUsage: DIGEST_ESTIMATED_USAGE,
    createRequestId,
    modelVersion: MODEL,
    timezoneProvider,
    now,
    owner,
  });
  const dailyDigestScheduler = new DailyDigestScheduler({
    service: digestService,
    repository,
    timezoneProvider,
    now,
    log: (error) => log({ phase: "daily_digest_scheduler", error }),
  });
  const cloudDispatcher = new AgentCloudDispatcher({
    store,
    workers: {
      analyze_session: analysisWorker,
      generate_daily_digest: digestService,
    },
    recoverIncompleteBudgetAttempts: () => budgetGuard.recoverIncompleteAttempts(),
    owner,
    now,
  });
  const analysisScheduler = new AnalysisScheduler({
    repository,
    memoryRepository,
    inputBuilder,
    desiredIdentityProvider: createDesiredIdentity,
    activityClassificationService,
    activityBuilder,
    activityCloudReviewEnabled: activityClassificationEnabled,
    cloudQueue: store,
    cloudTransportEnabled: true,
    now,
  });
  return Object.freeze({
    analysisScheduler,
    dailyDigestScheduler,
    cloudDispatcher,
    analysisBudgetGuard: budgetGuard,
    activityClassificationService,
  });
}

module.exports = {
  ANALYSIS_ESTIMATED_USAGE,
  DIGEST_ESTIMATED_USAGE,
  MODEL,
  createAnalysisManifest,
  createDesiredIdentity,
  createProductionAgentCloudComposition,
  digestInputIsFinalOnly,
};
