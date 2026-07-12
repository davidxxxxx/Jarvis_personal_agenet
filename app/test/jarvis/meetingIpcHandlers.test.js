const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, description = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function createFixture({
  appendPcm = () => true,
  onDerived = () => {},
  managedStartChunk = null,
  managedStartDeferred = null,
  managedStopDeferred = null,
  systemAvailable = false,
  aecAvailable = false,
} = {}) {
  const handles = new Map();
  const listeners = new Map();
  const sent = [];
  const detectionStates = [];
  const managerStops = [];
  const managedStartAcceptances = [];
  const derivedCalls = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-meeting-ipc-"));
  const createSender = (id) => {
    const webContents = new EventEmitter();
    let destroyed = false;
    Object.assign(webContents, {
      id,
      isDestroyed: () => destroyed,
      send: (...args) => sent.push(args),
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        webContents.emit("destroyed");
      },
    });
    return webContents;
  };
  const sender = createSender(101);
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

  const managedStarts = [];
  const windowsLoopbackAudioManager = {
    getCapability: async () => ({ available: systemAvailable }),
    start: async (options) => {
      managedStarts.push(options);
      if (managedStartChunk) {
        managedStartAcceptances.push(options.onChunk(managedStartChunk));
      }
      if (managedStartDeferred) await managedStartDeferred.promise;
    },
    stop: async () => {
      managerStops.push("stop");
      if (managedStopDeferred) await managedStopDeferred.promise;
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
    createSender,
    detectionStates,
    managerStops,
    derivedCalls,
    managedOptions: () => managedStarts.at(-1),
    managedStarts,
    managedStartAcceptances,
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
  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic", "failed-generation");
  const next = await start({ sender: fixture.sender }, { provider: "local" });
  send({ sender: fixture.sender }, Buffer.from([3, 4]), "mic", next.inputGeneration);

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
  assert.match(result.inputGeneration, /^[0-9a-f-]{36}$/);
  assert.equal(accepted, false);
  assert.equal(raced, false);
  assert.equal(appendCalls, 1);
  assert.deepEqual(fixture.managerStops, ["stop"]);
});

