const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const AnalysisBudgetGuard = require("../../src/jarvis/main/AnalysisBudgetGuard");
const { openAnalysisBudgetRepository } = require("../../src/jarvis/main/AnalysisBudgetRepository");

const LEGACY_REPOSITORY_METHODS = [
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
const OPTIONAL_REPOSITORY_METHODS = [
  "reserveNextAttempt",
  "getAttemptDispositionByRequestId",
  "listAttemptDispositionsByJob",
  "listStartupRecoveryDispositions",
];
const REPOSITORY_METHODS = [...LEGACY_REPOSITORY_METHODS, ...OPTIONAL_REPOSITORY_METHODS];

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

function nextReservation(overrides = {}) {
  const { attemptNumber: _attemptNumber, ...input } = reservation(overrides);
  return input;
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
  for (const method of LEGACY_REPOSITORY_METHODS) {
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

test("guard preserves legacy repository adapters and fails closed only when new capabilities run", () => {
  const repository = fakeRepository();
  for (const method of OPTIONAL_REPOSITORY_METHODS) delete repository[method];
  const guard = new AnalysisBudgetGuard({
    repository,
    now: () => 100,
    defaultTimezone: "Asia/Shanghai",
  });

  assert.equal(guard.reserve(reservation()).method, "reserve");
  const missingCapabilities = [
    ["reserveNextAttempt", () => guard.reserveNextAttempt(nextReservation())],
    ["getAttemptDispositionByRequestId", () => guard.getAttemptDispositionByRequestId("request-1")],
    [
      "listAttemptDispositionsByJob",
      () =>
        guard.listAttemptDispositionsByJob({
          jobId: "job-1",
          provider: "minimax",
          operation: "session_analysis",
        }),
    ],
    ["listStartupRecoveryDispositions", () => guard.listStartupRecoveryDispositions()],
  ];
  for (const [method, call] of missingCapabilities) {
    assert.throws(call, new TypeError(`repository.${method} must be a function`));
  }
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
  now += 1;
  guard.reserveNextAttempt(nextReservation({ requestId: "request-2" }));
  guard.getAttemptDispositionByRequestId("request-2");
  guard.listAttemptDispositionsByJob({
    jobId: "job-1",
    provider: "minimax",
    operation: "session_analysis",
  });
  guard.listStartupRecoveryDispositions();

  assert.deepEqual(calls, [
    [
      "initialize",
      {
        mode: "capped",
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
        mode: "capped",
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
    [
      "reserveNextAttempt",
      {
        ...nextReservation({ requestId: "request-2" }),
        at: Date.UTC(2026, 6, 15, 4) + 10,
      },
    ],
    ["getAttemptDispositionByRequestId", "request-2"],
    [
      "listAttemptDispositionsByJob",
      {
        jobId: "job-1",
        provider: "minimax",
        operation: "session_analysis",
      },
    ],
    ["listStartupRecoveryDispositions", undefined],
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
    () => guard.setPolicy({ monthlyLimitMicrousd: 1_000_000_000_001, timezone: "UTC" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1.5, timezone: "UTC" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1, timezone: "Asia/Calcutta" }),
    () => guard.setPolicy({ monthlyLimitMicrousd: 1, timezone: "UTC", extra: true }),
    () =>
      guard.setPolicy({
        mode: "forever",
        monthlyLimitMicrousd: 1,
        timezone: "UTC",
      }),
    () =>
      guard.setPolicy({
        mode: "capped",
        monthlyLimitMicrousd: 1_000_000_000_001,
        timezone: "UTC",
      }),
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
    () => guard.reserveNextAttempt({ ...nextReservation(), attemptNumber: 1 }),
    () => guard.reserveNextAttempt({ ...nextReservation(), requestId: "" }),
    () => guard.reserveNextAttempt({ ...nextReservation(), operation: "incremental_analysis" }),
    () => guard.getAttemptDispositionByRequestId("bad id"),
    () => guard.listAttemptDispositionsByJob({ jobId: "job-1", provider: "minimax" }),
    () =>
      guard.listAttemptDispositionsByJob({
        jobId: "job-1",
        provider: "minimax",
        operation: "session_analysis",
        extra: true,
      }),
    () => guard.listStartupRecoveryDispositions({ extra: true }),
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

test("guard forwards explicit capped and unlimited policy modes", () => {
  const calls = [];
  const guard = new AnalysisBudgetGuard({
    repository: fakeRepository({
      setPolicy(input) {
        calls.push(input);
        return input;
      },
    }),
    now: () => 100,
    defaultTimezone: "Asia/Shanghai",
  });

  guard.setPolicy({
    mode: "capped",
    monthlyLimitMicrousd: 200_000_000,
    timezone: "UTC",
  });
  guard.setPolicy({
    mode: "unlimited",
    monthlyLimitMicrousd: 200_000_000,
    timezone: "UTC",
  });
  assert.deepEqual(calls, [
    {
      mode: "capped",
      monthlyLimitMicrousd: 200_000_000,
      timezone: "UTC",
      at: 100,
    },
    {
      mode: "unlimited",
      monthlyLimitMicrousd: 200_000_000,
      timezone: "UTC",
      at: 100,
    },
  ]);
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
      "disabled"
    );
    assert.deepEqual(guard.reserve(reservation()), {
      ok: false,
      reason: "disabled",
    });
    now += 1;
    guard.setPolicy({ monthlyLimitMicrousd: 10_000_000, timezone: "Asia/Shanghai" });
    const reserved = guard.reserveNextAttempt(nextReservation());
    assert.equal(reserved.ok, true);
    assert.equal(reserved.attemptNumber, 1);
    assert.equal(
      guard.getAttemptDispositionByRequestId("request-1").disposition,
      "reserved_not_started"
    );
    assert.equal(guard.listStartupRecoveryDispositions().length, 1);
    now += 1;
    guard.markStarted("request-1");
    assert.equal(
      guard.listAttemptDispositionsByJob({
        jobId: "job-1",
        provider: "minimax",
        operation: "session_analysis",
      })[0].disposition,
      "started_unreconciled"
    );
    now += 1;
    guard.reconcile({
      requestId: "request-1",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(guard.getStatus().spentMicrousd, 3);
    assert.equal(guard.listStartupRecoveryDispositions().length, 0);
    assert.deepEqual(guard.recoverIncompleteAttempts(), {
      releasedCount: 0,
      usageUnknownCount: 0,
    });
  });
});
