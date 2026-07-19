const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const MODULE_PATH = "../../src/jarvis/main/MemoryMerger";

function loadMemoryMerger() {
  return require(MODULE_PATH);
}

function candidateFixture(overrides = {}) {
  return {
    schemaVersion: "jarvis-analysis-v2",
    sessionSummary: {
      title: "Release Notes",
      summary: "API v2 is ready.",
      evidenceSegmentIds: ["seg-2", "seg-1", "seg-2"],
    },
    memories: [
      {
        kind: "event",
        title: "Launch",
        body: "API v2 shipped.",
        confidence: 0.9,
        evidenceSegmentIds: ["seg-2", "seg-1", "seg-2"],
      },
      {
        kind: "fact",
        title: "Owner",
        body: "P1 owns the API.",
        confidence: 0.8,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
    topics: [
      { name: "Launch", summary: "API v2 shipped.", evidenceSegmentIds: ["seg-2"] },
      { name: "API", summary: "API v2 is ready.", evidenceSegmentIds: ["seg-1"] },
    ],
    todos: [
      {
        title: "Publish notes",
        ownerLabel: "P1",
        dueText: "Friday",
        evidenceSegmentIds: ["seg-2", "seg-1"],
      },
    ],
    suggestions: [
      {
        title: "Review metrics",
        rationale: "Catch regressions",
        basedOnEvidenceSegmentIds: ["seg-2", "seg-2"],
      },
    ],
    ...overrides,
  };
}

function plannerCandidate(overrides = {}) {
  return candidateFixture({
    sessionSummary: {
      title: "Release Notes",
      summary: "API v2 is ready.",
      evidenceSegmentIds: ["seg-1"],
    },
    memories: [],
    topics: [],
    todos: [],
    suggestions: [],
    ...overrides,
  });
}

function planFixture(overrides = {}) {
  return {
    analysisInput: { id: "input-1", sessionId: "session-1" },
    candidate: plannerCandidate(),
    evidence: {
      segments: [
        {
          id: "seg-1",
          sessionId: "session-1",
          startedAt: 1_000,
          endedAt: 2_000,
          speakerLabel: "P1",
        },
        {
          id: "seg-2",
          sessionId: "session-1",
          startedAt: 3_000,
          endedAt: 4_000,
          speakerLabel: null,
        },
      ],
      bindings: [{ label: "P1", subjectKind: "person", subjectId: "person-1" }],
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
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertValidationIssue(mergerModule, input, issueCode) {
  assert.throws(
    () => new mergerModule.MemoryMerger().plan(input),
    (error) =>
      error instanceof mergerModule.MemoryMergerValidationError && error.issueCode === issueCode
  );
}

test("canonical-v1 normalizes text exactly and preserves punctuation", () => {
  let merger;
  assert.doesNotThrow(() => {
    merger = loadMemoryMerger();
  });

  assert.equal(merger.CANONICAL_ALGORITHM, "canonical-v1");
  assert.equal(merger.canonicalizeText("  ＡＰＩ\u2003V2！\nReady?  "), "api v2! ready?");
  assert.throws(() => merger.canonicalizeText(null), TypeError);
});

test("canonical-v1 hashes fixed JSON array tuples with SHA-256 hex", () => {
  let merger;
  assert.doesNotThrow(() => {
    merger = loadMemoryMerger();
  });
  const { canonicalTupleHash } = merger;
  const tuples = [
    ["topic", "api，v2!"],
    ["memory", "fact", "release", ["person-1", "person-2"]],
    ["todo", "ship", null],
    ["suggestion", "review", "catch regressions"],
    ["session_summary", "session-1"],
  ];

  assert.equal(
    canonicalTupleHash(tuples[0]),
    "3f8c16ddcc65a46f3d611be95e6d5a0887c9baa67f16a49423c459c9d636430a"
  );
  assert.equal(new Set(tuples.map(canonicalTupleHash)).size, tuples.length);
  assert.throws(() => canonicalTupleHash({ kind: "topic", name: "api，v2!" }), TypeError);
});

test("canonical-v1 sorts and deduplicates subject and evidence ID sets", () => {
  const merger = loadMemoryMerger();
  assert.equal(typeof merger.normalizeStringSet, "function");
  assert.deepEqual(
    merger.normalizeStringSet(["subject-2", "subject-10", "subject-2"], "subjectIds"),
    ["subject-10", "subject-2"]
  );

  const canonical = merger.canonicalizeCandidate(candidateFixture());
  assert.deepEqual(canonical.sessionSummary.evidenceSegmentIds, ["seg-1", "seg-2"]);
  assert.deepEqual(
    canonical.memories.find((memory) => memory.kind === "event").evidenceSegmentIds,
    ["seg-1", "seg-2"]
  );
  assert.deepEqual(canonical.suggestions[0].basedOnEvidenceSegmentIds, ["seg-2"]);
  assert.throws(() => merger.normalizeStringSet(["subject-1", ""], "subjectIds"), TypeError);
});

test("semantic candidate hash ignores collection order but changes with semantic inputs", () => {
  const merger = loadMemoryMerger();
  assert.equal(typeof merger.semanticCandidateHash, "function");
  const original = candidateFixture();
  const reordered = candidateFixture({
    memories: [...original.memories].reverse().map((memory) => ({
      ...memory,
      evidenceSegmentIds: [...memory.evidenceSegmentIds].reverse(),
    })),
    topics: [...original.topics].reverse(),
    sessionSummary: {
      ...original.sessionSummary,
      evidenceSegmentIds: [...original.sessionSummary.evidenceSegmentIds].reverse(),
    },
  });

  const hash = merger.semanticCandidateHash(original);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(merger.semanticCandidateHash(reordered), hash);
  assert.notEqual(
    merger.semanticCandidateHash(
      candidateFixture({
        todos: [{ ...original.todos[0], ownerLabel: "P2" }],
      })
    ),
    hash
  );
  assert.notEqual(
    merger.semanticCandidateHash({
      ...original,
      memories: [{ ...original.memories[0], body: "API v3 shipped." }, original.memories[1]],
    }),
    hash
  );
});

test("plan is pure, input-immutable, ID/clock-free, and deterministically sorted", (t) => {
  const mergerModule = loadMemoryMerger();
  assert.equal(typeof mergerModule.MemoryMerger, "function");
  const suggestions = [
    {
      title: "Zulu",
      rationale: "Second",
      basedOnEvidenceSegmentIds: [],
    },
    {
      title: "Alpha",
      rationale: "First",
      basedOnEvidenceSegmentIds: [],
    },
  ];
  const input = deepFreeze(
    planFixture({ candidate: plannerCandidate({ suggestions: [...suggestions] }) })
  );
  const reversed = deepFreeze(
    planFixture({ candidate: plannerCandidate({ suggestions: [...suggestions].reverse() }) })
  );
  const originalNow = Date.now;
  const originalRandomUUID = crypto.randomUUID;
  Date.now = () => {
    throw new Error("clock access forbidden");
  };
  crypto.randomUUID = () => {
    throw new Error("ID generation forbidden");
  };
  t.after(() => {
    Date.now = originalNow;
    crypto.randomUUID = originalRandomUUID;
  });

  const merger = new mergerModule.MemoryMerger();
  const first = merger.plan(input);
  const second = merger.plan(reversed);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.inserts.map((action) => action.title),
    ["Alpha", "Zulu"]
  );
  assert.deepEqual(Object.keys(first), [
    "inserts",
    "revisions",
    "occurrenceLinks",
    "supersessions",
    "conflicts",
    "mergeSuggestions",
    "recurrences",
    "ignoredDuplicates",
    "semanticCandidateHash",
  ]);
  assert.doesNotMatch(JSON.stringify(first), /createdAt|generatedId|timestamp/u);
});

test("exact topic reuse normalizes summary equality and plans only meaningful revisions", () => {
  const mergerModule = loadMemoryMerger();
  const merger = new mergerModule.MemoryMerger();
  const canonicalKey = mergerModule.canonicalTupleHash(["topic", "api"]);
  const existingTopic = {
    id: "topic-api",
    canonicalKey,
    name: "API",
    lifecycle: "active",
    revisions: [{ id: "topic-revision-1", revision: 1, summary: "  API\u2003V2 IS READY.  " }],
    occurrences: [
      {
        id: "topic-occurrence-1",
        revisionId: "topic-revision-1",
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  };
  const sameInput = planFixture({
    candidate: plannerCandidate({
      topics: [{ name: "ＡＰＩ", summary: "api v2 is ready.", evidenceSegmentIds: ["seg-1"] }],
    }),
    existing: { ...planFixture().existing, topics: [existingTopic] },
  });

  const same = merger.plan(sameInput);
  assert.deepEqual(
    same.inserts.filter((action) => action.entityKind === "topic"),
    []
  );
  assert.deepEqual(same.revisions, []);
  assert.deepEqual(same.occurrenceLinks, []);

  const changed = merger.plan({
    ...sameInput,
    candidate: plannerCandidate({
      topics: [{ name: "API", summary: "API v3 is ready.", evidenceSegmentIds: ["seg-1"] }],
    }),
  });
  assert.deepEqual(changed.revisions, [
    {
      entityKind: "topic",
      topicId: "topic-api",
      previousRevisionId: "topic-revision-1",
      previousRevision: 1,
      canonicalKey,
      summary: "API v3 is ready.",
      normalizedSummary: "api v3 is ready.",
      evidenceSegmentIds: ["seg-1"],
    },
  ]);
});

test("dice-bigram-v1 uses the inclusive 0.72 boundary and canonical topic pairs", () => {
  const mergerModule = loadMemoryMerger();
  assert.equal(mergerModule.TOPIC_SIMILARITY_ALGORITHM, "dice-bigram-v1");
  assert.equal(mergerModule.TOPIC_SIMILARITY_THRESHOLD, 0.72);
  assert.equal(typeof mergerModule.diceBigramSimilarity, "function");
  const belowLeft = "abcdefghijklmno";
  const belowRight = "abcdefghijkpqrs";
  const exactLeft = "abcdefghijklm";
  const exactRight = "abcdefghijwxyz";
  assert.equal(mergerModule.diceBigramSimilarity(belowLeft, belowRight), 0.714286);
  assert.equal(mergerModule.diceBigramSimilarity(exactLeft, exactRight), 0.72);

  const topic = (id, name) => ({
    id,
    canonicalKey: mergerModule.canonicalTupleHash(["topic", name]),
    name,
    lifecycle: "active",
    revisions: [{ id: `${id}-revision`, revision: 1, summary: name }],
    occurrences: [],
  });
  const merger = new mergerModule.MemoryMerger();
  const below = merger.plan(
    planFixture({
      candidate: plannerCandidate({
        topics: [{ name: belowRight, summary: "candidate", evidenceSegmentIds: ["seg-1"] }],
      }),
      existing: { ...planFixture().existing, topics: [topic("topic-below", belowLeft)] },
    })
  );
  assert.deepEqual(below.mergeSuggestions, []);

  const existingExact = topic("topic-existing", exactLeft);
  const candidateKey = mergerModule.canonicalTupleHash(["topic", exactRight]);
  const exact = merger.plan(
    planFixture({
      candidate: plannerCandidate({
        topics: [{ name: exactRight, summary: "candidate", evidenceSegmentIds: ["seg-1"] }],
      }),
      existing: { ...planFixture().existing, topics: [existingExact] },
    })
  );
  assert.equal(exact.inserts.filter((action) => action.entityKind === "topic").length, 1);
  const expectedPair = [
    { canonicalKey: existingExact.canonicalKey, topicId: existingExact.id },
    { canonicalKey: candidateKey },
  ].sort((left, right) => (left.canonicalKey < right.canonicalKey ? -1 : 1));
  assert.equal(exact.mergeSuggestions.length, 1);
  assert.deepEqual(exact.mergeSuggestions[0], {
    pairKey: mergerModule.canonicalTupleHash([
      "topic_merge_pair",
      expectedPair[0].canonicalKey,
      expectedPair[1].canonicalKey,
      "dice-bigram-v1",
    ]),
    leftTopic: expectedPair[0],
    rightTopic: expectedPair[1],
    algorithmVersion: "dice-bigram-v1",
    score: 0.72,
    state: "proposed",
  });
  assert.equal(exact.mergeSuggestions[0].score.toFixed(6), "0.720000");
});

test("existing topic merge suggestions are idempotent and terminal states are never reset", () => {
  const mergerModule = loadMemoryMerger();
  const merger = new mergerModule.MemoryMerger();
  const left = {
    id: "topic-a",
    canonicalKey: mergerModule.canonicalTupleHash(["topic", "abcdefghijklm"]),
    name: "abcdefghijklm",
    lifecycle: "active",
    revisions: [{ id: "revision-a", revision: 1, summary: "left" }],
    occurrences: [],
  };
  const right = {
    id: "topic-b",
    canonicalKey: mergerModule.canonicalTupleHash(["topic", "abcdefghijwxyz"]),
    name: "abcdefghijwxyz",
    lifecycle: "active",
    revisions: [{ id: "revision-b", revision: 1, summary: "right" }],
    occurrences: [],
  };

  const withoutExistingSuggestion = merger.plan(
    planFixture({
      candidate: plannerCandidate({
        topics: [{ name: right.name, summary: "right", evidenceSegmentIds: ["seg-1"] }],
      }),
      existing: { ...planFixture().existing, topics: [right, left] },
    })
  );
  assert.equal(withoutExistingSuggestion.mergeSuggestions.length, 1);

  for (const state of ["proposed", "accepted", "dismissed"]) {
    const result = merger.plan(
      planFixture({
        candidate: plannerCandidate({
          topics: [{ name: right.name, summary: "right", evidenceSegmentIds: ["seg-1"] }],
        }),
        existing: {
          ...planFixture().existing,
          topics: [right, left],
          topicMergeSuggestions: [
            {
              id: `merge-${state}`,
              leftTopicId: "topic-a",
              rightTopicId: "topic-b",
              algorithmVersion: "dice-bigram-v1",
              score: 0.72,
              state,
            },
          ],
        },
      })
    );
    assert.deepEqual(result.mergeSuggestions, []);
  }
});

test("candidate-internal duplicates become deterministic ignored descriptors", () => {
  const mergerModule = loadMemoryMerger();
  const memory = {
    kind: "fact",
    title: "Owner",
    body: "P1 owns the API.",
    confidence: 0.8,
    evidenceSegmentIds: ["seg-1"],
  };
  const topic = { name: "API", summary: "API v2 is ready.", evidenceSegmentIds: ["seg-1"] };
  const todo = {
    title: "Publish notes",
    ownerLabel: "P1",
    dueText: "Friday",
    evidenceSegmentIds: ["seg-1"],
  };
  const suggestion = {
    title: "Review metrics",
    rationale: "Catch regressions",
    basedOnEvidenceSegmentIds: [],
  };
  const result = new mergerModule.MemoryMerger().plan(
    planFixture({
      candidate: plannerCandidate({
        memories: [memory, { ...memory }],
        topics: [topic, { ...topic }],
        todos: [todo, { ...todo }],
        suggestions: [suggestion, { ...suggestion }],
      }),
    })
  );

  assert.deepEqual(result.inserts.map((action) => action.entityKind).sort(), [
    "memory",
    "suggestion",
    "todo",
    "topic",
  ]);
  assert.deepEqual(
    result.ignoredDuplicates.map(({ entityKind, reason, ignoredCount }) => ({
      entityKind,
      reason,
      ignoredCount,
    })),
    [
      { entityKind: "memory", reason: "candidate_internal_duplicate", ignoredCount: 1 },
      { entityKind: "suggestion", reason: "candidate_internal_duplicate", ignoredCount: 1 },
      { entityKind: "todo", reason: "candidate_internal_duplicate", ignoredCount: 1 },
      { entityKind: "topic", reason: "candidate_internal_duplicate", ignoredCount: 1 },
    ]
  );
  const memoryInsert = result.inserts.find((action) => action.entityKind === "memory");
  assert.deepEqual(memoryInsert.canonicalTuple, ["memory", "fact", "owner", ["person-1"]]);
  const todoInsert = result.inserts.find((action) => action.entityKind === "todo");
  assert.deepEqual(todoInsert.canonicalTuple, ["todo", "publish notes", "person-1"]);
});

test("memory values reuse exactly, conflict independently, and supersede only with local proof", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalTuple = ["memory", "fact", "owner", ["person-1"]];
  const canonicalSlotKey = mergerModule.canonicalTupleHash(canonicalTuple);
  const oldValueKey = mergerModule.canonicalTupleHash([
    "memory_value",
    canonicalSlotKey,
    "p1 owns api v2.",
  ]);
  const existingMemory = {
    id: "memory-old",
    kind: "fact",
    canonicalSlotKey,
    canonicalValueKey: oldValueKey,
    title: "Owner",
    body: "P1 owns API v2.",
    lifecycle: "active",
    relatedSubjects: [{ subjectKind: "person", subjectId: "person-1" }],
    occurrences: [
      {
        id: "memory-occurrence-old",
        startedAt: 5_000,
        endedAt: 6_000,
        evidenceSegmentIds: ["seg-old"],
      },
    ],
  };
  const evidence = {
    segments: [
      ...planFixture().evidence.segments,
      {
        id: "seg-old",
        sessionId: "session-1",
        startedAt: 5_000,
        endedAt: 6_000,
        speakerLabel: "P1",
      },
      {
        id: "seg-new",
        sessionId: "session-1",
        startedAt: 5_000,
        endedAt: 6_000,
        speakerLabel: "P1",
      },
    ],
    bindings: planFixture().evidence.bindings,
  };
  const existing = { ...planFixture().existing, memories: [existingMemory] };
  const memoryCandidate = (body, segmentId, confidence = 0.8) =>
    plannerCandidate({
      memories: [
        {
          kind: "fact",
          title: "Owner",
          body,
          confidence,
          evidenceSegmentIds: [segmentId],
        },
      ],
    });
  const merger = new mergerModule.MemoryMerger();

  const exact = merger.plan(
    planFixture({
      candidate: memoryCandidate("P1 OWNS\u2003API V2.", "seg-old"),
      evidence,
      existing,
    })
  );
  assert.deepEqual(
    exact.inserts.filter((action) => action.entityKind === "memory"),
    []
  );
  assert.deepEqual(exact.occurrenceLinks, []);
  assert.deepEqual(exact.conflicts, []);
  assert.deepEqual(exact.supersessions, []);

  const changed = merger.plan(
    planFixture({
      candidate: memoryCandidate("P1 owns API v3.", "seg-new", 1),
      evidence,
      existing,
    })
  );
  const nextValueKey = changed.inserts.find(
    (action) => action.entityKind === "memory"
  ).canonicalValueKey;
  assert.deepEqual(changed.supersessions, []);
  assert.deepEqual(changed.conflicts, [
    {
      canonicalSlotKey,
      existingMemoryIds: ["memory-old"],
      candidateCanonicalValueKeys: [nextValueKey],
      reason: "independent_changed_body",
    },
  ]);

  const replacement = merger.plan(
    planFixture({
      candidate: memoryCandidate("P1 owns API v3.", "seg-new"),
      evidence,
      existing,
      trustedTranscriptReplacements: [{ newSegmentId: "seg-new", replacesSegmentIds: ["seg-old"] }],
    })
  );
  assert.deepEqual(replacement.conflicts, []);
  assert.deepEqual(replacement.supersessions, [
    {
      priorMemoryId: "memory-old",
      priorOccurrenceId: "memory-occurrence-old",
      nextMemoryCanonicalValueKey: nextValueKey,
      canonicalSlotKey,
      reason: "transcript_replacement",
      newSegmentId: "seg-new",
      replacesSegmentIds: ["seg-old"],
    },
  ]);
});

test("events reuse occurrences on overlap and an inclusive 30-minute gap only", () => {
  const mergerModule = loadMemoryMerger();
  assert.equal(mergerModule.EVENT_DEDUPE_WINDOW_MS, 30 * 60 * 1_000);
  const canonicalTuple = ["memory", "event", "launch", []];
  const canonicalSlotKey = mergerModule.canonicalTupleHash(canonicalTuple);
  const canonicalValueKey = mergerModule.canonicalTupleHash([
    "memory_value",
    canonicalSlotKey,
    "api v2 launched.",
  ]);
  const oldOccurrence = {
    id: "event-occurrence-old",
    startedAt: 1_000,
    endedAt: 2_000,
    evidenceSegmentIds: ["event-old"],
  };
  const existingMemory = {
    id: "event-memory",
    kind: "event",
    canonicalSlotKey,
    canonicalValueKey,
    title: "Launch",
    body: "API v2 launched.",
    lifecycle: "active",
    relatedSubjects: [],
    occurrences: [oldOccurrence],
  };
  const segments = [
    ...planFixture().evidence.segments,
    {
      id: "event-old",
      sessionId: "session-1",
      startedAt: 1_000,
      endedAt: 2_000,
      speakerLabel: null,
    },
    {
      id: "event-overlap",
      sessionId: "session-1",
      startedAt: 1_500,
      endedAt: 2_500,
      speakerLabel: null,
    },
    {
      id: "event-gap-exact",
      sessionId: "session-1",
      startedAt: 2_000 + mergerModule.EVENT_DEDUPE_WINDOW_MS,
      endedAt: 2_100 + mergerModule.EVENT_DEDUPE_WINDOW_MS,
      speakerLabel: null,
    },
    {
      id: "event-gap-late",
      sessionId: "session-1",
      startedAt: 2_001 + mergerModule.EVENT_DEDUPE_WINDOW_MS,
      endedAt: 2_101 + mergerModule.EVENT_DEDUPE_WINDOW_MS,
      speakerLabel: null,
    },
  ];
  const eventCandidate = (segmentId) =>
    plannerCandidate({
      memories: [
        {
          kind: "event",
          title: "Launch",
          body: "API v2 launched.",
          confidence: 0.9,
          evidenceSegmentIds: [segmentId],
        },
      ],
    });
  const planFor = (segmentId) =>
    new mergerModule.MemoryMerger().plan(
      planFixture({
        candidate: eventCandidate(segmentId),
        evidence: { segments, bindings: planFixture().evidence.bindings },
        existing: { ...planFixture().existing, memories: [existingMemory] },
      })
    );

  for (const segmentId of ["event-overlap", "event-gap-exact"]) {
    const result = planFor(segmentId);
    assert.deepEqual(result.occurrenceLinks, [
      {
        entityKind: "memory_occurrence",
        memoryId: "event-memory",
        occurrenceId: "event-occurrence-old",
        mode: "link_evidence",
        evidenceSegmentIds: [segmentId],
      },
    ]);
  }

  const late = planFor("event-gap-late");
  assert.equal(late.occurrenceLinks.length, 1);
  assert.equal(late.occurrenceLinks[0].mode, "create_occurrence");
  assert.equal(late.occurrenceLinks[0].memoryId, "event-memory");
  assert.deepEqual(late.occurrenceLinks[0].evidenceSegmentIds, ["event-gap-late"]);
});

test("legacy event occurrences may have unknown bounds but are never reused for time dedupe", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalSlotKey = mergerModule.canonicalTupleHash(["memory", "event", "launch", []]);
  const canonicalValueKey = mergerModule.canonicalTupleHash([
    "memory_value",
    canonicalSlotKey,
    "api v2 launched.",
  ]);
  const existingMemory = {
    id: "event-memory",
    kind: "event",
    canonicalSlotKey,
    canonicalValueKey,
    title: "Launch",
    body: "API v2 launched.",
    lifecycle: "active",
    relatedSubjects: [],
    occurrences: [
      {
        id: "legacy-event-occurrence",
        startedAt: null,
        endedAt: null,
        evidenceSegmentIds: [],
      },
    ],
  };
  const input = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "event",
          title: "Launch",
          body: "API v2 launched.",
          confidence: 0.9,
          evidenceSegmentIds: ["seg-2"],
        },
      ],
    }),
    existing: { ...planFixture().existing, memories: [existingMemory] },
  });

  const result = new mergerModule.MemoryMerger().plan(input);
  assert.equal(result.occurrenceLinks.length, 1);
  assert.equal(result.occurrenceLinks[0].mode, "create_occurrence");
  assert.equal(result.occurrenceLinks[0].memoryId, "event-memory");

  const halfKnown = structuredClone(input);
  halfKnown.existing.memories[0].occurrences[0].startedAt = 0;
  assertValidationIssue(mergerModule, halfKnown, "malformed_existing");
});

