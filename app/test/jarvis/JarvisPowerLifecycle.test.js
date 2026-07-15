const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisPowerLifecycle = require("../../src/jarvis/main/JarvisPowerLifecycle");
const { RendererPowerResumeHandshake } = JarvisPowerLifecycle;
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function activeState(sessionId = "session-day-1") {
  return {
    sessionId,
    status: "recording",
    startedAt: 1_000,
    captureMode: "dual",
    retentionMode: "speech_triggered",
    capturePolicy: { schemaVersion: 1, preRollMs: 2000, postRollMs: 3000, mergeGapMs: 3000 },
    sources: {
      mic: {
        sourceType: "mic",
        deviceId: "physical-mic",
        deviceLabel: "MV7",
        strategy: "physical",
      },
      system: { sourceType: "system", deviceId: null, deviceLabel: "System", strategy: "loopback" },
    },
  };
}

function createHarness({ initialState = activeState(), resumeFailure = null } = {}) {
  const calls = [];
  let state = structuredClone(initialState);
  const token = {
    ...structuredClone(initialState),
    localDate: "2026-07-14",
    language: "zh-en",
  };
  const service = {
    getState() {
      return structuredClone(state);
    },
    suspendForPower(at) {
      calls.push(["suspend", at]);
      state.status = "paused";
      return { state: structuredClone(state), resumeToken: structuredClone(token) };
    },
    resumeAfterPower(resumeToken, restoration, at) {
      calls.push(["resume", resumeToken.sessionId, restoration, at]);
      if (resumeFailure) throw resumeFailure;
      state.status = "recording";
      state.sessionId = resumeToken.sessionId;
      return structuredClone(state);
    },
    rotateAtLocalDate(input) {
      calls.push(["rotate", input]);
      state = { ...state, sessionId: input.newSessionId, status: "recording" };
      return {
        previousSessionId: input.sessionId,
        sessionId: input.newSessionId,
        localDate: input.localDate,
      };
    },
    recoverOpenSessions(at) {
      calls.push(["recover", at]);
      return [{ id: "interrupted-1" }];
    },
  };
  const processing = {
    async stop() {
      calls.push(["processing-stop"]);
    },
    start() {
      calls.push(["processing-start"]);
    },
  };
  const lifecycle = new JarvisPowerLifecycle({
    service,
    processingLifecycle: processing,
    releaseWhisper: async () => calls.push(["release-whisper"]),
    suspendUpstream: async (captureState) =>
      calls.push(["suspend-upstream", captureState.sessionId]),
    resumeDevices: async (resumeToken) => {
      calls.push(["resume-devices", resumeToken.sessionId]);
      return {
        mic: { deviceId: "physical-mic", deviceLabel: "MV7", strategy: "physical" },
      };
    },
    resumeUpstream: async (resumeToken) => calls.push(["resume-upstream", resumeToken.sessionId]),
    ensureGpuReady: async () => calls.push(["gpu-ready"]),
    localDateKey: (at) => (at < 2_000 ? "2026-07-14" : "2026-07-15"),
    createSessionId: () => "session-day-2",
  });
  return { lifecycle, service, processing, calls, getState: () => structuredClone(state) };
}

function safeFs() {
  const implementation = Object.create(fs);
  implementation.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: 20 * 1024 ** 3,
  });
  return implementation;
}

