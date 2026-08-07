"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const {
  applyJarvisMigrations,
  TARGET_VERSION,
  upgradeKnowledgeActionProjectionBackfillV57,
} = require("../../src/jarvis/main/JarvisMigrations");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

const APP_ROOT = path.resolve(__dirname, "../..");
const GATE_ROOT = path.join(APP_ROOT, ".tmp-tests", "v58-release-migration-gate");
const AT = 1_786_700_000_000;
let caseSequence = 0;

const DURABLE_TABLES = [
  "sessions",
  "people",
  "audio_tracks",
  "audio_chunks",
  "transcript_segments",
  "analysis_inputs",
  "analysis_input_speaker_bindings",
  "analysis_input_segments",
  "analysis_desired_heads",
  "todos_v2",
  "todo_revisions",
  "todo_occurrences",
  "todo_state_transitions",
  "suggestions_v2",
  "suggestion_occurrences",
  "session_summary_revisions",
  "personalization_feedback",
  "personalization_feedback_events",
  "todo_action_metadata",
  "suggestion_action_metadata",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertSafeGatePath(value) {
  const resolved = path.resolve(value);
  assert.equal(
    path.parse(resolved).root.toUpperCase(),
    "G:\\",
    "migration fixtures must stay on G:"
  );
  assert.equal(
    resolved.startsWith(`${path.resolve(APP_ROOT)}${path.sep}`),
    true,
    "migration fixtures must stay under the worktree app root"
  );
  return resolved;
}

function createCaseDirectory(label) {
  assertSafeGatePath(GATE_ROOT);
  fs.mkdirSync(GATE_ROOT, { recursive: true });
  const directory = path.join(GATE_ROOT, `${label}-${process.pid}-${Date.now()}-${++caseSequence}`);
  assertSafeGatePath(directory);
  fs.mkdirSync(directory);
  return directory;
}

function removeCaseDirectory(directory) {
  assertSafeGatePath(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

function downgradeAnalysisSchemaToV57(db) {
  const inputTriggers = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'analysis_inputs'
       ORDER BY name`
    )
    .all();
  const segmentTriggers = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'analysis_input_segments'
         AND name <> 'analysis_input_segments_validate_context'
       ORDER BY name`
    )
    .all();
  const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
  const previousLegacyAlterTable = db.pragma("legacy_alter_table", { simple: true });
  if (foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      for (const trigger of [...inputTriggers, ...segmentTriggers]) {
        db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`);
      }
      db.exec("DROP TRIGGER IF EXISTS analysis_input_segments_validate_context");
      db.exec(`
        ALTER TABLE analysis_input_segments RENAME TO analysis_input_segments_v58;
        CREATE TABLE analysis_input_segments (
          analysis_input_id TEXT NOT NULL REFERENCES analysis_inputs(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK(typeof(ordinal) = 'integer' AND ordinal >= 0),
          segment_id TEXT NOT NULL REFERENCES transcript_segments(id)
            ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
          segment_version INTEGER NOT NULL CHECK(
            typeof(segment_version) = 'integer' AND segment_version >= 1
          ),
          text_hash TEXT NOT NULL CHECK(
            typeof(text_hash) = 'text' AND length(text_hash) = 64
            AND text_hash NOT GLOB '*[^0-9a-f]*'
          ),
          text_snapshot TEXT NOT NULL CHECK(
            typeof(text_snapshot) = 'text' AND length(text_snapshot) > 0
          ),
          speaker_binding_label TEXT NOT NULL,
          PRIMARY KEY(analysis_input_id, ordinal),
          UNIQUE(analysis_input_id, segment_id),
          FOREIGN KEY(analysis_input_id, speaker_binding_label)
            REFERENCES analysis_input_speaker_bindings(analysis_input_id, label)
            ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
        );
        INSERT INTO analysis_input_segments (
          analysis_input_id, ordinal, segment_id, segment_version,
          text_hash, text_snapshot, speaker_binding_label
        )
        SELECT analysis_input_id, ordinal, segment_id, segment_version,
               text_hash, text_snapshot, speaker_binding_label
        FROM analysis_input_segments_v58;
        DROP TABLE analysis_input_segments_v58;

        ALTER TABLE analysis_inputs RENAME TO analysis_inputs_v58;
        CREATE TABLE analysis_inputs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          transcript_revision TEXT NOT NULL CHECK(
            typeof(transcript_revision) = 'text' AND length(transcript_revision) = 64
            AND transcript_revision NOT GLOB '*[^0-9a-f]*'
          ),
          identity_revision TEXT NOT NULL CHECK(
            typeof(identity_revision) = 'text' AND length(identity_revision) = 64
            AND identity_revision NOT GLOB '*[^0-9a-f]*'
          ),
          prompt_version TEXT NOT NULL CHECK(
            typeof(prompt_version) = 'text' AND length(trim(prompt_version)) BETWEEN 1 AND 128
          ),
          input_hash TEXT NOT NULL UNIQUE CHECK(
            typeof(input_hash) = 'text' AND length(input_hash) = 64
            AND input_hash NOT GLOB '*[^0-9a-f]*'
          ),
          input_contract_version TEXT NOT NULL CHECK(
            typeof(input_contract_version) = 'text'
            AND input_contract_version = 'jarvis-analysis-input-v2'
          ),
          redaction_version TEXT NOT NULL CHECK(
            typeof(redaction_version) = 'text'
            AND redaction_version = 'jarvis-redaction-v1'
          ),
          cloud_payload_json TEXT NOT NULL CHECK(
            CASE
              WHEN typeof(cloud_payload_json) = 'text' AND json_valid(cloud_payload_json)
              THEN COALESCE(
                json_type(cloud_payload_json) = 'object'
                AND json_extract(cloud_payload_json, '$.inputVersion') = input_contract_version,
                0
              )
              ELSE 0
            END
          ),
          cloud_payload_bytes INTEGER NOT NULL CHECK(
            typeof(cloud_payload_bytes) = 'integer'
            AND cloud_payload_bytes BETWEEN 2 AND 98304
            AND length(CAST(cloud_payload_json AS BLOB)) = cloud_payload_bytes
          ),
          cloud_payload_sha256 TEXT NOT NULL CHECK(
            typeof(cloud_payload_sha256) = 'text' AND length(cloud_payload_sha256) = 64
            AND cloud_payload_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          candidate_hash TEXT CHECK(
            candidate_hash IS NULL OR (
              typeof(candidate_hash) = 'text' AND length(candidate_hash) = 64
              AND candidate_hash NOT GLOB '*[^0-9a-f]*'
            )
          ),
          applied_at INTEGER CHECK(
            applied_at IS NULL OR (typeof(applied_at) = 'integer' AND applied_at >= 0)
          ),
          created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
          CHECK(
            (candidate_hash IS NULL AND applied_at IS NULL)
            OR (candidate_hash IS NOT NULL AND applied_at IS NOT NULL)
          )
        );
        INSERT INTO analysis_inputs (
          id, session_id, transcript_revision, identity_revision, prompt_version,
          input_hash, input_contract_version, redaction_version, cloud_payload_json,
          cloud_payload_bytes, cloud_payload_sha256, candidate_hash, applied_at, created_at
        )
        SELECT id, session_id, transcript_revision, identity_revision, prompt_version,
               input_hash, input_contract_version, redaction_version, cloud_payload_json,
               cloud_payload_bytes, cloud_payload_sha256, candidate_hash, applied_at, created_at
        FROM analysis_inputs_v58;
        DROP TABLE analysis_inputs_v58;
        CREATE INDEX idx_analysis_inputs_session_created
        ON analysis_inputs(session_id, created_at);
      `);
      for (const trigger of inputTriggers) db.exec(trigger.sql);
      for (const trigger of segmentTriggers) db.exec(trigger.sql);
    })();
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlterTable ? "ON" : "OFF"}`);
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}

function seedV2LineageAndActions(db, version) {
  const suffix = `v${version}`;
  const personId = `person-self-${suffix}`;
  const sessionId = `session-${suffix}`;
  const trackId = `track-${suffix}`;
  const chunkId = `chunk-${suffix}`;
  const segmentId = `segment-${suffix}`;
  const inputId = `analysis-input-${suffix}`;
  const todoId = `todo-${suffix}`;
  const suggestionId = `suggestion-${suffix}`;
  const inputHash = sha256(`input:${suffix}`);
  const transcriptRevision = sha256(`transcript:${suffix}`);
  const identityRevision = sha256(`identity:${suffix}`);
  const promptVersion = "jarvis-analysis-v2";
  const payload = JSON.stringify({ inputVersion: "jarvis-analysis-input-v2", fixture: suffix });
  const cloudPayloadHash = sha256(payload);
  const desiredVector = JSON.stringify({
    analysisInputId: inputId,
    analysisInputHash: inputHash,
    transcriptRevision,
    identityRevision,
    promptVersion,
    cloudPayloadHash,
    segments: [{ id: segmentId, version: 1 }],
  });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
       VALUES (?, ?, 1, ?, ?)`
    ).run(personId, `Local Self ${suffix}`, AT, AT);
    db.prepare(
      `INSERT INTO sessions (id, started_at, ended_at, status, created_at)
       VALUES (?, ?, ?, 'completed', ?)`
    ).run(sessionId, AT, AT + 10_000, AT);
    db.prepare(
      `INSERT INTO audio_tracks (
         id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
       ) VALUES (?, ?, 'mic', 24000, 1, ?, ?, 'stopped')`
    ).run(trackId, sessionId, AT, AT + 10_000);
    db.prepare(
      `INSERT INTO audio_chunks (
         id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
         transcription_status, track_id, source_type, sequence_number, write_state
       ) VALUES (?, ?, ?, ?, ?, 10000, ?, ?, 'completed', ?, 'mic', 0, 'committed')`
    ).run(
      chunkId,
      sessionId,
      `${suffix}.wav`,
      AT,
      AT + 10_000,
      sha256(`chunk:${suffix}`),
      AT + 86_400_000,
      trackId
    );
    db.prepare(
      `INSERT INTO transcript_segments (
         id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
         is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
         version, model_version, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'SELF', ?, 0.98, 1, 'analyzed', ?, ?, 'mic', 'final',
                 1, 'fixture-whisper', ?)`
    ).run(
      segmentId,
      sessionId,
      AT,
      AT + 10_000,
      personId,
      `durable v2 evidence ${suffix}`,
      trackId,
      chunkId,
      AT + 10_000
    );
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (?, ?, ?, ?, 'jarvis-analysis-v2', ?, 'jarvis-analysis-input-v2',
                 'jarvis-redaction-v1', ?, ?, ?, ?)`
    ).run(
      inputId,
      sessionId,
      transcriptRevision,
      identityRevision,
      inputHash,
      payload,
      Buffer.byteLength(payload, "utf8"),
      cloudPayloadHash,
      AT + 10_001
    );
    db.prepare(
      `INSERT INTO analysis_input_speaker_bindings (
         analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
       ) VALUES (?, 'SELF', 'person', ?, ?)`
    ).run(inputId, personId, `Local Self ${suffix}`);
    db.prepare(
      `INSERT INTO analysis_input_segments (
         analysis_input_id, ordinal, segment_id, segment_version,
         text_hash, text_snapshot, speaker_binding_label
       ) VALUES (?, 0, ?, 1, ?, ?, 'SELF')`
    ).run(
      inputId,
      segmentId,
      sha256(`durable v2 evidence ${suffix}`),
      `durable v2 evidence ${suffix}`
    );
    db.prepare(
      `INSERT INTO analysis_desired_heads (
         session_id, analysis_input_id, analysis_input_hash, desired_vector_json,
         desired_vector_hash, head_revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      sessionId,
      inputId,
      inputHash,
      desiredVector,
      sha256(desiredVector),
      AT + 10_002,
      AT + 10_002
    );

    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title, status, source_analysis_input_id,
         provenance, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'open', ?, 'evidence_linked', ?, ?)`
    ).run(
      todoId,
      sha256(`todo-base:${suffix}`),
      sha256(`todo-instance:${suffix}`),
      `Durable todo ${suffix}`,
      inputId,
      AT + 10_003,
      AT + 10_003
    );
    db.prepare(
      `INSERT INTO todo_revisions (
         id, todo_instance_id, revision, title, source_analysis_input_id, provenance, created_at
       ) VALUES (?, ?, 1, ?, ?, 'evidence_linked', ?)`
    ).run(`todo-revision-${suffix}`, todoId, `Durable todo ${suffix}`, inputId, AT + 10_003);
    db.prepare(
      `INSERT INTO todo_occurrences (
         id, todo_instance_id, todo_revision_id, analysis_input_id,
         occurrence_key, candidate_item_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `todo-occurrence-${suffix}`,
      todoId,
      `todo-revision-${suffix}`,
      inputId,
      sha256(`todo-occurrence:${suffix}`),
      sha256(`todo-candidate:${suffix}`),
      AT + 10_003
    );
    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason,
         source_analysis_input_id, actor, occurred_at
       ) VALUES (?, ?, NULL, 'open', 'analysis_created', ?, 'system', ?)`
    ).run(`todo-transition-${suffix}`, todoId, inputId, AT + 10_003);

    db.prepare(
      `INSERT INTO suggestions_v2 (
         id, canonical_key, title, rationale, state, source_analysis_input_id,
         provenance, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'proposed', ?, 'suggestion', ?, ?)`
    ).run(
      suggestionId,
      sha256(`suggestion:${suffix}`),
      `Durable suggestion ${suffix}`,
      `Rationale ${suffix}`,
      inputId,
      AT + 10_004,
      AT + 10_004
    );
    db.prepare(
      `INSERT INTO suggestion_occurrences (
         id, suggestion_id, analysis_input_id, occurrence_key,
         candidate_item_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `suggestion-occurrence-${suffix}`,
      suggestionId,
      inputId,
      sha256(`suggestion-occurrence:${suffix}`),
      sha256(`suggestion-candidate:${suffix}`),
      AT + 10_004
    );
    db.prepare(
      `INSERT INTO session_summary_revisions (
         id, session_id, revision, completeness, lifecycle, content_json,
         source_analysis_input_id, provenance, created_at
       ) VALUES (?, ?, 1, 'final', 'active', ?, ?, 'evidence_linked', ?)`
    ).run(
      `summary-${suffix}`,
      sessionId,
      JSON.stringify({ summary: `Durable summary ${suffix}` }),
      inputId,
      AT + 10_005
    );
    db.prepare(
      `INSERT INTO personalization_feedback (
         id, domain, source_entity_id, original_value, corrected_value,
         pattern_key, feature_json, occurred_at
       ) VALUES (?, 'suggestion', ?, 'visible', 'lower_priority', ?, ?, ?)`
    ).run(
      `legacy-feedback-${suffix}`,
      suggestionId,
      sha256(`feedback-pattern:${suffix}`),
      JSON.stringify({ fixture: suffix }),
      AT + 10_006
    );
    if (version >= 55) {
      db.prepare(
        `INSERT INTO personalization_feedback_events (
           id, domain, source_entity_id, event_state, original_value,
           corrected_value, pattern_key, feature_json, occurred_at
         ) VALUES (?, 'suggestion', ?, 'active', 'visible',
                   'lower_priority', ?, ?, ?)`
      ).run(
        `feedback-event-${suffix}`,
        suggestionId,
        sha256(`feedback-event-pattern:${suffix}`),
        JSON.stringify({ fixture: suffix, event: true }),
        AT + 10_007
      );
    }
  })();

  if (version === 57) upgradeKnowledgeActionProjectionBackfillV57(db);

  return { inputId, sessionId, todoId, suggestionId, segmentId };
}

function createLegacyFixture(filename, version) {
  assert.ok([54, 56, 57].includes(version));
  const db = new Database(filename);
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db, { now: () => AT });
    downgradeAnalysisSchemaToV57(db);
    if (version === 54) {
      db.exec(`
        DROP TRIGGER personalization_feedback_events_immutable_update;
        DROP TRIGGER personalization_feedback_events_immutable_delete;
        DROP TABLE personalization_feedback_events;
      `);
    }
    const ids = seedV2LineageAndActions(db, version);
    db.pragma(`user_version = ${version}`);
    assertLegacyShape(db, version);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    return ids;
  } finally {
    db.close();
  }
}

function assertLegacyShape(db, version) {
  assert.equal(db.pragma("user_version", { simple: true }), version);
  const inputSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analysis_inputs'")
    .get().sql;
  assert.match(inputSql, /input_contract_version = 'jarvis-analysis-input-v2'/u);
  assert.doesNotMatch(inputSql, /jarvis-analysis-input-v3/u);
  assert.equal(
    db
      .pragma("table_info(analysis_input_segments)")
      .some((column) => column.name === "application_key"),
    false
  );
  assert.equal(
    db
      .prepare(
        `SELECT count(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'personalization_feedback_events'`
      )
      .get().count,
    version === 54 ? 0 : 1
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM todo_action_metadata").get().count,
    version === 57 ? 1 : 0
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM suggestion_action_metadata").get().count,
    version === 57 ? 1 : 0
  );
}

function tableCount(db, table) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return exists
    ? db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get().count
    : null;
}

function durableCounts(db) {
  return Object.fromEntries(DURABLE_TABLES.map((table) => [table, tableCount(db, table)]));
}

function assertNoV57ForeignKeyTargets(db) {
  const staleMasterObjects = db
    .prepare(
      `SELECT type, name, tbl_name FROM sqlite_master
       WHERE sql IS NOT NULL AND lower(sql) LIKE '%analysis_inputs_v57%'
       ORDER BY type, name`
    )
    .all();
  assert.deepEqual(staleMasterObjects, []);

  const staleForeignKeys = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of tables) {
    for (const foreignKey of db.pragma(`foreign_key_list(${quoteIdentifier(name)})`)) {
      if (foreignKey.table === "analysis_inputs_v57") {
        staleForeignKeys.push({ table: name, foreignKey });
      }
    }
  }
  assert.deepEqual(staleForeignKeys, []);
}

function assertReleaseHealth(db) {
  assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("legacy_alter_table", { simple: true }), 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
  assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  assertNoV57ForeignKeyTargets(db);
}

function assertSeededLineageSurvived(db, ids) {
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM analysis_inputs WHERE id = ?").get(ids.inputId).count,
    1
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS count FROM analysis_input_segments WHERE analysis_input_id = ?")
      .get(ids.inputId).count,
    1
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS count FROM analysis_desired_heads WHERE analysis_input_id = ?")
      .get(ids.inputId).count,
    1
  );
  assert.equal(
    db.prepare("SELECT source_analysis_input_id FROM todos_v2 WHERE id = ?").get(ids.todoId)
      .source_analysis_input_id,
    ids.inputId
  );
  assert.equal(
    db
      .prepare("SELECT source_analysis_input_id FROM suggestions_v2 WHERE id = ?")
      .get(ids.suggestionId).source_analysis_input_id,
    ids.inputId
  );
  assert.equal(
    db
      .prepare(
        "SELECT source_analysis_input_id FROM session_summary_revisions WHERE session_id = ?"
      )
      .get(ids.sessionId).source_analysis_input_id,
    ids.inputId
  );
  assert.equal(
    db
      .prepare("SELECT source_session_id FROM todo_action_metadata WHERE todo_instance_id = ?")
      .get(ids.todoId).source_session_id,
    ids.sessionId
  );
  assert.equal(
    db
      .prepare("SELECT effective_state FROM suggestion_action_metadata WHERE suggestion_id = ?")
      .get(ids.suggestionId).effective_state,
    "proposed"
  );
}

function schemaSnapshot(db) {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all();
}

test("file-backed v54, v56 and v57 fixtures cross the v60 gate after repository cold reopen", async (t) => {
  assert.equal(TARGET_VERSION, 60);
  for (const version of [54, 56, 57]) {
    await t.test(`v${version} -> v60`, () => {
      const directory = createCaseDirectory(`v${version}`);
      const filename = path.join(directory, `jarvis-v${version}.db`);
      let repository;
      try {
        const ids = createLegacyFixture(filename, version);
        repository = new JarvisRepository(filename);
        assertReleaseHealth(repository.db);
        assertSeededLineageSurvived(repository.db, ids);
        const firstCounts = durableCounts(repository.db);
        repository.close();
        repository = null;

        repository = new JarvisRepository(filename);
        assertReleaseHealth(repository.db);
        assertSeededLineageSurvived(repository.db, ids);
        assert.deepEqual(durableCounts(repository.db), firstCounts);
        assert.deepEqual(applyJarvisMigrations(repository.db, { now: () => AT + 20_000 }), {
          fromVersion: 60,
          toVersion: 60,
        });
        assertReleaseHealth(repository.db);
        assert.deepEqual(durableCounts(repository.db), firstCounts);
      } finally {
        repository?.close();
        removeCaseDirectory(directory);
      }
    });
  }
});

test("a deterministic late foreign-key failure rolls the v57 migration back exactly", () => {
  const directory = createCaseDirectory("rollback-v57");
  const filename = path.join(directory, "jarvis-v57-rollback.db");
  let db;
  try {
    const ids = createLegacyFixture(filename, 57);
    db = new Database(filename);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO audio_tracks (
         id, session_id, source_type, sample_rate, channels, started_at, state
       ) VALUES ('intentional-orphan-track', 'missing-session', 'system', 24000, 1, ?, 'stopped')`
    ).run(AT + 30_000);
    db.pragma("foreign_keys = ON");

    const beforeSchema = schemaSnapshot(db);
    const beforeCounts = durableCounts(db);
    const beforeViolations = db.pragma("foreign_key_check");
    assert.equal(beforeViolations.length, 1);
    assert.equal(db.pragma("user_version", { simple: true }), 57);

    assert.throws(
      () => applyJarvisMigrations(db, { now: () => AT + 40_000 }),
      /schema migration would violate foreign keys/u
    );

    assert.equal(db.pragma("user_version", { simple: true }), 57);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("legacy_alter_table", { simple: true }), 0);
    assert.deepEqual(schemaSnapshot(db), beforeSchema);
    assert.deepEqual(durableCounts(db), beforeCounts);
    assert.deepEqual(db.pragma("foreign_key_check"), beforeViolations);
    assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.equal(
      db.prepare("SELECT input_contract_version FROM analysis_inputs WHERE id = ?").get(ids.inputId)
        .input_contract_version,
      "jarvis-analysis-input-v2"
    );
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'analysis_inputs_v57'`
        )
        .get().count,
      0
    );
    db.close();
    db = null;

    db = new Database(filename, { readonly: true });
    db.pragma("foreign_keys = ON");
    assert.equal(db.pragma("user_version", { simple: true }), 57);
    assert.deepEqual(schemaSnapshot(db), beforeSchema);
    assert.deepEqual(durableCounts(db), beforeCounts);
    assert.deepEqual(db.pragma("foreign_key_check"), beforeViolations);
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  } finally {
    db?.close();
    removeCaseDirectory(directory);
  }
});
