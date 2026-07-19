"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AgentWorkloadPolicy,
  AGENT_WORK_PRIORITY,
  freezeAgentAdmissionSnapshot,
} = require("../../src/jarvis/main/AgentWorkloadPolicy");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function externallyDeepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      externallyDeepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function admissionSnapshot() {
  const segments = [
    {
      ordinal: 0,
      segmentId: "segment-1",
      segmentVersion: 3,
      textHash: HASH_C,
      subjectRevision: 7,
      final: true,
      stable: true,
      current: true,
      duplicate: false,
      identityKind: "durable_subject",
    },
    {
      ordinal: 1,
      segmentId: "segment-2",
      segmentVersion: 2,
      textHash: HASH_D,
      subjectRevision: 8,
      final: true,
      stable: true,
      current: true,
      duplicate: false,
      identityKind: "durable_subject",
    },
  ];
  const desiredVector = {
    analysisInputId: "analysis-input-1",
    analysisInputHash: HASH_A,
    transcriptRevision: HASH_B,
    identityRevision: HASH_C,
    promptVersion: "jarvis-analysis-prompt-v2",
    responseSchemaVersion: "jarvis-analysis-v2",
    pseudonymBindingRevision: 4,
    modelVersion: "MiniMax-M2.7",
    cloudPayloadHash: HASH_D,
    segments: segments.map(({ ordinal, segmentId, segmentVersion, textHash, subjectRevision }) => ({
      ordinal,
      segmentId,
      segmentVersion,
      textHash,
      subjectRevision,
    })),
  };
  return {
    snapshotVersion: 1,
    kind: "analyze_session",
    manifest: {
      manifestVersion: 1,
      sessionId: "session-1",
      sessionState: "ended",
      processingState: "ready",
      ...desiredVector,
      segments,
    },
    desiredHead: desiredVector,
    backlog: [],
    captureActive: false,
    previewActive: false,
    pressure: { state: "normal", reason: null },
    cloudLaneInFlight: 0,
  };
}

function evaluate(raw) {
  return new AgentWorkloadPolicy().evaluate(freezeAgentAdmissionSnapshot(raw));
}

function digestAdmissionSnapshot(overrides = {}) {
  return {
    snapshotVersion: 1,
    kind: "generate_daily_digest",
    sourceCurrent: true,
    sourceFinalOnly: true,
    backlog: [],
    captureActive: false,
    previewActive: false,
    pressure: { state: "normal", reason: null },
    cloudLaneInFlight: 0,
    ...overrides,
  };
}

test("exports the final agent priorities and an immutable dependency-free policy", () => {
  assert.deepEqual(AGENT_WORK_PRIORITY, {
    analyze_session: 70,
    generate_daily_digest: 80,
  });
  assert.equal(Object.isFrozen(AGENT_WORK_PRIORITY), true);
  assert.equal(Object.isFrozen(new AgentWorkloadPolicy()), true);
});

test("copies and deeply freezes the canonical snapshot before deterministic evaluation", () => {
  const raw = admissionSnapshot();
  const original = clone(raw);
  const frozen = freezeAgentAdmissionSnapshot(raw);

  assert.notEqual(frozen, raw);
  assert.notEqual(frozen.manifest, raw.manifest);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.manifest), true);
  assert.equal(Object.isFrozen(frozen.manifest.segments), true);
  assert.equal(Object.isFrozen(frozen.manifest.segments[0]), true);
  assert.equal(Object.isFrozen(frozen.desiredHead.segments[0]), true);
  assert.equal(Object.isFrozen(frozen.backlog), true);
  assert.deepEqual(raw, original);
  assert.throws(() => {
    frozen.manifest.sessionId = "mutated";
  }, TypeError);

  const policy = new AgentWorkloadPolicy();
  const first = policy.evaluate(frozen);
  const second = policy.evaluate(frozen);
  assert.deepEqual(first, { eligible: true, reason: null, priority: 70 });
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(raw, original);
});

