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
