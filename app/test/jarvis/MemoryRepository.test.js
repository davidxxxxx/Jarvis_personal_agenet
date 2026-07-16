const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const test = require("node:test");

const AnalysisBudgetRepository = require("../../src/jarvis/main/AnalysisBudgetRepository");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const {
  canonicalTupleHash,
  canonicalizeText,
  semanticCandidateHash,
} = require("../../src/jarvis/main/MemoryMerger");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function loadMemoryRepository() {
  return require("../../src/jarvis/main/MemoryRepository");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function createFixture(filename = ":memory:") {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db);
  db.exec(`
    INSERT INTO people (id, display_name, is_self, created_at, last_seen_at)
    VALUES
      ('person-self', 'Local Self', 1, 1000, 5500),
      ('person-other', 'Other Person', 0, 5000, 5500);
    INSERT INTO sessions (id, started_at, ended_at, status, created_at)
    VALUES
      ('session-1', 1000, 5500, 'completed', 1000),
      ('session-2', 6000, 9000, 'completed', 6000);
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels, started_at, ended_at, state
    ) VALUES
      ('track-1', 'session-1', 'mic', 24000, 1, 1000, 5000, 'stopped'),
      ('track-omitted', 'session-1', 'system', 24000, 1, 5000, 5500, 'stopped'),
      ('track-2', 'session-2', 'mic', 24000, 1, 6000, 9000, 'stopped');
    INSERT INTO audio_chunks (
      id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, track_id, source_type, sequence_number, write_state
    ) VALUES
      ('chunk-1', 'session-1', 'capture-1.wav', 1000, 5000, 4000, '${HASH_A}', 9000,
       'completed', 'track-1', 'mic', 0, 'committed'),
      ('chunk-omitted', 'session-1', 'capture-private.wav', 5000, 5500, 500, '${HASH_C}', 9500,
       'completed', 'track-omitted', 'system', 0, 'committed'),
      ('chunk-2', 'session-2', 'capture-2.wav', 6000, 9000, 3000, '${HASH_B}', 12000,
       'completed', 'track-2', 'mic', 0, 'committed');
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
      is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
      version, model_version, completed_at
    ) VALUES
      ('segment-1', 'session-1', 1000, 5000, 'person-self', 'SELF',
       'durable evidence', 0.9, 1, 'analyzed', 'track-1', 'chunk-1', 'mic',
       'final', 1, 'whisper-v1', 5000),
      ('segment-omitted', 'session-1', 5000, 5500, 'person-other', 'P1',
       'private omitted evidence', 0.9, 1, 'analyzed', 'track-omitted', 'chunk-omitted', 'system',
       'final', 1, 'whisper-v1', 5500),
      ('segment-other', 'session-2', 6000, 9000, 'person-self', 'SELF',
       'other session', 0.8, 1, 'analyzed', 'track-2', 'chunk-2', 'mic',
       'final', 1, 'whisper-v1', 9000),
      ('segment-provisional', 'session-1', 2000, 2500, 'person-self', 'SELF',
       'not final', 0.5, 1, 'pending', NULL, NULL, 'mic',
       'provisional', 1, NULL, NULL);
    INSERT INTO speaker_clusters (
      id, session_id, track_id, local_label, model_id, person_id, link_state,
      created_at, updated_at
    ) VALUES (
      'cluster-other', 'session-1', 'track-omitted', 'P1', 'speaker-v1',
      'person-other', 'confirmed', 5000, 5500
    );
    INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
    VALUES ('cluster-other', 'segment-omitted');
  `);
  return db;
}

function createLegacyAnalysisSchema(db) {
  db.exec(`
    CREATE TABLE analysis_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      response_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      decisions_json TEXT NOT NULL DEFAULT '[]',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      canonical_title TEXT NOT NULL,
      normalized_title TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE session_topics (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      PRIMARY KEY(session_id, topic_id)
    );
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      owner_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
      due_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      confidence REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
      analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      needs_confirmation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_evidence (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
      analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      PRIMARY KEY(memory_id, segment_id)
    );
  `);
}

function seedLegacyAnalysis(db, { malformedJson = false } = {}) {
  db.exec(`
    INSERT INTO analysis_runs (
      id, session_id, kind, window_start, window_end, input_hash, model,
      status, attempt_count, response_json, created_at, completed_at
    ) VALUES (
      'legacy-run-1', 'session-1', 'final', 1000, 5000, '${HASH_A}', 'legacy-model',
      'completed', 1, '{}', 5000, 5100
    );
    INSERT INTO session_summaries (
      session_id, summary, decisions_json, suggestions_json,
      analysis_run_id, updated_at, is_final
    ) VALUES (
      'session-1', 'Legacy summary',
      ${malformedJson ? "'not-json'" : "'[\"Keep the local database\"]'"},
      ${malformedJson ? "'{bad-json'" : '\'[{"content":"Review the release","reason":"Catch regressions"}]\''},
      'legacy-run-1', 5100, 1
    );
    INSERT INTO topics (
      id, canonical_title, normalized_title, description, status, created_at, last_seen_at
    ) VALUES (
      'legacy-topic-1', 'Release', 'release', 'Release planning', 'active', 4000, 5100
    );
    INSERT INTO session_topics (session_id, topic_id, analysis_run_id)
    VALUES ('session-1', 'legacy-topic-1', 'legacy-run-1');
    INSERT INTO todos (
      id, content, normalized_content, owner_person_id, topic_id, due_at, status,
      confidence, created_at, updated_at, completed_at, source_session_id,
      source_segment_id, analysis_run_id
    ) VALUES (
      'legacy-todo-1', 'Prepare the release', 'prepare the release', 'person-self',
      'legacy-topic-1', 7000, 'open', 0.8, 4000, 5100, NULL,
      'session-1', 'segment-1', 'legacy-run-1'
    );
    INSERT INTO memories (
      id, type, content, normalized_content, person_id, topic_id, confidence, status,
      first_seen_at, last_seen_at, occurrence_count, needs_confirmation
    ) VALUES (
      'legacy-memory-1', 'opinion', 'Local storage is preferable',
      'local storage is preferable', 'person-self', 'legacy-topic-1', 0.85,
      'active', 4000, 5100, 1, 0
    );
    INSERT INTO memory_evidence (memory_id, segment_id, analysis_run_id)
    VALUES ('legacy-memory-1', 'segment-1', 'legacy-run-1');
  `);
}

function validInput(overrides = {}) {
  return {
    sessionId: "session-1",
    transcriptRevision: HASH_A,
    identityRevision: HASH_B,
    promptVersion: "jarvis-analysis-v2",
    segmentIds: ["segment-1"],
    ...overrides,
  };
}

function validCloudPayload(overrides = {}) {
  return {
    inputVersion: "jarvis-analysis-input-v2",
    segments: [
      {
        segmentId: "segment-1",
        startedAt: 1000,
        endedAt: 5000,
        speakerLabel: "SELF",
        text: "redacted evidence",
      },
    ],
    omittedRanges: [],
    ...overrides,
  };
}

function expectedPrepareToken() {
  return sha256(
    canonicalJson({
      schemaVersion: "jarvis-analysis-prepare-v1",
      sessionId: "session-1",
      transcriptRevision: HASH_A,
      identityRevision: HASH_B,
      promptVersion: "jarvis-analysis-v2",
      speakerBindings: [
        {
          label: "SELF",
          subjectKind: "person",
          subjectId: "person-self",
          subjectDisplayNameSnapshot: "Local Self",
        },
      ],
      segments: [
        {
          ordinal: 0,
          segmentId: "segment-1",
          segmentVersion: 1,
          textHash: sha256("durable evidence"),
          resultKind: "final",
          isStable: true,
          isCurrent: true,
          supersededBy: null,
          duplicateOf: null,
          speakerBindingLabel: "SELF",
        },
      ],
    })
  );
}

function validCreateInput(overrides = {}) {
  return {
    ...validInput(),
    prepareToken: expectedPrepareToken(),
    inputContractVersion: "jarvis-analysis-input-v2",
    redactionVersion: "jarvis-redaction-v1",
    cloudPayloadJson: JSON.stringify(validCloudPayload()),
    ...overrides,
  };
}

function expectedInputIdentity(cloudPayloadJson = validCreateInput().cloudPayloadJson) {
  const cloudPayloadBytes = Buffer.byteLength(cloudPayloadJson, "utf8");
  const cloudPayloadSha256 = sha256(cloudPayloadJson);
  const speakerBindings = [
    {
      label: "SELF",
      subjectKind: "person",
      subjectId: "person-self",
      subjectDisplayNameSnapshot: "Local Self",
    },
  ];
  const segments = [
    {
      ordinal: 0,
      segmentId: "segment-1",
      segmentVersion: 1,
      textHash: sha256("durable evidence"),
      speakerBindingLabel: "SELF",
    },
  ];
  const tuple = {
    schemaVersion: "jarvis-analysis-input-canonical-v2",
    sessionId: "session-1",
    transcriptRevision: HASH_A,
    identityRevision: HASH_B,
    promptVersion: "jarvis-analysis-v2",
    inputContractVersion: "jarvis-analysis-input-v2",
    redactionVersion: "jarvis-redaction-v1",
    cloudPayloadBytes,
    cloudPayloadSha256,
    speakerBindings,
    segments,
  };
  return {
    inputHash: sha256(canonicalJson(tuple)),
    cloudPayloadBytes,
    cloudPayloadSha256,
    speakerBindings,
    segments,
  };
}

function createRepository(db, counters = { ids: 0, clocks: 0 }, overrides = {}) {
  const MemoryRepository = loadMemoryRepository();
  return new MemoryRepository(db, {
    createId(prefix) {
      counters.ids += 1;
      return `${prefix}-${counters.ids}`;
    },
    now() {
      counters.clocks += 1;
      return 6000 + counters.clocks;
    },
    validateRedactedCloudPayload() {
      return true;
    },
    ...overrides,
  });
}

function validCandidate(overrides = {}) {
  return {
    schemaVersion: "jarvis-analysis-v2",
    sessionSummary: {
      title: "Session title",
      summary: "A durable session summary.",
      evidenceSegmentIds: ["segment-1"],
    },
    memories: [
      {
        kind: "decision",
        title: "Deployment choice",
        body: "Use the local-first deployment.",
        confidence: 0.9,
        evidenceSegmentIds: ["segment-1"],
      },
    ],
    topics: [
      {
        name: "Deployment",
        summary: "Local-first architecture",
        evidenceSegmentIds: ["segment-1"],
      },
    ],
    todos: [
      {
        title: "Prepare the release",
        ownerLabel: "SELF",
        dueText: null,
        evidenceSegmentIds: ["segment-1"],
      },
    ],
    suggestions: [
      {
        title: "Review tomorrow",
        rationale: "A later review may catch regressions.",
        basedOnEvidenceSegmentIds: [],
      },
    ],
    ...overrides,
  };
}

function createStoredInput(db, counters = { ids: 0, clocks: 0 }, overrides = {}) {
  const repository = createRepository(db, counters, overrides);
  const input = repository.createAnalysisInput(validCreateInput());
  return { repository, input, counters };
}

function createAlternativeInput(repository, text) {
  const cloudPayloadJson = JSON.stringify(
    validCloudPayload({
      segments: [{ ...validCloudPayload().segments[0], text }],
    })
  );
  return repository.createAnalysisInput(validCreateInput({ cloudPayloadJson }));
}

function createInputForSegments(repository, segmentIds, identity, sessionId = "session-1") {
  const request = validInput({
    sessionId,
    transcriptRevision: sha256(`transcript:${identity}`),
    segmentIds,
  });
  const prepared = repository.prepareAnalysisInput(request);
  return repository.createAnalysisInput({
    ...request,
    prepareToken: prepared.prepareToken,
    inputContractVersion: "jarvis-analysis-input-v2",
    redactionVersion: "jarvis-redaction-v1",
    cloudPayloadJson: JSON.stringify({
      inputVersion: "jarvis-analysis-input-v2",
      segments: prepared.segments.map((segment) => ({
        segmentId: segment.segmentId,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        speakerLabel: segment.speakerBindingLabel,
        text: `redacted ${segment.segmentId}`,
      })),
      omittedRanges: [],
    }),
  });
}

function setDesiredHead(repository, input, overrides = {}) {
  return repository.setAnalysisDesiredHead({
    sessionId: "session-1",
    analysisInputId: input.analysisInputId,
    responseSchemaVersion: "jarvis-analysis-v2",
    pseudonymBindingRevision: 1,
    modelVersion: "MiniMax-M2.7",
    segmentSubjectRevisions: [{ segmentId: "segment-1", subjectRevision: 1 }],
    ...overrides,
  });
}

function createCloudJob(db, head, overrides = {}) {
  let ids = 0;
  const store = new CaptureEvidenceStore(db, {
    createId: (prefix) => `${prefix}-cloud-${++ids}`,
    now: () => 7_000,
  });
  const job = store.enqueueCloudJob({
    sessionId: "session-1",
    jobType: "analyze_session",
    analysisInputId: head.analysisInputId,
    desiredHeadHash: head.desiredVectorHash,
    inputHash: head.analysisInputHash,
    inputVersion: 1,
    modelVersion: head.modelVersion,
    ...overrides,
  });
  return { store, job };
}

function reconcileBudgetAttempt(db, jobId, requestId = "budget-request-1") {
  const at = Date.UTC(2026, 6, 16, 4);
  const budget = new AnalysisBudgetRepository(db);
  budget.initialize({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai", at });
  assert.equal(
    budget.reserve({
      requestId,
      jobId,
      attemptNumber: 1,
      provider: "minimax",
      model: "MiniMax-M2.7",
      operation: "session_analysis",
      estimatedUsage: { inputTokens: 100, outputTokens: 100 },
      at: at + 1,
    }).ok,
    true
  );
  budget.markStarted({ requestId, at: at + 2 });
  budget.reconcile({
    requestId,
    usage: { inputTokens: 100, outputTokens: 100 },
    at: at + 3,
  });
  return requestId;
}

test("constructor requires a live database and dependency functions", () => {
  const MemoryRepository = loadMemoryRepository();
  const db = createFixture();
  try {
    assert.throws(() => new MemoryRepository(null), /database/i);
    assert.throws(() => new MemoryRepository(db, { createId: 1 }), /createId/i);
    assert.throws(() => new MemoryRepository(db, { createId: () => "id", now: 1 }), /now/i);
    assert.throws(
      () => new MemoryRepository(db, { createId: () => "id", now: () => 1 }),
      /validateRedactedCloudPayload/i
    );
  } finally {
    db.close();
  }
});

test("durably advances one exact analysis desired head without mutating immutable inputs", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const first = setDesiredHead(repository, input);

    assert.deepEqual(first, repository.getAnalysisDesiredHead("session-1"));
    assert.equal(first.headRevision, 1);
    assert.equal(first.analysisInputId, input.analysisInputId);
    assert.equal(first.analysisInputHash, input.inputHash);
    assert.equal(first.transcriptRevision, HASH_A);
    assert.equal(first.identityRevision, HASH_B);
    assert.equal(first.promptVersion, "jarvis-analysis-v2");
    assert.equal(first.responseSchemaVersion, "jarvis-analysis-v2");
    assert.equal(first.pseudonymBindingRevision, 1);
    assert.equal(first.modelVersion, "MiniMax-M2.7");
    assert.equal(first.cloudPayloadHash, expectedInputIdentity().cloudPayloadSha256);
    assert.deepEqual(first.segments, [
      {
        ordinal: 0,
        segmentId: "segment-1",
        segmentVersion: 1,
        textHash: sha256("durable evidence"),
        subjectRevision: 1,
      },
    ]);
    assert.match(first.desiredVectorHash, /^[0-9a-f]{64}$/);
    assert.equal(setDesiredHead(repository, input).headRevision, 1);

    const nextInput = createAlternativeInput(repository, "new redacted evidence");
    const second = setDesiredHead(repository, nextInput);
    assert.equal(second.headRevision, 2);
    assert.equal(second.analysisInputId, nextInput.analysisInputId);
    assert.notEqual(second.desiredVectorHash, first.desiredVectorHash);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count,
      2,
      "advancing the head must preserve immutable input history"
    );

    assert.throws(
      () =>
        setDesiredHead(repository, nextInput, {
          segmentSubjectRevisions: [{ segmentId: "wrong-segment", subjectRevision: 2 }],
        }),
      /segmentSubjectRevisions/
    );
  } finally {
    db.close();
  }
});

