const { randomUUID } = require("node:crypto");

const ACTIONS = new Set(["start", "pause", "resume", "finish"]);
const OUTCOMES = new Set(["ok", "error"]);

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
    this.claimed = new Map();
    this.acknowledged = new Map();
    this.expiredIds = new Map();
    this.failedIds = new Map();
    this.rendererId = null;
    this.expired = 0;
    this.failed = 0;
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
    this._assertRendererId(rendererId);
    this.rendererId = rendererId;
    this._expire();
    for (const envelope of this.pending.values()) this._send(envelope);
  }

  markNotReady(reason = "unavailable") {
    const unavailableRenderer = this.rendererId;
    this.rendererId = null;
    for (const [id, claim] of this.claimed) {
      if (claim.rendererId !== unavailableRenderer) continue;
      this.claimed.delete(id);
      this._remember(this.failedIds, id);
      this.failed += 1;
      this.log({ status: "claimed_renderer_gone", id, reason });
    }
    this.log({ status: "not_ready", reason });
  }

  claim(id, rendererId) {
    this._expire();
    if (this.rendererId !== rendererId) return { status: "not_ready" };
    if (this.acknowledged.has(id)) return { status: "duplicate" };
    if (this.expiredIds.has(id)) return { status: "expired" };
    if (this.failedIds.has(id)) return { status: "failed" };
    const existing = this.claimed.get(id);
    if (existing) {
      return { status: existing.rendererId === rendererId ? "in_flight" : "not_ready" };
    }
    const envelope = this.pending.get(id);
    if (!envelope) return { status: "unknown" };
    this.pending.delete(id);
    this.claimed.set(id, { envelope, rendererId });
    return { status: "claimed" };
  }

  acknowledge(id, outcome, rendererId) {
    this._expire();
    if (this.acknowledged.has(id)) return { status: "duplicate" };
    if (this.expiredIds.has(id)) return { status: "expired" };
    if (this.failedIds.has(id)) return { status: "failed" };
    if (!OUTCOMES.has(outcome)) return { status: "invalid" };
    const claim = this.claimed.get(id);
    if (!claim) return this.pending.has(id) ? { status: "unclaimed" } : { status: "unknown" };
    if (claim.rendererId !== rendererId) return { status: "not_owner" };
    this.claimed.delete(id);
    if (outcome === "error") {
      this._remember(this.failedIds, id);
      this.failed += 1;
      this.log({ status: "renderer_failed", id });
      return { status: "failed" };
    }
    this._remember(this.acknowledged, id);
    return { status: "acknowledged" };
  }

  getSnapshot() {
    this._expire();
    return {
      rendererId: this.rendererId,
      pendingIds: [...this.pending.keys()],
      claimedIds: [...this.claimed.keys()],
      expired: this.expired,
      failed: this.failed,
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
    const expire = (map, getEnvelope) => {
      for (const [id, value] of map) {
        const envelope = getEnvelope(value);
        if (envelope.expiresAt >= now) continue;
        map.delete(id);
        this._remember(this.expiredIds, id);
        this.expired += 1;
        this.log({ status: "expired", id });
      }
    };
    expire(this.pending, (envelope) => envelope);
    expire(this.claimed, (claim) => claim.envelope);
  }

  _assertRendererId(rendererId) {
    if (typeof rendererId !== "string" || rendererId.length < 1 || rendererId.length > 128) {
      throw new TypeError("renderer id must be a non-empty string");
    }
  }

  _remember(map, id) {
    map.delete(id);
    map.set(id, this.now());
    while (map.size > this.maxAcknowledged) map.delete(map.keys().next().value);
  }
}

module.exports = JarvisControlQueue;
