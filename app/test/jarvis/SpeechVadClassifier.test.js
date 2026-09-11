const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SpeechVadClassifier = require("../../src/jarvis/main/SpeechVadClassifier");
const SileroVadRuntime = require("../../src/workers/SileroVadRuntime");

function pcm100ms(amplitude = 0) {
  const output = Buffer.alloc(2_400 * 2);
  for (let offset = 0; offset < output.length; offset += 2) {
    output.writeInt16LE(amplitude, offset);
  }
  return output;
}

function voicedPcm100ms() {
  const sampleRate = 24_000;
  const output = Buffer.alloc(2_400 * 2);
  for (let index = 0; index < 2_400; index += 1) {
    const carrier = Math.sin((2 * Math.PI * 180 * index) / sampleRate);
    const modulation = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * index) / sampleRate);
    output.writeInt16LE(Math.round(carrier * modulation * 12_000), index * 2);
  }
  return output;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("classifier loads once and forwards distinct mic and system stream ids", async () => {
  const requests = [];
  const workerClient = {
    async request(method, payload) {
      requests.push({ method, payload });
      if (method === "vad.classify") return { probability: 0.75 };
      if (method === "vad.health") return { ok: true, probability: 0.01 };
      return { ok: true };
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "C:\\models\\silero.onnx",
    fsImpl: { existsSync: () => true },
  });

  assert.equal(classifier.isReady(), false);
  await classifier.initialize();
  assert.equal(classifier.isReady(), true);
  assert.equal(
    await classifier.classify({
      sessionId: "s1",
      sourceType: "mic",
      streamId: "s1:mic:1",
      sampleRate: 24_000,
      pcm: pcm100ms(),
    }),
    0.75
  );
  await classifier.classify({
    sessionId: "s1",
    sourceType: "system",
    streamId: "s1:system:1",
    sampleRate: 24_000,
    pcm: pcm100ms(),
  });

  assert.equal(requests.filter((request) => request.method === "vad.load").length, 1);
  assert.deepEqual(
    requests
      .filter((request) => request.method === "vad.classify")
      .map((request) => request.payload.streamId),
    ["s1:mic:1", "s1:system:1"]
  );
});

test("worker rejection marks VAD unavailable and background recovery reports health", async () => {
  let rejectClassification = true;
  const workerClient = {
    async request(method) {
      if (method === "vad.classify" && rejectClassification) {
        rejectClassification = false;
        throw new Error("worker restarted");
      }
      if (method === "vad.reload") return { ok: true, probability: 0.01 };
      if (method === "vad.health") return { ok: true, probability: 0.01 };
      return method === "vad.classify" ? { probability: 0.1 } : { ok: true };
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });
  await classifier.initialize();
  await assert.rejects(
    classifier.classify({
      sessionId: "s1",
      sourceType: "mic",
      streamId: "s1:mic:1",
      sampleRate: 24_000,
      pcm: pcm100ms(),
    }),
    /worker restarted/
  );
  assert.equal(classifier.isReady(), false);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("recovery callback not called")), 500);
    classifier.startRecovery({
      intervalMs: 5,
      onRecovered: () => {
        clearTimeout(timeout);
        resolve();
      },
    });
  });
  assert.equal(classifier.isReady(), true);
  await classifier.stop();
});

test("Silero runtime keeps recurrent state and remainder independent per source stream", async () => {
  let createOptions = null;
  const stateInputs = [];
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["input", "sr", "state"],
    outputNames: ["output", "stateN"],
    inputMetadata: { state: { dimensions: [1] } },
    async run(feeds) {
      const current = Number(feeds.state.data[0]);
      stateInputs.push(current);
      return {
        output: { data: Float32Array.from([0.8]) },
        stateN: { data: Float32Array.from([current + 1]) },
      };
    },
  };
  const ort = {
    Tensor,
    InferenceSession: {
      create: async (_modelPath, options) => {
        createOptions = options;
        return session;
      },
    },
  };
  const runtime = new SileroVadRuntime({ ort });
  await runtime.load("vad.onnx", { intraOpNumThreads: 8, executionMode: "parallel" });

  assert.equal(createOptions.intraOpNumThreads, 1);
  assert.equal(createOptions.executionMode, "sequential");

  await runtime.classify({
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: pcm100ms().buffer,
  });
  await runtime.classify({
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: pcm100ms().buffer,
  });
  await runtime.classify({
    streamId: "s1:system:1",
    sampleRate: 24_000,
    samplesBuffer: pcm100ms().buffer,
  });

  assert.equal(stateInputs[0], 0);
  assert.ok(stateInputs.slice(1, 6).some((value) => value > 0));
  assert.equal(stateInputs[6], 0);
  assert.equal(runtime.streamCount, 2);
});

