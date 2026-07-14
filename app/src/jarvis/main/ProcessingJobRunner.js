const ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeErrorCode(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "JOB_FAILED";
  }
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : "JOB_FAILED";
}

class ProcessingJobRunner {
  constructor({ store, owner, now = Date.now, leaseMs = 60_000 } = {}) {
    const requiredMethods = [
      "claimJobs",
      "recoverExpiredLeases",
      "completeJob",
      "retryJob",
      "blockJob",
    ];
    if (!store || requiredMethods.some((method) => typeof store[method] !== "function")) {
      throw new TypeError("store must implement the durable processing-job lease interface");
    }
    if (typeof owner !== "string" || !ERROR_CODE_PATTERN.test(owner)) {
      throw new TypeError("owner must be a safe identifier");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new RangeError("leaseMs must be a positive safe integer");
    }

    this.store = store;
    this.owner = owner;
    this.now = now;
    this.leaseMs = leaseMs;
    this.handlers = new Map();
  }

  register(jobType, handler) {
    if (typeof jobType !== "string" || !ERROR_CODE_PATTERN.test(jobType)) {
      throw new TypeError("jobType must be a safe identifier");
    }
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.handlers.set(jobType, handler);
    return this;
  }

  recoverExpiredLeases(at = this.now()) {
    return this.store.recoverExpiredLeases(at);
  }

  async runOnce(at = this.now()) {
    this.recoverExpiredLeases(at);
    const [job] = this.store.claimJobs({
      owner: this.owner,
      at,
      leaseMs: this.leaseMs,
      limit: 1,
    });
    if (!job) return 0;

    const handler = this.handlers.get(job.job_type);
    if (!handler) {
      this.store.blockJob(job.id, {
        owner: this.owner,
        at: this.now(),
        errorCode: "HANDLER_MISSING",
      });
      return 1;
    }

    try {
      await handler(job);
      this.store.completeJob(job.id, { owner: this.owner, at: this.now() });
    } catch (error) {
      const errorCode = normalizeErrorCode(error);
      const failedAt = this.now();
      this.store.retryJob(job.id, {
        owner: this.owner,
        at: failedAt,
        nextRetryAt: failedAt,
        errorCode,
      });
    }
    return 1;
  }
}

module.exports = ProcessingJobRunner;