test("managed system audio emitted during start is committed only after the start succeeds", async (t) => {
  const calls = [];
  const startupChunk = Buffer.from([1, 2, 3, 4]);
  const fixture = createFixture({
    aecAvailable: true,
    managedStartChunk: startupChunk,
    systemAvailable: true,
    appendPcm: (sessionId, source, buffer) => {
      calls.push(["persist", sessionId, source, buffer]);
      return true;
    },
    onDerived: (source, buffer) => calls.push(["derived", source, buffer]),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-starting" }
  );

  assert.equal(result.success, true);
  assert.deepEqual(fixture.managedStartAcceptances, [true]);
  assert.deepEqual(
    calls.map((call) => call.slice(0, call[0] === "persist" ? 3 : 2)),
    [
      ["persist", "jarvis-starting", "system"],
      ["derived", "system"],
    ]
  );
  assert.equal(calls[0][3], startupChunk);
  assert.notEqual(calls[1][2], startupChunk);
  assert.deepEqual(fixture.managerStops, []);
});

test("renderer ingress receives a metadata-only rejection when Jarvis stops accepting PCM", async (t) => {
  const fixture = createFixture({ appendPcm: () => false });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-renderer" }
  );
  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic", result.inputGeneration);

  assert.deepEqual(fixture.sent, [
    [
      "meeting-transcription-input-rejected",
      {
        source: "mic",
        reason: "jarvis-evidence-backpressure",
        inputGeneration: result.inputGeneration,
      },
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

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-dual" }
  );
  assert.match(result.inputGeneration, /^[0-9a-f-]{36}$/);
  send({ sender: fixture.sender }, system, "system", result.inputGeneration);
  send({ sender: fixture.sender }, mic, "mic", result.inputGeneration);

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

test("renderer ingress ignores foreign, missing, and stale generations without rejection", async (t) => {
  let appendCalls = 0;
  const foreignSent = [];
  const fixture = createFixture({
    appendPcm: () => {
      appendCalls += 1;
      return false;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");
  const foreignSender = {
    id: 202,
    isDestroyed: () => false,
    send: (...args) => foreignSent.push(args),
  };
  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-owned" }
  );

  send({ sender: fixture.sender }, Buffer.from([1]), "mic");
  send({ sender: fixture.sender }, Buffer.from([2]), "mic", "stale-generation");
  send({ sender: foreignSender }, Buffer.from([3]), "mic", result.inputGeneration);

  assert.equal(appendCalls, 0);
  assert.deepEqual(fixture.sent, []);
  assert.deepEqual(foreignSent, []);

  send({ sender: fixture.sender }, Buffer.from([4]), "mic", result.inputGeneration);
  assert.equal(appendCalls, 1);
  assert.deepEqual(fixture.sent, [
    [
      "meeting-transcription-input-rejected",
      {
        source: "mic",
        reason: "jarvis-evidence-backpressure",
        inputGeneration: result.inputGeneration,
      },
    ],
  ]);
});

test("stop, rollback, and cancel invalidate ingress and the next start gets a distinct generation", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (...args) => {
      persisted.push(args);
      return true;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const cancel = fixture.handles.get("meeting-transcription-cancel");
  const send = fixture.listeners.get("meeting-transcription-send");

  const first = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-first" }
  );
  await stop({ sender: fixture.sender });
  send({ sender: fixture.sender }, Buffer.from([1]), "mic", first.inputGeneration);

  const failed = await start(
    { sender: fixture.sender },
    { provider: "unsupported", jarvisSessionId: "jarvis-failed" }
  );
  send({ sender: fixture.sender }, Buffer.from([2]), "mic", first.inputGeneration);
  const cancelled = await cancel({ sender: fixture.sender });

  const second = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-second" }
  );
  send({ sender: fixture.sender }, Buffer.from([3]), "mic", first.inputGeneration);
  send({ sender: fixture.sender }, Buffer.from([4]), "mic", second.inputGeneration);

  assert.equal(failed.success, false);
  assert.equal(cancelled.success, true);
  assert.notEqual(second.inputGeneration, first.inputGeneration);
  assert.deepEqual(persisted.map(([sessionId]) => sessionId), ["jarvis-second"]);
});

test("a stale managed system callback cannot touch a newer mic-only generation", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (sessionId, source, buffer) => {
      persisted.push([sessionId, source, buffer]);
      return true;
    },
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-old" }
  );
  const oldManagedProducer = fixture.managedStarts[0];
  await stop({ sender: fixture.sender });
  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-current" }
  );

  const accepted = oldManagedProducer.onChunk(Buffer.from([1, 2]));
  send({ sender: fixture.sender }, Buffer.from([3, 4]), "mic", current.inputGeneration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(accepted, false);
  assert.deepEqual(
    persisted.map(([sessionId, source]) => [sessionId, source]),
    [["jarvis-current", "mic"]]
  );
  assert.equal(fixture.managerStops.length, 2);
  assert.deepEqual(
    fixture.sent.filter(([channel]) => channel === "meeting-transcription-input-rejected"),
    []
  );
});

test("a stale managed system callback is gated before a newer dual-track session", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (sessionId, source) => {
      persisted.push([sessionId, source]);
      return true;
    },
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-old-dual" }
  );
  const oldManagedProducer = fixture.managedStarts[0];
  await stop({ sender: fixture.sender });
  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-current-dual" }
  );
  const currentManagedProducer = fixture.managedStarts[1];

  const staleAccepted = oldManagedProducer.onChunk(Buffer.from([1, 2]));
  const currentAccepted = currentManagedProducer.onChunk(Buffer.from([3, 4]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(staleAccepted, false);
  assert.equal(currentAccepted, true);
  assert.deepEqual(persisted, [["jarvis-current-dual", "system"]]);
  assert.equal(fixture.managerStops.length, 2);
});

test("cancel keeps the start gate until the cancelled attempt finishes rolling back", async (t) => {
  const startDeferred = createDeferred();
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (sessionId, source) => {
      persisted.push([sessionId, source]);
      return true;
    },
    managedStartDeferred: startDeferred,
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const cancel = fixture.handles.get("meeting-transcription-cancel");
  const send = fixture.listeners.get("meeting-transcription-send");

  const firstPromise = start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-cancelled-a" }
  );
  await waitFor(() => fixture.managedStarts.length === 1);

  const cancelled = await cancel({ sender: fixture.sender });
  const blocked = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-blocked-b" }
  );

  startDeferred.resolve();
  const first = await firstPromise;
  if (first.success) await stop({ sender: fixture.sender });
  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-current-c" }
  );
  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic", current.inputGeneration);
  const staleAccepted = fixture.managedStarts[0].onChunk(Buffer.from([3, 4]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelled.success, true);
  assert.deepEqual(blocked, { success: false, error: "Operation in progress" });
  assert.equal(first.success, false);
  assert.equal(current.success, true);
  assert.equal(staleAccepted, false);
  assert.deepEqual(persisted, [["jarvis-current-c", "mic"]]);
});

