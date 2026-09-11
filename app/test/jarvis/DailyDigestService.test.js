const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_DAILY_DIGEST_REQUEST_BYTES,
  MAX_DAILY_DIGEST_RESPONSE_BYTES,
} = require("../../src/jarvis/main/DailyDigestContractLimits");

function loadService() {
  return require("../../src/jarvis/main/DailyDigestService");
}

function fixture(overrides = {}) {
  const calls = [];
  const state = {
    input: {
      status: "created",
      digestInputId: "digest-input-1",
      localDate: "2026-07-17",
      timezone: "Asia/Shanghai",
      sourceHash: "a".repeat(64),
      completeness: "final",
      cloudPayload: { private: true },
      inputWatermark: { private: true },
    },
    job: { id: "digest-job-1", state: "pending" },
    applyResult: {
      status: "applied",
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      digestId: "digest-1",
      revision: 1,
      sourceHash: "a".repeat(64),
    },
    completeResult: true,
    supersedeResult: true,
    recoveryCandidate: {
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      digestInputId: "digest-input-1",
      candidateState: "validated",
      jobState: "running",
      leaseOwner: "digest-worker",
      leaseExpiresAt: 9_000,
      budgetState: "reconciled",
    },
    ...overrides.state,
  };
  const memoryRepository = {
    createDailyDigestInput(input) {
      calls.push(["createDailyDigestInput", input]);
      return state.input;
    },
    getLatestDailyDigest(input) {
      calls.push(["getLatestDailyDigest", input]);
      return overrides.latest ?? null;
    },
    applyValidatedDailyDigestCandidate(input) {
      calls.push(["applyValidatedDailyDigestCandidate", input]);
      return state.applyResult;
    },
    getDailyDigestInput() {
      throw new Error("foundation calls must not load a cloud payload");
    },
    listRecoverableDailyDigestCandidates() {
      return [];
    },
    getRecoverableDailyDigestCandidateByJob(jobId) {
      calls.push(["getRecoverableDailyDigestCandidateByJob", jobId]);
      return state.recoveryCandidate?.jobId === jobId ? state.recoveryCandidate : null;
    },
    persistValidatedDailyDigestCandidate() {
      throw new Error("foundation calls must not persist a candidate");
    },
  };
  const store = {
    enqueueDailyDigestJob(input) {
      calls.push(["enqueueDailyDigestJob", input]);
      return state.job;
    },
    getDailyDigestJobByInput(digestInputId) {
      calls.push(["getDailyDigestJobByInput", digestInputId]);
      return state.job;
    },
    wakeDailyDigestJob(input) {
      calls.push(["wakeDailyDigestJob", input]);
      return { ...state.job, state: "pending" };
    },
    authorizeManualDailyDigestRetry(id, options) {
      calls.push(["authorizeManualDailyDigestRetry", id, options]);
      return overrides.manualRetryResult ?? null;
    },
    completeJob(jobId, input) {
      calls.push(["completeJob", jobId, input]);
      return state.completeResult;
    },
    deferJob() {
      throw new Error("foundation calls must not defer a job");
    },
    blockJob() {
      throw new Error("foundation calls must not block a job");
    },
    recordJobExecutionDevice() {
      throw new Error("foundation calls must not record an execution device");
    },
    supersedeDailyDigestJob() {
      calls.push(["supersedeDailyDigestJob", ...arguments]);
      return state.supersedeResult;
    },
  };
  const budgetGuard = {
    listAttemptDispositionsByJob: () => [],
    reserveNextAttempt: () => {
      throw new Error("foundation calls must not reserve budget");
    },
    markStarted: () => {
      throw new Error("foundation calls must not start budget");
    },
    reconcile: () => {
      throw new Error("foundation calls must not reconcile budget");
    },
    release: () => {
      throw new Error("foundation calls must not release budget");
    },
    markUsageUnknown: () => {
      throw new Error("foundation calls must not mark usage unknown");
    },
  };
  const client = {
    model: "MiniMax-M2.7",
    generate: async () => {
      throw new Error("foundation calls must not use the network");
    },
  };
  const DailyDigestService = loadService();
  const service = new DailyDigestService({
    memoryRepository,
    store,
    budgetGuard,
    client,
    admit: () => Object.freeze({ eligible: true, reason: null }),
    estimatedUsage: overrides.estimatedUsage ?? { inputTokens: 100, outputTokens: 100 },
    createRequestId: () => "digest-request-1",
    modelVersion: "MiniMax-M2.7",
    timezoneProvider: () => "Asia/Shanghai",
    now: () => 8_000,
    owner: "digest-worker",
  });
  return { service, calls, state, memoryRepository, store, budgetGuard, client };
}

test("constructor enforces the exact foundation dependency contract", () => {
  const DailyDigestService = loadService();
  const valid = fixture();
  assert.throws(
    () => new DailyDigestService({
      memoryRepository: valid.memoryRepository,
      store: valid.store,
      budgetGuard: valid.budgetGuard,
      client: valid.client,
      admit: () => Object.freeze({ eligible: true, reason: null }),
      estimatedUsage: { inputTokens: 1, outputTokens: 1 },
      createRequestId: () => "request-1",
      modelVersion: "MiniMax-M2.7",
      timezoneProvider: () => "UTC",
      now: () => 1,
      owner: "worker",
      extra: true,
    }),
    /exact|keys|dependency/i
  );
  assert.throws(
    () => new DailyDigestService({
      memoryRepository: valid.memoryRepository,
      store: valid.store,
      budgetGuard: valid.budgetGuard,
      client: { ...valid.client, model: "other-model" },
      admit: () => Object.freeze({ eligible: true, reason: null }),
      estimatedUsage: { inputTokens: 1, outputTokens: 1 },
      createRequestId: () => "request-1",
      modelVersion: "MiniMax-M2.7",
      timezoneProvider: () => "UTC",
      now: () => 1,
      owner: "worker",
    }),
    /client\.model|modelVersion/i
  );
});

test("prepare returns empty without enqueueing or leaking private input fields", () => {
  const { service, calls } = fixture({
    state: { input: { status: "empty", localDate: "2026-07-17", timezone: "Asia/Shanghai" } },
  });
  assert.deepEqual(service.prepare({ localDate: "2026-07-17" }), {
    status: "empty",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  });
  assert.deepEqual(calls, [
    [
      "createDailyDigestInput",
      { localDate: "2026-07-17", timezone: "Asia/Shanghai", modelVersion: "MiniMax-M2.7" },
    ],
  ]);
});

test("prepare enqueues one immutable source idempotently and never wakes ordinary work", () => {
  const { service, calls, state } = fixture();
  assert.deepEqual(service.prepare({ localDate: "2026-07-17" }), {
    status: "prepared",
    inputStatus: "created",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    digestInputId: "digest-input-1",
    sourceHash: "a".repeat(64),
    completeness: "final",
    jobId: "digest-job-1",
    jobState: "pending",
  });
  assert.deepEqual(calls[1], [
    "enqueueDailyDigestJob",
    {
      digestInputId: state.input.digestInputId,
      inputHash: state.input.sourceHash,
      inputVersion: 1,
      modelVersion: "MiniMax-M2.7",
    },
  ]);
  assert.equal(calls.some(([name]) => name === "wakeDailyDigestJob"), false);
  assert.equal(JSON.stringify(service.prepare({ localDate: "2026-07-17" })).includes("private"), false);
});

