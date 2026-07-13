const { AsyncLocalStorage } = require("node:async_hooks");

class UnifiedRootWriteGate {
  constructor() {
    this.closed = false;
    this.leases = 0;
    this.idleWaiters = [];
    this.context = new AsyncLocalStorage();
  }

  assertProducerAllowed() {
    const token = this.context.getStore();
    if (!this.closed || (token?.gate === this && token.active === true)) return;
    const error = new Error("storage migration in progress");
    error.code = "STORAGE_MIGRATION_IN_PROGRESS";
    throw error;
  }

  acquireWriteLease(label = "write") {
    this.assertProducerAllowed();
    this.leases += 1;
    const token = { gate: this, label, active: true, privileged: false };
    return () => {
      if (!token.active) return;
      token.active = false;
      this.leases -= 1;
      if (this.leases === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
  }

  runWithWriteLease(label, operation) {
    if (typeof operation !== "function") throw new TypeError("write operation is required");
    this.assertProducerAllowed();
    this.leases += 1;
    const token = { gate: this, label, active: true, privileged: false };
    return this.context.run(token, async () => {
      try {
        return await operation();
      } finally {
        if (token.active) {
          token.active = false;
          this.leases -= 1;
          if (this.leases === 0) {
            const waiters = this.idleWaiters.splice(0);
            for (const resolve of waiters) resolve();
          }
        }
      }
    });
  }

  runPrivilegedResume(operation) {
    if (typeof operation !== "function") throw new TypeError("resume operation is required");
    if (!this.closed) throw new Error("privileged resume requires a closed migration gate");
    const token = { gate: this, label: "migration-resume", active: true, privileged: true };
    return this.context.run(token, async () => {
      try {
        return await operation();
      } finally {
        token.active = false;
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