test("requires evaluation to receive the validated deeply frozen snapshot", () => {
  const policy = new AgentWorkloadPolicy();
  assert.throws(() => policy.evaluate(admissionSnapshot()), /freezeAgentAdmissionSnapshot/);

  let accessorReads = 0;
  const forged = admissionSnapshot();
  Object.defineProperty(forged, "captureActive", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return accessorReads % 2 === 0;
    },
  });
  externallyDeepFreeze(forged);
  assert.throws(() => policy.evaluate(forged), /freezeAgentAdmissionSnapshot/);

  let canonicalReads = 0;
  const rawWithAccessor = admissionSnapshot();
  Object.defineProperty(rawWithAccessor, "captureActive", {
    enumerable: true,
    get() {
      canonicalReads += 1;
      return canonicalReads > 1;
    },
  });
  const canonical = freezeAgentAdmissionSnapshot(rawWithAccessor);
  assert.equal(canonicalReads, 1);
  assert.equal(policy.evaluate(canonical).eligible, true);
  assert.equal(policy.evaluate(canonical).eligible, true);
  assert.equal(canonicalReads, 1);

  const duplicateOrdinal = admissionSnapshot();
  duplicateOrdinal.manifest.segments[1].ordinal = 0;
  assert.throws(
    () => freezeAgentAdmissionSnapshot(duplicateOrdinal),
    /manifest segment ordinals must be contiguous/
  );

  const duplicateId = admissionSnapshot();
  duplicateId.manifest.segments[1].segmentId = "segment-1";
  assert.throws(
    () => freezeAgentAdmissionSnapshot(duplicateId),
    /manifest segment ids must be unique/
  );
});

test("desired vector mismatches supersede every stale immutable input", () => {
  const mutations = [
    (input) => (input.desiredHead.analysisInputId = "analysis-input-2"),
    (input) => (input.desiredHead.analysisInputHash = HASH_B),
    (input) => (input.desiredHead.transcriptRevision = HASH_A),
    (input) => (input.desiredHead.identityRevision = HASH_D),
    (input) => (input.desiredHead.promptVersion = "prompt-v3"),
    (input) => (input.desiredHead.responseSchemaVersion = "schema-v3"),
    (input) => (input.desiredHead.pseudonymBindingRevision = 5),
    (input) => (input.desiredHead.modelVersion = "MiniMax-other"),
    (input) => (input.desiredHead.cloudPayloadHash = HASH_A),
    (input) => (input.desiredHead.segments[1].segmentId = "segment-other"),
    (input) => (input.desiredHead.segments[1].segmentVersion = 3),
    (input) => (input.desiredHead.segments[1].textHash = HASH_A),
    (input) => (input.desiredHead.segments[1].subjectRevision = 9),
  ];

  for (const mutate of mutations) {
    const input = admissionSnapshot();
    mutate(input);
    assert.deepEqual(evaluate(input), {
      eligible: false,
      reason: "current_input_superseded",
      priority: 70,
    });
  }

  const invalidDesiredOrdinal = admissionSnapshot();
  invalidDesiredOrdinal.desiredHead.segments[1].ordinal = 0;
  assert.throws(
    () => freezeAgentAdmissionSnapshot(invalidDesiredOrdinal),
    /desired segment ordinals must be contiguous/
  );
});

test("admits only terminal ready final stable current non-duplicate resolved subjects", () => {
  const mutations = [
    (input) => (input.manifest.sessionState = "active"),
    (input) => (input.manifest.processingState = "processing"),
    (input) => (input.manifest.segments[0].final = false),
    (input) => (input.manifest.segments[0].stable = false),
    (input) => (input.manifest.segments[0].current = false),
    (input) => (input.manifest.segments[0].duplicate = true),
    (input) => (input.manifest.segments[0].identityKind = "unresolved"),
  ];

  for (const mutate of mutations) {
    const input = admissionSnapshot();
    mutate(input);
    assert.deepEqual(evaluate(input), {
      eligible: false,
      reason: "final_inputs_pending",
      priority: 70,
    });
  }

  const recovered = admissionSnapshot();
  recovered.manifest.sessionState = "recovered_terminal";
  assert.equal(evaluate(recovered).eligible, true);

  const temporary = admissionSnapshot();
  temporary.manifest.segments[0].identityKind = "temporary_subject";
  assert.deepEqual(evaluate(temporary), {
    eligible: true,
    reason: null,
    priority: 70,
  });
});

