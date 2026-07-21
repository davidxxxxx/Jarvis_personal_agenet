const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSafeArtifactTree, assertSafeBuilderConfig } = require("./verify-package-safety");
const { verifyNativeAbi } = require("./verify-native-abi");

const ELECTRON_VERSION = "41.10.0";
const ELECTRON_ABI = "145";
const TARGET_ARCH = "x64";

const SIGNING_ENVIRONMENT = [
  /^(?:WIN(?:DOWS)?_)?CSC_/i,
  /^AZURE_(?:CLIENT_ID|CLIENT_SECRET|TENANT_ID|FEDERATED_TOKEN_FILE|AUTHORITY_HOST|CERTIFICATE_PROFILE_NAME|CODE_SIGNING_ACCOUNT_NAME|ENDPOINT)$/i,
  /^AZURE_TRUSTED_SIGNING_/i,
  /^SIGNTOOL_/i,
  /^(?:WIN(?:DOWS)?_)?CERTIFICATE_(?:LINK|PASSWORD|NAME|SUBJECT_NAME)$/i,
];

function sanitizeUnsignedEnvironment(environment) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (name.toUpperCase() === "CSC_IDENTITY_AUTO_DISCOVERY") continue;
    if (SIGNING_ENVIRONMENT.some((pattern) => pattern.test(name))) continue;
    sanitized[name] = value;
  }
  sanitized.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return sanitized;
}

