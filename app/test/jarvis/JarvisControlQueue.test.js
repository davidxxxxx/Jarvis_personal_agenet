const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisControlQueue = require("../../src/jarvis/main/JarvisControlQueue");

test("claimed controls fail on renderer crash and are never replayed", () => {
  const sent = [];
  let sequence = 0;
  const queue = new JarvisControlQueue({
    send: (envelope) => sent.push(envelope),
    createId: () => `control-${++sequence}`,
    now: () => 1_000,
  });

  const first = queue.enqueue("start");
  queue.markReady("renderer-1");
  assert.deepEqual(queue.claim(first.id, "renderer-1"), { status: "claimed" });

  queue.markNotReady("crashed");
  queue.markReady("renderer-2");
  assert.deepEqual(sent.map((entry) => entry.id), [first.id]);
  assert.deepEqual(queue.acknowledge(first.id, "ok", "renderer-1"), { status: "failed" });
  assert.deepEqual(queue.getSnapshot().claimedIds, []);
  assert.equal(queue.getSnapshot().failed, 1);

  const retry = queue.enqueue("start");
  assert.notEqual(retry.id, first.id);
  assert.deepEqual(sent.map((entry) => entry.id), [first.id, retry.id]);
  assert.deepEqual(queue.claim(retry.id, "renderer-2"), { status: "claimed" });
  assert.deepEqual(queue.acknowledge(retry.id, "ok", "renderer-2"), {
    status: "acknowledged",
  });
});

test("only the ready renderer can atomically claim an unexpired pending control", () => {
  let now = 1_000;
  const queue = new JarvisControlQueue({
    send: () => {},
    createId: () => "control-1",
    now: () => now,
    ttlMs: 100,
  });
  const envelope = queue.enqueue("pause");

  assert.deepEqual(queue.claim(envelope.id, "renderer-1"), { status: "not_ready" });
  queue.markReady("renderer-1");
  assert.deepEqual(queue.claim(envelope.id, "renderer-2"), { status: "not_ready" });
  assert.deepEqual(queue.claim("unknown", "renderer-1"), { status: "unknown" });
  now = 1_101;
  assert.deepEqual(queue.claim(envelope.id, "renderer-1"), { status: "expired" });
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
  assert.deepEqual(queue.claim(expired.id, "renderer"), { status: "expired" });

  const first = queue.enqueue("start");
  const second = queue.enqueue("pause");
  const third = queue.enqueue("finish");
  assert.deepEqual(queue.getSnapshot().pendingIds, [second.id, third.id]);
  assert.equal(queue.getSnapshot().dropped, 1);
  queue.claim(second.id, "renderer");
  queue.acknowledge(second.id, "ok", "renderer");
  queue.claim(third.id, "renderer");
  queue.acknowledge(third.id, "ok", "renderer");
  assert.deepEqual(queue.acknowledge(second.id, "ok", "renderer"), { status: "unknown" });
  assert.deepEqual(queue.acknowledge(third.id, "ok", "renderer"), { status: "duplicate" });
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
  assert.deepEqual(queue.acknowledge(envelope.id, "error", "renderer"), {
    status: "unclaimed",
  });
  assert.deepEqual(queue.claim(envelope.id, "renderer"), { status: "claimed" });
  assert.deepEqual(queue.acknowledge(envelope.id, "error", "renderer"), { status: "failed" });
  assert.deepEqual(queue.getSnapshot().pendingIds, []);
});
