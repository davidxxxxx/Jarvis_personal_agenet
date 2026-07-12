const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;

class JarvisStorageManager {
  constructor({ currentRoot, governor, migrator, fsImpl = fs, now = Date.now }) {
    if (typeof currentRoot !== "string" || !path.isAbsolute(currentRoot)) {
      throw new TypeError("currentRoot must be absolute");
    }
    if (!governor || typeof governor.inspect !== "function") {
      throw new TypeError("governor.inspect is required");
    }
    if (!migrator || typeof migrator.migrate !== "function") {
      throw new TypeError("migrator.migrate is required");
    }
    this.currentRoot = path.resolve(currentRoot);
    this.governor = governor;
    this.migrator = migrator;
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
    let writtenBytes24h = 0;
    let compressedBytes24h = 0;
    const walk = (directory) => {
      let entries;
      try {
        entries = this.fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        let stat;
        try {
          stat = this.fs.lstatSync(absolute);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(absolute);
        else if (
          stat.isFile() &&
          stat.mtimeMs >= cutoff &&
          entry.name !== ".emergency-reserve" &&
          !entry.name.includes("migration-manifest")
        ) {
          writtenBytes24h += stat.size;
          if (path.extname(entry.name).toLowerCase() === ".flac") compressedBytes24h += stat.size;
        }
      }
    };
    walk(this.currentRoot);
    return { writtenBytes24h, compressedBytes24h };
  }
}

module.exports = JarvisStorageManager;
