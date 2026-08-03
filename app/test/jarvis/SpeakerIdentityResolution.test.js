const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");
const SpeakerIdentityResolver = require("../../src/jarvis/main/SpeakerIdentityResolver");
const { meetsMinimum } = SpeakerIdentityResolver;
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
  buildIdentityResolutionJobKey,
  parseIdentityResolutionJobKey,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("../../src/jarvis/main/SessionDiarizationPolicy");
const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");

const MODEL_ID = "3dspeaker-campplus-voxceleb-16k-v1";
const PRIMARY_MODEL = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
const REVIEW_MODEL = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);

function vector(...components) {
  const value = new Float32Array(512);
  components.forEach((component, index) => {
    value[index] = component;
  });
  return value;
}

function primaryVector(...components) {
  const value = new Float32Array(PRIMARY_MODEL.embeddingDimension);
  components.forEach((component, index) => {
    value[index] = component;
  });
  return value;
}

function identityVector(manifest, ...components) {
  const value = new Float32Array(manifest.embeddingDimension);
  components.forEach((component, index) => {
    value[index] = component;
  });
  return value;
}

function fixture(t) {
  const repository = new JarvisRepository(":memory:");
  repository.db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-resolution', 1000, 9000, 'completed', 1000);
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-resolution', 'session-resolution', 'mic', 24000, 1, 1000, 9000, 'ended'
    );
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'cluster-resolution', 'session-resolution', 'track-resolution', 'speaker_1',
      '${MODEL_ID}', zeroblob(2048), 12000, 3, 0.78, 'unknown', 9000, 9000
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'run-resolution', 'session-resolution', 'track-resolution', '${"f".repeat(64)}',
      'jarvis-session-diarization-v1', 'sherpa-segmentation+3dspeaker-campplus',
      '${MODEL_ID}', '${"e".repeat(64)}', 512, 16000, 1, 'cpu', 1, 9000, 9000
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES (
      'run-resolution', 'cluster-resolution', 'speaker_1', zeroblob(2048),
      12000, 3, 0.78, 1000
    );
  `);
  repository.db
    .prepare("UPDATE speaker_clusters SET embedding = ? WHERE id = 'cluster-resolution'")
    .run(Buffer.from(vector(1).buffer));
  t.after(() => repository.close());
  return repository;
}

function addPersonAndSample(repository, { personId, embedding, sampleId = `${personId}-sample` }) {
  repository.renamePerson({ personId, displayName: personId });
  repository.addVoiceProfileSample({
    id: sampleId,
    personId,
    modelId: MODEL_ID,
    embedding,
    sourceKind: "enrollment",
    sourceClusterId: null,
    speechMs: 10_000,
    windowCount: 1,
    createdAt: 10_000,
  });
}

function addRunCluster(
  repository,
  { clusterId = "cluster-resolution-2", localLabel = "speaker_2" } = {}
) {
  repository.db
    .prepare(
      `
      INSERT INTO speaker_clusters (
        id, session_id, track_id, local_label, model_id, embedding,
        speech_ms, window_count, quality_score, link_state, created_at, updated_at
      ) VALUES (?, 'session-resolution', 'track-resolution', ?, ?, ?, 12000, 3, 0.9,
        'unknown', 9000, 9000)
    `
    )
    .run(clusterId, localLabel, MODEL_ID, Buffer.from(vector(0, 1).buffer));
  repository.db
    .prepare(
      `
      INSERT INTO speaker_diarization_run_clusters (
        run_id, cluster_id, local_label, embedding, speech_ms,
        window_count, quality_score, first_appearance_at
      ) VALUES ('run-resolution', ?, ?, ?, 12000, 3, 0.9, 2000)
    `
    )
    .run(clusterId, localLabel, Buffer.from(vector(0, 1).buffer));
}

function adjacentFloat32(value, direction) {
  const buffer = new ArrayBuffer(4);
  const float = new Float32Array(buffer);
  const bits = new Uint32Array(buffer);
  float[0] = value;
  bits[0] += direction;
  return float[0];
}

function adjacentFloat64(value, direction) {
  if (!Number.isFinite(value) || value <= 0 || ![-1, 1].includes(direction)) {
    throw new TypeError("adjacentFloat64 expects a positive finite value and direction");
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(direction));
  return view.getFloat64(0);
}

function seedReadyEvidence(t, { trackCount = 2, completeTracks = trackCount } = {}) {
  const repository = new JarvisRepository(":memory:");
  repository.db.exec(`
    INSERT INTO sessions (
      id, started_at, ended_at, status, created_at, finalized_at, processing_state
    ) VALUES ('session-ready', 1000, 20000, 'completed', 1000, 20000, 'processing');
  `);
  const runIds = [];
  const clusters = [];
  for (let index = 0; index < trackCount; index += 1) {
    const trackId = `track-ready-${index}`;
    const chunkId = `chunk-ready-${index}`;
    const segmentId = `segment-ready-${index}`;
    const sourceType = index === 0 ? "mic" : "system";
    repository.db
      .prepare(
        `
        INSERT INTO audio_tracks (
          id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
        ) VALUES (?, 'session-ready', ?, 24000, 1, 1000, 14000, 'ended')
      `
      )
      .run(trackId, sourceType);
    repository.db
      .prepare(
        `
        INSERT INTO audio_chunks (
          id, session_id, track_id, source_type, sequence_number, path,
          started_at, ended_at, duration_ms, sha256, expires_at,
          transcription_status, write_state, format, sample_rate, channels
        ) VALUES (?, 'session-ready', ?, ?, 0, ?, 1000, 14000, 13000, ?, 999999,
          'completed', 'committed', 'wav', 24000, 1)
      `
      )
      .run(chunkId, trackId, sourceType, `${chunkId}.wav`, String(index + 1).repeat(64));
    repository.db
      .prepare(
        `
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, attempt_count, created_at, completed_at
        ) VALUES (?, 'session-ready', ?, ?, 'transcribe_chunk', 'completed', 30,
          ?, 1, 'whisper-v1', 1, 14000, 14000)
      `
      )
      .run(`transcribe-${index}`, trackId, chunkId, String(index + 1).repeat(64));
    repository.db
      .prepare(
        `
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, speaker_label, text, confidence,
          is_stable, track_id, chunk_id, source_type, result_kind, version,
          model_version, completed_at
        ) VALUES (?, 'session-ready', 1000, 14000, 'speaker', ?, 0.9,
          1, ?, ?, ?, 'final', 1, 'whisper-v1', 14000)
      `
      )
      .run(segmentId, `text-${index}`, trackId, chunkId, sourceType);
    const evidence = repository.getDiarizationEvidenceSnapshot({
      sessionId: "session-ready",
      trackId,
      at: 15000,
      speakerProcessingPolicy: new SpeakerProcessingPolicy({
        transcriptionInputVersion: 1,
        transcriptionModelVersion: "whisper-v1",
      }),
    });
    const diarizationKey = buildDiarizationJobKey({
      sessionId: "session-ready",
      trackId,
      evidenceRevision: evidence.evidenceRevision,
    });
    repository.db
      .prepare(
        `
        INSERT INTO processing_jobs (
          id, session_id, track_id, job_type, state, priority,
          input_hash, input_version, model_version, attempt_count, created_at, completed_at
        ) VALUES (?, 'session-ready', ?, 'diarize_track', ?, 40, ?, 1, ?, 1, 15000, ?)
      `
      )
      .run(
        `diarize-${index}`,
        trackId,
        index < completeTracks ? "completed" : "pending",
        diarizationKey,
        SESSION_DIARIZATION_POLICY.policyId,
        index < completeTracks ? 15000 : null
      );
    if (index >= completeTracks) continue;
    const runId = `run-ready-${index}`;
    const clusterId = `cluster-ready-${index}`;
    repository.db
      .prepare(
        `
        INSERT INTO speaker_clusters (
          id, session_id, track_id, local_label, model_id, embedding,
          speech_ms, window_count, quality_score, link_state, created_at, updated_at
        ) VALUES (?, 'session-ready', ?, 'speaker_1', ?, ?, 13000, 3, 0.9,
          'unknown', 15000, 15000)
      `
      )
      .run(clusterId, trackId, MODEL_ID, Buffer.from(vector(0, 1).buffer));
    repository.db
      .prepare(
        `
        INSERT INTO speaker_diarization_runs (
          id, session_id, track_id, transcript_revision, policy_id,
          diarizer_model_id, embedding_model_id, model_artifact_sha256,
          embedding_dimension, sample_rate, input_version, execution_device,
          commit_sequence, created_at, completed_at
        ) VALUES (?, 'session-ready', ?, ?, ?, 'sherpa-segmentation+3dspeaker-campplus',
          ?, ?, 512, 16000, 1, 'cpu', ?, 15000, 15000)
      `
      )
      .run(
        runId,
        trackId,
        evidence.evidenceRevision,
        SESSION_DIARIZATION_POLICY.policyId,
        MODEL_ID,
        String(index + 5).repeat(64),
        index + 1
      );
    const runEmbedding = index === 0 ? vector(1, 0) : vector(0, 1);
    repository.db
      .prepare(
        `
        INSERT INTO speaker_diarization_run_clusters (
          run_id, cluster_id, local_label, embedding, speech_ms,
          window_count, quality_score, first_appearance_at
        ) VALUES (?, ?, 'speaker_1', ?, 13000, 3, 0.9, 1000)
      `
      )
      .run(runId, clusterId, Buffer.from(runEmbedding.buffer));
    runIds.push(runId);
    clusters.push({ clusterId, runId, runEmbedding });
  }
  t.after(() => repository.close());
  return { repository, runIds, clusters };
}

test("identity snapshot exposes prior anonymous dual-model evidence as a cross-session profile", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  const anonymousRef = "anonymous-speaker-1234567890abcdef1234567890abcdef";
  repository.db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('session-anonymous-history', 100, 900, 'completed', 100);
    INSERT INTO audio_tracks (
      id, session_id, source_type, application_key, application_display_name,
      sample_rate, channels, started_at, ended_at, state
    ) VALUES (
      'track-anonymous-history', 'session-anonymous-history', 'system',
      'kook', 'KOOK', 24000, 1, 100, 900, 'ended'
    );
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'cluster-anonymous-history', 'session-anonymous-history',
      'track-anonymous-history', 'speaker_1', '${MODEL_ID}', zeroblob(2048),
      15000, 3, 0.9, 'unknown', 900, 900
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'run-anonymous-history', 'session-anonymous-history',
      'track-anonymous-history', '${"a".repeat(64)}',
      '${SESSION_DIARIZATION_POLICY.policyId}',
      'sherpa-segmentation+3dspeaker-campplus', '${MODEL_ID}',
      '${"b".repeat(64)}', 512, 16000, 1, 'cpu', 99, 900, 900
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES (
      'run-anonymous-history', 'cluster-anonymous-history', 'speaker_1',
      zeroblob(2048), 15000, 3, 0.9, 100
    );
  `);
  repository.replaceSpeakerClusterModelEmbeddings({
    clusterId: "cluster-anonymous-history",
    sourceKind: "application",
    attributionState: "exact",
    overlapDetected: false,
    echoDetected: false,
    speechMs: 15_000,
    windowCount: 3,
    qualityScore: 0.9,
    createdAt: 900,
    models: [
      {
        ...PRIMARY_MODEL,
        embedding: identityVector(PRIMARY_MODEL, 1),
        qualityScore: 0.9,
      },
      {
        ...REVIEW_MODEL,
        embedding: identityVector(REVIEW_MODEL, 1),
        qualityScore: 0.9,
      },
    ],
  });
  repository.applySystemSpeakerResolutions({
    id: "resolution-run-anonymous-history",
    sessionId: "session-anonymous-history",
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    evidenceRunIds: ["run-anonymous-history"],
    results: [
      {
        evidenceRunId: "run-anonymous-history",
        clusterId: "cluster-anonymous-history",
        candidatePersonId: null,
        candidatePersonRef: anonymousRef,
        state: "unknown",
        score: 0.9,
        margin: 0.1,
        reason: "dual_model_anonymous_group",
      },
    ],
    at: 900,
  });

  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 20_000,
  });
  const anonymous = snapshot.samples.filter((sample) => sample.candidatePersonRef === anonymousRef);
  assert.equal(anonymous.length, 2);
  assert.deepEqual(
    anonymous.map((sample) => sample.modelId).sort(),
    [PRIMARY_MODEL.modelId, REVIEW_MODEL.modelId].sort()
  );
  assert.equal(
    anonymous.every((sample) => sample.personId === null),
    true
  );
  assert.equal(
    anonymous.every((sample) => sample.sourceKind === "system_anonymous"),
    true
  );
});

