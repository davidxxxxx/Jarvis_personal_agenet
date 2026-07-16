const CANDIDATE_STATES = new Set(["validated", "applied", "superseded"]);
const APPLY_STATES = new Set(["applied", "already_applied", "superseded"]);
const REGENERATE_WAKE_STATES = new Set(["pending", "retry"]);

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

class DailyDigestService {
  constructor(input) {
    exactPlainObject(
      input,
      ["memoryRepository", "store", "modelVersion", "timezoneProvider", "now", "owner"],
      "daily digest service dependencies"
    );
    for (const method of [
      "createDailyDigestInput",
      "getLatestDailyDigest",
      "applyValidatedDailyDigestCandidate",
    ]) {
      if (typeof input.memoryRepository?.[method] !== "function") {
        throw new TypeError(`memoryRepository.${method} must be a function`);
      }
    }
    for (const method of ["enqueueDailyDigestJob", "wakeDailyDigestJob", "completeJob"]) {
      if (typeof input.store?.[method] !== "function") {
        throw new TypeError(`store.${method} must be a function`);
      }
    }
    if (typeof input.timezoneProvider !== "function") {
      throw new TypeError("timezoneProvider must be a function");
    }
    if (typeof input.now !== "function") throw new TypeError("now must be a function");
    this.memoryRepository = input.memoryRepository;
    this.store = input.store;
    this.modelVersion = text(input.modelVersion, "modelVersion", 128);
    this.timezoneProvider = input.timezoneProvider;
    this.now = input.now;
    this.owner = text(input.owner, "owner");
  }

  _localDateInput(input, name) {
    exactPlainObject(input, ["localDate"], name);
    return text(input.localDate, "localDate", 10);
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

  regenerate(input) {
    this._localDateInput(input, "daily digest regenerate input");
    const prepared = this.prepare(input);
    if (prepared.status === "empty") return prepared;
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
    const applied = this.memoryRepository.applyValidatedDailyDigestCandidate({
      candidateId,
      leaseOwner,
    });
    if (!applied || !APPLY_STATES.has(applied.status)) {
      throw codedError("DAILY_DIGEST_CANDIDATE_RECOVERY_INVALID");
    }
    if (applied.jobId !== jobId) {
      throw codedError("DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    }
    if (
      this.store.completeJob(jobId, {
        owner: leaseOwner,
        at: timestamp(this.now(), "at"),
        executionDevice: "cloud",
      }) !== true
    ) {
      throw codedError("JOB_LEASE_LOST");
    }
    return { status: applied.status, jobId, candidateId };
  }
}

module.exports = DailyDigestService;
