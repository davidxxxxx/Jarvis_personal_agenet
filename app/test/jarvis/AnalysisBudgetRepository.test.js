const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openAnalysisBudgetRepository } = require("../../src/jarvis/main/AnalysisBudgetRepository");

function withDatabase(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-analysis-budget-"));
  const databasePath = path.join(directory, "jarvis.sqlite");
  try {
    return run(databasePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function reservation(at, overrides = {}) {
  return {
    requestId: "request-1",
    jobId: "job-1",
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    estimatedUsage: { inputTokens: 1, outputTokens: 1 },
    at,
    ...overrides,
  };
}

function nextReservation(at, overrides = {}) {
  const { attemptNumber: _attemptNumber, ...input } = reservation(at, overrides);
  return input;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test("repository factory initializes the default five-dollar local-month policy", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 5, 30, 16);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      assert.deepEqual(
        repository.initialize({
          monthlyLimitMicrousd: 5_000_000,
          timezone: "Asia/Shanghai",
          at,
        }),
        {
          mode: "capped",
          monthKey: "2026-07",
          timezone: "Asia/Shanghai",
          currency: "USD",
          monthlyLimitMicrousd: 5_000_000,
          spentMicrousd: 0,
          reservedMicrousd: 0,
          remainingMicrousd: 5_000_000,
          blockedReason: null,
        }
      );
      assert.deepEqual(repository.initialize({ timezone: "UTC", at: at + 1 }), {
        mode: "capped",
        monthKey: "2026-07",
        timezone: "Asia/Shanghai",
        currency: "USD",
        monthlyLimitMicrousd: 5_000_000,
        spentMicrousd: 0,
        reservedMicrousd: 0,
        remainingMicrousd: 5_000_000,
        blockedReason: null,
      });
    } finally {
      repository.close();
    }
  });
});

test("capped two-hundred-dollar and unlimited policies persist without disabling usage accounting", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        mode: "capped",
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at,
      });
      assert.deepEqual(
        repository.setPolicy({
          mode: "capped",
          monthlyLimitMicrousd: 200_000_000,
          timezone: "Asia/Shanghai",
          at: at + 1,
        }),
        {
          mode: "capped",
          monthKey: "2026-07",
          timezone: "Asia/Shanghai",
          currency: "USD",
          monthlyLimitMicrousd: 200_000_000,
          spentMicrousd: 0,
          reservedMicrousd: 0,
          remainingMicrousd: 200_000_000,
          blockedReason: null,
        }
      );
      assert.equal(repository.reserve(reservation(at + 2)).ok, true);
      repository.markStarted({ requestId: "request-1", at: at + 3 });
      repository.markUsageUnknown({
        requestId: "request-1",
        reasonCode: "usage_missing",
        at: at + 4,
      });
      const unlimited = repository.setPolicy({
        mode: "unlimited",
        monthlyLimitMicrousd: 200_000_000,
        timezone: "Asia/Shanghai",
        at: at + 5,
      });
      assert.equal(unlimited.mode, "unlimited");
      assert.equal(unlimited.remainingMicrousd, null);
      assert.equal(unlimited.blockedReason, null);
      assert.equal(
        repository.reserve(
          reservation(at + 6, {
            requestId: "request-2",
            jobId: "job-2",
          })
        ).ok,
        true
      );
    } finally {
      repository.close();
    }
  });
});

test("same-zone limit changes use the active policy while period audit snapshots stay immutable", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at,
      });
      const originalPeriod = repository.db
        .prepare(
          `SELECT monthly_limit_microusd, policy_revision
           FROM analysis_budget_periods`
        )
        .get();

      assert.equal(
        repository.setPolicy({ monthlyLimitMicrousd: 0, timezone: "Asia/Shanghai", at })
          .monthlyLimitMicrousd,
        0
      );
      assert.equal(repository.getStatus({ at }).blockedReason, "disabled");
      assert.equal(
        repository.setPolicy({
          monthlyLimitMicrousd: 10_000_000,
          timezone: "Asia/Shanghai",
          at: at + 1,
        }).remainingMicrousd,
        10_000_000
      );
      assert.deepEqual(
        repository.db
          .prepare(
            `SELECT monthly_limit_microusd, policy_revision
             FROM analysis_budget_periods`
          )
          .get(),
        originalPeriod
      );
    } finally {
      repository.close();
    }
  });
});