test("prepare reuses the same source identity and naturally advances when the source changes", () => {
  const { service, state } = fixture();
  const first = service.prepare({ localDate: "2026-07-17" });
  state.input = {
    ...state.input,
    status: "existing",
  };
  assert.deepEqual(service.prepare({ localDate: "2026-07-17" }), {
    ...first,
    inputStatus: "existing",
  });
  state.input = {
    ...state.input,
    status: "created",
    digestInputId: "digest-input-2",
    sourceHash: "b".repeat(64),
  };
  state.job = { id: "digest-job-2", state: "pending" };
  const changed = service.prepare({ localDate: "2026-07-17" });
  assert.equal(changed.digestInputId, "digest-input-2");
  assert.equal(changed.jobId, "digest-job-2");
  assert.equal(changed.sourceHash, "b".repeat(64));
});

test("getLatest delegates one trusted-timezone repository query", () => {
  const latest = { id: "digest-1", content: { summary: "safe" }, evidence: [] };
  const { service, calls } = fixture({ latest });
  assert.deepEqual(service.getLatest({ localDate: "2026-07-17" }), latest);
  assert.deepEqual(calls, [
    ["getLatestDailyDigest", { localDate: "2026-07-17", timezone: "Asia/Shanghai" }],
  ]);
});

test("regenerate wakes only pending or retry jobs for the current source", () => {
  for (const jobState of ["pending", "retry"]) {
    const { service, calls } = fixture({ state: { job: { id: `job-${jobState}`, state: jobState } } });
    const result = service.regenerate({ localDate: "2026-07-17" });
    assert.equal(result.status, "woken", jobState);
    assert.deepEqual(
      calls.filter(([name]) => name === "wakeDailyDigestJob"),
      [["wakeDailyDigestJob", { digestInputId: "digest-input-1", at: 8_000 }]],
      jobState
    );
  }
});

test("regenerate does not revive running blocked or terminal jobs", () => {
  for (const jobState of [
    "running",
    "blocked",
    "completed",
    "cancelled",
    "usage_unknown",
  ]) {
    const { service, calls } = fixture({ state: { job: { id: `job-${jobState}`, state: jobState } } });
    const result = service.regenerate({ localDate: "2026-07-17" });
    assert.equal(result.status, "unchanged", jobState);
    assert.equal(result.reason, `job_${jobState}`, jobState);
    assert.equal(calls.some(([name]) => name === "wakeDailyDigestJob"), false, jobState);
  }
});

test("regenerate authorizes a blocked digest only through the manual retry gate", () => {
  const { service, calls } = fixture({
    state: { job: { id: "job-blocked", state: "blocked" } },
    manualRetryResult: { id: "job-blocked", state: "retry" },
  });

  const result = service.regenerate({ localDate: "2026-07-17" });

  assert.equal(result.status, "woken");
  assert.equal(result.jobId, "job-blocked");
  assert.equal(result.jobState, "retry");
  assert.deepEqual(
    calls.filter(([name]) => name === "authorizeManualDailyDigestRetry"),
    [
      [
        "authorizeManualDailyDigestRetry",
        "job-blocked",
        { allowUsageUnknown: false, at: 8_000 },
      ],
    ]
  );
});

test("usage-unknown digest retry requires an explicit paid-retry acknowledgement", () => {
  const { service, calls } = fixture({
    state: { job: { id: "job-usage-unknown", state: "blocked" } },
    manualRetryResult: { id: "job-usage-unknown", state: "retry" },
  });

  const result = service.regenerate({
    localDate: "2026-07-17",
    allowUsageUnknown: true,
  });

  assert.equal(result.status, "woken");
  assert.deepEqual(
    calls.filter(([name]) => name === "authorizeManualDailyDigestRetry"),
    [
      [
        "authorizeManualDailyDigestRetry",
        "job-usage-unknown",
        { allowUsageUnknown: true, at: 8_000 },
      ],
    ]
  );
  assert.throws(
    () =>
      service.regenerate({
        localDate: "2026-07-17",
        allowUsageUnknown: "yes",
      }),
    /allowUsageUnknown.*boolean/i
  );
});

test("recoverCandidate applies every durable state without network and lease-fences its terminal transition", () => {
  for (const candidateState of ["validated", "applied", "superseded"]) {
    const appliedStatus = candidateState === "validated" ? "applied" :
      candidateState === "applied" ? "already_applied" : "superseded";
    const { service, calls } = fixture({
      state: {
        recoveryCandidate: {
          candidateId: "digest-candidate-1",
          jobId: "digest-job-1",
          digestInputId: "digest-input-1",
          candidateState,
          jobState: "running",
          leaseOwner: "digest-worker",
          leaseExpiresAt: 9_000,
          budgetState: "reconciled",
        },
        applyResult: {
          status: appliedStatus,
          candidateId: "digest-candidate-1",
          jobId: "digest-job-1",
        },
      },
    });
    assert.deepEqual(
      service.recoverCandidate({
        candidateId: "digest-candidate-1",
        jobId: "digest-job-1",
        candidateState,
        leaseOwner: "digest-worker",
      }),
      { status: appliedStatus, jobId: "digest-job-1", candidateId: "digest-candidate-1" },
      candidateState
    );
    const transition = candidateState === "superseded"
      ? [
        "supersedeDailyDigestJob",
        "digest-job-1",
        { owner: "digest-worker", at: 8_000 },
      ]
      : [
        "completeJob",
        "digest-job-1",
        { owner: "digest-worker", at: 8_000, executionDevice: "cloud" },
      ];
    assert.deepEqual(calls, [
      ["getRecoverableDailyDigestCandidateByJob", "digest-job-1"],
      [
        "applyValidatedDailyDigestCandidate",
        { candidateId: "digest-candidate-1", leaseOwner: "digest-worker" },
      ],
      transition,
    ]);
  }
});

test("recoverCandidate preserves a terminal candidate when completion loses the lease", () => {
  const { service, calls } = fixture({ state: { completeResult: false } });
  assert.throws(
    () => service.recoverCandidate({
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      candidateState: "validated",
      leaseOwner: "digest-worker",
    }),
    { code: "JOB_LEASE_LOST" }
  );
  assert.equal(calls[0][0], "getRecoverableDailyDigestCandidateByJob");
  assert.equal(calls[1][0], "applyValidatedDailyDigestCandidate");
  assert.equal(calls[2][0], "completeJob");
});

