const test = require("node:test");
const assert = require("node:assert/strict");

const { applyDailyDigestOutputPolicy } = require("../../src/jarvis/main/DailyDigestOutputPolicy");

function policyContext(overrides = {}) {
  return {
    category: "work_meeting",
    confidence: 0.92,
    decision: "adopted",
    sourceAttribution: "application_and_microphone",
    selfParticipated: true,
    allowSuggestions: true,
    applicationKey: "teams",
    ...overrides,
  };
}

function candidate(
  suggestions = [
    {
      text: "Review the launch checklist.",
      rationale: "The launch plan was discussed today.",
      evidenceSegmentIds: ["segment-1"],
      allowedActions: ["accept", "dismiss", "convert_to_todo"],
    },
  ]
) {
  return {
    schemaVersion: "jarvis-daily-digest-v1",
    sections: {
      today: [{ text: "Reviewed the launch plan.", evidenceSegmentIds: ["segment-1"] }],
      interactions: [],
      topicsAndDecisions: [],
      commitmentsAndTodos: [],
      worthRemembering: [],
      tomorrowSuggestions: suggestions,
    },
    processing: {
      completeness: "final",
      missingStages: [],
      transcriptCoverage: {
        selectedSegmentCount: 1,
        incompleteSegmentCount: 0,
        sessionCount: 1,
        startsAt: 1_000,
        endsAt: 2_000,
      },
    },
  };
}

function applyWith(context, value = candidate()) {
  return applyDailyDigestOutputPolicy(value, new Map([["segment-1", context]]));
}

test("keeps an evidence-backed suggestion from an allowed SELF-participating activity", () => {
  const value = candidate([
    {
      text: "Review the launch checklist.",
      rationale: "The launch plan was discussed today.",
      evidenceSegmentIds: ["segment-1", "segment-2"],
      allowedActions: ["accept", "dismiss"],
    },
  ]);
  const result = applyDailyDigestOutputPolicy(
    value,
    new Map([
      ["segment-1", policyContext({ selfParticipated: false })],
      ["segment-2", policyContext({ category: "learning", applicationKey: "chrome" })],
    ])
  );

  assert.deepEqual(result, value);
});

test("removes suggestions based on entertainment or gaming evidence", () => {
  for (const category of ["entertainment", "gaming"]) {
    const result = applyWith(
      policyContext({ category, selfParticipated: true, allowSuggestions: true })
    );
    assert.deepEqual(result.sections.tomorrowSuggestions, []);
  }
});

test("removes suggestions based on tentative or unknown activities", () => {
  for (const context of [
    policyContext({ decision: "tentative", confidence: 0.79 }),
    policyContext({ category: "unknown", decision: "unknown", confidence: 0.4 }),
  ]) {
    assert.deepEqual(applyWith(context).sections.tomorrowSuggestions, []);
  }
});

test("removes suggestions when any evidence has mixed-unknown attribution", () => {
  const result = applyWith(
    policyContext({ sourceAttribution: "mixed_unknown", applicationKey: null })
  );
  assert.deepEqual(result.sections.tomorrowSuggestions, []);
});

test("removes suggestions without SELF participation across their evidence", () => {
  const result = applyWith(policyContext({ selfParticipated: false }));
  assert.deepEqual(result.sections.tomorrowSuggestions, []);
});

test("removes suggestions when any evidence explicitly denies suggestion output", () => {
  const value = candidate([
    {
      text: "Review the launch checklist.",
      rationale: "The launch plan was discussed today.",
      evidenceSegmentIds: ["segment-1", "segment-2"],
      allowedActions: ["dismiss"],
    },
  ]);
  const result = applyDailyDigestOutputPolicy(
    value,
    new Map([
      ["segment-1", policyContext()],
      ["segment-2", policyContext({ allowSuggestions: false })],
    ])
  );
  assert.deepEqual(result.sections.tomorrowSuggestions, []);
});

test("removes suggestions with empty or missing evidence context", () => {
  const value = candidate([
    {
      text: "Suggestion without evidence.",
      rationale: "There is no attributable basis.",
      evidenceSegmentIds: [],
      allowedActions: ["dismiss"],
    },
    {
      text: "Suggestion with unknown evidence.",
      rationale: "The referenced segment is absent.",
      evidenceSegmentIds: ["segment-missing"],
      allowedActions: ["dismiss"],
    },
  ]);
  const result = applyDailyDigestOutputPolicy(value, new Map([["segment-1", policyContext()]]));
  assert.deepEqual(result.sections.tomorrowSuggestions, []);
});

test("deep-clones every section and does not mutate the candidate or policy context", () => {
  const value = candidate();
  const context = policyContext();
  const beforeCandidate = structuredClone(value);
  const beforeContext = structuredClone(context);
  const result = applyWith(context, value);

  assert.deepEqual(value, beforeCandidate);
  assert.deepEqual(context, beforeContext);
  assert.notStrictEqual(result, value);
  assert.notStrictEqual(result.sections, value.sections);
  assert.notStrictEqual(result.sections.today, value.sections.today);
  assert.notStrictEqual(result.sections.today[0], value.sections.today[0]);
  assert.notStrictEqual(
    result.sections.tomorrowSuggestions[0],
    value.sections.tomorrowSuggestions[0]
  );
});

test("strictly rejects malformed policy context instead of authorizing output", () => {
  const invalidContexts = [
    { ...policyContext(), confidence: Number.NaN },
    { ...policyContext(), category: "meeting" },
    { ...policyContext(), unexpected: true },
    { ...policyContext(), allowSuggestions: "yes" },
  ];
  delete invalidContexts[0].decision;

  for (const context of invalidContexts) {
    assert.throws(
      () => applyWith(context),
      /daily digest policy (?:context|category|confidence|suggestion)/i
    );
  }
  assert.throws(
    () => applyDailyDigestOutputPolicy(candidate(), { "segment-1": policyContext() }),
    /must be a Map/i
  );
});
