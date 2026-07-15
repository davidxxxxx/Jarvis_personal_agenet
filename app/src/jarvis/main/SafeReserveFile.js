const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
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

class DefaultAllocationInspector {
  inspect(filePath, stat) {
    let reparse = stat.isSymbolicLink();
    let sparse = false;
    let compressed = false;
    if (process.platform === "win32") {
      try {
        const raw = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "& { $a=(Get-Item -LiteralPath $args[0] -Force).Attributes; [Console]::Write([int]$a) }",
            filePath,
          ],
          { windowsHide: true, timeout: 5_000, encoding: "utf8" }
        );
        const attributes = Number(String(raw).trim());
        if (!Number.isSafeInteger(attributes)) throw new Error("invalid file attributes");
        reparse ||= (attributes & 0x400) !== 0;
        sparse = (attributes & 0x200) !== 0;
        compressed = (attributes & 0x800) !== 0;
      } catch {
        throw new Error("emergency reserve allocation could not be inspected");
      }
    }
    return {
      allocatedBytes:
        Number.isSafeInteger(stat.blocks) && stat.blocks >= 0 ? stat.blocks * 512 : stat.size,
      reparse,
      sparse,
      compressed,
    };
  }
}

function assertAllocated(filePath, stat, requiredBytes, allocationInspector) {
  const allocation = allocationInspector.inspect(filePath, stat);
  if (
    !stat?.isFile?.() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== requiredBytes ||
    !allocation ||
    allocation.reparse ||
    allocation.sparse ||
    allocation.compressed ||
    !Number.isSafeInteger(allocation.allocatedBytes) ||
    allocation.allocatedBytes < requiredBytes
  ) {
    throw new Error("emergency reserve file is unsafe");
  }
}

function freeSpaceTelemetry(beforeBytes, afterBytes, requiredBytes) {
  const observedDeltaBytes =
    Number.isSafeInteger(beforeBytes) && Number.isSafeInteger(afterBytes)
      ? afterBytes - beforeBytes
      : null;
  return Object.freeze({
    beforeBytes: Number.isSafeInteger(beforeBytes) ? beforeBytes : null,
    afterBytes: Number.isSafeInteger(afterBytes) ? afterBytes : null,
    observedDeltaBytes,
    requiredBytes,
    confirmed: Number.isSafeInteger(observedDeltaBytes) && observedDeltaBytes >= requiredBytes,
  });
}

function inspectFreeSpaceSync(inspector, directory) {
  try {
    return inspector.inspect(directory);
  } catch {
    return null;
  }
}

async function inspectFreeSpace(inspector, directory) {
  try {
    return inspector.inspectAsync
      ? await inspector.inspectAsync(directory)
      : await inspector.inspect(directory);
  } catch {
    return null;
  }
}

function reportTelemetrySync(callback, sample) {
  try {
    const pending = callback(sample);
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {}
}

function assertSizeBytes(sizeBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new TypeError("sizeBytes must be a positive safe integer");
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
  validate = () => {},
  allocationInspector = new DefaultAllocationInspector(),
  freeSpaceInspector = new DefaultFreeSpaceInspector(),
  onFreeSpaceTelemetry = () => {},
}) {
  assertSizeBytes(sizeBytes);
  const reservePath = path.resolve(filePath);
  const directory = path.dirname(reservePath);
  const before = inspectFreeSpaceSync(freeSpaceInspector, directory);
  let handle = null;
  try {
    handle = fsImpl.openSync(reservePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const expected = fsImpl.fstatSync(handle);
  try {
    assertAllocated(reservePath, expected, sizeBytes, allocationInspector);
    validate(reservePath, expected);
    const quarantine = `${reservePath}.release-${crypto.randomUUID()}`;
    fsImpl.renameSync(reservePath, quarantine);
    const renamed = fsImpl.lstatSync(quarantine);
    if (!sameFileIdentity(expected, renamed)) {
      restoreQuarantineSync(fsImpl, quarantine, reservePath);
      throw new Error("emergency reserve file is unsafe");
    }
    assertAllocated(quarantine, renamed, sizeBytes, allocationInspector);
    validate(quarantine, renamed);
    fsImpl.unlinkSync(quarantine);
  } finally {
    fsImpl.closeSync(handle);
  }
  fsyncDirectorySync(fsImpl, directory);
  const after = inspectFreeSpaceSync(freeSpaceInspector, directory);
  reportTelemetrySync(onFreeSpaceTelemetry, freeSpaceTelemetry(before, after, sizeBytes));
  return true;
}

async function releaseReserve({
  filePath,
  sizeBytes,
  fsImpl = fsp,
  validate = async () => {},
  allocationInspector = new DefaultAllocationInspector(),
  freeSpaceInspector = new DefaultFreeSpaceInspector(),
  onFreeSpaceTelemetry = () => {},
}) {
  assertSizeBytes(sizeBytes);
  const reservePath = path.resolve(filePath);
  const directory = path.dirname(reservePath);
  const before = await inspectFreeSpace(freeSpaceInspector, directory);
  let handle = null;
  try {
    handle = await fsImpl.open(reservePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const expected = await handle.stat();
  try {
    assertAllocated(reservePath, expected, sizeBytes, allocationInspector);
    await validate(reservePath, expected);
    const quarantine = `${reservePath}.release-${crypto.randomUUID()}`;
    await fsImpl.rename(reservePath, quarantine);
    const renamed = await fsImpl.lstat(quarantine);
    if (!sameFileIdentity(expected, renamed)) {
      await restoreQuarantine(fsImpl, quarantine, reservePath);
      throw new Error("emergency reserve file is unsafe");
    }
    assertAllocated(quarantine, renamed, sizeBytes, allocationInspector);
    await validate(quarantine, renamed);
    await fsImpl.unlink(quarantine);
  } finally {
    await handle.close();
  }
  await fsyncDirectory(fsImpl, directory);
  const after = await inspectFreeSpace(freeSpaceInspector, directory);
  reportTelemetrySync(onFreeSpaceTelemetry, freeSpaceTelemetry(before, after, sizeBytes));
  return true;
}

module.exports = {
  DefaultAllocationInspector,
  DefaultFreeSpaceInspector,
  releaseReserve,
  releaseReserveSync,
  sameFileIdentity,
};
