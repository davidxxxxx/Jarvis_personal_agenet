const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const WhisperManager = require("../../src/helpers/whisper");

function serverFixture({ proof }) {
  const starts = [];
  const serverManager = {
    process: { pid: 4_321 },
    useCuda: false,
    selectedGpuUuid: null,
    async start(modelPath, options) {
      starts.push({ modelPath, options });
      this.useCuda = options.useCuda === true;
      this.selectedGpuUuid = this.useCuda ? options.gpuUuid : null;
    },
    async transcribe() {
      return { text: "verified local result" };
    },
    getCudaProofEvidence() {
      return typeof proof === "function" ? proof(this) : proof;
    },
  };
  return { serverManager, starts };
}

test("CPU admission overrides WHISPER_THREADS with four and lowers process priority", async (t) => {
  const previous = process.env.WHISPER_THREADS;
  process.env.WHISPER_THREADS = "64";
  t.after(() => {
    if (previous === undefined) delete process.env.WHISPER_THREADS;
    else process.env.WHISPER_THREADS = previous;
  });
  const { serverManager, starts } = serverFixture({
    proof: { backend: "cpu", gpuUuid: null },
  });
  const priorities = [];
  const manager = new WhisperManager({
    serverManager,
    setProcessPriority: (pid, priority) => priorities.push({ pid, priority }),
  });
  manager.getModelPath = () => "model.bin";

  const result = await manager._runServerTranscription(Buffer.from("wav"), "base", null, null, {
    useCuda: false,
    threads: 4,
    lowPriority: true,
  });

  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.useCuda, false);
  assert.equal(starts[0].options.threads, 4);
  assert.equal(starts[0].options.gpuUuid, null);
  assert.deepEqual(priorities, [
    { pid: 4_321, priority: os.constants.priority.PRIORITY_BELOW_NORMAL },
  ]);
  assert.equal(result.executionDevice, "cpu");
});

test("CUDA admission binds the verified UUID and records CUDA only after backend proof", async () => {
  const { serverManager, starts } = serverFixture({
    proof: (server) => ({ backend: "cuda", gpuUuid: server.selectedGpuUuid }),
  });
  const manager = new WhisperManager({ serverManager, setProcessPriority: () => {} });
  manager.getModelPath = () => "model.bin";

  const result = await manager._runServerTranscription(Buffer.from("wav"), "base", null, null, {
    useCuda: true,
    gpuUuid: "GPU-verified",
    requireCuda: true,
  });

  assert.equal(starts[0].options.useCuda, true);
  assert.equal(starts[0].options.requireCuda, true);
  assert.equal(starts[0].options.gpuUuid, "GPU-verified");
  assert.equal(result.executionDevice, "cuda");
});

test("CUDA backend or UUID disagreement fails before a false device can be reported", async () => {
  const { serverManager } = serverFixture({ proof: { backend: "cpu", gpuUuid: null } });
  const manager = new WhisperManager({ serverManager, setProcessPriority: () => {} });
  manager.getModelPath = () => "model.bin";

  await assert.rejects(
    manager._runServerTranscription(Buffer.from("wav"), "base", null, null, {
      useCuda: true,
      gpuUuid: "GPU-verified",
      requireCuda: true,
    }),
    { code: "EXECUTION_DEVICE_MISMATCH" }
  );
});
