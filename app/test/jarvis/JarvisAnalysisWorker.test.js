const test = require("node:test");
const assert = require("node:assert/strict");
const AgentWorkloadPolicy = require("../../src/jarvis/main/AgentWorkloadPolicy");
const { validateCandidateAnalysis } = require("../../src/jarvis/main/JarvisAnalysisSchema");

function loadWorker() {
  return require("../../src/jarvis/main/JarvisAnalysisWorker");
}

function workerHarness({ applyResult = { status: "applied" }, applyError = null } = {}) {
  const calls = [];
  const store = {
    completeJob(jobId, input) {
      calls.push(["complete", jobId, input]);
      return true;
    },
    supersedeAnalysisJob(jobId, input) {
      calls.push(["supersede", jobId, input]);
      return true;
    },
    deferJob() {
      return true;
    },
    blockJob(jobId, input) {
      calls.push(["block", jobId, input]);
      return true;
    },
    recordJobExecutionDevice() {
      return true;
    },
  };
  const memoryRepository = {
    applyStoredAnalysisCandidate(input) {
      calls.push(["apply", input]);
      if (applyError) throw applyError;
      return applyResult;
    },
    getAnalysisInputForCloud() {
      throw new Error("recovery must not load a cloud request payload");
    },
    getAnalysisDesiredHead() {
      throw new Error("recovery must not prepare a new request");
    },
    listRecoverableAnalysisCandidates() {
      return [];
    },
    persistValidatedAnalysisCandidate() {
      throw new Error("recovery must not persist a second candidate");
    },
  };
  const client = {
    async analyze() {
      calls.push(["request"]);
      throw new Error("recovery must not use the network client");
    },
  };
  const budgetGuard = {
    listAttemptDispositionsByJob() {
      return [];
    },
    reserveNextAttempt() {
      throw new Error("recovery must not reserve a new budget attempt");
    },
    markStarted() {
      throw new Error("recovery must not start a budget attempt");
    },
    reconcile() {
      throw new Error("recovery must not reconcile twice");
    },
    release() {
      throw new Error("recovery must not release reconciled usage");
    },
    markUsageUnknown() {
      throw new Error("recovery must preserve reconciled usage");
    },
  };
  const policy = Object.freeze({
    evaluate: () => ({ eligible: true, reason: null, priority: 70 }),
  });
  const JarvisAnalysisWorker = loadWorker();
  const worker = new JarvisAnalysisWorker({
    store,
    memoryRepository,
    budgetGuard,
    workloadPolicy: policy,
    loadAdmissionSnapshot: () => {
      throw new Error("recovery must not evaluate new-request admission");
    },
    client,
    owner: "cloud-worker",
    model: "MiniMax-M2.7",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
    createRequestId: () => "budget-request-1",
    now: () => 200,
  });
  return { worker, calls };
}

test("startup completes already-applied analysis candidate with zero client calls", () => {
  const { worker, calls } = workerHarness();

  assert.deepEqual(
    worker.recoverCandidate({
      jobId: "job-analysis-1",
      candidateId: "candidate-1",
      candidateState: "applied",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 500,
    }),
    { status: "already_applied", jobId: "job-analysis-1" }
  );
  assert.deepEqual(calls, [
    ["complete", "job-analysis-1", { owner: "cloud-worker", at: 200, executionDevice: "cloud" }],
  ]);
});

test("startup applies a validated candidate and completes it with zero client calls", () => {
  const { worker, calls } = workerHarness();

  assert.deepEqual(
    worker.recoverCandidate({
      jobId: "job-analysis-1",
      candidateId: "candidate-1",
      candidateState: "validated",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 500,
    }),
    { status: "applied", jobId: "job-analysis-1" }
  );
  assert.deepEqual(calls, [
    [
      "apply",
      { candidateId: "candidate-1", jobId: "job-analysis-1", owner: "cloud-worker", at: 200 },
    ],
    ["complete", "job-analysis-1", { owner: "cloud-worker", at: 200, executionDevice: "cloud" }],
  ]);
});

