const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");

function fixture(t, runnerOptions = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s1', 10, 'recording', 10)"
  ).run();
  const store = new CaptureEvidenceStore(db, {
    createId: (prefix) => `${prefix}-generated`,
    now: () => 2_000,
  });
  const runner = new ProcessingJobRunner({
    store,
    owner: "worker-b",
    now: () => 2_000,
    leaseMs: 100,
    ...runnerOptions,
  });
  t.after(() => db.close());
  return { db, store, runner };
}

function seedJob(db, overrides = {}) {
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, session_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count,
      next_retry_at, lease_owner, lease_expires_at, error_code,
      created_at, completed_at
    ) VALUES (
      @id, 's1', @jobType, @state, @priority,
      @inputHash, @inputVersion, @modelVersion, @attemptCount,
      @nextRetryAt, @leaseOwner, @leaseExpiresAt, @errorCode,
      @createdAt, @completedAt
    )
  `
  ).run({
    id: "j1",
    jobType: "transcribe_chunk",
    state: "pending",
    priority: 0,
    inputHash: "pcm-hash",
    inputVersion: 3,
    modelVersion: "model-v2",
    attemptCount: 0,
    nextRetryAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    createdAt: 100,
    completedAt: null,
    ...overrides,
  });
}

test("reclaims an expired job and completes it exactly once", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, {
    state: "running",
    attemptCount: 1,
    leaseOwner: "dead-worker",
    leaseExpiresAt: 1_500,
  });
  const calls = [];
  runner.register("transcribe_chunk", async (job) => calls.push(job.id));

  assert.equal(await runner.runOnce(2_000), 1);
  assert.deepEqual(calls, ["j1"]);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, lease_owner, lease_expires_at,
             error_code, completed_at
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "completed",
      attempt_count: 2,
      lease_owner: null,
      lease_expires_at: null,
      error_code: null,
      completed_at: 2_000,
    }
  );
  assert.equal(await runner.runOnce(2_001), 0);
  assert.deepEqual(calls, ["j1"]);
});
test("does not steal a current lease", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, {
    state: "running",
    attemptCount: 1,
    leaseOwner: "worker-a",
    leaseExpiresAt: 2_001,
  });
  runner.register("transcribe_chunk", async () => assert.fail("current lease was stolen"));

  assert.equal(await runner.runOnce(2_000), 0);
  assert.deepEqual(
    db
      .prepare("SELECT state, lease_owner, lease_expires_at FROM processing_jobs WHERE id = 'j1'")
      .get(),
    { state: "running", lease_owner: "worker-a", lease_expires_at: 2_001 }
  );
});

test("claims and executes only one deterministic job per iteration", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, { id: "job-b", createdAt: 100 });
  seedJob(db, { id: "job-a", createdAt: 100, inputHash: "other" });
  const calls = [];
  runner.register("transcribe_chunk", async (job) => calls.push(job.id));

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(calls, ["job-a"]);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'job-a'").get().state,
    "completed"
  );
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'job-b'").get().state,
    "pending"
  );
});

test("visibly blocks a claimed job when its handler is missing", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, { jobType: "unknown_job" });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, error_code, completed_at, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "blocked",
      error_code: "HANDLER_MISSING",
      completed_at: 2_000,
      lease_owner: null,
      lease_expires_at: null,
    }
  );
});

test("records handler failure with backoff without losing durable input metadata", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    const error = new Error("temporary outage");
    error.code = "TRANSIENT";
    throw error;
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, input_hash, input_version, model_version, attempt_count,
             next_retry_at, error_code, completed_at, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "retry",
      input_hash: "pcm-hash",
      input_version: 3,
      model_version: "model-v2",
      attempt_count: 1,
      next_retry_at: 3_000,
      error_code: "TRANSIENT",
      completed_at: null,
      lease_owner: null,
      lease_expires_at: null,
    }
  );
});

test("resource admission defers durably before the handler without counting an attempt", async (t) => {
  let handlerCalled = false;
  const governor = {
    sample: async () => ({ state: "busy", selectedGpuUuid: "GPU-a" }),
    admit: () => ({ action: "defer", reason: "external_gpu_busy" }),
  };
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db, { attemptCount: 2, errorCode: "PRIOR_FAILURE" });
  runner.register("transcribe_chunk", async () => {
    handlerCalled = true;
  });

  assert.equal(await runner.runOnce(), 1);
  assert.equal(handlerCalled, false);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, next_retry_at, blocked_reason, error_code,
             lease_owner, lease_expires_at, execution_device
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "retry",
      attempt_count: 2,
      next_retry_at: 17_000,
      blocked_reason: "external_gpu_busy",
      error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      execution_device: null,
    }
  );
});

test("admitted heavy work receives bounded context and stores the actual device", async (t) => {
  const governor = {
    sample: async () => ({ state: "available", selectedGpuUuid: "GPU-verified" }),
    admit: () => ({ action: "run_cuda", reason: "resources_available" }),
  };
  const gate = new HeavyJobGate();
  const { db, runner } = fixture(t, { governor, heavyGate: gate });
  seedJob(db);
  const contexts = [];
  runner.register("transcribe_chunk", async (_job, context) => {
    contexts.push(context);
    return { executionDevice: "cuda" };
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(contexts, [
    {
      action: "run_cuda",
      device: "cuda",
      cpuThreads: null,
      lowPriority: false,
      selectedGpuUuid: "GPU-verified",
    },
  ]);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, blocked_reason, error_code, execution_device
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "completed",
      attempt_count: 1,
      blocked_reason: null,
      error_code: null,
      execution_device: "cuda",
    }
  );
});

test("a backend that disagrees with admission retries instead of persisting a false device", async (t) => {
  const governor = {
    sample: async () => ({ state: "available", selectedGpuUuid: "GPU-verified" }),
    admit: () => ({ action: "run_cuda", reason: "resources_available" }),
  };
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db);
  runner.register("transcribe_chunk", async () => ({ executionDevice: "cpu" }));

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, next_retry_at, error_code, execution_device
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "retry",
      attempt_count: 1,
      next_retry_at: 3_000,
      error_code: "EXECUTION_DEVICE_MISMATCH",
      execution_device: null,
    }
  );
});

test("classifies claimed retention and storage recovery urgency before running state replaces it", async (t) => {
  const cases = [
    {
      name: "retention",
      state: "retention_urgent",
      priority: 0,
      jobType: "transcribe_chunk",
      expectedKind: "retention_urgent",
    },
    {
      name: "storage",
      state: "storage_recovery_compress",
      priority: 10,
      jobType: "compress_chunk",
      expectedKind: "storage_recovery_compress",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const kinds = [];
      const governor = {
        sample: async () => ({ state: "constrained", selectedGpuUuid: null }),
        admit: (kind) => {
          kinds.push(kind);
          return { action: "run_cpu", reason: "storage_critical" };
        },
      };
      const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
      seedJob(db, scenario);
      runner.register(scenario.jobType, async () => ({ executionDevice: "cpu" }));

      assert.equal(await runner.runOnce(), 1);
      assert.deepEqual(kinds, [scenario.expectedKind]);
    });
  }
});

test("normalizes malformed handler error codes without stranding the lease", async (t) => {
  const cases = [
    ["numeric", { code: 503 }],
    ["object", { code: { status: 503 } }],
    ["unsafe string", { code: "not safe!" }],
    ["symbol", { code: Symbol("offline") }],
    [
      "throwing getter",
      Object.defineProperty({}, "code", {
        get() {
          throw new Error("code getter failed");
        },
      }),
    ],
  ];

  for (const [name, thrown] of cases) {
    await t.test(name, async (t) => {
      const { db, runner } = fixture(t);
      seedJob(db);
      runner.register("transcribe_chunk", async () => {
        throw thrown;
      });

      assert.equal(await runner.runOnce(), 1);
      assert.deepEqual(
        db
          .prepare(
            `
          SELECT state, error_code, next_retry_at, lease_owner, lease_expires_at
          FROM processing_jobs WHERE id = 'j1'
        `
          )
          .get(),
        {
          state: "retry",
          error_code: "JOB_FAILED",
          next_retry_at: 3_000,
          lease_owner: null,
          lease_expires_at: null,
        }
      );
    });
  }
});

test("persistent failure backs off so an independent due job is not starved", async (t) => {
  let now = 2_000;
  const { db, runner } = fixture(t, {
    now: () => now,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
  });
  seedJob(db, { id: "job-a-fails", inputHash: "fails" });
  seedJob(db, { id: "job-b-works", inputHash: "works" });
  const calls = [];
  runner.register("transcribe_chunk", async (job) => {
    calls.push(job.id);
    if (job.id === "job-a-fails") throw new Error("still unavailable");
  });

  assert.equal(await runner.runOnce(), 1);
  assert.equal(
    db.prepare("SELECT next_retry_at FROM processing_jobs WHERE id = 'job-a-fails'").get()
      .next_retry_at,
    2_100
  );
  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(calls, ["job-a-fails", "job-b-works"]);
  assert.equal(await runner.runOnce(), 0);

  now = 2_100;
  assert.equal(await runner.runOnce(), 1);
  assert.equal(
    db.prepare("SELECT next_retry_at FROM processing_jobs WHERE id = 'job-a-fails'").get()
      .next_retry_at,
    2_300
  );
});

test("exposes explicit expired-lease recovery", (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, {
    state: "running",
    leaseOwner: "worker-a",
    leaseExpiresAt: 2_000,
  });

  assert.equal(runner.recoverExpiredLeases(2_000), 1);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, next_retry_at, lease_owner, lease_expires_at, error_code
      FROM processing_jobs WHERE id = 'j1'
    `
      )
      .get(),
    {
      state: "retry",
      next_retry_at: 2_000,
      lease_owner: null,
      lease_expires_at: null,
      error_code: "LEASE_EXPIRED",
    }
  );
});

