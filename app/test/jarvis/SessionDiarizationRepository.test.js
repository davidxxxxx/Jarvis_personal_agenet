const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const VoiceEmbeddingCipher = require("../../src/jarvis/main/VoiceEmbeddingCipher");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("../../src/jarvis/main/SessionDiarizationPolicy");
const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");

function vector(index) {
  const value = new Float32Array(512);
  value[index] = 1;
  return value;
}

function encryptedVoiceCipher() {
  return new VoiceEmbeddingCipher({
    secretCrypto: {
      isAvailable: () => true,
      encrypt(value) {
        return Buffer.from(`sealed:${value}`, "utf8");
      },
      decrypt(value) {
        const text = Buffer.from(value).toString("utf8");
        if (!text.startsWith("sealed:")) throw new Error("invalid test ciphertext");
        return { value: text.slice("sealed:".length), needsReencrypt: false };
      },
    },
  });
}

function scaledVector(index, scale) {
  const value = vector(index);
  value[index] = scale;
  return value;
}

function nearVector(cosine) {
  const value = new Float32Array(512);
  value[0] = cosine;
  value[1] = Math.sqrt(1 - cosine * cosine);
  return value;
}

function seedFinalTrack(repo) {
  repo.db.exec(`
    INSERT INTO sessions (
      id, started_at, ended_at, status, created_at, finalized_at, processing_state
    ) VALUES ('session-cas', 1000, 5000, 'completed', 1000, 5000, 'processing');
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES ('track-cas', 'session-cas', 'mic', 24000, 1, 1000, 5000, 'ended');
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-cas', 'session-cas', 'track-cas', 'mic', 0, 'cas.wav',
      1000, 5000, 4000,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 20000,
      'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, created_at, completed_at
    ) VALUES (
      'job-cas', 'session-cas', 'track-cas', 'chunk-cas',
      'transcribe_chunk', 'completed', 30,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      1, 'whisper-v1', 1, 2000, 5100
    );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-cas', 'session-cas', 1000, 5000, 'mic', 'original', 0.9,
      1, 'track-cas', 'chunk-cas', 'mic', 'final', 1,
      'whisper-v1', 5100
    );
  `);
  return getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
}

function finalSpeakerPolicy(model = "whisper-v1") {
  return new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: model,
  });
}

function getFinalSnapshot(repo, input) {
  return repo["getDiarizationEvidenceSnapshot"]({
    ...input,
    speakerProcessingPolicy: input.speakerProcessingPolicy ?? finalSpeakerPolicy(),
  });
}

function enqueueFinalDiarization(repo, sessionId, input) {
  return repo["enqueueDiarizationJobs"](sessionId, {
    ...input,
    speakerProcessingPolicy: input.speakerProcessingPolicy ?? finalSpeakerPolicy(),
  });
}

function saveLocalActivityClassification(repo, category, createdAt) {
  return repo.saveActivityClassificationBatch({
    sessionId: "session-cas",
    activities: [
      {
        activityId: "activity-session-cas",
        startedAt: 1_000,
        endedAt: 5_000,
        applications: [],
        sourceAttribution: "microphone",
        statistics: {
          microphoneParticipated: true,
          selfDetected: false,
          speakerCount: 1,
        },
      },
    ],
    classifications: [
      {
        activityId: "activity-session-cas",
        category,
        confidence: 0.91,
        decision: "adopted",
        source: "local",
        reason: "test_local_classification",
        allowSummary: true,
        allowSuggestions: true,
        allowTodos: false,
        evidenceSegmentIds: ["segment-cas"],
      },
    ],
    createdAt,
  });
}

test("repository exposes raw speaker evidence before final-evidence policy filtering", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db
    .prepare(
      "UPDATE audio_chunks SET write_state = 'writing', deleted_at = 5500, expires_at = 5600, path = 'tombstone:deleted' WHERE id = 'chunk-cas'"
    )
    .run();
  repo.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, attempt_count, created_at
      ) VALUES (
        'job-cas-newer', 'session-cas', 'track-cas', 'chunk-cas',
        'transcribe_chunk', 'retry', 30, ?, 2, 'whisper-v2', 1, 5200
      )`
    )
    .run("b".repeat(64));

  const raw = repo.getDiarizationTrackEvidence({
    sessionId: "session-cas",
    trackId: "track-cas",
    observedAt: 6000,
  });

  assert.equal(raw.observedAt, 6000);
  assert.equal(raw.chunks.length, 1);
  assert.equal(raw.chunks[0].audioChunk.write_state, "writing");
  assert.equal(raw.chunks[0].audioChunk.deleted_at, 5500);
  assert.equal(raw.chunks[0].audioChunk.expires_at, 5600);
  assert.equal(raw.chunks[0].audioChunk.path, "tombstone:deleted");
  assert.equal(raw.chunks[0].latestTranscriptionJob.id, "job-cas-newer");
  assert.deepEqual(
    raw.chunks[0].transcriptSegments.map((segment) => segment.id),
    ["segment-cas"]
  );
});

test("historical v1 sessions enqueue v2 locally without overwriting legacy evidence", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.db
    .prepare(
      `
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'legacy-run', 'session-cas', 'track-cas', ?, ?,
      'legacy-diarizer', '3dspeaker-campplus-voxceleb-16k-v1', ?,
      512, 16000, 1, 'cpu', 1, 5000, 5100
    )
  `
    )
    .run(snapshot.evidenceRevision, SESSION_DIARIZATION_POLICY.policyId, "f".repeat(64));
  repo.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 5200 WHERE id = 'session-cas'"
    )
    .run();

  assert.deepEqual(
    repo
      .listHistoricalHybridCandidates({
        at: 6000,
        policy: HYBRID_DIARIZATION_POLICY,
        limit: 25,
      })
      .map((session) => session.id),
    ["session-cas"]
  );
  const queued = repo.enqueueHistoricalHybridReprocessing("session-cas", {
    at: 6000,
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  assert.equal(queued.enqueued, 1);
  assert.equal(repo.isHistoricalLocalOnlyReprocessing("session-cas"), true);
  assert.equal(repo.getSession("session-cas").processing_state, "processing");
  assert.equal(
    repo.db.prepare("SELECT count(*) AS count FROM speaker_diarization_runs").get().count,
    1
  );
  const hybridJob = repo.db
    .prepare(
      `
    SELECT input_version, model_version, state
    FROM processing_jobs
    WHERE job_type = 'diarize_track' AND model_version = ?
  `
    )
    .get(HYBRID_DIARIZATION_POLICY.policyId);
  assert.deepEqual(hybridJob, {
    input_version: 2,
    model_version: HYBRID_DIARIZATION_POLICY.policyId,
    state: "pending",
  });
});

test("completed v3 runs are eligible for reprocessing after the clustering policy bump", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.db
    .prepare(
      `
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'bad-v3-run', 'session-cas', 'track-cas', ?, 'jarvis-hybrid-diarization-v3',
      'pyannote-community-1', '3dspeaker-campplus-voxceleb-16k-v1', ?,
      512, 16000, 2, 'cuda', 1, 5000, 5100
    )
  `
    )
    .run(snapshot.evidenceRevision, "f".repeat(64));
  repo.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 5200 WHERE id = 'session-cas'"
    )
    .run();

  assert.deepEqual(
    repo
      .listHistoricalHybridCandidates({
        at: 6000,
        policy: HYBRID_DIARIZATION_POLICY,
        limit: 25,
      })
      .map((session) => session.id),
    ["session-cas"]
  );
  const queued = repo.enqueueHistoricalHybridReprocessing("session-cas", {
    at: 6000,
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  assert.equal(queued.enqueued, 1);
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT state, input_version, model_version
         FROM processing_jobs
         WHERE job_type = 'diarize_track' AND model_version = ?`
      )
      .get(HYBRID_DIARIZATION_POLICY.policyId),
    {
      state: "pending",
      input_version: 2,
      model_version: HYBRID_DIARIZATION_POLICY.policyId,
    }
  );
});

test("historical sessions without legacy speaker results are also eligible for local v2 analysis", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 5200 WHERE id = 'session-cas'"
    )
    .run();

  assert.deepEqual(
    repo
      .listHistoricalHybridCandidates({
        at: 6000,
        policy: HYBRID_DIARIZATION_POLICY,
        limit: 25,
      })
      .map((session) => session.id),
    ["session-cas"]
  );

  const queued = repo.enqueueHistoricalHybridReprocessing("session-cas", {
    at: 6000,
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  assert.equal(queued.enqueued, 1);
  assert.equal(repo.isHistoricalLocalOnlyReprocessing("session-cas"), true);
  assert.equal(
    repo.db.prepare("SELECT count(*) AS count FROM processing_jobs WHERE lane = 'cloud'").get()
      .count,
    0
  );
});

