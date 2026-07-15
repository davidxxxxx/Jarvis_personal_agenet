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

test("concurrent drains perform exactly one active cloud request", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const release = deferred();
  let claims = 0;
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases: () => [],
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
  await Promise.resolve();
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
      "claim",
      "execute",
    ]
  );
  assert.equal(calls.find(([name]) => name === "claim")[1].priorityBefore, 71);
});

test("shutdown stops new claims and joins the active cloud request", async () => {
  const AgentCloudDispatcher = loadDispatcher();
  const started = deferred();
  const release = deferred();
  let claims = 0;
  const dispatcher = new AgentCloudDispatcher({
    store: {
      recoverExpiredCloudCandidateLeases: () => [],
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