test("timezone changes remain pending until the old half-open period ends", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 2, 10, 12);
    const oldPeriodEnd = Date.UTC(2026, 3, 1, 7);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "America/Los_Angeles",
        at,
      });
      assert.equal(
        repository.setPolicy({
          monthlyLimitMicrousd: 5_000_000,
          timezone: "Asia/Shanghai",
          at,
        }).timezone,
        "America/Los_Angeles"
      );
      assert.equal(repository.getStatus({ at: oldPeriodEnd - 1 }).timezone, "America/Los_Angeles");
      assert.deepEqual(repository.getStatus({ at: oldPeriodEnd }), {
        mode: "capped",
        monthKey: "2026-04",
        timezone: "Asia/Shanghai",
        currency: "USD",
        monthlyLimitMicrousd: 5_000_000,
        spentMicrousd: 0,
        reservedMicrousd: 0,
        remainingMicrousd: 5_000_000,
        blockedReason: null,
      });
      const periods = repository.db
        .prepare(
          `SELECT timezone, starts_at, ends_at
           FROM analysis_budget_periods ORDER BY starts_at`
        )
        .all();
      assert.equal(periods.length, 2);
      assert.equal(periods[0].ends_at, oldPeriodEnd);
      assert.equal(periods[1].starts_at, oldPeriodEnd);
      assert.equal(periods[1].timezone, "Asia/Shanghai");
    } finally {
      repository.close();
    }
  });
});

test("historical status uses the policy effective then even after a future period is opened", () => {
  withDatabase((databasePath) => {
    const july = Date.UTC(2026, 6, 15, 4);
    const august = Date.UTC(2026, 7, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at: july,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 10_000_000,
        timezone: "Asia/Shanghai",
        at: july + 1,
      });
      assert.equal(repository.getStatus({ at: august }).monthlyLimitMicrousd, 10_000_000);
      assert.equal(repository.getStatus({ at: july + 2 }).monthlyLimitMicrousd, 10_000_000);
    } finally {
      repository.close();
    }
  });
});

test("changing a limit while a timezone is pending creates one refreshed pending revision", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 2, 10, 12);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "America/Los_Angeles",
        at,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at: at + 1,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 6_000_000,
        timezone: "Asia/Shanghai",
        at: at + 2,
      });

      assert.equal(
        repository.db
          .prepare("SELECT COUNT(*) AS count FROM analysis_budget_policy_revisions")
          .get().count,
        4
      );
      const pending = repository.db
        .prepare(
          `SELECT policy.monthly_limit_microusd, policy.timezone
           FROM analysis_budget_settings AS settings
           JOIN analysis_budget_policy_revisions AS policy
             ON policy.revision = settings.pending_policy_revision
           WHERE settings.singleton_id = 1`
        )
        .get();
      assert.deepEqual(pending, {
        monthly_limit_microusd: 6_000_000,
        timezone: "Asia/Shanghai",
      });
    } finally {
      repository.close();
    }
  });
});

test("cancelling a pending timezone appends a compensating revision that wins at the boundary", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 2, 10, 12);
    const oldPeriodEnd = Date.UTC(2026, 3, 1, 7);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "America/Los_Angeles",
        at,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at: at + 1,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "America/Los_Angeles",
        at: at + 2,
      });

      assert.deepEqual(
        repository.db
          .prepare(
            `SELECT pending_policy_revision, pending_effective_at
             FROM analysis_budget_settings WHERE singleton_id = 1`
          )
          .get(),
        { pending_policy_revision: null, pending_effective_at: null }
      );
      assert.equal(repository.getStatus({ at: oldPeriodEnd }).timezone, "America/Los_Angeles");
      const settings = repository.db
        .prepare(
          `SELECT active_policy_revision FROM analysis_budget_settings WHERE singleton_id = 1`
        )
        .get();
      const latest = repository.db
        .prepare(
          `SELECT revision, timezone FROM analysis_budget_policy_revisions
           WHERE effective_at <= ? ORDER BY effective_at DESC, revision DESC LIMIT 1`
        )
        .get(oldPeriodEnd);
      assert.equal(latest.timezone, "America/Los_Angeles");
      assert.equal(settings.active_policy_revision, latest.revision);
    } finally {
      repository.close();
    }
  });
});