test("recoverCandidate never completes a caller-supplied job that differs from candidate lineage", () => {
  const DailyDigestService = loadService();
  const jobs = new Map([
    ["real-digest-job", { state: "running", owner: "digest-worker" }],
    ["forged-digest-job", { state: "running", owner: "digest-worker" }],
  ]);
  const completed = [];
  let visibleWrites = 0;
  const service = new DailyDigestService({
    memoryRepository: {
      createDailyDigestInput: () => ({ status: "empty" }),
      getLatestDailyDigest: () => null,
      applyValidatedDailyDigestCandidate: () => {
        visibleWrites += 1;
        return {
          status: "already_applied",
          candidateId: "digest-candidate-1",
          jobId: "real-digest-job",
        };
      },
      getDailyDigestInput: () => null,
      listRecoverableDailyDigestCandidates: () => [],
      getRecoverableDailyDigestCandidateByJob: () => null,
      persistValidatedDailyDigestCandidate: () => null,
    },
    store: {
      enqueueDailyDigestJob: () => null,
      wakeDailyDigestJob: () => null,
      authorizeManualDailyDigestRetry: () => null,
      completeJob(jobId) {
        completed.push(jobId);
        jobs.get(jobId).state = "completed";
        return true;
      },
      deferJob: () => true,
      blockJob: () => true,
      recordJobExecutionDevice: () => true,
      supersedeDailyDigestJob: () => true,
    },
    budgetGuard: {
      listAttemptDispositionsByJob: () => [],
      reserveNextAttempt: () => ({ ok: false, reason: "not_used" }),
      markStarted: () => ({ ok: false }),
      reconcile: () => ({ ok: false }),
      release: () => ({ ok: false }),
      markUsageUnknown: () => ({ ok: false }),
    },
    client: {
      model: "MiniMax-M2.7",
      generate: async () => { throw new Error("network not expected"); },
    },
    admit: () => Object.freeze({ eligible: true, reason: null }),
    estimatedUsage: { inputTokens: 1, outputTokens: 1 },
    createRequestId: () => "request-1",
    modelVersion: "MiniMax-M2.7",
    timezoneProvider: () => "Asia/Shanghai",
    now: () => 8_000,
    owner: "digest-worker",
  });
  assert.throws(
    () => service.recoverCandidate({
      candidateId: "digest-candidate-1",
      jobId: "forged-digest-job",
      candidateState: "applied",
      leaseOwner: "digest-worker",
    }),
    { code: "DAILY_DIGEST_CANDIDATE_JOB_MISMATCH" }
  );
  assert.deepEqual(completed, []);
  assert.equal(visibleWrites, 0);
  assert.deepEqual([...jobs.values()].map((job) => job.state), ["running", "running"]);
});

test("recoverCandidate never transitions a different candidate on the same job", () => {
  const { service, calls, state } = fixture();
  state.recoveryCandidate = {
    ...state.recoveryCandidate,
    candidateId: "other-candidate",
  };
  assert.throws(
    () => service.recoverCandidate({
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      candidateState: "applied",
      leaseOwner: "digest-worker",
    }),
    { code: "DAILY_DIGEST_CANDIDATE_ID_MISMATCH" }
  );
  assert.deepEqual(calls.map(([name]) => name), ["getRecoverableDailyDigestCandidateByJob"]);
});

test("public service methods reject unknown caller-controlled fields", () => {
  const { service } = fixture();
  for (const invoke of [
    () => service.prepare({ localDate: "2026-07-17", timezone: "UTC" }),
    () => service.getLatest({ localDate: "2026-07-17", timezone: "UTC" }),
    () => service.regenerate({ localDate: "2026-07-17", force: true }),
    () => service.recoverCandidate({
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      candidateState: "validated",
      leaseOwner: "digest-worker",
      candidate: {},
    }),
  ]) {
    assert.throws(invoke, /exact|keys/i);
  }
});

const SOURCE_HASH = "d".repeat(64);

function durableDigestInput(overrides = {}) {
  const cloudPayload = {
    schemaVersion: "jarvis-daily-digest-input-v1",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    completeness: "final",
    sections: { transcriptCoverage: [], interactions: [] },
  };
  const cloudPayloadJson = JSON.stringify(cloudPayload);
  return {
    status: "existing",
    digestInputId: "digest-input-1",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    sourceHash: SOURCE_HASH,
    contractVersion: "jarvis-daily-digest-input-v1",
    completeness: "final",
    inputWatermark: { sessionIds: ["session-1"] },
    inputWatermarkJson: JSON.stringify({ sessionIds: ["session-1"] }),
    cloudPayload,
    cloudPayloadJson,
    inputBytes: Buffer.byteLength(cloudPayloadJson, "utf8"),
    modelVersion: "MiniMax-M2.7",
    createdAt: 100,
    ...overrides,
  };
}

function claimedDigestJob(overrides = {}) {
  return {
    id: "digest-job-1",
    job_type: "generate_daily_digest",
    lane: "cloud",
    state: "running",
    digest_input_id: "digest-input-1",
    input_hash: SOURCE_HASH,
    input_version: 1,
    model_version: "MiniMax-M2.7",
    lease_owner: "digest-worker",
    lease_expires_at: 1_000,
    session_id: null,
    track_id: null,
    chunk_id: null,
    analysis_input_id: null,
    desired_head_hash: null,
    ...overrides,
  };
}

function budgetAttempt(state, overrides = {}) {
  const mapping = {
    reserved: ["reserved_not_started", "release_and_retry"],
    started: ["started_unreconciled", "mark_usage_unknown"],
    reconciled: ["reconciled", "none"],
    released: ["released", "retry_with_new_attempt"],
    usage_unknown: ["usage_unknown", "block_for_period"],
  };
  const [disposition, startupAction] = mapping[state];
  const finalized = ["reconciled", "released", "usage_unknown"].includes(state);
  return {
    requestId: `old-${state}`,
    jobId: "digest-job-1",
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "daily_digest",
    state,
    disposition,
    startupAction,
    reasonCode: state === "released" ? "shutdown_before_transport" :
      state === "usage_unknown" ? "transport_ambiguous" : null,
    actualInputTokens: state === "reconciled" ? 0 : null,
    actualOutputTokens: state === "reconciled" ? 0 : null,
    actualMicrousd: state === "reconciled" ? 0 : null,
    createdAt: 100,
    startedAt: ["started", "reconciled", "usage_unknown"].includes(state) ? 110 : null,
    finalizedAt: finalized ? 120 : null,
    ...overrides,
  };
}

function clientResponse(overrides = {}) {
  return {
    result: { schemaVersion: "jarvis-daily-digest-v1", sections: {} },
    usage: { inputTokens: 80, outputTokens: 40 },
    requestBytes: 1_024,
    responseBytes: 512,
    ...overrides,
  };
}

