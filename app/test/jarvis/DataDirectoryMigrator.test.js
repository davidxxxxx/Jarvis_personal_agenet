const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DataDirectoryMigrator = require("../../src/jarvis/main/DataDirectoryMigrator");
const { DirectoryLeaseProvider } = require("../../src/jarvis/main/DirectoryLease");
const MigrationCoordinator = require("../../src/jarvis/main/MigrationCoordinator");
const { releaseReserve } = require("../../src/jarvis/main/SafeReserveFile");

const RESERVE_TOMBSTONE_PREFIX = ".emergency-reserve.release-";

function releaseRealReserve(options) {
  return releaseReserve({
    ...options,
    allocationInspector: {
      inspect: (_filePath, stat) => ({
        allocatedBytes: stat.size,
        reparse: false,
        sparse: false,
        compressed: false,
      }),
    },
    freeSpaceInspector: { inspectAsync: async () => 1_000_000 },
  });
}

async function writeTree(root) {
  await fsp.mkdir(path.join(root, "recordings", "nested"), { recursive: true });
  await fsp.mkdir(path.join(root, "models", "whisper"), { recursive: true });
  await fsp.writeFile(path.join(root, "jarvis.db"), "sqlite-evidence");
  await fsp.writeFile(path.join(root, "recordings", "a.wav"), "pcm-a");
  await fsp.writeFile(path.join(root, "recordings", "nested", "b.flac"), "flac-b");
  await fsp.writeFile(path.join(root, "models", "whisper", "base.bin"), "model");
}

async function hashTree(root) {
  const rows = [];
  async function walk(current, prefix = "") {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else {
        const bytes = await fsp.readFile(absolute);
        rows.push([
          relative,
          bytes.length,
          crypto.createHash("sha256").update(bytes).digest("hex"),
        ]);
      }
    }
  }
  await walk(root);
  return rows;
}

function createMigrator(events, overrides = {}) {
  return new DataDirectoryMigrator({
    volumeInspector: {
      inspect: async () => ({ kind: "fixed", writable: true }),
    },
    pathInspector: {
      inspect: async () => ({ reparse: false, mountPoint: false }),
    },
    closeHolders: async () => events.push("close"),
    persistRoot: async (root) => events.push(`persist:${path.basename(root)}`),
    reopenHolders: async (root) => events.push(`reopen:${path.basename(root)}`),
    ...overrides,
  });
}

test("resumes copied files and switches the root only after every file verifies", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-migrate-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  const migrator = createMigrator(events);

  await assert.rejects(migrator.migrate({ from, to, failAfterFiles: 2 }), /migration interrupted/);
  assert.deepEqual(events, ["close", "reopen:old-root"]);

  const result = await migrator.migrate({ from, to });

  assert.equal(result.switched, true);
  assert.equal(result.canDeleteOldRoot, true);
  assert.deepEqual(await hashTree(to), await hashTree(from));
  assert.deepEqual(events, [
    "close",
    "reopen:old-root",
    "close",
    "persist:new-root",
    "reopen:new-root",
  ]);
  assert.equal(fs.existsSync(from), true);
});

test("rejects a source changed between resumptions before activation", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-source-change-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  const migrator = createMigrator(events);

  await assert.rejects(migrator.migrate({ from, to, failAfterFiles: 1 }), /migration interrupted/);
  await fsp.writeFile(path.join(from, "models", "whisper", "base.bin"), "changed-model");

  await assert.rejects(migrator.migrate({ from, to }), /migration source changed/);
  assert.equal(fs.existsSync(to), true);
  assert.equal(fs.existsSync(path.join(to, ".jarvis-migration-owner")), true);
  assert.deepEqual(events, ["close", "reopen:old-root", "close", "reopen:old-root"]);
});

test("rolls configuration back and reopens the old root when the new root cannot reopen", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-rollback-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  let reopenCount = 0;
  const activationFailure = new Error(`cannot reopen private target ${to}`);
  const migrator = createMigrator(events, {
    reopenHolders: async (root) => {
      events.push(`reopen:${path.basename(root)}`);
      if (reopenCount++ === 0) throw activationFailure;
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), (error) => {
    assert.equal(
      error.message,
      "migration activation failed; the previous data directory was restored"
    );
    assert.equal(error.code, "MIGRATION_ACTIVATION_FAILED");
    assert.equal(error.step, "reopen_target");
    assert.equal(error.cause, activationFailure);
    assert.equal(error.message.includes(base), false);
    return true;
  });

  assert.deepEqual(events, [
    "close",
    "persist:new-root",
    "reopen:new-root",
    "persist:old-root",
    "reopen:old-root",
  ]);
  assert.equal(fs.existsSync(from), true);
});

