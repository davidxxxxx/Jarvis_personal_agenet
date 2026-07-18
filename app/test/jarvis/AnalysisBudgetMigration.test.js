const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");
const AnalysisBudgetRepository = require("../../src/jarvis/main/AnalysisBudgetRepository");

const LEGACY_V24_ATTEMPT_PERIOD_TRIGGER = `
  CREATE TRIGGER analysis_budget_attempts_validate_period
  BEFORE INSERT ON analysis_budget_attempts
  WHEN NOT EXISTS (
    SELECT 1 FROM analysis_budget_periods AS period
    WHERE period.id = NEW.period_id
      AND period.policy_revision = NEW.policy_revision
      AND period.currency = NEW.currency
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis budget attempt period snapshot mismatch');
  END;
`;

const TABLES = [
  "analysis_budget_policy_revisions",
  "analysis_budget_policy_modes",
  "analysis_budget_settings",
  "analysis_budget_periods",
  "analysis_budget_period_modes",
  "analysis_budget_price_versions",
  "analysis_budget_attempts",
];

test("latest migration adds explicit immutable policy and period budget modes", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repository = new AnalysisBudgetRepository(db);
    repository.initialize({
      mode: "capped",
      monthlyLimitMicrousd: 5_000_000,
      timezone: "Asia/Shanghai",
      at: 1_720_992_000_000,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT mode, monthly_limit_microusd
           FROM analysis_budget_policy_modes ORDER BY policy_revision`
        )
        .all(),
      [{ mode: "capped", monthly_limit_microusd: 5_000_000 }]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT mode, monthly_limit_microusd
           FROM analysis_budget_period_modes ORDER BY period_id`
        )
        .all(),
      [{ mode: "capped", monthly_limit_microusd: 5_000_000 }]
    );
    assert.throws(
      () => db.prepare("UPDATE analysis_budget_policy_modes SET mode = 'unlimited'").run(),
      /immutable/
    );
  } finally {
    db.close();
  }
});

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

function replaceTodosWithHistoricalV23Schema(db) {
  const historicalTriggers = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'todos_v2'
       ORDER BY name`
    )
    .all()
    .filter(
      ({ name }) =>
        !new Set([
          "todos_v2_validate_owner_shape_insert",
          "todos_v2_validate_owner_shape_update",
          "todos_v2_validate_owner_binding",
          "todos_v2_validate_owner_binding_update",
        ]).has(name)
    )
    .map(({ name, sql }) => ({
      name,
      sql:
        name === "todos_v2_immutable_content"
          ? sql.replace(
              "owner_subject_id, owner_display_name_snapshot, recurrence_of_id",
              "owner_subject_id, recurrence_of_id"
            )
          : sql,
    }));

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      ALTER TABLE todos_v2 RENAME TO todos_v24_fixture;
      CREATE TABLE todos_v2 (
        id TEXT PRIMARY KEY,
        canonical_base_key TEXT NOT NULL CHECK(
          typeof(canonical_base_key) = 'text' AND length(canonical_base_key) = 64
          AND canonical_base_key NOT GLOB '*[^0-9a-f]*'
        ),
        instance_key TEXT NOT NULL UNIQUE CHECK(
          typeof(instance_key) = 'text' AND length(instance_key) = 64
          AND instance_key NOT GLOB '*[^0-9a-f]*'
        ),
        title TEXT NOT NULL CHECK(typeof(title) = 'text' AND length(trim(title)) > 0),
        owner_subject_kind TEXT CHECK(
          owner_subject_kind IS NULL OR (
            typeof(owner_subject_kind) = 'text'
            AND owner_subject_kind IN ('person','speaker_cluster')
          )
        ),
        owner_subject_id TEXT CHECK(
          owner_subject_id IS NULL OR (
            typeof(owner_subject_id) = 'text' AND length(owner_subject_id) > 0
          )
        ),
        status TEXT NOT NULL CHECK(
          typeof(status) = 'text' AND status IN ('open','completed','dismissed')
        ),
        completed_at INTEGER CHECK(
          completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= 0)
        ),
        dismissed_at INTEGER CHECK(
          dismissed_at IS NULL OR (typeof(dismissed_at) = 'integer' AND dismissed_at >= 0)
        ),
        recurrence_of_id TEXT REFERENCES todos_v2(id) ON DELETE SET NULL,
        source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
        provenance TEXT NOT NULL CHECK(
          typeof(provenance) = 'text'
          AND provenance IN ('evidence_linked','legacy_unverified','suggestion','source_deleted')
        ),
        created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
        CHECK((owner_subject_kind IS NULL) = (owner_subject_id IS NULL)),
        CHECK(
          (status = 'open' AND completed_at IS NULL AND dismissed_at IS NULL)
          OR (status = 'completed' AND completed_at IS NOT NULL AND dismissed_at IS NULL)
          OR (status = 'dismissed' AND dismissed_at IS NOT NULL AND completed_at IS NULL)
        ),
        CHECK(recurrence_of_id IS NULL OR recurrence_of_id <> id)
      );
      DROP TABLE todos_v24_fixture;
    `);
    for (const trigger of historicalTriggers) db.exec(trigger.sql);
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