test("v22 persists revisioned identity resolution history", (t) => {
  const repository = fixture(t);
  assert.ok(TARGET_VERSION >= 22);
  assert.deepEqual(
    repository.db
      .prepare("PRAGMA table_info(speaker_identity_resolutions)")
      .all()
      .map((column) => column.name),
    [
      "id",
      "resolution_run_id",
      "session_id",
      "evidence_run_id",
      "cluster_id",
      "diarization_revision",
      "profile_revision",
      "policy_id",
      "candidate_person_id",
      "candidate_person_ref",
      "resolution_state",
      "match_score",
      "match_margin",
      "reason",
      "actor",
      "correction_id",
      "projection_applied",
      "created_at",
    ]
  );
  assert.ok(
    repository.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_identity_resolution_runs'"
      )
      .get()
  );
  const systemIndex = repository.db
    .prepare("PRAGMA index_list(speaker_identity_resolutions)")
    .all()
    .find((index) => index.name === "idx_speaker_identity_system_result");
  assert.deepEqual(
    { unique: systemIndex.unique, partial: systemIndex.partial },
    { unique: 1, partial: 1 }
  );
});

test("v46 repairs confirmed speaker projections created before system resolution synced transcripts", (t) => {
  const repository = fixture(t);
  assert.ok(TARGET_VERSION >= 46);
  repository.renamePerson({ personId: "person-a", displayName: "Person A" });
  repository.db.exec(`
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, source_type, result_kind, version
    ) VALUES (
      'segment-v45', 'session-resolution', 1000, 4000, 'speaker_1',
      'legacy projection evidence', 0.9, 1, 'track-resolution', 'mic',
      'provisional', 1
    );
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('cluster-resolution', 'segment-v45');
    UPDATE speaker_clusters
    SET person_id = 'person-a', link_state = 'confirmed'
    WHERE id = 'cluster-resolution';
    PRAGMA user_version = 45;
  `);

  assert.deepEqual(applyJarvisMigrations(repository.db), {
    fromVersion: 45,
    toVersion: TARGET_VERSION,
  });
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = ?")
      .get("segment-v45"),
    { person_id: "person-a", speaker_label: "Person A" }
  );
});