test("cloud analysis enqueue accepts only the exact current desired head", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const head = setDesiredHead(repository, input);
    assert.throws(
      () => createCloudJob(db, head, { desiredHeadHash: HASH_C }),
      /invalid cloud processing job/
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM processing_jobs").get().count, 0);
  } finally {
    db.close();
  }
});

test("a changed desired vector can enqueue a replacement job for the same immutable input", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const firstHead = setDesiredHead(repository, input);
    const { store, job: firstJob } = createCloudJob(db, firstHead);
    const secondHead = setDesiredHead(repository, input, {
      responseSchemaVersion: "jarvis-analysis-v3",
    });
    const secondJob = store.enqueueCloudJob({
      sessionId: "session-1",
      jobType: "analyze_session",
      analysisInputId: secondHead.analysisInputId,
      desiredHeadHash: secondHead.desiredVectorHash,
      inputHash: secondHead.analysisInputHash,
      inputVersion: 1,
      modelVersion: secondHead.modelVersion,
    });

    assert.notEqual(secondHead.desiredVectorHash, firstHead.desiredVectorHash);
    assert.notEqual(secondJob.id, firstJob.id);
    assert.deepEqual(
      db
        .prepare(
          `SELECT analysis_input_id, desired_head_hash FROM processing_jobs
           WHERE job_type = 'analyze_session' ORDER BY created_at, id`
        )
        .all(),
      [
        {
          analysis_input_id: input.analysisInputId,
          desired_head_hash: firstHead.desiredVectorHash,
        },
        {
          analysis_input_id: input.analysisInputId,
          desired_head_hash: secondHead.desiredVectorHash,
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("database rejects a validated candidate until its budget attempt is reconciled", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const head = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, head);
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    const at = Date.UTC(2026, 6, 16, 4);
    const budget = new AnalysisBudgetRepository(db);
    budget.initialize({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai", at });
    assert.equal(
      budget.reserve({
        requestId: "budget-started-only",
        jobId: job.id,
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        estimatedUsage: { inputTokens: 100, outputTokens: 100 },
        at: at + 1,
      }).ok,
      true
    );
    budget.markStarted({ requestId: "budget-started-only", at: at + 2 });
    const candidateJson = canonicalJson(validCandidate());

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO analysis_response_candidates (
               id, job_id, analysis_input_id, budget_attempt_id, desired_vector_hash,
               response_schema_version, candidate_json, candidate_bytes, candidate_hash,
               state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?)`
          )
          .run(
            "candidate-started-only",
            job.id,
            input.analysisInputId,
            "budget-started-only",
            head.desiredVectorHash,
            "jarvis-analysis-v2",
            candidateJson,
            Buffer.byteLength(candidateJson, "utf8"),
            sha256(candidateJson),
            at + 3
          ),
      /analysis response candidate linkage is invalid/
    );
  } finally {
    db.close();
  }
});

test("persists a validated candidate linked to job input head and reconciled budget attempt", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const head = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, head);
    const [claimed] = store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    assert.equal(claimed.id, job.id);
    const budgetAttemptId = reconcileBudgetAttempt(db, job.id);

    const persisted = repository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId,
      candidate: validCandidate(),
    });
    assert.equal(persisted.state, "validated");
    assert.match(persisted.candidateId, /^[A-Za-z0-9_-]+$/);
    assert.match(persisted.candidateHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      repository.persistValidatedAnalysisCandidate({
        jobId: job.id,
        analysisInputId: input.analysisInputId,
        budgetAttemptId,
        candidate: validCandidate(),
      }),
      { ...persisted, status: "existing" }
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE analysis_response_candidates SET candidate_json = '{}' WHERE id = ?")
          .run(persisted.candidateId),
      /analysis response candidate is immutable/
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM analysis_response_candidates WHERE id = ?")
          .run(persisted.candidateId),
      /analysis response candidate is immutable/
    );

    const recovery = repository.listRecoverableAnalysisCandidates({ limit: 10 });
    assert.deepEqual(recovery, [
      {
        candidateId: persisted.candidateId,
        jobId: job.id,
        analysisInputId: input.analysisInputId,
        budgetAttemptId,
        desiredVectorHash: head.desiredVectorHash,
        candidateHash: persisted.candidateHash,
        candidateState: "validated",
        jobState: "running",
        leaseOwner: "cloud-worker",
        leaseExpiresAt: 8_000,
        budgetState: "reconciled",
      },
    ]);

    assert.throws(
      () =>
        repository.applyStoredAnalysisCandidate({
          candidateId: persisted.candidateId,
          jobId: job.id,
          owner: "wrong-worker",
          at: 7_100,
        }),
      { code: "MEMORY_CANDIDATE_LEASE_LOST" }
    );
    const applied = repository.applyStoredAnalysisCandidate({
      candidateId: persisted.candidateId,
      jobId: job.id,
      owner: "cloud-worker",
      at: 7_100,
    });
    assert.equal(applied.status, "applied");
    assert.equal(
      repository.applyStoredAnalysisCandidate({
        candidateId: persisted.candidateId,
        jobId: job.id,
        owner: "cloud-worker",
        at: 7_101,
      }).status,
      "already_applied"
    );
    assert.deepEqual(
      db
        .prepare("SELECT state, disposition_at FROM analysis_response_candidates WHERE id = ?")
        .get(persisted.candidateId),
      { state: "applied", disposition_at: 7_100 }
    );
  } finally {
    db.close();
  }
});

test("stored candidate exact retry avoids planner clock and ID work while returning both hashes", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  let plannerCalls = 0;
  const MemoryMerger = require("../../src/jarvis/main/MemoryMerger").MemoryMerger;
  const realMerger = new MemoryMerger();
  try {
    const { repository, input } = createStoredInput(db, counters, {
      memoryMerger: {
        plan(plannerInput) {
          plannerCalls += 1;
          return realMerger.plan(plannerInput);
        },
      },
    });
    const head = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, head);
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    const persisted = repository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId: reconcileBudgetAttempt(db, job.id, "budget-request-exact-retry"),
      candidate: validCandidate(),
    });

    const applied = repository.applyStoredAnalysisCandidate({
      candidateId: persisted.candidateId,
      jobId: job.id,
      owner: "cloud-worker",
      at: 7_100,
    });
    const countsAfterApply = { ...counters };
    assert.equal(plannerCalls, 1);
    assert.deepEqual(
      repository.applyStoredAnalysisCandidate({
        candidateId: persisted.candidateId,
        jobId: job.id,
        owner: "cloud-worker",
        at: 7_101,
      }),
      {
        status: "already_applied",
        analysisInputId: input.analysisInputId,
        candidateHash: persisted.candidateHash,
        rawCandidateHash: persisted.candidateHash,
        semanticCandidateHash: applied.semanticCandidateHash,
      }
    );
    assert.equal(plannerCalls, 1);
    assert.deepEqual(counters, countsAfterApply);
  } finally {
    db.close();
  }
});

test("stored candidate disposition CAS failure rolls back the semantic hash and visible writes", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const head = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, head);
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    const persisted = repository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId: reconcileBudgetAttempt(db, job.id, "budget-request-cas-rollback"),
      candidate: validCandidate(),
    });
    db.exec(`
      CREATE TRIGGER inject_candidate_disposition_cas_miss
      BEFORE UPDATE OF state ON analysis_response_candidates
      WHEN OLD.id = '${persisted.candidateId}' AND NEW.state = 'applied'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    assert.throws(
      () =>
        repository.applyStoredAnalysisCandidate({
          candidateId: persisted.candidateId,
          jobId: job.id,
          owner: "cloud-worker",
          at: 7_100,
        }),
      { code: "MEMORY_CAS_CONFLICT" }
    );
    assert.deepEqual(
      db
        .prepare("SELECT state, disposition_at FROM analysis_response_candidates WHERE id = ?")
        .get(persisted.candidateId),
      { state: "validated", disposition_at: null }
    );
    assert.deepEqual(
      db
        .prepare("SELECT candidate_hash, applied_at FROM analysis_inputs WHERE id = ?")
        .get(input.analysisInputId),
      { candidate_hash: null, applied_at: null }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 0);
  } finally {
    db.close();
  }
});

test("every injected planner action-class failure rolls back the whole stored-candidate transaction", () => {
  const MemoryMerger = require("../../src/jarvis/main/MemoryMerger").MemoryMerger;
  const invalidActions = {
    inserts: { entityKind: "unknown" },
    revisions: { entityKind: "unknown" },
    occurrenceLinks: { mode: "unknown", entityKind: "unknown" },
    supersessions: {
      priorMemoryId: "missing-memory",
      nextMemoryCanonicalValueKey: "f".repeat(64),
      canonicalSlotKey: "e".repeat(64),
      reason: "transcript_replacement",
    },
    conflicts: {
      canonicalSlotKey: "e".repeat(64),
      existingMemoryIds: [],
      candidateCanonicalValueKeys: [],
    },
    mergeSuggestions: {
      leftTopic: { canonicalKey: "e".repeat(64), topicId: null },
      rightTopic: { canonicalKey: "f".repeat(64), topicId: null },
    },
    recurrences: {
      previousTodoId: "missing-todo",
      canonicalBaseKey: "e".repeat(64),
      evidenceSegmentIds: ["segment-1"],
    },
  };

  for (const [actionClass, invalidAction] of Object.entries(invalidActions)) {
    const db = createFixture();
    const realMerger = new MemoryMerger();
    try {
      const { repository, input } = createStoredInput(db, undefined, {
        memoryMerger: {
          plan(plannerInput) {
            const plan = realMerger.plan(plannerInput);
            return { ...plan, [actionClass]: [...plan[actionClass], invalidAction] };
          },
        },
      });
      const head = setDesiredHead(repository, input);
      const { store, job } = createCloudJob(db, head);
      store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
      const persisted = repository.persistValidatedAnalysisCandidate({
        jobId: job.id,
        analysisInputId: input.analysisInputId,
        budgetAttemptId: reconcileBudgetAttempt(db, job.id, `budget-request-${actionClass}`),
        candidate: validCandidate(),
      });

      assert.throws(
        () =>
          repository.applyStoredAnalysisCandidate({
            candidateId: persisted.candidateId,
            jobId: job.id,
            owner: "cloud-worker",
            at: 7_100,
          }),
        actionClass
      );
      assert.deepEqual(
        db
          .prepare("SELECT state, disposition_at FROM analysis_response_candidates WHERE id = ?")
          .get(persisted.candidateId),
        { state: "validated", disposition_at: null },
        actionClass
      );
      assert.deepEqual(
        db
          .prepare("SELECT candidate_hash, applied_at FROM analysis_inputs WHERE id = ?")
          .get(input.analysisInputId),
        { candidate_hash: null, applied_at: null },
        actionClass
      );
      assert.deepEqual(
        db
          .prepare(
            `SELECT
               (SELECT count(*) FROM memory_items_v2) AS memories,
               (SELECT count(*) FROM topics_v2) AS topics,
               (SELECT count(*) FROM todos_v2) AS todos,
               (SELECT count(*) FROM suggestions_v2) AS suggestions,
               (SELECT count(*) FROM session_summary_revisions) AS summaries,
               (SELECT count(*) FROM evidence_refs) AS evidence`
          )
          .get(),
        { memories: 0, topics: 0, todos: 0, suggestions: 0, summaries: 0, evidence: 0 },
        actionClass
      );
    } finally {
      db.close();
    }
  }
});

test("two SQLite connections serialize contending application of the same stored candidate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-memory-race-"));
  const filename = path.join(directory, "jarvis.sqlite");
  const firstDb = createFixture(filename);
  const secondDb = new Database(filename);
  secondDb.pragma("foreign_keys = ON");
  secondDb.pragma("busy_timeout = 1");
  try {
    const MemoryMerger = require("../../src/jarvis/main/MemoryMerger").MemoryMerger;
    const realMerger = new MemoryMerger();
    let secondRepository;
    let persisted;
    let job;
    let contentionError;
    let visibleDuringContention;
    const firstRepository = createRepository(firstDb, undefined, {
      memoryMerger: {
        plan(plannerInput) {
          try {
            secondRepository.applyStoredAnalysisCandidate({
              candidateId: persisted.candidateId,
              jobId: job.id,
              owner: "cloud-worker",
              at: 7_100,
            });
          } catch (error) {
            contentionError = error;
          }
          visibleDuringContention = secondDb
            .prepare(
              `SELECT
                 (SELECT count(*) FROM memory_items_v2) AS memories,
                 (SELECT count(*) FROM evidence_refs) AS evidence`
            )
            .get();
          return realMerger.plan(plannerInput);
        },
      },
    });
    const input = firstRepository.createAnalysisInput(validCreateInput());
    const head = setDesiredHead(firstRepository, input);
    const cloud = createCloudJob(firstDb, head);
    job = cloud.job;
    const { store } = cloud;
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    persisted = firstRepository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId: reconcileBudgetAttempt(firstDb, job.id, "budget-request-two-connections"),
      candidate: validCandidate(),
    });
    let secondPlannerCalls = 0;
    secondRepository = createRepository(secondDb, undefined, {
      memoryMerger: {
        plan() {
          secondPlannerCalls += 1;
          throw new Error("serialized retry invoked planner");
        },
      },
    });

    assert.equal(
      firstRepository.applyStoredAnalysisCandidate({
        candidateId: persisted.candidateId,
        jobId: job.id,
        owner: "cloud-worker",
        at: 7_100,
      }).status,
      "applied"
    );
    assert.equal(contentionError?.code, "SQLITE_BUSY");
    assert.deepEqual(visibleDuringContention, { memories: 0, evidence: 0 });
    assert.equal(secondPlannerCalls, 0);
    assert.equal(
      secondRepository.applyStoredAnalysisCandidate({
        candidateId: persisted.candidateId,
        jobId: job.id,
        owner: "cloud-worker",
        at: 7_101,
      }).status,
      "already_applied"
    );
    assert.equal(secondPlannerCalls, 0);
    assert.equal(secondDb.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 1);
    assert.equal(secondDb.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 4);
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate apply CAS supersedes a stale desired head without visible writes", () => {
  const db = createFixture();
  let plannerCalls = 0;
  try {
    const { repository, input } = createStoredInput(db, undefined, {
      memoryMerger: {
        plan() {
          plannerCalls += 1;
          throw new Error("stale desired head invoked planner");
        },
      },
    });
    const oldHead = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, oldHead);
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    const budgetAttemptId = reconcileBudgetAttempt(db, job.id, "budget-request-stale");
    const persisted = repository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId,
      candidate: validCandidate(),
    });

    const nextInput = createAlternativeInput(repository, "new desired redacted evidence");
    setDesiredHead(repository, nextInput);
    assert.deepEqual(
      repository.applyStoredAnalysisCandidate({
        candidateId: persisted.candidateId,
        jobId: job.id,
        owner: "cloud-worker",
        at: 7_100,
      }),
      {
        status: "superseded",
        analysisInputId: input.analysisInputId,
        candidateHash: persisted.candidateHash,
      }
    );
    assert.equal(
      db
        .prepare("SELECT candidate_hash FROM analysis_inputs WHERE id = ?")
        .get(input.analysisInputId).candidate_hash,
      null
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 0);
    assert.equal(plannerCalls, 0);
    assert.equal(
      db
        .prepare("SELECT state FROM analysis_response_candidates WHERE id = ?")
        .get(persisted.candidateId).state,
      "superseded"
    );
  } finally {
    db.close();
  }
});

