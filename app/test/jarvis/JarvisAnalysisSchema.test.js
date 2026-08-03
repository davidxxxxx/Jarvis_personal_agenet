const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AnalysisSchemaError,
  salvageCandidateAnalysis,
  validateCandidateAnalysis,
  ANALYSIS_TOOL,
} = require("../../src/jarvis/main/JarvisAnalysisSchema");

function candidate(overrides = {}) {
  return {
    schemaVersion: "jarvis-analysis-v3",
    sessionSummary: {
      title: "Delivery discussion",
      summary: "The team agreed on the delivery scope.",
      evidenceSegmentIds: ["seg-1"],
    },
    memories: [
      {
        kind: "decision",
        title: "Delivery date",
        body: "The delivery remains scheduled for Friday.",
        confidence: 0.9,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
    topics: [
      {
        name: "Delivery",
        summary: "Scope and timing were discussed.",
        evidenceSegmentIds: ["seg-1"],
      },
    ],
    todos: [
      {
        title: "Prepare acceptance checklist",
        ownerLabel: "SELF",
        dueText: "Friday afternoon",
        semanticConfidence: 0.95,
        evidenceSegmentIds: ["seg-2"],
      },
    ],
    suggestions: [
      {
        title: "Review risks tomorrow",
        rationale: "A follow-up may reveal missing dependencies.",
        basis: "work_context",
        learningGoalId: null,
        basedOnEvidenceSegmentIds: [],
      },
    ],
    ...overrides,
  };
}

const context = {
  allowedSegmentIds: new Set(["seg-1", "seg-2"]),
  allowedOwnerLabels: new Set(["SELF", "P1"]),
  allowedLearningGoalIds: new Set(["goal-english"]),
};

function expectIssue(payload, issueCode) {
  assert.throws(
    () => validateCandidateAnalysis(payload, context),
    (error) => {
      assert.ok(error instanceof AnalysisSchemaError);
      assert.equal(error.code, "invalid_structure");
      assert.equal(error.issueCode, issueCode);
      assert.equal(error.message, "Analysis response failed validation");
      assert.doesNotMatch(JSON.stringify(error), /seg-1|seg-other|Delivery|Friday/);
      return true;
    }
  );
}

test("accepts and copies one closed jarvis-analysis-v3 candidate", () => {
  const input = candidate();
  const result = validateCandidateAnalysis(input, context);
  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.sessionSummary, input.sessionSummary);
});

test("accepts explicit SELF commitment and assignment-acceptance todo evidence roles", () => {
  const direct = candidate({
    todos: [
      {
        ...candidate().todos[0],
        actionKind: "self_commitment",
        assignmentSegmentIds: [],
        acceptanceSegmentIds: [],
      },
    ],
  });
  assert.equal(validateCandidateAnalysis(direct, context).todos[0].actionKind, "self_commitment");

  const assigned = candidate({
    todos: [
      {
        ...candidate().todos[0],
        actionKind: "assignment_accepted",
        evidenceSegmentIds: ["seg-1", "seg-2"],
        assignmentSegmentIds: ["seg-1"],
        acceptanceSegmentIds: ["seg-2"],
      },
    ],
  });
  assert.deepEqual(validateCandidateAnalysis(assigned, context).todos[0], assigned.todos[0]);
});

test("rejects malformed assignment and acceptance evidence roles", () => {
  for (const todo of [
    {
      ...candidate().todos[0],
      actionKind: "assignment_accepted",
      assignmentSegmentIds: [],
      acceptanceSegmentIds: ["seg-2"],
    },
    {
      ...candidate().todos[0],
      actionKind: "assignment_accepted",
      assignmentSegmentIds: ["seg-1"],
      acceptanceSegmentIds: ["seg-1"],
      evidenceSegmentIds: ["seg-1", "seg-2"],
    },
    {
      ...candidate().todos[0],
      actionKind: "self_commitment",
      assignmentSegmentIds: ["seg-1"],
      acceptanceSegmentIds: [],
      evidenceSegmentIds: ["seg-1", "seg-2"],
    },
  ]) {
    expectIssue(candidate({ todos: [todo] }), "schema.todo_action_evidence");
  }
});

test("rejects non-object top levels and wrong collection types", () => {
  for (const value of [null, [], "candidate", 1]) {
    expectIssue(value, "schema.top_level_type");
  }
  for (const field of ["memories", "topics", "todos", "suggestions"]) {
    for (const value of [null, {}, "none"]) {
      expectIssue(candidate({ [field]: value }), `schema.collection_type.${field}`);
    }
  }
});

test("rejects missing and unknown fields recursively", () => {
  const missing = candidate();
  delete missing.sessionSummary;
  expectIssue(missing, "schema.missing_field");

  expectIssue(candidate({ modelId: "model-controlled" }), "schema.unknown_field");
  expectIssue(
    candidate({ sessionSummary: { ...candidate().sessionSummary, revision: 2 } }),
    "schema.unknown_field"
  );
  expectIssue(
    candidate({ todos: [{ ...candidate().todos[0], dueAt: 123 }] }),
    "schema.unknown_field"
  );
});

test("requires unique in-scope evidence for every factual output", () => {
  expectIssue(
    candidate({ sessionSummary: { ...candidate().sessionSummary, evidenceSegmentIds: [] } }),
    "schema.evidence_empty"
  );
  expectIssue(
    candidate({ memories: [{ ...candidate().memories[0], evidenceSegmentIds: [] }] }),
    "schema.evidence_empty"
  );
  expectIssue(
    candidate({ topics: [{ ...candidate().topics[0], evidenceSegmentIds: ["seg-other"] }] }),
    "schema.evidence_out_of_scope"
  );
  expectIssue(
    candidate({ todos: [{ ...candidate().todos[0], evidenceSegmentIds: ["seg-2", "seg-2"] }] }),
    "schema.evidence_duplicate"
  );
});

test("allows ungrounded suggestions but validates any supplied suggestion evidence", () => {
  assert.deepEqual(
    validateCandidateAnalysis(candidate(), context).suggestions[0],
    candidate().suggestions[0]
  );
  expectIssue(
    candidate({
      suggestions: [{ ...candidate().suggestions[0], basedOnEvidenceSegmentIds: ["seg-other"] }],
    }),
    "schema.evidence_out_of_scope"
  );
});

test("binds learning suggestions to an allowed goal and remains compatible with legacy candidates", () => {
  const learning = candidate({
    suggestions: [
      {
        ...candidate().suggestions[0],
        basis: "learning_goal",
        learningGoalId: "goal-english",
      },
    ],
  });
  assert.equal(
    validateCandidateAnalysis(learning, context).suggestions[0].learningGoalId,
    "goal-english"
  );

  expectIssue(
    candidate({
      suggestions: [
        {
          ...candidate().suggestions[0],
          basis: "learning_goal",
          learningGoalId: "goal-invented",
        },
      ],
    }),
    "schema.learning_goal_out_of_scope"
  );
  expectIssue(
    candidate({ suggestions: [{ ...candidate().suggestions[0], learningGoalId: "goal-english" }] }),
    "schema.learning_goal_unexpected"
  );

  const legacy = candidate({
    suggestions: [
      {
        title: "Legacy suggestion",
        rationale: "Readable but not newly authorized.",
        basedOnEvidenceSegmentIds: ["seg-1"],
      },
    ],
  });
  assert.deepEqual(validateCandidateAnalysis(legacy, context).suggestions[0], {
    title: "Legacy suggestion",
    rationale: "Readable but not newly authorized.",
    basis: "legacy_unverified",
    learningGoalId: null,
    basedOnEvidenceSegmentIds: ["seg-1"],
  });
});

test("salvages valid grounded output while dropping malformed optional items", () => {
  const input = candidate({
    sessionSummary: {
      ...candidate().sessionSummary,
      evidenceSegmentIds: ["seg-other", "seg-1", "seg-1"],
    },
    topics: [
      candidate().topics[0],
      { ...candidate().topics[0], name: "Invented", evidenceSegmentIds: ["seg-other"] },
    ],
    todos: [candidate().todos[0], { ...candidate().todos[0], ownerLabel: "Alice" }],
    suggestions: [
      {
        ...candidate().suggestions[0],
        basedOnEvidenceSegmentIds: ["seg-other", "seg-2"],
      },
    ],
  });

  const result = salvageCandidateAnalysis(input, context);

  assert.deepEqual(result.sessionSummary.evidenceSegmentIds, ["seg-1"]);
  assert.equal(result.topics.length, 1);
  assert.equal(result.todos.length, 1);
  assert.deepEqual(result.suggestions[0].basedOnEvidenceSegmentIds, ["seg-2"]);
});

test("salvage keeps the grounded summary when an optional collection has the wrong type", () => {
  const result = salvageCandidateAnalysis(
    candidate({
      todos: { title: "model emitted an object instead of an array" },
    }),
    context
  );

  assert.equal(result.sessionSummary.title, "Delivery discussion");
  assert.deepEqual(result.todos, []);
  assert.equal(result.memories.length, 1);
  assert.equal(result.topics.length, 1);
});

test("salvage bounds oversized optional collections before strict validation", () => {
  const result = salvageCandidateAnalysis(
    candidate({
      topics: Array.from({ length: 120 }, (_, index) => ({
        ...candidate().topics[0],
        name: `Delivery ${index}`,
      })),
    }),
    context
  );

  assert.equal(result.topics.length, 100);
  assert.equal(result.topics[99].name, "Delivery 99");
});

test("rejects invalid memory kinds confidence owner labels and due text", () => {
  expectIssue(
    candidate({ memories: [{ ...candidate().memories[0], kind: "opinion" }] }),
    "schema.memory_kind"
  );
  for (const confidence of [-0.1, 1.1, Number.NaN, "0.9"]) {
    expectIssue(
      candidate({ memories: [{ ...candidate().memories[0], confidence }] }),
      "schema.confidence"
    );
  }
  for (const semanticConfidence of [-0.1, 1.1, Number.NaN, "0.9", null]) {
    expectIssue(
      candidate({ todos: [{ ...candidate().todos[0], semanticConfidence }] }),
      "schema.confidence"
    );
  }
  expectIssue(
    candidate({ todos: [{ ...candidate().todos[0], ownerLabel: "P2" }] }),
    "schema.owner_out_of_scope"
  );
  expectIssue(
    candidate({ todos: [{ ...candidate().todos[0], ownerLabel: "person-real" }] }),
    "schema.owner_label"
  );
  expectIssue(
    candidate({ todos: [{ ...candidate().todos[0], dueText: { date: "Friday" } }] }),
    "schema.due_text"
  );
});

test("rejects untrimmed empty and overlong strings without echoing their contents", () => {
  expectIssue(
    candidate({ sessionSummary: { ...candidate().sessionSummary, title: " padded " } }),
    "schema.string"
  );
  expectIssue(candidate({ topics: [{ ...candidate().topics[0], name: "" }] }), "schema.string");
  expectIssue(
    candidate({ suggestions: [{ ...candidate().suggestions[0], rationale: "x".repeat(4_001) }] }),
    "schema.string"
  );
});

test("exports a recursively closed tool schema matching the v3 contract", () => {
  assert.equal(ANALYSIS_TOOL.type, "function");
  assert.equal(ANALYSIS_TOOL.function.name, "submit_jarvis_analysis");
  const root = ANALYSIS_TOOL.function.parameters;
  assert.equal(root.additionalProperties, false);
  assert.deepEqual(root.required, [
    "schemaVersion",
    "sessionSummary",
    "memories",
    "topics",
    "todos",
    "suggestions",
  ]);
  assert.equal(root.properties.sessionSummary.additionalProperties, false);
  for (const field of ["memories", "topics", "todos", "suggestions"]) {
    assert.equal(root.properties[field].type, "array");
    assert.equal(root.properties[field].items.additionalProperties, false);
    assert.equal(root.properties[field].maxItems, 100);
  }
  assert.equal(root.properties.memories.items.properties.evidenceSegmentIds.minItems, 1);
  assert.ok(root.properties.todos.items.required.includes("semanticConfidence"));
  assert.ok(root.properties.todos.items.required.includes("actionKind"));
  assert.ok(root.properties.todos.items.required.includes("assignmentSegmentIds"));
  assert.ok(root.properties.todos.items.required.includes("acceptanceSegmentIds"));
  assert.ok(root.properties.suggestions.items.required.includes("basis"));
  assert.ok(root.properties.suggestions.items.required.includes("learningGoalId"));
  assert.deepEqual(root.properties.suggestions.items.properties.basis.enum, [
    "work_context",
    "learning_goal",
    "explicit_agreement",
  ]);
  assert.equal(root.properties.suggestions.items.properties.basedOnEvidenceSegmentIds.minItems, 0);
});
