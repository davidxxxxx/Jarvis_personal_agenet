const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { SpeakerEmbeddings } = require("../../src/helpers/speakerEmbeddings");
const DiarizationManager = require("../../src/helpers/diarization");

function writeMonoPcm16Wav(filePath, sampleRate, samples) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const body = Buffer.alloc(dataBytes);
  samples.forEach((sample, index) => body.writeInt16LE(sample, index * 2));
  fs.writeFileSync(filePath, Buffer.concat([header, body]));
}

test("speaker extraction clears its private PCM clone after success and failure", async (t) => {
  for (const [name, fail] of [
    ["success", false],
    ["failure", true],
  ]) {
    await t.test(name, async () => {
      let captured = null;
      const helper = new SpeakerEmbeddings({
        workerClient: {
          async request(method, payload) {
            if (method === "speaker.load") return { ok: true };
            captured = payload.samplesBuffer;
            if (fail) throw new Error("extract failed");
            return { embeddingBuffer: new Float32Array(512).fill(1).buffer };
          },
        },
      });
      helper._ensureLoaded = async () => {};
      const source = new Float32Array(24_000).fill(0.25);

      if (fail) await assert.rejects(helper.extractEmbeddingFromSamples(source), /extract failed/);
      else await helper.extractEmbeddingFromSamples(source);

      assert.ok(captured instanceof ArrayBuffer);
      assert.equal(
        new Uint8Array(captured).every((value) => value === 0),
        true
      );
      assert.equal(source[0], 0.25);
    });
  }
});

test("speaker model artifact hash is the SHA-256 of the local model file and is cached", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, "campplus.onnx");
  const bytes = Buffer.from("local-campplus-artifact");
  fs.writeFileSync(modelPath, bytes);
  const helper = new SpeakerEmbeddings({
    workerClient: { request: async () => ({ ok: true }) },
  });
  helper.getModelPath = () => modelPath;

  const first = await helper.getModelArtifactSha256();
  fs.writeFileSync(modelPath, Buffer.from("changed-after-cached-read"));
  const cached = await helper.getModelArtifactSha256();

  assert.equal(first, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(cached, first);
});

test("speaker extraction cuts at the WAV rate then resamples 24 kHz PCM to real 16 kHz samples", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-resample-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wav24 = path.join(directory, "source-24k.wav");
  const wav16 = path.join(directory, "source-16k.wav");
  const source24 = Array.from({ length: 48_000 }, (_, index) => (index % 24_000) - 12_000);
  const source16 = Array.from({ length: 24_000 }, (_, index) => (index % 16_000) - 8_000);
  writeMonoPcm16Wav(wav24, 24_000, source24);
  writeMonoPcm16Wav(wav16, 16_000, source16);
  const captured = [];
  const privateBuffers = [];
  const helper = new SpeakerEmbeddings({
    workerClient: {
      async request(method, payload) {
        if (method === "speaker.load") return { ok: true };
        privateBuffers.push(payload.samplesBuffer);
        captured.push(Float32Array.from(new Float32Array(payload.samplesBuffer)));
        return { embeddingBuffer: new Float32Array(512).fill(1).buffer };
      },
    },
  });
  helper._ensureLoaded = async () => {};

  await helper.extractEmbedding(wav24, 0.25, 1.75);
  await helper.extractEmbedding(wav16, 0, 1.5);

  assert.equal(captured[0].length, 24_000);
  assert.ok(Math.abs(captured[0][0] - source24[6_000] / 32768) < 1e-6);
  const expectedLast24 = (source24[41_998] + source24[41_999]) / 2 / 32768;
  assert.ok(Math.abs(captured[0].at(-1) - expectedLast24) < 1e-6);
  assert.equal(captured[1].length, 24_000);
  assert.ok(Math.abs(captured[1][0] - source16[0] / 32768) < 1e-6);
  assert.ok(Math.abs(captured[1].at(-1) - source16.at(-1) / 32768) < 1e-6);
  assert.ok(privateBuffers.every((buffer) => new Uint8Array(buffer).every((byte) => byte === 0)));
});

