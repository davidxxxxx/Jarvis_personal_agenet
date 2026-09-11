const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActivityOutputPolicy,
  OUTPUT_POLICY_REASONS,
} = require("../../src/jarvis/main/ActivityOutputPolicy");

function adopted(category, overrides = {}) {
  return {
    category,
    decision: "adopted",
    confidence: 0.92,
    sourceAttribution: "application_and_microphone",
    selfParticipated: true,
    ...overrides,
  };
}

test("work meetings permit evidence-bound actions only when SELF participates", () => {
  const policy = new ActivityOutputPolicy();
  assert.deepEqual(policy.evaluate(adopted("work_meeting")), {
    allowSummary: true,
    allowSuggestions: true,
    allowTodos: true,
    interestOnly: false,
    reason: OUTPUT_POLICY_REASONS.WORK_CONTEXT,
  });
  assert.equal(
    policy.evaluate(adopted("work_meeting", { selfParticipated: false })).allowSuggestions,
    false
  );
});

test("learning suggestions require a currently confirmed learning goal", () => {
  const policy = new ActivityOutputPolicy();
  const withoutGoal = policy.evaluate(adopted("learning"));
  assert.equal(withoutGoal.allowSummary, true);
  assert.equal(withoutGoal.allowTodos, true);
  assert.equal(withoutGoal.allowSuggestions, false);
  assert.equal(withoutGoal.reason, OUTPUT_POLICY_REASONS.LEARNING_GOAL_REQUIRED);

  assert.equal(
    policy.evaluate(
      adopted("learning", {
        learningGoalId: "learning_goal_english",
        confirmedLearningGoalIds: ["learning_goal_english"],
      })
    ).allowSuggestions,
    true
  );
  assert.equal(
    policy.evaluate(
      adopted("learning", {
        learningGoalId: "learning_goal_english",
        confirmedLearningGoalIds: ["learning_goal_programming"],
      })
    ).allowSuggestions,
    false
  );
});

test("social outputs require explicit agreement and never infer hidden actions", () => {
  const policy = new ActivityOutputPolicy();
  for (const category of ["social_call", "in_person_conversation"]) {
    const passive = policy.evaluate(adopted(category));
    assert.equal(passive.allowSuggestions, false);
    assert.equal(passive.allowTodos, false);
    assert.equal(passive.reason, OUTPUT_POLICY_REASONS.EXPLICIT_AGREEMENT_REQUIRED);

    const agreed = policy.evaluate(adopted(category, { explicitAgreement: true }));
    assert.equal(agreed.allowSuggestions, true);
    assert.equal(agreed.allowTodos, true);
  }
});

test("entertainment, games and unknown activity never authorize actions", () => {
  const policy = new ActivityOutputPolicy();
  for (const category of ["entertainment", "gaming"]) {
    assert.deepEqual(policy.evaluate(adopted(category)), {
      allowSummary: true,
      allowSuggestions: false,
      allowTodos: false,
      interestOnly: true,
      reason: OUTPUT_POLICY_REASONS.INTEREST_ONLY,
    });
  }
  assert.deepEqual(
    policy.evaluate({
      category: "unknown",
      decision: "unknown",
      confidence: 0.4,
      sourceAttribution: "mixed_unknown",
      selfParticipated: false,
    }),
    {
      allowSummary: false,
      allowSuggestions: false,
      allowTodos: false,
      interestOnly: false,
      reason: OUTPUT_POLICY_REASONS.UNDETERMINED,
    }
  );
});

test("tentative or mixed-unknown classifications fail closed for actions", () => {
  const policy = new ActivityOutputPolicy();
  assert.equal(
    policy.evaluate(
      adopted("work_meeting", {
        decision: "tentative",
        confidence: 0.7,
      })
    ).allowSuggestions,
    false
  );
  assert.equal(
    policy.evaluate(
      adopted("work_meeting", {
        sourceAttribution: "mixed_unknown",
      })
    ).allowTodos,
    false
  );
});