test("startup blocks a validated candidate whose local application fails", () => {
  const { worker, calls } = workerHarness({
    applyError: Object.assign(new Error("local merge failed"), { code: "MEMORY_MERGER_INVALID_INPUT" }),
  });

  assert.deepEqual(
    worker.recoverCandidate({
      jobId: "job-analysis-1",
      candidateId: "candidate-1",
      candidateState: "validated",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 500,
    }),
    { status: "blocked", reason: "candidate_apply_failed", jobId: "job-analysis-1" }
  );
  assert.equal(calls.some(([name]) => name === "complete"), false);
  assert.equal(calls.find(([name]) => name === "block")[2].errorCode, "analysis_candidate_apply_failed");
});

test("startup supersedes a reconciled superseded candidate with zero network or apply calls", () => {
  const { worker, calls } = workerHarness();

  assert.deepEqual(
    worker.recoverCandidate({
      jobId: "job-analysis-1",
      candidateId: "candidate-1",
      candidateState: "superseded",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 500,
    }),
    { status: "superseded", jobId: "job-analysis-1" }
  );
  assert.deepEqual(calls, [["supersede", "job-analysis-1", { owner: "cloud-worker", at: 200 }]]);
});

const INPUT_HASH = "a".repeat(64);
const DESIRED_HASH = "b".repeat(64);
const TRANSCRIPT_HASH = "c".repeat(64);
const IDENTITY_HASH = "d".repeat(64);
const PAYLOAD_HASH = "e".repeat(64);
const TEXT_HASH = "f".repeat(64);

