const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TODO_ATTRIBUTION_POLICY_VERSION,
  evaluateTodoAttribution,
} = require("../../src/jarvis/main/TodoAttributionPolicy");

function evidence(overrides = {}) {
  return {
    segmentId: "segment-self",
    speakerRelation: "SELF",
    speakerEvidenceVerified: true,
    overlapDetected: false,
    sourceAttribution: "microphone",
    applicationKey: null,
    activityCategory: "work_meeting",
    activityConfidence: 0.96,
    activityDecision: "adopted",
    allowTodos: true,
    voiceConfidence: 0.97,
    transcriptConfidence: 0.98,
    startedAt: 1_000,
    endedAt: 2_000,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    ownerLabel: "SELF",
    semanticConfidence: 0.95,
    localCommitmentConfidence: 0.94,
    actionKind: "self_commitment",
    assignmentSegmentIds: [],
    acceptanceSegmentIds: [],
    evidence: [evidence()],
    ...overrides,
  };
}

test("auto-confirms only a strict SELF commitment with three independent 90% gates", () => {
  const result = evaluateTodoAttribution(input());

  assert.equal(result.disposition, "auto_confirmed");
  assert.equal(result.reason, "strict_self_commitment");
  assert.deepEqual(result.snapshot, {
    schemaVersion: 2,
    policyVersion: TODO_ATTRIBUTION_POLICY_VERSION,
    actionKind: "self_commitment",
    assignmentSegmentIds: [],
    acceptanceSegmentIds: [],
    evidenceSegmentIds: ["segment-self"],
    applicationKeys: [],
    activityCategories: ["work_meeting"],
    sourceAttributions: ["microphone"],
    speakerRelations: ["SELF"],
    semanticConfidence: 0.94,
    voiceConfidence: 0.97,
    sceneConfidence: 0.96,
    transcriptConfidence: 0.98,
    speakerEvidenceVerified: true,
    overlapDetected: false,
    trustGatePassed: true,
  });
});

for (const [name, patch] of [
  ["semantic", { semanticConfidence: 0.899 }],
  ["local commitment", { localCommitmentConfidence: 0.899 }],
]) {
  test(`does not auto-confirm when ${name} confidence is below 90%`, () => {
    const result = evaluateTodoAttribution(input(patch));
    assert.equal(result.disposition, "rejected");
    assert.equal(result.snapshot.trustGatePassed, false);
  });
}

test("does not auto-confirm when SELF voice confidence is below 90%", () => {
  const result = evaluateTodoAttribution(
    input({ evidence: [evidence({ voiceConfidence: 0.89 })] })
  );
  assert.equal(result.disposition, "rejected");
  assert.equal(result.snapshot.voiceConfidence, 0.89);
});

test("does not auto-confirm when scene confidence is below 90%", () => {
  const result = evaluateTodoAttribution(
    input({ evidence: [evidence({ activityConfidence: 0.89 })] })
  );
  assert.equal(result.disposition, "rejected");
  assert.equal(result.snapshot.sceneConfidence, 0.89);
});

for (const [name, overrides] of [
  ["unknown speaker", { speakerRelation: "UNKNOWN" }],
  ["unverified speaker evidence", { speakerEvidenceVerified: false }],
  ["overlap", { overlapDetected: true }],
  ["mixed source", { sourceAttribution: "mixed_unknown" }],
  ["tentative scene", { activityDecision: "tentative" }],
  ["entertainment", { activityCategory: "entertainment" }],
  ["game", { activityCategory: "gaming" }],
  ["policy-disabled scene", { allowTodos: false }],
]) {
  test(`fails closed for ${name}`, () => {
    const result = evaluateTodoAttribution(input({ evidence: [evidence(overrides)] }));
    assert.equal(result.disposition, "rejected");
    assert.equal(result.snapshot.trustGatePassed, false);
  });
}

test("keeps an explicit assignment accepted by SELF pending for user confirmation", () => {
  const result = evaluateTodoAttribution(
    input({
      actionKind: "assignment_accepted",
      assignmentSegmentIds: ["segment-assigner"],
      acceptanceSegmentIds: ["segment-self"],
      evidence: [
        evidence({
          segmentId: "segment-assigner",
          speakerRelation: "P1",
          voiceConfidence: 0.93,
          applicationKey: "kook",
          sourceAttribution: "application_and_microphone",
          startedAt: 1_000,
          endedAt: 2_000,
        }),
        evidence({
          segmentId: "segment-self",
          applicationKey: "kook",
          sourceAttribution: "application_and_microphone",
          startedAt: 3_000,
          endedAt: 4_000,
        }),
      ],
    })
  );

  assert.equal(result.disposition, "pending_confirmation");
  assert.equal(result.reason, "assigned_and_accepted");
  assert.equal(result.snapshot.trustGatePassed, true);
  assert.equal(result.snapshot.actionKind, "assignment_accepted");
  assert.deepEqual(result.snapshot.assignmentSegmentIds, ["segment-assigner"]);
  assert.deepEqual(result.snapshot.acceptanceSegmentIds, ["segment-self"]);
  assert.deepEqual(result.snapshot.speakerRelations, ["P1", "SELF"]);
  assert.deepEqual(result.snapshot.applicationKeys, ["kook"]);
});

test("rejects mixed-speaker evidence that does not explicitly identify assignment and acceptance", () => {
  const result = evaluateTodoAttribution(
    input({
      actionKind: undefined,
      assignmentSegmentIds: undefined,
      acceptanceSegmentIds: undefined,
      evidence: [
        evidence({ segmentId: "segment-assigner", speakerRelation: "P1" }),
        evidence({ segmentId: "segment-self", startedAt: 3_000, endedAt: 4_000 }),
      ],
    })
  );
  assert.equal(result.disposition, "rejected");
  assert.equal(result.reason, "assignment_evidence_invalid");
});

test("rejects assignment evidence unless another speaker assigns before SELF accepts", () => {
  for (const patch of [
    {
      assignmentSegmentIds: ["segment-self"],
      acceptanceSegmentIds: ["segment-assigner"],
    },
    {
      evidence: [
        evidence({
          segmentId: "segment-assigner",
          speakerRelation: "P1",
          startedAt: 3_000,
          endedAt: 4_000,
        }),
        evidence({ segmentId: "segment-self", startedAt: 1_000, endedAt: 2_000 }),
      ],
    },
  ]) {
    const result = evaluateTodoAttribution(
      input({
        actionKind: "assignment_accepted",
        assignmentSegmentIds: ["segment-assigner"],
        acceptanceSegmentIds: ["segment-self"],
        evidence: [
          evidence({ segmentId: "segment-assigner", speakerRelation: "P1" }),
          evidence({ segmentId: "segment-self", startedAt: 3_000, endedAt: 4_000 }),
        ],
        ...patch,
      })
    );
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "assignment_evidence_invalid");
  }
});

test("rejects a task assigned only to another person", () => {
  const result = evaluateTodoAttribution(
    input({ evidence: [evidence({ speakerRelation: "P1" })] })
  );
  assert.equal(result.disposition, "rejected");
});

test("validates the closed local policy input instead of coercing missing confidence", () => {
  assert.throws(
    () => evaluateTodoAttribution({ ...input(), semanticConfidence: null }),
    /semantic confidence/u
  );
  assert.throws(() => evaluateTodoAttribution({ ...input(), evidence: [] }), /evidence/u);
});
