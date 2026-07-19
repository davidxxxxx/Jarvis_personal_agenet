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
        return Promise.resolve([]);
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
  return { api: exposed.get("electronAPI").jarvis, invokes };
}

test("preload exposes a narrow activity-classification session query", async () => {
  const { api, invokes } = loadPreloadApi();

  await api.listActivityClassifications("session-1");

  assert.deepEqual(invokes, [["jarvis:activity:list-session", "session-1"]]);
  assert.equal(api.invoke, undefined);
});

test("preload rejects unsafe activity-classification session ids", () => {
  const { api, invokes } = loadPreloadApi();

  for (const sessionId of ["", "../session", "session/1", "界"]) {
    assert.throws(() => api.listActivityClassifications(sessionId));
  }
  assert.equal(invokes.length, 0);
});
