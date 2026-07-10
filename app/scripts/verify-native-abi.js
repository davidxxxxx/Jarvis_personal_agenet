"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RUNTIME_SMOKE_PATH = path.join(__dirname, "native-abi-smoke-runtime.js");

function assertSafeLabel(label) {
  if (typeof label !== "string" || !/^[a-z0-9-]{1,40}$/.test(label)) {
    throw new Error("native ABI verification received an invalid label");
  }
}

function assertAbsoluteEntry(entryPath, type, label) {
  if (typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
    throw new Error(`native ABI verification failed (${label})`);
  }
  let stat;
  try {
    stat = fs.lstatSync(entryPath);
  } catch {
    throw new Error(`native ABI verification failed (${label})`);
  }
  if (stat.isSymbolicLink() || (type === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`native ABI verification failed (${label})`);
  }
}

function verifyNativeAbi({
  runtimePath,
  modulePath,
  binaryPath,
  expectedAbi,
  label,
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  assertSafeLabel(label);
  if (!/^\d+$/.test(String(expectedAbi ?? ""))) {
    throw new Error(`native ABI verification failed (${label})`);
  }
  assertAbsoluteEntry(runtimePath, "file", label);
  assertAbsoluteEntry(modulePath, "directory", label);
  assertAbsoluteEntry(binaryPath, "file", label);

  const env = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSyncImpl(
    runtimePath,
    [RUNTIME_SMOKE_PATH, modulePath, binaryPath, String(expectedAbi)],
    {
      cwd: path.dirname(RUNTIME_SMOKE_PATH),
      encoding: "utf8",
      env,
      shell: false,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }
  );

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? "").trim());
  } catch {}
  if (
    result.error ||
    result.status !== 0 ||
    parsed?.ok !== true ||
    parsed?.abi !== String(expectedAbi) ||
    parsed?.value !== 1
  ) {
    throw new Error(`native ABI verification failed (${label})`);
  }
  return { ok: true, abi: String(expectedAbi), value: 1 };
}

if (require.main === module) {
  const [runtimePath, modulePath, binaryPath, expectedAbi, label] = process.argv.slice(2);
  try {
    const result = verifyNativeAbi({ runtimePath, modulePath, binaryPath, expectedAbi, label });
    process.stdout.write(
      JSON.stringify({ ok: result.ok, abi: result.abi, value: result.value, label })
    );
  } catch (error) {
    process.stderr.write(String(error.message));
    process.exitCode = 1;
  }
}

module.exports = { verifyNativeAbi };
