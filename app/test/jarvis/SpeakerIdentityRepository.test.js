const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");
const SpeakerIdentityRepository = require("../../src/jarvis/main/SpeakerIdentityRepository");
const {
  decodeEmbedding,
  encodeEmbedding,
} = require("../../src/jarvis/main/SpeakerIdentityRepository");

function fixture(t, { createId } = {}) {
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: "mic-1" });
  repository.createTrack({
    id: "t-mic",
    sessionId: "s1",
    sourceType: "mic",
    deviceId: "mic-1",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  let nextId = 0;
  const identities = new SpeakerIdentityRepository(repository.db, {
    createId: createId ?? ((prefix) => `${prefix}-${++nextId}`),
    now: () => 50_000 + nextId,
  });
  t.after(() => repository.close());
  return { repository, identities };
}

function addPerson(repository, personId, displayName = personId) {
  return repository.renamePerson({ personId, displayName });
}

function createCluster(identities, overrides = {}) {
  return identities.createCluster({
    id: "c1",
    sessionId: "s1",
    trackId: "t-mic",
    localLabel: "speaker_1",
    modelId: "campplus-v1",
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    speechMs: 18_000,
    windowCount: 4,
    qualityScore: 0.9,
    ...overrides,
  });
}

test("encodes embeddings as explicit little-endian Float32 and validates dimensions", (t) => {
  const encoded = encodeEmbedding(new Float32Array([1, -2.5]));
  assert.equal(encoded.toString("hex"), "0000803f000020c0");
  assert.deepEqual(Array.from(decodeEmbedding(encoded, 2)), [1, -2.5]);
  assert.throws(() => encodeEmbedding(new Float32Array([Number.NaN])), /finite/);
  assert.throws(() => encodeEmbedding(new Float32Array([Number.POSITIVE_INFINITY])), /finite/);
  assert.throws(() => decodeEmbedding(Buffer.alloc(3)), /multiple of 4/);
  assert.throws(() => decodeEmbedding(encoded, 3), /dimension/);

  const { identities } = fixture(t);
  createCluster(identities);
  assert.throws(
    () =>
      identities.createCluster({
        id: "c2",
        sessionId: "s1",
        trackId: "t-mic",
        localLabel: "speaker_2",
        modelId: "campplus-v1",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        speechMs: 15_000,
        windowCount: 3,
      }),
    /dimension/
  );
});

test("creates session clusters without assigning a person", (t) => {
  const { identities } = fixture(t);
  const cluster = createCluster(identities);

  assert.equal(cluster.personId, null);
  assert.equal(cluster.linkState, "unknown");
  assert.equal(cluster.modelId, "campplus-v1");
  assert.deepEqual(Array.from(cluster.embedding), [
    Math.fround(0.1),
    Math.fround(0.2),
    Math.fround(0.3),
    Math.fround(0.4),
  ]);
  assert.deepEqual(
    identities.listSessionClusters("s1").map((row) => row.id),
    ["c1"]
  );
});

test("replaces cluster transcript segments atomically", (t) => {
  const { repository, identities } = fixture(t);
  createCluster(identities);
  repository.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: null,
      speakerLabel: "speaker_1",
      text: "one",
      confidence: 0.9,
      isStable: true,
      trackId: "t-mic",
    },
  ]);
  repository.createSession({ id: "s2", startedAt: 1_000, micDeviceId: null });
  repository.upsertTranscriptSegments("s2", [
    {
      id: "seg-other",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: null,
      speakerLabel: "speaker_1",
      text: "other",
      confidence: 0.9,
      isStable: true,
    },
  ]);

  identities.replaceClusterSegments("c1", ["seg-1"]);
  assert.deepEqual(identities.getCluster("c1").transcriptSegmentIds, ["seg-1"]);
  assert.throws(() => identities.replaceClusterSegments("c1", ["seg-other"]), /same session/);
  assert.deepEqual(identities.getCluster("c1").transcriptSegmentIds, ["seg-1"]);
});

test("persists model-scoped profile samples and rejects inconsistent dimensions", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  const sample = identities.addProfileSample({
    id: "profile-1",
    personId: "p-zhang",
    modelId: "campplus-v1",
    embedding: new Float32Array([0.4, 0.3, 0.2, 0.1]),
    sourceKind: "enrollment",
    speechMs: 30_000,
    windowCount: 5,
    createdAt: 60_000,
  });

  assert.equal(sample.personId, "p-zhang");
  assert.deepEqual(
    identities.listProfiles("campplus-v1").map((row) => row.id),
    ["profile-1"]
  );
  assert.deepEqual(identities.listProfiles("another-model"), []);
  assert.throws(
    () =>
      identities.addProfileSample({
        id: "profile-2",
        personId: "p-zhang",
        modelId: "campplus-v1",
        embedding: new Float32Array([1, 0, 0]),
        sourceKind: "enrollment",
        speechMs: 30_000,
        windowCount: 3,
      }),
    /dimension/
  );
});

