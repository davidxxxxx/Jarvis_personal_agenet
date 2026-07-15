const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBoundedRecoveryBuffer } = require("../../src/helpers/meetingRecoveryLoop");
const { processWriteGate } = require("../../src/jarvis/main/UnifiedRootWriteGate");

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

async function waitForTimed(predicate, description = "timed condition", timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function createPcm16(sampleCount, sampleAt) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    pcm.writeInt16LE(sampleAt(sample), sample * 2);
  }
  return pcm;
}

function createFixture({
  appendPcm = () => true,
  sourceInterrupted = () => {},
  sourceRestored = () => {},
  onDerived = () => {},
  managedStartChunk = null,
  managedStartError = null,
  managedStartSequence = [],
  managedStartDeferred = null,
  managedStopDeferred = null,
  aecStartDeferred = null,
  transcribeLocalWhisper = async () => ({ success: true, text: "" }),
  maybeCorrect = null,
  warmStreaming = false,
  realtimeConnectDeferred = null,
  systemAvailable = false,
  aecAvailable = false,
  diarizationManager = null,
  speakerDiarizationEnabled = false,
} = {}) {
  const handles = new Map();
  const listeners = new Map();
  const sent = [];
  const detectionStates = [];
  const managerStops = [];
  const managedStartAcceptances = [];
  const recoveryLoopStarts = [];
  const derivedCalls = [];
  const lifecycle = [];
  const whisperCalls = [];
  const correctionCalls = [];
  const transcriptRevisions = [];
  const realtimeInstances = [];
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
  class ControllableRealtimeStreaming {
    constructor() {
      this.isConnected = false;
      this.completedSegments = [];
      this.disconnectCalls = 0;
      realtimeInstances.push(this);
    }

    async connect() {
      lifecycle.push("realtime-connect-start");
      await realtimeConnectDeferred.promise;
      this.isConnected = true;
      lifecycle.push("realtime-connect-complete");
    }

    async disconnect() {
      this.disconnectCalls += 1;
      this.isConnected = false;
      lifecycle.push("realtime-disconnect");
      return { text: "" };
    }
  }

  const ipcHandlersPath = path.resolve(__dirname, "../../src/helpers/ipcHandlers.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "./meetingRecoveryLoop") {
      const recoveryModule = originalLoad.call(this, request, parent, isMain);
      return {
        ...recoveryModule,
        createMeetingRecoveryLoop: (options) => {
          const loop = recoveryModule.createMeetingRecoveryLoop(options);
          return {
            ...loop,
            start: () => {
              const promise = loop.start();
              if (!recoveryLoopStarts.includes(promise)) recoveryLoopStarts.push(promise);
              return promise;
            },
          };
        },
      };
    }
    if (request === "./openaiRealtimeStreaming" && realtimeConnectDeferred) {
      return ControllableRealtimeStreaming;
    }
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
      lifecycle.push("manager-start");
      managedStarts.push(options);
      const behavior = managedStartSequence[managedStarts.length - 1] ?? {};
      const startChunks = behavior.chunks ?? [behavior.chunk ?? managedStartChunk].filter(Boolean);
      const startError = behavior.error ?? managedStartError;
      const startDeferred = behavior.deferred ?? managedStartDeferred;
      for (const startChunk of startChunks) {
        managedStartAcceptances.push(options.onChunk(startChunk));
      }
      if (startError) {
        options.onError(startError);
      }
      if (startDeferred) await startDeferred.promise;
    },
    stop: async () => {
      lifecycle.push("manager-stop");
      managerStops.push("stop");
      if (managedStopDeferred) await managedStopDeferred.promise;
    },
  };
  const meetingAecManager = {
    isAvailable: () => aecAvailable,
    start: async () => {
      lifecycle.push("aec-start");
      if (aecStartDeferred) await aecStartDeferred.promise;
      return aecAvailable;
    },
    stop: async () => {
      lifecycle.push("aec-stop");
    },
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
  const createWarmStreaming = (source) => ({
    isConnected: true,
    disconnect: async () => {
      lifecycle.push(`${source}-stream-disconnect`);
      return { text: "" };
    },
  });
  const instance = Object.assign(Object.create(IPCHandlers.prototype), {
    environmentManager: realtimeConnectDeferred
      ? { getOpenAIKey: () => "test-placeholder-key" }
      : {},
    databaseManager: {},
    whisperManager: {
      transcribeLocalWhisper: async (...args) => {
        whisperCalls.push(args);
        return transcribeLocalWhisper(...args);
      },
    },
    parakeetManager: {},
    diarizationManager,
    windowManager: { controlPanelWindow: win },
    meetingDetectionEngine: {
      setUserRecording: (value) => detectionStates.push(value),
    },
    audioTapManager: null,
    linuxPortalAudioManager: null,
    windowsLoopbackAudioManager,
    meetingAecManager,
    jarvisService: { appendPcm, sourceInterrupted, sourceRestored },
    jarvisRepository: {
      addTranscriptRevision: (revision) => transcriptRevisions.push(revision),
    },
    openAiCorrectionService: maybeCorrect
      ? {
          maybeCorrect: async (request) => {
            correctionCalls.push(request);
            return maybeCorrect(request);
          },
        }
      : null,
    speakerDiarizationEnabled,
    activeMeetingSpeakerConfig: null,
    whisperVadSettings: {},
    _meetingMicStreaming: warmStreaming ? createWarmStreaming("mic") : null,
    _meetingSystemStreaming: warmStreaming ? createWarmStreaming("system") : null,
  });
  instance.setupHandlers();

  return {
    instance,
    handles,
    listeners,
    sent,
    sender,
    createSender,
    detectionStates,
    managerStops,
    lifecycle,
    whisperCalls,
    correctionCalls,
    transcriptRevisions,
    realtimeInstances,
    derivedCalls,
    managedOptions: () => managedStarts.at(-1),
    managedStarts,
    managedStartAcceptances,
    recoveryLoopStarts,
    cleanup: async () => {
      await handles.get("meeting-transcription-stop")?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("midnight rebind keeps one live PCM producer writing into the next session", async (t) => {
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (sessionId, source, buffer) => {
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");
  const started = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "session-day-1" }
  );

  send({ sender: fixture.sender }, Buffer.from([1, 2]), "mic", started.inputGeneration);
  const rebound = fixture.instance.rebindJarvisSession("session-day-1", "session-day-2");
  const duplicate = fixture.instance.rebindJarvisSession("session-day-1", "session-day-2");
  send({ sender: fixture.sender }, Buffer.from([3, 4]), "mic", started.inputGeneration);

  assert.deepEqual(
    persisted.map(([sessionId, source, buffer]) => [sessionId, source, [...buffer]]),
    [
      ["session-day-1", "mic", [1, 2]],
      ["session-day-2", "mic", [3, 4]],
    ]
  );
  assert.deepEqual(rebound, { rebound: true, sessionId: "session-day-2" });
  assert.deepEqual(duplicate, { rebound: false, sessionId: "session-day-2" });
});

test("bounded managed recovery buffer clears bytes and remains reusable after overflow", () => {
  const buffer = createBoundedRecoveryBuffer(4);
  const first = Buffer.from([1, 2]);

  assert.equal(buffer.push(first), true);
  first[0] = 99;
  assert.equal(buffer.push(Buffer.from([3, 4])), true);
  assert.equal(buffer.push(Buffer.from([5])), false);
  assert.equal(buffer.byteLength, 4);
  assert.equal(buffer.length, 2);

  assert.deepEqual(buffer.drain(), [Buffer.from([1, 2]), Buffer.from([3, 4])]);
  assert.equal(buffer.byteLength, 0);
  assert.equal(buffer.length, 0);
  assert.equal(buffer.push(Buffer.from([6, 7, 8, 9])), true);
  buffer.clear();
  assert.equal(buffer.byteLength, 0);
  assert.equal(buffer.length, 0);
});

test("bounded recovery buffer copies ArrayBuffer and typed-array bytes", () => {
  const buffer = createBoundedRecoveryBuffer(8);
  const arrayBuffer = new Uint8Array([1, 2]).buffer;
  const typedArray = new Uint8Array([3, 4]);

  assert.equal(buffer.push(arrayBuffer), true);
  assert.equal(buffer.push(typedArray), true);
  new Uint8Array(arrayBuffer)[0] = 91;
  typedArray[0] = 92;

  assert.deepEqual(buffer.drain(), [Buffer.from([1, 2]), Buffer.from([3, 4])]);
});

test("bounded recovery buffer rejects invalid or oversized input before copying", () => {
  const buffer = createBoundedRecoveryBuffer(4);
  const oversized = Buffer.alloc(5);
  const originalFrom = Buffer.from;
  let copyCalls = 0;
  Buffer.from = function countedBufferFrom(...args) {
    copyCalls += 1;
    return originalFrom.apply(Buffer, args);
  };
  try {
    assert.equal(buffer.push(oversized), false);
  } finally {
    Buffer.from = originalFrom;
  }

  assert.equal(copyCalls, 0);
  assert.doesNotThrow(() => assert.equal(buffer.push({ byteLength: 1 }), false));
  assert.equal(buffer.byteLength, 0);
  assert.equal(buffer.length, 0);
});

test("meeting diarization holds capture-time write authority through raw PCM cleanup", async (t) => {
  const conversion = createDeferred();
  let rawPcmPath = null;
  const fixture = createFixture({
    diarizationManager: {
      isAvailable: () => true,
      async convertRawPcmToWav(candidate) {
        rawPcmPath = candidate;
        await conversion.promise;
        throw new Error("fixture conversion stop");
      },
    },
    speakerDiarizationEnabled: true,
  });
  t.after(async () => {
    conversion.resolve();
    processWriteGate.open();
    await fixture.cleanup();
  });
  processWriteGate.open();
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "diarization-test" }
  );
  send({ sender: fixture.sender }, Buffer.from([1, 2, 3, 4]), "mic", started.inputGeneration);
  processWriteGate.close();
  let drained = false;
  const idle = processWriteGate.waitForIdle().then(() => {
    drained = true;
  });
  await stop({ sender: fixture.sender });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(drained, false);
  assert.ok(rawPcmPath);
  assert.equal(fs.existsSync(rawPcmPath), true);

  conversion.resolve();
  await idle;
  assert.equal(fs.existsSync(rawPcmPath), false);
  processWriteGate.open();
});

