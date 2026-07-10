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
  const service = new JarvisService({ repository, userDataDir, broadcast() {}, now: () => 1000 });

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
