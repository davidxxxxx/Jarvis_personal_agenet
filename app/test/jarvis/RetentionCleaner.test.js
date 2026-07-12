const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");

function repositoryWith(rows) {
  const tombstoned = [];
  const promoted = [];
  return {
    tombstoned,
    promoted,
    listExpiredAudioChunks: () => rows,
    promoteSoonExpiringAudioJobs: (after, before) => {
      promoted.push({ after, before });
      return 0;
    },
    tombstoneChunk: (id, deletedAt) => {
      tombstoned.push({ id, deletedAt });
      return { changes: 1, jobsTerminated: 0 };
    },
  };
}

test("deletes hundreds of expired bytes through one async batch and tombstones confirmed rows", async () => {
  const rows = Array.from({ length: 240 }, (_, index) => ({
    id: `chunk-${index}`,
    path: `recording-${index}.wav`,
  }));
  const repository = repositoryWith(rows);
  const calls = [];
  const deleteBatch = async (root, paths) => {
    calls.push({ root, paths });
    return paths.map((_, index) => {
      if (index % 4 === 0) return { status: "deleted", code: "deleted" };
      if (index % 4 === 1) return { status: "missing", code: "file_not_found" };
      if (index % 4 === 2) return { status: "retry", code: "sharing_violation" };
      return { status: "outside", code: "handle_outside_root" };
    });
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch,
  });

  assert.deepEqual(await cleaner.clean(5_000), { deleted: 60, missing: 60, retry: 120 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paths.length, 240);
  assert.equal(repository.tombstoned.length, 120);
  assert.deepEqual(repository.tombstoned[0], { id: "chunk-0", deletedAt: 5_000 });
  assert.deepEqual(repository.promoted, [
    { after: 5_000, before: 5_000 + RetentionCleaner.URGENT_WINDOW_MS },
  ]);
});

test("overlapping cleanup requests share one invocation", async () => {
  const repository = repositoryWith([{ id: "one", path: "one.wav" }]);
  let release;
  let invocations = 0;
  const deleteBatch = () => {
    invocations += 1;
    return new Promise((resolve) => {
      release = () => resolve([{ status: "deleted", code: "deleted" }]);
    });
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch,
  });

  const first = cleaner.clean(5_000);
  const second = cleaner.clean(6_000);
  assert.equal(first, second);
  assert.equal(invocations, 1);
  release();
  assert.deepEqual(await first, { deleted: 1, missing: 0, retry: 0 });
});

test("shutdown cancels an active helper and prevents late repository writes", async () => {
  const repository = repositoryWith([{ id: "one", path: "one.wav" }]);
  let release;
  let cancelled = 0;
  const deleteBatch = () =>
    new Promise((resolve) => {
      release = () => resolve([{ status: "deleted", code: "deleted" }]);
    });
  deleteBatch.cancel = () => {
    cancelled += 1;
    release();
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch,
  });

  const cleaning = cleaner.clean(5_000);
  await cleaner.stop();
  assert.equal(cancelled, 1);
  assert.deepEqual(await cleaning, { deleted: 0, missing: 0, retry: 1 });
  assert.deepEqual(repository.tombstoned, []);
});

test("missing results tombstone metadata while unsafe and failed rows remain", async () => {
  const rows = [
    { id: "missing", path: "missing.wav" },
    { id: "outside", path: "outside.wav" },
    { id: "retry", path: "retry.wav" },
  ];
  const repository = repositoryWith(rows);
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings-does-not-exist"),
    deleteBatch: async () => [
      { status: "missing", code: "root_not_found" },
      { status: "outside", code: "handle_outside_root" },
      { status: "retry", code: "sharing_violation" },
    ],
  });

  assert.deepEqual(await cleaner.clean(5_000), { deleted: 0, missing: 1, retry: 2 });
  assert.deepEqual(repository.tombstoned, [{ id: "missing", deletedAt: 5_000 }]);
});

test("promotes the exact 24-hour pre-expiry window even when no bytes are expired", async () => {
  const repository = repositoryWith([]);
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => {
      throw new Error("must not delete without expired chunks");
    },
  });

  assert.deepEqual(await cleaner.clean(10_000), { deleted: 0, missing: 0, retry: 0 });
  assert.deepEqual(repository.promoted, [{ after: 10_000, before: 10_000 + 24 * 60 * 60 * 1000 }]);
});

