const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");
const {
  applyJarvisMigrations,
  TARGET_VERSION,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
} = require("../../src/jarvis/main/JarvisMigrations");

const TEST_SPEAKER_PROCESSING_POLICY = Object.freeze({ evaluate: (evidence) => evidence });

function finalSpeakerPolicy() {
  return new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: "whisper-v1",
  });
}

function getFinalSnapshot(repo, input) {
  return repo["getDiarizationEvidenceSnapshot"]({
    ...input,
    speakerProcessingPolicy: finalSpeakerPolicy(),
  });
}

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function seedFinalEvidence(repo) {
  repo.db.exec(`
    INSERT INTO sessions (
      id, started_at, ended_at, status, created_at, finalized_at, processing_state
    ) VALUES ('session-final', 1000, 5000, 'completed', 1000, 5000, 'processing');
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES ('track-mic', 'session-final', 'mic', 24000, 1, 1000, 5000, 'ended');
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES
      (
        'chunk-late', 'session-final', 'track-mic', 'mic', 1, 'late.wav',
        3000, 4000, 1000,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 10000,
        'no_speech', 'committed', 'wav', 24000, 1
      ),
      (
        'chunk-early', 'session-final', 'track-mic', 'mic', 0, 'early.wav',
        1000, 3000, 2000,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10000,
        'completed', 'committed', 'wav', 24000, 1
      );
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, created_at, completed_at
    ) VALUES
      (
        'job-early', 'session-final', 'track-mic', 'chunk-early',
        'transcribe_chunk', 'completed', 30,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        1, 'whisper-v1', 1, 2000, 4200
      ),
      (
        'job-late', 'session-final', 'track-mic', 'chunk-late',
        'transcribe_chunk', 'completed', 30,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        1, 'whisper-v1', 1, 3000, 4300
      );
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, speaker_label, text, confidence,
      is_stable, track_id, chunk_id, source_type, result_kind, version,
      model_version, completed_at
    ) VALUES (
      'segment-early', 'session-final', 1000, 3000, 'mic', 'hello world', 0.9,
      1, 'track-mic', 'chunk-early', 'mic', 'final', 1,
      'whisper-v1', 4200
    );
  `);
}

test("v21 creates revisioned diarization evidence with constrained foreign keys", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    applyJarvisMigrations(db, { now: () => 100 });

    assert.ok(TARGET_VERSION >= 22);
    assert.deepEqual(columns(db, "speaker_diarization_runs"), [
      "id",
      "session_id",
      "track_id",
      "transcript_revision",
      "policy_id",
      "diarizer_model_id",
      "embedding_model_id",
      "model_artifact_sha256",
      "embedding_dimension",
      "sample_rate",
      "input_version",
      "execution_device",
      "pipeline_metadata_json",
      "speaker_count_min",
      "speaker_count_max",
      "speaker_count_confidence",
      "overlap_ms",
      "overlap_separation_state",
      "model_pack_version",
      "commit_sequence",
      "created_at",
      "completed_at",
    ]);
    assert.deepEqual(columns(db, "speaker_diarization_run_clusters"), [
      "run_id",
      "cluster_id",
      "local_label",
      "embedding",
      "speech_ms",
      "window_count",
      "quality_score",
      "first_appearance_at",
    ]);
    assert.deepEqual(columns(db, "speaker_turns"), [
      "id",
      "run_id",
      "cluster_id",
      "chunk_id",
      "transcript_segment_id",
      "turn_index",
      "raw_label",
      "started_at",
      "ended_at",
      "embedding",
      "echo_state",
      "duplicate_of_turn_id",
      "excluded_from_centroid",
      "created_at",
    ]);
    assert.deepEqual(columns(db, "speaker_diarization_run_cluster_segments"), [
      "run_id",
      "cluster_id",
      "transcript_segment_id",
    ]);
    assert.deepEqual(
      db
        .prepare("PRAGMA foreign_key_list(speaker_diarization_run_cluster_segments)")
        .all()
        .map((row) => `${row.from}:${row.table}:${row.to}:${row.on_delete}`)
        .sort(),
      [
        "cluster_id:speaker_diarization_run_clusters:cluster_id:CASCADE",
        "run_id:speaker_diarization_run_clusters:run_id:CASCADE",
        "transcript_segment_id:transcript_segments:id:CASCADE",
      ]
    );
    assert.deepEqual(
      db
        .prepare("PRAGMA foreign_key_list(speaker_turns)")
        .all()
        .map((row) => `${row.from}:${row.table}:${row.on_delete}`)
        .sort(),
      [
        "chunk_id:audio_chunks:CASCADE",
        "cluster_id:speaker_clusters:CASCADE",
        "duplicate_of_turn_id:speaker_turns:SET NULL",
        "run_id:speaker_diarization_runs:CASCADE",
        "transcript_segment_id:transcript_segments:SET NULL",
      ]
    );
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_diarization_run_revision'"
        )
        .get()
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v21 upgrade preserves every v19 speaker cluster and transcript link", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    applyJarvisMigrations(db, { now: () => 100 });
    db.exec(transcriptSegmentsSchema("transcript_segments", { ifNotExists: true }));
    db.exec(TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS);
    db.exec(`
      INSERT INTO sessions (id, started_at, ended_at, status, created_at)
      VALUES ('s1', 10, 30, 'completed', 10);
      INSERT INTO audio_tracks (
        id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
      ) VALUES ('t1', 's1', 'mic', 24000, 1, 10, 30, 'ended');
      INSERT INTO audio_chunks (
        id, session_id, track_id, source_type, sequence_number, path,
        started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, write_state, format, sample_rate, channels
      ) VALUES (
        'c1', 's1', 't1', 'mic', 0, 'c1.wav',
        10, 30, 20, 'pcm-hash', 1000,
        'completed', 'committed', 'wav', 24000, 1
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, track_id, chunk_id, source_type, result_kind, version,
        model_version, completed_at
      ) VALUES (
        'seg1', 's1', 10, 30, 'mic', 'hello', 1,
        1, 't1', 'c1', 'mic', 'final', 1, 'whisper-v1', 40
      );
      INSERT INTO speaker_clusters (
        id, session_id, track_id, local_label, model_id, speech_ms,
        window_count, link_state, created_at, updated_at
      ) VALUES (
        'cluster1', 's1', 't1', 'speaker_1', 'legacy-model', 2000,
        1, 'unknown', 50, 50
      );
      INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
      VALUES ('cluster1', 'seg1');
      PRAGMA user_version = 19;
    `);

    const result = applyJarvisMigrations(db, { now: () => 200 });

    assert.deepEqual(result, { fromVersion: 19, toVersion: TARGET_VERSION });
    assert.deepEqual(db.prepare("SELECT id, local_label, model_id FROM speaker_clusters").all(), [
      { id: "cluster1", local_label: "speaker_1", model_id: "legacy-model" },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM speaker_cluster_segments").all(), [
      { cluster_id: "cluster1", transcript_segment_id: "seg1" },
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("diarization evidence snapshot is final-only, capture ordered, and revision stable", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalEvidence(repo);

  const first = getFinalSnapshot(repo, {
    sessionId: "session-final",
    trackId: "track-mic",
    at: 5000,
  });

  assert.equal(first.eligible, true);
  assert.equal(first.reason, null);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.chunks), true);
  assert.equal(Object.isFrozen(first.chunks[0]), true);
  assert.match(first.transcriptRevision, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    first.chunks.map((entry) => ({
      id: entry.audioChunk.id,
      result: entry.transcriptionResult,
      segmentIds: entry.transcriptSegments.map((segment) => segment.id),
    })),
    [
      { id: "chunk-early", result: "final", segmentIds: ["segment-early"] },
      { id: "chunk-late", result: "no_speech", segmentIds: [] },
    ]
  );

  repo.db.prepare("UPDATE processing_jobs SET completed_at = completed_at + 999").run();
  repo.db.prepare("UPDATE transcript_segments SET completed_at = completed_at + 777").run();
  const completionClockChanged = getFinalSnapshot(repo, {
    sessionId: "session-final",
    trackId: "track-mic",
    at: 5001,
  });
  assert.equal(completionClockChanged.transcriptRevision, first.transcriptRevision);

  repo.db
    .prepare("UPDATE transcript_segments SET text = 'hello revised' WHERE id = ?")
    .run("segment-early");
  const transcriptChanged = getFinalSnapshot(repo, {
    sessionId: "session-final",
    trackId: "track-mic",
    at: 5002,
  });
  assert.notEqual(transcriptChanged.transcriptRevision, first.transcriptRevision);
});

