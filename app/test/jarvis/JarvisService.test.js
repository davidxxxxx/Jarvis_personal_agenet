const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const PreviewAudioRing = require("../../src/jarvis/main/PreviewAudioRing");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createRepository() {
  const sessions = new Map([
    [
      "s1",
      {
        id: "s1",
        started_at: 1000,
        ended_at: null,
        status: "recording",
        mic_device_id: "mic-1",
      },
    ],
  ]);
  const chunks = [];
  const tracks = [];
  const gaps = [];
  const evidenceGaps = [];
  return {
    sessions,
    chunks,
    tracks,
    gaps,
    evidenceGaps,
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    setSessionStatus(id, status, at) {
      const session = sessions.get(id);
      session.status = status;
      session.ended_at = ["completed", "failed", "recovered"].includes(status) ? at : null;
      return session;
    },
    insertAudioChunk(chunk) {
      chunks.push(chunk);
      return chunk;
    },
    createTrack(track) {
      tracks.push({ ...track });
      return track;
    },
    createTracks(nextTracks) {
      tracks.push(...nextTracks.map((track) => ({ ...track })));
      return nextTracks;
    },
    setTrackState(id, state, endedAt = null) {
      const track = tracks.find((entry) => entry.id === id);
      if (track) Object.assign(track, { state, endedAt });
      return track;
    },
    openGap(gap) {
      gaps.push({ ...gap, endedAt: null });
      return gap;
    },
    interruptTrack({ trackId, gap, sessionId = null, sessionStatus = null }) {
      this.setTrackState(trackId, "recovering", gap.startedAt);
      const opened = this.openGap(gap);
      if (sessionId && sessionStatus)
        this.setSessionStatus(sessionId, sessionStatus, gap.startedAt);
      return opened;
    },
    closeGap(id, endedAt, recoveryAttempts = null) {
      const gap = gaps.find((entry) => entry.id === id);
      if (gap) Object.assign(gap, { endedAt, recoveryAttempts });
      return gap;
    },
    restoreTrack({
      trackId,
      gapId,
      endedAt,
      recoveryAttempts = 1,
      targetState = "active",
      sessionId = null,
      sessionStatus = null,
    }) {
      this.closeGap(gapId, endedAt, recoveryAttempts);
      const restored = this.setTrackState(
        trackId,
        targetState,
        targetState === "paused" ? endedAt : null
      );
      if (sessionId && sessionStatus) this.setSessionStatus(sessionId, sessionStatus, endedAt);
      return restored;
    },
    pauseCapture({ sessionId, sources, at }) {
      for (const source of sources) {
        if (source.expectedState === "active") this.setTrackState(source.trackId, "paused", at);
      }
      return this.setSessionStatus(sessionId, "paused", at);
    },
    pauseCaptureForLowDisk({ sessionId, sources, at }) {
      this.pauseCapture({ sessionId, sources, at });
      const session = sessions.get(sessionId);
      session.stop_reason = "capture_stopped_low_disk";
      session.durable_boundary_at = at;
      return session;
    },
    resumeCapture({ sessionId, sources }) {
      for (const source of sources) {
        if (source.expectedState === "paused") this.setTrackState(source.trackId, "active", null);
      }
      const session = this.setSessionStatus(sessionId, "recording", null);
      session.stop_reason = null;
      session.durable_boundary_at = null;
      return session;
    },
    finalizeCapture({ sessionId, sources, trackState, sessionStatus, at }) {
      for (const source of sources) {
        if (source.gapId) this.closeGap(source.gapId, at, null);
        this.setTrackState(source.trackId, trackState, at);
      }
      return this.setSessionStatus(sessionId, sessionStatus, at);
    },
    setSessionRetention(sessionId, retentionMode, capturePolicy) {
      const session = sessions.get(sessionId);
      if (session) {
        session.retention_mode = retentionMode;
        session.capture_policy_json = JSON.stringify(capturePolicy);
      }
      return session ?? null;
    },
    recordEvidenceGap(gap) {
      evidenceGaps.push({ ...gap });
      return gap;
    },
    commitChunk(chunk) {
      chunks.push(chunk);
      return chunk;
    },
    recoverOpenSessions() {
      return 0;
    },
  };
}

function createSafeFs() {
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  return fsImpl;
}

for (const requiredMethod of ["setSessionRetention", "recordEvidenceGap"]) {
  test(`constructor requires repository.${requiredMethod}`, () => {
    const repository = createRepository();
    delete repository[requiredMethod];

    assert.throws(
      () =>
        new JarvisService({
          repository,
          userDataDir: path.join(os.tmpdir(), "jarvis-required-repository-method"),
          broadcast() {},
        }),
      new RegExp(`repository\\.${requiredMethod}`)
    );
  });
}

function dualSources() {
  return [
    { sourceType: "mic", deviceId: "mv7", deviceLabel: "MV7", strategy: "web-audio" },
    {
      sourceType: "system",
      deviceId: null,
      deviceLabel: "Output",
      strategy: "wasapi-loopback",
    },
  ];
}