test("factory reopen preserves policy and period state", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const first = openAnalysisBudgetRepository(databasePath);
    first.initialize({
      monthlyLimitMicrousd: 5_000_000,
      timezone: "Asia/Shanghai",
      at,
    });
    first.setPolicy({
      monthlyLimitMicrousd: 10_000_000,
      timezone: "Asia/Shanghai",
      at: at + 1,
    });
    first.close();

    const reopened = openAnalysisBudgetRepository(databasePath);
    try {
      assert.equal(reopened.getStatus({ at: at + 2 }).monthlyLimitMicrousd, 10_000_000);
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) AS count FROM analysis_budget_periods").get().count,
        1
      );
    } finally {
      reopened.close();
    }
  });
});

test("reservation is exact-idempotent and both request and logical attempt collisions fail closed", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at,
      });
      assert.deepEqual(repository.reserve(reservation(at + 1)), {
        ok: true,
        requestId: "request-1",
        state: "reserved",
        reservedMicrousd: 3,
        replayed: false,
      });
      assert.deepEqual(repository.reserve(reservation(at + 2)), {
        ok: true,
        requestId: "request-1",
        state: "reserved",
        reservedMicrousd: 3,
        replayed: true,
      });
      assert.throws(
        () =>
          repository.reserve(
            reservation(at + 2, {
              estimatedUsage: { inputTokens: 2, outputTokens: 1 },
            })
          ),
        hasCode("BUDGET_REQUEST_ID_COLLISION")
      );
      assert.throws(
        () =>
          repository.reserve(
            reservation(at + 2, {
              requestId: "request-2",
            })
          ),
        hasCode("BUDGET_ATTEMPT_COLLISION")
      );
    } finally {
      repository.close();
    }
  });
});

test("reserveNextAttempt allocates from the durable ledger independently of processing attempt_count", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    let repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 100, timezone: "Asia/Shanghai", at });
      repository.db
        .prepare(
          `INSERT INTO sessions (id, started_at, status, created_at)
           VALUES ('session-1', ?, 'completed', ?)`
        )
        .run(at, at);
      repository.db
        .prepare(
          `INSERT INTO processing_jobs (
             id, session_id, job_type, state, input_hash, attempt_count, created_at
           ) VALUES ('job-1', 'session-1', 'analysis', 'pending', 'hash-1', 99, ?)`
        )
        .run(at);

      assert.deepEqual(repository.reserveNextAttempt(nextReservation(at + 1)), {
        ok: true,
        requestId: "request-1",
        attemptNumber: 1,
        state: "reserved",
        reservedMicrousd: 3,
        replayed: false,
      });
      assert.deepEqual(repository.reserveNextAttempt(nextReservation(at + 2)), {
        ok: true,
        requestId: "request-1",
        attemptNumber: 1,
        state: "reserved",
        reservedMicrousd: 3,
        replayed: true,
      });
      assert.throws(
        () =>
          repository.reserveNextAttempt(
            nextReservation(at + 2, {
              estimatedUsage: { inputTokens: 2, outputTokens: 1 },
            })
          ),
        hasCode("BUDGET_REQUEST_ID_COLLISION")
      );

      repository.release({
        requestId: "request-1",
        reasonCode: "local_preflight_failed",
        at: at + 3,
      });
      assert.equal(
        repository.reserveNextAttempt(nextReservation(at + 4, { requestId: "request-2" }))
          .attemptNumber,
        2
      );
      repository.close();

      repository = openAnalysisBudgetRepository(databasePath);
      repository.release({
        requestId: "request-2",
        reasonCode: "local_preflight_failed",
        at: at + 5,
      });
      assert.equal(
        repository.reserveNextAttempt(nextReservation(at + 6, { requestId: "request-3" }))
          .attemptNumber,
        3
      );
    } finally {
      if (repository.db?.open) repository.close();
    }
  });
});

