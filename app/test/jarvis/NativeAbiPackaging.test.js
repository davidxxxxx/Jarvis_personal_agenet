const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertUnsignedWindowsArtifacts,
  buildUnsignedWindows,
  createElectronNativeRebuildInvocation,
  createNodeNativeRestoreInvocation,
  createUnsignedBuilderInvocation,
  verifyNativeAbi,
} = require("../../scripts/build-windows");

const appRoot = path.resolve(__dirname, "../..");
const appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;

function successfulAuthenticodeResult() {
  return {
    status: 0,
    stdout: JSON.stringify([
      { name: `Jarvis Memory Setup ${appVersion}.exe`, status: "NotSigned" },
      { name: `Jarvis Memory ${appVersion}.exe`, status: "NotSigned" },
    ]),
  };
}

test("Electron native install uses the pinned prebuild for Electron 41.10.0 win32-x64", () => {
  assert.equal(typeof createElectronNativeRebuildInvocation, "function");
  const invocation = createElectronNativeRebuildInvocation({ appRoot });

  assert.equal(invocation.command, process.execPath);
  assert.equal(path.isAbsolute(invocation.command), true);
  assert.equal(path.isAbsolute(invocation.args[0]), true);
  assert.deepEqual(invocation.args.slice(1), [
    "--runtime",
    "electron",
    "--target",
    "41.10.0",
    "--arch",
    "x64",
  ]);
  assert.equal(invocation.options.cwd, path.join(appRoot, "node_modules", "better-sqlite3"));
  assert.equal(invocation.options.shell, false);
});

test("Node native restore uses the pinned current-Node prebuild without a shell", () => {
  assert.equal(typeof createNodeNativeRestoreInvocation, "function");
  const invocation = createNodeNativeRestoreInvocation({ appRoot });

  assert.equal(invocation.command, process.execPath);
  assert.equal(path.isAbsolute(invocation.command), true);
  assert.equal(path.isAbsolute(invocation.args[0]), true);
  assert.deepEqual(invocation.args.slice(1), [
    "--runtime",
    "node",
    "--target",
    process.versions.node,
    "--arch",
    process.arch,
  ]);
  assert.equal(invocation.options.cwd, path.join(appRoot, "node_modules", "better-sqlite3"));
  assert.equal(invocation.options.shell, false);
});

test("directory-only Windows packaging adds --dir without changing the trusted builder entry", () => {
  const invocation = createUnsignedBuilderInvocation({ appRoot, dirOnly: true });

  assert.deepEqual(invocation.args.slice(1), [
    "--win",
    "--config",
    path.join(appRoot, "electron-builder.unsigned-win.json"),
    "--dir",
  ]);
});

