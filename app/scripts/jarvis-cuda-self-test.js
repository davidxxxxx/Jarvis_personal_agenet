#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const CudaWhisperVerifier = require("../src/jarvis/main/CudaWhisperVerifier");

function readArgs(argv) {
  const options = { requireCuda: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-cuda") options.requireCuda = true;
    else if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--fixture") options.fixture = argv[++index];
    else if (arg === "--gpu-uuid") options.gpuUuid = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function findBinary(runtime) {
  if (!runtime) return null;
  const resolved = path.resolve(runtime);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  const expected =
    process.platform === "win32"
      ? "whisper-server-win32-x64-cuda.exe"
      : "whisper-server-linux-x64-cuda";
  const queue = [{ directory: resolved, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name === expected) return candidate;
      if (entry.isDirectory() && current.depth < 4) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

async function main() {
  let output;
  let requireCuda = false;
  try {
    const args = readArgs(process.argv.slice(2));
    requireCuda = args.requireCuda;
    const runtime = args.runtime || process.env.JARVIS_CUDA_RUNTIME || null;
    const model = args.model || process.env.LOCAL_WHISPER_MODEL_PATH || null;
    const binaryPath = findBinary(runtime);
    if (!binaryPath) {
      output = { ok: false, backend: "cpu", gpuUuid: null, reason: "verified_runtime_missing" };
    } else if (!model || !fs.existsSync(path.resolve(model))) {
      output = { ok: false, backend: "cpu", gpuUuid: null, reason: "model_missing" };
    } else {
      const originalLog = console.log;
      const originalError = console.error;
      const originalWarn = console.warn;
      console.log = () => {};
      console.error = () => {};
      console.warn = () => {};
      try {
        const verifier = new CudaWhisperVerifier();
        output = await verifier.verify({
          runtimeDir: fs.statSync(path.resolve(runtime)).isDirectory()
            ? path.resolve(runtime)
            : path.dirname(binaryPath),
          binaryPath,
          modelPath: path.resolve(model),
          fixturePath: args.fixture ? path.resolve(args.fixture) : undefined,
          gpuUuid: args.gpuUuid || process.env.TRANSCRIPTION_GPU_UUID || null,
        });
      } finally {
        console.log = originalLog;
        console.error = originalError;
        console.warn = originalWarn;
      }
    }
  } catch (error) {
    output = { ok: false, backend: "unknown", gpuUuid: null, reason: error.message };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (requireCuda && !(output.ok && output.backend === "cuda")) process.exitCode = 1;
}

void main();