function createRepresentativeV23Database() {
  const db = new Database(":memory:");
  migrate(db);
  replaceTodosWithHistoricalV23Schema(db);
  const cloudPayload = JSON.stringify({ inputVersion: "jarvis-analysis-input-v2" });
  db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('preserved-v23-session', 10, 20, 'completed', 10);
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at) VALUES
      ('person-bound', 'Bound snapshot', 1, 10, 20),
      ('person-live', 'Live person', 0, 10, 20);
    INSERT INTO speaker_clusters (
      id, session_id, local_label, model_id, person_id, link_state, created_at, updated_at
    ) VALUES (
      'cluster-live', 'preserved-v23-session', 'speaker_live', 'speaker-v1',
      NULL, 'unknown', 20, 20
    );
    INSERT INTO analysis_inputs (
      id, session_id, transcript_revision, identity_revision, prompt_version,
      input_hash, input_contract_version, redaction_version, cloud_payload_json,
      cloud_payload_bytes, cloud_payload_sha256, created_at
    ) VALUES (
      'input-v23', 'preserved-v23-session', '${"a".repeat(64)}', '${"b".repeat(64)}',
      'jarvis-analysis-v2', '${"c".repeat(64)}', 'jarvis-analysis-input-v2',
      'jarvis-redaction-v1', '${cloudPayload}', ${Buffer.byteLength(cloudPayload, "utf8")},
      '${"d".repeat(64)}', 20
    );
    INSERT INTO analysis_input_speaker_bindings (
      analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
    ) VALUES ('input-v23', 'SELF', 'person', 'person-bound', 'Bound snapshot');
    UPDATE people SET display_name = 'Renamed live person' WHERE id = 'person-bound';
    INSERT INTO todos_v2 (
      id, canonical_base_key, instance_key, title, owner_subject_kind, owner_subject_id,
      status, source_analysis_input_id, provenance, created_at, updated_at
    ) VALUES
      ('todo-binding', '${"1".repeat(64)}', '${"1".repeat(64)}', 'Binding snapshot',
       'person', 'person-bound', 'open', 'input-v23', 'evidence_linked', 20, 20),
      ('todo-live-person', '${"2".repeat(64)}', '${"2".repeat(64)}', 'Live person',
       'person', 'person-live', 'open', NULL, 'legacy_unverified', 20, 20),
      ('todo-live-cluster', '${"3".repeat(64)}', '${"3".repeat(64)}', 'Live cluster',
       'speaker_cluster', 'cluster-live', 'open', NULL, 'legacy_unverified', 20, 20),
      ('todo-missing-person', '${"4".repeat(64)}', '${"4".repeat(64)}', 'Missing person',
       'person', 'missing-person', 'open', NULL, 'legacy_unverified', 20, 20),
      ('todo-missing-cluster', '${"5".repeat(64)}', '${"5".repeat(64)}', 'Missing cluster',
       'speaker_cluster', 'missing-cluster', 'open', NULL, 'legacy_unverified', 20, 20),
      ('todo-unowned', '${"6".repeat(64)}', '${"6".repeat(64)}', 'Unowned',
       NULL, NULL, 'open', 'input-v23', 'evidence_linked', 20, 20);
    DROP TABLE analysis_budget_attempts;
    DROP TABLE analysis_budget_period_modes;
    DROP TABLE analysis_budget_policy_modes;
    DROP TABLE analysis_budget_periods;
    DROP TABLE analysis_budget_settings;
    DROP TABLE analysis_budget_price_versions;
    DROP TABLE analysis_budget_policy_revisions;
    PRAGMA user_version = 23;
  `);
  return db;
}

test("latest migration retains the durable v25 budget schema and reviewed MiniMax price rows", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(TARGET_VERSION, 31);
    assert.deepEqual(migrate(db), { fromVersion: 0, toVersion: TARGET_VERSION });
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
    assert.equal(
      db
        .prepare("PRAGMA table_info(todos_v2)")
        .all()
        .some(({ name }) => name === "owner_display_name_snapshot"),
      false
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM todos_v2").get().count, 6);
    assert.doesNotMatch(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'trigger' AND name = 'todos_v2_immutable_content'`
        )
        .get().sql,
      /owner_display_name_snapshot/
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'todos_v2_validate_owner_%'
           ORDER BY name`
        )
        .all(),
      []
    );
    assert.deepEqual(migrate(db), { fromVersion: 23, toVersion: TARGET_VERSION });
    assert.deepEqual(db.prepare("SELECT id, status FROM sessions").get(), {
      id: "preserved-v23-session",
      status: "completed",
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, owner_display_name_snapshot
           FROM todos_v2
           ORDER BY id`
        )
        .all(),
      [
        { id: "todo-binding", owner_display_name_snapshot: "Bound snapshot" },
        { id: "todo-live-cluster", owner_display_name_snapshot: "speaker_live" },
        { id: "todo-live-person", owner_display_name_snapshot: "Live person" },
        { id: "todo-missing-cluster", owner_display_name_snapshot: "[Unknown speaker]" },
        { id: "todo-missing-person", owner_display_name_snapshot: "[Unknown person]" },
        { id: "todo-unowned", owner_display_name_snapshot: null },
      ]
    );
    assert.throws(
      () =>
        db.exec(`
          INSERT INTO todos_v2 (
            id, canonical_base_key, instance_key, title,
            owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
            status, source_analysis_input_id, provenance, created_at, updated_at
          ) VALUES (
            'todo-invalid-shape', '${"7".repeat(64)}', '${"7".repeat(64)}',
            'Invalid shape', 'person', 'person-live', '   ', 'open', NULL,
            'legacy_unverified', 20, 20
          )
        `),
      /todo owner shape is invalid/
    );
    assert.throws(
      () =>
        db.exec(`
          INSERT INTO todos_v2 (
            id, canonical_base_key, instance_key, title,
            owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
            status, source_analysis_input_id, provenance, created_at, updated_at
          ) VALUES (
            'todo-invalid-binding', '${"8".repeat(64)}', '${"8".repeat(64)}',
            'Invalid binding', 'person', 'person-bound', 'Renamed live person', 'open',
            'input-v23', 'evidence_linked', 20, 20
          )
        `),
      /todo owner binding is invalid/
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO todos_v2 (
             id, canonical_base_key, instance_key, title,
             owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
             status, source_analysis_input_id, provenance, created_at, updated_at
           ) VALUES (
             'todo-valid-binding', ?, ?, 'Valid binding',
             'person', 'person-bound', 'Bound snapshot', 'open',
             'input-v23', 'evidence_linked', 20, 20
           )`
        )
        .run("9".repeat(64), "9".repeat(64)).changes,
      1
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO todos_v2 (
             id, canonical_base_key, instance_key, title,
             owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
             status, source_analysis_input_id, provenance, created_at, updated_at
           ) VALUES (
             'todo-valid-unowned', ?, ?, 'Valid unowned model todo',
             NULL, NULL, NULL, 'open', 'input-v23', 'evidence_linked', 20, 20
           )`
        )
        .run("a".repeat(64), "a".repeat(64)).changes,
      1
    );
    assert.throws(
      () =>
        db.exec(`
          UPDATE todos_v2
          SET owner_display_name_snapshot = 'Wrong binding'
          WHERE id = 'todo-binding'
        `),
      /todo owner binding is invalid/
    );
    assert.throws(
      () =>
        db.exec(`
          UPDATE todos_v2
          SET owner_display_name_snapshot = '   '
          WHERE id = 'todo-live-person'
        `),
      /todo owner shape is invalid/
    );
    assert.throws(
      () =>
        db.exec(`
          UPDATE todos_v2
          SET owner_display_name_snapshot = 'Hostile rewrite'
          WHERE id = 'todo-live-person'
        `),
      /todo content is immutable/
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const first = db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY type, name").all();
    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY type, name").all(),
      first
    );
  } finally {
    db.close();
  }
});

