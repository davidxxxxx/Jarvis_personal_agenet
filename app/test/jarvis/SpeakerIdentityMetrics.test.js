const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");

function metrics() {
  return require("./support/SpeakerIdentityMetrics");
}

function overlapFixture(weights, predictedIds, truthIds) {
  const predictedTurns = [];
  const truthSegments = [];
  let cursor = 0;
  for (let row = 0; row < predictedIds.length; row += 1) {
    for (let column = 0; column < truthIds.length; column += 1) {
      const duration = weights[row][column];
      if (duration <= 0) continue;
      predictedTurns.push({
        clusterId: predictedIds[row],
        startMs: cursor,
        endMs: cursor + duration,
      });
      truthSegments.push({
        speakerId: truthIds[column],
        startMs: cursor,
        endMs: cursor + duration,
      });
      cursor += duration;
    }
  }
  return { predictedTurns, truthSegments };
}

function truthSpeaker(speakerId, kind, personId = null) {
  return { speakerId, kind, personId: kind === "unknown" ? null : (personId ?? speakerId) };
}

function exactGateCase(overrides = {}) {
  const policy = SPEAKER_IDENTITY_RESOLUTION_POLICY;
  return {
    caseId: "threshold-case",
    truthSpeakers: [
      truthSpeaker("truth-self", "self", "self"),
      truthSpeaker("truth-known", "known", "known-a"),
      truthSpeaker("truth-unknown", "unknown"),
    ],
    truthSegments: [
      { speakerId: "truth-self", startMs: 0, endMs: 1_000 },
      { speakerId: "truth-known", startMs: 1_000, endMs: 2_000 },
      { speakerId: "truth-unknown", startMs: 2_000, endMs: 3_000 },
    ],
    predictedTurns: [
      { clusterId: "cluster-self", startMs: 0, endMs: 1_000 },
      { clusterId: "cluster-known", startMs: 1_000, endMs: 2_000 },
      { clusterId: "cluster-unknown", startMs: 2_000, endMs: 3_000 },
    ],
    decisions: [
      {
        clusterId: "cluster-self",
        state: "confirmed",
        candidatePersonId: "self",
        candidateKind: "self",
        score: policy.autoConfirmSimilarity,
        margin: policy.minimumMargin,
      },
      {
        clusterId: "cluster-known",
        state: "confirmed",
        candidatePersonId: "known-a",
        candidateKind: "known",
        score: policy.autoConfirmSimilarity,
        margin: policy.minimumMargin,
      },
      {
        clusterId: "cluster-unknown",
        state: "unknown",
        candidatePersonId: null,
        candidateKind: null,
        score: null,
        margin: null,
      },
    ],
    ...overrides,
  };
}

test("maximum-weight matching is permutation-invariant and discards zero-overlap pairs", () => {
  const { maximumWeightSpeakerMatching } = metrics();
  const fixture = overlapFixture(
    [
      [0, 20],
      [10, 0],
    ],
    ["cluster-b", "cluster-a"],
    ["speaker-b", "speaker-a"]
  );

  const expected = [
    { clusterId: "cluster-a", speakerId: "speaker-b", overlapMs: 10 },
    { clusterId: "cluster-b", speakerId: "speaker-a", overlapMs: 20 },
  ];
  assert.deepEqual(maximumWeightSpeakerMatching(fixture), expected);
  assert.deepEqual(
    maximumWeightSpeakerMatching({
      predictedTurns: [...fixture.predictedTurns].reverse(),
      truthSegments: [...fixture.truthSegments].reverse(),
    }),
    expected
  );
  assert.deepEqual(
    maximumWeightSpeakerMatching({
      predictedTurns: [{ clusterId: "orphan", startMs: 0, endMs: 10 }],
      truthSegments: [{ speakerId: "elsewhere", startMs: 10, endMs: 20 }],
    }),
    []
  );
});

test("maximum-weight matching solves the 3x3 greedy trap globally", () => {
  const { maximumWeightSpeakerMatching } = metrics();
  const fixture = overlapFixture(
    [
      [9, 8, 0],
      [8, 0, 0],
      [0, 7, 7],
    ],
    ["cluster-a", "cluster-b", "cluster-c"],
    ["speaker-1", "speaker-2", "speaker-3"]
  );

  assert.deepEqual(maximumWeightSpeakerMatching(fixture), [
    { clusterId: "cluster-a", speakerId: "speaker-2", overlapMs: 8 },
    { clusterId: "cluster-b", speakerId: "speaker-1", overlapMs: 8 },
    { clusterId: "cluster-c", speakerId: "speaker-3", overlapMs: 7 },
  ]);
});

