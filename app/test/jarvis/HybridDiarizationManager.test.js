const assert = require("node:assert/strict");
const test = require("node:test");
const DiarizationSidecarClient = require("../../src/jarvis/main/DiarizationSidecarClient");
const HybridDiarizationManager = require("../../src/jarvis/main/HybridDiarizationManager");

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