test("candidate apply fails closed when the current desired vector hash is inconsistent", () => {
  const db = createFixture();
  let plannerCalls = 0;
  try {
    const { repository, input } = createStoredInput(db, undefined, {
      memoryMerger: {
        plan() {
          plannerCalls += 1;
          throw new Error("corrupt desired head invoked planner");
        },
      },
    });
    const head = setDesiredHead(repository, input);
    const { store, job } = createCloudJob(db, head);
    store.claimCloudJobs({ owner: "cloud-worker", at: 7_000, leaseMs: 1_000 });
    const budgetAttemptId = reconcileBudgetAttempt(db, job.id, "budget-request-corrupt-head");
    const persisted = repository.persistValidatedAnalysisCandidate({
      jobId: job.id,
      analysisInputId: input.analysisInputId,
      budgetAttemptId,
      candidate: validCandidate(),
    });
    db.prepare(
      `UPDATE analysis_desired_heads
       SET desired_vector_json = json_set(
             desired_vector_json, '$.responseSchemaVersion', 'corrupt-schema'
           ),
           head_revision = head_revision + 1,
           updated_at = updated_at + 1
       WHERE session_id = 'session-1'`
    ).run();

    assert.throws(
      () =>
        repository.applyStoredAnalysisCandidate({
          candidateId: persisted.candidateId,
          jobId: job.id,
          owner: "cloud-worker",
          at: 7_100,
        }),
      { code: "MEMORY_DESIRED_HEAD_CORRUPT" }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 0);
    assert.equal(plannerCalls, 0);
    assert.equal(
      db
        .prepare("SELECT state FROM analysis_response_candidates WHERE id = ?")
        .get(persisted.candidateId).state,
      "validated"
    );
  } finally {
    db.close();
  }
});

test("candidate application plans from the exact private snapshot before clock or ID allocation", () => {
  const db = createFixture();
  try {
    const counters = { ids: 0, clocks: 0 };
    let snapshot;
    let countersAtPlan;
    const repository = createRepository(db, counters, {
      memoryMerger: {
        plan(input) {
          snapshot = input;
          countersAtPlan = { ...counters };
          return {
            inserts: [],
            revisions: [],
            occurrenceLinks: [],
            supersessions: [],
            conflicts: [],
            mergeSuggestions: [],
            recurrences: [],
            ignoredDuplicates: [],
            semanticCandidateHash: HASH_C,
          };
        },
      },
    });
    const input = repository.createAnalysisInput(validCreateInput());
    const baseline = { ...counters };
    const candidate = validCandidate({ memories: [], topics: [], todos: [], suggestions: [] });
    const rawCandidateHash = sha256(canonicalJson(candidate));

    assert.deepEqual(
      repository.applyCandidateAnalysis({
        analysisInputId: input.analysisInputId,
        inputHash: input.inputHash,
        candidate,
        claimedCandidateHash: rawCandidateHash,
      }),
      {
        status: "applied",
        analysisInputId: input.analysisInputId,
        candidateHash: rawCandidateHash,
        rawCandidateHash,
        semanticCandidateHash: HASH_C,
      }
    );
    assert.deepEqual(countersAtPlan, baseline);
    assert.deepEqual(snapshot, {
      analysisInput: { id: input.analysisInputId, sessionId: "session-1" },
      candidate,
      evidence: {
        segments: [
          {
            id: "segment-1",
            sessionId: "session-1",
            startedAt: 1000,
            endedAt: 5000,
            speakerLabel: "SELF",
          },
        ],
        bindings: [
          {
            label: "SELF",
            subjectKind: "person",
            subjectId: "person-self",
          },
        ],
      },
      existing: {
        memories: [],
        topics: [],
        topicMergeSuggestions: [],
        todos: [],
        suggestions: [],
        memorySupersessions: [],
        todoRecurrences: [],
      },
      trustedTranscriptReplacements: [],
    });
    assert.deepEqual(
      db
        .prepare("SELECT candidate_hash, applied_at FROM analysis_inputs WHERE id = ?")
        .get(input.analysisInputId),
      { candidate_hash: HASH_C, applied_at: 6002 }
    );
  } finally {
    db.close();
  }
});

