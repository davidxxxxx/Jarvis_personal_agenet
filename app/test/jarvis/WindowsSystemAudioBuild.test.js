const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createCompileInvocation,
  findZigCompiler,
  verifyExistingArtifact,
} = require("../../scripts/build-windows-system-audio");

const appRoot = path.resolve(__dirname, "../..");

test("compiler lookup accepts an explicit Jarvis Zig path without invoking a shell", () => {
  const explicit = path.join(appRoot, "toolchains", "zig.exe");
  assert.equal(
    findZigCompiler({
      appRoot,
      env: { JARVIS_ZIG_PATH: explicit },
      existsSync: (candidate) => candidate === explicit,
    }),
    explicit
  );
});

test("compile invocation targets native Windows and keeps caches under Jarvis storage", () => {
  const compilerPath = String.raw`G:\Jarvis\.toolchains\zig.exe`;
  const cacheRoot = String.raw`G:\Jarvis\.runtime-cache\native-build`;
  const sourcePath = path.join(appRoot, "resources", "windows-system-audio-helper.c");
  const outputPath = path.join(cacheRoot, "helper.tmp.exe");
  const invocation = createCompileInvocation({
    appRoot,
    compilerPath,
    sourcePath,
    outputPath,
    cacheRoot,
    env: { PATH: "trusted" },
  });

  assert.equal(invocation.command, compilerPath);
  assert.deepEqual(invocation.args.slice(0, 7), [
    "cc",
    "-target",
    "x86_64-windows-gnu",
    "-O2",
    "-D_CRT_SECURE_NO_WARNINGS",
    "-o",
    outputPath,
  ]);
  assert.equal(invocation.args.at(-3), "-lole32");
  assert.equal(invocation.args.at(-2), "-lmmdevapi");
  assert.equal(invocation.args.at(-1), "-luuid");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.TEMP.startsWith(String.raw`G:\Jarvis`), true);
  assert.equal(invocation.options.env.ZIG_GLOBAL_CACHE_DIR.startsWith(cacheRoot), true);
  assert.equal(invocation.options.env.ZIG_LOCAL_CACHE_DIR.startsWith(cacheRoot), true);
});

test(
  "checked-in Windows helper is source-pinned, hash-verified, and capability-probed",
  { skip: process.platform !== "win32" },
  () => {
    const result = verifyExistingArtifact({ appRoot });
    assert.equal(result.ok, true);
    assert.equal(result.capability.supportsApplicationCapture, true);
    assert.equal(result.capability.supportsSessionWatch, true);
    assert.equal(result.capability.minimumWindowsBuild, 20348);
    assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(result.binarySha256, /^[a-f0-9]{64}$/);
  }
);

test("Windows prebuild compiles the Jarvis helper instead of downloading an upstream latest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["compile:windows-system-audio"],
    "node scripts/build-windows-system-audio.js"
  );
  assert.match(pkg.scripts["compile:native"], /compile:windows-system-audio/);
  assert.doesNotMatch(pkg.scripts["prebuild:win"], /download:windows-system-audio-helper/);
});
