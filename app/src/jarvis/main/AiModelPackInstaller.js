const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MANIFEST_FILE,
  resolveAiModelPackRoot,
  verifyAiModelPack,
} = require("./AiModelPackManifest");
const { assertNonSystemDrive } = require("./SpeakerModelManifest");

const BUNDLED_DIRECTORY = "jarvis-ai-model-pack";

function resolveBundledAiModelPackRoot({ resourcesPath = process.resourcesPath } = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    throw new TypeError("resourcesPath must be absolute");
  }
  return path.resolve(resourcesPath, BUNDLED_DIRECTORY);
}

async function targetExists(targetRoot, fsImpl) {
  try {
    return (await fsImpl.stat(targetRoot)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function currentTargetDigest(targetRoot, fsImpl, systemDrive) {
  try {
    const verified = await verifyAiModelPack({ root: targetRoot, fsImpl, systemDrive });
    return verified.manifestSha256;
  } catch {
    return null;
  }
}

async function copyVerifiedFiles(source, staging, fsImpl) {
  await fsImpl.mkdir(staging, { recursive: false });
  for (const entry of source.manifest.files) {
    const from = path.resolve(source.root, entry.path);
    const to = path.resolve(staging, entry.path);
    if (to !== staging && !to.startsWith(`${staging}${path.sep}`)) {
      throw new Error("model pack target path escapes staging root");
    }
    await fsImpl.mkdir(path.dirname(to), { recursive: true });
    try {
      await fsImpl.link(from, to);
    } catch (error) {
      if (!new Set(["EXDEV", "EPERM", "EACCES", "ENOSYS", "EEXIST"]).has(error?.code)) {
        throw error;
      }
      await fsImpl.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
  await fsImpl.writeFile(
    path.join(staging, MANIFEST_FILE),
    `${JSON.stringify(source.manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

async function installBundledAiModelPack({
  sourceRoot = resolveBundledAiModelPackRoot(),
  targetRoot = resolveAiModelPackRoot(),
  fsImpl = fs.promises,
  systemDrive,
} = {}) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new TypeError("sourceRoot must be absolute");
  }
  const safeTarget = assertNonSystemDrive(path.resolve(targetRoot), { systemDrive });
  const source = await verifyAiModelPack({
    root: path.resolve(sourceRoot),
    fsImpl,
    allowSystemDrive: true,
  });
  const existingDigest = await currentTargetDigest(safeTarget, fsImpl, systemDrive);
  if (existingDigest === source.manifestSha256) {
    return Object.freeze({
      state: "current",
      targetRoot: safeTarget,
      packVersion: source.manifest.packVersion,
      manifestSha256: source.manifestSha256,
    });
  }

  const parent = path.dirname(safeTarget);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const staging = path.join(parent, `.${path.basename(safeTarget)}.install-${nonce}`);
  const backup = path.join(parent, `.${path.basename(safeTarget)}.rollback-${nonce}`);
  let backupCreated = false;
  const replacing = await targetExists(safeTarget, fsImpl);
  try {
    await fsImpl.mkdir(parent, { recursive: true });
    await copyVerifiedFiles(source, staging, fsImpl);
    const staged = await verifyAiModelPack({ root: staging, fsImpl, systemDrive });
    if (staged.manifestSha256 !== source.manifestSha256) {
      throw new Error("model pack changed while it was being installed");
    }
    if (replacing) {
      await fsImpl.rename(safeTarget, backup);
      backupCreated = true;
    }
    await fsImpl.rename(staging, safeTarget);
    const installed = await verifyAiModelPack({ root: safeTarget, fsImpl, systemDrive });
    if (installed.manifestSha256 !== source.manifestSha256) {
      throw new Error("installed model pack did not pass final verification");
    }
    if (backupCreated) {
      await fsImpl.rm(backup, { recursive: true, force: true });
      backupCreated = false;
    }
    return Object.freeze({
      state: replacing ? "replaced" : "installed",
      targetRoot: safeTarget,
      packVersion: installed.manifest.packVersion,
      manifestSha256: installed.manifestSha256,
    });
  } catch (error) {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await fsImpl.rm(safeTarget, { recursive: true, force: true }).catch(() => {});
      await fsImpl.rename(backup, safeTarget).catch(() => {});
      backupCreated = false;
    }
    throw error;
  } finally {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await fsImpl.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function installBundledAiModelPackIfPresent({
  resourcesPath = process.resourcesPath,
  dataRoot = process.env.JARVIS_DATA_ROOT,
  fsImpl = fs.promises,
  systemDrive,
} = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    return Object.freeze({ state: "not_bundled" });
  }
  const sourceRoot = resolveBundledAiModelPackRoot({ resourcesPath });
  try {
    const stat = await fsImpl.stat(path.join(sourceRoot, MANIFEST_FILE));
    if (!stat.isFile()) return Object.freeze({ state: "not_bundled" });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ state: "not_bundled" });
    throw error;
  }
  return installBundledAiModelPack({
    sourceRoot,
    targetRoot: resolveAiModelPackRoot({ dataRoot, systemDrive }),
    fsImpl,
    systemDrive,
  });
}

module.exports = {
  BUNDLED_DIRECTORY,
  installBundledAiModelPack,
  installBundledAiModelPackIfPresent,
  resolveBundledAiModelPackRoot,
};
