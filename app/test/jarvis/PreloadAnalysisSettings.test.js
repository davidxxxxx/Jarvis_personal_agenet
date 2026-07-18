const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi({ responder, rejection = null } = {}) {
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
        if (rejection) return Promise.reject(rejection);
        return Promise.resolve(responder ? responder(...args) : null);
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

const config = {
  keyConfigured: true,
  model: "MiniMax-M2.7",
  key: "sk-cp-private",
  path: "C:\\private\\key",
};

const budget = {
  mode: "capped",
  monthKey: "2026-07",
  timezone: "Asia/Shanghai",
  currency: "USD",
  monthlyLimitMicrousd: 5_000_000,
  spentMicrousd: 1_000_000,
  reservedMicrousd: 500_000,
  remainingMicrousd: 3_500_000,
  blockedReason: null,
  requestId: "private-request",
  rawError: "C:\\private\\ledger.db",
};

test("preload sends exact MiniMax and analysis-budget inputs and rebuilds safe responses", async () => {
  const { api, invokes } = loadPreloadApi({
    responder(channel) {
      return channel.includes("minimax") ? config : budget;
    },
  });

  assert.deepEqual(await api.setMiniMaxKey(" sk-cp-user-key "), {
    keyConfigured: true,
    model: "MiniMax-M2.7",
  });
  assert.deepEqual(await api.clearMiniMaxKey(), {
    keyConfigured: true,
    model: "MiniMax-M2.7",
  });
  assert.deepEqual(
    await api.setAnalysisBudget({
      mode: "unlimited",
      monthlyLimitMicrousd: 200_000_000,
      timezone: "UTC",
    }),
    {
    mode: "capped",
    monthKey: "2026-07",
    timezone: "Asia/Shanghai",
    currency: "USD",
    monthlyLimitMicrousd: 5_000_000,
    spentMicrousd: 1_000_000,
    reservedMicrousd: 500_000,
    remainingMicrousd: 3_500_000,
    blockedReason: null,
    }
  );
  assert.deepEqual(invokes, [
    ["jarvis:minimax:set-key", { key: "sk-cp-user-key" }],
    ["jarvis:minimax:clear-key"],
    [
      "jarvis:analysis-budget:set",
      { mode: "unlimited", monthlyLimitMicrousd: 200_000_000, timezone: "UTC" },
    ],
  ]);
});

test("preload rejects malformed MiniMax and analysis-budget inputs before IPC", () => {
  const { api, invokes } = loadPreloadApi();

  for (const key of ["", " ".repeat(4), "x".repeat(513)]) {
    assert.throws(() => api.setMiniMaxKey(key));
  }
  for (const input of [
    { mode: "capped", monthlyLimitMicrousd: -1, timezone: "UTC" },
    { mode: "capped", monthlyLimitMicrousd: 1_000_000_000_001, timezone: "UTC" },
    { mode: "forever", monthlyLimitMicrousd: 5_000_000, timezone: "UTC" },
    { mode: "capped", monthlyLimitMicrousd: 5_000_000, timezone: "UTC", extra: true },
  ]) {
    assert.throws(() => api.setAnalysisBudget(input));
  }
  assert.deepEqual(invokes, []);
});

test("preload strips private analysis status fields and masks raw IPC failures", async () => {
  const status = {
    sessionId: "session-1",
    state: "queued",
    errorCode: null,
    updatedAt: 9_000,
    jobId: "private-job",
    desiredVectorHash: "private-hash",
    reused: true,
    rawError: "C:\\private\\provider.log",
  };
  const { api } = loadPreloadApi({ responder: () => status });
  assert.deepEqual(await api.analyzeSession("session-1", "final"), {
    sessionId: "session-1",
    state: "queued",
    errorCode: null,
    updatedAt: 9_000,
  });
  assert.deepEqual(await api.getAnalysisStatus("session-1"), {
    sessionId: "session-1",
    state: "queued",
    errorCode: null,
    updatedAt: 9_000,
  });

  const failed = loadPreloadApi({
    rejection: new Error("C:\\private\\jarvis.db sk-cp-secret raw provider response"),
  });
  for (const operation of [
    () => failed.api.getMiniMaxConfig(),
    () => failed.api.setMiniMaxKey("sk-cp-secret"),
    () => failed.api.clearMiniMaxKey(),
    () => failed.api.getAnalysisBudget(),
    () => failed.api.setAnalysisBudget({ monthlyLimitMicrousd: 5_000_000, timezone: "UTC" }),
    () => failed.api.getAnalysisStatus("session-1"),
    () => failed.api.analyzeSession("session-1", "final"),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(JSON.stringify(error).includes("private"), false);
      assert.equal(error.message.includes("private"), false);
      assert.equal(error.message.includes("sk-cp"), false);
      return true;
    });
  }
});
