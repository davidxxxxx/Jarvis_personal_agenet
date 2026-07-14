const test = require("node:test");
const assert = require("node:assert/strict");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");

test("serializes heavy jobs with maximum concurrency one", async () => {
  const gate = new HeavyJobGate();
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseFirst;
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  const first = gate.run("final_transcription", async () => {
    order.push("final_transcription:start");
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await firstReleased;
    concurrent -= 1;
    order.push("final_transcription:end");
  });
  const second = gate.run("speaker", async () => {
    order.push("speaker:start");
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    concurrent -= 1;
    order.push("speaker:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.getState(), { activeKind: "final_transcription", queueLength: 1 });
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, [
    "final_transcription:start",
    "final_transcription:end",
    "speaker:start",
    "speaker:end",
  ]);
  assert.deepEqual(gate.getState(), { activeKind: null, queueLength: 0 });
});

test("releases the permit after synchronous throws and asynchronous rejection", async () => {
  const gate = new HeavyJobGate();
  const order = [];

  await assert.rejects(
    gate.run("whisper", () => {
      order.push("sync");
      throw new Error("sync failed");
    }),
    /sync failed/
  );
  await assert.rejects(
    gate.run("speaker", async () => {
      order.push("async");
      throw new Error("async failed");
    }),
    /async failed/
  );
  await gate.run("compression", () => {
    order.push("success");
  });

  assert.deepEqual(order, ["sync", "async", "success"]);
  assert.deepEqual(gate.getState(), { activeKind: null, queueLength: 0 });
});

test("does not start a queued callback after its signal is aborted", async () => {
  const gate = new HeavyJobGate();
  const controller = new AbortController();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let cancelledRan = false;

  const first = gate.run("final_transcription", () => blocked);
  const cancelled = gate.run(
    "speaker",
    () => {
      cancelledRan = true;
    },
    { signal: controller.signal }
  );
  controller.abort();
  release();

  await first;
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(cancelledRan, false);
  assert.deepEqual(gate.getState(), { activeKind: null, queueLength: 0 });
});

test("selects globally ordered Jarvis work when durable and preview jobs wait together", async () => {
  const gate = new HeavyJobGate();
  let releaseBlocker;
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const order = [];
  const active = gate.run("maintenance", () => blocker);
  await new Promise((resolve) => setImmediate(resolve));

  const waiting = [
    "final_transcription",
    "preview",
    "storage_recovery_compress",
    "retention_urgent",
  ].map((kind) =>
    gate.run(kind, () => {
      order.push(kind);
    })
  );

  releaseBlocker();
  await Promise.all([active, ...waiting]);

  assert.deepEqual(order, [
    "retention_urgent",
    "storage_recovery_compress",
    "preview",
    "final_transcription",
  ]);
});

test("preserves FIFO order among waiting jobs with the same priority", async () => {
  const gate = new HeavyJobGate();
  let releaseBlocker;
  const blocker = gate.run(
    "retention_urgent",
    () =>
      new Promise((resolve) => {
        releaseBlocker = resolve;
      })
  );
  await new Promise((resolve) => setImmediate(resolve));
  const order = [];
  const first = gate.run("preview", () => order.push("first"));
  const second = gate.run("preview", () => order.push("second"));

  releaseBlocker();
  await Promise.all([blocker, first, second]);

  assert.deepEqual(order, ["first", "second"]);
});
