const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ResourceGovernor,
  RESOURCE_STATES,
  ADMISSION_ACTIONS,
  JOB_PRIORITY,
  orderJobs,
  createWindowsCpuProvider,
  createWindowsPowerProvider,
} = require("../../src/jarvis/main/ResourceGovernor");
const {
  parseNvidiaSmiTelemetry,
  sampleNvidiaGpuTelemetry,
} = require("../../src/utils/gpuDetection");

function healthyTelemetry(overrides = {}) {
  return {
    telemetryAvailable: true,
    processTelemetryAvailable: true,
    gpus: [
      {
        index: 0,
        uuid: "GPU-a",
        name: "RTX Test",
        driverVersion: "999.1",
        utilizationPct: 10,
        totalVramMb: 16_384,
        usedVramMb: 2_048,
        freeVramMb: 14_336,
      },
    ],
    processes: [],
    ownedPids: [],
    externalGpuBusy: false,
    ...overrides,
  };
}

function cudaReady(overrides = {}) {
  return {
    installed: true,
    verified: true,
    quarantined: false,
    gpuUuid: "GPU-a",
    peakVramMb: 4_096,
    ...overrides,
  };
}

test("exports the exact resource state, action, and durable priority contracts", () => {
  assert.deepEqual(RESOURCE_STATES, ["available", "busy", "constrained", "unavailable"]);
  assert.deepEqual(ADMISSION_ACTIONS, ["run_cuda", "run_cpu", "defer", "pause_preview"]);
  assert.deepEqual(JOB_PRIORITY, {
    retention_urgent: 0,
    storage_recovery_compress: 10,
    preview: 20,
    final_transcription: 30,
    speaker: 40,
    analysis: 50,
    maintenance: 60,
  });
  assert.deepEqual(
    orderJobs(["analysis", "preview", "retention_urgent", "preview", "storage_recovery_compress"]),
    ["retention_urgent", "storage_recovery_compress", "preview", "preview", "analysis"]
  );
});

test("external GPU work immediately defers final work and pauses preview", () => {
  const governor = new ResourceGovernor();
  const snapshot = {
    state: "busy",
    externalGpuBusy: true,
    batterySaver: false,
    previewEnabled: true,
  };

  assert.deepEqual(governor.admit("final_transcription", snapshot), {
    action: "defer",
    reason: "external_gpu_busy",
  });
  assert.deepEqual(governor.admit("preview", snapshot), {
    action: "pause_preview",
    reason: "external_gpu_busy",
  });
});

test("CPU-only speaker capability is truthful and still yields under resource pressure", () => {
  const governor = new ResourceGovernor();
  const base = {
    state: "available",
    externalGpuBusy: false,
    batterySaver: false,
    previewEnabled: true,
    cpuLoadPct: 20,
    cpuTelemetryAvailable: true,
    powerTelemetryAvailable: true,
  };
  const capability = { executionDevice: "cpu" };

  assert.deepEqual(governor.admit("speaker", base, capability), {
    action: "run_cpu",
    reason: "cpu_backend",
  });
  assert.deepEqual(governor.admit("speaker", { ...base, state: "unavailable" }, capability), {
    action: "run_cpu",
    reason: "cuda_unavailable_cpu_backend",
  });
  assert.deepEqual(
    governor.admit("speaker", { ...base, state: "busy", externalGpuBusy: true }, capability),
    { action: "defer", reason: "external_gpu_busy" }
  );
  assert.deepEqual(
    governor.admit(
      "speaker",
      { ...base, state: "constrained", reason: "cpu_load_high", cpuLoadPct: 95 },
      capability
    ),
    { action: "defer", reason: "cpu_load_high" }
  );
});

test("unavailable local diarization models defer durably before resource admission", () => {
  const governor = new ResourceGovernor();
  const available = {
    state: "available",
    externalGpuBusy: false,
    batterySaver: false,
    previewEnabled: true,
    cpuLoadPct: 20,
    cpuTelemetryAvailable: true,
    powerTelemetryAvailable: true,
  };

  assert.deepEqual(
    governor.admit("speaker", available, {
      executionDevice: "cpu",
      available: false,
      unavailableReason: "diarization_model_unavailable",
    }),
    { action: "defer", reason: "diarization_model_unavailable" }
  );
});

