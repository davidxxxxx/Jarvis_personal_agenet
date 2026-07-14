const { randomUUID } = require("node:crypto");

function settleWithin(
  tasks,
  timeoutMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
) {
  const settled = Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeoutImpl(() => resolve({ timedOut: true }), timeoutMs);
    timer?.unref?.();
  });
  return Promise.race([settled, timeout]).finally(() => clearTimeoutImpl(timer));
}

class RendererShutdownHandshake {
  constructor({
    send,
    isAvailable,
    createId = randomUUID,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.send = send;
    this.isAvailable = isAvailable;
    this.createId = createId;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.pending = null;
  }

  request(timeoutMs) {
    if (this.pending) return this.pending.promise;
    if (!this.isAvailable()) return Promise.resolve({ status: "unavailable" });
    const id = this.createId();
    let resolvePending;
    const promise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    const finish = (result) => {
      if (!this.pending || this.pending.id !== id) return;
      this.clearTimeout(this.pending.timer);
      this.pending = null;
      resolvePending(result);
    };
    const timer = this.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    timer?.unref?.();
    this.pending = { id, promise, finish, timer };
    try {
      this.send({ id });
    } catch {
      finish({ status: "send_failed" });
    }
    return promise;
  }

  acknowledge(id, outcome) {
    if (!this.pending || this.pending.id !== id) return false;
    this.pending.finish({ status: "acknowledged", outcome });
    return true;
  }

  markRendererGone() {
    this.pending?.finish({ status: "renderer_gone" });
  }
}

class GracefulShutdownCoordinator {
  constructor({
    requestRendererFlush,
    beginClose,
    stopUpstream = [],
    stopRuntime = [],
    closeWriter,
    closeRepository,
    phaseTimeoutMs = 5_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.requestRendererFlush = requestRendererFlush;
    this.beginClose = beginClose;
    this.stopUpstream = stopUpstream;
    this.stopRuntime = stopRuntime;
    this.closeWriter = closeWriter;
    this.closeRepository = closeRepository;
    this.phaseTimeoutMs = phaseTimeoutMs;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.shutdownPromise = null;
  }

  shutdown() {
    if (!this.shutdownPromise) this.shutdownPromise = this._shutdown();
    return this.shutdownPromise;
  }

  async _phase(tasks) {
    return settleWithin(tasks, this.phaseTimeoutMs, this.setTimeout, this.clearTimeout);
  }

  async _runtimePhase() {
    return Promise.allSettled(this.stopRuntime.map((task) => Promise.resolve().then(task)));
  }

  async _shutdown() {
    await this._phase([this.requestRendererFlush]);
    await this._phase([this.beginClose]);
    await this._phase(this.stopUpstream);
    await this._runtimePhase();
    await this._phase([this.closeWriter]);
    await this._phase([this.closeRepository]);
  }
}

module.exports = {
  GracefulShutdownCoordinator,
  RendererShutdownHandshake,
  settleWithin,
};
