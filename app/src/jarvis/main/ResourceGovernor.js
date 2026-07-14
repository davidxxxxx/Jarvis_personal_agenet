const os = require("os");
const { sampleNvidiaGpuTelemetry } = require("../../utils/gpuDetection");

const RESOURCE_STATES = Object.freeze(["available", "busy", "constrained", "unavailable"]);
const ADMISSION_ACTIONS = Object.freeze(["run_cuda", "run_cpu", "defer", "pause_preview"]);
const JOB_PRIORITY = Object.freeze({
  retention_urgent: 0,
  storage_recovery_compress: 10,
  preview: 20,
  final_transcription: 30,
  speaker: 40,
  analysis: 50,
  maintenance: 60,
});
const DEFAULT_SAMPLING_INTERVAL_MS = 15_000;
const DEFAULT_VRAM_SAFETY_MARGIN_MB = 1_024;
const MAX_CPU_FALLBACK_THREADS = 4;
const CPU_UNSAFE_LOAD_PCT = 90;

function orderJobs(kinds) {
  return kinds
    .map((kind, index) => ({ kind, index }))
    .sort(
      (left, right) =>
        (JOB_PRIORITY[left.kind] ?? Number.MAX_SAFE_INTEGER) -
          (JOB_PRIORITY[right.kind] ?? Number.MAX_SAFE_INTEGER) || left.index - right.index
    )
    .map(({ kind }) => kind);
}