test("reserveNextAttempt serializes cross-connection budget and attempt allocation", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const first = openAnalysisBudgetRepository(databasePath, { busyTimeoutMs: 5 });
    const second = openAnalysisBudgetRepository(databasePath, { busyTimeoutMs: 5 });
    try {
      first.initialize({ monthlyLimitMicrousd: 3, timezone: "Asia/Shanghai", at });
      const firstResult = first.reserveNextAttempt(nextReservation(at + 1));
      assert.equal(firstResult.attemptNumber, 1);
      assert.deepEqual(
        second.reserveNextAttempt(nextReservation(at + 2, { requestId: "request-2" })),
        { ok: false, reason: "budget_exceeded" }
      );
      assert.deepEqual(second.reserveNextAttempt(nextReservation(at + 3)), {
        ...firstResult,
        replayed: true,
      });
      assert.deepEqual(
        first.db
          .prepare(
            `SELECT request_id, attempt_number FROM analysis_budget_attempts
             WHERE job_id = 'job-1' ORDER BY attempt_number`
          )
          .all(),
        [{ request_id: "request-1", attempt_number: 1 }]
      );

      first.db.exec("BEGIN IMMEDIATE");
      try {
        assert.deepEqual(
          second.reserveNextAttempt(nextReservation(at + 4, { requestId: "request-busy" })),
          { ok: false, reason: "budget_busy" }
        );
      } finally {
        first.db.exec("ROLLBACK");
      }
    } finally {
      first.close();
      second.close();
    }
  });
});

test("same-zone limit changes bind new reservations to the active admission policy", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({
        monthlyLimitMicrousd: 5_000_000,
        timezone: "Asia/Shanghai",
        at,
      });
      repository.setPolicy({
        monthlyLimitMicrousd: 10_000_000,
        timezone: "Asia/Shanghai",
        at: at + 1,
      });
      const activeRevision = repository.db
        .prepare(
          `SELECT active_policy_revision FROM analysis_budget_settings WHERE singleton_id = 1`
        )
        .get().active_policy_revision;
      repository.reserve(reservation(at + 2));
      assert.equal(
        repository.db
          .prepare("SELECT policy_revision FROM analysis_budget_attempts WHERE request_id = ?")
          .get("request-1").policy_revision,
        activeRevision
      );
    } finally {
      repository.close();
    }
  });
});

test("two connections cannot consume the same last budget and lock contention returns budget_busy", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const first = openAnalysisBudgetRepository(databasePath, { busyTimeoutMs: 5 });
    const second = openAnalysisBudgetRepository(databasePath, { busyTimeoutMs: 5 });
    try {
      first.initialize({ monthlyLimitMicrousd: 3, timezone: "Asia/Shanghai", at });
      assert.equal(first.reserve(reservation(at + 1)).ok, true);
      assert.deepEqual(
        second.reserve(
          reservation(at + 1, {
            requestId: "request-2",
            jobId: "job-2",
          })
        ),
        { ok: false, reason: "budget_exceeded" }
      );
      assert.equal(
        first.db.prepare("SELECT COUNT(*) AS count FROM analysis_budget_attempts").get().count,
        1
      );

      first.db.exec("BEGIN IMMEDIATE");
      try {
        assert.deepEqual(
          second.reserve(
            reservation(at + 2, {
              requestId: "request-busy",
              jobId: "job-busy",
            })
          ),
          { ok: false, reason: "budget_busy" }
        );
      } finally {
        first.db.exec("ROLLBACK");
      }
    } finally {
      first.close();
      second.close();
    }
  });
});

