const test = require("node:test");
const assert = require("node:assert/strict");

const ApplicationAudioPolicy = require("../../src/jarvis/main/ApplicationAudioPolicy");
const ApplicationAudioCapturePool = require("../../src/jarvis/main/ApplicationAudioCapturePool");

function createHarness(options = {}) {
  let watcherCallbacks;
  const watcher = {
    started: 0,
    stopped: 0,
    async start() {
      this.started += 1;
    },
    async stop() {
      this.stopped += 1;
    },
  };
  const managers = [];
  const events = [];
  const pool = new ApplicationAudioCapturePool({
    now: options.now ?? (() => 10_000),
    watcherFactory(callbacks) {
      watcherCallbacks = callbacks;
      return watcher;
    },
    managerFactory(identity) {
      const manager = {
        identity,
        starts: [],
        stops: 0,
        async start(args) {
          this.starts.push(args);
          this.args = args;
        },
        async stop() {
          this.stops += 1;
        },
      };
      managers.push(manager);
      return manager;
    },
    onTrackStarted: (event) => {
      events.push({ type: "started", ...event });
      if (options.trackStartError) throw options.trackStartError;
    },
    onTrackEnded: (event) => events.push({ type: "ended", ...event }),
    onAttributionChange: (event) => events.push({ type: "attribution", ...event }),
    onChunk: (event) => events.push({ type: "chunk", ...event }),
    setIntervalImpl: options.setIntervalImpl ?? (() => 1),
    clearIntervalImpl: options.clearIntervalImpl ?? (() => {}),
    silenceReleaseMs: options.silenceReleaseMs,
    retryDelayMs: options.retryDelayMs,
    selectionDebounceMs: options.selectionDebounceMs,
    sessionInactiveGraceMs: options.sessionInactiveGraceMs,
  });
  return {
    pool,
    watcher,
    managers,
    events,
    emit: (event) => watcherCallbacks.onSession(event),
    watcherError: (error) => watcherCallbacks.onError(error),
  };
}

function active(applicationKey, pid, overrides = {}) {
  return {
    state: "active",
    pid,
    applicationKey,
    applicationDisplayName: applicationKey,
    peak: 1,
    ...overrides,
  };
}

test("policy clamps settings to 1-8 and ranks calls, foreground, browsers, then games", () => {
  const policy = new ApplicationAudioPolicy();
  assert.equal(policy.resolveLimit(), 4);
  assert.equal(policy.resolveLimit({ configuredLimit: -3 }), 1);
  assert.equal(policy.resolveLimit({ configuredLimit: 99 }), 8);
  assert.equal(policy.resolveLimit({ configuredLimit: 8, fullscreen: true }), 2);

  const selected = policy.select(
    [
      active("dota2", 1),
      active("chrome", 2),
      active("zoom", 3),
      active("notepad", 4, { isForeground: true }),
      active("spotify", 5),
    ],
    { configuredLimit: 4 }
  );
  assert.deepEqual(
    selected.map((entry) => entry.applicationKey),
    ["zoom", "notepad", "chrome", "dota2"]
  );
});

test("policy excludes virtual-audio infrastructure from application tracks", () => {
  const policy = new ApplicationAudioPolicy();
  const selected = policy.select(
    [
      active("SteelSeriesSonar", 201, {
        applicationDisplayName: "SteelSeries Sonar Virtual Audio Device",
      }),
      active("audiodg", 202, {
        applicationDisplayName: "Windows Audio Device Graph Isolation",
      }),
      active("zoom", 203),
    ],
    { configuredLimit: 4 }
  );

  assert.deepEqual(
    selected.map((entry) => entry.applicationKey),
    ["zoom"]
  );
});

test("pool starts at most four independent application tracks while watcher remains singular", async () => {
  const harness = createHarness();
  await harness.pool.start();
  assert.equal(harness.watcher.started, 1);

  for (const [key, pid] of [
    ["dota2", 101],
    ["chrome", 102],
    ["zoom", 103],
    ["notepad", 104],
    ["spotify", 105],
  ]) {
    await harness.emit(active(key, pid, { isForeground: key === "notepad" }));
  }
  await harness.pool.waitForIdle();

  const status = harness.pool.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.configuredLimit, 4);
  assert.equal(status.effectiveLimit, 4);
  assert.deepEqual(
    status.activeTracks.map((track) => track.applicationKey),
    ["chrome", "dota2", "notepad", "zoom"]
  );
  assert.equal(harness.managers.filter((manager) => manager.starts.length === 1).length, 4);
  for (const manager of harness.managers.filter((entry) => entry.starts.length === 1)) {
    assert.equal(manager.args.mode, "application");
    assert.equal(manager.args.targetPid, manager.identity.pid);
  }
  assert.equal(
    harness.events.filter(
      (event) => event.type === "attribution" && event.attributionState === "mixed_unknown"
    ).length,
    4
  );
  assert.equal(
    harness.events.filter(
      (event) => event.type === "attribution" && event.attributionState === "exact"
    ).length,
    4
  );
});

test("equal-priority watcher updates keep the original selected tracks sticky", async () => {
  let at = 10_000;
  const harness = createHarness({ now: () => (at += 250), selectionDebounceMs: 500 });
  await harness.pool.start({ configuredLimit: 4 });
  for (const [key, pid] of [
    ["alpha", 111],
    ["bravo", 112],
    ["charlie", 113],
    ["delta", 114],
    ["echo", 115],
  ]) {
    await harness.emit(active(key, pid));
  }
  for (let index = 0; index < 20; index += 1) {
    await harness.emit(
      active(["alpha", "bravo", "charlie", "delta", "echo"][index % 5], 111 + (index % 5))
    );
  }
  await harness.pool.waitForIdle();

  assert.deepEqual(
    harness.pool.getStatus().activeTracks.map((track) => track.applicationKey),
    ["alpha", "bravo", "charlie", "delta"]
  );
  assert.equal(harness.events.filter((event) => event.type === "started").length, 4);
  assert.equal(
    harness.events.some(
      (event) => event.type === "ended" && event.reason === "application_not_selected"
    ),
    false
  );
});

