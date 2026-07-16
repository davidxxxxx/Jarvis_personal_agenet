const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const test = require("node:test");

const {
  applyJarvisMigrations,
  TARGET_VERSION,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
} = require("../../src/jarvis/main/JarvisMigrations");
const { canonicalTupleHash, canonicalizeText } = require("../../src/jarvis/main/MemoryMerger");

const PREVIOUS_VERSION = 22;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const CLOUD_PAYLOAD_JSON = JSON.stringify({ inputVersion: INPUT_CONTRACT_VERSION });
const CLOUD_PAYLOAD_BYTES = Buffer.byteLength(CLOUD_PAYLOAD_JSON, "utf8");

function insertMemoryCanonicalBridge(db, { memoryItemId, kind, title, subjectIds = [] }) {
  const canonicalSlotKey = canonicalTupleHash([
    "memory",
    kind,
    canonicalizeText(title),
    [...new Set(subjectIds)].sort(),
  ]);
  db.prepare(
    `INSERT INTO memory_item_canonical_slots (
       memory_item_id, canonical_slot_key, algorithm
     ) VALUES (?, ?, 'canonical-v1')`
  ).run(memoryItemId, canonicalSlotKey);
  return canonicalSlotKey;
}

const LINEAGE_TABLES = [
  "analysis_inputs",
  "analysis_input_segments",
  "analysis_input_speaker_bindings",
  "memory_items_v2",
  "memory_occurrences",
  "memory_supersessions",
  "memory_conflict_groups",
  "memory_conflict_members",
  "topics_v2",
  "topic_revisions",
  "topic_occurrences",
  "topic_merge_suggestions",
  "todos_v2",
  "todo_revisions",
  "todo_occurrences",
  "todo_state_transitions",
  "todo_recurrences",
  "suggestions_v2",
  "suggestion_occurrences",
  "suggestion_acceptances",
  "session_summary_revisions",
  "evidence_refs",
  "daily_digests",
  "legacy_import_runs",
  "legacy_import_map",
];

const LINEAGE_TRIGGERS = [
  "analysis_inputs_immutable_update",
  "analysis_inputs_candidate_cas",
  "analysis_inputs_immutable_delete",
  "analysis_input_segments_immutable_update",
  "analysis_input_segments_immutable_delete",
  "analysis_input_speaker_bindings_immutable_update",
  "analysis_input_speaker_bindings_immutable_delete",
  "analysis_input_speaker_bindings_validate_target",
  "topic_revisions_validate_predecessor",
  "todo_revisions_validate_predecessor",
  "session_summary_revisions_validate_predecessor",
  "daily_digests_validate_predecessor",
  "memory_supersessions_validate_slot",
  "memory_conflict_members_validate_slot",
  "memory_conflict_groups_validate_resolution",
  "todos_v2_validate_owner_shape_insert",
  "todos_v2_validate_owner_shape_update",
  "todos_v2_validate_owner_binding",
  "todos_v2_validate_owner_binding_update",
  "todos_v2_terminal_state",
  "suggestions_v2_terminal_state",
  "evidence_refs_validate_target_insert",
  "evidence_refs_validate_target_update",
  "evidence_refs_expire_audio",
];

const DROP_ORDER = [
  "legacy_import_map",
  "legacy_import_runs",
  "evidence_refs",
  "suggestion_acceptances",
  "suggestion_occurrences",
  "suggestions_v2",
  "topic_merge_suggestions",
  "memory_conflict_members",
  "memory_conflict_groups",
  "memory_supersessions",
  "todo_recurrences",
  "todo_state_transitions",
  "todo_occurrences",
  "todo_revisions",
  "todos_v2",
  "topic_occurrences",
  "topic_revisions",
  "topics_v2",
  "memory_occurrences",
  "memory_items_v2",
  "session_summary_revisions",
  "daily_digests",
  "analysis_input_speaker_bindings",
  "analysis_input_segments",
  "analysis_inputs",
];

function createDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function schemaObjects(db, type) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((row) => row.name);
}

function ensureTranscriptSchema(db) {
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_segments'")
      .get()
  ) {
    return;
  }
  db.exec(transcriptSegmentsSchema("transcript_segments", { ifNotExists: true }));
  db.exec(TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS);
}

function stripLineageSchema(db) {
  db.pragma("foreign_keys = OFF");
  for (const trigger of LINEAGE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of DROP_ORDER) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.pragma(`user_version = ${PREVIOUS_VERSION}`);
  db.pragma("foreign_keys = ON");
}

function createPreviousVersionDatabase({ withTranscript = true } = {}) {
  const db = createDatabase();
  applyJarvisMigrations(db);
  if (withTranscript) ensureTranscriptSchema(db);
  stripLineageSchema(db);
  return db;
}

function seedCaptureLineage(db, { sessionId = "session-1", segmentId = "segment-1" } = {}) {
  db.prepare(
    `INSERT INTO sessions (id, started_at, ended_at, status, created_at)
     VALUES (?, 1000, 5000, 'completed', 1000)`
  ).run(sessionId);
  db.prepare(
    `INSERT INTO audio_tracks (
       id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
     ) VALUES ('track-1', ?, 'mic', 24000, 1, 1000, 5000, 'stopped')`
  ).run(sessionId);
  db.prepare(
    `INSERT INTO audio_chunks (
       id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
       transcription_status, track_id, source_type, sequence_number, write_state
     ) VALUES (
       'chunk-1', ?, 'capture.wav', 1000, 5000, 4000, ?, 9000,
       'completed', 'track-1', 'mic', 0, 'committed'
     )`
  ).run(sessionId, HASH_A);
  db.prepare(
    `INSERT INTO transcript_segments (
       id, session_id, started_at, ended_at, speaker_label, text, confidence,
       is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
       version, model_version, completed_at
     ) VALUES (
       ?, ?, 1000, 5000, 'SELF', 'durable evidence', 0.9,
       1, 'analyzed', 'track-1', 'chunk-1', 'mic', 'final',
       1, 'whisper-v1', 5000
     )`
  ).run(segmentId, sessionId);
}

function seedSecondFinalSegment(db) {
  db.prepare(
    `INSERT INTO audio_chunks (
       id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
       transcription_status, track_id, source_type, sequence_number, write_state
     ) VALUES (
       'chunk-2', 'session-1', 'capture-2.wav', 5000, 7000, 2000, ?, 9000,
       'completed', 'track-1', 'mic', 1, 'committed'
     )`
  ).run(HASH_B);
  db.prepare(
    `INSERT INTO transcript_segments (
       id, session_id, started_at, ended_at, speaker_label, text, confidence,
       is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
       version, model_version, completed_at
     ) VALUES (
       'segment-2', 'session-1', 5000, 7000, 'P1', 'second durable evidence', 0.9,
       1, 'analyzed', 'track-1', 'chunk-2', 'mic', 'final',
       1, 'whisper-v1', 7000
     )`
  ).run();
}

function seedAnalysisInput(db, { sessionId = "session-1", inputId = "input-1" } = {}) {
  const { display_name: subjectDisplayNameSnapshot } = db
    .prepare("SELECT display_name FROM people WHERE id = 'person-1'")
    .get();
  db.prepare(
    `INSERT INTO analysis_inputs (
       id, session_id, transcript_revision, identity_revision, prompt_version,
       input_hash, input_contract_version, redaction_version, cloud_payload_json,
       cloud_payload_bytes, cloud_payload_sha256, created_at
     ) VALUES (?, ?, ?, ?, 'jarvis-analysis-v2', ?, ?, ?, ?, ?, ?, 6000)`
  ).run(
    inputId,
    sessionId,
    HASH_A,
    HASH_B,
    HASH_C,
    INPUT_CONTRACT_VERSION,
    REDACTION_VERSION,
    CLOUD_PAYLOAD_JSON,
    CLOUD_PAYLOAD_BYTES,
    HASH_F
  );
  db.prepare(
    `INSERT INTO analysis_input_speaker_bindings (
       analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
     ) VALUES (?, 'SELF', 'person', 'person-1', ?)`
  ).run(inputId, subjectDisplayNameSnapshot);
  db.prepare(
    `INSERT INTO analysis_input_segments (
       analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
       speaker_binding_label
     ) VALUES (?, 0, 'segment-1', 1, ?, 'durable evidence', 'SELF')`
  ).run(inputId, HASH_A);
}

function seedEvidenceOwner(db) {
  db.prepare(
    `INSERT INTO memory_items_v2 (
       id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
       lifecycle, source_analysis_input_id, provenance, created_at, updated_at
     ) VALUES (
       'memory-1', 'fact', ?, ?, 'Fact', 'Durable evidence', 0.9,
       'active', 'input-1', 'evidence_linked', 6000, 6000
     )`
  ).run(HASH_A, HASH_B);
  insertMemoryCanonicalBridge(db, {
    memoryItemId: "memory-1",
    kind: "fact",
    title: "Fact",
  });
  db.prepare(
    `INSERT INTO memory_occurrences (
       id, memory_value_id, analysis_input_id, occurrence_key,
       candidate_item_fingerprint, started_at, ended_at, confidence, created_at
     ) VALUES (
       'memory-occurrence-1', 'memory-1', 'input-1', ?, ?, 1000, 5000, 0.9, 6000
     )`
  ).run(HASH_A, HASH_B);
}

