const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const { releaseReserve, releaseReserveSync } = require("../../src/jarvis/main/SafeReserveFile");

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function allocated(size) {
  return {
    allocatedBytes: size,
    reparse: false,
    sparse: false,
    compressed: false,
  };
}

function availableBytes(stat) {
  return Number(stat.bavail) * Number(stat.bsize);
}

test("successful object-bound release survives same-volume writes that obscure telemetry", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-contention-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const competingPath = path.join(base, "competing-write.bin");
  const sizeBytes = 4096;
  await fsp.writeFile(reservePath, Buffer.alloc(sizeBytes, 1));

  const reserveReleased = deferred();
  const writerFinished = deferred();
  const fsImpl = Object.assign({}, fsp, {
    async open(candidate, ...args) {
      const handle = await fsp.open(candidate, ...args);
      if (path.resolve(candidate) !== path.resolve(reservePath)) return handle;
      return {
        close: handle.close.bind(handle),
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        async truncate(length) {
          const result = await handle.truncate(length);
          reserveReleased.resolve();
          await writerFinished.promise;
          return result;
        },
      };
    },
    async unlink(candidate) {
      await fsp.unlink(candidate);
      if (String(candidate).includes(".release-")) {
        reserveReleased.resolve();
        await writerFinished.promise;
      }
    },
  });
  const telemetry = [];
  const freeSpaceInspector = {
    async inspectAsync(directory) {
      return availableBytes(await fsp.statfs(directory));
    },
  };
  const competingWriter = (async () => {
    await reserveReleased.promise;
    const handle = await fsp.open(competingPath, "w");
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x5a);
      for (let index = 0; index < 64; index += 1) await handle.write(chunk);
      await handle.sync();
    } finally {
      await handle.close();
      writerFinished.resolve();
    }
  })();

  const [released] = await Promise.all([
    releaseReserve({
      filePath: reservePath,
      sizeBytes,
      fsImpl,
      allocationInspector: { inspect: () => allocated(sizeBytes) },
      freeSpaceInspector,
      onFreeSpaceTelemetry: (sample) => telemetry.push(sample),
    }),
    competingWriter,
  ]);

  assert.equal(released, true);
  assert.equal(fs.existsSync(reservePath), false);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].confirmed, false);
  assert.equal(telemetry[0].requiredBytes, sizeBytes);
  assert.equal(telemetry[0].observedDeltaBytes < sizeBytes, true);
  assert.equal(Object.hasOwn(telemetry[0], "filePath"), false);
  const tombstones = (await fsp.readdir(base)).filter((name) =>
    name.startsWith(".emergency-reserve.release-")
  );
  assert.equal(tombstones.length, 1);
  assert.equal((await fsp.stat(path.join(base, tombstones[0]))).size, 0);
});

test("free-space telemetry sampling cannot undo an authoritative release", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-telemetry-error-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 2));

  const released = await releaseReserve({
    filePath: reservePath,
    sizeBytes: 4096,
    allocationInspector: { inspect: () => allocated(4096) },
    freeSpaceInspector: {
      async inspectAsync() {
        throw new Error("telemetry unavailable");
      },
    },
    onFreeSpaceTelemetry() {
      throw new Error("telemetry sink unavailable");
    },
  });

  assert.equal(released, true);
  assert.equal(fs.existsSync(reservePath), false);
});

test("async telemetry sinks cannot delay an authoritative release", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-telemetry-pending-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 6));
  let telemetryStarted = false;
  const neverSettles = new Promise(() => {});

  const outcome = await Promise.race([
    releaseReserve({
      filePath: reservePath,
      sizeBytes: 4096,
      allocationInspector: { inspect: () => allocated(4096) },
      freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
      onFreeSpaceTelemetry() {
        telemetryStarted = true;
        return neverSettles;
      },
    }),
    delay(250, "timed-out"),
  ]);

  assert.equal(outcome, true);
  assert.equal(telemetryStarted, true);
  assert.equal(fs.existsSync(reservePath), false);
});