test("pending, running, and future-retry local work all preempt analysis", () => {
  for (const job of [
    { jobType: "transcribe_chunk", lane: "local", state: "pending", priority: 30 },
    { jobType: "diarize_track", lane: "local", state: "running", priority: 40 },
    {
      jobType: "compress_chunk",
      lane: "local",
      state: "retry",
      priority: 60,
      nextRetryAt: 9_999_999,
    },
  ]) {
    const input = admissionSnapshot();
    input.backlog = [job];
    assert.deepEqual(evaluate(input), {
      eligible: false,
      reason: "higher_priority_backlog",
      priority: 70,
    });
  }

  const terminal = admissionSnapshot();
  terminal.backlog = [
    { jobType: "transcribe_chunk", lane: "local", state: "completed", priority: 30 },
    { jobType: "compress_chunk", lane: "local", state: "superseded", priority: 60 },
    { jobType: "diarize_track", lane: "local", state: "blocked", priority: 40 },
    { jobType: "other_cloud", lane: "cloud", state: "running", priority: 10 },
  ];
  assert.equal(evaluate(terminal).eligible, true);
});

test("capture, preview, system pressure, and cloud-lane occupancy use stable reasons", () => {
  for (const mutate of [
    (input) => (input.captureActive = true),
    (input) => (input.previewActive = true),
  ]) {
    const input = admissionSnapshot();
    mutate(input);
    assert.equal(evaluate(input).reason, "preview_active");
  }

  for (const state of ["busy", "constrained", "battery_saver"]) {
    const input = admissionSnapshot();
    input.pressure = { state, reason: `${state}_test` };
    assert.equal(evaluate(input).reason, "system_constrained");
  }

  const laneBusy = admissionSnapshot();
  laneBusy.cloudLaneInFlight = 1;
  assert.equal(evaluate(laneBusy).reason, "cloud_lane_busy");
});

test("daily digest uses priority 80, accepts partial coverage, and waits for analysis", () => {
  assert.deepEqual(evaluate(digestAdmissionSnapshot()), {
    eligible: true,
    reason: null,
    priority: 80,
  });
  assert.deepEqual(
    evaluate(digestAdmissionSnapshot({ sourceCurrent: false })),
    { eligible: false, reason: "current_input_superseded", priority: 80 }
  );
  assert.deepEqual(
    evaluate(digestAdmissionSnapshot({ sourceFinalOnly: false })),
    { eligible: false, reason: "final_inputs_pending", priority: 80 }
  );
  assert.deepEqual(
    evaluate(digestAdmissionSnapshot({
      backlog: [{
        jobType: "analyze_session",
        lane: "cloud",
        state: "retry",
        priority: 70,
        nextRetryAt: 9_999,
      }],
    })),
    { eligible: false, reason: "higher_priority_backlog", priority: 80 }
  );
});

test("reason precedence is desired, finality, backlog, preview, pressure, then cloud lane", () => {
  const input = admissionSnapshot();
  input.desiredHead.analysisInputHash = HASH_B;
  input.manifest.segments[0].final = false;
  input.backlog = [{ jobType: "compress_chunk", lane: "local", state: "retry", priority: 60 }];
  input.previewActive = true;
  input.pressure = { state: "constrained", reason: "cpu_load_high" };
  input.cloudLaneInFlight = 1;
  assert.equal(evaluate(input).reason, "current_input_superseded");

  input.desiredHead.analysisInputHash = HASH_A;
  assert.equal(evaluate(input).reason, "final_inputs_pending");
  input.manifest.segments[0].final = true;
  assert.equal(evaluate(input).reason, "higher_priority_backlog");
  input.backlog = [];
  assert.equal(evaluate(input).reason, "preview_active");
  input.previewActive = false;
  assert.equal(evaluate(input).reason, "system_constrained");
  input.pressure = { state: "normal", reason: null };
  assert.equal(evaluate(input).reason, "cloud_lane_busy");
});