test("identity metrics report exact self, known, unknown, correction, and boundary denominators", () => {
  const { computeSpeakerIdentityMetrics } = metrics();
  const policy = SPEAKER_IDENTITY_RESOLUTION_POLICY;
  const report = computeSpeakerIdentityMetrics({
    policy,
    cases: [
      {
        caseId: "case-a",
        truthSpeakers: [
          truthSpeaker("self-a", "self", "self"),
          truthSpeaker("known-a", "known", "known-a"),
          truthSpeaker("unknown-a", "unknown"),
        ],
        truthSegments: [
          { speakerId: "self-a", startMs: 0, endMs: 100 },
          { speakerId: "known-a", startMs: 100, endMs: 200 },
          { speakerId: "unknown-a", startMs: 200, endMs: 300 },
        ],
        predictedTurns: [
          { clusterId: "a-self", startMs: 0, endMs: 100 },
          { clusterId: "a-known", startMs: 100, endMs: 200 },
          { clusterId: "a-unknown", startMs: 200, endMs: 300 },
        ],
        decisions: [
          {
            clusterId: "a-self",
            state: "confirmed",
            candidatePersonId: "self",
            candidateKind: "self",
            score: 0.9,
            margin: 0.1,
          },
          {
            clusterId: "a-known",
            state: "suggested",
            candidatePersonId: "self",
            candidateKind: "self",
            score: 0.75,
            margin: 0.1,
          },
          {
            clusterId: "a-unknown",
            state: "confirmed",
            candidatePersonId: "self",
            candidateKind: "self",
            score: 0.85,
            margin: 0.07,
          },
        ],
      },
      {
        caseId: "case-b",
        truthSpeakers: [truthSpeaker("known-b", "known", "known-b")],
        truthSegments: [{ speakerId: "known-b", startMs: 0, endMs: 100 }],
        predictedTurns: [{ clusterId: "b-known", startMs: 0, endMs: 100 }],
        decisions: [
          {
            clusterId: "b-known",
            state: "confirmed",
            candidatePersonId: "known-b",
            candidateKind: "known",
            score: policy.autoConfirmSimilarity,
            margin: policy.minimumMargin,
          },
        ],
      },
    ],
  });

  assert.deepEqual(report.speakerCount, { correctCases: 2, totalCases: 2, accuracy: 1 });
  assert.deepEqual(report.self, {
    truthSupport: 1,
    automaticSupport: 2,
    tp: 1,
    fp: 1,
    fn: 0,
    precision: 0.5,
    recall: 1,
  });
  assert.deepEqual(report.known, {
    truthSupport: 2,
    automaticSupport: 1,
    tp: 1,
    fp: 0,
    fn: 1,
    precision: 1,
    recall: 0.5,
  });
  assert.deepEqual(report.unknown, {
    truthSupport: 1,
    automaticFalsePositives: 1,
    falsePositiveRate: 1,
  });
  assert.equal(report.correctionsNeeded, 2);
  assert.deepEqual(
    report.automaticBoundaries.map((row) => ({
      caseId: row.caseId,
      clusterId: row.clusterId,
      requiredScore: row.requiredScore,
      requiredMargin: row.requiredMargin,
      scorePass: row.scorePass,
      marginPass: row.marginPass,
    })),
    [
      {
        caseId: "case-a",
        clusterId: "a-self",
        requiredScore: policy.autoConfirmSimilarity,
        requiredMargin: policy.minimumMargin,
        scorePass: true,
        marginPass: true,
      },
      {
        caseId: "case-a",
        clusterId: "a-unknown",
        requiredScore: policy.autoConfirmSimilarity,
        requiredMargin: policy.minimumMargin,
        scorePass: true,
        marginPass: true,
      },
      {
        caseId: "case-b",
        clusterId: "b-known",
        requiredScore: policy.autoConfirmSimilarity,
        requiredMargin: policy.minimumMargin,
        scorePass: true,
        marginPass: true,
      },
    ]
  );
});

