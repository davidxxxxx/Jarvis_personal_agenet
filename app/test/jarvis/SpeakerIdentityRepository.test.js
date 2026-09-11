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

function applySuggestion(repository, identities, overrides = {}) {
  const diarizationRevision = overrides.diarizationRevision ?? "a".repeat(64);
  const profileRevision = overrides.profileRevision ?? "b".repeat(64);
  const policyId = overrides.policyId ?? "identity-policy-v1";
  const evidenceRunId = overrides.evidenceRunId ?? "evidence-run-1";
  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        commit_sequence, created_at, completed_at
      ) VALUES (?, 's1', 't-mic', ?, 'diarization-policy-v1',
        'diarizer-v1', 'campplus-v1', ?, 512, 16000, 1, 'cpu', 1, 2000, 3000)`
    )
    .run(evidenceRunId, "c".repeat(64), "d".repeat(64));
  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_run_clusters (
        run_id, cluster_id, local_label, embedding, speech_ms,
        window_count, quality_score, first_appearance_at
      ) VALUES (?, 'c1', 'speaker_1', ?, 18000, 4, 0.9, 2000)`
    )
    .run(evidenceRunId, Buffer.alloc(2048));
  return identities.applySystemResolution({
    evidenceRunId,
    clusterId: "c1",
    candidatePersonId: overrides.personId ?? "p-zhang",
    state: "suggested",
    score: overrides.score ?? 0.84,
    margin: overrides.margin ?? 0.17,
    reason: overrides.reason ?? "candidate_above_suggestion_threshold",
    diarizationRevision,
    profileRevision,
    policyId,
    at: overrides.at ?? 4_000,
  });
}

function assertNoPrivateIdentityData(value) {
  const visit = (current) => {
    assert.equal(Buffer.isBuffer(current), false);
    assert.equal(current instanceof Uint8Array, false);
    assert.equal(current instanceof Float32Array, false);
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      assert.doesNotMatch(key, /embedding|blob|path/i);
      visit(nested);
    }
  };
  visit(value);
}

function downgradeIdentitySchemaToV17(repository) {
  repository.db.exec(`
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_insert;
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_update;
    DROP TABLE IF EXISTS speaker_identity_resolutions;
    DROP TABLE IF EXISTS speaker_identity_resolution_runs;
  `);
  repository.db.exec("DROP INDEX IF EXISTS idx_speaker_clusters_unbound_label");
  const columns = new Set(
    repository.db
      .prepare("PRAGMA table_info(speaker_identity_corrections)")
      .all()
      .map((column) => column.name)
  );
  for (const column of [
    "resolution_commit_sequence",
    "correction_kind",
    "next_person_ref",
    "previous_person_ref",
  ]) {
    if (columns.has(column)) {
      repository.db.exec(`ALTER TABLE speaker_identity_corrections DROP COLUMN ${column}`);
    }
  }
  repository.db.pragma("user_version = 17");
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

test("merge keeps immutable person provenance and cannot be undone as a link correction", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-source", "Source");
  addPerson(repository, "p-target", "Target");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-source",
    actor: "user",
    scope: "session",
  });

  identities.mergePeople({ sourcePersonId: "p-source", targetPersonId: "p-target" });

  const corrections = identities.listCorrections("c1");
  assert.equal(corrections[0].nextPersonId, null);
  assert.equal(corrections[0].nextPersonRef, "p-source");
  assert.equal(corrections[0].correctionKind, "link");
  assert.equal(corrections[1].previousPersonId, null);
  assert.equal(corrections[1].previousPersonRef, "p-source");
  assert.equal(corrections[1].nextPersonRef, "p-target");
  assert.equal(corrections[1].correctionKind, "merge");

  identities.undoLastCorrection("c1");

  assert.equal(identities.getCluster("c1").personId, "p-target");
  assert.equal(identities.getCluster("c1").linkState, "confirmed");
  assert.equal(identities.listCorrections("c1")[1].undoneAt, null);
});

