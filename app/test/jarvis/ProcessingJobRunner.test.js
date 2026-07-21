const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const ResourceGovernor = require("../../src/jarvis/main/ResourceGovernor");
const PreviewTranscriptionScheduler = require("../../src/jarvis/main/PreviewTranscriptionScheduler");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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
      lane, analysis_input_id, desired_head_hash, created_at, completed_at
    ) VALUES (
      @id, 's1', @jobType, @state, @priority,
      @inputHash, @inputVersion, @modelVersion, @attemptCount,
      @nextRetryAt, @leaseOwner, @leaseExpiresAt, @errorCode,
      @lane, @analysisInputId, @desiredHeadHash, @createdAt, @completedAt
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
    lane: "local",
    analysisInputId: null,
    desiredHeadHash: null,
    createdAt: 100,
    completedAt: null,
    ...overrides,
  });
}

function seedDailyDigestJob(db) {
  const sourceHash = "c".repeat(64);
  const payload = JSON.stringify({ schemaVersion: "jarvis-daily-digest-input-v1" });
  db.prepare(
    `INSERT INTO daily_digest_inputs (
       id, local_date, timezone, source_hash, contract_version, completeness,
       input_watermark_json, cloud_payload_json, input_bytes, model_version, created_at
     ) VALUES (
       'digest-input', '2026-07-17', 'Asia/Shanghai', ?,
       'jarvis-daily-digest-input-v1', 'final', '{}', ?, ?, 'model-v2', 100
     )`
  ).run(sourceHash, payload, Buffer.byteLength(payload));
  db.prepare(
    `INSERT INTO processing_jobs (
       id, session_id, job_type, state, priority, input_hash, input_version,
       model_version, attempt_count, lane, digest_input_id, created_at
     ) VALUES (
       'cloud-digest', NULL, 'generate_daily_digest', 'pending', 80, ?, 3,
       'model-v2', 0, 'cloud', 'digest-input', 100
     )`
  ).run(sourceHash);
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

test("leaves ordinary final work unclaimed when draining above the preview priority ceiling", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, { id: "final-only", priority: 30 });
  runner.register("transcribe_chunk", async () => assert.fail("final work crossed the ceiling"));

  assert.equal(await runner.runOnce(2_000, { priorityBefore: 20 }), 0);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'final-only'").get().state,
    "pending"
  );
});