test("v21 upgrades in place to the v22 identity resolution schema", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db);
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('preserved-v21-session', 1000, 2000, 'completed', 1000);
      DROP TABLE speaker_identity_resolutions;
      DROP TABLE speaker_identity_resolution_runs;
      ALTER TABLE speaker_identity_corrections DROP COLUMN resolution_commit_sequence;
      PRAGMA user_version = 21;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 21, toVersion: TARGET_VERSION });
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = 'preserved-v21-session'").get());
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_identity_resolutions'"
        )
        .get()
    );
    assert.ok(
      db
        .prepare("PRAGMA table_info(speaker_identity_corrections)")
        .all()
        .some((column) => column.name === "resolution_commit_sequence")
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v21 correction sequence backfill lets undo restore a post-upgrade system result", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-identity-v21-correction-"));
  const databasePath = path.join(directory, "jarvis.db");
  let repository = new JarvisRepository(databasePath);
  t.after(() => {
    repository?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repository.createSession({ id: "legacy-session", startedAt: 1000, micDeviceId: "mic" });
  repository.createTrack({
    id: "legacy-track",
    sessionId: "legacy-session",
    sourceType: "mic",
    sampleRate: 24000,
    channels: 1,
    startedAt: 1000,
  });
  repository.db.exec(`
    UPDATE sessions SET status = 'completed', ended_at = 14000 WHERE id = 'legacy-session';
    UPDATE audio_tracks SET state = 'ended', ended_at = 14000 WHERE id = 'legacy-track';
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'legacy-cluster', 'legacy-session', 'legacy-track', 'speaker_1', '${MODEL_ID}',
      zeroblob(2048), 12000, 3, 0.9, 'unknown', 14000, 14000
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'legacy-run', 'legacy-session', 'legacy-track', '${"a".repeat(64)}',
      'jarvis-session-diarization-v1', 'sherpa-segmentation+3dspeaker-campplus',
      '${MODEL_ID}', '${"b".repeat(64)}', 512, 16000, 1, 'cpu', 1, 14000, 14000
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES (
      'legacy-run', 'legacy-cluster', 'speaker_1', zeroblob(2048), 12000, 3, 0.9, 1000
    );
  `);
  repository.renamePerson({ personId: "legacy-person-a", displayName: "Legacy A" });
  repository.renamePerson({ personId: "legacy-person-b", displayName: "Legacy B" });
  repository.confirmSpeakerLink({
    clusterId: "legacy-cluster",
    personId: "legacy-person-a",
    scope: "session",
    actor: "user",
  });
  repository.close();
  repository = null;

  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP TABLE speaker_identity_resolutions;
    DROP TABLE speaker_identity_resolution_runs;
    ALTER TABLE speaker_identity_corrections DROP COLUMN resolution_commit_sequence;
    PRAGMA user_version = 21;
  `);
  legacy.close();

  repository = new JarvisRepository(databasePath);
  assert.equal(
    repository.db
      .prepare("SELECT resolution_commit_sequence FROM speaker_identity_corrections")
      .get().resolution_commit_sequence,
    0
  );
  const protectedResult = repository.applySystemSpeakerResolution({
    evidenceRunId: "legacy-run",
    clusterId: "legacy-cluster",
    candidatePersonId: "legacy-person-b",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    at: 10_000,
  });
  assert.equal(protectedResult.projectionApplied, false);
  assert.equal(repository.getSpeakerCluster("legacy-cluster").personId, "legacy-person-a");

  repository.undoSpeakerCorrection("legacy-cluster");
  assert.equal(repository.getSpeakerCluster("legacy-cluster").personId, "legacy-person-b");
  assert.equal(repository.getSpeakerCluster("legacy-cluster").linkState, "confirmed");
});

test("schema rejects cross-session evidence even when individual foreign keys exist", (t) => {
  const repository = fixture(t);
  repository.db.exec(`
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES ('other-session', 1000, 9000, 'completed', 1000);
    INSERT INTO speaker_identity_resolution_runs (
      id, session_id, diarization_revision, profile_revision, policy_id,
      commit_sequence, expected_cluster_count, created_at, completed_at
    ) VALUES (
      'other-resolution-run', 'other-session', '${"1".repeat(64)}', '${"2".repeat(64)}',
      '${SPEAKER_IDENTITY_RESOLUTION_POLICY.id}', 1, 1, 10000, 10000
    );
  `);
  assert.throws(
    () =>
      repository.db
        .prepare(
          `
          INSERT INTO speaker_identity_resolutions (
            id, resolution_run_id, session_id, evidence_run_id, cluster_id,
            diarization_revision, profile_revision, policy_id, resolution_state,
            reason, actor, correction_id, projection_applied, created_at
          ) VALUES (
            'cross-session-result', 'other-resolution-run', 'other-session',
            'run-resolution', 'cluster-resolution', ?, ?, ?, 'unknown',
            'no_candidate', 'system', NULL, 1, 10000
          )
        `
        )
        .run("1".repeat(64), "2".repeat(64), SPEAKER_IDENTITY_RESOLUTION_POLICY.id),
    /evidence session mismatch/
  );
});

test("unknown dual-model matches persist a local anonymous reference without creating a person", (t) => {
  const repository = fixture(t);
  const batch = {
    id: "resolution-run-anonymous",
    sessionId: "session-resolution",
    diarizationRevision: "1".repeat(64),
    profileRevision: "2".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    evidenceRunIds: ["run-resolution"],
    results: [
      {
        evidenceRunId: "run-resolution",
        clusterId: "cluster-resolution",
        candidatePersonId: null,
        candidatePersonRef: "anonymous-speaker-local",
        state: "unknown",
        score: 0.91,
        margin: 0.08,
        reason: "dual_model_anonymous_group",
      },
    ],
    at: 10_000,
  };

  const first = repository.applySystemSpeakerResolutions(batch);
  const retry = repository.applySystemSpeakerResolutions(batch);

  assert.deepEqual(retry, first);
  assert.equal(first[0].candidatePersonId, null);
  assert.equal(first[0].candidatePersonRef, "anonymous-speaker-local");
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "unknown");
  assert.equal(repository.db.prepare("SELECT count(*) AS count FROM people").get().count, 0);
});

test("resolution provenance and projection survive repository restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-identity-resolution-"));
  const databasePath = path.join(directory, "jarvis.db");
  let repository = new JarvisRepository(databasePath);
  t.after(() => {
    repository?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repository.createSession({ id: "restart-session", startedAt: 1000, micDeviceId: "mic" });
  repository.createTrack({
    id: "restart-track",
    sessionId: "restart-session",
    sourceType: "mic",
    sampleRate: 24000,
    channels: 1,
    startedAt: 1000,
  });
  repository.db.exec(`
    UPDATE sessions SET status = 'completed', ended_at = 14000 WHERE id = 'restart-session';
    UPDATE audio_tracks SET state = 'ended', ended_at = 14000 WHERE id = 'restart-track';
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'restart-cluster', 'restart-session', 'restart-track', 'speaker_1', '${MODEL_ID}',
      zeroblob(2048), 12000, 3, 0.9, 'unknown', 14000, 14000
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'restart-run', 'restart-session', 'restart-track', '${"a".repeat(64)}',
      'jarvis-session-diarization-v1', 'sherpa-segmentation+3dspeaker-campplus',
      '${MODEL_ID}', '${"b".repeat(64)}', 512, 16000, 1, 'cpu', 1, 14000, 14000
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES ('restart-run', 'restart-cluster', 'speaker_1', zeroblob(2048), 12000, 3, 0.9, 1000);
  `);
  repository.db
    .prepare("UPDATE speaker_clusters SET embedding = ? WHERE id = 'restart-cluster'")
    .run(Buffer.from(vector(1).buffer));
  repository.db
    .prepare(
      "UPDATE speaker_diarization_run_clusters SET embedding = ? WHERE cluster_id = 'restart-cluster'"
    )
    .run(Buffer.from(vector(1).buffer));
  repository.renamePerson({ personId: "restart-person", displayName: "Restart" });
  repository.applySystemSpeakerResolution({
    evidenceRunId: "restart-run",
    clusterId: "restart-cluster",
    candidatePersonId: "restart-person",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    at: 15000,
  });
  repository.close();
  repository = new JarvisRepository(databasePath);
  assert.equal(repository.db.pragma("user_version", { simple: true }), TARGET_VERSION);
  assert.equal(repository.getSpeakerCluster("restart-cluster").personId, "restart-person");
  assert.equal(
    repository.listSpeakerResolutionHistory("restart-cluster")[0].reason,
    "auto_confirmed"
  );
});

test("system resolution persists provenance without learning and protects user corrections", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  repository.db.exec(`
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, source_type, result_kind, version, model_version, completed_at
    ) VALUES (
      'segment-resolution', 'session-resolution', 1000, 4000, 'speaker_1',
      'identity projection evidence', 0.9, 1, 'track-resolution', 'mic',
      'provisional', 1, NULL, NULL
    );
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('cluster-resolution', 'segment-resolution');
  `);
  const revisions = {
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const beforeSamples = repository.db
    .prepare("SELECT count(*) AS count FROM voice_profile_samples")
    .get().count;

  const applied = repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    ...revisions,
    at: 20_000,
  });
  assert.equal(applied.projectionApplied, true);
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, link_state, match_score, match_margin FROM speaker_clusters")
      .get(),
    { person_id: "person-a", link_state: "confirmed", match_score: 0.9, match_margin: 0.2 }
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = ?")
      .get("segment-resolution"),
    { person_id: "person-a", speaker_label: "person-a" }
  );
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM voice_profile_samples").get().count,
    beforeSamples
  );

  repository.confirmSpeakerLink({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });
  const protectedResult = repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: null,
    state: "unknown",
    score: null,
    margin: null,
    reason: "no_candidate",
    ...revisions,
    profileRevision: "c".repeat(64),
    at: 21_000,
  });
  assert.equal(protectedResult.projectionApplied, false);
  assert.equal(protectedResult.reason, "no_candidate");
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "confirmed");
});

test("system suggestions remain candidate-only and do not project a person into transcripts", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  repository.db.exec(`
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, source_type, result_kind, version
    ) VALUES (
      'segment-suggested', 'session-resolution', 1000, 4000, 'speaker_1',
      'suggestion evidence', 0.9, 1, 'track-resolution', 'mic', 'provisional', 1
    );
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('cluster-resolution', 'segment-suggested');
  `);

  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "suggested",
    score: 0.78,
    margin: 0.1,
    reason: "suggested",
    diarizationRevision: "e".repeat(64),
    profileRevision: "f".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    at: 20_000,
  });

  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, link_state FROM speaker_clusters WHERE id = ?")
      .get("cluster-resolution"),
    { person_id: "person-a", link_state: "suggested" }
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT person_id, speaker_label FROM transcript_segments WHERE id = ?")
      .get("segment-suggested"),
    { person_id: null, speaker_label: "speaker_1" }
  );
});

test("same-revision user rejection is durable and exact-revision scoped", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  const revisions = {
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "suggested",
    score: 0.75,
    margin: 0.2,
    reason: "suggested",
    ...revisions,
    at: 20_000,
  });
  repository.rejectSpeakerSuggestion({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });

  assert.deepEqual(repository.listRejectedSpeakerPersonIds("cluster-resolution", revisions), [
    "person-a",
  ]);
  assert.deepEqual(
    repository.listRejectedSpeakerPersonIds("cluster-resolution", {
      ...revisions,
      profileRevision: "e".repeat(64),
    }),
    []
  );
  const rejected = repository.listSpeakerResolutionHistory("cluster-resolution").at(-1);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.reason, "user_rejected_candidate");
  assert.equal(rejected.candidatePersonRef, "person-a");
});

test("rejection targets the current monotonic resolution revision despite decreasing clocks", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  const first = {
    diarizationRevision: "1".repeat(64),
    profileRevision: "2".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const current = {
    diarizationRevision: "3".repeat(64),
    profileRevision: "4".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  for (const [revision, at] of [
    [first, 30_000],
    [current, 10_000],
  ]) {
    repository.applySystemSpeakerResolution({
      evidenceRunId: "run-resolution",
      clusterId: "cluster-resolution",
      candidatePersonId: "person-a",
      state: "suggested",
      score: 0.75,
      margin: 0.2,
      reason: "suggested",
      ...revision,
      at,
    });
    const inputHash = buildIdentityResolutionJobKey({
      sessionId: "session-resolution",
      ...revision,
    });
    repository.db
      .prepare(
        `
        INSERT INTO processing_jobs (
          id, session_id, job_type, state, priority, input_hash,
          input_version, model_version, attempt_count, created_at, completed_at
        ) VALUES (?, 'session-resolution', 'resolve_identities', 'completed', 45,
          ?, 1, ?, 1, ?, ?)
      `
      )
      .run(`job-${revision.profileRevision[0]}`, inputHash, revision.policyId, at, at);
  }

  repository.rejectSpeakerSuggestion({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });
  const rejection = repository
    .listSpeakerResolutionHistory("cluster-resolution")
    .find((row) => row.actor === "user" && row.state === "rejected");
  assert.equal(rejection.diarizationRevision, current.diarizationRevision);
  assert.equal(rejection.profileRevision, current.profileRevision);
  assert.deepEqual(
    repository
      .listSpeakerResolutionHistory("cluster-resolution")
      .filter((row) => row.actor === "system")
      .map((row) => row.diarizationRevision),
    [first.diarizationRevision, current.diarizationRevision]
  );
  assert.deepEqual(
    repository.db
      .prepare(
        "SELECT id, state FROM processing_jobs WHERE job_type = 'resolve_identities' ORDER BY id"
      )
      .all(),
    [
      { id: "job-2", state: "completed" },
      { id: "job-4", state: "pending" },
    ]
  );
});

test("rejection ignores a newer protected candidate that was never projected", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  const projected = {
    diarizationRevision: "7".repeat(64),
    profileRevision: "8".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const protectedRevision = {
    diarizationRevision: "9".repeat(64),
    profileRevision: "a".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "suggested",
    score: 0.75,
    margin: 0.2,
    reason: "suggested",
    ...projected,
    at: 20_000,
  });
  repository.confirmSpeakerLink({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });
  const protectedResult = repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    ...protectedRevision,
    at: 21_000,
  });
  assert.equal(protectedResult.projectionApplied, false);

  repository.rejectSpeakerSuggestion({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });
  const rejection = repository
    .listSpeakerResolutionHistory("cluster-resolution")
    .find((row) => row.actor === "user" && row.state === "rejected");
  assert.equal(rejection.diarizationRevision, projected.diarizationRevision);
  assert.equal(rejection.profileRevision, projected.profileRevision);
});

test("rejection, exact-job requeue, and session wake are atomic across restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-identity-rejection-atomic-"));
  const databasePath = path.join(directory, "jarvis.db");
  let repository = new JarvisRepository(databasePath);
  t.after(() => {
    repository?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repository.createSession({ id: "atomic-session", startedAt: 1000, micDeviceId: "mic" });
  repository.createTrack({
    id: "atomic-track",
    sessionId: "atomic-session",
    sourceType: "mic",
    sampleRate: 24000,
    channels: 1,
    startedAt: 1000,
  });
  repository.db.exec(`
    UPDATE sessions SET status = 'completed', ended_at = 14000 WHERE id = 'atomic-session';
    UPDATE audio_tracks SET state = 'ended', ended_at = 14000 WHERE id = 'atomic-track';
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, embedding,
      speech_ms, window_count, quality_score, link_state, created_at, updated_at
    ) VALUES (
      'atomic-cluster', 'atomic-session', 'atomic-track', 'speaker_1', '${MODEL_ID}',
      zeroblob(2048), 12000, 3, 0.9, 'unknown', 14000, 14000
    );
    INSERT INTO speaker_diarization_runs (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    ) VALUES (
      'atomic-run', 'atomic-session', 'atomic-track', '${"e".repeat(64)}',
      'jarvis-session-diarization-v1', 'sherpa-segmentation+3dspeaker-campplus',
      '${MODEL_ID}', '${"f".repeat(64)}', 512, 16000, 1, 'cpu', 1, 14000, 14000
    );
    INSERT INTO speaker_diarization_run_clusters (
      run_id, cluster_id, local_label, embedding, speech_ms,
      window_count, quality_score, first_appearance_at
    ) VALUES (
      'atomic-run', 'atomic-cluster', 'speaker_1', zeroblob(2048), 12000, 3, 0.9, 1000
    );
  `);
  repository.renamePerson({ personId: "atomic-person", displayName: "Atomic" });
  const revision = {
    diarizationRevision: "5".repeat(64),
    profileRevision: "6".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  repository.applySystemSpeakerResolution({
    evidenceRunId: "atomic-run",
    clusterId: "atomic-cluster",
    candidatePersonId: "atomic-person",
    state: "suggested",
    score: 0.75,
    margin: 0.2,
    reason: "suggested",
    ...revision,
    at: 15_000,
  });
  const inputHash = buildIdentityResolutionJobKey({ sessionId: "atomic-session", ...revision });
  repository.db
    .prepare(
      `
      INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash,
        input_version, model_version, attempt_count, created_at, completed_at
      ) VALUES (
        'atomic-resolve-job', 'atomic-session', 'resolve_identities', 'completed', 45,
        ?, 1, ?, 1, 15000, 15000
      )
    `
    )
    .run(inputHash, revision.policyId);
  repository.db.exec(`
    UPDATE sessions SET processing_state = 'ready', ready_at = 15000
    WHERE id = 'atomic-session';
    CREATE TRIGGER reject_atomic_identity_wake
    BEFORE UPDATE OF processing_state ON sessions
    WHEN NEW.id = 'atomic-session' AND NEW.processing_state = 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'atomic identity wake rejected');
    END;
  `);

  assert.throws(
    () =>
      repository.rejectSpeakerSuggestion({
        clusterId: "atomic-cluster",
        personId: "atomic-person",
        scope: "session",
        actor: "user",
      }),
    /atomic identity wake rejected/
  );
  repository.close();
  repository = new JarvisRepository(databasePath);
  assert.equal(repository.getSpeakerCluster("atomic-cluster").linkState, "suggested");
  assert.equal(
    repository.db.prepare("SELECT state FROM processing_jobs WHERE id = 'atomic-resolve-job'").get()
      .state,
    "completed"
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'atomic-session'")
      .get(),
    { processing_state: "ready", ready_at: 15000 }
  );
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM speaker_identity_corrections WHERE cluster_id = 'atomic-cluster'"
      )
      .get().count,
    0
  );
  assert.equal(
    repository.listSpeakerResolutionHistory("atomic-cluster").filter((row) => row.actor === "user")
      .length,
    0
  );

  repository.db.exec("DROP TRIGGER reject_atomic_identity_wake");
  repository.rejectSpeakerSuggestion({
    clusterId: "atomic-cluster",
    personId: "atomic-person",
    scope: "session",
    actor: "user",
  });
  repository.close();
  repository = new JarvisRepository(databasePath);
  assert.equal(repository.getSpeakerCluster("atomic-cluster").linkState, "rejected");
  assert.equal(
    repository.db.prepare("SELECT state FROM processing_jobs WHERE id = 'atomic-resolve-job'").get()
      .state,
    "pending"
  );
  assert.equal(repository.getSession("atomic-session").processing_state, "processing");
  assert.equal(
    repository
      .listSpeakerResolutionHistory("atomic-cluster")
      .filter((row) => row.actor === "user" && row.state === "rejected").length,
    1
  );
});

test("policy and immutable job key are exact and restart parseable", () => {
  assert.deepEqual(SPEAKER_IDENTITY_RESOLUTION_POLICY, {
    id: "speaker-identity/campplus-eres2netv2-dual-zh-cn@2",
    modelId: MODEL_ID,
    minimumSpeechMs: 12_000,
    minimumWindows: 3,
    minimumQualityScore: 0.78,
    autoConfirmSimilarity: 0.82,
    suggestSimilarity: 0.72,
    minimumMargin: 0.05,
  });
  const identity = {
    sessionId: "session-resolution",
    diarizationRevision: "1".repeat(64),
    profileRevision: "2".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const key = buildIdentityResolutionJobKey(identity);
  assert.equal(
    key,
    `resolve_identities:session-resolution:${"1".repeat(64)}:${"2".repeat(64)}:${SPEAKER_IDENTITY_RESOLUTION_POLICY.id}`
  );
  assert.deepEqual(parseIdentityResolutionJobKey(key), identity);
});

test("every exact policy field and every production seam reject same-id alterations", (t) => {
  assert.equal(typeof assertExactIdentityResolutionPolicy, "function");
  const alteredValues = {
    id: "speaker-identity/3dspeaker-campplus-voxceleb-16k-v1@2",
    modelId: "different-model",
    minimumSpeechMs: 11_999,
    minimumWindows: 2,
    minimumQualityScore: 0.77,
    autoConfirmSimilarity: 0.81,
    suggestSimilarity: 0.71,
    minimumMargin: 0.04,
  };
  for (const field of Object.keys(SPEAKER_IDENTITY_RESOLUTION_POLICY)) {
    const altered = Object.freeze({
      ...SPEAKER_IDENTITY_RESOLUTION_POLICY,
      [field]: alteredValues[field],
    });
    assert.throws(() => assertExactIdentityResolutionPolicy(altered), /exact identity policy/);
  }
  const exactClone = Object.freeze({ ...SPEAKER_IDENTITY_RESOLUTION_POLICY });
  assert.equal(assertExactIdentityResolutionPolicy(exactClone), exactClone);

  const repository = fixture(t);
  const altered = Object.freeze({
    ...SPEAKER_IDENTITY_RESOLUTION_POLICY,
    minimumSpeechMs: 1,
  });
  assert.throws(() => new SpeakerIdentityResolver({ policy: altered }), /exact identity policy/);
  assert.throws(
    () =>
      repository.getSpeakerIdentityResolutionSnapshot({
        sessionId: "session-resolution",
        policy: altered,
      }),
    /exact identity policy/
  );
  assert.throws(
    () => repository.enqueueSpeakerIdentityResolutionJob("session-resolution", { policy: altered }),
    /exact identity policy/
  );
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  assert.throws(
    () => new SpeakerIdentityResolutionWorker({ repository, policy: altered }),
    /exact identity policy/
  );
  assert.throws(
    () =>
      new SpeakerIdentityResolutionWorker({
        repository,
        resolver: { policy: altered, resolveCluster() {} },
      }),
    /exact identity policy/
  );
});

test("resolver groups samples by person centroid rather than max single sample", () => {
  const resolver = new SpeakerIdentityResolver();
  const result = resolver.resolveCluster({
    cluster: {
      id: "cluster-resolution",
      modelId: MODEL_ID,
      embedding: vector(1, 0),
      speechMs: 12_000,
      windowCount: 3,
      qualityScore: 0.78,
    },
    samples: [
      { id: "a-1", personId: "a", modelId: MODEL_ID, embedding: vector(1, 0) },
      { id: "a-2", personId: "a", modelId: MODEL_ID, embedding: vector(-1, 0) },
      { id: "b-1", personId: "b", modelId: MODEL_ID, embedding: vector(0.9, 0.4358899) },
    ],
    rejectedPersonIds: [],
  });
  assert.equal(result.candidatePersonId, "b");
  assert.equal(result.state, "confirmed");
  assert.equal(result.reason, "auto_confirmed");
});

test("session batch is atomic, complete, DB-idempotent, and never learns", (t) => {
  const repository = fixture(t);
  addRunCluster(repository);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1, 0) });
  addPersonAndSample(repository, { personId: "person-b", embedding: vector(0, 1) });
  const beforeProfiles = repository.db
    .prepare("SELECT id, hex(embedding) AS embedding FROM voice_profile_samples ORDER BY id")
    .all();
  const batch = {
    id: "resolution-run-batch",
    sessionId: "session-resolution",
    diarizationRevision: "3".repeat(64),
    profileRevision: "4".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    evidenceRunIds: ["run-resolution"],
    results: [
      {
        evidenceRunId: "run-resolution",
        clusterId: "cluster-resolution",
        candidatePersonId: "person-a",
        state: "confirmed",
        score: 0.9,
        margin: 0.2,
        reason: "auto_confirmed",
      },
      {
        evidenceRunId: "run-resolution",
        clusterId: "cluster-resolution-2",
        candidatePersonId: "person-b",
        state: "suggested",
        score: 0.75,
        margin: 0.1,
        reason: "suggested",
      },
    ],
    at: 30_000,
  };

  assert.throws(
    () =>
      repository.applySystemSpeakerResolutions({
        ...batch,
        id: "resolution-run-fails",
        profileRevision: "5".repeat(64),
        results: [batch.results[0], { ...batch.results[1], candidatePersonId: "missing" }],
      }),
    /person not found/
  );
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolution_runs").get()
      .count,
    0
  );
  assert.deepEqual(
    repository.listSessionSpeakerClusters("session-resolution").map((cluster) => cluster.linkState),
    ["unknown", "unknown"]
  );

  const first = repository.applySystemSpeakerResolutions(batch);
  const retried = repository.applySystemSpeakerResolutions(batch);
  assert.equal(first.length, 2);
  assert.deepEqual(retried, first);
  const beforeInvalidRetryRows = repository.db
    .prepare(
      "SELECT cluster_id, candidate_person_id, resolution_state, match_score, match_margin FROM speaker_identity_resolutions WHERE resolution_run_id = ? ORDER BY cluster_id"
    )
    .all(batch.id);
  const beforeInvalidRetryProjection = repository.listSessionSpeakerClusters("session-resolution");
  assert.throws(
    () =>
      repository.applySystemSpeakerResolutions({
        ...batch,
        results: [
          { ...batch.results[0], candidatePersonId: "person-b", score: 0.85 },
          {
            ...batch.results[0],
            candidatePersonId: null,
            state: "unknown",
            score: null,
            margin: null,
            reason: "no_candidate",
          },
        ],
      }),
    /cover every evidence cluster exactly/
  );
  assert.deepEqual(
    repository.db
      .prepare(
        "SELECT cluster_id, candidate_person_id, resolution_state, match_score, match_margin FROM speaker_identity_resolutions WHERE resolution_run_id = ? ORDER BY cluster_id"
      )
      .all(batch.id),
    beforeInvalidRetryRows
  );
  assert.deepEqual(
    repository.listSessionSpeakerClusters("session-resolution"),
    beforeInvalidRetryProjection
  );
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolution_runs").get()
      .count,
    1
  );
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolutions").get().count,
    2
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT id, hex(embedding) AS embedding FROM voice_profile_samples ORDER BY id")
      .all(),
    beforeProfiles
  );
  assert.throws(
    () =>
      repository.applySystemSpeakerResolution({
        evidenceRunId: "run-resolution",
        clusterId: "cluster-resolution",
        candidatePersonId: "person-a",
        state: "confirmed",
        score: 0.9,
        margin: 0.2,
        reason: "auto_confirmed",
        diarizationRevision: "6".repeat(64),
        profileRevision: "7".repeat(64),
        policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
      }),
    /cover every evidence cluster exactly/
  );
});

test("a result id collision fails and rolls back the entire new resolution run", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  const targetRunId = "resolution-run-collision-target";
  const conflictingResultId = `speaker_resolution_${crypto
    .createHash("sha256")
    .update(`${targetRunId}\0cluster-resolution`)
    .digest("hex")
    .slice(0, 32)}`;
  repository.db
    .prepare(
      `
      INSERT INTO speaker_identity_resolution_runs (
        id, session_id, diarization_revision, profile_revision, policy_id,
        commit_sequence, expected_cluster_count, created_at, completed_at
      ) VALUES ('collision-owner', 'session-resolution', ?, ?, ?, 1, 1, 19000, 19000)
    `
    )
    .run("8".repeat(64), "9".repeat(64), SPEAKER_IDENTITY_RESOLUTION_POLICY.id);
  repository.db
    .prepare(
      `
      INSERT INTO speaker_identity_resolutions (
        id, resolution_run_id, session_id, evidence_run_id, cluster_id,
        diarization_revision, profile_revision, policy_id,
        resolution_state, reason, actor, correction_id, projection_applied, created_at
      ) VALUES (?, 'collision-owner', 'session-resolution', 'run-resolution',
        'cluster-resolution', ?, ?, ?, 'unknown', 'no_candidate', 'system', NULL, 1, 19000)
    `
    )
    .run(
      conflictingResultId,
      "8".repeat(64),
      "9".repeat(64),
      SPEAKER_IDENTITY_RESOLUTION_POLICY.id
    );
  assert.throws(
    () =>
      repository.applySystemSpeakerResolutions({
        id: targetRunId,
        sessionId: "session-resolution",
        diarizationRevision: "a".repeat(64),
        profileRevision: "b".repeat(64),
        policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
        evidenceRunIds: ["run-resolution"],
        results: [
          {
            evidenceRunId: "run-resolution",
            clusterId: "cluster-resolution",
            candidatePersonId: "person-a",
            state: "confirmed",
            score: 0.9,
            margin: 0.2,
            reason: "auto_confirmed",
          },
        ],
        at: 20000,
      }),
    { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }
  );
  assert.equal(
    repository.db
      .prepare("SELECT count(*) AS count FROM speaker_identity_resolution_runs WHERE id = ?")
      .get(targetRunId).count,
    0
  );
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "unknown");
});

test("an empty evidence run remains idempotent when resolution is retried", (t) => {
  const repository = fixture(t);
  repository.db.exec(`
    DELETE FROM speaker_diarization_run_clusters WHERE run_id = 'run-resolution';
    DELETE FROM speaker_clusters WHERE id = 'cluster-resolution';
  `);
  const batch = {
    id: "resolution-run-empty",
    sessionId: "session-resolution",
    diarizationRevision: "5".repeat(64),
    profileRevision: "6".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    evidenceRunIds: ["run-resolution"],
    results: [],
    at: 30_000,
  };

  assert.deepEqual(repository.applySystemSpeakerResolutions(batch), []);
  assert.deepEqual(repository.applySystemSpeakerResolutions(batch), []);
  assert.equal(
    repository.db
      .prepare("SELECT expected_cluster_count FROM speaker_identity_resolution_runs WHERE id = ?")
      .get(batch.id).expected_cluster_count,
    0
  );
});

test("active rejection is exact-revision scoped and undo preserves a newer system projection", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  addPersonAndSample(repository, { personId: "person-b", embedding: vector(0, 1) });
  const firstRevision = {
    diarizationRevision: "7".repeat(64),
    profileRevision: "8".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "suggested",
    score: 0.75,
    margin: 0.1,
    reason: "suggested",
    ...firstRevision,
    at: 20_000,
  });
  repository.rejectSpeakerSuggestion({ clusterId: "cluster-resolution", personId: "person-a" });
  assert.deepEqual(repository.listRejectedSpeakerPersonIds("cluster-resolution", firstRevision), [
    "person-a",
  ]);

  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-b",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    ...firstRevision,
    profileRevision: "9".repeat(64),
    at: 10_000,
  });
  assert.equal(repository.getSpeakerCluster("cluster-resolution").personId, "person-b");
  repository.undoSpeakerCorrection("cluster-resolution");
  assert.equal(repository.getSpeakerCluster("cluster-resolution").personId, "person-b");
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "confirmed");
  assert.deepEqual(
    repository.listRejectedSpeakerPersonIds("cluster-resolution", firstRevision),
    []
  );
});

test("the latest user rejection releases older confirmation protection", (t) => {
  const repository = fixture(t);
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  addPersonAndSample(repository, { personId: "person-b", embedding: vector(0, 1) });
  const revision = {
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-a",
    state: "suggested",
    score: 0.75,
    margin: 0.2,
    reason: "suggested",
    ...revision,
    at: 20_000,
  });
  repository.confirmSpeakerLink({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });
  repository.rejectSpeakerSuggestion({
    clusterId: "cluster-resolution",
    personId: "person-a",
    scope: "session",
    actor: "user",
  });

  const retried = repository.applySystemSpeakerResolution({
    evidenceRunId: "run-resolution",
    clusterId: "cluster-resolution",
    candidatePersonId: "person-b",
    state: "confirmed",
    score: 0.9,
    margin: 0.2,
    reason: "auto_confirmed",
    ...revision,
    at: 21_000,
  });
  assert.equal(retried.projectionApplied, true);
  assert.equal(repository.getSpeakerCluster("cluster-resolution").personId, "person-b");
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "confirmed");
});

test("resolver applies speech, windows, quality, score, and margin boundaries in order", () => {
  assert.equal(typeof meetsMinimum, "function");
  for (const threshold of [
    SPEAKER_IDENTITY_RESOLUTION_POLICY.minimumQualityScore,
    SPEAKER_IDENTITY_RESOLUTION_POLICY.suggestSimilarity,
    SPEAKER_IDENTITY_RESOLUTION_POLICY.autoConfirmSimilarity,
    SPEAKER_IDENTITY_RESOLUTION_POLICY.minimumMargin,
  ]) {
    assert.equal(meetsMinimum(adjacentFloat64(threshold, -1), threshold), false);
    assert.equal(meetsMinimum(threshold, threshold), true);
    assert.equal(meetsMinimum(adjacentFloat64(threshold, 1), threshold), true);
  }
  assert.equal(meetsMinimum(11_999, 12_000), false);
  assert.equal(meetsMinimum(12_000, 12_000), true);
  assert.equal(meetsMinimum(2, 3), false);
  assert.equal(meetsMinimum(3, 3), true);
  assert.equal(meetsMinimum(Number.NaN, 0), false);

  const resolver = new SpeakerIdentityResolver();
  const resolve = ({ cluster = {}, samples = [] } = {}) =>
    resolver.resolveCluster({
      cluster: {
        id: "c",
        modelId: MODEL_ID,
        embedding: vector(1, 0),
        speechMs: 12_000,
        windowCount: 3,
        qualityScore: 0.78,
        ...cluster,
      },
      samples,
      rejectedPersonIds: [],
    });
  const sample = (personId, score) => ({
    id: personId,
    personId,
    modelId: MODEL_ID,
    embedding: vector(score, Math.sqrt(1 - score * score)),
  });

  assert.equal(
    resolve({ cluster: { speechMs: 11_999, windowCount: 0, qualityScore: 0 } }).reason,
    "insufficient_speech"
  );
  assert.equal(
    resolve({ cluster: { speechMs: 12_000, windowCount: 2, qualityScore: 0 } }).reason,
    "insufficient_windows"
  );
  assert.equal(
    resolve({ cluster: { windowCount: 3, qualityScore: adjacentFloat32(0.78, -1) } }).reason,
    "low_quality"
  );
  assert.equal(resolve({ cluster: { qualityScore: 0.78 } }).reason, "no_candidate");
  assert.equal(
    resolve({ cluster: { qualityScore: adjacentFloat32(0.78, 1) } }).reason,
    "no_candidate"
  );

  assert.equal(
    resolve({ samples: [sample("a", adjacentFloat32(0.72, -1))] }).reason,
    "below_suggest_similarity"
  );
  assert.equal(resolve({ samples: [sample("a", adjacentFloat32(0.72, 1))] }).state, "suggested");
  assert.equal(resolve({ samples: [sample("a", adjacentFloat32(0.82, -1))] }).state, "suggested");
  assert.equal(resolve({ samples: [sample("a", adjacentFloat32(0.82, 1))] }).state, "confirmed");
  assert.equal(
    resolve({ samples: [sample("a", 1), sample("b", adjacentFloat32(0.95, 1))] }).reason,
    "insufficient_margin"
  );
  assert.equal(
    resolve({ samples: [sample("a", 1), sample("b", adjacentFloat32(0.95, -1))] }).state,
    "confirmed"
  );

  assert.equal(
    resolve({ samples: [sample("a", 0.7), sample("b", 0.7)] }).reason,
    "below_suggest_similarity"
  );
  assert.equal(
    resolve({ samples: [sample("a", 0.9), sample("b", 0.9)] }).reason,
    "insufficient_margin"
  );
  assert.equal(resolve({ samples: [sample("a", 0.75)] }).margin > 0.7, true);
});

test("self candidates use the exact production policy without relaxed gates", () => {
  const resolver = new SpeakerIdentityResolver();
  const resolveSelf = ({ score, secondScore }) =>
    resolver.resolveCluster({
      cluster: {
        id: "self-cluster",
        modelId: MODEL_ID,
        embedding: vector(1, 0),
        speechMs: 12_000,
        windowCount: 3,
        qualityScore: 0.9,
      },
      samples: [
        {
          id: "self-sample",
          personId: "self",
          isSelf: true,
          modelId: MODEL_ID,
          embedding: vector(score, Math.sqrt(1 - score * score)),
        },
        ...(secondScore === undefined
          ? []
          : [
              {
                id: "other-sample",
                personId: "other",
                modelId: MODEL_ID,
                embedding: vector(secondScore, Math.sqrt(1 - secondScore * secondScore)),
              },
            ]),
      ],
      rejectedPersonIds: [],
    });

  assert.equal(resolveSelf({ score: 0.71 }).state, "unknown");
  assert.equal(resolveSelf({ score: 0.75 }).state, "suggested");
  assert.equal(resolveSelf({ score: 0.83 }).state, "confirmed");
  assert.equal(resolveSelf({ score: 1, secondScore: 0.96 }).reason, "insufficient_margin");
  const confirmed = resolveSelf({ score: 1, secondScore: 0.94 });
  assert.equal(confirmed.candidatePersonId, "self");
  assert.equal(confirmed.state, "confirmed");
});

test("resolver is deterministic across sample order, isolates models, and rejects invalid vectors", () => {
  const resolver = new SpeakerIdentityResolver();
  const cluster = {
    id: "c",
    modelId: MODEL_ID,
    embedding: vector(1),
    speechMs: 12_000,
    windowCount: 3,
    qualityScore: 0.9,
  };
  const invalid = [
    vector(0),
    vector(Number.NaN),
    vector(Number.POSITIVE_INFINITY),
    new Float32Array([1, 0, 0, 0]),
  ];
  const samples = [
    { id: "wrong", personId: "wrong", modelId: "other-model", embedding: vector(1) },
    ...invalid.map((embedding, index) => ({
      id: `invalid-${index}`,
      personId: "invalid",
      modelId: MODEL_ID,
      embedding,
    })),
    { id: "a-1", personId: "a", modelId: MODEL_ID, embedding: vector(1, 0) },
    { id: "a-2", personId: "a", modelId: MODEL_ID, embedding: vector(0.8, 0.6) },
    { id: "b-1", personId: "b", modelId: MODEL_ID, embedding: vector(0.7, 0.7141428) },
  ];
  const forward = resolver.resolveCluster({ cluster, samples, rejectedPersonIds: [] });
  const reverse = resolver.resolveCluster({
    cluster,
    samples: [...samples].reverse(),
    rejectedPersonIds: [],
  });
  assert.deepEqual(reverse, forward);
  assert.equal(forward.candidatePersonId, "a");
  assert.equal(
    resolver.resolveCluster({
      cluster: { ...cluster, embedding: vector(0) },
      samples,
      rejectedPersonIds: [],
    }).reason,
    "invalid_cluster_embedding"
  );
  for (const embedding of [vector(Number.NaN), vector(Number.NEGATIVE_INFINITY)]) {
    assert.equal(
      resolver.resolveCluster({
        cluster: { ...cluster, embedding },
        samples,
        rejectedPersonIds: [],
      }).reason,
      "invalid_cluster_embedding"
    );
  }
  assert.equal(
    resolver.resolveCluster({ cluster, samples, rejectedPersonIds: ["a", "b"] }).reason,
    "no_candidate"
  );
});

test("snapshot requires every current diarization job terminal and revisions are deterministic", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 2, completeTracks: 1 });
  let snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });
  assert.equal(snapshot.eligible, false);
  assert.equal(snapshot.reason, "diarization_incomplete");
  assert.equal(
    repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 }).enqueued,
    0
  );

  repository.db
    .prepare(
      "UPDATE processing_jobs SET state = 'completed', completed_at = 16000 WHERE id = 'diarize-1'"
    )
    .run();
  assert.equal(
    repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: "session-ready",
      at: 16000,
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    }).eligible,
    false,
    "a completed job without its matching committed run is still incomplete"
  );
});

test("completed primary tracks can start identity resolution while an application track waits", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 2, completeTracks: 1 });
  repository.db.exec(`
    UPDATE audio_tracks
    SET application_key = 'kook', application_display_name = 'KOOK', capture_generation = 1
    WHERE id = 'track-ready-1';
  `);

  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });

  assert.equal(snapshot.eligible, true);
  assert.deepEqual(snapshot.evidenceRunIds, ["run-ready-0"]);
  assert.equal(
    repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 }).enqueued,
    1
  );
});

test("completed application diarization joins the next identity resolution revision", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 2, completeTracks: 2 });
  repository.db.exec(`
    UPDATE audio_tracks
    SET application_key = 'kook', application_display_name = 'KOOK', capture_generation = 1
    WHERE id = 'track-ready-1';
  `);

  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });

  assert.equal(snapshot.eligible, true);
  assert.deepEqual(snapshot.evidenceRunIds, ["run-ready-0", "run-ready-1"]);
});

test("ready snapshot uses per-run evidence and enqueue identity is strict and idempotent", (t) => {
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1, 0) });
  const first = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });
  const second = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });
  assert.equal(first.eligible, true);
  assert.equal(first.diarizationRevision, second.diarizationRevision);
  assert.equal(first.profileRevision, second.profileRevision);
  assert.deepEqual(first.clusters[0].embedding, clusters[0].runEmbedding);
  assert.notDeepEqual(
    first.clusters[0].embedding,
    repository.getSpeakerCluster(clusters[0].clusterId).embedding,
    "stable projection evidence is deliberately different"
  );

  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  const repeated = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  assert.equal(queued.enqueued, 1);
  assert.equal(repeated.enqueued, 0);
  assert.equal(queued.job.priority, 29);
  assert.equal(
    queued.job.input_hash,
    buildIdentityResolutionJobKey({
      sessionId: "session-ready",
      diarizationRevision: first.diarizationRevision,
      profileRevision: first.profileRevision,
      policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    })
  );
});

test("zero-evidence failed application tracks do not block identity resolution", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  repository.db
    .prepare(
      `
      INSERT INTO audio_tracks (
        id, session_id, source_type, application_key, application_display_name,
        capture_generation, strategy, sample_rate, channels, started_at, ended_at,
        state, failure_code
      ) VALUES (
        'failed-app-track', 'session-ready', 'system', 'kook', 'KOOK', 7,
        'wasapi-application-loopback', 24000, 1, 2000, 2000, 'failed',
        'activation_failed_0x88890004'
      )
    `
    )
    .run();

  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });
  assert.equal(snapshot.eligible, true);
  assert.deepEqual(snapshot.evidenceRunIds, ["run-ready-0"]);
  assert.equal(
    repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 }).enqueued,
    1
  );
});

test("profile revision includes the durable self flag", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-self-toggle", embedding: vector(1) });
  const before = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
  }).profileRevision;
  repository.db.prepare("UPDATE people SET is_self = 1 WHERE id = 'person-self-toggle'").run();
  const after = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16000,
  }).profileRevision;
  assert.notEqual(after, before);
});

test("worker revalidates immutable revisions and commits a complete resolution batch", async (t) => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1, 0) });
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  const worker = new SpeakerIdentityResolutionWorker({ repository, clock: () => 17000 });
  const result = await worker.run(queued.job);
  assert.equal(result.status, "completed");
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).personId, "person-a");
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolution_runs").get()
      .count,
    1
  );

  repository.replaceVoiceEnrollmentSamples({
    personId: "person-a",
    modelId: MODEL_ID,
    samples: [vector(0, 1), vector(0, 1), vector(0, 1)],
    centroid: vector(0, 1),
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 1,
    updatedAt: 18000,
  });
  await assert.rejects(() => worker.run(queued.job), { code: "IDENTITY_RESOLUTION_SUPERSEDED" });
});

test("identity worker renews deterministically and yields after every fixed cluster batch", async () => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const identity = {
    sessionId: "session-batched-resolution",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const clusters = Array.from({ length: 17 }, (_value, index) => ({
    evidenceRunId: "evidence-run-batched",
    clusterId: `cluster-${String(index).padStart(2, "0")}`,
  }));
  const snapshot = Object.freeze({
    eligible: true,
    diarizationRevision: identity.diarizationRevision,
    profileRevision: identity.profileRevision,
    evidenceRunIds: Object.freeze(["evidence-run-batched"]),
    clusters: Object.freeze(clusters),
    samples: Object.freeze([]),
  });
  const persisted = [];
  const repository = {
    getSpeakerIdentityResolutionSnapshot: () => snapshot,
    listRejectedSpeakerPersonIds: () => [],
    applySystemSpeakerResolutions: (input) => {
      persisted.push(input);
      return input.results;
    },
  };
  let renewals = 0;
  let yields = 0;
  const worker = new SpeakerIdentityResolutionWorker({
    repository,
    resolver: {
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
      resolveCluster: ({ cluster }) => ({
        candidatePersonId: null,
        state: "unknown",
        score: null,
        margin: null,
        reason: cluster.clusterId,
      }),
    },
    yieldToEventLoop: async () => {
      yields += 1;
    },
  });

  const result = await worker.run(
    {
      job_type: "resolve_identities",
      session_id: identity.sessionId,
      track_id: null,
      chunk_id: null,
      input_hash: buildIdentityResolutionJobKey(identity),
      input_version: 1,
      model_version: identity.policyId,
    },
    {
      renewLease() {
        renewals += 1;
        return true;
      },
    }
  );

  assert.equal(result.executionDevice, "cpu");
  assert.equal(persisted[0].results.length, 17);
  assert.equal(renewals, 36);
  assert.equal(yields, 4);
});

test("identity worker propagates lease loss before another cluster or commit", async () => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const identity = {
    sessionId: "session-lease-loss",
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const snapshot = {
    eligible: true,
    diarizationRevision: identity.diarizationRevision,
    profileRevision: identity.profileRevision,
    evidenceRunIds: ["evidence-run-lease-loss"],
    clusters: [
      { evidenceRunId: "evidence-run-lease-loss", clusterId: "cluster-a" },
      { evidenceRunId: "evidence-run-lease-loss", clusterId: "cluster-b" },
    ],
    samples: [],
  };
  let resolvedClusters = 0;
  let commits = 0;
  const worker = new SpeakerIdentityResolutionWorker({
    repository: {
      getSpeakerIdentityResolutionSnapshot: () => snapshot,
      listRejectedSpeakerPersonIds: () => [],
      applySystemSpeakerResolutions: () => {
        commits += 1;
        return [];
      },
    },
    resolver: {
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
      resolveCluster: () => {
        resolvedClusters += 1;
        return {
          candidatePersonId: null,
          state: "unknown",
          score: null,
          margin: null,
          reason: "no_match",
        };
      },
    },
  });
  const leaseLost = Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST" });

  await assert.rejects(
    worker.run(
      {
        job_type: "resolve_identities",
        session_id: identity.sessionId,
        track_id: null,
        chunk_id: null,
        input_hash: buildIdentityResolutionJobKey(identity),
        input_version: 1,
        model_version: identity.policyId,
      },
      {
        renewLease: () => {
          throw leaseLost;
        },
      }
    ),
    { code: "JOB_LEASE_LOST" }
  );
  assert.equal(resolvedClusters, 1);
  assert.equal(commits, 0);
});

test("completed diarization remains resolvable after source audio retention expiry", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 1_000_000,
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });
  assert.equal(snapshot.eligible, true);
  assert.equal(snapshot.evidenceRunIds[0], "run-ready-0");

  repository.db
    .prepare(
      `
      INSERT INTO processing_jobs (
        id, session_id, track_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      ) VALUES (
        'newer-diarize-pending', 'session-ready', 'track-ready-0', 'diarize_track',
        'pending', 40, ?, 1, ?, 20000
      )
    `
    )
    .run(
      `diarize_track:session-ready:track-ready-0:${"a".repeat(64)}:${SESSION_DIARIZATION_POLICY.policyId}`,
      SESSION_DIARIZATION_POLICY.policyId
    );
  assert.equal(
    repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: "session-ready",
      at: 1_000_000,
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    }).reason,
    "diarization_incomplete"
  );
});

test("an obsolete blocked diarization older than the selected completed run does not deadlock", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  const completed = repository.db
    .prepare("SELECT * FROM processing_jobs WHERE id = 'diarize-0'")
    .get();
  repository.db.prepare("DELETE FROM processing_jobs WHERE id = 'diarize-0'").run();
  repository.db
    .prepare(
      `
      INSERT INTO processing_jobs (
        id, session_id, track_id, job_type, state, priority,
        input_hash, input_version, model_version, error_code, blocked_reason,
        created_at, completed_at
      ) VALUES (
        'obsolete-before-success', 'session-ready', 'track-ready-0', 'diarize_track',
        'blocked', 40, ?, 1, ?, 'DIARIZATION_SUPERSEDED', 'DIARIZATION_SUPERSEDED',
        99999, 99999
      )
    `
    )
    .run(
      `diarize_track:session-ready:track-ready-0:${"b".repeat(64)}:${SESSION_DIARIZATION_POLICY.policyId}`,
      SESSION_DIARIZATION_POLICY.policyId
    );
  repository.db
    .prepare(
      `
      INSERT INTO processing_jobs (
        id, session_id, track_id, job_type, state, priority,
        input_hash, input_version, model_version, attempt_count,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      completed.id,
      completed.session_id,
      completed.track_id,
      completed.job_type,
      completed.state,
      completed.priority,
      completed.input_hash,
      completed.input_version,
      completed.model_version,
      completed.attempt_count,
      1,
      1
    );
  assert.equal(
    repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: "session-ready",
      at: 1_000_000,
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    }).eligible,
    true
  );
});

