const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");

function insertChunk(repository, { id, filePath, expiresAt }) {
  repository.insertAudioChunk({
    id,
    sessionId: "s1",
    path: filePath,
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    sha256: id.padEnd(64, "a").slice(0, 64),
    expiresAt,
  });
}

test("deletes expired audio before its metadata and preserves future audio", () => {
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-retention-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  const expiredPath = path.join(recordingsRoot, "s1", "expired.wav");
  const futurePath = path.join(recordingsRoot, "s1", "future.wav");
  fs.mkdirSync(path.dirname(expiredPath), { recursive: true });
  fs.writeFileSync(expiredPath, "expired");
  fs.writeFileSync(futurePath, "future");
  insertChunk(repository, { id: "expired", filePath: expiredPath, expiresAt: 4_000 });
  insertChunk(repository, { id: "future", filePath: futurePath, expiresAt: 6_000 });

  try {
    const result = new RetentionCleaner({ repository, recordingsRoot }).clean(5_000);

    assert.deepEqual(result, { deleted: 1, retry: 0, missing: 0 });
    assert.equal(fs.existsSync(expiredPath), false);
    assert.equal(repository.listAudioChunks("s1").some((row) => row.id === "expired"), false);
    assert.equal(fs.existsSync(futurePath), true);
    assert.equal(repository.listAudioChunks("s1").some((row) => row.id === "future"), true);
  } finally {
    repository.close();
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
  }
});

test("keeps metadata when deleting an expired audio file fails", () => {
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-retention-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  const expiredPath = path.join(recordingsRoot, "s1", "retry.wav");
  fs.mkdirSync(path.dirname(expiredPath), { recursive: true });
  fs.writeFileSync(expiredPath, "retry");
  insertChunk(repository, { id: "retry", filePath: expiredPath, expiresAt: 4_000 });
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = () => {
    const error = new Error("locked");
    error.code = "EPERM";
    throw error;
  };

  try {
    const result = new RetentionCleaner({ repository, recordingsRoot, fsImpl }).clean(5_000);

    assert.deepEqual(result, { deleted: 0, retry: 1, missing: 0 });
    assert.equal(fs.existsSync(expiredPath), true);
    assert.equal(repository.listAudioChunks("s1")[0].id, "retry");
  } finally {
    repository.close();
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
  }
});

test("tolerates missing files but never deletes paths outside the recordings root", () => {
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-retention-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-outside-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  const missingPath = path.join(recordingsRoot, "s1", "missing.wav");
  const outsidePath = path.join(outsideRoot, "must-stay.wav");
  fs.writeFileSync(outsidePath, "outside");
  insertChunk(repository, { id: "missing", filePath: missingPath, expiresAt: 4_000 });
  insertChunk(repository, { id: "outside", filePath: outsidePath, expiresAt: 4_000 });

  try {
    const result = new RetentionCleaner({ repository, recordingsRoot }).clean(5_000);

    assert.deepEqual(result, { deleted: 0, retry: 1, missing: 1 });
    assert.equal(fs.existsSync(outsidePath), true);
    assert.deepEqual(
      repository.listAudioChunks("s1").map((row) => row.id),
      ["outside"]
    );
  } finally {
    repository.close();
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("refuses a junction that resolves outside the recordings root", (t) => {
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-retention-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-outside-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  const junctionPath = path.join(recordingsRoot, "junction");
  const outsidePath = path.join(outsideRoot, "must-stay.wav");
  fs.writeFileSync(outsidePath, "outside");
  try {
    fs.symlinkSync(outsideRoot, junctionPath, "junction");
  } catch (error) {
    repository.close();
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
    t.skip(`junction unavailable: ${error.code}`);
    return;
  }
  insertChunk(repository, {
    id: "junction",
    filePath: path.join(junctionPath, "must-stay.wav"),
    expiresAt: 4_000,
  });

  try {
    const result = new RetentionCleaner({ repository, recordingsRoot }).clean(5_000);

    assert.deepEqual(result, { deleted: 0, retry: 1, missing: 0 });
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(repository.listAudioChunks("s1")[0].id, "junction");
  } finally {
    repository.close();
    fs.rmSync(junctionPath, { force: true });
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
