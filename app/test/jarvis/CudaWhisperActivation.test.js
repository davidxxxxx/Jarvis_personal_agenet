const assert = require("node:assert/strict");
const test = require("node:test");

const activation = require("../../src/jarvis/main/CudaWhisperActivation");
const { activateVerifiedCudaRuntime, startWhisperServerWithVerifiedCuda } = activation;

test("persists enabled only after a requireCuda start proves the backend", async () => {
  const events = [];
  const manager = {
    stopServer: async () => events.push("stop"),
    startServer: async (_model, options) => events.push(["start", options]),
    getServerStatus: () => ({ backend: "cuda" }),
  };
  const result = await activateVerifiedCudaRuntime({
    whisperManager: manager,
    modelName: "large-v3-turbo",
    gpuUuid: "GPU-a",
    setEnabled: async (value) => events.push(["enabled", value]),
  });
  assert.equal(result.enabled, true);
  assert.equal(events[1][1].requireCuda, true);
  assert.deepEqual(events.at(-1), ["enabled", true]);
});

test("a CUDA activation failure clears enablement and restores CPU", async () => {
  const events = [];
  const manager = {
    stopServer: async () => events.push("stop"),
    startServer: async (_model, options) => {
      events.push(["start", options]);
      if (options.useCuda) throw new Error("driver failed");
    },
    getServerStatus: () => ({ backend: "unknown" }),
  };
  const result = await activateVerifiedCudaRuntime({
    whisperManager: manager,
    modelName: "large-v3-turbo",
    gpuUuid: "GPU-a",
    setEnabled: async (value) => events.push(["enabled", value]),
  });
  assert.equal(result.enabled, false);
  assert.match(result.error, /driver failed/);
  assert.deepEqual(events.at(-2), ["start", { useCuda: false }]);
  assert.deepEqual(events.at(-1), ["enabled", false]);
  assert.equal(
    events.some((event) => Array.isArray(event) && event[0] === "enabled" && event[1]),
    false
  );
});

test("IPC-style server start forwards the verified pointer UUID without an environment UUID", async (t) => {
  const previous = process.env.TRANSCRIPTION_GPU_UUID;
  delete process.env.TRANSCRIPTION_GPU_UUID;
  t.after(() => {
    if (previous == null) delete process.env.TRANSCRIPTION_GPU_UUID;
    else process.env.TRANSCRIPTION_GPU_UUID = previous;
  });
  const starts = [];
  const whisperManager = {
    startServer: async (modelName, options) => {
      starts.push([modelName, options]);
      return { success: true };
    },
  };
  const cudaManager = {
    getVerifiedStartOptions: () => ({
      useCuda: true,
      gpuUuid: "GPU-verified-pointer",
    }),
  };
  assert.equal(typeof startWhisperServerWithVerifiedCuda, "function");

  await startWhisperServerWithVerifiedCuda({
    whisperManager,
    cudaManager,
    modelName: "large-v3-turbo",
  });

  assert.deepEqual(starts, [
    ["large-v3-turbo", { useCuda: true, gpuUuid: "GPU-verified-pointer" }],
  ]);
});
