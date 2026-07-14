const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const crypto = require("node:crypto");

const {
  WHISPER_CUDA_MANIFEST,
  getWhisperCudaDownloadUrl,
} = require("../../src/jarvis/main/WhisperCudaManifest");
const WhisperCudaManager = require("../../src/helpers/whisperCudaManager");

const PINNED = {
  repository: "OpenWhispr/whisper.cpp",
  tag: "0.0.7",
  asset: "whisper-server-win32-x64-cuda.zip",
  size: 754_998_658,
  sha256: "cdac6f0afb951b4213943297943a9865ae822a8669d623d1d6eb46a0dc0a38c6",
};

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cuda-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeManager(t, overrides = {}) {
  const root = makeRoot(t);
  const calls = { download: 0, extract: 0, verify: 0 };
  const manager = new WhisperCudaManager({
    platform: "win32",
    componentRoot: root,
    manifest: {
      ...PINNED,
      size: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    },
    extractedSizeEstimate: 8,
    diskSafetyMargin: 0,
    checkDiskSpace: async () => ({ ok: true, availableBytes: 10_000 }),
    inspectArchive: async () => [
      { path: "runtime/whisper-server-win32-x64-cuda.exe", type: "File" },
    ],
    downloadFile: async (_url, destination) => {
      calls.download += 1;
      fs.writeFileSync(destination, Buffer.from([1, 2, 3, 4]));
    },
    extractArchive: async (_archive, destination) => {
      calls.extract += 1;
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "whisper-server-win32-x64-cuda.exe"), "exe");
      fs.writeFileSync(path.join(destination, "cublas64_12.dll"), "dll");
      fs.writeFileSync(path.join(destination, "cudart64_12.dll"), "dll");
    },
    verifyRuntime: async ({ runtimeDir }) => {
      calls.verify += 1;
      return {
        ok: true,
        backend: "cuda",
        gpuUuid: "GPU-test",
        reason: "verified",
        driver: "1",
        peakVramMb: 64,
        modelId: "model-hash",
        runtimeDir,
      };
    },
    ...overrides,
  });
  return { root, calls, manager };
}

test("pins the approved Windows CUDA asset byte-for-byte", () => {
  assert.deepEqual(WHISPER_CUDA_MANIFEST, PINNED);
  assert.equal(Object.isFrozen(WHISPER_CUDA_MANIFEST), true);
  assert.equal(
    getWhisperCudaDownloadUrl(WHISPER_CUDA_MANIFEST),
    "https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.7/whisper-server-win32-x64-cuda.zip"
  );
});

test("does no network or filesystem write without explicit consent", async (t) => {
  const { root, calls, manager } = makeManager(t);
  const before = fs.readdirSync(root);
  const result = await manager.installPinnedCudaRuntime({ consent: false });
  assert.equal(result.success, false);
  assert.equal(result.code, "CONSENT_REQUIRED");
  assert.deepEqual(calls, { download: 0, extract: 0, verify: 0 });
  assert.deepEqual(fs.readdirSync(root), before);
});

test("rejects a digest mismatch before extraction and preserves the old pointer", async (t) => {
  const { root, calls, manager } = makeManager(t, {
    manifest: { ...PINNED, size: 4, sha256: "0".repeat(64) },
  });
  fs.writeFileSync(path.join(root, "current.json"), '{"version":"old"}\n');
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true }),
    (error) => error?.code === "CUDA_ARCHIVE_HASH_MISMATCH"
  );
  assert.equal(calls.extract, 0);
  assert.equal(fs.readFileSync(path.join(root, "current.json"), "utf8"), '{"version":"old"}\n');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "quarantine.json"), "utf8")).quarantined,
    true
  );
});

test("rejects missing companion libraries and leaves the old pointer untouched", async (t) => {
  const { root, manager } = makeManager(t, {
    extractArchive: async (_archive, destination) => {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "whisper-server-win32-x64-cuda.exe"), "exe");
    },
  });
  fs.writeFileSync(path.join(root, "current.json"), '{"version":"old"}\n');
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true }),
    (error) => error?.code === "CUDA_COMPANION_LIBRARY_MISSING"
  );
  assert.equal(fs.readFileSync(path.join(root, "current.json"), "utf8"), '{"version":"old"}\n');
});

