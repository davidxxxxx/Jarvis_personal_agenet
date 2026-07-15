const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const TABLES = [
  "analysis_budget_policy_revisions",
  "analysis_budget_settings",
  "analysis_budget_periods",
  "analysis_budget_price_versions",
  "analysis_budget_attempts",
];

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function migrate(db, fromVersion = 0) {
  if (fromVersion !== 0) db.pragma(`user_version = ${fromVersion}`);
  return applyJarvisMigrations(db, { now: () => 1_720_992_000_000 });
}

function createRepresentativeV23Database() {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('preserved-v23-session', 10, 20, 'completed', 10);
    DROP TABLE analysis_budget_attempts;
    DROP TABLE analysis_budget_periods;
    DROP TABLE analysis_budget_settings;
    DROP TABLE analysis_budget_price_versions;
    DROP TABLE analysis_budget_policy_revisions;
    PRAGMA user_version = 23;
  `);
  return db;
}

test("v24 creates the durable analysis budget schema and reviewed MiniMax price rows", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(TARGET_VERSION, 24);
    assert.deepEqual(migrate(db), { fromVersion: 0, toVersion: 24 });
    for (const table of TABLES) assert.ok(tableNames(db).includes(table), table);

    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_budget_settings WHERE singleton_id = 1").get(),
      {
        singleton_id: 1,
        default_monthly_limit_microusd: 5_000_000,
        currency: "USD",
        active_policy_revision: null,
        pending_policy_revision: null,
        pending_effective_at: null,
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT provider, model, operation, price_version, currency,
                  input_per_million_microusd, output_per_million_microusd, billing_basis
                  , created_at
           FROM analysis_budget_price_versions
           ORDER BY operation`
        )
        .all(),
      [
        {
          provider: "minimax",
          model: "MiniMax-M2.7",
          operation: "daily_digest",
          price_version: "minimax-m2.7-standard-2026-07-16",
          currency: "USD",
          input_per_million_microusd: 300_000,
          output_per_million_microusd: 1_200_000,
          billing_basis: "paygo_list_price_equivalent",
          created_at: Date.UTC(2026, 6, 16),
        },
        {
          provider: "minimax",
          model: "MiniMax-M2.7",
          operation: "session_analysis",
          price_version: "minimax-m2.7-standard-2026-07-16",
          currency: "USD",
          input_per_million_microusd: 300_000,
          output_per_million_microusd: 1_200_000,
          billing_basis: "paygo_list_price_equivalent",
          created_at: Date.UTC(2026, 6, 16),
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("a v23 database upgrades once and the latest reopen is a no-op", () => {
  const db = createRepresentativeV23Database();
  try {
    assert.deepEqual(migrate(db), { fromVersion: 23, toVersion: 24 });
    assert.deepEqual(db.prepare("SELECT id, status FROM sessions").get(), {
      id: "preserved-v23-session",
      status: "completed",
    });
    const first = db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY type, name").all();
    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 24, toVersion: 24 });
    assert.deepEqual(
      db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY type, name").all(),
      first
    );
  } finally {
    db.close();
  }
});

