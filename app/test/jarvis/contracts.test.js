const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
} = require("../../src/jarvis/shared/contracts");
const registerJarvisIpc = require("../../src/jarvis/main/registerJarvisIpc");

function createRepository(overrides = {}) {
  return {
    createSession: () => "created",
    setSessionStatus: () => "status-set",
    getSession: () => "session",
    listSessions: () => [],
    upsertTranscriptSegments: () => "segments-upserted",
    syncTranscriptSegments: () => "segments-synced",
    listTranscriptSegments: () => [],
    renamePerson: () => "renamed",
    listPeople: () => [],
    listAudioChunks: () => [],
    getAudioChunk: () => null,
    getSessionDetail: () => ({ session: { id: "s1" } }),
    searchMemory: () => [],
    listPeopleOverview: () => [],
    getPersonDetail: () => null,
    listTopics: () => [],
    getTopicDetail: () => null,
    renameTopic: () => null,
    listTodos: () => [],
    setTodoStatus: () => null,
    listMemories: () => [],
    getTodayInsights: () => null,
    getCloudBudgetStatus: () => ({
      monthUtc: "2026-07",
      enabled: false,
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      remainingMicrousd: 5_000_000,
      blockedReason: "cloud_disabled",
    }),
    setCloudBudgetSettings: () => ({ enabled: 0 }),
    ...overrides,
  };
}

function createService(overrides = {}) {
  return {
    startCapture: () => "capture-started",
    setRetentionMode: () => "retention-mode-set",
    sourceInterrupted: () => "source-interrupted",
    sourceRestored: () => "source-restored",
    pauseCapture: () => "capture-paused",
    resumeCapture: () => "capture-resumed",
    finishCapture: () => "capture-finished",
    failCapture: () => "capture-failed",
    ...overrides,
  };
}

function createVoiceEnrollmentService(overrides = {}) {
  return {
    getStatus: () => "voice-status",
    begin: () => "voice-begun",
    complete: () => "voice-enrolled",
    cancel: () => "voice-cancelled",
    cancelOwner: () => 0,
    ...overrides,
  };
}

function createIpcHarness(overrides = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const repository = createRepository(overrides);
  const service = createService();
  const voiceEnrollmentService = createVoiceEnrollmentService();
  const environmentManager = {
    getOpenAIKey: () => "sk-project-test",
    getMiniMaxKey: () => "sk-cp-test",
    saveMiniMaxKey: () => ({ success: true }),
  };
  const analysisScheduler = {
    analyzeSession: () => Promise.resolve({ state: "ready" }),
    getStatus: () => ({ state: "waiting" }),
  };
  registerJarvisIpc({
    ipcMain,
    repository,
    service,
    voiceEnrollmentService,
    environmentManager,
    analysisScheduler,
  });
  return {
    handlers,
    repository,
    service,
    voiceEnrollmentService,
    environmentManager,
    analysisScheduler,
  };
}

test("contract rejects path traversal and unknown states", () => {
  assert.throws(() => assertId("../secret", "sessionId"), /safe identifier/);
  assert.throws(() => assertSessionStatus("hidden-recording"), /invalid session status/);
  assert.equal(assertSessionStatus("recording"), "recording");
  assert.throws(() => assertSessionStatus("degraded"), /invalid session status/);
  assert.equal(assertCaptureMode("dual"), "dual");
  assert.equal(assertSourceType("system"), "system");
  assert.equal(assertRetentionMode("speech_triggered"), "speech_triggered");
  assert.throws(() => assertCaptureMode("auto"), /invalid capture mode/);
  assert.throws(() => assertSourceType("mixed"), /invalid source type/);
  assert.throws(() => assertRetentionMode("adaptive"), /invalid retention mode/);
});