test("todos reuse active instances and keep terminal history closed unless evidence is later", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalTuple = ["todo", "publish notes", "person-1"];
  const canonicalBaseKey = mergerModule.canonicalTupleHash(canonicalTuple);
  const revision = {
    id: "todo-revision-1",
    revision: 1,
    title: "Publish notes",
    dueText: "Friday",
  };
  const occurrence = {
    id: "todo-occurrence-old",
    revisionId: revision.id,
    startedAt: 5_000,
    endedAt: 6_000,
    evidenceSegmentIds: ["todo-old"],
  };
  const todoRow = (status, completedAt) => ({
    id: `todo-${status}`,
    canonicalBaseKey,
    title: "Publish notes",
    ownerSubjectKind: "person",
    ownerSubjectId: "person-1",
    status,
    completedAt,
    revisions: [revision],
    occurrences: [occurrence],
  });
  const segments = [
    ...planFixture().evidence.segments,
    {
      id: "todo-old",
      sessionId: "session-1",
      startedAt: 5_000,
      endedAt: 6_000,
      speakerLabel: "P1",
    },
    {
      id: "todo-before",
      sessionId: "session-1",
      startedAt: 9_000,
      endedAt: 9_100,
      speakerLabel: "P1",
    },
    {
      id: "todo-equal",
      sessionId: "session-1",
      startedAt: 10_000,
      endedAt: 10_100,
      speakerLabel: "P1",
    },
    {
      id: "todo-after",
      sessionId: "session-1",
      startedAt: 10_001,
      endedAt: 10_101,
      speakerLabel: "P1",
    },
  ];
  const todoCandidate = (segmentId) =>
    plannerCandidate({
      todos: [
        {
          title: "Publish notes",
          ownerLabel: "P1",
          dueText: "Friday",
          evidenceSegmentIds: [segmentId],
        },
      ],
    });
  const planFor = (existingTodo, segmentId) =>
    new mergerModule.MemoryMerger().plan(
      planFixture({
        candidate: todoCandidate(segmentId),
        evidence: { segments, bindings: planFixture().evidence.bindings },
        existing: { ...planFixture().existing, todos: [existingTodo] },
      })
    );

  const active = planFor(todoRow("open", null), "todo-old");
  assert.deepEqual(
    active.inserts.filter((action) => action.entityKind === "todo"),
    []
  );
  assert.deepEqual(active.occurrenceLinks, []);
  assert.deepEqual(active.recurrences, []);

  for (const segmentId of ["todo-before", "todo-equal"]) {
    const history = planFor(todoRow("completed", 10_000), segmentId);
    assert.deepEqual(
      history.inserts.filter((action) => action.entityKind === "todo"),
      []
    );
    assert.deepEqual(history.recurrences, []);
    assert.deepEqual(history.occurrenceLinks, [
      {
        entityKind: "todo",
        todoId: "todo-completed",
        revisionId: "todo-revision-1",
        mode: "attach_history",
        startedAt: segments.find((segment) => segment.id === segmentId).startedAt,
        endedAt: segments.find((segment) => segment.id === segmentId).endedAt,
        evidenceSegmentIds: [segmentId],
      },
    ]);
  }

  const later = planFor(todoRow("completed", 10_000), "todo-after");
  assert.deepEqual(
    later.inserts.filter((action) => action.entityKind === "todo"),
    []
  );
  assert.deepEqual(later.occurrenceLinks, []);
  assert.equal(later.recurrences.length, 1);
  assert.deepEqual(later.recurrences[0], {
    previousTodoId: "todo-completed",
    nextTodoInstanceKey: mergerModule.canonicalTupleHash([
      "todo_recurrence",
      "todo-completed",
      canonicalBaseKey,
      ["todo-after"],
    ]),
    canonicalBaseKey,
    title: "Publish notes",
    ownerSubjectKind: "person",
    ownerSubjectId: "person-1",
    dueText: "Friday",
    startedAt: 10_001,
    endedAt: 10_101,
    evidenceSegmentIds: ["todo-after"],
    reason: "later_evidence",
  });
});

