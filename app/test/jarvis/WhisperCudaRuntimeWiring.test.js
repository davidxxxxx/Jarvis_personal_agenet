const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

test("startup and IPC gate CUDA on verification and inject the data-root resolver", () => {
  const main = read("main.js");
  const ipc = read("src/helpers/ipcHandlers.js");
  assert.match(
    main,
    /setCudaBinaryResolver\(\(\)\s*=>\s*\n?\s*whisperCudaManager\.getCudaBinaryPath\(\)/
  );
  assert.match(main, /WHISPER_CUDA_ENABLED === "true" && whisperCudaManager\?\.isVerified\(\)/);
  assert.match(
    ipc,
    /WHISPER_CUDA_ENABLED === "true" && this\.whisperCudaManager\?\.isVerified\(\)/
  );
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