test("started attempts reconcile actual usage exactly even when it exceeds the reservation", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 3, timezone: "Asia/Shanghai", at });
      repository.reserve(reservation(at + 1));
      assert.deepEqual(repository.markStarted({ requestId: "request-1", at: at + 2 }), {
        ok: true,
        requestId: "request-1",
        state: "started",
        replayed: false,
      });
      assert.deepEqual(repository.markStarted({ requestId: "request-1", at: at + 3 }), {
        ok: true,
        requestId: "request-1",
        state: "started",
        replayed: true,
      });
      assert.deepEqual(
        repository.reconcile({
          requestId: "request-1",
          usage: { inputTokens: 1, outputTokens: 2 },
          at: at + 4,
        }),
        {
          ok: true,
          requestId: "request-1",
          state: "reconciled",
          actualMicrousd: 4,
          replayed: false,
        }
      );
      assert.deepEqual(
        repository.reconcile({
          requestId: "request-1",
          usage: { inputTokens: 1, outputTokens: 2 },
          at: at + 5,
        }),
        {
          ok: true,
          requestId: "request-1",
          state: "reconciled",
          actualMicrousd: 4,
          replayed: true,
        }
      );
      assert.throws(
        () =>
          repository.reconcile({
            requestId: "request-1",
            usage: { inputTokens: 1, outputTokens: 1 },
            at: at + 5,
          }),
        hasCode("BUDGET_RECONCILIATION_COLLISION")
      );
      assert.deepEqual(repository.getStatus({ at: at + 5 }), {
        mode: "capped",
        monthKey: "2026-07",
        timezone: "Asia/Shanghai",
        currency: "USD",
        monthlyLimitMicrousd: 3,
        spentMicrousd: 4,
        reservedMicrousd: 0,
        remainingMicrousd: 0,
        blockedReason: "over_limit",
      });
    } finally {
      repository.close();
    }
  });
});

test("release is pre-transport only while unknown usage retains the estimate for its original month", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const august = Date.UTC(2026, 6, 31, 16);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 10, timezone: "Asia/Shanghai", at });
      repository.reserve(reservation(at + 1));
      assert.deepEqual(
        repository.release({
          requestId: "request-1",
          reasonCode: "local_preflight_failed",
          at: at + 2,
        }),
        {
          ok: true,
          requestId: "request-1",
          state: "released",
          replayed: false,
        }
      );
      assert.equal(
        repository.release({
          requestId: "request-1",
          reasonCode: "local_preflight_failed",
          at: at + 3,
        }).replayed,
        true
      );
      assert.throws(
        () => repository.markStarted({ requestId: "request-1", at: at + 3 }),
        hasCode("BUDGET_INVALID_TRANSITION")
      );

      repository.reserve(reservation(at + 4, { requestId: "request-2", jobId: "job-2" }));
      repository.markStarted({ requestId: "request-2", at: at + 5 });
      assert.throws(
        () =>
          repository.release({
            requestId: "request-2",
            reasonCode: "shutdown_before_transport",
            at: at + 6,
          }),
        hasCode("BUDGET_INVALID_TRANSITION")
      );
      assert.deepEqual(
        repository.markUsageUnknown({
          requestId: "request-2",
          reasonCode: "usage_missing",
          at: at + 6,
        }),
        {
          ok: true,
          requestId: "request-2",
          state: "usage_unknown",
          replayed: false,
        }
      );
      assert.equal(repository.getStatus({ at: at + 7 }).reservedMicrousd, 3);
      assert.equal(repository.getStatus({ at: at + 7 }).blockedReason, "usage_unknown");
      assert.deepEqual(
        repository.reserve(reservation(at + 7, { requestId: "request-3", jobId: "job-3" })),
        { ok: false, reason: "usage_unknown" }
      );

      assert.equal(repository.getStatus({ at: august }).blockedReason, null);
      assert.equal(
        repository.reserve(
          reservation(august, { requestId: "request-august", jobId: "job-august" })
        ).ok,
        true
      );
    } finally {
      repository.close();
    }
  });
});

test("attempt dispositions expose authoritative reconciliation facts", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 100, timezone: "Asia/Shanghai", at });
      repository.reserveNextAttempt(
        nextReservation(at + 1, { requestId: "request-zero", jobId: "job-zero" })
      );
      repository.markStarted({ requestId: "request-zero", at: at + 2 });
      repository.reconcile({
        requestId: "request-zero",
        usage: { inputTokens: 0, outputTokens: 0 },
        at: at + 3,
      });

      repository.reserveNextAttempt(
        nextReservation(at + 4, { requestId: "request-paid", jobId: "job-paid" })
      );
      repository.markStarted({ requestId: "request-paid", at: at + 5 });
      const paid = repository.reconcile({
        requestId: "request-paid",
        usage: { inputTokens: 1, outputTokens: 2 },
        at: at + 6,
      });

      assert.deepEqual(
        (({ state, actualInputTokens, actualOutputTokens, actualMicrousd }) => ({
          state,
          actualInputTokens,
          actualOutputTokens,
          actualMicrousd,
        }))(repository.getAttemptDispositionByRequestId("request-zero")),
        {
          state: "reconciled",
          actualInputTokens: 0,
          actualOutputTokens: 0,
          actualMicrousd: 0,
        }
      );
      const [paidDisposition] = repository.listAttemptDispositionsByJob({
        jobId: "job-paid",
        provider: "minimax",
        operation: "session_analysis",
      });
      assert.deepEqual(
        (({ state, actualInputTokens, actualOutputTokens, actualMicrousd }) => ({
          state,
          actualInputTokens,
          actualOutputTokens,
          actualMicrousd,
        }))(paidDisposition),
        {
          state: "reconciled",
          actualInputTokens: 1,
          actualOutputTokens: 2,
          actualMicrousd: paid.actualMicrousd,
        }
      );
    } finally {
      repository.close();
    }
  });
});