class ResourceGovernor {
  constructor({
    now = Date.now,
    telemetryProvider = ({ ownedPids }) => sampleNvidiaGpuTelemetry({ ownedPids }),
    cudaProvider = async () => ({
      installed: false,
      verified: false,
      quarantined: false,
      gpuUuid: null,
      peakVramMb: null,
    }),
    cpuProvider = async () => ({
      loadPct: Math.min(100, (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100),
    }),
    powerProvider = async () => ({ onAcPower: null, batteryLevelPct: null, batterySaver: false }),
    ownedPidsProvider = () => [process.pid],
    previewEnabled = true,
    safetyMarginMb = DEFAULT_VRAM_SAFETY_MARGIN_MB,
    sampleIntervalMs = DEFAULT_SAMPLING_INTERVAL_MS,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    for (const [name, provider] of Object.entries({
      telemetryProvider,
      cudaProvider,
      cpuProvider,
      powerProvider,
      ownedPidsProvider,
    })) {
      if (typeof provider !== "function") throw new TypeError(`${name} must be a function`);
    }
    if (!Number.isSafeInteger(safetyMarginMb) || safetyMarginMb < 0) {
      throw new RangeError("safetyMarginMb must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs <= 0) {
      throw new RangeError("sampleIntervalMs must be a positive safe integer");
    }
    this.now = now;
    this.telemetryProvider = telemetryProvider;
    this.cudaProvider = cudaProvider;
    this.cpuProvider = cpuProvider;
    this.powerProvider = powerProvider;
    this.ownedPidsProvider = ownedPidsProvider;
    this.previewEnabled = previewEnabled !== false;
    this.safetyMarginMb = safetyMarginMb;
    this.sampleIntervalMs = sampleIntervalMs;
    this.latestSnapshot = null;
    this.restrictiveSince = null;
    this.healthySamples = 0;
  }

  async sample() {
    const sampledAt = this.now();
    const elapsed = sampledAt - (this.latestSnapshot?.sampledAt ?? sampledAt);
    if (this.latestSnapshot && elapsed >= 0 && elapsed < this.sampleIntervalMs) {
      return this.latestSnapshot;
    }
    const ownedPids = this.ownedPidsProvider();
    const [telemetryResult, cudaResult, cpuResult, powerResult] = await Promise.allSettled([
      this.telemetryProvider({ ownedPids }),
      this.cudaProvider(),
      this.cpuProvider(),
      this.powerProvider(),
    ]);
    const telemetry =
      telemetryResult.status === "fulfilled"
        ? telemetryResult.value
        : {
            telemetryAvailable: false,
            processTelemetryAvailable: false,
            gpus: [],
            processes: [],
            ownedPids,
            externalGpuBusy: false,
            error: "telemetry_unavailable",
          };
    const cuda =
      cudaResult.status === "fulfilled"
        ? cudaResult.value
        : {
            installed: false,
            verified: false,
            quarantined: false,
            gpuUuid: null,
            peakVramMb: null,
          };
    const cpu = cpuResult.status === "fulfilled" ? cpuResult.value : { loadPct: null };
    const power =
      powerResult.status === "fulfilled"
        ? powerResult.value
        : { onAcPower: null, batteryLevelPct: null, batterySaver: false };
    const selectedGpuUuid = cuda?.gpuUuid || null;
    const gpu = telemetry?.gpus?.find((candidate) => candidate.uuid === selectedGpuUuid) ?? null;
    const selectedProcesses = (telemetry?.processes ?? []).filter(
      (entry) => entry.gpuUuid === selectedGpuUuid
    );
    const owned = new Set(telemetry?.ownedPids ?? ownedPids ?? []);
    const externalGpuBusy = selectedProcesses.some((entry) => !owned.has(entry.pid));

    let candidateState = "available";
    let reason = "resources_available";
    if (
      cuda?.installed !== true ||
      cuda?.verified !== true ||
      cuda?.quarantined === true ||
      !selectedGpuUuid
    ) {
      candidateState = "unavailable";
      reason = "cuda_unavailable";
    } else if (
      telemetry?.telemetryAvailable !== true ||
      telemetry?.processTelemetryAvailable !== true ||
      !gpu
    ) {
      candidateState = "constrained";
      reason = "telemetry_unavailable";
    } else if (externalGpuBusy) {
      candidateState = "busy";
      reason = "external_gpu_busy";
    } else if (power?.batterySaver === true) {
      candidateState = "constrained";
      reason = "battery_saver";
    } else if (cpuResult.status !== "fulfilled" || powerResult.status !== "fulfilled") {
      candidateState = "constrained";
      reason = "telemetry_unavailable";
    } else if (
      !Number.isFinite(cuda?.peakVramMb) ||
      gpu.freeVramMb < cuda.peakVramMb + this.safetyMarginMb
    ) {
      candidateState = "constrained";
      reason = "insufficient_vram";
    }

    let state = candidateState;
    if (candidateState === "available") {
      this.healthySamples += 1;
      if (this.healthySamples < 2) {
        state = "constrained";
        reason = "recovery_hysteresis";
        if (this.restrictiveSince === null) this.restrictiveSince = sampledAt;
      } else {
        this.restrictiveSince = null;
      }
    } else {
      this.healthySamples = 0;
      if (this.restrictiveSince === null) this.restrictiveSince = sampledAt;
    }

    const snapshot = {
      sampledAt,
      state,
      reason,
      selectedGpuUuid,
      gpuUtilizationPct: gpu?.utilizationPct ?? null,
      totalVramMb: gpu?.totalVramMb ?? null,
      usedVramMb: gpu?.usedVramMb ?? null,
      freeVramMb: gpu?.freeVramMb ?? null,
      externalGpuBusy,
      cpuLoadPct: Number.isFinite(cpu?.loadPct) ? cpu.loadPct : null,
      onAcPower: typeof power?.onAcPower === "boolean" ? power.onAcPower : null,
      batteryLevelPct: Number.isFinite(power?.batteryLevelPct) ? power.batteryLevelPct : null,
      batterySaver: power?.batterySaver === true,
      cudaInstalled: cuda?.installed === true,
      cudaVerified: cuda?.verified === true,
      cudaQuarantined: cuda?.quarantined === true,
      peakVramMb: Number.isFinite(cuda?.peakVramMb) ? cuda.peakVramMb : null,
      safetyMarginMb: this.safetyMarginMb,
      processTelemetryAvailable: telemetry?.processTelemetryAvailable === true,
      telemetryAvailable: telemetry?.telemetryAvailable === true,
      previewEnabled: this.previewEnabled,
      restrictiveForMs:
        state === "available" || this.restrictiveSince === null
          ? 0
          : Math.max(0, sampledAt - this.restrictiveSince),
    };
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  admit(kind, snapshot = this.latestSnapshot) {
    if (!snapshot || !RESOURCE_STATES.includes(snapshot.state)) {
      throw new Error("resource snapshot is required");
    }
    const storageCritical = new Set(["retention_urgent", "storage_recovery_compress"]);
    if (snapshot.batterySaver === true) {
      if (storageCritical.has(kind) && (snapshot.cpuLoadPct ?? 0) < CPU_UNSAFE_LOAD_PCT) {
        return { action: "run_cpu", reason: "storage_critical" };
      }
      return {
        action: kind === "preview" ? "pause_preview" : "defer",
        reason: "battery_saver",
      };
    }
    if (snapshot.state === "busy" || snapshot.externalGpuBusy === true) {
      return {
        action: kind === "preview" ? "pause_preview" : "defer",
        reason: "external_gpu_busy",
      };
    }
    if (snapshot.state === "constrained") {
      if (storageCritical.has(kind) && (snapshot.cpuLoadPct ?? 0) < CPU_UNSAFE_LOAD_PCT) {
        return { action: "run_cpu", reason: "storage_critical" };
      }
      return {
        action: kind === "preview" ? "pause_preview" : "defer",
        reason: snapshot.reason || "resources_constrained",
      };
    }
    if (snapshot.state === "unavailable") {
      if (storageCritical.has(kind)) return { action: "run_cpu", reason: "storage_critical" };
      if (kind === "preview") {
        return snapshot.previewEnabled === false
          ? { action: "pause_preview", reason: "preview_disabled" }
          : { action: "run_cpu", reason: "cuda_unavailable" };
      }
      return { action: "defer", reason: "cuda_unavailable" };
    }
    if (["preview", "final_transcription", "speaker"].includes(kind)) {
      return { action: "run_cuda", reason: "resources_available" };
    }
    if (
      ["storage_recovery_compress", "retention_urgent", "analysis", "maintenance"].includes(kind)
    ) {
      return { action: "run_cpu", reason: "resources_available" };
    }
    return { action: "defer", reason: "unsupported_job_kind" };
  }
}

module.exports = ResourceGovernor;
module.exports.ResourceGovernor = ResourceGovernor;
module.exports.RESOURCE_STATES = RESOURCE_STATES;
module.exports.ADMISSION_ACTIONS = ADMISSION_ACTIONS;
module.exports.JOB_PRIORITY = JOB_PRIORITY;
module.exports.orderJobs = orderJobs;
module.exports.DEFAULT_SAMPLING_INTERVAL_MS = DEFAULT_SAMPLING_INTERVAL_MS;
module.exports.DEFAULT_VRAM_SAFETY_MARGIN_MB = DEFAULT_VRAM_SAFETY_MARGIN_MB;
module.exports.MAX_CPU_FALLBACK_THREADS = MAX_CPU_FALLBACK_THREADS;