test("Silero runtime carries recurrent h/c state through new_h and new_c outputs", async () => {
  const stateInputs = [];
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["x", "h", "c"],
    outputNames: ["prob", "new_h", "new_c"],
    inputMetadata: {
      h: { dimensions: [2, 1, 64] },
      c: { dimensions: [2, 1, 64] },
    },
    async run(feeds) {
      const h = Number(feeds.h.data[0]);
      const c = Number(feeds.c.data[0]);
      stateInputs.push({ h, c });
      return {
        prob: { data: Float32Array.from([0.8]) },
        new_h: { data: Float32Array.from({ length: 128 }, () => h + 1) },
        new_c: { data: Float32Array.from({ length: 128 }, () => c + 2) },
      };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: { Tensor, InferenceSession: { create: async () => session } },
  });
  await runtime.load("silero_vad.onnx");

  await runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: pcm100ms().buffer,
  });

  assert.deepEqual(stateInputs.slice(0, 3), [
    { h: 0, c: 0 },
    { h: 1, c: 2 },
    { h: 2, c: 4 },
  ]);
});

test("bundled Silero model advances real new_h/new_c recurrent state", async (t) => {
  const modelPath = path.resolve(
    __dirname,
    "../../dist/win-unpacked/resources/bin/diarization-models/silero_vad.onnx"
  );
  if (!fs.existsSync(modelPath)) {
    t.skip("bundled Silero model is not present in this checkout");
    return;
  }
  const ort = require("onnxruntime-node");
  const runtime = new SileroVadRuntime({ ort });
  await runtime.load(modelPath);

  await runtime.classify({
    sessionId: "real-model",
    streamId: "real-model:mic:1",
    sampleRate: 24_000,
    samplesBuffer: voicedPcm100ms().buffer,
  });
  const stream = runtime.streams.get("real-model:mic:1");
  const firstH = Float32Array.from(stream.states.get("h"));
  const firstC = Float32Array.from(stream.states.get("c"));
  assert.ok(firstH.some((value) => value !== 0));
  assert.ok(firstC.some((value) => value !== 0));

  await runtime.classify({
    sessionId: "real-model",
    streamId: "real-model:mic:1",
    sampleRate: 24_000,
    samplesBuffer: voicedPcm100ms().buffer,
  });
  assert.notDeepEqual([...stream.states.get("h")], [...firstH]);
  assert.notDeepEqual([...stream.states.get("c")], [...firstC]);
});

test("Silero runtime reports probability from the current classify call", async () => {
  const probabilities = [0.9, 0.1];
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([probabilities.shift()]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: { Tensor, InferenceSession: { create: async () => session } },
  });
  await runtime.load("vad.onnx");

  const oneWindow = Buffer.alloc(768 * 2);
  assert.ok(
    Math.abs(
      (
        await runtime.classify({
          streamId: "s1:mic:1",
          sampleRate: 24_000,
          samplesBuffer: oneWindow.buffer,
        })
      ).probability - 0.9
    ) < 1e-6
  );
  assert.ok(
    Math.abs(
      (
        await runtime.classify({
          streamId: "s1:mic:1",
          sampleRate: 24_000,
          samplesBuffer: oneWindow.buffer,
        })
      ).probability - 0.1
    ) < 1e-6
  );
});

test("Silero runtime bounds streams with LRU eviction and resets a whole session", async () => {
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: { Tensor, InferenceSession: { create: async () => session } },
    maxStreams: 2,
  });
  await runtime.load("vad.onnx");
  const oneWindow = Buffer.alloc(768 * 2);

  for (const [sessionId, streamId] of [
    ["s1", "s1:mic:1"],
    ["s1", "s1:system:1"],
    ["s2", "s2:mic:1"],
  ]) {
    await runtime.classify({
      sessionId,
      streamId,
      sampleRate: 24_000,
      samplesBuffer: oneWindow.buffer,
    });
  }

  assert.equal(runtime.streamCount, 2);
  assert.equal(runtime.hasStream("s1:mic:1"), false);
  assert.equal(runtime.hasStream("s1:system:1"), true);
  assert.equal(runtime.hasStream("s2:mic:1"), true);
  await runtime.resetSession("s1");
  assert.equal(runtime.streamCount, 1);
  assert.equal(runtime.hasStream("s1:system:1"), false);
  assert.equal(runtime.hasStream("s2:mic:1"), true);
});

