const { HYBRID_DIARIZATION_POLICY } = require("./HybridDiarizationPolicy");

class HistoricalDiarizationBackfillService {
  constructor({
    repository,
    speakerProcessingPolicy,
    policy = HYBRID_DIARIZATION_POLICY,
    now = Date.now,
    limit = 25,
    log = () => {},
  } = {}) {
    for (const method of [
      "listHistoricalHybridCandidates",
      "enqueueHistoricalHybridReprocessing",
    ]) {
      if (typeof repository?.[method] !== "function") {
        throw new TypeError(`repository.${method} is required`);
      }
    }
    if (!speakerProcessingPolicy || typeof speakerProcessingPolicy.evaluate !== "function") {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    if (!policy || policy.inputVersion !== 2 || typeof policy.policyId !== "string") {
      throw new TypeError("the v2 hybrid diarization policy is required");
    }
    if (typeof now !== "function" || typeof log !== "function") {
      throw new TypeError("historical backfill dependencies are invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("historical backfill limit must be between 1 and 100");
    }
    this.repository = repository;
    this.speakerProcessingPolicy = speakerProcessingPolicy;
    this.policy = policy;
    this.now = now;
    this.limit = limit;
    this.log = log;
  }

  runOnce() {
    const at = this.now();
    const candidates = this.repository.listHistoricalHybridCandidates({
      at,
      policy: this.policy,
      limit: this.limit,
    });
    const result = {
      inspected: candidates.length,
      sessionsQueued: 0,
      jobsQueued: 0,
      skippedTracks: 0,
    };
    for (const session of candidates) {
      try {
        const queued = this.repository.enqueueHistoricalHybridReprocessing(session.id, {
          at,
          policy: this.policy,
          speakerProcessingPolicy: this.speakerProcessingPolicy,
        });
        if (queued.enqueued > 0) result.sessionsQueued += 1;
        result.jobsQueued += queued.enqueued;
        result.skippedTracks += queued.skipped.length;
      } catch (error) {
        this.log({ phase: "historical_diarization_backfill", sessionId: session.id, error });
      }
    }
    return Object.freeze(result);
  }
}

module.exports = HistoricalDiarizationBackfillService;
