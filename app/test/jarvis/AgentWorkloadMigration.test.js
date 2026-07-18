"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  TARGET_VERSION,
  applyJarvisMigrations,
  upgradeAgentWorkloadV26,
} = require("../../src/jarvis/main/JarvisMigrations");

function schemaNames(db, type) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map(({ name }) => name);
}

test("v26 creates durable desired-head, candidate, and explicit processing-lane contracts", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    assert.equal(TARGET_VERSION, 31);
    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 0, toVersion: TARGET_VERSION });

    const tables = schemaNames(db, "table");
    assert.ok(tables.includes("analysis_desired_heads"));
    assert.ok(tables.includes("analysis_response_candidates"));

    const processingColumns = new Map(
      db.pragma("table_info(processing_jobs)").map((column) => [column.name, column])
    );
    assert.equal(processingColumns.get("lane").notnull, 1);
    assert.equal(processingColumns.get("lane").dflt_value, "'local'");
    assert.ok(processingColumns.has("analysis_input_id"));
    assert.ok(processingColumns.has("desired_head_hash"));

    const indexes = schemaNames(db, "index");
    assert.ok(indexes.includes("idx_processing_jobs_cloud_claim"));
    assert.ok(indexes.includes("idx_processing_jobs_analysis_input"));
    assert.ok(indexes.includes("idx_analysis_candidates_recovery"));

    const triggers = schemaNames(db, "trigger");
    for (const name of [
      "processing_jobs_cloud_contract_insert",
      "processing_jobs_cloud_contract_update",
      "analysis_desired_heads_validate_insert",
      "analysis_desired_heads_validate_update",
      "analysis_response_candidates_validate_insert",
      "analysis_response_candidates_immutable_update",
      "analysis_response_candidates_immutable_delete",
      "analysis_response_candidates_disposition_cas",
    ]) {
      assert.ok(triggers.includes(name), name);
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v26 migrates only unfinished cloud priorities and leaves unknown work local", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-v25', 1, 2, 'completed', 1);
      DROP TRIGGER processing_jobs_cloud_contract_insert;
      DROP TRIGGER processing_jobs_cloud_contract_update;
      PRAGMA ignore_check_constraints = ON;
    `);
    const insert = db.prepare(`
      INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash, input_version,
        model_version, lane, created_at, completed_at
      ) VALUES (?, 'session-v25', ?, ?, ?, ?, 1, 'legacy', 'local', 1, ?)
    `);
    insert.run("analysis-open", "analyze_session", "retry", 50, "analysis-open", null);
    insert.run("analysis-done", "analyze_session", "completed", 50, "analysis-done", 2);
    insert.run("digest-open", "generate_daily_digest", "pending", 50, "digest-open", null);
    insert.run("unknown-open", "future_job", "pending", 7, "unknown-open", null);

    upgradeAgentWorkloadV26(db);
    db.pragma("ignore_check_constraints = OFF");
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, priority, lane FROM processing_jobs
           WHERE id IN ('analysis-open','analysis-done','digest-open','unknown-open')
           ORDER BY id`
        )
        .all(),
      [
        { id: "analysis-done", priority: 50, lane: "cloud" },
        { id: "analysis-open", priority: 70, lane: "cloud" },
        { id: "digest-open", priority: 80, lane: "cloud" },
        { id: "unknown-open", priority: 7, lane: "local" },
      ]
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO processing_jobs (
               id, session_id, job_type, state, priority, input_hash,
               input_version, model_version, lane, created_at
             ) VALUES ('bad-cloud', 'session-v25', 'future_job', 'pending', 70,
                       'bad-cloud', 1, 'future', 'cloud', 3)`
          )
          .run(),
      /invalid cloud processing job/
    );
  } finally {
    db.close();
  }
});
