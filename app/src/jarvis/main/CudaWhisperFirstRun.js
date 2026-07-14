const fs = require("node:fs");

async function maybeOfferCudaWhisper({
  manager,
  verifier,
  whisperManager,
  modelName,
  selectedGpuUuid = process.env.TRANSCRIPTION_GPU_UUID || null,
  fileExists = fs.existsSync,
  detectGpu,
  listGpus,
  showPrompt,
  persistEnabled,
  activateCuda = async () => {},
}) {
  try {
    if (!manager?.isSupportedPlatform?.())
      return { offered: false, reason: "platform_unsupported" };
    if (manager.isDownloaded() || manager.hasDeclinedFirstRun()) {
      return {
        offered: false,
        reason: manager.isDownloaded() ? "already_installed" : "previously_declined",
      };
    }
    if (!modelName || !whisperManager?.getModelPath)
      return { offered: false, reason: "model_missing" };
    let modelPath;
    try {
      modelPath = whisperManager.getModelPath(modelName);
    } catch {
      return { offered: false, reason: "model_missing" };
    }
    if (!fileExists(modelPath)) return { offered: false, reason: "model_missing" };
    const [gpuInfo, gpuList] = await Promise.all([detectGpu(), listGpus()]);
    if (!gpuInfo?.hasNvidiaGpu) return { offered: false, reason: "nvidia_gpu_missing" };
    const gpuUuid = selectedGpuUuid || gpuList.find((gpu) => gpu.uuid)?.uuid || null;
    if (!gpuUuid) return { offered: false, reason: "gpu_uuid_missing" };
    const prompt = await showPrompt({
      type: "question",
      buttons: ["Install", "Not now"],
      defaultId: 0,
      cancelId: 1,
      title: "Enable CUDA transcription",
      message: "Download the pinned CUDA Whisper runtime (approximately 755 MB)?",
      detail:
        "Jarvis will verify a real inference on the selected NVIDIA GPU. If verification fails, recording remains available with CPU fallback.",
      noLink: true,
    });
    if (prompt?.response !== 0) {
      manager.recordFirstRunDecline();
      return { offered: true, enabled: false, reason: "declined" };
    }
    const verification = {
      verify: (input) => verifier.verify(input),
      getMetadata: () => verifier.getLastProofMetadata(),
      modelPath,
      gpuUuid,
      driver: gpuInfo.driverVersion || null,
      modelId: modelName,
    };
    const installed = await manager.installPinnedCudaRuntime({ consent: true, verification });
    const enabled =
      installed?.verification?.ok === true && manager.isVerified({ gpuUuid }) === true;
    if (enabled) await activateCuda({ modelName, gpuUuid });
    await persistEnabled(enabled);
    return {
      offered: true,
      enabled,
      reason: enabled ? "verified" : installed?.verification?.reason || "verification_failed",
    };
  } catch (error) {
    await Promise.resolve(persistEnabled(false)).catch(() => {});
    return { offered: true, enabled: false, reason: error?.code || "cuda_offer_failed" };
  }
}

module.exports = { maybeOfferCudaWhisper };