test("reports ownership loss when completion loses its lease instead of returning success", async (t) => {
  let now = 2_000;
  const { db, store, runner } = fixture(t, { now: () => now });
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    now = 2_100;
    assert.equal(store.recoverExpiredLeases(now), 1);
  });

  await assert.rejects(runner.runOnce(2_000), { code: "JOB_LEASE_LOST" });
  assert.deepEqual(
    db
      .prepare(
        "SELECT state, error_code, completed_at, lease_owner, lease_expires_at FROM processing_jobs WHERE id = 'j1'"
      )
      .get(),
    {
      state: "retry",
      error_code: "LEASE_EXPIRED",
      completed_at: null,
      lease_owner: null,
      lease_expires_at: null,
    }
  );
});

test("reports ownership loss when retry cannot transition the recovered lease", async (t) => {
  let now = 2_000;
  const { db, store, runner } = fixture(t, { now: () => now });
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    now = 2_100;
    assert.equal(store.recoverExpiredLeases(now), 1);
    const error = new Error("late backend failure");
    error.code = "TRANSIENT";
    throw error;
  });

  await assert.rejects(runner.runOnce(2_000), { code: "JOB_LEASE_LOST" });
  assert.deepEqual(
    db
      .prepare("SELECT state, error_code, next_retry_at FROM processing_jobs WHERE id = 'j1'")
      .get(),
    { state: "retry", error_code: "LEASE_EXPIRED", next_retry_at: 2_100 }
  );
});

test("reports ownership loss when resource deferral cannot release the recovered lease", async (t) => {
  let now = 2_000;
  let durableStore;
  const governor = {
    sample: async () => {
      now = 2_100;
      assert.equal(durableStore.recoverExpiredLeases(now), 1);
      return { state: "busy", selectedGpuUuid: "GPU-a" };
    },
    admit: () => ({ action: "defer", reason: "external_gpu_busy" }),
  };
  const { db, store, runner } = fixture(t, {
    now: () => now,
    governor,
    heavyGate: new HeavyJobGate(),
  });
  durableStore = store;
  seedJob(db);
  runner.register("transcribe_chunk", async () => assert.fail("deferred handler ran"));

  await assert.rejects(runner.runOnce(2_000), { code: "JOB_LEASE_LOST" });
  assert.deepEqual(
    db
      .prepare("SELECT state, error_code, blocked_reason FROM processing_jobs WHERE id = 'j1'")
      .get(),
    { state: "retry", error_code: "LEASE_EXPIRED", blocked_reason: null }
  );
});
