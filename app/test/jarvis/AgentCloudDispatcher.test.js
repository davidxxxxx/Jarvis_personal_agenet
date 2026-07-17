const test = require("node:test");
const assert = require("node:assert/strict");

function loadDispatcher() {
  return require("../../src/jarvis/main/AgentCloudDispatcher");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function claimedJob() {
  return {
    id: "job-analysis-1",
    job_type: "analyze_session",
    lane: "cloud",
    state: "running",
  };
}

test("dispatcher requires explicit incomplete-budget recovery wiring", () => {
  const AgentCloudDispatcher = loadDispatcher();
  assert.throws(
    () =>
      new AgentCloudDispatcher({
        store: {
          recoverExpiredCloudCandidateLeases: () => [],
          recoverExpiredCloudPrestartLeases: () => [],
          claimCloudJobs: () => [],
        },
        worker: {
          recoverCandidate: () => {},
          execute: () => {},
        },
        owner: "cloud-worker",
      }),
    /recoverIncompleteBudgetAttempts must be a function/
  );
});

test("every drain remains gated until incomplete-budget recovery succeeds", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const calls = [];
  let recoveryAttempts = 0;
  let claims = 0;
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases() {
        calls.push("recover_candidates");
        return [];
      },
      recoverExpiredCloudPrestartLeases() {
        calls.push("recover_prestart");
        return [];
      },
      claimCloudJobs() {
        calls.push("claim");
        claims += 1;
        return [];
      },
    },
    worker: {
      recoverCandidate: () => assert.fail("no candidate recovery expected"),
      execute: () => assert.fail("no request expected"),
    },
    recoverIncompleteBudgetAttempts() {
      recoveryAttempts += 1;
      calls.push(`recover_budget_${recoveryAttempts}`);
      if (recoveryAttempts === 1) throw new Error("budget recovery unavailable");
      return { releasedCount: 0, usageUnknownCount: 0 };
    },
    owner: "cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  await assert.rejects(dispatcher.start(), /budget recovery unavailable/);
  assert.equal(claims, 0);
  assert.equal(await dispatcher.drainOnce(), 0);
  assert.deepEqual(calls, [
    "recover_budget_1",
    "recover_budget_2",
    "recover_candidates",
    "recover_prestart",
    "claim",
  ]);
});

test("concurrent drains perform exactly one active cloud request", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const release = deferred();
  const started = deferred();
  let claims = 0;
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases: () => [],
      recoverExpiredCloudPrestartLeases: () => [],
      claimCloudJobs() {
        claims += 1;
        return claims === 1 ? [claimedJob()] : [];
      },
    },
    worker: {
      recoverCandidate: () => assert.fail("no candidate recovery expected"),
      async execute() {
        requests += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.resolve();
        await release.promise;
        active -= 1;
        return { status: "applied" };
      },
    },
    recoverIncompleteBudgetAttempts: () => ({ releasedCount: 0, usageUnknownCount: 0 }),
    owner: "cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  const first = dispatcher.drainOnce();
  const second = dispatcher.drainOnce();
  await started.promise;
  assert.equal(claims, 1);
  assert.equal(requests, 1);
  assert.equal(maxActive, 1);
  release.resolve();
  assert.equal(await first, 1);
  assert.equal(await second, 1);
});

test("startup recovers applied and validated candidates before claiming new requests", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const calls = [];
  const recoveries = [
    {
      jobId: "job-applied",
      candidateId: "candidate-applied",
      candidateState: "applied",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 1_100,
    },
    {
      jobId: "job-validated",
      candidateId: "candidate-validated",
      candidateState: "validated",
      leaseOwner: "cloud-worker",
      leaseExpiresAt: 1_100,
    },
  ];
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases(input) {
        calls.push(["recover_leases", input]);
        return recoveries;
      },
      recoverExpiredCloudPrestartLeases(input) {
        calls.push(["recover_prestart", input]);
        return [];
      },
      claimCloudJobs(input) {
        calls.push(["claim", input]);
        return [claimedJob()];
      },
    },
    worker: {
      recoverCandidate(candidate) {
        calls.push(["recover_candidate", candidate.candidateState]);
        return { status: candidate.candidateState };
      },
      async execute(job) {
        calls.push(["execute", job.id]);
        return { status: "applied" };
      },
    },
    recoverIncompleteBudgetAttempts() {
      calls.push(["recover_budget"]);
      return { releasedCount: 0, usageUnknownCount: 0 };
    },
    owner: "cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  assert.equal(await dispatcher.start(), 3);
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "recover_budget",
      "recover_leases",
      "recover_candidate",
      "recover_candidate",
      "recover_prestart",
      "claim",
      "execute",
    ]
  );
  assert.equal(
    calls.find(([name]) => name === "recover_leases")[1].priorityBefore,
    71
  );
  assert.equal(
    calls.find(([name]) => name === "recover_prestart")[1].priorityBefore,
    71
  );
  assert.equal(calls.find(([name]) => name === "claim")[1].priorityBefore, 71);
});