test("legacy todo occurrences accept only a fully unknown interval", () => {
  const mergerModule = loadMemoryMerger();
  const title = "Publish notes";
  const canonicalBaseKey = mergerModule.canonicalTupleHash(["todo", "publish notes", null]);
  const existingTodo = {
    id: "legacy-todo",
    canonicalBaseKey,
    title,
    ownerSubjectKind: null,
    ownerSubjectId: null,
    status: "completed",
    completedAt: 10_000,
    revisions: [
      {
        id: "legacy-todo-revision",
        revision: 1,
        title,
        dueText: null,
      },
    ],
    occurrences: [
      {
        id: "legacy-todo-occurrence",
        revisionId: "legacy-todo-revision",
        startedAt: null,
        endedAt: null,
        evidenceSegmentIds: [],
      },
    ],
  };
  const input = planFixture({
    existing: { ...planFixture().existing, todos: [existingTodo] },
  });

  assert.doesNotThrow(() => new mergerModule.MemoryMerger().plan(input));

  const halfKnown = structuredClone(input);
  halfKnown.existing.todos[0].occurrences[0].endedAt = 10_000;
  assertValidationIssue(mergerModule, halfKnown, "malformed_existing");
});

test("suggestions stay suggestions while proposed items reuse and terminal states remain terminal", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalTuple = ["suggestion", "review metrics", "catch regressions"];
  const canonicalKey = mergerModule.canonicalTupleHash(canonicalTuple);
  const suggestionCandidate = plannerCandidate({
    suggestions: [
      {
        title: "Review metrics",
        rationale: "Catch regressions",
        basedOnEvidenceSegmentIds: ["seg-2"],
      },
    ],
  });
  const suggestionRow = (state) => ({
    id: `suggestion-${state}`,
    canonicalKey,
    title: "Review metrics",
    rationale: "Catch regressions",
    state,
    occurrences: [
      {
        id: `suggestion-occurrence-${state}`,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  });
  const merger = new mergerModule.MemoryMerger();
  const proposed = merger.plan(
    planFixture({
      candidate: suggestionCandidate,
      existing: { ...planFixture().existing, suggestions: [suggestionRow("proposed")] },
    })
  );
  assert.deepEqual(proposed.inserts, []);
  assert.deepEqual(proposed.occurrenceLinks, [
    {
      entityKind: "suggestion_occurrence",
      suggestionId: "suggestion-proposed",
      occurrenceId: "suggestion-occurrence-proposed",
      mode: "link_evidence",
      evidenceSegmentIds: ["seg-2"],
    },
  ]);

  for (const state of ["accepted", "dismissed"]) {
    const terminal = merger.plan(
      planFixture({
        candidate: suggestionCandidate,
        existing: { ...planFixture().existing, suggestions: [suggestionRow(state)] },
      })
    );
    assert.deepEqual(terminal.inserts, []);
    assert.deepEqual(terminal.occurrenceLinks, []);
  }

  const newSuggestion = merger.plan(planFixture({ candidate: suggestionCandidate }));
  assert.deepEqual(
    newSuggestion.inserts.map((action) => action.entityKind),
    ["suggestion"]
  );
  assert.equal(
    newSuggestion.inserts.some((action) => action.entityKind === "todo"),
    false
  );
});

test("planner fails closed on cross-session, missing, malformed, or unbound evidence", () => {
  const mergerModule = loadMemoryMerger();
  assert.equal(typeof mergerModule.MemoryMergerValidationError, "function");
  const crossSession = structuredClone(planFixture());
  crossSession.evidence.segments[0].sessionId = "session-other";
  assertValidationIssue(mergerModule, crossSession, "cross_session_evidence");

  const missing = structuredClone(planFixture());
  missing.candidate.sessionSummary.evidenceSegmentIds = ["seg-missing"];
  assertValidationIssue(mergerModule, missing, "missing_evidence");

  const malformed = structuredClone(planFixture());
  malformed.evidence.segments[0].endedAt = malformed.evidence.segments[0].startedAt - 1;
  assertValidationIssue(mergerModule, malformed, "invalid_interval");

  const unbound = structuredClone(planFixture());
  unbound.evidence.bindings = [];
  assertValidationIssue(mergerModule, unbound, "missing_binding");
});

test("planner rejects unknown kinds and factual zero-evidence candidates", () => {
  const mergerModule = loadMemoryMerger();
  const unknownKind = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "opinion",
          title: "Owner",
          body: "P1 owns it.",
          confidence: 0.9,
          evidenceSegmentIds: ["seg-1"],
        },
      ],
    }),
  });
  assertValidationIssue(mergerModule, unknownKind, "unknown_entity_kind");

  const zeroEvidence = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "fact",
          title: "Owner",
          body: "P1 owns it.",
          confidence: 0.9,
          evidenceSegmentIds: [],
        },
      ],
    }),
  });
  assertValidationIssue(mergerModule, zeroEvidence, "factual_zero_evidence");
});