function insertEvidence(
  db,
  {
    id = "evidence-1",
    entityId = "memory-occurrence-1",
    sourceAnalysisInputId = "input-1",
    sessionId = "session-1",
    segmentId = "segment-1",
    audioChunkId = "chunk-1",
    trackId = "track-1",
    startedAt = 1000,
    endedAt = 5000,
    state = "available",
  } = {}
) {
  return db
    .prepare(
      `INSERT INTO evidence_refs (
       id, entity_type, entity_id, source_analysis_input_id, session_id,
       transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
       quote_text, audio_state, created_at
      ) VALUES (
        ?, 'memory_occurrence', ?, ?, ?,
        ?, ?, ?, ?, ?,
        'durable evidence', ?, 6000
      )`
    )
    .run(
      id,
      entityId,
      sourceAnalysisInputId,
      sessionId,
      segmentId,
      audioChunkId,
      trackId,
      startedAt,
      endedAt,
      state
    );
}

test("lineage migration remains pinned to its checked-in schema version", () => {
  assert.equal(PREVIOUS_VERSION + 1, 23);
  assert.ok(TARGET_VERSION >= 23);
});

test("empty and latest migration paths create the complete lineage schema without legacy tables", () => {
  const db = createDatabase();
  try {
    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 0, toVersion: TARGET_VERSION });
    const tables = schemaObjects(db, "table");
    for (const table of LINEAGE_TABLES) assert.ok(tables.includes(table), table);
    for (const legacy of [
      "analysis_runs",
      "session_summaries",
      "topics",
      "todos",
      "memories",
      "memory_evidence",
    ]) {
      assert.equal(tables.includes(legacy), false, legacy);
    }
    const triggers = schemaObjects(db, "trigger");
    for (const trigger of LINEAGE_TRIGGERS) assert.ok(triggers.includes(trigger), trigger);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });
  } finally {
    db.close();
  }
});