test("zero-enqueue historical work stays active and ready sessions remain discoverable", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db
    .prepare("UPDATE sessions SET processing_state = 'ready', ready_at = 5200 WHERE id = ?")
    .run("session-cas");

  const first = repo.enqueueHistoricalHybridReprocessing("session-cas", {
    at: 6_000,
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  assert.equal(first.enqueued, 1);
  repo.db.exec(`
    UPDATE processing_jobs
    SET state = 'completed', completed_at = 6100
    WHERE job_type = 'diarize_track';
    UPDATE sessions
    SET processing_state = 'ready', ready_at = 6100
    WHERE id = 'session-cas';
  `);

  const second = repo.enqueueHistoricalHybridReprocessing("session-cas", {
    at: 6_200,
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  assert.equal(second.enqueued, 0);
  const state = repo.db
    .prepare("SELECT * FROM session_reprocessing_state WHERE session_id = ?")
    .get("session-cas");
  assert.equal(state.state, "queued");
  for (const column of [
    "baseline_content_sha256",
    "baseline_identity_sha256",
    "baseline_classification_sha256",
  ]) {
    assert.match(state[column], /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(
    repo.listProcessingSessions().map((session) => session.id),
    ["session-cas"]
  );
});

test("atomic local finalize preserves summaries and recommends only semantic changes", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(snapshot, "semantic_baseline"));
  repo.db.exec(`
    INSERT INTO analysis_runs (
      id, session_id, kind, window_start, window_end, input_hash,
      model, status, attempt_count, created_at, completed_at
    ) VALUES (
      'analysis-semantic', 'session-cas', 'final', 1000, 5000, 'semantic-summary-input',
      'MiniMax-M2.7', 'completed', 1, 6000, 6000
    );
    INSERT INTO session_summaries (
      session_id, summary, decisions_json, suggestions_json,
      analysis_run_id, updated_at, is_final
    ) VALUES (
      'session-cas', 'keep this paid summary', '[]', '[]',
      'analysis-semantic', 6000, 1
    );
    UPDATE sessions SET processing_state = 'ready', ready_at = 6000
    WHERE id = 'session-cas';
  `);
  const requeue = (at) => {
    repo.enqueueHistoricalHybridReprocessing("session-cas", {
      at,
      policy: HYBRID_DIARIZATION_POLICY,
      speakerProcessingPolicy: finalSpeakerPolicy(),
    });
    repo.startHistoricalLocalOnlyReprocessing("session-cas", at + 1);
  };
  const refreshState = () =>
    repo.db
      .prepare("SELECT recommended, reason FROM session_summary_refresh_state WHERE session_id = ?")
      .get("session-cas");

  requeue(6_100);
  repo.db
    .prepare(
      "UPDATE speaker_clusters SET match_score = 0.01, quality_score = 0.02, updated_at = 6110"
    )
    .run();
  repo.finalizeHistoricalLocalOnlyReprocessing("session-cas", 6_120);
  assert.deepEqual(refreshState(), { recommended: 0, reason: null });

  requeue(6_200);
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('semantic-person', 'Semantic Person', 0, 6200, 6200);
    UPDATE speaker_clusters
    SET person_id = 'semantic-person', link_state = 'confirmed', updated_at = 6210;
  `);
  repo.finalizeHistoricalLocalOnlyReprocessing("session-cas", 6_220);
  assert.deepEqual(refreshState(), { recommended: 1, reason: "speaker_identity_changed" });

  saveLocalActivityClassification(repo, "work_meeting", 6_300);
  requeue(6_310);
  saveLocalActivityClassification(repo, "social_call", 6_320);
  repo.finalizeHistoricalLocalOnlyReprocessing("session-cas", 6_330);
  assert.deepEqual(refreshState(), {
    recommended: 1,
    reason: "activity_classification_changed",
  });

  requeue(6_400);
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("semantic transcript changed", "segment-cas");
  repo.db.prepare("UPDATE speaker_clusters SET person_id = NULL, link_state = 'unknown'").run();
  saveLocalActivityClassification(repo, "entertainment", 6_410);
  repo.finalizeHistoricalLocalOnlyReprocessing("session-cas", 6_420);
  assert.deepEqual(refreshState(), { recommended: 1, reason: "transcript_changed" });
  assert.equal(
    repo.db.prepare("SELECT summary FROM session_summaries WHERE session_id = ?").get("session-cas")
      .summary,
    "keep this paid summary"
  );
  assert.equal(
    repo.db.prepare("SELECT count(*) AS count FROM processing_jobs WHERE lane = 'cloud'").get()
      .count,
    0
  );
});

test("v2 speaker-count changes preserve the old summary and only recommend a refresh", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(snapshot, "summary_v1"));
  repo.db.exec(`
    INSERT INTO analysis_runs (
      id, session_id, kind, window_start, window_end, input_hash,
      model, status, attempt_count, created_at, completed_at
    ) VALUES (
      'analysis-old', 'session-cas', 'final', 1000, 5000, 'old-summary-input',
      'MiniMax-M2.7', 'completed', 1, 6000, 6000
    );
    INSERT INTO session_summaries (
      session_id, summary, decisions_json, suggestions_json,
      analysis_run_id, updated_at, is_final
    ) VALUES (
      'session-cas', 'keep this paid summary', '[]', '[]',
      'analysis-old', 6000, 1
    );
  `);
  const hybrid = commitInput(snapshot, "summary_v2");
  hybrid.run = {
    ...hybrid.run,
    id: "diarization_run_summary_v2",
    policyId: HYBRID_DIARIZATION_POLICY.policyId,
    diarizerModelId: HYBRID_DIARIZATION_POLICY.diarizerModelId,
    inputVersion: 2,
    executionDevice: "cuda",
    pipelineMetadata: { schemaVersion: 1 },
    speakerCount: { minimum: 2, maximum: 2, confidence: 0.94 },
    overlapMs: 0,
    overlapSeparationState: "not_needed",
    modelPackVersion: HYBRID_DIARIZATION_POLICY.modelPackVersion,
    completedAt: 6100,
  };
  hybrid.validatedAt = 6100;
  const secondCluster = {
    id: "speaker_cluster_session_cas_2",
    localLabel: "speaker_2",
    embedding: vector(1),
    speechMs: 1600,
    windowCount: 1,
    qualityScore: 0.98,
    firstAppearanceAt: 2900,
  };
  hybrid.clusters[0] = { ...hybrid.clusters[0], speechMs: 1600, windowCount: 1 };
  hybrid.clusters.push(secondCluster);
  hybrid.turns[1] = {
    ...hybrid.turns[1],
    clusterId: secondCluster.id,
    localLabel: secondCluster.localLabel,
    rawLabel: "raw_b",
    embedding: vector(1),
  };
  hybrid.segmentLinks.push({
    clusterId: secondCluster.id,
    transcriptSegmentId: "segment-cas",
  });

  assert.equal(repo.commitDiarizationRun(hybrid).status, "completed");
  assert.equal(
    repo.db.prepare("SELECT summary FROM session_summaries WHERE session_id = 'session-cas'").get()
      .summary,
    "keep this paid summary"
  );
  assert.deepEqual(
    repo.db
      .prepare(
        `
      SELECT recommended, reason, basis_policy_id, latest_policy_id
      FROM session_summary_refresh_state WHERE session_id = 'session-cas'
    `
      )
      .get(),
    {
      recommended: 1,
      reason: "speaker_count_changed",
      basis_policy_id: SESSION_DIARIZATION_POLICY.policyId,
      latest_policy_id: HYBRID_DIARIZATION_POLICY.policyId,
    }
  );
  assert.equal(
    repo.db.prepare("SELECT count(*) AS count FROM processing_jobs WHERE lane = 'cloud'").get()
      .count,
    0
  );
});

test("repository delegates raw evidence to the configured speaker processing policy", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);

  const eligible = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
  const wrongModel = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
    speakerProcessingPolicy: finalSpeakerPolicy("whisper-other"),
  });

  assert.equal(eligible.eligible, true);
  assert.match(eligible.stableAudioRevision, /^[0-9a-f]{64}$/);
  assert.match(eligible.transcriptRevision, /^[0-9a-f]{64}$/);
  assert.match(eligible.evidenceRevision, /^[0-9a-f]{64}$/);
  assert.equal(wrongModel.eligible, false);
  assert.equal(wrongModel.reason, "final_transcript_model_mismatch");
  assert.match(wrongModel.stableAudioRevision, /^[0-9a-f]{64}$/);
  assert.equal(wrongModel.evidenceRevision, null);
});

function commitInput(snapshot, suffix = "one") {
  const clusterId = "speaker_cluster_session_cas_1";
  return {
    expectedRevision: snapshot.evidenceRevision,
    speakerProcessingPolicy: finalSpeakerPolicy(),
    validatedAt: 6000,
    run: {
      id: `diarization_run_${suffix}`,
      sessionId: "session-cas",
      trackId: "track-cas",
      evidenceRevision: snapshot.evidenceRevision,
      policyId: "jarvis-session-diarization-v1",
      diarizerModelId: "sherpa-segmentation+3dspeaker-campplus",
      embeddingModelId: "3dspeaker-campplus-voxceleb-16k-v1",
      modelArtifactSha256: "f".repeat(64),
      embeddingDimension: 512,
      sampleRate: 16000,
      inputVersion: 1,
      executionDevice: "cpu",
      createdAt: 6000,
      completedAt: 6000,
    },
    clusters: [
      {
        id: clusterId,
        localLabel: "speaker_1",
        embedding: vector(0),
        speechMs: 3200,
        windowCount: 2,
        qualityScore: 0.99,
        firstAppearanceAt: 1100,
      },
    ],
    turns: [
      {
        id: `speaker_turn_${suffix}_1`,
        chunkId: "chunk-cas",
        transcriptSegmentId: "segment-cas",
        turnIndex: 0,
        rawLabel: "raw_a",
        localLabel: "speaker_1",
        clusterId,
        startedAt: 1100,
        endedAt: 2700,
        embedding: vector(0),
        echoState: "none",
        duplicateOfTurnId: null,
        excludedFromCentroid: false,
      },
      {
        id: `speaker_turn_${suffix}_2`,
        chunkId: "chunk-cas",
        transcriptSegmentId: "segment-cas",
        turnIndex: 1,
        rawLabel: "raw_a",
        localLabel: "speaker_1",
        clusterId,
        startedAt: 2900,
        endedAt: 4500,
        embedding: vector(0),
        echoState: "none",
        duplicateOfTurnId: null,
        excludedFromCentroid: false,
      },
    ],
    segmentLinks: [{ clusterId, transcriptSegmentId: "segment-cas" }],
  };
}

function revisedCommitInput(repo, suffix, clusters) {
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run(`revision ${suffix}`, "segment-cas");
  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const input = commitInput(snapshot, suffix);
  input.validatedAt = 6001;
  input.run.createdAt = 6001;
  input.run.completedAt = 6001;
  input.clusters = clusters;
  input.turns = clusters.map((cluster, index) => ({
    ...input.turns[index],
    id: `speaker_turn_${suffix}_${index}`,
    clusterId: cluster.id,
    localLabel: cluster.localLabel,
  }));
  input.segmentLinks = clusters.map((cluster) => ({
    clusterId: cluster.id,
    transcriptSegmentId: "segment-cas",
  }));
  return input;
}

function hybridCommitInput(snapshot, suffix) {
  const input = commitInput(snapshot, suffix);
  input.run = {
    ...input.run,
    policyId: HYBRID_DIARIZATION_POLICY.policyId,
    diarizerModelId: HYBRID_DIARIZATION_POLICY.diarizerModelId,
    inputVersion: 2,
    executionDevice: "cuda",
    pipelineMetadata: { schemaVersion: 1 },
    speakerCount: { minimum: 2, maximum: 2, confidence: 0.94 },
    overlapMs: 0,
    overlapSeparationState: "not_needed",
    modelPackVersion: HYBRID_DIARIZATION_POLICY.modelPackVersion,
  };
  return input;
}

test("v4 preserves voiced audit fragments outside the validated speaker count", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const input = hybridCommitInput(snapshot, "kook_audit_fragment");
  input.clusters = [
    {
      ...input.clusters[0],
      identityEligible: true,
      qualityGateReason: null,
    },
    {
      id: "speaker_cluster_kook_2",
      localLabel: "speaker_2",
      embedding: vector(1),
      speechMs: 6_000,
      windowCount: 3,
      qualityScore: 0.98,
      identityEligible: true,
      qualityGateReason: null,
      firstAppearanceAt: 2_900,
    },
    {
      id: "speaker_cluster_kook_audit_fragment",
      localLabel: "speaker_3",
      embedding: vector(2),
      speechMs: 800,
      windowCount: 1,
      qualityScore: 0.99,
      identityEligible: false,
      qualityGateReason: "insufficient_speech",
      firstAppearanceAt: 4_000,
    },
  ];

  assert.equal(repo.commitDiarizationRun(input).status, "completed");
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT local_label, identity_eligible, quality_gate_reason
         FROM speaker_diarization_run_clusters
         WHERE run_id = ?
         ORDER BY local_label`
      )
      .all(input.run.id),
    [
      { local_label: "speaker_1", identity_eligible: 1, quality_gate_reason: null },
      { local_label: "speaker_2", identity_eligible: 1, quality_gate_reason: null },
      {
        local_label: "speaker_3",
        identity_eligible: 0,
        quality_gate_reason: "insufficient_speech",
      },
    ]
  );
});

test("v4 rejects identity-eligible clusters beyond the validated speaker count", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const input = hybridCommitInput(snapshot, "kook_invalid_speaker_count");
  input.clusters.push(
    {
      id: "speaker_cluster_kook_2",
      localLabel: "speaker_2",
      embedding: vector(1),
      speechMs: 6_000,
      windowCount: 3,
      qualityScore: 0.98,
      identityEligible: true,
      qualityGateReason: null,
      firstAppearanceAt: 2_900,
    },
    {
      id: "speaker_cluster_kook_3",
      localLabel: "speaker_3",
      embedding: vector(2),
      speechMs: 6_000,
      windowCount: 3,
      qualityScore: 0.97,
      identityEligible: true,
      qualityGateReason: null,
      firstAppearanceAt: 4_000,
    }
  );

  assert.throws(
    () => repo.commitDiarizationRun(input),
    /diarization cluster count exceeds the validated speaker count/
  );
});