test("fails closed when free disk space cannot be measured", async (t) => {
  const { calls, manager } = makeManager(t, {
    checkDiskSpace: async () => ({ ok: true, availableBytes: Infinity }),
  });
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true }),
    (error) => error?.code === "CUDA_DISK_SPACE_UNKNOWN"
  );
  assert.equal(calls.download, 0);
});

test("rejects unsafe zip entries before invoking the extractor", async (t) => {
  const { root, calls, manager } = makeManager(t, {
    inspectArchive: async () => [{ path: "../escape.exe", type: "File", size: 1 }],
  });
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true }),
    (error) => error?.code === "CUDA_ARCHIVE_UNSAFE_PATH"
  );
  assert.equal(calls.extract, 0);
  assert.equal(fs.existsSync(path.join(root, "..", "escape.exe")), false);
});

test("an already-aborted install leaves no operation artifacts", async (t) => {
  const { root, calls, manager } = makeManager(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true, signal: controller.signal }),
    (error) => error?.code === "CUDA_INSTALL_CANCELLED"
  );
  assert.equal(calls.download, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("AbortController cancels a pending download and cleans only its own partial", async (t) => {
  let downloadStarted;
  const started = new Promise((resolve) => {
    downloadStarted = resolve;
  });
  const { root, manager } = makeManager(t, {
    downloadFile: async (_url, _destination, { signal }) => {
      downloadStarted();
      await new Promise((_, reject) => {
        signal.onAbort = () => reject(Object.assign(new Error("aborted"), { isAbort: true }));
      });
    },
  });
  const pointerBytes = '{"old":"pointer"}\n';
  fs.writeFileSync(path.join(root, "current.json"), pointerBytes);
  const controller = new AbortController();
  const pending = manager.installPinnedCudaRuntime({ consent: true, signal: controller.signal });
  const sameFlight = manager.installPinnedCudaRuntime({ consent: true, signal: controller.signal });
  assert.equal(sameFlight, pending);
  await started;
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "CUDA_INSTALL_CANCELLED");
  assert.equal(fs.readFileSync(path.join(root, "current.json"), "utf8"), pointerBytes);
  assert.deepEqual(fs.readdirSync(root), ["current.json"]);
  assert.equal(manager._activeDownload, null);
});

test("promotes only a verified immutable runtime and resolves it through current.json", async (t) => {
  const { root, manager } = makeManager(t);
  const result = await manager.installPinnedCudaRuntime({ consent: true });
  assert.equal(result.success, true);
  assert.equal(result.verification.ok, true);
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8"));
  assert.equal(pointer.version, "0.0.7");
  assert.equal(pointer.sha256, manager.manifest.sha256);
  assert.equal(
    manager.getCudaBinaryPath(),
    path.join(
      root,
      "versions",
      `0.0.7-${manager.manifest.sha256.slice(0, 16)}`,
      "whisper-server-win32-x64-cuda.exe"
    )
  );
  assert.equal(manager.isVerified({ gpuUuid: "GPU-test" }), true);
});

test("rejects malformed or escaping pointers", (t) => {
  const { root, manager } = makeManager(t);
  fs.writeFileSync(
    path.join(root, "current.json"),
    JSON.stringify({ version: "..", binary: "outside.exe" })
  );
  assert.equal(manager.getCudaBinaryPath(), null);
  fs.writeFileSync(path.join(root, "current.json"), "not json");
  assert.equal(manager.getCudaBinaryPath(), null);
});

test("resetDataRoot follows the newly selected component root", (t) => {
  const { manager } = makeManager(t);
  const next = makeRoot(t);
  process.env.JARVIS_DATA_ROOT = next;
  t.after(() => delete process.env.JARVIS_DATA_ROOT);
  manager.resetDataRoot();
  assert.equal(manager.getCudaBinaryDir(), path.join(next, "components", "cuda"));
});