test("undefined metric ratios remain null", () => {
  const { computeSpeakerIdentityMetrics } = metrics();
  const report = computeSpeakerIdentityMetrics({
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    cases: [
      {
        caseId: "no-auto",
        truthSpeakers: [truthSpeaker("self", "self", "self"), truthSpeaker("unknown", "unknown")],
        truthSegments: [
          { speakerId: "self", startMs: 0, endMs: 100 },
          { speakerId: "unknown", startMs: 100, endMs: 200 },
        ],
        predictedTurns: [
          { clusterId: "cluster-self", startMs: 0, endMs: 100 },
          { clusterId: "cluster-unknown", startMs: 100, endMs: 200 },
        ],
        decisions: [
          {
            clusterId: "cluster-self",
            state: "unknown",
            candidatePersonId: null,
            candidateKind: null,
            score: null,
            margin: null,
          },
          {
            clusterId: "cluster-unknown",
            state: "unknown",
            candidatePersonId: null,
            candidateKind: null,
            score: null,
            margin: null,
          },
        ],
      },
    ],
  });

  assert.equal(report.self.precision, null);
  assert.equal(report.self.recall, 0);
  assert.equal(report.known.precision, null);
  assert.equal(report.known.recall, null);
  assert.equal(report.unknown.falsePositiveRate, 0);
});

test("release gates fail explicitly when self or known automatic support is zero", () => {
  const { computeSpeakerIdentityMetrics, evaluateSpeakerReleaseGates } = metrics();
  const noAutomatic = exactGateCase({
    decisions: exactGateCase().decisions.map((decision) => ({
      ...decision,
      state: "unknown",
      candidatePersonId: null,
      candidateKind: null,
      score: null,
      margin: null,
    })),
  });
  const gate = evaluateSpeakerReleaseGates(
    computeSpeakerIdentityMetrics({
      cases: [noAutomatic],
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    })
  );

  assert.equal(gate.passed, false);
  assert.deepEqual(gate.failures, ["self_automatic_support_zero", "known_automatic_support_zero"]);
});

test("production score and margin thresholds pass at equality and fail immediately below", () => {
  const { computeSpeakerIdentityMetrics, evaluateSpeakerReleaseGates } = metrics();
  const policy = SPEAKER_IDENTITY_RESOLUTION_POLICY;
  const atBoundary = computeSpeakerIdentityMetrics({ cases: [exactGateCase()], policy });
  assert.deepEqual(evaluateSpeakerReleaseGates(atBoundary), {
    passed: true,
    failures: [],
  });

  const belowScore = exactGateCase();
  belowScore.decisions[0] = {
    ...belowScore.decisions[0],
    score: policy.autoConfirmSimilarity - Number.EPSILON,
  };
  assert.deepEqual(
    evaluateSpeakerReleaseGates(computeSpeakerIdentityMetrics({ cases: [belowScore], policy })),
    { passed: false, failures: ["automatic_score_boundary_failed"] }
  );

  const belowMargin = exactGateCase();
  belowMargin.decisions[1] = {
    ...belowMargin.decisions[1],
    margin: policy.minimumMargin - Number.EPSILON,
  };
  assert.deepEqual(
    evaluateSpeakerReleaseGates(computeSpeakerIdentityMetrics({ cases: [belowMargin], policy })),
    { passed: false, failures: ["automatic_margin_boundary_failed"] }
  );
});

test("precision hard gate accepts 0.95 exactly and rejects the adjacent lower ratio", () => {
  const { evaluateSpeakerReleaseGates } = metrics();
  const base = {
    speakerCount: { correctCases: 1, totalCases: 1, accuracy: 1 },
    self: {
      truthSupport: 20,
      automaticSupport: 20,
      tp: 19,
      fp: 1,
      fn: 1,
      precision: 0.95,
      recall: 0.95,
    },
    known: {
      truthSupport: 20,
      automaticSupport: 20,
      tp: 19,
      fp: 1,
      fn: 1,
      precision: 0.95,
      recall: 0.95,
    },
    unknown: { truthSupport: 20, automaticFalsePositives: 1, falsePositiveRate: 0.05 },
    correctionsNeeded: 0,
    automaticBoundaries: [],
  };
  assert.equal(evaluateSpeakerReleaseGates(base).passed, true);

  const below = structuredClone(base);
  below.known.tp = 18;
  below.known.fp = 1;
  below.known.automaticSupport = 19;
  below.known.precision = 18 / 19;
  assert.deepEqual(evaluateSpeakerReleaseGates(below), {
    passed: false,
    failures: ["known_precision_below_0_95"],
  });
});