test("word timestamps project one transcript into overlapping per-speaker utterances", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const insertWord = repo.db.prepare(`
    INSERT INTO transcript_words (
      id, transcript_segment_id, chunk_id, ordinal, word,
      started_at, ended_at, probability, created_at
    ) VALUES (?, 'segment-cas', 'chunk-cas', ?, ?, ?, ?, ?, 5500)
  `);
  insertWord.run("word-1", 0, "你", 1200, 1380, 0.98);
  insertWord.run("word-2", 1, "好", 1600, 1780, 0.94);
  insertWord.run("word-3", 2, " okay", 2100, 2450, 0.86);

  const input = commitInput(snapshot, "word_projection");
  const secondCluster = {
    id: "speaker_cluster_session_cas_2",
    localLabel: "speaker_2",
    embedding: vector(1),
    speechMs: 1200,
    windowCount: 1,
    qualityScore: 0.96,
    firstAppearanceAt: 1400,
  };
  input.clusters.push(secondCluster);
  input.turns = [
    { ...input.turns[0], startedAt: 1100, endedAt: 2700 },
    {
      ...input.turns[1],
      id: "speaker_turn_word_projection_overlap",
      clusterId: secondCluster.id,
      localLabel: secondCluster.localLabel,
      rawLabel: "raw_b",
      startedAt: 1400,
      endedAt: 2500,
      embedding: vector(1),
    },
  ];
  input.segmentLinks.push({
    clusterId: secondCluster.id,
    transcriptSegmentId: "segment-cas",
  });
  input.cannotLinks = [
    {
      leftClusterId: input.clusters[0].id,
      rightClusterId: secondCluster.id,
      reason: "simultaneous_turns",
    },
  ];

  assert.equal(repo.commitDiarizationRun(input).status, "completed");
  const detail = repo.getSessionDetail("session-cas");
  assert.deepEqual(
    detail.speakerUtterances.map((utterance) => ({
      localLabel: utterance.local_label,
      text: utterance.text,
      overlapState: utterance.overlap_state,
      evidenceKind: utterance.evidence_kind,
    })),
    [
      {
        localLabel: "speaker_1",
        text: "你好 okay",
        overlapState: "overlap",
        evidenceKind: "word_alignment",
      },
      {
        localLabel: "speaker_2",
        text: "好 okay",
        overlapState: "overlap",
        evidenceKind: "word_alignment",
      },
    ]
  );
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT reason FROM speaker_cluster_cannot_links
         WHERE run_id = 'diarization_run_word_projection'`
      )
      .all(),
    [{ reason: "simultaneous_turns" }]
  );
});

function rebuildAsLegacyV20DiarizationSchema(
  db,
  { hasCommitSequence = false, hasRunLinks = false, allowDuplicateCommitSequence = false } = {}
) {
  const existingRunLinks = hasRunLinks
    ? db
        .prepare(
          `SELECT run_id, cluster_id, transcript_segment_id
           FROM speaker_diarization_run_cluster_segments
           ORDER BY run_id, cluster_id, transcript_segment_id`
        )
        .all()
    : [];
  const commitSequenceDefinition = hasCommitSequence
    ? `commit_sequence INTEGER NOT NULL ${allowDuplicateCommitSequence ? "" : "UNIQUE"}
       CHECK(commit_sequence > 0),`
    : "";
  const commitSequenceColumn = hasCommitSequence ? ", commit_sequence" : "";
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS speaker_utterance_words;
    DROP TABLE IF EXISTS speaker_utterances;
    DROP TABLE IF EXISTS overlap_stem_evidence;
    DROP TABLE IF EXISTS speaker_cluster_cannot_links;
    DROP TABLE IF EXISTS transcript_words;
    DROP TABLE IF EXISTS application_audio_fallback_evidence;
    DROP TABLE IF EXISTS logical_audio_track_members;
    DROP TABLE IF EXISTS logical_audio_tracks;
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_insert;
    DROP TRIGGER IF EXISTS validate_identity_resolution_evidence_session_update;
    DROP TABLE IF EXISTS speaker_identity_resolutions;
    DROP TABLE IF EXISTS speaker_identity_resolution_runs;
    DROP INDEX IF EXISTS idx_diarization_run_revision;
    DROP INDEX IF EXISTS idx_diarization_runs_session_sequence;
    DROP INDEX IF EXISTS idx_diarization_run_clusters_cluster;
    DROP INDEX IF EXISTS idx_speaker_turns_run_time;
    DROP INDEX IF EXISTS idx_speaker_turns_segment;
    DROP INDEX IF EXISTS idx_diarization_run_cluster_segments_segment;
    DROP TABLE speaker_diarization_run_cluster_segments;
    ALTER TABLE speaker_turns RENAME TO speaker_turns_v21_fixture;
    ALTER TABLE speaker_diarization_run_clusters
      RENAME TO speaker_diarization_run_clusters_v21_fixture;
    ALTER TABLE speaker_diarization_runs RENAME TO speaker_diarization_runs_v21_fixture;

    CREATE TABLE speaker_diarization_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
      transcript_revision TEXT NOT NULL CHECK(
        length(transcript_revision) = 64 AND
        transcript_revision NOT GLOB '*[^0-9a-f]*'
      ),
      policy_id TEXT NOT NULL,
      diarizer_model_id TEXT NOT NULL,
      embedding_model_id TEXT NOT NULL,
      model_artifact_sha256 TEXT NOT NULL CHECK(
        length(model_artifact_sha256) = 64 AND
        model_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      embedding_dimension INTEGER NOT NULL CHECK(embedding_dimension = 512),
      sample_rate INTEGER NOT NULL CHECK(sample_rate = 16000),
      input_version INTEGER NOT NULL CHECK(input_version = 1),
      execution_device TEXT NOT NULL CHECK(execution_device = 'cpu'),
      ${commitSequenceDefinition}
      created_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL CHECK(completed_at >= created_at),
      UNIQUE(session_id, track_id, transcript_revision, policy_id)
    );
    CREATE TABLE speaker_diarization_run_clusters (
      run_id TEXT NOT NULL REFERENCES speaker_diarization_runs(id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
      local_label TEXT NOT NULL,
      embedding BLOB CHECK(
        embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
      ),
      speech_ms INTEGER NOT NULL CHECK(speech_ms >= 0),
      window_count INTEGER NOT NULL CHECK(window_count >= 0),
      quality_score REAL CHECK(
        quality_score IS NULL OR (
          typeof(quality_score) IN ('integer','real') AND quality_score BETWEEN 0 AND 1
        )
      ),
      first_appearance_at INTEGER NOT NULL,
      PRIMARY KEY(run_id, local_label),
      UNIQUE(run_id, cluster_id),
      CHECK(
        (window_count = 0 AND speech_ms = 0 AND embedding IS NULL AND quality_score IS NULL) OR
        (window_count > 0 AND embedding IS NOT NULL AND quality_score IS NOT NULL)
      )
    );
    CREATE TABLE speaker_turns (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES speaker_diarization_runs(id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
      transcript_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
      turn_index INTEGER NOT NULL CHECK(turn_index >= 0),
      raw_label TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL CHECK(ended_at > started_at),
      embedding BLOB CHECK(
        embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
      ),
      echo_state TEXT NOT NULL DEFAULT 'none'
        CHECK(echo_state IN ('none','possible','confirmed')),
      duplicate_of_turn_id TEXT REFERENCES speaker_turns(id) ON DELETE SET NULL,
      excluded_from_centroid INTEGER NOT NULL DEFAULT 0 CHECK(excluded_from_centroid IN (0,1)),
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, chunk_id, turn_index),
      CHECK(duplicate_of_turn_id IS NULL OR duplicate_of_turn_id <> id),
      CHECK(echo_state = 'confirmed' OR excluded_from_centroid = 0)
    );

    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device
      ${commitSequenceColumn}, created_at, completed_at
    )
    SELECT id, session_id, track_id, transcript_revision, policy_id,
           diarizer_model_id, embedding_model_id, model_artifact_sha256,
           embedding_dimension, sample_rate, input_version, execution_device
           ${commitSequenceColumn},
           created_at, completed_at
    FROM speaker_diarization_runs_v21_fixture;
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    )
    SELECT run_id, cluster_id, local_label, embedding, speech_ms,
           window_count, quality_score, first_appearance_at
    FROM speaker_diarization_run_clusters_v21_fixture;
    INSERT INTO speaker_turns
    SELECT * FROM speaker_turns_v21_fixture;

    DROP TABLE speaker_turns_v21_fixture;
    DROP TABLE speaker_diarization_run_clusters_v21_fixture;
    DROP TABLE speaker_diarization_runs_v21_fixture;
    CREATE UNIQUE INDEX idx_diarization_run_revision
      ON speaker_diarization_runs(session_id, track_id, transcript_revision, policy_id);
    CREATE INDEX idx_diarization_runs_session_completed
      ON speaker_diarization_runs(session_id, completed_at, id);
    CREATE INDEX idx_diarization_run_clusters_cluster
      ON speaker_diarization_run_clusters(cluster_id, run_id);
    CREATE INDEX idx_speaker_turns_run_time
      ON speaker_turns(run_id, started_at, ended_at, id);
    CREATE INDEX idx_speaker_turns_segment
      ON speaker_turns(transcript_segment_id, run_id);
    PRAGMA user_version = 20;
  `);
  if (hasRunLinks) {
    db.exec(`
      CREATE TABLE speaker_diarization_run_cluster_segments (
        run_id TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        transcript_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        PRIMARY KEY(run_id, cluster_id, transcript_segment_id),
        FOREIGN KEY(run_id, cluster_id)
          REFERENCES speaker_diarization_run_clusters(run_id, cluster_id) ON DELETE CASCADE
      );
    `);
    const insertRunLink = db.prepare(`
      INSERT INTO speaker_diarization_run_cluster_segments (
        run_id, cluster_id, transcript_segment_id
      ) VALUES (@run_id, @cluster_id, @transcript_segment_id)
    `);
    for (const runLink of existingRunLinks) insertRunLink.run(runLink);
  }
  db.pragma("foreign_keys = ON");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}

