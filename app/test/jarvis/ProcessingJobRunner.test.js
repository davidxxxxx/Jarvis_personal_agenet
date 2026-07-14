const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
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
  db.prepare(`
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
  `).run({
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
    db.prepare(`
      SELECT state, attempt_count, lease_owner, lease_expires_at,
             error_code, completed_at
      FROM processing_jobs WHERE id = 'j1'
    `).get(),
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
    db.prepare("SELECT state, lease_owner, lease_expires_at FROM processing_jobs WHERE id = 'j1'").get(),
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
  assert.equal(db.prepare("SELECT state FROM processing_jobs WHERE id = 'job-a'").get().state, "completed");
  assert.equal(db.prepare("SELECT state FROM processing_jobs WHERE id = 'job-b'").get().state, "pending");
});

test("visibly blocks a claimed job when its handler is missing", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, { jobType: "unknown_job" });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db.prepare(`
      SELECT state, error_code, completed_at, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id = 'j1'
    `).get(),
    {
      state: "blocked",
      error_code: "HANDLER_MISSING",
      completed_at: 2_000,
      lease_owner: null,
      lease_expires_at: null,
    }
  );
});

test("records handler failure as retry without losing durable input metadata", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    const error = new Error("temporary outage");
    error.code = "TRANSIENT";
    throw error;
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db.prepare(`
      SELECT state, input_hash, input_version, model_version, attempt_count,
             next_retry_at, error_code, completed_at, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id = 'j1'
    `).get(),
    {
      state: "retry",
      input_hash: "pcm-hash",
      input_version: 3,
      model_version: "model-v2",
      attempt_count: 1,
      next_retry_at: 2_000,
      error_code: "TRANSIENT",
      completed_at: null,
      lease_owner: null,
      lease_expires_at: null,
    }
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
    db.prepare(`
      SELECT state, next_retry_at, lease_owner, lease_expires_at, error_code
      FROM processing_jobs WHERE id = 'j1'
    `).get(),
    {
      state: "retry",
      next_retry_at: 2_000,
      lease_owner: null,
      lease_expires_at: null,
      error_code: "LEASE_EXPIRED",
    }
  );
});