test("v22 migration preserves populated transcript, audio, and speaker rows", () => {
  const db = createPreviousVersionDatabase();
  try {
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    seedCaptureLineage(db);
    db.prepare(
      `INSERT INTO speaker_clusters (
         id, session_id, track_id, local_label, model_id, person_id,
         link_state, created_at, updated_at
       ) VALUES (
         'cluster-1', 'session-1', 'track-1', 'speaker_1', 'speaker-v1', 'person-1',
         'confirmed', 5000, 5000
       )`
    ).run();

    assert.deepEqual(applyJarvisMigrations(db), {
      fromVersion: PREVIOUS_VERSION,
      toVersion: TARGET_VERSION,
    });
    assert.equal(db.prepare("SELECT text FROM transcript_segments").get().text, "durable evidence");
    assert.equal(db.prepare("SELECT path FROM audio_chunks").get().path, "capture.wav");
    assert.equal(db.prepare("SELECT person_id FROM speaker_clusters").get().person_id, "person-1");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("analysis input cloud payload contract validates exact redacted JSON and UTF-8 bytes", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    applyJarvisMigrations(db);
    const insertInput = ({
      id,
      inputHash,
      payload = CLOUD_PAYLOAD_JSON,
      payloadBytes = Buffer.byteLength(payload, "utf8"),
      contractVersion = INPUT_CONTRACT_VERSION,
      redactionVersion = REDACTION_VERSION,
      payloadHash = HASH_F,
    }) =>
      db
        .prepare(
          `INSERT INTO analysis_inputs (
             id, session_id, transcript_revision, identity_revision, prompt_version,
             input_hash, input_contract_version, redaction_version, cloud_payload_json,
             cloud_payload_bytes, cloud_payload_sha256, created_at
           ) VALUES (?, 'session-1', ?, ?, 'jarvis-analysis-v2', ?, ?, ?, ?, ?, ?, 6000)`
        )
        .run(
          id,
          HASH_A,
          HASH_B,
          inputHash,
          contractVersion,
          redactionVersion,
          payload,
          payloadBytes,
          payloadHash
        );

    assert.equal(insertInput({ id: "input-cloud-valid", inputHash: HASH_C }).changes, 1);
    assert.equal(
      insertInput({ id: "input-cloud-shared-payload-hash", inputHash: "0".repeat(64) }).changes,
      1
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT input_contract_version, redaction_version, cloud_payload_json,
                  cloud_payload_bytes, cloud_payload_sha256
           FROM analysis_inputs
           WHERE id = 'input-cloud-valid'`
        )
        .get(),
      {
        input_contract_version: INPUT_CONTRACT_VERSION,
        redaction_version: REDACTION_VERSION,
        cloud_payload_json: CLOUD_PAYLOAD_JSON,
        cloud_payload_bytes: CLOUD_PAYLOAD_BYTES,
        cloud_payload_sha256: HASH_F,
      }
    );

    for (const invalid of [
      { id: "input-cloud-malformed", inputHash: HASH_D, payload: "{not-json" },
      {
        id: "input-cloud-nonobject",
        inputHash: HASH_E,
        payload: JSON.stringify([INPUT_CONTRACT_VERSION]),
      },
      {
        id: "input-cloud-wrong-version",
        inputHash: HASH_F,
        payload: JSON.stringify({ inputVersion: "jarvis-analysis-input-v1" }),
      },
      {
        id: "input-cloud-wrong-contract-version",
        inputHash: "3".repeat(64),
        contractVersion: "jarvis-analysis-input-v1",
      },
      {
        id: "input-cloud-wrong-redaction-version",
        inputHash: "4".repeat(64),
        redactionVersion: "jarvis-redaction-v2",
      },
      {
        id: "input-cloud-invalid-payload-hash",
        inputHash: "5".repeat(64),
        payloadHash: "A".repeat(64),
      },
    ]) {
      assert.throws(() => insertInput(invalid), { code: "SQLITE_CONSTRAINT_CHECK" });
    }

    const utf8Payload = JSON.stringify({
      inputVersion: INPUT_CONTRACT_VERSION,
      transcript: "你好",
    });
    assert.throws(
      () =>
        insertInput({
          id: "input-cloud-utf8-mismatch",
          inputHash: "1".repeat(64),
          payload: utf8Payload,
          payloadBytes: utf8Payload.length,
        }),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );

    const oversizedPayload = JSON.stringify({
      inputVersion: INPUT_CONTRACT_VERSION,
      padding: "x".repeat(98_304),
    });
    assert.throws(
      () =>
        insertInput({
          id: "input-cloud-oversized",
          inputHash: "2".repeat(64),
          payload: oversizedPayload,
        }),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );
  } finally {
    db.close();
  }
});

test("analysis input CAS and immutable manifests reject hostile writes but allow session cascade", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedSecondFinalSegment(db);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_segments (
               analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
               speaker_binding_label
             ) VALUES ('input-1', 1, 'segment-2', 1, ?, 'second durable evidence', 'P1')`
          )
          .run(HASH_A),
      { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }
    );

    assert.throws(
      () => db.prepare("UPDATE analysis_input_segments SET text_hash = ?").run(HASH_B),
      /analysis input manifest is immutable/
    );
    assert.throws(
      () => db.prepare("UPDATE analysis_input_segments SET speaker_binding_label = 'P1'").run(),
      /analysis input manifest is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM analysis_input_segments").run(),
      /analysis input manifest is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM transcript_segments WHERE id = 'segment-1'").run(),
      /FOREIGN KEY constraint failed|analysis input manifest is immutable|manifested transcript segment is immutable/
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM analysis_input_segments").get().count,
      1
    );
    assert.throws(
      () => db.prepare("UPDATE analysis_input_speaker_bindings SET subject_id = 'person-2'").run(),
      /analysis input speaker bindings are immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM analysis_inputs").run(),
      /analysis input is immutable/
    );
    for (const [column, value] of [
      ["input_contract_version", "jarvis-analysis-input-v1"],
      ["redaction_version", "jarvis-redaction-v2"],
      [
        "cloud_payload_json",
        JSON.stringify({ inputVersion: INPUT_CONTRACT_VERSION, changed: true }),
      ],
      ["cloud_payload_bytes", CLOUD_PAYLOAD_BYTES + 1],
      ["cloud_payload_sha256", HASH_E],
    ]) {
      assert.throws(
        () => db.prepare(`UPDATE analysis_inputs SET ${column} = ?`).run(value),
        /analysis input is immutable/,
        column
      );
    }
    assert.throws(
      () => db.prepare("UPDATE analysis_inputs SET candidate_hash = ?").run(HASH_A),
      /analysis input candidate CAS is invalid/
    );
    assert.equal(
      db
        .prepare(
          "UPDATE analysis_inputs SET candidate_hash = ?, applied_at = 7000 WHERE id = 'input-1'"
        )
        .run(HASH_A).changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE analysis_inputs SET candidate_hash = ?, applied_at = 8000 WHERE id = 'input-1'"
          )
          .run(HASH_B),
      /analysis input candidate CAS is invalid/
    );

    assert.equal(db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run().changes, 1);
    for (const table of [
      "analysis_inputs",
      "analysis_input_segments",
      "analysis_input_speaker_bindings",
    ]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("speaker bindings require durable targets and exact session scope", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at) VALUES
        ('person-1', 'Self', 1, 1000, 5000),
        ('person-other', 'Other', 0, 1000, 5000);
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-other', 1000, 5000, 'completed', 1000);
      INSERT INTO speaker_clusters (
        id, session_id, local_label, model_id, person_id, link_state, created_at, updated_at
      ) VALUES
        ('cluster-other', 'session-other', 'speaker_1', 'speaker-v1', 'person-other', 'confirmed', 5000, 5000),
        ('cluster-local', 'session-1', 'speaker_1', 'speaker-v1', 'person-other', 'confirmed', 5000, 5000),
        ('cluster-bound', 'session-1', 'speaker_2', 'speaker-v1', 'person-other', 'confirmed', 5000, 5000);
    `);
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-bindings', 'session-1', ?, ?, 'jarvis-analysis-v2',
         ?, ?, ?, ?, ?, ?, 6000
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );

    for (const label of ["P0", "P01", "P1junk", "P", "P 1"]) {
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO analysis_input_speaker_bindings (
                 analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
               ) VALUES ('input-bindings', ?, 'person', 'person-other', 'Other')`
            )
            .run(label),
        { code: "SQLITE_CONSTRAINT_CHECK" }
      );
    }

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P1', 'person', 'missing-person', 'Missing')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P2', 'person', 'person-1', 'Self')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'SELF', 'person', 'person-other', 'Other')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P1', 'speaker_cluster', 'cluster-other', 'speaker_1')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P4', 'person', 'person-other', 'Wrong snapshot')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P5', 'speaker_cluster', 'cluster-local', 'wrong_cluster')`
          )
          .run(),
      /analysis input speaker binding target is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_speaker_bindings (
               analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
             ) VALUES ('input-bindings', 'P6', 'person', 'person-other', '   ')`
          )
          .run(),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO analysis_input_speaker_bindings (
             analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
           ) VALUES ('input-bindings', 'P3', 'person', 'person-other', 'Other')`
        )
        .run().changes,
      1
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO analysis_input_speaker_bindings (
             analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
           ) VALUES ('input-bindings', 'P4', 'speaker_cluster', 'cluster-bound', 'speaker_2')`
        )
        .run().changes,
      1
    );

    assert.equal(
      db
        .prepare(
          "UPDATE people SET display_name = 'Renamed Other', is_self = 1 WHERE id = 'person-other'"
        )
        .run().changes,
      1
    );
    assert.equal(
      db
        .prepare(
          `UPDATE speaker_clusters
           SET local_label = 'speaker_renamed', person_id = NULL, link_state = 'rejected'
           WHERE id = 'cluster-local'`
        )
        .run().changes,
      1
    );
    assert.equal(
      db.prepare("DELETE FROM speaker_clusters WHERE id = 'cluster-bound'").run().changes,
      1
    );
    assert.equal(db.prepare("DELETE FROM people WHERE id = 'person-other'").run().changes, 1);
    assert.deepEqual(
      db
        .prepare(
          `SELECT label, subject_kind, subject_id, subject_display_name_snapshot
           FROM analysis_input_speaker_bindings
           WHERE analysis_input_id = 'input-bindings'
           ORDER BY label`
        )
        .all(),
      [
        {
          label: "P3",
          subject_kind: "person",
          subject_id: "person-other",
          subject_display_name_snapshot: "Other",
        },
        {
          label: "P4",
          subject_kind: "speaker_cluster",
          subject_id: "cluster-bound",
          subject_display_name_snapshot: "speaker_2",
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("todo owner snapshots require the exact analysis input binding and survive source deletion", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at) VALUES
        ('person-1', 'Self', 1, 1000, 5000),
        ('person-bound', 'Bound person', 0, 1000, 5000),
        ('person-outside', 'Outside person', 0, 1000, 5000);
      INSERT INTO speaker_clusters (
        id, session_id, local_label, model_id, person_id, link_state, created_at, updated_at
      ) VALUES
        ('cluster-person-bound', 'session-1', 'speaker_1', 'speaker-v1', 'person-bound', 'confirmed', 5000, 5000),
        ('cluster-bound', 'session-1', 'speaker_2', 'speaker-v1', NULL, 'unknown', 5000, 5000),
        ('cluster-outside', 'session-1', 'speaker_3', 'speaker-v1', 'person-outside', 'confirmed', 5000, 5000);
    `);
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-owner-snapshots', 'session-1', ?, ?, 'jarvis-analysis-v2',
         ?, ?, ?, ?, ?, ?, 6000
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );
    db.exec(`
      INSERT INTO analysis_input_speaker_bindings (
        analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
      ) VALUES
        ('input-owner-snapshots', 'P1', 'person', 'person-bound', 'Bound person'),
        ('input-owner-snapshots', 'P2', 'speaker_cluster', 'cluster-bound', 'speaker_2');
    `);

    const insertTodo = db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
         status, source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES (
         @id, @canonicalBaseKey, @instanceKey, @title,
         @ownerSubjectKind, @ownerSubjectId, @ownerDisplayNameSnapshot,
         'open', @sourceAnalysisInputId, @provenance, 6000, 6000
       )`
    );
    const modelTodo = {
      canonicalBaseKey: HASH_A,
      title: "Bound todo",
      sourceAnalysisInputId: "input-owner-snapshots",
      provenance: "evidence_linked",
    };

    assert.equal(
      insertTodo.run({
        ...modelTodo,
        id: "todo-person-owner",
        instanceKey: HASH_B,
        ownerSubjectKind: "person",
        ownerSubjectId: "person-bound",
        ownerDisplayNameSnapshot: "Bound person",
      }).changes,
      1
    );
    assert.equal(
      insertTodo.run({
        ...modelTodo,
        id: "todo-cluster-owner",
        instanceKey: HASH_C,
        ownerSubjectKind: "speaker_cluster",
        ownerSubjectId: "cluster-bound",
        ownerDisplayNameSnapshot: "speaker_2",
      }).changes,
      1
    );
    assert.throws(
      () =>
        insertTodo.run({
          ...modelTodo,
          id: "todo-wrong-snapshot",
          instanceKey: HASH_D,
          ownerSubjectKind: "person",
          ownerSubjectId: "person-bound",
          ownerDisplayNameSnapshot: "Renamed person",
        }),
      /todo owner binding is invalid/
    );
    assert.throws(
      () =>
        insertTodo.run({
          ...modelTodo,
          id: "todo-wrong-cluster-snapshot",
          instanceKey: HASH_D,
          ownerSubjectKind: "speaker_cluster",
          ownerSubjectId: "cluster-bound",
          ownerDisplayNameSnapshot: "speaker_renamed",
        }),
      /todo owner binding is invalid/
    );
    assert.throws(
      () =>
        insertTodo.run({
          ...modelTodo,
          id: "todo-owner-outside-input",
          instanceKey: HASH_D,
          ownerSubjectKind: "speaker_cluster",
          ownerSubjectId: "cluster-outside",
          ownerDisplayNameSnapshot: "speaker_3",
        }),
      /todo owner binding is invalid/
    );
    assert.equal(
      insertTodo.run({
        ...modelTodo,
        id: "todo-model-without-owner",
        instanceKey: HASH_D,
        ownerSubjectKind: null,
        ownerSubjectId: null,
        ownerDisplayNameSnapshot: null,
      }).changes,
      1
    );
    assert.throws(
      () =>
        insertTodo.run({
          ...modelTodo,
          id: "todo-blank-snapshot",
          instanceKey: HASH_D,
          ownerSubjectKind: "person",
          ownerSubjectId: "person-bound",
          ownerDisplayNameSnapshot: "   ",
          sourceAnalysisInputId: null,
          provenance: "legacy_unverified",
        }),
      /todo owner shape is invalid/
    );
    assert.throws(
      () =>
        insertTodo.run({
          id: "todo-owner-without-snapshot",
          canonicalBaseKey: HASH_D,
          instanceKey: HASH_E,
          title: "Missing historical snapshot",
          ownerSubjectKind: "person",
          ownerSubjectId: "deleted-person",
          ownerDisplayNameSnapshot: null,
          sourceAnalysisInputId: null,
          provenance: "legacy_unverified",
        }),
      /todo owner shape is invalid/
    );
    assert.throws(
      () =>
        insertTodo.run({
          id: "todo-snapshot-without-owner",
          canonicalBaseKey: HASH_D,
          instanceKey: HASH_E,
          title: "Orphaned historical snapshot",
          ownerSubjectKind: null,
          ownerSubjectId: null,
          ownerDisplayNameSnapshot: "Historical name",
          sourceAnalysisInputId: null,
          provenance: "legacy_unverified",
        }),
      /todo owner shape is invalid/
    );
    assert.equal(
      insertTodo.run({
        id: "todo-legacy-owner",
        canonicalBaseKey: HASH_D,
        instanceKey: HASH_E,
        title: "Historical owner",
        ownerSubjectKind: "person",
        ownerSubjectId: "deleted-person",
        ownerDisplayNameSnapshot: "Historical name",
        sourceAnalysisInputId: null,
        provenance: "legacy_unverified",
      }).changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE todos_v2
             SET owner_display_name_snapshot = 'Hostile rewrite'
             WHERE id = 'todo-legacy-owner'`
          )
          .run(),
      /todo content is immutable/
    );

    assert.equal(db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run().changes, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM speaker_clusters").get().count, 0);
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
                  source_analysis_input_id, provenance
           FROM todos_v2
           ORDER BY id`
        )
        .all(),
      [
        {
          id: "todo-cluster-owner",
          owner_subject_kind: "speaker_cluster",
          owner_subject_id: "cluster-bound",
          owner_display_name_snapshot: "speaker_2",
          source_analysis_input_id: null,
          provenance: "source_deleted",
        },
        {
          id: "todo-legacy-owner",
          owner_subject_kind: "person",
          owner_subject_id: "deleted-person",
          owner_display_name_snapshot: "Historical name",
          source_analysis_input_id: null,
          provenance: "legacy_unverified",
        },
        {
          id: "todo-model-without-owner",
          owner_subject_kind: null,
          owner_subject_id: null,
          owner_display_name_snapshot: null,
          source_analysis_input_id: null,
          provenance: "source_deleted",
        },
        {
          id: "todo-person-owner",
          owner_subject_kind: "person",
          owner_subject_id: "person-bound",
          owner_display_name_snapshot: "Bound person",
          source_analysis_input_id: null,
          provenance: "source_deleted",
        },
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("analysis input segments accept only current final same-session manifest evidence", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Self', 1, 1000, 5000);
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, analysis_state, source_type, result_kind, version
      ) VALUES (
        'segment-provisional', 'session-1', 1000, 2000, 'SELF', 'mutable', 0.8,
        1, 'pending', 'mic', 'provisional', 1
      );
    `);
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-segments', 'session-1', ?, ?, 'jarvis-analysis-v2',
         ?, ?, ?, ?, ?, ?, 6000
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );
    db.prepare(
      `INSERT INTO analysis_input_speaker_bindings (
         analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
       ) VALUES ('input-segments', 'SELF', 'person', 'person-1', 'Self')`
    ).run();

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_segments (
               analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
               speaker_binding_label
             ) VALUES ('input-segments', 0, 'segment-provisional', 1, ?, 'mutable', 'SELF')`
          )
          .run(HASH_A),
      /analysis input segment is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_segments (
               analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
               speaker_binding_label
             ) VALUES ('input-segments', 0, 'segment-1', 2, ?, 'durable evidence', 'SELF')`
          )
          .run(HASH_A),
      /analysis input segment is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_input_segments (
               analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
               speaker_binding_label
             ) VALUES ('input-segments', 1, 'segment-1', 1, ?, 'durable evidence', 'SELF')`
          )
          .run(HASH_A),
      /analysis input segment ordinal is invalid/
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO analysis_input_segments (
             analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
             speaker_binding_label
           ) VALUES ('input-segments', 0, 'segment-1', 1, ?, 'durable evidence', 'SELF')`
        )
        .run(HASH_A).changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE transcript_segments SET text = 'rewritten' WHERE id = 'segment-1'")
          .run(),
      /manifested transcript segment is immutable/
    );
  } finally {
    db.close();
  }
});