function createPartialV20Fixture(databasePath, options) {
  const repo = new JarvisRepository(databasePath);
  const firstSnapshot = seedFinalTrack(repo);
  const first = commitInput(firstSnapshot, "z_partial_history");
  first.run.createdAt = 6000;
  first.run.completedAt = 6000;
  repo.commitDiarizationRun(first);
  repo.db.exec(`
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-partial-first', 'session-cas', 1000, 5000, 'mic',
      'partial historical revision one', 0.9, 1, 'track-cas', 'chunk-cas',
      'mic', 'final', 1, 'whisper-partial-v0', 5000
    );
    UPDATE speaker_turns
    SET transcript_segment_id = 'segment-partial-first'
    WHERE run_id = 'diarization_run_z_partial_history';
    UPDATE speaker_diarization_run_cluster_segments
    SET transcript_segment_id = 'segment-partial-first'
    WHERE run_id = 'diarization_run_z_partial_history';
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('speaker_cluster_session_cas_1', 'segment-partial-first');
  `);
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("partial historical revision two", "segment-cas");
  const secondSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const second = commitInput(secondSnapshot, "a_partial_history");
  second.validatedAt = 6001;
  second.run.createdAt = 6000;
  second.run.completedAt = 6000;
  repo.commitDiarizationRun(second);
  repo.close();

  const db = new Database(databasePath);
  rebuildAsLegacyV20DiarizationSchema(db, options);
  return db;
}

test("atomic diarization commit is idempotent and preserves revision history", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const firstSnapshot = seedFinalTrack(repo);
  const firstInput = commitInput(firstSnapshot);

  assert.deepEqual(repo.commitDiarizationRun(firstInput), {
    status: "completed",
    runId: "diarization_run_one",
  });
  assert.deepEqual(repo.commitDiarizationRun(firstInput), {
    status: "already_completed",
    runId: "diarization_run_one",
  });
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM speaker_diarization_runs) AS runs,
          (SELECT count(*) FROM speaker_diarization_run_clusters) AS run_clusters,
          (SELECT count(*) FROM speaker_clusters) AS stable_clusters,
          (SELECT count(*) FROM speaker_turns) AS turns,
          (SELECT count(*) FROM speaker_cluster_segments) AS segment_links`
      )
      .get(),
    { runs: 1, run_clusters: 1, stable_clusters: 1, turns: 2, segment_links: 1 }
  );

  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("revised", "segment-cas");
  const revisedSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const revisedInput = commitInput(revisedSnapshot, "two");
  revisedInput.validatedAt = 6001;
  revisedInput.run.createdAt = 6001;
  revisedInput.run.completedAt = 6001;

  assert.deepEqual(repo.commitDiarizationRun(revisedInput), {
    status: "completed",
    runId: "diarization_run_two",
  });
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM speaker_diarization_runs) AS runs,
          (SELECT count(*) FROM speaker_diarization_run_clusters) AS run_clusters,
          (SELECT count(*) FROM speaker_clusters) AS stable_clusters,
          (SELECT count(*) FROM speaker_turns) AS turns`
      )
      .get(),
    { runs: 2, run_clusters: 2, stable_clusters: 1, turns: 4 }
  );
  assert.equal(repo.listDiarizationRuns("session-cas").length, 2);
});

test("diarization commits encrypt cluster and turn embeddings under the v35 envelope constraint", (t) => {
  const repo = new JarvisRepository(":memory:", { embeddingCipher: encryptedVoiceCipher() });
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);

  assert.equal(
    repo.commitDiarizationRun(commitInput(snapshot, "encrypted_v35")).status,
    "completed"
  );
  const blobs = repo.db
    .prepare(
      `SELECT embedding FROM speaker_clusters
       UNION ALL SELECT embedding FROM speaker_diarization_run_clusters
       UNION ALL SELECT embedding FROM speaker_turns`
    )
    .all();
  assert.equal(blobs.length, 4);
  assert.equal(
    blobs.every(
      ({ embedding }) =>
        Buffer.isBuffer(embedding) &&
        embedding.subarray(0, 4).equals(Buffer.from("JVE1")) &&
        embedding.length > 2048
    ),
    true
  );
  assert.equal(
    repo.speakerIdentityRepository.decodeStoredEmbedding(blobs[0].embedding, 512).length,
    512
  );
});

test("stale diarization CAS rolls back run clusters turns and links", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const input = commitInput(snapshot, "stale");
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("changed before commit", "segment-cas");

  assert.throws(() => repo.commitDiarizationRun(input), {
    code: "DIARIZATION_STALE_INPUT",
  });
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM speaker_diarization_runs) AS runs,
          (SELECT count(*) FROM speaker_diarization_run_clusters) AS run_clusters,
          (SELECT count(*) FROM speaker_clusters) AS stable_clusters,
          (SELECT count(*) FROM speaker_turns) AS turns,
          (SELECT count(*) FROM speaker_cluster_segments) AS segment_links`
      )
      .get(),
    { runs: 0, run_clusters: 0, stable_clusters: 0, turns: 0, segment_links: 0 }
  );
});

test("confirmed echo turns persist without double-counting a centroid window", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const input = commitInput(snapshot, "echo");
  input.clusters[0].speechMs = 0;
  input.clusters[0].windowCount = 0;
  input.clusters[0].qualityScore = null;
  input.clusters[0].embedding = null;
  input.turns = [
    {
      ...input.turns[0],
      echoState: "confirmed",
      excludedFromCentroid: true,
    },
  ];

  assert.deepEqual(repo.commitDiarizationRun(input), {
    status: "completed",
    runId: "diarization_run_echo",
  });
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT cluster.window_count, cluster.speech_ms,
                cluster.embedding IS NULL AS embedding_is_null,
                turn.echo_state, turn.excluded_from_centroid
         FROM speaker_diarization_run_clusters AS cluster
         JOIN speaker_turns AS turn ON turn.run_id = cluster.run_id`
      )
      .get(),
    {
      window_count: 0,
      speech_ms: 0,
      embedding_is_null: 1,
      echo_state: "confirmed",
      excluded_from_centroid: 1,
    }
  );
});

