async function activateVerifiedCudaRuntime({
  whisperManager,
  modelName,
  gpuUuid,
  setEnabled = async () => {},
}) {
  if (!whisperManager || !modelName) {
    await setEnabled(false);
    return { enabled: false, error: "A local Whisper model is required" };
  }
  await whisperManager.stopServer().catch(() => {});
  try {
    await whisperManager.startServer(modelName, {
      useCuda: true,
      requireCuda: true,
      gpuUuid,
    });
    if (whisperManager.getServerStatus()?.backend !== "cuda") {
      throw new Error("CUDA runtime started without CUDA backend proof");
    }
    await setEnabled(true);
    return { enabled: true, error: null };
  } catch (error) {
    await whisperManager.stopServer().catch(() => {});
    await whisperManager.startServer(modelName, { useCuda: false }).catch(() => {});
    await setEnabled(false);
    return { enabled: false, error: error.message };
  }
}

async function startWhisperServerWithVerifiedCuda({
  whisperManager,
  cudaManager,
  modelName,
  gpuUuid,
}) {
  const startOptions = cudaManager?.getVerifiedStartOptions(
    gpuUuid === undefined ? undefined : { gpuUuid: gpuUuid || null }
  ) || { useCuda: false, gpuUuid: null };
  return whisperManager.startServer(modelName, startOptions);
}

module.exports = { activateVerifiedCudaRuntime, startWhisperServerWithVerifiedCuda };
