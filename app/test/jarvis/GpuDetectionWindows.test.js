const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNvidiaPmonTelemetry,
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

function pmonExecFile({ pmonOutput, pmonError = null }) {
  return (command, args, _options, callback) => {
    if (command === "nvidia-smi" && args[0].startsWith("--query-gpu=")) {
      callback(null, GPU_OUTPUT);
      return;
    }
    if (command === "nvidia-smi" && args[0].startsWith("--query-compute-apps=")) {
      callback(null, "101, GPU-test, [N/A]\n202, GPU-test, [N/A]");
      return;
    }
    if (command === "nvidia-smi" && args[0] === "pmon") {
      callback(pmonError, pmonOutput);
      return;
    }
    callback(new Error(`unexpected command: ${command}`));
  };
}

test("NVIDIA pmon ignores headers and inactive WDDM graphics processes", () => {
  const result = parseNvidiaPmonTelemetry(
    [
      "# gpu pid type sm mem enc dec jpg ofa fb ccpm command",
      "# Idx # C/G % % % % % % MB MB name",
      "0 101 C+G 42 3 - - - - 512 0 jarvis.exe",
      "0 202 G 3 2 - - - - 256 0 game.exe",
    ].join("\n"),
    [{ index: 0, uuid: "GPU-test" }]
  );

  assert.deepEqual(result, [
    {
      pid: 101,
      gpuUuid: "GPU-test",
      usedVramMb: 512,
      utilizationPct: 42,
    },
  ]);
});

test("Windows WDDM fallback uses NVIDIA pmon and keeps only actively busy processes", async () => {
  const result = await sampleNvidiaGpuTelemetry({
    platform: "win32",
    ownedPids: [101],
    execFileImpl: pmonExecFile({
      pmonOutput: [
        "0 101 C+G 42 3 - - - - 512 0 jarvis.exe",
        "0 202 G 3 2 - - - - 256 0 game.exe",
      ].join("\n"),
    }),
  });

  assert.equal(result.telemetryAvailable, true);
  assert.equal(result.processTelemetryAvailable, true);
  assert.equal(result.telemetrySource, "nvidia_pmon");
  assert.deepEqual(result.processes, [
    {
      pid: 101,
      gpuUuid: "GPU-test",
      usedVramMb: 512,
      utilizationPct: 42,
    },
  ]);
  assert.equal(result.externalGpuBusy, false);
});

test("Windows WDDM fallback reports a materially active external pmon process", async () => {
  const result = await sampleNvidiaGpuTelemetry({
    platform: "win32",
    ownedPids: [101],
    execFileImpl: pmonExecFile({
      pmonOutput: [
        "0 101 C+G 2 1 - - - - 512 0 jarvis.exe",
        "0 202 G 25 8 - - - - 4096 0 game.exe",
      ].join("\n"),
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
    execFileImpl: pmonExecFile({
      pmonOutput: "",
      pmonError: new Error("pmon unavailable"),
    }),
  });

  assert.equal(result.telemetryAvailable, false);
  assert.equal(result.processTelemetryAvailable, false);
  assert.equal(result.error, "invalid_process_telemetry");
});