test("turn evidence cannot link a final segment from another authoritative chunk", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE audio_chunks
    SET ended_at = 3000, duration_ms = 2000
    WHERE id = 'chunk-cas';
    UPDATE transcript_segments SET ended_at = 3000 WHERE id = 'segment-cas';
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-other', 'session-cas', 'track-cas', 'mic', 1, 'other.wav',
      3000, 5000, 2000,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 20000,
      'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, created_at, completed_at
    ) VALUES (
      'job-other', 'session-cas', 'track-cas', 'chunk-other',
      'transcribe_chunk', 'completed', 30,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      1, 'whisper-v1', 1, 3000, 5100
    );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-other', 'session-cas', 3000, 5000, 'mic', 'other', 0.9,
      1, 'track-cas', 'chunk-other', 'mic', 'final', 1,
      'whisper-v1', 5100
    );
  `);
  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
  });
  const input = commitInput(snapshot, "cross_chunk");
  input.turns = [input.turns[0]];
  input.turns[0].transcriptSegmentId = "segment-other";

  assert.throws(() => repo.commitDiarizationRun(input), {
    code: "DIARIZATION_INVALID_COMMIT",
  });
  assert.equal(
    repo.db.prepare("SELECT count(*) count FROM speaker_diarization_runs").get().count,
    0
  );
});

test("final evidence enqueues one restart-safe exact diarization job identity", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const speakerProcessingPolicy = finalSpeakerPolicy();
  const expectedKey = buildDiarizationJobKey({
    sessionId: "session-cas",
    trackId: "track-cas",
    evidenceRevision: snapshot.evidenceRevision,
  });

  const first = enqueueFinalDiarization(repo, "session-cas", {
    at: 6000,
    policy: SESSION_DIARIZATION_POLICY,
    speakerProcessingPolicy,
  });
  const repeated = enqueueFinalDiarization(repo, "session-cas", {
    at: 6001,
    policy: SESSION_DIARIZATION_POLICY,
    speakerProcessingPolicy,
  });

  assert.equal(first.enqueued, 1);
  assert.equal(repeated.enqueued, 0);
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT job_type, state, priority, input_hash, input_version,
                model_version, session_id, track_id, chunk_id
         FROM processing_jobs WHERE job_type = 'diarize_track'`
      )
      .get(),
    {
      job_type: "diarize_track",
      state: "pending",
      priority: 18,
      input_hash: expectedKey,
      input_version: 1,
      model_version: "jarvis-session-diarization-v1",
      session_id: "session-cas",
      track_id: "track-cas",
      chunk_id: null,
    }
  );
});

test("exact application coverage suppresses redundant system-mix diarization", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE sessions SET ended_at = 121000, finalized_at = 121000 WHERE id = 'session-cas';
    UPDATE audio_tracks
    SET source_type = 'system', ended_at = 121000
    WHERE id = 'track-cas';
    UPDATE audio_chunks
    SET source_type = 'system', started_at = 1000, ended_at = 121000,
        duration_ms = 120000, expires_at = 300000
    WHERE id = 'chunk-cas';
    UPDATE transcript_segments
    SET source_type = 'system', started_at = 1000, ended_at = 121000
    WHERE id = 'segment-cas';
    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state,
      failure_code
    ) VALUES (
      'track-app', 'session-cas', 'system', 'tencent_meeting', '腾讯会议',
      1, 24000, 1, 1000, 121000, 'ended', NULL
    );
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-app', 'session-cas', 'track-app', 'system', 0, 'app.wav',
      1000, 121000, 120000,
      '${"c".repeat(64)}', 300000,
      'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, created_at, completed_at
    ) VALUES (
      'job-app-transcript', 'session-cas', 'track-app', 'chunk-app',
      'transcribe_chunk', 'completed', 30,
      '${"c".repeat(64)}', 1, 'whisper-v1', 1, 2000, 121100
    );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-app', 'session-cas', 1000, 121000, 'system', 'meeting', 0.9,
      1, 'track-app', 'chunk-app', 'system', 'final', 1, 'whisper-v1', 121100
    );
    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'stale-system-mix-diarization', 'session-cas', 'track-cas',
      'diarize_track', 'retry', 36,
      '${"d".repeat(64)}', 1, 'stale-diarizer', 121200
    );
  `);

  const result = enqueueFinalDiarization(repo, "session-cas", {
    at: 122000,
    policy: SESSION_DIARIZATION_POLICY,
  });

  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.skipped, [
    {
      trackId: "track-cas",
      reason: "covered_by_exact_application",
      coverage: 1,
    },
  ]);
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT track_id, state, priority, error_code
         FROM processing_jobs
         WHERE job_type = 'diarize_track'
         ORDER BY track_id, created_at`
      )
      .all(),
    [
      {
        track_id: "track-app",
        state: "pending",
        priority: 26,
        error_code: null,
      },
      {
        track_id: "track-cas",
        state: "superseded",
        priority: 28,
        error_code: "SYSTEM_MIX_COVERED_BY_EXACT_APPLICATION",
      },
    ]
  );
  assert.deepEqual(
    repo.getSpeakerIdentityResolutionSnapshot({
      sessionId: "session-cas",
      at: 122000,
      diarizationPolicy: SESSION_DIARIZATION_POLICY,
    }),
    {
      eligible: false,
      reason: "diarization_incomplete",
      dependencyState: "pending",
    }
  );
});

test("short application tracks do not fan out diarization jobs", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE audio_tracks
    SET source_type = 'system', application_key = 'chrome',
        application_display_name = 'Chrome', capture_generation = 1,
        ended_at = 60000
    WHERE id = 'track-cas';
    UPDATE audio_chunks
    SET source_type = 'system', ended_at = 60000, duration_ms = 59000,
        expires_at = 200000
    WHERE track_id = 'track-cas';
    UPDATE transcript_segments
    SET source_type = 'system', ended_at = 60000
    WHERE track_id = 'track-cas';
    UPDATE sessions SET ended_at = 70000 WHERE id = 'session-cas';
    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'stale-short-app-job', 'session-cas', 'track-cas', 'diarize_track', 'retry', 40,
      '${"d".repeat(64)}', 1, 'stale-diarizer', 5500
    );
  `);

  const result = enqueueFinalDiarization(repo, "session-cas", {
    at: 80000,
    policy: SESSION_DIARIZATION_POLICY,
  });

  assert.equal(result.enqueued, 0);
  assert.deepEqual(result.skipped, [{ trackId: "track-cas", reason: "speaker_audio_too_short" }]);
  assert.deepEqual(
    repo.db
      .prepare("SELECT state, error_code, completed_at FROM processing_jobs WHERE id = ?")
      .get("stale-short-app-job"),
    {
      state: "superseded",
      error_code: "SPEAKER_AUDIO_TOO_SHORT",
      completed_at: 80000,
    }
  );
});

test("fragmented application generations schedule one logical track with every generation", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE sessions SET ended_at = 181000, finalized_at = 181000 WHERE id = 'session-cas';
    UPDATE audio_tracks
    SET source_type = 'system', application_key = 'kook',
        application_display_name = 'KOOK', capture_generation = 1,
        ended_at = 121000
    WHERE id = 'track-cas';
    UPDATE audio_chunks
    SET source_type = 'system', started_at = 1000, ended_at = 121000,
        duration_ms = 120000, expires_at = 300000
    WHERE id = 'chunk-cas';
    UPDATE transcript_segments
    SET source_type = 'system', started_at = 1000, ended_at = 121000
    WHERE id = 'segment-cas';
    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'stale-shorter-app-diarization', 'session-cas', 'track-cas',
      'diarize_track', 'retry', 26,
      '${"d".repeat(64)}', 1, 'stale-diarizer', 121200
    );

    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state,
      failure_code
    ) VALUES (
      'track-app-long', 'session-cas', 'system', 'kook', 'KOOK',
      2, 24000, 1, 121000, 181000, 'ended', NULL
    );
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-app-long', 'session-cas', 'track-app-long', 'system', 0, 'app-long.wav',
      121000, 181000, 60000,
      '${"e".repeat(64)}', 300000,
      'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, created_at, completed_at
    ) VALUES (
      'job-app-long-transcript', 'session-cas', 'track-app-long', 'chunk-app-long',
      'transcribe_chunk', 'completed', 30,
      '${"e".repeat(64)}', 1, 'whisper-v1', 1, 2000, 181100
    );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-app-long', 'session-cas', 121000, 181000, 'system', 'call continued', 0.9,
      1, 'track-app-long', 'chunk-app-long', 'system', 'final', 1, 'whisper-v1', 181100
    );
  `);

  const result = enqueueFinalDiarization(repo, "session-cas", {
    at: 182000,
    policy: SESSION_DIARIZATION_POLICY,
  });

  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.skipped, [
    { trackId: "track-app-long", reason: "application_track_not_primary" },
  ]);
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT track_id, state, error_code
         FROM processing_jobs
         WHERE job_type = 'diarize_track'
         ORDER BY track_id, created_at`
      )
      .all(),
    [
      {
        track_id: "track-cas",
        state: "superseded",
        error_code: "DIARIZATION_EVIDENCE_SUPERSEDED",
      },
      {
        track_id: "track-cas",
        state: "pending",
        error_code: null,
      },
    ]
  );
  assert.deepEqual(
    repo
      .getDiarizationTrackEvidence({
        sessionId: "session-cas",
        trackId: "track-cas",
        observedAt: 182000,
      })
      .chunks.map((entry) => ({
        id: entry.audioChunk.id,
        physicalTrackId: entry.audioChunk.physical_track_id,
      })),
    [
      { id: "chunk-cas", physicalTrackId: "track-cas" },
      { id: "chunk-app-long", physicalTrackId: "track-app-long" },
    ]
  );
});

test("logical application generations expose only the newest run and utterances", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE audio_tracks
    SET source_type = 'system', application_key = 'kook',
        application_display_name = 'KOOK', capture_generation = 1
    WHERE id = 'track-cas';
    UPDATE audio_chunks SET source_type = 'system' WHERE id = 'chunk-cas';
    UPDATE transcript_segments SET source_type = 'system' WHERE id = 'segment-cas';
    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      capture_generation, sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-kook-generation-2', 'session-cas', 'system', 'kook', 'KOOK',
      2, 24000, 1, 5000, 9000, 'ended'
    );
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-kook-generation-2', 'session-cas', 'track-kook-generation-2',
      'system', 0, 'kook-2.wav', 5000, 9000, 4000,
      '${"e".repeat(64)}', 20000, 'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-kook-generation-2', 'session-cas', 5000, 9000,
      'system', 'old generation text', 0.9, 1,
      'track-kook-generation-2', 'chunk-kook-generation-2', 'system',
      'final', 1, 'whisper-v1', 9000
    );
  `);
  repo.refreshLogicalApplicationTracks("session-cas", 10_000);
  repo.db.exec(`
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state,
      created_at, updated_at, identity_eligible
    ) VALUES
      ('cluster-kook-old', 'session-cas', 'track-kook-generation-2', 'speaker_1',
       '3dspeaker-campplus-voxceleb-16k-v1', zeroblob(2048),
       6000, 3, 0.9, 'unknown', 9000, 9000, 1),
      ('cluster-kook-new', 'session-cas', 'track-cas', 'speaker_2',
       '3dspeaker-campplus-voxceleb-16k-v1', zeroblob(2048),
       6000, 3, 0.9, 'unknown', 10000, 10000, 1),
      ('cluster-kook-fragment', 'session-cas', 'track-cas', 'speaker_3',
       '3dspeaker-campplus-voxceleb-16k-v1', zeroblob(2048),
       6000, 3, 0.4, 'unknown', 10000, 10000, 0);
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES
      ('run-kook-old', 'session-cas', 'track-kook-generation-2', '${"1".repeat(64)}',
       'jarvis-hybrid-diarization-v3', 'old-diarizer',
       '3dspeaker-campplus-voxceleb-16k-v1', '${"f".repeat(64)}',
       512, 16000, 2, 'cuda', 1, 9000, 9000),
      ('run-kook-new', 'session-cas', 'track-cas', '${"2".repeat(64)}',
       'jarvis-hybrid-diarization-v4', 'new-diarizer',
       '3dspeaker-campplus-voxceleb-16k-v1', '${"a".repeat(64)}',
       512, 16000, 2, 'cuda', 2, 10000, 10000);
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at, identity_eligible
    ) VALUES
      ('run-kook-old', 'cluster-kook-old', 'speaker_1', zeroblob(2048),
       6000, 3, 0.9, 5100, 1),
      ('run-kook-new', 'cluster-kook-new', 'speaker_2', zeroblob(2048),
       6000, 3, 0.9, 1100, 1),
      ('run-kook-new', 'cluster-kook-fragment', 'speaker_3', zeroblob(2048),
       6000, 3, 0.4, 1900, 0);
    INSERT INTO speaker_utterances (
      id, session_id, run_id, chunk_id, cluster_id, source_segment_id,
      started_at, ended_at, text, confidence, overlap_state,
      evidence_kind, created_at
    ) VALUES
      ('utterance-kook-old', 'session-cas', 'run-kook-old',
       'chunk-kook-generation-2', 'cluster-kook-old', 'segment-kook-generation-2',
       5100, 5600, 'old utterance', 0.9, 'single', 'word_alignment', 9000),
      ('utterance-kook-new', 'session-cas', 'run-kook-new',
       'chunk-cas', 'cluster-kook-new', 'segment-cas',
       1200, 1800, 'new utterance', 0.9, 'single', 'word_alignment', 10000);
  `);

  const detail = repo.getSessionDetail("session-cas");
  assert.deepEqual(
    detail.speakerUtterances.map((utterance) => ({
      id: utterance.id,
      text: utterance.text,
      applicationKey: utterance.application_key,
    })),
    [{ id: "utterance-kook-new", text: "new utterance", applicationKey: "kook" }]
  );
  const processing = repo.getSessionSpeakerProcessing("session-cas");
  assert.deepEqual(processing.latestRuns.map((run) => run.id), ["run-kook-new"]);
  assert.deepEqual(processing.speakers.map((speaker) => speaker.id), ["cluster-kook-new"]);
  assert.equal(processing.fragmentedEvidenceCount, 1);
});

