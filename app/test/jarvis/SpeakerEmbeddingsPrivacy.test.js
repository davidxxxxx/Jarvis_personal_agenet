const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  SpeakerEmbeddings,
  decodeEmbeddingBuffer,
} = require("../../src/helpers/speakerEmbeddings");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");
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

test("speaker extraction decodes cloned binary views as float bytes", () => {
  const expected = new Float32Array(512);
  for (let index = 0; index < expected.length; index += 1) expected[index] = index / 17 - 3;
  const bytes = Buffer.from(expected.buffer.slice(0));
  const sliced = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.deepEqual(decodeEmbeddingBuffer(bytes), expected);
  assert.deepEqual(decodeEmbeddingBuffer(sliced), expected);
  assert.deepEqual(decodeEmbeddingBuffer(expected.buffer.slice(0)), expected);
  assert.equal(decodeEmbeddingBuffer(Buffer.alloc(3)), null);
});

test("speaker extraction prefers a structured 512-value response and rejects unknown payloads", async () => {
  const expected = new Float32Array(512).fill(0.25);
  const helper = new SpeakerEmbeddings({
    workerClient: {
      async request() {
        return { embedding: Array.from(expected) };
      },
    },
  });
  helper._ensureLoaded = async () => {};

  assert.deepEqual(await helper.extractEmbeddingFromSamples(new Float32Array(24_000)), expected);

  helper.workerClient = { request: async () => ({ embedding: { invalid: true } }) };
  await assert.rejects(
    helper.extractEmbeddingFromSamples(new Float32Array(24_000)),
    { code: "SPEAKER_EMBEDDING_PAYLOAD_INVALID" }
  );
});

test("speaker extraction keeps Chinese CAM++ and ERes2NetV2 worker sessions isolated", async () => {
  const calls = [];
  const primaryModel = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const reviewModel = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  const workerClient = {
    async request(method, payload) {
      calls.push({ method, payload: { ...payload, samplesBuffer: undefined } });
      if (method === "speaker.load") return { ok: true };
      const dimension =
        payload.modelKey === SPEAKER_MODEL_KEYS.PRIMARY
          ? primaryModel.embeddingDimension
          : reviewModel.embeddingDimension;
      return { embedding: new Array(dimension).fill(0.25) };
    },
  };
  const primary = new SpeakerEmbeddings({
    modelKey: SPEAKER_MODEL_KEYS.PRIMARY,
    workerClient,
  });
  const review = new SpeakerEmbeddings({
    modelKey: SPEAKER_MODEL_KEYS.REVIEW,
    workerClient,
  });
  primary.isAvailable = () => true;
  review.isAvailable = () => true;
  primary.getModelPath = () => String.raw`G:\JarvisData\models\speaker-models\campplus.onnx`;
  review.getModelPath = () => String.raw`G:\JarvisData\models\speaker-models\eres2netv2.onnx`;

  const primaryEmbedding = await primary.extractEmbeddingFromSamples(new Float32Array(24_000));
  const reviewEmbedding = await review.extractEmbeddingFromSamples(new Float32Array(24_000));

  assert.equal(primaryEmbedding.length, 192);
  assert.equal(reviewEmbedding.length, 192);
  assert.deepEqual(
    calls.map(({ method, payload }) => [method, payload.modelKey]),
    [
      ["speaker.load", SPEAKER_MODEL_KEYS.PRIMARY],
      ["speaker.extract", SPEAKER_MODEL_KEYS.PRIMARY],
      ["speaker.load", SPEAKER_MODEL_KEYS.REVIEW],
      ["speaker.extract", SPEAKER_MODEL_KEYS.REVIEW],
    ]
  );
});

test("speaker extraction rejects a worker vector from the wrong model dimension", async () => {
  const helper = new SpeakerEmbeddings({
    modelKey: SPEAKER_MODEL_KEYS.PRIMARY,
    workerClient: {
      async request(method) {
        if (method === "speaker.load") return { ok: true };
        return { embedding: new Array(512).fill(0.25) };
      },
    },
  });
  helper.isAvailable = () => true;
  helper.getModelPath = () => String.raw`G:\JarvisData\models\speaker-models\campplus.onnx`;

  await assert.rejects(
    helper.extractEmbeddingFromSamples(new Float32Array(24_000)),
    (error) => error.code === "SPEAKER_EMBEDDING_DIMENSION_MISMATCH"
  );
});