test("release APIs reject invalid reserve sizes before touching the filesystem", async () => {
  const filePath = path.resolve("invalid-emergency-reserve");
  for (const sizeBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      releaseReserve({ filePath, sizeBytes }),
      /sizeBytes must be a positive safe integer/
    );
    assert.throws(
      () => releaseReserveSync({ filePath, sizeBytes }),
      /sizeBytes must be a positive safe integer/
    );
  }
});

test("release rejects wrong-size, reparse, sparse, compressed, and under-allocated reserves", async (t) => {
  for (const [name, allocation, sizeBytes = 4096] of [
    ["wrong-size", allocated(4096), 2048],
    ["reparse", { ...allocated(4096), reparse: true }],
    ["sparse", { ...allocated(4096), sparse: true }],
    ["compressed", { ...allocated(4096), compressed: true }],
    ["under-allocated", allocated(4095)],
  ]) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), `jarvis-reserve-${name}-`));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const reservePath = path.join(base, ".emergency-reserve");
    await fsp.writeFile(reservePath, Buffer.alloc(4096, 3));

    await assert.rejects(
      releaseReserve({
        filePath: reservePath,
        sizeBytes,
        allocationInspector: { inspect: () => allocation },
        freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
      }),
      /emergency reserve file is unsafe/,
      name
    );
    assert.equal(fs.existsSync(reservePath), true, name);
  }
});

test("release rejects a hard-linked reserve without removing either name", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-hardlink-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const linkedPath = path.join(base, "linked-reserve");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 4));
  await fsp.link(reservePath, linkedPath);

  await assert.rejects(
    releaseReserve({
      filePath: reservePath,
      sizeBytes: 4096,
      allocationInspector: { inspect: () => allocated(4096) },
      freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
    }),
    /emergency reserve file is unsafe/
  );

  assert.equal(fs.existsSync(reservePath), true);
  assert.equal(fs.existsSync(linkedPath), true);
});

test("async release does not restore an unverified replacement after the quarantine rename", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-async-rename-swap-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const movedOriginalPath = path.join(base, "moved-original-reserve");
  const latercomer = Buffer.from("unverified quarantine replacement");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 0x31));
  let quarantinePath = null;
  const fsImpl = Object.assign({}, fsp, {
    async rename(source, target) {
      if (path.resolve(source) === path.resolve(reservePath)) {
        quarantinePath = target;
        await fsp.rename(source, movedOriginalPath);
        await fsp.writeFile(source, latercomer);
      }
      return fsp.rename(source, target);
    },
  });

  await assert.rejects(
    releaseReserve({
      filePath: reservePath,
      sizeBytes: 4096,
      fsImpl,
      allocationInspector: { inspect: () => allocated(4096) },
      freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
    }),
    /emergency reserve file is unsafe/
  );

  assert.equal(fs.existsSync(reservePath), false);
  assert.deepEqual(await fsp.readFile(quarantinePath), latercomer);
  assert.equal((await fsp.stat(quarantinePath)).nlink, 1);
  assert.equal((await fsp.stat(movedOriginalPath)).size, 4096);
});

test("sync release does not restore an unverified replacement after the quarantine rename", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-sync-rename-swap-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const movedOriginalPath = path.join(base, "moved-original-reserve");
  const latercomer = Buffer.from("unverified quarantine replacement");
  fs.writeFileSync(reservePath, Buffer.alloc(4096, 0x32));
  let quarantinePath = null;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (source, target) => {
    if (path.resolve(source) === path.resolve(reservePath)) {
      quarantinePath = target;
      fs.renameSync(source, movedOriginalPath);
      fs.writeFileSync(source, latercomer);
    }
    return fs.renameSync(source, target);
  };

  assert.throws(
    () =>
      releaseReserveSync({
        filePath: reservePath,
        sizeBytes: 4096,
        fsImpl,
        allocationInspector: { inspect: () => allocated(4096) },
        freeSpaceInspector: { inspect: () => 1_000_000 },
      }),
    /emergency reserve file is unsafe/
  );

  assert.equal(fs.existsSync(reservePath), false);
  assert.deepEqual(fs.readFileSync(quarantinePath), latercomer);
  assert.equal(fs.statSync(quarantinePath).nlink, 1);
  assert.equal(fs.statSync(movedOriginalPath).size, 4096);
});

