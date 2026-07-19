const test = require("node:test");
const assert = require("node:assert/strict");

const ApplicationAudioCapturePool = require("../../src/jarvis/main/ApplicationAudioCapturePool");

test("capture failure immediately marks mixed fallback and retries with a new generation", async () => {
  let now = 1_000;
  let watcherCallbacks;
  const managers = [];
  const attributions = [];
  const pool = new ApplicationAudioCapturePool({
    now: () => now,
    retryDelayMs: 500,
    watcherFactory(callbacks) {
      watcherCallbacks = callbacks;
      return { start: async () => {}, stop: async () => {} };
    },
    managerFactory() {
      const manager = {
        async start(args) {
          this.args = args;
        },
        async stop() {},
      };
      managers.push(manager);
      return manager;
    },
    onAttributionChange: (event) => attributions.push(event),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await pool.start();
  await watcherCallbacks.onSession({
    state: "active",
    pid: 501,
    applicationKey: "kook",
    applicationDisplayName: "KOOK",
    peak: 1,
  });
  await pool.waitForIdle();

  managers[0].args.onError(Object.assign(new Error("device changed"), { code: "device_changed" }));
  await pool.waitForIdle();
  assert.equal(pool.getStatus().activeTracks.length, 0);
  assert.equal(pool.getStatus().fallbacks[0].reason, "device_changed");
  assert.equal(attributions.at(-1).attributionState, "mixed_unknown");

  now += 600;
  await pool.sweep();
  await pool.waitForIdle();
  assert.equal(pool.getStatus().activeTracks[0].captureGeneration, 2);
  assert.equal(managers.length, 2);
  assert.equal(attributions.at(-1).attributionState, "exact");
});

test("silent application capture is released and later probed without growing timers", async () => {
  let now = 2_000;
  let watcherCallbacks;
  let intervalCount = 0;
  let clearedCount = 0;
  const managers = [];
  const pool = new ApplicationAudioCapturePool({
    now: () => now,
    silenceReleaseMs: 1_000,
    retryDelayMs: 500,
    watcherFactory(callbacks) {
      watcherCallbacks = callbacks;
      return { start: async () => {}, stop: async () => {} };
    },
    managerFactory() {
      const manager = {
        async start(args) {
          this.args = args;
        },
        async stop() {},
      };
      managers.push(manager);
      return manager;
    },
    setIntervalImpl: () => {
      intervalCount += 1;
      return 7;
    },
    clearIntervalImpl: () => {
      clearedCount += 1;
    },
  });
  await pool.start();
  await watcherCallbacks.onSession({
    state: "active",
    pid: 601,
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    peak: 1,
  });
  await pool.waitForIdle();

  managers[0].args.onChunk(Buffer.alloc(4_800));
  now += 1_100;
  await pool.sweep();
  assert.equal(pool.getStatus().activeTracks.length, 0);
  assert.equal(pool.getStatus().fallbacks[0].reason, "confirmed_silence");

  now += 600;
  await pool.sweep();
  assert.equal(pool.getStatus().activeTracks[0].captureGeneration, 2);
  assert.equal(intervalCount, 1);
  await pool.stop();
  assert.equal(clearedCount, 1);
});
