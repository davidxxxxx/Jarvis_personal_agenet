const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

test("v46 databases migrate participant review history and overrides to v47", (t) => {
  const root = path.resolve(
    __dirname,
    "..",
    "..",
    ".tmp-tests",
    `participant-review-${crypto.randomUUID()}`
  );
  fs.mkdirSync(root, { recursive: true });
  let migrated = null;
  t.after(() => {
    migrated?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const databasePath = path.join(root, "jarvis.db");
  const initial = new JarvisRepository(databasePath);
  initial.db.exec(`
    DROP TRIGGER IF EXISTS validate_pinned_speaker_evidence_insert;
    DROP TRIGGER IF EXISTS validate_segment_review_override_insert;
    DROP TRIGGER IF EXISTS validate_cluster_review_override_update;
    DROP TRIGGER IF EXISTS validate_cluster_review_override_insert;
    DROP TRIGGER IF EXISTS participant_review_events_immutable_delete;
    DROP TRIGGER IF EXISTS participant_review_events_immutable_update;
    DROP TABLE IF EXISTS pinned_speaker_evidence;
    DROP TABLE IF EXISTS participant_review_backfill_batches;
    DROP TABLE IF EXISTS speaker_segment_review_overrides;
    DROP TABLE IF EXISTS speaker_cluster_review_overrides;
    DROP TABLE IF EXISTS speaker_identity_review_overrides;
    DROP TABLE IF EXISTS participant_review_events;
    DROP TABLE IF EXISTS session_participant_snapshot_clusters;
    DROP TABLE IF EXISTS session_participant_snapshots;
  `);
  initial.db.pragma("user_version = 46");
  initial.close();

  migrated = new JarvisRepository(databasePath);
  assert.ok(TARGET_VERSION >= 47);
  assert.equal(migrated.db.pragma("user_version", { simple: true }), TARGET_VERSION);
  const tables = new Set(
    migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  for (const table of [
    "session_participant_snapshots",
    "session_participant_snapshot_clusters",
    "participant_review_events",
    "speaker_cluster_review_overrides",
    "speaker_segment_review_overrides",
    "speaker_identity_review_overrides",
    "participant_review_backfill_batches",
    "pinned_speaker_evidence",
  ]) {
    assert.equal(tables.has(table), true, table);
  }

  migrated.createSession({
    id: "review-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  migrated.db
    .prepare(
      `INSERT INTO participant_review_events (
        id, session_id, action, subject_ref, payload_json,
        previous_state_json, next_state_json, reverts_event_id, actor, created_at
      ) VALUES (
        'event-1', 'review-session', 'mark_media', 'cluster-1', '{}',
        '{}', '{"disposition":"media"}', NULL, 'user', 2000
      )`
    )
    .run();
  assert.throws(
    () =>
      migrated.db
        .prepare("UPDATE participant_review_events SET actor = 'system' WHERE id = 'event-1'")
        .run(),
    /participant review event is immutable/u
  );
  assert.deepEqual(migrated.db.pragma("foreign_key_check"), []);
});