function createRealCapture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-power-lifecycle-"));
  const repository = new JarvisRepository(path.join(root, "jarvis.sqlite"));
  repository.createSession({
    id: "session-day-1",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    language: "zh-en",
    captureMode: "dual",
    retentionMode: "continuous",
  });
  const service = new JarvisService({
    repository,
    userDataDir: root,
    recordingsDir: path.join(root, "recordings"),
    broadcast() {},
    fsImpl: safeFs(),
  });
  service.startCapture({
    sessionId: "session-day-1",
    startedAt: 1_000,
    captureMode: "dual",
    retentionMode: "continuous",
    sources: [
      {
        sourceType: "mic",
        deviceId: "physical-mic",
        deviceLabel: "MV7",
        strategy: "physical",
      },
      {
        sourceType: "system",
        deviceId: null,
        deviceLabel: "System",
        strategy: "wasapi-loopback",
      },
    ],
  });
  return {
    root,
    repository,
    service,
    close() {
      service.shutdown();
      repository.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("suspend commits capture before joining processing and releasing Whisper", async () => {
  const { lifecycle, calls } = createHarness();

  const result = await lifecycle.onSuspend(1_500);

  assert.equal(result.resumeToken.sessionId, "session-day-1");
  assert.deepEqual(calls, [
    ["suspend-upstream", "session-day-1"],
    ["suspend", 1_500],
    ["processing-stop"],
    ["release-whisper"],
  ]);
});

test("renderer suspend failure still commits a fail-safe durable pause", async () => {
  const { lifecycle, calls, getState } = createHarness();
  lifecycle.suspendUpstream = async () => {
    calls.push(["suspend-upstream", "session-day-1"]);
    throw new Error("renderer did not stop");
  };

  await assert.rejects(lifecycle.onSuspend(1_500), /renderer did not stop/);

  assert.equal(getState().status, "paused");
  assert.equal(lifecycle.getResumeToken().sessionId, "session-day-1");
  assert.equal(calls.filter(([name]) => name === "processing-stop").length, 1);
  assert.equal(calls.filter(([name]) => name === "release-whisper").length, 1);
});

test("durable suspend does not wait for a stalled renderer acknowledgement", async () => {
  const { lifecycle, calls, getState } = createHarness();
  const release = deferred();
  lifecycle.suspendUpstream = async () => {
    calls.push(["suspend-upstream", "session-day-1"]);
    await release.promise;
  };

  const suspending = lifecycle.onSuspend(1_500);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter(([name]) => name === "suspend").length, 1);
  assert.equal(getState().status, "paused");
  assert.equal(lifecycle.getResumeToken().sessionId, "session-day-1");
  release.resolve();
  await suspending;
});

test("durable suspend is committed in the power callback turn", async () => {
  const { lifecycle, calls, getState } = createHarness();

  const suspending = lifecycle.onSuspend(1_500);

  assert.equal(calls.filter(([name]) => name === "suspend").length, 1);
  assert.equal(getState().status, "paused");
  await suspending;
});

test("wake waits for the late renderer stop before starting the replacement stream", async () => {
  const { lifecycle, calls } = createHarness();
  const release = deferred();
  lifecycle.suspendUpstream = async () => {
    calls.push(["suspend-upstream", "session-day-1"]);
    await release.promise;
  };

  const suspending = lifecycle.onSuspend(1_500);
  await new Promise((resolve) => setImmediate(resolve));
  const resuming = lifecycle.onResume(1_700);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 0);

  release.resolve();
  await Promise.all([suspending, resuming]);
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 1);
  assert.equal(calls.filter(([name]) => name === "resume-upstream").length, 1);
});

test("suspend still releases Whisper when the processing join reports failure", async () => {
  const { lifecycle, processing, calls } = createHarness();
  processing.stop = async () => {
    calls.push(["processing-stop"]);
    throw new Error("join failed");
  };

  await assert.rejects(lifecycle.onSuspend(1_500), /join failed/);

  assert.equal(calls.filter(([name]) => name === "release-whisper").length, 1);
  assert.equal(lifecycle.getResumeToken().sessionId, "session-day-1");
});

test("resume re-enumerates devices, keeps the same session, and only then restarts processing", async () => {
  const { lifecycle, calls, getState } = createHarness();
  await lifecycle.onSuspend(1_500);

  const result = await lifecycle.onResume(1_700);

  assert.equal(result.sessionId, "session-day-1");
  assert.equal(getState().sessionId, "session-day-1");
  assert.deepEqual(calls.slice(4), [
    ["resume-devices", "session-day-1"],
    [
      "resume",
      "session-day-1",
      { mic: { deviceId: "physical-mic", deviceLabel: "MV7", strategy: "physical" } },
      1_700,
    ],
    ["resume-upstream", "session-day-1"],
    ["gpu-ready"],
    ["processing-start"],
  ]);
});

