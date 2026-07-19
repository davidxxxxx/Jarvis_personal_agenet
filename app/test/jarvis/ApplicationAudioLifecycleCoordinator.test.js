const test = require("node:test");
const assert = require("node:assert/strict");

const ApplicationAudioLifecycleCoordinator = require(
  "../../src/jarvis/main/ApplicationAudioLifecycleCoordinator"
);

function createHarness({ rendererFailure = null } = {}) {
  const calls = [];
  let status = {
    running: true,
    configuredLimit: 4,
    fullscreen: false,
  };
  const pool = {
    getStatus() {
      return { ...status };
    },
    stop() {
      calls.push(["pool-stop"]);
      status.running = false;
      return Promise.resolve();
    },
    start(options) {
      calls.push(["pool-start", options]);
      status = {
        running: true,
        configuredLimit: options.configuredLimit,
        fullscreen: options.fullscreen,
      };
      return Promise.resolve({ ...status });
    },
  };
  const coordinator = new ApplicationAudioLifecycleCoordinator({
    getPool: () => pool,
    getSettings: () => ({ enabled: true, trackLimit: 6 }),
    getFullscreen: () => false,
    requestRenderer: async (kind, payload) => {
      calls.push(["renderer", kind, payload]);
      if (rendererFailure?.(kind, payload)) throw new Error("renderer unavailable");
      return { ok: true };
    },
  });
  return { coordinator, calls, pool };
}

test("power suspend closes application evidence before requesting renderer shutdown", async () => {
  const { coordinator, calls } = createHarness();

  await coordinator.suspend({ sessionId: "session-1" });

  assert.deepEqual(calls.slice(0, 2), [
    ["pool-stop"],
    ["renderer", "suspend", { sessionId: "session-1" }],
  ]);
});

test("power resume restores the application pool on the same session", async () => {
  const { coordinator, calls } = createHarness();
  await coordinator.suspend({ sessionId: "session-1" });

  await coordinator.resume({ sessionId: "session-1" });

  assert.deepEqual(calls.at(-1), [
    "pool-start",
    { sessionId: "session-1", configuredLimit: 6, fullscreen: false },
  ]);
});

test("midnight rotation stops the old pool and activates the destination session once", async () => {
  const { coordinator, calls } = createHarness();
  const base = {
    previousSessionId: "session-day-1",
    sessionId: "session-day-2",
    startedAt: 2_000,
    localDate: "2026-07-21",
  };

  await coordinator.rotate({ phase: "prepare", ...base });
  await coordinator.rotate({ phase: "activate", ...base });
  await coordinator.rotate({ phase: "commit", ...base });

  assert.equal(calls.filter(([name]) => name === "pool-stop").length, 1);
  assert.deepEqual(
    calls.filter(([name]) => name === "pool-start"),
    [
      [
        "pool-start",
        { sessionId: "session-day-2", configuredLimit: 6, fullscreen: false },
      ],
    ]
  );
  assert.equal(
    calls
      .filter(([name]) => name === "renderer")
      .every(([, kind, payload]) => kind === "rotate" && Object.keys(payload.sources).length === 0),
    true
  );
});

test("failed midnight prepare restarts the old application session", async () => {
  const { coordinator, calls } = createHarness({
    rendererFailure: (kind, payload) => kind === "rotate" && payload.phase === "prepare",
  });

  await assert.rejects(
    coordinator.rotate({
      phase: "prepare",
      previousSessionId: "session-day-1",
      sessionId: "session-day-2",
      startedAt: 2_000,
      localDate: "2026-07-21",
    }),
    /renderer unavailable/
  );

  assert.deepEqual(calls.at(-1), [
    "pool-start",
    { sessionId: "session-day-1", configuredLimit: 6, fullscreen: false },
  ]);
});

test("midnight abort restores the old application session after service rollback", async () => {
  const { coordinator, calls } = createHarness();
  const base = {
    previousSessionId: "session-day-1",
    sessionId: "session-day-2",
    startedAt: 2_000,
    localDate: "2026-07-21",
  };

  await coordinator.rotate({ phase: "prepare", ...base });
  await coordinator.rotate({ phase: "abort", ...base });

  assert.deepEqual(calls.at(-1), [
    "pool-start",
    { sessionId: "session-day-1", configuredLimit: 6, fullscreen: false },
  ]);
});
