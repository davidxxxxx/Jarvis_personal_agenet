const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { createStableSegmentId } = require("../../src/jarvis/shared/segmentIds.ts");

test("session-namespaced segment ids avoid restart-local raw id collisions", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const firstId = createStableSegmentId("s1", "seg-1");
  const secondId = createStableSegmentId("s2", "seg-1");
  const segment = {
    id: firstId,
    startedAt: 1100,
    endedAt: 1200,
    personId: null,
    speakerLabel: "mic",
    text: "First session",
    confidence: 0.5,
    isStable: true,
  };

  assert.notEqual(firstId, secondId);
  assert.match(firstId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(secondId, /^[A-Za-z0-9_-]{1,128}$/);
  const longId = createStableSegmentId("s".repeat(128), "raw".repeat(50));
  assert.match(longId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(longId, createStableSegmentId("s".repeat(128), "raw".repeat(50)));
  assert.notEqual(longId, createStableSegmentId("t".repeat(128), "raw".repeat(50)));
  repo.upsertTranscriptSegments("s1", [segment]);
  repo.upsertTranscriptSegments("s2", [
    { ...segment, id: secondId, startedAt: 2100, endedAt: 2200, text: "Second session" },
  ]);
  repo.upsertTranscriptSegments("s1", [{ ...segment, text: "Updated first session" }]);

  assert.equal(repo.listTranscriptSegments("s1")[0].id, firstId);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated first session");
  assert.equal(repo.listTranscriptSegments("s2")[0].id, secondId);
  repo.close();
});

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

test("cross-session segment collisions reject and roll back the whole batch", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const original = {
    id: "seg-shared",
    startedAt: 1100,
    endedAt: 1200,
    personId: "p-original",
    speakerLabel: "Speaker 1",
    text: "Original session text",
    confidence: 0.9,
    isStable: true,
  };
  repo.upsertTranscriptSegments("s1", [original]);

  assert.throws(
    () =>
      repo.upsertTranscriptSegments("s2", [
        {
          id: "seg-new",
          startedAt: 2100,
          endedAt: 2200,
          personId: "p-new",
          speakerLabel: "Speaker 2",
          text: "Must roll back",
          confidence: 0.8,
          isStable: true,
        },
        {
          ...original,
          personId: "p-collision",
          speakerLabel: "Wrong speaker",
          text: "Must not overwrite session one",
        },
      ]),
    /segment belongs to a different session/
  );

  assert.deepEqual(repo.listTranscriptSegments("s2"), []);
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-new"),
    false
  );
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-collision"),
    false
  );
  assert.equal(repo.listTranscriptSegments("s1")[0].text, original.text);

  repo.upsertTranscriptSegments("s1", [{ ...original, text: "Updated in session one" }]);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated in session one");
  repo.close();
});

test("stable transcript snapshot sync deletes retractions transactionally and only within its session", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const keep = {
    id: createStableSegmentId("s1", "seg-1"),
    startedAt: 1100,
    endedAt: 1200,
    personId: "p1",
    speakerLabel: "Speaker 1",
    text: "Keep me",
    confidence: 0.8,
    isStable: true,
  };
  const retract = {
    ...keep,
    id: createStableSegmentId("s1", "seg-2"),
    startedAt: 1300,
    endedAt: 1400,
    text: "Retract me",
  };
  const other = {
    ...keep,
    id: createStableSegmentId("s2", "seg-1"),
    startedAt: 2100,
    endedAt: 2200,
    personId: "p2",
    speakerLabel: "Speaker 2",
    text: "Other session",
  };
  repo.upsertTranscriptSegments("s1", [keep, retract]);
  repo.upsertTranscriptSegments("s2", [other]);
  repo.db
    .prepare("UPDATE transcript_segments SET analysis_state = 'ready' WHERE id = ?")
    .run(keep.id);

  repo.syncTranscriptSegments("s1", [{ ...keep, text: "Updated keep" }]);
  assert.deepEqual(
    repo.listTranscriptSegments("s1").map((segment) => segment.id),
    [keep.id]
  );
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated keep");
  assert.equal(repo.listTranscriptSegments("s1")[0].analysis_state, "ready");
  assert.equal(repo.listTranscriptSegments("s2")[0].id, other.id);

  assert.throws(
    () =>
      repo.syncTranscriptSegments("s1", [
        retract,
        { ...other, personId: "p-rollback", text: "Cross-session collision" },
      ]),
    /segment belongs to a different session/
  );
  assert.deepEqual(
    repo.listTranscriptSegments("s1").map((segment) => segment.id),
    [keep.id]
  );
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-rollback"),
    false
  );
  assert.equal(repo.listTranscriptSegments("s2")[0].text, "Other session");

  repo.syncTranscriptSegments("s1", []);
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  assert.equal(repo.listTranscriptSegments("s2")[0].id, other.id);
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

test("renaming a profiled self preserves self and voice-profile identity", () => {
  const repo = new JarvisRepository(":memory:");
  repo.renamePerson({
    personId: "self",
    displayName: "Original",
    isSelf: true,
    voiceProfileId: 77,
  });

  const renamed = repo.renamePerson({ personId: "self", displayName: "Renamed" });

  assert.equal(renamed.display_name, "Renamed");
  assert.equal(renamed.is_self, 1);
  assert.equal(renamed.voice_profile_id, 77);
  repo.close();
});

