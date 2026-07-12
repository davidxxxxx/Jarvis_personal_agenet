const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  DataRootConfig,
  resolveJarvisDataRoot,
  resolveRecordingsRoot,
  copyLegacyTreeSync,
} = require("../../src/jarvis/main/recordingStorage");

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

test("recording storage rejects relative paths and volume roots", () => {
  const userDataDir = path.resolve("C:\\Users\\test\\Jarvis Memory");

  assert.throws(() => resolveRecordingsRoot(userDataDir, "..\\recordings"), /absolute/);
  assert.throws(() => resolveRecordingsRoot(userDataDir, path.parse(userDataDir).root), /volume root/);
});