test("rollback invalidates native ingress before awaiting manager teardown", async (t) => {
  const stopDeferred = createDeferred();
  let appendCalls = 0;
  const fixture = createFixture({
    appendPcm: () => {
      appendCalls += 1;
      throw new Error("startup evidence failed");
    },
    managedStartChunk: Buffer.from([1, 2]),
    managedStopDeferred: stopDeferred,
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const startPromise = start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-flush-failure" }
  );
  await waitFor(() => fixture.managerStops.length >= 1);

  let acceptedDuringTeardown;
  let callbackError = null;
  try {
    acceptedDuringTeardown = fixture.managedStarts[0].onChunk(Buffer.from([3, 4]));
  } catch (error) {
    callbackError = error;
  }

  stopDeferred.resolve();
  const result = await startPromise;
  assert.equal(callbackError, null);
  assert.equal(acceptedDuringTeardown, false);
  assert.equal(appendCalls, 1);
  assert.equal(result.success, false);
  assert.match(result.error, /startup evidence failed/);
});

test("owner destruction invalidates active ingress, cleans up, and cannot affect the next owner", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (sessionId, source) => {
      persisted.push([sessionId, source]);
      return true;
    },
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  const first = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-destroyed-owner" }
  );
  const staleManagedInput = fixture.managedStarts[0];
  assert.equal(fixture.sender.listenerCount("destroyed"), 1);

  fixture.sender.destroy();
  send({ sender: fixture.sender }, Buffer.from([1]), "mic", first.inputGeneration);
  const staleAccepted = staleManagedInput.onChunk(Buffer.from([2]));
  await waitFor(() => fixture.managerStops.length >= 1);
  await new Promise((resolve) => setImmediate(resolve));

  const nextSender = fixture.createSender(202);
  const second = await start(
    { sender: nextSender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-next-owner" }
  );
  const stopsBeforeOldEvent = fixture.managerStops.length;
  fixture.sender.emit("destroyed");
  send({ sender: nextSender }, Buffer.from([3]), "mic", second.inputGeneration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(staleAccepted, false);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(fixture.sender.listenerCount("destroyed"), 0);
  assert.equal(nextSender.listenerCount("destroyed"), 1);
  assert.equal(fixture.managerStops.length, stopsBeforeOldEvent);
  assert.deepEqual(persisted, [["jarvis-next-owner", "mic"]]);

  await stop({ sender: nextSender });
  assert.equal(nextSender.listenerCount("destroyed"), 0);
});

test("an owner destroyed during startup cannot complete or leak a destruction listener", async (t) => {
  const startDeferred = createDeferred();
  const fixture = createFixture({ managedStartDeferred: startDeferred, systemAvailable: true });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const startPromise = start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-owner-race" }
  );
  await waitFor(() => fixture.managedStarts.length === 1);
  fixture.sender.destroy();
  startDeferred.resolve();

  const result = await startPromise;
  assert.equal(result.success, false);
  assert.match(result.error, /owner.*destroyed/i);
  assert.equal(fixture.sender.listenerCount("destroyed"), 0);
});

test("explicit stop blocks replacement starts until shared managers finish", async (t) => {
  const stopDeferred = createDeferred();
  const fixture = createFixture({ managedStopDeferred: stopDeferred, systemAvailable: true });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-stopping-a" }
  );
  const firstStopPromise = stop({ sender: fixture.sender });
  await waitFor(() => fixture.managerStops.length >= 1, "the first manager stop");
  const blockedPromise = start(
    { sender: fixture.sender },
    { provider: "unsupported", micOnly: true, jarvisSessionId: "jarvis-blocked-b" }
  );

  await new Promise((resolve) => setImmediate(resolve));
  stopDeferred.resolve();
  const [firstStop, blocked] = await Promise.all([firstStopPromise, blockedPromise]);

  assert.deepEqual(blocked, { success: false, error: "Operation in progress" });
  assert.equal(firstStop.success, true);

  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-current-c" }
  );

  assert.equal(current.success, true);
});

test("concurrent explicit stops share one manager teardown", async (t) => {
  const stopDeferred = createDeferred();
  const fixture = createFixture({ managedStopDeferred: stopDeferred, systemAvailable: true });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-deduplicated-stop" }
  );
  const firstStopPromise = stop({ sender: fixture.sender });
  await waitFor(() => fixture.managerStops.length >= 1, "the first manager stop");
  const duplicateStopPromise = stop({ sender: fixture.sender });
  await new Promise((resolve) => setImmediate(resolve));
  const managerStopsBeforeRelease = fixture.managerStops.length;

  stopDeferred.resolve();
  const [firstStop, duplicateStop] = await Promise.all([firstStopPromise, duplicateStopPromise]);

  assert.equal(managerStopsBeforeRelease, 1);
  assert.deepEqual(duplicateStop, firstStop);
});

test("explicit stop and rollback of the same in-flight start share one teardown", async (t) => {
  const startDeferred = createDeferred();
  const stopDeferred = createDeferred();
  const fixture = createFixture({
    managedStartDeferred: startDeferred,
    managedStopDeferred: stopDeferred,
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  const startPromise = start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-start-stop-race" }
  );
  await waitFor(() => fixture.managedStarts.length === 1, "the in-flight manager start");
  const stopPromise = stop({ sender: fixture.sender });
  await waitFor(() => fixture.managerStops.length >= 1, "the explicit manager stop");

  startDeferred.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const managerStopsBeforeRelease = fixture.managerStops.length;
  stopDeferred.resolve();
  const [startResult, stopResult] = await Promise.all([startPromise, stopPromise]);
  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-after-start-stop-race" }
  );

  assert.equal(startResult.success, false);
  assert.equal(stopResult.success, true);
  assert.equal(managerStopsBeforeRelease, 1);
  assert.equal(current.success, true);
});
