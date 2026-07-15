const { assertId } = require("../shared/contracts");

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

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("dispatcher clock must return a non-negative safe integer");
  }
  return value;
}

class AgentCloudDispatcher {
  constructor({
    store,
    worker,
    recoverIncompleteBudgetAttempts,
    owner,
    now = Date.now,
    leaseMs = 120_000,
    recoveryLimit = 100,
  } = {}) {
    for (const method of [
      "recoverExpiredCloudCandidateLeases",
      "recoverExpiredCloudPrestartLeases",
      "claimCloudJobs",
    ]) {
      requiredMethod(store, method, "store");
    }
    for (const method of ["recoverCandidate", "execute"]) {
      requiredMethod(worker, method, "worker");
    }
    if (typeof recoverIncompleteBudgetAttempts !== "function") {
      throw new TypeError("recoverIncompleteBudgetAttempts must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.store = store;
    this.worker = worker;
    this.recoverIncompleteBudgetAttempts = recoverIncompleteBudgetAttempts;
    this.owner = assertId(owner, "owner");
    this.now = now;
    this.leaseMs = positiveSafeInteger(leaseMs, "leaseMs");
    this.recoveryLimit = positiveSafeInteger(recoveryLimit, "recoveryLimit");
    if (this.recoveryLimit > 1_000) throw new RangeError("recoveryLimit must not exceed 1000");
    this.inFlight = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.recoveryInFlight = null;
    this.recoveryReady = false;
    this.stopping = false;
  }

  _now() {
    return timestamp(this.now());
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopping) return Promise.resolve(0);
    const operation = this.drainOnce();
    const wrapped = operation.catch((error) => {
      if (this.startPromise === wrapped) this.startPromise = null;
      throw error;
    });
    this.startPromise = wrapped;
    return wrapped;
  }

  drainOnce() {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const operation = this._gatedDrain();
    const wrapped = operation.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = null;
    });
    this.inFlight = wrapped;
    return wrapped;
  }

  _ensureRecoveryReady() {
    if (this.recoveryReady) return Promise.resolve();
    if (this.recoveryInFlight) return this.recoveryInFlight;
    const operation = Promise.resolve()
      .then(() => this.recoverIncompleteBudgetAttempts())
      .then(() => {
        this.recoveryReady = true;
      });
    const wrapped = operation.finally(() => {
      if (this.recoveryInFlight === wrapped) this.recoveryInFlight = null;
    });
    this.recoveryInFlight = wrapped;
    return wrapped;
  }

  async _gatedDrain() {
    await this._ensureRecoveryReady();
    if (this.stopping) return 0;
    return this._drain();
  }

  async _drain() {
    const at = this._now();
    const recoveries = this.store.recoverExpiredCloudCandidateLeases({
      owner: this.owner,
      at,
      leaseMs: this.leaseMs,
      limit: this.recoveryLimit,
    });
    if (!Array.isArray(recoveries)) {
      throw new TypeError("cloud candidate recovery must return an array");
    }
    let processed = 0;
    for (const recovery of recoveries) {
      await this.worker.recoverCandidate(recovery);
      processed += 1;
    }
    if (this.stopping) return processed;
    const prestart = this.store.recoverExpiredCloudPrestartLeases({
      owner: this.owner,
      at: this._now(),
      leaseMs: this.leaseMs,
      limit: 1,
    });
    if (!Array.isArray(prestart) || prestart.length > 1) {
      throw new TypeError("cloud pre-start recovery must return at most one job");
    }
    if (prestart.length === 1) {
      const job = prestart[0];
      if (
        job?.job_type !== "analyze_session" ||
        job?.lane !== "cloud" ||
        job?.state !== "running"
      ) {
        throw new TypeError("pre-start recovery returned a non-analysis cloud job");
      }
      await this.worker.execute(job);
      return processed + 1;
    }
    const claimed = this.store.claimCloudJobs({
      owner: this.owner,
      at: this._now(),
      leaseMs: this.leaseMs,
      limit: 1,
      priorityBefore: 71,
    });
    if (!Array.isArray(claimed) || claimed.length > 1) {
      throw new TypeError("cloud claim must return at most one job");
    }
    if (claimed.length === 0) return processed;
    const job = claimed[0];
    if (job?.job_type !== "analyze_session" || job?.lane !== "cloud") {
      throw new TypeError("dispatcher claimed a non-analysis cloud job");
    }
    await this.worker.execute(job);
    return processed + 1;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const active = this.inFlight;
    this.stopPromise = Promise.resolve(active).then(() => undefined);
    return this.stopPromise;
  }
}

module.exports = AgentCloudDispatcher;
