const AnalysisBudgetGuard = require("./AnalysisBudgetGuard");
const { openAnalysisBudgetRepository } = require("./AnalysisBudgetRepository");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class AnalysisBudgetService {
  constructor({
    defaultTimezone,
    now = Date.now,
    isDispatcherStopped = () => false,
    openRepository = openAnalysisBudgetRepository,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof isDispatcherStopped !== "function") {
      throw new TypeError("isDispatcherStopped must be a function");
    }
    if (typeof openRepository !== "function") {
      throw new TypeError("openRepository must be a function");
    }
    this.defaultTimezone = defaultTimezone;
    this.now = now;
    this.isDispatcherStopped = isDispatcherStopped;
    this.openRepository = openRepository;
    this.repository = null;
    this.guard = null;
  }

  _open(databasePath) {
    const repository = this.openRepository(databasePath);
    if (!repository || typeof repository.close !== "function") {
      throw new TypeError("openRepository must return a closeable analysis budget repository");
    }
    try {
      const guard = new AnalysisBudgetGuard({
        repository,
        defaultTimezone: this.defaultTimezone,
        now: this.now,
      });
      const status = guard.initialize();
      this.repository = repository;
      this.guard = guard;
      return status;
    } catch (error) {
      repository.close();
      throw error;
    }
  }

  open(databasePath) {
    if (this.guard) throw codedError("ANALYSIS_BUDGET_SERVICE_ALREADY_OPEN");
    return this._open(databasePath);
  }

  reopen(databasePath) {
    this._requireGuard();
    this.close();
    return this._open(databasePath);
  }

  close() {
    const repository = this.repository;
    this.repository = null;
    this.guard = null;
    repository?.close();
  }

  _requireGuard() {
    if (!this.guard) throw codedError("ANALYSIS_BUDGET_SERVICE_CLOSED");
    return this.guard;
  }

  getStatus(options) {
    return this._requireGuard().getStatus(options);
  }

  setPolicy(input) {
    return this._requireGuard().setPolicy(input);
  }

  reserve(input) {
    return this._requireGuard().reserve(input);
  }

  markStarted(requestId) {
    return this._requireGuard().markStarted(requestId);
  }

  reconcile(input) {
    return this._requireGuard().reconcile(input);
  }

  release(input) {
    return this._requireGuard().release(input);
  }

  markUsageUnknown(input) {
    return this._requireGuard().markUsageUnknown(input);
  }

  recoverIncompleteAttempts(options) {
    const guard = this._requireGuard();
    if (this.isDispatcherStopped() !== true) {
      throw codedError("ANALYSIS_BUDGET_RECOVERY_REQUIRES_STOPPED_DISPATCHER");
    }
    return guard.recoverIncompleteAttempts(options);
  }
}

module.exports = AnalysisBudgetService;