test("retries the same target after rollback leaves a real reserve tombstone", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-retry-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  let failTargetReopen = true;
  const migrator = createMigrator([], {
    releaseReserveImpl: releaseRealReserve,
    reopenHolders: async (root) => {
      if (root !== to || !failTargetReopen) return;
      failTargetReopen = false;
      await fsp.writeFile(path.join(root, ".emergency-reserve"), Buffer.alloc(4096, 0x51));
      throw new Error("target reopen failed");
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), /migration activation failed/);
  const tombstone = (await fsp.readdir(to)).find((name) =>
    name.startsWith(RESERVE_TOMBSTONE_PREFIX)
  );
  assert.equal((await fsp.lstat(path.join(to, tombstone))).size, 0);

  const result = await migrator.migrate({ from, to });

  assert.equal(result.switched, true);
  assert.equal((await fsp.lstat(path.join(to, tombstone))).nlink, 1);
});

test("source scanning ignores only validated reserve tombstones", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-reserve-source-scan-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await writeTree(source);
  const reservePath = path.join(source, ".emergency-reserve");
  await fsp.writeFile(reservePath, Buffer.alloc(4096, 0x52));
  await releaseRealReserve({ filePath: reservePath, sizeBytes: 4096, fsImpl: fsp });
  const migrator = createMigrator([]);

  const entries = await migrator._scanSource(source);

  assert.equal(
    entries.some((entry) => entry.relative.startsWith(RESERVE_TOMBSTONE_PREFIX)),
    false
  );
  assert.equal(entries.length, 4);
});

test("source scanning rejects forged reserve tombstones", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-forged-reserve-source-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const tombstoneName = `${RESERVE_TOMBSTONE_PREFIX}11111111-1111-4111-8111-111111111111`;
  for (const kind of ["nonzero", "multiple-links", "reparse"]) {
    const source = path.join(base, kind);
    await fsp.mkdir(source, { recursive: true });
    const tombstonePath = path.join(source, tombstoneName);
    await fsp.writeFile(tombstonePath, kind === "nonzero" ? "forged" : "");
    if (kind === "multiple-links") {
      await fsp.link(tombstonePath, path.join(base, "attacker-link"));
    }
    const migrator = createMigrator([], {
      pathInspector: {
        inspect: async (candidate) => ({
          reparse: kind === "reparse" && path.resolve(candidate) === path.resolve(tombstonePath),
          mountPoint: false,
        }),
      },
    });

    await assert.rejects(
      migrator._scanSource(source),
      /source contains an unsafe reserve tombstone/
    );
  }
});

test("target tree validation rejects forged reserve tombstones", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-forged-reserve-target-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const tombstoneName = `${RESERVE_TOMBSTONE_PREFIX}22222222-2222-4222-8222-222222222222`;
  for (const validator of ["_assertExactTree", "_assertNoUnexpectedTree"]) {
    for (const kind of ["nonzero", "multiple-links", "reparse"]) {
      const target = path.join(base, `${validator}-${kind}`);
      await fsp.mkdir(target, { recursive: true });
      const tombstonePath = path.join(target, tombstoneName);
      await fsp.writeFile(tombstonePath, kind === "nonzero" ? "forged" : "");
      if (kind === "multiple-links") {
        await fsp.link(tombstonePath, path.join(base, `${validator}-${kind}-attacker-link`));
      }
      const migrator = createMigrator([], {
        pathInspector: {
          inspect: async (candidate) => ({
            reparse: kind === "reparse" && path.resolve(candidate) === path.resolve(tombstonePath),
            mountPoint: false,
          }),
        },
      });

      await assert.rejects(migrator[validator](target, []), /migration staging tree is invalid/);
    }
  }
});

test("releases only the obsolete root reserve after success and the target reserve after rollback", async (t) => {
  for (const outcome of ["success", "rollback"]) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), `jarvis-reserve-${outcome}-`));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const from = path.join(base, "old-root");
    const to = path.join(base, "new-root");
    await writeTree(from);
    await fsp.writeFile(path.join(from, ".emergency-reserve"), Buffer.alloc(4096, 1));
    await fsp.writeFile(path.join(from, "keep-old-data.txt"), "preserve");
    let targetReopens = 0;
    const releasedAllocation = [];
    const releaseReserveImpl = async ({ filePath, sizeBytes, fsImpl }) => {
      const stat = await fsImpl.lstat(filePath);
      releasedAllocation.push({ root: path.dirname(filePath), bytes: stat.size });
      assert.equal(sizeBytes, stat.size);
      await fsImpl.rm(filePath);
      return true;
    };
    const migrator = createMigrator([], {
      releaseReserveImpl,
      reopenHolders: async (root) => {
        await fsp.writeFile(path.join(root, ".emergency-reserve"), Buffer.alloc(4096, 2));
        if (root === to && outcome === "rollback" && targetReopens++ === 0) {
          throw new Error("target reopen failed");
        }
      },
    });

    if (outcome === "success") await migrator.migrate({ from, to });
    else await assert.rejects(migrator.migrate({ from, to }), /migration activation failed/);

    if (outcome === "success") {
      assert.equal(fs.existsSync(path.join(from, ".emergency-reserve")), false);
      assert.equal(fs.existsSync(path.join(to, ".emergency-reserve")), true);
    } else {
      assert.equal(fs.existsSync(path.join(to, ".emergency-reserve")), false);
      assert.equal(fs.existsSync(path.join(from, ".emergency-reserve")), true);
    }
    assert.equal(await fsp.readFile(path.join(from, "keep-old-data.txt"), "utf8"), "preserve");
    assert.deepEqual(releasedAllocation, [
      { root: outcome === "success" ? from : to, bytes: 4096 },
    ]);
  }
});

