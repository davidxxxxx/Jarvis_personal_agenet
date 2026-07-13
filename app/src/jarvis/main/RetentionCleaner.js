const path = require("node:path");
const { createSafeRecordingDelete } = require("./SafeRecordingDelete");

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;

class RetentionCleaner {
  constructor({
    repository,
    recordingsRoot,
    deleteBatch = createSafeRecordingDelete(),
    artifactCleaner = null,
    temporaryEvidenceCleaner = null,
    now = Date.now,
    log = () => {},
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    if (!repository || typeof repository.listExpiredAudioChunks !== "function") {
      throw new TypeError("repository.listExpiredAudioChunks must be a function");
    }
    if (typeof repository.promoteSoonExpiringAudioJobs !== "function") {
      throw new TypeError("repository.promoteSoonExpiringAudioJobs must be a function");
    }
    if (typeof repository.tombstoneChunk !== "function") {
      throw new TypeError("repository.tombstoneChunk must be a function");
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
    this.artifactCleaner = artifactCleaner;
    this.temporaryEvidenceCleaner = temporaryEvidenceCleaner;
    this.now = now;
    this.log = log;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.timer = null;
    this.activeCleanup = null;
    this.generation = 0;
  }

  setRecordingsRoot(recordingsRoot) {
    if (typeof recordingsRoot !== "string" || !path.isAbsolute(recordingsRoot)) {
      throw new TypeError("recordingsRoot must be absolute");
    }
    this.recordingsRoot = path.resolve(recordingsRoot);
  }

  reconfigureStorage({ recordingsRoot, artifactCleaner, temporaryEvidenceCleaner }) {
    this.setRecordingsRoot(recordingsRoot);
    this.artifactCleaner = artifactCleaner ?? null;
    this.temporaryEvidenceCleaner = temporaryEvidenceCleaner ?? null;
  }

  clean(at = this.now()) {
    if (this.activeCleanup) return this.activeCleanup;
    const generation = this.generation;
    const run = async () => {
      const counts = { deleted: 0, retry: 0, missing: 0 };
      let temporaryEvidenceFailures = 0;
      let retiredArtifactRemoved = 0;
      let retiredArtifactRetry = 0;
      let retiredArtifactMaintenanceFailures = 0;
      const report = (extra = {}) => ({
        ...counts,
        ...extra,
        ...(temporaryEvidenceFailures > 0 ? { temporaryEvidenceFailures } : {}),
        ...(retiredArtifactRemoved > 0 ? { retiredArtifactRemoved } : {}),
        ...(retiredArtifactRetry > 0 ? { retiredArtifactRetry } : {}),
        ...(retiredArtifactMaintenanceFailures > 0
          ? { retiredArtifactMaintenanceFailures }
          : {}),
      });
      let expired;
      if (typeof this.temporaryEvidenceCleaner?.cleanupStaleTemporaryEvidence === "function") {
        try {
          await this.temporaryEvidenceCleaner.cleanupStaleTemporaryEvidence({
            getChunk: (id) => this.repository.getAudioChunk?.(id) ?? null,
          });
        } catch {
          temporaryEvidenceFailures = 1;
        }
      }
      if (typeof this.artifactCleaner?.runMaintenance === "function") {
        try {
          const maintenance = await this.artifactCleaner.runMaintenance(at);
          retiredArtifactRemoved += maintenance?.removed ?? 0;
          retiredArtifactRetry += maintenance?.retry ?? 0;
        } catch {
          retiredArtifactMaintenanceFailures = 1;
        }
      }
      try {
        this.repository.promoteSoonExpiringAudioJobs(at, at + URGENT_WINDOW_MS);
        expired = this.repository.listExpiredAudioChunks(at);
      } catch (error) {
        this.log(report({ retry: 1, metadataFailures: 1 }));
        throw new AggregateError([error], "retention metadata preparation failed");
      }
      if (expired.length === 0) {
        this.log(report());
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
      const metadataErrors = [];
      for (let index = 0; index < expired.length; index += 1) {
        const result = results[index] ?? { status: "retry" };
        if (result.status === "deleted" || result.status === "missing") {
          try {
            this.repository.tombstoneChunk(expired[index].id, at, {
              storageDeleted: true,
            });
            counts[result.status] += 1;
          } catch (error) {
            counts.retry += 1;
            metadataErrors.push(error);
            continue;
          }
          if (typeof this.artifactCleaner?.cleanupRetiredChunk === "function") {
            try {
              retiredArtifactRemoved +=
                (await this.artifactCleaner.cleanupRetiredChunk(expired[index], at)) ?? 0;
            } catch {
              retiredArtifactRetry += 1;
            }
          }
        } else {
          counts.retry += 1;
        }
      }
      this.log(
        metadataErrors.length > 0
          ? report({ metadataFailures: metadataErrors.length })
          : report()
      );
      if (metadataErrors.length > 0) {
        throw new AggregateError(metadataErrors, "retention metadata cleanup failed");
      }
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
RetentionCleaner.URGENT_WINDOW_MS = URGENT_WINDOW_MS;