test("history is immutable while session cascade removes owned occurrences and evidence only", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);
    insertEvidence(db);
    db.prepare(
      `INSERT INTO memory_items_v2 (
         id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
         lifecycle, source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES (
         'memory-2', 'fact', ?, ?, 'Replacement', 'Durable replacement', 0.95,
         'active', 'input-1', 'evidence_linked', 7000, 7000
       )`
    ).run(HASH_A, HASH_C);
    db.exec(`
      INSERT INTO memory_supersessions (
        previous_id, next_id, reason, analysis_input_id, created_at
      ) VALUES ('memory-1', 'memory-2', 'transcript_replacement', 'input-1', 7000);

      INSERT INTO todos_v2 (
        id, canonical_base_key, instance_key, title,
        owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
        status, completed_at,
        source_analysis_input_id, provenance, created_at, updated_at
      ) VALUES (
        'todo-history-previous', '${HASH_D}', '${HASH_E}', 'Previous',
        'person', 'person-1', 'Local', 'completed', 5000,
        'input-1', 'evidence_linked', 4000, 5000
      );
      INSERT INTO todos_v2 (
        id, canonical_base_key, instance_key, title,
        owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
        status, recurrence_of_id,
        source_analysis_input_id, provenance, created_at, updated_at
      ) VALUES (
        'todo-history-next', '${HASH_D}', '${HASH_F}', 'Next',
        'person', 'person-1', 'Local', 'open', 'todo-history-previous',
        'input-1', 'evidence_linked', 6000, 6000
      );
      INSERT INTO todo_revisions (
        id, todo_instance_id, revision, title, source_analysis_input_id, provenance, created_at
      ) VALUES (
        'todo-history-revision', 'todo-history-next', 1, 'Next',
        'input-1', 'evidence_linked', 6000
      );
      INSERT INTO todo_occurrences (
        id, todo_instance_id, todo_revision_id, analysis_input_id, occurrence_key,
        candidate_item_fingerprint, started_at, ended_at, created_at
      ) VALUES (
        'todo-history-occurrence', 'todo-history-next', 'todo-history-revision', 'input-1',
        '${HASH_D}', '${HASH_E}', 6000, 6000, 6000
      );
      INSERT INTO todo_recurrences (
        id, previous_todo_id, next_todo_id, source_occurrence_id, created_at
      ) VALUES (
        'todo-history-recurrence', 'todo-history-previous', 'todo-history-next',
        'todo-history-occurrence', 6000
      );
      INSERT INTO todo_state_transitions (
        id, todo_instance_id, from_status, to_status, reason,
        source_analysis_input_id, actor, occurred_at
      ) VALUES (
        'todo-history-transition', 'todo-history-next', NULL, 'open', 'recurrence',
        'input-1', 'system', 6000
      );
    `);

    assert.throws(
      () => db.prepare("UPDATE memory_occurrences SET candidate_item_fingerprint = ?").run(HASH_C),
      /memory occurrence is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM memory_occurrences").run(),
      /memory occurrence is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM memory_items_v2").run(),
      /memory item cannot be deleted/
    );
    assert.throws(
      () => db.prepare("UPDATE memory_items_v2 SET body = 'rewritten'").run(),
      /memory item content is immutable/
    );
    assert.throws(
      () => db.prepare("UPDATE evidence_refs SET quote_text = 'forged'").run(),
      /evidence reference is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM evidence_refs").run(),
      /evidence reference is immutable/
    );
    assert.throws(
      () => db.prepare("UPDATE memory_supersessions SET analysis_input_id = NULL").run(),
      /memory supersession source can only be cleared when its input is deleted/
    );
    assert.throws(
      () => db.prepare("UPDATE todo_state_transitions SET source_analysis_input_id = NULL").run(),
      /todo state transition source can only be cleared when its input is deleted/
    );
    assert.throws(
      () => db.prepare("UPDATE todo_recurrences SET source_occurrence_id = NULL").run(),
      /todo recurrence source can only be cleared when its occurrence is deleted/
    );

    assert.equal(db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run().changes, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 0);
    assert.deepEqual(
      db
        .prepare("SELECT id, source_analysis_input_id, provenance FROM memory_items_v2 ORDER BY id")
        .all(),
      [
        { id: "memory-1", source_analysis_input_id: null, provenance: "source_deleted" },
        { id: "memory-2", source_analysis_input_id: null, provenance: "source_deleted" },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT previous_id, next_id, reason, analysis_input_id, created_at
           FROM memory_supersessions`
        )
        .get(),
      {
        previous_id: "memory-1",
        next_id: "memory-2",
        reason: "transcript_replacement",
        analysis_input_id: null,
        created_at: 7000,
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT todo_instance_id, from_status, to_status, reason,
                  source_analysis_input_id, actor, occurred_at
           FROM todo_state_transitions
           WHERE id = 'todo-history-transition'`
        )
        .get(),
      {
        todo_instance_id: "todo-history-next",
        from_status: null,
        to_status: "open",
        reason: "recurrence",
        source_analysis_input_id: null,
        actor: "system",
        occurred_at: 6000,
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT previous_todo_id, next_todo_id, source_occurrence_id, created_at
           FROM todo_recurrences
           WHERE id = 'todo-history-recurrence'`
        )
        .get(),
      {
        previous_todo_id: "todo-history-previous",
        next_todo_id: "todo-history-next",
        source_occurrence_id: null,
        created_at: 6000,
      }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM todos_v2").get().count, 2);
    assert.throws(
      () => db.prepare("DELETE FROM memory_supersessions").run(),
      /memory supersession is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM todo_state_transitions").run(),
      /todo state transition is immutable/
    );
    assert.throws(
      () => db.prepare("DELETE FROM todo_recurrences").run(),
      /todo recurrence is immutable/
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("relation guards enforce predecessor, slot, conflict, terminal, and polymorphic invariants", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);
    db.prepare(
      `INSERT INTO memory_items_v2 (
         id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
         lifecycle, source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES (
         'memory-other-slot', 'fact', ?, ?, 'Other', 'Other', 0.8,
         'active', 'input-1', 'evidence_linked', 6000, 6000
       )`
    ).run(HASH_C, "d".repeat(64));
    insertMemoryCanonicalBridge(db, {
      memoryItemId: "memory-other-slot",
      kind: "fact",
      title: "Other",
    });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_supersessions (
               previous_id, next_id, reason, analysis_input_id, created_at
             ) VALUES ('memory-1', 'memory-other-slot', 'transcript_replacement', 'input-1', 7000)`
          )
          .run(),
      /memory supersession slot mismatch/
    );

    db.prepare(
      `INSERT INTO memory_conflict_groups (
         id, slot_key, episode, state, created_at, updated_at
       ) VALUES ('conflict-1', ?, 1, 'open', 6000, 6000)`
    ).run(HASH_A);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at)
             VALUES ('conflict-1', 'memory-other-slot', 6000)`
          )
          .run(),
      /memory conflict slot mismatch/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE memory_conflict_groups
             SET state = 'resolved', selected_member_id = 'memory-1', resolved_at = 7000
             WHERE id = 'conflict-1'`
          )
          .run(),
      /memory conflict resolution is invalid/
    );
    db.exec(
      `INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at)
       VALUES ('conflict-1', 'memory-1', 7000)`
    );
    db.exec(
      `UPDATE memory_conflict_groups
       SET state = 'resolved', selected_member_id = 'memory-1', resolved_at = 7000, updated_at = 7000
       WHERE id = 'conflict-1'`
    );
    assert.throws(
      () =>
        db.exec(
          `UPDATE memory_conflict_groups
           SET state = 'open', selected_member_id = NULL, resolved_at = NULL, updated_at = 8000
           WHERE id = 'conflict-1'`
        ),
      /memory conflict resolution is terminal/
    );

    db.prepare(
      `INSERT INTO topics_v2 (
         id, canonical_key, name, canonical_algorithm, lifecycle, source_analysis_input_id,
         provenance, created_at, updated_at
       ) VALUES (
         'topic-1', ?, 'Topic one', 'canonical-v1', 'active',
         'input-1', 'evidence_linked', 6000, 6000
       )`
    ).run(HASH_A);
    assert.throws(
      () => db.prepare("UPDATE topics_v2 SET name = 'Rewritten' WHERE id = 'topic-1'").run(),
      /topic identity is immutable/
    );
    db.prepare(
      `INSERT INTO topic_revisions (
         id, topic_id, revision, summary, source_analysis_input_id,
         provenance, created_at
       ) VALUES ('topic-revision-1', 'topic-1', 1, 'one', 'input-1', 'evidence_linked', 6000)`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO topic_revisions (
               id, topic_id, revision, previous_revision_id, summary,
               source_analysis_input_id, provenance, created_at
             ) VALUES (
               'topic-revision-3', 'topic-1', 3, 'topic-revision-1', 'three',
               'input-1', 'evidence_linked', 7000
             )`
          )
          .run(),
      /topic revision predecessor is invalid/
    );

    db.prepare(
      `INSERT INTO todos_v2 (
       id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot, status,
         completed_at, source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES (
         'todo-1', ?, ?, 'Do it', 'person', 'person-1', 'Local', 'completed',
         6000, 'input-1', 'evidence_linked', 6000, 6000
       )`
    ).run(HASH_A, HASH_B);
    assert.throws(
      () => db.prepare("UPDATE todos_v2 SET title = 'Rewritten' WHERE id = 'todo-1'").run(),
      /todo content is immutable/
    );
    assert.throws(
      () => db.prepare("UPDATE todos_v2 SET completed_at = 7000 WHERE id = 'todo-1'").run(),
      /todo (terminal state is immutable|state change requires transition history)/
    );
    assert.throws(
      () => db.prepare("UPDATE todos_v2 SET status = 'open' WHERE id = 'todo-1'").run(),
      /todo (terminal state is immutable|state change requires transition history)/
    );
    db.prepare(
      `INSERT INTO suggestions_v2 (
         id, canonical_key, title, rationale, state,
         source_analysis_input_id, provenance, decided_at, created_at, updated_at
       ) VALUES (
         'suggestion-1', ?, 'Maybe', 'Because', 'dismissed',
         'input-1', 'suggestion', 6000, 6000, 6000
       )`
    ).run(HASH_A);
    assert.throws(
      () =>
        db
          .prepare("UPDATE suggestions_v2 SET rationale = 'Rewritten' WHERE id = 'suggestion-1'")
          .run(),
      /suggestion content is immutable/
    );
    assert.throws(
      () =>
        db.prepare("UPDATE suggestions_v2 SET decided_at = 7000 WHERE id = 'suggestion-1'").run(),
      /suggestion terminal state is immutable/
    );
    assert.throws(
      () =>
        db.prepare("UPDATE suggestions_v2 SET state = 'proposed' WHERE id = 'suggestion-1'").run(),
      /suggestion terminal state is immutable/
    );

    assert.throws(
      () => insertEvidence(db, { entityId: "missing-occurrence" }),
      /evidence target does not exist/
    );
    insertEvidence(db);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE evidence_refs SET entity_id = 'missing-occurrence' WHERE id = 'evidence-1'"
          )
          .run(),
      /evidence target does not exist/
    );
    assert.equal(
      db
        .prepare("PRAGMA table_info(memory_items_v2)")
        .all()
        .some((column) => column.name === "supersedes_id"),
      false
    );
  } finally {
    db.close();
  }
});

test("occurrences are idempotent per input and revisions must belong to their canonical entity", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);
    db.prepare(
      `INSERT INTO topics_v2 (
         id, canonical_key, name, canonical_algorithm, lifecycle,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES
         ('topic-1', ?, 'Topic one', 'canonical-v1', 'active',
          'input-1', 'evidence_linked', 6000, 6000),
         ('topic-2', ?, 'Topic two', 'canonical-v1', 'active',
          'input-1', 'evidence_linked', 6000, 6000)`
    ).run(HASH_D, HASH_E);
    db.exec(`
      INSERT INTO topic_revisions (
        id, topic_id, revision, summary, source_analysis_input_id, provenance, created_at
      ) VALUES
        ('topic-revision-1', 'topic-1', 1, 'one', 'input-1', 'evidence_linked', 6000),
        ('topic-revision-2', 'topic-2', 1, 'two', 'input-1', 'evidence_linked', 6000);
    `);
    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot, status,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES
         ('todo-1', ?, ?, 'Todo one', 'person', 'person-1', 'Local', 'open',
          'input-1', 'evidence_linked', 6000, 6000),
         ('todo-2', ?, ?, 'Todo two', 'person', 'person-1', 'Local', 'open',
          'input-1', 'evidence_linked', 6000, 6000)`
    ).run(HASH_A, HASH_D, HASH_B, HASH_E);
    db.exec(`
      INSERT INTO todo_revisions (
        id, todo_instance_id, revision, title, source_analysis_input_id, provenance, created_at
      ) VALUES
        ('todo-revision-1', 'todo-1', 1, 'Todo one', 'input-1', 'evidence_linked', 6000),
        ('todo-revision-2', 'todo-2', 1, 'Todo two', 'input-1', 'evidence_linked', 6000);
    `);
    db.prepare(
      `INSERT INTO suggestions_v2 (
         id, canonical_key, title, rationale, state,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES ('suggestion-1', ?, 'Suggestion', 'Rationale', 'proposed',
                 'input-1', 'suggestion', 6000, 6000)`
    ).run(HASH_F);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_occurrences (
               id, memory_value_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, confidence, created_at
             ) VALUES ('memory-occurrence-duplicate', 'memory-1', 'input-1', ?, ?, 0.8, 6001)`
          )
          .run(HASH_C, HASH_B),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );

    db.prepare(
      `INSERT INTO topic_occurrences (
         id, topic_id, topic_revision_id, analysis_input_id, occurrence_key,
         candidate_item_fingerprint, created_at
       ) VALUES ('topic-occurrence-1', 'topic-1', 'topic-revision-1', 'input-1', ?, ?, 6000)`
    ).run(HASH_A, HASH_B);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO topic_occurrences (
               id, topic_id, topic_revision_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, created_at
             ) VALUES ('topic-occurrence-duplicate', 'topic-1', 'topic-revision-1',
                       'input-1', ?, ?, 6001)`
          )
          .run(HASH_C, HASH_B),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO topic_occurrences (
               id, topic_id, topic_revision_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, created_at
             ) VALUES ('topic-occurrence-wrong-owner', 'topic-1', 'topic-revision-2',
                       'input-1', ?, ?, 6001)`
          )
          .run(HASH_D, HASH_E),
      /topic occurrence revision owner is invalid/
    );

    db.prepare(
      `INSERT INTO todo_occurrences (
         id, todo_instance_id, todo_revision_id, analysis_input_id, occurrence_key,
         candidate_item_fingerprint, started_at, ended_at, created_at
       ) VALUES ('todo-occurrence-1', 'todo-1', 'todo-revision-1', 'input-1',
                 ?, ?, 1000, 5000, 6000)`
    ).run(HASH_A, HASH_B);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_occurrences (
               id, todo_instance_id, todo_revision_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, created_at
             ) VALUES ('todo-occurrence-duplicate', 'todo-1', 'todo-revision-1',
                       'input-1', ?, ?, 6001)`
          )
          .run(HASH_C, HASH_B),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_occurrences (
               id, todo_instance_id, todo_revision_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, created_at
             ) VALUES ('todo-occurrence-wrong-owner', 'todo-1', 'todo-revision-2',
                       'input-1', ?, ?, 6001)`
          )
          .run(HASH_D, HASH_E),
      /todo occurrence revision owner is invalid/
    );

    db.prepare(
      `INSERT INTO suggestion_occurrences (
         id, suggestion_id, analysis_input_id, occurrence_key,
         candidate_item_fingerprint, created_at
       ) VALUES ('suggestion-occurrence-1', 'suggestion-1', 'input-1', ?, ?, 6000)`
    ).run(HASH_A, HASH_B);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO suggestion_occurrences (
               id, suggestion_id, analysis_input_id, occurrence_key,
               candidate_item_fingerprint, created_at
             ) VALUES ('suggestion-occurrence-duplicate', 'suggestion-1',
                       'input-1', ?, ?, 6001)`
          )
          .run(HASH_C, HASH_B),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
  } finally {
    db.close();
  }
});