test("explicit stop supersedes a pending realtime prepare before its late connection can stay warm", async (t) => {
  const realtimeConnectDeferred = createDeferred();
  const fixture = createFixture({ realtimeConnectDeferred });
  t.after(fixture.cleanup);
  const prepare = fixture.handles.get("meeting-transcription-prepare");
  const stop = fixture.handles.get("meeting-transcription-stop");

  const preparePromise = prepare(
    { sender: fixture.sender },
    { provider: "openai-realtime", mode: "byok", micOnly: true }
  );
  await waitFor(
    () => fixture.lifecycle.includes("realtime-connect-start"),
    "the pending realtime prepare connection"
  );

  let stopSettled = false;
  const stopPromise = stop({ sender: fixture.sender }).then((result) => {
    stopSettled = true;
    return result;
  });
  await waitFor(() => stopSettled, "explicit stop while prepare is pending");
  const stopped = await stopPromise;

  realtimeConnectDeferred.resolve();
  const prepared = await preparePromise;

  assert.equal(stopped.success, true);
  assert.deepEqual(prepared, { success: false, error: "Prepare superseded" });
  assert.equal(fixture.realtimeInstances.length, 1);
  assert.equal(fixture.realtimeInstances[0].isConnected, false);
  assert.equal(fixture.realtimeInstances[0].disconnectCalls, 1);
});

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

