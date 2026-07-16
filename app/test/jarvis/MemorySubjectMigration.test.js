"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const { TARGET_VERSION, applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const { canonicalTupleHash, canonicalizeText } = require("../../src/jarvis/main/MemoryMerger");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const CLOUD_PAYLOAD_JSON = JSON.stringify({ inputVersion: "jarvis-analysis-input-v2" });

function schemaNames(db, type) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map(({ name }) => name);
}

function stripV27(db) {
  const lineageTrigger = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'evidence_refs_validate_lineage_insert'`
    )
    .get();
  if (lineageTrigger) {
    const sameSessionOwnership = `analysis_input_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM analysis_inputs AS occurrence_input
                  WHERE occurrence_input.id = analysis_input_id
                    AND occurrence_input.session_id = NEW.session_id
                )`;
    assert.equal(lineageTrigger.sql.split(sameSessionOwnership).length - 1, 4);
    db.exec("DROP TRIGGER evidence_refs_validate_lineage_insert");
    db.exec(
      lineageTrigger.sql
        .split(sameSessionOwnership)
        .join("analysis_input_id = NEW.source_analysis_input_id")
    );
  }
  db.exec(`
    DROP TRIGGER IF EXISTS memory_item_canonical_slots_immutable_update;
    DROP TRIGGER IF EXISTS memory_item_canonical_slots_immutable_delete;
    DROP TRIGGER IF EXISTS memory_item_subjects_immutable_update;
    DROP TRIGGER IF EXISTS memory_item_subjects_immutable_delete;
    DROP TABLE IF EXISTS memory_item_canonical_slots;
    DROP TABLE IF EXISTS memory_item_subjects;
    PRAGMA user_version = 26;
  `);
}

function seedV26SubjectLineage(db) {
  const exec = (label, statement) => {
    try {
      db.exec(statement);
    } catch (error) {
      throw new Error(`failed to seed ${label}: ${error.message}`, { cause: error });
    }
  };
  exec(
    "capture lineage",
    `
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-self', 'Alice', 1, 1, 1);

    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-subject', 1000, 5000, 'completed', 1000);

    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-subject', 'session-subject', 'mic', 24000, 1, 1000, 5000, 'stopped'
    );

    INSERT INTO audio_chunks (
      id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, track_id, source_type, sequence_number, write_state
    ) VALUES (
      'chunk-subject', 'session-subject', 'subject.wav', 1100, 1300, 200,
      '${HASH_D}', 9000, 'completed', 'track-subject', 'mic', 0, 'committed'
    );

    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, analysis_state, source_type, result_kind, version,
      model_version, completed_at, track_id, chunk_id
    ) VALUES (
      'segment-subject', 'session-subject', 1100, 1300, 'SELF',
      'Alice likes deterministic storage.', 0.99, 1, 'analyzed', 'mic',
      'final', 1, 'test-model', 1300, 'track-subject', 'chunk-subject'
    );
  `
  );
  try {
    db.prepare(
      `INSERT INTO analysis_inputs (
       id, session_id, transcript_revision, identity_revision, prompt_version,
       input_hash, input_contract_version, redaction_version, cloud_payload_json,
       cloud_payload_bytes, cloud_payload_sha256, created_at
     ) VALUES (
       'input-subject', 'session-subject', ?, ?, 'prompt-v1', ?,
       'jarvis-analysis-input-v2', 'jarvis-redaction-v1', ?, ?, ?, 1400
     )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      CLOUD_PAYLOAD_JSON,
      Buffer.byteLength(CLOUD_PAYLOAD_JSON, "utf8"),
      HASH_D
    );
  } catch (error) {
    throw new Error(`failed to seed analysis input: ${error.message}`, { cause: error });
  }
  const statements = [
    `
    INSERT INTO analysis_input_speaker_bindings (
      analysis_input_id, label, subject_kind, subject_id,
      subject_display_name_snapshot
    ) VALUES ('input-subject', 'SELF', 'person', 'person-self', 'Alice')`,
    `
    INSERT INTO analysis_input_segments (
      analysis_input_id, ordinal, segment_id, segment_version, text_hash,
      text_snapshot, speaker_binding_label
    ) VALUES (
      'input-subject', 0, 'segment-subject', 1,
      '${HASH_A}', 'Alice likes deterministic storage.', 'SELF'
    )`,
    `
    INSERT INTO memory_items_v2 (
      id, kind, canonical_slot_key, canonical_value_key, title, body,
      confidence, lifecycle, source_analysis_input_id, provenance,
      created_at, updated_at
    ) VALUES (
      'memory-subject', 'fact', '${HASH_B}', '${HASH_C}', 'Preference',
      'Alice likes deterministic storage.', 0.99, 'active', 'input-subject',
      'evidence_linked', 1500, 1500
    )`,
    `
    INSERT INTO memory_items_v2 (
      id, kind, canonical_slot_key, canonical_value_key, title, body,
      confidence, lifecycle, source_analysis_input_id, provenance,
      created_at, updated_at
    ) VALUES (
      'memory-no-lineage', 'fact', '${HASH_C}', '${HASH_D}', 'Unknown',
      'No durable subject lineage exists.', 0.5, 'active', NULL,
      'legacy_unverified', 1500, 1500
    )`,
    `
    INSERT INTO memory_occurrences (
      id, memory_value_id, analysis_input_id, legacy_session_id,
      occurrence_key, candidate_item_fingerprint, started_at, ended_at,
      confidence, created_at
    ) VALUES (
      'occurrence-subject', 'memory-subject', 'input-subject', NULL,
      '${HASH_A}', '${HASH_D}', 1100, 1300, 0.99, 1500
    )`,
    `
    INSERT INTO evidence_refs (
      id, entity_type, entity_id, source_analysis_input_id, session_id,
      transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
      quote_text, audio_state, created_at
    ) VALUES (
      'evidence-subject', 'memory_occurrence', 'occurrence-subject',
      'input-subject', 'session-subject', 'segment-subject', 'chunk-subject',
      'track-subject', 1100, 1300, 'Alice likes deterministic storage.',
      'available', 1500
    )`,
  ];
  for (const [index, statement] of statements.entries())
    exec(`lineage statement ${index}`, statement);
}