test("drains late durable urgency inside the preview permit without nesting the heavy gate", async (t) => {
  const gate = new HeavyJobGate();
  const governor = {
    sample: async () => ({ state: "constrained", selectedGpuUuid: null }),
    admit: () => ({ action: "run_cpu", reason: "storage_critical" }),
  };
  const { db, runner } = fixture(t, { governor, heavyGate: gate });
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const order = [];
  runner.register("transcribe_chunk", async (job) => {
    assert.equal(gate.getState().activeKind, "retention_urgent");
    order.push(job.id);
    return { executionDevice: "cpu" };
  });
  runner.register("compress_chunk", async (job) => {
    assert.equal(gate.getState().activeKind, "storage_recovery_compress");
    order.push(job.id);
    return { executionDevice: "cpu" };
  });

  const blocker = gate.run("maintenance", async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  await blockerStarted.promise;
  const scheduler = new PreviewTranscriptionScheduler({
    heavyGate: gate,
    now: () => 2_000,
    beforePreviewStart: (permit) =>
      runner.drainHigherPriorityWithinPermit(permit, { priorityBefore: 20, at: 2_000 }),
    executePreview: async () => {
      order.push("preview");
      return { segments: [] };
    },
    persistProvisional() {},
  });
  scheduler.request({ sessionId: "s1", trackId: "track-mic", throughMs: 15_000 });
  const preview = scheduler.tick({
    state: "available",
    reason: "resources_available",
    previewEnabled: true,
  });
  const final = gate.run("final_transcription", () => order.push("final"));

  seedJob(db, {
    id: "retention-late",
    state: "retention_urgent",
    priority: 0,
    inputHash: "retention-late",
  });
  seedJob(db, {
    id: "storage-late",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    inputHash: "storage-late",
  });
  seedJob(db, {
    id: "final-durable",
    priority: 30,
    inputHash: "final-durable",
  });
  releaseBlocker.resolve();
  await Promise.all([blocker, preview, final]);

  assert.deepEqual(order, ["retention-late", "storage-late", "preview", "final"]);
  assert.deepEqual(
    db
      .prepare("SELECT id, state FROM processing_jobs WHERE id IN (?, ?, ?) ORDER BY priority, id")
      .all("retention-late", "storage-late", "final-durable"),
    [
      { id: "retention-late", state: "completed" },
      { id: "storage-late", state: "completed" },
      { id: "final-durable", state: "pending" },
    ]
  );
});

test("rejects a forged preview permit before claiming a durable lease", async (t) => {
  const gate = new HeavyJobGate();
  const { db, runner } = fixture(t, { heavyGate: gate });
  seedJob(db, { id: "urgent-safe", state: "retention_urgent", priority: 0 });

  await assert.rejects(
    runner.drainHigherPriorityWithinPermit({}, { priorityBefore: 20, at: 2_000 }),
    /permit/i
  );
  assert.deepEqual(
    db
      .prepare("SELECT state, lease_owner, lease_expires_at FROM processing_jobs WHERE id = ?")
      .get("urgent-safe"),
    { state: "retention_urgent", lease_owner: null, lease_expires_at: null }
  );
});

test("permit draining preserves durable retry and resource deferral transitions", async (t) => {
  const gate = new HeavyJobGate();
  const governor = {
    sample: async () => ({ state: "constrained", selectedGpuUuid: null }),
    admit: (kind) =>
      kind === "storage_recovery_compress"
        ? { action: "defer", reason: "storage_pressure" }
        : { action: "run_cpu", reason: "retention_urgent" },
  };
  const { db, runner } = fixture(t, { governor, heavyGate: gate });
  seedJob(db, {
    id: "retention-retry",
    state: "retention_urgent",
    priority: 0,
    inputHash: "retention-retry",
  });
  seedJob(db, {
    id: "storage-defer",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    inputHash: "storage-defer",
  });
  seedJob(db, {
    id: "final-stays-pending",
    priority: 30,
    inputHash: "final-stays-pending",
  });
  runner.register("transcribe_chunk", async () => {
    const error = new Error("temporary retention failure");
    error.code = "TRANSIENT";
    throw error;
  });
  runner.register("compress_chunk", async () =>
    assert.fail("resource-deferred storage handler ran")
  );

  const processed = await gate.run("preview", (permit) =>
    runner.drainHigherPriorityWithinPermit(permit, { priorityBefore: 20, at: 2_000 })
  );

  assert.equal(processed, 2);
  assert.deepEqual(
    db
      .prepare(
        `
        SELECT id, state, attempt_count, next_retry_at, error_code, blocked_reason,
               lease_owner, lease_expires_at
        FROM processing_jobs
        WHERE id IN ('retention-retry', 'storage-defer', 'final-stays-pending')
        ORDER BY priority, id
      `
      )
      .all(),
    [
      {
        id: "retention-retry",
        state: "retry",
        attempt_count: 1,
        next_retry_at: 3_000,
        error_code: "TRANSIENT",
        blocked_reason: null,
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "storage-defer",
        state: "retry",
        attempt_count: 0,
        next_retry_at: 17_000,
        error_code: null,
        blocked_reason: "storage_pressure",
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "final-stays-pending",
        state: "pending",
        attempt_count: 0,
        next_retry_at: null,
        error_code: null,
        blocked_reason: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
  );
});

test("a running CUDA job yields durably when resources become busy", async (t) => {
  let admissions = 0;
  const governor = {
    sample: async () => ({ state: admissions === 0 ? "available" : "busy", selectedGpuUuid: "GPU-1" }),
    admit: () => {
      admissions += 1;
      return admissions === 1
        ? { action: "run_cuda", reason: "resources_available" }
        : { action: "defer", reason: "external_gpu_busy" };
    },
  };
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db, { priority: 30 });
  runner.register("transcribe_chunk", async (_job, context) => {
    assert.equal(context.device, "cuda");
    await context.checkResources();
    assert.fail("resource checkpoint should have yielded");
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db.prepare(`
      SELECT state, attempt_count, next_retry_at, error_code, blocked_reason,
             lease_owner, lease_expires_at
      FROM processing_jobs WHERE id = 'j1'
    `).get(),
    {
      state: "retry",
      attempt_count: 0,
      next_retry_at: 17_000,
      error_code: null,
      blocked_reason: "external_gpu_busy",
      lease_owner: null,
      lease_expires_at: null,
    }
  );
});

test("local runner leaves unknown and cloud work unclaimed instead of classifying maintenance", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, { jobType: "unknown_job" });
  seedDailyDigestJob(db);

  assert.throws(
    () => runner.register("unknown_job", async () => {}),
    /registered by the local processing runner/
  );
  assert.throws(
    () => runner.register("analyze_session", async () => {}),
    /registered by the local processing runner/
  );
  assert.throws(
    () => runner.register("generate_daily_digest", async () => {}),
    /registered by the local processing runner/
  );
  assert.equal(await runner.runOnce(), 0);
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, error_code, completed_at, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id IN ('j1','cloud-digest') ORDER BY id
    `
      )
      .all(),
    [
      {
        id: "cloud-digest",
        state: "pending",
        error_code: null,
        completed_at: null,
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "j1",
        state: "pending",
        error_code: null,
        completed_at: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
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

test("blocks deterministic database constraints after one attempt instead of retrying forever", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db, {
    jobType: "diarize_track",
    priority: 40,
    modelVersion: "jarvis-session-diarization-v1",
  });
  runner.register("diarize_track", async () => {
    const error = new Error("encrypted embedding violates an obsolete schema constraint");
    error.code = "SQLITE_CONSTRAINT_CHECK";
    throw error;
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, next_retry_at, error_code, completed_at,
                lease_owner, lease_expires_at
         FROM processing_jobs WHERE id = 'j1'`
      )
      .get(),
    {
      state: "blocked",
      attempt_count: 1,
      next_retry_at: null,
      error_code: "SQLITE_CONSTRAINT_CHECK",
      completed_at: 2_000,
      lease_owner: null,
      lease_expires_at: null,
    }
  );
  assert.equal(await runner.runOnce(), 0);
});