test("rejects capture startup while the process-wide migration gate is closed", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-migration-gate-"));
  const repository = createRepository();
  const migrationGate = {
    assertProducerAllowed(kind) {
      assert.equal(kind, "capture");
      const error = new Error("storage migration in progress");
      error.code = "STORAGE_MIGRATION_IN_PROGRESS";
      throw error;
    },
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    migrationGate,
    broadcast() {},
    now: () => 1_000,
    fsImpl: createSafeFs(),
  });

  try {
    assert.throws(
      () =>
        service.startCapture({
          sessionId: "s1",
          startedAt: 1_000,
          micDeviceId: "mic-1",
        }),
      (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
    );
    assert.equal(service.getState().status, "idle");
    assert.deepEqual(repository.tracks, []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("rebuilds and validates the emergency reserve before capture start and resume", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-lifecycle-"));
  const repository = createRepository();
  let ensureCalls = 0;
  const storageGovernor = {
    ensureReserve() {
      ensureCalls += 1;
    },
    evaluate() {
      return "ok";
    },
    inspect() {
      return { state: "ok" };
    },
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    fsImpl: createSafeFs(),
    storageGovernor,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.pauseCapture("s1", 1_100);
    service.resumeCapture("s1", 1_200);

    assert.equal(ensureCalls, 2);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps capture paused when the emergency reserve cannot be rebuilt", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-resume-fail-"));
  const repository = createRepository();
  let ensureCalls = 0;
  const storageGovernor = {
    ensureReserve() {
      ensureCalls += 1;
      if (ensureCalls > 1) throw new Error("reserve unavailable");
    },
    evaluate() {
      return "ok";
    },
    inspect() {
      return { state: "ok" };
    },
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    fsImpl: createSafeFs(),
    storageGovernor,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.pauseCapture("s1", 1_100);

    assert.throws(() => service.resumeCapture("s1", 1_200), /reserve unavailable/);
    assert.equal(service.getState().status, "paused");
    assert.equal(repository.sessions.get("s1").status, "paused");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("rejects capture startup when its mode differs from the persisted session", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-mode-mismatch-"));
  const repository = createRepository();
  repository.sessions.get("s1").capture_mode = "system";
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_000,
    fsImpl: createSafeFs(),
  });

  try {
    assert.throws(
      () =>
        service.startCapture({
          sessionId: "s1",
          startedAt: 1_000,
          captureMode: "mic",
          sources: [
            {
              sourceType: "mic",
              deviceId: "mic-1",
              deviceLabel: "Physical microphone",
              strategy: "web-audio",
            },
          ],
        }),
      /capture mode does not match persisted session/
    );
    assert.equal(service.getState().status, "idle");
    assert.deepEqual(repository.tracks, []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "system session retaining a microphone identity",
    captureMode: "system",
    persistedMicDeviceId: "legacy-mic",
    inputMicDeviceId: null,
    sources: [
      {
        sourceType: "system",
        deviceId: null,
        deviceLabel: "Windows output",
        strategy: "wasapi-loopback",
      },
    ],
    pattern: /system capture session must not persist a microphone device id/,
  },
  {
    name: "mic source differing from the persisted microphone identity",
    captureMode: "dual",
    persistedMicDeviceId: "persisted-mic",
    inputMicDeviceId: "replacement-mic",
    sources: [
      {
        sourceType: "mic",
        deviceId: "replacement-mic",
        deviceLabel: "Replacement microphone",
        strategy: "web-audio",
      },
      {
        sourceType: "system",
        deviceId: null,
        deviceLabel: "Windows output",
        strategy: "wasapi-loopback",
      },
    ],
    pattern: /microphone source does not match persisted session/,
  },
]) {
  test(`rejects ${scenario.name}`, () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-source-mismatch-"));
    const repository = createRepository();
    Object.assign(repository.sessions.get("s1"), {
      capture_mode: scenario.captureMode,
      mic_device_id: scenario.persistedMicDeviceId,
    });
    const service = new JarvisService({
      repository,
      userDataDir,
      broadcast() {},
      now: () => 1_000,
      fsImpl: createSafeFs(),
    });

    try {
      assert.throws(
        () =>
          service.startCapture({
            sessionId: "s1",
            startedAt: 1_000,
            micDeviceId: scenario.inputMicDeviceId,
            captureMode: scenario.captureMode,
            sources: scenario.sources,
          }),
        scenario.pattern
      );
      assert.equal(service.getState().status, "idle");
      assert.deepEqual(repository.tracks, []);
    } finally {
      service.shutdown();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

test("an explicit recordings directory controls disk checks and audio paths", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-data-"));
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-audio-"));
  const repository = createRepository();
  const checkedPaths = [];
  const fsImpl = createSafeFs();
  fsImpl.statfsSync = (checkedPath) => {
    checkedPaths.push(checkedPath);
    return { bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 };
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    recordingsDir,
    broadcast() {},
    now: () => 1_100,
    fsImpl,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4_800, 1));
    service.finishCapture("s1", 1_100);

    assert.equal(checkedPaths.length > 0, true);
    assert.equal(
      checkedPaths.every((checkedPath) => checkedPath === recordingsDir),
      true
    );
    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.chunks[0].path.startsWith(recordingsDir), true);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  }
});

test("committed capture audio notifies the preview requester after durable commit", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-request-"));
  const repository = createRepository();
  const notifications = [];
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_100,
    fsImpl: createSafeFs(),
    onChunkCommitted: (chunk) => notifications.push(chunk),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4_800, 1));
    service.finishCapture("s1", 1_100);

    assert.equal(repository.chunks.length, 1);
    assert.deepEqual(notifications, [repository.chunks[0]]);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("an async committed-chunk callback rejection cannot escape durable capture", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chunk-callback-rejection-"));
  const repository = createRepository();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.prependListener("unhandledRejection", onUnhandled);
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_100,
    fsImpl: createSafeFs(),
    onChunkCommitted: async () => {
      throw new Error("chunk callback rejected");
    },
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4_800, 1));
    service.finishCapture("s1", 1_100);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(repository.chunks.length, 1);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("continuous capture emits 15-second live preview watermarks while final chunks remain 60 seconds", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-watermark-"));
  const repository = createRepository();
  const watermarks = [];
  const previewAudioRing = new PreviewAudioRing({
    rootDir: path.join(userDataDir, "recordings", ".preview"),
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 61_000,
    fsImpl: createSafeFs(),
    previewAudioRing,
    onPreviewWatermark: (watermark) => watermarks.push(watermark),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    for (let second = 0; second < 60; second += 1) {
      assert.equal(service.appendMicPcm("s1", Buffer.alloc(24_000 * 2, second)), true);
    }

    assert.deepEqual(
      watermarks.map(({ sessionId, trackId, sourceType, throughMs }) => ({
        sessionId,
        trackId,
        sourceType,
        throughMs,
      })),
      [15_000, 30_000, 45_000, 60_000].map((throughMs) => ({
        sessionId: "s1",
        trackId: watermarks[0].trackId,
        sourceType: "mic",
        throughMs,
      }))
    );
    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.chunks[0].durationMs, 60_000);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("an async preview watermark rejection is contained outside the capture path", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-rejection-"));
  const repository = createRepository();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.prependListener("unhandledRejection", onUnhandled);
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 16_000,
    fsImpl: createSafeFs(),
    onPreviewWatermark: async () => {
      throw new Error("preview request rejected");
    },
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(24_000 * 2 * 15, 1)), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(service.getState().status, "recording");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("terminal capture clears its disposable live preview ring without touching final chunks", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-terminal-cleanup-"));
  const repository = createRepository();
  const previewAudioRing = new PreviewAudioRing({
    rootDir: path.join(userDataDir, "recordings", ".preview"),
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 61_000,
    fsImpl: createSafeFs(),
    previewAudioRing,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(24_000 * 2 * 60, 1));
    const trackId = repository.tracks[0].id;
    service.finishCapture("s1", 61_000);

    assert.equal(
      await previewAudioRing.withPreviewWav(
        { sessionId: "s1", trackId, fromMs: 0, throughMs: 60_000 },
        () => assert.fail("terminal preview audio remained readable")
      ),
      null
    );
    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.chunks[0].durationMs, 60_000);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("reconfigures every evidence holder and preview ring only after old preview cleanup", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reconfigure-"));
  const nextRoot = path.join(userDataDir, "next-recordings");
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_000,
    fsImpl: createSafeFs(),
  });
  try {
    const oldRing = service.previewAudioRing;
    const oldRoot = oldRing.rootDir;
    oldRing.append({
      sessionId: "preview-old-root",
      trackId: "track-mic",
      sourceType: "mic",
      fromMs: 0,
      throughMs: 1,
      pcm: Buffer.alloc(48),
    });
    const snapshotStarted = deferred();
    const releaseSnapshot = deferred();
    const snapshot = oldRing.withPreviewWav(
      {
        sessionId: "preview-old-root",
        trackId: "track-mic",
        fromMs: 0,
        throughMs: 1,
      },
      async () => {
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
      }
    );
    await snapshotStarted.promise;

    let migrationPrepared = false;
    const preparation = service.prepareStorageMigration().then(() => {
      migrationPrepared = true;
    });
    await Promise.resolve();
    assert.equal(migrationPrepared, false);
    assert.equal(service.previewAudioRing, oldRing);
    assert.equal(service.recordingsDir, path.join(userDataDir, "recordings"));

    releaseSnapshot.resolve();
    await Promise.all([snapshot, preparation]);
    assert.equal(oldRing.entries.size, 0);

    service.reconfigureStorage({ recordingsDir: nextRoot });
    assert.equal(service.recordingsDir, nextRoot);
    assert.equal(service.audioEvidenceReader.recordingsRoot, nextRoot);
    assert.equal(service.previewAudioRing, oldRing);
    assert.equal(service.previewAudioRing.rootDir, path.join(nextRoot, ".preview"));

    fs.rmSync(oldRoot, { recursive: true, force: true });
    service.previewAudioRing.append({
      sessionId: "preview-new-root",
      trackId: "track-mic",
      sourceType: "mic",
      fromMs: 0,
      throughMs: 1,
      pcm: Buffer.alloc(48),
    });
    await service.previewAudioRing.withPreviewWav(
      {
        sessionId: "preview-new-root",
        trackId: "track-mic",
        fromMs: 0,
        throughMs: 1,
      },
      ({ path: previewPath }) => {
        assert.equal(previewPath.startsWith(path.join(nextRoot, ".preview")), true);
        assert.equal(fs.existsSync(oldRoot), false);
      }
    );

    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.throws(
      () => service.reconfigureStorage({ recordingsDir: path.join(userDataDir, "unsafe") }),
      /capture must be inactive/
    );
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("migration and shutdown both join scheduled terminal preview cleanup", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-cleanup-join-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 2_000,
    fsImpl: createSafeFs(),
  });
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const originalClearSession = service.previewAudioRing.clearSession.bind(service.previewAudioRing);
  service.previewAudioRing.clearSession = async (sessionId) => {
    cleanupStarted.resolve();
    await releaseCleanup.promise;
    return originalClearSession(sessionId);
  };

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.finishCapture("s1", 2_000);
    await cleanupStarted.promise;

    let prepared = false;
    const preparation = service.prepareStorageMigration().then(() => {
      prepared = true;
    });
    const shutdown = service.shutdown();
    assert.equal(shutdown, service.shutdown());
    await Promise.resolve();
    assert.equal(prepared, false);

    releaseCleanup.resolve();
    await Promise.all([preparation, shutdown]);
    assert.equal(prepared, true);
    assert.equal(service.previewAudioRing.entries.size, 0);
    assert.equal(service.previewAudioRing.activeOperations.size, 0);
  } finally {
    releaseCleanup.resolve();
    await service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("pause closes audio, resume reuses the session, and finish stores seven-day metadata", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  const broadcasts = [];
  let clock = 1000;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast: (state) => broadcasts.push(state),
    now: () => clock,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1000, micDeviceId: "mic-1" });
    service.appendMicPcm("s1", Buffer.alloc(2400, 1));
    clock = 1100;
    service.pauseCapture("s1", clock);

    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.chunks[0].durationMs, 50);
    assert.equal(repository.chunks[0].expiresAt, repository.chunks[0].endedAt + 7 * 86400000);

    clock = 5000;
    service.resumeCapture("s1", clock);
    service.appendMicPcm("s1", Buffer.alloc(4800, 2));
    clock = 5100;
    service.finishCapture("s1", clock);

    assert.equal(repository.sessions.get("s1").status, "completed");
    assert.equal(repository.chunks.length, 2);
    assert.equal(repository.chunks[1].durationMs, 100);
    assert.equal(service.getState().elapsedMs, 200);
    assert.equal(
      broadcasts.every((state) => !("transcript" in state)),
      true
    );
    assert.deepEqual(Object.keys(broadcasts.at(-1)).sort(), [
      "captureMode",
      "capturePolicy",
      "effectiveRetentionMode",
      "elapsedMs",
      "errorCode",
      "retentionDegradedReason",
      "retentionMode",
      "sessionId",
      "sources",
      "startedAt",
      "status",
    ]);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("append rejects a session mismatch without writing audio", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1000,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1000, micDeviceId: null });
    assert.throws(() => service.appendMicPcm("other", Buffer.alloc(2)), /session mismatch/);
    service.finishCapture("s1", 1000);
    assert.deepEqual(repository.chunks, []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("audio metadata starts at the explicit session start rather than IPC handling time", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  let clock = 1200;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => clock,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4800, 1));
    clock = 1300;
    service.pauseCapture("s1", clock);

    assert.equal(repository.chunks[0].startedAt, 1000);
    assert.equal(repository.chunks[0].durationMs, 100);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("fails visibly before opening a writer when free disk is below the safety cutoff", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  const broadcasts = [];
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 1024 ** 3 });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast: (state) => broadcasts.push(state),
    now: () => 1_000,
    fsImpl,
  });

  try {
    assert.throws(
      () => service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null }),
      /disk space/i
    );
    assert.equal(repository.sessions.get("s1").status, "failed");
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "DISK_SPACE_LOW");
    assert.equal(broadcasts.at(-1).errorCode, "DISK_SPACE_LOW");
    assert.deepEqual(repository.chunks, []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("checks disk again at each rotation, commits legal evidence, and safe-stops recoverably", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => {
    diskChecks += 1;
    const safe = diskChecks < 3;
    return {
      bsize: 1,
      blocks: 200 * 1024 ** 3,
      bavail: safe ? 20 * 1024 ** 3 : 1024 ** 3,
    };
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_000,
    fsImpl,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    const accepted = service.appendMicPcm("s1", Buffer.alloc(24000 * 2 * 60 * 2, 1));

    assert.equal(accepted, false);
    assert.equal(diskChecks, 3);
    assert.equal(service.getState().status, "paused");
    assert.equal(service.getState().errorCode, "capture_stopped_low_disk");
    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(repository.sessions.get("s1").stop_reason, "capture_stopped_low_disk");
    assert.equal(repository.sessions.get("s1").durable_boundary_at, 120_900);
    assert.equal(repository.chunks.length, 2);
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(4_800, 1)), false);
    const sessionDir = path.join(userDataDir, "recordings", "s1", "mic");
    assert.equal(
      fs.readdirSync(sessionDir).some((name) => name.endsWith(".part")),
      false
    );
    assert.equal(fs.readdirSync(sessionDir).filter((name) => name.endsWith(".wav")).length, 2);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("protects and reconciles a low-disk stop record when its database transaction fails", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-low-disk-recovery-"));
  const repository = createRepository();
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: ++diskChecks < 3 ? 20 * 1024 ** 3 : 1024 ** 3,
  });
  const persistLowDisk = repository.pauseCaptureForLowDisk;
  const persistenceError = new Error("low-disk pause transaction unavailable");
  repository.pauseCaptureForLowDisk = () => {
    throw persistenceError;
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_000,
    fsImpl,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.throws(
      () => service.appendMicPcm("s1", Buffer.alloc(24_000 * 2 * 60 * 2, 1)),
      (error) => error === persistenceError
    );

    const recoveryDir = path.join(userDataDir, "recordings", ".session-recovery");
    assert.equal(fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(repository.sessions.get("s1").status, "recording");

    repository.pauseCaptureForLowDisk = persistLowDisk;
    service.recoverOpenSessions(130_000);

    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(repository.sessions.get("s1").stop_reason, "capture_stopped_low_disk");
    assert.deepEqual(fs.readdirSync(recoveryDir), []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("persists a low-disk pause record when the emergency chunk commit and pause transaction both fail", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-low-disk-chunk-failure-"));
  const repository = createRepository();
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: ++diskChecks < 3 ? 20 * 1024 ** 3 : 1024 ** 3,
  });
  const commitChunk = repository.commitChunk;
  const pauseLowDisk = repository.pauseCaptureForLowDisk;
  const commitError = new Error("sqlite chunk commit failed");
  repository.commitChunk = () => {
    throw commitError;
  };
  repository.pauseCaptureForLowDisk = () => {
    throw new Error("sqlite low-disk pause failed");
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_000,
    fsImpl,
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(4_800, 1)), true);
    assert.throws(() => service._stopForLowDisk(1_100), /failed to close audio sources/);
    const recoveryDir = path.join(userDataDir, "recordings", ".session-recovery");
    assert.equal(fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".json")).length, 1);

    repository.commitChunk = commitChunk;
    repository.pauseCaptureForLowDisk = pauseLowDisk;
    service.recoverOpenSessions(130_000);

    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(repository.sessions.get("s1").stop_reason, "capture_stopped_low_disk");
    assert.equal(repository.sessions.get("s1").durable_boundary_at, 1_100);
    assert.equal(
      repository.tracks.every((track) => ["paused", "recovering"].includes(track.state)),
      true
    );
    assert.deepEqual(fs.readdirSync(recoveryDir), []);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("shutdown flushes the last chunk and marks an active session recovered", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  let clock = 1_000;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => clock,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4_800, 1));
    clock = 1_100;

    service.shutdown();

    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.sessions.get("s1").status, "recovered");
    assert.equal(service.getState().status, "recovered");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("shutdown is idempotent and rejects late capture callbacks into closed state", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 1_100,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.beginShutdown();
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(4_800, 1)), false);
    assert.throws(() => service.resumeCapture("s1", 1_100), /shutting down/);
    service.shutdown();
    service.shutdown();
    assert.equal(repository.chunks.length, 0);
    assert.equal(repository.sessions.get("s1").status, "recovered");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("an error pause keeps completed audio and broadcasts the microphone error code", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-"));
  const repository = createRepository();
  const broadcasts = [];
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast: (state) => broadcasts.push(state),
    now: () => 1_100,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    service.appendMicPcm("s1", Buffer.alloc(4_800, 1));

    service.pauseCapture("s1", 1_100, "MIC_DISCONNECTED");

    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(service.getState().status, "paused");
    assert.equal(service.getState().errorCode, "MIC_DISCONNECTED");
    assert.equal(broadcasts.at(-1).errorCode, "MIC_DISCONNECTED");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("system loss degrades dual capture without closing mic", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-dual-"));
  const repository = createRepository();
  let clock = 10;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => clock,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: [
        {
          sourceType: "mic",
          deviceId: "mv7",
          deviceLabel: "Shure MV7",
          strategy: "web-audio",
        },
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: "Windows output",
          strategy: "wasapi-loopback",
        },
      ],
    });
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(4_800, 1)), true);
    clock = 20;
    const degraded = service.sourceInterrupted("s1", "system", {
      at: 20,
      reason: "track-ended",
    });

    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.captureMode, "dual");
    assert.equal(degraded.sources.mic.state, "active");
    assert.equal(degraded.sources.system.state, "reconnecting");
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(4_800, 2)), true);
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(4_800, 3)), false);
    assert.equal(repository.gaps.length, 1);
    assert.equal(repository.gaps[0].reason, "track-ended");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("restoring one source reopens only that writer and continues its sequence", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-restore-"));
  const repository = createRepository();
  let clock = 10;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => clock,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: [
        { sourceType: "mic", deviceId: "mv7", deviceLabel: "MV7", strategy: "web-audio" },
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: "Output",
          strategy: "wasapi-loopback",
        },
      ],
    });
    service.appendPcm("s1", "system", Buffer.alloc(48, 1));
    clock = 20;
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });
    const restored = service.sourceRestored("s1", "system", {
      at: 30,
      deviceId: "output-2",
      deviceLabel: "New output",
      strategy: "wasapi-loopback",
    });
    service.appendPcm("s1", "system", Buffer.alloc(48, 2));
    service.appendPcm("s1", "mic", Buffer.alloc(48, 3));
    clock = 40;
    service.finishCapture("s1", 40);

    assert.equal(restored.status, "recording");
    assert.equal(restored.sources.system.state, "active");
    assert.equal(restored.sources.system.deviceId, "output-2");
    assert.equal(repository.gaps[0].endedAt, 30);
    assert.deepEqual(
      repository.chunks
        .filter((chunk) => chunk.sourceType === "system")
        .map((chunk) => chunk.sequenceNumber),
      [0, 1]
    );
    assert.equal(repository.chunks.filter((chunk) => chunk.sourceType === "mic").length, 1);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a sticky writer failure isolates only its source", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-fault-"));
  const repository = createRepository();
  const commitChunk = repository.commitChunk;
  repository.commitChunk = (chunk) => {
    if (chunk.sourceType === "system") throw new Error("system metadata unavailable");
    return commitChunk.call(repository, chunk);
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: [
        { sourceType: "mic", deviceId: "mv7", deviceLabel: "MV7", strategy: "web-audio" },
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: "Output",
          strategy: "wasapi-loopback",
        },
      ],
    });
    service.appendPcm("s1", "system", Buffer.alloc(48, 1));
    const state = service.sourceInterrupted("s1", "system", {
      at: 20,
      reason: "track-ended",
    });

    assert.equal(state.status, "degraded");
    assert.equal(state.sources.system.errorCode, "AUDIO_WRITE_FAILED");
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 2)), true);
    assert.doesNotThrow(() => service.finishCapture("s1", 30));
    assert.equal(repository.chunks.filter((chunk) => chunk.sourceType === "mic").length, 1);
    assert.equal(repository.gaps.length, 1);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("degraded public state keeps the durable session open with real evidence storage", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-service-real-store-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({
    id: "s1",
    startedAt: 10,
    micDeviceId: "mv7",
    captureMode: "dual",
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: [
        { sourceType: "mic", deviceId: "mv7", deviceLabel: "MV7", strategy: "web-audio" },
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: "Output",
          strategy: "wasapi-loopback",
        },
      ],
    });
    const state = service.sourceInterrupted("s1", "system", {
      at: 20,
      reason: "track-ended",
    });

    assert.equal(state.status, "degraded");
    assert.equal(repository.getSession("s1").status, "recording");
    assert.equal(repository.db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 1);
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 1)), true);
    service.finishCapture("s1", 30);
    assert.deepEqual(
      repository.db.prepare("SELECT source_type, sequence_number FROM audio_chunks").all(),
      [{ source_type: "mic", sequence_number: 0 }]
    );
    assert.deepEqual(
      repository.db
        .prepare("SELECT job_type FROM processing_jobs ORDER BY job_type")
        .all()
        .map((job) => job.job_type),
      ["compress_chunk", "transcribe_chunk"]
    );
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real evidence storage timestamps a replacement binding without rewriting track identity", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-binding-history-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({
    id: "s1",
    startedAt: 10,
    micDeviceId: "mic-original",
    captureMode: "mic",
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 40,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [
        {
          sourceType: "mic",
          deviceId: "mic-original",
          deviceLabel: "Original microphone",
          strategy: "web-audio",
        },
      ],
    });
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 1)), true);
    service.sourceInterrupted("s1", "mic", { at: 20, reason: "device-change" });
    const restored = service.sourceRestored("s1", "mic", {
      at: 30,
      deviceId: "mic-replacement",
      deviceLabel: "Replacement microphone",
      strategy: "web-audio",
    });

    assert.equal(restored.status, "recording");
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 2)), true);
    assert.deepEqual(
      repository.db
        .prepare(
          `SELECT device_id, device_label, strategy, state
           FROM audio_tracks WHERE session_id = 's1' AND source_type = 'mic'`
        )
        .get(),
      {
        device_id: "mic-original",
        device_label: "Original microphone",
        strategy: "web-audio",
        state: "active",
      }
    );
    assert.deepEqual(
      repository.db
        .prepare(
          `SELECT started_at, ended_at, restored_device_id, restored_device_label, restored_strategy
           FROM audio_gaps WHERE reason = 'device-change'`
        )
        .get(),
      {
        started_at: 20,
        ended_at: 30,
        restored_device_id: "mic-replacement",
        restored_device_label: "Replacement microphone",
        restored_strategy: "web-audio",
      }
    );
    assert.equal(repository.getSession("s1").status, "recording");
    service.finishCapture("s1", 40);
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("source restoration rejects a payload that spoofs another lane identity", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-restore-identity-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });

    assert.throws(
      () =>
        service.sourceRestored("s1", "system", {
          at: 30,
          sourceType: "mic",
          deviceId: "output-2",
          deviceLabel: "New output",
          strategy: "wasapi-loopback",
        }),
      /source type.*match/i
    );
    assert.equal(service.getState().sources.system.sourceType, "system");
    assert.equal(service.getState().sources.system.state, "reconnecting");
    assert.equal(service.getState().sources.mic.sourceType, "mic");
    assert.equal(
      repository.tracks.find((track) => track.sourceType === "system").sourceType,
      "system"
    );
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const lifecycle of ["pauseCapture", "finishCapture"]) {
  test(`${lifecycle} settles a metadata close failure as terminal failed state`, () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-${lifecycle}-fault-`));
    const repository = createRepository();
    repository.commitChunk = () => {
      throw new Error("metadata unavailable");
    };
    const service = new JarvisService({
      repository,
      userDataDir,
      broadcast() {},
      now: () => 20,
      fsImpl: createSafeFs(),
    });

    try {
      service.startCapture({
        sessionId: "s1",
        startedAt: 10,
        captureMode: "mic",
        sources: [dualSources()[0]],
      });
      service.appendMicPcm("s1", Buffer.alloc(48, 1));

      const state = service[lifecycle]("s1", 20);

      assert.equal(state.status, "failed");
      assert.equal(state.errorCode, "AUDIO_WRITE_FAILED");
      assert.equal(state.sources.mic.state, "failed");
      assert.equal(repository.sessions.get("s1").status, "failed");
      assert.equal(service.appendMicPcm("s1", Buffer.alloc(48, 2)), false);
      assert.equal(
        fs
          .readdirSync(path.join(userDataDir, "recordings", "s1", "mic", "recovery"))
          .filter((name) => name.endsWith(".recovery.json")).length,
        1
      );
    } finally {
      service.shutdown();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

test("disk loss during restoration safe-stops the session and preserves the recovering lane", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-restore-disk-"));
  const repository = createRepository();
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => {
    diskChecks += 1;
    return {
      bsize: 1,
      blocks: 200 * 1024 ** 3,
      bavail: diskChecks === 1 ? 20 * 1024 ** 3 : 1024 ** 3,
    };
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl,
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });

    const state = service.sourceRestored("s1", "system", {
      at: 30,
      deviceId: "output-2",
      deviceLabel: "New output",
      strategy: "wasapi-loopback",
    });

    assert.equal(state.status, "paused");
    assert.equal(state.errorCode, "capture_stopped_low_disk");
    assert.equal(state.sources.mic.state, "paused");
    assert.equal(state.sources.system.state, "reconnecting");
    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48)), false);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("interruption persistence failure leaves the original writer live and state unchanged", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interrupt-rollback-"));
  const repository = createRepository();
  repository.interruptTrack = () => {
    throw new Error("gap persistence failed");
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });

    assert.throws(
      () => service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" }),
      /gap persistence failed/
    );
    assert.equal(service.getState().status, "recording");
    assert.equal(service.getState().sources.system.state, "active");
    assert.equal(repository.gaps.length, 0);
    assert.equal(repository.tracks.find((track) => track.sourceType === "system").state, "active");
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 1)), true);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("all-source interruption stays degraded and remains manually pausable", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-all-sources-recovering-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [dualSources()[0]],
    });

    const interrupted = service.sourceInterrupted("s1", "mic", {
      at: 20,
      reason: "device-change",
    });
    assert.equal(interrupted.status, "degraded");
    assert.equal(repository.sessions.get("s1").status, "recording");

    const paused = service.pauseCapture("s1", 30);
    assert.equal(paused.status, "paused");
    assert.equal(repository.sessions.get("s1").status, "paused");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("source interruption persists its track gap and session status in one repository call", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interrupt-atomic-status-"));
  const repository = createRepository();
  const originalSetSessionStatus = repository.setSessionStatus;
  repository.setSessionStatus = () => {
    throw new Error("separate session status write is forbidden");
  };
  const originalInterruptTrack = repository.interruptTrack;
  repository.interruptTrack = function (input) {
    assert.equal(input.sessionId, "s1");
    assert.equal(input.sessionStatus, "recording");
    const session = this.sessions.get(input.sessionId);
    const originalStatus = session.status;
    try {
      this.setSessionStatus = createRepository().setSessionStatus;
      return originalInterruptTrack.call(this, input);
    } finally {
      session.status = input.sessionStatus ?? originalStatus;
      this.setSessionStatus = () => {
        throw new Error("separate session status write is forbidden");
      };
    }
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [dualSources()[0]],
    });
    const interrupted = service.sourceInterrupted("s1", "mic", {
      at: 20,
      reason: "device-change",
    });

    assert.equal(interrupted.status, "degraded");
    assert.equal(interrupted.sources.mic.state, "reconnecting");
  } finally {
    repository.setSessionStatus = originalSetSessionStatus;
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("restoration persistence failure removes the empty replacement and permits retry", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-restore-rollback-"));
  const repository = createRepository();
  const originalSetSessionStatus = repository.setSessionStatus;
  const restoreTrack = repository.restoreTrack;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.appendPcm("s1", "system", Buffer.alloc(48, 1));
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });
    repository.restoreTrack = () => {
      throw new Error("restore persistence failed");
    };

    assert.throws(
      () =>
        service.sourceRestored("s1", "system", {
          at: 30,
          deviceId: "output-2",
          deviceLabel: "New output",
          strategy: "wasapi-loopback",
        }),
      /restore persistence failed/
    );
    assert.equal(service.getState().sources.system.state, "reconnecting");
    assert.equal(repository.gaps[0].endedAt, null);

    repository.restoreTrack = restoreTrack;
    service.sourceRestored("s1", "system", {
      at: 40,
      deviceId: "output-2",
      deviceLabel: "New output",
      strategy: "wasapi-loopback",
    });
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 2)), true);
    service.finishCapture("s1", 50);
    assert.deepEqual(
      repository.chunks
        .filter((chunk) => chunk.sourceType === "system")
        .map((chunk) => chunk.sequenceNumber),
      [0, 1]
    );
  } finally {
    repository.setSessionStatus = originalSetSessionStatus;
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("source restoration persists its track gap and session status in one repository call", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-restore-atomic-status-"));
  const repository = createRepository();
  const originalSetSessionStatus = repository.setSessionStatus;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [dualSources()[0]],
    });
    service.sourceInterrupted("s1", "mic", { at: 20, reason: "device-change" });

    const originalRestoreTrack = repository.restoreTrack;
    repository.restoreTrack = function (input) {
      assert.equal(input.sessionId, "s1");
      assert.equal(input.sessionStatus, "recording");
      const blockedSetSessionStatus = this.setSessionStatus;
      try {
        this.setSessionStatus = originalSetSessionStatus;
        return originalRestoreTrack.call(this, input);
      } finally {
        this.setSessionStatus = blockedSetSessionStatus;
      }
    };
    repository.setSessionStatus = () => {
      throw new Error("separate session status write is forbidden");
    };

    const restored = service.sourceRestored("s1", "mic", {
      at: 30,
      deviceId: "mv7-restored",
      deviceLabel: "MV7 restored",
      strategy: "web-audio",
    });
    assert.equal(restored.status, "recording");
    assert.equal(restored.sources.mic.state, "active");
  } finally {
    repository.setSessionStatus = originalSetSessionStatus;
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a restoration retry succeeds after its committed response broadcast fails", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-restore-retry-"));
  const repository = createRepository();
  let restoreCalls = 0;
  const restoreTrack = repository.restoreTrack;
  repository.restoreTrack = function (input) {
    restoreCalls += 1;
    return restoreTrack.call(this, input);
  };
  let broadcasts = 0;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {
      broadcasts += 1;
      if (broadcasts === 3) throw new Error("restoration response broadcast failed");
    },
    now: () => 30,
    fsImpl: createSafeFs(),
  });
  const restoration = {
    at: 30,
    deviceId: "mic-restored",
    deviceLabel: "Restored microphone",
    strategy: "web-audio",
  };

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [dualSources()[0]],
    });
    service.sourceInterrupted("s1", "mic", { at: 20, reason: "device-change" });

    assert.throws(
      () => service.sourceRestored("s1", "mic", restoration),
      /restoration response broadcast failed/
    );
    const retried = service.sourceRestored("s1", "mic", restoration);

    assert.equal(retried.status, "recording");
    assert.equal(retried.sources.mic.state, "active");
    assert.equal(restoreCalls, 1);
    assert.equal(repository.gaps.length, 1);
    assert.equal(repository.gaps[0].endedAt, 30);
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 2)), true);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a stale restoration retry cannot close a newer interruption gap", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stale-restore-retry-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 50,
    fsImpl: createSafeFs(),
  });
  const firstRestoration = {
    at: 30,
    deviceId: "mic-restored",
    deviceLabel: "Restored microphone",
    strategy: "web-audio",
  };

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "mic",
      sources: [dualSources()[0]],
    });
    service.sourceInterrupted("s1", "mic", { at: 20, reason: "device-change" });
    service.sourceRestored("s1", "mic", firstRestoration);
    service.sourceInterrupted("s1", "mic", { at: 40, reason: "device-change" });

    assert.throws(
      () => service.sourceRestored("s1", "mic", firstRestoration),
      /before the current interruption/i
    );
    assert.equal(service.getState().sources.mic.state, "reconnecting");
    assert.equal(repository.gaps[1].endedAt, null);

    const restored = service.sourceRestored("s1", "mic", {
      ...firstRestoration,
      at: 50,
    });
    assert.equal(restored.sources.mic.state, "active");
    assert.equal(repository.gaps[1].endedAt, 50);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("start track persistence failure leaves no active public session or tracks", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-start-rollback-"));
  const repository = createRepository();
  repository.createTracks = () => {
    throw new Error("track batch failed");
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 10,
    fsImpl: createSafeFs(),
  });

  try {
    assert.throws(
      () =>
        service.startCapture({
          sessionId: "s1",
          startedAt: 10,
          captureMode: "dual",
          sources: dualSources(),
        }),
      /track batch failed/
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "CAPTURE_START_FAILED");
    assert.equal(
      Object.values(service.getState().sources).every((source) => source.state === "failed"),
      true
    );
    assert.equal(repository.sessions.get("s1").status, "failed");
    assert.equal(repository.tracks.length, 0);
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48)), false);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("duplicate interruption persists exactly one gap transition", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interrupt-idempotent-"));
  const repository = createRepository();
  const interruptTrack = repository.interruptTrack;
  let transitions = 0;
  repository.interruptTrack = function (input) {
    transitions += 1;
    return interruptTrack.call(this, input);
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });
    const duplicate = service.sourceInterrupted("s1", "system", {
      at: 20,
      reason: "device-change",
    });

    assert.equal(duplicate.status, "degraded");
    assert.equal(transitions, 1);
    assert.equal(repository.gaps.length, 1);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

function injectFinalizationFailure(repository, error) {
  repository.finalizeCapture = () => {
    throw error;
  };
}

test("finish persistence failure exposes failed public state and the original error", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-finish-persist-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("terminal transaction failed");
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    injectFinalizationFailure(repository, persistenceError);

    assert.throws(
      () => service.finishCapture("s1", 20),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "CAPTURE_FINALIZATION_FAILED");
    assert.equal(service.getState().sources.mic.state, "failed");
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(48)), false);
    assert.doesNotThrow(() => service.shutdown());
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("error finalization failure closes public state and preserves the persistence error", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fail-persist-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("failed-session transaction failed");
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 30,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });
    injectFinalizationFailure(repository, persistenceError);

    assert.throws(
      () => service.failCapture("s1", "CAPTURE_FAILED", 30),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "CAPTURE_FAILED");
    assert.equal(
      Object.values(service.getState().sources).every((source) => source.state === "failed"),
      true
    );
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48)), false);
    assert.doesNotThrow(() => service.shutdown());
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("pause close-error finalization failure cannot leave a recording state without a writer", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pause-persist-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("audio failure transaction failed");
  repository.commitChunk = () => {
    throw new Error("metadata unavailable");
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    service.appendMicPcm("s1", Buffer.alloc(48, 1));
    injectFinalizationFailure(repository, persistenceError);

    assert.throws(
      () => service.pauseCapture("s1", 20),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "AUDIO_WRITE_FAILED");
    assert.equal(service.getState().sources.mic.state, "failed");
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(48, 2)), false);
    assert.doesNotThrow(() => service.shutdown());
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("shutdown finalization failure is observable, honest, and idempotent", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-shutdown-persist-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("shutdown transaction failed");
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    injectFinalizationFailure(repository, persistenceError);

    assert.throws(
      () => service.shutdown(),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "CAPTURE_FINALIZATION_FAILED");
    assert.equal(service.getState().sources.mic.state, "failed");
    assert.doesNotThrow(() => service.shutdown());
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("disk failure while interrupting safe-stops with a recoverable open gap", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interrupt-disk-real-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({
    id: "s1",
    startedAt: 10,
    micDeviceId: "mv7",
    captureMode: "dual",
  });
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: ++diskChecks === 1 ? 20 * 1024 ** 3 : 1024 ** 3,
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl,
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.appendPcm("s1", "system", Buffer.alloc(48, 1));

    const state = service.sourceInterrupted("s1", "system", {
      at: 20,
      reason: "device-change",
    });

    assert.equal(state.status, "paused");
    assert.equal(state.errorCode, "capture_stopped_low_disk");
    assert.equal(repository.getSession("s1").status, "paused");
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get()
        .count,
      1
    );
    assert.deepEqual(
      repository.db.prepare("SELECT DISTINCT state FROM audio_tracks ORDER BY state").all(),
      [{ state: "paused" }, { state: "recovering" }]
    );
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("pause persistence failure leaves every writer and public source active", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pause-atomic-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("pause transaction failed");
  repository.pauseCapture = () => {
    throw persistenceError;
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });

    assert.throws(
      () => service.pauseCapture("s1", 20),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "recording");
    assert.equal(service.getState().sources.mic.state, "active");
    assert.equal(service.getState().sources.system.state, "active");
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 1)), true);
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 2)), true);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("pause close failure happens after durable pause and finalizes failed", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pause-close-order-"));
  const repository = createRepository();
  const pauseCapture = repository.pauseCapture;
  let pauseTransactions = 0;
  repository.pauseCapture = function (input) {
    pauseTransactions += 1;
    return pauseCapture.call(this, input);
  };
  repository.commitChunk = () => {
    throw new Error("metadata unavailable");
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    service.appendMicPcm("s1", Buffer.alloc(48, 1));

    const state = service.pauseCapture("s1", 20);

    assert.equal(pauseTransactions, 1);
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "AUDIO_WRITE_FAILED");
    assert.equal(state.sources.mic.state, "failed");
    assert.equal(repository.sessions.get("s1").status, "failed");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resume persistence failure removes replacements and retry preserves sequence", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-resume-atomic-fault-"));
  const repository = createRepository();
  const resumeCapture = repository.resumeCapture;
  let resumeAttempts = 0;
  repository.resumeCapture = function (input) {
    resumeAttempts += 1;
    if (resumeAttempts === 1) throw new Error("resume transaction failed");
    return resumeCapture.call(this, input);
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 40,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    service.appendMicPcm("s1", Buffer.alloc(48, 1));
    service.pauseCapture("s1", 20);

    assert.throws(() => service.resumeCapture("s1", 30), /resume transaction failed/);
    assert.equal(service.getState().status, "paused");
    assert.equal(service.getState().sources.mic.state, "paused");
    assert.equal(repository.sessions.get("s1").status, "paused");
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(48, 2)), false);

    assert.equal(service.resumeCapture("s1", 40).status, "recording");
    assert.equal(service.appendMicPcm("s1", Buffer.alloc(48, 3)), true);
    service.finishCapture("s1", 50);
    assert.deepEqual(
      repository.chunks.map((chunk) => chunk.sequenceNumber),
      [0, 1]
    );
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("degraded dual pause and resume retain the recovering lane and gap", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-degraded-pause-"));
  const repository = createRepository();
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 40,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });

    const paused = service.pauseCapture("s1", 30);
    assert.equal(paused.status, "paused");
    assert.equal(paused.sources.mic.state, "paused");
    assert.equal(paused.sources.system.state, "reconnecting");
    assert.equal(repository.tracks.find((track) => track.sourceType === "mic").state, "paused");
    assert.equal(
      repository.tracks.find((track) => track.sourceType === "system").state,
      "recovering"
    );
    assert.equal(repository.gaps[0].endedAt, null);

    const resumed = service.resumeCapture("s1", 40);
    assert.equal(resumed.status, "degraded");
    assert.equal(resumed.sources.mic.state, "active");
    assert.equal(resumed.sources.system.state, "reconnecting");
    assert.equal(repository.sessions.get("s1").status, "recording");
    assert.equal(repository.gaps[0].endedAt, null);
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 1)), true);
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 2)), false);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resume rejects while all sources are automatically recovering without side effects", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-all-recovering-resume-"));
  const repository = createRepository();
  let resumeCalls = 0;
  const resumeCapture = repository.resumeCapture;
  repository.resumeCapture = function (input) {
    resumeCalls += 1;
    return resumeCapture.call(this, input);
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 50,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.sourceInterrupted("s1", "mic", { at: 20, reason: "device-change" });
    service.sourceInterrupted("s1", "system", { at: 30, reason: "device-change" });
    let reopenCalls = 0;
    const reopenSource = service.writer.reopenSource;
    service.writer.reopenSource = function (...args) {
      reopenCalls += 1;
      return reopenSource.apply(this, args);
    };

    assert.throws(() => service.resumeCapture("s1", 40), /capture session must be paused/i);
    assert.throws(() => service.resumeCapture("s1", 50), /capture session must be paused/i);
    assert.equal(resumeCalls, 0);
    assert.equal(reopenCalls, 0);
    assert.equal(repository.sessions.get("s1").status, "recording");
    assert.deepEqual(
      repository.tracks.map((track) => track.state),
      ["recovering", "recovering"]
    );
    assert.deepEqual(
      repository.gaps.map((gap) => gap.endedAt),
      [null, null]
    );
    const state = service.getState();
    assert.equal(state.status, "degraded");
    assert.equal(state.sources.mic.state, "reconnecting");
    assert.equal(state.sources.system.state, "reconnecting");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("manual pause restoration waits for explicit resume and preserves both sequences", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-manual-pause-restore-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({
    id: "s1",
    startedAt: 10,
    micDeviceId: "mv7",
    captureMode: "dual",
  });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 60,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({
      sessionId: "s1",
      startedAt: 10,
      captureMode: "dual",
      sources: dualSources(),
    });
    service.appendPcm("s1", "mic", Buffer.alloc(48, 1));
    service.appendPcm("s1", "system", Buffer.alloc(48, 2));
    service.sourceInterrupted("s1", "system", { at: 20, reason: "device-change" });
    service.pauseCapture("s1", 30);
    let reopenCalls = 0;
    const reopenSource = service.writer.reopenSource;
    service.writer.reopenSource = function (...args) {
      reopenCalls += 1;
      return reopenSource.apply(this, args);
    };

    const restored = service.sourceRestored("s1", "system", {
      at: 40,
      deviceId: "output-2",
      deviceLabel: "New output",
      strategy: "wasapi-loopback",
    });
    assert.equal(restored.status, "paused");
    assert.equal(restored.sources.mic.state, "paused");
    assert.equal(restored.sources.system.state, "paused");
    assert.equal(restored.sources.system.gapId, null);
    assert.equal(reopenCalls, 0);
    assert.equal(service.writer.writers.has("system"), false);
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 3)), false);
    assert.equal(repository.getSession("s1").status, "paused");
    assert.deepEqual(
      repository.db
        .prepare("SELECT source_type, state, ended_at FROM audio_tracks ORDER BY source_type")
        .all(),
      [
        { source_type: "mic", state: "paused", ended_at: 30 },
        { source_type: "system", state: "paused", ended_at: 40 },
      ]
    );
    assert.equal(
      repository.db.prepare("SELECT ended_at FROM audio_gaps WHERE reason = 'device-change'").get()
        .ended_at,
      40
    );

    const resumed = service.resumeCapture("s1", 50);
    assert.equal(resumed.status, "recording");
    assert.equal(resumed.sources.mic.state, "active");
    assert.equal(resumed.sources.system.state, "active");
    assert.equal(reopenCalls, 2);
    assert.equal(repository.getSession("s1").status, "recording");
    assert.deepEqual(
      repository.db
        .prepare("SELECT source_type, state, ended_at FROM audio_tracks ORDER BY source_type")
        .all(),
      [
        { source_type: "mic", state: "active", ended_at: null },
        { source_type: "system", state: "active", ended_at: null },
      ]
    );
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 4)), true);
    assert.equal(service.appendPcm("s1", "system", Buffer.alloc(48, 5)), true);
    service.finishCapture("s1", 60);
    assert.deepEqual(
      repository.db
        .prepare(
          "SELECT source_type, sequence_number FROM audio_chunks ORDER BY source_type, sequence_number"
        )
        .all(),
      [
        { source_type: "mic", sequence_number: 0 },
        { source_type: "mic", sequence_number: 1 },
        { source_type: "system", sequence_number: 0 },
        { source_type: "system", sequence_number: 1 },
      ]
    );
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("finalization persistence error survives a throwing failure broadcast", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-finalize-broadcast-fault-"));
  const repository = createRepository();
  const persistenceError = new Error("terminal transaction failed");
  repository.finalizeCapture = () => {
    throw persistenceError;
  };
  let broadcasts = 0;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {
      broadcasts += 1;
      if (broadcasts > 1) throw new Error("broadcast failed");
    },
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    assert.throws(
      () => service.finishCapture("s1", 20),
      (error) => error === persistenceError
    );
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "CAPTURE_FINALIZATION_FAILED");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("normal real-repository finish remains a forward terminal transition", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-finish-real-forward-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 10, micDeviceId: "mic-1" });
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => 20,
    fsImpl: createSafeFs(),
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 10, micDeviceId: "mic-1" });
    const state = service.finishCapture("s1", 20);
    assert.equal(state.status, "completed");
    assert.equal(repository.getSession("s1").status, "completed");
    assert.deepEqual(repository.db.prepare("SELECT state, ended_at FROM audio_tracks").get(), {
      state: "ended",
      ended_at: 20,
    });
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