test("preserves activation and rollback causes with stable private-path-free steps", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-rollback-cause-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const activationFailure = new Error(`target reopen failed at ${to}`);
  const rollbackFailure = new Error(`reserve release failed at ${to}`);
  const migrator = createMigrator([], {
    releaseReserveImpl: async ({ filePath }) => {
      if (path.dirname(filePath) === to) throw rollbackFailure;
      return false;
    },
    reopenHolders: async (root) => {
      if (root !== to) return;
      await fsp.writeFile(path.join(root, ".emergency-reserve"), Buffer.alloc(4096, 5));
      throw activationFailure;
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), (error) => {
    assert.equal(
      error.message,
      "migration rollback failed; restart Jarvis and select the previous data directory"
    );
    assert.equal(error.code, "MIGRATION_ROLLBACK_FAILED");
    assert.equal(error.step, "release_target_reserve");
    assert.equal(error.activationStep, "reopen_target");
    assert.equal(error.cause instanceof AggregateError, true);
    assert.deepEqual(error.cause.errors, [activationFailure, rollbackFailure]);
    assert.equal(error.message.includes(base), false);
    return true;
  });
});

test("rejects roots, nested paths, network and removable destinations without leaking paths", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-unsafe-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  await writeTree(from);
  const events = [];
  const fixed = createMigrator(events);

  await assert.rejects(fixed.migrate({ from, to: path.parse(from).root }), /destination is unsafe/);
  await assert.rejects(
    fixed.migrate({ from, to: path.join(from, "nested-target") }),
    /destination is unsafe/
  );

  for (const kind of ["network", "removable"]) {
    const migrator = createMigrator(events, {
      volumeInspector: { inspect: async () => ({ kind, writable: true }) },
    });
    const destination = path.join(base, `${kind}-private-user-name`);
    await assert.rejects(
      migrator.migrate({ from, to: destination }),
      (error) => error.message === "destination is unsafe" && !error.message.includes(destination)
    );
  }
});

test("rejects symlinks in the source manifest", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-link-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const link = path.join(from, "recordings", "escape.wav");
  try {
    await fsp.symlink(path.join(from, "jarvis.db"), link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("symlinks unavailable");
    throw error;
  }

  await assert.rejects(createMigrator([]).migrate({ from, to }), /source contains a link/);
});

test("rejects concurrent migrations", async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const migrator = createMigrator([], {
    volumeInspector: {
      inspect: async () => {
        await blocker;
        return { kind: "fixed", writable: true };
      },
    },
  });
  const from = path.resolve("from-root");
  const to = path.resolve("to-root");
  const first = migrator.migrate({ from, to });
  await assert.rejects(migrator.migrate({ from, to }), /migration already in progress/);
  release();
  await assert.rejects(first);
});

test("closes the global gate and drains holders before scanning the source", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-freeze-source-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  let sourceScanStarted = false;
  const fsImpl = {
    ...fsp,
    async readdir(target, options) {
      if (path.resolve(target) === path.resolve(from)) sourceScanStarted = true;
      return fsp.readdir(target, options);
    },
  };
  let releaseQuiesce;
  const quiesceBarrier = new Promise((resolve) => {
    releaseQuiesce = resolve;
  });
  const events = [];
  const coordinator = new MigrationCoordinator({
    providers: [
      {
        name: "runtime",
        async quiesce() {
          events.push("quiesce:start");
          await quiesceBarrier;
          events.push("quiesce:end");
        },
        async close() {
          events.push("close");
        },
        async reopen() {
          events.push("reopen");
        },
        async rollback() {
          events.push("rollback");
        },
        async resume() {
          events.push("resume");
        },
      },
    ],
  });
  const migrator = createMigrator([], { fsImpl, migrationCoordinator: coordinator });
  const migration = migrator.migrate({ from, to, failAfterFiles: 1 });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => coordinator.assertProducerAllowed("capture"),
      (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
    );
    assert.equal(sourceScanStarted, false);
  } finally {
    releaseQuiesce();
  }

  await assert.rejects(migration, /migration interrupted/);
  assert.deepEqual(events, ["quiesce:start", "quiesce:end", "close", "rollback", "resume"]);
});

