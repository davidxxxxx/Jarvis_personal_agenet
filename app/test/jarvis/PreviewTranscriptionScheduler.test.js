const test = require("node:test");
const assert = require("node:assert/strict");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const PreviewTranscriptionScheduler = require("../../src/jarvis/main/PreviewTranscriptionScheduler");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function availableSnapshot() {
  return {
    state: "available",
    reason: "resources_available",
    previewEnabled: true,
    cpuTelemetryAvailable: true,
    cpuLoadPct: 10,
    powerTelemetryAvailable: true,
    batterySaver: false,
  };
}

function cpuSnapshot() {
  return {
    state: "unavailable",
    reason: "cuda_unavailable",
    previewEnabled: true,
    cpuTelemetryAvailable: true,
    cpuLoadPct: 10,
    powerTelemetryAvailable: true,
    batterySaver: false,
  };
}

function createScheduler(options = {}) {
  return new PreviewTranscriptionScheduler({
    executePreview: async () => ({ segments: [] }),
    persistProvisional: () => {},
    heavyGate: new HeavyJobGate(),
    now: () => 0,
    ...options,
  });
}

test("keeps only the newest pending preview coverage for one session track", () => {
  const scheduler = createScheduler();

  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 30_000 });

  assert.deepEqual(scheduler.pending(), [{ sessionId: "s1", trackId: "mic", throughMs: 30_000 }]);
  assert.equal(scheduler.status().pending, 1);
});

test("keeps one newest successor while a preview is running", async () => {
  const first = deferred();
  const executions = [];
  let now = 0;
  const scheduler = createScheduler({
    now: () => now,
    executePreview: async (request) => {
      executions.push(request);
      if (executions.length === 1) return first.promise;
      return { segments: [] };
    },
  });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  const running = scheduler.tick(availableSnapshot());
  await new Promise((resolve) => setImmediate(resolve));

  for (let throughMs = 16_000; throughMs <= 90_000; throughMs += 1_000) {
    scheduler.request({ sessionId: "s1", trackId: "mic", throughMs });
  }

  assert.deepEqual(scheduler.pending(), [{ sessionId: "s1", trackId: "mic", throughMs: 90_000 }]);
  assert.equal(scheduler.status().running, 1);
  first.resolve({ segments: [] });
  await running;
  now = 30_000;
  await scheduler.tick(availableSnapshot());
  assert.deepEqual(
    executions.map(({ throughMs }) => throughMs),
    [15_000, 90_000]
  );
});

test("available cadence keeps simulated p95 preview latency within 30 seconds", async () => {
  let now = 0;
  const completed = [];
  const requested = [];
  const scheduler = createScheduler({
    now: () => now,
    executePreview: async ({ throughMs }) => {
      completed.push({ throughMs, at: now });
      return { segments: [] };
    },
  });

  for (now = 0; now <= 120_000; now += 1_000) {
    const throughMs = now + 1_000;
    requested.push({ throughMs, at: now });
    scheduler.request({ sessionId: "s1", trackId: "mic", throughMs });
    await scheduler.tick(availableSnapshot());
  }

  const latencies = requested
    .map(
      (request) => completed.find((entry) => entry.throughMs >= request.throughMs)?.at - request.at
    )
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  assert.ok(latencies.length >= 100);
  assert.ok(p95 <= 30_000, `expected p95 <= 30000, received ${p95}`);
  assert.equal(scheduler.status().cadenceMs, 15_000);
});

test("uses approved degraded and CPU cadences and pauses unsafe preview", async () => {
  const scheduler = createScheduler();

  await scheduler.tick({
    ...availableSnapshot(),
    state: "constrained",
    reason: "recovery_hysteresis",
  });
  assert.equal(scheduler.status().mode, "degraded");
  assert.ok(scheduler.status().cadenceMs >= 45_000);
  assert.ok(scheduler.status().cadenceMs <= 90_000);

  await scheduler.tick(cpuSnapshot());
  assert.equal(scheduler.status().executionDevice, "cpu");
  assert.ok(scheduler.status().cadenceMs >= 60_000);
  assert.ok(scheduler.status().cadenceMs <= 90_000);

  for (const snapshot of [
    { ...availableSnapshot(), state: "busy", reason: "external_gpu_busy" },
    { ...availableSnapshot(), state: "constrained", reason: "battery_saver", batterySaver: true },
    { ...availableSnapshot(), state: "constrained", reason: "cpu_load_high", cpuLoadPct: 95 },
    { state: "constrained", reason: "telemetry_unavailable" },
  ]) {
    await scheduler.tick(snapshot);
    assert.equal(scheduler.status().mode, "paused");
    assert.ok(scheduler.status().pausedReason);
    assert.equal(scheduler.status().recordingContinues, true);
  }
});

test("pauses an unknown constrained reason instead of failing open to CUDA", async () => {
  const scheduler = createScheduler();

  await scheduler.tick({
    ...availableSnapshot(),
    state: "constrained",
    reason: "future_resource_reason",
  });

  assert.equal(scheduler.status().mode, "paused");
  assert.equal(scheduler.status().pausedReason, "future_resource_reason");
  assert.equal(scheduler.status().executionDevice, null);
});