test("resolved conflict membership authorizes only the selected and superseded lifecycle outcomes", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    db.exec(`
      INSERT INTO memory_items_v2 (
        id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
        lifecycle, source_analysis_input_id, provenance, created_at, updated_at
      ) VALUES
        ('memory-selected', 'fact', '${HASH_A}', '${HASH_B}', 'Conflict lifecycle', 'Selected', 0.9,
         'conflict', 'input-1', 'evidence_linked', 6000, 6000),
        ('memory-loser', 'fact', '${HASH_A}', '${HASH_C}', 'Conflict lifecycle', 'Loser', 0.8,
         'conflict', 'input-1', 'evidence_linked', 6000, 6000),
        ('memory-dismissed', 'fact', '${HASH_A}', '${HASH_D}', 'Dismissed', 'Dismissed', 0.7,
         'dismissed', 'input-1', 'evidence_linked', 6000, 6000);
    `);
    insertMemoryCanonicalBridge(db, {
      memoryItemId: "memory-selected",
      kind: "fact",
      title: "Conflict lifecycle",
    });
    insertMemoryCanonicalBridge(db, {
      memoryItemId: "memory-loser",
      kind: "fact",
      title: "Conflict lifecycle",
    });
    insertMemoryCanonicalBridge(db, {
      memoryItemId: "memory-dismissed",
      kind: "fact",
      title: "Dismissed",
    });
    db.exec(`
      INSERT INTO memory_conflict_groups (
        id, slot_key, episode, state, created_at, updated_at
      ) VALUES ('conflict-lifecycle-1', '${HASH_A}', 1, 'open', 6000, 6000);
      INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at) VALUES
        ('conflict-lifecycle-1', 'memory-selected', 6000),
        ('conflict-lifecycle-1', 'memory-loser', 6000);
    `);

    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'active' WHERE id = 'memory-selected'")
          .run(),
      /memory item lifecycle/
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'superseded' WHERE id = 'memory-loser'")
          .run(),
      /memory item lifecycle/
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'dismissed' WHERE id = 'memory-loser'")
          .run(),
      /memory item lifecycle/
    );

    db.exec(`
      UPDATE memory_conflict_groups
      SET state = 'resolved', selected_member_id = 'memory-selected',
          resolved_at = 7000, updated_at = 7000
      WHERE id = 'conflict-lifecycle-1';
    `);
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'active' WHERE id = 'memory-loser'")
          .run(),
      /memory item lifecycle/
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE memory_items_v2 SET lifecycle = 'superseded' WHERE id = 'memory-selected'"
          )
          .run(),
      /memory item lifecycle/
    );
    assert.equal(
      db
        .prepare(
          "UPDATE memory_items_v2 SET lifecycle = 'active', updated_at = 7000 WHERE id = 'memory-selected'"
        )
        .run().changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'superseded' WHERE id = 'memory-loser'")
          .run(),
      /memory item lifecycle/
    );

    db.exec(`
      INSERT INTO memory_supersessions (
        previous_id, next_id, reason, analysis_input_id, created_at
      ) VALUES (
        'memory-loser', 'memory-selected', 'conflict_resolution', 'input-1', 7000
      );
    `);
    assert.equal(
      db
        .prepare(
          "UPDATE memory_items_v2 SET lifecycle = 'superseded', updated_at = 7000 WHERE id = 'memory-loser'"
        )
        .run().changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'active' WHERE id = 'memory-loser'")
          .run(),
      /memory item lifecycle/
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'active' WHERE id = 'memory-dismissed'")
          .run(),
      /memory item lifecycle/
    );

    db.exec(`
      INSERT INTO memory_items_v2 (
        id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
        lifecycle, source_analysis_input_id, provenance, created_at, updated_at
      ) VALUES (
        'memory-challenger', 'fact', '${HASH_A}', '${HASH_E}',
        'Conflict lifecycle', 'Challenger', 0.85,
        'conflict', 'input-1', 'evidence_linked', 8000, 8000
      );
    `);
    insertMemoryCanonicalBridge(db, {
      memoryItemId: "memory-challenger",
      kind: "fact",
      title: "Conflict lifecycle",
    });
    db.exec(`
      INSERT INTO memory_conflict_groups (
        id, slot_key, episode, state, created_at, updated_at
      ) VALUES ('conflict-lifecycle-2', '${HASH_A}', 2, 'open', 8000, 8000);
      INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at) VALUES
        ('conflict-lifecycle-2', 'memory-selected', 8000),
        ('conflict-lifecycle-2', 'memory-challenger', 8000);
    `);
    assert.equal(
      db
        .prepare(
          "UPDATE memory_items_v2 SET lifecycle = 'conflict', updated_at = 8000 WHERE id = 'memory-selected'"
        )
        .run().changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_items_v2 SET lifecycle = 'active' WHERE id = 'memory-selected'")
          .run(),
      /memory item lifecycle/
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, episode, state, selected_member_id, resolved_at
           FROM memory_conflict_groups
           WHERE slot_key = ?
           ORDER BY episode`
        )
        .all(HASH_A),
      [
        {
          id: "conflict-lifecycle-1",
          episode: 1,
          state: "resolved",
          selected_member_id: "memory-selected",
          resolved_at: 7000,
        },
        {
          id: "conflict-lifecycle-2",
          episode: 2,
          state: "open",
          selected_member_id: null,
          resolved_at: null,
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("conflicts, recurrences, acceptances, and topic merges preserve explicit durable relations", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_conflict_groups (
               id, slot_key, episode, state, selected_member_id, resolved_at, created_at, updated_at
             ) VALUES ('conflict-resolved', ?, 1, 'resolved', 'memory-1', 7000, 6000, 7000)`
          )
          .run(HASH_A),
      /memory conflict must be created open/
    );
    db.prepare(
      `INSERT INTO memory_conflict_groups (id, slot_key, episode, state, created_at, updated_at)
       VALUES ('conflict-1', ?, 1, 'open', 6000, 6000)`
    ).run(HASH_A);
    db.exec(
      `INSERT INTO memory_conflict_members (group_id, memory_item_id, created_at)
       VALUES ('conflict-1', 'memory-1', 6000)`
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_conflict_groups SET slot_key = ? WHERE id = 'conflict-1'")
          .run(HASH_B),
      /memory conflict identity is immutable/
    );
    assert.throws(
      () =>
        db.prepare("UPDATE memory_conflict_groups SET episode = 2 WHERE id = 'conflict-1'").run(),
      /memory conflict identity is immutable/
    );
    db.exec(`
      UPDATE memory_conflict_groups
      SET state = 'resolved', selected_member_id = 'memory-1', resolved_at = 7000, updated_at = 7000
      WHERE id = 'conflict-1';
    `);
    assert.throws(
      () =>
        db
          .prepare("UPDATE memory_conflict_groups SET updated_at = 8000 WHERE id = 'conflict-1'")
          .run(),
      /memory conflict resolution is terminal/
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO memory_conflict_groups (id, slot_key, episode, state, created_at, updated_at)
           VALUES ('conflict-2', ?, 2, 'open', 8000, 8000)`
        )
        .run(HASH_A).changes,
      1
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_conflict_groups (id, slot_key, episode, state, created_at, updated_at)
             VALUES ('conflict-3', ?, 3, 'open', 9000, 9000)`
          )
          .run(HASH_A),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT id, slot_key, episode, state, selected_member_id, resolved_at, created_at, updated_at
           FROM memory_conflict_groups
           WHERE id = 'conflict-1'`
        )
        .get(),
      {
        id: "conflict-1",
        slot_key: HASH_A,
        episode: 1,
        state: "resolved",
        selected_member_id: "memory-1",
        resolved_at: 7000,
        created_at: 6000,
        updated_at: 7000,
      }
    );

    db.prepare(
      `INSERT INTO topics_v2 (
         id, canonical_key, name, canonical_algorithm, lifecycle,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES
         ('topic-1', ?, 'Alpha', 'canonical-v1', 'active', 'input-1', 'evidence_linked', 6000, 6000),
         ('topic-2', ?, 'Beta', 'canonical-v1', 'active', 'input-1', 'evidence_linked', 6000, 6000)`
    ).run(HASH_D, HASH_E);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO topic_merge_suggestions (
             id, left_topic_id, right_topic_id, pair_key, algorithm_version,
             score, state, created_at, updated_at
           ) VALUES ('merge-reversed', 'topic-2', 'topic-1', ?, 'dice-bigram-v1',
                     0.8, 'proposed', 6000, 6000)`
          )
          .run(HASH_A),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO topic_merge_suggestions (
             id, left_topic_id, right_topic_id, pair_key, algorithm_version,
             score, state, created_at, updated_at
           ) VALUES ('merge-wrong-algorithm', 'topic-1', 'topic-2', ?, 'fuzzy-v2',
                     0.8, 'proposed', 6000, 6000)`
          )
          .run(HASH_B),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );

    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
         status, completed_at,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES ('todo-previous', ?, ?, 'Previous',
                 'person', 'person-1', 'Local', 'completed', 6000,
                 'input-1', 'evidence_linked', 5000, 6000)`
    ).run(HASH_A, HASH_D);
    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot,
         status, recurrence_of_id,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES ('todo-next', ?, ?, 'Next',
                 'person', 'person-1', 'Local', 'open', 'todo-previous',
                 'input-1', 'evidence_linked', 7000, 7000)`
    ).run(HASH_A, HASH_E);
    db.exec(`
      INSERT INTO todo_revisions (
        id, todo_instance_id, revision, title, source_analysis_input_id, provenance, created_at
      ) VALUES ('todo-next-revision', 'todo-next', 1, 'Next', 'input-1', 'evidence_linked', 7000);
      INSERT INTO todo_occurrences (
        id, todo_instance_id, todo_revision_id, analysis_input_id, occurrence_key,
        candidate_item_fingerprint, started_at, ended_at, created_at
      ) VALUES
        ('todo-next-occurrence-equal', 'todo-next', 'todo-next-revision', 'input-1',
         '${HASH_A}', '${HASH_B}', 6000, 6000, 6000),
        ('todo-next-occurrence', 'todo-next', 'todo-next-revision', 'input-1',
         '${HASH_C}', '${HASH_D}', 7000, 7000, 7000);
    `);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_recurrences (
               id, previous_todo_id, next_todo_id, source_occurrence_id, created_at
             ) VALUES (
               'recurrence-equal', 'todo-previous', 'todo-next',
               'todo-next-occurrence-equal', 6000
             )`
          )
          .run(),
      /todo recurrence relation is invalid/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_recurrences (
               id, previous_todo_id, next_todo_id, source_occurrence_id, created_at
             ) VALUES (
               'recurrence-missing-source', 'todo-previous', 'todo-next', NULL, 7000
             )`
          )
          .run(),
      /todo recurrence relation is invalid/
    );
    assert.equal(
      db
        .prepare(
          `INSERT INTO todo_recurrences (
           id, previous_todo_id, next_todo_id, source_occurrence_id, created_at
         ) VALUES ('recurrence-1', 'todo-previous', 'todo-next', 'todo-next-occurrence', 7000)`
        )
        .run().changes,
      1
    );
    assert.throws(
      () => db.prepare("UPDATE todo_recurrences SET created_at = 8000").run(),
      /todo recurrence is immutable/
    );

    db.prepare(
      `INSERT INTO suggestions_v2 (
         id, canonical_key, title, rationale, state,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES ('suggestion-proposed', ?, 'Proposed', 'Wait', 'proposed',
                 'input-1', 'suggestion', 6000, 6000)`
    ).run(HASH_F);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO suggestion_acceptances (
             suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
           ) VALUES ('suggestion-proposed', 'todo-next', 'action-1', 'user', 7000)`
          )
          .run(),
      /suggestion acceptance requires accepted suggestion/
    );
    db.prepare(
      `UPDATE suggestions_v2
       SET state = 'accepted', decided_at = 7000, updated_at = 7000
       WHERE id = 'suggestion-proposed'`
    ).run();
    assert.equal(
      db
        .prepare(
          `INSERT INTO suggestion_acceptances (
           suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
         ) VALUES ('suggestion-proposed', 'todo-next', 'action-1', 'user', 7000)`
        )
        .run().changes,
      1
    );
  } finally {
    db.close();
  }
});

