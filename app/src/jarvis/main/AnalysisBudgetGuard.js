const { assertId } = require("../shared/contracts");
const { assertCanonicalIanaTimezone } = require("./ZonedCalendar");
const {
  DEFAULT_MONTHLY_LIMIT_MICROUSD,
  MAX_MONTHLY_LIMIT_MICROUSD,
  BUDGET_MODES,
} = require("./AnalysisBudgetRepository");

const OPERATIONS = new Set([
  "session_analysis",
  "daily_digest",
  "activity_classification",
]);
const RELEASE_REASON_CODES = new Set([
  "local_preflight_failed",
  "admission_revoked",
  "shutdown_before_transport",
  "superseded_before_transport",
  "client_contract_error",
]);
const USAGE_UNKNOWN_REASON_CODES = new Set([
  "transport_ambiguous",
  "usage_missing",
  "usage_invalid",
  "process_recovery",
  "shutdown_after_transport",
]);
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_TEXT_CODE_POINTS = 128;

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown key: ${key}`);
  }
}

function assertRequiredKeys(value, required, name) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name} is missing required key: ${key}`);
    }
  }
}

function assertTimestamp(value, name = "at") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertMonthlyLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONTHLY_LIMIT_MICROUSD) {
    throw new TypeError(
      `monthlyLimitMicrousd must be a safe integer from 0 to ${MAX_MONTHLY_LIMIT_MICROUSD}`
    );
  }
  return value;
}

function normalizeMode(value, monthlyLimitMicrousd) {
  const mode = value ?? (monthlyLimitMicrousd === 0 ? "off" : "capped");
  if (!BUDGET_MODES.has(mode)) throw new TypeError("mode must be off, capped, or unlimited");
  if (mode === "off" && monthlyLimitMicrousd !== 0) {
    throw new TypeError("off mode requires a zero monthly limit");
  }
  return mode;
}

function assertBoundedText(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    Array.from(value).length > MAX_TEXT_CODE_POINTS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function assertTokenCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKEN_COUNT) {
    throw new TypeError(`${name} must be a safe integer from 0 to ${MAX_TOKEN_COUNT}`);
  }
  return value;
}

function normalizeUsage(value, name) {
  assertPlainObject(value, name);
  const keys = new Set(["inputTokens", "outputTokens"]);
  assertExactKeys(value, keys, name);
  assertRequiredKeys(value, keys, name);
  return {
    inputTokens: assertTokenCount(value.inputTokens, `${name}.inputTokens`),
    outputTokens: assertTokenCount(value.outputTokens, `${name}.outputTokens`),
  };
}