test("mixed-unknown output follows the live application fallback policy", () => {
  const previous = process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY;
  const policy = new ActivityOutputPolicy();
  const mixedUnknown = adopted("work_meeting", {
    decision: "tentative",
    confidence: 0.79,
    sourceAttribution: "mixed_unknown",
  });
  try {
    process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY = "conservative";
    assert.deepEqual(policy.evaluate(mixedUnknown), {
      allowSummary: true,
      allowSuggestions: false,
      allowTodos: false,
      interestOnly: false,
      reason: OUTPUT_POLICY_REASONS.SOURCE_UNCERTAIN,
    });

    process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY = "transcript_only";
    assert.deepEqual(policy.evaluate(mixedUnknown), {
      allowSummary: false,
      allowSuggestions: false,
      allowTodos: false,
      interestOnly: false,
      reason: OUTPUT_POLICY_REASONS.SOURCE_UNCERTAIN,
    });
    assert.equal(
      policy.evaluate(adopted("entertainment", { sourceAttribution: "mixed_unknown" }))
        .allowSummary,
      false
    );
  } finally {
    if (previous === undefined) delete process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY;
    else process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY = previous;
  }
});

test("an explicit mixed-unknown fallback policy is strict and overrides the environment", () => {
  const policy = new ActivityOutputPolicy();
  assert.equal(
    policy.evaluate(
      adopted("work_meeting", {
        sourceAttribution: "mixed_unknown",
        fallbackPolicy: "transcript_only",
      })
    ).allowSummary,
    false
  );
  assert.throws(
    () =>
      policy.evaluate(
        adopted("work_meeting", {
          sourceAttribution: "mixed_unknown",
          fallbackPolicy: "unsafe",
        })
      ),
    /fallback policy is invalid/
  );
});

test("candidate suggestions are authorized from their own basis instead of the coarse activity flag", () => {
  const policy = new ActivityOutputPolicy();
  const evidence = [
    adopted("learning", {
      // The activity pass cannot know which goal a later suggestion will cite.
      learningGoalId: null,
      confirmedLearningGoalIds: [],
    }),
  ];

  assert.equal(policy.evaluate(evidence[0]).allowSuggestions, false);
  assert.deepEqual(
    policy.evaluateSuggestionCandidate({
      basis: "learning_goal",
      learningGoalId: "goal_mandarin",
      confirmedLearningGoalIds: ["goal_mandarin"],
      evidence,
    }),
    { allowed: true, reason: OUTPUT_POLICY_REASONS.LEARNING_GOAL }
  );
});

test("candidate suggestions fail closed when their basis and evidence scene do not agree", () => {
  const policy = new ActivityOutputPolicy();
  const work = [adopted("work_meeting")];
  const social = [adopted("social_call")];

  assert.equal(
    policy.evaluateSuggestionCandidate({
      basis: "learning_goal",
      learningGoalId: "goal_mandarin",
      confirmedLearningGoalIds: ["goal_mandarin"],
      evidence: work,
    }).allowed,
    false
  );
  assert.equal(
    policy.evaluateSuggestionCandidate({
      basis: "explicit_agreement",
      learningGoalId: null,
      confirmedLearningGoalIds: [],
      evidence: social,
    }).allowed,
    true
  );
  assert.equal(
    policy.evaluateSuggestionCandidate({
      basis: "work_context",
      learningGoalId: null,
      confirmedLearningGoalIds: [],
      evidence: social,
    }).allowed,
    false
  );
});

test("candidate suggestions reject passive media uncertain sources and missing SELF evidence", () => {
  const policy = new ActivityOutputPolicy();
  for (const evidence of [
    [adopted("entertainment")],
    [adopted("gaming")],
    [adopted("work_meeting", { sourceAttribution: "mixed_unknown" })],
    [adopted("work_meeting", { selfParticipated: false })],
  ]) {
    assert.equal(
      policy.evaluateSuggestionCandidate({
        basis: "work_context",
        learningGoalId: null,
        confirmedLearningGoalIds: [],
        evidence,
      }).allowed,
      false
    );
  }
});