test("analysis budget migration preserves the separate OpenAI correction ledger", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE cloud_budget_settings (
        provider TEXT PRIMARY KEY,
        monthly_limit_microusd INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cloud_usage (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        actual_microusd INTEGER NOT NULL
      );
      INSERT INTO cloud_budget_settings VALUES ('openai', 5000000, 1, 7);
      INSERT INTO cloud_usage VALUES ('old-openai-charge', 'openai', 1234);
      PRAGMA user_version = 23;
    `);

    migrate(db, 23);

    assert.deepEqual(db.prepare("SELECT * FROM cloud_budget_settings").get(), {
      provider: "openai",
      monthly_limit_microusd: 5_000_000,
      enabled: 1,
      updated_at: 7,
    });
    assert.deepEqual(db.prepare("SELECT * FROM cloud_usage").get(), {
      id: "old-openai-charge",
      provider: "openai",
      actual_microusd: 1234,
    });
  } finally {
    db.close();
  }
});

test("policy and price history are immutable and policy limits cover exactly zero through ten dollars", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const insertPolicy = db.prepare(`
      INSERT INTO analysis_budget_policy_revisions (
        monthly_limit_microusd, timezone, currency, created_at, effective_at
      ) VALUES (?, 'Asia/Shanghai', 'USD', 1, 1)
    `);
    const zero = insertPolicy.run(0).lastInsertRowid;
    const ten = insertPolicy.run(10_000_000).lastInsertRowid;
    assert.throws(() => insertPolicy.run(-1), /constraint/i);
    assert.throws(() => insertPolicy.run(10_000_001), /constraint/i);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_policy_revisions SET monthly_limit_microusd = 1 WHERE revision = ?"
          )
          .run(zero),
      /immutable/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_settings SET active_policy_revision = 999 WHERE singleton_id = 1"
          )
          .run(),
      /policy pointer|foreign key/i
    );
    db.prepare(
      "UPDATE analysis_budget_settings SET active_policy_revision = ? WHERE singleton_id = 1"
    ).run(zero);
    assert.throws(
      () =>
        db
          .prepare(
            `
            UPDATE analysis_budget_settings
            SET pending_policy_revision = ?, pending_effective_at = 2
            WHERE singleton_id = 1
          `
          )
          .run(ten),
      /policy pointer/i
    );
    const pending = db
      .prepare(
        `
        INSERT INTO analysis_budget_policy_revisions (
          monthly_limit_microusd, timezone, currency, created_at, effective_at
        ) VALUES (0, 'UTC', 'USD', 2, 2)
      `
      )
      .run().lastInsertRowid;
    db.prepare(
      `
      UPDATE analysis_budget_settings
      SET pending_policy_revision = ?, pending_effective_at = 2
      WHERE singleton_id = 1
    `
    ).run(pending);
    assert.deepEqual(
      db
        .prepare(
          "SELECT active_policy_revision, pending_policy_revision, pending_effective_at FROM analysis_budget_settings"
        )
        .get(),
      {
        active_policy_revision: Number(zero),
        pending_policy_revision: Number(pending),
        pending_effective_at: 2,
      }
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_settings SET default_monthly_limit_microusd = 1 WHERE singleton_id = 1"
          )
          .run(),
      /immutable/i
    );
    assert.throws(
      () =>
        db.prepare("DELETE FROM analysis_budget_price_versions WHERE provider = 'minimax'").run(),
      /immutable/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO analysis_budget_settings (
               singleton_id, default_monthly_limit_microusd, currency
             ) VALUES (1, 0, 'USD')`
          )
          .run(),
      /immutable|replacement/i
    );
    assert.equal(
      db
        .prepare(
          "SELECT default_monthly_limit_microusd FROM analysis_budget_settings WHERE singleton_id = 1"
        )
        .get().default_monthly_limit_microusd,
      5_000_000
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO analysis_budget_price_versions (
               provider, model, operation, price_version, currency,
               input_per_million_microusd, output_per_million_microusd,
               billing_basis, created_at
             ) VALUES (
               'minimax', 'MiniMax-M2.7', 'session_analysis',
               'minimax-m2.7-standard-2026-07-16', 'USD', 1, 1,
               'paygo_list_price_equivalent', 1
             )`
          )
          .run(),
      /immutable|replacement/i
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT input_per_million_microusd, output_per_million_microusd
           FROM analysis_budget_price_versions
           WHERE operation = 'session_analysis'`
        )
        .get(),
      { input_per_million_microusd: 300_000, output_per_million_microusd: 1_200_000 }
    );
  } finally {
    db.close();
  }
});

