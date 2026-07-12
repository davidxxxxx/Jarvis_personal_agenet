const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AudioChunkWriter = require("../../src/jarvis/main/AudioChunkWriter");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wav-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("rotates exact 24 kHz mono s16le WAV files atomically and preserves leftovers", () => {
  withTempDir((dir) => {
    const completed = [];
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      trackId: "tm",
      sourceType: "mic",
      baseDir: dir,
      sampleRate: 24000,
      chunkSeconds: 0.1,
      now: () => 1000,
      startedAt: 900,
      onChunk: (chunk) => {
        const recoveryPath = `${chunk.path}.recovery.json`;
        assert.equal(fs.existsSync(chunk.path), true);
        assert.equal(fs.existsSync(recoveryPath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(recoveryPath, "utf8")), chunk);
        assert.equal(
          fs.readdirSync(dir).some((name) => name.endsWith(".tmp")),
          false
        );
        completed.push(chunk);
      },
    });
    writer.append(Buffer.alloc(24000 * 2 * 0.15, 1));
    writer.close(1200);

    assert.equal(completed.length, 2);
    assert.deepEqual(
      completed.map((chunk) => chunk.durationMs),
      [100, 50]
    );
    assert.deepEqual(
      completed.map((chunk) => fs.statSync(chunk.path).size),
      [44 + 4800, 44 + 2400]
    );

    for (const chunk of completed) {
      const wav = fs.readFileSync(chunk.path);
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.toString("ascii", 8, 12), "WAVE");
      assert.equal(wav.readUInt16LE(20), 1);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 24000);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
      assert.equal(
        chunk.sha256,
        crypto.createHash("sha256").update(wav.subarray(44)).digest("hex")
      );
      assert.equal(chunk.sessionId, "s1");
      assert.equal(chunk.trackId, "tm");
      assert.equal(chunk.sourceType, "mic");
      assert.equal(chunk.durationMs, chunk.endedAt - chunk.startedAt);
    }

    assert.deepEqual(
      completed.map(({ sequenceNumber, startedAt, endedAt }) => ({
        sequenceNumber,
        startedAt,
        endedAt,
      })),
      [
        { sequenceNumber: 0, startedAt: 900, endedAt: 1000 },
        { sequenceNumber: 1, startedAt: 1000, endedAt: 1050 },
      ]
    );
    assert.equal(
      fs.readdirSync(dir).some((name) => name.endsWith(".tmp") || name.endsWith(".part")),
      false
    );
    assert.equal(
      fs.readdirSync(dir).some((name) => name.endsWith(".recovery.json")),
      false
    );
  });
});

test("does not advertise a chunk when the atomic rename fails", (t) => {
  withTempDir((dir) => {
    const completed = [];
    const realRenameSync = fs.renameSync;
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      baseDir: dir,
      chunkSeconds: 0.001,
      onChunk: (chunk) => completed.push(chunk),
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to.endsWith(".wav")) throw new Error("rename failed");
      return realRenameSync(from, to);
    });

    assert.throws(
      () => writer.append(Buffer.alloc(48, 1)),
      (error) => {
        assert.match(error.message, /rename failed/);
        assert.equal(error.evidenceEndedAt, undefined);
        return true;
      }
    );
    assert.deepEqual(completed, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("fsyncs before hashing PCM, renaming, and advertising the chunk", (t) => {
  withTempDir((dir) => {
    const events = [];
    const realFsyncSync = fs.fsyncSync;
    const realRenameSync = fs.renameSync;
    const realCreateHash = crypto.createHash;
    t.mock.method(fs, "fsyncSync", (fd) => {
      const result = realFsyncSync(fd);
      events.push("fsync");
      return result;
    });
    t.mock.method(crypto, "createHash", (...args) => {
      events.push("hash");
      return realCreateHash(...args);
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      events.push(to.endsWith(".recovery.json") ? "rename recovery" : "rename wav");
      return realRenameSync(from, to);
    });
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      baseDir: dir,
      chunkSeconds: 0.001,
      onChunk() {
        events.push("callback");
      },
    });

    writer.append(Buffer.alloc(48, 1));

    assert.deepEqual(events, [
      "fsync",
      "hash",
      "fsync",
      "rename recovery",
      "rename wav",
      "callback",
    ]);
  });
});

