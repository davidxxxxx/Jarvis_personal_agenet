const fs = require("node:fs");
const path = require("node:path");

const GIB = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 512 * 1024 ** 2;
const RESERVE_CHUNK_BYTES = 1024 ** 2;

class FileEmergencyReserve {
  constructor({ filePath, sizeBytes = DEFAULT_RESERVE_BYTES, fsImpl = fs } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("emergency reserve filePath must be absolute");
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new TypeError("emergency reserve sizeBytes must be a positive safe integer");
    }
    this.filePath = path.resolve(filePath);
    this.sizeBytes = sizeBytes;
    this.fs = fsImpl;
  }

  ensure() {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      if (this.fs.statSync(this.filePath).size === this.sizeBytes) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const temporary = `${this.filePath}.tmp`;
    const handle = this.fs.openSync(temporary, "w", 0o600);
    try {
      const chunk = Buffer.alloc(Math.min(RESERVE_CHUNK_BYTES, this.sizeBytes));
      let written = 0;
      while (written < this.sizeBytes) {
        const length = Math.min(chunk.length, this.sizeBytes - written);
        this.fs.writeSync(handle, chunk, 0, length, written);
        written += length;
      }
      this.fs.fsyncSync(handle);
    } finally {
      this.fs.closeSync(handle);
    }
    this.fs.renameSync(temporary, this.filePath);
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

module.exports = StorageGovernor;
