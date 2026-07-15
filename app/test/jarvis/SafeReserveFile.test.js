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

test("successful unlink survives same-volume writes that obscure free-space telemetry", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-contention-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const reservePath = path.join(base, ".emergency-reserve");
  const competingPath = path.join(base, "competing-write.bin");
  const sizeBytes = 4096;
  await fsp.writeFile(reservePath, Buffer.alloc(sizeBytes, 1));

  const reserveUnlinked = deferred();
  const writerFinished = deferred();
  const fsImpl = Object.assign({}, fsp, {
    async unlink(candidate) {
      await fsp.unlink(candidate);
      if (String(candidate).includes(".release-")) {
        reserveUnlinked.resolve();
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
    await reserveUnlinked.promise;
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