test("relocates copied root-dependent metadata before persisting the target root", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-relocate-before-persist-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  const migrator = createMigrator(events, {
    relocateTarget: async ({ oldRoot, newRoot }) => {
      assert.equal(oldRoot, from);
      assert.equal(newRoot, to);
      events.push("relocate");
    },
  });

  await migrator.migrate({ from, to });

  assert.deepEqual(events, ["close", "relocate", "persist:new-root", "reopen:new-root"]);
});

test("crash-resumes relocation from verified source bytes without accepting forged target state", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-relocation-resume-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  const journalRoot = path.join(base, "journal");
  await writeTree(from);
  let relocations = 0;
  const migrator = createMigrator([], {
    journalRoot,
    relocateTarget: async ({ newRoot }) => {
      relocations += 1;
      await fsp.writeFile(path.join(newRoot, "jarvis.db"), "relocated-sqlite-evidence");
    },
  });

  await assert.rejects(
    migrator.migrate({ from, to, failAfterRelocation: true }),
    /migration interrupted/
  );
  await fsp.writeFile(path.join(to, "models", "whisper", "base.bin"), "forged-model");

  const result = await migrator.migrate({ from, to });

  assert.equal(result.switched, true);
  assert.equal(relocations, 2);
  assert.equal(await fsp.readFile(path.join(to, "jarvis.db"), "utf8"), "relocated-sqlite-evidence");
  assert.equal(await fsp.readFile(path.join(to, "models", "whisper", "base.bin"), "utf8"), "model");
  const manifestName = (await fsp.readdir(journalRoot))[0];
  const manifest = JSON.parse(await fsp.readFile(path.join(journalRoot, manifestName), "utf8"));
  assert.equal(manifest.phase, "activated");
  assert.match(
    manifest.files.find((entry) => entry.relative === "jarvis.db").targetSha256,
    /^[a-f0-9]{64}$/
  );
});

test("rejects forged relocation temp and SQLite residue names", async (t) => {
  for (const residue of ["sidecar-temp", "wal", "extra"]) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), `jarvis-forged-residue-${residue}-`));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const from = path.join(base, "old-root");
    const to = path.join(base, "new-root");
    const journalRoot = path.join(base, "journal");
    await writeTree(from);
    const sidecar = path.join(from, "recordings", "orphan.wav.recovery.json");
    await fsp.writeFile(
      sidecar,
      JSON.stringify({ path: path.join(from, "recordings", "orphan.wav") })
    );
    const migrator = createMigrator([], { journalRoot });
    await assert.rejects(
      migrator.migrate({ from, to, failAfterRelocation: true }),
      /migration interrupted/
    );
    const manifestName = (await fsp.readdir(journalRoot))[0];
    const manifest = JSON.parse(await fsp.readFile(path.join(journalRoot, manifestName), "utf8"));
    if (residue === "sidecar-temp") {
      await fsp.writeFile(
        `${path.join(to, "recordings", "orphan.wav.recovery.json")}.${manifest.migrationId}.${"0".repeat(64)}.${crypto.randomUUID()}.tmp`,
        "forged"
      );
    } else if (residue === "wal") {
      const validWal = Buffer.alloc(32);
      validWal.writeUInt32BE(0x377f0682, 0);
      validWal.writeUInt32BE(4096, 8);
      await fsp.writeFile(path.join(to, "jarvis.db-wal"), validWal);
    } else {
      await fsp.writeFile(path.join(to, "unexpected.bin"), "forged-extra");
    }
    await assert.rejects(migrator.migrate({ from, to }), /migration staging tree is invalid/);
    if (residue === "wal") {
      assert.equal(fs.existsSync(path.join(to, "jarvis.db-wal")), true);
    }
  }
});

test("streams migration hashes with a bounded fixed buffer for large files", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-streaming-hash-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const largeFile = path.join(from, "models", "whisper", "large.bin");
  await fsp.writeFile(largeFile, Buffer.alloc(8 * 1024 * 1024, 0x5a));
  let peakRead = 0;
  let streamedReads = 0;
  const fsImpl = {
    ...fsp,
    async readFile(candidate, ...args) {
      if (path.basename(candidate) === "large.bin") {
        throw new Error("large migration files must not use readFile");
      }
      return fsp.readFile(candidate, ...args);
    },
    async open(candidate, ...args) {
      const handle = await fsp.open(candidate, ...args);
      if (path.basename(candidate) !== "large.bin") return handle;
      const originalRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        peakRead = Math.max(peakRead, length);
        streamedReads += 1;
        return originalRead(buffer, offset, length, position);
      };
      return handle;
    },
  };
  const migrator = createMigrator([], { fsImpl });

  await migrator.migrate({ from, to });

  assert.equal(streamedReads > 0, true);
  assert.equal(peakRead, 64 * 1024);
  assert.equal(
    (await fsp.stat(path.join(to, "models", "whisper", "large.bin"))).size,
    8 * 1024 * 1024
  );
});