test("planner rejects malformed private snapshots and model-shaped replacement trust", () => {
  const mergerModule = loadMemoryMerger();
  const malformedExisting = structuredClone(planFixture());
  malformedExisting.existing.topics.push({
    id: "topic-bad",
    name: "Bad",
    lifecycle: "active",
    revisions: [],
    occurrences: [],
  });
  assertValidationIssue(mergerModule, malformedExisting, "malformed_existing");

  const modelTrust = structuredClone(planFixture());
  modelTrust.trustedTranscriptReplacements.push({
    newSegmentId: "seg-1",
    replacesSegmentIds: ["seg-2"],
    trusted: true,
  });
  assertValidationIssue(mergerModule, modelTrust, "untrusted_replacement");
});

test("planner rejects replacement facts that do not completely cover an old occurrence", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalSlotKey = mergerModule.canonicalTupleHash([
    "memory",
    "fact",
    "owner",
    ["person-1"],
  ]);
  const input = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "fact",
          title: "Owner",
          body: "P1 owns API v3.",
          confidence: 0.9,
          evidenceSegmentIds: ["seg-new"],
        },
      ],
    }),
    evidence: {
      segments: [
        ...planFixture().evidence.segments,
        {
          id: "seg-old",
          sessionId: "session-1",
          startedAt: 5_000,
          endedAt: 6_000,
          speakerLabel: "P1",
        },
        {
          id: "seg-unrelated",
          sessionId: "session-1",
          startedAt: 5_000,
          endedAt: 6_000,
          speakerLabel: "P1",
        },
        {
          id: "seg-new",
          sessionId: "session-1",
          startedAt: 5_000,
          endedAt: 6_000,
          speakerLabel: "P1",
        },
      ],
      bindings: planFixture().evidence.bindings,
    },
    existing: {
      ...planFixture().existing,
      memories: [
        {
          id: "memory-old",
          kind: "fact",
          canonicalSlotKey,
          canonicalValueKey: mergerModule.canonicalTupleHash([
            "memory_value",
            canonicalSlotKey,
            "p1 owns api v2.",
          ]),
          title: "Owner",
          body: "P1 owns API v2.",
          lifecycle: "active",
          relatedSubjects: [{ subjectKind: "person", subjectId: "person-1" }],
          occurrences: [
            {
              id: "occurrence-old",
              startedAt: 5_000,
              endedAt: 6_000,
              evidenceSegmentIds: ["seg-old"],
            },
          ],
        },
      ],
    },
    trustedTranscriptReplacements: [
      { newSegmentId: "seg-new", replacesSegmentIds: ["seg-unrelated"] },
    ],
  });

  assertValidationIssue(mergerModule, input, "untrusted_replacement");
});

