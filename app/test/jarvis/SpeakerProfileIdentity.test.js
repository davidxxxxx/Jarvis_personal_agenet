const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const DatabaseManager = require("../../src/helpers/database");
const { SELF_VOICE_PROFILE_ID } = require("../../src/jarvis/main/VoiceEnrollmentService");

test("reserved self profile never blends with an unrelated profile named 我", () => {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = new Database(":memory:");
  manager.db.exec(`
    CREATE TABLE speaker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      email TEXT,
      embedding BLOB NOT NULL,
      sample_count INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const unrelatedEmbedding = Buffer.from(new Float32Array([9, 9]).buffer);
  const unrelated = manager.db
    .prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)")
    .run("我", unrelatedEmbedding);

  const self = manager.upsertSpeakerProfile(
    "我",
    null,
    Buffer.from(new Float32Array([1, 2]).buffer),
    SELF_VOICE_PROFILE_ID
  );

  assert.equal(self.id, SELF_VOICE_PROFILE_ID);
  assert.notEqual(self.id, Number(unrelated.lastInsertRowid));
  assert.equal(
    manager.db.prepare("SELECT sample_count FROM speaker_profiles WHERE id = ?").get(unrelated.lastInsertRowid)
      .sample_count,
    1
  );
  manager.db.close();
});