test("lowering the active limit preserves held rows and raising it admits only new attempts", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 3, timezone: "Asia/Shanghai", at });
      repository.reserve(reservation(at + 1));
      assert.equal(
        repository.setPolicy({
          monthlyLimitMicrousd: 2,
          timezone: "Asia/Shanghai",
          at: at + 2,
        }).blockedReason,
        "over_limit"
      );
      assert.deepEqual(
        repository.reserve(reservation(at + 3, { requestId: "request-2", jobId: "job-2" })),
        { ok: false, reason: "over_limit" }
      );
      assert.equal(
        repository.db.prepare("SELECT COUNT(*) AS count FROM analysis_budget_attempts").get().count,
        1
      );
      repository.setPolicy({
        monthlyLimitMicrousd: 10,
        timezone: "Asia/Shanghai",
        at: at + 4,
      });
      assert.equal(
        repository.reserve(reservation(at + 5, { requestId: "request-3", jobId: "job-3" })).ok,
        true
      );
    } finally {
      repository.close();
    }
  });
});

test("durable attempt disposition queries distinguish every lifecycle and startup action", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    let repository = openAnalysisBudgetRepository(databasePath);
    try {
      repository.initialize({ monthlyLimitMicrousd: 100, timezone: "Asia/Shanghai", at });
      repository.reserveNextAttempt(nextReservation(at + 1, { requestId: "request-reserved" }));
      repository.reserveNextAttempt(nextReservation(at + 2, { requestId: "request-started" }));
      repository.markStarted({ requestId: "request-started", at: at + 3 });

      repository.reserveNextAttempt(nextReservation(at + 4, { requestId: "request-reconciled" }));
      repository.markStarted({ requestId: "request-reconciled", at: at + 5 });
      repository.reconcile({
        requestId: "request-reconciled",
        usage: { inputTokens: 1, outputTokens: 1 },
        at: at + 6,
      });

      repository.reserveNextAttempt(nextReservation(at + 7, { requestId: "request-released" }));
      repository.release({
        requestId: "request-released",
        reasonCode: "local_preflight_failed",
        at: at + 8,
      });

      repository.reserveNextAttempt(nextReservation(at + 9, { requestId: "request-unknown" }));
      repository.markStarted({ requestId: "request-unknown", at: at + 10 });
      repository.markUsageUnknown({
        requestId: "request-unknown",
        reasonCode: "usage_missing",
        at: at + 11,
      });

      assert.deepEqual(repository.getAttemptDispositionByRequestId("request-reserved"), {
        requestId: "request-reserved",
        jobId: "job-1",
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        state: "reserved",
        disposition: "reserved_not_started",
        startupAction: "release_and_retry",
        reasonCode: null,
        actualInputTokens: null,
        actualOutputTokens: null,
        actualMicrousd: null,
        createdAt: at + 1,
        startedAt: null,
        finalizedAt: null,
      });
      assert.equal(repository.getAttemptDispositionByRequestId("missing-request"), null);

      const byJob = repository.listAttemptDispositionsByJob({
        jobId: "job-1",
        provider: "minimax",
        operation: "session_analysis",
      });
      assert.deepEqual(
        byJob.map(({ attemptNumber, state, disposition, startupAction, reasonCode }) => ({
          attemptNumber,
          state,
          disposition,
          startupAction,
          reasonCode,
        })),
        [
          {
            attemptNumber: 1,
            state: "reserved",
            disposition: "reserved_not_started",
            startupAction: "release_and_retry",
            reasonCode: null,
          },
          {
            attemptNumber: 2,
            state: "started",
            disposition: "started_unreconciled",
            startupAction: "mark_usage_unknown",
            reasonCode: null,
          },
          {
            attemptNumber: 3,
            state: "reconciled",
            disposition: "reconciled",
            startupAction: "none",
            reasonCode: null,
          },
          {
            attemptNumber: 4,
            state: "released",
            disposition: "released",
            startupAction: "retry_with_new_attempt",
            reasonCode: "local_preflight_failed",
          },
          {
            attemptNumber: 5,
            state: "usage_unknown",
            disposition: "usage_unknown",
            startupAction: "block_for_period",
            reasonCode: "usage_missing",
          },
        ]
      );
      assert.deepEqual(
        repository
          .listStartupRecoveryDispositions()
          .map(({ requestId, disposition, startupAction }) => ({
            requestId,
            disposition,
            startupAction,
          })),
        [
          {
            requestId: "request-reserved",
            disposition: "reserved_not_started",
            startupAction: "release_and_retry",
          },
          {
            requestId: "request-started",
            disposition: "started_unreconciled",
            startupAction: "mark_usage_unknown",
          },
        ]
      );

      repository.close();
      repository = openAnalysisBudgetRepository(databasePath);
      assert.equal(
        repository.getAttemptDispositionByRequestId("request-started").disposition,
        "started_unreconciled"
      );
      assert.deepEqual(repository.recover({ at: at + 12 }), {
        releasedCount: 1,
        usageUnknownCount: 1,
      });
      assert.deepEqual(repository.listStartupRecoveryDispositions(), []);
      assert.deepEqual(
        repository
          .listAttemptDispositionsByJob({
            jobId: "job-1",
            provider: "minimax",
            operation: "session_analysis",
          })
          .slice(0, 2)
          .map(({ disposition, startupAction, reasonCode }) => ({
            disposition,
            startupAction,
            reasonCode,
          })),
        [
          {
            disposition: "released",
            startupAction: "retry_with_new_attempt",
            reasonCode: "process_recovery",
          },
          {
            disposition: "usage_unknown",
            startupAction: "block_for_period",
            reasonCode: "process_recovery",
          },
        ]
      );
    } finally {
      if (repository.db?.open) repository.close();
    }
  });
});