test("blocks a transcription lineage mismatch instead of retrying obsolete work", async (t) => {
  const { db, runner } = fixture(t);
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    const error = new Error("TRANSCRIPTION_LINEAGE_MISMATCH");
    error.code = "TRANSCRIPTION_LINEAGE_MISMATCH";
    throw error;
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, next_retry_at, error_code, completed_at
         FROM processing_jobs WHERE id = 'j1'`
      )
      .get(),
    {
      state: "blocked",
      attempt_count: 1,
      next_retry_at: null,
      error_code: "TRANSCRIPTION_LINEAGE_MISMATCH",
      completed_at: 2_000,
    }
  );
  assert.equal(await runner.runOnce(), 0);
});

test("obsolete diarization inputs become terminal while the runner continues other jobs", async (t) => {
  const { db, runner } = fixture(t);
  const obsoleteCodes = [
    "DIARIZATION_STALE_INPUT",
    "DIARIZATION_AUDIO_EXPIRED",
    "DIARIZATION_SUPERSEDED",
  ];
  obsoleteCodes.forEach((code, index) =>
    seedJob(db, {
      id: `obsolete-${index}`,
      jobType: "diarize_track",
      priority: 40,
      inputHash: `obsolete-${index}`,
      modelVersion: "jarvis-session-diarization-v1",
      createdAt: 100 + index,
    })
  );
  seedJob(db, {
    id: "ordinary-after-obsolete",
    jobType: "transcribe_chunk",
    priority: 50,
    inputHash: "ordinary",
    createdAt: 200,
  });
  const ordinaryCalls = [];
  runner.register("diarize_track", async (job) => {
    const error = new Error(obsoleteCodes[Number(job.id.slice(-1))]);
    error.code = obsoleteCodes[Number(job.id.slice(-1))];
    throw error;
  });
  runner.register("transcribe_chunk", async (job) => ordinaryCalls.push(job.id));

  for (let index = 0; index < 4; index += 1) assert.equal(await runner.runOnce(), 1);
  for (let index = 0; index < 5; index += 1) assert.equal(await runner.runOnce(), 0);

  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, error_code, next_retry_at, completed_at
         FROM processing_jobs WHERE id LIKE 'obsolete-%' ORDER BY id`
      )
      .all(),
    obsoleteCodes.map((code, index) => ({
      id: `obsolete-${index}`,
      state: "blocked",
      error_code: code,
      next_retry_at: null,
      completed_at: 2000,
    }))
  );
  assert.deepEqual(ordinaryCalls, ["ordinary-after-obsolete"]);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'ordinary-after-obsolete'").get()
      .state,
    "completed"
  );
});

