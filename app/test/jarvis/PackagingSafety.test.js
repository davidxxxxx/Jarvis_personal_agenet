const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertSafeBuilderConfig,
  assertSafeArtifactTree,
} = require("../../scripts/verify-package-safety");
const { createUnsignedBuilderInvocation } = require("../../scripts/build-windows");

const appRoot = path.resolve(__dirname, "../..");

test("unsigned Windows packaging config cannot inherit an environment file", () => {
  assert.doesNotThrow(() =>
    assertSafeBuilderConfig(path.join(appRoot, "electron-builder.unsigned-win.json"))
  );
});

test("package safety rejects secret-like resources without exposing their contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-safety-"));
  const secret = "do-not-print-this-secret";
  const envPath = path.join(root, "resources", ".env.production");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, `TOKEN=${secret}`);

  try {
    assert.throws(
      () => assertSafeArtifactTree(root),
      (error) => {
        assert.match(error.message, /unsafe packaged resource/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsigned Windows wrapper disables all certificate auto-discovery without a shell", () => {
  const invocation = createUnsignedBuilderInvocation({
    appRoot,
    env: { PATH: process.env.PATH, CSC_IDENTITY_AUTO_DISCOVERY: "true" },
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.deepEqual(invocation.args.slice(1), [
    "--win",
    "--config",
    path.join(appRoot, "electron-builder.unsigned-win.json"),
  ]);
});