test("period identity cannot overlap or be rewritten", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const revision = db
      .prepare(
        `
        INSERT INTO analysis_budget_policy_revisions (
          monthly_limit_microusd, timezone, currency, created_at, effective_at
        ) VALUES (5000000, 'Asia/Shanghai', 'USD', 1, 1)
      `
      )
      .run().lastInsertRowid;
    const insert = db.prepare(`
      INSERT INTO analysis_budget_periods (
        month_key, timezone, starts_at, ends_at, currency,
        monthly_limit_microusd, policy_revision, created_at
      ) VALUES (?, 'Asia/Shanghai', ?, ?, 'USD', 5000000, ?, 1)
    `);
    const periodId = insert.run("2026-07", 100, 200, revision).lastInsertRowid;
    assert.throws(() => insert.run("2026-08", 199, 300, revision), /overlap/i);
    assert.throws(
      () =>
        db
          .prepare(
            `
            INSERT INTO analysis_budget_periods (
              month_key, timezone, starts_at, ends_at, currency,
              monthly_limit_microusd, policy_revision, created_at
            ) VALUES ('2026-09', 'Asia/Shanghai', 300, 400, 'USD', 4000000, ?, 1)
          `
          )
          .run(revision),
      /policy snapshot/i
    );
    assert.throws(
      () =>
        db.prepare("UPDATE analysis_budget_periods SET starts_at = 99 WHERE id = ?").run(periodId),
      /immutable/i
    );
    const replacementRevision = db
      .prepare(
        `INSERT INTO analysis_budget_policy_revisions (
           monthly_limit_microusd, timezone, currency, created_at, effective_at
         ) VALUES (0, 'Asia/Shanghai', 'USD', 2, 2)`
      )
      .run().lastInsertRowid;
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE analysis_budget_periods
             SET monthly_limit_microusd = 0, policy_revision = ? WHERE id = ?`
          )
          .run(replacementRevision, periodId),
      /immutable/i
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT monthly_limit_microusd, policy_revision
           FROM analysis_budget_periods WHERE id = ?`
        )
        .get(periodId),
      { monthly_limit_microusd: 5_000_000, policy_revision: Number(revision) }
    );
  } finally {
    db.close();
  }
});

test("attempt rows enforce one logical request and the legal durable state transitions", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const revision = db
      .prepare(
        `
        INSERT INTO analysis_budget_policy_revisions (
          monthly_limit_microusd, timezone, currency, created_at, effective_at
        ) VALUES (5000000, 'Asia/Shanghai', 'USD', 1, 1)
      `
      )
      .run().lastInsertRowid;
    const periodId = db
      .prepare(
        `
        INSERT INTO analysis_budget_periods (
          month_key, timezone, starts_at, ends_at, currency,
          monthly_limit_microusd, policy_revision, created_at
        ) VALUES ('2026-07', 'Asia/Shanghai', 100, 200, 'USD', 5000000, ?, 1)
      `
      )
      .run(revision).lastInsertRowid;
    const otherRevision = db
      .prepare(
        `
        INSERT INTO analysis_budget_policy_revisions (
          monthly_limit_microusd, timezone, currency, created_at, effective_at
        ) VALUES (5000000, 'Asia/Shanghai', 'USD', 2, 2)
      `
      )
      .run().lastInsertRowid;
    const insert = db.prepare(`
      INSERT INTO analysis_budget_attempts (
        request_id, job_id, attempt_number, period_id, policy_revision,
        provider, model, operation, price_version, currency,
        input_per_million_microusd, output_per_million_microusd,
        estimated_input_tokens, estimated_output_tokens, reserved_microusd,
        state, created_at
      ) VALUES (
        ?, 'job-analysis-1', 1, ?, ?, 'minimax', 'MiniMax-M2.7',
        'session_analysis', 'minimax-m2.7-standard-2026-07-16', 'USD',
        300000, 1200000, 1000, 2048, 2758, 'reserved', 1
      )
    `);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_budget_attempts (
               request_id, job_id, attempt_number, period_id, policy_revision,
               provider, model, operation, price_version, currency,
               input_per_million_microusd, output_per_million_microusd,
               estimated_input_tokens, estimated_output_tokens, reserved_microusd,
               actual_input_tokens, actual_output_tokens, actual_microusd,
               state, created_at, started_at, finalized_at
             ) VALUES (
               'request-direct-terminal', 'job-direct-terminal', 1, ?, ?,
               'minimax', 'MiniMax-M2.7', 'session_analysis',
               'minimax-m2.7-standard-2026-07-16', 'USD',
               300000, 1200000, 1000, 2048, 2758,
               1, 1, 999999, 'reconciled', 1, 100, 2
             )`
          )
          .run(periodId, revision),
      /initial state|reserved/i
    );
    insert.run("request-1", periodId, revision);
    assert.throws(() => insert.run("request-2", periodId, revision), /unique/i);
    assert.throws(
      () => insert.run("request-wrong-policy", periodId, otherRevision),
      /period snapshot/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `
            INSERT INTO analysis_budget_attempts (
              request_id, job_id, attempt_number, period_id, policy_revision,
              provider, model, operation, price_version, currency,
              input_per_million_microusd, output_per_million_microusd,
              estimated_input_tokens, estimated_output_tokens, reserved_microusd,
              state, created_at
            ) VALUES (
              'request-wrong-cost', 'job-analysis-2', 1, ?, ?, 'minimax', 'MiniMax-M2.7',
              'session_analysis', 'minimax-m2.7-standard-2026-07-16', 'USD',
              300000, 1200000, 1000, 2048, 1, 'reserved', 1
            )
          `
          )
          .run(periodId, revision),
      /reservation cost/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_attempts SET state = 'released', reason_code = 'raw-provider-error', finalized_at = 2 WHERE request_id = 'request-1'"
          )
          .run(),
      /reason code/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_attempts SET state = 'reconciled', finalized_at = 2 WHERE request_id = 'request-1'"
          )
          .run(),
      /transition/i
    );
    db.prepare(
      "UPDATE analysis_budget_attempts SET state = 'started', started_at = 5 WHERE request_id = 'request-1'"
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE analysis_budget_attempts
             SET state = 'reconciled', started_at = 6,
                 actual_input_tokens = 1000, actual_output_tokens = 2000,
                 actual_microusd = 2700, finalized_at = 7
             WHERE request_id = 'request-1'`
          )
          .run(),
      /started_at|start time|immutable/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE analysis_budget_attempts
             SET state = 'reconciled', actual_input_tokens = 1000,
                 actual_output_tokens = 2000, actual_microusd = 2700, finalized_at = 4
             WHERE request_id = 'request-1'`
          )
          .run(),
      /constraint|finalized/i
    );
    db.prepare(
      `
      UPDATE analysis_budget_attempts
      SET state = 'reconciled', actual_input_tokens = 1000,
          actual_output_tokens = 2000, actual_microusd = 2700, finalized_at = 6
      WHERE request_id = 'request-1'
    `
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_budget_attempts SET actual_microusd = 1 WHERE request_id = 'request-1'"
          )
          .run(),
      /terminal|immutable/i
    );
  } finally {
    db.close();
  }
});

test("a hostile preexisting budget table rolls the v24 migration back without partial schema", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE analysis_budget_policy_revisions (hostile TEXT);
      PRAGMA user_version = 23;
    `);
    assert.throws(() => migrate(db, 23));
    assert.equal(db.pragma("user_version", { simple: true }), 23);
    assert.deepEqual(
      TABLES.filter((name) => tableNames(db).includes(name)),
      ["analysis_budget_policy_revisions"]
    );
  } finally {
    db.close();
  }
});