test("virtual-audio infrastructure tracks never fan out diarization jobs", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    UPDATE audio_tracks
    SET source_type = 'system', application_key = 'audiodg',
        application_display_name = 'audiodg', capture_generation = 1,
        ended_at = 121000
    WHERE id = 'track-cas';
    UPDATE audio_chunks
    SET source_type = 'system', ended_at = 121000, duration_ms = 120000,
        expires_at = 300000
    WHERE track_id = 'track-cas';
    UPDATE transcript_segments
    SET source_type = 'system', ended_at = 121000
    WHERE track_id = 'track-cas';
    UPDATE sessions SET ended_at = 130000 WHERE id = 'session-cas';
  `);

  const result = enqueueFinalDiarization(repo, "session-cas", {
    at: 140000,
    policy: SESSION_DIARIZATION_POLICY,
  });

  assert.equal(result.enqueued, 0);
  assert.deepEqual(result.skipped, [
    { trackId: "track-cas", reason: "virtual_audio_infrastructure" },
  ]);
});

test("nonterminal latest transcription never schedules diarization", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, attempt_count, created_at
      ) VALUES (
        'job-newer-retry', 'session-cas', 'track-cas', 'chunk-cas',
        'transcribe_chunk', 'retry', 30,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        2, 'whisper-v2', 1, 5200
      )`
    )
    .run();

  assert.deepEqual(
    enqueueFinalDiarization(repo, "session-cas", {
      at: 6000,
      policy: SESSION_DIARIZATION_POLICY,
    }),
    {
      enqueued: 0,
      jobs: [],
      skipped: [{ trackId: "track-cas", reason: "final_transcript_pending" }],
    }
  );
  assert.equal(
    repo.db
      .prepare("SELECT count(*) count FROM processing_jobs WHERE job_type = 'diarize_track'")
      .get().count,
    0
  );
});

test("a terminal track with only explicit no-speech evidence schedules durable diarization", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.prepare("DELETE FROM transcript_segments WHERE chunk_id = 'chunk-cas'").run();
  repo.db
    .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-cas'")
    .run();

  const result = enqueueFinalDiarization(repo, "session-cas", {
    at: 6000,
    policy: SESSION_DIARIZATION_POLICY,
  });

  assert.equal(result.enqueued, 1);
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.jobs[0].state, "pending");
});

test("an empty no-speech run remains distinguishable and idempotent after restart", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.prepare("DELETE FROM transcript_segments WHERE chunk_id = 'chunk-cas'").run();
  repo.db
    .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-cas'")
    .run();
  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
  });
  const empty = commitInput(snapshot, "no_speech_empty");
  empty.clusters = [];
  empty.turns = [];
  empty.segmentLinks = [];

  assert.deepEqual(repo.commitDiarizationRun(empty), {
    status: "completed",
    runId: "diarization_run_no_speech_empty",
  });
  const reopened = repo.getDiarizationRun({
    sessionId: "session-cas",
    trackId: "track-cas",
    evidenceRevision: snapshot.evidenceRevision,
    policyId: SESSION_DIARIZATION_POLICY.policyId,
  });
  assert.equal(reopened.id, "diarization_run_no_speech_empty");
  assert.deepEqual(repo.commitDiarizationRun(empty), {
    status: "already_completed",
    runId: "diarization_run_no_speech_empty",
  });
});