test("diarization evidence rejects provisional or nonterminal latest transcription", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalEvidence(repo);
  repo.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, attempt_count, created_at
      ) VALUES (
        'job-early-v2', 'session-final', 'track-mic', 'chunk-early',
        'transcribe_chunk', 'retry', 30,
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        2, 'whisper-v2', 1, 4500
      )`
    )
    .run();

  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-final",
    trackId: "track-mic",
    at: 5000,
  });

  assert.deepEqual(
    {
      eligible: snapshot.eligible,
      reason: snapshot.reason,
      evidenceRevision: snapshot.evidenceRevision,
    },
    {
      eligible: false,
      reason: "final_transcript_pending",
      evidenceRevision: null,
    }
  );
});

test("diarization evidence reports terminal retained audio expiry explicitly", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalEvidence(repo);

  const snapshot = getFinalSnapshot(repo, {
    sessionId: "session-final",
    trackId: "track-mic",
    at: 10_001,
  });

  assert.deepEqual(
    {
      eligible: snapshot.eligible,
      reason: snapshot.reason,
      evidenceRevision: snapshot.evidenceRevision,
    },
    { eligible: false, reason: "final_audio_expired", evidenceRevision: null }
  );
});

function unitEmbedding(index, secondaryIndex = null, secondaryValue = 0) {
  const vector = new Float32Array(512);
  vector[index] = 1;
  if (secondaryIndex !== null) vector[secondaryIndex] = secondaryValue;
  return vector;
}

function immutableWorkerSnapshot() {
  const snapshot = {
    eligible: true,
    reason: null,
    stableAudioRevision: "b".repeat(64),
    transcriptRevision: "c".repeat(64),
    evidenceRevision: "d".repeat(64),
    session: { id: "session-worker", started_at: 1000, ended_at: 9000, status: "completed" },
    track: {
      id: "track-worker",
      session_id: "session-worker",
      source_type: "mic",
      started_at: 1000,
      ended_at: 9000,
      state: "ended",
    },
    chunks: [
      {
        id: "chunk-1",
        session_id: "session-worker",
        track_id: "track-worker",
        source_type: "mic",
        started_at: 1000,
        ended_at: 5000,
        duration_ms: 4000,
        sha256: "1".repeat(64),
        transcriptionResult: "final",
        finalSegments: [{ id: "segment-1", started_at: 1000, ended_at: 5000, duplicate_of: null }],
      },
      {
        id: "chunk-2",
        session_id: "session-worker",
        track_id: "track-worker",
        source_type: "mic",
        started_at: 5000,
        ended_at: 9000,
        duration_ms: 4000,
        sha256: "2".repeat(64),
        transcriptionResult: "final",
        finalSegments: [{ id: "segment-2", started_at: 5000, ended_at: 9000, duplicate_of: null }],
      },
    ],
  };
  return Object.freeze(snapshot);
}

test("diarization job keys expose the combined evidence revision without changing serialization", () => {
  const {
    buildDiarizationJobKey,
    parseDiarizationJobKey,
  } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const evidenceRevision = "a".repeat(64);
  const legacySerialized = `diarize_track:session-worker:track-worker:${evidenceRevision}:jarvis-session-diarization-v1`;

  assert.equal(
    buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision,
    }),
    legacySerialized
  );
  assert.deepEqual(parseDiarizationJobKey(legacySerialized), {
    sessionId: "session-worker",
    trackId: "track-worker",
    evidenceRevision,
    policyId: "jarvis-session-diarization-v1",
  });
});

test("exports one immutable versioned diarization policy for the actual CPU models", () => {
  const { SESSION_DIARIZATION_POLICY } = require("../../src/jarvis/main/SessionDiarizationPolicy");

  assert.equal(Object.isFrozen(SESSION_DIARIZATION_POLICY), true);
  assert.deepEqual(SESSION_DIARIZATION_POLICY, {
    policyId: "jarvis-session-diarization-v1",
    diarizerModelId: "sherpa-segmentation+3dspeaker-campplus",
    embeddingModelId: "3dspeaker-campplus-voxceleb-16k-v1",
    embeddingDimension: 512,
    sampleRate: 16000,
    minimumEmbeddingMs: 1500,
    maximumEmbeddingMs: 8000,
    turnBoundaryToleranceMs: 100,
    inputVersion: 1,
    clusterSimilarityThreshold: 0.72,
    echoSimilarityThreshold: 0.95,
  });
});

test("worker preserves raw multi-turn evidence and clusters adjacent chunks by first appearance", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  const verified = [];
  let committed = null;
  let fetchCalls = 0;
  let leaseRenewals = 0;
  let artifactHashCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network forbidden");
  };
  try {
    const worker = new SessionDiarizationWorker({
      speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
      repository: {
        getDiarizationEvidenceSnapshot: () => snapshot,
        getDiarizationRun: () => null,
        listDiarizationEchoCandidates: () => [],
        commitDiarizationRun: (input) => {
          committed = input;
          return { status: "completed", runId: input.run.id };
        },
      },
      audioEvidenceReader: {
        withVerifiedWav: async (chunk, consume, options) => {
          verified.push({ id: chunk.id, options });
          return consume(`${chunk.id}.wav`);
        },
      },
      diarizeAudio: async ({ chunk }) =>
        chunk.id === "chunk-1"
          ? [
              { start: 0, end: 1.6, speaker: "raw_a" },
              { start: 1.8, end: 3.5, speaker: "raw_b" },
            ]
          : [{ start: 0.1, end: 1.9, speaker: "raw_other" }],
      embedWindow: async ({ chunk, turn }) => {
        if (chunk.id === "chunk-1" && turn.rawLabel === "raw_b") return unitEmbedding(1);
        return unitEmbedding(0, 2, 0.01);
      },
      modelArtifactSha256: async () => {
        artifactHashCalls += 1;
        return "a".repeat(64);
      },
      clock: () => 10_000,
    });
    const key = buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    });

    const result = await worker.run(
      {
        id: "job-diarize",
        session_id: "session-worker",
        track_id: "track-worker",
        input_hash: key,
        model_version: "jarvis-session-diarization-v1",
      },
      { renewLease: () => (leaseRenewals += 1) }
    );

    assert.deepEqual(result, { executionDevice: "cpu", status: "completed" });
    assert.deepEqual(verified, [
      { id: "chunk-1", options: { sampleRate: 16000, channels: 1 } },
      { id: "chunk-2", options: { sampleRate: 16000, channels: 1 } },
    ]);
    assert.equal(leaseRenewals, 15);
    assert.equal(fetchCalls, 0);
    assert.equal(artifactHashCalls, 1);
    assert.equal(committed.run.modelArtifactSha256, "a".repeat(64));
    assert.deepEqual(
      committed.clusters.map((cluster) => ({
        label: cluster.localLabel,
        windows: cluster.windowCount,
      })),
      [
        { label: "speaker_1", windows: 2 },
        { label: "speaker_2", windows: 1 },
      ]
    );
    assert.deepEqual(
      committed.turns.map((turn) => ({
        chunkId: turn.chunkId,
        rawLabel: turn.rawLabel,
        localLabel: turn.localLabel,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      })),
      [
        {
          chunkId: "chunk-1",
          rawLabel: "raw_a",
          localLabel: "speaker_1",
          startedAt: 1000,
          endedAt: 2600,
        },
        {
          chunkId: "chunk-1",
          rawLabel: "raw_b",
          localLabel: "speaker_2",
          startedAt: 2800,
          endedAt: 4500,
        },
        {
          chunkId: "chunk-2",
          rawLabel: "raw_other",
          localLabel: "speaker_1",
          startedAt: 5100,
          endedAt: 6900,
        },
      ]
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("worker globally consolidates a chunk-local cluster after its centroid converges", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let committed;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) =>
      chunk.id === "chunk-1"
        ? [{ start: 0, end: 1.6, speaker: "raw_a" }]
        : [
            { start: 0, end: 1.6, speaker: "raw_b" },
            { start: 1.8, end: 3.5, speaker: "raw_b" },
          ],
    embedWindow: async ({ chunk, turn }) =>
      chunk.id === "chunk-2" && turn.startMs === 0
        ? unitEmbedding(0, 1, 1.020204)
        : unitEmbedding(0),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run({
    id: "job-global-clustering",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.equal(committed.clusters.length, 1);
  assert.equal(committed.clusters[0].windowCount, 3);
  assert.deepEqual(
    [...new Set(committed.turns.map((turn) => turn.clusterId))],
    [committed.clusters[0].id]
  );
});

test("worker rejects invalid turn bounds and non-finite 512D embeddings before commit", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let commits = 0;
  let lastCommit = null;
  const createWorker = (diarizeAudio, embedWindow) =>
    new SessionDiarizationWorker({
      speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
      repository: {
        getDiarizationEvidenceSnapshot: () => snapshot,
        getDiarizationRun: () => null,
        listDiarizationEchoCandidates: () => [],
        commitDiarizationRun: (input) => {
          commits += 1;
          lastCommit = input;
        },
      },
      audioEvidenceReader: {
        withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
      },
      diarizeAudio,
      embedWindow,
      modelArtifactSha256: "a".repeat(64),
      clock: () => 10_000,
    });
  const key = buildDiarizationJobKey({
    sessionId: "session-worker",
    trackId: "track-worker",
    evidenceRevision: snapshot.evidenceRevision,
  });
  const job = {
    id: "job-diarize",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: key,
    model_version: "jarvis-session-diarization-v1",
  };

  await createWorker(
    async ({ chunk }) =>
      chunk.id === "chunk-1" ? [{ start: 2.5, end: 4.077, speaker: "raw" }] : [],
    async () => unitEmbedding(0)
  ).run(job);
  assert.equal(commits, 1);
  assert.equal(lastCommit.turns[0].endedAt, snapshot.chunks[0].ended_at);

  commits = 0;
  lastCommit = null;
  await assert.rejects(
    createWorker(
      async ({ chunk }) =>
        chunk.id === "chunk-1" ? [{ start: 2.5, end: 4.101, speaker: "raw" }] : [],
      async () => unitEmbedding(0)
    ).run(job),
    { code: "DIARIZATION_INVALID_TURN" }
  );

  await assert.rejects(
    createWorker(
      async () => [{ start: -1, end: 2, speaker: "raw" }],
      async () => unitEmbedding(0)
    ).run(job),
    { code: "DIARIZATION_INVALID_TURN" }
  );
  const invalid = unitEmbedding(0);
  invalid[0] = Number.NaN;
  await assert.rejects(
    createWorker(
      async () => [{ start: 0, end: 2, speaker: "raw" }],
      async () => invalid
    ).run(job),
    { code: "DIARIZATION_EMBEDDING_NONFINITE" }
  );
  assert.equal(commits, 0);
});

test("worker propagates every strict sidecar failure without committing an empty run", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let commits = 0;
  for (const code of [
    "DIARIZATION_BINARY_UNAVAILABLE",
    "DIARIZATION_MODEL_UNAVAILABLE",
    "DIARIZATION_SIDECAR_TIMEOUT",
    "DIARIZATION_SIDECAR_SPAWN_FAILED",
    "DIARIZATION_SIDECAR_EXIT_NONZERO",
  ]) {
    const worker = new SessionDiarizationWorker({
      speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
      repository: {
        getDiarizationEvidenceSnapshot: () => snapshot,
        getDiarizationRun: () => null,
        listDiarizationEchoCandidates: () => [],
        commitDiarizationRun: () => {
          commits += 1;
        },
      },
      audioEvidenceReader: {
        withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
      },
      diarizeAudio: async () => {
        const error = new Error("sidecar failed");
        error.code = code;
        throw error;
      },
      embedWindow: async () => assert.fail("sidecar failure ran embeddings"),
      modelArtifactSha256: "a".repeat(64),
    });
    await assert.rejects(
      worker.run({
        id: `job-${code}`,
        session_id: "session-worker",
        track_id: "track-worker",
        input_hash: buildDiarizationJobKey({
          sessionId: "session-worker",
          trackId: "track-worker",
          evidenceRevision: snapshot.evidenceRevision,
        }),
        model_version: "jarvis-session-diarization-v1",
      }),
      { code }
    );
  }
  assert.equal(commits, 0);
});

test("worker distinguishes expired and superseded durable evidence", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const revision = "a".repeat(64);
  const job = {
    id: "job-obsolete",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: revision,
    }),
    model_version: "jarvis-session-diarization-v1",
  };
  const createWorker = (snapshot) =>
    new SessionDiarizationWorker({
      speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
      repository: {
        getDiarizationEvidenceSnapshot: () => snapshot,
        getDiarizationRun: () => null,
        listDiarizationEchoCandidates: () => [],
        commitDiarizationRun: () => assert.fail("obsolete input committed"),
      },
      audioEvidenceReader: {
        withVerifiedWav: async () => assert.fail("obsolete input read audio"),
      },
      diarizeAudio: async () => assert.fail("obsolete input ran diarization"),
      embedWindow: async () => assert.fail("obsolete input ran embeddings"),
      modelArtifactSha256: "a".repeat(64),
    });

  await assert.rejects(
    createWorker({
      eligible: false,
      reason: "final_audio_expired",
      stableAudioRevision: null,
      transcriptRevision: null,
      evidenceRevision: null,
    }).run(job),
    { code: "DIARIZATION_AUDIO_EXPIRED" }
  );
  await assert.rejects(
    createWorker({
      eligible: true,
      reason: null,
      stableAudioRevision: "c".repeat(64),
      transcriptRevision: "d".repeat(64),
      evidenceRevision: "b".repeat(64),
      chunks: [],
    }).run(job),
    { code: "DIARIZATION_SUPERSEDED" }
  );
});

test("worker re-evaluates every evidence revision immediately before commit", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const evidenceRevision = "a".repeat(64);
  const first = {
    eligible: true,
    reason: null,
    stableAudioRevision: "b".repeat(64),
    transcriptRevision: "c".repeat(64),
    evidenceRevision,
    chunks: [],
  };
  const changedBeforeCommit = {
    ...first,
    stableAudioRevision: "d".repeat(64),
  };
  let reads = 0;
  const worker = new SessionDiarizationWorker({
    repository: {
      getDiarizationEvidenceSnapshot: () => (reads++ === 0 ? first : changedBeforeCommit),
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: () => assert.fail("changed evidence committed"),
    },
    speakerProcessingPolicy: Object.freeze({ evaluate: (evidence) => evidence }),
    audioEvidenceReader: {
      withVerifiedWav: async () => assert.fail("empty final evidence read audio"),
    },
    diarizeAudio: async () => assert.fail("empty final evidence ran diarization"),
    embedWindow: async () => assert.fail("empty final evidence ran embeddings"),
    modelArtifactSha256: "e".repeat(64),
    clock: () => 10_000,
  });

  await assert.rejects(
    worker.run({
      id: "job-precommit-cas",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: buildDiarizationJobKey({
        sessionId: "session-worker",
        trackId: "track-worker",
        evidenceRevision,
      }),
      model_version: "jarvis-session-diarization-v1",
    }),
    { code: "DIARIZATION_SUPERSEDED" }
  );
  assert.equal(reads, 2);
});

test("worker marks transcript-confirmed cross-track echo and excludes its centroid contribution", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const snapshot = {
    ...base,
    chunks: base.chunks.map((chunk, index) => ({
      ...chunk,
      finalSegments:
        index === 0
          ? [{ ...chunk.finalSegments[0], duplicate_of: "system-segment" }]
          : chunk.finalSegments,
    })),
  };
  let committed = null;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [
        {
          id: "system-turn",
          started_at: 1100,
          ended_at: 2800,
          transcript_segment_id: "system-segment",
          embedding: unitEmbedding(0),
        },
      ],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) =>
      chunk.id === "chunk-1" ? [{ start: 0.1, end: 1.8, speaker: "mic_echo" }] : [],
    embedWindow: async () => unitEmbedding(0),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });
  const key = buildDiarizationJobKey({
    sessionId: "session-worker",
    trackId: "track-worker",
    evidenceRevision: snapshot.evidenceRevision,
  });

  await worker.run({
    id: "job-echo",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: key,
    model_version: "jarvis-session-diarization-v1",
  });

  assert.deepEqual(
    {
      echoState: committed.turns[0].echoState,
      duplicateOfTurnId: committed.turns[0].duplicateOfTurnId,
      excludedFromCentroid: committed.turns[0].excludedFromCentroid,
      clusterWindows: committed.clusters[0].windowCount,
      clusterSpeechMs: committed.clusters[0].speechMs,
      clusterEmbedding: committed.clusters[0].embedding,
    },
    {
      echoState: "confirmed",
      duplicateOfTurnId: "system-turn",
      excludedFromCentroid: true,
      clusterWindows: 0,
      clusterSpeechMs: 0,
      clusterEmbedding: null,
    }
  );
});

test("worker returns an existing completed run before loading retained audio", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const revision = "e".repeat(64);
  let snapshots = 0;
  let artifacts = 0;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => {
        snapshots += 1;
        throw new Error("retained audio was already deleted");
      },
      getDiarizationRun: () => ({ id: "completed-run" }),
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: () => assert.fail("completed run was committed twice"),
    },
    audioEvidenceReader: {
      withVerifiedWav: async () => assert.fail("completed run reread audio"),
    },
    diarizeAudio: async () => assert.fail("completed run reran diarization"),
    embedWindow: async () => assert.fail("completed run reran embeddings"),
    modelArtifactSha256: async () => {
      artifacts += 1;
      return "a".repeat(64);
    },
  });

  const result = await worker.run({
    id: "job-existing",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: revision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.deepEqual(result, { executionDevice: "cpu", status: "already_completed" });
  assert.equal(snapshots, 0);
  assert.equal(artifacts, 0);
});

test("worker verifies every authoritative no-speech chunk and commits an empty completed run", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const snapshot = {
    ...base,
    chunks: base.chunks.map((chunk) => ({
      ...chunk,
      transcriptionResult: "no_speech",
      finalSegments: [],
    })),
  };
  const verified = [];
  let committed = null;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => {
        verified.push(chunk.id);
        return consume(`${chunk.id}.wav`);
      },
    },
    diarizeAudio: async () => assert.fail("no-speech evidence ran the diarizer"),
    embedWindow: async () => assert.fail("no-speech evidence ran embeddings"),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  const result = await worker.run({
    id: "job-no-speech",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.deepEqual(result, { executionDevice: "cpu", status: "completed" });
  assert.deepEqual(verified, ["chunk-1", "chunk-2"]);
  assert.deepEqual(committed.clusters, []);
  assert.deepEqual(committed.turns, []);
  assert.deepEqual(committed.segmentLinks, []);
});

test("worker preserves a short raw turn while padding only its embedding window", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let committed = null;
  let embeddedTurn = null;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) =>
      chunk.id === "chunk-1" ? [{ start: 0.2, end: 0.8, speaker: "short_turn" }] : [],
    embedWindow: async ({ turn }) => {
      embeddedTurn = turn;
      return unitEmbedding(0);
    },
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run({
    id: "job-short-turn",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.deepEqual(
    {
      rawStartMs: embeddedTurn.startMs,
      rawEndMs: embeddedTurn.endMs,
      embeddingStartMs: embeddedTurn.embeddingStartMs,
      embeddingEndMs: embeddedTurn.embeddingEndMs,
    },
    {
      rawStartMs: 200,
      rawEndMs: 800,
      embeddingStartMs: 0,
      embeddingEndMs: 1500,
    }
  );
  assert.deepEqual(
    {
      startedAt: committed.turns[0].startedAt,
      endedAt: committed.turns[0].endedAt,
      speechMs: committed.clusters[0].speechMs,
    },
    { startedAt: 1200, endedAt: 1800, speechMs: 600 }
  );
});

test("worker treats a chunk shorter than the minimum embedding window as empty speaker evidence", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const snapshot = {
    ...base,
    chunks: [
      {
        ...base.chunks[0],
        ended_at: base.chunks[0].started_at + 1_000,
        duration_ms: 1_000,
        finalSegments: [
          {
            ...base.chunks[0].finalSegments[0],
            ended_at: base.chunks[0].started_at + 1_000,
          },
        ],
      },
      {
        ...base.chunks[1],
        transcriptionResult: "no_speech",
        finalSegments: [],
      },
    ],
  };
  const verified = [];
  let committed = null;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => {
        verified.push(chunk.id);
        return consume(`${chunk.id}.wav`);
      },
    },
    diarizeAudio: async () => assert.fail("too-short evidence ran the diarizer"),
    embedWindow: async () => assert.fail("too-short evidence ran embeddings"),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  const result = await worker.run({
    id: "job-too-short",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.deepEqual(result, { executionDevice: "cpu", status: "completed" });
  assert.deepEqual(verified, ["chunk-1", "chunk-2"]);
  assert.deepEqual(committed.clusters, []);
  assert.deepEqual(committed.turns, []);
  assert.deepEqual(committed.segmentLinks, []);
});

test("worker sorts raw turns before assigning stable first-appearance labels and ids", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  const key = buildDiarizationJobKey({
    sessionId: "session-worker",
    trackId: "track-worker",
    evidenceRevision: snapshot.evidenceRevision,
  });
  const runWith = async (rawTurns) => {
    let committed;
    const worker = new SessionDiarizationWorker({
      speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
      repository: {
        getDiarizationEvidenceSnapshot: () => snapshot,
        getDiarizationRun: () => null,
        listDiarizationEchoCandidates: () => [],
        commitDiarizationRun: (input) => {
          committed = input;
          return { status: "completed", runId: input.run.id };
        },
      },
      audioEvidenceReader: {
        withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
      },
      diarizeAudio: async ({ chunk }) => (chunk.id === "chunk-1" ? rawTurns : []),
      embedWindow: async ({ turn }) =>
        turn.rawLabel === "earlier" ? unitEmbedding(0) : unitEmbedding(1),
      modelArtifactSha256: "a".repeat(64),
      clock: () => 10_000,
    });
    await worker.run({
      id: "job-deterministic",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: key,
      model_version: "jarvis-session-diarization-v1",
    });
    return {
      clusters: committed.clusters.map(({ id, localLabel, firstAppearanceAt }) => ({
        id,
        localLabel,
        firstAppearanceAt,
      })),
      turns: committed.turns.map(({ id, turnIndex, rawLabel, localLabel, startedAt }) => ({
        id,
        turnIndex,
        rawLabel,
        localLabel,
        startedAt,
      })),
    };
  };
  const earlier = { start: 0.1, end: 1.7, speaker: "earlier" };
  const later = { start: 2, end: 3.7, speaker: "later" };

  const first = await runWith([later, earlier]);
  const repeated = await runWith([earlier, later]);

  assert.deepEqual(first, repeated);
  assert.deepEqual(
    first.turns.map(({ rawLabel, localLabel, turnIndex }) => ({ rawLabel, localLabel, turnIndex })),
    [
      { rawLabel: "earlier", localLabel: "speaker_1", turnIndex: 0 },
      { rawLabel: "later", localLabel: "speaker_2", turnIndex: 1 },
    ]
  );
});

test("worker links a turn to every strictly overlapping final segment", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const snapshot = {
    ...base,
    chunks: [
      {
        ...base.chunks[0],
        finalSegments: [
          {
            id: "segment-first",
            started_at: 1000,
            ended_at: 2000,
            duplicate_of: "system-segment",
          },
          { id: "segment-second", started_at: 2000, ended_at: 5000, duplicate_of: null },
        ],
      },
      base.chunks[1],
    ],
  };
  let committed;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [
        {
          id: "system-turn",
          started_at: 1000,
          ended_at: 2000,
          transcript_segment_id: "system-segment",
          embedding: unitEmbedding(0),
        },
      ],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) =>
      chunk.id === "chunk-1" ? [{ start: 0.5, end: 2.5, speaker: "crossing" }] : [],
    embedWindow: async () => unitEmbedding(0),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run({
    id: "job-overlap",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.equal(committed.turns[0].transcriptSegmentId, "segment-second");
  assert.equal(committed.turns[0].echoState, "confirmed");
  assert.deepEqual(committed.segmentLinks.map((link) => link.transcriptSegmentId).sort(), [
    "segment-first",
    "segment-second",
  ]);
});

test("worker persists minimum centroid consistency instead of perfect synthetic quality", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let committed;
  let embeddingIndex = 0;
  const worker = new SessionDiarizationWorker({
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) =>
      chunk.id === "chunk-1"
        ? [
            { start: 0, end: 1.6, speaker: "same_raw_cluster" },
            { start: 2, end: 3.6, speaker: "same_raw_cluster" },
          ]
        : [],
    embedWindow: async () => unitEmbedding(embeddingIndex++),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run({
    id: "job-quality",
    session_id: "session-worker",
    track_id: "track-worker",
    input_hash: buildDiarizationJobKey({
      sessionId: "session-worker",
      trackId: "track-worker",
      evidenceRevision: snapshot.evidenceRevision,
    }),
    model_version: "jarvis-session-diarization-v1",
  });

  assert.ok(committed.clusters[0].qualityScore > 0.7);
  assert.ok(committed.clusters[0].qualityScore < 0.8);
  assert.notEqual(committed.clusters[0].qualityScore, 1);
});

test("v2 worker persists CUDA count consensus and overlap separation metadata", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let committed;
  const worker = new SessionDiarizationWorker({
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk, executionContext }) => {
      assert.equal(executionContext.device, "cuda");
      const turns = [{ start: 0, end: 1.6, speaker: `raw_${chunk.id}` }];
      Object.defineProperty(turns, "metadata", {
        value: {
          schemaVersion: 1,
          speakerCount:
            chunk.id === "chunk-1"
              ? { minimum: 1, maximum: 2, preferred: 1, confidence: 0.55, state: "models_disagree" }
              : { minimum: 1, maximum: 1, preferred: 1, confidence: 0.94, state: "models_agree" },
          overlapWindows: chunk.id === "chunk-1" ? [{ startMs: 400, endMs: 1400 }] : [],
          overlapSeparation: {
            state: chunk.id === "chunk-1" ? "completed" : "not_needed",
          },
        },
      });
      return turns;
    },
    embedWindow: async () => unitEmbedding(0),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });
  const result = await worker.run(
    {
      id: "job-hybrid",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: buildDiarizationJobKey({
        sessionId: "session-worker",
        trackId: "track-worker",
        evidenceRevision: snapshot.evidenceRevision,
        policyId: HYBRID_DIARIZATION_POLICY.policyId,
      }),
      model_version: HYBRID_DIARIZATION_POLICY.policyId,
    },
    { device: "cuda", renewLease: () => true, checkResources: async () => true }
  );

  assert.deepEqual(result, { executionDevice: "cuda", status: "completed" });
  assert.equal(committed.run.modelPackVersion, HYBRID_DIARIZATION_POLICY.modelPackVersion);
  assert.deepEqual(committed.run.speakerCount, {
    minimum: 1,
    maximum: 2,
    preferred: 1,
    confidence: 0.55,
    state: "models_disagree",
  });
  assert.equal(committed.run.overlapMs, 1000);
  assert.equal(committed.run.overlapSeparationState, "completed");
  assert.equal(committed.run.pipelineMetadata.chunks.length, 2);
  const legacyClusterId = `speaker_cluster_${crypto
    .createHash("sha256")
    .update(["session-worker", "track-worker", "speaker_1"].join("\0"))
    .digest("hex")
    .slice(0, 24)}`;
  assert.notEqual(
    committed.clusters[0].id,
    legacyClusterId,
    "hybrid reprocessing must not reuse a legacy cluster primary key"
  );
  const legacyTurnId = `speaker_turn_${crypto
    .createHash("sha256")
    .update([snapshot.evidenceRevision, "chunk-1", "0"].join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
  assert.notEqual(
    committed.turns[0].id,
    legacyTurnId,
    "hybrid reprocessing must not reuse a legacy speaker-turn primary key"
  );
});