test("unsigned artifact verification retries a transient Windows signature result", () => {
  let attempts = 0;
  const waits = [];
  const verificationEnvironments = [];

  assertUnsignedWindowsArtifacts({
    appRoot,
    platform: "win32",
    systemRoot: String.raw`C:\Windows`,
    env: {
      PATH: "trusted-path",
      PSModulePath: String.raw`C:\Program Files\PowerShell\Modules;C:\Windows\Modules`,
    },
    signatureScanAttempts: 2,
    signatureScanRetryDelayMs: 25,
    waitImpl: (delayMs) => waits.push(delayMs),
    spawnSyncImpl: (_command, _args, options) => {
      attempts += 1;
      verificationEnvironments.push(options.env);
      if (attempts === 1) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: `Jarvis Memory Setup ${appVersion}.exe`, status: "UnknownError" },
            { name: `Jarvis Memory ${appVersion}.exe`, status: "NotSigned" },
          ]),
        };
      }
      return successfulAuthenticodeResult();
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [25]);
  for (const environment of verificationEnvironments) {
    assert.equal(environment.PATH, "trusted-path");
    assert.equal(
      environment.PSModulePath,
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`
    );
    assert.doesNotMatch(environment.PSModulePath, /PowerShell\\Modules/i);
  }
});

test("native verifier invokes an absolute runtime without shell interpolation and requires ABI 145", () => {
  assert.equal(typeof verifyNativeAbi, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-native-abi-invocation-"));
  const runtimePath = path.join(root, "electron.exe");
  const modulePath = path.join(root, "better-sqlite3");
  const binaryPath = path.join(modulePath, "build", "Release", "better_sqlite3.node");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(runtimePath, "runtime");
  fs.writeFileSync(binaryPath, "native");

  try {
    const result = verifyNativeAbi({
      runtimePath,
      modulePath,
      binaryPath,
      expectedAbi: "145",
      label: "source-electron",
      spawnSyncImpl(command, args, options) {
        assert.equal(command, runtimePath);
        assert.equal(path.isAbsolute(command), true);
        assert.equal(path.isAbsolute(args[0]), true);
        assert.deepEqual(args.slice(1), [modulePath, binaryPath, "145"]);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
        return { status: 0, stdout: JSON.stringify({ ok: true, abi: "145", value: 1 }) };
      },
    });
    assert.deepEqual(result, { ok: true, abi: "145", value: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native verifier fails closed on wrong ABI without exposing child output", () => {
  assert.equal(typeof verifyNativeAbi, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-native-abi-redaction-"));
  const runtimePath = path.join(root, "electron.exe");
  const modulePath = path.join(root, "better-sqlite3");
  const binaryPath = path.join(modulePath, "better_sqlite3.node");
  fs.mkdirSync(modulePath);
  fs.writeFileSync(runtimePath, "runtime");
  fs.writeFileSync(binaryPath, "native");
  const sensitive = "do-not-print-this-native-path-or-body";

  try {
    assert.throws(
      () =>
        verifyNativeAbi({
          runtimePath,
          modulePath,
          binaryPath,
          expectedAbi: "145",
          label: "packaged-electron",
          spawnSyncImpl: () => ({
            status: 0,
            stdout: JSON.stringify({ ok: true, abi: "144", value: 1, sensitive }),
            stderr: sensitive,
          }),
        }),
      (error) => {
        assert.match(error.message, /native ABI verification failed.*packaged-electron/i);
        assert.doesNotMatch(error.message, new RegExp(sensitive));
        assert.doesNotMatch(error.message, new RegExp(root.replaceAll("\\", "\\\\"), "i"));
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native verifier executes SELECT 1 through the real current Node runtime", () => {
  assert.equal(typeof verifyNativeAbi, "function");
  const modulePath = path.join(appRoot, "node_modules", "better-sqlite3");
  const binaryPath = path.join(modulePath, "build", "Release", "better_sqlite3.node");
  const result = verifyNativeAbi({
    runtimePath: process.execPath,
    modulePath,
    binaryPath,
    expectedAbi: process.versions.modules,
    label: "source-node",
  });
  assert.deepEqual(result, {
    ok: true,
    abi: process.versions.modules,
    value: 1,
  });
});

test("unsigned build enforces native rebuild, runtime smokes, scans, and Node restore order", () => {
  const order = [];
  const spawnSyncImpl = (command, args) => {
    if (args.includes("--runtime") && args.includes("electron")) order.push("electron-prebuild");
    else if (args.includes("--runtime") && args.includes("node")) order.push("node-restore");
    else if (args.includes("--win")) order.push("builder");
    else {
      order.push("auth-spawn");
      return successfulAuthenticodeResult();
    }
    return { status: 0, stdout: "" };
  };

  buildUnsignedWindows({
    appRoot,
    platform: "win32",
    systemRoot: String.raw`C:\Windows`,
    spawnSyncImpl,
    assertSafeBuilderConfigImpl: () => order.push("setup"),
    verifyNativeAbiImpl: ({ label }) => {
      order.push(label);
      return {
        ok: true,
        abi: label === "source-node" ? process.versions.modules : "145",
        value: 1,
      };
    },
    assertSafeArtifactTreeImpl: () => order.push("package-scan"),
    assertUnsignedWindowsArtifactsImpl: () => order.push("auth-scan"),
  });

  assert.deepEqual(order, [
    "setup",
    "electron-prebuild",
    "source-electron",
    "builder",
    "packaged-electron",
    "package-scan",
    "auth-scan",
    "node-restore",
    "source-node",
  ]);
});

test("directory-only build still verifies ABI and scans package but skips installer signature checks", () => {
  const order = [];

  buildUnsignedWindows({
    appRoot,
    dirOnly: true,
    spawnSyncImpl(_command, args) {
      if (args.includes("--runtime") && args.includes("electron")) {
        order.push("electron-prebuild");
      } else if (args.includes("--runtime") && args.includes("node")) {
        order.push("node-restore");
      } else if (args.includes("--win")) {
        order.push(args.includes("--dir") ? "builder-dir" : "builder");
      }
      return { status: 0, stdout: "" };
    },
    assertSafeBuilderConfigImpl: () => order.push("setup"),
    verifyNativeAbiImpl: ({ label }) => {
      order.push(label);
      return { ok: true, abi: label === "source-node" ? process.versions.modules : "145", value: 1 };
    },
    assertSafeArtifactTreeImpl: () => order.push("package-scan"),
    assertUnsignedWindowsArtifactsImpl: () => order.push("auth-scan"),
  });

  assert.deepEqual(order, [
    "setup",
    "electron-prebuild",
    "source-electron",
    "builder-dir",
    "packaged-electron",
    "package-scan",
    "node-restore",
    "source-node",
  ]);
});

test("unsigned build restores and verifies Node ABI after a builder failure", () => {
  const order = [];
  const previousExitCode = process.exitCode;
  try {
    assert.throws(
      () =>
        buildUnsignedWindows({
          appRoot,
          platform: "win32",
          systemRoot: String.raw`C:\Windows`,
          spawnSyncImpl(command, args) {
            if (args.includes("--runtime") && args.includes("electron")) {
              order.push("electron-prebuild");
            } else if (args.includes("--runtime") && args.includes("node")) {
              order.push("node-restore");
            }
            else if (args.includes("--win")) {
              order.push("builder");
              return { status: 17, stdout: "" };
            }
            return { status: 0, stdout: "" };
          },
          assertSafeBuilderConfigImpl: () => order.push("setup"),
          verifyNativeAbiImpl: ({ label }) => {
            order.push(label);
            return {
              ok: true,
              abi: label === "source-node" ? process.versions.modules : "145",
              value: 1,
            };
          },
          assertSafeArtifactTreeImpl: () => order.push("package-scan"),
          assertUnsignedWindowsArtifactsImpl: () => order.push("auth-scan"),
        }),
      /Windows package build failed/i
    );
    assert.deepEqual(order, [
      "setup",
      "electron-prebuild",
      "source-electron",
      "builder",
      "node-restore",
      "source-node",
    ]);
  } finally {
    process.exitCode = previousExitCode;
  }
});