test("session phase always attempts resolution enqueue after diarization scheduling", async () => {
  const { JarvisProcessingRuntime } = require("../../src/jarvis/main/JarvisProcessingRuntime");
  const calls = [];
  const repository = {
    listProcessingSessions: () => [],
    isSessionReadyForPostProcessing: () => true,
    markSessionProcessing: () => calls.push("mark"),
    enqueueDiarizationJobs: () => calls.push("diarize"),
    enqueueSpeakerIdentityResolutionJob: (_id, options) =>
      calls.push(`resolve:${options.diarizationPolicy.policyId}`),
    refreshSessionReadiness: (_id, _at, options) =>
      calls.push(`refresh:${options.diarizationPolicy.policyId}`),
  };
  const runtime = new JarvisProcessingRuntime({
    runner: { runOnce: async () => 0, recoverExpiredLeases: () => 0 },
    repository,
    reconciler: { reconcileSession: async () => calls.push("reconcile") },
    deduper: { dedupe: async () => calls.push("dedupe") },
    now: () => 100,
    diarizationPolicy: HYBRID_DIARIZATION_POLICY,
  });
  await runtime._runSessionPhase([{ id: "session-runtime", ended_at: 100 }], 0, 1, new Set());
  assert.deepEqual(calls, [
    "mark",
    "reconcile",
    "dedupe",
    "diarize",
    `resolve:${HYBRID_DIARIZATION_POLICY.policyId}`,
    `refresh:${HYBRID_DIARIZATION_POLICY.policyId}`,
  ]);
});

