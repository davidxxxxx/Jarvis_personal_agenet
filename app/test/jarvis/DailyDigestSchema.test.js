const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAILY_DIGEST_TOOL,
  DailyDigestSchemaError,
  DAILY_DIGEST_SCHEMA_VERSION,
  validateCandidateDailyDigest,
} = require("../../src/jarvis/main/DailyDigestSchema");

const context = {
  allowedSegmentIds: new Set(["segment-1", "segment-2"]),
  allowedSubjectRefs: new Set(["SELF", "subject-0123456789abcdef"]),
  completeness: "final",
  transcriptCoverage: {
    selectedSegmentCount: 2,
    incompleteSegmentCount: 0,
    sessionCount: 1,
    startsAt: 1_000,
    endsAt: 2_000,
  },
};

function candidate() {
  return {
    schemaVersion: "jarvis-daily-digest-v1",
    sections: {
      today: [{ text: "Reviewed the launch plan.", evidenceSegmentIds: ["segment-1"] }],
      interactions: [
        {
          subjectRef: "subject-0123456789abcdef",
          text: "Aligned on the launch plan.",
          evidenceSegmentIds: ["segment-1", "segment-2"],
        },
      ],
      topicsAndDecisions: [],
      commitmentsAndTodos: [],
      worthRemembering: [],
      tomorrowSuggestions: [
        {
          text: "Review the launch checklist.",
          rationale: "The launch plan was discussed today.",
          evidenceSegmentIds: ["segment-2"],
          allowedActions: ["accept", "dismiss", "convert_to_todo"],
        },
      ],
    },
    processing: {
      completeness: "final",
      missingStages: [],
      transcriptCoverage: { ...context.transcriptCoverage },
    },
  };
}

test("accepts the exact evidence-backed daily digest contract", () => {
  assert.deepEqual(validateCandidateDailyDigest(candidate(), context), candidate());
  assert.equal(DAILY_DIGEST_SCHEMA_VERSION, "jarvis-daily-digest-v1");
  assert.equal(DAILY_DIGEST_TOOL.function.name, "submit_jarvis_daily_digest");
});

function expectIssue(mutator, issueCode, overrideContext = context) {
  const payload = candidate();
  mutator(payload);
  assert.throws(
    () => validateCandidateDailyDigest(payload, overrideContext),
    (error) =>
      error instanceof DailyDigestSchemaError &&
      error.code === "invalid_structure" &&
      error.issueCode === issueCode
  );
}

test("rejects unknown or missing fields at every contract level", () => {
  for (const mutate of [
    (value) => { value.entityId = "model-id"; },
    (value) => { value.sections.createdAt = 123; },
    (value) => { value.sections.today[0].timestamp = 123; },
    (value) => { value.sections.interactions[0].personId = "person-private"; },
    (value) => { value.sections.tomorrowSuggestions[0].automaticActions = ["create_todo"]; },
    (value) => { value.processing.finishedAt = 123; },
  ]) {
    expectIssue(mutate, "schema.unknown_field");
  }
  expectIssue((value) => { delete value.sections.worthRemembering; }, "schema.missing_field");
});

test("rejects duplicate, empty factual, and out-of-input evidence IDs", () => {
  expectIssue(
    (value) => { value.sections.today[0].evidenceSegmentIds = ["segment-1", "segment-1"]; },
    "schema.evidence_duplicate"
  );
  expectIssue(
    (value) => { value.sections.today[0].evidenceSegmentIds = []; },
    "schema.evidence_empty"
  );
  expectIssue(
    (value) => { value.sections.today[0].evidenceSegmentIds = ["segment-private"]; },
    "schema.evidence_out_of_scope"
  );
});

test("requires interaction subjects to come from the immutable input", () => {
  expectIssue(
    (value) => { value.sections.interactions[0].subjectRef = "subject-ffffffffffffffff"; },
    "schema.subject_out_of_scope"
  );
});

test("rejects oversized strings, arrays, evidence lists, and response payloads", () => {
  expectIssue(
    (value) => { value.sections.today[0].text = "x".repeat(4_001); },
    "schema.string"
  );
  expectIssue(
    (value) => { value.sections.today = Array.from({ length: 101 }, () => ({
      text: "item",
      evidenceSegmentIds: ["segment-1"],
    })); },
    "schema.collection_count"
  );
  const manyAllowed = new Set(Array.from({ length: 101 }, (_, index) => `segment-${index}`));
  expectIssue(
    (value) => { value.sections.today[0].evidenceSegmentIds = [...manyAllowed]; },
    "schema.evidence_count",
    {
      ...context,
      allowedSegmentIds: manyAllowed,
      transcriptCoverage: { ...context.transcriptCoverage, selectedSegmentCount: 101 },
    }
  );
  expectIssue(
    (value) => {
      value.sections.today = Array.from({ length: 100 }, (_, index) => ({
        text: `${index}-${"x".repeat(3_999)}`,
        evidenceSegmentIds: ["segment-1"],
      }));
      value.sections.topicsAndDecisions = structuredClone(value.sections.today);
    },
    "schema.response_too_large"
  );
});

test("allows only explicit user-controlled suggestion actions", () => {
  for (const actions of [
    [],
    ["accept", "accept"],
    ["create_todo"],
    ["accept", "schedule_calendar_event"],
  ]) {
    expectIssue(
      (value) => { value.sections.tomorrowSuggestions[0].allowedActions = actions; },
      actions.length === 0 ? "schema.actions_empty" :
        new Set(actions).size !== actions.length ? "schema.actions_duplicate" :
          "schema.action_unsupported"
    );
  }
});

test("rejects automatic todo, calendar, and message directives in model text", () => {
  for (const directive of [
    "Automatically create a todo for tomorrow.",
    "Auto-schedule this on the calendar.",
    "Automatically send a message to the team.",
    "自动创建一个待办并写入日历。",
  ]) {
    expectIssue(
      (value) => { value.sections.tomorrowSuggestions[0].text = directive; },
      "schema.automatic_action"
    );
  }
});

test("requires processing completeness to match the persisted input", () => {
  expectIssue(
    (value) => { value.processing.completeness = "partial"; },
    "schema.completeness_mismatch"
  );
});

test("requires transcript coverage to match the persisted input", () => {
  expectIssue(
    (value) => { value.processing.transcriptCoverage.selectedSegmentCount = 1; },
    "schema.coverage_mismatch"
  );
});

test("requires missing stages to agree with partial or final completeness", () => {
  expectIssue(
    (value) => { value.processing.missingStages = ["transcription"]; },
    "schema.missing_stages_mismatch"
  );

  const partialContext = { ...context, completeness: "partial" };
  expectIssue(
    (value) => { value.processing.completeness = "partial"; },
    "schema.missing_stages_mismatch",
    partialContext
  );
  const partial = candidate();
  partial.processing.completeness = "partial";
  partial.processing.missingStages = ["upstream_processing"];
  assert.deepEqual(validateCandidateDailyDigest(partial, partialContext), partial);
});

test("rejects invalid validation context before trusting model output", () => {
  for (const invalid of [
    null,
    { ...context, allowedSegmentIds: ["segment-1"] },
    { ...context, allowedSubjectRefs: ["SELF"] },
    { ...context, completeness: "complete" },
    { ...context, transcriptCoverage: { ...context.transcriptCoverage, extra: true } },
  ]) {
    assert.throws(
      () => validateCandidateDailyDigest(candidate(), invalid),
      (error) =>
        error instanceof DailyDigestSchemaError &&
        error.issueCode === "schema.validation_context"
    );
  }
});
