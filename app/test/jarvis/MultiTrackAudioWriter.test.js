const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const MultiTrackAudioWriter = require("../../src/jarvis/main/MultiTrackAudioWriter");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-multitrack-wav-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("writes mic and system chunks independently", () => {
  withTempDir((baseDir) => {
    const chunks = [];
    const writer = new MultiTrackAudioWriter({
      sessionId: "s1",
      baseDir,
      now: () => 1000,
      tracks: {
        mic: { id: "tm", startedAt: 10 },
        system: { id: "ts", startedAt: 20 },
      },
      onChunk: (chunk) => chunks.push(chunk),
    });
    writer.append("mic", Buffer.alloc(24000 * 2, 1));
    writer.append("system", Buffer.alloc(24000 * 2, 2));
    writer.closeAll(2000);

    assert.deepEqual(
      chunks.map(({ trackId, sourceType, sequenceNumber, startedAt, endedAt, durationMs }) => ({
        trackId,
        sourceType,
        sequenceNumber,
        startedAt,
        endedAt,
        durationMs,
      })),
      [
        {
          trackId: "tm",
          sourceType: "mic",
          sequenceNumber: 0,
          startedAt: 10,
          endedAt: 1010,
          durationMs: 1000,
        },
        {
          trackId: "ts",
          sourceType: "system",
          sequenceNumber: 0,
          startedAt: 20,
          endedAt: 1020,
          durationMs: 1000,
        },
      ]
    );
    assert.notEqual(chunks[0].path, chunks[1].path);
    assert.equal(path.dirname(chunks[0].path), path.join(baseDir, "mic"));
    assert.equal(path.dirname(chunks[1].path), path.join(baseDir, "system"));

    const micPcm = fs.readFileSync(chunks[0].path).subarray(44);
    const systemPcm = fs.readFileSync(chunks[1].path).subarray(44);
    assert.equal(micPcm.every((byte) => byte === 1), true);
    assert.equal(systemPcm.every((byte) => byte === 2), true);
    assert.equal(chunks[0].sha256, crypto.createHash("sha256").update(micPcm).digest("hex"));
    assert.equal(chunks[1].sha256, crypto.createHash("sha256").update(systemPcm).digest("hex"));
  });
});

test("rejects appends for inactive sources", () => {
  withTempDir((baseDir) => {
    const writer = new MultiTrackAudioWriter({
      sessionId: "s1",
      baseDir,
      tracks: { mic: { id: "tm", startedAt: 10 } },
      onChunk() {},
    });

    assert.throws(() => writer.append("system", Buffer.alloc(2)), /inactive audio source: system/);
    writer.abortAll();
  });
});

test("closeAll flushes every source and aggregates source-aware failures", () => {
  withTempDir((baseDir) => {
    const completed = [];
    const writer = new MultiTrackAudioWriter({
      sessionId: "s1",
      baseDir,
      tracks: {
        mic: { id: "tm", startedAt: 10 },
        system: { id: "ts", startedAt: 20 },
      },
      onChunk(chunk) {
        if (chunk.sourceType === "mic") throw new Error("mic commit failed");
        completed.push(chunk);
      },
    });
    writer.append("mic", Buffer.alloc(48, 1));
    writer.append("system", Buffer.alloc(48, 2));

    assert.throws(
      () => writer.closeAll(1000),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.message, /mic/);
        assert.equal(error.errors.length, 1);
        assert.match(error.errors[0].message, /mic/);
        assert.match(error.errors[0].cause.message, /audio chunk metadata commit failed/);
        assert.match(error.errors[0].cause.cause.message, /mic commit failed/);
        return true;
      }
    );
    assert.equal(completed.length, 1);
    assert.equal(completed[0].sourceType, "system");
    assert.equal(fs.readFileSync(completed[0].path).subarray(44).equals(Buffer.alloc(48, 2)), true);

    assert.doesNotThrow(() => writer.closeAll(1001));
    assert.equal(completed.length, 1);
    assert.equal(
      fs
        .readdirSync(path.join(baseDir, "mic", "recovery"))
        .filter((name) => name.endsWith(".recovery.json")).length,
      1
    );
    assert.equal(
      fs
        .readdirSync(path.join(baseDir, "system"))
        .filter((name) => name.endsWith(".recovery.json")).length,
      0
    );
  });
});

test("closeSource failure does not close another source", () => {
  withTempDir((baseDir) => {
    const completed = [];
    const writer = new MultiTrackAudioWriter({
      sessionId: "s1",
      baseDir,
      tracks: {
        mic: { id: "tm", startedAt: 10 },
        system: { id: "ts", startedAt: 20 },
      },
      onChunk(chunk) {
        if (chunk.sourceType === "mic") throw new Error("mic commit failed");
        completed.push(chunk);
      },
    });
    writer.append("mic", Buffer.alloc(48, 1));

    let fault;
    assert.throws(
      () => writer.closeSource("mic", 1000),
      (error) => {
        fault = error;
        assert.match(error.message, /audio chunk metadata commit failed/);
        return true;
      }
    );
    assert.match(fault.cause.message, /mic commit failed/);
    writer.append("system", Buffer.alloc(48, 2));
    writer.closeSource("system", 1001);
    assert.doesNotThrow(() => writer.closeSource("mic", 1002));

    assert.equal(completed.length, 1);
    assert.equal(completed[0].sourceType, "system");
  });
});

test("reopens one closed source without replacing a surviving writer", () => {
  withTempDir((baseDir) => {
    const completed = [];
    const writer = new MultiTrackAudioWriter({
      sessionId: "s1",
      baseDir,
      tracks: {
        mic: { id: "tm", startedAt: 10 },
        system: { id: "ts", startedAt: 20 },
      },
      onChunk: (chunk) => completed.push(chunk),
    });

    writer.append("system", Buffer.alloc(48, 1));
    writer.closeSource("system", 1000);
    writer.append("mic", Buffer.alloc(48, 2));
    writer.reopenSource("system", { id: "ts", startedAt: 1100 });
    writer.append("system", Buffer.alloc(48, 3));
    writer.closeAll(1200);

    assert.deepEqual(
      completed.map((chunk) => [chunk.sourceType, chunk.sequenceNumber]),
      [
        ["system", 0],
        ["mic", 0],
        ["system", 1],
      ]
    );
  });
});