class AnalysisBudgetGuard {
  constructor({ repository, now = Date.now, defaultTimezone } = {}) {
    for (const method of [
      "initialize",
      "getStatus",
      "setPolicy",
      "reserve",
      "markStarted",
      "reconcile",
      "release",
      "markUsageUnknown",
      "recover",
    ]) {
      if (!repository || typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} must be a function`);
      }
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.repository = repository;
    this.now = now;
    this.defaultTimezone = assertCanonicalIanaTimezone(defaultTimezone);
  }

  _now() {
    return assertTimestamp(this.now());
  }

  _invokeOptionalRepositoryMethod(method, ...args) {
    if (typeof this.repository[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
    return this.repository[method](...args);
  }

  initialize() {
    return this.repository.initialize({
      mode: "capped",
      monthlyLimitMicrousd: DEFAULT_MONTHLY_LIMIT_MICROUSD,
      timezone: this.defaultTimezone,
      at: this._now(),
    });
  }

  getStatus(options = {}) {
    assertPlainObject(options, "status options");
    const keys = new Set(["at"]);
    assertExactKeys(options, keys, "status options");
    const at = Object.prototype.hasOwnProperty.call(options, "at")
      ? assertTimestamp(options.at)
      : this._now();
    return this.repository.getStatus({ at });
  }

  setPolicy(input) {
    assertPlainObject(input, "policy input");
    const allowed = new Set(["mode", "monthlyLimitMicrousd", "timezone"]);
    const required = new Set(["monthlyLimitMicrousd", "timezone"]);
    assertExactKeys(input, allowed, "policy input");
    assertRequiredKeys(input, required, "policy input");
    const monthlyLimitMicrousd = assertMonthlyLimit(input.monthlyLimitMicrousd);
    return this.repository.setPolicy({
      mode: normalizeMode(input.mode, monthlyLimitMicrousd),
      monthlyLimitMicrousd,
      timezone: assertCanonicalIanaTimezone(input.timezone),
      at: this._now(),
    });
  }

  reserve(input) {
    return this.repository.reserve({
      ...this._normalizeReservation(input, { includeAttemptNumber: true }),
      at: this._now(),
    });
  }

  reserveNextAttempt(input) {
    return this._invokeOptionalRepositoryMethod("reserveNextAttempt", {
      ...this._normalizeReservation(input),
      at: this._now(),
    });
  }

  _normalizeReservation(input, { includeAttemptNumber = false } = {}) {
    assertPlainObject(input, "reservation input");
    const keys = new Set([
      "requestId",
      "jobId",
      "provider",
      "model",
      "operation",
      "estimatedUsage",
    ]);
    if (includeAttemptNumber) keys.add("attemptNumber");
    assertExactKeys(input, keys, "reservation input");
    assertRequiredKeys(input, keys, "reservation input");
    if (
      includeAttemptNumber &&
      (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1)
    ) {
      throw new TypeError("attemptNumber must be a positive safe integer");
    }
    if (!OPERATIONS.has(input.operation)) {
      throw new TypeError(
        "operation must be session_analysis, daily_digest, or activity_classification"
      );
    }
    return {
      requestId: assertId(input.requestId, "requestId"),
      jobId: assertId(input.jobId, "jobId"),
      ...(includeAttemptNumber ? { attemptNumber: input.attemptNumber } : {}),
      provider: assertBoundedText(input.provider, "provider"),
      model: assertBoundedText(input.model, "model"),
      operation: input.operation,
      estimatedUsage: normalizeUsage(input.estimatedUsage, "estimatedUsage"),
    };
  }

  getAttemptDispositionByRequestId(requestId) {
    return this._invokeOptionalRepositoryMethod(
      "getAttemptDispositionByRequestId",
      assertId(requestId, "requestId")
    );
  }

  listAttemptDispositionsByJob(input) {
    assertPlainObject(input, "job attempt query");
    const keys = new Set(["jobId", "provider", "operation"]);
    assertExactKeys(input, keys, "job attempt query");
    assertRequiredKeys(input, keys, "job attempt query");
    if (!OPERATIONS.has(input.operation)) {
      throw new TypeError(
        "operation must be session_analysis, daily_digest, or activity_classification"
      );
    }
    return this._invokeOptionalRepositoryMethod("listAttemptDispositionsByJob", {
      jobId: assertId(input.jobId, "jobId"),
      provider: assertBoundedText(input.provider, "provider"),
      operation: input.operation,
    });
  }

  listStartupRecoveryDispositions(options = {}) {
    assertPlainObject(options, "startup recovery query");
    assertExactKeys(options, new Set(), "startup recovery query");
    return this._invokeOptionalRepositoryMethod("listStartupRecoveryDispositions");
  }

  markStarted(requestId) {
    return this.repository.markStarted({
      requestId: assertId(requestId, "requestId"),
      at: this._now(),
    });
  }

  reconcile(input) {
    assertPlainObject(input, "reconciliation input");
    const keys = new Set(["requestId", "usage"]);
    assertExactKeys(input, keys, "reconciliation input");
    assertRequiredKeys(input, keys, "reconciliation input");
    return this.repository.reconcile({
      requestId: assertId(input.requestId, "requestId"),
      usage: normalizeUsage(input.usage, "usage"),
      at: this._now(),
    });
  }

  release(input) {
    return this._finalize(input, {
      name: "release input",
      reasonCodes: RELEASE_REASON_CODES,
      repositoryMethod: "release",
    });
  }

  markUsageUnknown(input) {
    return this._finalize(input, {
      name: "usage unknown input",
      reasonCodes: USAGE_UNKNOWN_REASON_CODES,
      repositoryMethod: "markUsageUnknown",
    });
  }

  _finalize(input, { name, reasonCodes, repositoryMethod }) {
    assertPlainObject(input, name);
    const keys = new Set(["requestId", "reasonCode"]);
    assertExactKeys(input, keys, name);
    assertRequiredKeys(input, keys, name);
    if (!reasonCodes.has(input.reasonCode)) {
      throw new TypeError(`${name}.reasonCode is invalid`);
    }
    return this.repository[repositoryMethod]({
      requestId: assertId(input.requestId, "requestId"),
      reasonCode: input.reasonCode,
      at: this._now(),
    });
  }

  recoverIncompleteAttempts(options = {}) {
    assertPlainObject(options, "recovery options");
    const keys = new Set(["at"]);
    assertExactKeys(options, keys, "recovery options");
    const at = Object.prototype.hasOwnProperty.call(options, "at")
      ? assertTimestamp(options.at)
      : this._now();
    return this.repository.recover({ at });
  }

  recover(options = {}) {
    return this.recoverIncompleteAttempts(options);
  }
}

module.exports = AnalysisBudgetGuard;
module.exports.OPERATIONS = OPERATIONS;
module.exports.RELEASE_REASON_CODES = RELEASE_REASON_CODES;
module.exports.USAGE_UNKNOWN_REASON_CODES = USAGE_UNKNOWN_REASON_CODES;