test("session phase schedules completed-track diarization before every track transcript is ready", async () => {
  const { JarvisProcessingRuntime } = require("../../src/jarvis/main/JarvisProcessingRuntime");
  const calls = [];
  const repository = {
    listProcessingSessions: () => [],
    isSessionReadyForPostProcessing: () => false,
    markSessionProcessing: () => calls.push("mark"),
    enqueueDiarizationJobs: () => calls.push("diarize"),
    enqueueSpeakerIdentityResolutionJob: () => calls.push("resolve"),
    refreshSessionReadiness: () => calls.push("refresh"),
  };
  const runtime = new JarvisProcessingRuntime({
    runner: { runOnce: async () => 0, recoverExpiredLeases: () => 0 },
    repository,
    reconciler: { reconcileSession: async () => calls.push("reconcile") },
    deduper: { dedupe: async () => calls.push("dedupe") },
    now: () => 100,
    diarizationPolicy: HYBRID_DIARIZATION_POLICY,
  });

  await runtime._runSessionPhase([{ id: "session-partial", ended_at: 100 }], 0, 1, new Set());

  assert.deepEqual(calls, ["mark", "diarize"]);
});

test("identity resolution can enqueue from the selected hybrid diarization policy", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  const run = repository.db
    .prepare("SELECT * FROM speaker_diarization_runs WHERE session_id = 'session-ready'")
    .get();
  const hybridKey = buildDiarizationJobKey({
    sessionId: run.session_id,
    trackId: run.track_id,
    evidenceRevision: run.transcript_revision,
    policyId: HYBRID_DIARIZATION_POLICY.policyId,
  });
  repository.db
    .prepare(
      `UPDATE speaker_diarization_runs
       SET policy_id = ?, input_version = ?
       WHERE id = ?`
    )
    .run(HYBRID_DIARIZATION_POLICY.policyId, HYBRID_DIARIZATION_POLICY.inputVersion, run.id);
  repository.db
    .prepare(
      `UPDATE processing_jobs
       SET input_hash = ?, input_version = ?, model_version = ?
       WHERE session_id = 'session-ready' AND job_type = 'diarize_track'`
    )
    .run(hybridKey, HYBRID_DIARIZATION_POLICY.inputVersion, HYBRID_DIARIZATION_POLICY.policyId);

  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", {
    at: 16_000,
    diarizationPolicy: HYBRID_DIARIZATION_POLICY,
  });

  assert.equal(queued.reason, null);
  assert.equal(queued.enqueued, 1);
});

