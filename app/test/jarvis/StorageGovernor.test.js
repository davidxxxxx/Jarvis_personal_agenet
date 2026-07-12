const assert = require("node:assert/strict");
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
      release: () => calls.push("release"),
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
  await fsp.mkdir(path.join(root, "recordings"), { recursive: true });
  await fsp.writeFile(path.join(root, "recordings", "recent.wav"), Buffer.alloc(100));
  await fsp.writeFile(path.join(root, "recordings", "recent.flac"), Buffer.alloc(40));
  await fsp.writeFile(path.join(root, "recordings", "old.wav"), Buffer.alloc(80));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(path.join(root, "recordings", "old.wav"), old, old);
  const governor = new StorageGovernor({ reserve: { ensure() {}, release() {} } });
  const manager = new JarvisStorageManager({
    currentRoot: root,
    governor,
    fsImpl: Object.assign(Object.create(fs), {
      statfsSync: () => ({ bsize: 1, blocks: 100 * GIB, bavail: 30 * GIB }),
    }),
    migrator: { migrate: async () => ({ switched: true }) },
  });
  manager.setProgress({ state: "copying", completedFiles: 1, totalFiles: 2 });

  const status = await manager.getStatus();

  assert.equal(status.state, "ok");
  assert.equal(status.currentRoot, root);
  assert.equal(status.writtenBytes24h, 140);
  assert.equal(status.compressedBytes24h, 40);
  assert.equal(status.projectedDailyGrowthBytes, 140);
  assert.equal(status.remainingDays, Math.floor((30 * GIB - 5 * GIB) / 140));
  assert.deepEqual(status.progress, { state: "copying", completedFiles: 1, totalFiles: 2 });
});