test("a failed same-tag reinstall cannot replace the current verified runtime", async (t) => {
  const { root, manager } = makeManager(t, {
    verifyRuntime: async () => ({
      ok: false,
      backend: "cpu",
      gpuUuid: null,
      reason: "cuda_not_active",
    }),
  });
  const oldDir = path.join(root, "old-runtime");
  fs.mkdirSync(oldDir);
  const oldFiles = [
    ["whisper-server-win32-x64-cuda.exe", "trusted-old-exe"],
    ["cublas64_12.dll", "trusted-old-cublas"],
    ["cudart64_12.dll", "trusted-old-cudart"],
  ];
  const integrity = oldFiles.map(([name, bytes]) => {
    fs.writeFileSync(path.join(oldDir, name), bytes);
    return {
      path: name,
      size: Buffer.byteLength(bytes),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const oldPointer = {
    schemaVersion: 1,
    version: manager.manifest.tag,
    asset: manager.manifest.asset,
    directory: "old-runtime",
    sha256: manager.manifest.sha256,
    binary: "whisper-server-win32-x64-cuda.exe",
    files: integrity,
    verification: { ok: true, backend: "cuda", gpuUuid: "GPU-old", reason: "verified" },
  };
  const pointerBytes = `${JSON.stringify(oldPointer, null, 2)}\n`;
  fs.writeFileSync(path.join(root, "current.json"), pointerBytes);
  const oldBinary = manager.getCudaBinaryPath();
  await assert.rejects(
    manager.installPinnedCudaRuntime({ consent: true, verification: { gpuUuid: "GPU-new" } }),
    (error) => error?.code === "CUDA_VERIFICATION_FAILED"
  );
  assert.equal(fs.readFileSync(path.join(root, "current.json"), "utf8"), pointerBytes);
  assert.equal(fs.readFileSync(path.join(oldDir, oldFiles[0][0]), "utf8"), "trusted-old-exe");
  assert.equal(manager.getCudaBinaryPath(), oldBinary);
  assert.equal(manager.isVerified({ gpuUuid: "GPU-old" }), true);
});

test("runtime tampering invalidates a previously verified pointer", async (t) => {
  const { root, manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({ consent: true });
  const binary = manager.getCudaBinaryPath();
  fs.writeFileSync(path.join(root, "keep.txt"), "not managed by CUDA");
  fs.appendFileSync(binary, "tampered");
  assert.equal(manager.getCudaBinaryPath(), null);
  assert.equal(manager.isVerified({ gpuUuid: "GPU-test" }), false);
  const status = manager.getStatus();
  assert.equal(status.reason, "CUDA_INTEGRITY_SIZE_MISMATCH");
  assert.equal(status.present, true);
  assert.equal(status.verified, false);
  assert.equal(status.actions.includes("remove"), true);
  assert.equal((await manager.delete()).success, true);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "not managed by CUDA");
  assert.equal(manager.getStatus().present, false);
});

test("a nested official archive layout resolves after a fresh process", async (t) => {
  const { root, manager } = makeManager(t, {
    extractArchive: async (_archive, destination) => {
      const nested = path.join(destination, "Release", "bin");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "whisper-server-win32-x64-cuda.exe"), "exe");
      fs.writeFileSync(path.join(nested, "cublas64_12.dll"), "dll");
      fs.writeFileSync(path.join(nested, "cudart64_12.dll"), "dll");
    },
  });
  const installed = await manager.installPinnedCudaRuntime({ consent: true });
  const fresh = new WhisperCudaManager({
    platform: "win32",
    componentRoot: root,
    manifest: manager.manifest,
  });
  assert.equal(fresh.getCudaBinaryPath(), installed.path);
  assert.match(installed.path, /Release[\\/]bin[\\/]whisper-server-win32-x64-cuda\.exe$/);
});

test("Retry repairs an integrity-invalid present runtime through a new pinned install", async (t) => {
  const { manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({ consent: true });
  fs.appendFileSync(manager.getCudaBinaryPath(), "tampered");
  const broken = manager.getStatus();
  assert.equal(broken.present, true);
  assert.equal(broken.path, null);
  const repaired = await manager.installPinnedCudaRuntime({ consent: true });
  assert.equal(repaired.success, true);
  assert.equal(manager.getStatus().verified, true);
  assert.notEqual(manager.getCudaBinaryPath(), null);
});

test("an installed runtime can be re-verified for a newly selected GPU without downloading", async (t) => {
  const { calls, manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({ consent: true });
  const downloadCount = calls.download;
  const verification = await manager.verifyInstalledCudaRuntime({
    gpuUuid: "GPU-new",
    verify: async () => ({ ok: true, backend: "cuda", gpuUuid: "GPU-new", reason: "verified" }),
  });
  assert.equal(verification.ok, true);
  assert.equal(manager.isVerified({ gpuUuid: "GPU-new" }), true);
  assert.equal(calls.download, downloadCount);
});

test("transient CUDA verification failures quarantine only on the third boot attempt", async (t) => {
  const { root, manager } = makeManager(t, {
    verifyRuntime: async () => ({
      ok: false,
      backend: "unknown",
      gpuUuid: null,
      reason: "cuda_driver_failure",
    }),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      manager.installPinnedCudaRuntime({ consent: true }),
      (error) => error?.code === "CUDA_VERIFICATION_FAILED"
    );
  }
  const entries = fs.readdirSync(root);
  assert.equal(entries.filter((name) => name.includes(".failed-")).length, 2);
  assert.equal(entries.filter((name) => name.includes(".quarantine-")).length, 1);
  assert.equal(manager.getCudaBinaryPath(), null);
});

test("three transient re-verification failures safe-disable the pointer but preserve rollback", async (t) => {
  const { manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({ consent: true });
  const trustedPath = manager.getCudaBinaryPath();
  const trustedBytes = fs.readFileSync(trustedPath);
  const failure = {
    verify: async () => ({
      ok: false,
      backend: "unknown",
      gpuUuid: null,
      reason: "cuda_driver_failure",
    }),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await manager.verifyInstalledCudaRuntime(failure)).ok, false);
    assert.equal(manager.getCudaBinaryPath(), trustedPath);
  }
  assert.equal((await manager.verifyInstalledCudaRuntime(failure)).ok, false);
  assert.equal(manager.getCudaBinaryPath(), null);
  assert.equal(manager.getStatus().canRollback, true);
  assert.equal(fs.readFileSync(trustedPath).equals(trustedBytes), true);
  assert.equal((await manager.rollback()).success, true);
  assert.equal(manager.getCudaBinaryPath(), trustedPath);
});

test("persists bounded peak VRAM metadata without changing verifier result shape", async (t) => {
  const { root, manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({
    consent: true,
    verification: { getMetadata: () => ({ peakVramMb: 321 }) },
  });
  const record = JSON.parse(fs.readFileSync(path.join(root, "verification.json"), "utf8"));
  assert.equal(record.peakVramMb, 321);
});

test("rollback accepts a previously verified older manifest pointer and resolves it", async (t) => {
  const oldManifest = {
    repository: "OpenWhispr/whisper.cpp",
    tag: "0.0.6",
    asset: "whisper-server-win32-x64-cuda-v1.zip",
    size: 4,
    sha256: "1".repeat(64),
  };
  const { root, manager } = makeManager(t, {
    approvedManifests: [
      {
        ...PINNED,
        size: 4,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      },
      oldManifest,
    ],
  });
  await manager.installPinnedCudaRuntime({ consent: true });
  const current = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8"));
  const currentDir = path.join(root, current.directory);
  const oldDir = path.join(root, "rollback-v1");
  fs.cpSync(currentDir, oldDir, { recursive: true });
  const previous = {
    ...current,
    version: "0.0.6",
    asset: oldManifest.asset,
    directory: "rollback-v1",
    sha256: "1".repeat(64),
    verification: { ...current.verification, gpuUuid: "GPU-old" },
  };
  fs.writeFileSync(path.join(root, "previous.json"), `${JSON.stringify(previous, null, 2)}\n`);
  assert.equal(manager.getStatus().canRollback, true);
  const rolledBack = await manager.rollback();
  assert.equal(rolledBack.success, true);
  assert.match(rolledBack.path, /rollback-v1/);
  assert.equal(manager.isVerified({ gpuUuid: "GPU-old" }), true);
});

test("rollback rejects an unknown manifest even when the pointer self-claims verification", async (t) => {
  const { root, manager } = makeManager(t);
  await manager.installPinnedCudaRuntime({ consent: true });
  const current = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8"));
  fs.writeFileSync(
    path.join(root, "previous.json"),
    `${JSON.stringify({
      ...current,
      version: "0.0.6",
      asset: "unknown.zip",
      sha256: "2".repeat(64),
    })}\n`
  );
  assert.equal(manager.getStatus().canRollback, false);
  assert.equal((await manager.rollback()).success, false);
});
