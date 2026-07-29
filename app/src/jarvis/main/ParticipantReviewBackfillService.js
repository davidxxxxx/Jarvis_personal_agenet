const DEFAULT_SCOPE = "recent_audio";
const VALID_SCOPES = new Set([
  "recent_audio",
  "all_retained_audio",
  "metadata_cleanup",
]);

class ParticipantReviewBackfillService {
  constructor({
    repository,
    now = Date.now,
    limit = 4,
    log = () => {},
    yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {}) {
    for (const method of [
      "beginParticipantReviewBackfillBatch",
      "getLatestParticipantSnapshot",
      "refreshSessionParticipantSnapshot",
      "recordParticipantReviewBackfillProgress",
      "finishParticipantReviewBackfillBatch",
    ]) {
      if (typeof repository?.[method] !== "function") {
        throw new TypeError(`repository.${method} is required`);
      }
    }
    if (typeof now !== "function" || typeof log !== "function") {
      throw new TypeError("participant review backfill dependencies are invalid");
    }
    if (typeof yieldControl !== "function") {
      throw new TypeError("yieldControl must be a function");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("participant review backfill limit must be between 1 and 100");
    }

    this.repository = repository;
    this.now = now;
    this.limit = limit;
    this.log = log;
    this.yieldControl = yieldControl;
    this.stopping = false;
    this.inFlight = null;
  }

  runOnce({ scope = DEFAULT_SCOPE } = {}) {
    if (!VALID_SCOPES.has(scope)) {
      return Promise.reject(new RangeError("participant review backfill scope is invalid"));
    }
    if (this.inFlight) return this.inFlight;
    this.stopping = false;
    this.inFlight = this._runOnce(scope).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stop() {
    this.stopping = true;
    return this.inFlight ?? Promise.resolve();
  }

  async _runOnce(scope) {
    const at = this.now();
    const batch = this.repository.beginParticipantReviewBackfillBatch({
      scope,
      limit: this.limit,
      at,
    });
    const result = {
      batchId: batch.id,
      scope: batch.scope,
      inspected: batch.sessionIds.length,
      processed: 0,
      changed: 0,
      failed: 0,
      state: "completed",
    };

    for (const sessionId of batch.sessionIds) {
      if (this.stopping) {
        result.state = "cancelled";
        break;
      }
      await this.yieldControl();
      if (this.stopping) {
        result.state = "cancelled";
        break;
      }

      let changed = false;
      let errorCode = null;
      try {
        const before = this.repository.getLatestParticipantSnapshot(sessionId);
        const after = this.repository.refreshSessionParticipantSnapshot(sessionId, { at });
        changed = before?.sourceHash !== after?.sourceHash;
        if (changed) result.changed += 1;
      } catch (error) {
        errorCode = "participant_snapshot_failed";
        result.failed += 1;
        this.log({
          phase: "participant_review_backfill",
          batchId: batch.id,
          sessionId,
          error,
        });
      }
      this.repository.recordParticipantReviewBackfillProgress(batch.id, {
        changed,
        errorCode,
      });
      result.processed += 1;
    }

    if (result.state !== "cancelled" && result.failed > 0) {
      result.state = "failed";
    }
    this.repository.finishParticipantReviewBackfillBatch(batch.id, {
      state: result.state,
      errorCode:
        result.state === "cancelled"
          ? "shutdown"
          : result.failed > 0
            ? "participant_snapshot_failed"
            : null,
      at: this.now(),
    });
    return Object.freeze(result);
  }
}

module.exports = ParticipantReviewBackfillService;
