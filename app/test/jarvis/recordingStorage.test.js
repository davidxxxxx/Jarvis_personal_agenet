const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  DataRootConfig,
  resolveJarvisDataRoot,
  resolveRecordingsRoot,
  copyLegacyTreeSync,
  adoptLegacyDatabaseSync,
} = require("../../src/jarvis/main/recordingStorage");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

test("recording storage defaults under userData and accepts a safe absolute override", () => {
  const userDataDir = path.resolve("C:\\Users\\test\\AppData\\Roaming\\Jarvis Memory");
  const external = path.resolve("G:\\JarvisData\\recordings");

  assert.equal(resolveJarvisDataRoot(userDataDir, ""), path.join(userDataDir, "jarvis"));
  assert.equal(
    resolveRecordingsRoot(userDataDir, ""),
    path.join(userDataDir, "jarvis", "recordings")
  );
  assert.equal(resolveRecordingsRoot(userDataDir, `  ${external}  `), external);
});

test("legacy adoption copies and verifies files without accepting links", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, "old");
  const to = path.join(root, "new");
  fs.mkdirSync(path.join(from, "nested"), { recursive: true });
  fs.writeFileSync(path.join(from, "nested", "audio.wav"), "evidence");

  copyLegacyTreeSync({ from, to });
  copyLegacyTreeSync({ from, to });
  assert.equal(fs.readFileSync(path.join(to, "nested", "audio.wav"), "utf8"), "evidence");

  try {
    fs.symlinkSync(path.join(from, "nested", "audio.wav"), path.join(from, "escape.wav"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => copyLegacyTreeSync({ from, to }), /legacy data contains a link/);
});

test("data-root configuration persists atomically without deleting the previous root", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-root-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = path.join(root, "data");
  const config = new DataRootConfig({ userDataDir: root });

  assert.equal(config.load(), path.join(root, "jarvis"));
  config.save(configured);

  assert.equal(config.load(), configured);
  assert.equal(fs.existsSync(`${config.filePath}.tmp`), false);
});

test("activation journal resumes a validated persisted target and finalizes it", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-root-activation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous");
  const target = path.join(root, "target");
  const config = new DataRootConfig({ userDataDir: root });
  config.save(previous);
  config.beginActivation({
    previous,
    target,
    migrationId: "migration-1",
    targetIdentity: "fixed-volume:target",
  });
  config.markActivationPhase("persisted");

  const recovered = config.recoverActivation((candidate) => candidate === target);

  assert.equal(recovered, target);
  assert.deepEqual(config.loadState(), {
    version: 2,
    current: target,
    previous: null,
    target: null,
    migrationId: null,
    targetIdentity: null,
    phase: "complete",
  });
});

test("activation journal rolls an invalid target back and reads version one configs", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-root-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous");
  const target = path.join(root, "target");
  const config = new DataRootConfig({ userDataDir: root });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(config.filePath, JSON.stringify({ version: 1, root: previous }));
  assert.equal(config.load(), previous);

  config.beginActivation({ previous, target, migrationId: "migration-2" });
  config.markActivationPhase("reopening");
  assert.equal(config.recoverActivation(() => false), previous);
  assert.equal(config.load(), previous);
  assert.equal(config.loadState().phase, "complete");
});

test("recording storage rejects relative paths and volume roots", () => {
  const userDataDir = path.resolve("C:\\Users\\test\\Jarvis Memory");

  assert.throws(() => resolveRecordingsRoot(userDataDir, "..\\recordings"), /absolute/);
  assert.throws(() => resolveRecordingsRoot(userDataDir, path.parse(userDataDir).root), /volume root/);
});

test("legacy database adoption checkpoints WAL-only commits before verified copy", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-wal-"));
  const legacyPath = path.join(root, "legacy", "jarvis.db");
  const targetPath = path.join(root, "target", "jarvis.db");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const writer = new JarvisRepository(legacyPath);
  writer.createSession({ id: "wal-only", startedAt: 1_000, micDeviceId: null });
  t.after(() => {
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(fs.existsSync(`${legacyPath}-wal`), true);

  adoptLegacyDatabaseSync({ from: legacyPath, to: targetPath });

  const adopted = new JarvisRepository(targetPath);
  assert.equal(adopted.getSession("wal-only").id, "wal-only");
  adopted.close();
});
