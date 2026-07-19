const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 120_000;
const MEBIBYTE = 1024 * 1024;
const WINDOWS_GPU_PROCESS_MEMORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$pidValue = [int]$args[0]
$rows = @(
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |
    Where-Object { ([string]$_.Name) -match "(^|_)pid_$pidValue(_|$)" }
)
[uint64]$dedicatedBytes = 0
[uint64]$sharedBytes = 0
foreach ($row in $rows) {
  $dedicatedBytes += [uint64]$row.DedicatedUsage
  $sharedBytes += [uint64]$row.SharedUsage
}
[pscustomobject]@{
  processFound = [bool]($rows.Count -gt 0)
  dedicatedBytes = $dedicatedBytes
  sharedBytes = $sharedBytes
} | ConvertTo-Json -Compress
`;

function result(ok, backend, gpuUuid, reason) {
  return { ok, backend, gpuUuid, reason };
}

function createSilentProbeWav(durationMs = 500) {
  const sampleRate = 16_000;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataLength = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

function queryNvidiaTelemetry(pid, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      "nvidia-smi",
      ["--query-compute-apps=pid,gpu_uuid,used_gpu_memory", "--format=csv,noheader,nounits"],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve({ gpuUuid: null, processFound: false, vramMb: 0 });
          return;
        }
        const row = stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split(",").map((value) => value.trim()))
          .find((parts) => Number(parts[0]) === Number(pid));
        const gpuUuid = /^GPU-[A-Za-z0-9-]+$/.test(row?.[1] || "") ? row[1] : null;
        resolve({
          gpuUuid,
          processFound: !!row,
          vramMb: row ? Number.parseInt(row[2], 10) || 0 : 0,
        });
      }
    );
  });
}

function queryWindowsGpuProcessMemory(
  pid,
  { execFileImpl = execFile, platform = process.platform } = {}
) {
  return new Promise((resolve) => {
    const unavailable = { processFound: false, vramMb: 0 };
    if (platform !== "win32" || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) {
      resolve(unavailable);
      return;
    }
    execFileImpl(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& {${WINDOWS_GPU_PROCESS_MEMORY_SCRIPT}}`,
        String(pid),
      ],
      { timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(unavailable);
          return;
        }
        try {
          const reading = JSON.parse(String(stdout).trim());
          const dedicatedBytes = Number(reading?.dedicatedBytes);
          const sharedBytes = Number(reading?.sharedBytes);
          const totalBytes = dedicatedBytes + sharedBytes;
          if (
            reading?.processFound !== true ||
            !Number.isSafeInteger(dedicatedBytes) ||
            dedicatedBytes < 0 ||
            !Number.isSafeInteger(sharedBytes) ||
            sharedBytes < 0 ||
            !Number.isSafeInteger(totalBytes) ||
            totalBytes <= 0
          ) {
            resolve(unavailable);
            return;
          }
          resolve({
            processFound: true,
            vramMb: Math.max(1, Math.ceil(totalBytes / MEBIBYTE)),
          });
        } catch {
          resolve(unavailable);
        }
      }
    );
  });
}

async function queryGpuProcessTelemetry(
  pid,
  { execFileImpl = execFile, platform = process.platform } = {}
) {
  const nvidia = await queryNvidiaTelemetry(pid, { execFileImpl });
  if (nvidia.processFound && nvidia.vramMb > 0) {
    return { ...nvidia, source: "nvidia-smi" };
  }
  const wddm = await queryWindowsGpuProcessMemory(pid, { execFileImpl, platform });
  if (wddm.processFound && wddm.vramMb > 0) {
    return {
      gpuUuid: nvidia.gpuUuid,
      processFound: true,
      vramMb: wddm.vramMb,
      source: "wddm",
    };
  }
  return { ...nvidia, source: "nvidia-smi" };
}

async function createRealProbeServer(
  { binaryPath, modelPath, gpuUuid },
  { createManager = null } = {}
) {
  const WhisperServerManager = require("../../helpers/whisperServer");
  const manager = createManager
    ? createManager({ cudaBinaryResolver: () => binaryPath })
    : new WhisperServerManager({ cudaBinaryResolver: () => binaryPath });
  try {
    await manager.start(modelPath, { useCuda: true, requireCuda: true, gpuUuid });
  } catch (error) {
    await manager.stop().catch(() => {});
    throw error;
  }
  return {
    get pid() {
      return manager.process?.pid || null;
    },
    infer: (wav) => manager.transcribe(wav, { preconvertedWav: true }),
    evidence: () => manager.getCudaProofEvidence(),
    stop: () => manager.stop(),
  };
}

function classifyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (text.includes("abort")) return "verification_aborted";
  if (text.includes("timeout")) return "verification_timeout";
  if (text.includes("out of memory") || text.includes("enomem")) return "cuda_out_of_memory";
  if (text.includes("driver")) return "cuda_driver_failure";
  return "cuda_launch_failed";
}

