"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function downgradeAnalysisSchemaToV57(db) {
  const inputTriggerSql = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'analysis_inputs'
       ORDER BY name`
    )
    .all();
  const segmentTriggerSql = db
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
      for (const trigger of [...inputTriggerSql, ...segmentTriggerSql]) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
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
      for (const trigger of inputTriggerSql) db.exec(trigger.sql);
      for (const trigger of segmentTriggerSql) db.exec(trigger.sql);
      db.pragma("user_version = 57");
    })();
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlterTable ? "ON" : "OFF"}`);
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}

function insertAnalysisInput(db, { id, version, padding = 0, createdAt = 2_000 }) {
  const cloudPayload = JSON.stringify({ inputVersion: version, padding: "x".repeat(padding) });
  const bytes = Buffer.byteLength(cloudPayload, "utf8");
  db.prepare(
    `INSERT INTO analysis_inputs (
       id, session_id, transcript_revision, identity_revision, prompt_version,
       input_hash, input_contract_version, redaction_version, cloud_payload_json,
       cloud_payload_bytes, cloud_payload_sha256, created_at
     ) VALUES (?, 'session-v58', ?, ?, 'prompt-v58', ?, ?, 'jarvis-redaction-v1', ?, ?, ?, ?)`
  ).run(
    id,
    sha256(`transcript:${id}`),
    sha256(`identity:${id}`),
    sha256(`input:${id}`),
    version,
    cloudPayload,
    bytes,
    sha256(cloudPayload),
    createdAt
  );
  db.prepare(
    `INSERT INTO analysis_input_speaker_bindings (
       analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
     ) VALUES (?, 'SELF', 'person', 'person-self-v58', 'Local Self')`
  ).run(id);
  return { cloudPayload, bytes };
}

