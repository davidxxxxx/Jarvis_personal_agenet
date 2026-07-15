const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const test = require("node:test");

const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");

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

function createFixture() {
  const db = new Database(":memory:");
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

function createStoredInput(db, counters = { ids: 0, clocks: 0 }) {
  const repository = createRepository(db, counters);
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

test("createAnalysisInput persists exact redacted payload and canonical v2 input identity", () => {
  const db = createFixture();
  try {
    const repository = createRepository(db);
    const createInput = validCreateInput();
    const identity = expectedInputIdentity(createInput.cloudPayloadJson);
    const result = repository.createAnalysisInput(createInput);

    assert.deepEqual(result, {
      status: "created",
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
      analysisInputId: "analysis_input-1",
      inputHash: expectedInputIdentity().inputHash,
    });
    assert.deepEqual(counters, { ids: 1, clocks: 1 });
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
      { status: "already_applied", analysisInputId: input.analysisInputId, candidateHash }
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

test("applyCandidateAnalysis appends topic, todo, and session-summary revisions without overwriting history", () => {
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
    assert.equal(todoRevisions.length, 2);
    assert.equal(todoRevisions[1].previous_revision_id, todoRevisions[0].id);
    assert.equal(todoRevisions[1].due_text, "tomorrow");

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
    assert.equal(db.prepare("SELECT count(*) AS count FROM todo_occurrences").get().count, 2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM todo_revisions").get().count, 2);
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
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_occurrences").get().count, 2);
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