test("measures cadence from the actual heavy-gate callback start after a long wait", async () => {
  let now = 0;
  let releaseBlocker;
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const gate = new HeavyJobGate();
  const active = gate.run("retention_urgent", () => blocker);
  const starts = [];
  const scheduler = createScheduler({
    heavyGate: gate,
    now: () => now,
    executePreview: async () => {
      starts.push(now);
      return { segments: [] };
    },
  });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  const first = scheduler.tick(availableSnapshot());
  await new Promise((resolve) => setImmediate(resolve));

  now = 120_000;
  releaseBlocker();
  await Promise.all([active, first]);
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 30_000 });
  await scheduler.tick(availableSnapshot());
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(starts, [120_000]);
  assert.equal(scheduler.status().pending, 1);
});

test("runs atomic durable arbitration inside the preview permit before transcription", async () => {
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
  const scheduler = createScheduler({
    heavyGate: gate,
    beforePreviewStart: (permit) => {
      gate.assertActivePermit(permit);
      if (urgentClaimable) order.push("retention_urgent");
    },
    executePreview: async () => {
      order.push("preview");
      return { segments: [] };
    },
  });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  const preview = scheduler.tick(availableSnapshot());
  const final = gate.run("final_transcription", () => order.push("final_transcription"));

  urgentClaimable = true;
  releaseBlocker.resolve();
  await Promise.all([blocker, preview, final]);

  assert.deepEqual(order, ["retention_urgent", "preview", "final_transcription"]);
});

test("stop during durable arbitration restores the pending preview without starting transcription", async () => {
  const arbitrationStarted = deferred();
  const releaseArbitration = deferred();
  let executions = 0;
  const scheduler = createScheduler({
    beforePreviewStart: async () => {
      arbitrationStarted.resolve();
      await releaseArbitration.promise;
    },
    executePreview: async () => {
      executions += 1;
      return { segments: [] };
    },
  });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  const preview = scheduler.tick(availableSnapshot());
  await arbitrationStarted.promise;

  scheduler.stop();
  releaseArbitration.resolve();
  assert.equal(await preview, 0);
  assert.equal(executions, 0);
  assert.deepEqual(scheduler.pending(), [{ sessionId: "s1", trackId: "mic", throughMs: 15_000 }]);
});

test("bounds preview context to the newest 120 seconds and advances uncovered coverage", async () => {
  let now = 0;
  const executions = [];
  const scheduler = createScheduler({
    now: () => now,
    executePreview: async (request) => {
      executions.push(request);
      return { segments: [] };
    },
  });

  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 300_000 });
  await scheduler.tick(availableSnapshot());
  now = 30_000;
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 450_000 });
  await scheduler.tick(availableSnapshot());

  assert.deepEqual(
    executions.map(({ fromMs, throughMs }) => ({ fromMs, throughMs })),
    [
      { fromMs: 180_000, throughMs: 300_000 },
      { fromMs: 330_000, throughMs: 450_000 },
    ]
  );
});

test("normalizes persisted preview output to provisional and contains preview failures", async () => {
  let shouldFail = false;
  let now = 0;
  const persisted = [];
  const finalJobs = [{ id: "final-1", state: "pending" }];
  const scheduler = createScheduler({
    executePreview: async ({ fromMs, throughMs }) => {
      if (shouldFail) throw new Error("preview exploded");
      return {
        segments: [
          {
            id: "preview-1",
            startedAt: fromMs,
            endedAt: throughMs,
            text: "temporary",
            resultKind: "final",
          },
        ],
      };
    },
    persistProvisional: (input) => persisted.push(input),
    now: () => now,
  });

  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 15_000 });
  await scheduler.tick(availableSnapshot());
  assert.equal(persisted[0].segments[0].resultKind, "provisional");

  shouldFail = true;
  now = 30_000;
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 30_000 });
  await scheduler.tick({ ...availableSnapshot(), sampledAt: 30_000 });
  assert.match(scheduler.status().lastError, /preview exploded/);
  assert.deepEqual(finalJobs, [{ id: "final-1", state: "pending" }]);

  await scheduler.tick({ ...availableSnapshot(), state: "busy", reason: "external_gpu_busy" });
  assert.deepEqual(finalJobs, [{ id: "final-1", state: "pending" }]);
});

test("validates identifiers and monotonic safe millisecond boundaries", () => {
  const scheduler = createScheduler();

  assert.throws(
    () => scheduler.request({ sessionId: "", trackId: "mic", throughMs: 1 }),
    /sessionId/
  );
  assert.throws(() => scheduler.request({ sessionId: "s1", trackId: "", throughMs: 1 }), /trackId/);
  assert.throws(
    () => scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: -1 }),
    /throughMs/
  );
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 10 });
  assert.throws(
    () => scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 9 }),
    /monotonic/
  );
});

test("round-robins pending tracks so continuous mic requests cannot starve system audio", async () => {
  let now = 0;
  const executed = [];
  const scheduler = createScheduler({
    now: () => now,
    executePreview: async (request) => {
      executed.push(request.trackId);
      return { segments: [] };
    },
  });
  scheduler.request({ sessionId: "s1", trackId: "mic", throughMs: 30_000 });
  scheduler.request({ sessionId: "s1", trackId: "system", throughMs: 30_000 });

  for (let index = 0; index < 3; index += 1) {
    await scheduler.tick(availableSnapshot());
    now += 30_000;
    scheduler.request({
      sessionId: "s1",
      trackId: "mic",
      throughMs: 60_000 + index * 30_000,
    });
  }

  assert.ok(executed.includes("system"), `system track starved: ${executed.join(",")}`);
  assert.ok(executed.indexOf("system") <= 1, `system track was not served promptly: ${executed}`);
});