test("a same-shaped schema without the reviewed definitions fails closed", () => {
  const reference = new Database(":memory:");
  const db = new Database(":memory:");
  try {
    migrate(reference);
    const triggerOwners = reference
      .prepare(
        `SELECT name, tbl_name FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name LIKE 'analysis_budget_%'
         ORDER BY name`
      )
      .all();
    for (const table of TABLES) {
      const columnList = reference
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => `"${column.name}" BLOB`)
        .join(", ");
      db.exec(`CREATE TABLE "${table}" (${columnList})`);
    }
    for (const trigger of triggerOwners) {
      db.exec(
        `CREATE TRIGGER "${trigger.name}" BEFORE UPDATE ON "${trigger.tbl_name}"
         BEGIN SELECT 1; END`
      );
    }
    db.prepare(
      `INSERT INTO analysis_budget_settings (
         singleton_id, default_monthly_limit_microusd, currency
       ) VALUES (1, 5000000, 'USD')`
    ).run();
    const insertPrice = db.prepare(
      `INSERT INTO analysis_budget_price_versions (
         provider, model, operation, price_version, currency,
         input_per_million_microusd, output_per_million_microusd,
         billing_basis, created_at
       ) VALUES (
         'minimax', 'MiniMax-M2.7', ?, 'minimax-m2.7-standard-2026-07-16',
         'USD', 300000, 1200000, 'paygo_list_price_equivalent', ?
       )`
    );
    insertPrice.run("session_analysis", Date.UTC(2026, 6, 16));
    insertPrice.run("daily_digest", Date.UTC(2026, 6, 16));
    db.pragma("user_version = 23");

    assert.throws(() => migrate(db), /schema collision/i);
    assert.equal(db.pragma("user_version", { simple: true }), 23);
  } finally {
    reference.close();
    db.close();
  }
});