test("mergePeople refuses to delete the reserved self person", (t) => {
  const { repository, identities } = fixture(t);
  repository.renamePerson({ personId: "self", displayName: "我", isSelf: true });
  addPerson(repository, "p-target", "Target");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "self",
    actor: "user",
    scope: "session",
  });

  assert.throws(
    () => identities.mergePeople({ sourcePersonId: "self", targetPersonId: "p-target" }),
    /self person/
  );
  assert.equal(
    repository.db.prepare("SELECT is_self FROM people WHERE id = 'self'").get().is_self,
    1
  );
  assert.equal(identities.getCluster("c1").personId, "self");
  assert.equal(identities.listCorrections("c1").length, 1);
});

test("unbound clusters remain unique by session and local label", (t) => {
  const { identities } = fixture(t);
  createCluster(identities, {
    id: "unbound-1",
    trackId: null,
    localLabel: "speaker_unbound",
  });

  assert.throws(
    () =>
      createCluster(identities, {
        id: "unbound-2",
        trackId: null,
        localLabel: "speaker_unbound",
      }),
    /UNIQUE/
  );
});

test("public profile writes cannot bypass user-confirmed cluster quality", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities, {
    id: "low-quality",
    localLabel: "speaker_low",
    qualityScore: 0.4,
  });
  repository.db
    .prepare("UPDATE speaker_clusters SET person_id = ?, link_state = 'confirmed' WHERE id = ?")
    .run("p-zhang", "low-quality");

  assert.throws(
    () =>
      identities.addProfileSample({
        id: "bypass-low-quality",
        personId: "p-zhang",
        modelId: "campplus-v1",
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        sourceClusterId: "low-quality",
        sourceKind: "user_confirmed",
        speechMs: 18_000,
        windowCount: 4,
      }),
    /quality gate/
  );
  assert.throws(
    () =>
      identities.addProfileSample({
        id: "bypass-no-source",
        personId: "p-zhang",
        modelId: "campplus-v1",
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        sourceKind: "user_confirmed",
        speechMs: 18_000,
        windowCount: 4,
      }),
    /source cluster/
  );

  createCluster(identities, {
    id: "good-quality",
    localLabel: "speaker_good",
  });
  repository.db
    .prepare("UPDATE speaker_clusters SET person_id = ?, link_state = 'confirmed' WHERE id = ?")
    .run("p-zhang", "good-quality");
  assert.throws(
    () =>
      identities.addProfileSample({
        id: "bypass-wrong-vector",
        personId: "p-zhang",
        modelId: "campplus-v1",
        embedding: new Float32Array([0.4, 0.3, 0.2, 0.1]),
        sourceClusterId: "good-quality",
        sourceKind: "user_confirmed",
        speechMs: 18_000,
        windowCount: 4,
      }),
    /cluster embedding/
  );

  const accepted = identities.addProfileSample({
    id: "confirmed-valid",
    personId: "p-zhang",
    modelId: "campplus-v1",
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    sourceClusterId: "good-quality",
    sourceKind: "user_confirmed",
    speechMs: 18_000,
    windowCount: 4,
  });
  assert.equal(accepted.sourceKind, "user_confirmed");

  const enrollment = identities.addProfileSample({
    id: "enrollment-unaffected",
    personId: "p-zhang",
    modelId: "another-model",
    embedding: new Float32Array([1, 0]),
    sourceKind: "enrollment",
    speechMs: 1_000,
    windowCount: 1,
  });
  assert.equal(enrollment.sourceKind, "enrollment");
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
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_insert;
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_update;
    DROP TABLE IF EXISTS speaker_identity_resolutions;
    DROP TABLE IF EXISTS speaker_identity_resolution_runs;
    DROP TRIGGER clear_deleted_person_speaker_links;
    DROP TABLE speaker_identity_corrections;
    DROP TABLE voice_profile_import_markers;
    DROP TABLE voice_profile_aggregates;
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
    "voice_profile_aggregates",
    "voice_profile_import_markers",
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