test("persists every activation journal boundary before switching holders", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-activation-boundaries-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  const activationJournal = {
    begin(input) {
      assert.equal(input.previous, from);
      assert.equal(input.target, to);
      assert.match(input.migrationId, /^[A-Za-z0-9_-]+$/);
      assert.match(input.token, /^[a-f0-9]{64}$/);
      assert.equal(input.sourceIdentity.length > 0, true);
      assert.equal(input.targetIdentity.length > 0, true);
      assert.equal(path.isAbsolute(input.manifestPath), true);
      assert.match(input.manifestSha256, /^[a-f0-9]{64}$/);
      events.push("journal:verified");
    },
    mark(phase) {
      events.push(`journal:${phase}`);
    },
    finalize(root) {
      events.push(`journal:complete:${path.basename(root)}`);
    },
    rollback(root) {
      events.push(`journal:rollback-complete:${path.basename(root)}`);
    },
  };
  const migrator = createMigrator(events, { activationJournal });

  await migrator.migrate({ from, to });

  assert.deepEqual(events, [
    "close",
    "journal:verified",
    "journal:activating",
    "persist:new-root",
    "journal:persisted",
    "journal:reopening",
    "reopen:new-root",
    "journal:complete:new-root",
  ]);
});

test("keeps the committed target authoritative and the write gate closed when lease release fails", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-postcommit-release-"));
  const { processWriteGate } = require("../../src/jarvis/main/UnifiedRootWriteGate");
  t.after(async () => {
    processWriteGate.open();
    await fsp.rm(base, { recursive: true, force: true });
  });
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const events = [];
  const realProvider = new DirectoryLeaseProvider();
  let injected = false;
  const injectTargetReleaseFailure = (candidate, heldLease) => {
    if (path.resolve(candidate) !== path.resolve(to)) return heldLease;
    return {
      ...heldLease,
      async release() {
        await heldLease.release();
        if (!injected) {
          injected = true;
          throw new Error("injected target lease release failure");
        }
      },
    };
  };
  const directoryLeaseProvider = {
    async acquire(candidate) {
      const heldLease = await realProvider.acquire(candidate);
      return injectTargetReleaseFailure(candidate, heldLease);
    },
    async createAndAcquire(candidate) {
      const heldLease = await realProvider.createAndAcquire(candidate);
      return injectTargetReleaseFailure(candidate, heldLease);
    },
  };
  const migrator = createMigrator(events, { directoryLeaseProvider });

  await assert.rejects(migrator.migrate({ from, to }), /directory lease release failed/);

  assert.equal(injected, true);
  assert.deepEqual(events, ["close", "persist:new-root", "reopen:new-root"]);
  assert.throws(
    () => migrator.migrationCoordinator.assertProducerAllowed(),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  assert.deepEqual(await hashTree(to), await hashTree(from));
});

test("startup activation validation rejects damaged targets and accepts an exact relocated tree", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-startup-activation-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const sourceTemplate = path.join(base, "source-template");
  await writeTree(sourceTemplate);
  const recoveryWav = path.join(sourceTemplate, "recordings", "recovery.wav");
  await fsp.writeFile(recoveryWav, "recovery-pcm");
  await fsp.writeFile(
    `${recoveryWav}.recovery.json`,
    JSON.stringify({ path: recoveryWav, sha256: "a".repeat(64) })
  );

  for (const phase of ["persisted", "reopening"]) {
    for (const damage of ["none", "recording", "sidecar", "model", "identity"]) {
      const caseRoot = path.join(base, `${phase}-${damage}`);
      const from = path.join(caseRoot, "old-root");
      const to = path.join(caseRoot, "new-root");
      const journalRoot = path.join(caseRoot, "journal");
      await fsp.cp(sourceTemplate, from, { recursive: true });
      let proof = null;
      const migrator = createMigrator([], {
        journalRoot,
        activationJournal: {
          begin(input) {
            proof = { ...input, phase };
            throw new Error("simulated startup crash");
          },
          async mark() {},
          async finalize() {},
          async rollback() {},
        },
      });
      await assert.rejects(migrator.migrate({ from, to }), /simulated startup crash/);
      assert.ok(proof);
      if (damage === "recording") {
        await fsp.rm(path.join(to, "recordings", "a.wav"));
      } else if (damage === "sidecar") {
        await fsp.writeFile(path.join(to, "recordings", "recovery.wav.recovery.json"), "tampered");
      } else if (damage === "model") {
        await fsp.writeFile(path.join(to, "models", "whisper", "base.bin"), "tampered");
      } else if (damage === "identity") {
        proof = { ...proof, targetIdentity: "forged-target-identity" };
      }
      assert.equal(
        await migrator.validateActivationTarget(to, proof),
        damage === "none",
        `${phase}/${damage}`
      );
    }
  }
});