test("v2 worker keeps overlap speech out of durable identity centroids", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let committed;
  const worker = new SessionDiarizationWorker({
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) => {
      if (chunk.id !== "chunk-1") return [];
      const turns = [
        { start: 0, end: 1.6, speaker: "S1" },
        { start: 0.5, end: 1.5, speaker: "S2" },
        { start: 2, end: 3.6, speaker: "S1" },
      ];
      Object.defineProperty(turns, "metadata", {
        value: {
          speakerCount: {
            minimum: 2,
            maximum: 2,
            preferred: 2,
            confidence: 0.9,
            state: "models_agree",
          },
          overlapWindows: [{ startMs: 400, endMs: 1_700 }],
          overlapSeparation: { state: "completed", processed: 1, total: 1 },
        },
      });
      return turns;
    },
    embedWindow: async ({ turn }) => unitEmbedding(turn.rawLabel === "S1" ? 0 : 1),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run(
    {
      id: "job-overlap-centroid",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: buildDiarizationJobKey({
        sessionId: "session-worker",
        trackId: "track-worker",
        evidenceRevision: snapshot.evidenceRevision,
        policyId: HYBRID_DIARIZATION_POLICY.policyId,
      }),
      model_version: HYBRID_DIARIZATION_POLICY.policyId,
    },
    { device: "cuda", renewLease: () => true, checkResources: async () => true }
  );

  const byLabel = new Map(committed.clusters.map((cluster) => [cluster.localLabel, cluster]));
  assert.equal(byLabel.get("speaker_1").windowCount, 1);
  assert.equal(byLabel.get("speaker_2").windowCount, 0);
  assert.equal(committed.turns.filter((turn) => turn.overlapExcludedFromCentroid).length, 2);
  assert.equal(committed.run.pipelineMetadata.chunks[0].overlapCentroidExcludedTurns, 2);
});

