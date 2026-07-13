const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DataDirectoryMigrator = require("../../src/jarvis/main/DataDirectoryMigrator");
const MigrationCoordinator = require("../../src/jarvis/main/MigrationCoordinator");

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
        rows.push([relative, bytes.length, crypto.createHash("sha256").update(bytes).digest("hex")]);
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

  await assert.rejects(
    migrator.migrate({ from, to, failAfterFiles: 2 }),
    /migration interrupted/
  );
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

  await assert.rejects(
    migrator.migrate({ from, to, failAfterFiles: 1 }),
    /migration interrupted/
  );
  await fsp.writeFile(path.join(from, "models", "whisper", "base.bin"), "changed-model");

  await assert.rejects(
    migrator.migrate({ from, to }),
    /migration source changed/
  );
  assert.equal(fs.existsSync(to), false);
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
  const migrator = createMigrator(events, {
    reopenHolders: async (root) => {
      events.push(`reopen:${path.basename(root)}`);
      if (reopenCount++ === 0) throw new Error("cannot reopen target");
    },
  });

  await assert.rejects(migrator.migrate({ from, to }), /migration activation failed/);

  assert.deepEqual(events, [
    "close",
    "persist:new-root",
    "reopen:new-root",
    "persist:old-root",
    "reopen:old-root",
  ]);
  assert.equal(fs.existsSync(from), true);
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
      (error) =>
        error.message === "destination is unsafe" && !error.message.includes(destination)
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

  assert.deepEqual(events, [
    "close",
    "relocate",
    "persist:new-root",
    "reopen:new-root",
  ]);
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
  assert.match(manifest.files.find((entry) => entry.relative === "jarvis.db").targetSha256, /^[a-f0-9]{64}$/);
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

test("uses a protected journal and random staging while rejecting forged extra files", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-private-staging-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const from = path.join(base, "old-root");
  const to = path.join(base, "new-root");
  const journalRoot = path.join(base, "app-owned-journal");
  await writeTree(from);
  const migrator = createMigrator([], { journalRoot });

  await assert.rejects(
    migrator.migrate({ from, to, failAfterFiles: 1 }),
    /migration interrupted/
  );
  assert.equal(fs.existsSync(`${to}.jarvis-migration-staging`), false);
  assert.equal(fs.existsSync(`${to}.jarvis-migration-manifest.json`), false);
  const journalNames = await fsp.readdir(journalRoot);
  assert.equal(journalNames.length, 1);
  const manifest = JSON.parse(await fsp.readFile(path.join(journalRoot, journalNames[0]), "utf8"));
  const staging = path.join(
    path.dirname(to),
    `.jarvis-migration-${manifest.migrationId}-${manifest.token.slice(0, 16)}`
  );
  assert.equal(fs.existsSync(staging), true);
  await fsp.writeFile(path.join(staging, "forged-extra.bin"), "forged");

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

  await assert.rejects(createMigrator([]).migrate({ from, to: nonemptyTarget }), /destination is unsafe/);
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
