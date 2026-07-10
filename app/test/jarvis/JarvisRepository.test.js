const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

test("session lifecycle and stable transcript upsert are idempotent", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: "mic-1" });
  repo.setSessionStatus("s1", "paused", 2000);
  const segment = {
    id: "seg-1",
    startedAt: 1100,
    endedAt: 1600,
    personId: "person-2",
    speakerLabel: "Speaker 2",
    text: "Send me the test feedback before Friday",
    confidence: 0.91,
    isStable: true,
  };
  repo.upsertTranscriptSegments("s1", [segment, segment]);

  const session = repo.getSession("s1");
  assert.equal(session.status, "paused");
  assert.equal(repo.listTranscriptSegments("s1").length, 1);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, segment.text);
  repo.close();
});

test("renaming a person changes display metadata without rewriting transcript text", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 1000,
      endedAt: 1200,
      personId: "p2",
      speakerLabel: "Speaker 2",
      text: "Hello",
      confidence: 0.8,
      isStable: true,
    },
  ]);
  repo.renamePerson({ personId: "p2", displayName: "Zhang San", isSelf: false });

  assert.equal(repo.listPeople()[0].display_name, "Zhang San");
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Hello");
  repo.close();
});

test("person and segment writes roll back together when a segment violates the schema", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });

  assert.throws(
    () =>
      repo.upsertTranscriptSegments("s1", [
        {
          id: "seg-1",
          startedAt: 1000,
          endedAt: 1200,
          personId: "p2",
          speakerLabel: "Speaker 2",
          text: null,
          confidence: 0.8,
          isStable: true,
        },
      ]),
    /NOT NULL/
  );
  assert.deepEqual(repo.listPeople(), []);
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  repo.close();
});

test("audio metadata retention and interrupted session recovery stay in jarvis.db", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: "mic-1" });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  repo.setSessionStatus("s2", "completed", 2600);
  repo.insertAudioChunk({
    id: "chunk-1",
    sessionId: "s1",
    path: "audio/s1/chunk-1.wav",
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    sha256: "a".repeat(64),
    expiresAt: 4000,
  });

  assert.equal(repo.listSessions({ from: 1500, to: 2500 })[0].id, "s2");
  assert.equal(repo.listExpiredAudioChunks(3999).length, 0);
  assert.equal(repo.listExpiredAudioChunks(4000)[0].id, "chunk-1");
  assert.equal(repo.recoverOpenSessions(5000), 1);
  assert.equal(repo.getSession("s1").status, "recovered");
  assert.equal(repo.getSession("s1").ended_at, 5000);
  assert.equal(repo.deleteAudioChunk("chunk-1"), 1);
  assert.deepEqual(repo.listAudioChunks("s1"), []);
  repo.close();
});

test("schema initialization is idempotent and file databases use WAL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-repository-"));
  const dbPath = path.join(directory, "jarvis.db");

  try {
    const first = new JarvisRepository(dbPath);
    first.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
    first.close();

    const second = new JarvisRepository(dbPath);
    assert.equal(second.getSession("s1").language, "zh");
    assert.equal(second.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(second.db.pragma("foreign_keys", { simple: true }), 1);
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("schema constraints reject unknown statuses and cascade session-owned rows", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 1000,
      endedAt: 1200,
      personId: "p1",
      speakerLabel: "Speaker 1",
      text: "Hello",
      confidence: 0.8,
      isStable: true,
    },
  ]);

  assert.throws(() => repo.setSessionStatus("s1", "hidden-recording"), /invalid session status/);
  assert.throws(
    () => repo.upsertTranscriptSegments("missing", [{
      id: "seg-2",
      startedAt: 1000,
      endedAt: 1200,
      personId: null,
      speakerLabel: "Speaker 1",
      text: "Hello",
      confidence: 0.8,
      isStable: true,
    }]),
    /FOREIGN KEY/
  );
  repo.db.prepare("DELETE FROM people WHERE id = ?").run("p1");
  assert.equal(repo.listTranscriptSegments("s1")[0].person_id, null);
  repo.db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  repo.close();
});