test("logical row, entity, revision, binding, and evidence permutations produce deep-equal plans", () => {
  const mergerModule = loadMemoryMerger();
  const topicKey = (name) =>
    mergerModule.canonicalTupleHash(["topic", mergerModule.canonicalizeText(name)]);
  const apiTopic = {
    id: "topic-api",
    canonicalKey: topicKey("API"),
    name: "API",
    lifecycle: "active",
    revisions: [
      { id: "topic-api-revision-2", revision: 2, summary: "API v2 ready." },
      { id: "topic-api-revision-1", revision: 1, summary: "API v1 ready." },
    ],
    occurrences: [
      {
        id: "topic-api-occurrence",
        revisionId: "topic-api-revision-2",
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  };
  const roadmapTopic = {
    id: "topic-roadmap",
    canonicalKey: topicKey("Roadmap"),
    name: "Roadmap",
    lifecycle: "active",
    revisions: [{ id: "topic-roadmap-revision", revision: 1, summary: "Roadmap" }],
    occurrences: [],
  };
  const candidate = plannerCandidate({
    sessionSummary: {
      title: "Release Notes",
      summary: "API v2 ready.",
      evidenceSegmentIds: ["seg-2", "seg-1"],
    },
    memories: [
      {
        kind: "event",
        title: "Launch",
        body: "API v2 launched.",
        confidence: 0.9,
        evidenceSegmentIds: ["seg-2"],
      },
      {
        kind: "fact",
        title: "Owner",
        body: "P1 owns API v2.",
        confidence: 0.8,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
    topics: [
      { name: "Docs", summary: "Docs ready.", evidenceSegmentIds: ["seg-2"] },
      { name: "API", summary: "API v2 ready.", evidenceSegmentIds: ["seg-2", "seg-1"] },
    ],
    todos: [
      {
        title: "Announce",
        ownerLabel: null,
        dueText: null,
        evidenceSegmentIds: ["seg-2"],
      },
      {
        title: "Publish notes",
        ownerLabel: "P1",
        dueText: "Friday",
        evidenceSegmentIds: ["seg-1"],
      },
    ],
    suggestions: [
      {
        title: "Share metrics",
        rationale: "Keep everyone informed",
        basedOnEvidenceSegmentIds: [],
      },
      {
        title: "Review metrics",
        rationale: "Catch regressions",
        basedOnEvidenceSegmentIds: ["seg-2"],
      },
    ],
  });
  const base = planFixture({
    candidate,
    evidence: {
      segments: planFixture().evidence.segments,
      bindings: [
        ...planFixture().evidence.bindings,
        { label: "P2", subjectKind: "speaker_cluster", subjectId: "cluster-2" },
      ],
    },
    existing: { ...planFixture().existing, topics: [roadmapTopic, apiTopic] },
  });
  const permuted = structuredClone(base);
  permuted.candidate.sessionSummary.evidenceSegmentIds.reverse();
  for (const collection of ["memories", "topics", "todos", "suggestions"]) {
    permuted.candidate[collection].reverse();
  }
  for (const item of [
    ...permuted.candidate.memories,
    ...permuted.candidate.topics,
    ...permuted.candidate.todos,
  ]) {
    item.evidenceSegmentIds.reverse();
  }
  for (const item of permuted.candidate.suggestions) {
    item.basedOnEvidenceSegmentIds.reverse();
  }
  permuted.evidence.segments.reverse();
  permuted.evidence.bindings.reverse();
  permuted.existing.topics.reverse();
  for (const topic of permuted.existing.topics) {
    topic.revisions.reverse();
    topic.occurrences.reverse();
    for (const occurrence of topic.occurrences) occurrence.evidenceSegmentIds.reverse();
  }

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(permuted);
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    actual.occurrenceLinks.filter((action) => action.entityKind === "topic_occurrence"),
    [
      {
        entityKind: "topic_occurrence",
        topicId: "topic-api",
        occurrenceId: "topic-api-occurrence",
        revisionId: "topic-api-revision-2",
        mode: "link_evidence",
        evidenceSegmentIds: ["seg-2"],
      },
    ]
  );
});

test("a topic occurrence with all logical evidence already linked is a write no-op", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalKey = mergerModule.canonicalTupleHash(["topic", "api"]);
  const result = new mergerModule.MemoryMerger().plan(
    planFixture({
      candidate: plannerCandidate({
        topics: [{ name: "API", summary: "API v2 ready.", evidenceSegmentIds: ["seg-2", "seg-1"] }],
      }),
      existing: {
        ...planFixture().existing,
        topics: [
          {
            id: "topic-api",
            canonicalKey,
            name: "API",
            lifecycle: "active",
            revisions: [{ id: "topic-api-revision", revision: 1, summary: "API v2 ready." }],
            occurrences: [
              {
                id: "topic-api-occurrence",
                revisionId: "topic-api-revision",
                evidenceSegmentIds: ["seg-2", "seg-1"],
              },
            ],
          },
        ],
      },
    })
  );

  for (const key of [
    "inserts",
    "revisions",
    "occurrenceLinks",
    "supersessions",
    "conflicts",
    "mergeSuggestions",
    "recurrences",
    "ignoredDuplicates",
  ]) {
    assert.deepEqual(result[key], []);
  }
});

test("duplicate canonical snapshot identities fail closed before row order can choose a winner", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalKey = mergerModule.canonicalTupleHash(["topic", "api"]);
  const duplicateTopic = (id) => ({
    id,
    canonicalKey,
    name: "API",
    lifecycle: "active",
    revisions: [{ id: `${id}-revision`, revision: 1, summary: "API" }],
    occurrences: [],
  });
  const input = planFixture({
    candidate: plannerCandidate({
      topics: [{ name: "API", summary: "API", evidenceSegmentIds: ["seg-1"] }],
    }),
    existing: {
      ...planFixture().existing,
      topics: [duplicateTopic("topic-a"), duplicateTopic("topic-b")],
    },
  });

  assertValidationIssue(mergerModule, input, "malformed_existing");
});

test("reusable memory occurrence tie-breaks by ID independent of snapshot order", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalSlotKey = mergerModule.canonicalTupleHash([
    "memory",
    "fact",
    "owner",
    ["person-1"],
  ]);
  const memory = {
    id: "memory-owner",
    kind: "fact",
    canonicalSlotKey,
    canonicalValueKey: mergerModule.canonicalTupleHash([
      "memory_value",
      canonicalSlotKey,
      "p1 owns api v2.",
    ]),
    title: "Owner",
    body: "P1 owns API v2.",
    lifecycle: "active",
    relatedSubjects: [{ subjectKind: "person", subjectId: "person-1" }],
    occurrences: [
      {
        id: "occurrence-b",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-1"],
      },
      {
        id: "occurrence-a",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  };
  const base = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "fact",
          title: "Owner",
          body: "P1 owns API v2.",
          confidence: 0.8,
          evidenceSegmentIds: ["seg-2", "seg-1"],
        },
      ],
    }),
    existing: { ...planFixture().existing, memories: [memory] },
  });
  const reversed = structuredClone(base);
  reversed.existing.memories[0].occurrences.reverse();

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(actual.occurrenceLinks[0].occurrenceId, "occurrence-a");
});