test("uses a protected journal and leased in-place target while rejecting forged extra files", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-private-staging-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  const journalRoot = path.join(base, "app-owned-journal");
  await writeTree(from);
  const migrator = createMigrator([], { journalRoot });

  await assert.rejects(migrator.migrate({ from, to, failAfterFiles: 1 }), /migration interrupted/);
  assert.equal(fs.existsSync(`${to}.jarvis-migration-staging`), false);
  assert.equal(fs.existsSync(`${to}.jarvis-migration-manifest.json`), false);
  const journalNames = await fsp.readdir(journalRoot);
  assert.equal(journalNames.length, 1);
  const manifest = JSON.parse(await fsp.readFile(path.join(journalRoot, journalNames[0]), "utf8"));
  assert.match(manifest.sourceIdentity, /^(win32:|posix:)/);
  assert.match(manifest.targetIdentity, /^(win32:|posix:)/);
  assert.equal(fs.existsSync(to), true);
  await fsp.writeFile(path.join(to, "forged-extra.bin"), "forged");

  await assert.rejects(migrator.migrate({ from, to }), /migration staging tree is invalid/);
});

test("rejects injected reparse ancestors and accepts only an existing empty target", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-target-shape-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const emptyTarget = path.join(base, "empty-target");
  const nonemptyTarget = path.join(base, "nonempty-target");
  await writeTree(from);
  await fsp.mkdir(emptyTarget);
  await fsp.mkdir(nonemptyTarget);
  await fsp.writeFile(path.join(nonemptyTarget, "foreign.txt"), "foreign");

  await assert.rejects(
    createMigrator([]).migrate({ from, to: nonemptyTarget }),
    /destination is unsafe/
  );
  await createMigrator([]).migrate({ from, to: emptyTarget });
  assert.equal(fs.existsSync(path.join(emptyTarget, "jarvis.db")), true);

  const reparseTarget = path.join(base, "reparse-target");
  await assert.rejects(
    createMigrator([], {
      pathInspector: {
        inspect: async (candidate) => ({
          reparse: path.resolve(candidate) === path.resolve(base),
          mountPoint: false,
        }),
      },
    }).migrate({ from, to: reparseTarget }),
    /destination is unsafe/
  );
});

test("inspects every existing destination ancestor through the volume root", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-target-ancestors-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const safeNearestAncestor = path.join(base, "safe", "nested");
  const to = path.join(safeNearestAncestor, "new-root");
  await writeTree(from);
  await fsp.mkdir(safeNearestAncestor, { recursive: true });
  const inspected = [];

  await assert.rejects(
    createMigrator([], {
      pathInspector: {
        inspect: async (candidate) => {
          inspected.push(path.resolve(candidate));
          return {
            reparse: path.resolve(candidate) === path.resolve(base),
            mountPoint: false,
          };
        },
      },
    }).migrate({ from, to }),
    /destination is unsafe/
  );
  assert.equal(inspected.includes(path.resolve(safeNearestAncestor)), true);
  assert.equal(inspected.includes(path.resolve(base)), true);
  assert.equal(fs.existsSync(to), false);
});

test("rejects an ancestor swap when the preflight and postflight directory identities differ", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-ancestor-swap-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  let captures = 0;
  const migrator = createMigrator([], {
    directoryIdentityProvider: async (candidate) => ({
      path: path.resolve(candidate),
      dev: "1",
      ino: captures++ === 0 ? "safe-ancestor" : "swapped-ancestor",
      finalPath: path.resolve(candidate),
      volumeIdentity: "fixed-volume",
    }),
  });

  await assert.rejects(migrator.migrate({ from, to }), /destination directory identity changed/);
  assert.equal(fs.existsSync(to), false);
});

