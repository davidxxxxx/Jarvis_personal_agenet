const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PreviewAudioRing = require("../../src/jarvis/main/PreviewAudioRing");

const BYTES_PER_MS = (24_000 * 2) / 1_000;

function pcm(durationMs, value) {
  return Buffer.alloc(durationMs * BYTES_PER_MS, value);
}

function wavPcm(filePath) {
  return fs.readFileSync(filePath).subarray(44);
}

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-ring-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, ring: new PreviewAudioRing({ rootDir }) };
}

test("emits 15-second watermarks and retains at most the newest 120 seconds per track", async (t) => {
  const { ring } = fixture(t);
  const watermarks = [];
  for (let second = 0; second < 121; second += 1) {
    watermarks.push(
      ...ring.append({
        sessionId: "s1",
        trackId: "track-mic",
        sourceType: "mic",
        fromMs: second * 1_000,
        throughMs: (second + 1) * 1_000,
        pcm: pcm(1_000, second),
      })
    );
  }

  assert.deepEqual(watermarks, [15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000]);
  await ring.withPreviewWav(
    { sessionId: "s1", trackId: "track-mic", fromMs: 1_000, throughMs: 121_000 },
    ({ path: previewPath, fromMs, throughMs }) => {
      assert.equal(fromMs, 1_000);
      assert.equal(throughMs, 121_000);
      assert.equal(wavPcm(previewPath).length, pcm(120_000, 0).length);
      assert.equal(wavPcm(previewPath)[0], 1);
    }
  );
});

test("zero-fills discontinuities and keeps microphone and system tracks isolated", async (t) => {
  const { ring } = fixture(t);
  ring.append({
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    fromMs: 0,
    throughMs: 1_000,
    pcm: pcm(1_000, 1),
  });
  ring.append({
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    fromMs: 2_000,
    throughMs: 3_000,
    pcm: pcm(1_000, 2),
  });
  ring.append({
    sessionId: "s1",
    trackId: "track-system",
    sourceType: "system",
    fromMs: 0,
    throughMs: 3_000,
    pcm: pcm(3_000, 9),
  });

  await ring.withPreviewWav(
    { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 3_000 },
    ({ path: previewPath, sourceType }) => {
      const output = wavPcm(previewPath);
      assert.equal(sourceType, "mic");
      assert.equal(output[0], 1);
      assert.equal(output[1_500 * BYTES_PER_MS], 0);
      assert.equal(output[2_500 * BYTES_PER_MS], 2);
    }
  );
  await ring.withPreviewWav(
    { sessionId: "s1", trackId: "track-system", fromMs: 0, throughMs: 3_000 },
    ({ path: previewPath, sourceType }) => {
      assert.equal(sourceType, "system");
      assert.equal(
        wavPcm(previewPath).every((value) => value === 9),
        true
      );
    }
  );
});

test("publishes only an atomically renamed preview WAV and removes it after failure", async (t) => {
  const { rootDir, ring } = fixture(t);
  ring.append({
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    fromMs: 0,
    throughMs: 1_000,
    pcm: pcm(1_000, 3),
  });

  await assert.rejects(
    ring.withPreviewWav(
      { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 1_000 },
      ({ path: previewPath }) => {
        assert.match(previewPath, /\.preview\.wav$/);
        assert.equal(fs.existsSync(previewPath), true);
        assert.deepEqual(
          fs.readdirSync(path.dirname(previewPath)).filter((name) => name.endsWith(".tmp")),
          []
        );
        throw new Error("transcriber failed");
      }
    ),
    /transcriber failed/
  );

  assert.deepEqual(
    fs.readdirSync(rootDir, { recursive: true }).filter((name) => /\.wav|\.tmp$/.test(name)),
    []
  );
});

test("clearSession drops buffered audio and validates bounded safe ranges", async (t) => {
  const { ring } = fixture(t);
  ring.append({
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    fromMs: 0,
    throughMs: 1_000,
    pcm: pcm(1_000, 4),
  });
  ring.clearSession("s1");

  assert.equal(
    await ring.withPreviewWav(
      { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 1_000 },
      () => assert.fail("cleared audio was exposed")
    ),
    null
  );
  assert.throws(
    () =>
      ring.append({
        sessionId: "s1",
        trackId: "track-mic",
        sourceType: "mic",
        fromMs: 2_000,
        throughMs: 1_000,
        pcm: Buffer.alloc(0),
      }),
    /range/
  );
  await assert.rejects(
    ring.withPreviewWav(
      { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 120_001 },
      () => {}
    ),
    /120000/
  );
});

test("startup and clearSession remove only bounded disposable preview artifacts", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-stale-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const directory = path.join(rootDir, "s1", "track-mic");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "old.preview.wav"), "stale");
  fs.writeFileSync(path.join(directory, "old.preview.wav.dead.tmp"), "stale");
  fs.writeFileSync(path.join(directory, "keep.txt"), "keep");

  const ring = new PreviewAudioRing({ rootDir });
  await ring.waitUntilReady();
  assert.deepEqual(fs.readdirSync(directory), ["keep.txt"]);

  fs.writeFileSync(path.join(directory, "late.preview.wav"), "stale");
  await ring.clearSession("s1");
  assert.equal(fs.existsSync(path.join(directory, "late.preview.wav")), false);
  assert.equal(fs.existsSync(path.join(directory, "keep.txt")), true);
});

test("preview WAV publication avoids synchronous main-thread file writes and fsync", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-async-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const fsImpl = Object.create(fs);
  fsImpl.mkdirSync = () => assert.fail("preview used synchronous mkdir");
  fsImpl.openSync = () => assert.fail("preview used synchronous open");
  fsImpl.writeFileSync = () => assert.fail("preview used synchronous write");
  fsImpl.fsyncSync = () => assert.fail("preview used synchronous fsync");
  fsImpl.renameSync = () => assert.fail("preview used synchronous rename");
  const ring = new PreviewAudioRing({ rootDir, fsImpl });
  ring.append({
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    fromMs: 0,
    throughMs: 1_000,
    pcm: pcm(1_000, 5),
  });

  await ring.withPreviewWav(
    { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 1_000 },
    ({ path: previewPath }) => assert.equal(fs.existsSync(previewPath), true)
  );
});