test("planner insert actions persist canonical entities subjects and semantic reorder idempotency", () => {
  const db = createFixture();
  try {
    const counters = { ids: 0, clocks: 0 };
    const repository = createRepository(db, counters);
    const input = repository.createAnalysisInput(validCreateInput());
    const candidate = validCandidate({
      memories: [
        ...validCandidate().memories,
        {
          kind: "preference",
          title: "Storage preference",
          body: "Keep durable data local.",
          confidence: 0.8,
          evidenceSegmentIds: ["segment-1"],
        },
      ],
      topics: [
        ...validCandidate().topics,
        {
          name: "Privacy",
          summary: "Keep private data local",
          evidenceSegmentIds: ["segment-1"],
        },
      ],
      todos: [
        ...validCandidate().todos,
        {
          title: "Verify local storage",
          ownerLabel: "SELF",
          dueText: "Tomorrow",
          evidenceSegmentIds: ["segment-1"],
        },
      ],
      suggestions: [
        ...validCandidate().suggestions,
        {
          title: "Audit storage",
          rationale: "Confirm all durable state remains local.",
          basedOnEvidenceSegmentIds: ["segment-1"],
        },
      ],
    });
    const rawCandidateHash = sha256(canonicalJson(candidate));
    const semanticHash = semanticCandidateHash(candidate);

    assert.deepEqual(
      repository.applyCandidateAnalysis({
        analysisInputId: input.analysisInputId,
        inputHash: input.inputHash,
        candidate,
        claimedCandidateHash: rawCandidateHash,
      }),
      {
        status: "applied",
        analysisInputId: input.analysisInputId,
        candidateHash: rawCandidateHash,
        rawCandidateHash,
        semanticCandidateHash: semanticHash,
      }
    );
    const expectedDecisionSlot = canonicalTupleHash([
      "memory",
      "decision",
      canonicalizeText("Deployment choice"),
      ["person-self"],
    ]);
    assert.deepEqual(
      db
        .prepare(
          `SELECT canonical_slot_key, canonical_value_key
           FROM memory_items_v2 WHERE title = 'Deployment choice'`
        )
        .get(),
      {
        canonical_slot_key: expectedDecisionSlot,
        canonical_value_key: canonicalTupleHash([
          "memory_value",
          expectedDecisionSlot,
          canonicalizeText("Use the local-first deployment."),
        ]),
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT canonical_slot_key, algorithm
           FROM memory_item_canonical_slots
           WHERE memory_item_id = (
             SELECT id FROM memory_items_v2 WHERE title = 'Deployment choice'
           )`
        )
        .get(),
      { canonical_slot_key: expectedDecisionSlot, algorithm: "canonical-v1" }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT memory_item_id, subject_kind, subject_id
           FROM memory_item_subjects ORDER BY memory_item_id`
        )
        .all()
        .map(({ subject_kind, subject_id }) => ({ subject_kind, subject_id })),
      [
        { subject_kind: "person", subject_id: "person-self" },
        { subject_kind: "person", subject_id: "person-self" },
      ]
    );
    assert.deepEqual(
      db
        .prepare("SELECT candidate_hash FROM analysis_inputs WHERE id = ?")
        .get(input.analysisInputId),
      { candidate_hash: semanticHash }
    );

    const afterFirst = { ...counters };
    const countsAfterFirst = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM memory_items_v2) AS memories,
           (SELECT count(*) FROM topics_v2) AS topics,
           (SELECT count(*) FROM todos_v2) AS todos,
           (SELECT count(*) FROM suggestions_v2) AS suggestions,
           (SELECT count(*) FROM evidence_refs) AS evidence`
      )
      .get();
    const reordered = {
      ...candidate,
      memories: [...candidate.memories].reverse(),
      topics: [...candidate.topics].reverse(),
      todos: [...candidate.todos].reverse(),
      suggestions: [...candidate.suggestions].reverse(),
    };
    const reorderedRawHash = sha256(canonicalJson(reordered));
    assert.notEqual(reorderedRawHash, rawCandidateHash);
    assert.deepEqual(
      repository.applyCandidateAnalysis({
        analysisInputId: input.analysisInputId,
        inputHash: input.inputHash,
        candidate: reordered,
        claimedCandidateHash: reorderedRawHash,
      }),
      {
        status: "already_applied",
        analysisInputId: input.analysisInputId,
        candidateHash: reorderedRawHash,
        rawCandidateHash: reorderedRawHash,
        semanticCandidateHash: semanticHash,
      }
    );
    assert.deepEqual(counters, afterFirst);
    assert.deepEqual(
      db
        .prepare(
          `SELECT
             (SELECT count(*) FROM memory_items_v2) AS memories,
             (SELECT count(*) FROM topics_v2) AS topics,
             (SELECT count(*) FROM todos_v2) AS todos,
             (SELECT count(*) FROM suggestions_v2) AS suggestions,
             (SELECT count(*) FROM evidence_refs) AS evidence`
        )
        .get(),
      countsAfterFirst
    );
  } finally {
    db.close();
  }
});

test("candidate-internal duplicates and candidate-candidate conflicts apply the exact converged plan", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const local = validCandidate().memories[0];
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate({
        topics: [],
        todos: [],
        suggestions: [],
        memories: [
          local,
          {
            ...local,
            title: "DEPLOYMENT   CHOICE",
            body: "use the LOCAL-FIRST deployment.",
          },
          { ...local, body: "Use the cloud-first deployment." },
        ],
      }),
    });

    assert.deepEqual(
      db.prepare("SELECT body, lifecycle FROM memory_items_v2 ORDER BY body").all(),
      [
        { body: "Use the cloud-first deployment.", lifecycle: "conflict" },
        { body: "use the LOCAL-FIRST deployment.", lifecycle: "conflict" },
      ]
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 2);
    assert.deepEqual(db.prepare("SELECT state, episode FROM memory_conflict_groups").get(), {
      state: "open",
      episode: 1,
    });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM memory_conflict_members").get().count,
      2
    );
  } finally {
    db.close();
  }
});

test("event overlap exact 30-minute gap and plus-one millisecond apply planner occurrence actions", () => {
  const db = createFixture();
  const windowMs = 30 * 60 * 1_000;
  try {
    db.exec(`
      INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, track_id, source_type, sequence_number, write_state
      ) VALUES
        ('chunk-event-base', 'session-1', 'event-base.wav', 1000, 2000, 1000, '${"1".repeat(64)}',
         ${3000 + windowMs}, 'completed', 'track-1', 'mic', 10, 'committed'),
        ('chunk-event-overlap', 'session-1', 'event-overlap.wav', 1500, 2500, 1000,
         '${"2".repeat(64)}', ${3000 + windowMs}, 'completed', 'track-1', 'mic', 11, 'committed'),
        ('chunk-event-exact', 'session-1', 'event-exact.wav', ${2000 + windowMs},
         ${2100 + windowMs}, 100, '${"3".repeat(64)}', ${3000 + windowMs}, 'completed',
         'track-1', 'mic', 12, 'committed'),
        ('chunk-event-late', 'session-1', 'event-late.wav', ${2001 + windowMs},
         ${2101 + windowMs}, 100, '${"4".repeat(64)}', ${3000 + windowMs}, 'completed',
         'track-1', 'mic', 13, 'committed');
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
        is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
        version, model_version, completed_at
      ) VALUES
        ('event-base', 'session-1', 1000, 2000, 'person-self', 'SELF', 'event base', 0.9,
         1, 'analyzed', 'track-1', 'chunk-event-base', 'mic', 'final', 1, 'whisper-event', 2000),
        ('event-overlap', 'session-1', 1500, 2500, 'person-self', 'SELF', 'event overlap', 0.9,
         1, 'analyzed', 'track-1', 'chunk-event-overlap', 'mic', 'final', 1, 'whisper-event', 2500),
        ('event-exact', 'session-1', ${2000 + windowMs}, ${2100 + windowMs},
         'person-self', 'SELF', 'event exact', 0.9, 1, 'analyzed', 'track-1',
         'chunk-event-exact', 'mic', 'final', 1, 'whisper-event', ${2100 + windowMs}),
        ('event-late', 'session-1', ${2001 + windowMs}, ${2101 + windowMs},
         'person-self', 'SELF', 'event late', 0.9, 1, 'analyzed', 'track-1',
         'chunk-event-late', 'mic', 'final', 1, 'whisper-event', ${2101 + windowMs});
    `);
    const repository = createRepository(db);
    const sequence = [
      ["event-base", 1],
      ["event-overlap", 1],
      ["event-exact", 1],
      ["event-late", 2],
    ];
    const eventInputs = new Map();
    for (const [segmentId, expectedOccurrences] of sequence) {
      const input = createInputForSegments(repository, [segmentId], segmentId);
      eventInputs.set(segmentId, input);
      try {
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate: validCandidate({
            sessionSummary: {
              title: "Launch",
              summary: "API v2 launch evidence.",
              evidenceSegmentIds: [segmentId],
            },
            memories: [
              {
                kind: "event",
                title: "Launch",
                body: "API v2 launched.",
                confidence: 0.9,
                evidenceSegmentIds: [segmentId],
              },
            ],
            topics: [],
            todos: [],
            suggestions: [],
          }),
        });
      } catch (error) {
        error.message = `${segmentId}: ${error.message}`;
        throw error;
      }
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count,
        expectedOccurrences,
        segmentId
      );
    }

    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 1);
    assert.deepEqual(
      db.prepare("SELECT started_at, ended_at FROM memory_occurrences ORDER BY started_at").all(),
      [
        { started_at: 1000, ended_at: 2000 },
        { started_at: 2001 + windowMs, ended_at: 2101 + windowMs },
      ]
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM evidence_refs WHERE entity_type = 'memory_occurrence'"
        )
        .get().count,
      4
    );

    const firstOccurrenceId = db
      .prepare("SELECT id FROM memory_occurrences ORDER BY started_at LIMIT 1")
      .get().id;
    const otherSessionInput = createInputForSegments(
      repository,
      ["segment-other"],
      "cross-session",
      "session-2"
    );
    const insertInvalidEvidence = db.prepare(
      `INSERT INTO evidence_refs (
         id, entity_type, entity_id, source_analysis_input_id, session_id,
         transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
         quote_text, audio_state, created_at
       ) VALUES (?, 'memory_occurrence', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 9999)`
    );
    assert.throws(
      () =>
        insertInvalidEvidence.run(
          "evidence-cross-session",
          firstOccurrenceId,
          otherSessionInput.analysisInputId,
          "session-2",
          "segment-other",
          "chunk-2",
          "track-2",
          6000,
          9000,
          "other session"
        ),
      /evidence lineage is invalid/
    );
    assert.throws(
      () =>
        insertInvalidEvidence.run(
          "evidence-manifest-mismatch",
          firstOccurrenceId,
          eventInputs.get("event-base").analysisInputId,
          "session-1",
          "event-late",
          "chunk-event-late",
          "track-1",
          2001 + windowMs,
          2101 + windowMs,
          "event late"
        ),
      /evidence lineage is invalid/
    );
  } finally {
    db.close();
  }
});

test("future topic references create one deterministic proposed merge suggestion", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate({
        memories: [],
        todos: [],
        suggestions: [],
        topics: [
          {
            name: "Project Atlas",
            summary: "Atlas planning",
            evidenceSegmentIds: ["segment-1"],
          },
          {
            name: "Project Atlas Plan",
            summary: "Detailed Atlas planning",
            evidenceSegmentIds: ["segment-1"],
          },
        ],
      }),
    });

    const topics = db.prepare("SELECT id, name FROM topics_v2 ORDER BY id").all();
    assert.equal(topics.length, 2);
    const merge = db.prepare("SELECT * FROM topic_merge_suggestions").get();
    assert.ok(merge);
    assert.equal(merge.left_topic_id < merge.right_topic_id, true);
    assert.deepEqual(
      [merge.left_topic_id, merge.right_topic_id].sort(),
      topics.map((topic) => topic.id).sort()
    );
    assert.equal(merge.algorithm_version, "dice-bigram-v1");
    assert.equal(merge.state, "proposed");
    assert.equal(merge.decided_at, null);
    assert.equal(merge.score, 0.827586);
    assert.equal(
      merge.pair_key,
      canonicalTupleHash([
        "topic_merge_pair",
        ...[
          canonicalTupleHash(["topic", canonicalizeText("Project Atlas")]),
          canonicalTupleHash(["topic", canonicalizeText("Project Atlas Plan")]),
        ].sort(),
        "dice-bigram-v1",
      ])
    );
  } finally {
    db.close();
  }
});

test("suggestion accept and dismiss are explicit terminal idempotent repository transitions", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate({ memories: [], topics: [], todos: [] }),
    });
    const accepted = db.prepare("SELECT id FROM suggestions_v2").get();
    assert.deepEqual(repository.acceptSuggestion({ suggestionId: accepted.id, at: 7000 }), {
      status: "accepted",
      suggestionId: accepted.id,
      decidedAt: 7000,
    });
    assert.deepEqual(repository.acceptSuggestion({ suggestionId: accepted.id, at: 7000 }), {
      status: "already_accepted",
      suggestionId: accepted.id,
      decidedAt: 7000,
    });
    assert.throws(() => repository.dismissSuggestion({ suggestionId: accepted.id, at: 7000 }), {
      code: "MEMORY_SUGGESTION_ALREADY_DECIDED",
    });
    assert.equal(db.prepare("SELECT count(*) AS count FROM todos_v2").get().count, 0);

    const nextInput = createAlternativeInput(repository, "second suggestion input");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        memories: [],
        topics: [],
        todos: [],
        suggestions: [
          {
            title: "Keep separate",
            rationale: "This remains only a suggestion.",
            basedOnEvidenceSegmentIds: [],
          },
        ],
      }),
    });
    const dismissed = db.prepare("SELECT id FROM suggestions_v2 WHERE state = 'proposed'").get();
    assert.deepEqual(repository.dismissSuggestion({ suggestionId: dismissed.id, at: 7100 }), {
      status: "dismissed",
      suggestionId: dismissed.id,
      decidedAt: 7100,
    });
    assert.deepEqual(repository.dismissSuggestion({ suggestionId: dismissed.id, at: 7100 }), {
      status: "already_dismissed",
      suggestionId: dismissed.id,
      decidedAt: 7100,
    });
    assert.throws(() => repository.acceptSuggestion({ suggestionId: dismissed.id, at: 7100 }), {
      code: "MEMORY_SUGGESTION_ALREADY_DECIDED",
    });
    assert.throws(() => repository.acceptSuggestion({ suggestionId: "missing", at: 7200 }), {
      code: "MEMORY_SUGGESTION_NOT_FOUND",
    });
    const terminalSuggestions = db
      .prepare("SELECT id, state, decided_at, updated_at FROM suggestions_v2 ORDER BY id")
      .all();
    const terminalOccurrenceCount = db
      .prepare("SELECT count(*) AS count FROM suggestion_occurrences")
      .get().count;
    const repeatedInput = createAlternativeInput(repository, "terminal suggestions repeated");
    repository.applyCandidateAnalysis({
      analysisInputId: repeatedInput.analysisInputId,
      inputHash: repeatedInput.inputHash,
      candidate: validCandidate({
        memories: [],
        topics: [],
        todos: [],
        suggestions: [
          validCandidate().suggestions[0],
          {
            title: "Keep separate",
            rationale: "This remains only a suggestion.",
            basedOnEvidenceSegmentIds: [],
          },
        ],
      }),
    });
    assert.deepEqual(
      db.prepare("SELECT id, state, decided_at, updated_at FROM suggestions_v2 ORDER BY id").all(),
      terminalSuggestions
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM suggestion_occurrences").get().count,
      terminalOccurrenceCount
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM todos_v2").get().count, 0);
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis imports the observable legacy snapshot once with append-only lineage", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db);
    const counters = { ids: 0, clocks: 0 };
    const repository = createRepository(db, counters);

    const first = repository.importLegacyAnalysis();
    const countersAfterFirst = { ...counters };
    const second = repository.importLegacyAnalysis();

    assert.deepEqual(first, { status: "completed", importedRowCount: 8 });
    assert.deepEqual(second, { status: "completed", importedRowCount: 0 });
    assert.deepEqual(counters, countersAfterFirst);
    assert.equal(db.prepare("SELECT count(*) count FROM legacy_import_map").get().count, 8);
    assert.deepEqual(
      db
        .prepare(
          "SELECT status, imported_row_count FROM legacy_import_runs ORDER BY started_at, id"
        )
        .all(),
      [{ status: "completed", imported_row_count: 8 }]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT kind, provenance FROM memory_items_v2
           ORDER BY kind, id`
        )
        .all(),
      [
        { kind: "decision", provenance: "legacy_unverified" },
        { kind: "opinion", provenance: "evidence_linked" },
      ]
    );
    assert.deepEqual(db.prepare(`SELECT provenance FROM topics_v2`).all(), [
      { provenance: "legacy_unverified" },
    ]);
    assert.deepEqual(db.prepare(`SELECT status, provenance FROM todos_v2`).all(), [
      { status: "open", provenance: "evidence_linked" },
    ]);
    assert.deepEqual(db.prepare(`SELECT state, provenance FROM suggestions_v2`).all(), [
      { state: "proposed", provenance: "legacy_unverified" },
    ]);
    assert.deepEqual(
      db
        .prepare(
          `SELECT session_id, completeness, lifecycle, provenance, content_json
           FROM session_summary_revisions`
        )
        .all(),
      [
        {
          session_id: "session-1",
          completeness: "final",
          lifecycle: "active",
          provenance: "legacy_unverified",
          content_json: canonicalJson({
            summary: "Legacy summary",
            decisions: ["Keep the local database"],
            suggestions: [{ content: "Review the release", reason: "Catch regressions" }],
          }),
        },
      ]
    );
    assert.equal(db.prepare("SELECT count(*) count FROM daily_digests").get().count, 0);
    assert.deepEqual(
      db
        .prepare(
          `SELECT entity_type, session_id, transcript_segment_id, quote_text, audio_state
           FROM evidence_refs ORDER BY entity_type`
        )
        .all(),
      [
        {
          entity_type: "memory_occurrence",
          session_id: "session-1",
          transcript_segment_id: "segment-1",
          quote_text: "durable evidence",
          audio_state: "available",
        },
        {
          entity_type: "todo_occurrence",
          session_id: "session-1",
          transcript_segment_id: "segment-1",
          quote_text: "durable evidence",
          audio_state: "available",
        },
      ]
    );
    for (const table of [
      "memory_occurrences",
      "topic_occurrences",
      "todo_occurrences",
      "suggestion_occurrences",
    ]) {
      const rows = db.prepare(`SELECT analysis_input_id, legacy_session_id FROM ${table}`).all();
      assert.ok(rows.length > 0, table);
      assert.ok(
        rows.every(
          (row) => row.analysis_input_id === null && row.legacy_session_id === "session-1"
        ),
        table
      );
    }
    const snapshot = repository.readPublicSnapshot();
    for (const collection of [
      snapshot.memories,
      snapshot.topics,
      snapshot.todos,
      snapshot.suggestions,
    ]) {
      for (const item of collection) {
        assert.ok(item.occurrences.every((occurrence) => occurrence.sessionId === "session-1"));
      }
    }
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis rolls back targets maps and run markers after an injected failure", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db);
    const repository = createRepository(db);
    db.exec(`
      CREATE TRIGGER fail_legacy_todo_map
      BEFORE INSERT ON legacy_import_map
      WHEN NEW.source_table = 'todos'
      BEGIN
        SELECT RAISE(ABORT, 'injected legacy import failure');
      END;
    `);

    assert.throws(() => repository.importLegacyAnalysis(), /injected legacy import failure/);
    for (const table of [
      "legacy_import_runs",
      "legacy_import_map",
      "memory_items_v2",
      "memory_occurrences",
      "topics_v2",
      "topic_revisions",
      "topic_occurrences",
      "todos_v2",
      "todo_revisions",
      "todo_occurrences",
      "suggestions_v2",
      "suggestion_occurrences",
      "session_summary_revisions",
      "evidence_refs",
    ]) {
      assert.equal(db.prepare(`SELECT count(*) count FROM ${table}`).get().count, 0, table);
    }

    db.exec("DROP TRIGGER fail_legacy_todo_map");
    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 8,
    });
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis treats malformed legacy arrays as empty without blocking startup", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db, { malformedJson: true });
    const repository = createRepository(db);

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 6,
    });
    assert.equal(db.prepare("SELECT count(*) count FROM suggestions_v2").get().count, 0);
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT content_json FROM session_summary_revisions").get().content_json
      ),
      { decisions: [], suggestions: [], summary: "Legacy summary" }
    );
    assert.equal(
      db.prepare("SELECT count(*) count FROM memory_items_v2 WHERE kind = 'decision'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis fingerprints live segment lineage and later adds newly verifiable evidence", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    db.exec(`
      INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, track_id, source_type, sequence_number, write_state
      ) VALUES (
        'chunk-late', 'session-1', 'late.wav', 2000, 2500, 500, '${HASH_C}', 9000,
        'completed', 'track-1', 'mic', 1, 'committed'
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
        is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
        version, model_version, completed_at
      ) VALUES (
        'segment-late', 'session-1', 2000, 2500, 'person-self', 'SELF',
        'late evidence', 0.8, 0, 'pending', 'track-1', 'chunk-late', 'mic',
        'provisional', 1, NULL, NULL
      );
      INSERT INTO analysis_runs (
        id, session_id, kind, window_start, window_end, input_hash, model,
        status, attempt_count, response_json, created_at, completed_at
      ) VALUES (
        'legacy-run-late', 'session-1', 'final', 2000, 2500, '${HASH_C}', 'legacy-model',
        'completed', 1, '{}', 2500, 2600
      );
      INSERT INTO memories (
        id, type, content, normalized_content, confidence, status,
        first_seen_at, last_seen_at, occurrence_count, needs_confirmation
      ) VALUES (
        'legacy-memory-late', 'fact', 'Evidence arrives later', 'evidence arrives later',
        0.8, 'active', 2500, 2600, 1, 0
      );
      INSERT INTO memory_evidence (memory_id, segment_id, analysis_run_id)
      VALUES ('legacy-memory-late', 'segment-late', 'legacy-run-late');
    `);
    const repository = createRepository(db);

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 2,
    });
    assert.equal(db.prepare("SELECT count(*) count FROM evidence_refs").get().count, 0);
    assert.equal(
      db.prepare("SELECT provenance FROM memory_items_v2").get().provenance,
      "legacy_unverified"
    );

    db.prepare(
      `UPDATE transcript_segments
       SET result_kind = 'final', is_stable = 1, analysis_state = 'analyzed',
           model_version = 'whisper-v1', completed_at = 2700
       WHERE id = 'segment-late'`
    ).run();
    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 2,
    });
    assert.equal(db.prepare("SELECT count(*) count FROM evidence_refs").get().count, 1);
    assert.equal(
      db.prepare("SELECT provenance FROM memory_items_v2").get().provenance,
      "legacy_unverified"
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT target_entity_type FROM legacy_import_map
           WHERE source_table = 'memory_evidence' ORDER BY imported_at, rowid`
        )
        .all(),
      [{ target_entity_type: "memory" }, { target_entity_type: "evidence" }]
    );
    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 0,
    });
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis groups late memory evidence into one occurrence per legacy session", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    db.exec(`
      INSERT INTO analysis_runs (
        id, session_id, kind, window_start, window_end, input_hash, model,
        status, attempt_count, response_json, created_at, completed_at
      ) VALUES (
        'legacy-run-cross-1', 'session-1', 'final', 1000, 5000, '${HASH_A}', 'legacy-model',
        'completed', 1, '{}', 5000, 5100
      );
      INSERT INTO memories (
        id, type, content, normalized_content, confidence, status,
        first_seen_at, last_seen_at, occurrence_count, needs_confirmation
      ) VALUES (
        'legacy-memory-cross', 'fact', 'Seen in two sessions', 'seen in two sessions',
        0.9, 'active', 5000, 5100, 1, 0
      );
      INSERT INTO memory_evidence (memory_id, segment_id, analysis_run_id)
      VALUES ('legacy-memory-cross', 'segment-1', 'legacy-run-cross-1');
    `);
    const repository = createRepository(db);

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 2,
    });

    db.exec(`
      INSERT INTO analysis_runs (
        id, session_id, kind, window_start, window_end, input_hash, model,
        status, attempt_count, response_json, created_at, completed_at
      ) VALUES (
        'legacy-run-cross-2', 'session-2', 'final', 6000, 9000, '${HASH_B}', 'legacy-model',
        'completed', 1, '{}', 9000, 9100
      );
      INSERT INTO memory_evidence (memory_id, segment_id, analysis_run_id)
      VALUES ('legacy-memory-cross', 'segment-other', 'legacy-run-cross-2');
    `);

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 2,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT legacy_session_id, count(*) AS count
           FROM memory_occurrences
           GROUP BY legacy_session_id ORDER BY legacy_session_id`
        )
        .all(),
      [
        { legacy_session_id: "session-1", count: 1 },
        { legacy_session_id: "session-2", count: 1 },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT occurrence.legacy_session_id, evidence.session_id,
                  evidence.transcript_segment_id
           FROM evidence_refs AS evidence
           JOIN memory_occurrences AS occurrence ON occurrence.id = evidence.entity_id
           WHERE evidence.entity_type = 'memory_occurrence'
           ORDER BY evidence.session_id`
        )
        .all(),
      [
        {
          legacy_session_id: "session-1",
          session_id: "session-1",
          transcript_segment_id: "segment-1",
        },
        {
          legacy_session_id: "session-2",
          session_id: "session-2",
          transcript_segment_id: "segment-other",
        },
      ]
    );
    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 0,
    });
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 2);
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis appends summary and topic revisions without overwriting history", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db);
    const repository = createRepository(db);
    repository.importLegacyAnalysis();
    db.exec(`
      INSERT INTO analysis_runs (
        id, session_id, kind, window_start, window_end, input_hash, model,
        status, attempt_count, response_json, created_at, completed_at
      ) VALUES (
        'legacy-run-2', 'session-1', 'final', 1000, 5000, '${HASH_B}', 'legacy-model',
        'completed', 1, '{}', 5200, 5300
      );
      UPDATE session_summaries
      SET summary = 'Revised legacy summary', analysis_run_id = 'legacy-run-2', updated_at = 5300
      WHERE session_id = 'session-1';
      UPDATE topics
      SET description = 'Revised release planning', last_seen_at = 5300
      WHERE id = 'legacy-topic-1';
      UPDATE session_topics
      SET analysis_run_id = 'legacy-run-2'
      WHERE session_id = 'session-1' AND topic_id = 'legacy-topic-1';
    `);

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 5,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT revision, lifecycle, content_json
           FROM session_summary_revisions ORDER BY revision`
        )
        .all()
        .map((row) => ({ ...row, content: JSON.parse(row.content_json) }))
        .map(({ content_json: _contentJson, ...row }) => row),
      [
        {
          revision: 1,
          lifecycle: "superseded",
          content: {
            decisions: ["Keep the local database"],
            suggestions: [{ content: "Review the release", reason: "Catch regressions" }],
            summary: "Legacy summary",
          },
        },
        {
          revision: 2,
          lifecycle: "active",
          content: {
            decisions: ["Keep the local database"],
            suggestions: [{ content: "Review the release", reason: "Catch regressions" }],
            summary: "Revised legacy summary",
          },
        },
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT revision, summary FROM topic_revisions ORDER BY revision").all(),
      [
        { revision: 1, summary: "Release planning" },
        { revision: 2, summary: "Revised release planning" },
      ]
    );
    assert.equal(db.prepare("SELECT count(*) count FROM topic_occurrences").get().count, 2);
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis completes a todo monotonically and never reopens it", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db);
    const repository = createRepository(db);
    repository.importLegacyAnalysis();

    db.prepare(
      `UPDATE todos
       SET status = 'completed', completed_at = 5200, updated_at = 5200
       WHERE id = 'legacy-todo-1'`
    ).run();
    assert.equal(repository.importLegacyAnalysis().importedRowCount, 1);
    assert.deepEqual(db.prepare("SELECT status, completed_at FROM todos_v2").get(), {
      status: "completed",
      completed_at: 5200,
    });

    db.prepare(
      `UPDATE todos
       SET status = 'open', completed_at = NULL, updated_at = 5300
       WHERE id = 'legacy-todo-1'`
    ).run();
    assert.equal(repository.importLegacyAnalysis().importedRowCount, 1);
    assert.deepEqual(db.prepare("SELECT status, completed_at FROM todos_v2").get(), {
      status: "completed",
      completed_at: 5200,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT from_status, to_status, reason, actor
           FROM todo_state_transitions ORDER BY occurred_at, id`
        )
        .all(),
      [
        {
          from_status: "open",
          to_status: "completed",
          reason: "user_action",
          actor: "user",
        },
      ]
    );
  } finally {
    db.close();
  }
});

test("importLegacyAnalysis adds later todo evidence without mutating legacy provenance", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    db.exec(`
      INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
        transcription_status, track_id, source_type, sequence_number, write_state
      ) VALUES (
        'chunk-todo-late', 'session-1', 'todo-late.wav', 2600, 2800, 200, '${HASH_C}', 9000,
        'completed', 'track-1', 'mic', 1, 'committed'
      );
      INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, person_id, speaker_label, text, confidence,
        is_stable, analysis_state, track_id, chunk_id, source_type, result_kind,
        version, model_version, completed_at
      ) VALUES (
        'segment-todo-late', 'session-1', 2600, 2800, 'person-self', 'SELF',
        'todo evidence later', 0.8, 0, 'pending', 'track-1', 'chunk-todo-late', 'mic',
        'provisional', 1, NULL, NULL
      );
      INSERT INTO analysis_runs (
        id, session_id, kind, window_start, window_end, input_hash, model,
        status, attempt_count, response_json, created_at, completed_at
      ) VALUES (
        'legacy-run-todo-late', 'session-1', 'final', 2600, 2800, '${HASH_C}', 'legacy-model',
        'completed', 1, '{}', 2800, 2900
      );
      INSERT INTO todos (
        id, content, normalized_content, status, confidence, created_at, updated_at,
        source_session_id, source_segment_id, analysis_run_id
      ) VALUES (
        'legacy-todo-late', 'Follow late evidence', 'follow late evidence', 'open', 0.8,
        2800, 2900, 'session-1', 'segment-todo-late', 'legacy-run-todo-late'
      );
    `);
    const repository = createRepository(db);

    assert.equal(repository.importLegacyAnalysis().importedRowCount, 1);
    assert.equal(
      db.prepare("SELECT provenance FROM todos_v2").get().provenance,
      "legacy_unverified"
    );
    assert.equal(db.prepare("SELECT count(*) count FROM evidence_refs").get().count, 0);

    db.prepare(
      `UPDATE transcript_segments
       SET result_kind = 'final', is_stable = 1, analysis_state = 'analyzed',
           model_version = 'whisper-v1', completed_at = 3000
       WHERE id = 'segment-todo-late'`
    ).run();
    assert.equal(repository.importLegacyAnalysis().importedRowCount, 1);
    assert.equal(
      db.prepare("SELECT provenance FROM todos_v2").get().provenance,
      "legacy_unverified"
    );
    assert.equal(db.prepare("SELECT count(*) count FROM evidence_refs").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) count FROM todo_occurrences").get().count, 2);
  } finally {
    db.close();
  }
});

test("audio tombstoning expires imported evidence without creating another legacy occurrence", () => {
  const db = createFixture();
  try {
    createLegacyAnalysisSchema(db);
    seedLegacyAnalysis(db);
    const repository = createRepository(db);
    repository.importLegacyAnalysis();
    const baseline = {
      maps: db.prepare("SELECT count(*) count FROM legacy_import_map").get().count,
      memories: db.prepare("SELECT count(*) count FROM memory_occurrences").get().count,
      todos: db.prepare("SELECT count(*) count FROM todo_occurrences").get().count,
      evidence: db.prepare("SELECT count(*) count FROM evidence_refs").get().count,
    };

    db.prepare("UPDATE audio_chunks SET deleted_at = 7000 WHERE id = 'chunk-1'").run();

    assert.deepEqual(repository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 0,
    });
    assert.deepEqual(
      {
        maps: db.prepare("SELECT count(*) count FROM legacy_import_map").get().count,
        memories: db.prepare("SELECT count(*) count FROM memory_occurrences").get().count,
        todos: db.prepare("SELECT count(*) count FROM todo_occurrences").get().count,
        evidence: db.prepare("SELECT count(*) count FROM evidence_refs").get().count,
      },
      baseline
    );
    assert.deepEqual(db.prepare("SELECT DISTINCT audio_state FROM evidence_refs").all(), [
      { audio_state: "expired" },
    ]);
  } finally {
    db.close();
  }
});

test("prepareAnalysisInput returns a worker-private live snapshot, bindings, and redaction terms", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const prepared = repository.prepareAnalysisInput(validInput());

    assert.equal(prepared.prepareToken, expectedPrepareToken());
    assert.deepEqual(prepared.segments, [
      {
        ordinal: 0,
        segmentId: "segment-1",
        segmentVersion: 1,
        textHash: sha256("durable evidence"),
        textSnapshot: "durable evidence",
        resultKind: "final",
        isStable: true,
        isCurrent: true,
        supersededBy: null,
        duplicateOf: null,
        startedAt: 1000,
        endedAt: 5000,
        speakerBindingLabel: "SELF",
      },
    ]);
    assert.deepEqual(prepared.speakerBindings, [
      {
        label: "SELF",
        subjectKind: "person",
        subjectId: "person-self",
        subjectDisplayNameSnapshot: "Local Self",
      },
    ]);
    assert.deepEqual(prepared.redactionTerms.participants, [
      { label: "SELF", names: ["Local Self"] },
    ]);
    assert.deepEqual(prepared.redactionTerms.deviceLabels, []);
  } finally {
    db.close();
  }
});

test("prepareAnalysisInput orders the complete manifest before assigning SELF and Pn labels", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const prepared = repository.prepareAnalysisInput(
      validInput({ segmentIds: ["segment-omitted", "segment-1"] })
    );

    assert.deepEqual(
      prepared.segments.map(({ ordinal, segmentId, speakerBindingLabel }) => ({
        ordinal,
        segmentId,
        speakerBindingLabel,
      })),
      [
        { ordinal: 0, segmentId: "segment-1", speakerBindingLabel: "SELF" },
        { ordinal: 1, segmentId: "segment-omitted", speakerBindingLabel: "P1" },
      ]
    );
    assert.deepEqual(
      prepared.speakerBindings.map(({ label, subjectId }) => ({ label, subjectId })),
      [
        { label: "SELF", subjectId: "person-self" },
        { label: "P1", subjectId: "person-other" },
      ]
    );
    for (const segment of prepared.segments) {
      assert.equal(segment.resultKind, "final");
      assert.equal(segment.isStable, true);
      assert.equal(segment.isCurrent, true);
      assert.equal(segment.supersededBy, null);
      assert.equal(segment.duplicateOf, null);
    }
  } finally {
    db.close();
  }
});

test("createAnalysisInput persists exact redacted payload and canonical v2 input identity", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const createInput = validCreateInput();
    const identity = expectedInputIdentity(createInput.cloudPayloadJson);
    const result = repository.createAnalysisInput(createInput);

    assert.deepEqual(result, {
      status: "created",
      candidateState: "pending",
      analysisInputId: "analysis_input-1",
      inputHash: identity.inputHash,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT input_hash, input_contract_version, redaction_version, cloud_payload_json,
                cloud_payload_bytes, cloud_payload_sha256
         FROM analysis_inputs`
        )
        .get(),
      {
        input_hash: identity.inputHash,
        input_contract_version: "jarvis-analysis-input-v2",
        redaction_version: "jarvis-redaction-v1",
        cloud_payload_json: createInput.cloudPayloadJson,
        cloud_payload_bytes: identity.cloudPayloadBytes,
        cloud_payload_sha256: identity.cloudPayloadSha256,
      }
    );
    assert.deepEqual(db.prepare("SELECT * FROM analysis_input_segments").get(), {
      analysis_input_id: "analysis_input-1",
      ordinal: 0,
      segment_id: "segment-1",
      segment_version: 1,
      text_hash: sha256("durable evidence"),
      text_snapshot: "durable evidence",
      speaker_binding_label: "SELF",
    });
    assert.deepEqual(db.prepare("SELECT * FROM analysis_input_speaker_bindings").get(), {
      analysis_input_id: "analysis_input-1",
      label: "SELF",
      subject_kind: "person",
      subject_id: "person-self",
      subject_display_name_snapshot: "Local Self",
    });
  } finally {
    db.close();
  }
});

