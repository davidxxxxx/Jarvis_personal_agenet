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
  return { api: exposed.get("electronAPI").jarvis, invokes, sends, listeners };
}

function payload(windows) {
  return {
    sampleRate: 24_000,
    channels: 1,
    format: "float32",
    recordedSampleCount: 24_000 * 30,
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
    () =>
      api.completeVoiceEnrollment(
        "session",
        payload([window(new Float32Array(600_001)), tiny(), tiny()])
      ),
    /payload cap/
  );
  assert.equal(invokes.length, 0);

  const valid = payload([
    window(new Float32Array([0.1]), 0),
    window(new Float32Array([0.2]), 1),
    window(new Float32Array([0.3]), 2),
  ]);
  assert.equal(await api.completeVoiceEnrollment("session", valid), "invoked");
  assert.deepEqual(invokes[0], ["jarvis:voice-enrollment:complete", "session", valid]);
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
  assert.deepEqual(invokes, [
    ["jarvis:capture:fail", "s1", "MIC_DISCONNECTED", 1_100],
  ]);
});