test("speaker extraction clears original and resampled PCM on success and error", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-zeroize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wavPath = path.join(directory, "source.wav");
  writeMonoPcm16Wav(
    wavPath,
    24_000,
    Array.from({ length: 48_000 }, (_, index) => (index % 20_000) - 10_000)
  );

  for (const fail of [false, true]) {
    let originalPcm = null;
    let resampledPcm = null;
    const helper = new SpeakerEmbeddings({
      resampleImpl(samples, inputRate, outputRate) {
        originalPcm = samples;
        resampledPcm = SpeakerEmbeddings.resampleLinear(samples, inputRate, outputRate);
        return resampledPcm;
      },
      workerClient: {
        async request(method) {
          if (method === "speaker.load") return { ok: true };
          if (fail) throw new Error("inference failed");
          return { embeddingBuffer: new Float32Array(512).fill(1).buffer };
        },
      },
    });
    helper._ensureLoaded = async () => {};

    if (fail)
      await assert.rejects(helper.extractEmbedding(wavPath, 0.25, 1.75), /inference failed/);
    else await helper.extractEmbedding(wavPath, 0.25, 1.75);

    assert.ok(originalPcm instanceof Float32Array);
    assert.ok(resampledPcm instanceof Float32Array);
    assert.equal(
      originalPcm.every((sample) => sample === 0),
      true
    );
    assert.equal(
      resampledPcm.every((sample) => sample === 0),
      true
    );
  }
});

test("diarization artifact hash covers segmentation and embedding models and retries after failure", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const segmentationPath = path.join(directory, "segmentation.onnx");
  const embeddingPath = path.join(directory, "embedding.onnx");
  const segmentation = Buffer.from("segmentation-model");
  const embedding = Buffer.from("embedding-model");
  fs.writeFileSync(segmentationPath, segmentation);
  const manager = new DiarizationManager();
  manager.getModelArtifacts = () => [
    { id: "sherpa-pyannote-segmentation-3.0", path: segmentationPath },
    { id: "3dspeaker-campplus-voxceleb-16k-v1", path: embeddingPath },
  ];

  await assert.rejects(manager.getModelArtifactSha256(), /ENOENT/);
  fs.writeFileSync(embeddingPath, embedding);

  const expected = crypto
    .createHash("sha256")
    .update("sherpa-pyannote-segmentation-3.0\0")
    .update(segmentation)
    .update("\0")
    .update("3dspeaker-campplus-voxceleb-16k-v1\0")
    .update(embedding)
    .update("\0")
    .digest("hex");
  const first = await manager.getModelArtifactSha256();
  fs.writeFileSync(segmentationPath, Buffer.from("changed-after-cache"));
  const cached = await manager.getModelArtifactSha256();

  assert.equal(first, expected);
  assert.equal(cached, first);
});

function fakeSidecar({ stdout = "", stderr = "", code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    if (error) child.emit("error", error);
    else child.emit("close", code);
  });
  return child;
}

test("strict diarization distinguishes dependency and sidecar failures while legacy stays tolerant", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-strict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wavPath = path.join(directory, "input.wav");
  fs.writeFileSync(wavPath, Buffer.from("wav"));

  await t.test("missing binary", async () => {
    const manager = new DiarizationManager();
    manager.getBinaryPath = () => null;
    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_BINARY_UNAVAILABLE",
    });
    assert.deepEqual(await manager.diarize(wavPath), []);
  });

  await t.test("missing model", async () => {
    const manager = new DiarizationManager();
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => false;
    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_MODEL_UNAVAILABLE",
    });
  });

  for (const scenario of [
    {
      name: "spawn error",
      child: () => fakeSidecar({ error: new Error("spawn failed") }),
      code: "DIARIZATION_SIDECAR_SPAWN_FAILED",
    },
    {
      name: "nonzero exit",
      child: () => fakeSidecar({ stderr: "model rejected", code: 7 }),
      code: "DIARIZATION_SIDECAR_EXIT_NONZERO",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const manager = new DiarizationManager({ spawnImpl: scenario.child });
      manager.getBinaryPath = () => "diarizer";
      manager.isModelDownloaded = () => true;
      await assert.rejects(manager.diarizeStrict(wavPath), { code: scenario.code });
    });
  }

  await t.test("timeout", async () => {
    let timeoutCallback = null;
    const manager = new DiarizationManager({
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        return child;
      },
      setTimeoutImpl: (callback) => {
        timeoutCallback = callback;
        queueMicrotask(callback);
        return 1;
      },
      clearTimeoutImpl: () => {},
      gracefulStopProcessImpl: async () => {},
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;
    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_TIMEOUT",
    });
    assert.equal(typeof timeoutCallback, "function");
  });

  await t.test("legal empty output", async () => {
    const manager = new DiarizationManager({ spawnImpl: () => fakeSidecar() });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;
    assert.deepEqual(await manager.diarizeStrict(wavPath), []);
  });

  await t.test("malformed nonempty output", async () => {
    const manager = new DiarizationManager({
      spawnImpl: () => fakeSidecar({ stdout: "unexpected sidecar text\n" }),
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;
    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_INVALID_OUTPUT",
    });
  });
});
