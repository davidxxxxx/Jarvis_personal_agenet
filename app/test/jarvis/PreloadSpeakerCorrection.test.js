const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi(invokeImpl) {
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
        return invokeImpl ? invokeImpl(...args) : Promise.resolve("invoked");
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

test("preload exposes only narrow named speaker correction invokes", async () => {
  const { api, invokes } = loadPreloadApi();
  const confirmation = { clusterId: "c1", personId: "p1", scope: "persistent" };

  await api.listSessionSpeakerClusters("s1");
  await api.confirmSpeaker(confirmation);
  await api.rejectSpeaker("c1", "p1");
  await api.undoSpeakerCorrection("c1");
  await api.listSpeakerCorrections("c1");
  await api.mergePeople("p-source", "p-target");

  assert.deepEqual(invokes, [
    ["jarvis:speaker:list-session", "s1"],
    ["jarvis:speaker:confirm", confirmation],
    ["jarvis:speaker:reject", "c1", "p1"],
    ["jarvis:speaker:undo", "c1"],
    ["jarvis:speaker:corrections", "c1"],
    ["jarvis:people:merge", "p-source", "p-target"],
  ]);
  assert.equal(api.invoke, undefined);
});

test("preload rejects malformed or private speaker inputs before IPC cloning", () => {
  const { api, invokes } = loadPreloadApi();
  for (const input of [
    null,
    [],
    { clusterId: "c1", scope: "session" },
    { clusterId: "c1", personId: "p1", newPersonName: "P1", scope: "session" },
    { clusterId: "c1", newPersonName: " ", scope: "session" },
    { clusterId: "c1", newPersonName: "界".repeat(81), scope: "session" },
    { clusterId: "c1", personId: "p1", scope: "session", actor: "system" },
    { clusterId: "c1", personId: "p1", scope: "session", embedding: new Float32Array(4) },
    { clusterId: "c1", personId: "p1", scope: "session", path: "secret.wav" },
  ]) {
    assert.throws(() => api.confirmSpeaker(input));
  }
  assert.throws(() => api.listSessionSpeakerClusters("../s1"));
  assert.throws(() => api.rejectSpeaker("c1", "../p1"));
  assert.throws(() => api.mergePeople("same", "same"));
  assert.equal(invokes.length, 0);
});

test("preload reconstructs public ambiguity details without forwarding envelope extras", async () => {
  const { api } = loadPreloadApi(async () => ({
    speakerCorrectionError: {
      code: "ambiguous_duplicate_name",
      candidates: [
        {
          id: "p1",
          displayName: "Alice",
          isSelf: false,
          embedding: [0.5],
          path: "private.wav",
        },
      ],
      path: "also-private.wav",
    },
  }));

  await assert.rejects(
    api.confirmSpeaker({ clusterId: "c1", newPersonName: "Alice", scope: "session" }),
    (error) => {
      assert.equal(error.code, "ambiguous_duplicate_name");
      assert.deepEqual(error.candidates, [{ id: "p1", displayName: "Alice", isSelf: false }]);
      assert.equal(error.path, undefined);
      return true;
    }
  );
});