test("retains deterministic recovery metadata and a sticky fault when the callback throws", () => {
  withTempDir((dir) => {
    const callbackError = new Error("commit failed");
    let attemptedChunk;
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      trackId: "tm",
      sourceType: "mic",
      baseDir: dir,
      chunkSeconds: 0.002,
      startedAt: 100,
      onChunk(chunk) {
        attemptedChunk = chunk;
        throw callbackError;
      },
    });

    let fault;
    assert.throws(
      () => writer.append(Buffer.alloc(96, 1)),
      (error) => {
        fault = error;
        assert.match(error.message, /audio chunk metadata commit failed/);
        return true;
      }
    );
    assert.equal(fault.cause, callbackError);
    assert.equal(fault.evidenceEndedAt, 102);
    const recoveryDir = path.join(dir, "recovery");
    assert.equal(path.dirname(attemptedChunk.path), recoveryDir);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${attemptedChunk.path}.recovery.json`, "utf8")), {
      id: attemptedChunk.id,
      sessionId: "s1",
      trackId: "tm",
      sourceType: "mic",
      sequenceNumber: 0,
      path: attemptedChunk.path,
      startedAt: 100,
      endedAt: 102,
      durationMs: 2,
      sha256: attemptedChunk.sha256,
    });
    assert.equal(fs.existsSync(attemptedChunk.path), true);
    assert.equal(writer.sequenceNumber, 1);
    assert.equal(writer.startedAt, 102);

    assert.throws(
      () => writer.append(Buffer.alloc(48, 2)),
      (error) => error === fault
    );
    assert.throws(
      () => writer.close(500),
      (error) => error === fault
    );
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".wav")).length, 0);
    assert.equal(fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".wav")).length, 1);
    assert.equal(
      fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".recovery.json")).length,
      1
    );
  });
});

test("marks the durable end when recovery cleanup fails after the chunk callback", (t) => {
  withTempDir((dir) => {
    const realUnlinkSync = fs.unlinkSync;
    let attemptedChunk;
    t.mock.method(fs, "unlinkSync", (target) => {
      if (String(target).endsWith(".recovery.json")) throw new Error("cleanup failed");
      return realUnlinkSync(target);
    });
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      trackId: "tm",
      sourceType: "mic",
      baseDir: dir,
      chunkSeconds: 0.002,
      startedAt: 100,
      onChunk(chunk) {
        attemptedChunk = chunk;
      },
    });

    assert.throws(
      () => writer.append(Buffer.alloc(96, 1)),
      (error) => {
        assert.match(error.message, /audio chunk recovery cleanup failed/);
        assert.equal(error.evidenceEndedAt, 102);
        return true;
      }
    );
    assert.equal(fs.existsSync(attemptedChunk.path), true);
  });
});

test("close never emits an empty chunk", () => {
  withTempDir((dir) => {
    const completed = [];
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      baseDir: dir,
      now: () => 1000,
      onChunk: (chunk) => completed.push(chunk),
    });

    writer.close(1000);

    assert.deepEqual(completed, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("writer rejects non-24 kHz input, chunks over 60 seconds, and odd PCM bytes", () => {
  withTempDir((dir) => {
    const options = { sessionId: "s1", baseDir: dir, onChunk() {} };
    assert.throws(() => new AudioChunkWriter({ ...options, sampleRate: 16000 }), /24000/);
    assert.throws(() => new AudioChunkWriter({ ...options, chunkSeconds: 61 }), /60/);

    const writer = new AudioChunkWriter(options);
    assert.throws(() => writer.append(Buffer.alloc(3)), /16-bit/);
    writer.close();
  });
});
