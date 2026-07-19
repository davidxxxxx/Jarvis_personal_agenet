const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNvidiaSmiTelemetry,
  sampleNvidiaGpuTelemetry,
} = require("../../src/utils/gpuDetection");

const GPU_OUTPUT = "0, GPU-test, NVIDIA Test GPU, 596.49, 18, 16303, 3326, 12670";

test("NVIDIA telemetry accepts driver-reserved VRAM that is neither used nor free", () => {
  const result = parseNvidiaSmiTelemetry({
    gpuOutput: GPU_OUTPUT,
    processOutput: "",
  });

  assert.equal(result.telemetryAvailable, true);
  assert.equal(result.gpus[0].totalVramMb, 16303);
  assert.equal(result.gpus[0].usedVramMb, 3326);
  assert.equal(result.gpus[0].freeVramMb, 12670);
});

test("NVIDIA telemetry still rejects used plus free memory above total VRAM", () => {
  const result = parseNvidiaSmiTelemetry({
    gpuOutput: "0, GPU-test, NVIDIA Test GPU, 596.49, 18, 100, 60, 50",
    processOutput: "",
  });

  assert.equal(result.telemetryAvailable, false);
  assert.equal(result.error, "invalid_gpu_telemetry");
});

function wddmExecFile({ engineOutput, engineError = null }) {
  return (command, args, _options, callback) => {
    if (command === "nvidia-smi" && args[0].startsWith("--query-gpu=")) {
      callback(null, GPU_OUTPUT);
      return;
    }
    if (command === "nvidia-smi" && args[0].startsWith("--query-compute-apps=")) {
      callback(null, "101, GPU-test, [N/A]\n202, GPU-test, [N/A]");
      return;
    }
    if (command === "powershell.exe") {
      callback(engineError, engineOutput);
      return;
    }
    callback(new Error(`unexpected command: ${command}`));
  };
}

test("Windows WDDM fallback keeps only actively busy GPU processes", async () => {
  const result = await sampleNvidiaGpuTelemetry({
    platform: "win32",
    ownedPids: [101],
    execFileImpl: wddmExecFile({
      engineOutput: "101,42\n202,3",
    }),
  });

  assert.equal(result.telemetryAvailable, true);
  assert.equal(result.processTelemetryAvailable, true);
  assert.equal(result.telemetrySource, "windows_wddm");
  assert.deepEqual(result.processes, [
    {
      pid: 101,
      gpuUuid: "GPU-test",
      usedVramMb: 0,
      utilizationPct: 42,
    },
  ]);
  assert.equal(result.externalGpuBusy, false);
});

test("Windows WDDM fallback reports a materially active external GPU process", async () => {
  const result = await sampleNvidiaGpuTelemetry({
    platform: "win32",
    ownedPids: [101],
    execFileImpl: wddmExecFile({
      engineOutput: "101,2\n202,25",
    }),
  });

  assert.equal(result.telemetryAvailable, true);
  assert.equal(result.processTelemetryAvailable, true);
  assert.equal(result.externalGpuBusy, true);
  assert.deepEqual(
    result.processes.map((entry) => entry.pid),
    [202]
  );
});

test("Windows WDDM failure remains fail-closed", async () => {
  const result = await sampleNvidiaGpuTelemetry({
    platform: "win32",
    ownedPids: [101],
    execFileImpl: wddmExecFile({
      engineOutput: "",
      engineError: new Error("WMI unavailable"),
    }),
  });

  assert.equal(result.telemetryAvailable, false);
  assert.equal(result.processTelemetryAvailable, false);
  assert.equal(result.error, "invalid_process_telemetry");
});
