const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const StorageGovernor = require("../../src/jarvis/main/StorageGovernor");
const JarvisStorageManager = require("../../src/jarvis/main/JarvisStorageManager");

const GIB = 1024 ** 3;

test("uses the greater absolute and percentage thresholds at inclusive boundaries", () => {
  const governor = new StorageGovernor({ reserve: { ensure() {}, release() {} } });
  assert.equal(
    governor.evaluate({ volumeBytes: 100 * GIB, freeBytes: 20 * GIB }),
    "warning"
  );
  assert.equal(governor.evaluate({ volumeBytes: 100 * GIB, freeBytes: 5 * GIB }), "stop");
  assert.equal(
    governor.evaluate({ volumeBytes: 400 * GIB, freeBytes: 40 * GIB }),
    "warning"
  );
  assert.equal(governor.evaluate({ volumeBytes: 400 * GIB, freeBytes: 12 * GIB }), "stop");
  assert.equal(
    governor.evaluate({ volumeBytes: 400 * GIB, freeBytes: 40 * GIB + 1 }),
    "ok"
  );
});

test("counts pending writes against free space before classifying", () => {
  const governor = new StorageGovernor({ reserve: { ensure() {}, release() {} } });

  assert.equal(
    governor.evaluate({
      volumeBytes: 100 * GIB,
      freeBytes: 6 * GIB,
      pendingWriteBytes: 1 * GIB,
    }),
    "stop"
  );
});

test("releases the injectable emergency reserve at stop and exposes stopped publicly", () => {
  const calls = [];
  const governor = new StorageGovernor({
    reserve: {
      ensure: () => calls.push("ensure"),
      release: () => {
        calls.push("release");
        return true;
      },
    },
  });

  governor.ensureReserve();
  const status = governor.inspect({ volumeBytes: 100 * GIB, freeBytes: 4 * GIB });

  assert.deepEqual(calls, ["ensure", "release"]);
  assert.equal(status.state, "stopped");
  assert.equal(status.recoveryAction, "Free disk space, then resume capture.");
});

test("fails safe when the emergency reserve cannot be prepared or released", () => {
  const prepareFailure = new StorageGovernor({
    reserve: {
      ensure() {
        throw new Error("private path must not escape");
      },
      release() {},
    },
  });
  assert.throws(() => prepareFailure.ensureReserve(), /emergency storage reserve unavailable/);

  const releaseFailure = new StorageGovernor({
    reserve: {
      ensure() {},
      release() {
        throw new Error("private path must not escape");
      },
    },
  });
  assert.throws(
    () => releaseFailure.inspect({ volumeBytes: 100 * GIB, freeBytes: 4 * GIB }),
    /emergency storage reserve could not be released/
  );

  const missingReserve = new StorageGovernor({
    reserve: {
      ensure() {},
      release() {
        return false;
      },
    },
  });
  assert.throws(
    () => missingReserve.inspect({ volumeBytes: 100 * GIB, freeBytes: 4 * GIB }),
    /emergency storage reserve could not be released/
  );
  assert.equal(missingReserve.reserveReleased, false);
});

