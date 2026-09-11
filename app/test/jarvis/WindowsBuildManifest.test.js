const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { BUILD_MANIFEST_FILE, writeWindowsBuildManifest } = require("../../scripts/afterPack");

const appRoot = path.resolve(__dirname, "../..");
const testRootBase = path.resolve(appRoot, "..", "..", ".runtime-cache", "build-manifest-tests");

function makeTestRoot(name) {
  fs.mkdirSync(testRootBase, { recursive: true });
  const root = path.join(testRootBase, `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeContext(root) {
  const appOutDir = path.join(root, "win-unpacked");
  fs.mkdirSync(path.join(appOutDir, "resources"), { recursive: true });
  return {
    appOutDir,
    electronPlatformName: "win32",
    packager: {
      appInfo: { version: "0.2.0-rc.1" },
    },
  };
}

test("afterPack writes a fail-closed Windows build manifest from a clean Git source", (t) => {
  const root = makeTestRoot("clean");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({ version: "0.2.0-rc.1" }),
    "utf8"
  );
  const context = makeContext(root);
  const gitCommit = "7356b3bbff883bbfb5fad49bb69bd2fa381deb7c";
  const calls = [];

  const result = writeWindowsBuildManifest(context, {
    sourceRoot,
    schemaVersion: 58,
    now: () => new Date("2026-08-03T01:02:03.004Z"),
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "rev-parse") return `${gitCommit}\n`;
      if (args[0] === "status") return "";
      throw new Error("unexpected Git command");
    },
  });

  const manifestPath = path.join(context.appOutDir, "resources", BUILD_MANIFEST_FILE);
  assert.equal(result.manifestPath, manifestPath);
  const expectedManifest = {
    manifestVersion: 1,
    verification: {
      state: "built-unverified",
      provenance: "git-head",
      commitFormat: "sha1-40",
      sourceTree: "clean",
    },
    appVersion: "0.2.0-rc.1",
    gitCommit,
    schemaVersion: 58,
    builtAtUtc: "2026-08-03T01:02:03.004Z",
  };
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), expectedManifest);
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ]
  );
  assert.equal(
    calls.every(({ options }) => options.cwd === sourceRoot),
    true
  );
});

test("afterPack refuses to claim a Git commit for a dirty source tree", (t) => {
  const root = makeTestRoot("dirty");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({ version: "0.2.0-rc.1" }),
    "utf8"
  );
  const context = makeContext(root);

  assert.throws(
    () =>
      writeWindowsBuildManifest(context, {
        sourceRoot,
        schemaVersion: 58,
        execFileSyncImpl(_command, args) {
          return args[0] === "rev-parse"
            ? "7356b3bbff883bbfb5fad49bb69bd2fa381deb7c\n"
            : " M src/main.js\n";
        },
      }),
    /clean Git source tree/u
  );
  assert.equal(
    fs.existsSync(path.join(context.appOutDir, "resources", BUILD_MANIFEST_FILE)),
    false
  );
});

test("afterPack requires the release manifest Git identity to be exactly SHA-1 length", (t) => {
  const root = makeTestRoot("commit-length");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({ version: "0.2.0-rc.1" }),
    "utf8"
  );
  const context = makeContext(root);

  assert.throws(
    () =>
      writeWindowsBuildManifest(context, {
        sourceRoot,
        schemaVersion: 58,
        execFileSyncImpl(_command, args) {
          return args[0] === "rev-parse" ? `${"a".repeat(64)}\n` : "";
        },
      }),
    /40-character Git source commit/u
  );
});
