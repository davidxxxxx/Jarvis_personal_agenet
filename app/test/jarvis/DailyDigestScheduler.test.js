const test = require("node:test");
const assert = require("node:assert/strict");
const DailyDigestScheduler = require("../../src/jarvis/main/DailyDigestScheduler");

function harness({
  at = Date.UTC(2026, 6, 17, 4),
  timezone = "Asia/Shanghai",
  maxCatchupDays = 2,
  sessions = new Map(),
} = {}) {
  let now = at;
  let zone = timezone;
  const calls = [];
  const service = {
    async prepare(input) {
      calls.push(["prepare", input]);
      return { status: "prepared", localDate: input.localDate };
    },
    getLatest(input) {
      calls.push(["latest", input]);
      return { localDate: input.localDate };
    },
    async regenerate(input) {
      calls.push(["regenerate", input]);
      return { status: "woken", localDate: input.localDate };
    },
  };
  const scheduler = new DailyDigestScheduler({
    service,
    repository: { getSession: (sessionId) => sessions.get(sessionId) ?? null },
    timezoneProvider: () => zone,
    now: () => now,
    maxCatchupDays,
    log(error) {
      calls.push(["log", error.code ?? error.message]);
    },
  });
  return {
    scheduler,
    service,
    calls,
    setNow(value) {
      now = value;
    },
    setTimezone(value) {
      zone = value;
    },
  };
}

test("scheduler requires durable service, repository, and trusted timezone", () => {
  assert.throws(() => new DailyDigestScheduler(), /service\.prepare/i);
  assert.throws(
    () => new DailyDigestScheduler({
      service: { prepare() {}, getLatest() {}, regenerate() {} },
      repository: {},
      timezoneProvider: () => "UTC",
    }),
    /repository\.getSession/i
  );
});

test("first start prepares only the immediately previous local day", async () => {
  const { scheduler, calls } = harness();
  const result = await scheduler.start();

  assert.deepEqual(result.map((item) => item.localDate), ["2026-07-16"]);
  assert.deepEqual(calls, [["prepare", { localDate: "2026-07-16" }]]);
  assert.equal(await scheduler.start(), result);
  assert.equal(calls.length, 1);
});

test("midnight and bounded sleep catch-up prepare completed days in order", async () => {
  const { scheduler, calls, setNow } = harness({ maxCatchupDays: 2 });
  await scheduler.start();
  calls.length = 0;
  setNow(Date.UTC(2026, 6, 20, 16)); // 2026-07-21 00:00 Shanghai

  assert.deepEqual(
    (await scheduler.tick()).map((item) => item.localDate),
    ["2026-07-17", "2026-07-18"]
  );
  assert.deepEqual(
    (await scheduler.tick()).map((item) => item.localDate),
    ["2026-07-19", "2026-07-20"]
  );
  assert.deepEqual(await scheduler.tick(), []);
});

test("DST catch-up uses actual local boundaries and never fixed 24-hour arithmetic", async () => {
  const { scheduler, calls, setNow } = harness({
    at: Date.UTC(2026, 2, 8, 8),
    timezone: "America/Los_Angeles",
    maxCatchupDays: 3,
  });
  await scheduler.start();
  calls.length = 0;
  setNow(Date.UTC(2026, 2, 9, 7)); // midnight after the 23-hour spring day

  assert.deepEqual(
    (await scheduler.tick()).map((item) => item.localDate),
    ["2026-03-08"]
  );
});

test("timezone change prepares only the new zone previous day", async () => {
  const { scheduler, calls, setTimezone } = harness();
  await scheduler.start();
  calls.length = 0;
  setTimezone("America/Los_Angeles");

  assert.deepEqual(
    (await scheduler.tick()).map((item) => item.localDate),
    ["2026-07-15"]
  );
});

test("session readiness prepares every intersecting day but not midnight end boundary", async () => {
  const sessions = new Map([
    ["cross", {
      id: "cross",
      status: "completed",
      processing_state: "ready",
      started_at: Date.UTC(2026, 6, 16, 15, 59),
      ended_at: Date.UTC(2026, 6, 17, 16),
    }],
  ]);
  const { scheduler, calls } = harness({ sessions });
  await scheduler.start();
  calls.length = 0;

  assert.deepEqual(
    (await scheduler.onSessionReady("cross")).map((item) => item.localDate),
    ["2026-07-16", "2026-07-17"]
  );
  assert.deepEqual(calls.map(([, input]) => input.localDate), ["2026-07-16", "2026-07-17"]);
});

test("non-ready and missing sessions do not prepare a digest", async () => {
  const sessions = new Map([
    ["active", {
      id: "active",
      status: "recording",
      processing_state: "pending",
      started_at: 1,
      ended_at: null,
    }],
  ]);
  const { scheduler, calls } = harness({ sessions });
  await scheduler.start();
  calls.length = 0;

  assert.deepEqual(await scheduler.onSessionReady("active"), []);
  assert.deepEqual(await scheduler.onSessionReady("missing"), []);
  assert.deepEqual(calls, []);
});

test("date reads and regeneration accept only a canonical trusted local date", async () => {
  const { scheduler, calls } = harness();
  await scheduler.start();
  assert.deepEqual(scheduler.getLatest({ localDate: "2026-07-17" }), {
    localDate: "2026-07-17",
  });
  assert.deepEqual(await scheduler.regenerate({ localDate: "2026-07-17" }), {
    status: "woken",
    localDate: "2026-07-17",
  });
  assert.equal(calls.at(-1)[0], "regenerate");
  assert.throws(() => scheduler.getLatest({ localDate: "2026-02-29" }), /localDate|local date/i);
  await assert.rejects(
    async () => scheduler.regenerate({ localDate: "2026-07-17", timezone: "UTC" }),
    /only localDate/i
  );
});

test("stop joins queued work, blocks later work, and permits a clean restart", async () => {
  const { scheduler, calls, setNow } = harness();
  await scheduler.start();
  setNow(Date.UTC(2026, 6, 17, 16));
  const tick = scheduler.tick();
  const stopped = scheduler.stop();
  assert.equal(scheduler.stop(), stopped);
  await Promise.all([tick, stopped]);
  const countAtStop = calls.length;
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(calls.length, countAtStop);

  await scheduler.start();
  assert.equal(calls.some(([, input]) => input?.localDate === "2026-07-17"), true);
  await scheduler.stop();
});

test("concurrent ticks serialize and durable prepare remains the convergence boundary", async () => {
  const { scheduler, calls, setNow } = harness();
  await scheduler.start();
  calls.length = 0;
  setNow(Date.UTC(2026, 6, 17, 16));

  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
  assert.deepEqual(calls, [["prepare", { localDate: "2026-07-17" }]]);
});
