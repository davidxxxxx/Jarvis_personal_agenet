const { assertId } = require("../shared/contracts");
const { freezeAgentAdmissionSnapshot } = require("./AgentWorkloadPolicy");
const { validateCandidateAnalysis } = require("./JarvisAnalysisSchema");

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DESIRED_VECTOR_KEYS = Object.freeze([
  "analysisInputId",
  "analysisInputHash",
  "transcriptRevision",
  "identityRevision",
  "promptVersion",
  "responseSchemaVersion",
  "pseudonymBindingRevision",
  "modelVersion",
  "cloudPayloadHash",
  "segments",
]);

function requiredMethod(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} must be a function`);
  }
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function usage(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "inputTokens") ||
    !Object.prototype.hasOwnProperty.call(value, "outputTokens") ||
    !Number.isSafeInteger(value.inputTokens) ||
    value.inputTokens < 0 ||
    !Number.isSafeInteger(value.outputTokens) ||
    value.outputTokens < 0
  ) {
    return null;
  }
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

function desiredVector(head) {
  return Object.fromEntries(DESIRED_VECTOR_KEYS.map((key) => [key, head[key]]));
}

class JarvisAnalysisWorker {
  constructor({
    store,
    memoryRepository,
    budgetGuard,
    workloadPolicy,
    loadAdmissionSnapshot,
    client,
    owner,
    model,
    estimatedUsage,
    createRequestId,
    validateCandidate = validateCandidateAnalysis,
    now = Date.now,
  } = {}) {
    for (const method of [
      "completeJob",
      "supersedeAnalysisJob",
      "deferJob",
      "blockJob",
      "recordJobExecutionDevice",
    ]) {
      requiredMethod(store, method, "store");
    }
    for (const method of [
      "applyStoredAnalysisCandidate",
      "getAnalysisInputForCloud",
      "getAnalysisDesiredHead",
      "listRecoverableAnalysisCandidates",
      "persistValidatedAnalysisCandidate",
    ]) {
      requiredMethod(memoryRepository, method, "memoryRepository");
    }
    for (const method of [
      "listAttemptDispositionsByJob",
      "reserveNextAttempt",
      "markStarted",
      "reconcile",
      "release",
      "markUsageUnknown",
    ]) {
      requiredMethod(budgetGuard, method, "budgetGuard");
    }
    requiredMethod(workloadPolicy, "evaluate", "workloadPolicy");
    requiredMethod(client, "analyze", "client");
    if (typeof loadAdmissionSnapshot !== "function") {
      throw new TypeError("loadAdmissionSnapshot must be a function");
    }
    if (typeof createRequestId !== "function") {
      throw new TypeError("createRequestId must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof validateCandidate !== "function") {
      throw new TypeError("validateCandidate must be a function");
    }
    if (typeof model !== "string" || !model || model !== model.trim()) {
      throw new TypeError("model must be a bounded non-empty string");
    }
    if (
      !estimatedUsage ||
      typeof estimatedUsage !== "object" ||
      Array.isArray(estimatedUsage) ||
      !Number.isSafeInteger(estimatedUsage.inputTokens) ||
      estimatedUsage.inputTokens < 0 ||
      !Number.isSafeInteger(estimatedUsage.outputTokens) ||
      estimatedUsage.outputTokens < 0
    ) {
      throw new TypeError("estimatedUsage must contain non-negative token counts");
    }
    this.store = store;
    this.memoryRepository = memoryRepository;
    this.budgetGuard = budgetGuard;
    this.workloadPolicy = workloadPolicy;
    this.loadAdmissionSnapshot = loadAdmissionSnapshot;
    this.client = client;
    this.owner = assertId(owner, "owner");
    this.model = model;
    this.estimatedUsage = Object.freeze({ ...estimatedUsage });
    this.createRequestId = createRequestId;
    this.validateCandidate = validateCandidate;
    this.now = now;
  }

  _at() {
    return timestamp(this.now(), "at");
  }

  _validateClaimedJob(job) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      throw new TypeError("claimed analysis job is required");
    }
    const id = assertId(job.id, "jobId");
    if (job.job_type !== "analyze_session" || job.lane !== "cloud" || job.state !== "running") {
      throw codedError("ANALYSIS_JOB_CONTRACT_INVALID");
    }
    if (
      !HASH_PATTERN.test(job.input_hash) ||
      !HASH_PATTERN.test(job.desired_head_hash) ||
      job.input_version !== 1 ||
      job.model_version !== this.model ||
      typeof job.analysis_input_id !== "string" ||
      !job.analysis_input_id ||
      job.lease_owner !== this.owner ||
      !Number.isSafeInteger(job.lease_expires_at) ||
      job.lease_expires_at <= this._at()
    ) {
      throw codedError("ANALYSIS_JOB_CONTRACT_INVALID");
    }
    assertId(job.session_id, "sessionId");
    assertId(job.analysis_input_id, "analysisInputId");
    return { ...job, id };
  }

  _loadState(job) {
    const analysisInput = this.memoryRepository.getAnalysisInputForCloud(job.analysis_input_id);
    const head = this.memoryRepository.getAnalysisDesiredHead(job.session_id);
    const candidates = this.memoryRepository.listRecoverableAnalysisCandidates({ limit: 100 });
    const attempts = this.budgetGuard.listAttemptDispositionsByJob({
      jobId: job.id,
      provider: "minimax",
      operation: "session_analysis",
    });
    if (!Array.isArray(candidates) || !Array.isArray(attempts)) {
      throw codedError("ANALYSIS_DURABLE_STATE_INVALID");
    }
    return { analysisInput, head, candidates, attempts };
  }

  _isCurrent(job, analysisInput, head) {
    return Boolean(
      analysisInput &&
      head &&
      analysisInput.inputHash === job.input_hash &&
      head.analysisInputId === job.analysis_input_id &&
      head.analysisInputHash === job.input_hash &&
      head.desiredVectorHash === job.desired_head_hash &&
      head.modelVersion === this.model &&
      head.promptVersion === "jarvis-analysis-v2" &&
      head.responseSchemaVersion === "jarvis-analysis-v2"
    );
  }

  _evaluate(job, analysisInput, head) {
    const state = this.loadAdmissionSnapshot({ job, analysisInput, desiredHead: head });
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw codedError("ANALYSIS_ADMISSION_SNAPSHOT_INVALID");
    }
    const snapshot = freezeAgentAdmissionSnapshot({
      snapshotVersion: 1,
      kind: "analyze_session",
      manifest: state.manifest,
      desiredHead: desiredVector(head),
      backlog: state.backlog,
      captureActive: state.captureActive,
      previewActive: state.previewActive,
      pressure: state.pressure,
      cloudLaneInFlight: state.cloudLaneInFlight,
    });
    return this.workloadPolicy.evaluate(snapshot);
  }

  _complete(jobId, { executionDevice = null } = {}) {
    const at = this._at();
    if (
      this.store.completeJob(jobId, {
        owner: this.owner,
        at,
        executionDevice,
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _defer(jobId, reason) {
    const at = this._at();
    if (
      this.store.deferJob(jobId, {
        owner: this.owner,
        at,
        nextRetryAt: at + 15_000,
        reason,
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _supersede(jobId) {
    if (
      this.store.supersedeAnalysisJob(jobId, {
        owner: this.owner,
        at: this._at(),
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _block(jobId, errorCode) {
    if (
      this.store.blockJob(jobId, {
        owner: this.owner,
        at: this._at(),
        errorCode,
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _validateResponse(response, analysisInput) {
    const authoritativeUsage = usage(response?.usage);
    const keys = new Set([
      "result",
      "usage",
      "model",
      "requestId",
      "inputHash",
      "requestBytes",
      "responseBytes",
    ]);
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      Object.keys(response).length !== keys.size ||
      Object.keys(response).some((key) => !keys.has(key)) ||
      !authoritativeUsage ||
      response.model !== this.model ||
      response.inputHash !== analysisInput.inputHash ||
      typeof response.requestId !== "string" ||
      !response.requestId ||
      !Number.isSafeInteger(response.requestBytes) ||
      response.requestBytes < 1 ||
      !Number.isSafeInteger(response.responseBytes) ||
      response.responseBytes < 1
    ) {
      const error = codedError("ANALYSIS_RESPONSE_INVALID");
      error.authoritativeUsage = authoritativeUsage;
      throw error;
    }
    try {
      const result = this.validateCandidate(response.result, {
        allowedSegmentIds: new Set(analysisInput.allowedSegmentIds),
        allowedOwnerLabels: new Set(analysisInput.allowedOwnerLabels),
      });
      return { result, usage: authoritativeUsage };
    } catch (cause) {
      const error = codedError("ANALYSIS_RESPONSE_INVALID");
      error.cause = cause;
      error.authoritativeUsage = authoritativeUsage;
      throw error;
    }
  }

  _requireBudgetTransition(result, { requestId, state, replayed = undefined }) {
    if (
      !result ||
      result.ok !== true ||
      result.requestId !== requestId ||
      result.state !== state ||
      (replayed !== undefined && result.replayed !== replayed)
    ) {
      throw codedError("ANALYSIS_BUDGET_TRANSITION_INVALID");
    }
    return result;
  }

  _preparePriorAttempt(job, attempts) {
    const latest = attempts.at(-1);
    if (!latest) return { attemptNumber: 1 };
    if (
      !Number.isSafeInteger(latest.attemptNumber) ||
      latest.attemptNumber < 1 ||
      typeof latest.requestId !== "string" ||
      !latest.requestId
    ) {
      throw codedError("ANALYSIS_DURABLE_STATE_INVALID");
    }
    const attemptNumber = latest.attemptNumber + 1;
    if (!Number.isSafeInteger(attemptNumber)) {
      throw codedError("ANALYSIS_DURABLE_STATE_INVALID");
    }
    if (latest.state === "reserved") {
      this._requireBudgetTransition(
        this.budgetGuard.release({
          requestId: latest.requestId,
          reasonCode: "shutdown_before_transport",
        }),
        { requestId: latest.requestId, state: "released" }
      );
      return { attemptNumber };
    }
    if (latest.state === "started") {
      this._requireBudgetTransition(
        this.budgetGuard.markUsageUnknown({
          requestId: latest.requestId,
          reasonCode: "process_recovery",
        }),
        { requestId: latest.requestId, state: "usage_unknown" }
      );
      this._block(job.id, "analysis_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }
    if (latest.state === "usage_unknown") {
      this._block(job.id, "analysis_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }
    if (latest.state === "reconciled") {
      if (
        latest.actualInputTokens === 0 &&
        latest.actualOutputTokens === 0 &&
        latest.actualMicrousd === 0
      ) {
        return { attemptNumber };
      }
      this._block(job.id, "analysis_reconciled_without_candidate");
      return { status: "blocked", reason: "reconciled_without_candidate", jobId: job.id };
    }
    if (latest.state === "released") return { attemptNumber };
    throw codedError("ANALYSIS_DURABLE_STATE_INVALID");
  }

  async execute(claimedJob) {
    const job = this._validateClaimedJob(claimedJob);
    const initial = this._loadState(job);
    const recoverable = initial.candidates.find((candidate) => candidate.jobId === job.id);
    if (recoverable) {
      return this.recoverCandidate({
        ...recoverable,
        leaseOwner: job.lease_owner,
        leaseExpiresAt: job.lease_expires_at,
      });
    }
    const priorAttempt = this._preparePriorAttempt(job, initial.attempts);
    if (priorAttempt.status) return priorAttempt;
    if (!this._isCurrent(job, initial.analysisInput, initial.head)) {
      this._supersede(job.id);
      return { status: "superseded", jobId: job.id };
    }
    const initialDecision = this._evaluate(job, initial.analysisInput, initial.head);
    if (initialDecision.eligible !== true) {
      this._defer(job.id, "analysis_deferred_for_local_work");
      return {
        status: "deferred",
        reason: initialDecision.reason,
        jobId: job.id,
      };
    }

    const requestId = assertId(this.createRequestId(), "requestId");
    const reservation = this.budgetGuard.reserveNextAttempt({
      requestId,
      jobId: job.id,
      provider: "minimax",
      model: this.model,
      operation: "session_analysis",
      estimatedUsage: this.estimatedUsage,
    });
    if (reservation?.ok !== true) {
      this._defer(job.id, "analysis_budget_denied");
      return { status: "deferred", reason: reservation?.reason ?? "budget_denied", jobId: job.id };
    }
    if (
      reservation.requestId !== requestId ||
      reservation.attemptNumber !== priorAttempt.attemptNumber ||
      reservation.state !== "reserved" ||
      reservation.replayed !== false ||
      !Number.isSafeInteger(reservation.reservedMicrousd) ||
      reservation.reservedMicrousd < 0
    ) {
      throw codedError("ANALYSIS_BUDGET_TRANSITION_INVALID");
    }

    const reloadedInput = this.memoryRepository.getAnalysisInputForCloud(job.analysis_input_id);
    const reloadedHead = this.memoryRepository.getAnalysisDesiredHead(job.session_id);
    if (!this._isCurrent(job, reloadedInput, reloadedHead)) {
      this.budgetGuard.release({ requestId, reasonCode: "superseded_before_transport" });
      this._supersede(job.id);
      return { status: "superseded", jobId: job.id };
    }
    const finalDecision = this._evaluate(job, reloadedInput, reloadedHead);
    if (finalDecision.eligible !== true) {
      this.budgetGuard.release({ requestId, reasonCode: "admission_revoked" });
      this._defer(job.id, "analysis_deferred_for_local_work");
      return { status: "deferred", reason: finalDecision.reason, jobId: job.id };
    }

    this._requireBudgetTransition(this.budgetGuard.markStarted(requestId), {
      requestId,
      state: "started",
      replayed: false,
    });
    const request = this.client.analyze(reloadedInput);
    const deviceRecorded =
      this.store.recordJobExecutionDevice(job.id, {
        owner: this.owner,
        at: this._at(),
        executionDevice: "cloud",
      }) === true;
    let response;
    try {
      response = await request;
    } catch (error) {
      const authoritativeUsage = usage(error?.authoritativeUsage);
      if (authoritativeUsage) {
        this.budgetGuard.reconcile({ requestId, usage: authoritativeUsage });
        if (authoritativeUsage.inputTokens === 0 && authoritativeUsage.outputTokens === 0) {
          this._defer(job.id, "analysis_authoritative_zero_usage");
          return { status: "deferred", reason: "authoritative_zero_usage", jobId: job.id };
        }
        this._block(job.id, "analysis_invalid_response");
        return { status: "blocked", reason: "invalid_response", jobId: job.id };
      }
      this.budgetGuard.markUsageUnknown({
        requestId,
        reasonCode: "transport_ambiguous",
      });
      this._block(job.id, "analysis_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }
    let validated;
    try {
      validated = this._validateResponse(response, reloadedInput);
    } catch (error) {
      if (error.authoritativeUsage) {
        this.budgetGuard.reconcile({ requestId, usage: error.authoritativeUsage });
        this._block(job.id, "analysis_invalid_response");
        return { status: "blocked", reason: "invalid_response", jobId: job.id };
      }
      this.budgetGuard.markUsageUnknown({ requestId, reasonCode: "usage_invalid" });
      this._block(job.id, "analysis_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }

    this.budgetGuard.reconcile({ requestId, usage: validated.usage });
    const persisted = this.memoryRepository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: job.analysis_input_id,
      budgetAttemptId: requestId,
      candidate: validated.result,
    });
    if (
      !persisted ||
      !new Set(["created", "existing"]).has(persisted.status) ||
      !new Set(["validated", "applied", "superseded"]).has(persisted.state)
    ) {
      throw codedError("ANALYSIS_CANDIDATE_PERSIST_INVALID");
    }
    if (!deviceRecorded) throw codedError("JOB_LEASE_LOST");
    const applied = this.memoryRepository.applyStoredAnalysisCandidate({
      candidateId: persisted.candidateId,
      jobId: job.id,
      owner: this.owner,
      at: this._at(),
    });
    if (!applied || !new Set(["applied", "already_applied", "superseded"]).has(applied.status)) {
      throw codedError("ANALYSIS_CANDIDATE_APPLY_INVALID");
    }
    if (applied.status === "superseded") {
      this._supersede(job.id);
      return { status: "superseded", jobId: job.id };
    }
    this._complete(job.id, { executionDevice: "cloud" });
    return { status: applied.status, jobId: job.id };
  }

  recoverCandidate(recovery) {
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
      throw new TypeError("candidate recovery is required");
    }
    const jobId = assertId(recovery.jobId, "jobId");
    const candidateId = assertId(recovery.candidateId, "candidateId");
    if (!new Set(["validated", "applied"]).has(recovery.candidateState)) {
      throw new TypeError("candidateState must be validated or applied");
    }
    if (recovery.leaseOwner !== this.owner) throw codedError("JOB_LEASE_LOST");
    const at = this._at();
    if (positiveSafeInteger(recovery.leaseExpiresAt, "leaseExpiresAt") <= at) {
      throw codedError("JOB_LEASE_LOST");
    }
    let status = "already_applied";
    if (recovery.candidateState === "validated") {
      const applied = this.memoryRepository.applyStoredAnalysisCandidate({
        candidateId,
        jobId,
        owner: this.owner,
        at,
      });
      if (!applied || !new Set(["applied", "already_applied", "superseded"]).has(applied.status)) {
        throw codedError("ANALYSIS_CANDIDATE_RECOVERY_INVALID");
      }
      status = applied.status;
    }
    if (status === "superseded") {
      this._supersede(jobId);
      return { status, jobId };
    }
    if (
      this.store.completeJob(jobId, {
        owner: this.owner,
        at,
        executionDevice: "cloud",
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
    return { status, jobId };
  }
}

module.exports = JarvisAnalysisWorker;