test("active managed system backpressure enters same-session recovery while mic remains live", async (t) => {
  const interruptions = [];
  const restorations = [];
  const persisted = [];
  let rejectFirstSystem = true;
  const recoveryChunk = Buffer.from([7, 8]);
  const micChunk = Buffer.from([9, 10]);
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, { chunks: [recoveryChunk] }],
    appendPcm: (sessionId, source, buffer) => {
      if (source === "system" && rejectFirstSystem) {
        rejectFirstSystem = false;
        return false;
      }
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
    },
    sourceRestored: async (...args) => {
      restorations.push(args);
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-active-backpressure" }
  );
  const accepted = fixture.managedStarts[0].onChunk(Buffer.from([1, 2]));
  send({ sender: fixture.sender }, micChunk, "mic", started.inputGeneration);

  assert.equal(accepted, false);
  assert.deepEqual(persisted, [["jarvis-active-backpressure", "mic", micChunk]]);
  await waitForTimed(() => fixture.managedStarts.length === 2, "the backpressure restart");
  await waitForTimed(
    () => persisted.some(([, source]) => source === "system"),
    "the recovered system append"
  );

  assert.equal(interruptions.length, 1);
  assert.equal(restorations.length, 1);
  assert.deepEqual(
    persisted.map(([sessionId, source, buffer]) => [sessionId, source, buffer]),
    [
      ["jarvis-active-backpressure", "mic", micChunk],
      ["jarvis-active-backpressure", "system", recoveryChunk],
    ]
  );
  assert.ok(fixture.managerStops.length >= 1);
});

test("active managed system append exceptions are contained and recover while mic remains live", async (t) => {
  const interruptions = [];
  const restorations = [];
  const persisted = [];
  let throwFirstSystem = true;
  const recoveryChunk = Buffer.from([17, 18]);
  const micChunk = Buffer.from([19, 20]);
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, { chunks: [recoveryChunk] }],
    appendPcm: (sessionId, source, buffer) => {
      if (source === "system" && throwFirstSystem) {
        throwFirstSystem = false;
        throw new Error("active system evidence failure");
      }
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
    },
    sourceRestored: async (...args) => {
      restorations.push(args);
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-active-throw" }
  );
  let accepted;
  assert.doesNotThrow(() => {
    accepted = fixture.managedStarts[0].onChunk(Buffer.from([3, 4]));
  });
  send({ sender: fixture.sender }, micChunk, "mic", started.inputGeneration);

  assert.equal(accepted, false);
  assert.deepEqual(persisted, [["jarvis-active-throw", "mic", micChunk]]);
  await waitForTimed(() => fixture.managedStarts.length === 2, "the exception restart");
  await waitForTimed(
    () => persisted.some(([, source]) => source === "system"),
    "the system append after exception"
  );

  assert.equal(interruptions.length, 1);
  assert.equal(restorations.length, 1);
  assert.deepEqual(persisted, [
    ["jarvis-active-throw", "mic", micChunk],
    ["jarvis-active-throw", "system", recoveryChunk],
  ]);
  assert.ok(fixture.managerStops.length >= 1);
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

test("managed system failure during start falls back before reporting the source available", async (t) => {
  const interruptions = [];
  const fixture = createFixture({
    managedStartError: new Error("system producer failed during startup"),
    sourceInterrupted: (...args) => interruptions.push(args),
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-startup-system-failure" }
  );

  assert.equal(result.success, true);
  assert.equal(result.systemAudioStrategy, "loopback");
  assert.deepEqual(fixture.managerStops, ["stop"]);
  assert.deepEqual(interruptions, []);
  assert.equal(
    fixture.sent.filter(([channel]) => channel === "meeting-transcription-source-state").length,
    0
  );
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
  assert.deepEqual(
    persisted.map(([sessionId]) => sessionId),
    ["jarvis-second"]
  );
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

  await start({ sender: fixture.sender }, { provider: "local", jarvisSessionId: "jarvis-old" });
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
  assert.equal(fixture.managerStops.length, 1);
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
  assert.equal(fixture.managerStops.length, 1);
});

test("managed system errors publish only for their current input generation", async (t) => {
  const interruptions = [];
  const fixture = createFixture({
    systemAvailable: true,
    sourceInterrupted: (...args) => interruptions.push(args),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-source-state-old" }
  );
  const oldProducer = fixture.managedStarts[0];
  await stop({ sender: fixture.sender });

  const second = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-source-state-current" }
  );
  const currentProducer = fixture.managedStarts[1];
  const stopsBeforeStaleError = fixture.managerStops.length;
  oldProducer.onError(new Error("stale producer"));
  const stopsAfterStaleError = fixture.managerStops.length;
  currentProducer.onError(new Error("current producer"));
  currentProducer.onError(new Error("duplicate current producer error"));

  assert.deepEqual(
    fixture.sent.filter(([channel]) => channel === "meeting-transcription-source-state"),
    [
      [
        "meeting-transcription-source-state",
        {
          source: "system",
          state: "unavailable",
          reason: "system-capture-error",
          inputGeneration: second.inputGeneration,
        },
      ],
    ]
  );
  assert.equal(stopsBeforeStaleError, 1);
  assert.equal(stopsAfterStaleError, stopsBeforeStaleError);
  assert.equal(fixture.managerStops.length, 2);
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0][0], "jarvis-source-state-current");
  assert.equal(interruptions[0][1], "system");
  assert.deepEqual(interruptions[0][2], {
    at: interruptions[0][2].at,
    reason: "system-capture-error",
  });
  assert.equal(Number.isSafeInteger(interruptions[0][2].at), true);
  assert.equal(
    fixture.sent.some(([, payload]) => JSON.stringify(payload).includes("private device details")),
    false
  );
});