test("renderer power handshake waits for fresh device metadata and upstream acknowledgement", async () => {
  const sent = [];
  const handshake = new RendererPowerResumeHandshake({
    send: (request) => sent.push(request),
    isAvailable: () => true,
    createId: () => `request-${sent.length + 1}`,
    timeoutMs: 1_000,
  });

  const devices = handshake.request("enumerate", { sessionId: "session-day-1", sources: {} });
  assert.equal(sent[0].kind, "enumerate");
  handshake.acknowledge(sent[0].id, "ok", {
    mic: { deviceId: "fresh-mic", deviceLabel: "Fresh Mic", strategy: "physical" },
  });
  assert.equal((await devices).mic.deviceId, "fresh-mic");

  const suspended = handshake.request("suspend", {
    sessionId: "session-day-1",
    sources: {},
  });
  assert.equal(sent[1].kind, "suspend");
  handshake.acknowledge(sent[1].id, "ok", null);
  await suspended;

  const upstream = handshake.request("resume", { sessionId: "session-day-1", sources: {} });
  assert.equal(sent[2].kind, "resume");
  handshake.acknowledge(sent[2].id, "ok", null);
  await upstream;
});

test("renderer power handshake rejects unavailable or failed recovery", async () => {
  const unavailable = new RendererPowerResumeHandshake({
    send() {},
    isAvailable: () => false,
  });
  await assert.rejects(
    unavailable.request("enumerate", { sessionId: "session-day-1", sources: {} }),
    /unavailable/
  );

  let request;
  const failed = new RendererPowerResumeHandshake({
    send: (value) => {
      request = value;
    },
    isAvailable: () => true,
  });
  const pending = failed.request("resume", { sessionId: "session-day-1", sources: {} });
  failed.acknowledge(request.id, "error", { message: "microphone missing" });
  await assert.rejects(pending, /microphone missing/);
});

test("duplicate suspend and resume callbacks are single-flight and idempotent", async () => {
  const { lifecycle, calls } = createHarness();

  const suspended = await Promise.all([lifecycle.onSuspend(1_500), lifecycle.onSuspend(1_500)]);
  const resumed = await Promise.all([lifecycle.onResume(1_700), lifecycle.onResume(1_700)]);

  assert.deepEqual(suspended[0], suspended[1]);
  assert.deepEqual(resumed[0], resumed[1]);
  assert.equal(calls.filter(([name]) => name === "suspend").length, 1);
  assert.equal(calls.filter(([name]) => name === "resume").length, 1);
});

test("wake waits for an in-flight suspend join before device recovery", async () => {
  const { lifecycle, processing, calls } = createHarness();
  const entered = deferred();
  const release = deferred();
  processing.stop = async () => {
    calls.push(["processing-stop"]);
    entered.resolve();
    await release.promise;
  };

  const suspending = lifecycle.onSuspend(1_500);
  await entered.promise;
  const resuming = lifecycle.onResume(1_700);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 0);

  release.resolve();
  await Promise.all([suspending, resuming]);
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 1);
});

test("failed resume stays paused with the in-memory token available for retry", async () => {
  const { lifecycle, getState } = createHarness({ resumeFailure: new Error("device lost") });
  await lifecycle.onSuspend(1_500);

  await assert.rejects(lifecycle.onResume(1_700), /device lost/);

  assert.equal(getState().status, "paused");
  assert.equal(lifecycle.getResumeToken().sessionId, "session-day-1");
});

test("GPU health failure re-suspends a durably resumed capture", async () => {
  const { lifecycle, getState, calls } = createHarness();
  await lifecycle.onSuspend(1_500);
  lifecycle.ensureGpuReady = async () => {
    calls.push(["gpu-ready"]);
    throw new Error("GPU unhealthy");
  };

  await assert.rejects(lifecycle.onResume(1_700), /GPU unhealthy/);

  assert.equal(getState().status, "paused");
  assert.equal(lifecycle.getResumeToken().sessionId, "session-day-1");
  assert.equal(calls.filter(([name]) => name === "suspend").length, 2);
  assert.equal(calls.filter(([name]) => name === "suspend-upstream").length, 2);
  assert.equal(calls.filter(([name]) => name === "processing-start").length, 0);
});

