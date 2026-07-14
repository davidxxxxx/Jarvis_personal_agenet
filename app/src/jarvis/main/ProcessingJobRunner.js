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

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultJobKind(job) {
  const queuedState = job.claimed_from_state ?? job.state;
  if (
    queuedState === "retention_urgent" ||
    (job.job_type === "transcribe_chunk" && job.priority === 0)
  ) {
    return "retention_urgent";
  }
  if (
    queuedState === "storage_recovery_compress" ||
    (job.job_type === "compress_chunk" && job.priority === 10)
  ) {
    return "storage_recovery_compress";
  }
  if (job.job_type === "transcribe_chunk") return "final_transcription";
  if (job.job_type === "preview_transcription") return "preview";
  if (job.job_type === "speaker") return "speaker";
  if (job.job_type === "analyze_session") return "analysis";
  return "maintenance";
}

class ProcessingJobRunner {
  constructor({
    store,
    owner,
    now = Date.now,
    leaseMs = 60_000,
    retryBaseMs = 1_000,
    retryMaxMs = 60_000,
    governor = null,
    heavyGate = null,
    classifyJob = defaultJobKind,
  } = {}) {
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
    if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs <= 0) {
      throw new RangeError("retryBaseMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs) {
      throw new RangeError("retryMaxMs must be a safe integer at least retryBaseMs");
    }
    if (governor !== null) {
      if (typeof governor.sample !== "function" || typeof governor.admit !== "function") {
        throw new TypeError("governor must implement sample and admit");
      }
      if (typeof store.deferJob !== "function") {
        throw new TypeError("store.deferJob is required with resource governance");
      }
      if (!heavyGate || typeof heavyGate.run !== "function") {
        throw new TypeError("heavyGate.run is required with resource governance");
      }
    }
    if (typeof classifyJob !== "function") throw new TypeError("classifyJob must be a function");

    this.store = store;
    this.owner = owner;
    this.now = now;
    this.leaseMs = leaseMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.governor = governor;
    this.heavyGate = heavyGate;
    this.classifyJob = classifyJob;
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

    let context = null;
    let kind = null;
    if (this.governor) {
      kind = this.classifyJob(job);
      let snapshot;
      let admission;
      try {
        snapshot = await this.governor.sample();
        admission = this.governor.admit(kind, snapshot);
      } catch {
        admission = { action: "defer", reason: "telemetry_unavailable" };
      }
      if (["defer", "pause_preview"].includes(admission.action)) {
        this.store.deferJob(job.id, {
          owner: this.owner,
          at: this.now(),
          reason: admission.reason,
        });
        return 1;
      }
      const device = admission.action === "run_cuda" ? "cuda" : "cpu";
      context = {
        action: admission.action,
        device,
        cpuThreads: device === "cpu" ? 4 : null,
        lowPriority: device === "cpu",
        selectedGpuUuid: device === "cuda" ? snapshot.selectedGpuUuid : null,
      };
    }

    try {
      const invoke = () => handler(job, context);
      const result = this.heavyGate ? await this.heavyGate.run(kind, invoke) : await invoke();
      const executionDevice = context ? result?.executionDevice : null;
      if (context && executionDevice !== context.device) {
        throw codedError("EXECUTION_DEVICE_MISMATCH");
      }
      this.store.completeJob(job.id, {
        owner: this.owner,
        at: this.now(),
        executionDevice,
      });
    } catch (error) {
      const errorCode = normalizeErrorCode(error);
      const failedAt = this.now();
      const exponent = Math.max(0, Math.min(30, (job.attempt_count ?? 1) - 1));
      const retryDelay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
      const nextRetryAt = Math.min(Number.MAX_SAFE_INTEGER, failedAt + retryDelay);
      this.store.retryJob(job.id, {
        owner: this.owner,
        at: failedAt,
        nextRetryAt,
        errorCode,
      });
    }
    return 1;
  }
}

module.exports = ProcessingJobRunner;
