const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertSafeBuilderConfig,
  assertSafeArtifactTree,
  assertScannableTextSize,
} = require("../../scripts/verify-package-safety");
const {
  assertUnsignedWindowsArtifacts,
  createUnsignedBuilderInvocation,
} = require("../../scripts/build-windows");

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
  const signingEnvironment = {
    PATH: process.env.PATH,
    CSC_IDENTITY_AUTO_DISCOVERY: "true",
    CSC_LINK: "legacy-certificate",
    CSC_KEY_PASSWORD: "legacy-password",
    CSC_NAME: "legacy-name",
    CSC_FOR_PULL_REQUEST: "unexpected-related-signing-toggle",
    WIN_CSC_LINK: "windows-certificate",
    WIN_CSC_KEY_PASSWORD: "windows-password",
    WINDOWS_CSC_NAME: "windows-name",
    AZURE_CLIENT_SECRET: "azure-secret",
    AZURE_TENANT_ID: "azure-tenant",
    AZURE_CODE_SIGNING_ACCOUNT_NAME: "azure-account",
  };
  const invocation = createUnsignedBuilderInvocation({
    appRoot,
    env: signingEnvironment,
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  for (const name of Object.keys(signingEnvironment)) {
    if (name === "PATH" || name === "CSC_IDENTITY_AUTO_DISCOVERY") continue;
    assert.equal(name in invocation.env, false, `${name} leaked into unsigned build`);
  }
  assert.deepEqual(invocation.args.slice(1), [
    "--win",
    "--config",
    path.join(appRoot, "electron-builder.unsigned-win.json"),
  ]);
});

test("package content scanning fails closed before reading oversized text", () => {
  assert.throws(
    () => assertScannableTextSize(32 * 1024 * 1024 + 1, "resources/oversized.js"),
    /exceeds safety limit/i
  );
});

test("unsigned wrapper rejects a signed or unverifiable final executable", () => {
  const artifactRoot = path.join(appRoot, "dist");
  const signedResult = {
    status: 0,
    stdout: JSON.stringify([
      { name: "Jarvis Memory Setup 0.1.0.exe", status: "Valid" },
      { name: "Jarvis Memory 0.1.0.exe", status: "NotSigned" },
    ]),
  };

  assert.throws(
    () =>
      assertUnsignedWindowsArtifacts({
        appRoot,
        artifactRoot,
        platform: "win32",
        systemRoot: String.raw`C:\Windows`,
        spawnSyncImpl: () => signedResult,
      }),
    /artifact must be Authenticode NotSigned/i
  );

  assert.doesNotThrow(() =>
    assertUnsignedWindowsArtifacts({
      appRoot,
      artifactRoot,
      platform: "win32",
      systemRoot: String.raw`C:\Windows`,
      spawnSyncImpl: () => ({
        status: 0,
        stdout: JSON.stringify([
          { name: "Jarvis Memory Setup 0.1.0.exe", status: "NotSigned" },
          { name: "Jarvis Memory 0.1.0.exe", status: "NotSigned" },
        ]),
      }),
    })
  );
});

test("package safety rejects runtime/user-data files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-runtime-"));
  const runtimePath = path.join(root, "resources", "recordings", "capture.wav");
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, "audio bytes");

  try {
    assert.throws(() => assertSafeArtifactTree(root), /forbidden runtime resource/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety redacts credentials embedded in ordinary loose JavaScript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-content-"));
  const secret = `sk-cp-${"A".repeat(48)}`;
  fs.writeFileSync(path.join(root, "ordinary.js"), `export const token = "${secret}";`);

  try {
    assert.throws(
      () => assertSafeArtifactTree(root),
      (error) => {
        assert.match(error.message, /credential content.*openai/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety scans ordinary JavaScript inside ASAR without exposing secrets", async () => {
  const asar = require("@electron/asar");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-"));
  const source = path.join(root, "source");
  const packagePath = path.join(root, "app.asar");
  const secret = `AKIA${"A1".repeat(8)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "ordinary.js"),
    `export const AWS_ACCESS_KEY_ID = "${secret}";`
  );
  await asar.createPackage(source, packagePath);
  fs.rmSync(source, { recursive: true, force: true });

  try {
    assert.throws(
      () => assertSafeArtifactTree(root),
      (error) => {
        assert.match(error.message, /credential content.*aws/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
