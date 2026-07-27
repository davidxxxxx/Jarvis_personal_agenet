const assert = require("node:assert/strict");
const test = require("node:test");

const { maybeOfferCudaWhisper } = require("../../src/jarvis/main/CudaWhisperFirstRun");

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    input: {
      manager: {
        isSupportedPlatform: () => true,
        isDownloaded: () => false,
        hasDeclinedFirstRun: () => false,
        recordFirstRunDecline: () => calls.push("decline"),
        installPinnedCudaRuntime: async (options) => {
          calls.push(["install", options.consent]);
          return { success: true, verification: { ok: true, backend: "cuda", gpuUuid: "GPU-a" } };
        },
        isVerified: () => true,
      },
      verifier: {
        verify: async () => ({ ok: true, backend: "cuda", gpuUuid: "GPU-a", reason: "verified" }),
      },
      whisperManager: { getModelPath: () => "model.bin" },
      modelName: "large-v3-turbo",
      fileExists: () => true,
      detectGpu: async () => ({ hasNvidiaGpu: true, driverVersion: "1" }),
      listGpus: async () => [{ uuid: "GPU-a" }],
      showPrompt: async (options) => {
        calls.push(["prompt", options.message]);
        return { response: 1 };
      },
      persistEnabled: async (enabled) => calls.push(["enabled", enabled]),
      activateCuda: async ({ modelName }) => calls.push(["activate", modelName]),
      ...overrides,
    },
  };
}

test("decline is persisted and no download starts before or after refusal", async () => {
  const { calls, input } = dependencies();
  const result = await maybeOfferCudaWhisper(input);
  assert.equal(result.reason, "declined");
  assert.match(calls[0][1], /755 MB/);
  assert.deepEqual(calls.slice(1), ["decline"]);
});

test("acceptance invokes the pinned consent path and enables only verified CUDA", async () => {
  const { calls, input } = dependencies({
    showPrompt: async () => ({ response: 0 }),
  });
  const result = await maybeOfferCudaWhisper(input);
  assert.equal(result.enabled, true);
  assert.deepEqual(calls, [
    ["install", true],
    ["activate", "large-v3-turbo"],
    ["enabled", true],
  ]);
});

test("an already verified runtime restores CUDA activation without prompting again", async () => {
  const { calls, input } = dependencies({
    manager: {
      isSupportedPlatform: () => true,
      isDownloaded: () => true,
      hasDeclinedFirstRun: () => false,
      getVerifiedStartOptions: ({ enabled }) => ({
        useCuda: enabled === true,
        gpuUuid: "GPU-a",
      }),
    },
  });

  const result = await maybeOfferCudaWhisper(input);

  assert.deepEqual(result, {
    offered: false,
    enabled: true,
    reason: "already_verified",
  });
  assert.deepEqual(calls, [
    ["activate", "large-v3-turbo"],
    ["enabled", true],
  ]);
});

test("does not prompt without an installed local model", async () => {
  const { calls, input } = dependencies({ fileExists: () => false });
  const result = await maybeOfferCudaWhisper(input);
  assert.equal(result.reason, "model_missing");
  assert.deepEqual(calls, []);
});

test("uses an installed model when the configured default model is unavailable", async () => {
  const { calls, input } = dependencies({
    modelName: "base",
    whisperManager: {
      getModelPath: (modelName) => `${modelName}.bin`,
      listWhisperModels: async () => ({
        success: true,
        models: [
          { model: "base", downloaded: false },
          { model: "large-v3-turbo", downloaded: true },
        ],
      }),
    },
    fileExists: (filePath) => filePath === "large-v3-turbo.bin",
    showPrompt: async () => ({ response: 0 }),
  });

  const result = await maybeOfferCudaWhisper(input);

  assert.equal(result.enabled, true);
  assert.deepEqual(calls, [
    ["install", true],
    ["activate", "large-v3-turbo"],
    ["enabled", true],
  ]);
});