test("cold launch reports interruption without invoking device resume", async () => {
  const { lifecycle, calls } = createHarness({
    initialState: { sessionId: null, status: "idle", sources: {} },
  });

  const result = await lifecycle.recoverAfterLaunch(10_000);

  assert.equal(result.interruptedSessionId, "interrupted-1");
  assert.deepEqual(result.interruptedSessionIds, ["interrupted-1"]);
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 0);
});

test("idle wake restarts background processing without opening a device", async () => {
  const { lifecycle, calls } = createHarness({
    initialState: { sessionId: null, status: "idle", sources: {} },
  });
  await lifecycle.onSuspend(1_500);

  const result = await lifecycle.onResume(1_700);

  assert.equal(result.resumed, false);
  assert.equal(calls.filter(([name]) => name === "resume-devices").length, 0);
  assert.equal(calls.filter(([name]) => name === "processing-start").length, 1);
});

test("local midnight rotates once and preserves visible listening", async () => {
  const { lifecycle, calls, getState } = createHarness();
  await lifecycle.onLocalDateChange(1_500);

  const result = await lifecycle.onLocalDateChange(2_000);

  assert.equal(result.sessionId, "session-day-2");
  assert.equal(getState().status, "recording");
  const rotation = calls.find(([name]) => name === "rotate")[1];
  assert.deepEqual(rotation, {
    sessionId: "session-day-1",
    newSessionId: "session-day-2",
    localDate: "2026-07-15",
    at: 2_000,
  });
});

test("first timer callback rotates an active session that started on the prior local date", async () => {
  const { lifecycle, calls } = createHarness();

  const result = await lifecycle.onLocalDateChange(2_000);

  assert.equal(result.sessionId, "session-day-2");
  assert.equal(calls.filter(([name]) => name === "rotate").length, 1);
});

test("duplicate and repeated local-date callbacks return the same destination", async () => {
  const { lifecycle, calls } = createHarness();
  await lifecycle.onLocalDateChange(1_500);

  const results = await Promise.all([
    lifecycle.onLocalDateChange(2_000),
    lifecycle.onLocalDateChange(2_000),
    lifecycle.onLocalDateChange(2_100),
  ]);

  assert.equal(new Set(results.map((result) => result.sessionId)).size, 1);
  assert.equal(calls.filter(([name]) => name === "rotate").length, 1);
});

test("idle local-date changes never start capture", async () => {
  const { lifecycle, calls } = createHarness({
    initialState: { sessionId: null, status: "idle", sources: {} },
  });

  const result = await lifecycle.onLocalDateChange(2_000);

  assert.equal(result.rotated, false);
  assert.equal(calls.filter(([name]) => name === "rotate").length, 0);
});

test("real suspend persists one system gap per active source and resume closes both", () => {
  const runtime = createRealCapture();
  try {
    const suspended = runtime.service.suspendForPower(2_000);
    const gaps = runtime.repository.db
      .prepare(
        `SELECT gap.*, track.source_type
         FROM audio_gaps gap JOIN audio_tracks track ON track.id = gap.track_id
         WHERE track.session_id = ? ORDER BY track.source_type`
      )
      .all("session-day-1");

    assert.equal(suspended.state.status, "paused");
    assert.equal(suspended.resumeToken.sessionId, "session-day-1");
    assert.deepEqual(
      gaps.map((gap) => [gap.source_type, gap.reason, gap.ended_at]),
      [
        ["mic", "system_suspend", null],
        ["system", "system_suspend", null],
      ]
    );

    const resumed = runtime.service.resumeAfterPower(
      suspended.resumeToken,
      {
        mic: { deviceId: "physical-mic-2", deviceLabel: "MV7", strategy: "physical" },
        system: { deviceId: null, deviceLabel: "System", strategy: "wasapi-loopback" },
      },
      3_000
    );
    const closed = runtime.repository.db
      .prepare(
        `SELECT gap.*, track.source_type
         FROM audio_gaps gap JOIN audio_tracks track ON track.id = gap.track_id
         WHERE track.session_id = ? ORDER BY track.source_type`
      )
      .all("session-day-1");
    assert.equal(resumed.sessionId, "session-day-1");
    assert.equal(resumed.status, "recording");
    assert.equal(runtime.service.resumeCapture("session-day-1", 3_001).status, "recording");
    assert.deepEqual(
      closed.map((gap) => [gap.source_type, gap.ended_at, gap.restored_device_id]),
      [
        ["mic", 3_000, "physical-mic-2"],
        ["system", 3_000, null],
      ]
    );
  } finally {
    runtime.close();
  }
});