test("startup readiness reconciliation preserves a ready hybrid-policy session", (t) => {
  const { repository, runIds, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  repository.renamePerson({ personId: "person-a", displayName: "person-a" });
  const run = repository.db
    .prepare("SELECT * FROM speaker_diarization_runs WHERE session_id = 'session-ready'")
    .get();
  const hybridKey = buildDiarizationJobKey({
    sessionId: run.session_id,
    trackId: run.track_id,
    evidenceRevision: run.transcript_revision,
    policyId: HYBRID_DIARIZATION_POLICY.policyId,
  });
  repository.db
    .prepare(
      `UPDATE speaker_diarization_runs
       SET policy_id = ?, input_version = ?
       WHERE id = ?`
    )
    .run(HYBRID_DIARIZATION_POLICY.policyId, HYBRID_DIARIZATION_POLICY.inputVersion, run.id);
  repository.db
    .prepare(
      `UPDATE processing_jobs
       SET input_hash = ?, input_version = ?, model_version = ?
       WHERE session_id = 'session-ready' AND job_type = 'diarize_track'`
    )
    .run(hybridKey, HYBRID_DIARIZATION_POLICY.inputVersion, HYBRID_DIARIZATION_POLICY.policyId);
  const identity = repository.enqueueSpeakerIdentityResolutionJob("session-ready", {
    at: 16_000,
    diarizationPolicy: HYBRID_DIARIZATION_POLICY,
  });
  const snapshot = repository.getSpeakerIdentityResolutionSnapshot({
    sessionId: "session-ready",
    at: 16_000,
    diarizationPolicy: HYBRID_DIARIZATION_POLICY,
  });
  repository.applySystemSpeakerResolutions({
    id: "hybrid-ready-resolution",
    sessionId: "session-ready",
    diarizationRevision: snapshot.diarizationRevision,
    profileRevision: snapshot.profileRevision,
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
    evidenceRunIds: runIds,
    results: clusters.map(({ clusterId, runId }) => ({
      evidenceRunId: runId,
      clusterId,
      candidatePersonId: null,
      state: "unknown",
      score: null,
      margin: null,
      reason: "no_candidate",
    })),
    at: 16_000,
  });
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 16000 WHERE id = ?")
    .run(identity.job.id);
  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 16000 WHERE id = 'session-ready'"
    )
    .run();

  assert.deepEqual(
    repository.reconcileHistoricalSpeakerReadiness(18_000, {
      diarizationPolicy: HYBRID_DIARIZATION_POLICY,
    }),
    {
      inspected: 1,
      woken: 0,
      ready: 1,
      processing: 0,
    }
  );
});

