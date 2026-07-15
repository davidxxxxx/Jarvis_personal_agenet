const test = require("node:test");
const assert = require("node:assert/strict");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const SpeakerCorrectionService = require("../../src/jarvis/main/SpeakerCorrectionService");

function fixture(t, clusterOverrides = {}) {
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
  repository.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: null,
      speakerLabel: "speaker_1",
      text: "hello",
      confidence: 0.9,
      isStable: true,
      trackId: "t-mic",
    },
  ]);
  repository.createSpeakerCluster({
    id: "c1",
    sessionId: "s1",
    trackId: "t-mic",
    localLabel: "speaker_1",
    modelId: "campplus-v1",
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    speechMs: 18_000,
    windowCount: 4,
    qualityScore: 0.9,
    ...clusterOverrides,
  });
  repository.replaceSpeakerClusterSegments("c1", ["seg-1"]);
  const service = new SpeakerCorrectionService({
    repository,
    createPersonId: () => "person-created",
    now: () => 60_000,
  });
  t.after(() => repository.close());
  return { repository, service };
}

function addPerson(repository, id, displayName, isSelf = false) {
  return repository.renamePerson({ personId: id, displayName, isSelf });
}

function applySuggestion(repository, personId = "p-zhang") {
  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        commit_sequence, created_at, completed_at
      ) VALUES ('evidence-run-1', 's1', 't-mic', ?, 'diarization-policy-v1',
        'diarizer-v1', 'campplus-v1', ?, 512, 16000, 1, 'cpu', 1, 2000, 3000)`
    )
    .run("c".repeat(64), "d".repeat(64));
  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_run_clusters (
        run_id, cluster_id, local_label, embedding, speech_ms,
        window_count, quality_score, first_appearance_at
      ) VALUES ('evidence-run-1', 'c1', 'speaker_1', ?, 18000, 4, 0.9, 2000)`
    )
    .run(Buffer.alloc(2048));
  repository.applySystemSpeakerResolution({
    evidenceRunId: "evidence-run-1",
    clusterId: "c1",
    candidatePersonId: personId,
    state: "suggested",
    score: 0.84,
    margin: 0.17,
    reason: "candidate_above_suggestion_threshold",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: "identity-policy-v1",
    at: 4_000,
  });
}

function transcriptProjection(repository) {
  return repository.db
    .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = 'seg-1'")
    .get();
}

test("session confirmation creates a display-normalized person atomically without learning", (t) => {
  const { repository, service } = fixture(t);

  const result = service.confirm({
    clusterId: "c1",
    newPersonName: "  Alice   Smith  ",
    scope: "session",
  });

  assert.equal(result.createdPerson, true);
  assert.equal(result.profileSampleAdded, false);
  assert.equal(result.profileSampleReason, "session_scope");
  assert.equal(result.cluster.person.displayName, "Alice Smith");
  assert.deepEqual(transcriptProjection(repository), {
    person_id: "person-created",
    speaker_label: "Alice Smith",
  });
  assert.equal(repository.listVoiceProfiles("campplus-v1").length, 0);
});

test("persistent confirmation reports added and quality-gate skip outcomes separately", (t) => {
  const good = fixture(t);
  addPerson(good.repository, "p-zhang", "张三");
  const learned = good.service.confirm({
    clusterId: "c1",
    personId: "p-zhang",
    scope: "persistent",
  });
  assert.equal(learned.profileSampleAdded, true);
  assert.equal(learned.profileSampleReason, "added");

  const low = fixture(t, { qualityScore: 0.4 });
  addPerson(low.repository, "p-li", "李四");
  const linked = low.service.confirm({
    clusterId: "c1",
    personId: "p-li",
    scope: "persistent",
  });
  assert.equal(linked.cluster.person.id, "p-li");
  assert.equal(linked.profileSampleAdded, false);
  assert.equal(linked.profileSampleReason, "insufficient_quality");
});

test("confirm enforces exact keys target XOR scope safe IDs and Unicode name bounds", (t) => {
  const { service } = fixture(t);
  const valid = "界".repeat(80);
  assert.equal(
    service.confirm({ clusterId: "c1", newPersonName: valid, scope: "session" }).cluster.person
      .displayName,
    valid
  );
  for (const input of [
    { clusterId: "c1", scope: "session" },
    { clusterId: "c1", personId: "p1", newPersonName: "P1", scope: "session" },
    { clusterId: "c1", newPersonName: "P1", scope: "forever" },
    { clusterId: "c1", newPersonName: " ", scope: "session" },
    { clusterId: "c1", newPersonName: "界".repeat(81), scope: "session" },
    { clusterId: "c1", newPersonName: "P1", scope: "session", actor: "system" },
    [],
  ]) {
    assert.throws(() => service.confirm(input), /target|scope|name|unknown|object/i);
  }
});

