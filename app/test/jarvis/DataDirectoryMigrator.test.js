const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DataDirectoryMigrator = require("../../src/jarvis/main/DataDirectoryMigrator");

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
  assert.deepEqual(events, []);

  const result = await migrator.migrate({ from, to });

  assert.equal(result.switched, true);
  assert.equal(result.canDeleteOldRoot, true);
  assert.deepEqual(await hashTree(to), await hashTree(from));
  assert.deepEqual(events, ["close", "persist:new-root", "reopen:new-root"]);
  assert.equal(fs.existsSync(from), true);
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
