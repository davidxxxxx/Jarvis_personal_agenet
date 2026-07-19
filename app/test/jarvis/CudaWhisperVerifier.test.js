const assert = require("node:assert/strict");
const test = require("node:test");

const CudaWhisperVerifier = require("../../src/jarvis/main/CudaWhisperVerifier");
const { createRealProbeServer, queryGpuProcessTelemetry } = CudaWhisperVerifier;

function verifierFor({ inference, evidence, telemetry, launchError } = {}) {
  let stopped = 0;
  const verifier = new CudaWhisperVerifier({
    createProbeServer: async () => {
      if (launchError) throw launchError;
      return {
        pid: 41,
        infer: async () => inference ?? { text: "" },
        evidence: async () => evidence ?? { backend: "cuda", gpuUuid: "GPU-a" },
        stop: async () => {
          stopped += 1;
        },
      };
    },
    queryTelemetry: async () => telemetry ?? { gpuUuid: "GPU-a", processFound: true, vramMb: 128 },
    timeoutMs: 500,
  });
  return { verifier, stopped: () => stopped };
}

test("rejects a process that answers but reports CPU", async () => {
  const { verifier } = verifierFor({ evidence: { backend: "cpu", gpuUuid: null } });
  assert.deepEqual(await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m" }), {
    ok: false,
    backend: "cpu",
    gpuUuid: null,
    reason: "cuda_not_active",
  });
});

test("requires process telemetry for the exact selected GPU UUID", async () => {
  const { verifier } = verifierFor({
    telemetry: { gpuUuid: "GPU-b", processFound: true, vramMb: 32 },
  });
  assert.deepEqual(
    await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m", gpuUuid: "GPU-a" }),
    { ok: false, backend: "cuda", gpuUuid: "GPU-b", reason: "gpu_uuid_mismatch" }
  );
});

test("rejects missing PID/VRAM telemetry even when logs say CUDA", async () => {
  const { verifier } = verifierFor({
    telemetry: { gpuUuid: "GPU-a", processFound: false, vramMb: 0 },
  });
  assert.deepEqual(
    await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m", gpuUuid: "GPU-a" }),
    {
      ok: false,
      backend: "cuda",
      gpuUuid: "GPU-a",
      reason: "gpu_process_not_observed",
    }
  );
});

test("accepts only inference plus CUDA evidence and matching PID telemetry", async () => {
  const { verifier, stopped } = verifierFor();
  assert.deepEqual(
    await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m", gpuUuid: "GPU-a" }),
    {
      ok: true,
      backend: "cuda",
      gpuUuid: "GPU-a",
      reason: "verified",
    }
  );
  assert.equal(stopped(), 1);
  assert.deepEqual(verifier.getLastProofMetadata(), {
    gpuUuid: "GPU-a",
    peakVramMb: 128,
  });
});

test("accepts WDDM PID memory only after inference and matching CUDA server evidence", async () => {
  const { verifier } = verifierFor({
    telemetry: { gpuUuid: null, processFound: true, vramMb: 256, source: "wddm" },
  });

  assert.deepEqual(
    await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m", gpuUuid: "GPU-a" }),
    {
      ok: true,
      backend: "cuda",
      gpuUuid: "GPU-a",
      reason: "verified",
    }
  );
  assert.deepEqual(verifier.getLastProofMetadata(), {
    gpuUuid: "GPU-a",
    peakVramMb: 256,
  });
});

test("WDDM PID memory cannot substitute for mismatched server GPU evidence", async () => {
  const { verifier } = verifierFor({
    evidence: { backend: "cuda", gpuUuid: "GPU-b" },
    telemetry: { gpuUuid: null, processFound: true, vramMb: 256, source: "wddm" },
  });

  assert.deepEqual(
    await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m", gpuUuid: "GPU-a" }),
    {
      ok: false,
      backend: "cuda",
      gpuUuid: null,
      reason: "server_gpu_uuid_mismatch",
    }
  );
});

