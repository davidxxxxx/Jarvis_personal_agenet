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

test("package safety rejects Electron profile paths and aliases", async (t) => {
  const profilePaths = [
    "user-data/Cookies",
    "userdata/History",
    "user data/Network/Cookies",
    "profile/Preferences",
    "Profile 1/Preferences",
    "Guest Profile/Preferences",
    "System Profile/Preferences",
    "Default/Preferences",
    "Default/Bookmarks",
    "Default/Extensions/x",
    "Default/Login Data",
    "Default/Preferences.bak",
    "Cache/entry.bin",
    "Code Cache/entry.bin",
    "GPUCache/entry.bin",
    "Local Storage/entry.bin",
    "Session Storage/entry.bin",
    "IndexedDB/entry.bin",
    "Network/Cookies",
    "Crashpad/report.dmp",
  ];

  for (const profilePath of profilePaths) {
    await t.test(profilePath, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-profile-"));
      const filePath = path.join(root, "resources", ...profilePath.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "runtime profile data");
      try {
        assert.throws(() => assertSafeArtifactTree(root), /runtime profile resource/i);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("package safety allows unrelated filenames containing default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-default-name-"));
  const files = ["assets/default-theme.json", "assets/mydefault.conf", "defaults/readme.txt"];
  for (const relativePath of files) {
    const filePath = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "safe text");
  }
  try {
    assert.doesNotThrow(() => assertSafeArtifactTree(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety scans common and extensionless text with redacted findings", async (t) => {
  for (const extension of [".ini", ".conf", ".toml", ".properties", "", ".custom"]) {
    await t.test(extension || "extensionless", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-unknown-text-"));
      const secret = `sk-cp-${"U".repeat(48)}`;
      fs.writeFileSync(path.join(root, `settings${extension}`), `token = ${secret}\n`);
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
  }
});

const PRIVATE_KEY_LABELS = [
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
];

function createPrivateKeyFixture(label, { escaped = false, wrapped = false } = {}) {
  const body = Buffer.from(`${label}:${"private-material-".repeat(12)}`).toString("base64");
  const bodyText = wrapped ? `${body.slice(0, 37)} \r\n  ${body.slice(37)}` : body;
  const pem = `-----BEGIN ${label}-----\n${bodyText}\n-----END ${label}-----`;
  return escaped ? pem.replaceAll("\n", "\\n") : pem;
}

function assertRedactedPrivateKeyFailure(scan, secret) {
  assert.throws(scan, (error) => {
    assert.match(error.message, /credential content.*private-key/i);
    assert.doesNotMatch(error.message, new RegExp(secret.slice(0, 24)));
    assert.doesNotMatch(error.message, /BEGIN .*PRIVATE KEY/);
    return true;
  });
}

test("package safety detects one-line and escaped private keys in loose text", async (t) => {
  const fileNames = ["key.conf", "key.custom", "key.json", "key", "key.properties"];
  for (let index = 0; index < PRIVATE_KEY_LABELS.length; index += 1) {
    const label = PRIVATE_KEY_LABELS[index];
    await t.test(label, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-private-key-"));
      const escaped = index >= 2;
      const secret = createPrivateKeyFixture(label, { escaped, wrapped: index === 1 });
      const content = fileNames[index].endsWith(".json")
        ? JSON.stringify({ privateKey: createPrivateKeyFixture(label) })
        : `private_key = "${secret}"`;
      fs.writeFileSync(path.join(root, fileNames[index]), content);
      try {
        assertRedactedPrivateKeyFailure(() => assertSafeArtifactTree(root), secret);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("package safety detects one-line and escaped private keys inside ASAR", async (t) => {
  const asar = require("@electron/asar");
  const fileNames = ["key.json", "key.ini", "key.custom", "key", "key.toml"];
  for (let index = 0; index < PRIVATE_KEY_LABELS.length; index += 1) {
    const label = PRIVATE_KEY_LABELS[index];
    await t.test(label, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-private-key-"));
      const source = path.join(root, "source");
      const packagePath = path.join(root, "app.asar");
      const escaped = index % 2 === 0;
      const secret = createPrivateKeyFixture(label, { escaped, wrapped: index === 3 });
      const content = fileNames[index].endsWith(".json")
        ? JSON.stringify({ privateKey: createPrivateKeyFixture(label) })
        : `private_key = "${secret}"`;
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, fileNames[index]), content);
      await asar.createPackage(source, packagePath);
      fs.rmSync(source, { recursive: true, force: true });
      try {
        assertRedactedPrivateKeyFailure(() => assertSafeArtifactTree(root), secret);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("package safety rejects oversized unknown files before reading them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-oversized-"));
  const filePath = path.join(root, "settings.custom");
  const fd = fs.openSync(filePath, "w");
  fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  try {
    assert.throws(() => assertSafeArtifactTree(root), /exceeds safety limit/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety rejects loose junction indirections", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-link-target-"));
  fs.writeFileSync(path.join(outside, "settings.ini"), "safe text");
  const junctionPath = path.join(root, "linked");
  try {
    fs.symlinkSync(outside, junctionPath, "junction");
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip(`junction unavailable: ${error.code}`);
    return;
  }
  try {
    assert.throws(() => assertSafeArtifactTree(root), /unsupported loose entry.*linked/i);
  } finally {
    fs.rmSync(junctionPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("package safety applies profile and unknown-text checks inside ASAR", async (t) => {
  const asar = require("@electron/asar");
  for (const relativePath of [
    "Default/Preferences",
    "Default/Bookmarks",
    "Default/Extensions/x",
    "Default/Login Data",
    "Default/Preferences.bak",
    "settings.ini",
    "settings.conf",
    "settings.toml",
    "settings.properties",
    "settings",
  ]) {
    await t.test(relativePath, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-policy-"));
      const source = path.join(root, "source");
      const packagePath = path.join(root, "app.asar");
      const target = path.join(source, ...relativePath.split("/"));
      const secret = `sk-cp-${"V".repeat(48)}`;
      const isProfilePath = relativePath.startsWith("Default/");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, isProfilePath ? "runtime profile data" : `token = ${secret}\n`);
      await asar.createPackage(source, packagePath);
      fs.rmSync(source, { recursive: true, force: true });
      try {
        assert.throws(
          () => assertSafeArtifactTree(root),
          (error) => {
            if (isProfilePath) {
              assert.match(error.message, /runtime profile resource/i);
            } else {
              assert.match(error.message, /credential content.*openai/i);
              assert.doesNotMatch(error.message, new RegExp(secret));
            }
            return true;
          }
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("package safety allows unrelated default filenames inside ASAR", async () => {
  const asar = require("@electron/asar");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-default-name-"));
  const source = path.join(root, "source");
  const packagePath = path.join(root, "app.asar");
  const target = path.join(source, "assets", "default-theme.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ theme: "safe" }));
  await asar.createPackage(source, packagePath);
  fs.rmSync(source, { recursive: true, force: true });
  try {
    assert.doesNotThrow(() => assertSafeArtifactTree(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety rejects ASAR link metadata without following it", async () => {
  const asar = require("@electron/asar");
  const { Readable } = require("node:stream");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-link-"));
  const packagePath = path.join(root, "app.asar");
  const statPath = path.join(root, "stat-source.txt");
  fs.writeFileSync(statPath, "safe");
  const stat = fs.statSync(statPath);
  await asar.createPackageFromStreams(packagePath, [
    {
      type: "file",
      path: "target.txt",
      unpacked: false,
      stat,
      streamGenerator: () => Readable.from([Buffer.from("safe")]),
    },
    {
      type: "link",
      path: "linked.txt",
      symlink: "target.txt",
      unpacked: false,
      stat,
      streamGenerator: () => Readable.from([Buffer.alloc(0)]),
    },
  ]);
  try {
    assert.throws(() => assertSafeArtifactTree(root), /unsupported ASAR link.*linked\.txt/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety scans supported ASAR unpacked indirections", async () => {
  const asar = require("@electron/asar");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-unpacked-"));
  const source = path.join(root, "source");
  const packagePath = path.join(root, "app.asar");
  const secret = `sk-cp-${"W".repeat(48)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "settings.ini"), `token = ${secret}\n`);
  await asar.createPackageWithOptions(source, packagePath, { unpack: "*.ini" });
  fs.rmSync(source, { recursive: true, force: true });
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
    fs.rmSync(`${packagePath}.unpacked`, { recursive: true, force: true });
  }
});

test("package safety rejects malformed missing ONNX unpacked aliases", async () => {
  const asar = require("@electron/asar");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-asar-missing-"));
  const source = path.join(root, "source");
  const packagePath = path.join(root, "app.asar");
  const relativePath = path.join(
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    "malformed.txt"
  );
  const target = path.join(source, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "safe");
  // @electron/asar's unpack glob is matched against basenames on Windows; a
  // slash-qualified glob silently produces an ordinary packed entry there.
  await asar.createPackageWithOptions(source, packagePath, { unpack: "malformed.txt" });
  assert.equal(asar.statFile(packagePath, relativePath, false).unpacked, true);
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(`${packagePath}.unpacked`, { recursive: true, force: true });
  try {
    assert.throws(
      () => assertSafeArtifactTree(root),
      /unsupported ASAR unpacked indirection.*malformed\.txt/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package safety rejects a reparse artifact root", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-root-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-package-root-target-"));
  fs.writeFileSync(path.join(outside, "safe.txt"), "safe");
  const root = path.join(parent, "dist");
  try {
    fs.symlinkSync(outside, root, "junction");
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip(`junction unavailable: ${error.code}`);
    return;
  }
  try {
    assert.throws(() => assertSafeArtifactTree(root), /unsupported package root/i);
  } finally {
    fs.rmSync(root, { force: true });
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
