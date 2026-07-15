const os = require("os");
const { execFile } = require("node:child_process");
const { sampleNvidiaGpuTelemetry } = require("../../utils/gpuDetection");

const RESOURCE_STATES = Object.freeze(["available", "busy", "constrained", "unavailable"]);
const ADMISSION_ACTIONS = Object.freeze(["run_cuda", "run_cpu", "defer", "pause_preview"]);
const JOB_PRIORITY = Object.freeze({
  retention_urgent: 0,
  storage_recovery_compress: 10,
  preview: 20,
  final_transcription: 30,
  speaker: 40,
  identity: 45,
  maintenance: 60,
  analysis: 70,
  daily_digest: 80,
});
const DEFAULT_SAMPLING_INTERVAL_MS = 15_000;
const DEFAULT_VRAM_SAFETY_MARGIN_MB = 1_024;
const MAX_CPU_FALLBACK_THREADS = 4;
const CPU_UNSAFE_LOAD_PCT = 90;
const GPU_UNSAFE_UTILIZATION_PCT = 90;
const CLOUD_BUSY_CPU_LOAD_PCT = 75;
const CLOUD_BUSY_MEMORY_LOAD_PCT = 80;
const CLOUD_UNSAFE_MEMORY_LOAD_PCT = 90;
const CLOUD_LOW_BATTERY_PCT = 20;
const WINDOWS_POWER_STATUS_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarvisPowerStatus {
  [StructLayout(LayoutKind.Sequential)]
  public struct SYSTEM_POWER_STATUS {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public uint BatteryLifeTime;
    public uint BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
}
'@
$status = New-Object JarvisPowerStatus+SYSTEM_POWER_STATUS
if (-not [JarvisPowerStatus]::GetSystemPowerStatus([ref]$status)) { exit 2 }
$onAcPower = if ($status.ACLineStatus -eq 1) { $true } elseif ($status.ACLineStatus -eq 0) { $false } else { $null }
$batteryPresent = $status.BatteryFlag -ne 128 -and $status.BatteryFlag -ne 255
$batteryLevelPct = if ($batteryPresent -and $status.BatteryLifePercent -ne 255) { [int]$status.BatteryLifePercent } else { $null }
[pscustomobject]@{
  onAcPower = $onAcPower
  batteryPresent = $batteryPresent
  batteryLevelPct = $batteryLevelPct
  batterySaver = [bool]($status.SystemStatusFlag -eq 1)
} | ConvertTo-Json -Compress
`;

function unknownCpuReading() {
  return { loadPct: null, telemetryAvailable: false };
}

function unknownMemoryReading() {
  return { loadPct: null, telemetryAvailable: false };
}

function normalizeMemoryReading(reading) {
  if (
    reading?.telemetryAvailable === false ||
    typeof reading?.loadPct !== "number" ||
    !Number.isFinite(reading.loadPct) ||
    reading.loadPct < 0 ||
    reading.loadPct > 100
  ) {
    return unknownMemoryReading();
  }
  return { loadPct: reading.loadPct, telemetryAvailable: true };
}

function createSystemMemoryProvider({
  memoryStatsProvider = () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }),
} = {}) {
  if (typeof memoryStatsProvider !== "function") {
    throw new TypeError("memoryStatsProvider must be a function");
  }
  return async () => {
    let reading;
    try {
      reading = memoryStatsProvider();
    } catch {
      return unknownMemoryReading();
    }
    const totalBytes = reading?.totalBytes;
    const freeBytes = reading?.freeBytes;
    if (
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isFinite(freeBytes) ||
      freeBytes < 0 ||
      freeBytes > totalBytes
    ) {
      return unknownMemoryReading();
    }
    return {
      loadPct: Math.max(0, Math.min(100, ((totalBytes - freeBytes) / totalBytes) * 100)),
      telemetryAvailable: true,
    };
  };
}

function summarizeCpuTimes(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu?.times;
    if (
      !times ||
      ![times.user, times.nice, times.sys, times.idle, times.irq].every(Number.isFinite)
    ) {
      return null;
    }
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function createWindowsCpuProvider({ cpuTimesProvider = () => os.cpus() } = {}) {
  if (typeof cpuTimesProvider !== "function") {
    throw new TypeError("cpuTimesProvider must be a function");
  }
  let previous = null;
  return async () => {
    const current = summarizeCpuTimes(cpuTimesProvider());
    if (!current) {
      previous = null;
      return unknownCpuReading();
    }
    if (!previous) {
      previous = current;
      return unknownCpuReading();
    }
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    previous = current;
    if (
      !Number.isFinite(totalDelta) ||
      totalDelta <= 0 ||
      idleDelta < 0 ||
      idleDelta > totalDelta
    ) {
      return unknownCpuReading();
    }
    const loadPct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
    return { loadPct, telemetryAvailable: true };
  };
}

function unknownPowerReading() {
  return {
    onAcPower: null,
    batteryPresent: null,
    batteryLevelPct: null,
    batterySaver: null,
    telemetryAvailable: false,
  };
}

function normalizePowerReading(reading) {
  const batteryLevelPct = reading?.batteryLevelPct;
  const batteryLevelKnown =
    typeof batteryLevelPct === "number" &&
    Number.isFinite(batteryLevelPct) &&
    batteryLevelPct >= 0 &&
    batteryLevelPct <= 100;
  const batteryPresent =
    typeof reading?.batteryPresent === "boolean"
      ? reading.batteryPresent
      : batteryLevelKnown
        ? true
        : null;
  if (
    reading?.telemetryAvailable === false ||
    typeof reading?.onAcPower !== "boolean" ||
    typeof reading?.batterySaver !== "boolean" ||
    typeof batteryPresent !== "boolean" ||
    (batteryPresent && !batteryLevelKnown)
  ) {
    return unknownPowerReading();
  }
  return {
    onAcPower: reading.onAcPower,
    batteryPresent,
    batteryLevelPct: batteryPresent ? batteryLevelPct : null,
    batterySaver: reading.batterySaver,
    telemetryAvailable: true,
  };
}

function createWindowsPowerProvider({
  platform = process.platform,
  execFileImpl = execFile,
  now = Date.now,
  cacheMs = 60_000,
} = {}) {
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(cacheMs) || cacheMs <= 0) {
    throw new RangeError("cacheMs must be a positive safe integer");
  }
  let latest = null;
  let sampledAt = null;
  let inFlight = null;
  return async () => {
    const at = now();
    if (latest && sampledAt !== null && at - sampledAt >= 0 && at - sampledAt < cacheMs) {
      return latest;
    }
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve) => {
      if (platform !== "win32") {
        resolve(unknownPowerReading());
        return;
      }
      execFileImpl(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWER_STATUS_SCRIPT],
        { timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(unknownPowerReading());
            return;
          }
          try {
            resolve(normalizePowerReading(JSON.parse(String(stdout).trim())));
          } catch {
            resolve(unknownPowerReading());
          }
        }
      );
    });
    try {
      latest = await inFlight;
      sampledAt = now();
      return latest;
    } finally {
      inFlight = null;
    }
  };
}

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

function projectCloudPressure(snapshot) {
  const cpuKnown =
    snapshot?.cpuTelemetryAvailable === true &&
    typeof snapshot?.cpuLoadPct === "number" &&
    Number.isFinite(snapshot.cpuLoadPct) &&
    snapshot.cpuLoadPct >= 0 &&
    snapshot.cpuLoadPct <= 100;
  const memoryKnown =
    snapshot?.memoryTelemetryAvailable === true &&
    typeof snapshot?.memoryLoadPct === "number" &&
    Number.isFinite(snapshot.memoryLoadPct) &&
    snapshot.memoryLoadPct >= 0 &&
    snapshot.memoryLoadPct <= 100;
  const powerKnown =
    snapshot?.powerTelemetryAvailable === true &&
    typeof snapshot?.onAcPower === "boolean" &&
    typeof snapshot?.batterySaver === "boolean";
  const batteryLevelPct = snapshot?.batteryLevelPct;
  const batteryLevelKnown =
    typeof batteryLevelPct === "number" &&
    Number.isFinite(batteryLevelPct) &&
    batteryLevelPct >= 0 &&
    batteryLevelPct <= 100;
  let state = "normal";
  let reason = null;
  if (snapshot?.batterySaver === true) {
    state = "battery_saver";
    reason = "battery_saver";
  } else if (!cpuKnown || !memoryKnown || !powerKnown) {
    state = "constrained";
    reason = "telemetry_unavailable";
  } else if (
    snapshot.onAcPower === false &&
    snapshot.batteryPresent === true &&
    (!batteryLevelKnown || batteryLevelPct <= CLOUD_LOW_BATTERY_PCT)
  ) {
    state = "constrained";
    reason = "low_battery";
  } else if (snapshot.cpuLoadPct >= CPU_UNSAFE_LOAD_PCT) {
    state = "constrained";
    reason = "cpu_load_high";
  } else if (snapshot.memoryLoadPct >= CLOUD_UNSAFE_MEMORY_LOAD_PCT) {
    state = "constrained";
    reason = "memory_pressure";
  } else if (snapshot.cpuLoadPct >= CLOUD_BUSY_CPU_LOAD_PCT) {
    state = "busy";
    reason = "cpu_busy";
  } else if (snapshot.memoryLoadPct >= CLOUD_BUSY_MEMORY_LOAD_PCT) {
    state = "busy";
    reason = "memory_busy";
  }
  return Object.freeze({
    state,
    reason,
    cpuLoadPct: cpuKnown ? snapshot.cpuLoadPct : null,
    memoryLoadPct: memoryKnown ? snapshot.memoryLoadPct : null,
    onAcPower: powerKnown ? snapshot.onAcPower : null,
    batteryLevelPct: powerKnown && batteryLevelKnown ? batteryLevelPct : null,
  });
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
    cpuProvider = null,
    memoryProvider = null,
    powerProvider = null,
    ownedPidsProvider = () => [process.pid],
    previewEnabled = true,
    safetyMarginMb = DEFAULT_VRAM_SAFETY_MARGIN_MB,
    sampleIntervalMs = DEFAULT_SAMPLING_INTERVAL_MS,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    const effectiveCpuProvider = cpuProvider ?? createWindowsCpuProvider();
    const effectiveMemoryProvider = memoryProvider ?? createSystemMemoryProvider();
    const effectivePowerProvider = powerProvider ?? createWindowsPowerProvider();
    for (const [name, provider] of Object.entries({
      telemetryProvider,
      cudaProvider,
      cpuProvider: effectiveCpuProvider,
      memoryProvider: effectiveMemoryProvider,
      powerProvider: effectivePowerProvider,
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
    this.cpuProvider = effectiveCpuProvider;
    this.memoryProvider = effectiveMemoryProvider;
    this.powerProvider = effectivePowerProvider;
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
    const [telemetryResult, cudaResult, cpuResult, memoryResult, powerResult] =
      await Promise.allSettled([
        this.telemetryProvider({ ownedPids }),
        this.cudaProvider(),
        this.cpuProvider(),
        this.memoryProvider(),
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
    const cpu = cpuResult.status === "fulfilled" ? cpuResult.value : unknownCpuReading();
    const memory =
      memoryResult.status === "fulfilled"
        ? normalizeMemoryReading(memoryResult.value)
        : unknownMemoryReading();
    const power =
      powerResult.status === "fulfilled"
        ? normalizePowerReading(powerResult.value)
        : unknownPowerReading();
    const selectedGpuUuid = cuda?.gpuUuid || null;
    const gpu = telemetry?.gpus?.find((candidate) => candidate.uuid === selectedGpuUuid) ?? null;
    const selectedProcesses = (telemetry?.processes ?? []).filter(
      (entry) => entry.gpuUuid === selectedGpuUuid
    );
    const owned = new Set(telemetry?.ownedPids ?? ownedPids ?? []);
    const externalGpuBusy = selectedProcesses.some((entry) => !owned.has(entry.pid));
    const cpuLoadPct = cpu?.loadPct;
    const cpuTelemetryAvailable =
      cpu?.telemetryAvailable !== false &&
      typeof cpuLoadPct === "number" &&
      Number.isFinite(cpuLoadPct) &&
      cpuLoadPct >= 0 &&
      cpuLoadPct <= 100;
    const gpuTelemetryValid = Boolean(
      gpu &&
      Number.isFinite(gpu.utilizationPct) &&
      gpu.utilizationPct >= 0 &&
      gpu.utilizationPct <= 100 &&
      Number.isFinite(gpu.totalVramMb) &&
      gpu.totalVramMb >= 0 &&
      Number.isFinite(gpu.usedVramMb) &&
      gpu.usedVramMb >= 0 &&
      Number.isFinite(gpu.freeVramMb) &&
      gpu.freeVramMb >= 0
    );

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
      !gpuTelemetryValid
    ) {
      candidateState = "constrained";
      reason = "telemetry_unavailable";
    } else if (externalGpuBusy) {
      candidateState = "busy";
      reason = "external_gpu_busy";
    } else if (!cpuTelemetryAvailable || power.telemetryAvailable !== true) {
      candidateState = "constrained";
      reason = "telemetry_unavailable";
    } else if (power.batterySaver === true) {
      candidateState = "constrained";
      reason = "battery_saver";
    } else if (gpu.utilizationPct >= GPU_UNSAFE_UTILIZATION_PCT) {
      candidateState = "constrained";
      reason = "gpu_utilization_high";
    } else if (cpuLoadPct >= CPU_UNSAFE_LOAD_PCT) {
      candidateState = "constrained";
      reason = "cpu_load_high";
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
      cpuLoadPct: cpuTelemetryAvailable ? cpuLoadPct : null,
      cpuTelemetryAvailable,
      memoryLoadPct: memory.loadPct,
      memoryTelemetryAvailable: memory.telemetryAvailable,
      onAcPower: power.onAcPower,
      batteryPresent: power.batteryPresent,
      batteryLevelPct: power.batteryLevelPct,
      batterySaver: power.batterySaver,
      powerTelemetryAvailable: power.telemetryAvailable,
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

  cloudPressure(snapshot = this.latestSnapshot) {
    return projectCloudPressure(snapshot);
  }

  admit(kind, snapshot = this.latestSnapshot, capability = undefined) {
    if (!snapshot || !RESOURCE_STATES.includes(snapshot.state)) {
      throw new Error("resource snapshot is required");
    }
    if (kind === "speaker" && capability?.available === false) {
      const reason = capability.unavailableReason;
      return {
        action: "defer",
        reason:
          typeof reason === "string" && /^[a-z0-9_]{1,128}$/.test(reason)
            ? reason
            : "diarization_model_unavailable",
      };
    }
    const storageCritical = new Set(["retention_urgent", "storage_recovery_compress"]);
    const cpuReadingValid =
      Number.isFinite(snapshot.cpuLoadPct) &&
      snapshot.cpuLoadPct >= 0 &&
      snapshot.cpuLoadPct <= 100;
    const cpuTelemetryKnown = snapshot.cpuTelemetryAvailable === true && cpuReadingValid;
    const cpuSafe = cpuReadingValid && snapshot.cpuLoadPct < CPU_UNSAFE_LOAD_PCT;
    const powerKnown = snapshot.powerTelemetryAvailable === true;
    const cpuOnlySpeaker = kind === "speaker" && capability?.executionDevice === "cpu";
    if (snapshot.batterySaver === true) {
      if (kind === "storage_recovery_compress" && cpuSafe && powerKnown) {
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
      if (storageCritical.has(kind) && cpuSafe && powerKnown) {
        return { action: "run_cpu", reason: "storage_critical" };
      }
      return {
        action: kind === "preview" ? "pause_preview" : "defer",
        reason: snapshot.reason || "resources_constrained",
      };
    }
    if (snapshot.state === "unavailable") {
      if (storageCritical.has(kind) && cpuSafe && powerKnown) {
        return { action: "run_cpu", reason: "storage_critical" };
      }
      if (kind === "preview") {
        if (snapshot.previewEnabled === false) {
          return { action: "pause_preview", reason: "preview_disabled" };
        }
        if (!cpuTelemetryKnown || !powerKnown || snapshot.batterySaver !== false) {
          return { action: "pause_preview", reason: "telemetry_unavailable" };
        }
        if (!cpuSafe) return { action: "pause_preview", reason: "cpu_load_high" };
        return { action: "run_cpu", reason: "cuda_unavailable" };
      }
      if (cpuOnlySpeaker) {
        if (!cpuTelemetryKnown || !powerKnown || snapshot.batterySaver !== false) {
          return { action: "defer", reason: "telemetry_unavailable" };
        }
        if (!cpuSafe) return { action: "defer", reason: "cpu_load_high" };
        return { action: "run_cpu", reason: "cuda_unavailable_cpu_backend" };
      }
      return { action: "defer", reason: "cuda_unavailable" };
    }
    if (cpuOnlySpeaker) {
      if (!cpuTelemetryKnown || !powerKnown || snapshot.batterySaver !== false) {
        return { action: "defer", reason: "telemetry_unavailable" };
      }
      if (!cpuSafe) return { action: "defer", reason: "cpu_load_high" };
      return { action: "run_cpu", reason: "cpu_backend" };
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
module.exports.CPU_UNSAFE_LOAD_PCT = CPU_UNSAFE_LOAD_PCT;
module.exports.GPU_UNSAFE_UTILIZATION_PCT = GPU_UNSAFE_UTILIZATION_PCT;
module.exports.createWindowsCpuProvider = createWindowsCpuProvider;
module.exports.createSystemMemoryProvider = createSystemMemoryProvider;
module.exports.createWindowsPowerProvider = createWindowsPowerProvider;
module.exports.projectCloudPressure = projectCloudPressure;