test("v17 identity history migrates on reopen with snapshots and rolls back on failure", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-v17-"));
  const successPath = path.join(directory, "success.db");
  const failurePath = path.join(directory, "failure.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const dbPath of [successPath, failurePath]) {
    const repository = new JarvisRepository(dbPath);
    repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
    repository.renamePerson({ personId: "p1", displayName: "Person" });
    repository.createSpeakerCluster({
      id: "c1",
      sessionId: "s1",
      trackId: null,
      localLabel: "speaker_1",
      modelId: "campplus-v1",
      embedding: new Float32Array([1, 0]),
      speechMs: 18_000,
      windowCount: 3,
      qualityScore: 0.9,
    });
    repository.confirmSpeakerLink({
      clusterId: "c1",
      personId: "p1",
      actor: "user",
      scope: "session",
    });
    downgradeIdentitySchemaToV17(repository);
    if (dbPath === successPath) {
      repository.createSpeakerCluster({
        id: "c2",
        sessionId: "s1",
        trackId: null,
        localLabel: "speaker_1",
        modelId: "campplus-v1",
        embedding: new Float32Array([1, 0]),
        speechMs: 12_000,
        windowCount: 3,
        qualityScore: 0.8,
      });
    }
    repository.close();
  }

  const reopened = new JarvisRepository(successPath);
  assert.equal(reopened.db.pragma("user_version", { simple: true }), TARGET_VERSION);
  assert.deepEqual(
    reopened.db
      .prepare("PRAGMA table_info(speaker_identity_corrections)")
      .all()
      .map((column) => column.name)
      .filter((name) =>
        ["previous_person_ref", "next_person_ref", "correction_kind"].includes(name)
      ),
    ["previous_person_ref", "next_person_ref", "correction_kind"]
  );
  assert.equal(reopened.listSpeakerCorrections("c1")[0].nextPersonRef, "p1");
  const migratedClusters = reopened.listSessionSpeakerClusters("s1");
  assert.equal(migratedClusters.length, 2);
  assert.equal(new Set(migratedClusters.map((cluster) => cluster.localLabel)).size, 2);
  assert.ok(
    reopened.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_speaker_clusters_unbound_label")
  );
  reopened.close();

  const failing = new Database(failurePath);
  failing.exec(`
    CREATE TRIGGER abort_identity_history_backfill
    BEFORE UPDATE ON speaker_identity_corrections
    BEGIN
      SELECT RAISE(ABORT, 'forced identity migration failure');
    END;
  `);
  assert.throws(() => applyJarvisMigrations(failing), /forced identity migration failure/);
  assert.equal(failing.pragma("user_version", { simple: true }), 17);
  assert.deepEqual(
    failing
      .prepare("PRAGMA table_info(speaker_identity_corrections)")
      .all()
      .map((column) => column.name),
    [
      "id",
      "cluster_id",
      "previous_person_id",
      "next_person_id",
      "previous_state",
      "next_state",
      "scope",
      "actor",
      "created_at",
      "undone_at",
    ]
  );
  failing.close();
});