test("speaker extraction admits an exact 1500 ms window despite floating-point subtraction", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-ms-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wavPath = path.join(directory, "source.wav");
  writeMonoPcm16Wav(wavPath, 16_000, Array.from({ length: 48_000 }, () => 1_000));
  let extracted = false;
  const helper = new SpeakerEmbeddings({
    workerClient: {
      async request() {
        extracted = true;
        return { embedding: new Array(512).fill(0.25) };
      },
    },
  });
  helper._ensureLoaded = async () => {};

  assert.ok(2.002 - 0.502 < 1.5);
  const embedding = await helper.extractEmbedding(wavPath, 0.502, 2.002);

  assert.equal(extracted, true);
  assert.equal(embedding.length, 512);
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

test("diarization normalizes non-16 kHz WAV input and removes the private conversion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-normalize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wavPath = path.join(directory, "private-source-24k.wav");
  writeMonoPcm16Wav(wavPath, 24_000, [1, 2, 3, 4]);

  for (const [name, sidecarCode] of [
    ["success", 0],
    ["sidecar failure", 7],
  ]) {
    await t.test(name, async () => {
      const convertedPath = path.join(directory, `private-converted-${sidecarCode}.wav`);
      const conversionCalls = [];
      const spawnCalls = [];
      const removed = [];
      const manager = new DiarizationManager({
        convertToWavImpl: async (inputPath, outputPath, options) => {
          conversionCalls.push({ inputPath, outputPath, options });
          writeMonoPcm16Wav(outputPath, 16_000, [1, 2, 3]);
        },
        createTempWavPathImpl: () => convertedPath,
        unlinkImpl: async (filePath) => {
          removed.push(filePath);
          await fs.promises.unlink(filePath);
        },
        spawnImpl: (binaryPath, args) => {
          spawnCalls.push({ binaryPath, args });
          return fakeSidecar({ code: sidecarCode });
        },
      });
      manager.getBinaryPath = () => "diarizer";
      manager.isModelDownloaded = () => true;

      if (sidecarCode === 0) {
        assert.deepEqual(await manager.diarizeStrict(wavPath), []);
      } else {
        await assert.rejects(manager.diarizeStrict(wavPath), {
          code: "DIARIZATION_SIDECAR_EXIT_NONZERO",
        });
      }

      assert.deepEqual(conversionCalls, [
        {
          inputPath: wavPath,
          outputPath: convertedPath,
          options: { sampleRate: 16_000, channels: 1, redactPaths: true },
        },
      ]);
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].args.at(-1), convertedPath);
      assert.deepEqual(removed, [convertedPath]);
      assert.equal(fs.existsSync(convertedPath), false);
      assert.equal(fs.existsSync(wavPath), true);
    });
  }

  await t.test("conversion failure removes partial output before spawn", async () => {
    const convertedPath = path.join(directory, "private-partial.wav");
    const removed = [];
    let spawnCount = 0;
    const manager = new DiarizationManager({
      convertToWavImpl: async (_inputPath, outputPath) => {
        fs.writeFileSync(outputPath, Buffer.from("partial private audio"));
        throw new Error("conversion failed");
      },
      createTempWavPathImpl: () => convertedPath,
      unlinkImpl: async (filePath) => {
        removed.push(filePath);
        await fs.promises.unlink(filePath);
      },
      spawnImpl: () => {
        spawnCount += 1;
        return fakeSidecar();
      },
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;

    await assert.rejects(manager.diarizeStrict(wavPath), /conversion failed/);
    assert.equal(spawnCount, 0);
    assert.deepEqual(removed, [convertedPath]);
    assert.equal(fs.existsSync(convertedPath), false);
  });
});

test("strict diarization accepts only the packaged helper's known banner lines", () => {
  const manager = new DiarizationManager();
  const output = [
    "OfflineSpeakerDiarizationConfig(segmentation=OfflineSpeakerSegmentationConfig(), embedding=OfflineSpeakerEmbeddingConfig())",
    "Started",
    "1.972 -- 3.203 speaker_01",
  ].join("\n");

  assert.deepEqual(manager._parseStrictOutput(output), [
    { start: 1.972, end: 3.203, speaker: "speaker_01" },
  ]);
  assert.throws(
    () => manager._parseStrictOutput(`${output}\nFinished`),
    (error) => error.code === "DIARIZATION_SIDECAR_INVALID_OUTPUT"
  );
});