test("obsolete identity resolution jobs block once and do not stop later work", async (t) => {
  const { db, runner } = fixture(t);
  const codes = ["IDENTITY_RESOLUTION_STALE_INPUT", "IDENTITY_RESOLUTION_SUPERSEDED"];
  codes.forEach((code, index) =>
    seedJob(db, {
      id: `resolve-obsolete-${index}`,
      jobType: "resolve_identities",
      priority: 45,
      inputHash: `resolve-obsolete-${index}`,
      modelVersion: "speaker-identity/3dspeaker-campplus-voxceleb-16k-v1@1",
      createdAt: 100 + index,
    })
  );
  seedJob(db, {
    id: "after-resolve-obsolete",
    jobType: "transcribe_chunk",
    priority: 50,
    inputHash: "after-resolve-obsolete",
    createdAt: 200,
  });
  const completed = [];
  runner.register("resolve_identities", async (job) => {
    const code = codes[Number(job.id.slice(-1))];
    const error = new Error(code);
    error.code = code;
    throw error;
  });
  runner.register("transcribe_chunk", async (job) => completed.push(job.id));

  for (let index = 0; index < 3; index += 1) assert.equal(await runner.runOnce(), 1);
  assert.equal(await runner.runOnce(), 0);
  assert.deepEqual(
    db
      .prepare(
        "SELECT id, state, error_code FROM processing_jobs WHERE id LIKE 'resolve-obsolete-%' ORDER BY id"
      )
      .all(),
    codes.map((code, index) => ({
      id: `resolve-obsolete-${index}`,
      state: "blocked",
      error_code: code,
    }))
  );
  assert.deepEqual(completed, ["after-resolve-obsolete"]);
});