test("v17 legacy merges become non-undoable provenance while ordinary links stay undoable", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-merge-v17-"));
  const dbPath = path.join(directory, "jarvis.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const repository = new JarvisRepository(dbPath);
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  const addCluster = (id, localLabel) =>
    repository.createSpeakerCluster({
      id,
      sessionId: "s1",
      trackId: null,
      localLabel,
      modelId: "campplus-v1",
      embedding: new Float32Array([1, 0]),
      speechMs: 18_000,
      windowCount: 3,
      qualityScore: 0.9,
    });

  for (const [personId, name] of [
    ["source-confirmed", "Source confirmed"],
    ["target-confirmed", "Target confirmed"],
    ["source-suggested", "Source suggested"],
    ["target-suggested", "Target suggested"],
    ["source-deleted-target", "Source deleted target"],
    ["target-later-deleted", "Target later deleted"],
    ["ordinary-link", "Ordinary link"],
    ["ordinary-reject", "Ordinary reject"],
  ]) {
    repository.renamePerson({ personId, displayName: name });
  }

  addCluster("legacy-confirmed", "legacy_confirmed");
  repository.confirmSpeakerLink({
    clusterId: "legacy-confirmed",
    personId: "source-confirmed",
    actor: "user",
    scope: "session",
  });
  repository.mergeSpeakerPeople({
    sourcePersonId: "source-confirmed",
    targetPersonId: "target-confirmed",
  });

  addCluster("legacy-suggested", "legacy_suggested");
  repository.db
    .prepare("UPDATE speaker_clusters SET person_id = ?, link_state = 'suggested' WHERE id = ?")
    .run("source-suggested", "legacy-suggested");
  repository.mergeSpeakerPeople({
    sourcePersonId: "source-suggested",
    targetPersonId: "target-suggested",
  });

  addCluster("legacy-target-deleted", "legacy_target_deleted");
  repository.confirmSpeakerLink({
    clusterId: "legacy-target-deleted",
    personId: "source-deleted-target",
    actor: "user",
    scope: "session",
  });
  repository.mergeSpeakerPeople({
    sourcePersonId: "source-deleted-target",
    targetPersonId: "target-later-deleted",
  });
  repository.db.prepare("DELETE FROM people WHERE id = ?").run("target-later-deleted");

  addCluster("ordinary-link-cluster", "ordinary_link");
  repository.confirmSpeakerLink({
    clusterId: "ordinary-link-cluster",
    personId: "ordinary-link",
    actor: "user",
    scope: "persistent",
  });

  addCluster("ordinary-reject-cluster", "ordinary_reject");
  repository.db
    .prepare("UPDATE speaker_clusters SET person_id = ?, link_state = 'suggested' WHERE id = ?")
    .run("ordinary-reject", "ordinary-reject-cluster");
  repository.rejectSpeakerSuggestion({
    clusterId: "ordinary-reject-cluster",
    personId: "ordinary-reject",
    actor: "user",
    scope: "session",
  });

  downgradeIdentitySchemaToV17(repository);
  repository.close();

  const migrated = new JarvisRepository(dbPath);
  const mergeCorrection = (clusterId) =>
    migrated
      .listSpeakerCorrections(clusterId)
      .find(
        (correction) =>
          correction.previousState === correction.nextState &&
          ["confirmed", "suggested"].includes(correction.previousState)
      );
  for (const [clusterId, expectedPersonId, expectedState] of [
    ["legacy-confirmed", "target-confirmed", "confirmed"],
    ["legacy-suggested", "target-suggested", "suggested"],
    ["legacy-target-deleted", null, "unknown"],
  ]) {
    const correction = mergeCorrection(clusterId);
    assert.equal(correction.correctionKind, "merge");
    assert.equal(correction.previousPersonRef, `legacy-source-unavailable:${correction.id}`);
    assert.ok(correction.nextPersonRef);
    migrated.undoSpeakerCorrection(clusterId);
    assert.equal(migrated.getSpeakerCluster(clusterId).personId, expectedPersonId);
    assert.equal(migrated.getSpeakerCluster(clusterId).linkState, expectedState);
  }

  const ordinaryLink = migrated.listSpeakerCorrections("ordinary-link-cluster")[0];
  assert.equal(ordinaryLink.correctionKind, "link");
  migrated.undoSpeakerCorrection("ordinary-link-cluster");
  assert.equal(migrated.getSpeakerCluster("ordinary-link-cluster").personId, null);
  assert.equal(migrated.getSpeakerCluster("ordinary-link-cluster").linkState, "unknown");

  const ordinaryReject = migrated.listSpeakerCorrections("ordinary-reject-cluster")[0];
  assert.equal(ordinaryReject.correctionKind, "link");
  migrated.undoSpeakerCorrection("ordinary-reject-cluster");
  assert.equal(migrated.getSpeakerCluster("ordinary-reject-cluster").personId, "ordinary-reject");
  assert.equal(migrated.getSpeakerCluster("ordinary-reject-cluster").linkState, "suggested");
  migrated.close();
});