test("reserve rejects a same-size linked, sparse, compressed, or under-allocated file", () => {
  const path = require("node:path");
  const filePath = path.resolve("unsafe-reserve");
  const fileStat = {
    size: 8,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const fsImpl = {
    mkdirSync() {},
    lstatSync: () => fileStat,
    statSync: () => fileStat,
  };
  for (const allocation of [
    { allocatedBytes: 8, reparse: true, sparse: false, compressed: false },
    { allocatedBytes: 8, reparse: false, sparse: true, compressed: false },
    { allocatedBytes: 8, reparse: false, sparse: false, compressed: true },
    { allocatedBytes: 7, reparse: false, sparse: false, compressed: false },
  ]) {
    const reserve = new StorageGovernor.FileEmergencyReserve({
      filePath,
      sizeBytes: 8,
      fsImpl,
      allocationInspector: { inspect: () => allocation },
    });
    assert.throws(() => reserve.ensure(), /emergency reserve file is unsafe/);
  }
});

test("reserve rejects a hard-linked file even when size and allocation are valid", () => {
  const path = require("node:path");
  const filePath = path.resolve("hard-linked-reserve");
  const fileStat = {
    size: 8,
    nlink: 2,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const reserve = new StorageGovernor.FileEmergencyReserve({
    filePath,
    sizeBytes: 8,
    fsImpl: {
      mkdirSync() {},
      lstatSync: () => fileStat,
    },
    allocationInspector: {
      inspect: () => ({
        allocatedBytes: 8,
        reparse: false,
        sparse: false,
        compressed: false,
      }),
    },
  });

  assert.throws(() => reserve.ensure(), /emergency reserve file is unsafe/);
});

test("reserve quarantine release preserves a replacement raced in after handle verification", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-release-race-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const filePath = path.join(base, ".emergency-reserve");
  const originalPath = path.join(base, "original-reserve");
  fs.writeFileSync(filePath, "reserved");
  let injected = false;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (source, target) => {
    if (!injected && source === filePath) {
      injected = true;
      fs.renameSync(filePath, originalPath);
      fs.writeFileSync(filePath, "foreign!");
    }
    return fs.renameSync(source, target);
  };
  const reserve = new StorageGovernor.FileEmergencyReserve({
    filePath,
    sizeBytes: 8,
    fsImpl,
    allocationInspector: {
      inspect: () => ({
        allocatedBytes: 8,
        reparse: false,
        sparse: false,
        compressed: false,
      }),
    },
    freeSpaceInspector: { inspect: () => 1_000_000 },
  });

  assert.throws(() => reserve.release(), /emergency reserve file is unsafe/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "foreign!");
  assert.equal(fs.readFileSync(originalPath, "utf8"), "reserved");
});

test("production reserve verifies real allocation and the released-free-space adapter", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-real-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const filePath = path.join(base, ".emergency-reserve");
  const freeSpace = [1_000_000, 1_000_000 + 1024 * 1024];
  const reserve = new StorageGovernor.FileEmergencyReserve({
    filePath,
    sizeBytes: 1024 * 1024,
    freeSpaceInspector: { inspect: () => freeSpace.shift() },
  });

  reserve.ensure();
  assert.equal(fs.statSync(filePath).size, 1024 * 1024);
  assert.equal(reserve.release(), true);
  assert.equal(fs.existsSync(filePath), false);
});

test("rejects invalid or unsafe numeric inputs", () => {
  const governor = new StorageGovernor({ reserve: { ensure() {}, release() {} } });
  assert.throws(() => governor.evaluate({ volumeBytes: 0, freeBytes: 1 }), /volumeBytes/);
  assert.throws(
    () => governor.evaluate({ volumeBytes: 100, freeBytes: 5, pendingWriteBytes: -1 }),
    /pendingWriteBytes/
  );
});

test("status reports real 24-hour bytes, projection, remaining days, root and progress", async (t) => {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-storage-status-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const governor = new StorageGovernor({ reserve: { ensure() {}, release() {} } });
  const now = 1_750_000_000_000;
  let telemetrySince = null;
  const manager = new JarvisStorageManager({
    currentRoot: root,
    governor,
    fsImpl: Object.assign(Object.create(fs), {
      statfsSync: () => ({ bsize: 1, blocks: 100 * GIB, bavail: 30 * GIB }),
      readdirSync: () => {
        throw new Error("status must not walk the data root");
      },
    }),
    usageProvider(since) {
      telemetrySince = since;
      return { writtenBytes24h: 140, compressedBytes24h: 40, netGrowthBytes24h: 60 };
    },
    now: () => now,
    migrator: { migrate: async () => ({ switched: true }) },
  });
  manager.setProgress({ state: "copying", completedFiles: 1, totalFiles: 2 });

  const status = await manager.getStatus();

  assert.equal(status.state, "ok");
  assert.equal(status.currentRoot, root);
  assert.equal(status.writtenBytes24h, 140);
  assert.equal(status.compressedBytes24h, 40);
  assert.equal(status.netGrowthBytes24h, 60);
  assert.equal(status.projectedDailyGrowthBytes, 60);
  assert.equal(status.remainingDays, Math.floor((30 * GIB - 5 * GIB) / 60));
  assert.equal(telemetrySince, now - 24 * 60 * 60 * 1000);
  assert.deepEqual(status.progress, { state: "copying", completedFiles: 1, totalFiles: 2 });
});

test("status does not project exhaustion when signed 24-hour growth is non-positive", async () => {
  const path = require("node:path");
  const manager = new JarvisStorageManager({
    currentRoot: path.resolve("non-growing-root"),
    governor: new StorageGovernor({ reserve: { ensure() {}, release() {} } }),
    fsImpl: { statfsSync: () => ({ bsize: 1, blocks: 100 * GIB, bavail: 30 * GIB }) },
    usageProvider: () => ({
      writtenBytes24h: 140,
      compressedBytes24h: 40,
      netGrowthBytes24h: -20,
    }),
    migrator: { migrate: async () => ({ switched: true }) },
  });

  const status = await manager.getStatus();

  assert.equal(status.netGrowthBytes24h, -20);
  assert.equal(status.projectedDailyGrowthBytes, 0);
  assert.equal(status.remainingDays, null);
});
