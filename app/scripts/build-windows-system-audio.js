#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET = "x86_64-windows-gnu";
const MANIFEST_SCHEMA_VERSION = 1;
const BINARY_NAME = "windows-system-audio-helper.exe";
const MANIFEST_NAME = "windows-system-audio-helper.manifest.json";
const REQUIRED_CAPABILITIES = Object.freeze({
  supportsSystemAudio: true,
  supportsNativeCapture: true,
  supportsApplicationCapture: true,
  supportsSessionWatch: true,
  minimumWindowsBuild: 20348,
  source: "wasapi-process-loopback",
});

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function findWorkspaceStorageRoot(appRoot) {
  let current = path.resolve(appRoot);
  while (true) {
    if (
      fs.existsSync(path.join(current, ".toolchains")) ||
      fs.existsSync(path.join(current, ".runtime-cache"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(appRoot);
    current = parent;
  }
}

function findZigCompiler({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [];
  if (typeof env.JARVIS_ZIG_PATH === "string" && env.JARVIS_ZIG_PATH.trim()) {
    candidates.push(path.resolve(env.JARVIS_ZIG_PATH.trim()));
  }

  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (directory.trim()) candidates.push(path.join(directory.trim(), "zig.exe"));
  }

  let current = path.resolve(appRoot);
  while (true) {
    candidates.push(
      path.join(
        current,
        ".toolchains",
        "zig-0.16.0",
        "zig-x86_64-windows-0.16.0",
        "zig.exe"
      )
    );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function assertCacheOnWorkspaceDrive(appRoot, cacheRoot) {
  if (!path.isAbsolute(cacheRoot)) throw new Error("native cache root must be absolute");
  if (
    process.platform === "win32" &&
    path.parse(appRoot).root.toLowerCase() !== path.parse(cacheRoot).root.toLowerCase()
  ) {
    throw new Error("native cache must remain on the Jarvis workspace drive");
  }
}

function createCompileInvocation({
  appRoot = path.resolve(__dirname, ".."),
  compilerPath,
  sourcePath,
  outputPath,
  cacheRoot,
  env = process.env,
} = {}) {
  if (!compilerPath || !path.isAbsolute(compilerPath)) {
    throw new Error("an absolute Zig compiler path is required");
  }
  assertCacheOnWorkspaceDrive(appRoot, cacheRoot);
  const tempRoot = path.join(cacheRoot, "temp");
  const globalCache = path.join(cacheRoot, "zig-global");
  const localCache = path.join(cacheRoot, "zig-local");
  return {
    command: compilerPath,
    args: [
      "cc",
      "-target",
      TARGET,
      "-O2",
      "-D_CRT_SECURE_NO_WARNINGS",
      "-o",
      outputPath,
      sourcePath,
      "-lole32",
      "-lmmdevapi",
      "-luuid",
    ],
    options: {
      cwd: appRoot,
      env: {
        ...env,
        TEMP: tempRoot,
        TMP: tempRoot,
        ZIG_GLOBAL_CACHE_DIR: globalCache,
        ZIG_LOCAL_CACHE_DIR: localCache,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function probeHelper(binaryPath, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(binaryPath, ["probe"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Windows system audio helper capability probe failed");
  }
  let capability;
  try {
    capability = JSON.parse(String(result.stdout).trim());
  } catch {
    throw new Error("Windows system audio helper returned an invalid capability probe");
  }
  for (const [name, expected] of Object.entries(REQUIRED_CAPABILITIES)) {
    if (capability?.[name] !== expected) {
      throw new Error(`Windows system audio helper is missing capability: ${name}`);
    }
  }
  if (!Number.isInteger(capability.windowsBuild) || capability.windowsBuild < 0) {
    throw new Error("Windows system audio helper did not report a valid Windows build");
  }
  return capability;
}

function getArtifactPaths(appRoot) {
  const sourcePath = path.join(appRoot, "resources", "windows-system-audio-helper.c");
  const binRoot = path.join(appRoot, "resources", "bin");
  return {
    sourcePath,
    binRoot,
    binaryPath: path.join(binRoot, BINARY_NAME),
    manifestPath: path.join(binRoot, MANIFEST_NAME),
  };
}

function verifyExistingArtifact({
  appRoot = path.resolve(__dirname, ".."),
  spawnSyncImpl = spawnSync,
} = {}) {
  const { sourcePath, binaryPath, manifestPath } = getArtifactPaths(appRoot);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(binaryPath) || !fs.existsSync(manifestPath)) {
    throw new Error("Windows system audio helper artifact or manifest is missing");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sourceSha256 = sha256File(sourcePath);
  const binarySha256 = sha256File(binaryPath);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("Windows system audio helper manifest schema is unsupported");
  }
  if (manifest.sourceSha256 !== sourceSha256) {
    throw new Error("Windows system audio helper source hash does not match its manifest");
  }
  if (manifest.binarySha256 !== binarySha256) {
    throw new Error("Windows system audio helper binary hash does not match its manifest");
  }
  const capability = probeHelper(binaryPath, { spawnSyncImpl });
  return { ok: true, sourceSha256, binarySha256, capability, manifest };
}

function replaceArtifact(stagingPath, outputPath) {
  const backupPath = `${outputPath}.${process.pid}.previous`;
  let movedPrevious = false;
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (fs.existsSync(outputPath)) {
      fs.renameSync(outputPath, backupPath);
      movedPrevious = true;
    }
    fs.renameSync(stagingPath, outputPath);
    if (movedPrevious) fs.unlinkSync(backupPath);
  } catch (error) {
    if (!fs.existsSync(outputPath) && movedPrevious && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, outputPath);
    }
    throw error;
  } finally {
    if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
  }
}

function buildWindowsSystemAudio({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
  force = false,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") {
    console.log("[windows-system-audio-helper] Skipping native Windows build");
    return { skipped: true };
  }

  if (!force) {
    try {
      const verified = verifyExistingArtifact({ appRoot, spawnSyncImpl });
      console.log("[windows-system-audio-helper] Source-pinned artifact is current");
      return verified;
    } catch {}
  }

  const compilerPath = findZigCompiler({ appRoot, env });
  if (!compilerPath) {
    throw new Error(
      "Zig 0.16.0 is required to rebuild the source-pinned Windows system audio helper"
    );
  }

  const storageRoot = findWorkspaceStorageRoot(appRoot);
  const cacheRoot = path.resolve(
    env.JARVIS_NATIVE_CACHE_DIR || path.join(storageRoot, ".runtime-cache", "native-build")
  );
  assertCacheOnWorkspaceDrive(appRoot, cacheRoot);
  const { sourcePath, binRoot, binaryPath, manifestPath } = getArtifactPaths(appRoot);
  const stagingPath = path.join(cacheRoot, `${BINARY_NAME}.${process.pid}.tmp.exe`);
  fs.mkdirSync(binRoot, { recursive: true });
  for (const directory of [
    cacheRoot,
    path.join(cacheRoot, "temp"),
    path.join(cacheRoot, "zig-global"),
    path.join(cacheRoot, "zig-local"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const invocation = createCompileInvocation({
    appRoot,
    compilerPath,
    sourcePath,
    outputPath: stagingPath,
    cacheRoot,
    env,
  });
  const compileResult = spawnSyncImpl(invocation.command, invocation.args, invocation.options);
  if (compileResult.error || compileResult.status !== 0) {
    if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
    throw new Error("Windows system audio helper compilation failed");
  }
  const capability = probeHelper(stagingPath, { spawnSyncImpl });
  const sourceSha256 = sha256File(sourcePath);
  const binarySha256 = sha256File(stagingPath);
  replaceArtifact(stagingPath, binaryPath);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceSha256,
    binarySha256,
    compiler: {
      family: "zig-cc",
      version: "0.16.0",
      target: TARGET,
    },
    capability: {
      supportsSystemAudio: capability.supportsSystemAudio,
      supportsNativeCapture: capability.supportsNativeCapture,
      supportsApplicationCapture: capability.supportsApplicationCapture,
      supportsSessionWatch: capability.supportsSessionWatch,
      minimumWindowsBuild: capability.minimumWindowsBuild,
      source: capability.source,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[windows-system-audio-helper] Built and verified ${binarySha256}`);
  return { ok: true, sourceSha256, binarySha256, capability, manifest };
}

if (require.main === module) {
  try {
    buildWindowsSystemAudio({ force: process.argv.includes("--force") });
  } catch (error) {
    console.error(`[windows-system-audio-helper] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildWindowsSystemAudio,
  createCompileInvocation,
  findZigCompiler,
  probeHelper,
  verifyExistingArtifact,
};
