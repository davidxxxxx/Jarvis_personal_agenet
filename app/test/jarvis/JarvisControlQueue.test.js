const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisControlQueue = require("../../src/jarvis/main/JarvisControlQueue");

test("queues through load, crash, reload, and renderer-ready handshakes", () => {
  const sent = [];
  let sequence = 0;
  const queue = new JarvisControlQueue({
    send: (envelope) => sent.push(envelope),
    createId: () => `control-${++sequence}`,
    now: () => 1_000,
  });

  const first = queue.enqueue("start");
  assert.deepEqual(sent, []);

  queue.markReady("renderer-1");
  assert.deepEqual(sent.map((entry) => entry.id), [first.id]);

  queue.markNotReady("crashed");
  const second = queue.enqueue("pause");
  queue.markReady("renderer-2");
  assert.deepEqual(sent.map((entry) => entry.id), [first.id, first.id, second.id]);

  assert.deepEqual(queue.acknowledge(first.id, "ok"), { status: "acknowledged" });
  assert.deepEqual(queue.acknowledge(first.id, "ok"), { status: "duplicate" });
  assert.deepEqual(queue.getSnapshot().pendingIds, [second.id]);
});

test("expires stale controls and bounds pending and acknowledgement dedupe", () => {
  let now = 1_000;
  let sequence = 0;
  const queue = new JarvisControlQueue({
    send: () => {},
    createId: () => `control-${++sequence}`,
    now: () => now,
    ttlMs: 100,
    maxPending: 2,
    maxAcknowledged: 1,
  });

  const expired = queue.enqueue("start");
  now = 1_101;
  queue.markReady("renderer");
  assert.equal(queue.getSnapshot().expired, 1);
  assert.deepEqual(queue.acknowledge(expired.id, "ok"), { status: "expired" });

  const first = queue.enqueue("start");
  const second = queue.enqueue("pause");
  const third = queue.enqueue("finish");
  assert.deepEqual(queue.getSnapshot().pendingIds, [second.id, third.id]);
  assert.equal(queue.getSnapshot().dropped, 1);
  queue.acknowledge(second.id, "ok");
  queue.acknowledge(third.id, "ok");
  assert.deepEqual(queue.acknowledge(second.id, "ok"), { status: "unknown" });
  assert.deepEqual(queue.acknowledge(third.id, "ok"), { status: "duplicate" });
  assert.notEqual(first.id, second.id);
});

test("send and renderer errors are contained with explicit result semantics", () => {
  const errors = [];
  const queue = new JarvisControlQueue({
    send: () => {
      throw new Error("renderer unavailable");
    },
    createId: () => "control-1",
    now: () => 1_000,
    log: (event) => errors.push(event),
  });
  queue.markReady("renderer");
  const envelope = queue.enqueue("resume");

  assert.deepEqual(queue.getSnapshot().pendingIds, [envelope.id]);
  assert.equal(errors.at(-1).status, "send_failed");
  assert.deepEqual(queue.acknowledge(envelope.id, "error"), { status: "failed" });
  assert.deepEqual(queue.getSnapshot().pendingIds, []);
});
