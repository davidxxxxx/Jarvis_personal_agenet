const test = require("node:test");
const assert = require("node:assert/strict");

const JarvisService = require("../../src/jarvis/main/JarvisService");

function createServiceHarness() {
  const calls = [];
  const service = Object.create(JarvisService.prototype);
  service.closing = false;
  service.closed = false;
  service.state = {
    sessionId: "session-1",
    status: "recording",
    sources: {
      system: {
        sourceType: "system",
        trackId: "system-mix-track",
      },
    },
  };
  service.applicationSources = new Map();
  service.applicationTrackEvidence = new Map();
  service.applicationAttributionIntervals = new Map();
  service.writer = {
    reopenSource: (key, track) => calls.push(["reopen", key, track]),
    append: (key, pcm) => calls.push(["append", key, pcm.length]),
    closeSource: (key, at) => calls.push(["close-source", key, at]),
  };
  let nextInterval = 1;
  service.repository = {
    createTrack: (track) => calls.push(["create-track", track]),
    createApplicationAudioInterval: (interval) => {
      const row = { id: `interval-${nextInterval++}`, ...interval };
      calls.push(["create-interval", row]);
      return row;
    },
    closeApplicationAudioInterval: (id, at) => {
      calls.push(["close-interval", id, at]);
      return { changes: 1 };
    },
    setTrackState: (id, state, at, failureCode) =>
      calls.push(["track-state", id, state, at, failureCode]),
  };
  return { service, calls };
}

test("Jarvis service creates a source-pinned application track and routes PCM by generation", () => {
  const { service, calls } = createServiceHarness();
  const track = service.startApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 1,
    startedAt: 3_000,
  });

  assert.equal(track.applicationKey, "chrome");
  assert.equal(track.captureGeneration, 1);
  assert.match(track.trackId, /^track-/);
  const created = calls.find((entry) => entry[0] === "create-track")[1];
  assert.equal(created.sourceType, "system");
  assert.equal(created.applicationKey, "chrome");
  assert.equal(created.captureGeneration, 1);
  assert.equal(created.strategy, "wasapi-application-loopback");
  assert.equal(
    service.appendApplicationAudioPcm({
      sessionId: "session-1",
      applicationKey: "chrome",
      captureGeneration: 1,
      pcm: Buffer.alloc(960),
    }),
    true
  );
  assert.equal(calls.some((entry) => entry[0] === "append" && entry[2] === 960), true);
  assert.throws(
    () =>
      service.appendApplicationAudioPcm({
        sessionId: "session-1",
        applicationKey: "chrome",
        captureGeneration: 2,
        pcm: Buffer.alloc(2),
      }),
    /generation/
  );
});

test("attribution transitions use the system mix for fallback and app track for exact evidence", () => {
  const { service, calls } = createServiceHarness();
  const track = service.startApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "kook",
    applicationDisplayName: "KOOK",
    captureGeneration: 1,
    startedAt: 3_000,
  });
  service.recordApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "kook",
    captureGeneration: 1,
    attributionState: "mixed_unknown",
    at: 1_000,
    reason: "dynamic_start_prebuffer",
  });
  service.recordApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "kook",
    captureGeneration: 1,
    attributionState: "exact",
    at: 3_000,
    reason: "application_capture_started",
  });

  const intervals = calls.filter((entry) => entry[0] === "create-interval");
  assert.equal(intervals[0][1].trackId, "system-mix-track");
  assert.equal(intervals[0][1].intervalKind, "mixed_fallback");
  assert.equal(
    intervals[0][1].applicationKey,
    null,
    "fallback evidence must never persist a guessed application source"
  );
  assert.equal(intervals[1][1].trackId, track.trackId);
  assert.equal(intervals[1][1].intervalKind, "application_active");
  assert.equal(intervals[1][1].applicationKey, "kook");
  assert.equal(intervals[1][1].reason, null);
  assert.equal(intervals[1][1].failureCode, null);
  assert.deepEqual(
    calls.find((entry) => entry[0] === "close-interval").slice(1),
    ["interval-1", 3_000]
  );
});

test("ending an app track preserves mixed fallback until the application becomes inactive", () => {
  const { service, calls } = createServiceHarness();
  service.startApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "zoom",
    applicationDisplayName: "Zoom",
    captureGeneration: 1,
    startedAt: 2_000,
  });
  service.recordApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "zoom",
    captureGeneration: 1,
    attributionState: "exact",
    at: 2_000,
    reason: "application_capture_started",
  });
  service.recordApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "zoom",
    captureGeneration: 1,
    attributionState: "mixed_unknown",
    at: 4_000,
    reason: "application_not_selected",
  });
  service.stopApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "zoom",
    captureGeneration: 1,
    endedAt: 4_000,
  });

  assert.equal(service.applicationSources.has("zoom"), false);
  assert.equal(service.applicationAttributionIntervals.has("zoom"), true);
  assert.equal(calls.some((entry) => entry[0] === "track-state" && entry[2] === "ended"), true);

  service.endApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "zoom",
    at: 5_000,
  });
  assert.equal(service.applicationAttributionIntervals.has("zoom"), false);
  assert.equal(
    calls.some(
      (entry) => entry[0] === "close-interval" && entry[1] === "interval-2" && entry[2] === 5_000
    ),
    true
  );
});

test("capture failures persist a safe concrete code on fallback evidence and failed tracks", () => {
  const { service, calls } = createServiceHarness();
  service.startApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 7,
    startedAt: 2_000,
  });
  service.recordApplicationAudioAttribution({
    sessionId: "session-1",
    applicationKey: "chrome",
    captureGeneration: 7,
    attributionState: "mixed_unknown",
    at: 2_500,
    reason: "activation_failed",
    failureCode: "activation_failed_0x88890004",
  });
  service.stopApplicationAudioTrack({
    sessionId: "session-1",
    applicationKey: "chrome",
    captureGeneration: 7,
    endedAt: 3_000,
    state: "failed",
    failureCode: "activation_failed_0x88890004",
  });

  const interval = calls.find((entry) => entry[0] === "create-interval")[1];
  assert.equal(interval.failureCode, "activation_failed_0x88890004");
  assert.deepEqual(calls.find((entry) => entry[0] === "track-state").slice(2), [
    "failed",
    3_000,
    "activation_failed_0x88890004",
  ]);
});
