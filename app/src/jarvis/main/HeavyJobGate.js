const { JOB_PRIORITY } = require("./ResourceGovernor");

class HeavyJobGate {
  constructor() {
    this.activeKind = null;
    this.activePermit = null;
    this.runningWithinPermit = false;
    this.queue = [];
  }

  run(kind, fn, { signal } = {}) {
    if (typeof kind !== "string" || !kind) throw new TypeError("kind must be a non-empty string");
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, fn, resolve, reject, signal });
      this._drain();
    });
  }

  getState() {
    return { activeKind: this.activeKind, queueLength: this.queue.length };
  }

  assertActivePermit(permit) {
    if (permit === null || typeof permit !== "object" || permit !== this.activePermit) {
      throw new Error("heavy-job permit is not active");
    }
    return permit;
  }

  async runWithinPermit(permit, kind, fn) {
    this.assertActivePermit(permit);
    if (typeof kind !== "string" || !kind) throw new TypeError("kind must be a non-empty string");
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    const outerKind = this.activeKind;
    const outerPriority = JOB_PRIORITY[outerKind] ?? Number.MAX_SAFE_INTEGER;
    const innerPriority = JOB_PRIORITY[kind] ?? Number.MAX_SAFE_INTEGER;
    if (this.runningWithinPermit) {
      throw new Error("heavy-job permit work is already running");
    }
    if (innerPriority >= outerPriority) {
      throw new Error("work inside a heavy-job permit must have higher priority");
    }
    this.runningWithinPermit = true;
    this.activeKind = kind;
    try {
      return await fn();
    } finally {
      this.activeKind = outerKind;
      this.runningWithinPermit = false;
      this.assertActivePermit(permit);
    }
  }

  _drain() {
    if (this.activeKind !== null) return;
    let nextIndex = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      const nextPriority = JOB_PRIORITY[this.queue[index].kind] ?? Number.MAX_SAFE_INTEGER;
      const selectedPriority = JOB_PRIORITY[this.queue[nextIndex].kind] ?? Number.MAX_SAFE_INTEGER;
      if (nextPriority < selectedPriority) nextIndex = index;
    }
    const [next] = this.queue.splice(nextIndex, 1);
    if (!next) return;
    this.activeKind = next.kind;
    const permit = Object.freeze({});
    this.activePermit = permit;
    void (async () => {
      let result;
      let failure;
      try {
        if (next.signal?.aborted) {
          failure = new DOMException("The operation was aborted", "AbortError");
        } else {
          result = await next.fn(permit);
        }
      } catch (error) {
        failure = error;
      } finally {
        this.activePermit = null;
        this.activeKind = null;
        this._drain();
      }
      if (failure) next.reject(failure);
      else next.resolve(result);
    })();
  }
}

module.exports = HeavyJobGate;
