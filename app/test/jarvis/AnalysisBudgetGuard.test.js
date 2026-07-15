const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const AnalysisBudgetGuard = require("../../src/jarvis/main/AnalysisBudgetGuard");
const { openAnalysisBudgetRepository } = require("../../src/jarvis/main/AnalysisBudgetRepository");

const REPOSITORY_METHODS = [
  "initialize",
  "getStatus",
  "setPolicy",
  "reserve",
  "markStarted",
  "reconcile",
  "release",
  "markUsageUnknown",
  "recover",
];

function fakeRepository(overrides = {}) {
  return Object.fromEntries(
    REPOSITORY_METHODS.map((method) => [method, overrides[method] ?? (() => ({ method }))])
  );
}

function reservation(overrides = {}) {
  return {
    requestId: "request-1",
    jobId: "job-1",
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    estimatedUsage: { inputTokens: 1, outputTokens: 1 },
    ...overrides,
  };
}

function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-budget-guard-"));
  const repository = openAnalysisBudgetRepository(path.join(directory, "jarvis.sqlite"));
  try {
    return run(repository);
  } finally {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("guard requires the complete repository contract and a valid injected clock", () => {
  for (const method of REPOSITORY_METHODS) {
    const repository = fakeRepository();
    delete repository[method];
    assert.throws(
      () => new AnalysisBudgetGuard({ repository, defaultTimezone: "Asia/Shanghai" }),
      new TypeError(`repository.${method} must be a function`)
    );
  }
  assert.throws(
    () =>
      new AnalysisBudgetGuard({
        repository: fakeRepository(),
        now: 1,
        defaultTimezone: "Asia/Shanghai",
      }),
    /now must be a function/
  );
  assert.throws(
    () =>
      new AnalysisBudgetGuard({
        repository: fakeRepository(),
        defaultTimezone: "Asia/Calcutta",
      }),
    /canonical IANA/
  );
});

test("guard owns timestamps and delegates the complete lifecycle without exposing cost inputs", () => {
  let now = Date.UTC(2026, 6, 15, 4);
  const calls = [];
  const repository = fakeRepository(
    Object.fromEntries(
      REPOSITORY_METHODS.map((method) => [
        method,
        (input) => {
          calls.push([method, input]);
          return { method, input };
        },
      ])
    )
  );
  const guard = new AnalysisBudgetGuard({
    repository,
    now: () => now,
    defaultTimezone: "Asia/Shanghai",
  });

  guard.initialize();
  now += 1;
  guard.getStatus();
  now += 1;
  guard.getStatus({ at: 123 });
  now += 1;
  guard.setPolicy({ monthlyLimitMicrousd: 10_000_000, timezone: "UTC" });
  now += 1;
  guard.reserve(reservation());
  now += 1;
  guard.markStarted("request-1");
  now += 1;
  guard.reconcile({
    requestId: "request-1",
    usage: { inputTokens: 2, outputTokens: 3 },
  });
  now += 1;
  guard.release({ requestId: "request-1", reasonCode: "local_preflight_failed" });
  now += 1;
  guard.markUsageUnknown({ requestId: "request-1", reasonCode: "usage_missing" });
  now += 1;
  guard.recoverIncompleteAttempts();

  assert.deepEqual(calls, [
    [
      "initialize",
      {
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at: Date.UTC(2026, 6, 15, 4),
      },
    ],
    ["getStatus", { at: Date.UTC(2026, 6, 15, 4) + 1 }],
    ["getStatus", { at: 123 }],
    [
      "setPolicy",
      {
        monthlyLimitMicrousd: 10_000_000,
        timezone: "UTC",
        at: Date.UTC(2026, 6, 15, 4) + 3,
      },
    ],
    ["reserve", { ...reservation(), at: Date.UTC(2026, 6, 15, 4) + 4 }],
    ["markStarted", { requestId: "request-1", at: Date.UTC(2026, 6, 15, 4) + 5 }],
    [
      "reconcile",
      {
        requestId: "request-1",
        usage: { inputTokens: 2, outputTokens: 3 },
        at: Date.UTC(2026, 6, 15, 4) + 6,
      },
    ],
    [
      "release",
      {
        requestId: "request-1",
        reasonCode: "local_preflight_failed",
        at: Date.UTC(2026, 6, 15, 4) + 7,
      },
    ],
    [
      "markUsageUnknown",
      {
        requestId: "request-1",
        reasonCode: "usage_missing",
        at: Date.UTC(2026, 6, 15, 4) + 8,
      },
    ],
    ["recover", { at: Date.UTC(2026, 6, 15, 4) + 9 }],
  ]);
});

test("guard rejects malformed, extra, and unsafe public inputs before repository mutation", () => {
  let calls = 0;
  const repository = fakeRepository(
    Object.fromEntries(REPOSITORY_METHODS.map((method) => [method, () => (calls += 1)]))
  );
  const guard = new AnalysisBudgetGuard({
    repository,
    now: () => 100,
    defaultTimezone: "Asia/Shanghai",
  });
  const invalidCalls = [
    () => guard.getStatus({ at: 1, extra: true }),
    () => guard.setPolicy({ monthlyLimitMicrousd: -1, timezone: "UTC" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 10_000_001, timezone: "UTC" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1.5, timezone: "UTC" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1, timezone: "Asia/Calcutta" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1, timezone: "UTC", extra: true }),
    () => guard.reserve({ ...reservation(), requestId: "" }),
    () => guard.reserve({ ...reservation(), jobId: "contains spaces" }),
    () => guard.reserve({ ...reservation(), attemptNumber: 0 }),
    () => guard.reserve({ ...reservation(), provider: " minimax" }),
    () => guard.reserve({ ...reservation(), model: "" }),
    () => guard.reserve({ ...reservation(), operation: "incremental_analysis" }),
    () => guard.reserve({ ...reservation(), estimatedUsage: { inputTokens: -1, outputTokens: 1 } }),
    () =>
      guard.reserve({
        ...reservation(),
        estimatedUsage: { inputTokens: 1, outputTokens: 1, usd: 1 },
      }),
    () => guard.reserve({ ...reservation(), estimatedUsd: 1 }),
    () => guard.markStarted("bad id"),
    () => guard.reconcile({ requestId: "request-1", usage: { inputTokens: 1.1, outputTokens: 1 } }),
    () =>
      guard.reconcile({
        requestId: "request-1",
        usage: { inputTokens: 1, outputTokens: 1 },
        actualUsd: 1,
      }),
    () => guard.release({ requestId: "request-1", reasonCode: "usage_missing" }),
    () => guard.markUsageUnknown({ requestId: "request-1", reasonCode: "local_preflight_failed" }),
    () => guard.recoverIncompleteAttempts({ at: -1 }),
  ];

  for (const call of invalidCalls) assert.throws(call, TypeError);
  assert.equal(calls, 0);
});

test("guard integrates default, zero, and ten-dollar policies with durable transitions", () => {
  withRepository((repository) => {
    let now = Date.UTC(2026, 6, 15, 4);
    const guard = new AnalysisBudgetGuard({
      repository,
      now: () => now,
      defaultTimezone: "Asia/Shanghai",
    });
    assert.equal(guard.initialize().monthlyLimitMicrousd, 5_000_000);
    assert.equal(
      guard.setPolicy({ monthlyLimitMicrousd: 0, timezone: "Asia/Shanghai" }).blockedReason,
      "budget_exceeded"
    );
    assert.deepEqual(guard.reserve(reservation()), {
      ok: false,
      reason: "budget_exceeded",
    });
    now += 1;
    guard.setPolicy({ monthlyLimitMicrousd: 10_000_000, timezone: "Asia/Shanghai" });
    const reserved = guard.reserve(reservation());
    assert.equal(reserved.ok, true);
    now += 1;
    guard.markStarted("request-1");
    now += 1;
    guard.reconcile({
      requestId: "request-1",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(guard.getStatus().spentMicrousd, 3);
    assert.deepEqual(guard.recoverIncompleteAttempts(), {
      releasedCount: 0,
      usageUnknownCount: 0,
    });
  });
});