test("diarization adapter logs exclude full audio, model, and binary paths", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-log-paths-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wavPath = path.join(directory, "private-audio-24k.wav");
  const convertedPath = path.join(directory, "private-converted-16k.wav");
  const binaryPath = path.join(directory, "private-bin", "sherpa-onnx-diarize.exe");
  const segmentationPath = path.join(directory, "private-models", "segmentation.onnx");
  const embeddingPath = path.join(directory, "private-models", "embedding.onnx");
  writeMonoPcm16Wav(wavPath, 24_000, [1, 2, 3, 4]);
  const logCalls = [];
  const loggerImpl = {
    debug: (...args) => logCalls.push(args),
    info: (...args) => logCalls.push(args),
    warn: (...args) => logCalls.push(args),
  };
  const manager = new DiarizationManager({
    loggerImpl,
    convertToWavImpl: async (_inputPath, outputPath) => {
      writeMonoPcm16Wav(outputPath, 16_000, [1, 2, 3]);
    },
    createTempWavPathImpl: () => convertedPath,
    unlinkImpl: (filePath) => fs.promises.unlink(filePath),
    spawnImpl: () =>
      fakeSidecar({
        code: 7,
        stderr: `failed ${wavPath} ${convertedPath} ${segmentationPath} ${embeddingPath}`,
      }),
  });
  manager.getBinaryPath = () => binaryPath;
  manager.isModelDownloaded = () => true;
  manager._resolveModelPath = (relativePath) =>
    relativePath.includes("pyannote") ? segmentationPath : embeddingPath;

  await assert.rejects(manager.diarizeStrict(wavPath), {
    code: "DIARIZATION_SIDECAR_EXIT_NONZERO",
  });

  assert.ok(logCalls.length >= 2);
  const serializedLogs = JSON.stringify(logCalls);
  for (const privatePath of [
    wavPath,
    convertedPath,
    binaryPath,
    segmentationPath,
    embeddingPath,
  ]) {
    assert.equal(serializedLogs.includes(privatePath), false);
  }
});

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

  await t.test("failed timeout stop keeps process and pid until shutdown retries", async () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let trackedPid = null;
    let stopCalls = 0;
    const manager = new DiarizationManager({
      spawnImpl: () => child,
      setTimeoutImpl: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeoutImpl: () => {},
      gracefulStopProcessImpl: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("kill failed");
      },
      pidFileImpl: {
        write: (_name, pid) => {
          trackedPid = pid;
        },
        clear: () => {
          trackedPid = null;
        },
      },
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;

    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_STOP_FAILED",
    });
    assert.equal(stopCalls, 1);
    assert.equal(manager._process, child);
    assert.equal(trackedPid, 4242);

    await manager.shutdown();
    assert.equal(stopCalls, 2);
    assert.equal(manager._process, null);
    assert.equal(trackedPid, null);
  });

  await t.test("active timed-out sidecar blocks a second spawn until shutdown", async () => {
    const child = new EventEmitter();
    child.pid = 100;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let trackedPid = null;
    let spawnCount = 0;
    let stopCalls = 0;
    const manager = new DiarizationManager({
      spawnImpl: () => {
        spawnCount += 1;
        return child;
      },
      setTimeoutImpl: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeoutImpl: () => {},
      gracefulStopProcessImpl: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("kill failed");
      },
      pidFileImpl: {
        write: (_name, pid) => {
          trackedPid = pid;
        },
        clear: () => {
          trackedPid = null;
        },
      },
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;

    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_STOP_FAILED",
    });
    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_BUSY",
    });
    assert.deepEqual(await manager.diarize(wavPath), []);
    assert.equal(spawnCount, 1);
    assert.equal(manager._process, child);
    assert.equal(trackedPid, 100);

    await manager.shutdown();
    assert.equal(stopCalls, 2);
    assert.equal(manager._process, null);
    assert.equal(trackedPid, null);
  });

  await t.test("natural close after failed timeout stop clears stale tracking", async () => {
    const child = new EventEmitter();
    child.pid = 4244;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let trackedPid = null;
    const manager = new DiarizationManager({
      spawnImpl: () => child,
      setTimeoutImpl: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeoutImpl: () => {},
      gracefulStopProcessImpl: async () => {
        throw new Error("kill failed");
      },
      pidFileImpl: {
        write: (_name, pid) => {
          trackedPid = pid;
        },
        clear: () => {
          trackedPid = null;
        },
      },
    });
    manager.getBinaryPath = () => "diarizer";
    manager.isModelDownloaded = () => true;

    await assert.rejects(manager.diarizeStrict(wavPath), {
      code: "DIARIZATION_SIDECAR_STOP_FAILED",
    });
    assert.equal(manager._process, child);
    assert.equal(trackedPid, 4244);

    child.emit("close", 0);
    assert.equal(manager._process, null);
    assert.equal(trackedPid, null);
  });

  await t.test(
    "successful timeout stop ignores kill events then clears tracked process",
    async () => {
      const child = new EventEmitter();
      child.pid = 4243;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const pidEvents = [];
      const manager = new DiarizationManager({
        spawnImpl: () => child,
        setTimeoutImpl: (callback) => {
          queueMicrotask(callback);
          return 1;
        },
        clearTimeoutImpl: () => {},
        gracefulStopProcessImpl: async (processToStop) => {
          processToStop.emit("error", new Error("kill transition"));
          processToStop.emit("close", 1);
        },
        pidFileImpl: {
          write: (_name, pid) => pidEvents.push(`write:${pid}`),
          clear: () => pidEvents.push("clear"),
        },
      });
      manager.getBinaryPath = () => "diarizer";
      manager.isModelDownloaded = () => true;

      await assert.rejects(manager.diarizeStrict(wavPath), {
        code: "DIARIZATION_SIDECAR_TIMEOUT",
      });
      assert.equal(manager._process, null);
      assert.deepEqual(pidEvents, ["write:4243", "clear"]);
    }
  );

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
