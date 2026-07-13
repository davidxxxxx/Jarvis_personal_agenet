const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;

class JarvisStorageManager {
  constructor({ currentRoot, governor, migrator, usageProvider, fsImpl = fs, now = Date.now }) {
    if (typeof currentRoot !== "string" || !path.isAbsolute(currentRoot)) {
      throw new TypeError("currentRoot must be absolute");
    }
    if (!governor || typeof governor.inspect !== "function") {
      throw new TypeError("governor.inspect is required");
    }
    if (!migrator || typeof migrator.migrate !== "function") {
      throw new TypeError("migrator.migrate is required");
    }
    if (typeof usageProvider !== "function") {
      throw new TypeError("usageProvider is required");
    }
    this.currentRoot = path.resolve(currentRoot);
    this.governor = governor;
    this.migrator = migrator;
    this.usageProvider = usageProvider;
    this.fs = fsImpl;
    this.now = now;
    this.progress = null;
  }

  setProgress(progress) {
    this.progress = progress ? { ...progress } : null;
  }

  async getStatus() {
    let stats;
    try {
      stats = this.fs.statfsSync(this.currentRoot);
    } catch {
      return {
        state: "stopped",
        currentRoot: this.currentRoot,
        freeBytes: 0,
        volumeBytes: 0,
        writtenBytes24h: 0,
        compressedBytes24h: 0,
        projectedDailyGrowthBytes: 0,
        remainingDays: 0,
        progress: this.progress,
        recoveryAction: "Restore access to the current data directory, then restart Jarvis.",
      };
    }
    const blockSize = Number(stats.bsize);
    const volumeBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail ?? stats.bfree) * blockSize;
    const inspected = this.governor.inspect({ volumeBytes, freeBytes });
    const usage = this._recentUsage();
    const projectedDailyGrowthBytes = usage.writtenBytes24h;
    const remainingDays =
      projectedDailyGrowthBytes > 0
        ? Math.max(0, Math.floor((freeBytes - inspected.stopBytes) / projectedDailyGrowthBytes))
        : null;
    return {
      ...inspected,
      currentRoot: this.currentRoot,
      ...usage,
      projectedDailyGrowthBytes,
      remainingDays,
      progress: this.progress,
    };
  }

  async migrate({ to, signal } = {}) {
    this.setProgress({ state: "starting", completedFiles: 0, totalFiles: 0 });
    try {
      const result = await this.migrator.migrate({ from: this.currentRoot, to, signal });
      if (result?.switched) this.currentRoot = path.resolve(to);
      this.setProgress({ state: "complete", completedFiles: 1, totalFiles: 1 });
      return result;
    } catch (error) {
      this.setProgress({ state: "failed", completedFiles: 0, totalFiles: 0 });
      throw error;
    }
  }

  _recentUsage() {
    const cutoff = this.now() - DAY_MS;
    const usage = this.usageProvider(cutoff);
    for (const name of ["writtenBytes24h", "compressedBytes24h"]) {
      if (!Number.isSafeInteger(usage?.[name]) || usage[name] < 0) {
        throw new Error(`storage usage telemetry returned invalid ${name}`);
      }
    }
    return {
      writtenBytes24h: usage.writtenBytes24h,
      compressedBytes24h: usage.compressedBytes24h,
    };
  }
}

module.exports = JarvisStorageManager;
