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
  modelStatus: "ready",
  fallbackUsed: false,
  checkedAt: 1_000,
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

const resourceSettings = {
  profile: "balanced",
  externalGpuThresholdPct: 45,
  recoveryWaitMs: 60_000,
  privatePath: "C:\\private\\resource.json",
};

const applicationAudioStatus = {
  enabled: true,
  trackLimit: 4,
  fallbackPolicy: "conservative",
  runtime: {
    running: true,
    configuredLimit: 4,
    effectiveLimit: 2,
    fullscreen: true,
    activeTracks: [
      {
        applicationKey: "chrome",
        applicationDisplayName: "Chrome",
        captureGeneration: 7,
        state: "recording",
        processId: 1234,
      },
    ],
    fallbacks: [
      {
        applicationKey: "kook",
        applicationDisplayName: "KOOK",
        reason: "capture_failed",
        retryAt: 9_000,
        state: "mixed_unknown",
        executablePath: "C:\\private\\kook.exe",
      },
    ],
  },
  privatePath: "C:\\private\\application-audio.json",
};

test("preload exposes only explicit safe todo reminder inputs", async () => {
  const { api, invokes } = loadPreloadApi();
  await api.getTodoReminder("todo_1");
  await api.setTodoReminder("todo_1", 9_000);
  await api.setTodoReminder("todo_1", null);
  assert.deepEqual(invokes, [
    ["jarvis:todo-reminder:get", "todo_1"],
    ["jarvis:todo-reminder:set", { todoId: "todo_1", reminderAt: 9_000 }],
    ["jarvis:todo-reminder:set", { todoId: "todo_1", reminderAt: null }],
  ]);
  assert.throws(() => api.getTodoReminder("../private"));
  assert.throws(() => api.setTodoReminder("todo_1", -1));
});

test("preload exposes the lightweight action center watermark channel", async () => {
  const { api, invokes } = loadPreloadApi();
  await api.getActionCenterWatermark();
  await api.getActionCenterDelta();
  await api.markActionCenterRead(7);
  assert.deepEqual(invokes, [
    ["jarvis:memory:v2-action-watermark"],
    ["jarvis:memory:v2-action-delta"],
    ["jarvis:memory:v2-action-read", { throughSequence: 7 }],
  ]);
  assert.throws(() => api.markActionCenterRead(-1));
});

test("preload validates the four rollout flags returned by the main process", async () => {
  const rolloutFlags = {
    applicationAudioV1: true,
    dualSpeakerVerificationV1: false,
    activityClassificationV1: true,
    actionCenterV1: false,
  };
  const { api, invokes } = loadPreloadApi({ responder: () => rolloutFlags });

  assert.deepEqual(await api.getRolloutFlags(), rolloutFlags);
  assert.deepEqual(invokes, [["jarvis:rollout-flags:get"]]);

  const invalid = loadPreloadApi({ responder: () => ({ ...rolloutFlags, privatePath: "x" }) });
  await assert.rejects(() => invalid.api.getRolloutFlags(), /exact keys/u);
});

test("preload sends exact MiniMax and analysis-budget inputs and rebuilds safe responses", async () => {
  const { api, invokes } = loadPreloadApi({
    responder(channel) {
      return channel.includes("minimax") ? config : budget;
    },
  });

  assert.deepEqual(await api.setMiniMaxKey(" sk-cp-user-key "), {
    keyConfigured: true,
    model: "MiniMax-M2.7",
    modelStatus: "ready",
    fallbackUsed: false,
    checkedAt: 1_000,
  });
  assert.deepEqual(await api.clearMiniMaxKey(), {
    keyConfigured: true,
    model: "MiniMax-M2.7",
    modelStatus: "ready",
    fallbackUsed: false,
    checkedAt: 1_000,
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

test("preload validates resource governance updates and strips private response fields", async () => {
  const { api, invokes } = loadPreloadApi({ responder: () => resourceSettings });

  assert.deepEqual(await api.getResourceGovernance(), {
    profile: "balanced",
    externalGpuThresholdPct: 45,
    recoveryWaitMs: 60_000,
  });
  assert.deepEqual(
    await api.setResourceGovernance({
      profile: "game_priority",
      externalGpuThresholdPct: 25,
      recoveryWaitMs: 180_000,
    }),
    {
      profile: "balanced",
      externalGpuThresholdPct: 45,
      recoveryWaitMs: 60_000,
    }
  );
  assert.deepEqual(invokes, [
    ["jarvis:resource-governance:get"],
    [
      "jarvis:resource-governance:set",
      {
        profile: "game_priority",
        externalGpuThresholdPct: 25,
        recoveryWaitMs: 180_000,
      },
    ],
  ]);

  for (const input of [
    { profile: "unknown", externalGpuThresholdPct: 45, recoveryWaitMs: 60_000 },
    { profile: "balanced", externalGpuThresholdPct: 9, recoveryWaitMs: 60_000 },
    { profile: "balanced", externalGpuThresholdPct: 45, recoveryWaitMs: 300_001 },
  ]) {
    assert.throws(() => api.setResourceGovernance(input));
  }
  assert.equal(invokes.length, 2);
});

test("preload validates application audio settings and strips process identity fields", async () => {
  const { api, invokes } = loadPreloadApi({ responder: () => applicationAudioStatus });

  const expected = {
    enabled: true,
    trackLimit: 4,
    fallbackPolicy: "conservative",
    runtime: {
      running: true,
      configuredLimit: 4,
      effectiveLimit: 2,
      fullscreen: true,
      activeTracks: [
        {
          applicationKey: "chrome",
          applicationDisplayName: "Chrome",
          captureGeneration: 7,
          state: "recording",
        },
      ],
      fallbacks: [
        {
          applicationKey: "kook",
          applicationDisplayName: "KOOK",
          reason: "capture_failed",
          retryAt: 9_000,
          state: "mixed_unknown",
        },
      ],
    },
  };
  assert.deepEqual(await api.getApplicationAudioSettings(), expected);
  assert.deepEqual(
    await api.setApplicationAudioSettings({
      enabled: false,
      trackLimit: 8,
      fallbackPolicy: "transcript_only",
    }),
    expected
  );
  assert.deepEqual(invokes, [
    ["jarvis:application-audio:get"],
    [
      "jarvis:application-audio:set",
      { enabled: false, trackLimit: 8, fallbackPolicy: "transcript_only" },
    ],
  ]);

  for (const input of [
    { enabled: "yes", trackLimit: 4, fallbackPolicy: "conservative" },
    { enabled: true, trackLimit: 0, fallbackPolicy: "conservative" },
    { enabled: true, trackLimit: 9, fallbackPolicy: "conservative" },
    { enabled: true, trackLimit: 4, fallbackPolicy: "unsafe" },
    { enabled: true, trackLimit: 4, fallbackPolicy: "conservative", extra: true },
  ]) {
    assert.throws(() => api.setApplicationAudioSettings(input));
  }
  assert.equal(invokes.length, 2);
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
    () => failed.api.getResourceGovernance(),
    () =>
      failed.api.setResourceGovernance({
        profile: "balanced",
        externalGpuThresholdPct: 45,
        recoveryWaitMs: 60_000,
      }),
    () => failed.api.getApplicationAudioSettings(),
    () =>
      failed.api.setApplicationAudioSettings({
        enabled: true,
        trackLimit: 4,
        fallbackPolicy: "conservative",
      }),
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
