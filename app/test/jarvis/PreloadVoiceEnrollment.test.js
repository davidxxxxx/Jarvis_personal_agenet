const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi() {
  const exposed = new Map();
  const invokes = [];
  const sends = [];
  const listeners = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed.set(name, value);
      },
    },
    ipcRenderer: {
      invoke(...args) {
        invokes.push(args);
        return Promise.resolve("invoked");
      },
      send(...args) {
        sends.push(args);
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel) {
        listeners.delete(channel);
      },
    },
    webUtils: {},
  };
  const preloadPath = path.resolve(__dirname, "../../preload.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }
  const rootApi = exposed.get("electronAPI");
  return { api: rootApi.jarvis, rootApi, invokes, sends, listeners };
}

function payload(windows) {
  return {
    sampleRate: 24_000,
    channels: 1,
    format: "float32",
    recordedSampleCount: 24_000 * 30,
    source: {
      kind: "microphone",
      deviceId: "physical-mic-1",
      label: "Physical microphone",
    },
    windows,
  };
}

function window(samples, startSample = 0) {
  return {
    startSample,
    endSample: startSample + samples.length,
    samples,
  };
}

test("preload rejects oversized or malformed enrollment payloads before IPC cloning", async () => {
  const { api, invokes } = loadPreloadApi();
  const tiny = () => window(new Float32Array([0.1]));

  assert.throws(
    () => api.completeVoiceEnrollment("session", payload([tiny(), tiny(), tiny(), tiny()])),
    /exactly three windows/
  );
  assert.throws(
    () => api.completeVoiceEnrollment("session", payload([window([0.1]), tiny(), tiny()])),
    /Float32Array/
  );
  assert.throws(
    () => api.completeVoiceEnrollment("session", payload([tiny(), tiny(), tiny()])),
    /ten seconds/
  );
  assert.equal(invokes.length, 0);

  const tenSeconds = () => new Float32Array(24_000 * 10).fill(0.1);
  const valid = payload([
    window(tenSeconds(), 0),
    window(tenSeconds(), 24_000 * 10),
    window(tenSeconds(), 24_000 * 20),
  ]);
  assert.equal(await api.completeVoiceEnrollment("session", valid), "invoked");
  assert.deepEqual(invokes[0], ["jarvis:voice-enrollment:complete", "session", valid]);
});

test("preload exposes metadata-only self voice enrollment status", async () => {
  const { api, invokes } = loadPreloadApi();

  assert.equal(await api.getVoiceEnrollmentStatus(), "invoked");
  assert.deepEqual(invokes, [["jarvis:voice-enrollment:status"]]);
});

test("preload exposes narrow cloud budget controls", async () => {
  const { api, invokes } = loadPreloadApi();
  const input = { enabled: true, monthlyLimitMicrousd: 5_000_000 };

  assert.equal(await api.getCloudBudget(), "invoked");
  assert.equal(await api.setCloudBudget(input), "invoked");
  assert.deepEqual(invokes, [["jarvis:cloud-budget:get"], ["jarvis:cloud-budget:set", input]]);
});

test("preload exposes only scalar-date daily digest controls", async () => {
  const { api, invokes } = loadPreloadApi();

  assert.equal(await api.getDailyDigest("2026-07-17"), "invoked");
  assert.equal(await api.regenerateDailyDigest("2026-07-17"), "invoked");
  assert.equal(await api.regenerateDailyDigest("2026-07-17", true), "invoked");
  assert.deepEqual(invokes, [
    ["jarvis:memory:daily-digest", { localDate: "2026-07-17" }],
    [
      "jarvis:analysis:daily-digest:regenerate",
      { localDate: "2026-07-17", allowUsageUnknown: false },
    ],
    [
      "jarvis:analysis:daily-digest:regenerate",
      { localDate: "2026-07-17", allowUsageUnknown: true },
    ],
  ]);
  assert.equal("getDailyDigestStatus" in api, false);
  assert.throws(() => api.getDailyDigest({ localDate: "2026-07-17", timezone: "UTC" }));
  assert.throws(() => api.regenerateDailyDigest("2026-02-29"), /valid calendar date/i);
  assert.throws(
    () => api.regenerateDailyDigest("2026-07-17", "yes"),
    /allowUsageUnknown.*boolean/i
  );
  assert.equal(invokes.length, 3);
});

test("preload exposes narrow v2 knowledge reads and actions", async () => {
  const { api, invokes } = loadPreloadApi();

  await api.getKnowledgeOverview();
  await api.decideKnowledgeSuggestion("suggestion_1", "accept");
  await api.resolveKnowledgeConflict("conflict_1", "memory_1");
  await api.completeKnowledgeTodo("todo_1");

  assert.deepEqual(invokes, [
    ["jarvis:memory:v2-overview"],
    ["jarvis:memory:v2-suggestion-decision", { suggestionId: "suggestion_1", action: "accept" }],
    [
      "jarvis:memory:v2-conflict-resolve",
      { conflictGroupId: "conflict_1", selectedMemoryItemId: "memory_1" },
    ],
    ["jarvis:memory:v2-todo-complete", { todoId: "todo_1" }],
  ]);
  assert.throws(() => api.decideKnowledgeSuggestion("suggestion_1", "convert"));
  assert.throws(() => api.completeKnowledgeTodo("../todo"));
  assert.equal(invokes.length, 4);
});