test("Windows telemetry falls back to exact-PID GPU process memory when WDDM hides VRAM", async () => {
  const calls = [];
  const telemetry = await queryGpuProcessTelemetry(41, {
    platform: "win32",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      if (file === "nvidia-smi") {
        process.nextTick(() => callback(null, "41, GPU-a, [N/A]\n", ""));
        return;
      }
      process.nextTick(() =>
        callback(
          null,
          JSON.stringify({
            processFound: true,
            dedicatedBytes: 200 * 1024 * 1024,
            sharedBytes: 56 * 1024 * 1024,
          }),
          ""
        )
      );
    },
  });

  assert.deepEqual(telemetry, {
    gpuUuid: "GPU-a",
    processFound: true,
    vramMb: 256,
    source: "wddm",
  });
  assert.equal(calls[1].file.toLowerCase(), "powershell.exe");
  assert.equal(calls[1].args.includes("-NonInteractive"), true);
  assert.match(calls[1].args[calls[1].args.indexOf("-Command") + 1], /^& \{/u);
  assert.equal(calls[1].options.windowsHide, true);
});

test("always stops the probe after malformed inference", async () => {
  const { verifier, stopped } = verifierFor({ inference: { nope: true } });
  assert.deepEqual(await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m" }), {
    ok: false,
    backend: "unknown",
    gpuUuid: null,
    reason: "invalid_inference_response",
  });
  assert.equal(stopped(), 1);
});

test("maps OOM and launch failures to bounded safe reasons", async () => {
  const error = Object.assign(new Error("CUDA out of memory"), { code: "ENOMEM" });
  const { verifier } = verifierFor({ launchError: error });
  assert.deepEqual(await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m" }), {
    ok: false,
    backend: "unknown",
    gpuUuid: null,
    reason: "cuda_out_of_memory",
  });
});

test("real probe startup failure stops manager state created before rejection", async () => {
  let stopped = 0;
  const manager = {
    process: { pid: 41 },
    start: async () => {
      throw new Error("health timeout after spawn");
    },
    stop: async () => {
      stopped += 1;
      manager.process = null;
    },
  };
  assert.equal(typeof createRealProbeServer, "function");

  await assert.rejects(
    createRealProbeServer(
      { binaryPath: "cuda.exe", modelPath: "model.bin", gpuUuid: "GPU-a" },
      { createManager: () => manager }
    ),
    /health timeout/
  );
  assert.equal(stopped, 1);
  assert.equal(manager.process, null);
});

test("stops a probe that resolves only after the verification timeout", async () => {
  let stopped = 0;
  const verifier = new CudaWhisperVerifier({
    timeoutMs: 5,
    createProbeServer: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        pid: 1,
        infer: async () => ({ text: "" }),
        evidence: async () => ({ backend: "cuda", gpuUuid: "GPU-a" }),
        stop: async () => {
          stopped += 1;
        },
      };
    },
  });
  assert.deepEqual(await verifier.verify({ runtimeDir: "x", binaryPath: "b", modelPath: "m" }), {
    ok: false,
    backend: "unknown",
    gpuUuid: null,
    reason: "verification_timeout",
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(stopped, 1);
});

test("stops an active probe when verification is aborted during inference", async () => {
  let stopped = 0;
  const controller = new AbortController();
  const verifier = new CudaWhisperVerifier({
    timeoutMs: 500,
    createProbeServer: async () => ({
      pid: 1,
      infer: async () => new Promise(() => {}),
      evidence: async () => ({ backend: "cuda", gpuUuid: "GPU-a" }),
      stop: async () => {
        stopped += 1;
      },
    }),
  });
  const pending = verifier.verify({
    runtimeDir: "x",
    binaryPath: "b",
    modelPath: "m",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  assert.deepEqual(await pending, {
    ok: false,
    backend: "unknown",
    gpuUuid: null,
    reason: "verification_aborted",
  });
  assert.equal(stopped, 1);
});
