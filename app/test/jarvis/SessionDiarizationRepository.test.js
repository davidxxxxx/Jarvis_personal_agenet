const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("../../src/jarvis/main/SessionDiarizationPolicy");

function vector(index) {
  const value = new Float32Array(512);
  value[index] = 1;
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
  return repo.getDiarizationEvidenceSnapshot({
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
  });
}

function commitInput(snapshot, suffix = "one") {
  const clusterId = "speaker_cluster_session_cas_1";
  return {
    expectedRevision: snapshot.transcriptRevision,
    validatedAt: 6000,
    run: {
      id: `diarization_run_${suffix}`,
      sessionId: "session-cas",
      trackId: "track-cas",
      transcriptRevision: snapshot.transcriptRevision,
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
  const revisedSnapshot = repo.getDiarizationEvidenceSnapshot({
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
  const snapshot = repo.getDiarizationEvidenceSnapshot({
    sessionId: "session-cas",
    trackId: "track-cas",
    at: 6000,
  });
  const input = commitInput(snapshot, "cross_chunk");
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
  const expectedKey = buildDiarizationJobKey({
    sessionId: "session-cas",
    trackId: "track-cas",
    transcriptRevision: snapshot.transcriptRevision,
  });

  const first = repo.enqueueDiarizationJobs("session-cas", {
    at: 6000,
    policy: SESSION_DIARIZATION_POLICY,
  });
  const repeated = repo.enqueueDiarizationJobs("session-cas", {
    at: 6001,
    policy: SESSION_DIARIZATION_POLICY,
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
      priority: 40,
      input_hash: expectedKey,
      input_version: 1,
      model_version: "jarvis-session-diarization-v1",
      session_id: "session-cas",
      track_id: "track-cas",
      chunk_id: null,
    }
  );
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
    repo.enqueueDiarizationJobs("session-cas", {
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

test("a terminal track with only explicit no-speech evidence schedules no diarization", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.prepare("DELETE FROM transcript_segments WHERE chunk_id = 'chunk-cas'").run();
  repo.db
    .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-cas'")
    .run();

  assert.deepEqual(
    repo.enqueueDiarizationJobs("session-cas", {
      at: 6000,
      policy: SESSION_DIARIZATION_POLICY,
    }),
    { enqueued: 0, jobs: [], skipped: [{ trackId: "track-cas", reason: "no_speech" }] }
  );
  assert.equal(
    repo.db
      .prepare("SELECT count(*) count FROM processing_jobs WHERE job_type = 'diarize_track'")
      .get().count,
    0
  );
});