test("a sampled external process makes the selected GPU busy in one sampling interval", async () => {
  let at = 1_000;
  const governor = new ResourceGovernor({
    now: () => at,
    telemetryProvider: async () =>
      healthyTelemetry({
        processes: [{ pid: 88, gpuUuid: "GPU-a", usedVramMb: 256 }],
        externalGpuBusy: true,
      }),
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 25 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const snapshot = await governor.sample();
  assert.equal(snapshot.sampledAt, 1_000);
  assert.equal(snapshot.state, "busy");
  assert.equal(snapshot.restrictiveForMs, 0);
  at += 15_000;
  assert.deepEqual(governor.admit("final_transcription", snapshot), {
    action: "defer",
    reason: "external_gpu_busy",
  });
});

test("external work on another GPU does not mark the verified selected GPU busy", async () => {
  let at = 1_000;
  const governor = new ResourceGovernor({
    now: () => at,
    telemetryProvider: async () => ({
      ...healthyTelemetry(),
      gpus: [
        healthyTelemetry().gpus[0],
        {
          ...healthyTelemetry().gpus[0],
          index: 1,
          uuid: "GPU-b",
        },
      ],
      processes: [{ pid: 88, gpuUuid: "GPU-b", usedVramMb: 256 }],
      externalGpuBusy: true,
    }),
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 25 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  assert.equal((await governor.sample()).state, "constrained");
  at += 15_000;
  assert.equal((await governor.sample()).state, "available");
});

test("missing or invalid live telemetry is constrained and never available", async () => {
  const governor = new ResourceGovernor({
    now: () => 5_000,
    telemetryProvider: async () => ({
      telemetryAvailable: false,
      processTelemetryAvailable: false,
      gpus: [],
      processes: [],
      externalGpuBusy: false,
      error: "invalid_gpu_telemetry",
    }),
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 20 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const snapshot = await governor.sample();
  assert.equal(snapshot.state, "constrained");
  assert.equal(snapshot.reason, "telemetry_unavailable");
  assert.deepEqual(governor.admit("preview", snapshot), {
    action: "pause_preview",
    reason: "telemetry_unavailable",
  });
});

test("provider failure becomes an explicit restrictive snapshot instead of escaping", async () => {
  const governor = new ResourceGovernor({
    now: () => 5_000,
    telemetryProvider: async () => {
      throw new Error("nvidia-smi timed out");
    },
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 20 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const snapshot = await governor.sample();
  assert.equal(snapshot.state, "constrained");
  assert.equal(snapshot.reason, "telemetry_unavailable");
  assert.equal(snapshot.telemetryAvailable, false);
});

test("production sampling interval reuses a snapshot until 15000 ms has elapsed", async () => {
  let at = 1_000;
  let calls = 0;
  const governor = new ResourceGovernor({
    now: () => at,
    telemetryProvider: async () => {
      calls += 1;
      return healthyTelemetry();
    },
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 20 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const first = await governor.sample();
  at += 14_999;
  assert.equal(await governor.sample(), first);
  assert.equal(calls, 1);
  at += 1;
  assert.equal((await governor.sample()).state, "available");
  assert.equal(calls, 2);
});

test("requires peak plus 1024 MiB and two healthy samples before recovery", async () => {
  let freeVramMb = 5_119;
  let at = 10_000;
  const governor = new ResourceGovernor({
    now: () => at,
    telemetryProvider: async () => {
      const telemetry = healthyTelemetry();
      telemetry.gpus[0].freeVramMb = freeVramMb;
      telemetry.gpus[0].usedVramMb = telemetry.gpus[0].totalVramMb - freeVramMb;
      return telemetry;
    },
    cudaProvider: async () => cudaReady({ peakVramMb: 4_096 }),
    cpuProvider: async () => ({ loadPct: 20 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const low = await governor.sample();
  assert.equal(low.safetyMarginMb, 1_024);
  assert.equal(low.state, "constrained");
  assert.equal(low.reason, "insufficient_vram");
  assert.deepEqual(governor.admit("final_transcription", low), {
    action: "defer",
    reason: "insufficient_vram",
  });

  freeVramMb = 5_120;
  at += 15_000;
  const firstHealthy = await governor.sample();
  assert.equal(firstHealthy.state, "constrained");
  assert.equal(firstHealthy.reason, "recovery_hysteresis");
  at += 15_000;
  const recovered = await governor.sample();
  assert.equal(recovered.state, "available");
  assert.deepEqual(governor.admit("final_transcription", recovered), {
    action: "run_cuda",
    reason: "resources_available",
  });
});

test("battery saver admits only storage rescue and pauses or defers AI work", () => {
  const governor = new ResourceGovernor();
  const snapshot = {
    state: "constrained",
    reason: "battery_saver",
    batterySaver: true,
    previewEnabled: true,
    cpuLoadPct: 10,
    powerTelemetryAvailable: true,
  };

  assert.deepEqual(governor.admit("preview", snapshot), {
    action: "pause_preview",
    reason: "battery_saver",
  });
  assert.deepEqual(governor.admit("final_transcription", snapshot), {
    action: "defer",
    reason: "battery_saver",
  });
  assert.deepEqual(governor.admit("storage_recovery_compress", snapshot), {
    action: "run_cpu",
    reason: "storage_critical",
  });
  assert.deepEqual(governor.admit("retention_urgent", snapshot), {
    action: "defer",
    reason: "battery_saver",
  });
});

test("graphics-only load on the selected GPU constrains admission without a compute process", async () => {
  const at = 1_000;
  const governor = new ResourceGovernor({
    now: () => at,
    telemetryProvider: async () => {
      const telemetry = healthyTelemetry();
      telemetry.gpus[0].utilizationPct = 95;
      return telemetry;
    },
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 20 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const snapshot = await governor.sample();
  assert.equal(snapshot.state, "constrained");
  assert.equal(snapshot.reason, "gpu_utilization_high");
  assert.equal(snapshot.gpuUtilizationPct, 95);
  assert.equal(snapshot.externalGpuBusy, false);
});

test("high Windows CPU load constrains GPU admission", async () => {
  const governor = new ResourceGovernor({
    now: () => 1_000,
    telemetryProvider: async () => healthyTelemetry(),
    cudaProvider: async () => cudaReady(),
    cpuProvider: async () => ({ loadPct: 95 }),
    powerProvider: async () => ({ onAcPower: true, batteryLevelPct: 100, batterySaver: false }),
  });

  const snapshot = await governor.sample();
  assert.equal(snapshot.state, "constrained");
  assert.equal(snapshot.reason, "cpu_load_high");
  assert.deepEqual(governor.admit("storage_recovery_compress", snapshot), {
    action: "defer",
    reason: "cpu_load_high",
  });
});

test("invalid CPU or missing power readings remain fail-closed after hysteresis", async (t) => {
  for (const scenario of [
    {
      name: "invalid CPU",
      cpu: { loadPct: null },
      power: { onAcPower: true, batteryLevelPct: 100, batterySaver: false },
    },
    {
      name: "missing power",
      cpu: { loadPct: 20 },
      power: { onAcPower: null, batteryLevelPct: null, batterySaver: false },
    },
  ]) {
    await t.test(scenario.name, async () => {
      let at = 1_000;
      const governor = new ResourceGovernor({
        now: () => at,
        telemetryProvider: async () => healthyTelemetry(),
        cudaProvider: async () => cudaReady(),
        cpuProvider: async () => scenario.cpu,
        powerProvider: async () => scenario.power,
      });
      await governor.sample();
      at += 15_000;
      const second = await governor.sample();
      assert.equal(second.state, "constrained");
      assert.equal(second.reason, "telemetry_unavailable");
      assert.deepEqual(governor.admit("storage_recovery_compress", second), {
        action: "defer",
        reason: "telemetry_unavailable",
      });
    });
  }
});

test("Windows providers normalize CPU deltas and active battery saver status", async () => {
  const snapshots = [
    [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }],
    [{ times: { user: 180, nice: 0, sys: 70, idle: 950, irq: 0 } }],
  ];
  const cpuProvider = createWindowsCpuProvider({ cpuTimesProvider: () => snapshots.shift() });
  assert.deepEqual(await cpuProvider(), { loadPct: null, telemetryAvailable: false });
  assert.deepEqual(await cpuProvider(), { loadPct: 50, telemetryAvailable: true });

  const calls = [];
  const powerProvider = createWindowsPowerProvider({
    platform: "win32",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(
        null,
        JSON.stringify({
          onAcPower: false,
          batteryPresent: true,
          batteryLevelPct: 44,
          batterySaver: true,
        }),
        ""
      );
    },
  });
  assert.deepEqual(await powerProvider(), {
    onAcPower: false,
    batteryPresent: true,
    batteryLevelPct: 44,
    batterySaver: true,
    telemetryAvailable: true,
  });
  assert.equal(calls[0].file.toLowerCase(), "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
});

test("Windows power sampling coalesces concurrent calls and caches beyond governor cadence", async () => {
  let at = 1_000;
  let calls = 0;
  const provider = createWindowsPowerProvider({
    platform: "win32",
    now: () => at,
    execFileImpl(_file, _args, _options, callback) {
      calls += 1;
      process.nextTick(() =>
        callback(
          null,
          JSON.stringify({
            onAcPower: true,
            batteryPresent: false,
            batteryLevelPct: null,
            batterySaver: false,
          }),
          ""
        )
      );
    },
  });

  const [first, concurrent] = await Promise.all([provider(), provider()]);
  assert.equal(first, concurrent);
  assert.equal(calls, 1);
  at += 59_999;
  assert.equal(await provider(), first);
  assert.equal(calls, 1);
  at += 1;
  assert.notEqual(await provider(), first);
  assert.equal(calls, 2);
});

test("CUDA unavailable allows optional CPU preview but not ordinary final backlog", () => {
  const governor = new ResourceGovernor();
  const unavailable = {
    state: "unavailable",
    reason: "cuda_unavailable",
    batterySaver: false,
    previewEnabled: true,
    cpuLoadPct: 20,
    cpuTelemetryAvailable: true,
    powerTelemetryAvailable: true,
  };

  assert.deepEqual(governor.admit("preview", unavailable), {
    action: "run_cpu",
    reason: "cuda_unavailable",
  });
  assert.deepEqual(governor.admit("final_transcription", unavailable), {
    action: "defer",
    reason: "cuda_unavailable",
  });
  assert.deepEqual(governor.admit("preview", { ...unavailable, previewEnabled: false }), {
    action: "pause_preview",
    reason: "preview_disabled",
  });
});

test("CUDA-unavailable preview fails closed on unsafe CPU or unknown power", () => {
  const governor = new ResourceGovernor();
  const baseline = {
    state: "unavailable",
    reason: "cuda_unavailable",
    batterySaver: false,
    previewEnabled: true,
    cpuLoadPct: 20,
    cpuTelemetryAvailable: true,
    powerTelemetryAvailable: true,
  };
  const cases = [
    {
      name: "missing CPU telemetry",
      snapshot: { ...baseline, cpuLoadPct: null, cpuTelemetryAvailable: false },
      reason: "telemetry_unavailable",
    },
    {
      name: "invalid CPU telemetry",
      snapshot: { ...baseline, cpuLoadPct: -1 },
      reason: "telemetry_unavailable",
    },
    {
      name: "high CPU load",
      snapshot: { ...baseline, cpuLoadPct: 95 },
      reason: "cpu_load_high",
    },
    {
      name: "unknown power state",
      snapshot: { ...baseline, powerTelemetryAvailable: false },
      reason: "telemetry_unavailable",
    },
    {
      name: "unknown battery-saver state",
      snapshot: { ...baseline, batterySaver: null },
      reason: "telemetry_unavailable",
    },
    {
      name: "battery saver",
      snapshot: { ...baseline, batterySaver: true },
      reason: "battery_saver",
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      governor.admit("preview", entry.snapshot),
      { action: "pause_preview", reason: entry.reason },
      entry.name
    );
  }
});

test("parses live NVIDIA telemetry and distinguishes Jarvis-owned from external PIDs", () => {
  const gpuOutput = "0, GPU-a, RTX Test, 999.1, 42, 16384, 4096, 12288\n";
  const processOutput = "101, GPU-a, 512\n202, GPU-a, 256\n";
  const parsed = parseNvidiaSmiTelemetry({ gpuOutput, processOutput, ownedPids: [101] });

  assert.equal(parsed.telemetryAvailable, true);
  assert.equal(parsed.processTelemetryAvailable, true);
  assert.equal(parsed.externalGpuBusy, true);
  assert.deepEqual(parsed.gpus[0], {
    index: 0,
    uuid: "GPU-a",
    name: "RTX Test",
    driverVersion: "999.1",
    utilizationPct: 42,
    totalVramMb: 16_384,
    usedVramMb: 4_096,
    freeVramMb: 12_288,
  });
  assert.deepEqual(
    parseNvidiaSmiTelemetry({ gpuOutput, processOutput, ownedPids: [101, 202] }).externalGpuBusy,
    false
  );

  const invalid = parseNvidiaSmiTelemetry({
    gpuOutput: "not,nvidia,telemetry",
    processOutput: "",
    ownedPids: [],
  });
  assert.equal(invalid.telemetryAvailable, false);
  assert.equal(invalid.error, "invalid_gpu_telemetry");
});

test("live NVIDIA sampling makes unavailable process telemetry explicit", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout });
    if (args[0].startsWith("--query-gpu=")) {
      callback(null, "0, GPU-a, RTX Test, 999.1, 1, 16384, 1024, 15360\n", "");
      return;
    }
    const error = new Error("process query unavailable");
    error.code = "ENOENT";
    callback(error, "", "");
  };

  const sampled = await sampleNvidiaGpuTelemetry({ execFileImpl, ownedPids: [process.pid] });
  assert.equal(calls.length, 2);
  assert.equal(sampled.telemetryAvailable, false);
  assert.equal(sampled.processTelemetryAvailable, false);
  assert.equal(sampled.error, "process_telemetry_unavailable");
});