test("preload exposes control readiness and coordinated shutdown acknowledgements", () => {
  const { api, sends, invokes, listeners } = loadPreloadApi();
  const shutdownRequests = [];

  api.controlReady("renderer-1");
  api.claimControl("control-1", "renderer-1");
  api.acknowledgeControl("control-1", "ok", "renderer-1");
  const unsubscribe = api.onShutdownRequested((request) => shutdownRequests.push(request));
  listeners.get("jarvis:shutdown-request")({}, { id: "shutdown-1" });
  api.acknowledgeShutdown("shutdown-1", "ok");

  assert.deepEqual(shutdownRequests, [{ id: "shutdown-1" }]);
  assert.deepEqual(invokes, [["jarvis:control:claim", "control-1", "renderer-1"]]);
  assert.deepEqual(sends, [
    ["jarvis:control:ready", "renderer-1"],
    ["jarvis:control:ack", "control-1", "ok", "renderer-1"],
    ["jarvis:shutdown:ack", "shutdown-1", "ok"],
  ]);
  unsubscribe();
  assert.equal(listeners.has("jarvis:shutdown-request"), false);
});

test("preload exposes narrow authoritative capture failure IPC", async () => {
  const { api, invokes } = loadPreloadApi();

  assert.equal(await api.failCapture("s1", "MIC_DISCONNECTED", 1_100), "invoked");
  assert.deepEqual(invokes, [["jarvis:capture:fail", "s1", "MIC_DISCONNECTED", 1_100]]);
});

test("preload exposes the session timeline request to the renderer", async () => {
  const { api, invokes } = loadPreloadApi();

  assert.equal(await api.getSessionTimeline("session-1"), "invoked");
  assert.equal(
    await api.getSessionTimeline("session-1", { trackOffset: 100, trackLimit: 100 }),
    "invoked"
  );
  assert.equal(await api.getSessionTimelineStatus("session-1"), "invoked");
  assert.deepEqual(invokes, [
    ["jarvis:memory:session-timeline", "session-1"],
    [
      "jarvis:memory:session-timeline",
      "session-1",
      { trackOffset: 100, trackLimit: 100 },
    ],
    ["jarvis:memory:session-timeline-status", "session-1"],
  ]);
});

test("preload exposes source interruption and restoration request-response IPC", async () => {
  const { api, invokes } = loadPreloadApi();
  const interruption = { at: 1_100, reason: "mic-track-ended" };
  const restoration = {
    at: 1_200,
    deviceId: "physical-mic",
    deviceLabel: "Physical microphone",
    strategy: "web-audio",
  };

  assert.equal(await api.sourceInterrupted("s1", "mic", interruption), "invoked");
  assert.equal(await api.sourceRestored("s1", "mic", restoration), "invoked");
  assert.deepEqual(invokes, [
    ["jarvis:capture:source-interrupted", "s1", "mic", interruption],
    ["jarvis:capture:source-restored", "s1", "mic", restoration],
  ]);
});

test("preload exposes the narrow retention mode switch IPC", async () => {
  const { api, invokes } = loadPreloadApi();

  assert.equal(await api.setRetentionMode("s1", "continuous", 1_300), "invoked");
  assert.deepEqual(invokes, [["jarvis:capture:set-retention-mode", "s1", "continuous", 1_300]]);
});

test("preload exposes metadata-only meeting input rejection events", () => {
  const { rootApi, listeners, sends } = loadPreloadApi();
  const rejected = [];
  const chunk = new ArrayBuffer(4);

  const unsubscribe = rootApi.onMeetingTranscriptionInputRejected((payload) =>
    rejected.push(payload)
  );
  rootApi.meetingTranscriptionSend(chunk, "system", "input-generation-1");
  listeners.get("meeting-transcription-input-rejected")(
    {},
    {
      source: "system",
      reason: "jarvis-evidence-backpressure",
      inputGeneration: "input-generation-1",
    }
  );

  assert.deepEqual(sends, [["meeting-transcription-send", chunk, "system", "input-generation-1"]]);
  assert.deepEqual(rejected, [
    {
      source: "system",
      reason: "jarvis-evidence-backpressure",
      inputGeneration: "input-generation-1",
    },
  ]);
  unsubscribe();
  assert.equal(listeners.has("meeting-transcription-input-rejected"), false);
});

test("preload exposes generation-bound meeting source state events", () => {
  const { rootApi, listeners } = loadPreloadApi();
  const states = [];

  const unsubscribe = rootApi.onMeetingTranscriptionSourceState((payload) => states.push(payload));
  listeners.get("meeting-transcription-source-state")(
    {},
    {
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "input-generation-2",
    }
  );

  assert.deepEqual(states, [
    {
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "input-generation-2",
    },
  ]);
  unsubscribe();
  assert.equal(listeners.has("meeting-transcription-source-state"), false);
});

test("preload exposes generation-bound computer-audio level metadata", () => {
  const { rootApi, listeners } = loadPreloadApi();
  const levels = [];

  const unsubscribe = rootApi.onMeetingTranscriptionAudioLevel((payload) => levels.push(payload));
  listeners.get("meeting-transcription-audio-level")(
    {},
    {
      source: "system",
      level: 0.125,
      inputGeneration: "input-generation-3",
    }
  );

  assert.deepEqual(levels, [
    {
      source: "system",
      level: 0.125,
      inputGeneration: "input-generation-3",
    },
  ]);
  unsubscribe();
  assert.equal(listeners.has("meeting-transcription-audio-level"), false);
});
