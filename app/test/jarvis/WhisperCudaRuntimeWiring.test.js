const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WhisperManager = require("../../src/helpers/whisper");

const appRoot = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

test("startup and IPC gate CUDA on verification and inject the data-root resolver", () => {
  const main = read("main.js");
  const ipc = read("src/helpers/ipcHandlers.js");
  assert.match(
    main,
    /setCudaBinaryResolver\(\(\)\s*=>\s*\n?\s*whisperCudaManager\.getCudaBinaryPath\(\)/
  );
  assert.match(main, /whisperCudaManager\?\.getVerifiedStartOptions\(\)/);
  assert.match(main, /resolveJarvisWhisperModel\(\{/);
  assert.match(main, /modelName:\s*resolveConfiguredJarvisWhisperModel\(\)/);
  assert.match(main, /ownedPidsProvider:\s*jarvisOwnedPidsProvider/);
  assert.match(ipc, /startWhisperServerWithVerifiedCuda\(\{/);
  assert.doesNotMatch(
    ipc,
    /WHISPER_CUDA_ENABLED === "true" && this\.whisperCudaManager\?\.isDownloaded\(\)/
  );
  assert.match(ipc, /verifyInstalledCudaRuntime\(verification\)/);
  assert.match(ipc, /installPinnedCudaRuntime\(\{/);
  assert.match(ipc, /currentStatus\.path/);
  assert.match(ipc, /rollback-cuda-whisper-binary/);
  assert.match(read("src/jarvis/main/CudaWhisperActivation.js"), /requireCuda: true/);
});

test("renderer distinguishes installed from verified CUDA in settings and quick entry", () => {
  const picker = read("src/components/TranscriptionModelPicker.tsx");
  const control = read("src/components/ControlPanel.tsx");
  assert.match(picker, /cudaStatus\.verified \? \(/);
  assert.match(picker, /cudaStatus\.downloaded \? t\("gpu\.retry"\)/);
  assert.match(control, /!status\.verified/);
  assert.match(picker, /rollbackCudaWhisperBinary/);
  assert.match(read("preload.js"), /rollback-cuda-whisper-binary/);
});

test("runtime installer has no latest-release executable selection", () => {
  const manager = read("src/helpers/whisperCudaManager.js");
  assert.doesNotMatch(manager, /releases\/latest|fetchJson/);
  assert.match(manager, /getWhisperCudaDownloadUrl\(this\.manifest\)/);
});

test("startup forwards the verified GPU UUID to whisper-server", async (t) => {
  const model = path.join(__dirname, "startup-model.bin");
  fs.writeFileSync(model, "model");
  t.after(() => fs.rmSync(model, { force: true }));

  const starts = [];
  const manager = new WhisperManager();
  manager.getModelPath = () => model;
  manager.logDependencyStatus = async () => {};
  manager.serverManager = {
    isAvailable: () => true,
    start: async (_modelPath, options) => starts.push(options),
    ready: false,
    port: 8178,
  };

  await manager.initializeAtStartup({
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    useCuda: true,
    gpuUuid: "GPU-verified-pointer",
  });

  assert.deepEqual(starts, [{ useCuda: true, gpuUuid: "GPU-verified-pointer" }]);
});

test("normal transcription restart retains the verified GPU UUID", async () => {
  const starts = [];
  const manager = new WhisperManager();
  manager.getModelPath = () => "model.bin";
  manager.serverManager = {
    useCuda: true,
    selectedGpuUuid: "GPU-verified-pointer",
    lastStartOptions: { gpuUuid: "GPU-verified-pointer" },
    start: async (_modelPath, options) => starts.push(options),
    transcribe: async () => ({ text: "ok" }),
  };

  const result = await manager._runServerTranscription(Buffer.from("wav"), "base", "auto");

  assert.equal(result.text, "ok");
  assert.equal(starts[0].gpuUuid, "GPU-verified-pointer");
});