test("reusable todo occurrence tie-breaks by ID independent of snapshot order", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalBaseKey = mergerModule.canonicalTupleHash(["todo", "publish notes", "person-1"]);
  const todo = {
    id: "todo-publish",
    canonicalBaseKey,
    title: "Publish notes",
    ownerSubjectKind: "person",
    ownerSubjectId: "person-1",
    status: "open",
    completedAt: null,
    revisions: [
      {
        id: "todo-revision",
        revision: 1,
        title: "Publish notes",
        dueText: "Friday",
      },
    ],
    occurrences: [
      {
        id: "occurrence-b",
        revisionId: "todo-revision",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-1"],
      },
      {
        id: "occurrence-a",
        revisionId: "todo-revision",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  };
  const base = planFixture({
    candidate: plannerCandidate({
      todos: [
        {
          title: "Publish notes",
          ownerLabel: "P1",
          dueText: "Friday",
          evidenceSegmentIds: ["seg-2", "seg-1"],
        },
      ],
    }),
    existing: { ...planFixture().existing, todos: [todo] },
  });
  const reversed = structuredClone(base);
  reversed.existing.todos[0].occurrences.reverse();

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(actual.occurrenceLinks[0].occurrenceId, "occurrence-a");
});

test("memory supersession occurrence tie-breaks by ID independent of snapshot order", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalSlotKey = mergerModule.canonicalTupleHash([
    "memory",
    "fact",
    "owner",
    ["person-1"],
  ]);
  const memory = {
    id: "memory-old",
    kind: "fact",
    canonicalSlotKey,
    canonicalValueKey: mergerModule.canonicalTupleHash([
      "memory_value",
      canonicalSlotKey,
      "p1 owns api v2.",
    ]),
    title: "Owner",
    body: "P1 owns API v2.",
    lifecycle: "active",
    relatedSubjects: [{ subjectKind: "person", subjectId: "person-1" }],
    occurrences: [
      {
        id: "occurrence-b",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-old"],
      },
      {
        id: "occurrence-a",
        startedAt: 1_000,
        endedAt: 2_000,
        evidenceSegmentIds: ["seg-old"],
      },
    ],
  };
  const base = planFixture({
    candidate: plannerCandidate({
      memories: [
        {
          kind: "fact",
          title: "Owner",
          body: "P1 owns API v3.",
          confidence: 0.8,
          evidenceSegmentIds: ["seg-new"],
        },
      ],
    }),
    evidence: {
      segments: [
        ...planFixture().evidence.segments,
        {
          id: "seg-old",
          sessionId: "session-1",
          startedAt: 1_000,
          endedAt: 2_000,
          speakerLabel: "P1",
        },
        {
          id: "seg-new",
          sessionId: "session-1",
          startedAt: 1_000,
          endedAt: 2_000,
          speakerLabel: "P1",
        },
      ],
      bindings: planFixture().evidence.bindings,
    },
    existing: { ...planFixture().existing, memories: [memory] },
    trustedTranscriptReplacements: [{ newSegmentId: "seg-new", replacesSegmentIds: ["seg-old"] }],
  });
  const reversed = structuredClone(base);
  reversed.existing.memories[0].occurrences.reverse();

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(actual.supersessions[0].priorOccurrenceId, "occurrence-a");
});

