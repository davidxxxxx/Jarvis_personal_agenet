const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function createCluster(repository, input) {
  return repository.createSpeakerCluster({
    modelId: "campplus-v1",
    embedding: new Float32Array(512).fill(0.01),
    windowCount: 4,
    qualityScore: 0.9,
    ...input,
  });
}

test("people review overview separates anonymous social voices from pending and media", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({
    id: "review-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "dual",
  });
  repository.createTracks([
    {
      id: "track-mic",
      sessionId: "review-session",
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
    {
      id: "track-dota",
      sessionId: "review-session",
      sourceType: "system",
      applicationKey: "dota-2",
      applicationDisplayName: "DOTA 2",
      captureGeneration: 1,
      strategy: "include-process-tree",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
  ]);
  createCluster(repository, {
    id: "cluster-anonymous",
    sessionId: "review-session",
    trackId: "track-mic",
    localLabel: "speaker_1",
    speechMs: 25_000,
  });
  createCluster(repository, {
    id: "cluster-pending",
    sessionId: "review-session",
    trackId: "track-mic",
    localLabel: "speaker_2",
    speechMs: 8_000,
  });
  createCluster(repository, {
    id: "cluster-media",
    sessionId: "review-session",
    trackId: "track-dota",
    localLabel: "speaker_3",
    speechMs: 30_000,
  });

  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        commit_sequence, created_at, completed_at
      ) VALUES (
        'evidence-run', 'review-session', 'track-mic', ?, 'diarization-policy-v1',
        'diarizer-v1', 'campplus-v1', ?, 512, 16000, 2, 'cuda', 1, 2000, 3000
      )`
    )
    .run("c".repeat(64), "d".repeat(64));
  const insertEvidence = repository.db.prepare(
    `INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES ('evidence-run', ?, ?, ?, ?, 4, 0.9, 2000)`
  );
  insertEvidence.run(
    "cluster-anonymous",
    "speaker_1",
    Buffer.alloc(2048),
    25_000
  );
  insertEvidence.run("cluster-pending", "speaker_2", Buffer.alloc(2048), 8_000);
  const anonymousRef = `anonymous-speaker-${"1".repeat(32)}`;
  repository.applySystemSpeakerResolutions({
    id: "resolution-run",
    sessionId: "review-session",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: "identity-policy-v1",
    evidenceRunIds: ["evidence-run"],
    results: [
      {
        evidenceRunId: "evidence-run",
        clusterId: "cluster-anonymous",
        candidatePersonId: null,
        candidatePersonRef: anonymousRef,
        state: "unknown",
        score: 0.91,
        margin: 0.2,
        reason: "dual_model_anonymous_group",
        models: {
          primary: {
            modelId: "campplus-v1",
            artifactVersion: "test",
            embeddingSpace: "campplus",
            similarity: 0.91,
            margin: 0.2,
            passed: true,
          },
          review: {
            modelId: "eres2netv2-v1",
            artifactVersion: "test",
            embeddingSpace: "eres2netv2",
            similarity: 0.9,
            margin: 0.2,
            passed: true,
          },
        },
      },
      {
        evidenceRunId: "evidence-run",
        clusterId: "cluster-pending",
        candidatePersonId: null,
        candidatePersonRef: null,
        state: "unknown",
        score: null,
        margin: null,
        reason: "primary_gate_failed",
        models: {
          primary: {
            modelId: "campplus-v1",
            artifactVersion: "test",
            embeddingSpace: "campplus",
            similarity: 0.7,
            margin: 0.05,
            passed: false,
          },
          review: {
            modelId: "eres2netv2-v1",
            artifactVersion: "test",
            embeddingSpace: "eres2netv2",
            similarity: 0.65,
            margin: 0.04,
            passed: false,
          },
        },
      },
    ],
    at: 4_000,
  });

  const overview = repository.listPeopleReviewOverview();
  assert.equal(overview.anonymous.length, 1);
  assert.equal(overview.anonymous[0].id, anonymousRef);
  assert.equal(overview.anonymous[0].displayName, "未命名人物 1");
  assert.equal(overview.anonymous[0].speechMs, 25_000);
  assert.deepEqual(overview.anonymous[0].sourceNames, ["麦克风"]);
  assert.equal(overview.needsReview.length, 1);
  assert.equal(overview.needsReview[0].sessionId, "review-session");
  assert.equal(overview.needsReview[0].clusterCount, 1);
  assert.equal(overview.needsReview[0].representativeCluster.id, "cluster-pending");
  assert.equal(
    overview.anonymous.some((entry) => entry.representativeCluster.id === "cluster-media"),
    false
  );

  const mediaReview = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "mark_media",
    clusterIds: ["cluster-pending"],
    at: 5_000,
  });
  assert.equal(mediaReview.preview.affectedClusterCount, 1);
  assert.equal(
    mediaReview.speakerProcessing.participants.mediaVoices.some((voice) =>
      voice.clusterIds.includes("cluster-pending")
    ),
    true
  );
  const restored = repository.undoParticipantReview(mediaReview.event.id, 6_000);
  assert.equal(
    restored.speakerProcessing.participants.participants.some((person) =>
      person.clusterIds.includes("cluster-pending")
    ),
    true
  );

  const mergeReview = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "merge",
    clusterIds: ["cluster-anonymous", "cluster-pending"],
    at: 7_000,
  });
  assert.equal(mergeReview.speakerProcessing.participants.participants.length, 1);
  assert.equal(mergeReview.speakerProcessing.participants.participants[0].kind, "reviewed");
  assert.equal(mergeReview.speakerProcessing.participants.count.minimum, 1);
  assert.equal(mergeReview.speakerProcessing.participants.count.maximum, 1);
  assert.equal(
    repository.listParticipantReviewHistory("review-session").filter((event) => event.canUndo)
      .length,
    1
  );
});

test("people review overview hides anomalous legacy cluster storms", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({
    id: "legacy-storm",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repository.createTrack({
    id: "legacy-mic",
    sessionId: "legacy-storm",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repository.db
    .prepare(
      `INSERT INTO speaker_diarization_runs (
        id, session_id, track_id, transcript_revision, policy_id,
        diarizer_model_id, embedding_model_id, model_artifact_sha256,
        embedding_dimension, sample_rate, input_version, execution_device,
        commit_sequence, created_at, completed_at
      ) VALUES (
        'legacy-run', 'legacy-storm', 'legacy-mic', ?, 'diarization-policy-v1',
        'diarizer-v1', 'campplus-v1', ?, 512, 16000, 2, 'cuda', 1, 2000, 3000
      )`
    )
    .run("c".repeat(64), "d".repeat(64));
  const insertEvidence = repository.db.prepare(
    `INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES ('legacy-run', ?, ?, ?, 6000, 4, 0.9, 2000)`
  );
  for (let index = 0; index < 25; index += 1) {
    const clusterId = `legacy-cluster-${index}`;
    const localLabel = `speaker_${index + 1}`;
    createCluster(repository, {
      id: clusterId,
      sessionId: "legacy-storm",
      trackId: "legacy-mic",
      localLabel,
      speechMs: 6_000,
    });
    insertEvidence.run(clusterId, localLabel, Buffer.alloc(2048));
  }

  assert.equal(
    repository.getSessionSpeakerProcessing("legacy-storm").participants.excluded.anomaly,
    true
  );
  assert.deepEqual(repository.listPeopleReviewOverview(), {
    anonymous: [],
    needsReview: [],
  });
});