test("retention cleanup asks the shared reader to remove proven stale leases", async () => {
  const repository = repositoryWith([]);
  repository.getAudioChunk = (id) => ({ id });
  const calls = [];
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => [],
    temporaryEvidenceCleaner: {
      async cleanupStaleTemporaryEvidence({ getChunk }) {
        calls.push(getChunk("c1"));
        return 1;
      },
    },
  });

  await cleaner.clean(10_000);

  assert.deepEqual(calls, [{ id: "c1" }]);
});

test("temporary evidence cleanup failure is isolated and reported without private details", async () => {
  const logs = [];
  const repository = repositoryWith([{ id: "expired", path: "private-recording.wav" }]);
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => [{ status: "deleted", code: "deleted" }],
    temporaryEvidenceCleaner: {
      async cleanupStaleTemporaryEvidence() {
        throw new Error("C:\\Users\\private\\secret-lease.wav");
      },
    },
    log: (entry) => logs.push(entry),
  });

  assert.deepEqual(await cleaner.clean(15_000), { deleted: 1, missing: 0, retry: 0 });
  assert.deepEqual(repository.tombstoned, [{ id: "expired", deletedAt: 15_000 }]);
  assert.deepEqual(logs, [
    { deleted: 1, missing: 0, retry: 0, temporaryEvidenceFailures: 1 },
  ]);
  assert.equal(JSON.stringify(logs).includes("private"), false);
});

test("surfaces metadata transaction failures without claiming successful cleanup", async () => {
  const logs = [];
  const repository = repositoryWith([
    { id: "db-fails", path: "db-fails.flac" },
    { id: "succeeds", path: "succeeds.wav" },
  ]);
  repository.tombstoneChunk = (id, deletedAt) => {
    if (id === "db-fails") throw new Error("database unavailable");
    repository.tombstoned.push({ id, deletedAt });
    return { changes: 1, jobsTerminated: 1 };
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => [
      { status: "deleted", code: "deleted" },
      { status: "missing", code: "file_not_found" },
    ],
    log: (counts) => logs.push(counts),
  });

  await assert.rejects(cleaner.clean(20_000), /retention metadata cleanup failed/);
  assert.deepEqual(repository.tombstoned, [{ id: "succeeds", deletedAt: 20_000 }]);
  assert.deepEqual(logs, [{ deleted: 0, missing: 1, retry: 1, metadataFailures: 1 }]);
});

test("surfaces and safely logs urgency query failures before touching audio", async () => {
  const logs = [];
  const repository = repositoryWith([{ id: "untouched", path: "untouched.wav" }]);
  repository.promoteSoonExpiringAudioJobs = () => {
    throw new Error("database unavailable");
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => {
      throw new Error("audio deletion must not start");
    },
    log: (counts) => logs.push(counts),
  });

  await assert.rejects(cleaner.clean(30_000), /retention metadata preparation failed/);
  assert.deepEqual(logs, [{ deleted: 0, missing: 0, retry: 1, metadataFailures: 1 }]);
  assert.deepEqual(repository.tombstoned, []);
});

test("timer start is idempotent, contains async errors, stops, and ignores late callbacks", async () => {
  let intervalCallback;
  const intervals = [];
  const cleared = [];
  const logs = [];
  const cleaner = new RetentionCleaner({
    repository: {
      listExpiredAudioChunks: () => {
        throw new Error("database unavailable");
      },
      promoteSoonExpiringAudioJobs() {},
      tombstoneChunk() {},
    },
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => [],
    setIntervalImpl: (callback, intervalMs) => {
      intervalCallback = callback;
      const timer = {
        intervalMs,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
    log: (result) => logs.push(result),
  });

  cleaner.start(123);
  cleaner.start(456);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].unrefCalled, true);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs.at(-1), { deleted: 0, retry: 1, missing: 0 });

  await cleaner.stop();
  assert.deepEqual(cleared, intervals);
  const logCount = logs.length;
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, logCount);
});