test("createAnalysisInput validates exact cloud payload keys and manifest scope", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    for (const cloudPayload of [
      { ...validCloudPayload(), sessionId: "private" },
      validCloudPayload({ segments: [{ ...validCloudPayload().segments[0], startedAt: 999 }] }),
      validCloudPayload({ segments: [{ ...validCloudPayload().segments[0], speakerLabel: "P1" }] }),
      validCloudPayload({
        segments: [{ ...validCloudPayload().segments[0], quoteText: "forbidden" }],
      }),
    ]) {
      assert.throws(
        () =>
          repository.createAnalysisInput(
            validCreateInput({ cloudPayloadJson: JSON.stringify(cloudPayload) })
          ),
        { code: "MEMORY_CLOUD_PAYLOAD_INVALID" }
      );
    }
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    db.close();
  }
});

test("createAnalysisInput is canonically idempotent without consuming another id or clock", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    repository.createAnalysisInput(validCreateInput());
    assert.deepEqual(repository.createAnalysisInput(validCreateInput()), {
      status: "existing",
      candidateState: "pending",
      analysisInputId: "analysis_input-1",
      inputHash: expectedInputIdentity().inputHash,
    });
    assert.deepEqual(counters, { ids: 1, clocks: 1 });
  } finally {
    db.close();
  }
});

test("createAnalysisInput reports an already applied canonical input without another cloud attempt", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const first = repository.createAnalysisInput(validCreateInput());
    repository.applyCandidateAnalysis({
      analysisInputId: first.analysisInputId,
      inputHash: first.inputHash,
      candidate: validCandidate(),
    });

    assert.deepEqual(repository.createAnalysisInput(validCreateInput()), {
      status: "existing",
      candidateState: "applied",
      analysisInputId: first.analysisInputId,
      inputHash: first.inputHash,
    });
  } finally {
    db.close();
  }
});

test("createAnalysisInput changes identity when payload or immutable contract metadata changes", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    const first = repository.createAnalysisInput(validCreateInput());
    const changedPayload = JSON.stringify(
      validCloudPayload({
        segments: [{ ...validCloudPayload().segments[0], text: "other redaction" }],
      })
    );
    const second = repository.createAnalysisInput(
      validCreateInput({ cloudPayloadJson: changedPayload })
    );
    assert.notEqual(first.inputHash, second.inputHash);
    assert.deepEqual(counters, { ids: 2, clocks: 2 });
  } finally {
    db.close();
  }
});

test("getAnalysisInputForCloud returns exact payload scope without local identity data", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const input = repository.createAnalysisInput(validCreateInput());
    const first = repository.getAnalysisInputForCloud(input.analysisInputId);
    assert.deepEqual(first, {
      inputHash: input.inputHash,
      cloudPayloadJson: validCreateInput().cloudPayloadJson,
      allowedSegmentIds: ["segment-1"],
      allowedOwnerLabels: ["SELF"],
    });
    assert.equal("sessionId" in first, false);
    assert.equal("speakerBindings" in first, false);
    first.allowedSegmentIds.push("poison");
    assert.deepEqual(repository.getAnalysisInputForCloud(input.analysisInputId).allowedSegmentIds, [
      "segment-1",
    ]);
  } finally {
    db.close();
  }
});