test("managed system interruption persistence retries after producer failure is consumed", async (t) => {
  const interruptions = [];
  const fixture = createFixture({
    systemAvailable: true,
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
      if (interruptions.length === 1) {
        throw new Error("temporary persistence failure");
      }
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-interruption-retry" }
  );
  fixture.managedStarts[0].onError(new Error("system producer failed"));

  assert.equal(interruptions.length, 1);
  assert.equal(fixture.managerStops.length, 1);
  assert.equal(
    fixture.sent.filter(([channel]) => channel === "meeting-transcription-source-state").length,
    1
  );

  await waitForTimed(
    () => interruptions.length === 2,
    "the current system interruption persistence retry"
  );

  assert.equal(interruptions[0][0], "jarvis-interruption-retry");
  assert.equal(interruptions[0][1], "system");
  assert.deepEqual(interruptions[1], interruptions[0]);
  assert.equal(
    fixture.sent.filter(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.inputGeneration === started.inputGeneration
    ).length,
    1
  );
});

test("stopping and replacing the input binding cancels its system interruption retry", async (t) => {
  const interruptions = [];
  const fixture = createFixture({
    systemAvailable: true,
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
      if (args[0] === "jarvis-interruption-old") {
        throw new Error("old persistence unavailable");
      }
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-interruption-old" }
  );
  fixture.managedStarts[0].onError(new Error("old producer failed"));
  await waitForTimed(() => interruptions.length === 1, "the first old-binding attempt");
  await new Promise((resolve) => setImmediate(resolve));

  await stop({ sender: fixture.sender });
  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-interruption-new" }
  );
  fixture.managedStarts[1].onError(new Error("new producer failed"));
  await waitForTimed(
    () => interruptions.some(([sessionId]) => sessionId === "jarvis-interruption-new"),
    "the new-binding persistence"
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(
    interruptions.map(([sessionId]) => sessionId),
    ["jarvis-interruption-old", "jarvis-interruption-new"]
  );
  assert.equal(
    fixture.sent.filter(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" && payload.state === "unavailable"
    ).length,
    2
  );
});

test("successful retried system interruption persistence is not duplicated", async (t) => {
  let attempts = 0;
  const fixture = createFixture({
    systemAvailable: true,
    sourceInterrupted: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("response was lost after persistence");
      }
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-interruption-idempotent" }
  );
  fixture.managedStarts[0].onError(new Error("producer ended"));

  await waitForTimed(() => attempts === 2, "the successful persistence retry");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(attempts, 2);
  assert.equal(fixture.managerStops.length, 1);
  assert.equal(
    fixture.sent.filter(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" && payload.state === "unavailable"
    ).length,
    1
  );
});

test("managed system recovery restores before flushing its synchronous first chunk while mic stays live", async (t) => {
  const restoration = createDeferred();
  const calls = [];
  const recoveryChunk = Buffer.from([7, 8]);
  const micChunk = Buffer.from([3, 4]);
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, { chunk: recoveryChunk }],
    appendPcm: (sessionId, source, buffer) => {
      calls.push(["append", sessionId, source, buffer]);
      return true;
    },
    sourceInterrupted: async (...args) => {
      calls.push(["interrupted", ...args]);
    },
    sourceRestored: async (...args) => {
      calls.push(["restored", ...args]);
      await restoration.promise;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-managed-recovery" }
  );
  fixture.managedStarts[0].onError(new Error("current producer failed"));

  await waitForTimed(() => fixture.managedStarts.length === 2, "the managed system restart");
  await waitForTimed(
    () => calls.some(([kind]) => kind === "restored"),
    "the managed system restoration"
  );
  send({ sender: fixture.sender }, micChunk, "mic", started.inputGeneration);

  assert.deepEqual(
    calls.filter(([kind]) => kind === "interrupted").map((call) => call.slice(1, 3)),
    [["jarvis-managed-recovery", "system"]]
  );
  assert.deepEqual(
    calls.filter(([kind, , source]) => kind === "append" && source === "system"),
    []
  );
  assert.equal(
    calls.some(
      ([kind, sessionId, source, buffer]) =>
        kind === "append" &&
        sessionId === "jarvis-managed-recovery" &&
        source === "mic" &&
        buffer === micChunk
    ),
    true
  );

  restoration.resolve();
  await waitForTimed(
    () => calls.some(([kind, , source]) => kind === "append" && source === "system"),
    "the buffered system chunk flush"
  );

  const restoredIndex = calls.findIndex(([kind]) => kind === "restored");
  const systemAppendIndex = calls.findIndex(
    ([kind, , source]) => kind === "append" && source === "system"
  );
  assert.ok(restoredIndex >= 0 && restoredIndex < systemAppendIndex);
  assert.deepEqual(calls[systemAppendIndex][3], recoveryChunk);
  assert.deepEqual(calls[restoredIndex].slice(1), [
    "jarvis-managed-recovery",
    "system",
    {
      at: calls[restoredIndex][3].at,
      deviceId: null,
      deviceLabel: null,
      strategy: "wasapi-loopback",
    },
  ]);
});

test("stop and a new input binding cancel a scheduled managed system restart", async (t) => {
  const interruption = createDeferred();
  let restorationCalls = 0;
  const fixture = createFixture({
    systemAvailable: true,
    sourceInterrupted: async () => {
      await interruption.promise;
    },
    sourceRestored: async () => {
      restorationCalls += 1;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-scheduled-recovery-old" }
  );
  fixture.managedStarts[0].onError(new Error("schedule a recovery"));
  interruption.resolve();
  await Promise.resolve();
  await Promise.resolve();

  await stop({ sender: fixture.sender });
  await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-scheduled-recovery-new" }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(fixture.managedStarts.length, 1);
  assert.equal(restorationCalls, 0);
  assert.equal(
    fixture.sent.some(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.inputGeneration !== undefined &&
        payload.state === "recording"
    ),
    false
  );
});

test("stop and a new input binding cancel an in-flight managed system restoration", async (t) => {
  const restoration = createDeferred();
  const persisted = [];
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, {}],
    appendPcm: (sessionId, source, buffer) => {
      persisted.push([sessionId, source, buffer]);
      return true;
    },
    sourceInterrupted: async () => {},
    sourceRestored: async () => {
      await restoration.promise;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-inflight-recovery-old" }
  );
  fixture.managedStarts[0].onError(new Error("begin in-flight recovery"));
  await waitForTimed(() => fixture.managedStarts.length === 2, "the in-flight recovery manager");
  const recoveryProducer = fixture.managedStarts[1];
  const stopsBeforeCancellation = fixture.managerStops.length;

  await stop({ sender: fixture.sender });
  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-inflight-recovery-new" }
  );
  send({ sender: fixture.sender }, Buffer.from([9, 10]), "mic", current.inputGeneration);
  const staleAccepted = recoveryProducer.onChunk(Buffer.from([1, 2]));
  restoration.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(staleAccepted, false);
  assert.ok(fixture.managerStops.length > stopsBeforeCancellation);
  assert.deepEqual(
    persisted.map(([sessionId, source]) => [sessionId, source]),
    [["jarvis-inflight-recovery-new", "mic"]]
  );
  assert.equal(
    fixture.sent.some(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.state === "recording" &&
        payload.inputGeneration !== current.inputGeneration
    ),
    false
  );
});

test("stop settles a post-restoration gap retry false and late persistence cannot revive it", async (t) => {
  const restoration = createDeferred();
  const gapPersistence = createDeferred();
  const interruptions = [];
  let restorationCalls = 0;
  const persisted = [];
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, {}],
    appendPcm: (sessionId, source, buffer) => {
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
      if (interruptions.length === 2) await gapPersistence.promise;
    },
    sourceRestored: async () => {
      restorationCalls += 1;
      await restoration.promise;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-post-restore-gap-old" }
  );
  fixture.managedStarts[0].onError(new Error("start recovery"));
  await waitForTimed(() => fixture.managedStarts.length === 2, "the recovery candidate");
  await waitForTimed(() => restorationCalls === 1, "the pending restoration");
  assert.equal(fixture.recoveryLoopStarts.length, 1);
  const recoveryPromise = fixture.recoveryLoopStarts[0];

  fixture.managedStarts[1].onError(new Error("candidate failed after restoration began"));
  restoration.resolve();
  await waitForTimed(() => interruptions.length === 2, "the post-restoration gap persistence");

  await stop({ sender: fixture.sender });
  const current = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-post-restore-gap-new" }
  );
  send({ sender: fixture.sender }, Buffer.from([31, 32]), "mic", current.inputGeneration);
  gapPersistence.resolve();

  const outcome = await Promise.race([
    recoveryPromise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false, value: null }), 250)),
  ]);
  assert.deepEqual(outcome, { settled: true, value: false });
  assert.deepEqual(
    persisted.map(([sessionId, source]) => [sessionId, source]),
    [["jarvis-post-restore-gap-new", "mic"]]
  );
  assert.equal(
    fixture.sent.some(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.state === "recording" &&
        payload.inputGeneration !== current.inputGeneration
    ),
    false
  );
});

