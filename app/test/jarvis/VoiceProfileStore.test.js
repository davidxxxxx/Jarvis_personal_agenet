const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const VoiceProfileStore = require("../../src/jarvis/main/VoiceProfileStore");
const { SPEAKER_EMBEDDING_MODEL_ID } = require("../../src/helpers/speakerEmbeddings");

const MODEL_ID = SPEAKER_EMBEDDING_MODEL_ID;

function normalized(index = 0) {
  const vector = new Float32Array(512);
  vector[index] = 1;
  return vector;
}

function createStore(repository, options = {}) {
  repository.renamePerson({ personId: "self", displayName: "我", isSelf: true });
  return new VoiceProfileStore({ repository, ...options });
}

function enrollment(overrides = {}) {
  return {
    modelId: MODEL_ID,
    samples: [normalized(0), normalized(0), normalized(0)],
    sampleSpeechMs: [10_000, 10_000, 10_000],
    centroid: normalized(0),
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 1,
    ...overrides,
  };
}

test("replaces only same-person/model enrollment samples and preserves confirmed/other-model data", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository);
  repository.renamePerson({ personId: "other", displayName: "Other" });
  repository.speakerIdentityRepository.addProfileSample({
    id: "other-model",
    personId: "self",
    modelId: "another-model",
    embedding: new Float32Array([1, 0]),
    sourceKind: "enrollment",
    speechMs: 1_000,
    windowCount: 1,
  });

  store.saveEnrollment(enrollment());
  const firstIds = repository.listVoiceProfiles(MODEL_ID).map((sample) => sample.id);
  store.saveEnrollment(
    enrollment({
      samples: [normalized(1), normalized(1), normalized(1)],
      centroid: normalized(1),
      selfConsistency: 0.99,
    })
  );

  const current = repository.listVoiceProfiles(MODEL_ID);
  assert.equal(current.length, 3);
  assert.equal(
    current.every((sample) => sample.personId === "self" && sample.sourceKind === "enrollment"),
    true
  );
  assert.equal(
    current.some((sample) => firstIds.includes(sample.id)),
    false
  );
  assert.equal(repository.listVoiceProfiles("another-model").length, 1);
  assert.deepEqual(store.getStatus(), {
    enrolled: true,
    modelId: MODEL_ID,
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 0.99,
    updatedAt: store.getStatus().updatedAt,
  });
});

test("preserves a user_confirmed sample while replacing enrollment", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository);
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repository.createSpeakerCluster({
    id: "cluster",
    sessionId: "s1",
    trackId: null,
    localLabel: "speaker_1",
    modelId: MODEL_ID,
    embedding: normalized(2),
    speechMs: 18_000,
    windowCount: 3,
    qualityScore: 0.9,
  });
  repository.confirmSpeakerLink({
    clusterId: "cluster",
    personId: "self",
    actor: "user",
    scope: "persistent",
  });
  assert.equal(
    repository
      .listVoiceProfiles(MODEL_ID)
      .filter((sample) => sample.sourceKind === "user_confirmed").length,
    1
  );

  store.saveEnrollment(enrollment());
  store.saveEnrollment(
    enrollment({ centroid: normalized(1), samples: [normalized(1), normalized(1), normalized(1)] })
  );
  assert.equal(
    repository
      .listVoiceProfiles(MODEL_ID)
      .filter((sample) => sample.sourceKind === "user_confirmed").length,
    1
  );
  assert.equal(
    repository.listVoiceProfiles(MODEL_ID).filter((sample) => sample.sourceKind === "enrollment")
      .length,
    3
  );
});

test("rolls back sample replacement and aggregate update together", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository);
  store.saveEnrollment(enrollment());
  const beforeSamples = repository.listVoiceProfiles(MODEL_ID).map((sample) => sample.id);
  const beforeStatus = store.getStatus();
  repository.db.exec(`
    CREATE TRIGGER abort_profile_aggregate_update
    BEFORE UPDATE ON voice_profile_aggregates
    BEGIN SELECT RAISE(ABORT, 'forced aggregate failure'); END;
  `);

  assert.throws(
    () => store.saveEnrollment(enrollment({ centroid: normalized(1) })),
    /forced aggregate failure/
  );
  assert.deepEqual(
    repository.listVoiceProfiles(MODEL_ID).map((sample) => sample.id),
    beforeSamples
  );
  assert.deepEqual(store.getStatus(), beforeStatus);
});

test("persists current-model samples and aggregate across a same-path restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-profile-"));
  const dbPath = path.join(directory, "jarvis.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let repository = new JarvisRepository(dbPath);
  let store = createStore(repository);
  store.saveEnrollment(enrollment({ selfConsistency: 0.995 }));
  const before = store.getStatus();
  repository.close();

  repository = new JarvisRepository(dbPath);
  store = new VoiceProfileStore({ repository });
  assert.deepEqual(store.getStatus(), before);
  assert.equal(repository.listVoiceProfiles(MODEL_ID).length, 3);
  repository.close();
});

