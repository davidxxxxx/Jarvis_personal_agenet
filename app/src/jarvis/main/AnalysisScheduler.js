const crypto = require("node:crypto");
const { assertId } = require("../shared/contracts");

const PROMPT_VERSION = "jarvis-analysis-hierarchical-v3";

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isCallable(value, method) {
  return value && typeof value[method] === "function";
}

function eligibleSegments(detail) {
  return detail.segments
    .filter(
      (segment) =>
        segment.result_kind === "final" &&
        segment.is_stable === 1 &&
        segment.superseded_by == null &&
        segment.duplicate_of == null &&
        typeof segment.text === "string" &&
        segment.text.trim()
    )
    .sort(
      (left, right) =>
        left.started_at - right.started_at ||
        left.ended_at - right.ended_at ||
        left.id.localeCompare(right.id)
    );
}

function inputRevisions(segments, people) {
  const transcriptRevision = hashJson(
    segments.map((segment) => ({
      id: segment.id,
      version: segment.version,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      text: segment.text,
      personId: segment.person_id ?? null,
    }))
  );
  const identityRevision = hashJson(
    people
      .map((person) => ({
        id: person.id,
        displayName: person.display_name ?? null,
        isSelf: person.is_self === 1,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  return { transcriptRevision, identityRevision };
}

class AnalysisScheduler {
  constructor({
    repository,
    memoryRepository = repository?.memoryRepository,
    inputBuilder,
    desiredIdentityProvider,
    activityClassificationService = null,
    activityBuilder = null,
    cloudQueue = repository?.captureEvidenceStore,
    cloudTransportEnabled = false,
    now = Date.now,
  } = {}) {
    if (!isCallable(repository, "getSessionDetail")) {
      throw new TypeError("analysis repository is required");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof cloudTransportEnabled !== "boolean") {
      throw new TypeError("cloudTransportEnabled must be a boolean");
    }
    if (cloudTransportEnabled) {
      for (const method of [
        "prepareAnalysisInput",
        "createAnalysisInput",
        "setAnalysisDesiredHead",
      ]) {
        if (!isCallable(memoryRepository, method)) {
          throw new TypeError("analysis memory repository is required");
        }
      }
      if (!isCallable(inputBuilder, "build")) {
        throw new TypeError("analysis input builder is required");
      }
      if (!isCallable(cloudQueue, "enqueueCloudJob")) {
        throw new TypeError("durable analysis cloud queue is required");
      }
      if (!isCallable(cloudQueue, "authorizeManualAnalysisRetry")) {
        throw new TypeError("manual analysis retry queue is required");
      }
      if (typeof desiredIdentityProvider !== "function") {
        throw new TypeError("desiredIdentityProvider must be a function");
      }
    }
    if ((activityClassificationService === null) !== (activityBuilder === null)) {
      throw new TypeError(
        "activityClassificationService and activityBuilder must be configured together"
      );
    }
    if (
      activityClassificationService !== null &&
      typeof activityClassificationService.classifySession !== "function"
    ) {
      throw new TypeError("activityClassificationService.classifySession is required");
    }
    if (activityBuilder !== null && typeof activityBuilder.build !== "function") {
      throw new TypeError("activityBuilder.build is required");
    }
    this.repository = repository;
    this.memoryRepository = memoryRepository;
    this.inputBuilder = inputBuilder;
    this.desiredIdentityProvider = desiredIdentityProvider;
    this.activityClassificationService = activityClassificationService;
    this.activityBuilder = activityBuilder;
    this.cloudQueue = cloudQueue;
    this.cloudTransportEnabled = cloudTransportEnabled;
    this.now = now;
    this.inFlight = new Map();
    this.status = new Map();
    this.quiesced = false;
  }

  _setStatus(sessionId, state, errorCode = null, extra = {}) {
    const status = {
      sessionId,
      state,
      errorCode,
      updatedAt: this.now(),
      ...extra,
    };
    this.status.set(sessionId, status);
    return status;
  }

  getStatus(sessionId) {
    const id = assertId(sessionId, "sessionId");
    const transient = this.status.get(id);
    if (transient?.state === "preparing") return transient;
    if (isCallable(this.memoryRepository, "getAnalysisWorkState")) {
      return { sessionId: id, ...this.memoryRepository.getAnalysisWorkState(id) };
    }
    return {
      sessionId: id,
      state: "waiting",
      retryable: false,
      errorCode: null,
      nextRetryAt: null,
      attemptCount: 0,
      updatedAt: null,
    };
  }

  async recoverReadySessions({ limit = 1 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("analysis recovery limit must be between 1 and 100");
    }
    if (
      this.quiesced ||
      !this.cloudTransportEnabled ||
      !isCallable(this.repository, "listSessions")
    ) {
      return 0;
    }

    const sessions = this.repository.listSessions({ limit: 1_000 });
    let attempted = 0;
    let scheduled = 0;
    for (const session of sessions) {
      if (attempted >= limit) break;
      if (
        !session?.id ||
        !new Set(["completed", "recovered"]).has(session.status) ||
        session.processing_state !== "ready" ||
        this.repository.isHistoricalLocalOnlyReprocessing?.(session.id) === true
      ) {
        continue;
      }
      const detail = this.repository.getSessionDetail(session.id);
      if (!detail || eligibleSegments(detail).length === 0) continue;
      const workState = this.getStatus(session.id);
      const needsAnalysis = !detail.summary && workState.state === "waiting";
      const needsActivityClassification =
        this.activityClassificationService !== null &&
        this.activityBuilder !== null &&
        isCallable(this.repository, "listSessionActivityClassifications") &&
        this.repository.listSessionActivityClassifications(session.id).length === 0;
      if (!needsAnalysis && !needsActivityClassification) continue;

      attempted += 1;
      const status = await this.analyzeSession(session.id, "final");
      if (status.state === "queued" || status.state === "ready") scheduled += 1;
    }
    return scheduled;
  }

  analyzeSession(
    sessionId,
    kind = "incremental",
    { manual = false, allowUsageUnknown = false } = {}
  ) {
    const id = assertId(sessionId, "sessionId");
    if (kind !== "incremental" && kind !== "final") throw new TypeError("invalid analysis kind");
    if (typeof manual !== "boolean" || typeof allowUsageUnknown !== "boolean") {
      throw new TypeError("analysis retry options are invalid");
    }
    if (allowUsageUnknown && !manual) {
      throw new TypeError("usage-unknown retry requires a manual request");
    }
    if (this.quiesced) {
      const error = new Error("storage migration in progress");
      error.code = "STORAGE_MIGRATION_IN_PROGRESS";
      throw error;
    }
    if (!this.cloudTransportEnabled) {
      return Promise.resolve(this._setStatus(id, "blocked", "analysis_runtime_not_ready"));
    }
    let plan;
    try {
      plan = this._prepare(id, kind);
    } catch (error) {
      this._setFailureStatus(id, error);
      throw error;
    }
    if (plan.status) return Promise.resolve(plan.status);
    try {
      return Promise.resolve(this._enqueue({ ...plan, manual, allowUsageUnknown }));
    } catch (error) {
      this._setFailureStatus(id, error);
      throw error;
    }
  }

  async quiesce() {
    this.quiesced = true;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  resume() {
    this.quiesced = false;
  }

  _setFailureStatus(sessionId, error) {
    const errorCode = typeof error?.code === "string" ? error.code : "analysis_failed";
    const state =
      errorCode === "rate_limit"
        ? "quota_limited"
        : error?.retryable === true
          ? "retry_needed"
          : "blocked";
    return this._setStatus(sessionId, state, errorCode);
  }

  _prepare(sessionId, kind) {
    const detail = this.repository.getSessionDetail(sessionId);
    if (!detail) {
      const error = new Error("analysis session does not exist");
      error.code = "ANALYSIS_SESSION_NOT_FOUND";
      throw error;
    }
    const segments = eligibleSegments(detail);
    if (segments.length === 0) {
      return { status: this._setStatus(sessionId, "blocked", "analysis_input_empty") };
    }
    const people = isCallable(this.repository, "listPeople") ? this.repository.listPeople() : [];
    const revisions = inputRevisions(segments, people);
    const request = {
      sessionId,
      ...revisions,
      promptVersion: PROMPT_VERSION,
      segmentIds: segments.map((segment) => segment.id),
    };
    this._setStatus(sessionId, "preparing");
    const prepared = this.memoryRepository.prepareAnalysisInput(request);
    const built = this.inputBuilder.build(prepared, { strategy: "hierarchical" });
    if (!built?.sendable) {
      return {
        status: this._setStatus(sessionId, "blocked", built?.reason || "analysis_input_invalid"),
      };
    }
    const persisted = this.memoryRepository.createAnalysisInput({
      ...request,
      prepareToken: prepared.prepareToken,
      inputContractVersion: built.inputContractVersion,
      redactionVersion: built.redactionVersion,
      cloudPayloadJson: built.cloudPayloadJson,
    });
    if (
      !persisted ||
      !new Set(["created", "existing"]).has(persisted.status) ||
      !new Set(["pending", "applied"]).has(persisted.candidateState) ||
      (persisted.status === "created" && persisted.candidateState !== "pending") ||
      typeof persisted.analysisInputId !== "string" ||
      !/^[0-9a-f]{64}$/u.test(persisted.inputHash)
    ) {
      const error = new Error("analysis input state unavailable");
      error.code = "analysis_input_state_invalid";
      throw error;
    }
    return { sessionId, kind, persisted, prepared, segments, people };
  }

  _enqueue({
    sessionId,
    kind,
    persisted,
    prepared,
    segments,
    people,
    manual,
    allowUsageUnknown,
  }) {
    const identity = this.desiredIdentityProvider({
      sessionId,
      kind,
      persisted,
      prepared,
      segments,
      people,
    });
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
      throw new TypeError("durable desired identity is required");
    }
    const head = this.memoryRepository.setAnalysisDesiredHead({
      sessionId,
      analysisInputId: persisted.analysisInputId,
      responseSchemaVersion: identity.responseSchemaVersion,
      pseudonymBindingRevision: identity.pseudonymBindingRevision,
      modelVersion: identity.modelVersion,
      segmentSubjectRevisions: identity.segmentSubjectRevisions,
    });
    if (
      !head ||
      head.analysisInputId !== persisted.analysisInputId ||
      head.analysisInputHash !== persisted.inputHash ||
      typeof head.desiredVectorHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(head.desiredVectorHash) ||
      head.modelVersion !== identity.modelVersion
    ) {
      const error = new Error("analysis desired head unavailable");
      error.code = "analysis_desired_head_invalid";
      throw error;
    }
    let job = this.cloudQueue.enqueueCloudJob({
      sessionId,
      jobType: "analyze_session",
      analysisInputId: persisted.analysisInputId,
      desiredHeadHash: head.desiredVectorHash,
      inputHash: persisted.inputHash,
      inputVersion: 1,
      modelVersion: identity.modelVersion,
    });
    if (manual && job?.state === "blocked") {
      job =
        this.cloudQueue.authorizeManualAnalysisRetry(job.id, {
          allowUsageUnknown,
          at: this.now(),
        }) ?? job;
    }
    if (!job || typeof job.id !== "string" || !job.id) {
      const error = new Error("analysis cloud job unavailable");
      error.code = "analysis_cloud_job_invalid";
      throw error;
    }
    this._scheduleActivityClassification(sessionId, job.id);
    const reused = persisted.status === "existing";
    const state =
      reused && persisted.candidateState === "applied" && job.state === "completed"
        ? "ready"
        : "queued";
    return this._setStatus(sessionId, state, null, {
      jobId: job.id,
      desiredVectorHash: head.desiredVectorHash,
      reused,
    });
  }

  _scheduleActivityClassification(sessionId, jobId) {
    if (
      this.activityClassificationService === null ||
      this.quiesced ||
      this.inFlight.has(sessionId)
    ) {
      return;
    }
    if (
      isCallable(this.repository, "listSessionActivityClassifications") &&
      this.repository.listSessionActivityClassifications(sessionId).length > 0
    ) {
      return;
    }
    let prepared;
    try {
      prepared = this.activityBuilder.build(sessionId);
    } catch {
      return;
    }
    if (!Array.isArray(prepared?.activities) || prepared.activities.length === 0) return;
    const operation = Promise.resolve()
      .then(() =>
        this.activityClassificationService.classifySession({
          sessionId,
          jobId,
          activities: prepared.activities,
          redactionTerms: prepared.redactionTerms,
          cloudReview: true,
        })
      )
      .catch(() => null)
      .finally(() => {
        if (this.inFlight.get(sessionId) === operation) this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, operation);
  }
}

module.exports = AnalysisScheduler;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