test("diarization dependency deferrals use a long retry window without a claim storm", async (t) => {
  let now = 2_000;
  let available = false;
  const governor = {
    sample: async () => ({ state: "available" }),
    admit: () =>
      available
        ? { action: "run_cpu", reason: "cpu_backend" }
        : { action: "defer", reason: "diarization_model_unavailable" },
  };
  const { db, runner } = fixture(t, {
    now: () => now,
    governor,
    heavyGate: new HeavyJobGate(),
  });
  const calls = [];
  for (let index = 0; index < 8; index += 1) {
    seedJob(db, {
      id: `model-wait-${index}`,
      jobType: "diarize_track",
      priority: 40,
      inputHash: `model-wait-${index}`,
      modelVersion: "jarvis-session-diarization-v1",
      createdAt: 100 + index,
    });
  }
  runner.register("diarize_track", async (job) => {
    calls.push(job.id);
    return { executionDevice: "cpu" };
  });

  for (let index = 0; index < 8; index += 1) assert.equal(await runner.runOnce(), 1);
  now += 15_000;
  for (let index = 0; index < 20; index += 1) assert.equal(await runner.runOnce(), 0);
  const waiting = db
    .prepare(
      `SELECT state, attempt_count, next_retry_at, blocked_reason
       FROM processing_jobs ORDER BY id`
    )
    .all();
  assert.ok(waiting.every((job) => job.state === "retry"));
  assert.ok(waiting.every((job) => job.attempt_count === 0));
  assert.ok(waiting.every((job) => job.next_retry_at >= 2_000 + 30 * 60_000));
  assert.ok(waiting.every((job) => job.blocked_reason === "diarization_model_unavailable"));
  assert.deepEqual(calls, []);

  available = true;
  now = Math.max(...waiting.map((job) => job.next_retry_at));
  for (let index = 0; index < 8; index += 1) assert.equal(await runner.runOnce(), 1);
  assert.equal(await runner.runOnce(), 0);
  assert.equal(calls.length, 8);
  assert.equal(
    db.prepare("SELECT count(*) count FROM processing_jobs WHERE state = 'completed'").get().count,
    8
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

test("CUDA-unavailable final transcription and compression drain durably on bounded CPU", async (t) => {
  const governor = new ResourceGovernor({
    now: () => 2_000,
    telemetryProvider: async () => ({
      telemetryAvailable: true,
      processTelemetryAvailable: true,
      gpus: [],
      processes: [],
      ownedPids: [],
      externalGpuBusy: false,
    }),
    cudaProvider: async () => ({
      installed: false,
      verified: false,
      quarantined: false,
      gpuUuid: null,
      peakVramMb: null,
    }),
    cpuProvider: async () => ({ loadPct: 20, telemetryAvailable: true }),
    memoryProvider: async () => ({ loadPct: 20, telemetryAvailable: true }),
    powerProvider: async () => ({
      onAcPower: true,
      batteryPresent: false,
      batteryLevelPct: null,
      batterySaver: false,
      telemetryAvailable: true,
    }),
  });
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db, { id: "final-job", priority: 30 });
  seedJob(db, {
    id: "compression-job",
    jobType: "compress_chunk",
    priority: 60,
    inputHash: "compression-input",
  });
  const contexts = [];
  const handle = async (job, context) => {
    contexts.push({ id: job.id, ...context });
    return { executionDevice: "cpu" };
  };
  runner.register("transcribe_chunk", handle);
  runner.register("compress_chunk", handle);

  assert.equal(await runner.runOnce(), 1);
  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(contexts, [
    {
      id: "final-job",
      action: "run_cpu",
      device: "cpu",
      cpuThreads: 4,
      lowPriority: true,
      selectedGpuUuid: null,
    },
    {
      id: "compression-job",
      action: "run_cpu",
      device: "cpu",
      cpuThreads: 4,
      lowPriority: true,
      selectedGpuUuid: null,
    },
  ]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT id, state, blocked_reason, execution_device FROM processing_jobs ORDER BY priority"
      )
      .all(),
    [
      {
        id: "final-job",
        state: "completed",
        blocked_reason: null,
        execution_device: "cpu",
      },
      {
        id: "compression-job",
        state: "completed",
        blocked_reason: null,
        execution_device: "cpu",
      },
    ]
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

test("classifies diarize_track as CPU speaker work without claiming CUDA", async (t) => {
  const admissions = [];
  const governor = {
    sample: async () => ({
      state: "available",
      selectedGpuUuid: "GPU-a",
      cpuLoadPct: 20,
      cpuTelemetryAvailable: true,
      powerTelemetryAvailable: true,
      batterySaver: false,
    }),
    admit: (kind, _snapshot, capability) => {
      admissions.push({ kind, capability });
      return { action: "run_cpu", reason: "cpu_backend" };
    },
  };
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db, { jobType: "diarize_track", priority: 40 });
  runner.register("diarize_track", async (_job, context) => {
    assert.equal(context.device, "cpu");
    return { executionDevice: "cpu" };
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(admissions, [{ kind: "speaker", capability: { executionDevice: "cpu" } }]);
  assert.equal(
    db.prepare("SELECT execution_device FROM processing_jobs WHERE id = 'j1'").get()
      .execution_device,
    "cpu"
  );
});

test("classifies resolve_identities as CPU speaker work without claiming CUDA", async (t) => {
  const admissions = [];
  const governor = {
    sample: async () => ({
      state: "available",
      selectedGpuUuid: "GPU-a",
      cpuLoadPct: 20,
      cpuTelemetryAvailable: true,
      powerTelemetryAvailable: true,
      batterySaver: false,
    }),
    admit: (kind, _snapshot, capability) => {
      admissions.push({ kind, capability });
      return { action: "run_cpu", reason: "cpu_backend" };
    },
  };
  const { db, runner } = fixture(t, { governor, heavyGate: new HeavyJobGate() });
  seedJob(db, { jobType: "resolve_identities", priority: 45 });
  runner.register("resolve_identities", async (_job, context) => {
    assert.equal(context.device, "cpu");
    return { executionDevice: "cpu" };
  });

  assert.equal(await runner.runOnce(), 1);
  assert.deepEqual(admissions, [{ kind: "speaker", capability: { executionDevice: "cpu" } }]);
  assert.equal(
    db.prepare("SELECT execution_device FROM processing_jobs WHERE id = 'j1'").get()
      .execution_device,
    "cpu"
  );
});

test("a running admitted CPU speaker job is durably visible before its handler completes", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({ id: "s1", startedAt: 10, micDeviceId: null });
  seedJob(repository.db, { jobType: "resolve_identities", priority: 45 });
  const entered = deferred();
  const release = deferred();
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner: "speaker-status-worker",
    now: () => 2_000,
    leaseMs: 1_000,
    governor: {
      sample: async () => ({ state: "available", selectedGpuUuid: "GPU-private" }),
      admit: () => ({ action: "run_cpu", reason: "cpu_backend" }),
    },
    heavyGate: new HeavyJobGate(),
  });
  runner.register("resolve_identities", async (_job, context) => {
    assert.equal(context.device, "cpu");
    assert.equal(context.selectedGpuUuid, null);
    entered.resolve();
    await release.promise;
    return { executionDevice: "cpu" };
  });

  const running = runner.runOnce(2_000);
  await entered.promise;
  assert.deepEqual(
    repository.db
      .prepare("SELECT state, lease_owner, execution_device FROM processing_jobs WHERE id = 'j1'")
      .get(),
    {
      state: "running",
      lease_owner: "speaker-status-worker",
      execution_device: "cpu",
    }
  );
  assert.equal(repository.getRuntimeProcessingStatus().activeExecutionDevice, "cpu");

  release.resolve();
  assert.equal(await running, 1);
  assert.deepEqual(
    repository.db
      .prepare("SELECT state, execution_device FROM processing_jobs WHERE id = 'j1'")
      .get(),
    { state: "completed", execution_device: "cpu" }
  );
});

test("final transcription and durable diarization share one heavy-work permit", async (t) => {
  const gate = new HeavyJobGate();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let active = 0;
  let peak = 0;
  const order = [];
  const governor = {
    sample: async () => ({ state: "available", selectedGpuUuid: null }),
    admit: () => ({ action: "run_cpu", reason: "test_cpu" }),
  };
  const { db, runner } = fixture(t, { governor, heavyGate: gate });
  seedJob(db, { id: "transcribe-final", priority: 30, inputHash: "final-pcm" });
  seedJob(db, {
    id: "diarize-final",
    jobType: "diarize_track",
    priority: 40,
    inputHash: "diarize-key",
  });
  const run = async (job) => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`${job.job_type}:start`);
    if (job.job_type === "transcribe_chunk") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    order.push(`${job.job_type}:end`);
    active -= 1;
    return { executionDevice: "cpu" };
  };
  runner.register("transcribe_chunk", run);
  runner.register("diarize_track", run);

  const first = runner.runOnce();
  const second = runner.runOnce();
  await firstStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.getState(), { activeKind: "final_transcription", queueLength: 1 });
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(peak, 1);
  assert.deepEqual(order, [
    "transcribe_chunk:start",
    "transcribe_chunk:end",
    "diarize_track:start",
    "diarize_track:end",
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT id, state, execution_device FROM processing_jobs ORDER BY priority, id")
      .all(),
    [
      { id: "transcribe-final", state: "completed", execution_device: "cpu" },
      { id: "diarize-final", state: "completed", execution_device: "cpu" },
    ]
  );
});