test("an active application keeps its current PID while that PID remains present", async () => {
  const harness = createHarness({ selectionDebounceMs: 0 });
  await harness.pool.start();
  await harness.emit(active("chrome", 301));
  await harness.emit(active("chrome", 302, { peak: 1 }));
  await harness.emit(active("chrome", 301, { peak: 0.1 }));
  await harness.pool.waitForIdle();

  assert.deepEqual(
    harness.events
      .filter((event) => event.type === "started" && event.applicationKey === "chrome")
      .map((event) => event.pid),
    [301]
  );
});

test("a transient inactive watcher event keeps the same application capture generation", async () => {
  let at = 10_000;
  const harness = createHarness({
    now: () => at,
    sessionInactiveGraceMs: 5_000,
    silenceReleaseMs: 60_000,
  });
  await harness.pool.start();
  await harness.emit(active("kook", 320));
  at += 1_000;
  await harness.emit({ ...active("kook", 320), state: "inactive", peak: 0 });
  at += 1_000;
  await harness.emit(active("kook", 320));
  await harness.pool.waitForIdle();

  assert.equal(
    harness.events.filter((event) => event.type === "started" && event.applicationKey === "kook")
      .length,
    1
  );
  assert.equal(
    harness.events.some(
      (event) => event.type === "ended" && event.applicationKey === "kook"
    ),
    false
  );
});

test("evidence registration failures retain the original bounded error code", async () => {
  const error = new Error("invalid application interval");
  error.code = "SQLITE_CONSTRAINT_TRIGGER";
  const harness = createHarness({ trackStartError: error });
  await harness.pool.start();
  await harness.emit(active("chrome", 350));
  await harness.pool.waitForIdle();

  const ended = harness.events.find(
    (event) => event.type === "ended" && event.applicationKey === "chrome"
  );
  assert.equal(ended.failureCode, "evidence_registration_failed_SQLITE_CONSTRAINT_TRIGGER");
});

test("fullscreen mode retains only the communication app and foreground game", async () => {
  const harness = createHarness();
  await harness.pool.start({ configuredLimit: 8 });
  await harness.emit(active("chrome", 201));
  await harness.emit(active("zoom", 202));
  await harness.emit(active("dota2", 203, { isForeground: true }));
  await harness.emit(active("spotify", 204));
  await harness.pool.setFullscreen(true);
  await harness.pool.waitForIdle();

  const status = harness.pool.getStatus();
  assert.equal(status.effectiveLimit, 2);
  assert.deepEqual(
    status.activeTracks.map((track) => track.applicationKey),
    ["dota2", "zoom"]
  );
  assert.equal(harness.watcher.started, 1);
});

test("application PID replacement closes the old generation and starts a new one", async () => {
  const harness = createHarness();
  await harness.pool.start();
  await harness.emit(active("chrome", 301));
  await harness.emit({ ...active("chrome", 301), state: "inactive", peak: 0 });
  await harness.emit(active("chrome", 302));
  await harness.pool.waitForIdle();

  const starts = harness.events.filter(
    (event) => event.type === "started" && event.applicationKey === "chrome"
  );
  assert.deepEqual(
    starts.map((event) => [event.pid, event.captureGeneration]),
    [
      [301, 1],
      [302, 2],
    ]
  );
  assert.equal(
    harness.events.some(
      (event) =>
        event.type === "ended" && event.applicationKey === "chrome" && event.captureGeneration === 1
    ),
    true
  );
});

test("stop closes all app helpers and the one watcher without touching the mixed safety track", async () => {
  const harness = createHarness();
  await harness.pool.start();
  await harness.emit(active("zoom", 401));
  await harness.emit(active("chrome", 402));
  await harness.pool.stop();

  assert.equal(harness.watcher.stopped, 1);
  assert.equal(
    harness.managers.every((manager) => manager.stops === 1),
    true
  );
  assert.deepEqual(harness.pool.getStatus().activeTracks, []);
  assert.equal(
    harness.events.some((event) => event.type === "ended" && event.reason === "pool_stopped"),
    true
  );
});

test("stop closes application evidence synchronously before native helpers finish", async () => {
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const harness = createHarness();
  await harness.pool.start({ sessionId: "session-before-suspend" });
  await harness.emit(active("zoom", 501));
  harness.managers[0].stop = async () => stopGate;

  const stopping = harness.pool.stop();

  assert.equal(
    harness.events.some(
      (event) =>
        event.type === "ended" &&
        event.sessionId === "session-before-suspend" &&
        event.reason === "pool_stopped"
    ),
    true
  );
  assert.deepEqual(harness.pool.getStatus().activeTracks, []);
  releaseStop();
  await stopping;
});

test("pool can restart on a replacement session after stop cleanup completes", async () => {
  const harness = createHarness();
  await harness.pool.start({ sessionId: "session-day-1" });
  await harness.emit(active("chrome", 601));
  await harness.pool.stop();
  await harness.pool.start({ sessionId: "session-day-2" });
  await harness.emit(active("chrome", 602));
  await harness.pool.waitForIdle();

  const starts = harness.events.filter(
    (event) => event.type === "started" && event.applicationKey === "chrome"
  );
  assert.deepEqual(
    starts.map((event) => [event.sessionId, event.captureGeneration]),
    [
      ["session-day-1", 1],
      ["session-day-2", 2],
    ]
  );
  assert.equal(harness.watcher.started, 2);
});