test("v27 fresh schema creates stable immutable memory subject identity", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    assert.equal(TARGET_VERSION, 27);
    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 0, toVersion: 27 });
    assert.ok(schemaNames(db, "table").includes("memory_item_subjects"));
    assert.ok(schemaNames(db, "table").includes("memory_item_canonical_slots"));
    assert.deepEqual(
      db.pragma("table_info(memory_item_subjects)").map(({ name, notnull, pk }) => ({
        name,
        notnull,
        pk,
      })),
      [
        { name: "memory_item_id", notnull: 1, pk: 1 },
        { name: "subject_kind", notnull: 1, pk: 2 },
        { name: "subject_id", notnull: 1, pk: 3 },
      ]
    );
    const triggers = schemaNames(db, "trigger");
    assert.ok(triggers.includes("memory_item_subjects_immutable_update"));
    assert.ok(triggers.includes("memory_item_subjects_immutable_delete"));
    assert.ok(triggers.includes("memory_item_canonical_slots_immutable_update"));
    assert.ok(triggers.includes("memory_item_canonical_slots_immutable_delete"));
    const lineageSql = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'evidence_refs_validate_lineage_insert'`
      )
      .get().sql;
    assert.equal(
      (lineageSql.match(/occurrence_input\.session_id = NEW\.session_id/g) ?? []).length,
      4
    );
    assert.doesNotMatch(lineageSql, /analysis_input_id = NEW\.source_analysis_input_id/);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v27 backfills exact immutable subjects once and retains them after source deletion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-memory-subject-v27-"));
  const filename = path.join(directory, "jarvis.db");
  let db = new Database(filename);
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db);
    stripV27(db);
    seedV26SubjectLineage(db);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 26, toVersion: 27 });
    assert.deepEqual(
      db.prepare("SELECT * FROM memory_item_subjects ORDER BY memory_item_id").all(),
      [
        {
          memory_item_id: "memory-subject",
          subject_kind: "person",
          subject_id: "person-self",
        },
      ]
    );
    const expectedSubjectSlot = canonicalTupleHash([
      "memory",
      "fact",
      canonicalizeText("Preference"),
      ["person-self"],
    ]);
    assert.deepEqual(
      db.prepare("SELECT * FROM memory_item_canonical_slots ORDER BY memory_item_id").all(),
      [
        {
          memory_item_id: "memory-no-lineage",
          canonical_slot_key: canonicalTupleHash([
            "memory",
            "fact",
            canonicalizeText("Unknown"),
            [],
          ]),
          algorithm: "canonical-v1",
        },
        {
          memory_item_id: "memory-subject",
          canonical_slot_key: expectedSubjectSlot,
          algorithm: "canonical-v1",
        },
      ]
    );
    assert.notEqual(
      db.prepare("SELECT canonical_slot_key FROM memory_items_v2 WHERE id = 'memory-subject'").get()
        .canonical_slot_key,
      expectedSubjectSlot,
      "v27 must preserve the old stored entity key"
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE memory_item_subjects SET subject_id = 'other'
             WHERE memory_item_id = 'memory-subject'`
          )
          .run(),
      /memory item subject is immutable/
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM memory_item_subjects WHERE memory_item_id = 'memory-subject'")
          .run(),
      /memory item subject is immutable/
    );

    db.close();
    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 27, toVersion: 27 });
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_item_subjects").get().count, 1);

    db.prepare("DELETE FROM sessions WHERE id = 'session-subject'").run();
    assert.deepEqual(db.prepare("SELECT * FROM memory_item_subjects").all(), [
      {
        memory_item_id: "memory-subject",
        subject_kind: "person",
        subject_id: "person-self",
      },
    ]);
    assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v27 canonical slot bridge preserves legacy groups and permits mixed legacy-new relations", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyJarvisMigrations(db);
    stripV27(db);
    seedV26SubjectLineage(db);
    applyJarvisMigrations(db);

    const canonicalSlot = db
      .prepare(
        `SELECT canonical_slot_key FROM memory_item_canonical_slots
         WHERE memory_item_id = 'memory-subject'`
      )
      .get().canonical_slot_key;
    db.exec(`
      INSERT INTO memory_items_v2 (
        id, kind, canonical_slot_key, canonical_value_key, title, body,
        confidence, lifecycle, source_analysis_input_id, provenance,
        created_at, updated_at
      ) VALUES (
        'memory-legacy-peer', 'fact', '${HASH_B}', '${HASH_E}', 'Preference',
        'A different legacy value.', 0.8, 'active', NULL, 'legacy_unverified', 1600, 1600
      );
    `);
    db.prepare(
      `INSERT INTO memory_item_subjects (memory_item_id, subject_kind, subject_id)
       VALUES ('memory-legacy-peer', 'person', 'person-self')`
    ).run();
    db.prepare(
      `INSERT INTO memory_item_canonical_slots (
         memory_item_id, canonical_slot_key, algorithm
       ) VALUES ('memory-legacy-peer', ?, 'canonical-v1')`
    ).run(canonicalSlot);
    db.exec(`
      INSERT INTO memory_conflict_groups (
        id, slot_key, episode, state, selected_member_id, resolved_at,
        created_at, updated_at
      ) VALUES ('legacy-group', '${HASH_B}', 1, 'open', NULL, NULL, 1700, 1700);
      INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at)
      VALUES
        ('legacy-group', 'memory-subject', 1700),
        ('legacy-group', 'memory-legacy-peer', 1700);
      UPDATE memory_conflict_groups
      SET state = 'resolved', selected_member_id = 'memory-legacy-peer',
          resolved_at = 1800, updated_at = 1800
      WHERE id = 'legacy-group';
    `);

    db.prepare(
      `INSERT INTO memory_items_v2 (
         id, kind, canonical_slot_key, canonical_value_key, title, body,
         confidence, lifecycle, source_analysis_input_id, provenance,
         created_at, updated_at
       ) VALUES (
         'memory-new', 'fact', ?, '${HASH_F}', 'Preference',
         'A canonical-v1 value.', 0.9, 'active', NULL, 'legacy_unverified', 1900, 1900
       )`
    ).run(canonicalSlot);
    db.prepare(
      `INSERT INTO memory_item_subjects (memory_item_id, subject_kind, subject_id)
       VALUES ('memory-new', 'person', 'person-self')`
    ).run();
    db.prepare(
      `INSERT INTO memory_item_canonical_slots (
         memory_item_id, canonical_slot_key, algorithm
       ) VALUES ('memory-new', ?, 'canonical-v1')`
    ).run(canonicalSlot);
    db.prepare(
      `INSERT INTO memory_conflict_groups (
         id, slot_key, episode, state, selected_member_id, resolved_at,
         created_at, updated_at
       ) VALUES ('mixed-group', ?, 1, 'open', NULL, NULL, 2000, 2000)`
    ).run(canonicalSlot);
    db.exec(`
      INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at)
      VALUES
        ('mixed-group', 'memory-subject', 2000),
        ('mixed-group', 'memory-new', 2000);
      UPDATE memory_items_v2 SET lifecycle = 'conflict', updated_at = 2000
      WHERE id IN ('memory-subject', 'memory-new');
      UPDATE memory_conflict_groups
      SET state = 'resolved', selected_member_id = 'memory-new',
          resolved_at = 2100, updated_at = 2100
      WHERE id = 'mixed-group';
      INSERT INTO memory_supersessions (
        previous_id, next_id, reason, analysis_input_id, created_at
      ) VALUES (
        'memory-subject', 'memory-new', 'conflict_resolution', NULL, 2100
      );
      UPDATE memory_items_v2 SET lifecycle = 'superseded', updated_at = 2100
      WHERE id = 'memory-subject';
      UPDATE memory_items_v2 SET lifecycle = 'active', updated_at = 2100
      WHERE id = 'memory-new';
    `);
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, lifecycle FROM memory_items_v2
           WHERE id IN ('memory-subject','memory-new') ORDER BY id`
        )
        .all(),
      [
        { id: "memory-new", lifecycle: "active" },
        { id: "memory-subject", lifecycle: "superseded" },
      ]
    );
  } finally {
    db.close();
  }
});