test("classifier resetSession and stop clear VAD worker streams", async () => {
  const requests = [];
  const workerClient = {
    async request(method, payload) {
      requests.push({ method, payload });
      if (method === "vad.health") return { ok: true, probability: 0.01 };
      return { ok: true };
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });
  await classifier.initialize();
  await classifier.resetSession("s1");
  await classifier.stop();

  assert.ok(
    requests.some(
      (request) => request.method === "vad.resetSession" && request.payload.sessionId === "s1"
    )
  );
  assert.ok(requests.some((request) => request.method === "vad.reset"));
});

test("detailed classification preserves per-window probabilities and clears its PCM clone", async () => {
  let captured = null;
  const classifier = new SpeechVadClassifier({
    workerClient: {
      async request(method, payload) {
        if (method === "vad.load") return { ok: true };
        if (method === "vad.health") return { ok: true, probability: 0.01 };
        if (method === "vad.classify") {
          captured = payload.samplesBuffer;
          return { probability: 0.8, windowCount: 2, probabilities: [0.8, 0.2] };
        }
        return { ok: true };
      },
    },
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });
  await classifier.initialize();
  const pcm = Buffer.alloc(3_072, 7);

  assert.deepEqual(
    await classifier.classifyDetailed({
      sessionId: "s1",
      sourceType: "mic",
      streamId: "s1:mic:1",
      sampleRate: 24_000,
      pcm,
    }),
    { probability: 0.8, windowCount: 2, probabilities: [0.8, 0.2] }
  );
  assert.equal(
    new Uint8Array(captured).every((value) => value === 0),
    true
  );
  assert.equal(
    pcm.every((value) => value === 7),
    true
  );
  await classifier.stop();
});

test("Silero runtime clears cloned PCM when the model is unloaded or stream id is invalid", async (t) => {
  const ort = {
    Tensor: class Tensor {},
    InferenceSession: {
      create: async () => ({ inputNames: ["input"], outputNames: ["output"] }),
    },
  };
  const runtime = new SileroVadRuntime({ ort });
  await t.test("model unloaded", async () => {
    const samplesBuffer = new ArrayBuffer(1_536);
    new Uint8Array(samplesBuffer).fill(7);
    await assert.rejects(
      runtime.classify({ streamId: "valid", sampleRate: 24_000, samplesBuffer }),
      /not loaded/
    );
    assert.equal(
      new Uint8Array(samplesBuffer).every((value) => value === 0),
      true
    );
  });

  await runtime.load("vad.onnx");
  await t.test("invalid stream", async () => {
    const samplesBuffer = new ArrayBuffer(1_536);
    new Uint8Array(samplesBuffer).fill(7);
    await assert.rejects(
      runtime.classify({ streamId: "", sampleRate: 24_000, samplesBuffer }),
      /streamId/
    );
    assert.equal(
      new Uint8Array(samplesBuffer).every((value) => value === 0),
      true
    );
  });
});

test("stop prevents an in-flight initialize from restoring ready state", async () => {
  const loading = deferred();
  const workerClient = {
    async request(method) {
      if (method === "vad.load") return loading.promise;
      return { ok: true };
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });

  const initialize = classifier.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const stop = classifier.stop();
  loading.resolve({ ok: true });
  await Promise.all([initialize, stop]);

  assert.equal(classifier.isReady(), false);
});

test("classifier stays unavailable when health inference returns an invalid probability", async () => {
  const classifier = new SpeechVadClassifier({
    workerClient: {
      async request(method) {
        if (method === "vad.health") return { ok: true, probability: Number.NaN };
        return { ok: true };
      },
    },
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });

  await assert.rejects(classifier.initialize(), /health/i);
  assert.equal(classifier.isReady(), false);
});

test("Silero runtime serializes inference across microphone and system streams", async () => {
  const runs = [];
  let activeRuns = 0;
  let maxActiveRuns = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      const pending = deferred();
      runs.push(pending);
      await pending.promise;
      activeRuns -= 1;
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: { Tensor, InferenceSession: { create: async () => session } },
  });
  await runtime.load("vad.onnx");
  const oneWindow = Buffer.alloc(768 * 2);

  const mic = runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: oneWindow.buffer,
  });
  const system = runtime.classify({
    sessionId: "s1",
    streamId: "s1:system:1",
    sampleRate: 24_000,
    samplesBuffer: oneWindow.buffer,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 1);
  runs[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 2);
  runs[1].resolve();
  await Promise.all([mic, system]);

  assert.equal(maxActiveRuns, 1);
});

