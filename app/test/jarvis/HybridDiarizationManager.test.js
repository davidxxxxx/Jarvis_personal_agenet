const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const DiarizationSidecarClient = require("../../src/jarvis/main/DiarizationSidecarClient");
const HybridDiarizationManager = require("../../src/jarvis/main/HybridDiarizationManager");
const {
  HYBRID_DIARIZATION_POLICY,
} = require("../../src/jarvis/main/HybridDiarizationPolicy");

function runtime(result) {
  return {
    async run(operation) {
      return operation({ request: async () => result });
    },
    status() {
      return {
        loaded: true,
        loading: false,
        active: 0,
        unloadScheduled: true,
        unloadDelayMs: 300_000,
      };
    },
    async dispose() {},
  };
}

test("sidecar client initializes its EventEmitter base before storing runtime state", () => {
  const client = new DiarizationSidecarClient({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
  });
  assert.equal(client.listenerCount("error"), 0);
  assert.equal(client.packRoot, "G:\\JarvisData\\models\\ai-model-pack");
});

test("sidecar keeps System32 available for the pinned NVIDIA probe without inheriting PATH", async () => {
  let spawnOptions = null;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    pid: 1234,
  });
  const client = new DiarizationSidecarClient({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    spawnImpl: (_executable, _arguments, options) => {
      spawnOptions = options;
      return child;
    },
  });
  await client.start();
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    assert.ok(spawnOptions.env.PATH.includes(`${systemRoot}\\System32`));
  }
  assert.notEqual(spawnOptions.env.PATH, process.env.PATH);
  await client.stop();
});

test("hybrid manager exposes consensus and sends only final work through CUDA", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 10_000,
      turns: [
        { speaker: "S1", startMs: 0, endMs: 5_000 },
        { speaker: "S2", startMs: 4_000, endMs: 9_000 },
      ],
      verifierCount: 2,
      overlapSeparation: { state: "completed", processed: 1, total: 1 },
    }),
    fsImpl: { existsSync: () => true },
  });
  await assert.rejects(
    manager.diarizeStrict("G:\\recording.wav", { executionContext: { device: "cpu" } }),
    (error) => error.code === "DIARIZATION_CUDA_REQUIRED"
  );
  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });
  assert.equal(turns.length, 2);
  assert.equal(turns.metadata.speakerCount.state, "models_agree");
  assert.equal(turns.metadata.speakerCount.preferred, 2);
  assert.deepEqual(turns.metadata.overlapWindows, [{ startMs: 3_750, endMs: 5_250 }]);
  assert.equal(turns.metadata.overlapSeparation.state, "completed");
  assert.equal(manager.status().unloadDelayMs, 300_000);
});

test("hybrid manager can disable the high-memory overlap separator per track", async () => {
  let requestPayload = null;
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: {
      async run(operation) {
        return operation({
          request: async (_command, payload) => {
            requestPayload = payload;
            return {
              durationMs: 10_000,
              turns: [{ speaker: "S1", startMs: 0, endMs: 10_000 }],
              verifierCount: 1,
              overlapSeparation: {
                state: "not_needed",
                processed: 0,
                total: 0,
                reason: "policy_disabled",
              },
            };
          },
        });
      },
      status() {
        return { loaded: true, loading: false, active: 0, unloadScheduled: true };
      },
      async dispose() {},
    },
    fsImpl: { existsSync: () => true },
  });

  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
    enableOverlapSeparation: false,
    releaseHighMemoryResources: true,
  });

  assert.equal(requestPayload.enableOverlapSeparation, false);
  assert.equal(requestPayload.releaseOverlapSeparatorAfterRequest, true);
  assert.equal(turns.metadata.overlapSeparation.reason, "policy_disabled");
});

test("hybrid manager namespaces stable overlap artifact paths by diarization policy", async () => {
  const artifactKeys = [];
  const makeManager = (policyId) =>
    new HybridDiarizationManager({
      packRoot: "G:\\JarvisData\\models\\ai-model-pack",
      policy: Object.freeze({ ...HYBRID_DIARIZATION_POLICY, policyId }),
      runtime: {
        async run(operation) {
          return operation({
            request: async (_command, payload) => {
              artifactKeys.push(payload.artifactKey);
              return {
                durationMs: 1_000,
                turns: [{ speaker: "S1", startMs: 0, endMs: 1_000 }],
                verifierCount: 1,
                overlapSeparation: { state: "not_needed", processed: 0, total: 0, stems: [] },
              };
            },
          });
        },
        status() {
          return { loaded: true, loading: false, active: 0, unloadScheduled: true };
        },
        async dispose() {},
      },
      fsImpl: { existsSync: () => true },
    });

  const v5 = makeManager("jarvis-hybrid-diarization-v5");
  const v6 = makeManager("jarvis-hybrid-diarization-v6");
  const input = {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
    artifactKey: "stem_same_session_and_chunk",
  };

  await v5.diarizeStrict("G:\\recording.wav", input);
  await v5.diarizeStrict("G:\\recording.wav", input);
  await v6.diarizeStrict("G:\\recording.wav", input);

  assert.match(artifactKeys[0], /^stem_[0-9a-f]{64}$/u);
  assert.equal(artifactKeys[1], artifactKeys[0], "same-policy retries must reuse one path");
  assert.notEqual(artifactKeys[2], artifactKeys[0], "new policies require a distinct path");
});

