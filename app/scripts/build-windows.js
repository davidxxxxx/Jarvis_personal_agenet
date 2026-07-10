const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSafeArtifactTree, assertSafeBuilderConfig } = require("./verify-package-safety");

function createUnsignedBuilderInvocation({ appRoot = path.resolve(__dirname, ".."), env = process.env } = {}) {
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  return {
    command: process.execPath,
    args: [require.resolve("electron-builder/cli.js"), "--win", "--config", configPath],
    env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    options: {
      cwd: appRoot,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

function buildUnsignedWindows(options = {}) {
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..");
  const invocation = createUnsignedBuilderInvocation({ ...options, appRoot });
  const configPath = path.join(appRoot, "electron-builder.unsigned-win.json");
  assertSafeBuilderConfig(configPath);
  const result = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    env: invocation.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else assertSafeArtifactTree(path.join(appRoot, "dist"));
  return result;
}

if (require.main === module) buildUnsignedWindows();

module.exports = { buildUnsignedWindows, createUnsignedBuilderInvocation };
