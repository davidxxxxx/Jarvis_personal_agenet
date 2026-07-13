const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DefaultPathInspector,
  DefaultVolumeInspector,
} = require("../../src/jarvis/main/StoragePathInspector");

function directoryStat() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

test("Windows path inspection recognizes mount-point reparse tags", async () => {
  const inspector = new DefaultPathInspector({
    platform: "win32",
    metadataProvider: async () => ({
      finalPath: "C:\\real\\target",
      attributes: 0x400,
      reparseTag: "0xa0000003",
      driveType: "Fixed",
      volumeGuid: "\\\\?\\Volume{fixed}\\",
      serial: "SERIAL",
    }),
  });

  assert.deepEqual(await inspector.inspect("C:\\link", directoryStat()), {
    reparse: true,
    mountPoint: true,
    reparseTag: "0xa0000003",
    finalPath: "C:\\real\\target",
  });
});

test("Windows path and volume inspection fail closed when authoritative metadata is unavailable", async () => {
  const metadataProvider = async () => {
    throw new Error("powershell unavailable");
  };
  const pathInspector = new DefaultPathInspector({ platform: "win32", metadataProvider });
  await assert.rejects(pathInspector.inspect("C:\\target", directoryStat()), /inspection failed/);

  const volumeInspector = new DefaultVolumeInspector({
    platform: "win32",
    metadataProvider,
    fsImpl: {
      lstat: async () => directoryStat(),
      realpath: async () => "C:\\target",
      access: async () => {},
    },
  });
  assert.deepEqual(await volumeInspector.inspect("C:\\target"), {
    kind: "unknown",
    writable: false,
  });
});

test("Windows volume identity is derived from the resolved final path, GUID, and serial", async () => {
  const seen = [];
  const inspector = new DefaultVolumeInspector({
    platform: "win32",
    fsImpl: {
      lstat: async () => directoryStat(),
      realpath: async () => "D:\\resolved\\target",
      access: async () => {},
    },
    metadataProvider: async (candidate) => {
      seen.push(candidate);
      return {
        finalPath: candidate,
        attributes: 0x10,
        reparseTag: null,
        driveType: "Fixed",
        volumeGuid: "\\\\?\\Volume{actual}\\",
        serial: "A1B2-C3D4",
      };
    },
  });

  assert.deepEqual(await inspector.inspect("D:\\junction\\target"), {
    kind: "fixed",
    writable: true,
    identity: "\\\\?\\Volume{actual}\\|A1B2-C3D4",
    finalPath: "D:\\resolved\\target",
  });
  assert.deepEqual(seen, ["D:\\resolved\\target"]);
});

test("Linux and Darwin volume identity comes from stat.dev rather than the path", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-posix-volume-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const left = path.join(base, "left");
  const right = path.join(base, "right");
  await fsp.mkdir(left);
  await fsp.mkdir(right);
  const expectedDev = String((await fsp.lstat(base)).dev);

  for (const platform of ["linux", "darwin"]) {
    const inspector = new DefaultVolumeInspector({ platform, fsImpl: fsp });
    const leftResult = await inspector.inspect(path.join(left, "not-created-yet"));
    const rightResult = await inspector.inspect(right);
    assert.equal(leftResult.identity, `device:${expectedDev}`);
    assert.equal(rightResult.identity, leftResult.identity);
    assert.equal(leftResult.finalPath, await fsp.realpath(left));
  }
});

test("production Windows inspector rejects a real junction when creation is available", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only junction check");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-real-junction-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const target = path.join(base, "target");
  const junction = path.join(base, "junction");
  await fsp.mkdir(target);
  try {
    fs.symlinkSync(target, junction, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      return t.skip(`junction creation unavailable: ${error.code}`);
    }
    throw error;
  }
  const stat = await fsp.lstat(junction);
  const inspected = await new DefaultPathInspector().inspect(junction, stat);
  assert.equal(inspected.reparse, true);
  assert.equal(inspected.mountPoint, true);
});