test("async release preserves a quarantine replacement introduced after validation", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-async-swap-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const movedOriginalPath = path.join(base, "moved-original-reserve");
  const latercomer = Buffer.from("later quarantine occupant");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 0x41));
  let quarantinePath = null;
  let raced = false;
  const injectRace = async () => {
    if (raced) return;
    raced = true;
    await fsp.rename(quarantinePath, movedOriginalPath);
    await fsp.writeFile(quarantinePath, latercomer);
  };
  const fsImpl = Object.assign({}, fsp, {
    async open(candidate, ...args) {
      const handle = await fsp.open(candidate, ...args);
      if (path.resolve(candidate) !== path.resolve(reservePath)) return handle;
      return {
        close: handle.close.bind(handle),
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        async truncate(length) {
          await injectRace();
          return handle.truncate(length);
        },
      };
    },
    async rename(source, target) {
      await fsp.rename(source, target);
      if (path.resolve(source) === path.resolve(reservePath)) quarantinePath = target;
    },
    async unlink(candidate) {
      if (quarantinePath && path.resolve(candidate) === path.resolve(quarantinePath)) {
        await injectRace();
      }
      return fsp.unlink(candidate);
    },
  });

  await assert.rejects(
    releaseReserve({
      filePath: reservePath,
      sizeBytes: 4096,
      fsImpl,
      allocationInspector: { inspect: () => allocated(4096) },
      freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
    }),
    /emergency reserve file is unsafe/
  );

  assert.equal(raced, true);
  assert.deepEqual(await fsp.readFile(quarantinePath), latercomer);
  assert.equal((await fsp.stat(movedOriginalPath)).size, 0);
  assert.equal(fs.existsSync(reservePath), false);
});

test("sync release preserves a quarantine replacement introduced after validation", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reserve-sync-swap-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const movedOriginalPath = path.join(base, "moved-original-reserve");
  const latercomer = Buffer.from("later quarantine occupant");
  fs.writeFileSync(reservePath, Buffer.alloc(4096, 0x42));
  let quarantinePath = null;
  let raced = false;
  const injectRace = () => {
    if (raced) return;
    raced = true;
    fs.renameSync(quarantinePath, movedOriginalPath);
    fs.writeFileSync(quarantinePath, latercomer);
  };
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (source, target) => {
    fs.renameSync(source, target);
    if (path.resolve(source) === path.resolve(reservePath)) quarantinePath = target;
  };
  fsImpl.ftruncateSync = (descriptor, length) => {
    injectRace();
    return fs.ftruncateSync(descriptor, length);
  };
  fsImpl.unlinkSync = (candidate) => {
    if (quarantinePath && path.resolve(candidate) === path.resolve(quarantinePath)) injectRace();
    return fs.unlinkSync(candidate);
  };

  assert.throws(
    () =>
      releaseReserveSync({
        filePath: reservePath,
        sizeBytes: 4096,
        fsImpl,
        allocationInspector: { inspect: () => allocated(4096) },
        freeSpaceInspector: { inspect: () => 1_000_000 },
      }),
    /emergency reserve file is unsafe/
  );

  assert.equal(raced, true);
  assert.deepEqual(fs.readFileSync(quarantinePath), latercomer);
  assert.equal(fs.statSync(movedOriginalPath).size, 0);
  assert.equal(fs.existsSync(reservePath), false);
});