test("v2 worker reports only durable long-session speakers instead of overlap and brief fragments", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const snapshot = {
    ...base,
    chunks: base.chunks.map((chunk, index) => ({
      audioChunk: {
        ...chunk,
        started_at: 1_000 + index * 600_000,
        ended_at: 1_000 + (index + 1) * 600_000,
        duration_ms: 600_000,
      },
      latestTranscriptionJob: { id: `transcription-${chunk.id}` },
      transcriptSegments: [],
      transcriptionResult: "final",
    })),
  };
  let committed;
  const worker = new SessionDiarizationWorker({
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async ({ chunk }) => {
      const turns =
        chunk.id === "chunk-1"
          ? [
              { start: 0, end: 2, speaker: "S1" },
              { start: 3, end: 5, speaker: "S1" },
              { start: 6, end: 8, speaker: "S1" },
              { start: 10, end: 12, speaker: "brief" },
              { start: 20, end: 22, speaker: "overlap-a" },
              { start: 20.5, end: 21.5, speaker: "overlap-b" },
            ]
          : [];
      Object.defineProperty(turns, "metadata", {
        value: {
          schemaVersion: 1,
          speakerCount: {
            minimum: 1,
            maximum: 4,
            preferred: 2,
            confidence: 0.55,
            state: "models_disagree",
          },
          overlapWindows: chunk.id === "chunk-1" ? [{ startMs: 20_000, endMs: 22_000 }] : [],
          overlapSeparation: { state: "completed" },
        },
      });
      return turns;
    },
    embedWindow: async ({ turn }) =>
      unitEmbedding(turn.rawLabel === "S1" || turn.rawLabel.startsWith("overlap") ? 0 : 1),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run(
    {
      id: "job-long-speaker-confidence",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: buildDiarizationJobKey({
        sessionId: "session-worker",
        trackId: "track-worker",
        evidenceRevision: snapshot.evidenceRevision,
        policyId: HYBRID_DIARIZATION_POLICY.policyId,
      }),
      model_version: HYBRID_DIARIZATION_POLICY.policyId,
    },
    { device: "cuda", renewLease: () => true, checkResources: async () => true }
  );

  assert.deepEqual(committed.run.speakerCount, {
    minimum: 1,
    maximum: 1,
    preferred: 1,
    confidence: 0.55,
    state: "evidence_filtered",
  });
  assert.deepEqual(committed.run.pipelineMetadata.speakerCandidates, {
    total: 4,
    durable: 1,
    brief: 1,
    overlapOnly: 2,
  });
});

test("v2 worker bounds long-session pipeline metadata without dropping speaker evidence", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
  const base = immutableWorkerSnapshot();
  const chunks = Array.from({ length: 470 }, (_, index) => ({
    ...base.chunks[0],
    id: `chunk-${index + 1}`,
    started_at: 1_000 + index * 60_000,
    ended_at: 1_000 + (index + 1) * 60_000,
    duration_ms: 60_000,
    sha256: crypto
      .createHash("sha256")
      .update(`chunk-${index + 1}`)
      .digest("hex"),
    finalSegments: [],
  }));
  const snapshot = { ...base, chunks };
  let committed;
  const worker = new SessionDiarizationWorker({
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: (input) => {
        committed = input;
        return { status: "completed", runId: input.run.id };
      },
    },
    audioEvidenceReader: {
      withVerifiedWav: async (chunk, consume) => consume(`${chunk.id}.wav`),
    },
    diarizeAudio: async () => {
      const turns = [];
      Object.defineProperty(turns, "metadata", {
        value: {
          schemaVersion: 1,
          stage: "final",
          pipeline: HYBRID_DIARIZATION_POLICY.policyId,
          executionDevice: "cuda",
          speakerCount: {
            minimum: 0,
            maximum: 0,
            preferred: 0,
            confidence: 1,
            state: "models_agree",
          },
          overlapWindows: Array.from({ length: 200 }, (_, index) => ({
            startMs: index * 200,
            endMs: index * 200 + 100,
          })),
          overlapSeparation: { state: "completed", processed: 200, total: 200 },
          models: { primary: "primary", verifier: "verifier", separator: "separator" },
        },
      });
      return turns;
    },
    embedWindow: async () => assert.fail("empty turns do not require embeddings"),
    modelArtifactSha256: "a".repeat(64),
    clock: () => 10_000,
  });

  await worker.run(
    {
      id: "job-long-session",
      session_id: "session-worker",
      track_id: "track-worker",
      input_hash: buildDiarizationJobKey({
        sessionId: "session-worker",
        trackId: "track-worker",
        evidenceRevision: snapshot.evidenceRevision,
        policyId: HYBRID_DIARIZATION_POLICY.policyId,
      }),
      model_version: HYBRID_DIARIZATION_POLICY.policyId,
    },
    { device: "cuda", renewLease: () => true, checkResources: async () => true }
  );

  assert.equal(committed.run.pipelineMetadata.chunksTotal, 470);
  assert.equal(committed.run.pipelineMetadata.chunks.length, 96);
  assert.equal(committed.run.pipelineMetadata.chunksOmitted, 374);
  assert.equal(committed.run.pipelineMetadata.chunks[0].overlapWindows.length, 16);
  assert.equal(committed.run.pipelineMetadata.chunks[0].overlapWindowsOmitted, 184);
  assert.ok(Buffer.byteLength(JSON.stringify(committed.run.pipelineMetadata), "utf8") < 256 * 1024);
  assert.deepEqual(committed.clusters, []);
  assert.deepEqual(committed.turns, []);
});

