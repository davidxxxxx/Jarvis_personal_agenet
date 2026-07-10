const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNELS, assertId, assertSessionStatus } = require("../../src/jarvis/shared/contracts");
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
    ...overrides,
  };
}

function createService(overrides = {}) {
  return {
    startCapture: () => "capture-started",
    pauseCapture: () => "capture-paused",
    resumeCapture: () => "capture-resumed",
    finishCapture: () => "capture-finished",
    ...overrides,
  };
}

function createVoiceEnrollmentService(overrides = {}) {
  return {
    enroll: () => "voice-enrolled",
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
  registerJarvisIpc({ ipcMain, repository, service, voiceEnrollmentService });
  return { handlers, repository, service, voiceEnrollmentService };
}

test("contract rejects path traversal and unknown states", () => {
  assert.throws(() => assertId("../secret", "sessionId"), /safe identifier/);
  assert.throws(() => assertSessionStatus("hidden-recording"), /invalid session status/);
  assert.equal(assertSessionStatus("recording"), "recording");
});

test("contract exposes only the named Jarvis channels", () => {
  assert.deepEqual(Object.keys(CHANNELS).sort(), [
    "control",
    "createSession",
    "enrollVoice",
    "finishCapture",
    "getSession",
    "listAudioChunks",
    "listPeople",
    "listSegments",
    "listSessions",
    "pauseCapture",
    "renamePerson",
    "resumeCapture",
    "setSessionStatus",
    "startCapture",
    "stateChanged",
    "syncSegments",
    "upsertSegments",
  ]);
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
      CHANNELS.listPeople,
      CHANNELS.listSegments,
      CHANNELS.listSessions,
      CHANNELS.renamePerson,
      CHANNELS.setSessionStatus,
      CHANNELS.syncSegments,
      CHANNELS.upsertSegments,
      CHANNELS.startCapture,
      CHANNELS.pauseCapture,
      CHANNELS.resumeCapture,
      CHANNELS.finishCapture,
      CHANNELS.enrollVoice,
    ].sort()
  );
  assert.equal(handlers.has(CHANNELS.control), false);
  assert.equal(handlers.has(CHANNELS.stateChanged), false);
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

test("IPC sends voice enrollment windows only to the local enrollment service", async () => {
  const { handlers, voiceEnrollmentService } = createIpcHarness();
  const windows = [{ startSample: 0, endSample: 1, samples: new Float32Array([0.1]) }];

  assert.equal(await handlers.get(CHANNELS.enrollVoice)(null, windows), "voice-enrolled");
  assert.equal(typeof voiceEnrollmentService.enroll, "function");
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
        }),
      new RegExp(`repository\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  for (const method of ["startCapture", "pauseCapture", "resumeCapture", "finishCapture"]) {
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
        }),
      new RegExp(`service\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  assert.throws(
    () =>
      registerJarvisIpc({
        ipcMain: { handle() {} },
        repository: createRepository(),
        service: createService(),
        voiceEnrollmentService: {},
      }),
    /voiceEnrollmentService\.enroll must be a function/
  );
});