function createUnsignedBuilderInvocation({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
  dirOnly = false,
} = {}) {
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  const args = [require.resolve("electron-builder/cli.js"), "--win", "--config", configPath];
  if (dirOnly) args.push("--dir");
  return {
    command: process.execPath,
    args,
    env: sanitizeUnsignedEnvironment(env),
    options: {
      cwd: appRoot,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function createWindowsModelBundleInvocation({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
  publishOnly = false,
} = {}) {
  const args = [path.join(appRoot, "scripts", "build-windows-model-bundle.js")];
  if (publishOnly) args.push("--publish-only");
  return {
    command: process.execPath,
    args,
    env: sanitizeUnsignedEnvironment(env),
    options: {
      cwd: appRoot,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function createElectronNativeRebuildInvocation({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
} = {}) {
  const prebuildCliPath = require.resolve("prebuild-install/bin.js");
  const modulePath = path.join(appRoot, "node_modules", "better-sqlite3");
  return {
    command: process.execPath,
    args: [
      prebuildCliPath,
      "--runtime",
      "electron",
      "--target",
      ELECTRON_VERSION,
      "--arch",
      TARGET_ARCH,
    ],
    env: sanitizeUnsignedEnvironment(env),
    options: {
      cwd: modulePath,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function createNodeNativeRestoreInvocation({
  appRoot = path.resolve(__dirname, ".."),
  env = process.env,
} = {}) {
  const prebuildCliPath = require.resolve("prebuild-install/bin.js");
  const modulePath = path.join(appRoot, "node_modules", "better-sqlite3");
  const restoreEnvironment = { ...env };
  for (const name of Object.keys(restoreEnvironment)) {
    if (/^(?:npm_config_)?(?:runtime|target|disturl|target_arch)$/i.test(name)) {
      delete restoreEnvironment[name];
    }
  }
  delete restoreEnvironment.ELECTRON_RUN_AS_NODE;
  return {
    command: process.execPath,
    args: [
      prebuildCliPath,
      "--runtime",
      "node",
      "--target",
      process.versions.node,
      "--arch",
      process.arch,
    ],
    env: restoreEnvironment,
    options: {
      cwd: modulePath,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function runRequiredInvocation(invocation, label, spawnSyncImpl) {
  const result = spawnSyncImpl(invocation.command, invocation.args, {
    ...invocation.options,
    env: invocation.env,
  });
  if (result.error || result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

function getSourceNativePaths(appRoot) {
  const modulePath = path.join(appRoot, "node_modules", "better-sqlite3");
  return {
    runtimePath: path.join(appRoot, "node_modules", "electron", "dist", "electron.exe"),
    modulePath,
    binaryPath: path.join(modulePath, "build", "Release", "better_sqlite3.node"),
  };
}

function getPackagedNativePaths(appRoot) {
  const unpackedRoot = path.join(appRoot, "dist", "win-unpacked");
  const modulePath = path.join(
    unpackedRoot,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3"
  );
  return {
    runtimePath: path.join(unpackedRoot, "Jarvis Memory.exe"),
    modulePath,
    binaryPath: path.join(modulePath, "build", "Release", "better_sqlite3.node"),
  };
}

function assertUnsignedWindowsArtifacts({
  appRoot = path.resolve(__dirname, ".."),
  artifactRoot = path.join(appRoot, "dist"),
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  env = process.env,
  spawnSyncImpl = spawnSync,
  signatureScanAttempts = 10,
  signatureScanRetryDelayMs = 500,
  waitImpl = (delayMs) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs),
} = {}) {
  if (platform !== "win32") {
    throw new Error("Authenticode verification requires Windows");
  }
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("trusted Windows SystemRoot is unavailable");
  }
  const pkg = JSON.parse(
    require("node:fs").readFileSync(path.join(appRoot, "package.json"), "utf8")
  );
  const expectedNames = [`${pkg.productName} Setup ${pkg.version}.exe`];
  const artifactPaths = expectedNames.map((name) => path.join(artifactRoot, name));
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const verificationEnvironment = { ...env };
  for (const name of Object.keys(verificationEnvironment)) {
    if (/^psmodulepath$/i.test(name)) delete verificationEnvironment[name];
  }
  // Windows PowerShell 5.1 cannot import PowerShell 7's security module.
  // Pin its built-in module root so a parent PowerShell 7 process cannot
  // leak an incompatible WindowsApps module path into Authenticode checks.
  verificationEnvironment.PSModulePath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules"
  );
  let lastError;
  for (let attempt = 1; attempt <= signatureScanAttempts; attempt += 1) {
    const result = spawnSyncImpl(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(appRoot, "scripts", "verify-unsigned-artifacts.ps1"),
        ...artifactPaths,
      ],
      {
        cwd: appRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: verificationEnvironment,
      }
    );
    try {
      if (result.error || result.status !== 0) {
        throw new Error("Authenticode verification failed");
      }
      const parsed = JSON.parse(String(result.stdout).trim());
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const expectedName of expectedNames) {
        const row = rows.find((entry) => entry?.name === expectedName);
        if (!row || row.status !== "NotSigned") {
          throw new Error(`artifact must be Authenticode NotSigned: ${expectedName}`);
        }
      }
      return;
    } catch (error) {
      lastError =
        error instanceof SyntaxError
          ? new Error("Authenticode verification returned invalid output")
          : error;
      if (attempt < signatureScanAttempts) {
        waitImpl(signatureScanRetryDelayMs);
      }
    }
  }
  throw lastError;
}

function buildUnsignedWindows(options = {}) {
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..");
  const invocation = createUnsignedBuilderInvocation({ ...options, appRoot });
  const modelBundleInvocation = createWindowsModelBundleInvocation({ ...options, appRoot });
  const modelPublishInvocation = createWindowsModelBundleInvocation({
    ...options,
    appRoot,
    publishOnly: true,
  });
  const electronRebuildInvocation = createElectronNativeRebuildInvocation({ ...options, appRoot });
  const nodeRestoreInvocation = createNodeNativeRestoreInvocation({ ...options, appRoot });
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const assertSafeBuilderConfigImpl =
    options.assertSafeBuilderConfigImpl ?? assertSafeBuilderConfig;
  const verifyNativeAbiImpl = options.verifyNativeAbiImpl ?? verifyNativeAbi;
  const assertSafeArtifactTreeImpl = options.assertSafeArtifactTreeImpl ?? assertSafeArtifactTree;
  const assertUnsignedWindowsArtifactsImpl =
    options.assertUnsignedWindowsArtifactsImpl ?? assertUnsignedWindowsArtifacts;
  const sourceNativePaths = getSourceNativePaths(appRoot);
  const packagedNativePaths = getPackagedNativePaths(appRoot);
  let result;
  let primaryError;
  let restoreError;

  try {
    assertSafeBuilderConfigImpl(configPath);
    if (!options.dirOnly) {
      runRequiredInvocation(
        modelBundleInvocation,
        "Windows model component preparation",
        spawnSyncImpl
      );
    }
    runRequiredInvocation(
      electronRebuildInvocation,
      "Electron native dependency prebuild install",
      spawnSyncImpl
    );
    verifyNativeAbiImpl({
      ...sourceNativePaths,
      expectedAbi: ELECTRON_ABI,
      label: "source-electron",
      environment: invocation.env,
    });
    result = spawnSyncImpl(invocation.command, invocation.args, {
      ...invocation.options,
      env: invocation.env,
    });
    if (result.error || result.status !== 0) throw new Error("Windows package build failed");
    verifyNativeAbiImpl({
      ...packagedNativePaths,
      expectedAbi: ELECTRON_ABI,
      label: "packaged-electron",
      environment: invocation.env,
    });
    if (!options.dirOnly) {
      runRequiredInvocation(
        modelPublishInvocation,
        "Windows model component publication",
        spawnSyncImpl
      );
    }
    const artifactRoot = path.join(appRoot, "dist");
    assertSafeArtifactTreeImpl(artifactRoot);
    if (!options.dirOnly) {
      assertUnsignedWindowsArtifactsImpl({
        appRoot,
        artifactRoot,
        platform: options.platform,
        systemRoot: options.systemRoot,
        spawnSyncImpl,
      });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      runRequiredInvocation(nodeRestoreInvocation, "Node native dependency restore", spawnSyncImpl);
      verifyNativeAbiImpl({
        ...sourceNativePaths,
        runtimePath: process.execPath,
        expectedAbi: String(process.versions.modules),
        label: "source-node",
        environment: nodeRestoreInvocation.env,
      });
    } catch (error) {
      restoreError = error;
    }
  }
  if (restoreError) {
    throw new Error(
      primaryError
        ? `${primaryError.message}; Node native dependency restore failed`
        : "Node native dependency restore failed"
    );
  }
  if (primaryError) throw primaryError;
  return result;
}

if (require.main === module) {
  buildUnsignedWindows({ dirOnly: process.argv.includes("--dir") });
}

module.exports = {
  assertUnsignedWindowsArtifacts,
  buildUnsignedWindows,
  createElectronNativeRebuildInvocation,
  createNodeNativeRestoreInvocation,
  createUnsignedBuilderInvocation,
  createWindowsModelBundleInvocation,
  sanitizeUnsignedEnvironment,
  verifyNativeAbi,
};
