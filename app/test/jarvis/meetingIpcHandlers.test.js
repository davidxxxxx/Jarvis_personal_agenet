const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function createFixture({
  appendPcm = () => true,
  onDerived = () => {},
  systemAvailable = false,
  aecAvailable = false,
} = {}) {
  const handles = new Map();
  const listeners = new Map();
  const sent = [];
  const detectionStates = [];
  const managerStops = [];
  const derivedCalls = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-meeting-ipc-"));
  const sender = {
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
  };
  const win = {
    isDestroyed: () => false,
    webContents: sender,
  };
  const electron = {
    ipcMain: {
      handle: (channel, handler) => handles.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
      emit() {},
    },
    app: {
      dock: null,
      getPath: () => tempDir,
      getVersion: () => "0.0.0-test",
      getLoginItemSettings: () => ({}),
      setLoginItemSettings() {},
    },
    shell: { showItemInFolder() {}, openExternal: async () => {} },
    BrowserWindow: {
      fromWebContents: () => win,
      getAllWindows: () => [win],
    },
    systemPreferences: {
      askForMediaAccess: async () => false,
      getMediaAccessStatus: () => "denied",
      isTrustedAccessibilityClient: () => false,
    },
    net: { fetch: async () => ({ ok: false, json: async () => ({}) }) },
  };

  const ipcHandlersPath = path.resolve(__dirname, "../../src/helpers/ipcHandlers.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  let IPCHandlers;
  try {
    delete require.cache[ipcHandlersPath];
    IPCHandlers = require(ipcHandlersPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[ipcHandlersPath];
  }

  let managedOptions = null;
  const windowsLoopbackAudioManager = {
    getCapability: async () => ({ available: systemAvailable }),
    start: async (options) => {
      managedOptions = options;
    },
    stop: async () => {
      managerStops.push("stop");
    },
  };
  const meetingAecManager = {
    isAvailable: () => aecAvailable,
    start: async () => aecAvailable,
    stop: async () => {},
    processSystemBuffer: (buffer) => {
      derivedCalls.push(["system", buffer]);
      onDerived("system", buffer);
      return true;
    },
    processMicBuffer: (buffer) => {
      derivedCalls.push(["mic", buffer]);
      onDerived("mic", buffer);
      return true;
    },
  };
  const instance = Object.assign(Object.create(IPCHandlers.prototype), {
    environmentManager: {},
    databaseManager: {},
    whisperManager: {
      transcribeLocalWhisper: async () => ({ success: true, text: "" }),
    },
    parakeetManager: {},
    diarizationManager: null,
    windowManager: { controlPanelWindow: win },
    meetingDetectionEngine: {
      setUserRecording: (value) => detectionStates.push(value),
    },
    audioTapManager: null,
    linuxPortalAudioManager: null,
    windowsLoopbackAudioManager,
    meetingAecManager,
    jarvisService: { appendPcm },
    jarvisRepository: null,
    openAiCorrectionService: null,
    speakerDiarizationEnabled: false,
    activeMeetingSpeakerConfig: null,
    whisperVadSettings: {},
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
  });
  instance.setupHandlers();

  return {
    handles,
    listeners,
    sent,
    sender,
    detectionStates,
    managerStops,
    derivedCalls,
    managedOptions: () => managedOptions,
    cleanup: async () => {
      await handles.get("meeting-transcription-stop")?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("unsupported non-mic-only start rolls back Jarvis identity before later audio or starts", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (...args) => {
      persisted.push(args);
      return true;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const failed = await start(
    { sender: fixture.sender },
    { provider: "unsupported", jarvisSessionId: "jarvis-dual" }
  );
  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic");
  const next = await start({ sender: fixture.sender }, { provider: "local" });
  send({ sender: fixture.sender }, Buffer.from([3, 4]), "mic");

  assert.equal(failed.success, false);
  assert.equal(next.success, true);
  assert.deepEqual(fixture.detectionStates.slice(0, 3), [true, false, true]);
  assert.deepEqual(persisted, []);
});

test("managed system producer receives false and stops after Jarvis backpressure", async (t) => {
  let appendCalls = 0;
  const fixture = createFixture({
    appendPcm: () => {
      appendCalls += 1;
      return false;
    },
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-system" }
  );
  const accepted = fixture.managedOptions().onChunk(Buffer.from([1, 2]));
  const raced = fixture.managedOptions().onChunk(Buffer.from([3, 4]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.equal(accepted, false);
  assert.equal(raced, false);
  assert.equal(appendCalls, 1);
  assert.deepEqual(fixture.managerStops, ["stop"]);
});

test("renderer ingress receives a metadata-only rejection when Jarvis stops accepting PCM", async (t) => {
  const fixture = createFixture({ appendPcm: () => false });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-renderer" }
  );
  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic");

  assert.deepEqual(fixture.sent, [
    [
      "meeting-transcription-input-rejected",
      { source: "mic", reason: "jarvis-evidence-backpressure" },
    ],
  ]);
});

test("IPCHandlers persists each exact source buffer once before AEC consumers", async (t) => {
  const calls = [];
  const fixture = createFixture({
    aecAvailable: true,
    appendPcm: (sessionId, source, buffer) => {
      calls.push(["persist", sessionId, source, buffer]);
      return true;
    },
    onDerived: (source, buffer) => calls.push(["derived", source, buffer]),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");
  const mic = Buffer.from([1, 2]);
  const system = Buffer.from([3, 4]);

  await start({ sender: fixture.sender }, { provider: "local", jarvisSessionId: "jarvis-dual" });
  send({ sender: fixture.sender }, system, "system");
  send({ sender: fixture.sender }, mic, "mic");

  assert.deepEqual(
    calls.map((call) => call.slice(0, call[0] === "persist" ? 3 : 2)),
    [
      ["persist", "jarvis-dual", "system"],
      ["derived", "system"],
      ["persist", "jarvis-dual", "mic"],
      ["derived", "mic"],
    ]
  );
  assert.equal(calls[0][3], system);
  assert.equal(calls[2][3], mic);
  assert.notEqual(calls[1][2], system);
  assert.notEqual(calls[3][2], mic);
});