test("retention mode IPC validates mode and forwards a sanitized session id", () => {
  const calls = [];
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({ setRetentionMode: (...args) => calls.push(args) }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  handlers.get(CHANNELS.setRetentionMode)(null, "session-1", "continuous", 1_100);
  assert.deepEqual(calls, [["session-1", "continuous", 1_100]]);
  assert.throws(
    () => handlers.get(CHANNELS.setRetentionMode)(null, "session-1", "adaptive", 1_200),
    /invalid retention mode/
  );
  assert.throws(
    () => handlers.get(CHANNELS.setRetentionMode)(null, "../escape", "continuous", 1_200),
    /safe identifier/
  );
  assert.equal(calls.length, 1);
});

test("audio read IPC returns a verified playable WAV for authoritative FLAC", async () => {
  const handlers = new Map();
  const chunk = { id: "c1", format: "flac", path: "opaque.flac", pcm_sha256: "hash" };
  const playable = Buffer.from("verified-wav");
  const calls = [];
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({ getAudioChunk: () => chunk }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    audioEvidenceReader: {
      async readPlayableWav(input) {
        calls.push(input);
        return playable;
      },
    },
  });

  const result = await handlers.get(CHANNELS.readAudioChunk)(null, "c1");

  assert.equal(result, playable);
  assert.deepEqual(calls, [chunk]);
});

test("retired provenance is private at audio IPC boundaries", () => {
  const handlers = new Map();
  const privateChunk = {
    id: "c1",
    session_id: "s1",
    path: "speech.wav",
    format: "wav",
    retired_path: "private.flac",
    retired_format: "flac",
    retired_file_sha256: "b".repeat(64),
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({
      listAudioChunks: () => [privateChunk],
      getSessionDetail: () => ({ session: { id: "s1" }, audioChunks: [privateChunk] }),
    }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  const list = handlers.get(CHANNELS.listAudioChunks)(null, "s1");
  const detail = handlers.get(CHANNELS.getSessionDetail)(null, "s1");
  for (const chunk of [list[0], detail.audioChunks[0]]) {
    assert.equal(Object.hasOwn(chunk, "retired_path"), false);
    assert.equal(Object.hasOwn(chunk, "retired_format"), false);
    assert.equal(Object.hasOwn(chunk, "retired_file_sha256"), false);
  }
});

test("start capture IPC rejects invalid source selections before calling the service", () => {
  let calls = 0;
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({
      startCapture() {
        calls += 1;
      },
    }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        captureMode: "dual",
        sources: [{ sourceType: "mic" }],
      }),
    /sources must exactly match capture mode dual/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        captureMode: "auto",
        sources: [],
      }),
    /invalid capture mode/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        micDeviceId: "contradictory-mic",
        captureMode: "system",
        sources: [
          {
            sourceType: "system",
            deviceId: null,
            deviceLabel: null,
            strategy: "wasapi-loopback",
          },
        ],
      }),
    /micDeviceId must match the selected capture sources/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        micDeviceId: "mic-a",
        captureMode: "dual",
        sources: [
          { sourceType: "mic", deviceId: "mic-b" },
          { sourceType: "system", deviceId: null },
        ],
      }),
    /micDeviceId must match the selected capture sources/
  );
  assert.equal(calls, 0);
});