for (const terminal of ["finish", "fail", "shutdown"]) {
  test(`${terminal} invalidates an in-memory power resume token`, async () => {
    const runtime = createRealCapture();
    try {
      runtime.service.suspendForPower(2_000);
      assert.ok(runtime.service.powerResumeToken);
      if (terminal === "finish") {
        runtime.service.finishCapture("session-day-1", 2_100);
      } else if (terminal === "fail") {
        runtime.service.failCapture("session-day-1", "capture_start_failed", 2_100);
      } else {
        await runtime.service.shutdown();
      }
      assert.equal(runtime.service.powerResumeToken, null);
    } finally {
      runtime.close();
    }
  });
}

test("real midnight rotation preserves choices and persists one continuation", () => {
  const runtime = createRealCapture();
  try {
    const first = runtime.service.rotateAtLocalDate({
      sessionId: "session-day-1",
      newSessionId: "session-day-2",
      localDate: "2026-07-15",
      at: 86_400_000,
    });
    const second = runtime.service.rotateAtLocalDate({
      sessionId: "session-day-1",
      newSessionId: "ignored-duplicate",
      localDate: "2026-07-15",
      at: 86_400_001,
    });
    const next = runtime.repository.getSession("session-day-2");
    const links = runtime.repository.listSessionContinuations("session-day-1");

    assert.equal(first.sessionId, "session-day-2");
    assert.equal(second.sessionId, "session-day-2");
    assert.equal(runtime.service.getState().status, "recording");
    assert.equal(next.capture_mode, "dual");
    assert.equal(next.mic_device_id, "physical-mic");
    assert.equal(next.language, "zh-en");
    assert.equal(next.retention_mode, "continuous");
    assert.equal(
      next.capture_policy_json,
      runtime.repository.getSession("session-day-1").capture_policy_json
    );
    assert.deepEqual(links, [
      {
        source_session_id: "session-day-1",
        destination_session_id: "session-day-2",
        reason: "local_midnight",
        boundary_at: 86_400_000,
        destination_local_date: "2026-07-15",
      },
    ]);
  } finally {
    runtime.close();
  }
});

test("midnight writer startup failure rolls back the link and keeps the old session recording", () => {
  const runtime = createRealCapture();
  const createWriter = runtime.service._createWriter.bind(runtime.service);
  runtime.service._createWriter = (sessionId, ...args) => {
    if (sessionId === "session-day-2") throw new Error("next writer unavailable");
    return createWriter(sessionId, ...args);
  };
  try {
    assert.throws(
      () =>
        runtime.service.rotateAtLocalDate({
          sessionId: "session-day-1",
          newSessionId: "session-day-2",
          localDate: "2026-07-15",
          at: 86_400_000,
        }),
      /next writer unavailable/
    );

    assert.equal(runtime.service.getState().sessionId, "session-day-1");
    assert.equal(runtime.service.getState().status, "recording");
    assert.equal(runtime.repository.getSession("session-day-1").status, "recording");
    assert.equal(runtime.repository.getSession("session-day-2"), null);
    assert.deepEqual(runtime.repository.listSessionContinuations("session-day-1"), []);
    assert.equal(
      runtime.service.appendPcm("session-day-1", "mic", Buffer.alloc(24_000 * 2, 1)),
      true
    );
  } finally {
    runtime.close();
  }
});
