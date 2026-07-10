const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisService = require("../../src/jarvis/main/JarvisService");

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
  return {
    sessions,
    chunks,
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
      "elapsedMs",
      "errorCode",
      "sessionId",
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
    const sessionDir = path.join(userDataDir, "recordings", "s1");
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