test("normalized duplicate reuse retains display form and ambiguity makes no mutation", (t) => {
  const { repository, service } = fixture(t);
  addPerson(repository, "p-existing", "Ａlice   Smith");

  const reused = service.confirm({
    clusterId: "c1",
    newPersonName: "alice smith",
    scope: "session",
  });
  assert.equal(reused.createdPerson, false);
  assert.equal(reused.cluster.person.id, "p-existing");
  assert.equal(reused.cluster.person.displayName, "Ａlice   Smith");

  service.undo("c1");
  addPerson(repository, "p-duplicate", "ALICE SMITH");
  let error;
  try {
    service.confirm({
      clusterId: "c1",
      newPersonName: " Alice Smith ",
      scope: "session",
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, "ambiguous_duplicate_name");
  assert.deepEqual(error.candidates.map((candidate) => candidate.id).sort(), [
    "p-duplicate",
    "p-existing",
  ]);
  assert.equal(repository.getSpeakerCluster("c1").personId, null);
  assert.equal(repository.listPeople().length, 2);
});

test("new-person confirmation rolls back person link correction transcript and sample together", (t) => {
  const { repository, service } = fixture(t);
  const original = repository.speakerIdentityRepository._syncTranscriptProjection;
  repository.speakerIdentityRepository._syncTranscriptProjection = () => {
    throw new Error("injected transcript projection failure");
  };
  t.after(() => {
    repository.speakerIdentityRepository._syncTranscriptProjection = original;
  });

  assert.throws(
    () =>
      service.confirm({
        clusterId: "c1",
        newPersonName: "Rollback Person",
        scope: "persistent",
      }),
    /injected transcript projection failure/
  );
  assert.equal(repository.listPeople().length, 0);
  assert.equal(repository.getSpeakerCluster("c1").linkState, "unknown");
  assert.equal(repository.listSpeakerCorrections("c1").length, 0);
  assert.deepEqual(transcriptProjection(repository), {
    person_id: null,
    speaker_label: "speaker_1",
  });
  assert.equal(repository.listVoiceProfiles("campplus-v1").length, 0);
});

test("reject targets only the current suggestion and undo restores it", (t) => {
  const { repository, service } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  addPerson(repository, "p-li", "李四");
  applySuggestion(repository);

  assert.throws(() => service.reject("c1", "p-li"), /current suggestion/);
  assert.equal(repository.getSpeakerCluster("c1").linkState, "suggested");
  const rejected = service.reject("c1", "p-zhang");
  assert.equal(rejected.linkState, "rejected");
  assert.equal(rejected.lastRejectedPerson.id, "p-zhang");
  assert.equal(repository.listVoiceProfiles("campplus-v1").length, 0);

  const restored = service.undo("c1");
  assert.equal(restored.linkState, "suggested");
  assert.equal(restored.suggestedPerson.id, "p-zhang");
  assert.throws(() => service.undo("c1"), /undoable link correction/);
});

test("merge revalidates self and existence inside one transaction and returns fresh safe detail", (t) => {
  const { repository, service } = fixture(t);
  addPerson(repository, "self", "我", true);
  addPerson(repository, "p-source", "Source");
  addPerson(repository, "p-target", "Target");
  service.confirm({ clusterId: "c1", personId: "p-source", scope: "session" });

  assert.throws(() => service.mergePeople("self", "p-target"), /self/);
  assert.throws(() => service.mergePeople("p-source", "p-source"), /different/);
  assert.throws(() => service.mergePeople("missing", "p-target"), /not found/);
  const detail = service.mergePeople("p-source", "p-target");

  assert.equal(detail.person.id, "p-target");
  assert.equal(detail.identity.appearances[0].clusterId, "c1");
  assert.equal(detail.identity.corrections[0].correctionKind, "merge");
  assert.equal(repository.getSpeakerClusterView("c1").canUndo, false);
  assert.equal(JSON.stringify(detail).includes("embedding"), false);
  assert.equal(JSON.stringify(detail).includes("path"), false);
});

test("list APIs return only public allowlisted correction and cluster metadata", (t) => {
  const { repository, service } = fixture(t);
  addPerson(repository, "p-zhang", "张三");
  service.confirm({ clusterId: "c1", personId: "p-zhang", scope: "session" });

  const value = {
    clusters: service.listSessionClusters("s1"),
    corrections: service.listCorrections("c1"),
  };
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("embedding"), false);
  assert.equal(serialized.includes("path"), false);
  assert.equal(value.corrections[0].actor, "user");
});
