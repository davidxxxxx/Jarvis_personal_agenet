const assert = require("node:assert/strict");
const test = require("node:test");

const CudaWhisperVerifier = require("../../src/jarvis/main/CudaWhisperVerifier");

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