test("createAnalysisInput rejects empty or duplicate ordered segment ids", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    assert.throws(() => repository.prepareAnalysisInput(validInput({ segmentIds: [] })), {
      code: "MEMORY_INPUT_EMPTY",
    });
    assert.throws(
      () => repository.prepareAnalysisInput(validInput({ segmentIds: ["segment-1", "segment-1"] })),
      { code: "MEMORY_INPUT_DUPLICATE_SEGMENT" }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    db.close();
  }
});

test("createAnalysisInput rejects cross-session, missing, and provisional segments atomically", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    for (const segmentIds of [["segment-other"], ["missing"], ["segment-provisional"]]) {
      assert.throws(() => repository.prepareAnalysisInput(validInput({ segmentIds })), {
        code: "MEMORY_INPUT_STALE",
      });
    }
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM analysis_input_segments").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test("applyCandidateAnalysis writes closed entities, occurrences, revisions, and locally derived evidence", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const candidate = validCandidate({
      todos: [{ ...validCandidate().todos[0], ownerLabel: null }],
    });
    const result = repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate,
    });

    assert.deepEqual(result, {
      status: "applied",
      analysisInputId: input.analysisInputId,
      candidateHash: sha256(canonicalJson(candidate)),
      rawCandidateHash: sha256(canonicalJson(candidate)),
      semanticCandidateHash: semanticCandidateHash(candidate),
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT
           (SELECT count(*) FROM memory_items_v2) AS memories,
           (SELECT count(*) FROM memory_occurrences) AS memory_occurrences,
           (SELECT count(*) FROM topics_v2) AS topics,
           (SELECT count(*) FROM topic_revisions) AS topic_revisions,
           (SELECT count(*) FROM topic_occurrences) AS topic_occurrences,
           (SELECT count(*) FROM todos_v2) AS todos,
           (SELECT count(*) FROM todo_revisions) AS todo_revisions,
           (SELECT count(*) FROM todo_occurrences) AS todo_occurrences,
           (SELECT count(*) FROM todo_state_transitions) AS todo_transitions,
           (SELECT count(*) FROM suggestions_v2) AS suggestions,
           (SELECT count(*) FROM suggestion_occurrences) AS suggestion_occurrences,
           (SELECT count(*) FROM session_summary_revisions) AS summaries,
           (SELECT count(*) FROM evidence_refs) AS evidence`
        )
        .get(),
      {
        memories: 1,
        memory_occurrences: 1,
        topics: 1,
        topic_revisions: 1,
        topic_occurrences: 1,
        todos: 1,
        todo_revisions: 1,
        todo_occurrences: 1,
        todo_transitions: 1,
        suggestions: 1,
        suggestion_occurrences: 1,
        summaries: 1,
        evidence: 4,
      }
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT owner_subject_kind, owner_subject_id, owner_display_name_snapshot
           FROM todos_v2`
        )
        .get(),
      {
        owner_subject_kind: null,
        owner_subject_id: null,
        owner_display_name_snapshot: null,
      }
    );
    assert.equal(repository.readPublicSnapshot().todos[0].ownerLabel, null);
    assert.deepEqual(
      db
        .prepare(
          `SELECT DISTINCT session_id, transcript_segment_id, audio_chunk_id, track_id,
                         started_at, ended_at, quote_text, audio_state
         FROM evidence_refs`
        )
        .get(),
      {
        session_id: "session-1",
        transcript_segment_id: "segment-1",
        audio_chunk_id: "chunk-1",
        track_id: "track-1",
        started_at: 1000,
        ended_at: 5000,
        quote_text: "durable evidence",
        audio_state: "available",
      }
    );
    for (const table of [
      "memory_occurrences",
      "topic_occurrences",
      "todo_occurrences",
      "suggestion_occurrences",
    ]) {
      assert.deepEqual(
        db.prepare(`SELECT analysis_input_id, legacy_session_id FROM ${table}`).get(),
        { analysis_input_id: input.analysisInputId, legacy_session_id: null }
      );
    }
  } finally {
    db.close();
  }
});

test("applyCandidateAnalysis rejects model-controlled local fields and evidence ranges", () => {
  for (const mutate of [
    (candidate) => (candidate.sessionSummary.id = "model-id"),
    (candidate) => (candidate.memories[0].status = "active"),
    (candidate) => (candidate.topics[0].quoteText = "invented"),
    (candidate) => (candidate.todos[0].startedAt = 1000),
  ]) {
    const db = createFixture();
    try {
      const { repository, input } = createStoredInput(db);
      const candidate = validCandidate();
      mutate(candidate);
      assert.throws(
        () =>
          repository.applyCandidateAnalysis({
            analysisInputId: input.analysisInputId,
            inputHash: input.inputHash,
            candidate,
          }),
        { code: "MEMORY_CANDIDATE_INVALID" }
      );
      assert.equal(
        db.prepare("SELECT candidate_hash FROM analysis_inputs").get().candidate_hash,
        null
      );
      assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 0);
    } finally {
      db.close();
    }
  }
});

test("applyCandidateAnalysis enforces factual evidence scope and local owner bindings", () => {
  for (const [candidate, code] of [
    [
      validCandidate({
        memories: [{ ...validCandidate().memories[0], evidenceSegmentIds: [] }],
      }),
      "MEMORY_EVIDENCE_REQUIRED",
    ],
    [
      validCandidate({
        topics: [{ ...validCandidate().topics[0], evidenceSegmentIds: ["segment-other"] }],
      }),
      "MEMORY_EVIDENCE_OUT_OF_SCOPE",
    ],
    [
      validCandidate({ todos: [{ ...validCandidate().todos[0], ownerLabel: "P1" }] }),
      "MEMORY_OWNER_OUT_OF_SCOPE",
    ],
  ]) {
    const db = createFixture();
    try {
      const { repository, input } = createStoredInput(db);
      assert.throws(
        () =>
          repository.applyCandidateAnalysis({
            analysisInputId: input.analysisInputId,
            inputHash: input.inputHash,
            candidate,
          }),
        { code }
      );
      assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 0);
    } finally {
      db.close();
    }
  }
});

test("applyCandidateAnalysis verifies claimed candidate hash and is exactly idempotent", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const { repository, input } = createStoredInput(db, counters);
    const candidate = validCandidate();
    const candidateHash = sha256(canonicalJson(candidate));
    assert.throws(
      () =>
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate,
          claimedCandidateHash: HASH_A,
        }),
      { code: "MEMORY_CANDIDATE_HASH_MISMATCH" }
    );
    const applied = repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate,
      claimedCandidateHash: candidateHash,
    });
    const countsAfterApply = { ...counters };
    assert.equal(applied.status, "applied");
    assert.deepEqual(
      repository.applyCandidateAnalysis({
        analysisInputId: input.analysisInputId,
        inputHash: input.inputHash,
        candidate,
      }),
      {
        status: "already_applied",
        analysisInputId: input.analysisInputId,
        candidateHash,
        rawCandidateHash: candidateHash,
        semanticCandidateHash: semanticCandidateHash(candidate),
      }
    );
    assert.deepEqual(counters, countsAfterApply);
    assert.throws(
      () =>
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate: validCandidate({ suggestions: [] }),
        }),
      { code: "MEMORY_CANDIDATE_ALREADY_APPLIED" }
    );
  } finally {
    db.close();
  }
});

test("reordered semantic retry is read-only and consumes no planner clock or ID work", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  const MemoryMerger = require("../../src/jarvis/main/MemoryMerger").MemoryMerger;
  const realMerger = new MemoryMerger();
  let plannerCalls = 0;
  try {
    const { repository, input } = createStoredInput(db, counters, {
      memoryMerger: {
        plan(plannerInput) {
          plannerCalls += 1;
          return realMerger.plan(plannerInput);
        },
      },
    });
    const candidate = validCandidate({
      suggestions: [
        validCandidate().suggestions[0],
        {
          title: "Check the release notes",
          rationale: "A second review catches omissions.",
          basedOnEvidenceSegmentIds: [],
        },
      ],
    });
    const applied = repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate,
    });
    const countersAfterApply = { ...counters };
    assert.equal(plannerCalls, 1);

    const reordered = { ...candidate, suggestions: [...candidate.suggestions].reverse() };
    assert.deepEqual(
      repository.applyCandidateAnalysis({
        analysisInputId: input.analysisInputId,
        inputHash: input.inputHash,
        candidate: reordered,
      }),
      {
        status: "already_applied",
        analysisInputId: input.analysisInputId,
        candidateHash: sha256(canonicalJson(reordered)),
        rawCandidateHash: sha256(canonicalJson(reordered)),
        semanticCandidateHash: applied.semanticCandidateHash,
      }
    );
    assert.equal(plannerCalls, 1);
    assert.deepEqual(counters, countersAfterApply);
  } finally {
    db.close();
  }
});

test("applyCandidateAnalysis rolls back every derived row when the final CAS fails", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    db.exec(`
      CREATE TRIGGER reject_memory_candidate_cas
      BEFORE UPDATE OF candidate_hash ON analysis_inputs
      BEGIN
        SELECT RAISE(ABORT, 'injected candidate CAS failure');
      END;
    `);

    assert.throws(
      () =>
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate: validCandidate(),
        }),
      /injected candidate CAS failure/
    );
    assert.equal(
      db.prepare("SELECT candidate_hash FROM analysis_inputs").get().candidate_hash,
      null
    );
    for (const table of [
      "memory_items_v2",
      "memory_occurrences",
      "topics_v2",
      "topic_revisions",
      "topic_occurrences",
      "todos_v2",
      "todo_revisions",
      "todo_occurrences",
      "suggestions_v2",
      "suggestion_occurrences",
      "session_summary_revisions",
      "evidence_refs",
    ]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
    }
  } finally {
    db.close();
  }
});

test("applyCandidateAnalysis appends topic and summary revisions while reusing the planned todo revision", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    const nextInput = createAlternativeInput(repository, "second redaction");
    const nextCandidate = validCandidate({
      sessionSummary: {
        ...validCandidate().sessionSummary,
        summary: "A revised durable session summary.",
      },
      topics: [{ ...validCandidate().topics[0], summary: "Revised local-first architecture" }],
      todos: [{ ...validCandidate().todos[0], dueText: "tomorrow" }],
    });
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: nextCandidate,
    });

    const topicRevisions = db
      .prepare(
        `SELECT id, revision, previous_revision_id, summary
         FROM topic_revisions ORDER BY revision`
      )
      .all();
    assert.equal(topicRevisions.length, 2);
    assert.deepEqual(
      topicRevisions.map(({ revision, summary }) => ({ revision, summary })),
      [
        { revision: 1, summary: "Local-first architecture" },
        { revision: 2, summary: "Revised local-first architecture" },
      ]
    );
    assert.equal(topicRevisions[1].previous_revision_id, topicRevisions[0].id);

    const todoRevisions = db
      .prepare(
        `SELECT id, revision, previous_revision_id, due_text
         FROM todo_revisions ORDER BY revision`
      )
      .all();
    assert.equal(todoRevisions.length, 1);
    assert.equal(todoRevisions[0].previous_revision_id, null);
    assert.equal(todoRevisions[0].due_text, null);
    assert.deepEqual(
      db
        .prepare("SELECT todo_revision_id FROM todo_occurrences ORDER BY created_at, id")
        .all()
        .map((row) => row.todo_revision_id),
      [todoRevisions[0].id]
    );

    const summaries = db
      .prepare(
        `SELECT id, revision, previous_revision_id, lifecycle, content_json
         FROM session_summary_revisions ORDER BY revision`
      )
      .all();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].lifecycle, "superseded");
    assert.equal(summaries[1].lifecycle, "active");
    assert.equal(summaries[1].previous_revision_id, summaries[0].id);
    assert.deepEqual(JSON.parse(summaries[0].content_json), {
      title: "Session title",
      summary: "A durable session summary.",
    });
    assert.deepEqual(JSON.parse(summaries[1].content_json), {
      title: "Session title",
      summary: "A revised durable session summary.",
    });
  } finally {
    db.close();
  }
});

test("normalized-identical session summary reuses active history when evidence is already linked", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    const candidate = validCandidate({ memories: [], topics: [], todos: [], suggestions: [] });
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate,
    });
    const nextInput = createAlternativeInput(repository, "normalized summary retry");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: {
        ...candidate,
        sessionSummary: {
          title: "SESSION   TITLE",
          summary: "a DURABLE session summary.",
          evidenceSegmentIds: ["segment-1"],
        },
      },
    });

    assert.deepEqual(
      db
        .prepare(
          `SELECT revision, previous_revision_id, lifecycle, content_json
           FROM session_summary_revisions`
        )
        .all(),
      [
        {
          revision: 1,
          previous_revision_id: null,
          lifecycle: "active",
          content_json: JSON.stringify({
            title: "Session title",
            summary: "A durable session summary.",
          }),
        },
      ]
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM evidence_refs").get().count, 1);
  } finally {
    db.close();
  }
});

test("contradictory memory values create an episode and resolution is terminal and idempotent", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const { repository, input } = createStoredInput(db, counters);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    const nextInput = createAlternativeInput(repository, "contradictory redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        memories: [
          {
            ...validCandidate().memories[0],
            body: "Use the cloud-first deployment.",
          },
        ],
      }),
    });

    const memories = db
      .prepare("SELECT id, body, lifecycle FROM memory_items_v2 ORDER BY created_at, id")
      .all();
    assert.deepEqual(
      memories.map(({ body, lifecycle }) => ({ body, lifecycle })),
      [
        { body: "Use the local-first deployment.", lifecycle: "conflict" },
        { body: "Use the cloud-first deployment.", lifecycle: "conflict" },
      ]
    );
    const group = db.prepare("SELECT * FROM memory_conflict_groups").get();
    assert.equal(group.episode, 1);
    assert.equal(group.state, "open");
    assert.deepEqual(
      db
        .prepare(
          "SELECT memory_item_id FROM memory_conflict_members WHERE group_id = ? ORDER BY memory_item_id"
        )
        .all(group.id)
        .map((row) => row.memory_item_id),
      memories.map((memory) => memory.id).sort()
    );

    const selected = memories[0];
    assert.deepEqual(
      repository.resolveMemoryConflict({
        conflictGroupId: group.id,
        selectedMemoryItemId: selected.id,
      }),
      {
        status: "resolved",
        conflictGroupId: group.id,
        selectedMemoryItemId: selected.id,
      }
    );
    const countersAfterResolve = { ...counters };
    assert.deepEqual(
      repository.resolveMemoryConflict({
        conflictGroupId: group.id,
        selectedMemoryItemId: selected.id,
      }),
      {
        status: "already_resolved",
        conflictGroupId: group.id,
        selectedMemoryItemId: selected.id,
      }
    );
    assert.deepEqual(counters, countersAfterResolve);
    assert.throws(
      () =>
        repository.resolveMemoryConflict({
          conflictGroupId: group.id,
          selectedMemoryItemId: memories[1].id,
        }),
      { code: "MEMORY_CONFLICT_ALREADY_RESOLVED" }
    );
    assert.deepEqual(
      db.prepare("SELECT state, selected_member_id FROM memory_conflict_groups").get(),
      { state: "resolved", selected_member_id: selected.id }
    );
    assert.deepEqual(
      db.prepare("SELECT body, lifecycle FROM memory_items_v2 ORDER BY body").all(),
      [
        { body: "Use the cloud-first deployment.", lifecycle: "superseded" },
        { body: "Use the local-first deployment.", lifecycle: "active" },
      ]
    );
    assert.deepEqual(
      db
        .prepare("SELECT previous_id, next_id, reason, analysis_input_id FROM memory_supersessions")
        .get(),
      {
        previous_id: memories[1].id,
        next_id: selected.id,
        reason: "conflict_resolution",
        analysis_input_id: null,
      }
    );
  } finally {
    db.close();
  }
});

