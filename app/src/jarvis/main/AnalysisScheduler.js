const crypto = require("node:crypto");
const { assertId } = require("../shared/contracts");

const PROMPT_VERSION = "jarvis-analysis-hierarchical-v3";

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isCallable(value, method) {
  return value && typeof value[method] === "function";
}

function isMissingCloudJob(workState) {
  return (
    workState?.state === "retry_needed" &&
    workState.retryable === true &&
    workState.errorCode === "analysis_runtime_not_ready" &&
    workState.nextRetryAt === null &&
    workState.attemptCount === 0
  );
}

function getActivityClassificationRevision(memoryRepository, sessionId) {
  if (!isCallable(memoryRepository, "getActivityActionPolicyRevision")) return undefined;
  const revision = memoryRepository.getActivityActionPolicyRevision(sessionId);
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/u.test(revision)) {
    throw new TypeError("activity classification revision is invalid");
  }
  return revision;
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

function inputRevisions(
  segments,
  people,
  participantSnapshotRevision = undefined,
  activityClassificationRevision = undefined
) {
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
  const peopleRevision = people
    .map((person) => ({
      id: person.id,
      displayName: person.display_name ?? null,
      isSelf: person.is_self === 1,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const identityEvidence =
    participantSnapshotRevision === undefined
      ? peopleRevision
      : { people: peopleRevision, participantSnapshotRevision };
  const identityRevision = hashJson(
    activityClassificationRevision === undefined
      ? identityEvidence
      : { identity: identityEvidence, activityClassificationRevision }
  );
  return { transcriptRevision, identityRevision };
}

function getParticipantSnapshotRevision(repository, sessionId) {
  if (!isCallable(repository, "getLatestParticipantSnapshot")) return undefined;
  const snapshot = repository.getLatestParticipantSnapshot(sessionId);
  if (snapshot === null) return null;
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    typeof snapshot.sourceHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(snapshot.sourceHash) ||
    typeof snapshot.projectorVersion !== "string" ||
    !snapshot.projectorVersion.trim()
  ) {
    const error = new Error("participant snapshot revision unavailable");
    error.code = "analysis_participant_snapshot_invalid";
    throw error;
  }
  return {
    revision: snapshot.revision,
    sourceHash: snapshot.sourceHash,
    projectorVersion: snapshot.projectorVersion,
  };
}

class AnalysisScheduler {
  constructor({
    repository,
    memoryRepository = repository?.memoryRepository,
    inputBuilder,
    desiredIdentityProvider,
    activityClassificationService = null,
    activityBuilder = null,
    activityCloudReviewEnabled = true,
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
    if (typeof activityCloudReviewEnabled !== "boolean") {
      throw new TypeError("activityCloudReviewEnabled must be a boolean");
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
      typeof activityClassificationService.classifyLocal !== "function"
    ) {
      throw new TypeError("activityClassificationService.classifyLocal is required");
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
    this.activityCloudReviewEnabled = activityCloudReviewEnabled;
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
    if (this.quiesced || !isCallable(this.repository, "listSessions")) {
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
      // A desired head is committed before its cloud job so a local enqueue failure
      // cannot roll lineage back. The durable no-job state is uniquely distinguishable
      // from normal rate-limit/offline retries and enqueueCloudJob is identity-idempotent.
      const needsAnalysis =
        this.cloudTransportEnabled &&
        ((!detail.summary && workState.state === "waiting") || isMissingCloudJob(workState));
      const activityClassifications = isCallable(
        this.repository,
        "listSessionActivityClassifications"
      )
        ? this.repository.listSessionActivityClassifications(session.id)
        : null;
      const needsActivityClassification =
        this.activityClassificationService !== null &&
        this.activityBuilder !== null &&
        Array.isArray(activityClassifications) &&
        activityClassifications.length === 0;
      const currentActivityClassificationRevision =
        Array.isArray(activityClassifications) && activityClassifications.length > 0
          ? getActivityClassificationRevision(this.memoryRepository, session.id)
          : undefined;
      const desiredHead =
        currentActivityClassificationRevision !== undefined &&
        isCallable(this.memoryRepository, "getAnalysisDesiredHead")
          ? this.memoryRepository.getAnalysisDesiredHead(session.id)
          : null;
      const needsActivityRefreshRecommendation =
        currentActivityClassificationRevision !== undefined &&
        desiredHead?.activityClassificationRevision !== currentActivityClassificationRevision;
      if (!needsAnalysis && !needsActivityClassification && !needsActivityRefreshRecommendation) {
        continue;
      }

      attempted += 1;
      const status = await this.analyzeSession(session.id, "final");
      if (
        status.state === "queued" ||
        status.state === "ready" ||
        status.localClassification === "completed"
      ) {
        scheduled += 1;
      }
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
    let activityReviewPlan = null;
    try {
      activityReviewPlan = this.classifySessionLocally(id);
    } catch (error) {
      this._setFailureStatus(id, error);
      throw error;
    }
    if (!manual) {
      try {
        const recommendation = this._recommendActivityClassificationRefresh(id);
        if (recommendation !== null) return Promise.resolve(recommendation);
      } catch (error) {
        this._setFailureStatus(id, error);
        throw error;
      }
    }
    if (!this.cloudTransportEnabled) {
      return Promise.resolve(
        this._setStatus(id, "blocked", "analysis_runtime_not_ready", {
          ...(activityReviewPlan === null ? {} : { localClassification: "completed" }),
        })
      );
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
      return Promise.resolve(
        this._enqueue({ ...plan, activityReviewPlan, manual, allowUsageUnknown })
      );
    } catch (error) {
      this._setFailureStatus(id, error);
      throw error;
    }
  }

  refreshAfterActivityClassification(sessionId) {
    const id = assertId(sessionId, "sessionId");
    return Promise.resolve(this._recommendActivityClassificationRefresh(id) ?? this.getStatus(id));
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

  classifySessionLocally(sessionId, { force = false } = {}) {
    const id = assertId(sessionId, "sessionId");
    if (typeof force !== "boolean") throw new TypeError("force must be a boolean");
    if (this.activityClassificationService === null) {
      if (force) throw new Error("local activity classification is unavailable");
      return null;
    }
    if (
      !force &&
      isCallable(this.repository, "listSessionActivityClassifications") &&
      this.repository.listSessionActivityClassifications(id).length > 0
    ) {
      return null;
    }
    const prepared = this.activityBuilder.build(id);
    if (!Array.isArray(prepared?.activities) || prepared.activities.length === 0) return null;
    this.activityClassificationService.classifyLocal({
      sessionId: id,
      activities: prepared.activities,
    });
    return prepared;
  }

  _recommendActivityClassificationRefresh(sessionId) {
    const currentRevision = getActivityClassificationRevision(this.memoryRepository, sessionId);
    if (currentRevision === undefined) return null;
    const desiredHead = isCallable(this.memoryRepository, "getAnalysisDesiredHead")
      ? this.memoryRepository.getAnalysisDesiredHead(sessionId)
      : null;
    if (desiredHead?.activityClassificationRevision === currentRevision) return null;
    const detail = this.repository.getSessionDetail(sessionId);
    if (!detail?.summary) return null;
    if (!isCallable(this.repository, "markSessionSummaryRefreshRecommended")) {
      const error = new Error("summary refresh recommendation is unavailable");
      error.code = "analysis_summary_refresh_unavailable";
      throw error;
    }
    const refresh = this.repository.markSessionSummaryRefreshRecommended(
      sessionId,
      "activity_classification_changed",
      this.now()
    );
    return {
      ...this.getStatus(sessionId),
      summaryRefreshRecommended: refresh?.recommended === 1,
      summaryRefreshReason: refresh?.reason ?? "activity_classification_changed",
    };
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
    const participantSnapshotRevision = getParticipantSnapshotRevision(this.repository, sessionId);
    const activityClassificationRevision = getActivityClassificationRevision(
      this.memoryRepository,
      sessionId
    );
    const revisions = inputRevisions(
      segments,
      people,
      participantSnapshotRevision,
      activityClassificationRevision
    );
    const request = {
      sessionId,
      ...revisions,
      promptVersion: PROMPT_VERSION,
      segmentIds: segments.map((segment) => segment.id),
      ...(participantSnapshotRevision === undefined ? {} : { participantSnapshotRevision }),
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
    return {
      sessionId,
      kind,
      persisted,
      prepared,
      segments,
      people,
      activityClassificationRevision,
    };
  }

  _enqueue({
    sessionId,
    kind,
    persisted,
    prepared,
    segments,
    people,
    activityClassificationRevision,
    activityReviewPlan,
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
      ...(activityClassificationRevision === undefined ? {} : { activityClassificationRevision }),
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
    this._scheduleActivityCloudReview(
      sessionId,
      job.id,
      activityReviewPlan,
      activityClassificationRevision
    );
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

  _scheduleActivityCloudReview(sessionId, jobId, prepared, scheduledRevision) {
    if (
      this.activityClassificationService === null ||
      !this.activityCloudReviewEnabled ||
      !isCallable(this.activityClassificationService, "reviewSessionWithCloud") ||
      prepared === null ||
      this.quiesced ||
      this.inFlight.has(sessionId)
    ) {
      return;
    }
    const operation = Promise.resolve()
      .then(() =>
        this.activityClassificationService.reviewSessionWithCloud({
          sessionId,
          jobId,
          activities: prepared.activities,
          redactionTerms: prepared.redactionTerms,
        })
      )
      .then(() => {
        if (this.quiesced) return null;
        const currentRevision = getActivityClassificationRevision(this.memoryRepository, sessionId);
        if (currentRevision === undefined || currentRevision === scheduledRevision) return null;
        return this.refreshAfterActivityClassification(sessionId);
      })
      .catch(() => null)
      .finally(() => {
        if (this.inFlight.get(sessionId) === operation) this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, operation);
  }
}

module.exports = AnalysisScheduler;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
