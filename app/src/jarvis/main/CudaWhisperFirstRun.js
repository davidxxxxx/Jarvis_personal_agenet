const fs = require("node:fs");

async function resolveInstalledWhisperModel({
  whisperManager,
  modelName,
  fileExists = fs.existsSync,
}) {
  if (typeof whisperManager?.getModelPath !== "function") return null;
  const tryModel = (candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) return null;
    const normalized = candidate.trim();
    try {
      const modelPath = whisperManager.getModelPath(normalized);
      return fileExists(modelPath) ? { modelName: normalized, modelPath } : null;
    } catch {
      return null;
    }
  };

  const preferred = tryModel(modelName);
  if (preferred) return preferred;
  if (typeof whisperManager.listWhisperModels !== "function") return null;

  let inventory;
  try {
    inventory = await whisperManager.listWhisperModels();
  } catch {
    return null;
  }
  for (const candidate of inventory?.models ?? []) {
    if (candidate?.downloaded !== true) continue;
    const resolved = tryModel(candidate.model);
    if (resolved) return resolved;
  }
  return null;
}

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
    const installedModel = await resolveInstalledWhisperModel({
      whisperManager,
      modelName,
      fileExists,
    });
    if (!installedModel) return { offered: false, reason: "model_missing" };
    const { modelName: resolvedModelName, modelPath } = installedModel;
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
      modelId: resolvedModelName,
    };
    const installed = await manager.installPinnedCudaRuntime({ consent: true, verification });
    const enabled =
      installed?.verification?.ok === true && manager.isVerified({ gpuUuid }) === true;
    if (enabled) await activateCuda({ modelName: resolvedModelName, gpuUuid });
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
module.exports.resolveInstalledWhisperModel = resolveInstalledWhisperModel;
