const fs = require("node:fs");
const path = require("node:path");

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

class RetentionCleaner {
  constructor({ repository, recordingsRoot, fsImpl = fs, now = Date.now, log = () => {} }) {
    if (!repository || typeof repository.listExpiredAudioChunks !== "function") {
      throw new TypeError("repository.listExpiredAudioChunks must be a function");
    }
    if (typeof repository.deleteAudioChunk !== "function") {
      throw new TypeError("repository.deleteAudioChunk must be a function");
    }
    if (typeof recordingsRoot !== "string" || recordingsRoot.length === 0) {
      throw new TypeError("recordingsRoot is required");
    }
    if (!fsImpl || typeof fsImpl.unlinkSync !== "function") {
      throw new TypeError("fsImpl.unlinkSync must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof log !== "function") throw new TypeError("log must be a function");

    this.repository = repository;
    this.recordingsRoot = path.resolve(recordingsRoot);
    this.fs = fsImpl;
    this.now = now;
    this.log = log;
    this.timer = null;
  }

  clean(at = this.now()) {
    const counts = { deleted: 0, retry: 0, missing: 0 };
    const expired = this.repository.listExpiredAudioChunks(at);

    for (const chunk of expired) {
      let missing = false;
      try {
        if (!this._isContainedRecording(chunk.path)) {
          counts.retry += 1;
          continue;
        }
        try {
          this.fs.unlinkSync(chunk.path);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          missing = true;
        }
        this.repository.deleteAudioChunk(chunk.id);
        if (missing) counts.missing += 1;
        else counts.deleted += 1;
      } catch {
        counts.retry += 1;
      }
    }

    this.log({ ...counts });
    return counts;
  }

  start(intervalMs = DAILY_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a positive safe integer");
    }
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.clean(this.now());
      } catch {
        this.log({ deleted: 0, retry: 1, missing: 0 });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  _isContainedRecording(filePath) {
    if (typeof filePath !== "string" || filePath.length === 0) return false;

    const candidate = path.resolve(filePath);
    if (!this._isWithin(this.recordingsRoot, candidate)) return false;

    try {
      const realRoot = this.fs.realpathSync(this.recordingsRoot);
      const realCandidate = this.fs.realpathSync(candidate);
      return this._isWithin(realRoot, realCandidate);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }

  _isWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  }
}

module.exports = RetentionCleaner;