function desiredHead(overrides = {}) {
  return {
    analysisInputId: "analysis-input-1",
    analysisInputHash: INPUT_HASH,
    transcriptRevision: TRANSCRIPT_HASH,
    identityRevision: IDENTITY_HASH,
    promptVersion: "jarvis-analysis-v2",
    responseSchemaVersion: "jarvis-analysis-v2",
    pseudonymBindingRevision: 1,
    modelVersion: "MiniMax-M2.7",
    cloudPayloadHash: PAYLOAD_HASH,
    segments: [
      {
        ordinal: 0,
        segmentId: "segment-1",
        segmentVersion: 1,
        textHash: TEXT_HASH,
        subjectRevision: 1,
      },
    ],
    desiredVectorHash: DESIRED_HASH,
    headRevision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function validCandidate() {
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
  };
}

function clientResponse(overrides = {}) {
  return {
    result: validCandidate(),
    usage: { inputTokens: 80, outputTokens: 40 },
    model: "MiniMax-M2.7",
    requestId: "provider-request-1",
    inputHash: INPUT_HASH,
    requestBytes: 800,
    responseBytes: 400,
    ...overrides,
  };
}

function manifestFor(head) {
  return {
    manifestVersion: 1,
    sessionId: "session-1",
    sessionState: "ended",
    processingState: "ready",
    analysisInputId: head.analysisInputId,
    analysisInputHash: head.analysisInputHash,
    transcriptRevision: head.transcriptRevision,
    identityRevision: head.identityRevision,
    promptVersion: head.promptVersion,
    responseSchemaVersion: head.responseSchemaVersion,
    pseudonymBindingRevision: head.pseudonymBindingRevision,
    modelVersion: head.modelVersion,
    cloudPayloadHash: head.cloudPayloadHash,
    segments: head.segments.map((segment) => ({
      ...segment,
      final: true,
      stable: true,
      current: true,
      duplicate: false,
      identityKind: "durable_subject",
    })),
  };
}

function admissionState(head, overrides = {}) {
  return {
    manifest: manifestFor(head),
    backlog: [],
    captureActive: false,
    previewActive: false,
    pressure: {
      state: "normal",
      reason: null,
      cpuLoadPct: 20,
      memoryLoadPct: 30,
      onAcPower: true,
      batteryLevelPct: 100,
    },
    cloudLaneInFlight: 0,
    ...overrides,
  };
}

function claimedJob(overrides = {}) {
  return {
    id: "job-analysis-1",
    session_id: "session-1",
    job_type: "analyze_session",
    state: "running",
    lane: "cloud",
    input_hash: INPUT_HASH,
    input_version: 1,
    model_version: "MiniMax-M2.7",
    analysis_input_id: "analysis-input-1",
    desired_head_hash: DESIRED_HASH,
    lease_owner: "cloud-worker",
    lease_expires_at: 500,
    error_code: null,
    ...overrides,
  };
}

function executionHarness({
  initialHead = desiredHead(),
  onReserve = null,
  admissionStates = null,
  reserveResult = {
    ok: true,
    requestId: "budget-request-1",
    attemptNumber: 1,
    state: "reserved",
    reservedMicrousd: 100,
    replayed: false,
  },
  markStartedResult = {
    ok: true,
    requestId: "budget-request-1",
    state: "started",
    replayed: false,
  },
  response = clientResponse(),
  clientError = null,
  attempts = [],
  applyResult = { status: "applied" },
  applyError = null,
  executionDeviceRecorded = true,
  executionDeviceError = null,
  clientConfigured = true,
  budgetMode = "capped",
} = {}) {
  const JarvisAnalysisWorker = loadWorker();
  const calls = [];
  let head = initialHead;
  let admissionIndex = 0;
  const cloudInput = {
    inputHash: INPUT_HASH,
    cloudPayloadJson: JSON.stringify({
      inputVersion: "jarvis-analysis-input-v2",
      segments: [
        {
          segmentId: "segment-1",
          startedAt: 100,
          endedAt: 200,
          speakerLabel: "SELF",
          text: "redacted evidence",
        },
      ],
      omittedRanges: [],
    }),
    allowedSegmentIds: ["segment-1"],
    allowedOwnerLabels: ["SELF"],
  };
  const store = {
    completeJob(jobId, input) {
      calls.push(["complete", jobId, input]);
      return true;
    },
    supersedeAnalysisJob(jobId, input) {
      calls.push(["supersede", jobId, input]);
      return true;
    },
    deferJob(jobId, input) {
      calls.push(["defer", jobId, input]);
      return true;
    },
    blockJob(jobId, input) {
      calls.push(["block", jobId, input]);
      return true;
    },
    recordJobExecutionDevice(jobId, input) {
      calls.push(["execution_device", jobId, input]);
      if (executionDeviceError) throw executionDeviceError;
      return executionDeviceRecorded;
    },
  };
  const memoryRepository = {
    getAnalysisInputForCloud(id) {
      calls.push(["load_input", id]);
      return cloudInput;
    },
    getAnalysisDesiredHead(sessionId) {
      calls.push(["load_head", sessionId]);
      return head;
    },
    listRecoverableAnalysisCandidates() {
      calls.push(["load_candidates"]);
      return [];
    },
    persistValidatedAnalysisCandidate(input) {
      calls.push(["persist", input]);
      return {
        status: "created",
        candidateId: "candidate-1",
        candidateHash: "1".repeat(64),
        state: "validated",
      };
    },
    applyStoredAnalysisCandidate(input) {
      calls.push(["apply", input]);
      if (applyError) throw applyError;
      return applyResult;
    },
  };
  const budgetGuard = {
    getStatus() {
      calls.push(["budget_status"]);
      return { mode: budgetMode };
    },
    listAttemptDispositionsByJob(input) {
      calls.push(["load_attempts", input]);
      return attempts;
    },
    reserveNextAttempt(input) {
      calls.push(["reserve", input]);
      onReserve?.({ setHead: (next) => (head = next) });
      return reserveResult;
    },
    markStarted(requestId) {
      calls.push(["mark_started", requestId]);
      return markStartedResult;
    },
    reconcile(input) {
      calls.push(["reconcile", input]);
      return { ok: true, requestId: input.requestId, state: "reconciled" };
    },
    release(input) {
      calls.push(["release", input]);
      return { ok: true, requestId: input.requestId, state: "released" };
    },
    markUsageUnknown(input) {
      calls.push(["usage_unknown", input]);
      return { ok: true, requestId: input.requestId, state: "usage_unknown" };
    },
  };
  const snapshots = admissionStates ?? [() => admissionState(head), () => admissionState(head)];
  const worker = new JarvisAnalysisWorker({
    store,
    memoryRepository,
    budgetGuard,
    workloadPolicy: new AgentWorkloadPolicy(),
    loadAdmissionSnapshot(input) {
      calls.push(["policy_snapshot", input.desiredHead.desiredVectorHash]);
      const value = snapshots[Math.min(admissionIndex, snapshots.length - 1)];
      admissionIndex += 1;
      return typeof value === "function" ? value() : value;
    },
    client: {
      isConfigured: () => clientConfigured,
      async analyze(input) {
        calls.push(["request", input]);
        if (clientError) throw clientError;
        return response;
      },
    },
    owner: "cloud-worker",
    model: "MiniMax-M2.7",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
    createRequestId: () => "budget-request-1",
    validateCandidate(candidate, context) {
      calls.push(["validate"]);
      return validateCandidateAnalysis(candidate, context);
    },
    now: () => 200,
  });
  return { worker, calls, cloudInput, setHead: (next) => (head = next) };
}

test("executes the exact durable request ordering and applies through candidate CAS", async () => {
  const { worker, calls, cloudInput } = executionHarness();

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "applied",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "load_input",
      "load_head",
      "load_candidates",
      "load_attempts",
      "policy_snapshot",
      "reserve",
      "load_input",
      "load_head",
      "policy_snapshot",
      "mark_started",
      "execution_device",
      "request",
      "validate",
      "reconcile",
      "persist",
      "apply",
      "complete",
    ]
  );
  assert.equal(calls.find(([name]) => name === "request")[1], cloudInput);
});