test("recovery releases unstarted attempts, marks started usage unknown, and is reopen-idempotent", () => {
  withDatabase((databasePath) => {
    const at = Date.UTC(2026, 6, 15, 4);
    const first = openAnalysisBudgetRepository(databasePath);
    let reopened = null;
    try {
      first.initialize({ monthlyLimitMicrousd: 10, timezone: "Asia/Shanghai", at });
      first.reserve(reservation(at + 1));
      first.reserve(reservation(at + 1, { requestId: "request-2", jobId: "job-2" }));
      first.markStarted({ requestId: "request-2", at: at + 2 });
      assert.deepEqual(first.recover({ at: at + 3 }), {
        releasedCount: 1,
        usageUnknownCount: 1,
      });
      const finalized = first.db
        .prepare(
          `SELECT request_id, state, reason_code, finalized_at
           FROM analysis_budget_attempts ORDER BY request_id`
        )
        .all();
      assert.deepEqual(first.recover({ at: at + 4 }), {
        releasedCount: 0,
        usageUnknownCount: 0,
      });
      assert.deepEqual(
        first.db
          .prepare(
            `SELECT request_id, state, reason_code, finalized_at
             FROM analysis_budget_attempts ORDER BY request_id`
          )
          .all(),
        finalized
      );
      first.close();

      reopened = openAnalysisBudgetRepository(databasePath);
      assert.equal(reopened.getStatus({ at: at + 5 }).blockedReason, "usage_unknown");
      assert.deepEqual(reopened.recover({ at: at + 6 }), {
        releasedCount: 0,
        usageUnknownCount: 0,
      });
    } finally {
      if (first.db?.open) first.close();
      if (reopened?.db?.open) reopened.close();
    }
  });
});
