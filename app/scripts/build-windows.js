const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSafeArtifactTree, assertSafeBuilderConfig } = require("./verify-package-safety");
const { verifyNativeAbi } = require("./verify-native-abi");

const ELECTRON_VERSION = "41.10.0";
const ELECTRON_ABI = "145";
const TARGET_ARCH = "x64";
const TARGET_PLATFORM = "win32";

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
} = {}) {
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  return {
    command: process.execPath,
    args: [require.resolve("electron-builder/cli.js"), "--win", "--config", configPath],
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
  const rebuildMainPath = require.resolve("@electron/rebuild");
  const rebuildCliPath = path.join(path.dirname(rebuildMainPath), "cli.js");
  return {
    command: process.execPath,
    args: [
      rebuildCliPath,
      "--version",
      ELECTRON_VERSION,
      "--arch",
      TARGET_ARCH,
      "--platform",
      TARGET_PLATFORM,
      "--force",
      "--only",
      "better-sqlite3",
      "--module-dir",
      appRoot,
    ],
    env: sanitizeUnsignedEnvironment(env),
    options: {
      cwd: appRoot,
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
  const npmCliPath = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const restoreEnvironment = { ...env };
  for (const name of Object.keys(restoreEnvironment)) {
    if (/^(?:npm_config_)?(?:runtime|target|disturl|target_arch)$/i.test(name)) {
      delete restoreEnvironment[name];
    }
  }
  delete restoreEnvironment.ELECTRON_RUN_AS_NODE;
  return {
    command: process.execPath,
    args: [npmCliPath, "rebuild", "better-sqlite3"],
    env: restoreEnvironment,
    options: {
      cwd: appRoot,
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
  spawnSyncImpl = spawnSync,
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
  const expectedNames = [
    `${pkg.productName} Setup ${pkg.version}.exe`,
    `${pkg.productName} ${pkg.version}.exe`,
  ];
  const artifactPaths = expectedNames.map((name) => path.join(artifactRoot, name));
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
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
    { cwd: appRoot, encoding: "utf8", shell: false, windowsHide: true }
  );
  if (result.error || result.status !== 0) {
    throw new Error("Authenticode verification failed");
  }
  let rows;
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("Authenticode verification returned invalid output");
  }
  for (const expectedName of expectedNames) {
    const row = rows.find((entry) => entry?.name === expectedName);
    if (!row || row.status !== "NotSigned") {
      throw new Error(`artifact must be Authenticode NotSigned: ${expectedName}`);
    }
  }
}

function buildUnsignedWindows(options = {}) {
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..");
  const invocation = createUnsignedBuilderInvocation({ ...options, appRoot });
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
    runRequiredInvocation(
      electronRebuildInvocation,
      "Electron native dependency rebuild",
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
    const artifactRoot = path.join(appRoot, "dist");
    assertSafeArtifactTreeImpl(artifactRoot);
    assertUnsignedWindowsArtifactsImpl({
      appRoot,
      artifactRoot,
      platform: options.platform,
      systemRoot: options.systemRoot,
      spawnSyncImpl,
    });
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

if (require.main === module) buildUnsignedWindows();

module.exports = {
  assertUnsignedWindowsArtifacts,
  buildUnsignedWindows,
  createElectronNativeRebuildInvocation,
  createNodeNativeRestoreInvocation,
  createUnsignedBuilderInvocation,
  sanitizeUnsignedEnvironment,
  verifyNativeAbi,
};
