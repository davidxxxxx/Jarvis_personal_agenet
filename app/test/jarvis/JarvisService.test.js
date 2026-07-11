const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

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
  return {
    sessions,
    chunks,
    tracks,
    gaps,
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
    setTrackState(id, state, endedAt = null) {
      const track = tracks.find((entry) => entry.id === id);
      if (track) Object.assign(track, { state, endedAt });
      return track;
    },
    openGap(gap) {
      gaps.push({ ...gap, endedAt: null });
      return gap;
    },
    closeGap(id, endedAt, recoveryAttempts = null) {
      const gap = gaps.find((entry) => entry.id === id);
      if (gap) Object.assign(gap, { endedAt, recoveryAttempts });
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
    assert.equal(checkedPaths.every((checkedPath) => checkedPath === recordingsDir), true);
    assert.equal(repository.chunks.length, 1);
    assert.equal(repository.chunks[0].path.startsWith(recordingsDir), true);
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(recordingsDir, { recursive: true, force: true });
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
      "elapsedMs",
      "errorCode",
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

test("checks disk again at each rotation and fails without a corrupt partial chunk", () => {
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
    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "DISK_SPACE_LOW");
    assert.equal(repository.chunks.length, 1);
    const sessionDir = path.join(userDataDir, "recordings", "s1", "mic");
    assert.equal(fs.readdirSync(sessionDir).some((name) => name.endsWith(".part")), false);
    assert.equal(fs.readdirSync(sessionDir).filter((name) => name.endsWith(".wav")).length, 1);
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
    assert.throws(
      () => service.resumeCapture("s1", 1_100),
      /shutting down/
    );
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
  repository.createSession({ id: "s1", startedAt: 10, micDeviceId: "mv7" });
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
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM audio_gaps").get().count,
      1
    );
    assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48, 1)), true);
    service.finishCapture("s1", 30);
    assert.deepEqual(
      repository.db
        .prepare("SELECT source_type, sequence_number FROM audio_chunks")
        .all(),
      [{ source_type: "mic", sequence_number: 0 }]
    );
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM processing_jobs").get().count,
      1
    );
  } finally {
    service.shutdown();
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