test("a base v24 database replaces the legacy period trigger before revised-policy reserve", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`
      DROP TRIGGER analysis_budget_attempts_validate_period;
      ${LEGACY_V24_ATTEMPT_PERIOD_TRIGGER}
      PRAGMA user_version = 24;
    `);
    assert.match(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'trigger' AND name = 'analysis_budget_attempts_validate_period'`
        )
        .get().sql,
      /period\.policy_revision = NEW\.policy_revision/
    );

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 24, toVersion: TARGET_VERSION });
    const upgradedSql = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'analysis_budget_attempts_validate_period'`
      )
      .get().sql;
    assert.match(upgradedSql, /period\.starts_at <= NEW\.created_at/);
    assert.match(upgradedSql, /ORDER BY latest\.effective_at DESC, latest\.revision DESC/);

    const repository = new AnalysisBudgetRepository(db);
    const at = Date.UTC(2026, 6, 15, 4);
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
    assert.equal(
      repository.reserve({
        requestId: "request-upgraded-v24",
        jobId: "job-upgraded-v24",
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        estimatedUsage: { inputTokens: 1, outputTokens: 1 },
        at: at + 2,
      }).ok,
      true
    );
  } finally {
    db.close();
  }
});

test("v29 rejects an incomplete v23 foundation without mutating the OpenAI correction ledger", () => {
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

    assert.throws(() => migrate(db, 23), /v29 daily digest foundation/i);
    assert.equal(db.pragma("user_version", { simple: true }), 23);

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
        ) VALUES ('2026-07', 'Asia/Shanghai', 1, 200, 'USD', 5000000, ?, 1)
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

test("a hostile preexisting budget table rolls the budget migration back without partial schema", () => {
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