test("missing MiniMax configuration defers before reserving or starting budget", async () => {
  const { worker, calls } = executionHarness({ clientConfigured: false });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "deferred",
    reason: "configuration_required",
    jobId: "job-analysis-1",
  });
  assert.equal(calls.some(([name]) => name === "reserve"), false);
  assert.equal(calls.some(([name]) => name === "mark_started"), false);
  assert.equal(calls.some(([name]) => name === "request"), false);
});

test("analysis jobs require the fixed input contract version before durable reads", async () => {
  const { worker, calls } = executionHarness();

  await assert.rejects(worker.execute(claimedJob({ input_version: 2 })), {
    code: "ANALYSIS_JOB_CONTRACT_INVALID",
  });
  assert.deepEqual(calls, []);
});

test("finishes a stale job before reserve without a paid attempt", async () => {
  const { worker, calls } = executionHarness({
    initialHead: desiredHead({ desiredVectorHash: "9".repeat(64) }),
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "superseded",
    jobId: "job-analysis-1",
  });
  assert.equal(
    calls.some(([name]) => name === "reserve"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "request"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "complete"),
    false
  );
  assert.deepEqual(calls.find(([name]) => name === "supersede").slice(1), [
    "job-analysis-1",
    { owner: "cloud-worker", at: 200 },
  ]);
});

