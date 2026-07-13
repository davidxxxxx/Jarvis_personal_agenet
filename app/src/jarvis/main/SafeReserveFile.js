const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function sameFileIdentity(expected, actual) {
  return (
    expected?.isFile?.() === true &&
    expected?.isSymbolicLink?.() === false &&
    actual?.isFile?.() === true &&
    actual?.isSymbolicLink?.() === false &&
    String(expected.dev) === String(actual.dev) &&
    String(expected.ino) === String(actual.ino) &&
    expected.size === actual.size &&
    expected.nlink === 1 &&
    actual.nlink === 1
  );
}

class DefaultFreeSpaceInspector {
  inspect(directory) {
    const stat = fs.statfsSync(directory);
    return Number(stat.bavail) * Number(stat.bsize);
  }

  async inspectAsync(directory) {
    const stat = await fsp.statfs(directory);
    return Number(stat.bavail) * Number(stat.bsize);
  }
}

function assertFreed(before, after, requiredBytes) {
  if (
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes <= 0 ||
    after - before < requiredBytes
  ) {
    throw new Error("emergency reserve released allocation could not be verified");
  }
}

function restoreQuarantineSync(fsImpl, quarantine, original) {
  try {
    fsImpl.linkSync(quarantine, original);
    fsImpl.unlinkSync(quarantine);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function restoreQuarantine(fsImpl, quarantine, original) {
  try {
    await fsImpl.link(quarantine, original);
    await fsImpl.unlink(quarantine);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function fsyncDirectorySync(fsImpl, directory) {
  let handle = null;
  try {
    handle = fsImpl.openSync(directory, "r");
    fsImpl.fsyncSync(handle);
  } catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (handle !== null) fsImpl.closeSync(handle);
  }
}

async function fsyncDirectory(fsImpl, directory) {
  let handle = null;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function releaseReserveSync({
  filePath,
  sizeBytes,
  fsImpl = fs,
  validate,
  freeSpaceInspector = new DefaultFreeSpaceInspector(),
}) {
  const reservePath = path.resolve(filePath);
  const directory = path.dirname(reservePath);
  const before = freeSpaceInspector.inspect(directory);
  let handle = null;
  try {
    handle = fsImpl.openSync(reservePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const expected = fsImpl.fstatSync(handle);
  try {
    validate(reservePath, expected);
    const quarantine = `${reservePath}.release-${crypto.randomUUID()}`;
    fsImpl.renameSync(reservePath, quarantine);
    const renamed = fsImpl.lstatSync(quarantine);
    if (!sameFileIdentity(expected, renamed)) {
      restoreQuarantineSync(fsImpl, quarantine, reservePath);
      throw new Error("emergency reserve file is unsafe");
    }
    validate(quarantine, renamed);
    fsImpl.unlinkSync(quarantine);
  } finally {
    fsImpl.closeSync(handle);
  }
  fsyncDirectorySync(fsImpl, directory);
  const after = freeSpaceInspector.inspect(directory);
  assertFreed(before, after, sizeBytes);
  return true;
}

async function releaseReserve({
  filePath,
  sizeBytes,
  fsImpl = fsp,
  validate = async () => {},
  freeSpaceInspector = new DefaultFreeSpaceInspector(),
}) {
  const reservePath = path.resolve(filePath);
  const directory = path.dirname(reservePath);
  const before = freeSpaceInspector.inspectAsync
    ? await freeSpaceInspector.inspectAsync(directory)
    : await freeSpaceInspector.inspect(directory);
  let handle = null;
  try {
    handle = await fsImpl.open(reservePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const expected = await handle.stat();
  try {
    await validate(reservePath, expected);
    const quarantine = `${reservePath}.release-${crypto.randomUUID()}`;
    await fsImpl.rename(reservePath, quarantine);
    const renamed = await fsImpl.lstat(quarantine);
    if (!sameFileIdentity(expected, renamed)) {
      await restoreQuarantine(fsImpl, quarantine, reservePath);
      throw new Error("emergency reserve file is unsafe");
    }
    await validate(quarantine, renamed);
    await fsImpl.unlink(quarantine);
  } finally {
    await handle.close();
  }
  await fsyncDirectory(fsImpl, directory);
  const after = freeSpaceInspector.inspectAsync
    ? await freeSpaceInspector.inspectAsync(directory)
    : await freeSpaceInspector.inspect(directory);
  assertFreed(before, after, sizeBytes);
  return true;
}

module.exports = {
  DefaultFreeSpaceInspector,
  releaseReserve,
  releaseReserveSync,
  sameFileIdentity,
};
