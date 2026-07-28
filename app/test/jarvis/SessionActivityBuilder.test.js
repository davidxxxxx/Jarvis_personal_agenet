const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const SessionActivityBuilder = require("../../src/jarvis/main/SessionActivityBuilder");

test("builder joins overlapping microphone speech to the application without leaking names", () => {
  const tracks = [
    {
      id: "track-kook",
      track_kind: "application",
      attribution_state: "exact",
      application_key: "kook",
      device_label: null,
    },
    {
      id: "track-mic",
      track_kind: "mic",
      attribution_state: "exact",
      application_key: null,
      device_label: "Physical Microphone",
    },
  ];
  const segments = [
    {
      id: "segment-kook",
      track_id: "track-kook",
      started_at: 1_000,
      ended_at: 4_000,
      text: "张三说今晚一起玩",
      person_id: "person-zhang",
      speaker_label: "speaker_1",
      is_self: 0,
    },
    {
      id: "segment-self",
      track_id: "track-mic",
      started_at: 2_000,
      ended_at: 5_000,
      text: "我说可以",
      person_id: "person-self",
      speaker_label: "speaker_2",
      is_self: 1,
    },
  ];
  const people = [
    { id: "person-self", display_name: "徐杰", is_self: 1 },
    { id: "person-zhang", display_name: "张三", is_self: 0 },
  ];
  const db = {
    prepare(sql) {
      if (sql.includes("FROM audio_tracks")) return { all: () => tracks };
      if (sql.includes("FROM transcript_segments")) return { all: () => segments };
      if (sql.includes("FROM people")) return { all: () => people };
      throw new Error("unexpected query");
    },
  };

  const result = new SessionActivityBuilder(db).build("session-kook");

  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].sourceAttribution, "application_and_microphone");
  assert.deepEqual(result.activities[0].applications, ["kook"]);
  assert.deepEqual(result.activities[0].speakerLabels, ["P1", "SELF"]);
  assert.equal(result.activities[0].statistics.selfDetected, true);
  assert.deepEqual(result.redactionTerms.participants, [
    { label: "SELF", names: ["徐杰"] },
    { label: "P1", names: ["张三"] },
  ]);
  assert.deepEqual(result.redactionTerms.deviceLabels, ["Physical Microphone"]);
  assert.equal(JSON.stringify(result).includes("person-self"), false);
  assert.equal(JSON.stringify(result).includes("person-zhang"), false);
});

test("mixed system audio never claims an application even if a key is present", () => {
  const db = {
    prepare(sql) {
      if (sql.includes("FROM audio_tracks")) {
        return {
          all: () => [
            {
              id: "track-mix",
              track_kind: "system_mix",
              attribution_state: "mixed_unknown",
              application_key: "chrome",
              device_label: null,
            },
          ],
        };
      }
      if (sql.includes("FROM transcript_segments")) {
        return {
          all: () => [
            {
              id: "segment-mix",
              track_id: "track-mix",
              started_at: 1_000,
              ended_at: 4_000,
              text: "unknown source",
              person_id: null,
              speaker_label: "speaker_1",
              is_self: null,
            },
          ],
        };
      }
      if (sql.includes("FROM people")) return { all: () => [] };
      throw new Error("unexpected query");
    },
  };

  const [activity] = new SessionActivityBuilder(db).build("session-mix").activities;
  assert.equal(activity.sourceAttribution, "mixed_unknown");
  assert.deepEqual(activity.applications, []);
});

test("builder derives activity fields from the current audio_tracks schema", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audio_tracks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      application_key TEXT,
      application_display_name TEXT,
      device_label TEXT,
      strategy TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_self INTEGER NOT NULL
    );
    CREATE TABLE transcript_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      person_id TEXT,
      speaker_label TEXT,
      text TEXT NOT NULL,
      result_kind TEXT NOT NULL,
      is_stable INTEGER NOT NULL,
      superseded_by TEXT,
      duplicate_of TEXT
    );
  `);
  db.prepare(`
    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      device_label, strategy, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "track-kook",
    "session-current",
    "system",
    "kook",
    "KOOK",
    null,
    "wasapi-application-loopback",
    1_000,
    4_000
  );
  db.prepare(`
    INSERT INTO transcript_segments (
      id, session_id, track_id, started_at, ended_at, person_id,
      speaker_label, text, result_kind, is_stable, superseded_by, duplicate_of
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'final', 1, NULL, NULL)
  `).run(
    "segment-kook",
    "session-current",
    "track-kook",
    1_000,
    4_000,
    null,
    "speaker_1",
    "今晚一起玩"
  );

  const [activity] = new SessionActivityBuilder(db).build("session-current").activities;

  assert.equal(activity.sourceAttribution, "application");
  assert.deepEqual(activity.applications, ["kook"]);
  db.close();
});