test("public cluster projection allowlists current monotonic provenance and evidence", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities);
  repository.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: null,
      speakerLabel: "speaker_1",
      text: "你好",
      confidence: 0.9,
      isStable: true,
      trackId: "t-mic",
    },
  ]);
  identities.replaceClusterSegments("c1", ["seg-1"]);
  applySuggestion(repository, identities);

  const view = identities.getClusterView("c1");

  assert.deepEqual(Object.keys(view).sort(), [
    "canUndo",
    "candidatePersonRef",
    "diarizationRevision",
    "evidenceSegmentIds",
    "id",
    "lastRejectedPerson",
    "linkState",
    "localLabel",
    "margin",
    "person",
    "policyId",
    "profileRevision",
    "qualityScore",
    "reason",
    "score",
    "sessionId",
    "speechMs",
    "suggestedPerson",
    "trackId",
    "updatedAt",
    "windowCount",
  ]);
  assert.equal(view.linkState, "suggested");
  assert.deepEqual(view.suggestedPerson, {
    id: "p-zhang",
    displayName: "张三",
    isSelf: false,
  });
  assert.equal(view.person, null);
  assert.equal(view.reason, "candidate_above_suggestion_threshold");
  assert.equal(view.policyId, "identity-policy-v1");
  assert.equal(view.diarizationRevision, "a".repeat(64));
  assert.equal(view.profileRevision, "b".repeat(64));
  assert.deepEqual(view.evidenceSegmentIds, ["seg-1"]);
  assert.equal(view.canUndo, false);
  assertNoPrivateIdentityData(view);
});

test("correction mutations atomically synchronize transcript identity and stable labels", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  addPerson(repository, "p-target", "张三（合并）");
  createCluster(identities);
  repository.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: null,
      speakerLabel: "speaker_1",
      text: "你好",
      confidence: 0.9,
      isStable: true,
      trackId: "t-mic",
    },
  ]);
  identities.replaceClusterSegments("c1", ["seg-1"]);

  const outcome = identities.confirmLinkWithOutcome({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "persistent",
  });
  assert.deepEqual(outcome, { profileSampleAdded: true, profileSampleReason: "added" });
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = 'seg-1'")
      .get(),
    { person_id: "p-zhang", speaker_label: "张三" }
  );
  assert.equal(identities.getClusterView("c1").canUndo, true);

  identities.undoLastCorrection("c1");
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = 'seg-1'")
      .get(),
    { person_id: null, speaker_label: "张三" }
  );

  identities.confirmLink({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "session",
  });
  identities.mergePeople({ sourcePersonId: "p-zhang", targetPersonId: "p-target" });
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = 'seg-1'")
      .get(),
    { person_id: "p-target", speaker_label: "张三" }
  );
  assert.equal(identities.getClusterView("c1").canUndo, false);
  identities.undoLastCorrection("c1");
  assert.equal(identities.getCluster("c1").personId, "p-target");
});

test("person identity detail exposes metadata without vectors or filesystem paths", (t) => {
  const { repository, identities } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  createCluster(identities);
  identities.confirmLink({
    clusterId: "c1",
    personId: "p-zhang",
    actor: "user",
    scope: "persistent",
  });

  const identity = identities.getPersonIdentityDetail("p-zhang");

  assert.equal(identity.samples.length, 1);
  assert.deepEqual(identity.samples[0], {
    id: identity.samples[0].id,
    modelId: "campplus-v1",
    sourceKind: "user_confirmed",
    sourceClusterId: "c1",
    speechMs: 18_000,
    windowCount: 4,
    createdAt: identity.samples[0].createdAt,
  });
  assert.equal(identity.appearances[0].clusterId, "c1");
  assert.equal(identity.corrections[0].actor, "user");
  assert.deepEqual(Object.keys(identity.corrections[0]).sort(), [
    "actor",
    "clusterId",
    "correctionKind",
    "createdAt",
    "id",
    "nextPersonId",
    "nextPersonRef",
    "nextState",
    "previousPersonId",
    "previousPersonRef",
    "previousState",
    "scope",
    "undoneAt",
  ]);
  assertNoPrivateIdentityData(identity);
});