test("managed recovery buffer overflow stops the candidate without appending and later retries", async (t) => {
  const firstOverflowChunk = Buffer.alloc(300 * 1024, 1);
  const secondOverflowChunk = Buffer.alloc(300 * 1024, 2);
  const recoveredChunk = Buffer.from([11, 12, 13]);
  const persisted = [];
  let restorationCalls = 0;
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [
      {},
      { chunks: [firstOverflowChunk, secondOverflowChunk] },
      { chunks: [recoveredChunk] },
    ],
    appendPcm: (sessionId, source, buffer) => {
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    sourceInterrupted: async () => {},
    sourceRestored: async () => {
      restorationCalls += 1;
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-overflow-recovery" }
  );
  fixture.managedStarts[0].onError(new Error("begin overflow recovery"));

  await waitForTimed(() => fixture.managedStarts.length === 3, "a retry after buffer overflow");
  await waitForTimed(
    () => persisted.some(([, source]) => source === "system"),
    "the post-overflow recovered system chunk"
  );

  assert.deepEqual(fixture.managedStartAcceptances, [true, false, true]);
  assert.deepEqual(persisted, [["jarvis-overflow-recovery", "system", recoveredChunk]]);
  assert.ok(fixture.managerStops.length >= 2);
  assert.equal(restorationCalls, 1);
  assert.equal(
    fixture.sent.some(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.state === "unavailable" &&
        payload.reason === "system-recovery-buffer-overflow" &&
        payload.inputGeneration === started.inputGeneration
    ),
    true
  );
  assert.equal(
    fixture.sent.some(
      ([channel, payload]) =>
        channel === "meeting-transcription-source-state" &&
        payload.state === "recording" &&
        payload.reason === "system-capture-restored" &&
        payload.inputGeneration === started.inputGeneration
    ),
    true
  );
});

test("managed recovery reopens the gap and retries when buffered delivery throws", async (t) => {
  const failedDeliveryChunk = Buffer.from([21, 22]);
  const recoveredChunk = Buffer.from([23, 24]);
  const interruptions = [];
  const persisted = [];
  let systemDeliveryAttempts = 0;
  const fixture = createFixture({
    systemAvailable: true,
    managedStartSequence: [{}, { chunks: [failedDeliveryChunk] }, { chunks: [recoveredChunk] }],
    appendPcm: (sessionId, source, buffer) => {
      if (source === "system") {
        systemDeliveryAttempts += 1;
        if (systemDeliveryAttempts === 1) throw new Error("temporary evidence delivery failure");
      }
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    sourceInterrupted: async (...args) => {
      interruptions.push(args);
    },
    sourceRestored: async () => {},
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");

  await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-delivery-retry" }
  );
  fixture.managedStarts[0].onError(new Error("begin delivery recovery"));

  await waitForTimed(() => fixture.managedStarts.length === 3, "a retry after delivery failure");
  await waitForTimed(
    () => persisted.some(([, source]) => source === "system"),
    "the system chunk after delivery retry"
  );

  assert.equal(systemDeliveryAttempts, 2);
  assert.deepEqual(persisted, [["jarvis-delivery-retry", "system", recoveredChunk]]);
  assert.equal(interruptions.length, 2);
  assert.equal(interruptions[1][2].reason, "system-recovery-delivery-failed");
  assert.ok(fixture.managerStops.length >= 2);
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

test("initial managed system append exceptions recover without escaping the start", async (t) => {
  const interruptions = [];
  const restorations = [];
  const persisted = [];
  let appendCalls = 0;
  let throwFirstSystem = true;
  const initialChunk = Buffer.from([1, 2]);
  const micChunk = Buffer.from([3, 4]);
  const fixture = createFixture({
    appendPcm: (sessionId, source, buffer) => {
      appendCalls += 1;
      if (source === "system" && throwFirstSystem) {
        throwFirstSystem = false;
        throw new Error("startup evidence failed");
      }
      persisted.push([sessionId, source, Buffer.from(buffer)]);
      return true;
    },
    managedStartChunk: initialChunk,
    sourceInterrupted: async (...args) => interruptions.push(args),
    sourceRestored: async (...args) => restorations.push(args),
    systemAvailable: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const send = fixture.listeners.get("meeting-transcription-send");

  const result = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-flush-failure" }
  );
  send({ sender: fixture.sender }, micChunk, "mic", result.inputGeneration);

  assert.equal(result.success, true);
  await waitForTimed(() => fixture.managedStarts.length === 2, "initial delivery recovery");
  await waitForTimed(
    () => persisted.some(([, source]) => source === "system"),
    "initial delivery recovered append"
  );
  assert.equal(appendCalls, 3);
  assert.equal(interruptions.length, 1);
  assert.equal(restorations.length, 1);
  assert.deepEqual(persisted, [
    ["jarvis-flush-failure", "mic", micChunk],
    ["jarvis-flush-failure", "system", initialChunk],
  ]);
  assert.ok(fixture.managerStops.length >= 1);
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
  let stopSettled = false;
  stopPromise.finally(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.equal(fixture.managerStops.length, 0);

  startDeferred.resolve();
  await waitFor(() => fixture.managerStops.length >= 1, "the post-start rollback manager stop");
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

test("early explicit stop waits for startup settlement before one fresh rollback", async (t) => {
  const aecStartDeferred = createDeferred();
  const persisted = [];
  const fixture = createFixture({
    aecAvailable: true,
    aecStartDeferred,
    appendPcm: (...args) => {
      persisted.push(args);
      return true;
    },
    systemAvailable: true,
    warmStreaming: true,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");

  const startPromise = start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-early-stop" }
  );
  await waitFor(() => fixture.lifecycle.includes("aec-start"), "the deferred AEC start");

  let stopSettled = false;
  const stopPromise = stop({ sender: fixture.sender }).then((result) => {
    stopSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const stopWasPendingBeforeStartupSettled = !stopSettled;

  aecStartDeferred.resolve();
  const [startResult, stopResult] = await Promise.all([startPromise, stopPromise]);
  const managedStartsAfterRollback = fixture.managedStarts.length;
  const lifecycleAfterRollback = [...fixture.lifecycle];

  assert.equal(stopWasPendingBeforeStartupSettled, true);
  assert.equal(startResult.success, false);
  assert.equal(stopResult.success, true);
  assert.equal(managedStartsAfterRollback, 0);
  assert.equal(lifecycleAfterRollback.filter((entry) => entry === "manager-stop").length, 1);
  assert.ok(
    lifecycleAfterRollback.indexOf("aec-stop") > lifecycleAfterRollback.indexOf("aec-start")
  );

  const current = await start({ sender: fixture.sender }, { provider: "local" });
  send({ sender: fixture.sender }, Buffer.alloc(4), "mic", current.inputGeneration);
  assert.equal(current.success, true);
  assert.deepEqual(persisted, []);
});

test("normal stop preserves Jarvis identity through the final local transcription flush", async (t) => {
  const finalTranscriptionDeferred = createDeferred();
  const correctionDeferred = createDeferred();
  const persisted = [];
  const fixture = createFixture({
    appendPcm: (...args) => {
      persisted.push(args);
      return true;
    },
    transcribeLocalWhisper: async () => finalTranscriptionDeferred.promise,
    maybeCorrect: async () => correctionDeferred.promise,
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");
  const pcm = Buffer.alloc(4_800 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(12_000, offset);

  const started = await start(
    { sender: fixture.sender },
    {
      provider: "local",
      micOnly: true,
      jarvisSessionId: "jarvis-final-flush",
    }
  );
  send({ sender: fixture.sender }, pcm, "mic", started.inputGeneration);

  const stopPromise = stop({ sender: fixture.sender });
  await waitFor(() => fixture.whisperCalls.length === 1, "the final local transcription");
  send({ sender: fixture.sender }, pcm, "mic", started.inputGeneration);
  const persistedDuringStop = persisted.length;

  finalTranscriptionDeferred.resolve({ success: true, text: "und der die das" });
  await waitFor(() => fixture.correctionCalls.length === 1, "the final cloud correction");
  let stopSettledBeforeCorrection = false;
  stopPromise.finally(() => {
    stopSettledBeforeCorrection = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const stopWaitedForCorrection = !stopSettledBeforeCorrection;
  correctionDeferred.resolve({
    status: "corrected",
    text: "corrected bilingual transcript",
    confidence: 0.95,
  });
  const stopped = await stopPromise;
  await new Promise((resolve) => setImmediate(resolve));

  const rendererSegments = [];
  for (const [channel, payload] of fixture.sent) {
    if (channel !== "meeting-transcription-segment") continue;
    if (payload.type === "final") {
      rendererSegments.push({ ...payload });
      continue;
    }
    if (payload.type === "correction") {
      for (let index = 0; index < rendererSegments.length; index += 1) {
        const segment = rendererSegments[index];
        if (
          segment.source === payload.source &&
          segment.timestamp === payload.timestamp &&
          segment.text === payload.originalText
        ) {
          rendererSegments[index] = {
            ...segment,
            originalText: segment.text,
            text: payload.text,
          };
        }
      }
    }
  }
  for (const finalSegment of stopped.finalSegments) {
    if (
      rendererSegments.some(
        (segment) =>
          segment.source === finalSegment.source &&
          segment.timestamp === finalSegment.timestamp &&
          segment.text === finalSegment.text
      )
    ) {
      continue;
    }
    rendererSegments.push({ ...finalSegment });
  }

  const [, finalWhisperOptions] = fixture.whisperCalls[0];
  assert.equal(persistedDuringStop, 1);
  assert.equal(persisted.length, 1);
  assert.equal(typeof finalWhisperOptions.initialPrompt, "string");
  assert.ok(finalWhisperOptions.initialPrompt.length > 0);
  assert.equal(fixture.correctionCalls.length, 1);
  assert.equal(stopWaitedForCorrection, true);
  assert.equal(fixture.transcriptRevisions.length, 1);
  assert.equal(fixture.transcriptRevisions[0].sessionId, "jarvis-final-flush");
  assert.equal(rendererSegments.length, 1);
  assert.equal(rendererSegments[0].text, "corrected bilingual transcript");
  assert.equal(rendererSegments[0].originalText, "und der die das");
  assert.equal(stopped.finalSegments.length, 1);
  assert.equal(stopped.finalSegments[0].text, "corrected bilingual transcript");
  assert.equal(stopped.finalSegments[0].source, "mic");
  assert.equal(stopped.finalSegments[0].timestamp, rendererSegments[0].timestamp);
  assert.equal(stopped.finalSegments[0].confidence, 0.25);
  assert.equal(stopped.success, true);
  assert.equal(stopped.transcript, "corrected bilingual transcript");
});

test("Jarvis carries real PCM echo evidence into retained MIC and SYSTEM transcript rows", async (t) => {
  const fixture = createFixture({
    systemAvailable: true,
    transcribeLocalWhisper: async () => ({ success: true, text: "release the API Friday" }),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");
  const pcm = Buffer.alloc(12_000 * 2);
  for (let sample = 0; sample < 12_000; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? 12_000 : -9_000, sample * 2);
  }

  const started = await start(
    { sender: fixture.sender },
    {
      provider: "local",
      jarvisSessionId: "jarvis-real-echo-evidence",
    }
  );
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, pcm, "system", started.inputGeneration);
  }
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, pcm, "mic", started.inputGeneration);
  }

  const stopped = await stop({ sender: fixture.sender });
  const system = stopped.finalSegments.find((segment) => segment.source === "system");
  const mic = stopped.finalSegments.find((segment) => segment.source === "mic");
  const rendererMic = fixture.sent
    .filter(
      ([channel, payload]) =>
        channel === "meeting-transcription-segment" &&
        payload.type === "final" &&
        payload.source === "mic"
    )
    .map(([, payload]) => payload)
    .at(-1);

  assert.equal(started.success, true);
  assert.ok(system, "SYSTEM source row must remain available");
  assert.ok(
    mic,
    `MIC source row must remain available for derived dedupe: ${JSON.stringify({
      finalSegments: stopped.finalSegments,
      whisperCallCount: fixture.whisperCalls.length,
      rendererFinals: fixture.sent.filter(
        ([channel, payload]) =>
          channel === "meeting-transcription-segment" && payload.type === "final"
      ),
    })}`
  );
  assert.equal(mic.echoScore, 1);
  assert.equal(rendererMic.echoScore, 1);
  assert.equal(Number.isSafeInteger(mic.startedAt), true);
  assert.equal(Number.isSafeInteger(mic.endedAt), true);
  assert.ok(mic.startedAt < mic.endedAt);
  assert.ok(system.startedAt < system.endedAt);
});

test("Jarvis retains low-amplitude correlated MIC evidence below the system-dominant gate", async (t) => {
  const fixture = createFixture({
    systemAvailable: true,
    transcribeLocalWhisper: async () => ({ success: true, text: "release Friday" }),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");
  const correlatedPcm = createPcm16(12_000, (sample) =>
    Math.round(500 * Math.sin((2 * Math.PI * sample) / 61))
  );

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-low-amplitude-echo" }
  );
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, correlatedPcm, "system", started.inputGeneration);
  }
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, correlatedPcm, "mic", started.inputGeneration);
  }

  const stopped = await stop({ sender: fixture.sender });
  const mic = stopped.finalSegments.find((segment) => segment.source === "mic");

  assert.ok(mic, "low-amplitude non-silent MIC evidence must reach Jarvis transcription");
  assert.equal(mic.echoScore, 1);
  assert.equal(fixture.whisperCalls.length, 2);
});

test("Jarvis retains low-amplitude double-talk without inventing echo evidence", async (t) => {
  const fixture = createFixture({
    systemAvailable: true,
    transcribeLocalWhisper: async () => ({ success: true, text: "local response" }),
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");
  const systemPcm = createPcm16(12_000, (sample) =>
    Math.round(300 * Math.sin((2 * Math.PI * sample) / 61))
  );
  const doubleTalkPcm = createPcm16(12_000, (sample) =>
    Math.round(
      300 * Math.sin((2 * Math.PI * sample) / 61) + 300 * Math.sin((2 * Math.PI * sample) / 37)
    )
  );

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", jarvisSessionId: "jarvis-low-amplitude-double-talk" }
  );
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, systemPcm, "system", started.inputGeneration);
  }
  for (let index = 0; index < 3; index += 1) {
    send({ sender: fixture.sender }, doubleTalkPcm, "mic", started.inputGeneration);
  }

  const stopped = await stop({ sender: fixture.sender });
  const mic = stopped.finalSegments.find((segment) => segment.source === "mic");

  assert.ok(mic, "low-amplitude double-talk must not be dropped with system-dominant audio");
  assert.equal(mic.echoScore, undefined);
  assert.equal(fixture.whisperCalls.length, 2);
});

test("normal stop waits for an active periodic transcription and drains its tail", async (t) => {
  const periodicTranscriptionDeferred = createDeferred();
  const originalSetInterval = global.setInterval;
  let periodicTick = null;
  global.setInterval = (callback, delay, ...args) => {
    periodicTick = callback;
    return originalSetInterval(() => {}, delay, ...args);
  };
  t.after(() => {
    global.setInterval = originalSetInterval;
  });
  let transcriptionCall = 0;
  const fixture = createFixture({
    transcribeLocalWhisper: async () => {
      transcriptionCall += 1;
      if (transcriptionCall === 1) return periodicTranscriptionDeferred.promise;
      return { success: true, text: "tail transcript" };
    },
  });
  t.after(fixture.cleanup);
  const start = fixture.handles.get("meeting-transcription-start");
  const stop = fixture.handles.get("meeting-transcription-stop");
  const send = fixture.listeners.get("meeting-transcription-send");
  const pcm = Buffer.alloc(4_800 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(12_000, offset);

  const started = await start(
    { sender: fixture.sender },
    { provider: "local", micOnly: true, jarvisSessionId: "jarvis-periodic-final-drain" }
  );
  global.setInterval = originalSetInterval;
  send({ sender: fixture.sender }, pcm, "mic", started.inputGeneration);
  periodicTick();
  await waitFor(() => fixture.whisperCalls.length === 1, "the periodic transcription");
  send({ sender: fixture.sender }, pcm, "mic", started.inputGeneration);

  const stopPromise = stop({ sender: fixture.sender });
  let stopSettled = false;
  stopPromise.finally(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const stopWaitedForPeriodic = !stopSettled;
  periodicTranscriptionDeferred.resolve({ success: true, text: "periodic transcript" });
  const stopped = await stopPromise;

  assert.equal(stopWaitedForPeriodic, true);
  assert.equal(fixture.whisperCalls.length, 2);
  assert.match(stopped.transcript, /periodic transcript/);
  assert.match(stopped.transcript, /tail transcript/);
});