test("revision history retains run-scoped segment links as well as the latest projection", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const firstSnapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(firstSnapshot, "history_one"));

  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("revised", "segment-cas");
  const secondSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const second = commitInput(secondSnapshot, "history_two");
  second.validatedAt = 6001;
  second.run.createdAt = 6001;
  second.run.completedAt = 6001;
  repo.commitDiarizationRun(second);

  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT run_id, cluster_id, transcript_segment_id
         FROM speaker_diarization_run_cluster_segments
         ORDER BY run_id, cluster_id, transcript_segment_id`
      )
      .all(),
    [
      {
        run_id: "diarization_run_history_one",
        cluster_id: "speaker_cluster_session_cas_1",
        transcript_segment_id: "segment-cas",
      },
      {
        run_id: "diarization_run_history_two",
        cluster_id: "speaker_cluster_session_cas_1",
        transcript_segment_id: "segment-cas",
      },
    ]
  );
  assert.equal(
    repo.db.prepare("SELECT count(*) count FROM speaker_cluster_segments").get().count,
    1
  );
});

test("v20 diarization history migrates transactionally to v21 and remains writable", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-v20-"));
  const databasePath = path.join(directory, "jarvis.db");
  let repo = null;
  let db = null;
  t.after(() => {
    repo?.close();
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  repo = new JarvisRepository(databasePath);
  const firstSnapshot = seedFinalTrack(repo);
  const first = commitInput(firstSnapshot, "z_history");
  first.run.createdAt = 6000;
  first.run.completedAt = 6000;
  repo.commitDiarizationRun(first);
  repo.db.exec(`
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-history-first', 'session-cas', 1000, 5000, 'mic',
      'historical revision one', 0.9, 1, 'track-cas', 'chunk-cas',
      'mic', 'final', 1, 'whisper-history-v0', 5000
    );
    UPDATE speaker_turns
    SET transcript_segment_id = 'segment-history-first'
    WHERE run_id = 'diarization_run_z_history';
    UPDATE speaker_diarization_run_cluster_segments
    SET transcript_segment_id = 'segment-history-first'
    WHERE run_id = 'diarization_run_z_history';
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('speaker_cluster_session_cas_1', 'segment-history-first');
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-history', 'History', 0, 6000, 6000);
    UPDATE speaker_clusters
    SET person_id = 'person-history', link_state = 'confirmed'
    WHERE id = 'speaker_cluster_session_cas_1';
  `);
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("historical revision two", "segment-cas");
  const secondSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const second = commitInput(secondSnapshot, "a_history");
  second.validatedAt = 6001;
  second.run.createdAt = 6000;
  second.run.completedAt = 6000;
  repo.commitDiarizationRun(second);
  repo.close();
  repo = null;

  db = new Database(databasePath);
  rebuildAsLegacyV20DiarizationSchema(db);
  db.prepare(
    "UPDATE speaker_turns SET echo_state = 'confirmed', excluded_from_centroid = 0 WHERE id = ?"
  ).run("speaker_turn_z_history_1");
  assert.equal(db.pragma("user_version", { simple: true }), 20);
  assert.equal(
    db
      .prepare("PRAGMA table_info(speaker_diarization_runs)")
      .all()
      .some((row) => row.name === "commit_sequence"),
    false
  );
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_diarization_run_cluster_segments'"
      )
      .get(),
    undefined
  );
  assert.match(
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'speaker_turns'")
      .get().sql,
    /echo_state = 'confirmed' OR excluded_from_centroid = 0/
  );

  db.close();
  db = null;

  repo = new JarvisRepository(databasePath);
  assert.ok(TARGET_VERSION >= 22);
  assert.equal(repo.db.pragma("user_version", { simple: true }), TARGET_VERSION);
  assert.equal(repo.db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(repo.db.pragma("foreign_key_check"), []);
  assert.deepEqual(
    repo.db
      .prepare("SELECT id, commit_sequence FROM speaker_diarization_runs ORDER BY commit_sequence")
      .all(),
    [
      { id: "diarization_run_a_history", commit_sequence: 1 },
      { id: "diarization_run_z_history", commit_sequence: 2 },
    ]
  );
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT (SELECT count(*) FROM speaker_diarization_runs) AS runs,
                (SELECT count(*) FROM speaker_diarization_run_clusters) AS clusters,
                (SELECT count(*) FROM speaker_turns) AS turns,
                (SELECT count(*) FROM speaker_cluster_segments) AS old_links,
                (SELECT count(*) FROM speaker_diarization_run_cluster_segments) AS run_links`
      )
      .get(),
    { runs: 2, clusters: 2, turns: 4, old_links: 2, run_links: 2 }
  );
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT run_id, transcript_segment_id
         FROM speaker_diarization_run_cluster_segments
         ORDER BY run_id, transcript_segment_id`
      )
      .all(),
    [
      { run_id: "diarization_run_a_history", transcript_segment_id: "segment-cas" },
      {
        run_id: "diarization_run_z_history",
        transcript_segment_id: "segment-history-first",
      },
    ]
  );
  assert.deepEqual(
    repo.db
      .prepare("SELECT echo_state, excluded_from_centroid FROM speaker_turns WHERE id = ?")
      .get("speaker_turn_z_history_1"),
    { echo_state: "confirmed", excluded_from_centroid: 1 }
  );
  assert.deepEqual(
    repo.listDiarizationRuns("session-cas").map((run) => run.id),
    ["diarization_run_a_history", "diarization_run_z_history"]
  );
  assert.deepEqual(
    repo.db
      .prepare(
        "SELECT person_id, link_state FROM speaker_clusters WHERE id = 'speaker_cluster_session_cas_1'"
      )
      .get(),
    { person_id: "person-history", link_state: "confirmed" }
  );
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("post migration revision", "segment-cas");
  const thirdSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 7001,
  });
  const third = commitInput(thirdSnapshot, "post_migration");
  third.validatedAt = 7001;
  third.run.createdAt = 7001;
  third.run.completedAt = 7001;
  assert.deepEqual(repo.commitDiarizationRun(third), {
    status: "completed",
    runId: "diarization_run_post_migration",
  });
  assert.deepEqual(
    repo.listDiarizationRuns("session-cas").map((run) => run.commit_sequence),
    [1, 2, 3]
  );
});

test("partial v20 diarization schemas all migrate without losing provenance", async (t) => {
  const variants = [
    { name: "missing sequence and run links", hasCommitSequence: false, hasRunLinks: false },
    { name: "existing sequence without run links", hasCommitSequence: true, hasRunLinks: false },
    { name: "existing run links without sequence", hasCommitSequence: false, hasRunLinks: true },
  ];

  for (const variant of variants) {
    await t.test(variant.name, (subtest) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-partial-"));
      const databasePath = path.join(directory, "jarvis.db");
      let db = createPartialV20Fixture(databasePath, variant);
      let repo = null;
      subtest.after(() => {
        repo?.close();
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(
        db
          .prepare("PRAGMA table_info(speaker_diarization_runs)")
          .all()
          .some((row) => row.name === "commit_sequence"),
        variant.hasCommitSequence
      );
      assert.equal(
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_diarization_run_cluster_segments'"
            )
            .get()
        ),
        variant.hasRunLinks
      );
      db.close();
      db = null;

      repo = new JarvisRepository(databasePath);
      assert.equal(repo.db.pragma("user_version", { simple: true }), TARGET_VERSION);
      assert.equal(repo.db.pragma("foreign_keys", { simple: true }), 1);
      assert.deepEqual(repo.db.pragma("foreign_key_check"), []);
      assert.deepEqual(
        repo.db
          .prepare(
            `SELECT run_id, transcript_segment_id
             FROM speaker_diarization_run_cluster_segments
             ORDER BY run_id, transcript_segment_id`
          )
          .all(),
        [
          {
            run_id: "diarization_run_a_partial_history",
            transcript_segment_id: "segment-cas",
          },
          {
            run_id: "diarization_run_z_partial_history",
            transcript_segment_id: "segment-partial-first",
          },
        ]
      );
      assert.equal(
        repo.db.prepare("SELECT count(*) AS count FROM speaker_cluster_segments").get().count,
        2
      );
      assert.deepEqual(
        repo.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v21'")
          .all(),
        []
      );

      repo.db
        .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
        .run(`post migration ${variant.name}`, "segment-cas");
      const snapshot = getFinalSnapshot(repo, {
        sessionId: "session-cas",
        trackId: "track-cas",
        at: 7001,
      });
      const suffix = variant.name.replaceAll(" ", "_");
      const third = commitInput(snapshot, suffix);
      third.validatedAt = 7001;
      third.run.createdAt = 7001;
      third.run.completedAt = 7001;
      assert.equal(repo.commitDiarizationRun(third).status, "completed");
      assert.deepEqual(
        repo.listDiarizationRuns("session-cas").map((run) => run.commit_sequence),
        [1, 2, 3]
      );
    });
  }
});

test("a failed partial v20 migration rolls back cleanly and can be retried", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-retry-"));
  const databasePath = path.join(directory, "jarvis.db");
  const db = createPartialV20Fixture(databasePath, {
    hasCommitSequence: true,
    hasRunLinks: false,
    allowDuplicateCommitSequence: true,
  });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  db.prepare("UPDATE speaker_diarization_runs SET commit_sequence = 1").run();

  assert.throws(() => applyJarvisMigrations(db), { code: "SQLITE_CONSTRAINT_UNIQUE" });
  assert.equal(db.pragma("user_version", { simple: true }), 20);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v21'").all(),
    []
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM speaker_diarization_runs").get().count, 2);

  db.exec(`
    UPDATE speaker_diarization_runs
    SET commit_sequence = CASE id
      WHEN 'diarization_run_z_partial_history' THEN 1
      ELSE 2
    END;
  `);
  assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 20, toVersion: TARGET_VERSION });
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v21'").all(),
    []
  );
});

test("stable identity reuse is invariant to embedding scale", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(snapshot, "scale_origin"));
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-scale', 'Scale', 0, 6000, 6000);
    UPDATE speaker_clusters
    SET person_id = 'person-scale', link_state = 'confirmed'
    WHERE id = 'speaker_cluster_session_cas_1';
  `);
  const scaled = revisedCommitInput(repo, "scale_revision", [
    {
      id: "incoming-scaled",
      localLabel: "speaker_scaled",
      embedding: scaledVector(0, 0.1),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 1100,
    },
  ]);

  repo.commitDiarizationRun(scaled);

  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT run_cluster.cluster_id, stable.person_id, stable.link_state
         FROM speaker_diarization_run_clusters AS run_cluster
         JOIN speaker_clusters AS stable ON stable.id = run_cluster.cluster_id
         WHERE run_cluster.run_id = 'diarization_run_scale_revision'`
      )
      .get(),
    {
      cluster_id: "speaker_cluster_session_cas_1",
      person_id: "person-scale",
      link_state: "confirmed",
    }
  );
});

test("incoming cosine ambiguity cannot inherit a confirmed identity", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(snapshot, "incoming_tie_origin"));
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-incoming-tie', 'Incoming Tie', 0, 6000, 6000);
    UPDATE speaker_clusters
    SET person_id = 'person-incoming-tie', link_state = 'confirmed'
    WHERE id = 'speaker_cluster_session_cas_1';
  `);
  repo.statements.insertDiarizationStableCluster.run({
    id: "stable-near-incoming",
    sessionId: "session-cas",
    trackId: "track-cas",
    localLabel: "speaker_near",
    modelId: "3dspeaker-campplus-voxceleb-16k-v1",
    embedding: Buffer.from(nearVector(0.99).buffer),
    speechMs: 1600,
    windowCount: 1,
    qualityScore: 1,
    identityEligible: 1,
    qualityGateReason: null,
    at: 6000,
  });
  const ambiguous = revisedCommitInput(repo, "incoming_tie_revision", [
    {
      id: "incoming-tie",
      localLabel: "speaker_tie",
      embedding: vector(0),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 1100,
    },
  ]);

  repo.commitDiarizationRun(ambiguous);

  const row = repo.db
    .prepare(
      `SELECT run_cluster.cluster_id, stable.person_id, stable.link_state
       FROM speaker_diarization_run_clusters AS run_cluster
       JOIN speaker_clusters AS stable ON stable.id = run_cluster.cluster_id
       WHERE run_cluster.run_id = 'diarization_run_incoming_tie_revision'`
    )
    .get();
  assert.notEqual(row.cluster_id, "speaker_cluster_session_cas_1");
  assert.notEqual(row.cluster_id, "stable-near-incoming");
  assert.deepEqual(
    { person_id: row.person_id, link_state: row.link_state },
    { person_id: null, link_state: "unknown" }
  );
});