test("confirmLink is transactional and retains correction history", (t) => {
  const { repository, identities } = fixture(t, { createId: () => "correction-fixed" });
  addPerson(repository, "p-zhang", "张三");
  addPerson(repository, "p-li", "李四");
  createCluster(identities);

  identities.confirmLink({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "session",
  });
  assert.equal(identities.getCluster("c1").personId, "p-zhang");
  assert.equal(identities.listCorrections("c1").length, 1);

  assert.throws(
    () =>
      identities.confirmLink({
        clusterId: "c1",
        personId: "p-li",
        actor: "user",
        scope: "session",
      }),
    /UNIQUE/
  );
  assert.equal(identities.getCluster("c1").personId, "p-zhang");
  assert.equal(identities.listCorrections("c1").length, 1);
});

test("persistent user confirmation adds only quality-gated profile evidence", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities);
  createCluster(identities, {
    id: "c-low-quality",
    localLabel: "speaker_2",
    qualityScore: null,
  });
  createCluster(identities, {
    id: "c-system",
    localLabel: "speaker_3",
  });

  identities.confirmLink({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "persistent",
  });
  identities.confirmLink({
    clusterId: "c-low-quality",
    personId: "p-zhang",
    actor: "user",
    scope: "persistent",
  });
  identities.confirmLink({
    clusterId: "c-system",
    personId: "p-zhang",
    actor: "system",
    scope: "persistent",
  });

  const samples = identities.listProfiles("campplus-v1");
  assert.equal(samples.length, 1);
  assert.equal(samples[0].sourceKind, "user_confirmed");
  assert.equal(samples[0].sourceClusterId, "c1");
});

test("reject and undo restore the recorded previous identity state", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities);
  repository.db
    .prepare("UPDATE speaker_clusters SET person_id = ?, link_state = 'suggested' WHERE id = ?")
    .run("p-zhang", "c1");

  identities.rejectSuggestion({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "session",
  });
  assert.equal(identities.getCluster("c1").personId, null);
  assert.equal(identities.getCluster("c1").linkState, "rejected");

  identities.undoLastCorrection("c1");
  assert.equal(identities.getCluster("c1").personId, "p-zhang");
  assert.equal(identities.getCluster("c1").linkState, "suggested");
  assert.equal(identities.listCorrections("c1")[0].undoneAt, 50_001);
});

test("undo uses insertion order when corrections share a timestamp", (t) => {
  const correctionIds = ["correction-z", "correction-a"];
  const { repository, identities } = fixture(t, {
    createId: () => correctionIds.shift(),
  });
  addPerson(repository, "p-first", "First");
  addPerson(repository, "p-second", "Second");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-first",
    actor: "user",
    scope: "session",
  });
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-second",
    actor: "user",
    scope: "session",
  });

  identities.undoLastCorrection("c1");

  assert.equal(identities.getCluster("c1").personId, "p-first");
  assert.equal(identities.listCorrections("c1")[1].undoneAt, 50_000);
});

test("mergePeople moves current identity data and keeps correction rows", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-source", "张三（旧）");
  addPerson(repository, "p-target", "张三");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-source",
    actor: "user",
    scope: "persistent",
  });

  identities.mergePeople({
    sourcePersonId: "p-source",
    targetPersonId: "p-target",
    actor: "user",
  });

  assert.equal(identities.getCluster("c1").personId, "p-target");
  assert.equal(identities.listProfiles("campplus-v1")[0].personId, "p-target");
  assert.equal(
    repository.db.prepare("SELECT 1 FROM people WHERE id = ?").get("p-source"),
    undefined
  );
  assert.ok(identities.listCorrections("c1").length >= 1);
});

test("deleting a person clears the link without deleting cluster evidence", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "session",
  });

  repository.db.prepare("DELETE FROM people WHERE id = ?").run("p-zhang");

  const cluster = identities.getCluster("c1");
  assert.equal(cluster.personId, null);
  assert.equal(cluster.linkState, "unknown");
  assert.deepEqual(Array.from(cluster.embedding), [
    Math.fround(0.1),
    Math.fround(0.2),
    Math.fround(0.3),
    Math.fround(0.4),
  ]);
});

test("identity migrations are idempotent and preserve existing data", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-migration-"));
  const dbPath = path.join(directory, "jarvis.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const repository = new JarvisRepository(dbPath);
  repository.createSession({ id: "preserved", startedAt: 1_000, micDeviceId: null });
  repository.renamePerson({ personId: "preserved-person", displayName: "Preserved" });
  repository.close();

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    DROP TRIGGER clear_deleted_person_speaker_links;
    DROP TABLE speaker_identity_corrections;
    DROP TABLE voice_profile_samples;
    DROP TABLE speaker_cluster_segments;
    DROP TABLE speaker_clusters;
    PRAGMA user_version = 16;
  `);
  assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 16, toVersion: TARGET_VERSION });
  assert.deepEqual(applyJarvisMigrations(db), {
    fromVersion: TARGET_VERSION,
    toVersion: TARGET_VERSION,
  });
  assert.equal(db.prepare("SELECT id FROM sessions WHERE id = ?").get("preserved").id, "preserved");
  assert.equal(
    db.prepare("SELECT id FROM people WHERE id = ?").get("preserved-person").id,
    "preserved-person"
  );
  for (const table of [
    "speaker_clusters",
    "speaker_cluster_segments",
    "voice_profile_samples",
    "speaker_identity_corrections",
  ]) {
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table).count,
      1
    );
  }
  db.close();
});
