const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");

const AnalysisBudgetService = require("../../src/jarvis/main/AnalysisBudgetService");
const { openAnalysisBudgetRepository } = require("../../src/jarvis/main/AnalysisBudgetRepository");

const NOW = Date.UTC(2026, 6, 16, 4, 0, 0);

function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-analysis-budget-service-"));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createService(overrides = {}) {
  return new AnalysisBudgetService({
    defaultTimezone: "Asia/Shanghai",
    now: () => NOW,
    isDispatcherStopped: () => true,
    ...overrides,
  });
}

function reservation(requestId, jobId, attemptNumber = 1) {
  return {
    requestId,
    jobId,
    attemptNumber,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    estimatedUsage: { inputTokens: 1_000, outputTokens: 100 },
  };
}

test("service opens a migrated database with the five-dollar local-month default", () =>
  withTempDirectory((directory) => {
    const service = createService();
    service.open(path.join(directory, "jarvis.sqlite"));

    assert.deepEqual(service.getStatus(), {
      monthKey: "2026-07",
      timezone: "Asia/Shanghai",
      currency: "USD",
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      remainingMicrousd: 5_000_000,
      blockedReason: null,
    });

    service.close();
  }));

test("reopen swaps databases on one stable service and invalidates the old repository handle", () =>
  withTempDirectory((directory) => {
    const repositories = [];
    const service = createService({
      openRepository(databasePath) {
        const repository = openAnalysisBudgetRepository(databasePath);
        repositories.push(repository);
        return repository;
      },
    });
    const firstPath = path.join(directory, "first.sqlite");
    const secondPath = path.join(directory, "second.sqlite");

    service.open(firstPath);
    service.setPolicy({ monthlyLimitMicrousd: 10_000_000, timezone: "Asia/Shanghai" });
    const stableReference = service;
    service.reopen(secondPath);

    assert.equal(service, stableReference);
    assert.equal(repositories.length, 2);
    assert.equal(repositories[0].db.open, false);
    assert.equal(repositories[1].db.open, true);
    assert.equal(service.getStatus().monthlyLimitMicrousd, 5_000_000);

    service.reopen(firstPath);
    assert.equal(repositories[1].db.open, false);
    assert.equal(service.getStatus().monthlyLimitMicrousd, 10_000_000);
    service.close();
  }));

test("close is idempotent and every later budget operation fails closed", () =>
  withTempDirectory((directory) => {
    const service = createService();
    service.open(path.join(directory, "jarvis.sqlite"));
    service.close();
    service.close();

    for (const operation of [
      () => service.getStatus(),
      () => service.setPolicy({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai" }),
      () => service.reserve(reservation("request-after-close", "job-after-close")),
    ]) {
      assert.throws(operation, (error) => {
        assert.equal(error.code, "ANALYSIS_BUDGET_SERVICE_CLOSED");
        assert.equal(error.message, "ANALYSIS_BUDGET_SERVICE_CLOSED");
        return true;
      });
    }
  }));

test("recovery requires a stopped dispatcher and is durable and idempotent", () =>
  withTempDirectory((directory) => {
    let dispatcherStopped = false;
    const databasePath = path.join(directory, "jarvis.sqlite");
    const service = createService({ isDispatcherStopped: () => dispatcherStopped });
    service.open(databasePath);
    service.reserve(reservation("request-reserved", "job-reserved"));
    service.reserve(reservation("request-started", "job-started"));
    service.markStarted("request-started");

    assert.throws(
      () => service.recoverIncompleteAttempts(),
      (error) => {
        assert.equal(error.code, "ANALYSIS_BUDGET_RECOVERY_REQUIRES_STOPPED_DISPATCHER");
        assert.equal(error.message, "ANALYSIS_BUDGET_RECOVERY_REQUIRES_STOPPED_DISPATCHER");
        return true;
      }
    );

    dispatcherStopped = true;
    assert.deepEqual(service.recoverIncompleteAttempts(), {
      releasedCount: 1,
      usageUnknownCount: 1,
    });
    assert.deepEqual(service.recoverIncompleteAttempts(), {
      releasedCount: 0,
      usageUnknownCount: 0,
    });

    const observer = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        observer
          .prepare(
            "SELECT request_id, state, reason_code FROM analysis_budget_attempts ORDER BY request_id"
          )
          .all(),
        [
          {
            request_id: "request-reserved",
            state: "released",
            reason_code: "process_recovery",
          },
          {
            request_id: "request-started",
            state: "usage_unknown",
            reason_code: "process_recovery",
          },
        ]
      );
    } finally {
      observer.close();
      service.close();
    }
  }));
