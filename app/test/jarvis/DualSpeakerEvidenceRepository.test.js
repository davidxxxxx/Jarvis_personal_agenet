const test = require("node:test");
const assert = require("node:assert/strict");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");

function embeddingCipher() {
  const prefix = Buffer.from("TEST-ENC");
  return {
    encryptBuffer(plaintext) {
      const encrypted = Buffer.alloc(prefix.length + plaintext.length);
      prefix.copy(encrypted);
      for (let index = 0; index < plaintext.length; index += 1) {
        encrypted[prefix.length + index] = plaintext[index] ^ 0xa5;
      }
      return encrypted;
    },
    decryptBuffer(encrypted) {
      assert.equal(encrypted.subarray(0, prefix.length).equals(prefix), true);
      const plaintext = Buffer.alloc(encrypted.length - prefix.length);
      for (let index = 0; index < plaintext.length; index += 1) {
        plaintext[index] = encrypted[prefix.length + index] ^ 0xa5;
      }
      return plaintext;
    },
  };
}

function seed(repository) {
  repository.db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-dual-repo', 1000, 20000, 'completed', 1000);
    INSERT INTO audio_tracks (
      id, session_id, source_type, device_id, device_label, strategy,
      sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-dual-repo', 'session-dual-repo', 'mic', 'physical-mic',
      'Physical Microphone', 'selected', 24000, 1, 1000, 20000, 'ended'
    );
    INSERT INTO audio_chunks (
      id, session_id, path, started_at, ended_at, duration_ms, sha256,
      expires_at, transcription_status, track_id, source_type, sequence_number,
      write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-dual-repo', 'session-dual-repo', 'G:\\\\JarvisData\\\\chunk.wav',
      1000, 20000, 19000, '${"a".repeat(64)}', 999999, 'completed',
      'track-dual-repo', 'mic', 0, 'committed', 'wav', 24000, 1
    );
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, speech_ms,
      window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'cluster-dual-repo', 'session-dual-repo', 'track-dual-repo',
      'speaker_1', 'legacy', 15000, 3, 0.9, 'unknown', 20000, 20000
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'run-dual-repo', 'session-dual-repo', 'track-dual-repo',
      '${"b".repeat(64)}', 'jarvis-session-diarization-v1', 'diarizer',
      'legacy', '${"c".repeat(64)}', 512, 16000, 1, 'cpu', 1, 20000, 20000
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, speech_ms, window_count,
      quality_score, first_appearance_at
    ) VALUES (
      'run-dual-repo', 'cluster-dual-repo', 'speaker_1',
      0, 0, NULL, 1000
    );
  `);
  const insertTurn = repository.db.prepare(`
    INSERT INTO speaker_turns (
      id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
      raw_label, started_at, ended_at, echo_state, excluded_from_centroid, created_at
    ) VALUES (
      ?, 'run-dual-repo', 'cluster-dual-repo', 'chunk-dual-repo', NULL, ?,
      'speaker_1', ?, ?, 'none', 0, 20000
    )
  `);
  insertTurn.run("turn-1", 0, 1000, 6000);
  insertTurn.run("turn-2", 1, 7000, 12000);
  insertTurn.run("turn-3", 2, 13000, 18000);
}

function saveDualEvidence(
  repository,
  { sourceKind = "mic", attributionState = "exact", overlapDetected = false } = {}
) {
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  const primaryEmbedding = new Float32Array(192);
  const reviewEmbedding = new Float32Array(192);
  primaryEmbedding[0] = 1;
  reviewEmbedding[1] = 1;
  repository.replaceSpeakerClusterModelEmbeddings({
    clusterId: "cluster-dual-repo",
    sourceKind,
    attributionState,
    overlapDetected,
    echoDetected: false,
    speechMs: 15_000,
    windowCount: 3,
    qualityScore: 0.9,
    createdAt: 20_000,
    models: [
      { ...primary, embedding: primaryEmbedding, qualityScore: 0.91 },
      { ...review, embedding: reviewEmbedding, qualityScore: 0.89 },
    ],
  });
  return { primary, review };
}

test("repository exposes exact safe windows and encrypts both isolated model spaces", (t) => {
  const repository = new JarvisRepository(":memory:", {
    embeddingCipher: embeddingCipher(),
  });
  t.after(() => repository.close());
  seed(repository);

  const windows = repository.listSpeakerIdentityAudioWindows({
    sessionId: "session-dual-repo",
    evidenceRunId: "run-dual-repo",
    clusterId: "cluster-dual-repo",
  });
  assert.equal(windows.length, 3);
  assert.equal(
    windows.every((window) => window.trackKind === "mic"),
    true
  );
  assert.equal(
    windows.every((window) => window.attributionState === "exact"),
    true
  );
  assert.equal(
    windows.every((window) => !window.overlapDetected && !window.echoDetected),
    true
  );

  const { primary, review } = saveDualEvidence(repository);

  const stored = repository.db
    .prepare("SELECT model_id, embedding FROM speaker_cluster_model_embeddings ORDER BY model_id")
    .all();
  assert.equal(stored.length, 2);
  assert.equal(
    stored.every((row) => row.embedding.subarray(0, 8).toString() === "TEST-ENC"),
    true
  );
  const decoded = repository.listSpeakerClusterModelEmbeddings("cluster-dual-repo");
  assert.equal(decoded.length, 2);
  assert.equal(
    decoded.every((entry) => entry.embedding.length === 192),
    true
  );
  assert.equal(decoded.find((entry) => entry.modelId === primary.modelId).embedding[0], 1);
  assert.equal(decoded.find((entry) => entry.modelId === review.modelId).embedding[1], 1);
  for (const entry of decoded) entry.embedding.fill(0);
});

test("persistent confirmation learns both encrypted model spaces and undo removes them", (t) => {
  const repository = new JarvisRepository(":memory:", {
    embeddingCipher: embeddingCipher(),
  });
  t.after(() => repository.close());
  seed(repository);
  const { primary, review } = saveDualEvidence(repository);
  repository.renamePerson({ personId: "person-confirmed", displayName: "人物 3" });

  const outcome = repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-dual-repo",
    personId: "person-confirmed",
    scope: "persistent",
    actor: "user",
  });

  assert.deepEqual(outcome, {
    profileSampleAdded: true,
    profileSampleReason: "added",
  });
  const stored = repository.db
    .prepare(
      `SELECT model_id, embedding, source_kind
       FROM voice_profile_samples
       WHERE source_cluster_id = 'cluster-dual-repo'
       ORDER BY model_id`
    )
    .all();
  assert.deepEqual(
    stored.map((row) => row.model_id),
    [primary.modelId, review.modelId].sort()
  );
  assert.equal(
    stored.every((row) => row.source_kind === "user_confirmed"),
    true
  );
  assert.equal(
    stored.every((row) => row.embedding.subarray(0, 8).toString() === "TEST-ENC"),
    true
  );
  assert.equal(repository.listVoiceProfiles(primary.modelId)[0].embedding[0], 1);
  assert.equal(repository.listVoiceProfiles(review.modelId)[0].embedding[1], 1);

  repository.undoSpeakerCorrection("cluster-dual-repo");
  assert.equal(
    repository.db
      .prepare("SELECT count(*) AS count FROM voice_profile_samples WHERE source_cluster_id = ?")
      .get("cluster-dual-repo").count,
    0
  );
});

test("SELF never learns application or mixed-system speaker evidence", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  seed(repository);
  repository.renamePerson({ personId: "self-person", displayName: "我", isSelf: true });
  saveDualEvidence(repository, { sourceKind: "application" });

  const applicationOutcome = repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-dual-repo",
    personId: "self-person",
    scope: "persistent",
    actor: "user",
  });
  assert.deepEqual(applicationOutcome, {
    profileSampleAdded: false,
    profileSampleReason: "insufficient_quality",
  });
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM voice_profile_samples").get().count,
    0
  );

  saveDualEvidence(repository, {
    sourceKind: "system_mix",
    attributionState: "mixed_unknown",
    overlapDetected: true,
  });
  const mixedOutcome = repository.confirmSpeakerLinkWithOutcome({
    clusterId: "cluster-dual-repo",
    personId: "self-person",
    scope: "persistent",
    actor: "user",
  });
  assert.deepEqual(mixedOutcome, {
    profileSampleAdded: false,
    profileSampleReason: "insufficient_quality",
  });
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM voice_profile_samples").get().count,
    0
  );
});

test("dual resolver model scores are committed atomically with the resolution", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  seed(repository);
  repository.renamePerson({ personId: "person-dual", displayName: "人物 3" });
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);

  const [resolution] = repository.applySystemSpeakerResolutions({
    id: "resolution-run-dual",
    sessionId: "session-dual-repo",
    diarizationRevision: "d".repeat(64),
    profileRevision: "e".repeat(64),
    policyId: "jarvis-speaker-identity-resolution-v1",
    evidenceRunIds: ["run-dual-repo"],
    results: [
      {
        evidenceRunId: "run-dual-repo",
        clusterId: "cluster-dual-repo",
        candidatePersonId: "person-dual",
        state: "suggested",
        score: 0.88,
        margin: 0.09,
        reason: "evaluation_missing",
        models: {
          primary: {
            modelId: primary.modelId,
            artifactVersion: primary.artifactVersion,
            embeddingSpace: primary.embeddingSpace,
            similarity: 0.91,
            margin: 0.12,
            passed: true,
          },
          review: {
            modelId: review.modelId,
            artifactVersion: review.artifactVersion,
            embeddingSpace: review.embeddingSpace,
            similarity: 0.88,
            margin: 0.09,
            passed: true,
          },
        },
      },
    ],
    at: 21_000,
  });

  assert.equal(resolution.state, "suggested");
  assert.deepEqual(
    repository.listSpeakerResolutionModelEvidence(resolution.id),
    [
      {
        resolutionId: resolution.id,
        modelId: primary.modelId,
        artifactVersion: primary.artifactVersion,
        embeddingSpace: primary.embeddingSpace,
        similarity: 0.91,
        margin: 0.12,
        passed: true,
        createdAt: 21_000,
      },
      {
        resolutionId: resolution.id,
        modelId: review.modelId,
        artifactVersion: review.artifactVersion,
        embeddingSpace: review.embeddingSpace,
        similarity: 0.88,
        margin: 0.09,
        passed: true,
        createdAt: 21_000,
      },
    ].sort((left, right) => left.modelId.localeCompare(right.modelId))
  );
});
