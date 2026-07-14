const test = require("node:test");
const assert = require("node:assert/strict");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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

for (const kind of ["retention_urgent", "storage_recovery_compress"]) {
  test(`lets preview drain late ${kind} inside its permit before preview and final`, async () => {
    const gate = new HeavyJobGate();
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const order = [];
    let urgentClaimable = false;

    const blocker = gate.run("maintenance", async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    });
    await blockerStarted.promise;

    const preview = gate.run("preview", async (permit) => {
      gate.assertActivePermit(permit);
      if (urgentClaimable) {
        order.push(kind);
        urgentClaimable = false;
      }
      gate.assertActivePermit(permit);
      if (!urgentClaimable) {
        order.push("preview");
      }
    });
    const final = gate.run("final_transcription", () => order.push("final_transcription"));

    urgentClaimable = true;
    releaseBlocker.resolve();
    await Promise.all([blocker, preview, final]);
    assert.deepEqual(order, [kind, "preview", "final_transcription"]);
  });
}

test("a durable job inserted after successful preview arbitration does not preempt active preview", async () => {
  const gate = new HeavyJobGate();
  const previewStarted = deferred();
  const releasePreview = deferred();
  const order = [];
  let admissionChecks = 0;

  const preview = gate.run("preview", async (permit) => {
    gate.assertActivePermit(permit);
    admissionChecks += 1;
    if (admissionChecks === 1) {
      order.push("preview:start");
      previewStarted.resolve();
      await releasePreview.promise;
      order.push("preview:end");
    }
  });
  await previewStarted.promise;
  const urgent = gate.run("retention_urgent", () => order.push("retention_urgent"));
  const final = gate.run("final_transcription", () => order.push("final_transcription"));

  assert.deepEqual(order, ["preview:start"]);
  releasePreview.resolve();
  await Promise.all([preview, urgent, final]);

  assert.equal(admissionChecks, 1);
  assert.deepEqual(order, [
    "preview:start",
    "preview:end",
    "retention_urgent",
    "final_transcription",
  ]);
});

test("rejects a forged or expired heavy-job permit", async () => {
  const gate = new HeavyJobGate();
  let expiredPermit;

  assert.throws(() => gate.assertActivePermit({}), /permit/i);
  await gate.run("preview", (permit) => {
    expiredPermit = permit;
    assert.doesNotThrow(() => gate.assertActivePermit(permit));
  });
  assert.throws(() => gate.assertActivePermit(expiredPermit), /permit/i);
});

test("code holding only the gate instance cannot reflect or steal the active permit", async () => {
  const gate = new HeavyJobGate();
  const previewStarted = deferred();
  const releasePreview = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;

  const preview = gate.run("preview", async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    previewStarted.resolve();
    await releasePreview.promise;
    concurrent -= 1;
  });
  await previewStarted.promise;

  let stolenPermit = null;
  for (const key of Reflect.ownKeys(gate)) {
    const descriptor = Object.getOwnPropertyDescriptor(gate, key);
    if (!descriptor || !("value" in descriptor)) continue;
    try {
      gate.assertActivePermit(descriptor.value);
      stolenPermit = descriptor.value;
      break;
    } catch {
      // A gate instance exposes ordinary state, but no usable capability token.
    }
  }

  if (stolenPermit) {
    await gate.runWithinPermit(stolenPermit, "retention_urgent", async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      concurrent -= 1;
    });
  }
  releasePreview.resolve();
  await preview;

  assert.equal(stolenPermit, null);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(
    Reflect.ownKeys(gate).filter((key) => /permit/i.test(String(key))),
    []
  );
});

test("permit work stays single-concurrency and accepts only higher-priority kinds", async () => {
  const gate = new HeavyJobGate();
  const innerStarted = deferred();
  const releaseInner = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;

  await gate.run("preview", async (permit) => {
    const storage = gate.runWithinPermit(permit, "storage_recovery_compress", async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      innerStarted.resolve();
      await releaseInner.promise;
      concurrent -= 1;
    });
    await innerStarted.promise;
    await assert.rejects(
      gate.runWithinPermit(permit, "retention_urgent", () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        concurrent -= 1;
      }),
      /already running/i
    );
    releaseInner.resolve();
    await storage;
    await assert.rejects(
      gate.runWithinPermit(permit, "final_transcription", () => undefined),
      /higher priority/i
    );
  });

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(gate.getState(), { activeKind: null, queueLength: 0 });
});
