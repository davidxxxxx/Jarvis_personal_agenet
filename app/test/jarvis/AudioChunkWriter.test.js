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
        assert.equal(fs.existsSync(chunk.path), true);
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
      assert.equal(chunk.sha256, crypto.createHash("sha256").update(wav.subarray(44)).digest("hex"));
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
  });
});

test("does not advertise a chunk when the atomic rename fails", (t) => {
  withTempDir((dir) => {
    const completed = [];
    const writer = new AudioChunkWriter({
      sessionId: "s1",
      baseDir: dir,
      chunkSeconds: 0.001,
      onChunk: (chunk) => completed.push(chunk),
    });
    t.mock.method(fs, "renameSync", () => {
      throw new Error("rename failed");
    });

    assert.throws(() => writer.append(Buffer.alloc(48, 1)), /rename failed/);
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
    t.mock.method(fs, "renameSync", (...args) => {
      events.push("rename");
      return realRenameSync(...args);
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

    assert.deepEqual(events, ["fsync", "hash", "rename", "callback"]);
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
