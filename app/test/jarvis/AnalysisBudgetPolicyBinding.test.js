const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");

function insertAttempt(db, { requestId, jobId, policyRevision, periodId = 1, createdAt = 5 }) {
  return db
    .prepare(
      `INSERT INTO analysis_budget_attempts (
         request_id, job_id, attempt_number, period_id, policy_revision,
         provider, model, operation, price_version, currency,
         input_per_million_microusd, output_per_million_microusd,
         estimated_input_tokens, estimated_output_tokens, reserved_microusd,
         state, created_at
       ) VALUES (
         ?, ?, 1, ?, ?, 'minimax', 'MiniMax-M2.7', 'session_analysis',
         'minimax-m2.7-standard-2026-07-16', 'USD',
         300000, 1200000, 1, 1, 3, 'reserved', ?
       )`
    )
    .run(requestId, jobId, periodId, policyRevision, createdAt);
}

test("attempt policy is the latest globally effective revision at request creation", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db);
    const insertPolicy = db.prepare(
      `INSERT INTO analysis_budget_policy_revisions (
         monthly_limit_microusd, timezone, currency, created_at, effective_at
       ) VALUES (?, 'Asia/Shanghai', 'USD', ?, ?)`
    );
    const periodPolicy = Number(insertPolicy.run(5_000_000, 1, 1).lastInsertRowid);
    const olderAtSameInstant = Number(insertPolicy.run(4_000_000, 2, 2).lastInsertRowid);
    const activePolicy = Number(insertPolicy.run(3_000_000, 3, 2).lastInsertRowid);
    const futurePolicy = Number(insertPolicy.run(2_000_000, 10, 10).lastInsertRowid);
    db.prepare(
      `INSERT INTO analysis_budget_periods (
         id, month_key, timezone, starts_at, ends_at, currency,
         monthly_limit_microusd, policy_revision, created_at
       ) VALUES (1, '2026-07', 'Asia/Shanghai', 1, 100, 'USD', 5000000, ?, 1)`
    ).run(periodPolicy);

    insertAttempt(db, {
      requestId: "request-active-policy",
      jobId: "job-active-policy",
      policyRevision: activePolicy,
    });
    assert.equal(
      db
        .prepare("SELECT policy_revision FROM analysis_budget_attempts WHERE request_id = ?")
        .get("request-active-policy").policy_revision,
      activePolicy
    );
    for (const [suffix, revision] of [
      ["period", periodPolicy],
      ["same-instant-older", olderAtSameInstant],
      ["future", futurePolicy],
    ]) {
      assert.throws(
        () =>
          insertAttempt(db, {
            requestId: `request-${suffix}`,
            jobId: `job-${suffix}`,
            policyRevision: revision,
          }),
        /snapshot/i
      );
    }
  } finally {
    db.close();
  }
});

test("attempt creation time must fall inside its referenced half-open period", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db);
    const insertPolicy = db.prepare(
      `INSERT INTO analysis_budget_policy_revisions (
         monthly_limit_microusd, timezone, currency, created_at, effective_at
       ) VALUES (?, 'Asia/Shanghai', 'USD', ?, ?)`
    );
    const julyPolicy = Number(insertPolicy.run(5_000_000, 1, 1).lastInsertRowid);
    const augustPolicy = Number(insertPolicy.run(5_000_000, 100, 100).lastInsertRowid);
    const insertPeriod = db.prepare(
      `INSERT INTO analysis_budget_periods (
         id, month_key, timezone, starts_at, ends_at, currency,
         monthly_limit_microusd, policy_revision, created_at
       ) VALUES (?, ?, 'Asia/Shanghai', ?, ?, 'USD', 5000000, ?, ?)`
    );
    insertPeriod.run(1, "2026-07", 1, 100, julyPolicy, 1);
    insertPeriod.run(2, "2026-08", 100, 200, augustPolicy, 100);

    assert.throws(
      () =>
        insertAttempt(db, {
          requestId: "request-wrong-period",
          jobId: "job-wrong-period",
          policyRevision: augustPolicy,
          periodId: 1,
          createdAt: 150,
        }),
      /period/i
    );
    insertAttempt(db, {
      requestId: "request-correct-period",
      jobId: "job-correct-period",
      policyRevision: augustPolicy,
      periodId: 2,
      createdAt: 150,
    });
    assert.equal(
      db
        .prepare("SELECT period_id FROM analysis_budget_attempts WHERE request_id = ?")
        .get("request-correct-period").period_id,
      2
    );
  } finally {
    db.close();
  }
});