test("stable reverse cosine ambiguity cannot pass a confirmed identity to either incoming", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(snapshot, "reverse_tie_origin"));
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-reverse-tie', 'Reverse Tie', 0, 6000, 6000);
    UPDATE speaker_clusters
    SET person_id = 'person-reverse-tie', link_state = 'confirmed'
    WHERE id = 'speaker_cluster_session_cas_1';
  `);
  const ambiguous = revisedCommitInput(repo, "reverse_tie_revision", [
    {
      id: "incoming-reverse-best",
      localLabel: "speaker_best",
      embedding: vector(0),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 1100,
    },
    {
      id: "incoming-reverse-near",
      localLabel: "speaker_near",
      embedding: nearVector(0.99),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 2900,
    },
  ]);

  repo.commitDiarizationRun(ambiguous);

  const rows = repo.db
    .prepare(
      `SELECT run_cluster.cluster_id, stable.person_id, stable.link_state
       FROM speaker_diarization_run_clusters AS run_cluster
       JOIN speaker_clusters AS stable ON stable.id = run_cluster.cluster_id
       WHERE run_cluster.run_id = 'diarization_run_reverse_tie_revision'
       ORDER BY run_cluster.local_label`
    )
    .all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.cluster_id !== "speaker_cluster_session_cas_1"));
  assert.ok(rows.every((row) => row.person_id === null && row.link_state === "unknown"));
});

test("cross-revision stable clusters reuse voice one-to-one instead of local labels", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const firstSnapshot = seedFinalTrack(repo);
  const first = commitInput(firstSnapshot, "bob_first");
  repo.commitDiarizationRun(first);
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-bob', 'Bob', 0, 6000, 6000);
    UPDATE speaker_clusters
    SET person_id = 'person-bob', link_state = 'confirmed'
    WHERE id = 'speaker_cluster_session_cas_1';
  `);
  const bobEmbeddingBefore = Buffer.from(
    repo.db
      .prepare("SELECT embedding FROM speaker_clusters WHERE id = ?")
      .get("speaker_cluster_session_cas_1").embedding
  );

  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("Alice then Bob", "segment-cas");
  const revisedSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const second = commitInput(revisedSnapshot, "alice_before_bob");
  second.validatedAt = 6001;
  second.run.createdAt = 6001;
  second.run.completedAt = 6001;
  second.clusters = [
    {
      id: "incoming-alice",
      localLabel: "speaker_1",
      embedding: vector(1),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 1100,
    },
    {
      id: "incoming-bob",
      localLabel: "speaker_2",
      embedding: vector(0),
      speechMs: 1600,
      windowCount: 1,
      qualityScore: 1,
      firstAppearanceAt: 2900,
    },
  ];
  second.turns = [
    {
      ...second.turns[0],
      id: "turn-alice",
      clusterId: "incoming-alice",
      localLabel: "speaker_1",
      startedAt: 1500,
      endedAt: 2700,
    },
    {
      ...second.turns[1],
      id: "turn-bob",
      clusterId: "incoming-bob",
      localLabel: "speaker_2",
    },
  ];
  second.segmentLinks = [
    { clusterId: "incoming-alice", transcriptSegmentId: "segment-cas" },
    { clusterId: "incoming-bob", transcriptSegmentId: "segment-cas" },
  ];

  repo.commitDiarizationRun(second);

  const mappings = repo.db
    .prepare(
      `SELECT run_cluster.local_label, run_cluster.cluster_id, stable.person_id,
              stable.link_state, stable.local_label AS stable_label
       FROM speaker_diarization_run_clusters AS run_cluster
       JOIN speaker_clusters AS stable ON stable.id = run_cluster.cluster_id
       WHERE run_cluster.run_id = 'diarization_run_alice_before_bob'
       ORDER BY run_cluster.local_label`
    )
    .all();
  assert.equal(mappings[0].local_label, "speaker_1");
  assert.notEqual(mappings[0].cluster_id, "speaker_cluster_session_cas_1");
  assert.equal(mappings[0].person_id, null);
  assert.equal(mappings[0].link_state, "unknown");
  assert.notEqual(mappings[0].stable_label, "speaker_1");
  assert.deepEqual(mappings[1], {
    local_label: "speaker_2",
    cluster_id: "speaker_cluster_session_cas_1",
    person_id: "person-bob",
    link_state: "confirmed",
    stable_label: "speaker_1",
  });
  assert.deepEqual(
    Buffer.from(
      repo.db
        .prepare("SELECT embedding FROM speaker_clusters WHERE id = ?")
        .get("speaker_cluster_session_cas_1").embedding
    ),
    bobEmbeddingBefore
  );
});

test("zero-window echo cluster never reuses an identified stable cluster by label", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const firstSnapshot = seedFinalTrack(repo);
  repo.commitDiarizationRun(commitInput(firstSnapshot, "identified"));
  repo.db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES ('person-known', 'Known', 0, 6000, 6000);
    UPDATE speaker_clusters SET person_id = 'person-known', link_state = 'confirmed';
  `);
  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("echo revision", "segment-cas");
  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const echo = commitInput(snapshot, "zero_echo");
  echo.validatedAt = 6001;
  echo.run.createdAt = 6001;
  echo.run.completedAt = 6001;
  echo.clusters[0].embedding = null;
  echo.clusters[0].speechMs = 0;
  echo.clusters[0].windowCount = 0;
  echo.clusters[0].qualityScore = null;
  echo.turns[0].echoState = "confirmed";
  echo.turns[0].excludedFromCentroid = true;
  echo.turns = [echo.turns[0]];

  repo.commitDiarizationRun(echo);

  const row = repo.db
    .prepare(
      `SELECT run_cluster.cluster_id, stable.person_id, stable.link_state
       FROM speaker_diarization_run_clusters AS run_cluster
       JOIN speaker_clusters AS stable ON stable.id = run_cluster.cluster_id
       WHERE run_cluster.run_id = 'diarization_run_zero_echo'`
    )
    .get();
  assert.notEqual(row.cluster_id, "speaker_cluster_session_cas_1");
  assert.deepEqual(
    { person_id: row.person_id, link_state: row.link_state },
    {
      person_id: null,
      link_state: "unknown",
    }
  );
});

test("echo exclusion is an exact invariant in repository validation and SQLite CHECKs", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const snapshot = seedFinalTrack(repo);
  const confirmedIncluded = commitInput(snapshot, "confirmed_included");
  confirmedIncluded.turns[0].echoState = "confirmed";
  confirmedIncluded.turns[0].excludedFromCentroid = false;
  assert.throws(() => repo.commitDiarizationRun(confirmedIncluded), /echo/i);

  const possibleExcluded = commitInput(snapshot, "possible_excluded");
  possibleExcluded.turns[0].echoState = "possible";
  possibleExcluded.turns[0].excludedFromCentroid = true;
  assert.throws(() => repo.commitDiarizationRun(possibleExcluded), /echo/i);

  repo.commitDiarizationRun(commitInput(snapshot, "schema_check"));
  const insert = repo.db.prepare(`
    INSERT INTO speaker_turns (
      id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
      raw_label, started_at, ended_at, embedding, echo_state,
      duplicate_of_turn_id, excluded_from_centroid, created_at
    ) VALUES (?, 'diarization_run_schema_check', 'speaker_cluster_session_cas_1',
      'chunk-cas', 'segment-cas', ?, 'raw', 1100, 2700, ?, ?, NULL, ?, 6000)
  `);
  const embedding = Buffer.alloc(2048);
  assert.throws(() => insert.run("bad-confirmed", 2, embedding, "confirmed", 0), {
    code: "SQLITE_CONSTRAINT_CHECK",
  });
  assert.throws(() => insert.run("bad-possible", 3, embedding, "possible", 1), {
    code: "SQLITE_CONSTRAINT_CHECK",
  });
});

test("commit sequence, not wall clock or run id, defines revision and echo latest order", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  const firstSnapshot = seedFinalTrack(repo);
  const first = commitInput(firstSnapshot, "z_clock_first");
  first.run.createdAt = 9000;
  first.run.completedAt = 9000;
  repo.commitDiarizationRun(first);

  repo.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("clock rollback", "segment-cas");
  const secondSnapshot = getFinalSnapshot(repo, {
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6001,
  });
  const second = commitInput(secondSnapshot, "a_clock_second");
  second.validatedAt = 6001;
  second.run.createdAt = 8000;
  second.run.completedAt = 8000;
  repo.commitDiarizationRun(second);

  assert.deepEqual(
    repo.listDiarizationRuns("session-cas").map((run) => ({
      id: run.id,
      sequence: run.commit_sequence,
    })),
    [
      { id: "diarization_run_z_clock_first", sequence: 1 },
      { id: "diarization_run_a_clock_second", sequence: 2 },
    ]
  );
});

test("echo candidates come only from the latest committed run sequence per track", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.exec(`
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES ('track-system', 'session-cas', 'system', 24000, 1, 1000, 5000, 'ended');
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (
      'chunk-system', 'session-cas', 'track-system', 'system', 0, 'system.wav',
      1000, 5000, 4000,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 20000,
      'completed', 'committed', 'wav', 24000, 1
    );
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'system-stable', 'session-cas', 'track-system', 'speaker_1',
      '3dspeaker-campplus-voxceleb-16k-v1', zeroblob(2048),
      1600, 1, 1, 'unknown', 6000, 6000
    );
  `);
  const insertRun = repo.db.prepare(`
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (?, 'session-cas', 'track-system', ?, 'jarvis-session-diarization-v1',
      'sherpa-segmentation+3dspeaker-campplus',
      '3dspeaker-campplus-voxceleb-16k-v1', ?, 512, 16000, 1, 'cpu', ?, ?, ?)
  `);
  const insertCluster = repo.db.prepare(`
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES (?, 'system-stable', 'speaker_1', zeroblob(2048), 1600, 1, 1, 1100)
  `);
  const insertTurn = repo.db.prepare(`
    INSERT INTO speaker_turns (
      id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
      raw_label, started_at, ended_at, embedding, echo_state,
      duplicate_of_turn_id, excluded_from_centroid, created_at
    ) VALUES (?, ?, 'system-stable', 'chunk-system', NULL, 0,
      'raw', 1100, 2700, zeroblob(2048), 'none', NULL, 0, ?)
  `);
  insertRun.run("run-clock-newer", "c".repeat(64), "f".repeat(64), 1, 9000, 9000);
  insertCluster.run("run-clock-newer");
  insertTurn.run("turn-old-sequence", "run-clock-newer", 9000);
  insertRun.run("run-clock-older", "d".repeat(64), "f".repeat(64), 2, 8000, 8000);
  insertCluster.run("run-clock-older");
  insertTurn.run("turn-new-sequence", "run-clock-older", 8000);

  assert.deepEqual(
    repo
      .listDiarizationEchoCandidates({
        sessionId: "session-cas",
        excludeTrackId: "track-cas",
        policyId: SESSION_DIARIZATION_POLICY.policyId,
      })
      .map((turn) => turn.id),
    ["turn-new-sequence"]
  );
});
