const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  TARGET_VERSION,
  applyJarvisMigrations,
  upgradeApplicationAudioTracksV32,
} = require("../../src/jarvis/main/JarvisMigrations");

function createV31TrackFixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE audio_tracks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK(source_type IN ('mic','system')),
      device_id TEXT,
      device_label TEXT,
      strategy TEXT,
      sample_rate INTEGER NOT NULL,
      channels INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      state TEXT NOT NULL,
      UNIQUE(session_id, source_type)
    );
    CREATE TABLE track_children (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE
    );
    INSERT INTO sessions (id, started_at) VALUES ('session-1', 100);
    INSERT INTO audio_tracks (
      id, session_id, source_type, device_id, device_label, strategy,
      sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('mic-track', 'session-1', 'mic', 'mic-1', 'Desk mic', 'media-recorder',
       24000, 1, 100, NULL, 'active'),
      ('mix-track', 'session-1', 'system', NULL, 'Computer audio', 'process-loopback',
       24000, 1, 100, NULL, 'active');
    INSERT INTO track_children (id, track_id)
    VALUES ('child-mic', 'mic-track'), ('child-mix', 'mix-track');
  `);
  return db;
}

function insertTrack(db, input) {
  db.prepare(
    `INSERT INTO audio_tracks (
       id, session_id, source_type, application_key, application_display_name,
       capture_generation, device_id, device_label, strategy,
       sample_rate, channels, started_at, state
     ) VALUES (
       @id, @sessionId, @sourceType, @applicationKey, @applicationDisplayName,
       @captureGeneration, NULL, NULL, @strategy,
       24000, 1, 100, 'active'
     )`
  ).run({
    applicationKey: null,
    applicationDisplayName: null,
    captureGeneration: 0,
    strategy: "test",
    ...input,
  });
}

test("v32 migrates legacy mic and mixed-system tracks without changing lineage ids", () => {
  const db = createV31TrackFixture();
  try {
    db.pragma("foreign_keys = OFF");
    upgradeApplicationAudioTracksV32(db);
    db.pragma("foreign_keys = ON");

    assert.deepEqual(
      db
        .prepare(
          `SELECT id, source_type, track_kind, application_key,
                  application_display_name, attribution_state, capture_generation
           FROM audio_tracks
           ORDER BY id`
        )
        .all(),
      [
        {
          id: "mic-track",
          source_type: "mic",
          track_kind: "mic",
          application_key: null,
          application_display_name: null,
          attribution_state: "exact",
          capture_generation: 0,
        },
        {
          id: "mix-track",
          source_type: "system",
          track_kind: "system_mix",
          application_key: null,
          application_display_name: null,
          attribution_state: "mixed_unknown",
          capture_generation: 0,
        },
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT id, track_id FROM track_children ORDER BY id").all(),
      [
        { id: "child-mic", track_id: "mic-track" },
        { id: "child-mix", track_id: "mix-track" },
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v32 supports several application tracks plus one safety mix in the same session", () => {
  const db = createV31TrackFixture();
  try {
    db.pragma("foreign_keys = OFF");
    upgradeApplicationAudioTracksV32(db);
    db.pragma("foreign_keys = ON");

    insertTrack(db, {
      id: "chrome-track",
      sessionId: "session-1",
      sourceType: "system",
      applicationKey: "chrome",
      applicationDisplayName: "Chrome",
      captureGeneration: 1,
      strategy: "include-process-tree",
    });
    insertTrack(db, {
      id: "kook-track",
      sessionId: "session-1",
      sourceType: "system",
      applicationKey: "kook",
      applicationDisplayName: "KOOK",
      captureGeneration: 2,
      strategy: "include-process-tree",
    });

    assert.deepEqual(
      db
        .prepare(
          `SELECT id, track_kind, attribution_state
           FROM audio_tracks WHERE source_type = 'system' ORDER BY id`
        )
        .all(),
      [
        { id: "chrome-track", track_kind: "application", attribution_state: "exact" },
        { id: "kook-track", track_kind: "application", attribution_state: "exact" },
        { id: "mix-track", track_kind: "system_mix", attribution_state: "mixed_unknown" },
      ]
    );
    assert.throws(
      () =>
        insertTrack(db, {
          id: "chrome-duplicate",
          sessionId: "session-1",
          sourceType: "system",
          applicationKey: "chrome",
          applicationDisplayName: "Chrome",
          captureGeneration: 1,
          strategy: "include-process-tree",
        }),
      /UNIQUE/
    );
    assert.throws(
      () =>
        insertTrack(db, {
          id: "raw-path",
          sessionId: "session-1",
          sourceType: "system",
          applicationKey: "c:\\games\\dota2.exe",
          applicationDisplayName: "DOTA 2",
          strategy: "include-process-tree",
        }),
      /CHECK/
    );
  } finally {
    db.close();
  }
});

test("v32 records exact application and unknown fallback intervals without guessing source", () => {
  const db = createV31TrackFixture();
  try {
    db.pragma("foreign_keys = OFF");
    upgradeApplicationAudioTracksV32(db);
    db.pragma("foreign_keys = ON");
    insertTrack(db, {
      id: "chrome-track",
      sessionId: "session-1",
      sourceType: "system",
      applicationKey: "chrome",
      applicationDisplayName: "Chrome",
      captureGeneration: 3,
      strategy: "include-process-tree",
    });

    db.prepare(
      `INSERT INTO application_audio_intervals (
         id, session_id, track_id, interval_kind, application_key,
         attribution_state, capture_generation, started_at, ended_at, reason, created_at
       ) VALUES (
         'exact-1', 'session-1', 'chrome-track', 'application_active', 'chrome',
         'exact', 3, 100, 200, NULL, 100
       )`
    ).run();
    db.prepare(
      `INSERT INTO application_audio_intervals (
         id, session_id, track_id, interval_kind, application_key,
         attribution_state, capture_generation, started_at, ended_at, reason, created_at
       ) VALUES (
         'fallback-1', 'session-1', 'mix-track', 'mixed_fallback', NULL,
         'mixed_unknown', 4, 200, 250, 'application_capture_failed', 200
       )`
    ).run();

    assert.deepEqual(
      db
        .prepare(
          `SELECT interval_kind, application_key, attribution_state, reason
           FROM application_audio_intervals ORDER BY started_at`
        )
        .all(),
      [
        {
          interval_kind: "application_active",
          application_key: "chrome",
          attribution_state: "exact",
          reason: null,
        },
        {
          interval_kind: "mixed_fallback",
          application_key: null,
          attribution_state: "mixed_unknown",
          reason: "application_capture_failed",
        },
      ]
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO application_audio_intervals (
               id, session_id, track_id, interval_kind, application_key,
               attribution_state, capture_generation, started_at, ended_at, reason, created_at
             ) VALUES (
               'guess-1', 'session-1', 'mix-track', 'mixed_fallback', 'chrome',
               'mixed_unknown', 4, 250, 300, 'guessed_from_text', 250
             )`
          )
          .run(),
      /invalid application audio interval/
    );
  } finally {
    db.close();
  }
});

test("clean migrations reach the current schema and repeated source migration is idempotent", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(TARGET_VERSION, 42);
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 100 }), {
      fromVersion: 0,
      toVersion: TARGET_VERSION,
    });
    assert.doesNotThrow(() => upgradeApplicationAudioTracksV32(db));
    assert.deepEqual(applyJarvisMigrations(db, { now: () => 200 }), {
      fromVersion: TARGET_VERSION,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