test("startup executes one safely recovered pre-start job before any new claim", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const calls = [];
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases() {
        calls.push("recover_candidates");
        return [];
      },
      recoverExpiredCloudPrestartLeases() {
        calls.push("recover_prestart");
        return [claimedJob()];
      },
      claimCloudJobs() {
        calls.push("claim");
        return [];
      },
    },
    worker: {
      recoverCandidate: () => assert.fail("no candidate recovery expected"),
      async execute(job) {
        calls.push(`execute_${job.id}`);
        return { status: "applied" };
      },
    },
    recoverIncompleteBudgetAttempts() {
      calls.push("recover_budget");
      return { releasedCount: 0, usageUnknownCount: 0 };
    },
    owner: "cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  assert.equal(await dispatcher.start(), 1);
  assert.deepEqual(calls, [
    "recover_budget",
    "recover_candidates",
    "recover_prestart",
    "execute_job-analysis-1",
  ]);
});

test("shutdown stops new claims and joins the active cloud request", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const started = deferred();
  const release = deferred();
  let claims = 0;
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases: () => [],
      recoverExpiredCloudPrestartLeases: () => [],
      claimCloudJobs() {
        claims += 1;
        return [claimedJob()];
      },
    },
    worker: {
      recoverCandidate: () => assert.fail("no candidate recovery expected"),
      async execute() {
        started.resolve();
        await release.promise;
        return { status: "applied" };
      },
    },
    recoverIncompleteBudgetAttempts: () => ({ releasedCount: 0, usageUnknownCount: 0 }),
    owner: "cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  const drain = dispatcher.drainOnce();
  await started.promise;
  let stopped = false;
  const stopping = dispatcher.stop().then(() => {
    stopped = true;
  });
  assert.equal(await dispatcher.drainOnce(), 0);
  assert.equal(claims, 1);
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  assert.equal(await drain, 1);
  await stopping;
  assert.equal(stopped, true);
});

test("shared dispatcher routes digest recovery and analysis execution through one lane", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const calls = [];
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases(input) {
        calls.push(["recover_leases", input]);
        return [{
          jobId: "job-digest-1",
          jobType: "generate_daily_digest",
          candidateId: "candidate-digest-1",
          candidateState: "validated",
          leaseOwner: "shared-cloud-worker",
          leaseExpiresAt: 1_100,
        }];
      },
      recoverExpiredCloudPrestartLeases(input) {
        calls.push(["recover_prestart", input]);
        return [];
      },
      claimCloudJobs(input) {
        calls.push(["claim", input]);
        return [claimedJob()];
      },
    },
    workers: {
      analyze_session: {
        recoverCandidate: () => assert.fail("analysis candidate recovery not expected"),
        async execute(job) {
          calls.push(["analysis_execute", job.id]);
        },
      },
      generate_daily_digest: {
        recoverCandidate(candidate) {
          calls.push(["digest_recover", candidate.candidateId]);
        },
        execute: () => assert.fail("digest execution not expected"),
      },
    },
    recoverIncompleteBudgetAttempts: () => ({ releasedCount: 0, usageUnknownCount: 0 }),
    owner: "shared-cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  assert.equal(await dispatcher.start(), 2);
  assert.deepEqual(calls.map(([name]) => name), [
    "recover_leases",
    "digest_recover",
    "recover_prestart",
    "claim",
    "analysis_execute",
  ]);
  for (const name of ["recover_leases", "recover_prestart", "claim"]) {
    assert.equal(calls.find(([call]) => call === name)[1].priorityBefore, 81);
  }
});

test("shared dispatcher routes a recovered digest job before any new claim", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const calls = [];
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases: () => [],
      recoverExpiredCloudPrestartLeases() {
        return [{
          id: "job-digest-1",
          job_type: "generate_daily_digest",
          lane: "cloud",
          state: "running",
        }];
      },
      claimCloudJobs: () => assert.fail("new claim must wait"),
    },
    workers: {
      analyze_session: {
        recoverCandidate: () => assert.fail("analysis recovery not expected"),
        execute: () => assert.fail("analysis execution not expected"),
      },
      generate_daily_digest: {
        recoverCandidate: () => assert.fail("digest candidate recovery not expected"),
        async execute(job) {
          calls.push(job.id);
        },
      },
    },
    recoverIncompleteBudgetAttempts: () => ({ releasedCount: 0, usageUnknownCount: 0 }),
    owner: "shared-cloud-worker",
    now: () => 100,
    leaseMs: 1_000,
  });

  assert.equal(await dispatcher.start(), 1);
  assert.deepEqual(calls, ["job-digest-1"]);
});