test("capture modes require their exact unique source set", () => {
  const { normalizeCaptureSources } = require("../../src/jarvis/shared/captureModes");
  const mic = { sourceType: "mic" };
  const system = { sourceType: "system" };

  assert.throws(() => normalizeCaptureSources("dual", [mic, mic]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("mic", [mic, system]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("system", [mic]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("mic", [system]), /exactly match/);
  assert.deepEqual(
    normalizeCaptureSources("dual", [system, mic]).map((source) => source.sourceType),
    ["mic", "system"]
  );
});

test("source lifecycle IPC validates metadata and forwards only sanitized inputs", () => {
  const interrupted = [];
  const restored = [];
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({
      sourceInterrupted: (...args) => interrupted.push(args),
      sourceRestored: (...args) => restored.push(args),
    }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  handlers.get(CHANNELS.sourceInterrupted)(null, "session-1", "mic", {
    at: 1_100,
    reason: "mic-track-ended",
  });
  handlers.get(CHANNELS.sourceRestored)(null, "session-1", "mic", {
    at: 1_200,
    deviceId: "physical-mic",
    deviceLabel: "Physical microphone",
    strategy: "web-audio",
  });

  assert.deepEqual(interrupted, [["session-1", "mic", { at: 1_100, reason: "mic-track-ended" }]]);
  assert.deepEqual(restored, [
    [
      "session-1",
      "mic",
      {
        at: 1_200,
        deviceId: "physical-mic",
        deviceLabel: "Physical microphone",
        strategy: "web-audio",
      },
    ],
  ]);

  for (const [channel, args] of [
    [CHANNELS.sourceInterrupted, ["../escape", "mic", { at: 1, reason: "ended" }]],
    [CHANNELS.sourceInterrupted, ["session-1", "mixed", { at: 1, reason: "ended" }]],
    [CHANNELS.sourceInterrupted, ["session-1", "mic", { at: 1, reason: "" }]],
    [
      CHANNELS.sourceRestored,
      ["session-1", "mic", { at: 2, deviceId: 7, deviceLabel: null, strategy: null }],
    ],
  ]) {
    assert.throws(() => handlers.get(channel)(null, ...args));
  }
  assert.equal(interrupted.length, 1);
  assert.equal(restored.length, 1);
});

test("contract exposes only the named Jarvis channels", () => {
  assert.deepEqual(
    Object.keys(CHANNELS).sort(),
    [
      "beginVoiceEnrollment",
      "cancelVoiceEnrollment",
      "completeVoiceEnrollment",
      "control",
      "createSession",
      "failCapture",
      "finishCapture",
      "getAnalysisStatus",
      "getCloudBudget",
      "getMiniMaxConfig",
      "getPersonDetail",
      "getSession",
      "getSessionDetail",
      "getTodayInsights",
      "getTopicDetail",
      "getVoiceEnrollmentStatus",
      "analyzeSession",
      "listAudioChunks",
      "readAudioChunk",
      "listMemories",
      "listPeople",
      "listPeopleOverview",
      "listSegments",
      "listSessions",
      "listTodos",
      "listTopics",
      "pauseCapture",
      "renamePerson",
      "resumeCapture",
      "setCloudBudget",
      "setMiniMaxKey",
      "setSessionStatus",
      "setRetentionMode",
      "setTodoStatus",
      "sourceInterrupted",
      "sourceRestored",
      "startCapture",
      "stateChanged",
      "syncSegments",
      "searchMemory",
      "renameTopic",
      "upsertSegments",
    ].sort()
  );
  assert.equal(Object.isFrozen(CHANNELS), true);
});

test("IPC registers only request-response repository channels", () => {
  const { handlers } = createIpcHarness();

  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      CHANNELS.createSession,
      CHANNELS.getSession,
      CHANNELS.listAudioChunks,
      CHANNELS.readAudioChunk,
      CHANNELS.listPeople,
      CHANNELS.listSegments,
      CHANNELS.listSessions,
      CHANNELS.renamePerson,
      CHANNELS.setSessionStatus,
      CHANNELS.setRetentionMode,
      CHANNELS.syncSegments,
      CHANNELS.upsertSegments,
      CHANNELS.startCapture,
      CHANNELS.sourceInterrupted,
      CHANNELS.sourceRestored,
      CHANNELS.pauseCapture,
      CHANNELS.resumeCapture,
      CHANNELS.finishCapture,
      CHANNELS.failCapture,
      CHANNELS.beginVoiceEnrollment,
      CHANNELS.getVoiceEnrollmentStatus,
      CHANNELS.completeVoiceEnrollment,
      CHANNELS.cancelVoiceEnrollment,
      CHANNELS.getCloudBudget,
      CHANNELS.setCloudBudget,
      CHANNELS.getSessionDetail,
      CHANNELS.searchMemory,
      CHANNELS.listPeopleOverview,
      CHANNELS.getPersonDetail,
      CHANNELS.listTopics,
      CHANNELS.getTopicDetail,
      CHANNELS.renameTopic,
      CHANNELS.listTodos,
      CHANNELS.setTodoStatus,
      CHANNELS.listMemories,
      CHANNELS.getTodayInsights,
      CHANNELS.analyzeSession,
      CHANNELS.getAnalysisStatus,
      CHANNELS.getMiniMaxConfig,
      CHANNELS.setMiniMaxKey,
    ].sort()
  );
  assert.equal(handlers.has(CHANNELS.control), false);
  assert.equal(handlers.has(CHANNELS.stateChanged), false);
});

test("IPC exposes MiniMax configured state without returning the secret", async () => {
  const { handlers } = createIpcHarness();
  const config = await handlers.get(CHANNELS.getMiniMaxConfig)();
  const expectedModel = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
  assert.deepEqual(config, { keyConfigured: true, model: expectedModel });
  assert.doesNotMatch(JSON.stringify(config), /sk-cp/);
  const saved = await handlers.get(CHANNELS.setMiniMaxKey)(null, "new-token-plan-key");
  assert.deepEqual(saved, { keyConfigured: true, model: expectedModel });
});

test("IPC returns metadata-only self voice enrollment status", async () => {
  const { handlers } = createIpcHarness();

  assert.equal(
    await handlers.get(CHANNELS.getVoiceEnrollmentStatus)({ sender: { id: 7 } }),
    "voice-status"
  );
});

test("IPC returns cloud budget status without exposing the project key", async () => {
  let savedSettings = null;
  const { handlers } = createIpcHarness({
    setCloudBudgetSettings(input) {
      savedSettings = input;
    },
    getCloudBudgetStatus() {
      return {
        monthUtc: "2026-07",
        enabled: true,
        monthlyLimitMicrousd: 10_000_000,
        spentMicrousd: 1200,
        reservedMicrousd: 100_000,
        remainingMicrousd: 9_898_800,
        blockedReason: null,
      };
    },
  });

  const initial = await handlers.get(CHANNELS.getCloudBudget)();
  assert.equal(initial.keyConfigured, true);
  assert.equal(JSON.stringify(initial).includes("sk-project-test"), false);

  const updated = await handlers.get(CHANNELS.setCloudBudget)(null, {
    enabled: true,
    monthlyLimitMicrousd: 10_000_000,
  });
  assert.deepEqual(savedSettings, {
    enabled: true,
    monthlyLimitMicrousd: 10_000_000,
  });
  assert.equal(updated.keyConfigured, true);
  assert.equal(updated.monthlyLimitMicrousd, 10_000_000);
});

test("IPC validates identifiers and statuses before calling the repository", () => {
  let calls = 0;
  const { handlers } = createIpcHarness({
    setSessionStatus() {
      calls += 1;
    },
    listTranscriptSegments() {
      calls += 1;
    },
  });

  assert.throws(
    () => handlers.get(CHANNELS.setSessionStatus)(null, "../s1", "recording", 1000),
    /safe identifier/
  );
  assert.throws(
    () => handlers.get(CHANNELS.setSessionStatus)(null, "s1", "hidden-recording", 1000),
    /invalid session status/
  );
  assert.throws(() => handlers.get(CHANNELS.listSegments)(null, "../s1"), /safe identifier/);
  assert.equal(calls, 0);
});

test("IPC preserves repository errors for Electron invoke rejection", () => {
  const expected = new Error("database closed");
  const { handlers } = createIpcHarness({
    getSession() {
      throw expected;
    },
  });

  assert.throws(() => handlers.get(CHANNELS.getSession)(null, "s1"), expected);
});

test("IPC binds narrow voice enrollment sessions to the requesting renderer", async () => {
  const { handlers, voiceEnrollmentService } = createIpcHarness();
  const event = { sender: { id: 42 } };
  const payload = { sampleRate: 24_000, channels: 1, format: "float32", windows: [] };

  assert.equal(await handlers.get(CHANNELS.beginVoiceEnrollment)(event), "voice-begun");
  assert.equal(
    await handlers.get(CHANNELS.completeVoiceEnrollment)(event, "opaque-id", payload),
    "voice-enrolled"
  );
  assert.equal(handlers.get(CHANNELS.cancelVoiceEnrollment)(event, "opaque-id"), "voice-cancelled");
  assert.equal(typeof voiceEnrollmentService.complete, "function");
});

test("IPC cancels renderer-owned enrollment when the sender is destroyed", () => {
  let destroyedListener;
  const cancelOwnerCalls = [];
  const voiceEnrollmentService = createVoiceEnrollmentService({
    cancelOwner(ownerId) {
      cancelOwnerCalls.push(ownerId);
      return 1;
    },
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService,
    environmentManager: { getOpenAIKey: () => null },
  });
  const event = {
    sender: {
      id: 42,
      once(name, listener) {
        assert.equal(name, "destroyed");
        destroyedListener = listener;
      },
    },
  };

  handlers.get(CHANNELS.beginVoiceEnrollment)(event);
  handlers.get(CHANNELS.beginVoiceEnrollment)(event);
  assert.equal(typeof destroyedListener, "function");
  destroyedListener();
  assert.deepEqual(cancelOwnerCalls, [42]);
});

test("IPC registration rejects invalid IPC and missing handler capabilities", () => {
  assert.throws(() => registerJarvisIpc({ ipcMain: null, repository: {}, service: {} }), /ipcMain/);
  assert.throws(
    () =>
      registerJarvisIpc({
        ipcMain: { handle() {} },
        repository: null,
        service: {},
        voiceEnrollmentService: {},
      }),
    /repository/
  );

  const requiredMethods = [
    "createSession",
    "setSessionStatus",
    "getSession",
    "listSessions",
    "upsertTranscriptSegments",
    "syncTranscriptSegments",
    "listTranscriptSegments",
    "renamePerson",
    "listPeople",
    "listAudioChunks",
    "getCloudBudgetStatus",
    "setCloudBudgetSettings",
  ];
  for (const method of requiredMethods) {
    const repository = createRepository();
    delete repository[method];
    const registered = [];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle: (channel) => registered.push(channel) },
          repository,
          service: createService(),
          voiceEnrollmentService: createVoiceEnrollmentService(),
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`repository\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  for (const method of [
    "startCapture",
    "setRetentionMode",
    "sourceInterrupted",
    "sourceRestored",
    "pauseCapture",
    "resumeCapture",
    "finishCapture",
    "failCapture",
  ]) {
    const service = createService();
    delete service[method];
    const registered = [];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle: (channel) => registered.push(channel) },
          repository: createRepository(),
          service,
          voiceEnrollmentService: createVoiceEnrollmentService(),
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`service\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  for (const method of ["begin", "complete", "cancel", "cancelOwner"]) {
    const voiceEnrollmentService = createVoiceEnrollmentService();
    delete voiceEnrollmentService[method];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle() {} },
          repository: createRepository(),
          service: createService(),
          voiceEnrollmentService,
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`voiceEnrollmentService\\.${method} must be a function`)
    );
  }
});

