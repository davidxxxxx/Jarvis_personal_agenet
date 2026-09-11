const test = require("node:test");
const assert = require("node:assert/strict");

const ApplicationAudioCapturePool = require(
  "../../src/jarvis/main/ApplicationAudioCapturePool"
);

function event(applicationKey, pid, state = "active") {
  return {
    state,
    pid,
    applicationKey,
    applicationDisplayName: applicationKey,
    peak: state === "active" ? 1 : 0,
    isForeground: false,
  };
}

test("dynamic application pool recycles helpers and state across a long event stream", async () => {
  let watcherCallbacks;
  let createdManagers = 0;
  let stoppedManagers = 0;
  let intervalsCreated = 0;
  let intervalsCleared = 0;
  let now = 10_000;
  const pool = new ApplicationAudioCapturePool({
    now: () => now,
    watcherFactory(callbacks) {
      watcherCallbacks = callbacks;
      return {
        async start() {},
        async stop() {},
      };
    },
    managerFactory() {
      createdManagers += 1;
      return {
        async start() {},
        async stop() {
          stoppedManagers += 1;
        },
      };
    },
    setIntervalImpl() {
      intervalsCreated += 1;
      return intervalsCreated;
    },
    clearIntervalImpl() {
      intervalsCleared += 1;
    },
  });
  await pool.start({ sessionId: "soak-session" });

  for (let index = 0; index < 500; index += 1) {
    const applicationKey = `app-${index % 20}`;
    const pid = 1_000 + index;
    now += 10;
    await watcherCallbacks.onSession(event(applicationKey, pid));
    now += 10;
    await watcherCallbacks.onSession(event(applicationKey, pid, "inactive"));
  }
  await pool.waitForIdle();

  // Sticky selection deliberately retains the bounded active helper set while
  // applications churn. Once the confirmed-silence window expires, the sweep
  // must release every helper and all candidate/fallback state.
  now += 60_001;
  await pool.sweep();
  await pool.waitForIdle();

  assert.equal(pool.candidates.size, 0);
  assert.equal(pool.activeTracks.size, 0);
  assert.equal(pool.fallbacks.size, 0);
  assert.equal(Object.hasOwn(pool, "generations"), false);
  assert.equal(pool.nextCaptureGeneration, createdManagers);
  assert.equal(stoppedManagers, createdManagers);
  assert.equal(createdManagers > 0 && createdManagers <= 100, true);
  assert.equal(intervalsCreated, 1);

  await pool.stop();
  assert.equal(intervalsCleared, 1);
});

test("malformed session floods cannot grow the candidate pool without bound", async () => {
  let watcherCallbacks;
  const warnings = [];
  const pool = new ApplicationAudioCapturePool({
    watcherFactory(callbacks) {
      watcherCallbacks = callbacks;
      return {
        async start() {},
        async stop() {},
      };
    },
    managerFactory() {
      return {
        async start() {},
        async stop() {},
      };
    },
    onWarning: (warning) => warnings.push(warning),
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
  });
  await pool.start({ sessionId: "bounded-session" });

  for (let index = 0; index < 300; index += 1) {
    await watcherCallbacks.onSession(event(`unique-app-${index}`, 2_000 + index));
  }
  await pool.waitForIdle();

  assert.equal(pool.candidates.size, 256);
  assert.equal(pool.activeTracks.size <= 4, true);
  assert.equal(
    warnings.some((warning) => warning.code === "application_candidate_limit_reached"),
    true
  );
  await pool.stop();
});
