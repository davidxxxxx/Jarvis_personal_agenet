const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "..", "..", "scripts", "jarvis-cuda-self-test.js");

test("default CUDA self-test is a single truthful no-download fallback result", () => {
  const env = { ...process.env };
  delete env.JARVIS_CUDA_RUNTIME;
  delete env.LOCAL_WHISPER_MODEL_PATH;
  env.WHISPER_CUDA_ENABLED = "sentinel";
  const child = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, "");
  const lines = child.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    ok: false,
    backend: "cpu",
    gpuUuid: null,
    reason: "verified_runtime_missing",
  });
  assert.equal(process.env.WHISPER_CUDA_ENABLED, undefined);
});

test("--require-cuda makes the truthful fallback a failing hardware gate", () => {
  const env = { ...process.env };
  delete env.JARVIS_CUDA_RUNTIME;
  delete env.LOCAL_WHISPER_MODEL_PATH;
  const child = spawnSync(process.execPath, [script, "--require-cuda"], {
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).backend, "cpu");
});
