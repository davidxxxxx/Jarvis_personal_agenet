const { execFile } = require("child_process");

let cachedGpuInfo = null;

function detectNvidiaGpu() {
  if (cachedGpuInfo) return Promise.resolve(cachedGpuInfo);

  if (process.platform === "darwin") {
    cachedGpuInfo = { hasNvidiaGpu: false };
    return Promise.resolve(cachedGpuInfo);
  }

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          cachedGpuInfo = { hasNvidiaGpu: false };
          resolve(cachedGpuInfo);
          return;
        }

        const parts = stdout
          .trim()
          .split(",")
          .map((s) => s.trim());
        if (parts.length < 3) {
          cachedGpuInfo = { hasNvidiaGpu: false };
          resolve(cachedGpuInfo);
          return;
        }

        cachedGpuInfo = {
          hasNvidiaGpu: true,
          gpuName: parts[0],
          driverVersion: parts[1],
          vramMb: parseInt(parts[2], 10) || undefined,
        };
        resolve(cachedGpuInfo);
      }
    );
  });
}

let cachedGpuList = null;

const LIVE_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_ACTIVE_GPU_PROCESS_MIN_PCT = 10;
const WINDOWS_GPU_ENGINE_QUERY = String.raw`
$ErrorActionPreference = "Stop"
$totals = @{}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
  ForEach-Object {
    if ($_.Name -match "^pid_(\d+)_" -and $_.UtilizationPercentage -ne $null) {
      $pidValue = [int]$Matches[1]
      $utilization = [double]$_.UtilizationPercentage
      if (-not $totals.ContainsKey($pidValue)) { $totals[$pidValue] = 0.0 }
      $totals[$pidValue] += $utilization
    }
  }
$totals.GetEnumerator() |
  Sort-Object Name |
  ForEach-Object {
    $bounded = [Math]::Min(100, [Math]::Max(0, [Math]::Round([double]$_.Value)))
    [Console]::Out.WriteLine(("{0},{1}" -f $_.Key, $bounded))
  }
`;

function parseInteger(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNvidiaSmiTelemetry({
  gpuOutput,
  processOutput = "",
  ownedPids = [],
  processTelemetryAvailable = true,
} = {}) {
  const gpus = String(gpuOutput ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(",").map((field) => field.trim());
      if (fields.length !== 8) return null;
      const [index, uuid, name, driverVersion, utilization, total, used, free] = fields;
      const values = {
        index: parseInteger(index),
        utilizationPct: parseInteger(utilization),
        totalVramMb: parseInteger(total),
        usedVramMb: parseInteger(used),
        freeVramMb: parseInteger(free),
      };
      if (
        Object.values(values).some((value) => value === null) ||
        !uuid ||
        !name ||
        !driverVersion ||
        values.utilizationPct > 100 ||
        values.usedVramMb > values.totalVramMb ||
        values.freeVramMb > values.totalVramMb ||
        values.usedVramMb + values.freeVramMb > values.totalVramMb
      ) {
        return null;
      }
      return { ...values, uuid, name, driverVersion };
    })
    .filter(Boolean);

  if (gpus.length === 0) {
    return {
      telemetryAvailable: false,
      processTelemetryAvailable: false,
      gpus: [],
      processes: [],
      ownedPids: [],
      externalGpuBusy: false,
      error: "invalid_gpu_telemetry",
    };
  }

  const knownGpuUuids = new Set(gpus.map((gpu) => gpu.uuid));
  const processes = [];
  if (processTelemetryAvailable) {
    for (const line of String(processOutput ?? "")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)) {
      const fields = line.split(",").map((field) => field.trim());
      const pid = parseInteger(fields[0]);
      const usedVramMb = parseInteger(fields[2]);
      if (
        fields.length !== 3 ||
        pid === null ||
        !knownGpuUuids.has(fields[1]) ||
        usedVramMb === null
      ) {
        return {
          telemetryAvailable: false,
          processTelemetryAvailable: false,
          gpus,
          processes: [],
          ownedPids: [],
          externalGpuBusy: false,
          error: "invalid_process_telemetry",
        };
      }
      processes.push({ pid, gpuUuid: fields[1], usedVramMb });
    }
  }

  const normalizedOwnedPids = [...new Set(ownedPids.filter((pid) => parseInteger(pid) === pid))];
  const owned = new Set(normalizedOwnedPids);
  const available = processTelemetryAvailable === true;
  return {
    telemetryAvailable: available,
    processTelemetryAvailable: available,
    gpus,
    processes,
    ownedPids: normalizedOwnedPids,
    externalGpuBusy: available && processes.some((entry) => !owned.has(entry.pid)),
    ...(available ? {} : { error: "process_telemetry_unavailable" }),
  };
}

function parseWindowsGpuEngineTelemetry(output) {
  const utilizationByPid = new Map();
  for (const line of String(output ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)) {
    const fields = line.split(",").map((field) => field.trim());
    const pid = parseInteger(fields[0]);
    const utilizationPct = parseInteger(fields[1]);
    if (fields.length !== 2 || pid === null || utilizationPct === null || utilizationPct > 100) {
      return null;
    }
    utilizationByPid.set(pid, utilizationPct);
  }
  return utilizationByPid;
}