test("profile changes wake ready historical sessions and create one new revision job", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  repository.renamePerson({ personId: "person-a", displayName: "person-a" });
  const first = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 16000 WHERE id = ?")
    .run(first.job.id);
  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 16000 WHERE id = 'session-ready'"
    )
    .run();

  repository.replaceVoiceEnrollmentSamples({
    personId: "person-a",
    modelId: MODEL_ID,
    samples: [vector(0, 1), vector(0, 1), vector(0, 1)],
    centroid: vector(0, 1),
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 1,
    updatedAt: 17000,
  });
  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'session-ready'")
      .get(),
    { processing_state: "processing", ready_at: null }
  );
  const changed = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 18000 });
  const repeated = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 18000 });
  assert.equal(changed.enqueued, 1);
  assert.equal(repeated.enqueued, 0);
  assert.notEqual(changed.job.input_hash, first.job.input_hash);
});

test("a dual-model enrollment wakes historical diarization created in the legacy model space", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  repository.renamePerson({ personId: "self", displayName: "我", isSelf: true });
  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 16000 WHERE id = 'session-ready'"
    )
    .run();

  repository.addVoiceProfileSample({
    id: "dual-primary-self",
    personId: "self",
    modelId: PRIMARY_MODEL.modelId,
    embedding: primaryVector(1),
    sourceKind: "enrollment",
    sourceClusterId: null,
    speechMs: 10_000,
    windowCount: 1,
    createdAt: 17_000,
  });

  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'session-ready'")
      .get(),
    { processing_state: "processing", ready_at: null }
  );
});

test("startup readiness reconciliation repairs a stale ready session after profile changes", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  repository.renamePerson({ personId: "person-a", displayName: "person-a" });
  const first = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16_000 });
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 16000 WHERE id = ?")
    .run(first.job.id);
  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 16000 WHERE id = 'session-ready'"
    )
    .run();
  repository.addVoiceProfileSample({
    id: "dual-primary-person-a",
    personId: "person-a",
    modelId: PRIMARY_MODEL.modelId,
    embedding: primaryVector(1),
    sourceKind: "enrollment",
    sourceClusterId: null,
    speechMs: 10_000,
    windowCount: 1,
    createdAt: 17_000,
  });
  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 16000 WHERE id = 'session-ready'"
    )
    .run();

  assert.deepEqual(repository.reconcileHistoricalSpeakerReadiness(18_000), {
    inspected: 1,
    woken: 1,
    ready: 0,
    processing: 1,
  });
  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'session-ready'")
      .get(),
    { processing_state: "processing", ready_at: null }
  );
});

test("profile sample persistence and historical-session wake are one transaction", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  repository.renamePerson({ personId: "person-atomic", displayName: "Atomic" });
  repository.db.exec(`
    UPDATE sessions SET processing_state = 'ready', ready_at = 16000
    WHERE id = 'session-ready';
    CREATE TRIGGER reject_identity_profile_wake
    BEFORE UPDATE OF processing_state ON sessions
    WHEN NEW.id = 'session-ready' AND NEW.processing_state = 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'wake rejected');
    END;
  `);
  assert.throws(
    () =>
      repository.addVoiceProfileSample({
        id: "atomic-profile",
        personId: "person-atomic",
        modelId: MODEL_ID,
        embedding: vector(1),
        sourceKind: "enrollment",
        sourceClusterId: null,
        speechMs: 10_000,
        windowCount: 1,
        createdAt: 17000,
      }),
    /wake rejected/
  );
  assert.equal(
    repository.db
      .prepare("SELECT count(*) AS count FROM voice_profile_samples WHERE id = 'atomic-profile'")
      .get().count,
    0
  );
});

test("undo profile mutation and session wake roll back together on wake failure", (t) => {
  const repository = fixture(t);
  repository.renamePerson({ personId: "person-undo", displayName: "Undo" });
  repository.confirmSpeakerLink({
    clusterId: "cluster-resolution",
    personId: "person-undo",
    scope: "persistent",
    actor: "user",
  });
  repository.db.exec(`
    UPDATE sessions
    SET status = 'completed', ended_at = 20000, processing_state = 'ready', ready_at = 20000
    WHERE id = 'session-resolution';
    CREATE TRIGGER reject_identity_undo_wake
    BEFORE UPDATE OF processing_state ON sessions
    WHEN NEW.id = 'session-resolution' AND NEW.processing_state = 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'undo wake rejected');
    END;
  `);
  assert.throws(() => repository.undoSpeakerCorrection("cluster-resolution"), /undo wake rejected/);
  assert.equal(repository.getSpeakerCluster("cluster-resolution").linkState, "confirmed");
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM voice_profile_samples WHERE source_cluster_id = 'cluster-resolution'"
      )
      .get().count,
    1
  );
  assert.equal(repository.listSpeakerCorrections("cluster-resolution")[0].undoneAt, null);
});