test("v2 worker releases loaded models before yielding to a newly busy GPU", async () => {
  const SessionDiarizationWorker = require("../../src/jarvis/main/SessionDiarizationWorker");
  const { buildDiarizationJobKey } = require("../../src/jarvis/main/SessionDiarizationPolicy");
  const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
  const snapshot = immutableWorkerSnapshot();
  let releases = 0;
  const worker = new SessionDiarizationWorker({
    policy: HYBRID_DIARIZATION_POLICY,
    speakerProcessingPolicy: TEST_SPEAKER_PROCESSING_POLICY,
    repository: {
      getDiarizationEvidenceSnapshot: () => snapshot,
      getDiarizationRun: () => null,
      listDiarizationEchoCandidates: () => [],
      commitDiarizationRun: () => assert.fail("yielded work must not commit"),
    },
    audioEvidenceReader: {
      withVerifiedWav: async () => assert.fail("resource checkpoint runs before reading audio"),
    },
    diarizeAudio: async () => [],
    embedWindow: async () => unitEmbedding(0),
    modelArtifactSha256: "a".repeat(64),
    releaseResources: async () => {
      releases += 1;
    },
    clock: () => 10_000,
  });
  const busy = new Error("JOB_RESOURCE_YIELD");
  busy.code = "JOB_RESOURCE_YIELD";
  await assert.rejects(
    worker.run(
      {
        id: "job-yield",
        session_id: "session-worker",
        track_id: "track-worker",
        input_hash: buildDiarizationJobKey({
          sessionId: "session-worker",
          trackId: "track-worker",
          evidenceRevision: snapshot.evidenceRevision,
          policyId: HYBRID_DIARIZATION_POLICY.policyId,
        }),
        model_version: HYBRID_DIARIZATION_POLICY.policyId,
      },
      {
        device: "cuda",
        renewLease: () => true,
        checkResources: async () => {
          throw busy;
        },
      }
    ),
    /JOB_RESOURCE_YIELD/
  );
  assert.equal(releases, 1);
});

test("embedding normalization accepts an unaligned Buffer view", () => {
  const { normalizeEmbedding } = require("../../src/jarvis/main/SessionDiarizationWorker");
  const backing = Buffer.alloc(512 * 4 + 1);
  const unaligned = backing.subarray(1);
  unaligned.writeFloatLE(1, 0);

  const normalized = normalizeEmbedding(unaligned, 512);

  assert.equal(normalized.length, 512);
  assert.equal(normalized[0], 1);
});
