const assert = require("node:assert/strict");
const test = require("node:test");

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
    completeJob(jobId, input) {
      calls.push(["completeJob", jobId, input]);
      return state.completeResult;
    },
  };
  const DailyDigestService = loadService();
  const service = new DailyDigestService({
    memoryRepository,
    store,
    modelVersion: "MiniMax-M2.7",
    timezoneProvider: () => "Asia/Shanghai",
    now: () => 8_000,
    owner: "digest-worker",
  });
  return { service, calls, state, memoryRepository, store };
}

test("constructor enforces the exact foundation dependency contract", () => {
  const DailyDigestService = loadService();
  const valid = fixture();
  assert.throws(
    () => new DailyDigestService({
      memoryRepository: valid.memoryRepository,
      store: valid.store,
      modelVersion: "MiniMax-M2.7",
      timezoneProvider: () => "UTC",
      now: () => 1,
      owner: "worker",
      extra: true,
    }),
    /exact|keys|dependency/i
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

test("recoverCandidate applies every durable state without network and lease-fences completion", () => {
  for (const candidateState of ["validated", "applied", "superseded"]) {
    const appliedStatus = candidateState === "validated" ? "applied" :
      candidateState === "applied" ? "already_applied" : "superseded";
    const { service, calls } = fixture({
      state: {
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
    assert.deepEqual(calls, [
      [
        "applyValidatedDailyDigestCandidate",
        { candidateId: "digest-candidate-1", leaseOwner: "digest-worker" },
      ],
      [
        "completeJob",
        "digest-job-1",
        { owner: "digest-worker", at: 8_000, executionDevice: "cloud" },
      ],
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
  assert.equal(calls[0][0], "applyValidatedDailyDigestCandidate");
  assert.equal(calls[1][0], "completeJob");
});

test("recoverCandidate never completes a caller-supplied job that differs from candidate lineage", () => {
  const DailyDigestService = loadService();
  const jobs = new Map([
    ["real-digest-job", { state: "running", owner: "digest-worker" }],
    ["forged-digest-job", { state: "running", owner: "digest-worker" }],
  ]);
  const completed = [];
  const service = new DailyDigestService({
    memoryRepository: {
      createDailyDigestInput: () => ({ status: "empty" }),
      getLatestDailyDigest: () => null,
      applyValidatedDailyDigestCandidate: () => ({
        status: "already_applied",
        candidateId: "digest-candidate-1",
        jobId: "real-digest-job",
      }),
    },
    store: {
      enqueueDailyDigestJob: () => null,
      wakeDailyDigestJob: () => null,
      completeJob(jobId) {
        completed.push(jobId);
        jobs.get(jobId).state = "completed";
        return true;
      },
    },
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
  assert.deepEqual([...jobs.values()].map((job) => job.state), ["running", "running"]);
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