test("renews a long job lease with a bounded heartbeat and clears the timer", async (t) => {
  let now = 2_000;
  let heartbeat = null;
  let heartbeatMs = null;
  const cleared = [];
  const timer = { unref() {} };
  const { db, runner } = fixture(t, {
    now: () => now,
    leaseMs: 90,
    setIntervalImpl: (callback, interval) => {
      heartbeat = callback;
      heartbeatMs = interval;
      return timer;
    },
    clearIntervalImpl: (value) => cleared.push(value),
  });
  seedJob(db);
  runner.register("transcribe_chunk", async (_job, context) => {
    now = 2_050;
    heartbeat();
    assert.equal(
      db.prepare("SELECT lease_expires_at FROM processing_jobs WHERE id = 'j1'").get()
        .lease_expires_at,
      2_140
    );
    now = 2_120;
    assert.equal(context.renewLease(), true);
  });

  assert.equal(await runner.runOnce(2_000), 1);
  assert.equal(heartbeatMs, 30);
  assert.deepEqual(cleared, [timer]);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'j1'").get().state,
    "completed"
  );
});

test("heartbeat ownership loss aborts completion and still clears its timer", async (t) => {
  let now = 2_000;
  let heartbeat = null;
  const cleared = [];
  const timer = { unref() {} };
  const { db, store, runner } = fixture(t, {
    now: () => now,
    leaseMs: 90,
    setIntervalImpl: (callback) => {
      heartbeat = callback;
      return timer;
    },
    clearIntervalImpl: (value) => cleared.push(value),
  });
  seedJob(db);
  runner.register("transcribe_chunk", async () => {
    now = 2_090;
    assert.equal(store.recoverExpiredLeases(now), 1);
    heartbeat();
  });

  await assert.rejects(runner.runOnce(2_000), { code: "JOB_LEASE_LOST" });
  assert.deepEqual(cleared, [timer]);
  assert.deepEqual(
    db.prepare("SELECT state, error_code, lease_owner FROM processing_jobs WHERE id = 'j1'").get(),
    { state: "retry", error_code: "LEASE_EXPIRED", lease_owner: null }
  );
});

test("a final heartbeat before completion cannot race the owner transition", async (t) => {
  let now = 2_000;
  let heartbeat = null;
  const cleared = [];
  const timer = { unref() {} };
  const { db, store, runner } = fixture(t, {
    now: () => now,
    leaseMs: 90,
    setIntervalImpl: (callback) => {
      heartbeat = callback;
      return timer;
    },
    clearIntervalImpl: (value) => cleared.push(value),
  });
  seedJob(db);
  const complete = store.completeJob.bind(store);
  store.completeJob = (id, input) => {
    now = 2_050;
    heartbeat();
    return complete(id, { ...input, at: now });
  };
  runner.register("transcribe_chunk", async () => undefined);

  assert.equal(await runner.runOnce(2_000), 1);
  assert.deepEqual(cleared, [timer]);
  assert.deepEqual(
    db
      .prepare("SELECT state, completed_at, lease_owner FROM processing_jobs WHERE id = 'j1'")
      .get(),
    { state: "completed", completed_at: 2_050, lease_owner: null }
  );
});