function parseNvidiaProcessIdentities(processOutput, knownGpuUuids) {
  const identities = [];
  for (const line of String(processOutput ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)) {
    const fields = line.split(",").map((field) => field.trim());
    const pid = parseInteger(fields[0]);
    if (fields.length !== 3 || pid === null || !knownGpuUuids.has(fields[1])) {
      return null;
    }
    identities.push({
      pid,
      gpuUuid: fields[1],
      usedVramMb: parseInteger(fields[2]),
    });
  }
  return identities;
}

function execNvidiaQuery(execFileImpl, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "nvidia-smi",
      args,
      { timeout: LIVE_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function execWindowsGpuEngineQuery(execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GPU_ENGINE_QUERY],
      { timeout: LIVE_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function buildWindowsWddmTelemetry({
  parsed,
  processOutput,
  engineOutput,
  ownedPids,
  activeProcessMinPct = WINDOWS_ACTIVE_GPU_PROCESS_MIN_PCT,
}) {
  const knownGpuUuids = new Set(parsed.gpus.map((gpu) => gpu.uuid));
  const identities = parseNvidiaProcessIdentities(processOutput, knownGpuUuids);
  const utilizationByPid = parseWindowsGpuEngineTelemetry(engineOutput);
  if (!identities || !utilizationByPid) return parsed;

  const normalizedOwnedPids = [...new Set(ownedPids.filter((pid) => parseInteger(pid) === pid))];
  const owned = new Set(normalizedOwnedPids);
  const processes = identities
    .map((identity) => ({
      ...identity,
      usedVramMb: identity.usedVramMb ?? 0,
      utilizationPct: utilizationByPid.get(identity.pid) ?? 0,
    }))
    .filter((entry) => entry.utilizationPct >= activeProcessMinPct);
  return {
    telemetryAvailable: true,
    processTelemetryAvailable: true,
    gpus: parsed.gpus,
    processes,
    ownedPids: normalizedOwnedPids,
    externalGpuBusy: processes.some((entry) => !owned.has(entry.pid)),
    telemetrySource: "windows_wddm",
  };
}

async function sampleNvidiaGpuTelemetry({
  execFileImpl = execFile,
  ownedPids = [],
  platform = process.platform,
} = {}) {
  let gpuOutput;
  try {
    gpuOutput = await execNvidiaQuery(execFileImpl, [
      "--query-gpu=index,uuid,name,driver_version,utilization.gpu,memory.total,memory.used,memory.free",
      "--format=csv,noheader,nounits",
    ]);
  } catch {
    return {
      telemetryAvailable: false,
      processTelemetryAvailable: false,
      gpus: [],
      processes: [],
      ownedPids: [],
      externalGpuBusy: false,
      error: "gpu_telemetry_unavailable",
    };
  }

  let processOutput = "";
  let processTelemetryAvailable = true;
  try {
    processOutput = await execNvidiaQuery(execFileImpl, [
      "--query-compute-apps=pid,gpu_uuid,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ]);
  } catch {
    processTelemetryAvailable = false;
  }
  const parsed = parseNvidiaSmiTelemetry({
    gpuOutput,
    processOutput,
    ownedPids,
    processTelemetryAvailable,
  });
  if (
    platform !== "win32" ||
    parsed.telemetryAvailable === true ||
    parsed.error !== "invalid_process_telemetry"
  ) {
    return parsed;
  }

  try {
    const engineOutput = await execWindowsGpuEngineQuery(execFileImpl);
    return buildWindowsWddmTelemetry({
      parsed,
      processOutput,
      engineOutput,
      ownedPids,
    });
  } catch {
    return parsed;
  }
}

function listNvidiaGpus() {
  if (cachedGpuList) return Promise.resolve(cachedGpuList);

  if (process.platform === "darwin") {
    cachedGpuList = [];
    return Promise.resolve(cachedGpuList);
  }

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          cachedGpuList = [];
          resolve(cachedGpuList);
          return;
        }

        const gpus = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const parts = line.split(",").map((s) => s.trim());
            return {
              index: parseInt(parts[0], 10),
              uuid: parts[1] || "",
              name: parts[2] || "Unknown GPU",
              vramMb: parseInt(parts[3], 10) || 0,
            };
          })
          .filter((g) => !isNaN(g.index));

        if (gpus.length > 0) cachedGpuList = gpus;
        resolve(gpus);
      }
    );
  });
}

module.exports = {
  detectNvidiaGpu,
  listNvidiaGpus,
  buildWindowsWddmTelemetry,
  parseNvidiaSmiTelemetry,
  parseNvidiaProcessIdentities,
  parseWindowsGpuEngineTelemetry,
  sampleNvidiaGpuTelemetry,
  LIVE_QUERY_TIMEOUT_MS,
  WINDOWS_ACTIVE_GPU_PROCESS_MIN_PCT,
};