test("leases and revalidates the destination anchor before scanning the source", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows anchor lease ordering test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-anchor-prescan-race-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const anchor = path.join(base, "safe-parent");
  const to = path.join(anchor, "nested", "new-root");
  const displaced = path.join(base, "displaced-safe-parent");
  const replacement = path.join(base, "replacement-parent");
  await writeTree(from);
  await fsp.writeFile(path.join(from, "private.bin"), "private-data");
  await fsp.mkdir(anchor);
  await fsp.mkdir(replacement);

  let scanned = false;
  let copied = false;
  const leasedFs = Object.create(fsp);
  leasedFs.readdir = async (candidate, options) => {
    if (path.resolve(candidate) === path.resolve(from)) scanned = true;
    return fsp.readdir(candidate, options);
  };
  leasedFs.copyFile = async (...args) => {
    copied = true;
    return fsp.copyFile(...args);
  };

  const realProvider = new DirectoryLeaseProvider();
  const activeLeases = new Set();
  let swapped = false;
  const track = (lease) => {
    const key = {};
    activeLeases.add(key);
    return {
      ...lease,
      async release() {
        try {
          return await lease.release();
        } finally {
          activeLeases.delete(key);
        }
      },
    };
  };
  const directoryLeaseProvider = {
    async acquire(candidate) {
      if (!swapped && path.resolve(candidate) === path.resolve(anchor)) {
        swapped = true;
        await fsp.rename(anchor, displaced);
        await fsp.rename(replacement, anchor);
      }
      return track(await realProvider.acquire(candidate));
    },
    async createAndAcquire(candidate) {
      return track(await realProvider.createAndAcquire(candidate));
    },
  };
  const directoryIdentityProvider = async (candidate) => {
    const stat = await fsp.lstat(candidate);
    return {
      path: path.resolve(candidate),
      dev: String(stat.dev),
      ino: String(stat.ino),
      finalPath: path.resolve(candidate),
      volumeIdentity: "fixed-volume",
    };
  };

  await assert.rejects(
    createMigrator([], {
      fsImpl: leasedFs,
      directoryLeaseProvider,
      directoryIdentityProvider,
      relocateTarget: async () => {},
    }).migrate({ from, to }),
    /destination directory identity changed/
  );

  assert.equal(swapped, true);
  assert.equal(scanned, false);
  assert.equal(copied, false);
  assert.equal(activeLeases.size, 0);
  assert.equal(fs.existsSync(path.join(to, "private.bin")), false);
});

test("rejects a created staging handle whose final volume identity changed", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-volume-identity-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  let inspections = 0;
  const migrator = createMigrator([], {
    volumeInspector: {
      inspect: async () => ({
        kind: "fixed",
        writable: true,
        identity: ++inspections === 1 ? "volume-a" : "volume-b",
      }),
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), /destination volume changed/);
});

test("holds the destination object while copying so a swap-back attacker receives no files", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows rename-blocking lease test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-target-lease-race-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const safeParent = path.join(base, "safe-parent");
  const to = path.join(safeParent, "nested", "new-root");
  const displaced = path.join(base, "displaced-safe-parent");
  const attacker = path.join(base, "attacker-root");
  await writeTree(from);
  await fsp.mkdir(attacker);
  let attempted = false;
  const leasedFs = Object.create(fsp);
  leasedFs.copyFile = async (sourceFile, targetFile, flags) => {
    if (!attempted) {
      attempted = true;
      assert.equal(path.resolve(targetFile).startsWith(`${path.resolve(to)}${path.sep}`), true);
      await assert.rejects(fsp.rename(safeParent, displaced), (error) =>
        ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
      );
    }
    return fsp.copyFile(sourceFile, targetFile, flags);
  };

  await createMigrator([], { fsImpl: leasedFs, relocateTarget: async () => {} }).migrate({
    from,
    to,
  });

  assert.equal(attempted, true);
  assert.deepEqual(await fsp.readdir(attacker), []);
  assert.equal(fs.existsSync(displaced), false);
});

test("atomically leases every newly created destination component before it can be moved", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows atomic directory creation test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-component-lease-race-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const firstMissing = path.join(base, "safe-parent");
  const nested = path.join(firstMissing, "nested");
  const to = path.join(nested, "new-root");
  const displaced = path.join(base, "displaced-safe-parent");
  const attacker = path.join(base, "attacker-root");
  const attackerAfterSwapBack = path.join(base, "attacker-after-swap-back");
  await writeTree(from);
  await fsp.writeFile(path.join(from, "private.bin"), "private-data");
  await fsp.mkdir(attacker);

  let legacySwapAttempted = false;
  let attackerInstalled = false;
  const leasedFs = Object.create(fsp);
  leasedFs.mkdir = async (candidate, options) => {
    const result = await fsp.mkdir(candidate, options);
    if (!legacySwapAttempted && path.resolve(candidate) === path.resolve(firstMissing)) {
      legacySwapAttempted = true;
      await fsp.rename(firstMissing, displaced);
      await fsp.rename(attacker, firstMissing);
      attackerInstalled = true;
    }
    return result;
  };

  const realProvider = new DirectoryLeaseProvider();
  const componentAttempts = [];
  const directoryLeaseProvider = {
    acquire(candidate) {
      return realProvider.acquire(candidate);
    },
    async createAndAcquire(candidate) {
      const lease = await realProvider.createAndAcquire(candidate);
      componentAttempts.push(path.resolve(candidate));
      await assert.rejects(fsp.rename(candidate, `${candidate}.displaced`), (error) =>
        ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
      );
      return lease;
    },
  };

  await createMigrator([], {
    fsImpl: leasedFs,
    directoryLeaseProvider,
    relocateTarget: async () => {},
  }).migrate({ from, to });

  if (attackerInstalled) {
    await fsp.rename(firstMissing, attackerAfterSwapBack);
    await fsp.rename(displaced, firstMissing);
  }
  assert.deepEqual(
    componentAttempts,
    [firstMissing, nested, to].map((candidate) => path.resolve(candidate))
  );
  assert.equal(legacySwapAttempted, false);
  assert.equal(attackerInstalled, false);
  assert.deepEqual(await fsp.readdir(attacker), []);
  assert.equal(
    fs.existsSync(path.join(attackerAfterSwapBack, "nested", "new-root", "private.bin")),
    false
  );
  assert.equal(await fsp.readFile(path.join(to, "private.bin"), "utf8"), "private-data");
  const releasedParent = path.join(base, "released-safe-parent");
  await fsp.rename(firstMissing, releasedParent);
  await fsp.rename(releasedParent, firstMissing);
});

