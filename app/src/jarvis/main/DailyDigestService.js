const {
  DEFAULT_DAILY_DIGEST_REQUEST_BYTES,
  MAX_DAILY_DIGEST_RESPONSE_BYTES,
} = require("./DailyDigestContractLimits");

const CANDIDATE_STATES = new Set(["validated", "applied", "superseded"]);
const APPLY_STATES = new Set(["applied", "already_applied", "superseded"]);
const REGENERATE_WAKE_STATES = new Set(["pending", "retry"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_TOKEN_COUNT = 1_000_000_000;
const INPUT_CONTRACT_VERSION = "jarvis-daily-digest-input-v1";
const INPUT_KEYS = [
  "status",
  "digestInputId",
  "localDate",
  "timezone",
  "sourceHash",
  "contractVersion",
  "completeness",
  "inputWatermark",
  "inputWatermarkJson",
  "cloudPayload",
  "cloudPayloadJson",
  "inputBytes",
  "modelVersion",
  "createdAt",
];
const ATTEMPT_KEYS = [
  "requestId",
  "jobId",
  "attemptNumber",
  "provider",
  "model",
  "operation",
  "state",
  "disposition",
  "startupAction",
  "reasonCode",
  "actualInputTokens",
  "actualOutputTokens",
  "actualMicrousd",
  "createdAt",
  "startedAt",
  "finalizedAt",
];
const ATTEMPT_DISPOSITION = Object.freeze({
  reserved: Object.freeze(["reserved_not_started", "release_and_retry"]),
  started: Object.freeze(["started_unreconciled", "mark_usage_unknown"]),
  reconciled: Object.freeze(["reconciled", "none"]),
  released: Object.freeze(["released", "retry_with_new_attempt"]),
  usage_unknown: Object.freeze(["usage_unknown", "block_for_period"]),
});
const PUBLIC_ERROR_CODES = new Set([
  "offline",
  "budget_unavailable",
  "usage_unknown",
  "invalid_response",
  "runtime_unavailable",
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactPlainObject(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  return value;
}

function text(value, name, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${name} must be non-empty trimmed text`);
  }
  if (Array.from(value).length > maxLength) throw new RangeError(`${name} is too long`);
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeIntegerOrNull(value, name) {
  if (value === null) return null;
  return timestamp(value, name);
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
    value.inputTokens > MAX_TOKEN_COUNT ||
    !Number.isSafeInteger(value.outputTokens) ||
    value.outputTokens < 0 ||
    value.outputTokens > MAX_TOKEN_COUNT
  ) {
    return null;
  }
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

function authoritativeErrorUsage(error) {
  const safeUsage = usage(error?.usage);
  if (
    !safeUsage ||
    !Number.isSafeInteger(error?.requestBytes) ||
    error.requestBytes < 1 ||
    error.requestBytes > DEFAULT_DAILY_DIGEST_REQUEST_BYTES ||
    !Number.isSafeInteger(error?.responseBytes) ||
    error.responseBytes < 1 ||
    error.responseBytes > MAX_DAILY_DIGEST_RESPONSE_BYTES
  ) {
    return null;
  }
  return safeUsage;
}

function jsonObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return value;
}

function publicErrorCode(...values) {
  const joined = values.filter((value) => typeof value === "string").join("_").toLowerCase();
  if (/usage_unknown/u.test(joined)) return "usage_unknown";
  if (/budget|quota/u.test(joined)) return "budget_unavailable";
  if (/offline|network|connection/u.test(joined)) return "offline";
  if (/invalid|schema|response/u.test(joined)) return "invalid_response";
  if (/runtime|configuration/u.test(joined)) return "runtime_unavailable";
  const exact = values.find((value) => PUBLIC_ERROR_CODES.has(value));
  return exact ?? (joined ? "generation_failed" : null);
}

class DailyDigestService {
  constructor(input) {
    exactPlainObject(
      input,
      [
        "memoryRepository",
        "store",
        "budgetGuard",
        "client",
        "admit",
        "estimatedUsage",
        "createRequestId",
        "modelVersion",
        "timezoneProvider",
        "now",
        "owner",
      ],
      "daily digest service dependencies"
    );
    for (const method of [
      "createDailyDigestInput",
      "getLatestDailyDigest",
      "applyValidatedDailyDigestCandidate",
      "getDailyDigestInput",
      "getRecoverableDailyDigestCandidateByJob",
      "persistValidatedDailyDigestCandidate",
    ]) {
      if (typeof input.memoryRepository?.[method] !== "function") {
        throw new TypeError(`memoryRepository.${method} must be a function`);
      }
    }
    for (const method of [
      "enqueueDailyDigestJob",
      "wakeDailyDigestJob",
      "authorizeManualDailyDigestRetry",
      "completeJob",
      "deferJob",
      "blockJob",
      "recordJobExecutionDevice",
      "supersedeDailyDigestJob",
    ]) {
      if (typeof input.store?.[method] !== "function") {
        throw new TypeError(`store.${method} must be a function`);
      }
    }
    for (const method of [
      "listAttemptDispositionsByJob",
      "reserveNextAttempt",
      "markStarted",
      "reconcile",
      "release",
      "markUsageUnknown",
    ]) {
      if (typeof input.budgetGuard?.[method] !== "function") {
        throw new TypeError(`budgetGuard.${method} must be a function`);
      }
    }
    if (typeof input.client?.generate !== "function") {
      throw new TypeError("client.generate must be a function");
    }
    if (typeof input.admit !== "function") throw new TypeError("admit must be a function");
    exactPlainObject(
      input.estimatedUsage,
      ["inputTokens", "outputTokens"],
      "estimatedUsage"
    );
    const estimatedUsage = usage(input.estimatedUsage);
    if (!estimatedUsage) throw new TypeError("estimatedUsage is invalid");
    if (typeof input.createRequestId !== "function") {
      throw new TypeError("createRequestId must be a function");
    }
    if (typeof input.timezoneProvider !== "function") {
      throw new TypeError("timezoneProvider must be a function");
    }
    if (typeof input.now !== "function") throw new TypeError("now must be a function");
    this.memoryRepository = input.memoryRepository;
    this.store = input.store;
    this.budgetGuard = input.budgetGuard;
    this.client = input.client;
    this.admit = input.admit;
    this.estimatedUsage = Object.freeze(estimatedUsage);
    this.createRequestId = input.createRequestId;
    this.modelVersion = text(input.modelVersion, "modelVersion", 128);
    if (input.client.model !== this.modelVersion) {
      throw new TypeError("client.model must equal modelVersion");
    }
    this.timezoneProvider = input.timezoneProvider;
    this.now = input.now;
    this.owner = text(input.owner, "owner");
  }

  _localDateInput(input, name) {
    exactPlainObject(input, ["localDate"], name);
    return text(input.localDate, "localDate", 10);
  }

  _regenerateInput(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new TypeError("daily digest regenerate input must be a plain object");
    }
    const keys = Object.keys(input);
    if (
      !Object.prototype.hasOwnProperty.call(input, "localDate") ||
      keys.some((key) => key !== "localDate" && key !== "allowUsageUnknown")
    ) {
      throw new TypeError("daily digest regenerate input has invalid keys");
    }
    const allowUsageUnknown = Object.prototype.hasOwnProperty.call(
      input,
      "allowUsageUnknown"
    )
      ? input.allowUsageUnknown
      : false;
    if (typeof allowUsageUnknown !== "boolean") {
      throw new TypeError("allowUsageUnknown must be a boolean");
    }
    return {
      localDate: text(input.localDate, "localDate", 10),
      allowUsageUnknown,
    };
  }

  _timezone() {
    return text(this.timezoneProvider(), "timezone", 64);
  }

  prepare(input) {
    const localDate = this._localDateInput(input, "daily digest prepare input");
    const timezone = this._timezone();
    const digestInput = this.memoryRepository.createDailyDigestInput({
      localDate,
      timezone,
      modelVersion: this.modelVersion,
    });
    if (digestInput?.status === "empty") {
      return { status: "empty", localDate, timezone };
    }
    if (
      !digestInput ||
      !new Set(["created", "existing"]).has(digestInput.status) ||
      !new Set(["partial", "final"]).has(digestInput.completeness)
    ) {
      throw codedError("DAILY_DIGEST_INPUT_INVALID");
    }
    const digestInputId = text(digestInput.digestInputId, "digestInputId");
    const sourceHash = text(digestInput.sourceHash, "sourceHash", 64);
    const job = this.store.enqueueDailyDigestJob({
      digestInputId,
      inputHash: sourceHash,
      inputVersion: 1,
      modelVersion: this.modelVersion,
    });
    if (!job || typeof job !== "object") throw codedError("DAILY_DIGEST_JOB_INVALID");
    return {
      status: "prepared",
      inputStatus: digestInput.status,
      localDate,
      timezone,
      digestInputId,
      sourceHash,
      completeness: digestInput.completeness,
      jobId: text(job.id, "jobId"),
      jobState: text(job.state, "jobState", 64),
    };
  }

  getLatest(input) {
    const localDate = this._localDateInput(input, "daily digest latest input");
    return this.memoryRepository.getLatestDailyDigest({
      localDate,
      timezone: this._timezone(),
    });
  }

  getPublicStatus(input) {
    const localDate = this._localDateInput(input, "daily digest status input");
    const timezone = this._timezone();
    const digest = this.memoryRepository.getLatestDailyDigest({ localDate, timezone });
    const work = this.memoryRepository.getLatestDailyDigestWorkState?.({ localDate, timezone }) ?? null;
    if (!work) {
      return Object.freeze({
        state: digest ? "ready" : "not_generated",
        retryable: false,
        errorCode: null,
        nextRetryAt: null,
        attemptCount: 0,
      });
    }
    const states = {
      pending: "queued",
      running: "running",
      retry: "retry_needed",
      completed: digest ? "ready" : "blocked",
      blocked: "blocked",
      failed: "blocked",
      cancelled: "blocked",
      superseded: digest ? "ready" : "blocked",
      audio_expired_before_processing: "blocked",
    };
    const state = states[work.state] ?? "blocked";
    return Object.freeze({
      state,
      retryable: new Set(["queued", "running", "retry_needed"]).has(state),
      errorCode:
        state === "blocked" ? publicErrorCode(work.errorCode, work.blockedReason) : null,
      nextRetryAt:
        state === "retry_needed" && Number.isSafeInteger(work.nextRetryAt)
          ? work.nextRetryAt
          : null,
      attemptCount:
        Number.isSafeInteger(work.attemptCount) && work.attemptCount >= 0
          ? work.attemptCount
          : 0,
    });
  }

  regenerate(input) {
    const request = this._regenerateInput(input);
    const prepared = this.prepare({ localDate: request.localDate });
    if (prepared.status === "empty") return prepared;
    if (prepared.jobState === "blocked") {
      const authorized = this.store.authorizeManualDailyDigestRetry(prepared.jobId, {
        allowUsageUnknown: request.allowUsageUnknown,
        at: timestamp(this.now(), "at"),
      });
      if (authorized) {
        return {
          ...prepared,
          status: "woken",
          jobId: text(authorized.id, "jobId"),
          jobState: text(authorized.state, "jobState", 64),
        };
      }
    }
    if (!REGENERATE_WAKE_STATES.has(prepared.jobState)) {
      return {
        ...prepared,
        status: "unchanged",
        reason: `job_${prepared.jobState}`,
      };
    }
    const job = this.store.wakeDailyDigestJob({
      digestInputId: prepared.digestInputId,
      at: timestamp(this.now(), "at"),
    });
    if (!job || typeof job !== "object") throw codedError("DAILY_DIGEST_JOB_INVALID");
    return {
      ...prepared,
      status: "woken",
      jobId: text(job.id, "jobId"),
      jobState: text(job.state, "jobState", 64),
    };
  }

  _at() {
    return timestamp(this.now(), "at");
  }

  _validateClaimedJob(job) {
    try {
      if (!job || typeof job !== "object" || Array.isArray(job)) {
        throw new TypeError("claimed daily digest job is required");
      }
      text(job.id, "jobId");
      text(job.digest_input_id, "digestInputId");
      text(job.lease_owner, "leaseOwner");
      if (
        job.job_type !== "generate_daily_digest" ||
        job.lane !== "cloud" ||
        job.state !== "running" ||
        !HASH_PATTERN.test(job.input_hash) ||
        job.input_version !== 1 ||
        job.model_version !== this.modelVersion ||
        job.lease_owner !== this.owner ||
        !Number.isSafeInteger(job.lease_expires_at) ||
        job.lease_expires_at <= this._at() ||
        job.session_id !== null ||
        job.track_id !== null ||
        job.chunk_id !== null ||
        job.analysis_input_id !== null ||
        job.desired_head_hash !== null
      ) {
        throw new TypeError("claimed daily digest job contract is invalid");
      }
      return job;
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_JOB_CONTRACT_INVALID");
      error.cause = cause;
      throw error;
    }
  }

  _validateInputShape(input, allowedStatuses = ["existing"]) {
    try {
      exactPlainObject(input, INPUT_KEYS, "daily digest immutable input");
      if (!allowedStatuses.includes(input.status)) throw new TypeError("input status is invalid");
      text(input.digestInputId, "digestInputId");
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)) {
        throw new TypeError("localDate is invalid");
      }
      text(input.timezone, "timezone", 64);
      if (!HASH_PATTERN.test(input.sourceHash)) throw new TypeError("sourceHash is invalid");
      if (input.contractVersion !== INPUT_CONTRACT_VERSION) {
        throw new TypeError("input contract is invalid");
      }
      if (!new Set(["partial", "final"]).has(input.completeness)) {
        throw new TypeError("completeness is invalid");
      }
      jsonObject(input.inputWatermark, "inputWatermark");
      jsonObject(input.cloudPayload, "cloudPayload");
      if (
        typeof input.inputWatermarkJson !== "string" ||
        JSON.stringify(input.inputWatermark) !== input.inputWatermarkJson ||
        typeof input.cloudPayloadJson !== "string" ||
        JSON.stringify(input.cloudPayload) !== input.cloudPayloadJson ||
        !Number.isSafeInteger(input.inputBytes) ||
        input.inputBytes !== Buffer.byteLength(input.cloudPayloadJson, "utf8") ||
        typeof input.modelVersion !== "string" ||
        !input.modelVersion.trim() ||
        input.modelVersion !== input.modelVersion.trim() ||
        Array.from(input.modelVersion).length > 128
      ) {
        throw new TypeError("immutable input fields are invalid");
      }
      timestamp(input.createdAt, "createdAt");
      return input;
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_INPUT_CONTRACT_INVALID");
      error.cause = cause;
      throw error;
    }
  }

  _validateBoundInput(job, input) {
    const stored = this._validateInputShape(input);
    if (
      stored.digestInputId !== job.digest_input_id ||
      stored.sourceHash !== job.input_hash
    ) {
      throw codedError("DAILY_DIGEST_INPUT_CONTRACT_INVALID");
    }
    return stored;
  }

  _validateCandidates(value) {
    if (!Array.isArray(value)) throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
    try {
      return value.map((candidate) => {
        exactPlainObject(
          candidate,
          [
            "candidateId",
            "jobId",
            "digestInputId",
            "candidateState",
            "jobState",
            "leaseOwner",
            "leaseExpiresAt",
            "budgetState",
          ],
          "recoverable daily digest candidate"
        );
        text(candidate.candidateId, "candidateId");
        text(candidate.jobId, "jobId");
        text(candidate.digestInputId, "digestInputId");
        if (!CANDIDATE_STATES.has(candidate.candidateState)) {
          throw new TypeError("candidateState is invalid");
        }
        text(candidate.jobState, "jobState", 64);
        if (candidate.leaseOwner !== null) text(candidate.leaseOwner, "leaseOwner");
        safeIntegerOrNull(candidate.leaseExpiresAt, "leaseExpiresAt");
        text(candidate.budgetState, "budgetState", 64);
        return candidate;
      });
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
      error.cause = cause;
      throw error;
    }
  }

  _validateAttempts(job, value) {
    if (!Array.isArray(value)) throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
    try {
      return value.map((attempt, index) => {
        exactPlainObject(attempt, ATTEMPT_KEYS, "daily digest budget attempt disposition");
        text(attempt.requestId, "requestId");
        if (
          attempt.jobId !== job.id ||
          attempt.attemptNumber !== index + 1 ||
          attempt.provider !== "minimax" ||
          attempt.model !== this.modelVersion ||
          attempt.operation !== "daily_digest" ||
          !Object.prototype.hasOwnProperty.call(ATTEMPT_DISPOSITION, attempt.state)
        ) {
          throw new TypeError("attempt identity is invalid");
        }
        const [disposition, startupAction] = ATTEMPT_DISPOSITION[attempt.state];
        if (attempt.disposition !== disposition || attempt.startupAction !== startupAction) {
          throw new TypeError("attempt disposition is invalid");
        }
        timestamp(attempt.createdAt, "attempt createdAt");
        const expectsStarted = ["started", "reconciled", "usage_unknown"].includes(attempt.state);
        const expectsFinal = ["reconciled", "released", "usage_unknown"].includes(attempt.state);
        if (expectsStarted) timestamp(attempt.startedAt, "attempt startedAt");
        else if (attempt.startedAt !== null) throw new TypeError("attempt startedAt is invalid");
        if (expectsFinal) timestamp(attempt.finalizedAt, "attempt finalizedAt");
        else if (attempt.finalizedAt !== null) throw new TypeError("attempt finalizedAt is invalid");
        if (expectsStarted && attempt.startedAt < attempt.createdAt) {
          throw new TypeError("attempt chronology is invalid");
        }
        if (expectsFinal && attempt.finalizedAt < (attempt.startedAt ?? attempt.createdAt)) {
          throw new TypeError("attempt chronology is invalid");
        }
        if (attempt.state === "reconciled") {
          timestamp(attempt.actualInputTokens, "actualInputTokens");
          timestamp(attempt.actualOutputTokens, "actualOutputTokens");
          timestamp(attempt.actualMicrousd, "actualMicrousd");
          if (attempt.reasonCode !== null) throw new TypeError("reasonCode is invalid");
        } else {
          if (
            attempt.actualInputTokens !== null ||
            attempt.actualOutputTokens !== null ||
            attempt.actualMicrousd !== null
          ) {
            throw new TypeError("actual usage is invalid");
          }
          if (["released", "usage_unknown"].includes(attempt.state)) {
            text(attempt.reasonCode, "reasonCode", 128);
          } else if (attempt.reasonCode !== null) {
            throw new TypeError("reasonCode is invalid");
          }
        }
        return attempt;
      });
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
      error.cause = cause;
      throw error;
    }
  }

  _loadDurableState(job) {
    const input = this._validateBoundInput(
      job,
      this.memoryRepository.getDailyDigestInput(job.digest_input_id)
    );
    const recoverable = this.memoryRepository.getRecoverableDailyDigestCandidateByJob(job.id);
    const candidates = recoverable === null ? [] : this._validateCandidates([recoverable]);
    const attempts = this._validateAttempts(
      job,
      this.budgetGuard.listAttemptDispositionsByJob({
        jobId: job.id,
        provider: "minimax",
        operation: "daily_digest",
      })
    );
    return { input, candidates, attempts };
  }

  _matchingCandidate(job, input, candidates) {
    const matching = candidates.filter((candidate) => candidate.jobId === job.id);
    if (matching.length > 1) throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
    const candidate = matching[0];
    if (!candidate) return null;
    if (
      candidate.digestInputId !== input.digestInputId ||
      candidate.jobState !== "running" ||
      candidate.leaseOwner !== job.lease_owner ||
      candidate.leaseExpiresAt !== job.lease_expires_at ||
      candidate.budgetState !== "reconciled"
    ) {
      throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
    }
    return candidate;
  }

  _requireBudgetTransition(result, { requestId, state, replayed }) {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result.ok !== true ||
      result.requestId !== requestId ||
      result.state !== state ||
      (replayed !== undefined && result.replayed !== replayed)
    ) {
      throw codedError("DAILY_DIGEST_BUDGET_TRANSITION_INVALID");
    }
    return result;
  }

  _complete(jobId) {
    if (
      this.store.completeJob(jobId, {
        owner: this.owner,
        at: this._at(),
        executionDevice: "cloud",
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _defer(jobId, reason, { preserveManualRetry = false } = {}) {
    const at = this._at();
    if (
      this.store.deferJob(jobId, {
        owner: this.owner,
        at,
        nextRetryAt: at + 15_000,
        reason,
        preserveManualRetry,
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

  _supersede(jobId) {
    if (
      this.store.supersedeDailyDigestJob(jobId, {
        owner: this.owner,
        at: this._at(),
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
  }

  _decision(job, input) {
    let decision;
    try {
      decision = this.admit(job, input);
      exactPlainObject(decision, ["eligible", "reason"], "daily digest admission");
      if (
        !Object.isFrozen(decision) ||
        typeof decision.eligible !== "boolean" ||
        (decision.reason !== null &&
          (typeof decision.reason !== "string" ||
            !decision.reason.trim() ||
            decision.reason !== decision.reason.trim())) ||
        (decision.eligible && decision.reason !== null) ||
        (!decision.eligible && decision.reason === null)
      ) {
        throw new TypeError("daily digest admission is invalid");
      }
      return decision;
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_ADMISSION_INVALID");
      error.cause = cause;
      throw error;
    }
  }

  _preparePriorAttempt(job, attempts) {
    const latest = attempts.at(-1);
    if (!latest) return { attemptNumber: 1 };
    const attemptNumber = latest.attemptNumber + 1;
    if (!Number.isSafeInteger(attemptNumber)) {
      throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
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
      this._block(job.id, "daily_digest_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }
    if (latest.state === "usage_unknown") {
      if (
        job.error_code === "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED" &&
        this.budgetGuard.getStatus?.({})?.mode === "unlimited"
      ) {
        return { attemptNumber };
      }
      this._block(job.id, "daily_digest_usage_unknown");
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
      if (job.error_code === "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED") {
        return { attemptNumber };
      }
      this._block(job.id, "daily_digest_reconciled_without_candidate");
      return { status: "blocked", reason: "reconciled_without_candidate", jobId: job.id };
    }
    if (latest.state === "released") return { attemptNumber };
    throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
  }

  _enqueueCurrentInput(current) {
    if (current.status === "empty") return;
    this.store.enqueueDailyDigestJob({
      digestInputId: current.digestInputId,
      inputHash: current.sourceHash,
      inputVersion: 1,
      modelVersion: this.modelVersion,
    });
  }

  _rebuildCurrentInput(storedInput) {
    const rebuilt = this.memoryRepository.createDailyDigestInput({
      localDate: storedInput.localDate,
      timezone: storedInput.timezone,
      modelVersion: this.modelVersion,
    });
    if (
      rebuilt &&
      typeof rebuilt === "object" &&
      !Array.isArray(rebuilt) &&
      rebuilt.status === "empty"
    ) {
      try {
        exactPlainObject(rebuilt, ["status", "localDate", "timezone"], "empty daily digest input");
        if (
          rebuilt.localDate !== storedInput.localDate ||
          rebuilt.timezone !== storedInput.timezone
        ) {
          throw new TypeError("empty daily digest source is mismatched");
        }
      } catch (cause) {
        const error = codedError("DAILY_DIGEST_INPUT_CONTRACT_INVALID");
        error.cause = cause;
        throw error;
      }
      return { current: rebuilt, matches: false };
    }
    const current = this._validateInputShape(rebuilt, ["created", "existing"]);
    if (
      current.localDate !== storedInput.localDate ||
      current.timezone !== storedInput.timezone
    ) {
      throw codedError("DAILY_DIGEST_INPUT_CONTRACT_INVALID");
    }
    const matches =
      current.digestInputId === storedInput.digestInputId &&
      current.sourceHash === storedInput.sourceHash &&
      current.completeness === storedInput.completeness;
    return { current, matches };
  }

  _ensureCurrent(job, storedInput, requestId = null) {
    let rebuilt;
    try {
      rebuilt = this._rebuildCurrentInput(storedInput);
    } catch (error) {
      if (requestId !== null) {
        this._requireBudgetTransition(
          this.budgetGuard.release({
            requestId,
            reasonCode: "superseded_before_transport",
          }),
          { requestId, state: "released" }
        );
      }
      throw error;
    }
    if (rebuilt.matches) return true;
    if (requestId !== null) {
      this._requireBudgetTransition(
        this.budgetGuard.release({
          requestId,
          reasonCode: "superseded_before_transport",
        }),
        { requestId, state: "released" }
      );
    }
    this._enqueueCurrentInput(rebuilt.current);
    this._supersede(job.id);
    return false;
  }

  _ensureCurrentOrBlock(job, storedInput, requestId = null) {
    try {
      return this._ensureCurrent(job, storedInput, requestId) ? "current" : "superseded";
    } catch (error) {
      if (error?.code !== "DAILY_DIGEST_EVIDENCE_OUT_OF_SCOPE") throw error;
      this._block(job.id, "daily_digest_evidence_out_of_scope");
      return "blocked";
    }
  }

  _validateResponse(response) {
    const exceedsByteLimit =
      (Number.isSafeInteger(response?.requestBytes) &&
        response.requestBytes > DEFAULT_DAILY_DIGEST_REQUEST_BYTES) ||
      (Number.isSafeInteger(response?.responseBytes) &&
        response.responseBytes > MAX_DAILY_DIGEST_RESPONSE_BYTES);
    const authoritativeUsage = exceedsByteLimit ? null : usage(response?.usage);
    try {
      exactPlainObject(
        response,
        ["result", "usage", "requestBytes", "responseBytes"],
        "daily digest client response"
      );
      if (
        !authoritativeUsage ||
        !Number.isSafeInteger(response.requestBytes) ||
        response.requestBytes < 1 ||
        response.requestBytes > DEFAULT_DAILY_DIGEST_REQUEST_BYTES ||
        !Number.isSafeInteger(response.responseBytes) ||
        response.responseBytes < 1 ||
        response.responseBytes > MAX_DAILY_DIGEST_RESPONSE_BYTES
      ) {
        throw new TypeError("daily digest response metadata is invalid");
      }
      jsonObject(response.result, "daily digest result");
      return { result: response.result, usage: authoritativeUsage };
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_RESPONSE_INVALID");
      error.cause = cause;
      error.authoritativeUsage = authoritativeUsage;
      throw error;
    }
  }

  _reconcile(requestId, authoritativeUsage) {
    return this._requireBudgetTransition(
      this.budgetGuard.reconcile({ requestId, usage: authoritativeUsage }),
      { requestId, state: "reconciled" }
    );
  }

  async execute(claimedJob) {
    const job = this._validateClaimedJob(claimedJob);
    const preserveManualRetry =
      job.error_code === "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED";
    const initial = this._loadDurableState(job);
    const recoverable = this._matchingCandidate(job, initial.input, initial.candidates);
    if (recoverable) {
      return this.recoverCandidate({
        candidateId: recoverable.candidateId,
        jobId: job.id,
        candidateState: recoverable.candidateState,
        leaseOwner: job.lease_owner,
      });
    }
    const prior = this._preparePriorAttempt(job, initial.attempts);
    if (prior.status) return prior;
    const initialFreshness = this._ensureCurrentOrBlock(job, initial.input);
    if (initialFreshness !== "current") {
      return { status: initialFreshness, jobId: job.id };
    }
    const initialDecision = this._decision(job, initial.input);
    if (!initialDecision.eligible) {
      this._defer(job.id, "daily_digest_deferred_for_local_work", {
        preserveManualRetry,
      });
      return { status: "deferred", reason: initialDecision.reason, jobId: job.id };
    }
    if (typeof this.client.isConfigured === "function" && !this.client.isConfigured()) {
      this._defer(job.id, "daily_digest_configuration_required", {
        preserveManualRetry,
      });
      return { status: "deferred", reason: "configuration_required", jobId: job.id };
    }

    const requestId = text(this.createRequestId(), "requestId");
    const reservation = this.budgetGuard.reserveNextAttempt({
      requestId,
      jobId: job.id,
      provider: "minimax",
      model: this.modelVersion,
      operation: "daily_digest",
      estimatedUsage: this.estimatedUsage,
    });
    if (reservation?.ok !== true) {
      try {
        exactPlainObject(reservation, ["ok", "reason"], "budget reservation denial");
        if (reservation.ok !== false) throw new TypeError("reservation denial is invalid");
        text(reservation.reason, "reservation reason", 128);
      } catch (cause) {
        const error = codedError("DAILY_DIGEST_BUDGET_TRANSITION_INVALID");
        error.cause = cause;
        throw error;
      }
      this._defer(job.id, "daily_digest_budget_denied", {
        preserveManualRetry,
      });
      return { status: "deferred", reason: reservation.reason, jobId: job.id };
    }
    try {
      exactPlainObject(
        reservation,
        ["ok", "requestId", "attemptNumber", "state", "reservedMicrousd", "replayed"],
        "budget reservation"
      );
      if (
        reservation.requestId !== requestId ||
        reservation.attemptNumber !== prior.attemptNumber ||
        reservation.state !== "reserved" ||
        reservation.replayed !== false ||
        !Number.isSafeInteger(reservation.reservedMicrousd) ||
        reservation.reservedMicrousd < 0
      ) {
        throw new TypeError("budget reservation is invalid");
      }
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_BUDGET_TRANSITION_INVALID");
      error.cause = cause;
      throw error;
    }

    let reloadedInput;
    try {
      reloadedInput = this._validateBoundInput(
        job,
        this.memoryRepository.getDailyDigestInput(job.digest_input_id)
      );
    } catch (error) {
      this._requireBudgetTransition(
        this.budgetGuard.release({ requestId, reasonCode: "superseded_before_transport" }),
        { requestId, state: "released" }
      );
      throw error;
    }
    const finalFreshness = this._ensureCurrentOrBlock(job, reloadedInput, requestId);
    if (finalFreshness !== "current") {
      return { status: finalFreshness, jobId: job.id };
    }
    const finalDecision = this._decision(job, reloadedInput);
    if (!finalDecision.eligible) {
      this._requireBudgetTransition(
        this.budgetGuard.release({ requestId, reasonCode: "admission_revoked" }),
        { requestId, state: "released" }
      );
      this._defer(job.id, "daily_digest_deferred_for_local_work", {
        preserveManualRetry,
      });
      return { status: "deferred", reason: finalDecision.reason, jobId: job.id };
    }

    this._requireBudgetTransition(this.budgetGuard.markStarted(requestId), {
      requestId,
      state: "started",
      replayed: false,
    });
    try {
      if (
        this.store.recordJobExecutionDevice(job.id, {
          owner: this.owner,
          at: this._at(),
          executionDevice: "cloud",
        }) !== true
      ) {
        throw codedError("JOB_LEASE_LOST");
      }
    } catch (error) {
      this._requireBudgetTransition(
        this.budgetGuard.markUsageUnknown({
          requestId,
          reasonCode: "process_recovery",
        }),
        { requestId, state: "usage_unknown" }
      );
      throw error;
    }

    let response;
    try {
      response = await this.client.generate({
        cloudPayloadJson: reloadedInput.cloudPayloadJson,
        inputHash: reloadedInput.sourceHash,
      });
    } catch (error) {
      const authoritativeUsage = authoritativeErrorUsage(error);
      if (authoritativeUsage) {
        this._reconcile(requestId, authoritativeUsage);
        if (authoritativeUsage.inputTokens === 0 && authoritativeUsage.outputTokens === 0) {
          this._defer(job.id, "daily_digest_authoritative_zero_usage");
          return { status: "deferred", reason: "authoritative_zero_usage", jobId: job.id };
        }
        this._block(job.id, "daily_digest_invalid_response");
        return { status: "blocked", reason: "invalid_response", jobId: job.id };
      }
      this._requireBudgetTransition(
        this.budgetGuard.markUsageUnknown({
          requestId,
          reasonCode: "transport_ambiguous",
        }),
        { requestId, state: "usage_unknown" }
      );
      this._block(job.id, "daily_digest_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }

    let validated;
    try {
      validated = this._validateResponse(response);
    } catch (error) {
      if (error.authoritativeUsage) {
        this._reconcile(requestId, error.authoritativeUsage);
        this._block(job.id, "daily_digest_invalid_response");
        return { status: "blocked", reason: "invalid_response", jobId: job.id };
      }
      this._requireBudgetTransition(
        this.budgetGuard.markUsageUnknown({ requestId, reasonCode: "usage_invalid" }),
        { requestId, state: "usage_unknown" }
      );
      this._block(job.id, "daily_digest_usage_unknown");
      return { status: "blocked", reason: "usage_unknown", jobId: job.id };
    }

    this._reconcile(requestId, validated.usage);
    const persisted = this.memoryRepository.persistValidatedDailyDigestCandidate({
      jobId: job.id,
      digestInputId: job.digest_input_id,
      budgetAttemptId: requestId,
      candidate: validated.result,
    });
    try {
      exactPlainObject(
        persisted,
        ["status", "candidateId", "candidateHash", "state"],
        "persisted daily digest candidate"
      );
      if (
        !new Set(["created", "existing"]).has(persisted.status) ||
        !CANDIDATE_STATES.has(persisted.state) ||
        !HASH_PATTERN.test(persisted.candidateHash)
      ) {
        throw new TypeError("persisted candidate status is invalid");
      }
      text(persisted.candidateId, "candidateId");
    } catch (cause) {
      const error = codedError("DAILY_DIGEST_CANDIDATE_PERSIST_INVALID");
      error.cause = cause;
      throw error;
    }
    const applied = this.memoryRepository.applyValidatedDailyDigestCandidate({
      candidateId: persisted.candidateId,
      leaseOwner: this.owner,
    });
    if (
      !applied ||
      typeof applied !== "object" ||
      Array.isArray(applied) ||
      !APPLY_STATES.has(applied.status) ||
      typeof applied.candidateId !== "string"
    ) {
      throw codedError("DAILY_DIGEST_CANDIDATE_APPLY_INVALID");
    }
    if (applied.candidateId !== persisted.candidateId) {
      throw codedError("DAILY_DIGEST_CANDIDATE_ID_MISMATCH");
    }
    if (applied.jobId !== job.id) {
      throw codedError("DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    }
    if (applied.status === "superseded") this._supersede(job.id);
    else this._complete(job.id);
    return { status: applied.status, jobId: job.id };
  }

  recoverCandidate(input) {
    exactPlainObject(
      input,
      ["candidateId", "jobId", "candidateState", "leaseOwner"],
      "daily digest candidate recovery"
    );
    const candidateId = text(input.candidateId, "candidateId");
    const jobId = text(input.jobId, "jobId");
    if (!CANDIDATE_STATES.has(input.candidateState)) {
      throw new TypeError("candidateState must be validated, applied, or superseded");
    }
    const leaseOwner = text(input.leaseOwner, "leaseOwner");
    if (leaseOwner !== this.owner) throw codedError("JOB_LEASE_LOST");
    const durable = this.memoryRepository.getRecoverableDailyDigestCandidateByJob(jobId);
    if (durable === null) throw codedError("DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    const [recovery] = this._validateCandidates([durable]);
    if (recovery.candidateId !== candidateId) {
      throw codedError("DAILY_DIGEST_CANDIDATE_ID_MISMATCH");
    }
    if (
      recovery.jobId !== jobId ||
      recovery.candidateState !== input.candidateState ||
      recovery.jobState !== "running" ||
      recovery.leaseOwner !== leaseOwner ||
      recovery.leaseExpiresAt === null ||
      recovery.leaseExpiresAt <= this._at() ||
      recovery.budgetState !== "reconciled"
    ) {
      throw codedError("DAILY_DIGEST_DURABLE_STATE_INVALID");
    }
    const applied = this.memoryRepository.applyValidatedDailyDigestCandidate({
      candidateId,
      leaseOwner,
    });
    if (
      !applied ||
      typeof applied !== "object" ||
      Array.isArray(applied) ||
      !APPLY_STATES.has(applied.status) ||
      typeof applied.candidateId !== "string"
    ) {
      throw codedError("DAILY_DIGEST_CANDIDATE_RECOVERY_INVALID");
    }
    if (applied.candidateId !== candidateId) {
      throw codedError("DAILY_DIGEST_CANDIDATE_ID_MISMATCH");
    }
    if (applied.jobId !== jobId) {
      throw codedError("DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    }
    if (applied.status === "superseded") this._supersede(jobId);
    else this._complete(jobId);
    return { status: applied.status, jobId, candidateId };
  }
}

module.exports = DailyDigestService;