function executionFixture(options = {}) {
  const calls = [];
  const state = {
    inputs: options.inputs ?? [durableDigestInput(), durableDigestInput()],
    currentInputs: options.currentInputs ?? [durableDigestInput(), durableDigestInput()],
    currentInputIndex: 0,
    inputIndex: 0,
    candidates: options.candidates ?? [],
    attempts: options.attempts ?? [],
    admission: options.admission ?? [
      Object.freeze({ eligible: true, reason: null }),
      Object.freeze({ eligible: true, reason: null }),
    ],
    admissionIndex: 0,
    reservation: options.reservation ?? {
      ok: true,
      requestId: "digest-request-1",
      attemptNumber: (options.attempts?.at(-1)?.attemptNumber ?? 0) + 1,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
    markStarted: options.markStarted ?? {
      ok: true,
      requestId: "digest-request-1",
      state: "started",
      replayed: false,
    },
    reconcileResult: options.reconcileResult ?? null,
    releaseResult: options.releaseResult ?? null,
    usageUnknownResult: options.usageUnknownResult ?? null,
    response: options.response ?? clientResponse(),
    persistResult: options.persistResult ?? {
      status: "created",
      candidateId: "digest-candidate-1",
      candidateHash: "e".repeat(64),
      state: "validated",
    },
    applyResult: options.applyResult ?? {
      status: "applied",
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
      digestId: "digest-1",
      revision: 1,
      sourceHash: SOURCE_HASH,
    },
    completeResult: options.completeResult ?? true,
    recordDeviceResult: options.recordDeviceResult ?? true,
  };
  const memoryRepository = {
    createDailyDigestInput(input) {
      calls.push(["rebuild_input", input]);
      if (options.currentInputErrorAt === state.currentInputIndex) {
        state.currentInputIndex += 1;
        throw options.currentInputError ?? Object.assign(new Error("evidence out of scope"), {
          code: "DAILY_DIGEST_EVIDENCE_OUT_OF_SCOPE",
        });
      }
      const current = state.currentInputs[
        Math.min(state.currentInputIndex, state.currentInputs.length - 1)
      ];
      state.currentInputIndex += 1;
      return current;
    },
    getLatestDailyDigest: () => null,
    getDailyDigestInput(id) {
      calls.push(["load_input", id]);
      if (options.inputErrorAt === state.inputIndex) {
        state.inputIndex += 1;
        throw options.inputError ?? Object.assign(new Error("input corrupt"), {
          code: "DAILY_DIGEST_INPUT_CORRUPT",
        });
      }
      const input = state.inputs[Math.min(state.inputIndex, state.inputs.length - 1)];
      state.inputIndex += 1;
      return input;
    },
    listRecoverableDailyDigestCandidates(input) {
      calls.push(["load_candidates", input]);
      return state.candidates.slice(0, 100);
    },
    getRecoverableDailyDigestCandidateByJob(jobId) {
      calls.push(["load_candidate", jobId]);
      return state.candidates.find((candidate) => candidate.jobId === jobId) ?? null;
    },
    persistValidatedDailyDigestCandidate(input) {
      calls.push(["persist", input]);
      if (options.persistError) throw options.persistError;
      options.onPersist?.(state, input);
      return state.persistResult;
    },
    applyValidatedDailyDigestCandidate(input) {
      calls.push(["apply", input]);
      if (options.applyError) throw options.applyError;
      options.onApply?.(state, input);
      return state.applyResult;
    },
  };
  const store = {
    enqueueDailyDigestJob(input) {
      calls.push(["enqueue_current", input]);
      return { id: "digest-job-current", state: "pending" };
    },
    wakeDailyDigestJob: () => null,
    authorizeManualDailyDigestRetry: () => null,
    completeJob(jobId, input) {
      calls.push(["complete", jobId, input]);
      return state.completeResult;
    },
    deferJob(jobId, input) {
      calls.push(["defer", jobId, input]);
      return options.deferResult ?? true;
    },
    blockJob(jobId, input) {
      calls.push(["block", jobId, input]);
      return options.blockResult ?? true;
    },
    recordJobExecutionDevice(jobId, input) {
      calls.push(["execution_device", jobId, input]);
      if (options.recordDeviceError) throw options.recordDeviceError;
      return state.recordDeviceResult;
    },
    supersedeDailyDigestJob(jobId, input) {
      calls.push(["supersede", jobId, input]);
      return options.supersedeResult ?? true;
    },
  };
  const budgetGuard = {
    getStatus() {
      return { mode: options.budgetMode ?? "capped" };
    },
    listAttemptDispositionsByJob(input) {
      calls.push(["load_attempts", input]);
      return state.attempts;
    },
    reserveNextAttempt(input) {
      calls.push(["reserve", input]);
      options.onReserve?.(state, input);
      return state.reservation;
    },
    markStarted(requestId) {
      calls.push(["mark_started", requestId]);
      return state.markStarted;
    },
    reconcile(input) {
      calls.push(["reconcile", input]);
      options.onReconcile?.(state, input);
      return state.reconcileResult ?? {
        ok: true,
        requestId: input.requestId,
        state: "reconciled",
      };
    },
    release(input) {
      calls.push(["release", input]);
      return state.releaseResult ?? { ok: true, requestId: input.requestId, state: "released" };
    },
    markUsageUnknown(input) {
      calls.push(["usage_unknown", input]);
      options.onUsageUnknown?.(state, input);
      return state.usageUnknownResult ?? {
        ok: true,
        requestId: input.requestId,
        state: "usage_unknown",
      };
    },
  };
  const client = {
    model: "MiniMax-M2.7",
    async generate(input) {
      calls.push(["request", input]);
      if (options.clientError) throw options.clientError;
      return state.response;
    },
  };
  const DailyDigestService = loadService();
  const service = new DailyDigestService({
    memoryRepository,
    store,
    budgetGuard,
    client,
    admit(job, input) {
      calls.push(["admit", job.id, input.digestInputId]);
      const decision = state.admission[
        Math.min(state.admissionIndex, state.admission.length - 1)
      ];
      state.admissionIndex += 1;
      return decision;
    },
    estimatedUsage: options.estimatedUsage ?? { inputTokens: 100, outputTokens: 100 },
    createRequestId: () => "digest-request-1",
    modelVersion: "MiniMax-M2.7",
    timezoneProvider: () => "Asia/Shanghai",
    now: () => 200,
    owner: "digest-worker",
  });
  return { service, calls, state, memoryRepository, store, budgetGuard, client };
}

test("execute follows the exact durable happy-path order and sends one bounded client request", async () => {
  const { service, calls } = executionFixture();
  assert.deepEqual(await service.execute(claimedDigestJob()), {
    status: "applied",
    jobId: "digest-job-1",
  });
  assert.deepEqual(calls.map(([name]) => name), [
    "load_input",
    "load_candidate",
    "load_attempts",
    "rebuild_input",
    "admit",
    "reserve",
    "load_input",
    "rebuild_input",
    "admit",
    "mark_started",
    "execution_device",
    "request",
    "reconcile",
    "persist",
    "apply",
    "complete",
  ]);
  assert.deepEqual(calls.find(([name]) => name === "request")[1], {
    cloudPayloadJson: durableDigestInput().cloudPayloadJson,
    inputHash: SOURCE_HASH,
  });
  assert.equal(calls.filter(([name]) => name === "request").length, 1);
  assert.deepEqual(calls.find(([name]) => name === "reserve")[1], {
    requestId: "digest-request-1",
    jobId: "digest-job-1",
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "daily_digest",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
  });
});

test("execute rejects every wrong job, model, lease, and nullable identity before durable reads", async (t) => {
  const cases = [
    ["job type", { job_type: "analyze_session" }],
    ["lane", { lane: "local" }],
    ["state", { state: "pending" }],
    ["hash", { input_hash: "not-a-hash" }],
    ["version", { input_version: 2 }],
    ["model", { model_version: "other-model" }],
    ["owner", { lease_owner: "other-worker" }],
    ["expired", { lease_expires_at: 200 }],
    ["session", { session_id: "session-1" }],
    ["track", { track_id: "track-1" }],
    ["chunk", { chunk_id: "chunk-1" }],
    ["analysis input", { analysis_input_id: "analysis-input-1" }],
    ["desired head", { desired_head_hash: "a".repeat(64) }],
    ["digest input", { digest_input_id: null }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const { service, calls } = executionFixture();
      await assert.rejects(service.execute(claimedDigestJob(override)), {
        code: "DAILY_DIGEST_JOB_CONTRACT_INVALID",
      });
      assert.deepEqual(calls, []);
    });
  }
});