test("ordinary rename preserves voice profile and mark-self preserves display name", () => {
  const repo = new JarvisRepository(":memory:");
  repo.renamePerson({
    personId: "p2",
    displayName: "张三",
    isSelf: false,
    voiceProfileId: 88,
  });

  const renamed = repo.renamePerson({ personId: "p2", displayName: "张先生" });
  const markedSelf = repo.renamePerson({ personId: "p2", isSelf: true });

  assert.equal(renamed.voice_profile_id, 88);
  assert.equal(renamed.is_self, 0);
  assert.equal(markedSelf.display_name, "张先生");
  assert.equal(markedSelf.voice_profile_id, 88);
  assert.equal(markedSelf.is_self, 1);
  repo.close();
});

test("speaker names are trimmed and bounded to 80 Unicode code points", () => {
  const repo = new JarvisRepository(":memory:");
  const eightyEmoji = "😀".repeat(80);

  const person = repo.renamePerson({ personId: "p2", displayName: `  ${eightyEmoji}  ` });

  assert.equal(person.display_name, eightyEmoji);
  assert.equal(Array.from(person.display_name).length, 80);
  assert.throws(
    () => repo.renamePerson({ personId: "p2", displayName: "😀".repeat(81) }),
    /at most 80 Unicode code points/
  );
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
  assert.deepEqual(
    repo.recoverOpenSessions(5000).map((session) => session.id),
    ["s1"]
  );
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
    () =>
      repo.upsertTranscriptSegments("missing", [
        {
          id: "seg-2",
          startedAt: 1000,
          endedAt: 1200,
          personId: null,
          speakerLabel: "Speaker 1",
          text: "Hello",
          confidence: 0.8,
          isStable: true,
        },
      ]),
    /FOREIGN KEY/
  );
  repo.db.prepare("DELETE FROM people WHERE id = ?").run("p1");
  assert.equal(repo.listTranscriptSegments("s1")[0].person_id, null);
  repo.db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  repo.close();
});

test("cloud budget settings and settled usage persist across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cloud-budget-"));
  const dbPath = path.join(directory, "jarvis.db");
  let first = null;
  let second = null;

  try {
    first = new JarvisRepository(dbPath);
    assert.deepEqual(first.getCloudBudgetSettings(), {
      provider: "openai",
      monthly_limit_microusd: 5_000_000,
      enabled: 0,
      updated_at: 0,
    });
    first.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 10 });
    assert.equal(
      first.reserveCloudUsage({
        id: "usage_1",
        monthUtc: "2026-07",
        model: "gpt-4o-transcribe",
        audioMs: 12_000,
        reservedMicrousd: 100_000,
        priceVersion: "openai-2026-07-11",
        createdAt: 20,
      }).ok,
      true
    );
    first.settleCloudUsage({
      id: "usage_1",
      inputTokens: 120,
      outputTokens: 18,
      actualMicrousd: 480,
      settledAt: 30,
    });
    first.close();
    first = null;

    second = new JarvisRepository(dbPath);
    assert.equal(second.getCloudBudgetSettings().enabled, 1);
    assert.deepEqual(second.getCloudBudgetStatus(Date.UTC(2026, 6, 20)), {
      monthUtc: "2026-07",
      enabled: true,
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 480,
      reservedMicrousd: 0,
      remainingMicrousd: 4_999_520,
      blockedReason: null,
    });
    second.close();
    second = null;
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cloud usage reservation atomically protects the monthly limit", () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  repo.db.prepare(`
    INSERT INTO cloud_usage (
      id, month_utc, provider, model, audio_ms, input_tokens, output_tokens,
      price_version, reserved_microusd, actual_microusd, status, created_at, settled_at
    ) VALUES (?, ?, 'openai', 'gpt-4o-transcribe', 1000, 0, 0, ?, 0, ?, 'settled', 1, 2)
  `).run("spent", "2026-07", "openai-2026-07-11", 4_950_001);

  const result = repo.reserveCloudUsage({
    id: "usage_2",
    monthUtc: "2026-07",
    model: "gpt-4o-transcribe",
    audioMs: 12_000,
    reservedMicrousd: 100_000,
    priceVersion: "openai-2026-07-11",
    createdAt: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "budget_protected");
  assert.equal(repo.db.prepare("SELECT count(*) AS count FROM cloud_usage").get().count, 1);
  repo.close();
});

test("cloud budget validation rejects out-of-range limits and unknown usage fails closed", () => {
  const repo = new JarvisRepository(":memory:");
  assert.throws(
    () => repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 4_999_999 }),
    /between 5000000 and 10000000/
  );
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 10_000_000, at: 1 });
  assert.equal(
    repo.reserveCloudUsage({
      id: "usage_unknown",
      monthUtc: "2026-07",
      model: "gpt-4o-transcribe",
      audioMs: 1_000,
      reservedMicrousd: 100_000,
      priceVersion: "openai-2026-07-11",
      createdAt: 2,
    }).ok,
    true
  );
  repo.markCloudUsageUnknown({ id: "usage_unknown", settledAt: 3 });

  const blocked = repo.reserveCloudUsage({
    id: "usage_after_unknown",
    monthUtc: "2026-07",
    model: "gpt-4o-transcribe",
    audioMs: 1_000,
    reservedMicrousd: 100_000,
    priceVersion: "openai-2026-07-11",
    createdAt: 4,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "usage_unknown");
  repo.close();
});