test("Silero health inference does not evict a retained capture stream", async () => {
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: { Tensor, InferenceSession: { create: async () => session } },
    maxStreams: 1,
  });
  await runtime.load("vad.onnx");
  await runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: Buffer.alloc(768 * 2).buffer,
  });

  await runtime.health();

  assert.equal(runtime.streamCount, 1);
  assert.equal(runtime.hasStream("s1:mic:1"), true);
});

test("recovery reloads a permanently faulty first VAD session before reporting healthy", async (t) => {
  let creates = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const ort = {
    Tensor,
    InferenceSession: {
      create: async () => {
        creates += 1;
        const faulty = creates === 1;
        return {
          inputNames: ["input"],
          outputNames: ["output"],
          async run() {
            if (faulty) throw new Error("permanent first session fault");
            return { output: { data: Float32Array.from([0.1]) } };
          },
        };
      },
    },
  };
  const runtime = new SileroVadRuntime({ ort });
  let healthRequests = 0;
  const workerClient = {
    request(method, payload) {
      if (method === "vad.load") return runtime.load(payload.modelPath);
      if (method === "vad.reload") return runtime.reload(payload.modelPath);
      if (method === "vad.health") {
        healthRequests += 1;
        return runtime.health();
      }
      if (method === "vad.reset") return runtime.reset(payload?.streamId);
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });
  t.after(() => classifier.stop());

  await assert.rejects(classifier.initialize(), /permanent first session fault/);
  let recovered = 0;
  classifier.startRecovery({ intervalMs: 5, onRecovered: () => (recovered += 1) });
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("VAD reload did not recover"));
    }, 250);
    const poll = () => {
      if (settled) return;
      if (recovered === 1) {
        settled = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });

  assert.equal(creates, 2);
  assert.equal(healthRequests, 1);
  assert.equal(classifier.isReady(), true);
  await classifier.stop();
});

test("Silero reload waits for classify and atomically preserves the old session on create failure", async () => {
  const run = deferred();
  let creates = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const firstSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      await run.promise;
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: {
      Tensor,
      InferenceSession: {
        create: async () => {
          creates += 1;
          if (creates === 1) return firstSession;
          throw new Error("replacement create failed");
        },
      },
    },
  });
  await runtime.load("vad.onnx");
  const classify = runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: Buffer.alloc(768 * 2).buffer,
  });
  const reload = runtime.reload("vad.onnx");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);

  run.resolve();
  await classify;
  await assert.rejects(reload, /replacement create failed/);
  assert.equal(runtime.session, firstSession);
  assert.equal(runtime.modelPath, "vad.onnx");
});

test("Silero reload rolls back a candidate that fails its health inference", async () => {
  let creates = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const firstSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const candidateSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      throw new Error("candidate health failed");
    },
  };
  const runtime = new SileroVadRuntime({
    ort: {
      Tensor,
      InferenceSession: {
        create: async () => (++creates === 1 ? firstSession : candidateSession),
      },
    },
  });
  await runtime.load("old-vad.onnx");
  await runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: Buffer.alloc(768 * 2).buffer,
  });
  const oldStreams = runtime.streams;
  const oldStream = runtime.streams.get("s1:mic:1");

  await assert.rejects(runtime.reload("new-vad.onnx"), /candidate health failed/);

  assert.equal(runtime.session, firstSession);
  assert.equal(runtime.modelPath, "old-vad.onnx");
  assert.equal(runtime.streams, oldStreams);
  assert.equal(runtime.streams.get("s1:mic:1"), oldStream);
});

test("Silero reload commits a verified candidate and resets old streams", async () => {
  let creates = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const firstSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const candidateSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      return { output: { data: Float32Array.from([0.2]) } };
    },
  };
  const runtime = new SileroVadRuntime({
    ort: {
      Tensor,
      InferenceSession: {
        create: async () => (++creates === 1 ? firstSession : candidateSession),
      },
    },
  });
  await runtime.load("old-vad.onnx");
  await runtime.classify({
    sessionId: "s1",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    samplesBuffer: Buffer.alloc(768 * 2).buffer,
  });
  const oldStreams = runtime.streams;

  const result = await runtime.reload("new-vad.onnx");

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.probability - 0.2) < 1e-6);
  assert.equal(runtime.session, candidateSession);
  assert.equal(runtime.modelPath, "new-vad.onnx");
  assert.notEqual(runtime.streams, oldStreams);
  assert.equal(runtime.streamCount, 0);
});