test("execute binds the exact immutable input before admission and releases a changed reload", async () => {
  for (const input of [
    durableDigestInput({ digestInputId: "other-input" }),
    durableDigestInput({ sourceHash: "f".repeat(64) }),
    durableDigestInput({ contractVersion: "future-contract" }),
  ]) {
    const { service, calls } = executionFixture({ inputs: [input] });
    await assert.rejects(service.execute(claimedDigestJob()), {
      code: "DAILY_DIGEST_INPUT_CONTRACT_INVALID",
    });
    assert.equal(calls.some(([name]) => name === "admit"), false);
    assert.equal(calls.some(([name]) => name === "reserve"), false);
  }

  const changed = executionFixture({
    inputs: [durableDigestInput(), durableDigestInput({ sourceHash: "f".repeat(64) })],
  });
  await assert.rejects(changed.service.execute(claimedDigestJob()), {
    code: "DAILY_DIGEST_INPUT_CONTRACT_INVALID",
  });
  assert.deepEqual(changed.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(changed.calls.some(([name]) => name === "request"), false);

  const corrupt = executionFixture({ inputErrorAt: 1 });
  await assert.rejects(corrupt.service.execute(claimedDigestJob()), {
    code: "DAILY_DIGEST_INPUT_CORRUPT",
  });
  assert.deepEqual(corrupt.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(corrupt.calls.some(([name]) => name === "request"), false);
});

test("execute rebuilds the live source on both sides of reserve and supersedes stale work", async () => {
  const newer = durableDigestInput({
    status: "created",
    digestInputId: "digest-input-2",
    sourceHash: "f".repeat(64),
    completeness: "final",
  });
  const preStart = executionFixture({ currentInputs: [newer] });
  assert.deepEqual(await preStart.service.execute(claimedDigestJob()), {
    status: "superseded",
    jobId: "digest-job-1",
  });
  assert.deepEqual(preStart.calls.find(([name]) => name === "rebuild_input")[1], {
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  assert.deepEqual(preStart.calls.find(([name]) => name === "enqueue_current")[1], {
    digestInputId: "digest-input-2",
    inputHash: "f".repeat(64),
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  assert.deepEqual(preStart.calls.find(([name]) => name === "supersede").slice(1), [
    "digest-job-1",
    { owner: "digest-worker", at: 200 },
  ]);
  assert.equal(preStart.calls.some(([name]) => name === "reserve"), false);
  assert.equal(preStart.calls.some(([name]) => name === "request"), false);

  const postReserve = executionFixture({
    currentInputs: [durableDigestInput(), newer],
  });
  assert.deepEqual(await postReserve.service.execute(claimedDigestJob()), {
    status: "superseded",
    jobId: "digest-job-1",
  });
  assert.equal(postReserve.calls.filter(([name]) => name === "rebuild_input").length, 2);
  assert.deepEqual(postReserve.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(
    postReserve.calls.findIndex(([name]) => name === "release") <
      postReserve.calls.findIndex(([name]) => name === "supersede"),
    true
  );
  assert.equal(postReserve.calls.some(([name]) => name === "mark_started"), false);
  assert.equal(postReserve.calls.some(([name]) => name === "request"), false);
});

test("deterministic digest evidence boundary failures block once instead of retaining the cloud lease", async () => {
  const preReserve = executionFixture({ currentInputErrorAt: 0 });
  assert.deepEqual(await preReserve.service.execute(claimedDigestJob()), {
    status: "blocked",
    jobId: "digest-job-1",
  });
  assert.deepEqual(preReserve.calls.find(([name]) => name === "block").slice(1), [
    "digest-job-1",
    {
      owner: "digest-worker",
      at: 200,
      errorCode: "daily_digest_evidence_out_of_scope",
    },
  ]);
  assert.equal(preReserve.calls.some(([name]) => name === "reserve"), false);

  const postReserve = executionFixture({ currentInputErrorAt: 1 });
  assert.deepEqual(await postReserve.service.execute(claimedDigestJob()), {
    status: "blocked",
    jobId: "digest-job-1",
  });
  assert.deepEqual(postReserve.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(postReserve.calls.some(([name]) => name === "request"), false);
});

test("execute supersedes an empty live source before or after reserve without enqueue or network", async () => {
  const empty = {
    status: "empty",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  };
  const preReserve = executionFixture({ currentInputs: [empty] });
  assert.deepEqual(await preReserve.service.execute(claimedDigestJob()), {
    status: "superseded",
    jobId: "digest-job-1",
  });
  assert.equal(preReserve.calls.some(([name]) => name === "enqueue_current"), false);
  assert.equal(preReserve.calls.some(([name]) => name === "reserve"), false);
  assert.equal(preReserve.calls.some(([name]) => name === "request"), false);
  assert.equal(preReserve.calls.some(([name]) => name === "supersede"), true);

  const postReserve = executionFixture({
    currentInputs: [durableDigestInput(), empty],
  });
  assert.deepEqual(await postReserve.service.execute(claimedDigestJob()), {
    status: "superseded",
    jobId: "digest-job-1",
  });
  assert.deepEqual(postReserve.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "superseded_before_transport",
  });
  assert.equal(postReserve.calls.some(([name]) => name === "enqueue_current"), false);
  assert.equal(postReserve.calls.some(([name]) => name === "mark_started"), false);
  assert.equal(postReserve.calls.some(([name]) => name === "request"), false);
  assert.equal(postReserve.calls.some(([name]) => name === "supersede"), true);
});

test("execute recovers a matching candidate before any prior-attempt action or network", async () => {
  const candidate = {
    candidateId: "digest-candidate-1",
    jobId: "digest-job-1",
    digestInputId: "digest-input-1",
    candidateState: "validated",
    jobState: "running",
    leaseOwner: "digest-worker",
    leaseExpiresAt: 1_000,
    budgetState: "reconciled",
  };
  const distractors = Array.from({ length: 101 }, (_, index) => ({
    ...candidate,
    candidateId: `distractor-${index}`,
    jobId: `distractor-job-${index}`,
    digestInputId: `distractor-input-${index}`,
    leaseOwner: null,
    leaseExpiresAt: null,
  }));
  const { service, calls } = executionFixture({
    candidates: [...distractors, candidate],
    attempts: [budgetAttempt("usage_unknown")],
  });
  assert.deepEqual(await service.execute(claimedDigestJob()), {
    status: "applied",
    jobId: "digest-job-1",
    candidateId: "digest-candidate-1",
  });
  assert.equal(calls.some(([name]) => name === "reserve"), false);
  assert.equal(calls.some(([name]) => name === "usage_unknown"), false);
  assert.equal(calls.some(([name]) => name === "request"), false);
  assert.equal(calls.some(([name]) => name === "admit"), false);
  assert.deepEqual(calls.filter(([name]) => name === "load_candidate"), [
    ["load_candidate", "digest-job-1"],
    ["load_candidate", "digest-job-1"],
  ]);
  assert.equal(calls.some(([name]) => name === "load_candidates"), false);
});

test("execute permits a current-model job to reuse immutable input created under an older model", async () => {
  const legacyInput = durableDigestInput({ modelVersion: "MiniMax-M2.5" });
  const { service, calls } = executionFixture({
    inputs: [legacyInput, legacyInput],
    currentInputs: [legacyInput, legacyInput],
  });
  assert.deepEqual(await service.execute(claimedDigestJob()), {
    status: "applied",
    jobId: "digest-job-1",
  });
  assert.equal(calls.find(([name]) => name === "reserve")[1].model, "MiniMax-M2.7");
  assert.equal(calls.filter(([name]) => name === "request").length, 1);
});

test("execute applies every exact prior-attempt disposition without accidental resend", async (t) => {
  for (const state of ["reserved", "started", "usage_unknown", "reconciled", "released"]) {
    await t.test(state, async () => {
      const overrides = state === "reconciled" ? {} : undefined;
      const { service, calls } = executionFixture({ attempts: [budgetAttempt(state, overrides)] });
      const result = await service.execute(claimedDigestJob());
      if (["started", "usage_unknown"].includes(state)) {
        assert.deepEqual(result, {
          status: "blocked",
          reason: "usage_unknown",
          jobId: "digest-job-1",
        });
        assert.equal(calls.some(([name]) => name === "request"), false);
        if (state === "started") {
          assert.deepEqual(calls.find(([name]) => name === "usage_unknown")[1], {
            requestId: "old-started",
            reasonCode: "process_recovery",
          });
        }
        return;
      }
      assert.equal(result.status, "applied");
      assert.equal(calls.filter(([name]) => name === "request").length, 1);
      if (state === "reserved") {
        assert.deepEqual(calls.find(([name]) => name === "release")[1], {
          requestId: "old-reserved",
          reasonCode: "shutdown_before_transport",
        });
      }
    });
  }

  const nonzero = executionFixture({
    attempts: [budgetAttempt("reconciled", {
      actualInputTokens: 10,
      actualOutputTokens: 1,
      actualMicrousd: 5,
    })],
  });
  assert.deepEqual(await nonzero.service.execute(claimedDigestJob()), {
    status: "blocked",
    reason: "reconciled_without_candidate",
    jobId: "digest-job-1",
  });
  assert.equal(nonzero.calls.some(([name]) => name === "request"), false);

  const malformed = executionFixture({
    attempts: [budgetAttempt("released", { disposition: "reconciled" })],
  });
  await assert.rejects(malformed.service.execute(claimedDigestJob()), {
    code: "DAILY_DIGEST_DURABLE_STATE_INVALID",
  });
  assert.equal(malformed.calls.some(([name]) => name === "request"), false);
});

test("manual usage-unknown retry sends one new request only in unlimited mode", async () => {
  const previousAttempt = budgetAttempt("usage_unknown");
  const authorizedJob = claimedDigestJob({
    error_code: "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED",
  });
  const unlimited = executionFixture({
    attempts: [previousAttempt],
    budgetMode: "unlimited",
  });

  assert.deepEqual(await unlimited.service.execute(authorizedJob), {
    status: "applied",
    jobId: "digest-job-1",
  });
  assert.equal(unlimited.calls.filter(([name]) => name === "request").length, 1);
  assert.equal(unlimited.state.reservation.attemptNumber, 2);

  const capped = executionFixture({
    attempts: [previousAttempt],
    budgetMode: "capped",
  });
  assert.deepEqual(await capped.service.execute(authorizedJob), {
    status: "blocked",
    reason: "usage_unknown",
    jobId: "digest-job-1",
  });
  assert.equal(capped.calls.some(([name]) => name === "request"), false);
});

test("manual retry authorization survives resource deferral before transport", async () => {
  const deferred = executionFixture({
    attempts: [budgetAttempt("usage_unknown")],
    budgetMode: "unlimited",
    admission: [Object.freeze({ eligible: false, reason: "external_gpu_busy" })],
  });

  assert.deepEqual(
    await deferred.service.execute(
      claimedDigestJob({
        error_code: "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED",
      })
    ),
    {
      status: "deferred",
      reason: "external_gpu_busy",
      jobId: "digest-job-1",
    }
  );
  assert.equal(deferred.calls.some(([name]) => name === "request"), false);
  assert.equal(
    deferred.calls.find(([name]) => name === "defer")[2].preserveManualRetry,
    true
  );
});

test("execute performs two exact frozen admission checks and keeps pre-start denial free", async () => {
  const offline = executionFixture({
    admission: [Object.freeze({ eligible: false, reason: "offline" })],
  });
  assert.deepEqual(await offline.service.execute(claimedDigestJob()), {
    status: "deferred",
    reason: "offline",
    jobId: "digest-job-1",
  });
  assert.equal(offline.calls.some(([name]) => name === "reserve"), false);
  assert.equal(offline.calls.some(([name]) => name === "mark_started"), false);
  assert.equal(offline.calls.some(([name]) => name === "request"), false);

  const revoked = executionFixture({
    admission: [
      Object.freeze({ eligible: true, reason: null }),
      Object.freeze({ eligible: false, reason: "local_pressure" }),
    ],
  });
  assert.deepEqual(await revoked.service.execute(claimedDigestJob()), {
    status: "deferred",
    reason: "local_pressure",
    jobId: "digest-job-1",
  });
  assert.deepEqual(revoked.calls.find(([name]) => name === "release")[1], {
    requestId: "digest-request-1",
    reasonCode: "admission_revoked",
  });
  assert.equal(revoked.calls.filter(([name]) => name === "admit").length, 2);
  assert.equal(revoked.calls.some(([name]) => name === "mark_started"), false);
  assert.equal(revoked.calls.some(([name]) => name === "request"), false);

  for (const decision of [
    { eligible: true, reason: null },
    Object.freeze({ eligible: true, reason: null, extra: true }),
    Promise.resolve(Object.freeze({ eligible: true, reason: null })),
  ]) {
    const invalid = executionFixture({ admission: [decision] });
    await assert.rejects(invalid.service.execute(claimedDigestJob()), {
      code: "DAILY_DIGEST_ADMISSION_INVALID",
    });
    assert.equal(invalid.calls.some(([name]) => name === "reserve"), false);
  }
});

test("Task5C must adapt three-key policy decisions to the exact two-key digest admission contract", async () => {
  const unadapted = executionFixture({
    admission: [Object.freeze({ eligible: true, reason: null, priority: 80 })],
  });
  await assert.rejects(unadapted.service.execute(claimedDigestJob()), {
    code: "DAILY_DIGEST_ADMISSION_INVALID",
  });
  assert.equal(unadapted.calls.some(([name]) => name === "reserve"), false);

  const adapted = executionFixture({
    admission: [
      Object.freeze({ eligible: true, reason: null }),
      Object.freeze({ eligible: true, reason: null }),
    ],
  });
  assert.equal((await adapted.service.execute(claimedDigestJob())).status, "applied");
  assert.equal(adapted.calls.filter(([name]) => name === "admit").length, 2);
});

test("execute defers a denied reservation without start, budget use, or network", async () => {
  const { service, calls } = executionFixture({
    reservation: { ok: false, reason: "budget_exceeded" },
  });
  assert.deepEqual(await service.execute(claimedDigestJob()), {
    status: "deferred",
    reason: "budget_exceeded",
    jobId: "digest-job-1",
  });
  assert.equal(calls.some(([name]) => name === "mark_started"), false);
  assert.equal(calls.some(([name]) => name === "request"), false);
  assert.equal(calls.some(([name]) => name === "reconcile"), false);
});

test("execute allows only fresh exact reserve and start transitions to reach the client", async (t) => {
  const invalidReservations = [
    {
      ok: true,
      requestId: "digest-request-1",
      attemptNumber: 1,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: true,
    },
    {
      ok: true,
      requestId: "other-request",
      attemptNumber: 1,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
    {
      ok: true,
      requestId: "digest-request-1",
      attemptNumber: 2,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
    },
    {
      ok: true,
      requestId: "digest-request-1",
      attemptNumber: 1,
      state: "started",
      reservedMicrousd: 100,
      replayed: false,
    },
    {
      ok: true,
      requestId: "digest-request-1",
      attemptNumber: 1,
      state: "reserved",
      reservedMicrousd: 100,
      replayed: false,
      extra: true,
    },
  ];
  for (const [index, reservation] of invalidReservations.entries()) {
    await t.test(`reservation ${index + 1}`, async () => {
      const { service, calls } = executionFixture({ reservation });
      await assert.rejects(service.execute(claimedDigestJob()), {
        code: "DAILY_DIGEST_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(calls.some(([name]) => name === "request"), false);
    });
  }
  const invalidStarts = [
    { ok: true, requestId: "digest-request-1", state: "started", replayed: true },
    { ok: true, requestId: "other-request", state: "started", replayed: false },
    { ok: true, requestId: "digest-request-1", state: "reserved", replayed: false },
  ];
  for (const [index, markStarted] of invalidStarts.entries()) {
    await t.test(`start ${index + 1}`, async () => {
      const { service, calls } = executionFixture({ markStarted });
      await assert.rejects(service.execute(claimedDigestJob()), {
        code: "DAILY_DIGEST_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(calls.some(([name]) => name === "request"), false);
    });
  }
});

test("budget finalization transitions fail closed before the next lifecycle step", async (t) => {
  const invalid = (requestId, state) => [
    { ok: false, requestId, state },
    { ok: true, requestId: "wrong-request", state },
    { ok: true, requestId, state: "wrong-state" },
  ];
  for (const [index, reconcileResult] of invalid("digest-request-1", "reconciled").entries()) {
    await t.test(`reconcile ${index + 1}`, async () => {
      const { service, calls } = executionFixture({ reconcileResult });
      await assert.rejects(service.execute(claimedDigestJob()), {
        code: "DAILY_DIGEST_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(calls.some(([name]) => name === "persist"), false);
      assert.equal(calls.some(([name]) => name === "apply"), false);
      assert.equal(calls.some(([name]) => name === "complete"), false);
    });
  }
  for (const [index, releaseResult] of invalid("digest-request-1", "released").entries()) {
    await t.test(`release ${index + 1}`, async () => {
      const { service, calls } = executionFixture({
        releaseResult,
        admission: [
          Object.freeze({ eligible: true, reason: null }),
          Object.freeze({ eligible: false, reason: "local_pressure" }),
        ],
      });
      await assert.rejects(service.execute(claimedDigestJob()), {
        code: "DAILY_DIGEST_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(calls.some(([name]) => name === "defer"), false);
      assert.equal(calls.some(([name]) => name === "mark_started"), false);
      assert.equal(calls.some(([name]) => name === "request"), false);
    });
  }
  for (const [index, usageUnknownResult] of invalid(
    "digest-request-1",
    "usage_unknown"
  ).entries()) {
    await t.test(`usage unknown ${index + 1}`, async () => {
      const { service, calls } = executionFixture({
        usageUnknownResult,
        clientError: new Error("ambiguous transport"),
      });
      await assert.rejects(service.execute(claimedDigestJob()), {
        code: "DAILY_DIGEST_BUDGET_TRANSITION_INVALID",
      });
      assert.equal(calls.filter(([name]) => name === "request").length, 1);
      assert.equal(calls.some(([name]) => name === "block"), false);
    });
  }
});

test("execute classifies thrown client errors only from exact authoritative usage", async (t) => {
  const cases = [
    {
      name: "zero usage",
      usage: { inputTokens: 0, outputTokens: 0 },
      result: { status: "deferred", reason: "authoritative_zero_usage", jobId: "digest-job-1" },
      transition: "reconcile",
    },
    {
      name: "paid invalid response",
      usage: { inputTokens: 1, outputTokens: 0 },
      result: { status: "blocked", reason: "invalid_response", jobId: "digest-job-1" },
      transition: "reconcile",
    },
    {
      name: "missing usage",
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
    {
      name: "extra usage key",
      usage: { inputTokens: 1, outputTokens: 0, provider: "forged" },
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
    {
      name: "negative usage",
      usage: { inputTokens: -1, outputTokens: 0 },
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
    {
      name: "over-limit usage",
      usage: { inputTokens: 1_000_000_001, outputTokens: 0 },
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
    {
      name: "over-limit request bytes",
      usage: { inputTokens: 1, outputTokens: 0 },
      requestBytes: DEFAULT_DAILY_DIGEST_REQUEST_BYTES + 1,
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
    {
      name: "over-limit response bytes",
      usage: { inputTokens: 1, outputTokens: 0 },
      responseBytes: MAX_DAILY_DIGEST_RESPONSE_BYTES + 1,
      result: { status: "blocked", reason: "usage_unknown", jobId: "digest-job-1" },
      transition: "usage_unknown",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const error = Object.assign(new Error("client failure"),
        item.usage === undefined ? {} : {
          usage: item.usage,
          requestBytes: item.requestBytes ?? 100,
          responseBytes: item.responseBytes ?? 100,
        });
      const { service, calls } = executionFixture({ clientError: error });
      assert.deepEqual(await service.execute(claimedDigestJob()), item.result);
      assert.equal(calls.filter(([name]) => name === "request").length, 1);
      assert.equal(calls.some(([name]) => name === item.transition), true);
      if (item.transition === "usage_unknown") {
        assert.deepEqual(calls.find(([name]) => name === "usage_unknown")[1], {
          requestId: "digest-request-1",
          reasonCode: "transport_ambiguous",
        });
      }
    });
  }
});

test("constructor rejects estimated usage above the durable budget token ceiling", () => {
  assert.throws(
    () => executionFixture({
      estimatedUsage: { inputTokens: 1_000_000_001, outputTokens: 0 },
    }),
    /estimatedUsage|token/i
  );
});

test("execute requires the exact client response and reconciles any valid authoritative usage", async (t) => {
  const cases = [
    ["missing usage", { result: {}, requestBytes: 1, responseBytes: 1 }, "usage_unknown"],
    ["invalid usage", clientResponse({ usage: { inputTokens: 1.5, outputTokens: 0 } }), "usage_unknown"],
    ["extra response key", { ...clientResponse(), secret: true }, "invalid_response"],
    ["invalid request bytes", clientResponse({ requestBytes: 0 }), "invalid_response"],
    [
      "over-limit request bytes",
      clientResponse({ requestBytes: DEFAULT_DAILY_DIGEST_REQUEST_BYTES + 1 }),
      "usage_unknown",
    ],
    [
      "over-limit response bytes",
      clientResponse({ responseBytes: MAX_DAILY_DIGEST_RESPONSE_BYTES + 1 }),
      "usage_unknown",
    ],
    [
      "over-limit usage",
      clientResponse({ usage: { inputTokens: 1_000_000_001, outputTokens: 0 } }),
      "usage_unknown",
    ],
  ];
  for (const [name, response, reason] of cases) {
    await t.test(name, async () => {
      const { service, calls } = executionFixture({ response });
      assert.deepEqual(await service.execute(claimedDigestJob()), {
        status: "blocked",
        reason,
        jobId: "digest-job-1",
      });
      assert.equal(calls.some(([call]) => call === "persist"), false);
      if (reason === "usage_unknown") {
        assert.equal(calls.some(([call]) => call === "usage_unknown"), true);
      } else {
        assert.deepEqual(calls.find(([call]) => call === "reconcile")[1].usage, response.usage);
      }
    });
  }
});

test("execute validates persist and apply status plus candidate job lineage", async (t) => {
  const cases = [
    ["persist status", { persistResult: {
      status: "invalid", candidateId: "digest-candidate-1", candidateHash: "e".repeat(64),
      state: "validated",
    } }, "DAILY_DIGEST_CANDIDATE_PERSIST_INVALID"],
    ["persist state", { persistResult: {
      status: "created", candidateId: "digest-candidate-1", candidateHash: "e".repeat(64),
      state: "pending",
    } }, "DAILY_DIGEST_CANDIDATE_PERSIST_INVALID"],
    ["apply status", { applyResult: {
      status: "invalid", candidateId: "digest-candidate-1", jobId: "digest-job-1",
    } }, "DAILY_DIGEST_CANDIDATE_APPLY_INVALID"],
    ["apply lineage", { applyResult: {
      status: "applied", candidateId: "digest-candidate-1", jobId: "other-job",
    } }, "DAILY_DIGEST_CANDIDATE_JOB_MISMATCH"],
    ["apply candidate", { applyResult: {
      status: "applied", candidateId: "other-candidate", jobId: "digest-job-1",
    } }, "DAILY_DIGEST_CANDIDATE_ID_MISMATCH"],
  ];
  for (const [name, options, code] of cases) {
    await t.test(name, async () => {
      const { service, calls } = executionFixture(options);
      await assert.rejects(service.execute(claimedDigestJob()), { code });
      assert.equal(calls.some(([call]) => call === "complete"), false);
      assert.equal(calls.some(([call]) => call === "supersede"), false);
    });
  }

  const superseded = executionFixture({ applyResult: {
    status: "superseded",
    candidateId: "digest-candidate-1",
    jobId: "digest-job-1",
    digestInputId: "digest-input-1",
  } });
  assert.deepEqual(await superseded.service.execute(claimedDigestJob()), {
    status: "superseded",
    jobId: "digest-job-1",
  });
  assert.equal(superseded.calls.some(([name]) => name === "complete"), false);
  assert.equal(superseded.calls.some(([name]) => name === "supersede"), true);
  assert.equal(
    superseded.calls.findIndex(([name]) => name === "execution_device") <
      superseded.calls.findIndex(([name]) => name === "supersede"),
    true
  );
});

test("durable crash windows never resend paid work and preserve terminal candidates", async () => {
  const persistCrash = executionFixture({ persistError: new Error("persist crash") });
  await assert.rejects(persistCrash.service.execute(claimedDigestJob()), /persist crash/);
  assert.equal(persistCrash.calls.findIndex(([name]) => name === "reconcile") <
    persistCrash.calls.findIndex(([name]) => name === "persist"), true);
  const afterPersistCrash = executionFixture({
    attempts: [budgetAttempt("reconciled", {
      requestId: "digest-request-1",
      actualInputTokens: 80,
      actualOutputTokens: 40,
      actualMicrousd: 10,
    })],
  });
  assert.equal((await afterPersistCrash.service.execute(claimedDigestJob())).reason,
    "reconciled_without_candidate");
  assert.equal(afterPersistCrash.calls.some(([name]) => name === "request"), false);

  const candidate = {
    candidateId: "digest-candidate-1",
    jobId: "digest-job-1",
    digestInputId: "digest-input-1",
    candidateState: "validated",
    jobState: "running",
    leaseOwner: "digest-worker",
    leaseExpiresAt: 1_000,
    budgetState: "reconciled",
  };
  const applyCrash = executionFixture({ applyError: new Error("apply crash") });
  await assert.rejects(applyCrash.service.execute(claimedDigestJob()), /apply crash/);
  assert.equal(
    applyCrash.calls.findIndex(([name]) => name === "persist") <
      applyCrash.calls.findIndex(([name]) => name === "apply"),
    true
  );
  const afterApplyCrash = executionFixture({ candidates: [candidate] });
  assert.equal((await afterApplyCrash.service.execute(claimedDigestJob())).status, "applied");
  assert.equal(afterApplyCrash.calls.some(([name]) => name === "request"), false);

  const completeLost = executionFixture({ completeResult: false });
  await assert.rejects(completeLost.service.execute(claimedDigestJob()), { code: "JOB_LEASE_LOST" });
  assert.equal(completeLost.calls.findIndex(([name]) => name === "apply") <
    completeLost.calls.findIndex(([name]) => name === "complete"), true);
  const afterCompleteLost = executionFixture({
    candidates: [{ ...candidate, candidateState: "applied" }],
    applyResult: {
      status: "already_applied",
      candidateId: "digest-candidate-1",
      jobId: "digest-job-1",
    },
  });
  assert.equal((await afterCompleteLost.service.execute(claimedDigestJob())).status,
    "already_applied");
  assert.equal(afterCompleteLost.calls.some(([name]) => name === "request"), false);
});

test("post-start device or transport ambiguity is fenced before any possible resend", async () => {
  const deviceLost = executionFixture({ recordDeviceResult: false });
  await assert.rejects(deviceLost.service.execute(claimedDigestJob()), {
    code: "JOB_LEASE_LOST",
  });
  assert.deepEqual(deviceLost.calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "digest-request-1",
    reasonCode: "process_recovery",
  });
  assert.equal(deviceLost.calls.some(([name]) => name === "request"), false);

  const deviceError = executionFixture({ recordDeviceError: new Error("device write failed") });
  await assert.rejects(deviceError.service.execute(claimedDigestJob()), /device write failed/);
  assert.deepEqual(deviceError.calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "digest-request-1",
    reasonCode: "process_recovery",
  });
  assert.equal(deviceError.calls.some(([name]) => name === "request"), false);

  const ambiguous = executionFixture({ clientError: new Error("network timeout") });
  assert.deepEqual(await ambiguous.service.execute(claimedDigestJob()), {
    status: "blocked",
    reason: "usage_unknown",
    jobId: "digest-job-1",
  });
  assert.equal(ambiguous.calls.filter(([name]) => name === "request").length, 1);
  assert.deepEqual(ambiguous.calls.find(([name]) => name === "usage_unknown")[1], {
    requestId: "digest-request-1",
    reasonCode: "transport_ambiguous",
  });
  assert.equal(
    ambiguous.calls.findIndex(([name]) => name === "usage_unknown") <
      ambiguous.calls.findIndex(([name]) => name === "block"),
    true
  );

  const restart = executionFixture({ attempts: [budgetAttempt("usage_unknown", {
    requestId: "digest-request-1",
  })] });
  assert.deepEqual(await restart.service.execute(claimedDigestJob()), {
    status: "blocked",
    reason: "usage_unknown",
    jobId: "digest-job-1",
  });
  assert.equal(restart.calls.some(([name]) => name === "request"), false);
  assert.equal(restart.calls.some(([name]) => name === "reserve"), false);
});

test("execute returns bounded status only and defer/block transitions remain lease fenced", async () => {
  const success = executionFixture();
  const result = await success.service.execute(claimedDigestJob());
  const serialized = JSON.stringify(result);
  for (const secret of [SOURCE_HASH, "cloudPayloadJson", "budget", "secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  const deferLost = executionFixture({
    admission: [Object.freeze({ eligible: false, reason: "offline" })],
    deferResult: false,
  });
  await assert.rejects(deferLost.service.execute(claimedDigestJob()), { code: "JOB_LEASE_LOST" });
  const blockLost = executionFixture({
    attempts: [budgetAttempt("usage_unknown")],
    blockResult: false,
  });
  await assert.rejects(blockLost.service.execute(claimedDigestJob()), { code: "JOB_LEASE_LOST" });
  assert.equal(deferLost.calls.find(([name]) => name === "defer")[2].nextRetryAt, 15_200);
});