test("releases the complete component lease chain after success, validation failure, and abort", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows component lease lifecycle test");
  for (const outcome of ["success", "validation-failure", "abort"]) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), `jarvis-component-release-${outcome}-`));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const from = path.join(base, "old-root");
    const firstMissing = path.join(base, "safe-parent");
    const nested = path.join(firstMissing, "nested");
    const to = path.join(nested, "new-root");
    const moved = path.join(base, "released-safe-parent");
    await writeTree(from);

    const realProvider = new DirectoryLeaseProvider();
    const activeLeases = new Set();
    const track = (lease) => {
      const key = {};
      activeLeases.add(key);
      return {
        ...lease,
        async release() {
          try {
            return await lease.release();
          } finally {
            activeLeases.delete(key);
          }
        },
      };
    };
    const directoryLeaseProvider = {
      async acquire(candidate) {
        return track(await realProvider.acquire(candidate));
      },
      async createAndAcquire(candidate) {
        return track(await realProvider.createAndAcquire(candidate));
      },
    };
    const controller = new AbortController();
    const migrator = createMigrator([], {
      directoryLeaseProvider,
      pathInspector: {
        async inspect(candidate) {
          if (
            outcome === "validation-failure" &&
            path.resolve(candidate) === path.resolve(nested)
          ) {
            throw new Error("injected component validation failure");
          }
          return { reparse: false, mountPoint: false };
        },
      },
      onProgress(progress) {
        if (outcome === "abort" && progress.state === "copying" && progress.completedFiles === 1) {
          controller.abort();
        }
      },
      relocateTarget: async () => {},
    });

    if (outcome === "success") {
      await migrator.migrate({ from, to, signal: controller.signal });
    } else {
      await assert.rejects(
        migrator.migrate({ from, to, signal: controller.signal }),
        outcome === "abort" ? /migration interrupted/ : /injected component validation failure/
      );
    }

    assert.equal(activeLeases.size, 0, `${outcome} leaked a directory lease`);
    await fsp.rename(firstMissing, moved);
    await fsp.rename(moved, firstMissing);
  }
});

test("holds an existing target before creating its ownership marker", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows child-replacement lease test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-target-prelease-race-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  const displaced = path.join(base, "marked-target");
  await writeTree(from);
  await fsp.mkdir(to);
  const realProvider = new DirectoryLeaseProvider();
  let attempted = false;
  const directoryLeaseProvider = {
    async acquire(candidate) {
      const heldLease = await realProvider.acquire(candidate);
      if (!attempted && path.resolve(candidate) === path.resolve(to)) {
        attempted = true;
        await assert.rejects(fsp.rename(to, displaced), (error) =>
          ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
        );
      }
      return heldLease;
    },
  };

  await createMigrator([], { directoryLeaseProvider }).migrate({ from, to });

  assert.equal(attempted, true);
  assert.equal(fs.existsSync(displaced), false);
  assert.equal(fs.existsSync(path.join(to, ".jarvis-migration-owner")), false);
  assert.equal(fs.existsSync(path.join(to, "jarvis.db")), true);
});

test("resumes after a crash between verified manifest persistence and marker release", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-marker-crash-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  const journalRoot = path.join(base, "journal");
  await writeTree(from);
  let crash = true;
  const migrator = createMigrator([], {
    journalRoot,
    relocateTarget: async () => {},
    faultInjector: async (point) => {
      if (point === "copy-verified-before-marker-release" && crash) {
        crash = false;
        throw new Error("simulated marker crash");
      }
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), /simulated marker crash/);
  const result = await migrator.migrate({ from, to });

  assert.equal(result.switched, true);
  assert.equal(fs.existsSync(path.join(to, ".jarvis-migration-owner")), false);
});

test("rejects a partial copying tree whose ownership marker disappeared", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-marker-missing-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  await writeTree(from);
  const migrator = createMigrator([]);
  await assert.rejects(migrator.migrate({ from, to, failAfterFiles: 1 }), /migration interrupted/);
  await fsp.rm(path.join(to, ".jarvis-migration-owner"));

  await assert.rejects(migrator.migrate({ from, to }), /migration ownership marker is invalid/);
});
