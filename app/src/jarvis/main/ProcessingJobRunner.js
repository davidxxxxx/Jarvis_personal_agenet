const ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_OBSOLETE_ERRORS = new Set([
  "DIARIZATION_STALE_INPUT",
  "DIARIZATION_AUDIO_EXPIRED",
  "DIARIZATION_SUPERSEDED",
  "IDENTITY_RESOLUTION_STALE_INPUT",
  "IDENTITY_RESOLUTION_SUPERSEDED",
]);
const LONG_DEPENDENCY_DEFERRALS = new Set([
  "diarization_runtime_unavailable",
  "diarization_model_unavailable",
]);

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
  if (["speaker", "diarize_track", "resolve_identities"].includes(job.job_type)) return "speaker";
  if (job.job_type === "analyze_session") return "analysis";
  return "maintenance";
}

function defaultJobCapability(job) {
  return ["diarize_track", "resolve_identities"].includes(job.job_type)
    ? { executionDevice: "cpu" }
    : undefined;
}

class ProcessingJobRunner {
  constructor({
    store,
    owner,
    now = Date.now,
    leaseMs = 60_000,
    retryBaseMs = 1_000,
    retryMaxMs = 60_000,
    dependencyRetryMs = 30 * 60_000,
    governor = null,
    heavyGate = null,
    classifyJob = defaultJobKind,
    classifyCapability = defaultJobCapability,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    const requiredMethods = [
      "claimJobs",
      "recoverExpiredLeases",
      "renewJobLease",
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
    if (!Number.isSafeInteger(dependencyRetryMs) || dependencyRetryMs < 60_000) {
      throw new RangeError("dependencyRetryMs must be a safe integer of at least one minute");
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
    if (typeof classifyCapability !== "function") {
      throw new TypeError("classifyCapability must be a function");
    }
    if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
      throw new TypeError("interval functions are required");
    }

    this.store = store;
    this.owner = owner;
    this.now = now;
    this.leaseMs = leaseMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.dependencyRetryMs = dependencyRetryMs;
    this.governor = governor;
    this.heavyGate = heavyGate;
    this.classifyJob = classifyJob;
    this.classifyCapability = classifyCapability;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
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

  async _executeClaimedJob(job, { permit = null } = {}) {
    const handler = this.handlers.get(job.job_type);
    if (!handler) {
      const blocked = this.store.blockJob(job.id, {
        owner: this.owner,
        at: this.now(),
        errorCode: "HANDLER_MISSING",
      });
      if (!blocked) throw codedError("JOB_LEASE_LOST");
      return 1;
    }

    let context = {};
    const kind = this.classifyJob(job);
    const capability = this.classifyCapability(job, kind);
    if (this.governor) {
      let snapshot;
      let admission;
      try {
        snapshot = await this.governor.sample();
        admission = this.governor.admit(kind, snapshot, capability);
      } catch {
        admission = { action: "defer", reason: "telemetry_unavailable" };
      }
      if (["defer", "pause_preview"].includes(admission.action)) {
        const deferredAt = this.now();
        const delay = LONG_DEPENDENCY_DEFERRALS.has(admission.reason)
          ? this.dependencyRetryMs
          : 15_000;
        const deferred = this.store.deferJob(job.id, {
          owner: this.owner,
          at: deferredAt,
          nextRetryAt: Math.min(Number.MAX_SAFE_INTEGER, deferredAt + delay),
          reason: admission.reason,
        });
        if (!deferred) throw codedError("JOB_LEASE_LOST");
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

    let leaseLost = false;
    const renewLease = () => {
      if (leaseLost) throw codedError("JOB_LEASE_LOST");
      const renewed = this.store.renewJobLease(job.id, {
        owner: this.owner,
        at: this.now(),
        leaseMs: this.leaseMs,
      });
      if (!renewed) {
        leaseLost = true;
        throw codedError("JOB_LEASE_LOST");
      }
      return true;
    };
    Object.defineProperty(context, "renewLease", {
      value: renewLease,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const heartbeat = this.setInterval(
      () => {
        try {
          renewLease();
        } catch {
          leaseLost = true;
        }
      },
      Math.max(1, Math.floor(this.leaseMs / 3))
    );
    heartbeat?.unref?.();

    try {
      const invoke = () => handler(job, context);
      let result;
      if (permit !== null) {
        result = await this.heavyGate.runWithinPermit(permit, kind, invoke);
      } else {
        result = this.heavyGate ? await this.heavyGate.run(kind, invoke) : await invoke();
      }
      if (leaseLost) throw codedError("JOB_LEASE_LOST");
      const executionDevice = this.governor ? result?.executionDevice : null;
      if (this.governor && executionDevice !== context.device) {
        throw codedError("EXECUTION_DEVICE_MISMATCH");
      }
      const completed = this.store.completeJob(job.id, {
        owner: this.owner,
        at: this.now(),
        executionDevice,
      });
      if (!completed) throw codedError("JOB_LEASE_LOST");
    } catch (error) {
      if (normalizeErrorCode(error) === "JOB_LEASE_LOST") throw error;
      const errorCode = normalizeErrorCode(error);
      const failedAt = this.now();
      if (
        ["diarize_track", "resolve_identities"].includes(job.job_type) &&
        TERMINAL_OBSOLETE_ERRORS.has(errorCode)
      ) {
        const blocked = this.store.blockJob(job.id, {
          owner: this.owner,
          at: failedAt,
          errorCode,
        });
        if (!blocked) throw codedError("JOB_LEASE_LOST");
        return 1;
      }
      const exponent = Math.max(0, Math.min(30, (job.attempt_count ?? 1) - 1));
      const retryDelay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
      const nextRetryAt = Math.min(Number.MAX_SAFE_INTEGER, failedAt + retryDelay);
      const retried = this.store.retryJob(job.id, {
        owner: this.owner,
        at: failedAt,
        nextRetryAt,
        errorCode,
      });
      if (!retried) throw codedError("JOB_LEASE_LOST");
    } finally {
      this.clearInterval(heartbeat);
    }
    return 1;
  }

  async runOnce(at = this.now(), { priorityBefore = Number.MAX_SAFE_INTEGER } = {}) {
    this.recoverExpiredLeases(at);
    const [job] = this.store.claimJobs({
      owner: this.owner,
      at,
      leaseMs: this.leaseMs,
      limit: 1,
      priorityBefore,
    });
    if (!job) return 0;
    return this._executeClaimedJob(job);
  }

  async drainHigherPriorityWithinPermit(permit, { priorityBefore, at = this.now() } = {}) {
    if (!this.heavyGate || typeof this.heavyGate.assertActivePermit !== "function") {
      throw new Error("an active heavy-job gate is required");
    }
    if (!Number.isSafeInteger(priorityBefore) || priorityBefore <= 0) {
      throw new RangeError("priorityBefore must be a positive safe integer");
    }
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new RangeError("at must be a non-negative safe integer");
    }
    this.heavyGate.assertActivePermit(permit);
    this.recoverExpiredLeases(at);
    let processed = 0;
    for (;;) {
      this.heavyGate.assertActivePermit(permit);
      const claimAt = this.now();
      const [job] = this.store.claimJobs({
        owner: this.owner,
        at: claimAt,
        leaseMs: this.leaseMs,
        limit: 1,
        priorityBefore,
      });
      if (!job) return processed;
      processed += await this._executeClaimedJob(job, { permit });
    }
  }
}

module.exports = ProcessingJobRunner;