test("a contradiction after resolution creates a new conflict episode instead of reopening history", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    const secondInput = createAlternativeInput(repository, "second redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: secondInput.analysisInputId,
      inputHash: secondInput.inputHash,
      candidate: validCandidate({
        memories: [{ ...validCandidate().memories[0], body: "Use the cloud-first deployment." }],
      }),
    });
    const firstGroup = db.prepare("SELECT id FROM memory_conflict_groups").get();
    const selected = db
      .prepare("SELECT id FROM memory_items_v2 WHERE body = ?")
      .get("Use the local-first deployment.");
    repository.resolveMemoryConflict({
      conflictGroupId: firstGroup.id,
      selectedMemoryItemId: selected.id,
    });

    const thirdInput = createAlternativeInput(repository, "third redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: thirdInput.analysisInputId,
      inputHash: thirdInput.inputHash,
      candidate: validCandidate({
        memories: [{ ...validCandidate().memories[0], body: "Use the hybrid deployment." }],
      }),
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT episode, state, selected_member_id
           FROM memory_conflict_groups ORDER BY episode`
        )
        .all(),
      [
        { episode: 1, state: "resolved", selected_member_id: selected.id },
        { episode: 2, state: "open", selected_member_id: null },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT item.body
           FROM memory_conflict_members AS member
           JOIN memory_conflict_groups AS conflict ON conflict.id = member.group_id
           JOIN memory_items_v2 AS item ON item.id = member.memory_item_id
           WHERE conflict.episode = 2 ORDER BY item.body`
        )
        .all()
        .map((row) => row.body),
      ["Use the hybrid deployment.", "Use the local-first deployment."]
    );
  } finally {
    db.close();
  }
});