test("todo transition reasons enforce the actor, source, and state-shape contract", () => {
  const db = createPreviousVersionDatabase();
  try {
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-transition-contract', 1000, 5000, 'completed', 1000);
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-transition-contract', 'session-transition-contract', ?, ?,
         'jarvis-analysis-v2', ?, ?, ?, ?, ?, ?, 6000
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );
    db.exec(`
      INSERT INTO analysis_input_speaker_bindings (
        analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
      ) VALUES ('input-transition-contract', 'SELF', 'person', 'person-1', 'Local');
    `);
    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title,
         owner_subject_kind, owner_subject_id, owner_display_name_snapshot, status,
         source_analysis_input_id, provenance, created_at, updated_at
       ) VALUES
         ('todo-analysis-created', ?, ?, 'Created', 'person', 'person-1', 'Local', 'open',
          'input-transition-contract', 'evidence_linked', 6000, 6000),
         ('todo-recurrence-created', ?, ?, 'Recurrence', 'person', 'person-1', 'Local', 'open',
          'input-transition-contract', 'evidence_linked', 6000, 6000),
         ('todo-user-action', ?, ?, 'User action', 'person', 'person-1', 'Local', 'open',
          'input-transition-contract', 'evidence_linked', 6000, 6000),
         ('todo-suggestion-acceptance', ?, ?, 'Suggestion acceptance',
          'person', 'person-1', 'Local', 'open',
          'input-transition-contract', 'evidence_linked', 6000, 6000)`
    ).run(HASH_A, HASH_B, HASH_A, HASH_C, HASH_A, HASH_D, HASH_A, HASH_E);

    const insertTransition = ({
      id,
      todoId,
      fromStatus,
      toStatus,
      reason,
      sourceAnalysisInputId,
      actor,
    }) =>
      db
        .prepare(
          `INSERT INTO todo_state_transitions (
             id, todo_instance_id, from_status, to_status, reason,
             source_analysis_input_id, actor, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 7000)`
        )
        .run(id, todoId, fromStatus, toStatus, reason, sourceAnalysisInputId, actor);

    const assertInvalidContract = (input) =>
      assert.throws(
        () => insertTransition(input),
        /todo state transition reason contract is invalid/
      );
    assertInvalidContract({
      id: "transition-invalid-analysis-actor",
      todoId: "todo-analysis-created",
      fromStatus: null,
      toStatus: "open",
      reason: "analysis_created",
      sourceAnalysisInputId: "input-transition-contract",
      actor: "user",
    });
    assertInvalidContract({
      id: "transition-invalid-recurrence-source",
      todoId: "todo-recurrence-created",
      fromStatus: null,
      toStatus: "open",
      reason: "recurrence",
      sourceAnalysisInputId: null,
      actor: "system",
    });
    assertInvalidContract({
      id: "transition-invalid-user-source",
      todoId: "todo-user-action",
      fromStatus: "open",
      toStatus: "completed",
      reason: "user_action",
      sourceAnalysisInputId: "input-transition-contract",
      actor: "user",
    });
    assertInvalidContract({
      id: "transition-invalid-user-initial-shape",
      todoId: "todo-user-action",
      fromStatus: null,
      toStatus: "open",
      reason: "user_action",
      sourceAnalysisInputId: null,
      actor: "user",
    });
    assertInvalidContract({
      id: "transition-invalid-suggestion-actor",
      todoId: "todo-suggestion-acceptance",
      fromStatus: "open",
      toStatus: "dismissed",
      reason: "suggestion_acceptance",
      sourceAnalysisInputId: null,
      actor: "system",
    });
    assertInvalidContract({
      id: "transition-invalid-suggestion-initial-shape",
      todoId: "todo-suggestion-acceptance",
      fromStatus: null,
      toStatus: "open",
      reason: "suggestion_acceptance",
      sourceAnalysisInputId: null,
      actor: "user",
    });

    assert.equal(
      insertTransition({
        id: "transition-analysis-created",
        todoId: "todo-analysis-created",
        fromStatus: null,
        toStatus: "open",
        reason: "analysis_created",
        sourceAnalysisInputId: "input-transition-contract",
        actor: "system",
      }).changes,
      1
    );
    assert.equal(
      insertTransition({
        id: "transition-recurrence",
        todoId: "todo-recurrence-created",
        fromStatus: null,
        toStatus: "open",
        reason: "recurrence",
        sourceAnalysisInputId: "input-transition-contract",
        actor: "system",
      }).changes,
      1
    );
    assert.equal(
      insertTransition({
        id: "transition-user-action",
        todoId: "todo-user-action",
        fromStatus: "open",
        toStatus: "completed",
        reason: "user_action",
        sourceAnalysisInputId: null,
        actor: "user",
      }).changes,
      1
    );
    assert.equal(
      insertTransition({
        id: "transition-suggestion-acceptance",
        todoId: "todo-suggestion-acceptance",
        fromStatus: "open",
        toStatus: "dismissed",
        reason: "suggestion_acceptance",
        sourceAnalysisInputId: null,
        actor: "user",
      }).changes,
      1
    );
    assert.deepEqual(db.prepare("SELECT id, status FROM todos_v2 ORDER BY id").all(), [
      { id: "todo-analysis-created", status: "open" },
      { id: "todo-recurrence-created", status: "open" },
      { id: "todo-suggestion-acceptance", status: "dismissed" },
      { id: "todo-user-action", status: "completed" },
    ]);
  } finally {
    db.close();
  }
});

test("source-deletion exceptions cannot rewrite canonical or revision content", () => {
  const db = createPreviousVersionDatabase();
  try {
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO topics_v2 (
         id, canonical_key, name, canonical_algorithm, lifecycle,
         provenance, created_at, updated_at
       ) VALUES ('topic-legacy', ?, 'Legacy topic', 'canonical-v1', 'active',
                 'legacy_unverified', 1000, 1000)`
    ).run(HASH_A);
    db.exec(`
      INSERT INTO topic_revisions (
        id, topic_id, revision, summary, provenance, created_at
      ) VALUES ('topic-revision-legacy', 'topic-legacy', 1, 'original', 'legacy_unverified', 1000);
    `);
    assert.throws(
      () =>
        db.exec(
          "UPDATE topic_revisions SET summary = 'rewritten' WHERE id = 'topic-revision-legacy'"
        ),
      /topic revision is immutable/
    );
    assert.throws(
      () =>
        db.exec(
          `UPDATE topic_revisions
           SET summary = 'rewritten', provenance = 'source_deleted'
           WHERE id = 'topic-revision-legacy'`
        ),
      /topic revision (is immutable|provenance is immutable)/
    );
    assert.throws(
      () => db.exec("UPDATE topics_v2 SET provenance = 'source_deleted' WHERE id = 'topic-legacy'"),
      /topic provenance is immutable/
    );

    db.prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title, status, provenance, created_at, updated_at
       ) VALUES ('todo-legacy', ?, ?, 'Original', 'open', 'legacy_unverified', 1000, 1000)`
    ).run(HASH_A, HASH_B);
    db.exec(`
      INSERT INTO todo_revisions (
        id, todo_instance_id, revision, title, provenance, created_at
      ) VALUES ('todo-revision-legacy', 'todo-legacy', 1, 'Original', 'legacy_unverified', 1000);
    `);
    assert.throws(
      () =>
        db.exec("UPDATE todo_revisions SET title = 'rewritten' WHERE id = 'todo-revision-legacy'"),
      /todo revision is immutable/
    );
    assert.throws(
      () =>
        db.exec(
          `UPDATE todo_revisions
           SET title = 'rewritten', provenance = 'source_deleted'
           WHERE id = 'todo-revision-legacy'`
        ),
      /todo revision (is immutable|provenance is immutable)/
    );
    assert.throws(
      () =>
        db.exec(
          `UPDATE todos_v2
           SET status = 'completed', completed_at = 2000, updated_at = 2000
           WHERE id = 'todo-legacy'`
        ),
      /todo state change requires transition history/
    );
    db.exec(`
      INSERT INTO todo_state_transitions (
        id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
      ) VALUES ('todo-transition-legacy', 'todo-legacy', 'open', 'completed',
                'user_action', 'user', 2000);
    `);
    assert.deepEqual(
      db
        .prepare("SELECT status, completed_at, dismissed_at FROM todos_v2 WHERE id = 'todo-legacy'")
        .get(),
      { status: "completed", completed_at: 2000, dismissed_at: null }
    );
  } finally {
    db.close();
  }
});

test("legacy occurrences retain session lineage without synthetic analysis inputs", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    applyJarvisMigrations(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-source-check', 'session-1', ?, ?, 'jarvis-analysis-v2',
         ?, ?, ?, ?, ?, ?, 6000
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_C,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );
    db.prepare(
      `INSERT INTO memory_items_v2 (
         id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
         lifecycle, provenance, created_at, updated_at
       ) VALUES ('memory-opinion', 'opinion', ?, ?, 'Opinion', 'Legacy opinion', 0.5,
                 'active', 'legacy_unverified', 1000, 1000)`
    ).run(HASH_A, HASH_B);

    for (const table of [
      "memory_occurrences",
      "topic_occurrences",
      "todo_occurrences",
      "suggestion_occurrences",
    ]) {
      assert.equal(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === "legacy_session_id"),
        true,
        table
      );
    }
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_occurrences (
               id, memory_value_id, occurrence_key, candidate_item_fingerprint,
               confidence, created_at
             ) VALUES ('legacy-no-source', 'memory-opinion', ?, ?, 0.5, 1000)`
          )
          .run(HASH_A, HASH_B),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memory_occurrences (
               id, memory_value_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, confidence, created_at
             ) VALUES (
               'legacy-dual-source', 'memory-opinion', 'input-source-check', 'session-1',
               ?, ?, 0.5, 1000
             )`
          )
          .run(HASH_A, HASH_B),
      { code: "SQLITE_CONSTRAINT_CHECK" }
    );
    db.prepare(
      `INSERT INTO memory_occurrences (
         id, memory_value_id, legacy_session_id, occurrence_key,
         candidate_item_fingerprint, confidence, created_at
       ) VALUES ('legacy-occurrence', 'memory-opinion', 'session-1', ?, ?, 0.5, 1000)`
    ).run(HASH_A, HASH_B);
    assert.throws(
      () => db.prepare("DELETE FROM memory_occurrences WHERE id = 'legacy-occurrence'").run(),
      /memory occurrence is immutable/
    );
    assert.equal(db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run().changes, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("evidence references validate target input, manifest, capture lineage, bounds, and audio state", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    seedSecondFinalSegment(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 7000);
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('session-other', 1000, 5000, 'completed', 1000);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('track-other', 'session-1', 'system', 24000, 1, 1000, 5000, 'stopped');
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);
    db.prepare(
      `INSERT INTO analysis_inputs (
         id, session_id, transcript_revision, identity_revision, prompt_version,
         input_hash, input_contract_version, redaction_version, cloud_payload_json,
         cloud_payload_bytes, cloud_payload_sha256, created_at
       ) VALUES (
         'input-other', 'session-1', ?, ?, 'jarvis-analysis-v2',
         ?, ?, ?, ?, ?, ?, 6001
       )`
    ).run(
      HASH_A,
      HASH_B,
      HASH_D,
      INPUT_CONTRACT_VERSION,
      REDACTION_VERSION,
      CLOUD_PAYLOAD_JSON,
      CLOUD_PAYLOAD_BYTES,
      HASH_F
    );
    db.exec(`
      INSERT INTO analysis_input_speaker_bindings (
        analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
      ) VALUES ('input-other', 'SELF', 'person', 'person-1', 'Local');
      INSERT INTO analysis_input_segments (
        analysis_input_id, ordinal, segment_id, segment_version, text_hash, text_snapshot,
        speaker_binding_label
      ) VALUES ('input-other', 0, 'segment-1', 1, '${HASH_A}', 'durable evidence', 'SELF');
    `);

    const assertInvalidLineage = (overrides) =>
      assert.throws(() => insertEvidence(db, overrides), /evidence lineage is invalid/);
    assert.equal(
      insertEvidence(db, { id: "evidence-target-input", sourceAnalysisInputId: "input-other" })
        .changes,
      1
    );
    assertInvalidLineage({ id: "evidence-session", sessionId: "session-other" });
    assertInvalidLineage({
      id: "evidence-manifest",
      segmentId: "segment-2",
      audioChunkId: "chunk-2",
      startedAt: 5000,
      endedAt: 7000,
    });
    assertInvalidLineage({ id: "evidence-chunk", audioChunkId: "chunk-2" });
    assertInvalidLineage({ id: "evidence-track", trackId: "track-other" });
    assertInvalidLineage({ id: "evidence-start", startedAt: 999 });
    assertInvalidLineage({ id: "evidence-end", endedAt: 5001 });
    assertInvalidLineage({ id: "evidence-live-expired", state: "expired" });
    assertInvalidLineage({ id: "evidence-live-missing", state: "missing" });

    assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 1);
    assert.throws(
      () => db.prepare("DELETE FROM audio_chunks WHERE id = 'chunk-1'").run(),
      /constraint|immutable/i
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM audio_chunks WHERE id = 'chunk-1'").get().count,
      1
    );
    assert.equal(
      db.prepare("SELECT audio_state FROM evidence_refs WHERE id = 'evidence-target-input'").get()
        .audio_state,
      "available"
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("mid-migration trigger conflict rolls back every lineage DDL statement", () => {
  const db = createPreviousVersionDatabase();
  try {
    seedCaptureLineage(db);
    db.exec(`
      CREATE TRIGGER evidence_refs_expire_audio
      AFTER UPDATE OF deleted_at ON audio_chunks
      BEGIN
        SELECT 1;
      END;
    `);

    assert.throws(
      () => applyJarvisMigrations(db),
      /trigger evidence_refs_expire_audio already exists/
    );
    assert.equal(db.pragma("user_version", { simple: true }), PREVIOUS_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sessions").get().count, 1);
    const tables = schemaObjects(db, "table");
    for (const table of LINEAGE_TABLES) assert.equal(tables.includes(table), false, table);
    assert.equal(schemaObjects(db, "trigger").includes("evidence_refs_expire_audio"), true);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("audio tombstoning expires evidence atomically and trigger failure rolls back both rows", () => {
  const setup = () => {
    const db = createPreviousVersionDatabase();
    seedCaptureLineage(db);
    db.exec(`
      INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
      VALUES ('person-1', 'Local', 1, 1000, 5000);
    `);
    applyJarvisMigrations(db);
    seedAnalysisInput(db);
    seedEvidenceOwner(db);
    insertEvidence(db);
    return db;
  };

  const committed = setup();
  try {
    committed.prepare("UPDATE audio_chunks SET deleted_at = 7000 WHERE id = 'chunk-1'").run();
    assert.deepEqual(
      committed
        .prepare(
          `SELECT audio_state, transcript_segment_id, quote_text, started_at, ended_at,
                  session_id, track_id
           FROM evidence_refs WHERE id = 'evidence-1'`
        )
        .get(),
      {
        audio_state: "expired",
        transcript_segment_id: "segment-1",
        quote_text: "durable evidence",
        started_at: 1000,
        ended_at: 5000,
        session_id: "session-1",
        track_id: "track-1",
      }
    );
  } finally {
    committed.close();
  }

  const rejected = setup();
  try {
    rejected.exec(`
      CREATE TRIGGER reject_evidence_expiry
      BEFORE UPDATE OF audio_state ON evidence_refs
      WHEN OLD.audio_state = 'available' AND NEW.audio_state = 'expired'
      BEGIN
        SELECT RAISE(ABORT, 'injected evidence expiry failure');
      END;
    `);
    assert.throws(
      () =>
        rejected.transaction(() => {
          rejected.prepare("UPDATE audio_chunks SET deleted_at = 7000 WHERE id = 'chunk-1'").run();
        })(),
      /injected evidence expiry failure/
    );
    assert.equal(rejected.prepare("SELECT deleted_at FROM audio_chunks").get().deleted_at, null);
    assert.equal(
      rejected.prepare("SELECT audio_state FROM evidence_refs").get().audio_state,
      "available"
    );
  } finally {
    rejected.close();
  }
});

test("unconditional foreign-key preflight rolls back v23 without lineage residue", () => {
  const db = createPreviousVersionDatabase({ withTranscript: false });
  try {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO audio_chunks (
         id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at
       ) VALUES ('orphan', 'missing-session', 'orphan.wav', 0, 1, 1, ?, 2)`
    ).run(HASH_A);
    db.pragma("foreign_keys = ON");

    assert.throws(() => applyJarvisMigrations(db), /migration would violate foreign keys/);
    assert.equal(db.pragma("user_version", { simple: true }), PREVIOUS_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS count FROM audio_chunks").get().count, 1);
    const tables = schemaObjects(db, "table");
    for (const table of LINEAGE_TABLES) assert.equal(tables.includes(table), false, table);
  } finally {
    db.close();
  }
});

test("latest-version no-op still rejects existing foreign-key violations", () => {
  const db = createDatabase();
  try {
    applyJarvisMigrations(db);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO audio_chunks (
         id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at
       ) VALUES ('latest-orphan', 'missing-session', 'latest-orphan.wav', 0, 1, 1, ?, 2)`
    ).run(HASH_A);
    db.pragma("foreign_keys = ON");

    assert.throws(() => applyJarvisMigrations(db), /migration would violate foreign keys/);
    assert.equal(db.pragma("user_version", { simple: true }), TARGET_VERSION);
  } finally {
    db.close();
  }
});