test("self flag changes wake affected profile models while display-only rename does not", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "old-self", embedding: vector(1) });
  addPersonAndSample(repository, { personId: "new-self", embedding: vector(0, 1) });
  repository.db.exec(`
    UPDATE people SET is_self = CASE id WHEN 'old-self' THEN 1 ELSE 0 END;
    UPDATE sessions SET processing_state = 'ready', ready_at = 16000
    WHERE id = 'session-ready';
  `);

  repository.renamePerson({ personId: "new-self", isSelf: true });
  assert.deepEqual(
    repository.db
      .prepare("SELECT id, is_self FROM people WHERE id IN ('old-self','new-self') ORDER BY id")
      .all(),
    [
      { id: "new-self", is_self: 1 },
      { id: "old-self", is_self: 0 },
    ]
  );
  assert.equal(repository.getSession("session-ready").processing_state, "processing");

  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 17000 WHERE id = 'session-ready'"
    )
    .run();
  repository.renamePerson({ personId: "new-self", isSelf: false });
  assert.equal(repository.getSession("session-ready").processing_state, "processing");

  repository.db
    .prepare(
      "UPDATE sessions SET processing_state = 'ready', ready_at = 18000 WHERE id = 'session-ready'"
    )
    .run();
  repository.renamePerson({ personId: "new-self", displayName: "Only a name" });
  assert.equal(repository.getSession("session-ready").processing_state, "ready");
});

test("self transfer and historical-session wake roll back together on wake failure", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "old-self", embedding: vector(1) });
  addPersonAndSample(repository, { personId: "new-self", embedding: vector(0, 1) });
  repository.db.exec(`
    UPDATE people SET is_self = CASE id WHEN 'old-self' THEN 1 ELSE 0 END;
    UPDATE sessions SET processing_state = 'ready', ready_at = 19000
    WHERE id = 'session-ready';
    CREATE TRIGGER reject_identity_self_wake
    BEFORE UPDATE OF processing_state ON sessions
    WHEN NEW.id = 'session-ready' AND NEW.processing_state = 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'self wake rejected');
    END;
  `);

  assert.throws(
    () => repository.renamePerson({ personId: "new-self", isSelf: true }),
    /self wake rejected/
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT id, is_self FROM people WHERE id IN ('old-self','new-self') ORDER BY id")
      .all(),
    [
      { id: "new-self", is_self: 0 },
      { id: "old-self", is_self: 1 },
    ]
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'session-ready'")
      .get(),
    { processing_state: "ready", ready_at: 19000 }
  );
});

test("merge profile mutation and historical-session wake roll back together", (t) => {
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "merge-source", embedding: vector(1) });
  addPersonAndSample(repository, { personId: "merge-target", embedding: vector(0, 1) });
  repository.db
    .prepare(
      "UPDATE speaker_clusters SET person_id = 'merge-source', link_state = 'confirmed' WHERE id = ?"
    )
    .run(clusters[0].clusterId);
  repository.db.exec(`
    UPDATE sessions SET processing_state = 'ready', ready_at = 20000
    WHERE id = 'session-ready';
    CREATE TRIGGER reject_identity_merge_wake
    BEFORE UPDATE OF processing_state ON sessions
    WHEN NEW.id = 'session-ready' AND NEW.processing_state = 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'merge wake rejected');
    END;
  `);

  assert.throws(
    () =>
      repository.mergeSpeakerPeople({
        sourcePersonId: "merge-source",
        targetPersonId: "merge-target",
      }),
    /merge wake rejected/
  );
  assert.ok(repository.db.prepare("SELECT 1 FROM people WHERE id = 'merge-source'").get());
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM voice_profile_samples WHERE person_id = 'merge-source'"
      )
      .get().count,
    1
  );
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).personId, "merge-source");
  assert.deepEqual(
    repository.db
      .prepare("SELECT processing_state, ready_at FROM sessions WHERE id = 'session-ready'")
      .get(),
    { processing_state: "ready", ready_at: 20000 }
  );
});

test("readiness stays processing through diarization and resolution, then becomes ready", async (t) => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  let refreshed = repository.refreshSessionReadiness("session-ready", 16000);
  assert.equal(refreshed.processing_state, "processing");
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  refreshed = repository.refreshSessionReadiness("session-ready", 16000);
  assert.equal(refreshed.processing_state, "processing");
  const worker = new SpeakerIdentityResolutionWorker({ repository, clock: () => 17000 });
  await worker.run(queued.job);
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 17000 WHERE id = ?")
    .run(queued.job.id);
  refreshed = repository.refreshSessionReadiness("session-ready", 17000);
  assert.equal(refreshed.processing_state, "ready");
});

test("terminal diarization failure degrades speaker evidence without trapping a complete transcript", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1, completeTracks: 0 });

  let refreshed = repository.refreshSessionReadiness("session-ready", 16_000);
  assert.equal(refreshed.processing_state, "processing");

  repository.db
    .prepare(
      `UPDATE processing_jobs
       SET state = 'blocked', error_code = 'DIARIZATION_VALIDATION_FAILED', completed_at = 16500
       WHERE session_id = 'session-ready' AND job_type = 'diarize_track'`
    )
    .run();
  refreshed = repository.refreshSessionReadiness("session-ready", 17_000);

  assert.equal(refreshed.processing_state, "ready");
  assert.equal(refreshed.ready_at, 17_000);
  assert.deepEqual(
    repository.listPendingJobs("session-ready").map((job) => job.error_code),
    ["DIARIZATION_VALIDATION_FAILED"]
  );
});

test("terminal identity failure remains visible but no longer blocks session readiness", (t) => {
  const { repository } = seedReadyEvidence(t, { trackCount: 1 });
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16_000 });
  repository.db
    .prepare(
      `UPDATE processing_jobs
       SET state = 'blocked', error_code = 'SQLITE_CONSTRAINT_PRIMARYKEY', completed_at = 16500
       WHERE id = ?`
    )
    .run(queued.job.id);

  const refreshed = repository.refreshSessionReadiness("session-ready", 17_000);

  assert.equal(refreshed.processing_state, "ready");
  assert.equal(refreshed.ready_at, 17_000);
  assert.equal(repository.listPendingJobs("session-ready")[0].id, queued.job.id);
});

test("worker revalidates again before commit and writes no stale partial batch", async (t) => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1) });
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  const pure = new SpeakerIdentityResolver();
  let changed = false;
  const worker = new SpeakerIdentityResolutionWorker({
    repository,
    clock: () => 17000,
    resolver: {
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
      resolveCluster(input) {
        const result = pure.resolveCluster(input);
        if (!changed) {
          changed = true;
          repository.replaceVoiceEnrollmentSamples({
            personId: "person-a",
            modelId: MODEL_ID,
            samples: [vector(0, 1), vector(0, 1), vector(0, 1)],
            centroid: vector(0, 1),
            acceptedSpeechMs: 30_000,
            windowCount: 3,
            selfConsistency: 1,
            updatedAt: 17000,
          });
        }
        return result;
      },
    },
  });
  await assert.rejects(() => worker.run(queued.job), {
    code: "IDENTITY_RESOLUTION_SUPERSEDED",
  });
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolution_runs").get()
      .count,
    0
  );
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM speaker_identity_resolutions").get().count,
    0
  );
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).linkState, "unknown");
});

test("rejecting the top candidate requeues the immutable job and resolves the next person", async (t) => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1, 0) });
  addPersonAndSample(repository, {
    personId: "person-b",
    embedding: vector(0.9, Math.sqrt(1 - 0.9 ** 2)),
  });
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  const worker = new SpeakerIdentityResolutionWorker({ repository, clock: () => 17000 });
  await worker.run(queued.job);
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 17000 WHERE id = ?")
    .run(queued.job.id);
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).personId, "person-a");

  repository.rejectSpeakerSuggestion({
    clusterId: clusters[0].clusterId,
    personId: "person-a",
  });
  const requeued = repository.db
    .prepare("SELECT * FROM processing_jobs WHERE id = ?")
    .get(queued.job.id);
  assert.equal(requeued.state, "pending");
  await worker.run(requeued);
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).personId, "person-b");
  assert.equal(
    repository
      .listSpeakerResolutionHistory(clusters[0].clusterId)
      .filter((row) => row.actor === "user").length,
    1
  );
});

test("a rejection racing resolution aborts stale projection and the retry selects B", async (t) => {
  const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
  const { repository, clusters } = seedReadyEvidence(t, { trackCount: 1 });
  addPersonAndSample(repository, { personId: "person-a", embedding: vector(1, 0) });
  addPersonAndSample(repository, {
    personId: "person-b",
    embedding: vector(0.9, Math.sqrt(1 - 0.9 ** 2)),
  });
  const queued = repository.enqueueSpeakerIdentityResolutionJob("session-ready", { at: 16000 });
  const firstWorker = new SpeakerIdentityResolutionWorker({ repository, clock: () => 17000 });
  await firstWorker.run(queued.job);
  repository.db
    .prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 17000 WHERE id = ?")
    .run(queued.job.id);

  const pure = new SpeakerIdentityResolver();
  let rejected = false;
  const racingWorker = new SpeakerIdentityResolutionWorker({
    repository,
    clock: () => 18000,
    resolver: {
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
      resolveCluster(input) {
        const decision = pure.resolveCluster(input);
        if (!rejected) {
          rejected = true;
          repository.rejectSpeakerSuggestion({
            clusterId: clusters[0].clusterId,
            personId: "person-a",
          });
        }
        return decision;
      },
    },
  });
  await assert.rejects(() => racingWorker.run(queued.job), {
    code: "IDENTITY_RESOLUTION_REJECTION_CHANGED",
  });
  assert.notEqual(repository.getSpeakerCluster(clusters[0].clusterId).linkState, "suggested");
  const requeued = repository.db
    .prepare("SELECT * FROM processing_jobs WHERE id = ?")
    .get(queued.job.id);
  await firstWorker.run(requeued);
  assert.equal(repository.getSpeakerCluster(clusters[0].clusterId).personId, "person-b");
  const history = repository.listSpeakerResolutionHistory(clusters[0].clusterId);
  assert.deepEqual(
    history.map((row) => [row.actor, row.candidatePersonRef, row.state]),
    [
      ["system", "person-b", "confirmed"],
      ["user", "person-a", "rejected"],
    ]
  );
});