test("later analysis cannot reopen a terminal todo and preserves append-only transitions", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    const todo = db.prepare("SELECT id FROM todos_v2").get();
    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason,
         source_analysis_input_id, actor, occurred_at
       ) VALUES ('user-complete', ?, 'open', 'completed', 'user_action', NULL, 'user', 7000)`
    ).run(todo.id);

    const nextInput = createAlternativeInput(repository, "terminal todo redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        todos: [{ ...validCandidate().todos[0], dueText: "next week" }],
      }),
    });
    assert.deepEqual(db.prepare("SELECT status, completed_at, dismissed_at FROM todos_v2").get(), {
      status: "completed",
      completed_at: 7000,
      dismissed_at: null,
    });
    assert.equal(db.prepare("SELECT count(*) AS count FROM todo_occurrences").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM todo_revisions").get().count, 1);
    assert.deepEqual(
      db
        .prepare(
          `SELECT from_status, to_status, reason, actor
           FROM todo_state_transitions ORDER BY occurred_at`
        )
        .all(),
      [
        { from_status: null, to_status: "open", reason: "analysis_created", actor: "system" },
        { from_status: "open", to_status: "completed", reason: "user_action", actor: "user" },
      ]
    );
  } finally {
    db.close();
  }
});

test("strictly later evidence applies a closed todo A to B to C recurrence chain", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const firstInput = repository.createAnalysisInput(validCreateInput());
    repository.applyCandidateAnalysis({
      analysisInputId: firstInput.analysisInputId,
      inputHash: firstInput.inputHash,
      candidate: validCandidate({
        memories: [],
        topics: [],
        suggestions: [],
        todos: [
          {
            title: "Prepare the release",
            ownerLabel: null,
            dueText: null,
            evidenceSegmentIds: ["segment-1"],
          },
        ],
      }),
    });
    const previous = db.prepare("SELECT id FROM todos_v2").get();
    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason,
         source_analysis_input_id, actor, occurred_at
       ) VALUES ('complete-before-later-evidence', ?, 'open', 'completed',
                 'user_action', NULL, 'user', 4000)`
    ).run(previous.id);

    const request = validInput({
      transcriptRevision: HASH_C,
      segmentIds: ["segment-omitted"],
    });
    const prepared = repository.prepareAnalysisInput(request);
    const nextInput = repository.createAnalysisInput({
      ...request,
      prepareToken: prepared.prepareToken,
      inputContractVersion: "jarvis-analysis-input-v2",
      redactionVersion: "jarvis-redaction-v1",
      cloudPayloadJson: JSON.stringify({
        inputVersion: "jarvis-analysis-input-v2",
        segments: [
          {
            segmentId: "segment-omitted",
            startedAt: 5000,
            endedAt: 5500,
            speakerLabel: "P1",
            text: "later redacted evidence",
          },
        ],
        omittedRanges: [],
      }),
    });
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        sessionSummary: {
          title: "Later session title",
          summary: "A later durable session summary.",
          evidenceSegmentIds: ["segment-omitted"],
        },
        memories: [],
        topics: [],
        suggestions: [],
        todos: [
          {
            title: "Prepare the release",
            ownerLabel: null,
            dueText: "Next week",
            evidenceSegmentIds: ["segment-omitted"],
          },
        ],
      }),
    });

    const todos = db
      .prepare(
        `SELECT id, status, completed_at, recurrence_of_id
         FROM todos_v2 ORDER BY created_at, id`
      )
      .all();
    assert.deepEqual(
      todos.map(({ status, completed_at, recurrence_of_id }) => ({
        status,
        completed_at,
        recurrence_of_id,
      })),
      [
        { status: "completed", completed_at: 4000, recurrence_of_id: null },
        { status: "open", completed_at: null, recurrence_of_id: previous.id },
      ]
    );
    const nextOccurrence = db
      .prepare(
        "SELECT id, todo_instance_id, started_at FROM todo_occurrences WHERE started_at = 5000"
      )
      .get();
    const recurrence = db.prepare("SELECT * FROM todo_recurrences").get();
    assert.match(recurrence.id, /^[A-Za-z0-9_-]+$/);
    assert.equal(Number.isSafeInteger(recurrence.created_at), true);
    assert.deepEqual(
      {
        previous_todo_id: recurrence.previous_todo_id,
        next_todo_id: recurrence.next_todo_id,
        source_occurrence_id: recurrence.source_occurrence_id,
      },
      {
        previous_todo_id: previous.id,
        next_todo_id: todos[1].id,
        source_occurrence_id: nextOccurrence.id,
      }
    );
    assert.equal(nextOccurrence.todo_instance_id, todos[1].id);
    assert.deepEqual(
      db
        .prepare(
          `SELECT from_status, to_status, reason, actor
           FROM todo_state_transitions ORDER BY rowid`
        )
        .all(),
      [
        { from_status: null, to_status: "open", reason: "analysis_created", actor: "system" },
        { from_status: "open", to_status: "completed", reason: "user_action", actor: "user" },
        { from_status: null, to_status: "open", reason: "recurrence", actor: "system" },
      ]
    );

    db.prepare(
      `INSERT INTO todo_state_transitions (
         id, todo_instance_id, from_status, to_status, reason,
         source_analysis_input_id, actor, occurred_at
       ) VALUES ('complete-second-recurrence', ?, 'open', 'completed',
                 'user_action', NULL, 'user', 5600)`
    ).run(todos[1].id);
    const thirdInput = createInputForSegments(
      repository,
      ["segment-other"],
      "third-recurrence",
      "session-2"
    );
    repository.applyCandidateAnalysis({
      analysisInputId: thirdInput.analysisInputId,
      inputHash: thirdInput.inputHash,
      candidate: validCandidate({
        sessionSummary: {
          title: "Third session title",
          summary: "A third durable session summary.",
          evidenceSegmentIds: ["segment-other"],
        },
        memories: [],
        topics: [],
        suggestions: [],
        todos: [
          {
            title: "Prepare the release",
            ownerLabel: null,
            dueText: "Next month",
            evidenceSegmentIds: ["segment-other"],
          },
        ],
      }),
    });

    const chain = db
      .prepare(
        `SELECT id, status, completed_at, recurrence_of_id
         FROM todos_v2 ORDER BY created_at, id`
      )
      .all();
    assert.deepEqual(
      chain.map(({ status, completed_at, recurrence_of_id }) => ({
        status,
        completed_at,
        recurrence_of_id,
      })),
      [
        { status: "completed", completed_at: 4000, recurrence_of_id: null },
        { status: "completed", completed_at: 5600, recurrence_of_id: previous.id },
        { status: "open", completed_at: null, recurrence_of_id: todos[1].id },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT previous_todo_id, next_todo_id
           FROM todo_recurrences ORDER BY created_at, id`
        )
        .all(),
      [
        { previous_todo_id: previous.id, next_todo_id: todos[1].id },
        { previous_todo_id: todos[1].id, next_todo_id: chain[2].id },
      ]
    );
  } finally {
    db.close();
  }
});

test("cloud authorization is derived only from selected payload segments and their bindings", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const request = validInput({ segmentIds: ["segment-1", "segment-omitted"] });
    const prepared = repository.prepareAnalysisInput(request);
    assert.deepEqual(
      prepared.speakerBindings.map((binding) => binding.label),
      ["SELF", "P1"]
    );
    const cloudPayloadJson = JSON.stringify(
      validCloudPayload({ omittedRanges: [{ startedAt: 5000, endedAt: 5500 }] })
    );
    const input = repository.createAnalysisInput({
      ...request,
      prepareToken: prepared.prepareToken,
      inputContractVersion: "jarvis-analysis-input-v2",
      redactionVersion: "jarvis-redaction-v1",
      cloudPayloadJson,
    });
    assert.deepEqual(repository.getAnalysisInputForCloud(input.analysisInputId), {
      inputHash: input.inputHash,
      cloudPayloadJson,
      allowedSegmentIds: ["segment-1"],
      allowedOwnerLabels: ["SELF"],
    });
    assert.throws(
      () =>
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate: validCandidate({
            memories: [
              { ...validCandidate().memories[0], evidenceSegmentIds: ["segment-omitted"] },
            ],
          }),
        }),
      { code: "MEMORY_EVIDENCE_OUT_OF_SCOPE" }
    );
    assert.throws(
      () =>
        repository.applyCandidateAnalysis({
          analysisInputId: input.analysisInputId,
          inputHash: input.inputHash,
          candidate: validCandidate({
            todos: [{ ...validCandidate().todos[0], ownerLabel: "P1" }],
          }),
        }),
      { code: "MEMORY_OWNER_OUT_OF_SCOPE" }
    );
    assert.equal(
      db.prepare("SELECT candidate_hash FROM analysis_inputs").get().candidate_hash,
      null
    );
  } finally {
    db.close();
  }
});

test("cloud payload partitions every manifest segment into selected or fully omitted ranges", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const request = validInput({ segmentIds: ["segment-1", "segment-omitted"] });
    const prepared = repository.prepareAnalysisInput(request);
    const selectedOmittedSegment = {
      segmentId: "segment-omitted",
      startedAt: 5000,
      endedAt: 5500,
      speakerLabel: "P1",
      text: "redacted omitted evidence",
    };
    const invalidPayloads = [
      validCloudPayload({ omittedRanges: [] }),
      validCloudPayload({ omittedRanges: [{ startedAt: 5000, endedAt: 5200 }] }),
      validCloudPayload({
        segments: [...validCloudPayload().segments, selectedOmittedSegment],
        omittedRanges: [{ startedAt: 5000, endedAt: 5500 }],
      }),
      validCloudPayload({
        segments: [],
        omittedRanges: [{ startedAt: 1000, endedAt: 5500 }],
      }),
      validCloudPayload({
        omittedRanges: [
          { startedAt: 5000, endedAt: 5500 },
          { startedAt: 5000, endedAt: 5500 },
        ],
      }),
      validCloudPayload({
        omittedRanges: [
          { startedAt: 5000, endedAt: 5500 },
          { startedAt: 5200, endedAt: 5300 },
        ],
      }),
    ];
    for (const cloudPayload of invalidPayloads) {
      assert.throws(
        () =>
          repository.createAnalysisInput({
            ...request,
            prepareToken: prepared.prepareToken,
            inputContractVersion: "jarvis-analysis-input-v2",
            redactionVersion: "jarvis-redaction-v1",
            cloudPayloadJson: JSON.stringify(cloudPayload),
          }),
        { code: "MEMORY_CLOUD_PAYLOAD_INVALID" }
      );
    }
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    db.close();
  }
});

test("prepare token binds create to the exact live segment and speaker snapshot", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const prepared = repository.prepareAnalysisInput(validInput());
    db.prepare("UPDATE people SET display_name = 'Renamed Self' WHERE id = 'person-self'").run();
    assert.throws(
      () =>
        repository.createAnalysisInput(validCreateInput({ prepareToken: prepared.prepareToken })),
      { code: "MEMORY_PREPARE_STALE" }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    db.close();
  }
});

test("redaction verification is required and fails closed for private payload text", () => {
  const forbidden = ["Local Self", "SteelSeries Sonar", "C:\\private\\capture.wav", "api-secret"];
  const db = createFixture();
  let calls = 0;
  try {
    const repository = createRepository(
      db,
      { ids: 0, clocks: 0 },
      {
        validateRedactedCloudPayload({ cloudPayload, preparedSnapshot }) {
          calls += 1;
          assert.equal(preparedSnapshot.prepareToken, expectedPrepareToken());
          return !cloudPayload.segments.some((segment) =>
            forbidden.some((term) => segment.text.includes(term))
          );
        },
      }
    );
    for (const term of forbidden) {
      const cloudPayloadJson = JSON.stringify(
        validCloudPayload({
          segments: [{ ...validCloudPayload().segments[0], text: `leak ${term}` }],
        })
      );
      assert.throws(() => repository.createAnalysisInput(validCreateInput({ cloudPayloadJson })), {
        code: "MEMORY_REDACTION_UNVERIFIED",
      });
    }
    assert.equal(calls, forbidden.length);
    assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count, 0);
  } finally {
    db.close();
  }

  for (const validateRedactedCloudPayload of [
    () => false,
    () => "true",
    () => {
      throw new Error("validator unavailable");
    },
  ]) {
    const isolatedDb = createFixture();
    try {
      const repository = createRepository(
        isolatedDb,
        { ids: 0, clocks: 0 },
        {
          validateRedactedCloudPayload,
        }
      );
      assert.throws(() => repository.createAnalysisInput(validCreateInput()), {
        code: "MEMORY_REDACTION_UNVERIFIED",
      });
      assert.equal(
        isolatedDb.prepare("SELECT count(*) AS count FROM analysis_inputs").get().count,
        0
      );
    } finally {
      isolatedDb.close();
    }
  }
});

test("existing input idempotency reloads and verifies the complete stored tuple", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    repository.createAnalysisInput(validCreateInput());
    const countersAfterCreate = { ...counters };
    const corruptedPayload = JSON.stringify(
      validCloudPayload({
        segments: [{ ...validCloudPayload().segments[0], text: "corrupted redaction" }],
      })
    );
    db.exec("DROP TRIGGER analysis_inputs_immutable_update");
    db.prepare(
      `UPDATE analysis_inputs
       SET cloud_payload_json = ?, cloud_payload_bytes = ?, cloud_payload_sha256 = ?`
    ).run(corruptedPayload, Buffer.byteLength(corruptedPayload, "utf8"), sha256(corruptedPayload));
    assert.throws(() => repository.createAnalysisInput(validCreateInput()), {
      code: "MEMORY_INPUT_CORRUPT",
    });
    assert.deepEqual(counters, countersAfterCreate);
  } finally {
    db.close();
  }
});

test("canonical keys use locale-independent Unicode lowercasing", () => {
  const db = createFixture();
  const original = String.prototype.toLocaleLowerCase;
  try {
    String.prototype.toLocaleLowerCase = function forbiddenLocaleLowercase() {
      throw new Error("locale-sensitive lowercasing called");
    };
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate({
        memories: [{ ...validCandidate().memories[0], title: "I" }],
        topics: [],
        todos: [],
        suggestions: [],
      }),
    });
    const nextInput = createAlternativeInput(repository, "locale independent redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        memories: [{ ...validCandidate().memories[0], title: "i" }],
        topics: [],
        todos: [],
        suggestions: [],
      }),
    });
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_items_v2").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_conflict_groups").get().count, 0);
  } finally {
    String.prototype.toLocaleLowerCase = original;
    db.close();
  }
});

test("saveDigestRevision is exactly idempotent for the same local source hash", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    const digest = {
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_A,
      inputWatermark: { latestAppliedAt: 6000, analysisInputIds: ["analysis_input-1"] },
      content: { title: "Daily digest", summary: "A partial day." },
      completeness: "partial",
    };
    assert.deepEqual(repository.saveDigestRevision(digest), {
      status: "created",
      digestId: "daily_digest-1",
      revision: 1,
      sourceHash: HASH_A,
    });
    const countersAfterCreate = { ...counters };
    assert.deepEqual(repository.saveDigestRevision(digest), {
      status: "existing",
      digestId: "daily_digest-1",
      revision: 1,
      sourceHash: HASH_A,
    });
    assert.deepEqual(counters, countersAfterCreate);
    assert.deepEqual(
      db
        .prepare(
          `SELECT local_date, timezone, revision, completeness, lifecycle,
                input_watermark_json, content_json, source_hash
         FROM daily_digests`
        )
        .get(),
      {
        local_date: "2026-07-16",
        timezone: "Asia/Shanghai",
        revision: 1,
        completeness: "partial",
        lifecycle: "active",
        input_watermark_json: canonicalJson(digest.inputWatermark),
        content_json: canonicalJson(digest.content),
        source_hash: HASH_A,
      }
    );
  } finally {
    db.close();
  }
});

test("saveDigestRevision rejects reuse of a source hash for different canonical content", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    const digest = {
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_A,
      inputWatermark: { latestAppliedAt: 6000 },
      content: { summary: "First" },
      completeness: "partial",
    };
    repository.saveDigestRevision(digest);
    const countersAfterCreate = { ...counters };
    assert.throws(
      () => repository.saveDigestRevision({ ...digest, content: { summary: "Different" } }),
      { code: "MEMORY_DIGEST_HASH_COLLISION" }
    );
    assert.deepEqual(counters, countersAfterCreate);
    assert.equal(db.prepare("SELECT count(*) AS count FROM daily_digests").get().count, 1);
  } finally {
    db.close();
  }
});

test("saveDigestRevision appends partial-to-final history and rejects completeness regression", () => {
  const db = createFixture();
  const counters = { ids: 0, clocks: 0 };
  try {
    const repository = createRepository(db, counters);
    repository.saveDigestRevision({
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_A,
      inputWatermark: { latestAppliedAt: 6000 },
      content: { summary: "Partial" },
      completeness: "partial",
    });
    assert.deepEqual(
      repository.saveDigestRevision({
        localDate: "2026-07-16",
        timezone: "Asia/Shanghai",
        sourceHash: HASH_B,
        inputWatermark: { latestAppliedAt: 9000 },
        content: { summary: "Final" },
        completeness: "final",
      }),
      {
        status: "created",
        digestId: "daily_digest-2",
        revision: 2,
        sourceHash: HASH_B,
      }
    );
    const revisions = db
      .prepare(
        `SELECT id, revision, previous_revision_id, completeness, lifecycle, content_json
         FROM daily_digests ORDER BY revision`
      )
      .all();
    assert.equal(revisions.length, 2);
    assert.deepEqual(
      revisions.map(({ revision, completeness, lifecycle, content_json }) => ({
        revision,
        completeness,
        lifecycle,
        content: JSON.parse(content_json),
      })),
      [
        {
          revision: 1,
          completeness: "partial",
          lifecycle: "superseded",
          content: { summary: "Partial" },
        },
        { revision: 2, completeness: "final", lifecycle: "active", content: { summary: "Final" } },
      ]
    );
    assert.equal(revisions[1].previous_revision_id, revisions[0].id);
    const countersBeforeRegression = { ...counters };
    assert.throws(
      () =>
        repository.saveDigestRevision({
          localDate: "2026-07-16",
          timezone: "Asia/Shanghai",
          sourceHash: "c".repeat(64),
          inputWatermark: { latestAppliedAt: 10000 },
          content: { summary: "Late partial" },
          completeness: "partial",
        }),
      { code: "MEMORY_DIGEST_COMPLETENESS_REGRESSION" }
    );
    assert.deepEqual(counters, countersBeforeRegression);
    assert.equal(db.prepare("SELECT count(*) AS count FROM daily_digests").get().count, 2);
  } finally {
    db.close();
  }
});

test("saveDigestRevision validates local identity and rolls back supersession on insert failure", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const base = {
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_A,
      inputWatermark: { latestAppliedAt: 6000 },
      content: { summary: "First" },
      completeness: "partial",
    };
    for (const invalid of [
      { ...base, localDate: "2026-02-30" },
      { ...base, timezone: "Not/A_Real_Zone" },
      { ...base, sourceHash: "model hash" },
      { ...base, inputWatermark: { invalid: undefined } },
      { ...base, completeness: "incremental" },
    ]) {
      assert.throws(() => repository.saveDigestRevision(invalid));
    }
    repository.saveDigestRevision(base);
    db.exec(`
      CREATE TRIGGER reject_digest_insert
      BEFORE INSERT ON daily_digests
      WHEN NEW.revision = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected digest insert failure');
      END;
    `);
    assert.throws(
      () =>
        repository.saveDigestRevision({
          ...base,
          sourceHash: HASH_B,
          content: { summary: "Second" },
        }),
      /injected digest insert failure/
    );
    assert.deepEqual(db.prepare("SELECT revision, lifecycle FROM daily_digests").all(), [
      { revision: 1, lifecycle: "active" },
    ]);
  } finally {
    db.close();
  }
});

test("readPublicSnapshot exposes only renderer-safe allowlisted fields and fresh evidence arrays", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    repository.saveDigestRevision({
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_C,
      inputWatermark: {
        latestAppliedAt: 6000,
        analysisInputIds: ["private-analysis-input"],
        inputHash: HASH_A,
      },
      content: { summary: "Public digest" },
      completeness: "partial",
    });
    const snapshot = repository.readPublicSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "dailyDigests",
      "memories",
      "memoryConflicts",
      "sessionSummaries",
      "suggestions",
      "todos",
      "topics",
    ]);
    assert.equal(snapshot.memories.length, 1);
    assert.equal(snapshot.topics.length, 1);
    assert.equal(snapshot.todos.length, 1);
    assert.equal(snapshot.suggestions.length, 1);
    assert.equal(snapshot.sessionSummaries.length, 1);
    assert.equal(snapshot.dailyDigests.length, 1);
    assert.deepEqual(snapshot.memories[0].occurrences[0].evidence, [
      {
        sessionId: "session-1",
        segmentId: "segment-1",
        startedAt: 1000,
        endedAt: 5000,
        quote: "durable evidence",
        audioState: "available",
      },
    ]);
    assert.equal(snapshot.todos[0].ownerLabel, "Local Self");
    assert.deepEqual(snapshot.dailyDigests[0].content, { summary: "Public digest" });
    assert.equal("inputWatermark" in snapshot.dailyDigests[0], false);

    const forbiddenKeys = new Set([
      "analysisInputId",
      "analysisInputIds",
      "sourceAnalysisInputId",
      "inputHash",
      "candidateHash",
      "sourceHash",
      "canonicalKey",
      "canonicalSlotKey",
      "canonicalValueKey",
      "ownerSubjectId",
      "subjectId",
      "cloudPayloadJson",
      "prepareToken",
      "path",
      "deviceId",
      "deviceLabel",
      "embedding",
      "legacySessionId",
      "importRunId",
      "inputWatermark",
    ]);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `forbidden public key: ${key}`);
        visit(child);
      }
    };
    visit(snapshot);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("capture-1.wav"), false);
    assert.equal(serialized.includes(input.inputHash), false);
    assert.equal(serialized.includes(HASH_C), false);
    assert.equal(serialized.includes("private-analysis-input"), false);

    snapshot.memories[0].title = "poison";
    snapshot.memories[0].occurrences[0].evidence.push({ poison: true });
    const fresh = repository.readPublicSnapshot();
    assert.equal(fresh.memories[0].title, "Deployment choice");
    assert.equal(fresh.memories[0].occurrences[0].evidence.length, 1);
  } finally {
    db.close();
  }
});

test("readPublicSnapshot fails closed when durable JSON content is structurally corrupt", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    repository.saveDigestRevision({
      localDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      sourceHash: HASH_A,
      inputWatermark: { latestAppliedAt: 6000 },
      content: { summary: "Valid" },
      completeness: "partial",
    });
    db.exec("DROP TRIGGER daily_digests_immutable_content");
    db.prepare("UPDATE daily_digests SET content_json = '[]'").run();
    assert.throws(() => repository.readPublicSnapshot(), {
      code: "MEMORY_PUBLIC_READ_CORRUPT",
    });
  } finally {
    db.close();
  }
});

test("session deletion removes source occurrences but preserves durable public history", () => {
  const db = createFixture();
  try {
    db.prepare(
      "UPDATE transcript_segments SET person_id = NULL WHERE id = 'segment-omitted'"
    ).run();
    const repository = createRepository(db);
    const request = validInput({ segmentIds: ["segment-1", "segment-omitted"] });
    const prepared = repository.prepareAnalysisInput(request);
    const cloudPayloadJson = JSON.stringify({
      inputVersion: "jarvis-analysis-input-v2",
      segments: [
        validCloudPayload().segments[0],
        {
          segmentId: "segment-omitted",
          startedAt: 5000,
          endedAt: 5500,
          speakerLabel: "P1",
          text: "redacted private evidence",
        },
      ],
      omittedRanges: [],
    });
    const input = repository.createAnalysisInput({
      ...request,
      prepareToken: prepared.prepareToken,
      inputContractVersion: "jarvis-analysis-input-v2",
      redactionVersion: "jarvis-redaction-v1",
      cloudPayloadJson,
    });
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate({
        todos: [{ ...validCandidate().todos[0], ownerLabel: "P1" }],
      }),
    });
    assert.equal(
      db.prepare("SELECT owner_display_name_snapshot FROM todos_v2").get()
        .owner_display_name_snapshot,
      "P1"
    );
    assert.equal(repository.readPublicSnapshot().todos[0].ownerLabel, "P1");
    db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();

    assert.deepEqual(
      db
        .prepare(
          `SELECT
           (SELECT count(*) FROM memory_items_v2) AS memories,
           (SELECT count(*) FROM topics_v2) AS topics,
           (SELECT count(*) FROM todos_v2) AS todos,
           (SELECT count(*) FROM suggestions_v2) AS suggestions,
           (SELECT count(*) FROM memory_occurrences) AS memory_occurrences,
           (SELECT count(*) FROM topic_occurrences) AS topic_occurrences,
           (SELECT count(*) FROM todo_occurrences) AS todo_occurrences,
           (SELECT count(*) FROM evidence_refs) AS evidence,
           (SELECT count(*) FROM session_summary_revisions) AS summaries`
        )
        .get(),
      {
        memories: 1,
        topics: 1,
        todos: 1,
        suggestions: 1,
        memory_occurrences: 0,
        topic_occurrences: 0,
        todo_occurrences: 0,
        evidence: 0,
        summaries: 0,
      }
    );
    const snapshot = repository.readPublicSnapshot();
    assert.equal(snapshot.memories[0].provenance, "source_deleted");
    assert.equal(snapshot.topics[0].provenance, "source_deleted");
    assert.equal(snapshot.todos[0].provenance, "source_deleted");
    assert.equal(snapshot.todos[0].ownerLabel, "P1");
    assert.equal(snapshot.suggestions[0].provenance, "source_deleted");
    assert.deepEqual(snapshot.memories[0].occurrences, []);
    assert.deepEqual(snapshot.sessionSummaries, []);
  } finally {
    db.close();
  }
});

test("resolveMemoryConflict rolls back group, relations, and lifecycle on a forced failure", () => {
  const db = createFixture();
  try {
    const { repository, input } = createStoredInput(db);
    repository.applyCandidateAnalysis({
      analysisInputId: input.analysisInputId,
      inputHash: input.inputHash,
      candidate: validCandidate(),
    });
    const nextInput = createAlternativeInput(repository, "forced resolution redaction");
    repository.applyCandidateAnalysis({
      analysisInputId: nextInput.analysisInputId,
      inputHash: nextInput.inputHash,
      candidate: validCandidate({
        memories: [{ ...validCandidate().memories[0], body: "Use cloud deployment." }],
      }),
    });
    const group = db.prepare("SELECT id FROM memory_conflict_groups").get();
    const selected = db
      .prepare("SELECT id FROM memory_items_v2 WHERE body = 'Use the local-first deployment.'")
      .get();
    db.exec(`
      CREATE TRIGGER reject_selected_memory_resolution
      BEFORE UPDATE OF lifecycle ON memory_items_v2
      WHEN NEW.lifecycle = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'injected resolution failure');
      END;
    `);
    assert.throws(
      () =>
        repository.resolveMemoryConflict({
          conflictGroupId: group.id,
          selectedMemoryItemId: selected.id,
        }),
      /injected resolution failure/
    );
    assert.deepEqual(
      db.prepare("SELECT state, selected_member_id, resolved_at FROM memory_conflict_groups").get(),
      { state: "open", selected_member_id: null, resolved_at: null }
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_supersessions").get().count, 0);
    assert.deepEqual(db.prepare("SELECT DISTINCT lifecycle FROM memory_items_v2").all(), [
      { lifecycle: "conflict" },
    ]);
  } finally {
    db.close();
  }
});
