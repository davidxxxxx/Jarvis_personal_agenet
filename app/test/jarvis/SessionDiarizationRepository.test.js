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

test("a terminal track with only explicit no-speech evidence schedules durable diarization", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  seedFinalTrack(repo);
  repo.db.prepare("DELETE FROM transcript_segments WHERE chunk_id = 'chunk-cas'").run();
  repo.db
    .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-cas'")
    .run();

  const result = repo.enqueueDiarizationJobs("session-cas", {
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
  const snapshot = repo.getDiarizationEvidenceSnapshot({
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
    transcriptRevision: snapshot.transcriptRevision,
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
  const secondSnapshot = repo.getDiarizationEvidenceSnapshot({
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
  const revisedSnapshot = repo.getDiarizationEvidenceSnapshot({
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
  const snapshot = repo.getDiarizationEvidenceSnapshot({
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
  const secondSnapshot = repo.getDiarizationEvidenceSnapshot({
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