test("failCapture IPC validates known codes and preserves authoritative failed broadcast", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const JarvisService = require("../../src/jarvis/main/JarvisService");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fail-ipc-"));
  const session = { id: "s1", status: "recording" };
  const broadcasts = [];
  const repository = {
    getSession: () => session,
    setSessionStatus: (_id, status) => {
      session.status = status;
    },
    insertAudioChunk: () => {},
    createTrack: () => {},
    createTracks: () => {},
    setTrackState: () => {},
    openGap: () => {},
    interruptTrack: () => {},
    closeGap: () => {},
    restoreTrack: () => {},
    pauseCapture: () => {},
    resumeCapture: () => {},
    finalizeCapture: ({ sessionStatus }) => {
      session.status = sessionStatus;
    },
    setSessionRetention: () => {},
    recordEvidenceGap: () => {},
    commitChunk: () => {},
    recoverOpenSessions: () => [],
  };
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  const service = new JarvisService({
    repository,
    userDataDir,
    now: () => 1_100,
    fsImpl,
    broadcast: (state) => broadcasts.push(state),
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service,
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.throws(
      () => handlers.get(CHANNELS.failCapture)(null, "s1", "upstream_stop_failed", 1_100),
      /capture failure code/
    );
    handlers.get(CHANNELS.failCapture)(null, "s1", "capture_source_unavailable", 1_100);

    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "capture_source_unavailable");
    assert.equal(session.status, "failed");
    assert.equal(broadcasts.at(-1).status, "failed");
    assert.equal(broadcasts.at(-1).errorCode, "capture_source_unavailable");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