test("imports only legacy id -1 once without inventing quality and never exposes it as current model", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const legacyEmbedding = Buffer.from(normalized(4).buffer);
  let reads = 0;
  const legacyProfileReader = {
    getSpeakerProfileById(id, includeEmbedding) {
      reads += 1;
      assert.equal(id, -1);
      assert.equal(includeEmbedding, true);
      return { id: -1, display_name: "我", embedding: legacyEmbedding, sample_count: 99 };
    },
  };
  const store = createStore(repository, { legacyProfileReader });

  assert.equal(store.importLegacySelfProfile(), true);
  assert.equal(store.importLegacySelfProfile(), false);
  assert.equal(reads, 1);
  const legacy = repository.listVoiceProfiles("legacy-unversioned");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].speechMs, 0);
  assert.equal(legacy[0].windowCount, 0);
  assert.deepEqual(store.getStatus(), {
    enrolled: false,
    modelId: MODEL_ID,
    acceptedSpeechMs: 0,
    windowCount: 0,
    selfConsistency: null,
    updatedAt: null,
  });
  assert.equal(legacyEmbedding.equals(Buffer.from(normalized(4).buffer)), true);
});

test("legacy marker and imported target roll back in the same transaction", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository, {
    legacyProfileReader: {
      getSpeakerProfileById: () => ({ id: -1, embedding: Buffer.from(normalized(3).buffer) }),
    },
  });
  repository.db.exec(`
    CREATE TRIGGER abort_legacy_sample
    BEFORE INSERT ON voice_profile_samples
    WHEN NEW.model_id = 'legacy-unversioned'
    BEGIN SELECT RAISE(ABORT, 'forced legacy failure'); END;
  `);
  assert.throws(() => store.importLegacySelfProfile(), /forced legacy failure/);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM voice_profile_import_markers").get().count,
    0
  );
  assert.equal(repository.listVoiceProfiles("legacy-unversioned").length, 0);
});

test("corrupt legacy data is classified safely, leaves no marker, and imports after repair", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  let embedding = Buffer.alloc(3, 9);
  const logs = [];
  const store = createStore(repository, {
    legacyProfileReader: {
      getSpeakerProfileById: () => ({ id: -1, embedding }),
    },
  });

  assert.deepEqual(
    store.importLegacySelfProfileSafely((entry) => logs.push(entry)),
    {
      imported: false,
      status: "invalid_legacy_profile",
    }
  );
  assert.deepEqual(logs, [{ code: "legacy_voice_profile_invalid" }]);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM voice_profile_import_markers").get().count,
    0
  );
  assert.equal(repository.listVoiceProfiles("legacy-unversioned").length, 0);

  embedding = Buffer.from(normalized(3).buffer);
  assert.deepEqual(
    store.importLegacySelfProfileSafely((entry) => logs.push(entry)),
    {
      imported: true,
      status: "imported",
    }
  );
  assert.equal(repository.listVoiceProfiles("legacy-unversioned").length, 1);
});

test("rejects enrollment from any model other than the exact current CAMPPlus model", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository);
  assert.throws(
    () => store.saveEnrollment(enrollment({ modelId: "legacy-unversioned" })),
    /does not match the current model/
  );
  assert.equal(repository.listVoiceProfiles("legacy-unversioned").length, 0);
});

test("keeps the legacy import idempotent after reopening the same target database", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-profile-"));
  const dbPath = path.join(directory, "jarvis.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let reads = 0;
  const legacyProfileReader = {
    getSpeakerProfileById(id) {
      reads += 1;
      return { id, embedding: Buffer.from(normalized(5).buffer) };
    },
  };
  let repository = new JarvisRepository(dbPath);
  let store = createStore(repository, { legacyProfileReader });
  assert.equal(store.importLegacySelfProfile(), true);
  repository.close();

  repository = new JarvisRepository(dbPath);
  store = new VoiceProfileStore({ repository, legacyProfileReader });
  assert.equal(store.importLegacySelfProfile(), false);
  assert.equal(reads, 1);
  assert.equal(repository.listVoiceProfiles("legacy-unversioned").length, 1);
  const aggregate = repository.getVoiceProfileAggregate("self", "legacy-unversioned");
  assert.equal(aggregate.acceptedSpeechMs, 0);
  assert.equal(aggregate.windowCount, 0);
  assert.equal(aggregate.selfConsistency, null);
  repository.close();
});

test("refuses malformed current-model evidence before the repository transaction", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  const store = createStore(repository);
  for (const bad of [
    enrollment({ samples: [new Float32Array(511), normalized(0), normalized(0)] }),
    enrollment({
      samples: [Object.assign(normalized(0), { 4: Number.NaN }), normalized(0), normalized(0)],
    }),
    enrollment({ samples: [new Float32Array(512), normalized(0), normalized(0)] }),
    enrollment({ centroid: new Float32Array(512) }),
    enrollment({ windowCount: 2 }),
    enrollment({ sampleSpeechMs: [6_000, 6_000, 5_999], acceptedSpeechMs: 17_999 }),
    enrollment({ sampleSpeechMs: [10_000, 4_999, 10_000], acceptedSpeechMs: 24_999 }),
    enrollment({ selfConsistency: 0.77 }),
  ]) {
    assert.throws(() => store.saveEnrollment(bad), /quality|embedding|centroid|evidence/);
  }
  assert.equal(repository.listVoiceProfiles(MODEL_ID).length, 0);
  assert.equal(repository.getVoiceProfileAggregate("self", MODEL_ID), null);
});
