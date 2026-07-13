const { AsyncLocalStorage } = require("node:async_hooks");

class UnifiedRootWriteGate {
  constructor() {
    this.closed = false;
    this.leases = 0;
    this.idleWaiters = [];
    this.context = new AsyncLocalStorage();
  }

  assertProducerAllowed() {
    if (!this.closed || this.context.getStore()?.gate === this) return;
    const error = new Error("storage migration in progress");
    error.code = "STORAGE_MIGRATION_IN_PROGRESS";
    throw error;
  }

  acquireWriteLease() {
    this.assertProducerAllowed();
    this.leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
  }

  runWithWriteLease(label, operation) {
    if (typeof operation !== "function") throw new TypeError("write operation is required");
    const release = this.acquireWriteLease(label);
    return this.context.run({ gate: this, label }, async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }

  close() {
    this.closed = true;
  }

  open() {
    this.closed = false;
  }

  waitForIdle() {
    if (this.leases === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

const processWriteGate = new UnifiedRootWriteGate();

module.exports = { UnifiedRootWriteGate, processWriteGate };
