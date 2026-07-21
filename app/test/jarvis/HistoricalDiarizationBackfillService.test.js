const assert = require("node:assert/strict");
const test = require("node:test");
const HistoricalDiarizationBackfillService = require("../../src/jarvis/main/HistoricalDiarizationBackfillService");
const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");

test("historical backfill queues newest retained sessions through the local-only repository path", () => {
  const calls = [];
  const policy = { evaluate() {} };
  const service = new HistoricalDiarizationBackfillService({
    repository: {
      listHistoricalHybridCandidates(input) {
        calls.push(["list", input]);
        return [{ id: "newest" }, { id: "older" }];
      },
      enqueueHistoricalHybridReprocessing(sessionId, input) {
        calls.push(["queue", sessionId, input]);
        return sessionId === "newest"
          ? { enqueued: 2, skipped: [] }
          : { enqueued: 1, skipped: [{ trackId: "expired" }] };
      },
    },
    speakerProcessingPolicy: policy,
    now: () => 7000,
  });

  assert.deepEqual(service.runOnce(), {
    inspected: 2,
    sessionsQueued: 2,
    jobsQueued: 3,
    skippedTracks: 1,
  });
  assert.equal(calls[0][1].policy, HYBRID_DIARIZATION_POLICY);
  assert.equal(calls[1][2].speakerProcessingPolicy, policy);
  assert.deepEqual(
    calls.slice(1).map((call) => call[1]),
    ["newest", "older"]
  );
});

test("historical backfill isolates one damaged session and continues", () => {
  const failures = [];
  const service = new HistoricalDiarizationBackfillService({
    repository: {
      listHistoricalHybridCandidates: () => [{ id: "broken" }, { id: "healthy" }],
      enqueueHistoricalHybridReprocessing(sessionId) {
        if (sessionId === "broken") throw new Error("damaged history");
        return { enqueued: 1, skipped: [] };
      },
    },
    speakerProcessingPolicy: { evaluate() {} },
    log: (entry) => failures.push(entry),
  });

  assert.equal(service.runOnce().jobsQueued, 1);
  assert.equal(failures[0].sessionId, "broken");
});
