const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi({ response = null, rejection = null } = {}) {
  let exposed;
  const invokes = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name, value) {
        exposed = value;
      },
    },
    ipcRenderer: {
      invoke(...args) {
        invokes.push(args);
        return rejection ? Promise.reject(rejection) : Promise.resolve(response);
      },
      send() {},
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
  return { api: exposed.jarvis, invokes };
}

function context(overrides = {}) {
  return {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
    sessionId: "session_1",
    sessionStartedAt: 1_000,
    sessionEndedAt: 5_000,
    transcriptSegmentId: "segment_1",
    transcriptState: "available",
    trackId: "track_1",
    sourceType: "mic",
    startedAt: 1_500,
    endedAt: 2_500,
    quoteText: "Stored quote",
    audioState: "available",
    ...overrides,
  };
}

test("preload validates evidence ownership handles before invoking main", async () => {
  const { api, invokes } = loadPreloadApi({ response: context() });
  const request = {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  };

  assert.deepEqual(await api.getEvidenceContext(request), context());
  assert.deepEqual(invokes, [["jarvis:evidence:get-context", request]]);
  assert.throws(() => api.getEvidenceContext({ ...request, sessionId: "forged" }));
  assert.throws(() => api.getEvidenceContext({ ...request, ownerId: "../escape" }));
  assert.equal(invokes.length, 1);
});

test("preload strips non-allowlisted evidence response fields and masks raw IPC errors", async () => {
  const request = {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  };
  const { api } = loadPreloadApi({
    response: {
      ...context(),
      path: "C:\\private\\capture.flac",
      file_sha256: "a".repeat(64),
      device_label: "private microphone",
      rawError: "private stack",
    },
  });
  const result = await api.getEvidenceContext(request);
  assert.equal(JSON.stringify(result).includes("private"), false);

  const failed = loadPreloadApi({
    rejection: new Error("C:\\private\\jarvis.db internal SQL failed"),
  });
  await assert.rejects(failed.api.getEvidenceContext(request), (error) => {
    assert.equal(error.code, "EVIDENCE_CONTEXT_UNAVAILABLE");
    assert.equal(error.message, "Evidence context is unavailable");
    return true;
  });
});