test("Silero reload health and a following classify stay serialized across rollback", async () => {
  const candidateHealth = deferred();
  const candidateStarted = deferred();
  let creates = 0;
  let oldRuns = 0;
  let candidateRuns = 0;
  class Tensor {
    constructor(type, data, dimensions) {
      this.type = type;
      this.data = data;
      this.dimensions = dimensions;
    }
  }
  const oldSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      oldRuns += 1;
      return { output: { data: Float32Array.from([0.1]) } };
    },
  };
  const candidateSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run() {
      candidateRuns += 1;
      candidateStarted.resolve();
      return candidateHealth.promise;
    },
  };
  const runtime = new SileroVadRuntime({
    ort: {
      Tensor,
      InferenceSession: {
        create: async () => (++creates === 1 ? oldSession : candidateSession),
      },
    },
  });
  await runtime.load("old-vad.onnx");
  const reload = runtime.reload("new-vad.onnx");
  await candidateStarted.promise;
  let classifySettled = false;
  const classify = runtime
    .classify({
      sessionId: "s1",
      streamId: "s1:mic:1",
      sampleRate: 24_000,
      samplesBuffer: Buffer.alloc(768 * 2).buffer,
    })
    .finally(() => {
      classifySettled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(classifySettled, false);
  assert.equal(candidateRuns, 1);
  assert.equal(oldRuns, 0);

  candidateHealth.reject(new Error("candidate health failed"));
  await assert.rejects(reload, /candidate health failed/);
  const result = await classify;

  assert.equal(result.windowCount, 1);
  assert.ok(Math.abs(result.probability - 0.1) < 1e-6);
  assert.equal(runtime.session, oldSession);
  assert.equal(candidateRuns, 1);
  assert.equal(oldRuns, 1);
});

test("reported service failure waits for in-flight classify and requires a real health check", async (t) => {
  const classification = deferred();
  let healthAvailable = true;
  let loadCalls = 0;
  let reloadCalls = 0;
  let healthCalls = 0;
  let recovered = 0;
  const workerClient = {
    async request(method) {
      if (method === "vad.load") {
        loadCalls += 1;
        return { ok: true };
      }
      if (method === "vad.reload") {
        reloadCalls += 1;
        if (!healthAvailable) throw new Error("persistent VAD session fault");
        return { ok: true, probability: 0.01 };
      }
      if (method === "vad.health") {
        healthCalls += 1;
        if (!healthAvailable) throw new Error("persistent VAD session fault");
        return { ok: true, probability: 0.01 };
      }
      if (method === "vad.classify") return classification.promise;
      return { ok: true };
    },
  };
  const classifier = new SpeechVadClassifier({
    workerClient,
    getModelPath: () => "vad.onnx",
    fsImpl: { existsSync: () => true },
  });
  t.after(() => classifier.stop());
  await classifier.initialize();
  classifier.startRecovery({ intervalMs: 5, onRecovered: () => (recovered += 1) });
  const inFlight = classifier.classify({
    sessionId: "s1",
    sourceType: "mic",
    streamId: "s1:mic:1",
    sampleRate: 24_000,
    pcm: pcm100ms(),
  });
  await new Promise((resolve) => setImmediate(resolve));

  healthAvailable = false;
  classifier.reportFailure(new Error("service timeout"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(classifier.isReady(), false);
  assert.equal(loadCalls, 1);
  assert.equal(recovered, 0);

  classification.resolve({ probability: 0.1 });
  await inFlight;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(classifier.isReady(), false);
  assert.equal(healthCalls, 1);
  assert.equal(recovered, 0);

  healthAvailable = true;
  classifier.reportFailure(new Error("retry health"));
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("classifier did not recover"));
    }, 500);
    const poll = () => {
      if (settled) return;
      if (recovered === 1) {
        settled = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
  assert.equal(classifier.isReady(), true);
  assert.equal(loadCalls, 1);
  assert.ok(reloadCalls >= 1);
  assert.equal(healthCalls, 1);

  classifier.reportFailure(new Error("shutdown race"));
  await classifier.stop();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(recovered, 1);
  assert.equal(classifier.isReady(), false);
});
