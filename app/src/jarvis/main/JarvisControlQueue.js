const { randomUUID } = require("node:crypto");

const ACTIONS = new Set(["start", "pause", "resume", "finish"]);
const OUTCOMES = new Set(["ok", "duplicate", "expired", "error"]);

class JarvisControlQueue {
  constructor({
    send,
    createId = randomUUID,
    now = Date.now,
    log = () => {},
    ttlMs = 30_000,
    maxPending = 32,
    maxAcknowledged = 128,
  }) {
    if (typeof send !== "function") throw new TypeError("send must be a function");
    this.send = send;
    this.createId = createId;
    this.now = now;
    this.log = log;
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.maxAcknowledged = maxAcknowledged;
    this.pending = new Map();
    this.acknowledged = new Map();
    this.expiredIds = new Map();
    this.rendererId = null;
    this.expired = 0;
    this.dropped = 0;
  }

  enqueue(action) {
    if (!ACTIONS.has(action)) throw new TypeError("unsupported Jarvis control action");
    this._expire();
    while (this.pending.size >= this.maxPending) {
      const oldestId = this.pending.keys().next().value;
      this.pending.delete(oldestId);
      this.dropped += 1;
      this.log({ status: "dropped", id: oldestId });
    }
    const envelope = {
      id: this.createId(),
      action,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(envelope.id, envelope);
    if (this.rendererId) this._send(envelope);
    return envelope;
  }

  markReady(rendererId) {
    if (typeof rendererId !== "string" || rendererId.length < 1 || rendererId.length > 128) {
      throw new TypeError("renderer id must be a non-empty string");
    }
    this.rendererId = rendererId;
    this._expire();
    for (const envelope of this.pending.values()) this._send(envelope);
  }

  markNotReady(reason = "unavailable") {
    this.rendererId = null;
    this.log({ status: "not_ready", reason });
  }

  acknowledge(id, outcome) {
    this._expire();
    if (this.acknowledged.has(id)) return { status: "duplicate" };
    if (this.expiredIds.has(id)) return { status: "expired" };
    if (!this.pending.has(id)) return { status: "unknown" };
    if (!OUTCOMES.has(outcome)) return { status: "invalid" };
    this.pending.delete(id);
    this._remember(this.acknowledged, id);
    if (outcome === "error") {
      this.log({ status: "renderer_failed", id });
      return { status: "failed" };
    }
    return { status: "acknowledged" };
  }

  getSnapshot() {
    this._expire();
    return {
      rendererId: this.rendererId,
      pendingIds: [...this.pending.keys()],
      expired: this.expired,
      dropped: this.dropped,
    };
  }

  _send(envelope) {
    try {
      this.send(envelope);
    } catch {
      this.log({ status: "send_failed", id: envelope.id });
    }
  }

  _expire() {
    const now = this.now();
    for (const [id, envelope] of this.pending) {
      if (envelope.expiresAt < now) {
        this.pending.delete(id);
        this._remember(this.expiredIds, id);
        this.expired += 1;
        this.log({ status: "expired", id });
      }
    }
  }

  _remember(map, id) {
    map.delete(id);
    map.set(id, this.now());
    while (map.size > this.maxAcknowledged) map.delete(map.keys().next().value);
  }
}

module.exports = JarvisControlQueue;
