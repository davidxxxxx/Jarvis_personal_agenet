const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNELS, assertId, assertSessionStatus } = require("../../src/jarvis/shared/contracts");
const registerJarvisIpc = require("../../src/jarvis/main/registerJarvisIpc");

function createIpcHarness(overrides = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const repository = {
    createSession: () => "created",
    setSessionStatus: () => "status-set",
    getSession: () => "session",
    listSessions: () => [],
    upsertTranscriptSegments: () => "segments-upserted",
    listTranscriptSegments: () => [],
    renamePerson: () => "renamed",
    listPeople: () => [],
    listAudioChunks: () => [],
    ...overrides,
  };
  registerJarvisIpc({ ipcMain, repository });
  return { handlers, repository };
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
    "getSession",
    "listAudioChunks",
    "listPeople",
    "listSegments",
    "listSessions",
    "renamePerson",
    "setSessionStatus",
    "stateChanged",
    "upsertSegments",
  ]);
  assert.equal(Object.isFrozen(CHANNELS), true);
});

test("IPC registers only request-response repository channels", () => {
  const { handlers } = createIpcHarness();

  assert.deepEqual([...handlers.keys()].sort(), [
    CHANNELS.createSession,
    CHANNELS.getSession,
    CHANNELS.listAudioChunks,
    CHANNELS.listPeople,
    CHANNELS.listSegments,
    CHANNELS.listSessions,
    CHANNELS.renamePerson,
    CHANNELS.setSessionStatus,
    CHANNELS.upsertSegments,
  ].sort());
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
  assert.throws(
    () => handlers.get(CHANNELS.listSegments)(null, "../s1"),
    /safe identifier/
  );
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

test("IPC registration rejects incomplete dependencies", () => {
  assert.throws(() => registerJarvisIpc({ ipcMain: null, repository: {} }), /ipcMain/);
  assert.throws(() => registerJarvisIpc({ ipcMain: { handle() {} }, repository: null }), /repository/);
});
