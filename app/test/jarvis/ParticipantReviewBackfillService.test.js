const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ParticipantReviewBackfillService = require("../../src/jarvis/main/ParticipantReviewBackfillService");

test("participant review backfill is bounded, yields between sessions, and records progress", async () => {
  const calls = [];
  const snapshots = new Map();
  const service = new ParticipantReviewBackfillService({
    repository: {
      beginParticipantReviewBackfillBatch(input) {
        calls.push(["begin", input]);
        return {
          id: "batch-1",
          scope: input.scope,
          sessionIds: ["newest", "older"],
        };
      },
      getLatestParticipantSnapshot(sessionId) {
        return snapshots.get(sessionId) ?? null;
      },
      refreshSessionParticipantSnapshot(sessionId) {
        calls.push(["refresh", sessionId]);
        const snapshot = { sourceHash: `hash-${sessionId}` };
        snapshots.set(sessionId, snapshot);
        return snapshot;
      },
      recordParticipantReviewBackfillProgress(batchId, input) {
        calls.push(["progress", batchId, input]);
      },
      finishParticipantReviewBackfillBatch(batchId, input) {
        calls.push(["finish", batchId, input]);
        return { id: batchId, state: input.state };
      },
    },
    now: () => 7_000,
    limit: 2,
    yieldControl: async () => calls.push(["yield"]),
  });

  assert.deepEqual(await service.runOnce({ scope: "recent_audio" }), {
    batchId: "batch-1",
    scope: "recent_audio",
    inspected: 2,
    processed: 2,
    changed: 2,
    failed: 0,
    state: "completed",
  });
  assert.deepEqual(calls[0], [
    "begin",
    { scope: "recent_audio", limit: 2, at: 7_000 },
  ]);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "refresh").map(([, sessionId]) => sessionId),
    ["newest", "older"]
  );
  assert.equal(calls.filter(([kind]) => kind === "yield").length, 2);
  assert.deepEqual(calls.at(-1), [
    "finish",
    "batch-1",
    { state: "completed", errorCode: null, at: 7_000 },
  ]);
});

test("participant review backfill isolates a damaged session and does not loop inside a batch", async () => {
  const progress = [];
  const failures = [];
  const service = new ParticipantReviewBackfillService({
    repository: {
      beginParticipantReviewBackfillBatch: () => ({
        id: "batch-2",
        scope: "recent_audio",
        sessionIds: ["broken", "healthy"],
      }),
      getLatestParticipantSnapshot: () => null,
      refreshSessionParticipantSnapshot(sessionId) {
        if (sessionId === "broken") throw new Error("damaged historical identity");
        return { sourceHash: "healthy-hash" };
      },
      recordParticipantReviewBackfillProgress(_batchId, input) {
        progress.push(input);
      },
      finishParticipantReviewBackfillBatch(batchId, input) {
        return { id: batchId, state: input.state };
      },
    },
    log: (entry) => failures.push(entry),
    yieldControl: async () => {},
  });

  const result = await service.runOnce();
  assert.deepEqual(result, {
    batchId: "batch-2",
    scope: "recent_audio",
    inspected: 2,
    processed: 2,
    changed: 1,
    failed: 1,
    state: "failed",
  });
  assert.deepEqual(progress, [
    { changed: false, errorCode: "participant_snapshot_failed" },
    { changed: true, errorCode: null },
  ]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sessionId, "broken");
});

test("participant review backfill can be cancelled cleanly before the next session", async () => {
  const progress = [];
  let service;
  service = new ParticipantReviewBackfillService({
    repository: {
      beginParticipantReviewBackfillBatch: () => ({
        id: "batch-3",
        scope: "metadata_cleanup",
        sessionIds: ["one", "two"],
      }),
      getLatestParticipantSnapshot: () => null,
      refreshSessionParticipantSnapshot: () => ({ sourceHash: "one-hash" }),
      recordParticipantReviewBackfillProgress(_batchId, input) {
        progress.push(input);
      },
      finishParticipantReviewBackfillBatch(batchId, input) {
        return { id: batchId, state: input.state };
      },
    },
    yieldControl: async () => {
      if (progress.length === 1) void service.stop();
    },
  });

  const result = await service.runOnce({ scope: "metadata_cleanup" });
  assert.equal(result.state, "cancelled");
  assert.equal(result.processed, 1);
});

test("desktop startup schedules participant backfill only after the visible windows", () => {
  const mainSource = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "main.js"),
    "utf8"
  );
  const windowIndex = mainSource.indexOf("await windowManager.createMainWindow();");
  const scheduleIndex = mainSource.indexOf(
    "scheduleParticipantReviewBackfill();",
    windowIndex
  );
  assert.ok(mainSource.includes('require("./src/jarvis/main/ParticipantReviewBackfillService")'));
  assert.ok(windowIndex >= 0);
  assert.ok(scheduleIndex > windowIndex);
  assert.ok(mainSource.includes("await service?.stop();"));
});
