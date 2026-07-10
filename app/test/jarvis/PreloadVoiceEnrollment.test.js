const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi() {
  const exposed = new Map();
  const invokes = [];
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
      on() {},
      removeListener() {},
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
  return { api: exposed.get("electronAPI").jarvis, invokes };
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