test("releases a reservation when the desired head becomes stale before send", async () => {
  const { worker, calls } = executionHarness({
    onReserve({ setHead }) {
      setHead(desiredHead({ desiredVectorHash: "9".repeat(64) }));
    },
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "superseded",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(calls.find(([name]) => name === "release")[1], {
    requestId: "budget-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(
    calls.some(([name]) => name === "request"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "complete"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "supersede"),
    true
  );
});

test("releases and defers when local-work admission is revoked after reserve", async () => {
  const head = desiredHead();
  const { worker, calls } = executionHarness({
    admissionStates: [
      admissionState(head),
      admissionState(head, {
        backlog: [
          {
            jobType: "transcribe_chunk",
            lane: "local",
            state: "pending",
            priority: 30,
            nextRetryAt: null,
          },
        ],
      }),
    ],
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "deferred",
    reason: "higher_priority_backlog",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(calls.find(([name]) => name === "release")[1], {
    requestId: "budget-request-1",
    reasonCode: "admission_revoked",
  });
  assert.equal(
    calls.find(([name]) => name === "defer")[2].reason,
    "analysis_deferred_for_local_work"
  );
  assert.equal(
    calls.some(([name]) => name === "request"),
    false
  );
});

test("budget denial defers without deleting pending analysis work", async () => {
  const { worker, calls } = executionHarness({
    reserveResult: { ok: false, reason: "budget_exceeded" },
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "deferred",
    reason: "budget_exceeded",
    jobId: "job-analysis-1",
  });
  assert.equal(calls.find(([name]) => name === "defer")[2].reason, "analysis_budget_denied");
  assert.equal(
    calls.some(([name]) => name === "request"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "complete"),
    false
  );
});

test("manual retry authorization survives resource deferral before transport", async () => {
  const head = desiredHead();
  const reconciled = {
    requestId: "prior-paid-request",
    jobId: "job-analysis-1",
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    state: "reconciled",
    actualInputTokens: 100,
    actualOutputTokens: 50,
    actualMicrousd: 10,
  };
  const harness = executionHarness({
    initialHead: head,
    attempts: [reconciled],
    admissionStates: [
      admissionState(head, {
        pressure: {
          state: "busy",
          reason: "external_gpu_busy",
          cpuLoadPct: 20,
          memoryLoadPct: 30,
          onAcPower: true,
          batteryLevelPct: 100,
        },
      }),
    ],
  });

  const result = await harness.worker.execute(
    claimedJob({ error_code: "ANALYSIS_MANUAL_RETRY_AUTHORIZED" })
  );

  assert.equal(result.status, "deferred");
  assert.equal(harness.calls.some(([name]) => name === "request"), false);
  assert.equal(
    harness.calls.find(([name]) => name === "defer")[2].preserveManualRetry,
    true
  );
});

test("prior started and usage-unknown attempts always block before reservation", async () => {
  for (const state of ["started", "usage_unknown"]) {
    const { worker, calls } = executionHarness({
      attempts: [
        {
          requestId: `budget-request-${state}`,
          jobId: "job-analysis-1",
          attemptNumber: 1,
          provider: "minimax",
          model: "MiniMax-M2.7",
          operation: "session_analysis",
          state,
        },
      ],
    });

    assert.equal((await worker.execute(claimedJob())).status, "blocked");
    assert.equal(
      calls.some(([name]) => name === "reserve"),
      false
    );
    assert.equal(
      calls.some(([name]) => name === "request"),
      false
    );
    if (state === "started") {
      assert.deepEqual(calls.find(([name]) => name === "usage_unknown")[1], {
        requestId: "budget-request-started",
        reasonCode: "process_recovery",
      });
    }
  }
});

test("an explicit manual retry may replace usage-unknown work only in no-limit mode", async () => {
  const attempt = {
    requestId: "budget-request-old",
    jobId: "job-analysis-1",
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    state: "usage_unknown",
  };
  const capped = executionHarness({ attempts: [attempt], budgetMode: "capped" });
  assert.equal(
    (
      await capped.worker.execute(
        claimedJob({ error_code: "ANALYSIS_MANUAL_RETRY_AUTHORIZED" })
      )
    ).status,
    "blocked"
  );
  assert.equal(capped.calls.some(([name]) => name === "request"), false);

  const unlimited = executionHarness({
    attempts: [attempt],
    budgetMode: "unlimited",
    reserveResult: {
      ok: true,
      requestId: "budget-request-1",
      attemptNumber: 2,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
  });
  assert.equal(
    (
      await unlimited.worker.execute(
        claimedJob({ error_code: "ANALYSIS_MANUAL_RETRY_AUTHORIZED" })
      )
    ).status,
    "applied"
  );
  assert.equal(unlimited.calls.filter(([name]) => name === "request").length, 1);
});

test("a prior reserved attempt is durably released before the next attempt", async () => {
  const { worker, calls } = executionHarness({
    attempts: [
      {
        requestId: "budget-request-old",
        jobId: "job-analysis-1",
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        state: "reserved",
      },
    ],
    reserveResult: {
      ok: true,
      requestId: "budget-request-1",
      attemptNumber: 2,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
  });

  assert.equal((await worker.execute(claimedJob())).status, "applied");
  assert.deepEqual(calls.find(([name]) => name === "release")[1], {
    requestId: "budget-request-old",
    reasonCode: "shutdown_before_transport",
  });
  assert.equal(
    calls.findIndex(([name]) => name === "release") <
      calls.findIndex(([name]) => name === "reserve"),
    true
  );
  assert.equal(calls.find(([name]) => name === "reserve")[1].requestId, "budget-request-1");
});

test("only fresh exact reserve and start transitions may invoke the client", async (t) => {
  const invalidTransitions = [
    {
      name: "replayed reservation",
      reserveResult: {
        ok: true,
        requestId: "budget-request-1",
        attemptNumber: 1,
        state: "reserved",
        reservedMicrousd: 100,
        replayed: true,
      },
    },
    {
      name: "wrong reservation request",
      reserveResult: {
        ok: true,
        requestId: "budget-request-other",
        attemptNumber: 1,
        state: "reserved",
        reservedMicrousd: 100,
        replayed: false,
      },
    },
    {
      name: "wrong reservation attempt",
      reserveResult: {
        ok: true,
        requestId: "budget-request-1",
        attemptNumber: 2,
        state: "reserved",
        reservedMicrousd: 100,
        replayed: false,
      },
    },
    {
      name: "non-reserved reservation",
      reserveResult: {
        ok: true,
        requestId: "budget-request-1",
        attemptNumber: 1,
        state: "started",
        reservedMicrousd: 100,
        replayed: false,
      },
    },
    {
      name: "replayed start",
      markStartedResult: {
        ok: true,
        requestId: "budget-request-1",
        state: "started",
        replayed: true,
      },
    },
    {
      name: "wrong start request",
      markStartedResult: {
        ok: true,
        requestId: "budget-request-other",
        state: "started",
        replayed: false,
      },
    },
    {
      name: "non-started transition",
      markStartedResult: {
        ok: true,
        requestId: "budget-request-1",
        state: "reserved",
        replayed: false,
      },
    },
  ];

  for (const scenario of invalidTransitions) {
    await t.test(scenario.name, async () => {
      const { worker, calls } = executionHarness(scenario);
      await assert.rejects(worker.execute(claimedJob()), {
        code: "ANALYSIS_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(
        calls.some(([name]) => name === "request"),
        false
      );
    });
  }
});

test("started timeout becomes usage-unknown and a restart never resends it", async () => {
  const timeout = new Error("request timed out");
  const first = executionHarness({ clientError: timeout });

  assert.deepEqual(await first.worker.execute(claimedJob()), {
    status: "blocked",
    reason: "usage_unknown",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(first.calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "budget-request-1",
    reasonCode: "transport_ambiguous",
  });
  assert.equal(first.calls.filter(([name]) => name === "request").length, 1);

  const restart = executionHarness({
    attempts: [
      {
        requestId: "budget-request-1",
        jobId: "job-analysis-1",
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        state: "usage_unknown",
      },
    ],
  });
  assert.deepEqual(await restart.worker.execute(claimedJob()), {
    status: "blocked",
    reason: "usage_unknown",
    jobId: "job-analysis-1",
  });
  assert.equal(
    restart.calls.some(([name]) => name === "reserve"),
    false
  );
  assert.equal(
    restart.calls.some(([name]) => name === "request"),
    false
  );
});

test("invalid response structure with authoritative usage reconciles then blocks", async () => {
  const { worker, calls } = executionHarness({
    response: clientResponse({ result: { schemaVersion: "jarvis-analysis-v2" } }),
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "blocked",
    reason: "invalid_response",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(calls.find(([name]) => name === "reconcile")[1], {
    requestId: "budget-request-1",
    usage: { inputTokens: 80, outputTokens: 40 },
  });
  assert.equal(
    calls.some(([name]) => name === "persist"),
    false
  );
  assert.equal(calls.find(([name]) => name === "block")[2].errorCode, "analysis_invalid_response");
});

test("a paid validated response blocks durably when local candidate application fails", async () => {
  const { worker, calls } = executionHarness({
    applyError: Object.assign(new Error("local merge failed"), { code: "MEMORY_MERGER_INVALID_INPUT" }),
  });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "blocked",
    reason: "candidate_apply_failed",
    jobId: "job-analysis-1",
  });
  assert.equal(calls.filter(([name]) => name === "request").length, 1);
  assert.equal(calls.filter(([name]) => name === "reconcile").length, 1);
  assert.equal(calls.filter(([name]) => name === "persist").length, 1);
  assert.equal(calls.some(([name]) => name === "complete"), false);
  assert.equal(calls.find(([name]) => name === "block")[2].errorCode, "analysis_candidate_apply_failed");
});

test("a head change after paid response reconciles cost but CAS causes no visible write", async () => {
  const { worker, calls } = executionHarness({ applyResult: { status: "superseded" } });

  assert.deepEqual(await worker.execute(claimedJob()), {
    status: "superseded",
    jobId: "job-analysis-1",
  });
  assert.equal(
    calls.some(([name]) => name === "reconcile"),
    true
  );
  assert.equal(
    calls.some(([name]) => name === "persist"),
    true
  );
  assert.equal(calls.filter(([name]) => name === "apply").length, 1);
  assert.equal(
    calls.findIndex(([name]) => name === "reconcile") <
      calls.findIndex(([name]) => name === "apply"),
    true
  );
  assert.equal(
    calls.some(([name]) => name === "complete"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "supersede"),
    true
  );
});

test("execution-device lease loss prevents client invocation and fences the started attempt", async () => {
  const { worker, calls } = executionHarness({ executionDeviceRecorded: false });

  await assert.rejects(worker.execute(claimedJob()), { code: "JOB_LEASE_LOST" });
  assert.equal(
    calls.some(([name]) => name === "request"),
    false
  );
  assert.deepEqual(calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "budget-request-1",
    reasonCode: "process_recovery",
  });
  assert.equal(
    calls.some(([name]) => name === "reconcile"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "persist"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "apply"),
    false
  );
});

test("execution-device persistence failure never starts an unjoined client request", async () => {
  const persistenceFailure = new Error("execution-device write failed");
  const { worker, calls } = executionHarness({ executionDeviceError: persistenceFailure });

  await assert.rejects(worker.execute(claimedJob()), persistenceFailure);
  assert.equal(calls.filter(([name]) => name === "request").length, 0);
  assert.deepEqual(calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "budget-request-1",
    reasonCode: "process_recovery",
  });
  assert.equal(
    calls.some(([name]) => name === "reconcile"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "persist"),
    false
  );
  assert.equal(
    calls.some(([name]) => name === "apply"),
    false
  );
});

test("authoritative zero usage reconciles and durably permits one new attempt", async () => {
  const zeroUsageFailure = Object.assign(new Error("not accepted"), {
    authoritativeUsage: { inputTokens: 0, outputTokens: 0 },
  });
  const first = executionHarness({ clientError: zeroUsageFailure });

  assert.deepEqual(await first.worker.execute(claimedJob()), {
    status: "deferred",
    reason: "authoritative_zero_usage",
    jobId: "job-analysis-1",
  });
  assert.deepEqual(first.calls.find(([name]) => name === "reconcile")[1], {
    requestId: "budget-request-1",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  assert.equal(
    first.calls.some(([name]) => name === "usage_unknown"),
    false
  );
  assert.equal(
    first.calls.find(([name]) => name === "defer")[2].reason,
    "analysis_authoritative_zero_usage"
  );

  const retry = executionHarness({
    attempts: [
      {
        requestId: "budget-request-1",
        jobId: "job-analysis-1",
        attemptNumber: 1,
        provider: "minimax",
        model: "MiniMax-M2.7",
        operation: "session_analysis",
        state: "reconciled",
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualMicrousd: 0,
      },
    ],
    reserveResult: {
      ok: true,
      requestId: "budget-request-1",
      attemptNumber: 2,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
  });
  assert.equal(
    (await retry.worker.execute(claimedJob({ blocked_reason: "stale-non-authority" }))).status,
    "applied"
  );
  assert.equal(retry.calls.filter(([name]) => name === "request").length, 1);
});

test("job reasons never override nonzero or unknown reconciled accounting", async () => {
  for (const accounting of [
    { actualInputTokens: 1, actualOutputTokens: 0, actualMicrousd: 1 },
    { actualInputTokens: null, actualOutputTokens: null, actualMicrousd: null },
  ]) {
    const { worker, calls } = executionHarness({
      attempts: [
        {
          requestId: "budget-request-paid",
          jobId: "job-analysis-1",
          attemptNumber: 1,
          provider: "minimax",
          model: "MiniMax-M2.7",
          operation: "session_analysis",
          state: "reconciled",
          ...accounting,
        },
      ],
      reserveResult: {
        ok: true,
        requestId: "budget-request-1",
        attemptNumber: 2,
        state: "reserved",
        reservedMicrousd: 100,
        replayed: false,
      },
    });

    assert.deepEqual(
      await worker.execute(claimedJob({ blocked_reason: "analysis_authoritative_zero_usage" })),
      {
        status: "blocked",
        reason: "reconciled_without_candidate",
        jobId: "job-analysis-1",
      }
    );
    assert.equal(
      calls.some(([name]) => name === "reserve"),
      false
    );
    assert.equal(
      calls.some(([name]) => name === "request"),
      false
    );
  }
});
