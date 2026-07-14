class HeavyJobGate {
  constructor() {
    this.activeKind = null;
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

  _drain() {
    if (this.activeKind !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    this.activeKind = next.kind;
    void (async () => {
      let result;
      let failure;
      try {
        if (next.signal?.aborted) {
          failure = new DOMException("The operation was aborted", "AbortError");
        } else {
          result = await next.fn();
        }
      } catch (error) {
        failure = error;
      } finally {
        this.activeKind = null;
        this._drain();
      }
      if (failure) next.reject(failure);
      else next.resolve(result);
    })();
  }
}

module.exports = HeavyJobGate;