function insertManifest(db, analysisInputId, overrides = {}) {
  const context = {
    applicationKey: null,
    sourceAttribution: "microphone",
    activityCategory: "work_meeting",
    activityConfidence: 0.95,
    activityDecision: "adopted",
    selfParticipated: 1,
    memoryMode: "full",
    allowedSuggestionBasesJson: '["work_context"]',
    todoCandidateAllowed: 1,
    ...overrides,
  };
  return db
    .prepare(
      `INSERT INTO analysis_input_segments (
         analysis_input_id, ordinal, segment_id, segment_version, text_hash,
         text_snapshot, speaker_binding_label, application_key, source_attribution,
         activity_category, activity_confidence, activity_decision, self_participated,
         memory_mode, allowed_suggestion_bases_json, todo_candidate_allowed
       ) VALUES (?, 0, 'segment-v58', 1, ?, 'durable v58 evidence', 'SELF',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      analysisInputId,
      sha256("durable v58 evidence"),
      context.applicationKey,
      context.sourceAttribution,
      context.activityCategory,
      context.activityConfidence,
      context.activityDecision,
      context.selfParticipated,
      context.memoryMode,
      context.allowedSuggestionBasesJson,
      context.todoCandidateAllowed
    );
}

test("a file-backed v57 analysis lineage upgrades to v58 with durable v2 and strict v3 context", () => {
  const directory = path.resolve(__dirname, "../../.tmp-tests/analysis-input-v58");
  const filename = path.join(directory, `analysis-input-v57-${process.pid}-${Date.now()}.db`);
  fs.mkdirSync(directory, { recursive: true });
  let db;
  let stage = "open fixture";
  try {
    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    stage = "create current schema";
    applyJarvisMigrations(db, { now: () => 1_000 });
    stage = "downgrade analysis schema";
    downgradeAnalysisSchemaToV57(db);
    stage = "seed v57 source rows";
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-self-v58', 'Local Self', 1, 1000, 1000);
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-v58', 1000, 5000, 'completed', 1000);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('track-v58', 'session-v58', 'mic', 24000, 1, 1000, 5000, 'stopped');
      INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, track_id, source_type, sequence_number, write_state
      ) VALUES (
        'chunk-v58', 'session-v58', 'fixture-v58.wav', 1000, 5000, 4000,
        '${"a".repeat(64)}', 10000, 'completed', 'track-v58', 'mic', 0, 'committed'
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
        is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
        version, model_version, completed_at
      ) VALUES (
        'segment-v58', 'session-v58', 1000, 5000, 'person-self-v58', 'SELF',
        'durable v58 evidence', 0.95, 1, 'analyzed', 'track-v58', 'chunk-v58', 'mic', 'final',
        1, 'whisper-v58', 5000
      );
    `);
    stage = "insert v2 input";
    insertAnalysisInput(db, {
      id: "analysis-input-v2",
      version: "jarvis-analysis-input-v2",
    });
    stage = "insert v2 manifest";
    db.prepare(
      `INSERT INTO analysis_input_segments (
         analysis_input_id, ordinal, segment_id, segment_version,
         text_hash, text_snapshot, speaker_binding_label
       ) VALUES (
         'analysis-input-v2', 0, 'segment-v58', 1, ?, 'durable v58 evidence', 'SELF'
       )`
    ).run(sha256("durable v58 evidence"));
    assert.equal(db.pragma("user_version", { simple: true }), 57);
    db.close();
    db = null;

    stage = "migrate v57 file";
    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 57,
      toVersion: TARGET_VERSION,
    });
    db.close();
    db = null;

    stage = "verify reopened v58 file";
    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    assert.equal(db.pragma("user_version", { simple: true }), 58);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(
      db
        .prepare(
          `SELECT input_contract_version, cloud_payload_bytes
           FROM analysis_inputs WHERE id = 'analysis-input-v2'`
        )
        .get(),
      {
        input_contract_version: "jarvis-analysis-input-v2",
        cloud_payload_bytes: Buffer.byteLength(
          JSON.stringify({ inputVersion: "jarvis-analysis-input-v2", padding: "" }),
          "utf8"
        ),
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT application_key, source_attribution, activity_category,
                  activity_confidence, activity_decision, self_participated,
                  memory_mode, allowed_suggestion_bases_json, todo_candidate_allowed
           FROM analysis_input_segments WHERE analysis_input_id = 'analysis-input-v2'`
        )
        .get(),
      {
        application_key: null,
        source_attribution: null,
        activity_category: null,
        activity_confidence: null,
        activity_decision: null,
        self_participated: null,
        memory_mode: null,
        allowed_suggestion_bases_json: null,
        todo_candidate_allowed: null,
      }
    );
    assert.deepEqual(
      new Set(db.pragma("foreign_key_list(analysis_input_segments)").map((entry) => entry.table)),
      new Set(["analysis_input_speaker_bindings", "transcript_segments", "analysis_inputs"])
    );
    assert.equal(
      db
        .pragma("foreign_key_list(analysis_desired_heads)")
        .some((entry) => entry.table === "analysis_inputs"),
      true
    );
    const requiredTriggers = new Set([
      "analysis_inputs_immutable_update",
      "analysis_inputs_candidate_cas",
      "analysis_inputs_immutable_delete",
      "analysis_input_segments_immutable_update",
      "analysis_input_segments_immutable_delete",
      "analysis_input_segments_validate_source",
      "analysis_input_segments_validate_ordinal",
      "analysis_input_segments_validate_context",
      "analysis_input_segments_protect_source_update",
      "analysis_input_segments_protect_source_delete",
    ]);
    const installedTriggers = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((row) => row.name)
    );
    for (const trigger of requiredTriggers)
      assert.equal(installedTriggers.has(trigger), true, trigger);
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE analysis_input_segments SET text_snapshot = 'changed'
             WHERE analysis_input_id = 'analysis-input-v2'`
          )
          .run(),
      /immutable/u
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_inputs SET prompt_version = 'changed' WHERE id = 'analysis-input-v2'"
          )
          .run(),
      /immutable/u
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE transcript_segments SET text = 'changed' WHERE id = 'segment-v58'")
          .run(),
      /immutable/u
    );

    stage = "insert valid large v3 input";
    const large = insertAnalysisInput(db, {
      id: "analysis-input-v3-large",
      version: "jarvis-analysis-input-v3",
      padding: 392_000,
      createdAt: 3_000,
    });
    assert.equal(large.bytes > 98_304, true);
    assert.equal(large.bytes <= 393_216, true);
    stage = "insert valid v3 manifest";
    insertManifest(db, "analysis-input-v3-large");
    assert.deepEqual(
      db
        .prepare(
          `SELECT application_key, source_attribution, activity_category,
                  activity_confidence, activity_decision, self_participated,
                  memory_mode, allowed_suggestion_bases_json, todo_candidate_allowed
           FROM analysis_input_segments WHERE analysis_input_id = 'analysis-input-v3-large'`
        )
        .get(),
      {
        application_key: null,
        source_attribution: "microphone",
        activity_category: "work_meeting",
        activity_confidence: 0.95,
        activity_decision: "adopted",
        self_participated: 1,
        memory_mode: "full",
        allowed_suggestion_bases_json: '["work_context"]',
        todo_candidate_allowed: 1,
      }
    );

    insertAnalysisInput(db, {
      id: "analysis-input-v3-missing",
      version: "jarvis-analysis-input-v3",
    });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_segments (
               analysis_input_id, ordinal, segment_id, segment_version,
               text_hash, text_snapshot, speaker_binding_label
             ) VALUES (
               'analysis-input-v3-missing', 0, 'segment-v58', 1,
               ?, 'durable v58 evidence', 'SELF'
             )`
          )
          .run(sha256("durable v58 evidence")),
      /context is invalid/u
    );

    insertAnalysisInput(db, {
      id: "analysis-input-v2-context",
      version: "jarvis-analysis-input-v2",
    });
    assert.throws(() => insertManifest(db, "analysis-input-v2-context"), /context is invalid/u);

    insertAnalysisInput(db, {
      id: "analysis-input-v3-application-missing",
      version: "jarvis-analysis-input-v3",
    });
    assert.throws(
      () =>
        insertManifest(db, "analysis-input-v3-application-missing", {
          sourceAttribution: "application",
          applicationKey: null,
        }),
      /context is invalid/u
    );

    insertAnalysisInput(db, {
      id: "analysis-input-v3-mixed-key",
      version: "jarvis-analysis-input-v3",
    });
    assert.throws(
      () =>
        insertManifest(db, "analysis-input-v3-mixed-key", {
          sourceAttribution: "mixed_unknown",
          applicationKey: "kook",
        }),
      /context is invalid/u
    );

    insertAnalysisInput(db, {
      id: "analysis-input-v3-bad-category",
      version: "jarvis-analysis-input-v3",
    });
    assert.throws(
      () =>
        insertManifest(db, "analysis-input-v3-bad-category", {
          activityCategory: "window_title_guess",
        }),
      /constraint/u
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } catch (error) {
    const wrapped = new Error(`${stage}: ${error.message}`, { cause: error });
    wrapped.code = error.code;
    throw wrapped;
  } finally {
    db?.close();
    fs.rmSync(filename, { force: true });
  }
});
