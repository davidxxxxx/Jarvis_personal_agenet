const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");

function repositoryWith(rows) {
  const deleted = [];
  return {
    deleted,
    listExpiredAudioChunks: () => rows,
    deleteAudioChunk: (id) => deleted.push(id),
  };
}

test("deletes hundreds of expired rows through one async batch with mixed results", async () => {
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
  assert.equal(repository.deleted.length, 120);
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
  assert.deepEqual(repository.deleted, []);
});

test("missing results remove metadata while unsafe and failed rows remain", async () => {
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
  assert.deepEqual(repository.deleted, ["missing"]);
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
      deleteAudioChunk() {},
    },
    recordingsRoot: path.resolve("recordings"),
    deleteBatch: async () => [],
    setIntervalImpl: (callback, intervalMs) => {
      intervalCallback = callback;
      const timer = { intervalMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
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
