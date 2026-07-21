class OnDemandModelRuntime {
  constructor({
    load,
    unload,
    unloadDelayMs = 5 * 60_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    if (typeof load !== "function" || typeof unload !== "function") {
      throw new TypeError("load and unload must be functions");
    }
    if (!Number.isSafeInteger(unloadDelayMs) || unloadDelayMs < 1_000) {
      throw new RangeError("unloadDelayMs must be at least one second");
    }
    if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
      throw new TypeError("timer functions are required");
    }
    this.load = load;
    this.unload = unload;
    this.unloadDelayMs = unloadDelayMs;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.instance = null;
    this.loading = null;
    this.active = 0;
    this.releaseTimer = null;
  }

  _cancelRelease() {
    if (this.releaseTimer !== null) this.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  async _acquire(loadContext) {
    this._cancelRelease();
    if (this.instance !== null) return this.instance;
    if (this.loading === null) {
      const loading = Promise.resolve().then(() => this.load(loadContext));
      this.loading = loading;
      try {
        const instance = await loading;
        if (instance === null || instance === undefined) {
          throw new Error("model runtime loader returned no instance");
        }
        this.instance = instance;
      } finally {
        if (this.loading === loading) this.loading = null;
      }
    } else {
      await this.loading;
    }
    return this.instance;
  }

  _scheduleRelease() {
    if (this.active !== 0 || this.instance === null) return;
    this._cancelRelease();
    this.releaseTimer = this.setTimeout(async () => {
      this.releaseTimer = null;
      if (this.active !== 0 || this.instance === null) return;
      const instance = this.instance;
      this.instance = null;
      await this.unload(instance);
    }, this.unloadDelayMs);
    this.releaseTimer?.unref?.();
  }

  async run(operation, loadContext = null) {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const instance = await this._acquire(loadContext);
    this.active += 1;
    try {
      return await operation(instance);
    } finally {
      this.active -= 1;
      this._scheduleRelease();
    }
  }

  async dispose() {
    this._cancelRelease();
    if (this.loading !== null) await this.loading.catch(() => {});
    const instance = this.instance;
    this.instance = null;
    if (instance !== null) await this.unload(instance);
  }

  status() {
    return Object.freeze({
      loaded: this.instance !== null,
      loading: this.loading !== null,
      active: this.active,
      unloadScheduled: this.releaseTimer !== null,
      unloadDelayMs: this.unloadDelayMs,
    });
  }

  ownedPids() {
    const pid = this.instance?.getPid?.();
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  }
}

module.exports = OnDemandModelRuntime;
