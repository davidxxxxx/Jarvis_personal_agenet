const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const GIB = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 512 * 1024 ** 2;
const RESERVE_CHUNK_BYTES = 1024 ** 2;

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
            "$a=(Get-Item -LiteralPath $args[0] -Force).Attributes; [Console]::Write([int]$a)",
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

class FileEmergencyReserve {
  constructor({
    filePath,
    sizeBytes = DEFAULT_RESERVE_BYTES,
    fsImpl = fs,
    allocationInspector = new DefaultAllocationInspector(),
  } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("emergency reserve filePath must be absolute");
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new TypeError("emergency reserve sizeBytes must be a positive safe integer");
    }
    this.filePath = path.resolve(filePath);
    this.sizeBytes = sizeBytes;
    this.fs = fsImpl;
    if (!allocationInspector || typeof allocationInspector.inspect !== "function") {
      throw new TypeError("allocationInspector.inspect is required");
    }
    this.allocationInspector = allocationInspector;
  }

  ensure() {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const stat = this.fs.lstatSync(this.filePath);
      if (stat.size === this.sizeBytes) {
        this._assertAllocated(this.filePath, stat);
        return;
      }
      throw new Error("emergency reserve file is unsafe");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    const handle = this.fs.openSync(temporary, "wx", 0o600);
    try {
      let written = 0;
      while (written < this.sizeBytes) {
        const length = Math.min(RESERVE_CHUNK_BYTES, this.sizeBytes - written);
        const chunk = crypto.randomBytes(length);
        this.fs.writeSync(handle, chunk, 0, length, written);
        written += length;
      }
      this.fs.fsyncSync(handle);
    } finally {
      this.fs.closeSync(handle);
    }
    this._assertAllocated(temporary, this.fs.lstatSync(temporary));
    this.fs.renameSync(temporary, this.filePath);
    this._fsyncDirectory(path.dirname(this.filePath));
    this._assertAllocated(this.filePath, this.fs.lstatSync(this.filePath));
  }

  release() {
    try {
      this.fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  setFilePath(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("emergency reserve filePath must be absolute");
    }
    this.filePath = path.resolve(filePath);
  }

  _assertAllocated(filePath, stat) {
    const allocation = this.allocationInspector.inspect(filePath, stat);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !allocation ||
      allocation.reparse ||
      allocation.sparse ||
      allocation.compressed ||
      allocation.allocatedBytes < this.sizeBytes
    ) {
      throw new Error("emergency reserve file is unsafe");
    }
  }

  _fsyncDirectory(directory) {
    let handle = null;
    try {
      handle = this.fs.openSync(directory, "r");
      this.fs.fsyncSync(handle);
    } catch (error) {
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    } finally {
      if (handle !== null) this.fs.closeSync(handle);
    }
  }
}

class StorageGovernor {
  constructor({ reserve } = {}) {
    if (!reserve || typeof reserve.ensure !== "function" || typeof reserve.release !== "function") {
      throw new TypeError("reserve with ensure and release methods is required");
    }
    this.reserve = reserve;
    this.reserveReleased = false;
  }

  static thresholds(volumeBytes) {
    StorageGovernor._assertBytes(volumeBytes, "volumeBytes", { positive: true });
    return {
      warningBytes: Math.max(20 * GIB, Math.ceil(volumeBytes * 0.1)),
      stopBytes: Math.max(5 * GIB, Math.ceil(volumeBytes * 0.03)),
    };
  }

  static _assertBytes(value, name, { positive = false } = {}) {
    if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
      throw new TypeError(
        `${name} must be ${positive ? "a positive" : "a non-negative"} safe integer`
      );
    }
  }

  ensureReserve() {
    try {
      this.reserve.ensure();
      this.reserveReleased = false;
    } catch {
      throw new Error(
        "emergency storage reserve unavailable; free disk space and restart Jarvis before capture"
      );
    }
  }

  evaluate({ volumeBytes, freeBytes, pendingWriteBytes = 0 }) {
    StorageGovernor._assertBytes(volumeBytes, "volumeBytes", { positive: true });
    StorageGovernor._assertBytes(freeBytes, "freeBytes");
    StorageGovernor._assertBytes(pendingWriteBytes, "pendingWriteBytes");
    const { warningBytes, stopBytes } = StorageGovernor.thresholds(volumeBytes);
    const effectiveFreeBytes = Math.max(0, freeBytes - pendingWriteBytes);
    if (effectiveFreeBytes <= stopBytes) return "stop";
    if (effectiveFreeBytes <= warningBytes) return "warning";
    return "ok";
  }

  inspect(input) {
    const state = this.evaluate(input);
    if (state === "stop" && !this.reserveReleased) {
      try {
        this.reserve.release();
        this.reserveReleased = true;
      } catch {
        throw new Error(
          "emergency storage reserve could not be released; stop capture and free disk space"
        );
      }
    }
    const thresholds = StorageGovernor.thresholds(input.volumeBytes);
    return {
      state: state === "stop" ? "stopped" : state,
      volumeBytes: input.volumeBytes,
      freeBytes: input.freeBytes,
      pendingWriteBytes: input.pendingWriteBytes ?? 0,
      ...thresholds,
      recoveryAction:
        state === "stop"
          ? "Free disk space, then resume capture."
          : state === "warning"
            ? "Free disk space or migrate the Jarvis data directory."
            : null,
    };
  }
}

StorageGovernor.FileEmergencyReserve = FileEmergencyReserve;
StorageGovernor.DEFAULT_RESERVE_BYTES = DEFAULT_RESERVE_BYTES;
StorageGovernor.DefaultAllocationInspector = DefaultAllocationInspector;

module.exports = StorageGovernor;