class CudaWhisperVerifier {
  constructor({
    createProbeServer = createRealProbeServer,
    queryTelemetry = queryGpuProcessTelemetry,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readFile = (filePath) => fs.readFileSync(filePath),
  } = {}) {
    this.createProbeServer = createProbeServer;
    this.queryTelemetry = queryTelemetry;
    this.timeoutMs = timeoutMs;
    this.readFile = readFile;
    this.lastProofMetadata = null;
  }

  getLastProofMetadata() {
    return this.lastProofMetadata ? { ...this.lastProofMetadata } : null;
  }

  async verify({ runtimeDir, binaryPath, modelPath, fixturePath, gpuUuid, signal } = {}) {
    this.lastProofMetadata = null;
    let server = null;
    let timer = null;
    let abortListener = null;
    let terminalReason = null;
    let stopPromise = null;
    const stopServer = () => {
      if (!server) return stopPromise || Promise.resolve();
      const target = server;
      server = null;
      stopPromise = Promise.resolve(target.stop?.()).catch(() => {});
      return stopPromise;
    };
    try {
      if (signal?.aborted) return result(false, "unknown", null, "verification_aborted");
      const resolvedBinary = binaryPath || (runtimeDir ? this._findBinary(runtimeDir) : null);
      if (!resolvedBinary) return result(false, "unknown", null, "runtime_missing");
      if (!modelPath) return result(false, "unknown", null, "model_missing");
      const wav = fixturePath ? this.readFile(fixturePath) : createSilentProbeWav();
      const operation = (async () => {
        server = await this.createProbeServer({
          runtimeDir,
          binaryPath: resolvedBinary,
          modelPath,
          gpuUuid: gpuUuid || null,
          signal,
        });
        if (terminalReason) {
          await stopServer();
          return result(false, "unknown", null, terminalReason);
        }
        if (
          !server ||
          typeof server.infer !== "function" ||
          typeof server.evidence !== "function"
        ) {
          return result(false, "unknown", null, "probe_server_invalid");
        }
        if (!server.pid) return result(false, "unknown", null, "server_pid_missing");
        const inference = await server.infer(wav);
        if (!inference || typeof inference.text !== "string") {
          return result(false, "unknown", null, "invalid_inference_response");
        }
        const evidence = await server.evidence();
        const backend =
          evidence?.backend === "cuda" ? "cuda" : evidence?.backend === "cpu" ? "cpu" : "unknown";
        if (backend !== "cuda") {
          return result(false, backend, evidence?.gpuUuid || null, "cuda_not_active");
        }
        const telemetry = await this.queryTelemetry(server.pid, { gpuUuid: gpuUuid || null });
        let observedUuid = telemetry?.gpuUuid || null;
        if (!telemetry?.processFound || !(Number(telemetry.vramMb) > 0)) {
          return result(
            false,
            "cuda",
            observedUuid || evidence?.gpuUuid || null,
            "gpu_process_not_observed"
          );
        }
        if (gpuUuid && evidence?.gpuUuid && evidence.gpuUuid !== gpuUuid) {
          return result(false, "cuda", observedUuid, "server_gpu_uuid_mismatch");
        }
        if (
          !observedUuid &&
          telemetry?.source === "wddm" &&
          gpuUuid &&
          evidence?.gpuUuid === gpuUuid
        ) {
          observedUuid = gpuUuid;
        }
        if (!observedUuid) {
          return result(false, "cuda", null, "gpu_telemetry_missing");
        }
        if (gpuUuid && observedUuid !== gpuUuid) {
          return result(false, "cuda", observedUuid, "gpu_uuid_mismatch");
        }
        this.lastProofMetadata = {
          gpuUuid: observedUuid,
          peakVramMb: Number(telemetry.vramMb),
        };
        return result(true, "cuda", observedUuid, "verified");
      })();
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          terminalReason = "verification_timeout";
          stopServer();
          resolve(result(false, "unknown", null, terminalReason));
        }, this.timeoutMs);
      });
      const races = [operation, timeout];
      if (signal?.addEventListener) {
        races.push(
          new Promise((resolve) => {
            abortListener = () => {
              terminalReason = "verification_aborted";
              stopServer();
              resolve(result(false, "unknown", null, terminalReason));
            };
            signal.addEventListener("abort", abortListener, { once: true });
          })
        );
      }
      return await Promise.race(races);
    } catch (error) {
      return result(false, "unknown", null, classifyError(error));
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener && signal?.removeEventListener) {
        signal.removeEventListener("abort", abortListener);
      }
      await stopServer();
    }
  }

  _findBinary(runtimeDir) {
    const name =
      process.platform === "win32"
        ? "whisper-server-win32-x64-cuda.exe"
        : "whisper-server-linux-x64-cuda";
    const candidate = path.join(runtimeDir, name);
    return fs.existsSync(candidate) ? candidate : null;
  }
}

module.exports = CudaWhisperVerifier;
module.exports.createSilentProbeWav = createSilentProbeWav;
module.exports.queryNvidiaTelemetry = queryNvidiaTelemetry;
module.exports.queryWindowsGpuProcessMemory = queryWindowsGpuProcessMemory;
module.exports.queryGpuProcessTelemetry = queryGpuProcessTelemetry;
module.exports.createRealProbeServer = createRealProbeServer;
