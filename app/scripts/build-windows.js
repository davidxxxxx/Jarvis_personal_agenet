const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSafeArtifactTree, assertSafeBuilderConfig } = require("./verify-package-safety");

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

function createUnsignedBuilderInvocation({ appRoot = path.resolve(__dirname, ".."), env = process.env } = {}) {
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
  const pkg = JSON.parse(require("node:fs").readFileSync(path.join(appRoot, "package.json"), "utf8"));
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
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  assertSafeBuilderConfig(configPath);
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(invocation.command, invocation.args, {
    ...invocation.options,
    env: invocation.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const artifactRoot = path.join(appRoot, "dist");
    assertSafeArtifactTree(artifactRoot);
    assertUnsignedWindowsArtifacts({
      appRoot,
      artifactRoot,
      platform: options.platform,
      systemRoot: options.systemRoot,
      spawnSyncImpl,
    });
  }
  return result;
}

if (require.main === module) buildUnsignedWindows();

module.exports = {
  assertUnsignedWindowsArtifacts,
  buildUnsignedWindows,
  createUnsignedBuilderInvocation,
  sanitizeUnsignedEnvironment,
};
