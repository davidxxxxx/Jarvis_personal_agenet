const path = require("node:path");
const { createSafeRecordingDelete } = require("./SafeRecordingDelete");

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

class RetentionCleaner {
  constructor({
    repository,
    recordingsRoot,
    deleteBatch = createSafeRecordingDelete(),
    now = Date.now,
    log = () => {},
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    if (!repository || typeof repository.listExpiredAudioChunks !== "function") {
      throw new TypeError("repository.listExpiredAudioChunks must be a function");
    }
    if (typeof repository.deleteAudioChunk !== "function") {
      throw new TypeError("repository.deleteAudioChunk must be a function");
    }
    if (typeof recordingsRoot !== "string" || recordingsRoot.length === 0) {
      throw new TypeError("recordingsRoot is required");
    }
    if (typeof deleteBatch !== "function") throw new TypeError("deleteBatch must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof log !== "function") throw new TypeError("log must be a function");

    this.repository = repository;
    this.recordingsRoot = path.resolve(recordingsRoot);
    this.deleteBatch = deleteBatch;
    this.now = now;
    this.log = log;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.timer = null;
    this.activeCleanup = null;
    this.generation = 0;
  }

  clean(at = this.now()) {
    if (this.activeCleanup) return this.activeCleanup;
    const generation = this.generation;
    const run = async () => {
      const counts = { deleted: 0, retry: 0, missing: 0 };
      const expired = this.repository.listExpiredAudioChunks(at);
      if (expired.length === 0) {
        this.log({ ...counts });
        return counts;
      }
      let results;
      try {
        results = await this.deleteBatch(
          this.recordingsRoot,
          expired.map((chunk) => chunk.path)
        );
      } catch {
        results = expired.map(() => ({ status: "retry", code: "helper_failed" }));
      }
      if (generation !== this.generation) {
        return { deleted: 0, retry: expired.length, missing: 0 };
      }
      for (let index = 0; index < expired.length; index += 1) {
        const result = results[index] ?? { status: "retry" };
        if (result.status === "deleted" || result.status === "missing") {
          this.repository.deleteAudioChunk(expired[index].id);
          counts[result.status] += 1;
        } else {
          counts.retry += 1;
        }
      }
      this.log({ ...counts });
      return counts;
    };
    const promise = run().finally(() => {
      if (this.activeCleanup === promise) this.activeCleanup = null;
    });
    this.activeCleanup = promise;
    return promise;
  }

  start(intervalMs = DAILY_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a positive safe integer");
    }
    if (this.timer !== null) return;
    let timer;
    const run = () => {
      if (this.timer !== timer) return;
      void this.clean(this.now()).catch(() => {
        this.log({ deleted: 0, retry: 1, missing: 0 });
      });
    };
    timer = this.setInterval(run, intervalMs);
    this.timer = timer;
    this.timer.unref?.();
  }

  stop() {
    if (this.timer !== null) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    this.generation += 1;
    this.deleteBatch.cancel?.();
    return this.activeCleanup ?? Promise.resolve();
  }
}

module.exports = RetentionCleaner;