test("candidate topic identity collisions converge before planning unique inserts", () => {
  const mergerModule = loadMemoryMerger();
  const topics = [
    { name: "API", summary: "Ready", evidenceSegmentIds: ["seg-1"] },
    { name: "\uFF21\uFF30\uFF29", summary: "READY", evidenceSegmentIds: ["seg-1"] },
  ];
  const base = planFixture({
    candidate: plannerCandidate({ topics }),
  });
  const reversed = planFixture({
    candidate: plannerCandidate({ topics: [...topics].reverse() }),
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(expected.inserts.filter((action) => action.entityKind === "topic").length, 1);
  assert.deepEqual(
    expected.ignoredDuplicates.map(({ entityKind, canonicalKey, reason, ignoredCount }) => ({
      entityKind,
      canonicalKey,
      reason,
      ignoredCount,
    })),
    [
      {
        entityKind: "topic",
        canonicalKey: mergerModule.canonicalTupleHash(["topic", "api"]),
        reason: "candidate_internal_duplicate",
        ignoredCount: 1,
      },
    ]
  );
});

test("candidate todo identity collisions converge before planning unique inserts", () => {
  const mergerModule = loadMemoryMerger();
  const todos = [
    {
      title: "Publish notes",
      ownerLabel: "P1",
      dueText: "Friday",
      evidenceSegmentIds: ["seg-1"],
    },
    {
      title: "PUBLISH NOTES",
      ownerLabel: "P1",
      dueText: "FRIDAY",
      evidenceSegmentIds: ["seg-1"],
    },
  ];
  const base = planFixture({
    candidate: plannerCandidate({ todos }),
  });
  const reversed = planFixture({
    candidate: plannerCandidate({ todos: [...todos].reverse() }),
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(expected.inserts.filter((action) => action.entityKind === "todo").length, 1);
  assert.deepEqual(
    expected.ignoredDuplicates.map(({ entityKind, canonicalKey, reason, ignoredCount }) => ({
      entityKind,
      canonicalKey,
      reason,
      ignoredCount,
    })),
    [
      {
        entityKind: "todo",
        canonicalKey: mergerModule.canonicalTupleHash(["todo", "publish notes", "person-1"]),
        reason: "candidate_internal_duplicate",
        ignoredCount: 1,
      },
    ]
  );
});

test("candidate topic identity convergence unions disjoint evidence and is applied-idempotent", () => {
  const mergerModule = loadMemoryMerger();
  const candidate = plannerCandidate({
    topics: [
      { name: "API", summary: "Ready", evidenceSegmentIds: ["seg-2"] },
      {
        name: "\uFF21\uFF30\uFF29",
        summary: "READY",
        evidenceSegmentIds: ["seg-1"],
      },
      { name: "api", summary: "ready", evidenceSegmentIds: ["seg-2"] },
    ],
  });
  const base = planFixture({ candidate });
  const merger = new mergerModule.MemoryMerger();

  const planned = merger.plan(base);
  const [insert] = planned.inserts.filter((action) => action.entityKind === "topic");
  assert.deepEqual(insert.evidenceSegmentIds, ["seg-1", "seg-2"]);

  const applied = merger.plan({
    ...base,
    existing: {
      ...base.existing,
      topics: [
        {
          id: "topic-api",
          canonicalKey: insert.canonicalKey,
          name: insert.name,
          lifecycle: "active",
          revisions: [
            {
              id: "topic-api-revision",
              revision: 1,
              summary: insert.summary,
            },
          ],
          occurrences: [
            {
              id: "topic-api-occurrence",
              revisionId: "topic-api-revision",
              evidenceSegmentIds: insert.evidenceSegmentIds,
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(applied.inserts, []);
  assert.deepEqual(applied.revisions, []);
  assert.deepEqual(applied.occurrenceLinks, []);
});

test("candidate todo identity convergence unions disjoint evidence and is applied-idempotent", () => {
  const mergerModule = loadMemoryMerger();
  const candidate = plannerCandidate({
    todos: [
      {
        title: "Publish notes",
        ownerLabel: "P1",
        dueText: "Friday",
        evidenceSegmentIds: ["seg-2"],
      },
      {
        title: "PUBLISH NOTES",
        ownerLabel: "P1",
        dueText: "FRIDAY",
        evidenceSegmentIds: ["seg-1"],
      },
      {
        title: "publish notes",
        ownerLabel: "P1",
        dueText: "friday",
        evidenceSegmentIds: ["seg-2"],
      },
    ],
  });
  const base = planFixture({ candidate });
  const merger = new mergerModule.MemoryMerger();

  const planned = merger.plan(base);
  const [insert] = planned.inserts.filter((action) => action.entityKind === "todo");
  assert.deepEqual(insert.evidenceSegmentIds, ["seg-1", "seg-2"]);

  const applied = merger.plan({
    ...base,
    existing: {
      ...base.existing,
      todos: [
        {
          id: "todo-publish-notes",
          canonicalBaseKey: insert.canonicalBaseKey,
          title: insert.title,
          ownerSubjectKind: insert.ownerSubjectKind,
          ownerSubjectId: insert.ownerSubjectId,
          status: "open",
          completedAt: null,
          revisions: [
            {
              id: "todo-publish-notes-revision",
              revision: 1,
              title: insert.title,
              dueText: insert.dueText,
            },
          ],
          occurrences: [
            {
              id: "todo-publish-notes-occurrence",
              revisionId: "todo-publish-notes-revision",
              startedAt: 1_000,
              endedAt: 4_000,
              evidenceSegmentIds: insert.evidenceSegmentIds,
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(applied.inserts, []);
  assert.deepEqual(applied.occurrenceLinks, []);
  assert.deepEqual(applied.recurrences, []);
});

test("candidate memory-value and suggestion identities converge deterministically", () => {
  const mergerModule = loadMemoryMerger();
  const memories = [
    {
      kind: "fact",
      title: "Owner",
      body: "P1 owns API.",
      confidence: 0.8,
      evidenceSegmentIds: ["seg-1"],
    },
    {
      kind: "fact",
      title: "OWNER",
      body: "P1 OWNS API.",
      confidence: 0.8,
      evidenceSegmentIds: ["seg-1"],
    },
    {
      kind: "fact",
      title: "Owner",
      body: "P1 owns API.",
      confidence: 0.9,
      evidenceSegmentIds: ["seg-2"],
    },
  ];
  const suggestions = [
    {
      title: "Review metrics",
      rationale: "Catch regressions",
      basedOnEvidenceSegmentIds: ["seg-1"],
    },
    {
      title: "REVIEW METRICS",
      rationale: "CATCH REGRESSIONS",
      basedOnEvidenceSegmentIds: ["seg-1"],
    },
    {
      title: "Review metrics",
      rationale: "Catch regressions",
      basedOnEvidenceSegmentIds: ["seg-2"],
    },
  ];
  const evidence = structuredClone(planFixture().evidence);
  evidence.segments.find((segment) => segment.id === "seg-2").speakerLabel = "P1";
  const base = planFixture({
    candidate: plannerCandidate({ memories, suggestions }),
    evidence,
  });
  const reversed = planFixture({
    candidate: plannerCandidate({
      memories: [...memories].reverse(),
      suggestions: [...suggestions].reverse(),
    }),
    evidence,
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  const memoryInsert = expected.inserts.filter((action) => action.entityKind === "memory");
  const suggestionInsert = expected.inserts.filter((action) => action.entityKind === "suggestion");
  assert.equal(memoryInsert.length, 1);
  assert.equal(suggestionInsert.length, 1);
  assert.deepEqual(memoryInsert[0].evidenceSegmentIds, ["seg-1", "seg-2"]);
  assert.deepEqual(suggestionInsert[0].evidenceSegmentIds, ["seg-1", "seg-2"]);
  assert.deepEqual(
    expected.ignoredDuplicates.map(({ entityKind, reason, ignoredCount }) => ({
      entityKind,
      reason,
      ignoredCount,
    })),
    [
      { entityKind: "memory", reason: "candidate_internal_duplicate", ignoredCount: 2 },
      { entityKind: "suggestion", reason: "candidate_internal_duplicate", ignoredCount: 2 },
    ]
  );
});

test("candidate memory values in one slot remain distinct and plan one conflict", () => {
  const mergerModule = loadMemoryMerger();
  const memories = [
    {
      kind: "fact",
      title: "Owner",
      body: "P1 owns API v2.",
      confidence: 0.8,
      evidenceSegmentIds: ["seg-1"],
    },
    {
      kind: "fact",
      title: "Owner",
      body: "P1 owns API v3.",
      confidence: 0.9,
      evidenceSegmentIds: ["seg-1"],
    },
  ];
  const base = planFixture({ candidate: plannerCandidate({ memories }) });
  const reversed = planFixture({
    candidate: plannerCandidate({ memories: [...memories].reverse() }),
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  const memoryInserts = expected.inserts.filter((action) => action.entityKind === "memory");
  assert.equal(memoryInserts.length, 2);
  const canonicalSlotKey = memoryInserts[0].canonicalSlotKey;
  assert.equal(memoryInserts[1].canonicalSlotKey, canonicalSlotKey);
  assert.deepEqual(expected.conflicts, [
    {
      canonicalSlotKey,
      existingMemoryIds: [],
      candidateCanonicalValueKeys: memoryInserts.map((action) => action.canonicalValueKey).sort(),
      reason: "independent_changed_body",
    },
  ]);

  const alreadyApplied = merger.plan({
    ...base,
    existing: {
      ...base.existing,
      memories: memoryInserts.map((action, index) => ({
        id: `memory-${index}`,
        kind: action.kind,
        canonicalSlotKey: action.canonicalSlotKey,
        canonicalValueKey: action.canonicalValueKey,
        title: action.title,
        body: action.body,
        lifecycle: "conflict",
        relatedSubjects: action.relatedSubjects,
        occurrences: [
          {
            id: `occurrence-${index}`,
            startedAt: 1_000,
            endedAt: 2_000,
            evidenceSegmentIds: ["seg-1"],
          },
        ],
      })),
    },
  });
  assert.deepEqual(alreadyApplied.inserts, []);
  assert.deepEqual(alreadyApplied.occurrenceLinks, []);
  assert.deepEqual(alreadyApplied.conflicts, []);
});

test("candidate events cluster by the inclusive dedupe window before value convergence", () => {
  const mergerModule = loadMemoryMerger();
  const memories = [
    {
      kind: "event",
      title: "Launch",
      body: "API v2 launched.",
      confidence: 0.9,
      evidenceSegmentIds: ["event-a"],
    },
    {
      kind: "event",
      title: "Launch",
      body: "API v2 launched.",
      confidence: 0.9,
      evidenceSegmentIds: ["event-b"],
    },
  ];
  const evidence = {
    segments: [
      ...planFixture().evidence.segments,
      {
        id: "event-a",
        sessionId: "session-1",
        startedAt: 1_000,
        endedAt: 2_000,
        speakerLabel: null,
      },
      {
        id: "event-b",
        sessionId: "session-1",
        startedAt: 2_000 + mergerModule.EVENT_DEDUPE_WINDOW_MS + 1,
        endedAt: 2_100 + mergerModule.EVENT_DEDUPE_WINDOW_MS + 1,
        speakerLabel: null,
      },
    ],
    bindings: planFixture().evidence.bindings,
  };
  const base = planFixture({
    candidate: plannerCandidate({ memories }),
    evidence,
  });
  const reversed = planFixture({
    candidate: plannerCandidate({ memories: [...memories].reverse() }),
    evidence,
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  const memoryInserts = expected.inserts.filter((action) => action.entityKind === "memory");
  assert.equal(memoryInserts.length, 1);
  const futureOccurrences = expected.occurrenceLinks.filter(
    (action) =>
      action.entityKind === "memory" &&
      action.canonicalValueKey === memoryInserts[0].canonicalValueKey &&
      action.mode === "create_occurrence"
  );
  assert.deepEqual(
    [
      memoryInserts[0].evidenceSegmentIds,
      ...futureOccurrences.map((action) => action.evidenceSegmentIds),
    ],
    [["event-a"], ["event-b"]]
  );
  assert.deepEqual(
    futureOccurrences.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
    [
      {
        startedAt: 2_000 + mergerModule.EVENT_DEDUPE_WINDOW_MS + 1,
        endedAt: 2_100 + mergerModule.EVENT_DEDUPE_WINDOW_MS + 1,
      },
    ]
  );
});

test("new candidate topics plan an inclusive-threshold merge suggestion exactly once", () => {
  const mergerModule = loadMemoryMerger();
  const topics = [
    { name: "abcdefghijklm", summary: "Left", evidenceSegmentIds: ["seg-1"] },
    { name: "abcdefghijwxyz", summary: "Right", evidenceSegmentIds: ["seg-2"] },
  ];
  assert.equal(mergerModule.diceBigramSimilarity(topics[0].name, topics[1].name), 0.72);
  const base = planFixture({ candidate: plannerCandidate({ topics }) });
  const reversed = planFixture({
    candidate: plannerCandidate({ topics: [...topics].reverse() }),
  });

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  const topicInserts = expected.inserts.filter((action) => action.entityKind === "topic");
  assert.equal(topicInserts.length, 2);
  const topicRefs = topicInserts
    .map((action) => ({ canonicalKey: action.canonicalKey }))
    .sort((left, right) => (left.canonicalKey < right.canonicalKey ? -1 : 1));
  assert.deepEqual(expected.mergeSuggestions, [
    {
      pairKey: mergerModule.canonicalTupleHash([
        "topic_merge_pair",
        topicRefs[0].canonicalKey,
        topicRefs[1].canonicalKey,
        mergerModule.TOPIC_SIMILARITY_ALGORITHM,
      ]),
      leftTopic: topicRefs[0],
      rightTopic: topicRefs[1],
      algorithmVersion: mergerModule.TOPIC_SIMILARITY_ALGORITHM,
      score: 0.72,
      state: "proposed",
    },
  ]);

  const existingTopics = [...topicInserts]
    .sort((left, right) => (left.canonicalKey < right.canonicalKey ? -1 : 1))
    .map((action, index) => ({
      id: `topic-${index === 0 ? "a" : "b"}`,
      canonicalKey: action.canonicalKey,
      name: action.name,
      lifecycle: "active",
      revisions: [
        {
          id: `topic-revision-${index}`,
          revision: 1,
          summary: action.summary,
        },
      ],
      occurrences: [],
    }));
  const applied = merger.plan({
    ...base,
    existing: {
      ...base.existing,
      topics: existingTopics,
      topicMergeSuggestions: [
        {
          id: "merge-existing",
          leftTopicId: "topic-a",
          rightTopicId: "topic-b",
          algorithmVersion: mergerModule.TOPIC_SIMILARITY_ALGORITHM,
          score: 0.72,
          state: "proposed",
        },
      ],
    },
  });
  assert.deepEqual(applied.mergeSuggestions, []);
});

test("todo recurrence planning advances from the unique terminal leaf", () => {
  const mergerModule = loadMemoryMerger();
  const canonicalBaseKey = mergerModule.canonicalTupleHash(["todo", "publish notes", "person-1"]);
  const terminalTodo = (id, completedAt) => ({
    id,
    canonicalBaseKey,
    title: "Publish notes",
    ownerSubjectKind: "person",
    ownerSubjectId: "person-1",
    status: "completed",
    completedAt,
    revisions: [
      {
        id: `${id}-revision`,
        revision: 1,
        title: "Publish notes",
        dueText: "Friday",
      },
    ],
    occurrences: [],
  });
  const todoA = terminalTodo("todo-a", 10_000);
  const todoB = terminalTodo("todo-b", 20_000);
  const recurrence = {
    id: "recurrence-a-b",
    previousTodoId: "todo-a",
    nextTodoId: "todo-b",
    sourceOccurrenceId: null,
  };
  const evidence = {
    segments: [
      ...planFixture().evidence.segments,
      {
        id: "todo-after-b",
        sessionId: "session-1",
        startedAt: 20_001,
        endedAt: 20_100,
        speakerLabel: "P1",
      },
    ],
    bindings: planFixture().evidence.bindings,
  };
  const base = planFixture({
    candidate: plannerCandidate({
      todos: [
        {
          title: "Publish notes",
          ownerLabel: "P1",
          dueText: "Friday",
          evidenceSegmentIds: ["todo-after-b"],
        },
      ],
    }),
    evidence,
    existing: {
      ...planFixture().existing,
      todos: [todoA, todoB],
      todoRecurrences: [recurrence],
    },
  });
  const reversed = structuredClone(base);
  reversed.existing.todos.reverse();
  reversed.existing.todoRecurrences.reverse();

  const merger = new mergerModule.MemoryMerger();
  const expected = merger.plan(base);
  const actual = merger.plan(reversed);
  assert.deepEqual(actual, expected);
  assert.equal(expected.recurrences.length, 1);
  assert.equal(expected.recurrences[0].previousTodoId, "todo-b");
  assert.equal(expected.recurrences[0].reason, "later_evidence");
  assert.deepEqual(expected.recurrences[0].evidenceSegmentIds, ["todo-after-b"]);
});

test("todo recurrence graphs fail closed unless each base has one valid leaf", async (t) => {
  const mergerModule = loadMemoryMerger();
  const todoRow = (id, title = "Graph todo", status = "completed") => ({
    id,
    canonicalBaseKey: mergerModule.canonicalTupleHash([
      "todo",
      mergerModule.canonicalizeText(title),
      null,
    ]),
    title,
    ownerSubjectKind: null,
    ownerSubjectId: null,
    status,
    completedAt: status === "completed" ? 1_000 : null,
    revisions: [
      {
        id: `${id}-revision`,
        revision: 1,
        title,
        dueText: null,
      },
    ],
    occurrences: [],
  });
  const edge = (id, previousTodoId, nextTodoId) => ({
    id,
    previousTodoId,
    nextTodoId,
    sourceOccurrenceId: null,
  });
  const assertGraphInvalid = (todos, todoRecurrences) => {
    const input = planFixture({
      existing: {
        ...planFixture().existing,
        todos,
        todoRecurrences,
      },
    });
    assertValidationIssue(mergerModule, input, "malformed_existing");
  };

  await t.test("rejects dangling edges", () => {
    assertGraphInvalid([todoRow("todo-a")], [edge("edge-a-missing", "todo-a", "todo-missing")]);
  });
  await t.test("rejects cross-base edges", () => {
    assertGraphInvalid(
      [todoRow("todo-a", "Alpha"), todoRow("todo-b", "Beta")],
      [edge("edge-a-b", "todo-a", "todo-b")]
    );
  });
  await t.test("rejects cycles", () => {
    assertGraphInvalid(
      [todoRow("todo-a"), todoRow("todo-b")],
      [edge("edge-a-b", "todo-a", "todo-b"), edge("edge-b-a", "todo-b", "todo-a")]
    );
  });
  await t.test("rejects multiple outgoing edges", () => {
    assertGraphInvalid(
      [todoRow("todo-a"), todoRow("todo-b"), todoRow("todo-c")],
      [edge("edge-a-b", "todo-a", "todo-b"), edge("edge-a-c", "todo-a", "todo-c")]
    );
  });
  await t.test("rejects multiple incoming edges", () => {
    assertGraphInvalid(
      [todoRow("todo-a"), todoRow("todo-b"), todoRow("todo-c")],
      [edge("edge-a-c", "todo-a", "todo-c"), edge("edge-b-c", "todo-b", "todo-c")]
    );
  });
  await t.test("rejects ambiguous terminal leaves", () => {
    assertGraphInvalid([todoRow("todo-a"), todoRow("todo-b")], []);
  });
  await t.test("rejects multiple active instances", () => {
    assertGraphInvalid(
      [todoRow("todo-a", "Graph todo", "open"), todoRow("todo-b", "Graph todo", "open")],
      [edge("edge-a-b", "todo-a", "todo-b")]
    );
  });
});

test("todo recurrence source lineage validates completed transitions", async (t) => {
  const mergerModule = loadMemoryMerger();
  const canonicalBaseKey = mergerModule.canonicalTupleHash(["todo", "lineage todo", null]);
  const todoRow = ({ id, status, completedAt, occurrences = [] }) => ({
    id,
    canonicalBaseKey,
    title: "Lineage todo",
    ownerSubjectKind: null,
    ownerSubjectId: null,
    status,
    completedAt,
    revisions: [
      {
        id: `${id}-revision`,
        revision: 1,
        title: "Lineage todo",
        dueText: null,
      },
    ],
    occurrences: occurrences.map((occurrence) => ({
      ...occurrence,
      revisionId: `${id}-revision`,
    })),
  });
  const lineageInput = ({
    previousStatus = "completed",
    previousCompletedAt = 1_000,
    sourceOccurrenceId = "source-occurrence",
    sourceOwner = "next",
    sourceStartedAt = 1_001,
  } = {}) => {
    const sourceOccurrence = {
      id: "source-occurrence",
      startedAt: sourceStartedAt,
      endedAt: 2_000,
      evidenceSegmentIds: [],
    };
    const previousOccurrences = sourceOwner === "previous" ? [sourceOccurrence] : [];
    const nextOccurrences = sourceOwner === "next" ? [sourceOccurrence] : [];
    return planFixture({
      existing: {
        ...planFixture().existing,
        todos: [
          todoRow({
            id: "todo-previous",
            status: previousStatus,
            completedAt: previousCompletedAt,
            occurrences: previousOccurrences,
          }),
          todoRow({
            id: "todo-next",
            status: "completed",
            completedAt: 5_000,
            occurrences: nextOccurrences,
          }),
        ],
        todoRecurrences: [
          {
            id: "recurrence-previous-next",
            previousTodoId: "todo-previous",
            nextTodoId: "todo-next",
            sourceOccurrenceId,
          },
        ],
      },
    });
  };
  const assertLineageInvalid = (overrides) =>
    assertValidationIssue(mergerModule, lineageInput(overrides), "malformed_existing");

  await t.test(
    "accepts a source occurrence owned by next and strictly later than completion",
    () => {
      assert.doesNotThrow(() => new mergerModule.MemoryMerger().plan(lineageInput()));
    }
  );
  await t.test("accepts a null source retained after previous completion", () => {
    assert.doesNotThrow(() =>
      new mergerModule.MemoryMerger().plan(
        lineageInput({ sourceOccurrenceId: null, sourceOwner: "missing" })
      )
    );
  });
  await t.test("rejects a dangling source occurrence", () => {
    assertLineageInvalid({ sourceOwner: "missing" });
  });
  await t.test("rejects a source occurrence owned by the previous todo", () => {
    assertLineageInvalid({ sourceOwner: "previous" });
  });
  await t.test("rejects a source occurrence equal to previous completion", () => {
    assertLineageInvalid({ sourceStartedAt: 1_000 });
  });
  await t.test("rejects a source occurrence earlier than previous completion", () => {
    assertLineageInvalid({ sourceStartedAt: 999 });
  });
  await t.test("rejects a malformed source occurrence start time", () => {
    assertLineageInvalid({ sourceStartedAt: "1001" });
  });
  await t.test("rejects a dismissed previous todo even when source is null", () => {
    assertLineageInvalid({
      previousStatus: "dismissed",
      previousCompletedAt: null,
      sourceOccurrenceId: null,
      sourceOwner: "missing",
    });
  });
  await t.test("rejects an open previous todo even when source is null", () => {
    assertLineageInvalid({
      previousStatus: "open",
      previousCompletedAt: null,
      sourceOccurrenceId: null,
      sourceOwner: "missing",
    });
  });
  await t.test("rejects malformed previous completion time", () => {
    assertLineageInvalid({
      previousCompletedAt: "1000",
      sourceOccurrenceId: null,
      sourceOwner: "missing",
    });
  });
});
