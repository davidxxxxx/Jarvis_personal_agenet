const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { processWriteGate } = require("../../src/jarvis/main/UnifiedRootWriteGate");

test("CUDA binary resolution uses only the injected verified pointer", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-server-resolver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "verified-cuda.exe");
  fs.writeFileSync(binary, "binary");
  let calls = 0;
  const manager = new WhisperServerManager({
    cudaBinaryResolver: () => {
      calls += 1;
      return binary;
    },
  });
  assert.equal(manager.getServerBinaryPath({ preferCuda: true }), binary);
  assert.equal(calls, 1);
});

test("proof mode never hides a CUDA launch failure behind CPU fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-server-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "cuda.exe");
  const model = path.join(root, "model.bin");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(model, "model");
  let spawnCount = 0;
  let fallbackEvents = 0;
  let child;
  const manager = new WhisperServerManager({
    cudaBinaryResolver: () => binary,
    spawnImpl: () => {
      spawnCount += 1;
      child = new EventEmitter();
      child.pid = 999999998;
      child.killed = false;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    },
  });
  manager.findAvailablePort = async () => 8178;
  manager.getFFmpegPath = () => null;
  manager.waitForReady = async () => {
    child.stderr.write("CUDA driver failed");
    child.emit("close", 1);
    throw new Error("launch failed");
  };
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });
  await assert.rejects(
    manager._doStart(model, { useCuda: true, requireCuda: true, threads: 1 }),
    /launch failed/
  );
  assert.equal(spawnCount, 1);
  assert.equal(fallbackEvents, 0);
});

test("terminal startup failure clears process PID state and native temp lease", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-server-cleanup-"));
  t.after(() => {
    processWriteGate.open();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binary = path.join(root, "cuda.exe");
  const model = path.join(root, "model.bin");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(model, "model");
  const child = new EventEmitter();
  child.pid = 999999996;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    child.emit("close", 1);
    return true;
  };
  const pidEvents = [];
  const manager = new WhisperServerManager({
    cudaBinaryResolver: () => binary,
    spawnImpl: () => child,
    pidFile: {
      write: (name, pid) => pidEvents.push(["write", name, pid]),
      clear: (name) => pidEvents.push(["clear", name]),
    },
  });
  manager.findAvailablePort = async () => 8178;
  manager.getFFmpegPath = () => null;
  manager.waitForReady = async () => {
    throw new Error("health timeout");
  };

  await assert.rejects(
    manager._doStart(model, { useCuda: true, requireCuda: true, threads: 1 }),
    /health timeout/
  );
  processWriteGate.close();
  const leaseReleased = await Promise.race([
    processWriteGate.waitForIdle().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  processWriteGate.open();
  if (!child.killed) child.emit("close", 1);

  assert.equal(child.killed, true);
  assert.deepEqual(pidEvents, [
    ["write", "whisper", child.pid],
    ["clear", "whisper"],
  ]);
  assert.equal(manager.process, null);
  assert.equal(manager.tempLifecycleRelease, null);
  assert.equal(leaseReleased, true);
});

test("CUDA proof evidence requires positive CUDA logs and carries the selected UUID", () => {
  const manager = new WhisperServerManager({ cudaBinaryResolver: () => "cuda.exe" });
  manager.useCuda = true;
  manager.selectedGpuUuid = "GPU-proof";
  manager.lastServerOutput = "ggml_cuda_init: found 1 CUDA device\nCUDA0: NVIDIA";
  assert.deepEqual(manager.getCudaProofEvidence(), {
    backend: "cuda",
    gpuUuid: "GPU-proof",
  });
  manager.lastServerOutput = "whisper_init_state: use gpu = 0; CPU only";
  assert.deepEqual(manager.getCudaProofEvidence(), { backend: "cpu", gpuUuid: null });
});

test("preconverted WAV proof input does not require FFmpeg", async () => {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.hostname = "127.0.0.1";
  manager.port = 1;
  manager.canConvert = false;
  const wav = Buffer.from("RIFF-test");
  let converted = false;
  manager._convertToWav = async () => {
    converted = true;
    return wav;
  };
  const original = require("node:http").request;
  // The request is intentionally allowed to fail after proving conversion was skipped.
  await assert.rejects(
    manager.transcribe(wav, { preconvertedWav: true }),
    (error) => !/FFmpeg/.test(error.message)
  );
  assert.equal(converted, false);
  assert.equal(require("node:http").request, original);
});

test("a ready CPU server cannot satisfy a CUDA proof start", async () => {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.modelPath = "model.bin";
  manager.vadSignature = "vad:off";
  manager.threadSignature = "threads:default";
  manager.useCuda = false;
  let stopped = 0;
  let started = 0;
  manager.stop = async () => {
    stopped += 1;
    manager.process = null;
    manager.ready = false;
  };
  manager._doStart = async (_model, options) => {
    started += 1;
    assert.equal(options.useCuda, true);
    assert.equal(options.requireCuda, true);
  };
  await manager.start("model.bin", { useCuda: true, requireCuda: true });
  assert.equal(stopped, 1);
  assert.equal(started, 1);
});

test("a normal CUDA start restarts when the verified GPU UUID changes", async () => {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.modelPath = "model.bin";
  manager.vadSignature = "vad:off";
  manager.threadSignature = "threads:1";
  manager.useCuda = true;
  manager.selectedGpuUuid = "GPU-old";
  let stopped = 0;
  let started = 0;
  manager.stop = async () => {
    stopped += 1;
    manager.process = null;
    manager.ready = false;
  };
  manager._doStart = async (_model, options) => {
    started += 1;
    assert.equal(options.gpuUuid, "GPU-verified-pointer");
  };

  await manager.start("model.bin", {
    useCuda: true,
    gpuUuid: "GPU-verified-pointer",
    threads: 1,
  });

  assert.equal(stopped, 1);
  assert.equal(started, 1);
});

test("an explicit proof GPU UUID overrides the ambient environment", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-server-gpu-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "cuda.exe");
  const model = path.join(root, "model.bin");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(model, "model");
  const child = new EventEmitter();
  child.pid = 999999997;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let spawnEnv;
  const manager = new WhisperServerManager({
    cudaBinaryResolver: () => binary,
    spawnImpl: (_binary, _args, options) => {
      spawnEnv = options.env;
      return child;
    },
  });
  manager.findAvailablePort = async () => 8178;
  manager.getFFmpegPath = () => null;
  manager.waitForReady = async () => {
    manager.ready = true;
  };
  const old = process.env.TRANSCRIPTION_GPU_UUID;
  process.env.TRANSCRIPTION_GPU_UUID = "GPU-ambient";
  t.after(() => {
    if (old == null) delete process.env.TRANSCRIPTION_GPU_UUID;
    else process.env.TRANSCRIPTION_GPU_UUID = old;
    child.emit("close", 0);
  });
  await manager._doStart(model, {
    useCuda: true,
    requireCuda: true,
    gpuUuid: "GPU-explicit",
    threads: 1,
  });
  assert.equal(spawnEnv.CUDA_VISIBLE_DEVICES, "GPU-explicit");
  assert.equal(manager.selectedGpuUuid, "GPU-explicit");
});