test("hybrid manager rejects malformed sidecar turns before persistence", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({ turns: [{ speaker: "bad speaker", startMs: 0, endMs: 1 }] }),
    fsImpl: { existsSync: () => true },
  });
  await assert.rejects(
    manager.diarizeStrict("G:\\recording.wav", { executionContext: { device: "cuda" } }),
    (error) => error.code === "DIARIZATION_SIDECAR_INVALID_RESULT"
  );
});

test("hybrid manager preserves sub-millisecond turns that collapse after rounding", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 1_000,
      turns: [
        { speaker: "S1", startMs: 250, endMs: 250 },
        { speaker: "S2", startMs: 1_000, endMs: 1_000 },
      ],
      verifierCount: 2,
      overlapSeparation: { state: "not_needed", processed: 0, total: 0 },
    }),
    fsImpl: { existsSync: () => true },
  });

  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });

  assert.deepEqual([...turns], [
    { speaker: "S1", startMs: 250, endMs: 251 },
    { speaker: "S2", startMs: 999, endMs: 1_000 },
  ]);
});

test("hybrid manager corrects one or two millisecond boundary drift", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 1_000,
      turns: [
        { speaker: "S1", startMs: 251, endMs: 250 },
        { speaker: "S2", startMs: 1_001, endMs: 1_000 },
      ],
      verifierCount: 2,
      overlapSeparation: { state: "not_needed", processed: 0, total: 0 },
    }),
    fsImpl: { existsSync: () => true },
  });

  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });

  assert.deepEqual([...turns], [
    { speaker: "S1", startMs: 250, endMs: 251 },
    { speaker: "S2", startMs: 999, endMs: 1_000 },
  ]);
});

test("hybrid manager drops padding-only turns beyond the authoritative audio tail", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 1_000,
      turns: [
        { speaker: "S1", startMs: 0, endMs: 900 },
        { speaker: "S2", startMs: 1_020, endMs: 1_000 },
      ],
      verifierCount: 1,
      overlapSeparation: { state: "not_needed", processed: 0, total: 0 },
    }),
    fsImpl: { existsSync: () => true },
  });

  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });

  assert.deepEqual([...turns], [{ speaker: "S1", startMs: 0, endMs: 900 }]);
});

test("hybrid manager still rejects inverted sidecar turn bounds", async () => {
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 1_000,
      turns: [{ speaker: "S1", startMs: 255, endMs: 250 }],
    }),
    fsImpl: { existsSync: () => true },
  });

  await assert.rejects(
    manager.diarizeStrict("G:\\recording.wav", { executionContext: { device: "cuda" } }),
    (error) => error.code === "DIARIZATION_SIDECAR_INVALID_RESULT"
  );
});

test("hybrid manager keeps primary CUDA results when the optional verifier crashes", async () => {
  let verifierCalls = 0;
  const verifierError = new Error("native verifier access violation");
  verifierError.code = "DIARIZATION_SIDECAR_EXIT_NONZERO";
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    runtime: runtime({
      durationMs: 1_000,
      turns: [{ speaker: "S1", startMs: 0, endMs: 1_000 }],
      verifierCount: null,
      overlapSeparation: { state: "not_needed", processed: 0, total: 0 },
    }),
    verifierDiarizer: {
      async diarizeStrict() {
        verifierCalls += 1;
        throw verifierError;
      },
    },
    fsImpl: { existsSync: () => true },
  });

  const first = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });
  const second = await manager.diarizeStrict("G:\\recording-2.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-1" },
  });

  assert.equal(verifierCalls, 1);
  assert.equal(first.metadata.speakerCount.state, "primary_only");
  assert.equal(first.metadata.verifierState, "unavailable");
  assert.equal(first.metadata.models.verifier, null);
  assert.equal(second.metadata.verifierState, "unavailable");
  assert.equal(manager.status().verifierCircuitOpen, true);
});

test("default hybrid runtime binds the admitted GPU and validates CUDA plus primary model", async () => {
  const calls = [];
  let clientOptions = null;
  const client = {
    async start() {
      calls.push("start");
    },
    async request(command) {
      calls.push(command);
      if (command === "self_test") return { cuda: true, primaryLoaded: true };
      return {
        durationMs: 1_000,
        turns: [{ speaker: "S1", startMs: 0, endMs: 1_000 }],
        verifierCount: 1,
        overlapSeparation: { state: "not_needed", processed: 0, total: 0 },
      };
    },
    async stop() {
      calls.push("stop");
    },
  };
  const manager = new HybridDiarizationManager({
    packRoot: "G:\\JarvisData\\models\\ai-model-pack",
    clientFactory: (options) => {
      clientOptions = options;
      return client;
    },
    verifyPack: async () => ({ manifestSha256: "a".repeat(64) }),
    fsImpl: { existsSync: () => true },
  });

  const turns = await manager.diarizeStrict("G:\\recording.wav", {
    executionContext: { device: "cuda", selectedGpuUuid: "GPU-selected" },
  });
  assert.equal(turns.length, 1);
  assert.equal(clientOptions.selectedGpuUuid, "GPU-selected");
  assert.deepEqual(calls.slice(0, 3), ["start", "self_test", "diarize"]);
  await manager.dispose();
  assert.equal(calls.at(-1), "stop");
});
