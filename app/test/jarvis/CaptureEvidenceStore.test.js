const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const AnalysisBudgetGuard = require("../../src/jarvis/main/AnalysisBudgetGuard");
const AnalysisBudgetRepository = require("../../src/jarvis/main/AnalysisBudgetRepository");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const DailyDigestService = require("../../src/jarvis/main/DailyDigestService");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function fixture(t, { createId } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s1', 10, 'recording', 10)"
  ).run();
  let nextId = 0;
  const store = new CaptureEvidenceStore(db, {
    createId: createId ?? ((prefix) => `${prefix}-${++nextId}`),
    now: () => 100,
  });
  t.after(() => db.close());
  return { db, store };
}

function createTrack(store, overrides = {}) {
  return store.createTrack({
    id: "t1",
    sessionId: "s1",
    sourceType: "system",
    deviceId: "device-1",
    deviceLabel: "PC audio",
    strategy: "wasapi-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
    ...overrides,
  });
}

function chunk(overrides = {}) {
  return {
    id: "c1",
    sessionId: "s1",
    trackId: "t1",
    sourceType: "system",
    sequenceNumber: 0,
    path: "c1.wav",
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    sha256: "abc",
    expiresAt: 30,
    ...overrides,
  };
}

function seedProcessingJob(db, overrides = {}) {
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, session_id, track_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count,
      next_retry_at, lease_owner, lease_expires_at, error_code,
      lane, analysis_input_id, desired_head_hash, digest_input_id, created_at, completed_at
    ) VALUES (
      @id, @sessionId, @trackId, @jobType, @state, @priority,
      @inputHash, @inputVersion, @modelVersion, @attemptCount,
      @nextRetryAt, @leaseOwner, @leaseExpiresAt, @errorCode,
      @lane, @analysisInputId, @desiredHeadHash, @digestInputId, @createdAt, @completedAt
    )
  `
  ).run({
    id: "lease-job",
    sessionId: "s1",
    trackId: null,
    jobType: "transcribe_chunk",
    state: "pending",
    priority: 0,
    inputHash: "lease-input",
    inputVersion: 1,
    modelVersion: "model-v1",
    attemptCount: 0,
    nextRetryAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    lane: "local",
    analysisInputId: null,
    desiredHeadHash: null,
    digestInputId: null,
    createdAt: 100,
    completedAt: null,
    ...overrides,
  });
}

function seedDailyDigestInput(db, overrides = {}) {
  const inputHash = overrides.inputHash ?? "9".repeat(64);
  const inputId = overrides.inputId ?? `digest-input-${inputHash.slice(0, 8)}`;
  const payload = JSON.stringify({
    schemaVersion: "jarvis-daily-digest-input-v1",
    sessions: [],
    peopleInteractions: [],
    topics: [],
    decisions: [],
    commitments: [],
    todosCreated: [],
    todosCompleted: [],
    unresolvedConflicts: [],
    transcriptCoverage: { segmentCount: 0 },
  });
  db.prepare(
    `INSERT OR IGNORE INTO daily_digest_inputs (
       id, local_date, timezone, source_hash, contract_version, completeness,
       input_watermark_json, cloud_payload_json, input_bytes, model_version, created_at
     ) VALUES (
       ?, '2026-07-17', 'Asia/Shanghai', ?, 'jarvis-daily-digest-input-v1', 'final',
       '{"schemaVersion":"jarvis-daily-digest-watermark-v1"}', ?, ?, ?, 100
     )`
  ).run(
    inputId,
    inputHash,
    payload,
    Buffer.byteLength(payload, "utf8"),
    overrides.modelVersion ?? "MiniMax-M2.7"
  );
  return { inputId, inputHash };
}

function seedCloudAnalysisRecovery(
  db,
  store,
  {
    attemptState = "reconciled",
    candidateState = "validated",
    persistCandidate = true,
    actualUsage = { inputTokens: 100, outputTokens: 100 },
  } = {}
) {
  const inputHash = "a".repeat(64);
  const desiredHeadHash = "b".repeat(64);
  const payloadHash = "c".repeat(64);
  const candidateHash = "d".repeat(64);
  const cloudPayloadJson = JSON.stringify({ inputVersion: "jarvis-analysis-input-v2" });
  const desiredVectorJson = JSON.stringify({
    analysisInputId: "analysis-input-recovery",
    analysisInputHash: inputHash,
    transcriptRevision: "e".repeat(64),
    identityRevision: "f".repeat(64),
    promptVersion: "jarvis-analysis-v2",
    responseSchemaVersion: "jarvis-analysis-v2",
    pseudonymBindingRevision: 1,
    modelVersion: "MiniMax-M2.7",
    cloudPayloadHash: payloadHash,
    segments: [],
  });
  db.prepare(
    `INSERT INTO analysis_inputs (
       id, session_id, transcript_revision, identity_revision, prompt_version,
       input_hash, input_contract_version, redaction_version, cloud_payload_json,
       cloud_payload_bytes, cloud_payload_sha256, created_at
     ) VALUES (?, 's1', ?, ?, 'jarvis-analysis-v2', ?, 'jarvis-analysis-input-v2',
       'jarvis-redaction-v1', ?, ?, ?, 100)`
  ).run(
    "analysis-input-recovery",
    "e".repeat(64),
    "f".repeat(64),
    inputHash,
    cloudPayloadJson,
    Buffer.byteLength(cloudPayloadJson, "utf8"),
    payloadHash
  );
  db.prepare(
    `INSERT INTO analysis_desired_heads (
       session_id, analysis_input_id, analysis_input_hash, desired_vector_json,
       desired_vector_hash, head_revision, created_at, updated_at
     ) VALUES ('s1', 'analysis-input-recovery', ?, ?, ?, 1, 100, 100)`
  ).run(inputHash, desiredVectorJson, desiredHeadHash);
  const job = store.enqueueCloudJob({
    sessionId: "s1",
    jobType: "analyze_session",
    analysisInputId: "analysis-input-recovery",
    desiredHeadHash,
    inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  store.claimCloudJobs({ owner: "dead-cloud-worker", at: 100, leaseMs: 100 });

  const budgetAt = Date.UTC(2026, 6, 16, 4);
  const budget = new AnalysisBudgetRepository(db);
  budget.initialize({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai", at: budgetAt });
  if (attemptState === "none") return job;
  budget.reserve({
    requestId: "analysis-request-recovery",
    jobId: job.id,
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "session_analysis",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
    at: budgetAt + 1,
  });
  if (attemptState === "reserved") return job;
  if (attemptState === "released") {
    budget.release({
      requestId: "analysis-request-recovery",
      reasonCode: "shutdown_before_transport",
      at: budgetAt + 2,
    });
    return job;
  }
  budget.markStarted({ requestId: "analysis-request-recovery", at: budgetAt + 2 });
  if (attemptState === "started") return job;
  if (attemptState === "usage_unknown") {
    budget.markUsageUnknown({
      requestId: "analysis-request-recovery",
      reasonCode: "process_recovery",
      at: budgetAt + 3,
    });
  } else if (attemptState === "reconciled") {
    budget.reconcile({
      requestId: "analysis-request-recovery",
      usage: actualUsage,
      at: budgetAt + 3,
    });
    if (!persistCandidate) return job;
    const candidateJson = JSON.stringify({ schemaVersion: "jarvis-analysis-v2" });
    db.prepare(
      `INSERT INTO analysis_response_candidates (
         id, job_id, analysis_input_id, budget_attempt_id, desired_vector_hash,
         response_schema_version, candidate_json, candidate_bytes, candidate_hash,
         state, created_at, disposition_at
       ) VALUES (
         'analysis-candidate-recovery', ?, 'analysis-input-recovery',
         'analysis-request-recovery', ?, 'jarvis-analysis-v2', ?, ?, ?, ?, 150, ?
       )`
    ).run(
      job.id,
      desiredHeadHash,
      candidateJson,
      Buffer.byteLength(candidateJson, "utf8"),
      candidateHash,
      candidateState,
      candidateState === "validated" ? null : 175
    );
    if (candidateState === "applied") {
      db.prepare(
        `UPDATE analysis_inputs SET candidate_hash = ?, applied_at = 175 WHERE id = ?`
      ).run(candidateHash, "analysis-input-recovery");
    }
  }
  return job;
}

function setPrestartRecoveryState(db, store, state) {
  if (state === "none") {
    return seedCloudAnalysisRecovery(db, store, {
      attemptState: "none",
      persistCandidate: false,
    });
  }
  if (state === "released") {
    return seedCloudAnalysisRecovery(db, store, {
      attemptState: "released",
      persistCandidate: false,
    });
  }
  if (state === "reconciled_zero" || state === "reconciled_unknown") {
    const job = seedCloudAnalysisRecovery(db, store, {
      persistCandidate: false,
      actualUsage: { inputTokens: 0, outputTokens: 0 },
    });
    if (state === "reconciled_zero") return job;
    db.exec(`
      DROP TRIGGER analysis_budget_attempts_terminal;
      DROP TRIGGER analysis_budget_attempts_validate_actual_cost;
    `);
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      `UPDATE analysis_budget_attempts
       SET actual_input_tokens = NULL, actual_output_tokens = NULL, actual_microusd = NULL
       WHERE job_id = ? AND state = 'reconciled'`
    ).run(job.id);
    db.pragma("ignore_check_constraints = OFF");
    return job;
  }
  return seedCloudAnalysisRecovery(db, store, {
    attemptState: state === "reconciled_nonzero" ? "reconciled" : state,
    persistCandidate: false,
  });
}

function seedCloudDigestRecovery(
  db,
  store,
  {
    attemptState = "reconciled",
    candidateState = "validated",
    persistCandidate = true,
    actualUsage = { inputTokens: 100, outputTokens: 100 },
    suffix = "recovery",
    candidateCreatedAt = 150,
  } = {}
) {
  const input = seedDailyDigestInput(db, {
    inputId: `digest-input-${suffix}`,
    inputHash: "8".repeat(64),
  });
  const job = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  store.claimCloudJobs({ owner: "dead-cloud-worker", at: 100, leaseMs: 100 });

  const budgetAt = Date.UTC(2026, 6, 16, 4);
  const budget = new AnalysisBudgetRepository(db);
  budget.initialize({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai", at: budgetAt });
  if (attemptState === "none") return { job, input };
  const requestId = `digest-request-${suffix}`;
  budget.reserve({
    requestId,
    jobId: job.id,
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "daily_digest",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
    at: budgetAt + 1,
  });
  if (attemptState === "reserved") return { job, input, requestId };
  if (attemptState === "released") {
    budget.release({ requestId, reasonCode: "shutdown_before_transport", at: budgetAt + 2 });
    return { job, input, requestId };
  }
  budget.markStarted({ requestId, at: budgetAt + 2 });
  if (attemptState === "started") return { job, input, requestId };
  if (attemptState === "usage_unknown") {
    budget.markUsageUnknown({ requestId, reasonCode: "process_recovery", at: budgetAt + 3 });
    return { job, input, requestId };
  }
  budget.reconcile({ requestId, usage: actualUsage, at: budgetAt + 3 });
  if (!persistCandidate) return { job, input, requestId };
  const candidateId = `digest-candidate-${suffix}`;
  const candidateJson = JSON.stringify({ schemaVersion: "jarvis-daily-digest-v1" });
  db.prepare(
    `INSERT INTO daily_digest_response_candidates (
       id, job_id, digest_input_id, budget_attempt_id, response_schema_version,
       candidate_json, candidate_bytes, candidate_hash, state, created_at, disposition_at
      ) VALUES (?, ?, ?, ?, 'jarvis-daily-digest-v1', ?, ?, ?, ?, ?, ?)`
  ).run(
    candidateId,
    job.id,
    input.inputId,
    requestId,
    candidateJson,
    Buffer.byteLength(candidateJson, "utf8"),
    "7".repeat(64),
    candidateState,
    candidateCreatedAt,
    candidateState === "validated" ? null : 175
  );
  return { job, input, requestId, candidateId };
}

test("stores track state and gap lifecycle evidence", (t) => {
  const { db, store } = fixture(t);

  createTrack(store);
  store.setTrackState("t1", "ended", 50);
  store.openGap({
    id: "g1",
    trackId: "t1",
    startedAt: 20,
    reason: "device_lost",
    recoveryAttempts: 1,
  });
  store.closeGap("g1", 40, 2);

  assert.deepEqual(db.prepare("SELECT * FROM audio_tracks WHERE id = 't1'").get(), {
    id: "t1",
    session_id: "s1",
    source_type: "system",
    application_key: null,
    application_display_name: null,
    capture_generation: 0,
    track_kind: "system_mix",
    attribution_state: "mixed_unknown",
    device_id: "device-1",
    device_label: "PC audio",
    strategy: "wasapi-loopback",
    sample_rate: 24_000,
    channels: 1,
    started_at: 10,
    ended_at: 50,
    state: "ended",
    failure_code: null,
  });
  assert.deepEqual(db.prepare("SELECT * FROM audio_gaps WHERE id = 'g1'").get(), {
    id: "g1",
    track_id: "t1",
    started_at: 20,
    ended_at: 40,
    reason: "device_lost",
    recovery_attempts: 2,
    restored_device_id: null,
    restored_device_label: null,
    restored_strategy: null,
    average_level: null,
    peak_level: null,
  });
});

test("creates requested tracks atomically", (t) => {
  const { db, store } = fixture(t);
  const system = {
    id: "t1",
    sessionId: "s1",
    sourceType: "system",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
  };

  assert.throws(
    () => store.createTracks([system, { ...system, sourceType: "mic" }]),
    /audio_tracks\.id/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 0);
});

test("stores canonical application tracks and exact/fallback attribution intervals", (t) => {
  const { store } = fixture(t);
  createTrack(store);
  createTrack(store, {
    id: "chrome-track",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 2,
    strategy: "include-process-tree",
  });

  const exact = store.createApplicationAudioInterval({
    id: "interval-exact",
    sessionId: "s1",
    trackId: "chrome-track",
    intervalKind: "application_active",
    applicationKey: "chrome",
    attributionState: "exact",
    captureGeneration: 2,
    startedAt: 20,
  });
  const fallback = store.createApplicationAudioInterval({
    id: "interval-fallback",
    sessionId: "s1",
    trackId: "t1",
    intervalKind: "mixed_fallback",
    attributionState: "mixed_unknown",
    captureGeneration: 3,
    startedAt: 30,
    reason: "application_capture_failed",
  });

  assert.equal(exact.application_key, "chrome");
  assert.equal(fallback.application_key, null);
  assert.equal(store.closeApplicationAudioInterval("interval-exact", 29).changes, 1);
  assert.deepEqual(
    store.listApplicationAudioIntervals("s1").map((interval) => ({
      id: interval.id,
      kind: interval.interval_kind,
      applicationKey: interval.application_key,
      endedAt: interval.ended_at,
    })),
    [
      {
        id: "interval-exact",
        kind: "application_active",
        applicationKey: "chrome",
        endedAt: 29,
      },
      {
        id: "interval-fallback",
        kind: "mixed_fallback",
        applicationKey: null,
        endedAt: null,
      },
    ]
  );
});

test("rejects raw paths and partial application attribution before persistence", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () =>
      createTrack(store, {
        id: "raw-path",
        applicationKey: "c:\\games\\dota2.exe",
        applicationDisplayName: "DOTA 2",
      }),
    /canonical lowercase identifier/
  );
  assert.throws(
    () =>
      createTrack(store, {
        id: "missing-name",
        applicationKey: "chrome",
      }),
    /provided together/
  );
  assert.throws(
    () =>
      createTrack(store, {
        id: "window-title",
        applicationKey: "chrome",
        applicationDisplayName: "C:\\private\\meeting.txt",
      }),
    /path data/
  );
});

test("rolls back interruption when its gap cannot be persisted", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.openGap({ id: "g1", trackId: "t1", startedAt: 11, reason: "existing" });
  store.closeGap("g1", 12, 0);

  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
      }),
    /audio_gaps\.id/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "active",
    ended_at: null,
  });
});

test("rolls back gap closure when restoration track is missing", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  assert.throws(
    () => store.restoreTrack({ trackId: "missing", gapId: "g1", endedAt: 30 }),
    /track missing/i
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );
});

test("interrupt transition rolls back track and gap when its session status write fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  db.exec(`
    CREATE TRIGGER reject_interrupt_session_status
    BEFORE UPDATE ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session status unavailable');
    END;
  `);

  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        sessionId: "s1",
        sessionStatus: "recording",
        gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
      }),
    /session status unavailable/i
  );
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "active");
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("restoration transition rolls back gap track and metadata when session status write fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  db.prepare("UPDATE sessions SET status='paused' WHERE id='s1'").run();
  db.exec(`
    CREATE TRIGGER reject_restore_session_status
    BEFORE UPDATE ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session status unavailable');
    END;
  `);

  assert.throws(
    () =>
      store.restoreTrack({
        trackId: "t1",
        gapId: "g1",
        endedAt: 30,
        sessionId: "s1",
        sessionStatus: "recording",
        deviceId: "device-2",
        deviceLabel: "Replacement output",
        strategy: "renderer-loopback",
      }),
    /session status unavailable/i
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT state, ended_at, device_id, device_label, strategy FROM audio_tracks WHERE id='t1'"
      )
      .get(),
    {
      state: "recovering",
      ended_at: 20,
      device_id: "device-1",
      device_label: "PC audio",
      strategy: "wasapi-loopback",
    }
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
});

test("restoration preserves initial track identity and timestamps replacement metadata on the gap", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  store.restoreTrack({
    trackId: "t1",
    gapId: "g1",
    endedAt: 30,
    sessionId: "s1",
    sessionStatus: "recording",
    deviceId: "device-2",
    deviceLabel: "Replacement output",
    strategy: "renderer-loopback",
  });

  assert.deepEqual(
    db
      .prepare(
        "SELECT state, ended_at, device_id, device_label, strategy FROM audio_tracks WHERE id='t1'"
      )
      .get(),
    {
      state: "active",
      ended_at: null,
      device_id: "device-1",
      device_label: "PC audio",
      strategy: "wasapi-loopback",
    }
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT ended_at, restored_device_id, restored_device_label, restored_strategy FROM audio_gaps WHERE id='g1'"
      )
      .get(),
    {
      ended_at: 30,
      restored_device_id: "device-2",
      restored_device_label: "Replacement output",
      restored_strategy: "renderer-loopback",
    }
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("rejects invalid and stale interruption evidence without mutation", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);

  for (const [name, overrides, pattern] of [
    ["unsafe time", { startedAt: 10.5 }, /safe integer/i],
    ["reversed time", { startedAt: 9 }, /before.*track/i],
    ["missing id", { id: "" }, /gap id/i],
    ["unsafe id", { id: "../g1" }, /gap id/i],
    ["wrong track", { trackId: "other" }, /does not match/i],
    ["missing reason", { reason: "" }, /reason/i],
    ["negative attempts", { recoveryAttempts: -1 }, /recoveryAttempts/i],
  ]) {
    assert.throws(
      () =>
        store.interruptTrack({
          trackId: "t1",
          gap: {
            id: "g1",
            trackId: "t1",
            startedAt: 20,
            reason: "device-change",
            recoveryAttempts: 0,
            ...overrides,
          },
        }),
      pattern,
      name
    );
  }
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "active",
    ended_at: null,
  });
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 0);

  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        gap: { id: "g2", trackId: "t1", startedAt: 21, reason: "duplicate" },
      }),
    /active/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 1);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );
});

test("rejects invalid and stale restoration evidence without mutation", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  for (const [name, overrides, pattern] of [
    ["unsafe time", { endedAt: 20.5 }, /safe integer/i],
    ["reversed time", { endedAt: 19 }, /before.*gap/i],
    ["negative attempts", { recoveryAttempts: -1 }, /recoveryAttempts/i],
    ["unsafe attempts", { recoveryAttempts: 1.5 }, /recoveryAttempts/i],
  ]) {
    assert.throws(
      () =>
        store.restoreTrack({
          trackId: "t1",
          gapId: "g1",
          endedAt: 30,
          recoveryAttempts: 1,
          ...overrides,
        }),
      pattern,
      name
    );
  }
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );

  store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 30, recoveryAttempts: 1 });
  assert.throws(
    () => store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 40, recoveryAttempts: 2 }),
    /recovering|open/i
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, 30);
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "active");
});

test("restoration target state defaults active and accepts only active or paused", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  for (const [trackId, gapId] of [
    ["t1", "g1"],
    ["t2", "g2"],
  ]) {
    store.interruptTrack({
      trackId,
      gap: { id: gapId, trackId, startedAt: 20, reason: "device-change" },
    });
  }

  const active = store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 30 });
  const paused = store.restoreTrack({
    trackId: "t2",
    gapId: "g2",
    endedAt: 31,
    targetState: "paused",
  });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g3", trackId: "t1", startedAt: 32, reason: "device-change" },
  });
  assert.throws(
    () =>
      store.restoreTrack({
        trackId: "t1",
        gapId: "g3",
        endedAt: 33,
        targetState: "recovering",
      }),
    /target state/i
  );

  assert.equal(active.targetState, "active");
  assert.equal(paused.targetState, "paused");
  assert.deepEqual(db.prepare("SELECT id, state, ended_at FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering", ended_at: 32 },
    { id: "t2", state: "paused", ended_at: 31 },
  ]);
  assert.deepEqual(db.prepare("SELECT id, ended_at FROM audio_gaps ORDER BY id").all(), [
    { id: "g1", ended_at: 30 },
    { id: "g2", ended_at: 31 },
    { id: "g3", ended_at: null },
  ]);
});

test("finalizes gaps tracks and session atomically", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  db.exec(`
    CREATE TRIGGER reject_session_finalization
    BEFORE UPDATE OF status ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session finalization blocked');
    END
  `);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: "g1" }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /session finalization blocked/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "recovering",
    ended_at: 20,
  });
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "recording",
    ended_at: null,
  });
});

test("finalization requires every session track and derives every open gap", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t2", gapId: null }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /every session track/i
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "active" },
  ]);

  store.finalizeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", gapId: null },
      { trackId: "t2", gapId: null },
    ],
    trackState: "failed",
    sessionStatus: "failed",
    at: 30,
  });
  assert.equal(
    db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get().count,
    0
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "failed" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "failed");
});

test("pauses every active track and the session atomically", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  db.exec(`
    CREATE TRIGGER reject_second_track_pause
    BEFORE UPDATE OF state ON audio_tracks
    WHEN NEW.id = 't2' AND NEW.state = 'paused'
    BEGIN
      SELECT RAISE(ABORT, 'second track pause blocked');
    END
  `);

  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 20,
      }),
    /second track pause blocked/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "active" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("pause requires exact ownership coverage chronology and current states", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });

  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", expectedState: "active" }],
        at: 20,
      }),
    /every session track/i
  );
  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 20,
      }),
    /expected state/i
  );
  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 9,
      }),
    /session startedAt/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "active" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("pause and resume ignore application tracks that already ended", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, {
    id: "app-t1",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 1,
    deviceId: null,
    deviceLabel: null,
    strategy: "wasapi-application-loopback",
  });
  store.setTrackState("app-t1", "ended", 18);

  store.pauseCapture({
    sessionId: "s1",
    sources: [{ trackId: "t1", expectedState: "active" }],
    at: 20,
  });
  store.resumeCapture({
    sessionId: "s1",
    sources: [{ trackId: "t1", expectedState: "paused" }],
    at: 30,
  });

  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='app-t1'").get(), {
    state: "ended",
    ended_at: 18,
  });
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "active",
    ended_at: null,
  });
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("resume rolls back all track activations when session persistence fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "active" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 20,
  });
  db.exec(`
    CREATE TRIGGER reject_session_resume
    BEFORE UPDATE OF status ON sessions
    WHEN NEW.status = 'recording'
    BEGIN
      SELECT RAISE(ABORT, 'session resume blocked');
    END
  `);

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "paused" },
        ],
        at: 30,
      }),
    /session resume blocked/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "paused" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
});

test("resume requires exact ownership coverage chronology and current states", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "active" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 20,
  });
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s2', 10, 'paused', 10)"
  ).run();
  createTrack(store, { id: "t3", sessionId: "s2", sourceType: "mic", deviceId: "other" });
  store.setTrackState("t3", "paused", 20);

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", expectedState: "paused" }],
        at: 30,
      }),
    /every session track/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "paused" },
        ],
        at: 19,
      }),
    /track endedAt/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 30,
      }),
    /expected state/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t3", expectedState: "paused" },
        ],
        at: 30,
      }),
    /does not belong/i
  );
  assert.deepEqual(
    db.prepare("SELECT id, state FROM audio_tracks WHERE session_id='s1' ORDER BY id").all(),
    [
      { id: "t1", state: "paused" },
      { id: "t2", state: "paused" },
    ]
  );

  store.resumeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "paused" },
      { trackId: "t2", expectedState: "paused" },
    ],
    at: 30,
  });
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 40,
      }),
    /must be paused/i
  );
});

test("pause and resume retain recovering tracks and their open gaps", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 30,
  });
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "paused" },
  ]);
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);

  store.resumeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "paused" },
    ],
    at: 40,
  });
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "active" },
  ]);
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("resume rejects atomically when all tracks are recovering", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  for (const [trackId, gapId] of [
    ["t1", "g1"],
    ["t2", "g2"],
  ]) {
    store.interruptTrack({
      trackId,
      gap: { id: gapId, trackId, startedAt: 20, reason: "device-change" },
    });
  }
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "recovering" },
    ],
    at: 30,
  });

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "recovering" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 40,
      }),
    /paused track/i
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "recovering" },
  ]);
  assert.deepEqual(db.prepare("SELECT id, ended_at FROM audio_gaps ORDER BY id").all(), [
    { id: "g1", ended_at: null },
    { id: "g2", ended_at: null },
  ]);
});

test("finalization rejects timestamps before session start without tracks", (t) => {
  const { db, store } = fixture(t);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [],
        trackState: "recovered",
        sessionStatus: "recovered",
        at: 9,
      }),
    /session startedAt/i
  );
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "recording",
    ended_at: null,
  });
});

test("finalization rejects timestamps before a prior track end", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.setTrackState("t1", "paused", 30);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: null }],
        trackState: "ended",
        sessionStatus: "completed",
        at: 29,
      }),
    /track endedAt/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "paused",
    ended_at: 30,
  });
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("finalization preserves an application track's earlier terminal boundary", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, {
    id: "app-t1",
    applicationKey: "kook",
    applicationDisplayName: "KOOK",
    captureGeneration: 1,
    deviceId: null,
    deviceLabel: null,
    strategy: "wasapi-application-loopback",
  });
  store.setTrackState("app-t1", "ended", 18);

  store.finalizeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", gapId: null },
      { trackId: "app-t1", gapId: null },
    ],
    trackState: "ended",
    sessionStatus: "completed",
    at: 40,
  });

  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='app-t1'").get(), {
    state: "ended",
    ended_at: 18,
  });
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "ended",
    ended_at: 40,
  });
});

test("finalization rejects stale repeated terminal transitions", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.finalizeCapture({
    sessionId: "s1",
    sources: [{ trackId: "t1", gapId: null }],
    trackState: "ended",
    sessionStatus: "completed",
    at: 20,
  });

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: null }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /already terminal/i
  );
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "completed",
    ended_at: 20,
  });
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "ended",
    ended_at: 20,
  });
});

for (const [sessionStatus, trackState] of [
  ["recovered", "recovered"],
  ["failed", "failed"],
]) {
  test(`finalization rejects an already ${sessionStatus} session`, (t) => {
    const { db, store } = fixture(t);
    createTrack(store);
    store.finalizeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", gapId: null }],
      trackState,
      sessionStatus,
      at: 20,
    });

    assert.throws(
      () =>
        store.finalizeCapture({
          sessionId: "s1",
          sources: [{ trackId: "t1", gapId: null }],
          trackState,
          sessionStatus,
          at: 30,
        }),
      /already terminal/i
    );
    assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
      status: sessionStatus,
      ended_at: 20,
    });
  });
}

test("commits a chunk and one transcription job atomically", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  store.commitChunk(chunk());

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(
    db
      .prepare("SELECT count(*) count FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
      .get().count,
    1
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT track_id, source_type, sequence_number, transcription_status, write_state FROM audio_chunks"
      )
      .get(),
    {
      track_id: "t1",
      source_type: "system",
      sequence_number: 0,
      transcription_status: "pending",
      write_state: "committed",
    }
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT session_id, track_id, chunk_id, job_type, state, priority, input_hash, created_at FROM processing_jobs"
      )
      .get(),
    {
      session_id: "s1",
      track_id: "t1",
      chunk_id: "c1",
      job_type: "transcribe_chunk",
      state: "pending",
      priority: 30,
      input_hash: "abc",
      created_at: 100,
    }
  );
});

test("rejects duplicate track sequence without a partial chunk or job", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(
    () =>
      store.commitChunk(
        chunk({
          id: "c2",
          sequenceNumber: 0,
          path: "c2.wav",
          startedAt: 20,
          endedAt: 30,
          sha256: "def",
          expiresAt: 40,
        })
      ),
    /sequence/i
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
  assert.equal(db.prepare("SELECT id FROM audio_chunks").get().id, "c1");
});

test("creates distinct jobs for time-positioned chunks with identical PCM hashes", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  store.commitChunk(
    chunk({
      id: "c2",
      sequenceNumber: 1,
      path: "c2.wav",
      startedAt: 20,
      endedAt: 30,
    })
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 2);
  assert.deepEqual(
    db
      .prepare("SELECT chunk_id FROM processing_jobs ORDER BY chunk_id")
      .all()
      .map((row) => row.chunk_id),
    ["c1", "c2"]
  );
});

test("rolls back transcription creation when the chunk insert fails", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(() =>
    store.commitChunk(
      chunk({
        id: "c2",
        sequenceNumber: 1,
        path: "c1.wav",
        sha256: "def",
      })
    )
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("rolls back the inserted chunk when job creation fails", (t) => {
  const { store, db } = fixture(t, { createId: () => "job-fixed" });
  createTrack(store);
  db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'job-fixed', 's1', 't1', NULL, 'seed_job', 'pending', 'seed', 1, '', 1
    )`
  ).run();

  assert.throws(() => store.commitChunk(chunk()), /processing_jobs\.id/i);

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("enqueueChunkTranscription is idempotent by transcription input", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  db.prepare(
    `INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state
    ) VALUES (
      @id, @sessionId, @trackId, @sourceType, @sequenceNumber, @path,
      @startedAt, @endedAt, @durationMs, @sha256, @expiresAt,
      'pending', 'committed'
    )`
  ).run(chunk());

  const first = store.enqueueChunkTranscription(chunk());
  const duplicate = store.enqueueChunkTranscription(chunk());

  assert.equal(first.id, "job-1");
  assert.equal(duplicate.id, first.id);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("current-model reconciliation supersedes an unstarted legacy job without rewriting history", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000 }));
  const legacy = db
    .prepare("SELECT * FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
    .get();
  db.prepare("UPDATE sessions SET processing_state = 'ready', ready_at = 90 WHERE id = 's1'").run();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "current-model",
      at: 100,
    }),
    { enqueued: 1, superseded: 1 }
  );
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "current-model",
      at: 100,
    }),
    { enqueued: 0, superseded: 0 }
  );

  const jobs = db
    .prepare(
      `SELECT id, state, input_hash, input_version, model_version,
              attempt_count, error_code, completed_at
       FROM processing_jobs
       WHERE job_type = 'transcribe_chunk'
       ORDER BY model_version`
    )
    .all();
  assert.deepEqual(jobs, [
    {
      id: legacy.id,
      state: "superseded",
      input_hash: legacy.input_hash,
      input_version: legacy.input_version,
      model_version: "",
      attempt_count: 0,
      error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
      completed_at: 100,
    },
    {
      id: "job-2",
      state: "pending",
      input_hash: legacy.input_hash,
      input_version: 1,
      model_version: "current-model",
      attempt_count: 0,
      error_code: null,
      completed_at: null,
    },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT processing_state, ready_at, timeline_version FROM sessions WHERE id = 's1'")
      .get(),
    { processing_state: "processing", ready_at: null, timeline_version: 2 }
  );
});

test("current-model reconciliation recovers an expired legacy lease before replacing it", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-v1" }));
  const legacy = db
    .prepare("SELECT * FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
    .get();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', attempt_count = 1,
         lease_owner = 'dead-worker', lease_expires_at = 99
     WHERE id = ?`
  ).run(legacy.id);

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-v2",
      at: 100,
    }),
    { enqueued: 1, superseded: 1 }
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, model_version, attempt_count, error_code,
                lease_owner, lease_expires_at
         FROM processing_jobs
         WHERE job_type = 'transcribe_chunk'
         ORDER BY model_version`
      )
      .all(),
    [
      {
        id: legacy.id,
        state: "superseded",
        model_version: "model-v1",
        attempt_count: 1,
        error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "job-2",
        state: "pending",
        model_version: "model-v2",
        attempt_count: 0,
        error_code: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
  );
});

test("current-model reconciliation exempts only a live legacy lease", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-v1" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', attempt_count = 1,
         lease_owner = 'live-worker', lease_expires_at = 101
     WHERE job_type = 'transcribe_chunk'`
  ).run();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-v2",
      at: 100,
    }),
    { enqueued: 0, superseded: 0 }
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM processing_jobs").get().count, 1);

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-v2",
      at: 101,
    }),
    { enqueued: 1, superseded: 1 }
  );
});

test("model changes append one current transcription revision and preserve completed identity", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-v1" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 90, attempt_count = 1
     WHERE job_type = 'transcribe_chunk'`
  ).run();
  const historical = db
    .prepare("SELECT * FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
    .get();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-v2",
      at: 100,
    }),
    { enqueued: 1, superseded: 0 }
  );
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-v2",
      at: 100,
    }),
    { enqueued: 0, superseded: 0 }
  );

  const rows = db
    .prepare(
      `SELECT id, state, input_hash, input_version, model_version,
              attempt_count, error_code, completed_at
       FROM processing_jobs
       WHERE job_type = 'transcribe_chunk'
       ORDER BY model_version`
    )
    .all();
  assert.deepEqual(rows[0], {
    id: historical.id,
    state: historical.state,
    input_hash: historical.input_hash,
    input_version: historical.input_version,
    model_version: historical.model_version,
    attempt_count: historical.attempt_count,
    error_code: historical.error_code,
    completed_at: historical.completed_at,
  });
  assert.deepEqual(rows[1], {
    id: "job-2",
    state: "pending",
    input_hash: historical.input_hash,
    input_version: 1,
    model_version: "model-v2",
    attempt_count: 0,
    error_code: null,
    completed_at: null,
  });
});

test("model rollback A to B to A reactivates the audited A job idempotently", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-a" }));
  const modelA = db
    .prepare("SELECT * FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
    .get();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'retry', attempt_count = 2,
         next_retry_at = 500, error_code = 'TRANSIENT'
     WHERE id = ?`
  ).run(modelA.id);

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-b",
      at: 100,
    }),
    { enqueued: 1, superseded: 1 }
  );
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 1, superseded: 1 }
  );
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 0 }
  );

  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, model_version, attempt_count, next_retry_at,
                error_code, completed_at, lease_owner, lease_expires_at
         FROM processing_jobs
         WHERE job_type = 'transcribe_chunk'
         ORDER BY model_version`
      )
      .all(),
    [
      {
        id: modelA.id,
        state: "retry",
        model_version: "model-a",
        attempt_count: 2,
        next_retry_at: 110,
        error_code: null,
        completed_at: null,
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "job-2",
        state: "superseded",
        model_version: "model-b",
        attempt_count: 0,
        next_retry_at: null,
        error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
        completed_at: 110,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
  );
});

test("model rollback keeps completed A byte-for-byte while superseding pending B", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-a" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', attempt_count = 1, completed_at = 90,
         execution_device = 'cpu'
     WHERE job_type = 'transcribe_chunk'`
  ).run();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-b",
      at: 100,
    }),
    { enqueued: 1, superseded: 0 }
  );
  const modelA = db.prepare("SELECT * FROM processing_jobs WHERE model_version = 'model-a'").get();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 1 }
  );
  assert.deepEqual(db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(modelA.id), modelA);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, completed_at, error_code
         FROM processing_jobs WHERE model_version = 'model-b'`
      )
      .get(),
    {
      state: "superseded",
      attempt_count: 0,
      completed_at: 110,
      error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
    }
  );
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 0 }
  );
});

test("completed A rollback waits for a live B lease and supersedes B at expiry", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-a" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', attempt_count = 1, completed_at = 90
     WHERE job_type = 'transcribe_chunk'`
  ).run();
  store.enqueueCurrentModelTranscriptionJobs({
    inputVersion: 1,
    modelVersion: "model-b",
    at: 100,
  });
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', attempt_count = 1,
         lease_owner = 'live-worker', lease_expires_at = 111
     WHERE model_version = 'model-b'`
  ).run();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 0 }
  );
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE model_version = 'model-b'").get().state,
    "running"
  );

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 111,
    }),
    { enqueued: 0, superseded: 1 }
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, lease_owner, lease_expires_at, error_code
         FROM processing_jobs WHERE model_version = 'model-b'`
      )
      .get(),
    {
      state: "superseded",
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at: null,
      error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
    }
  );
});

test("current live A remains owned while rollback supersedes pending B", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, modelVersion: "model-a" }));
  store.enqueueCurrentModelTranscriptionJobs({
    inputVersion: 1,
    modelVersion: "model-b",
    at: 100,
  });
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', attempt_count = 1, completed_at = NULL,
         next_retry_at = NULL, lease_owner = 'worker-a', lease_expires_at = 120,
         error_code = NULL
     WHERE model_version = 'model-a'`
  ).run();
  const modelA = db.prepare("SELECT * FROM processing_jobs WHERE model_version = 'model-a'").get();

  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 1 }
  );
  assert.deepEqual(db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(modelA.id), modelA);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, completed_at, error_code
         FROM processing_jobs WHERE model_version = 'model-b'`
      )
      .get(),
    {
      state: "superseded",
      attempt_count: 0,
      completed_at: 110,
      error_code: "TRANSCRIPTION_MODEL_SUPERSEDED",
    }
  );
  assert.deepEqual(store.claimJobs({ owner: "worker-b", at: 110, leaseMs: 10, limit: 1 }), []);
  assert.deepEqual(
    store.enqueueCurrentModelTranscriptionJobs({
      inputVersion: 1,
      modelVersion: "model-a",
      at: 110,
    }),
    { enqueued: 0, superseded: 0 }
  );
});

test("rejects every transcription enqueue after a chunk is tombstoned", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  store.tombstoneChunk("c1", 200);

  assert.throws(() => store.enqueueChunkTranscription(chunk()), /deleted/i);
  assert.throws(
    () =>
      store.enqueueChunkTranscription(
        chunk({ inputVersion: 2, modelVersion: "replacement-model" })
      ),
    /deleted/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE chunk_id = 'c1'").get().state,
    "audio_expired_before_processing"
  );
});

test("rejects chunks whose track session or source does not match", (t) => {
  const { store, db } = fixture(t);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s2', 10, 'recording', 10)"
  ).run();
  createTrack(store);

  assert.throws(() => store.commitChunk(chunk({ sessionId: "s2" })), /session/i);
  assert.throws(() => store.commitChunk(chunk({ sourceType: "mic" })), /source/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects a chunk that starts before its persisted track or session", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () => store.commitChunk(chunk({ startedAt: 9, endedAt: 19, durationMs: 10, expiresAt: 30 })),
    /before.*track or session/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects a chunk that ends after its persisted track or session", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.setTrackState("t1", "ended", 20);
  db.prepare("UPDATE sessions SET status='completed', ended_at=20 WHERE id='s1'").run();

  assert.throws(
    () => store.commitChunk(chunk({ startedAt: 20, endedAt: 21, durationMs: 1, expiresAt: 30 })),
    /after.*track or session/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects enqueue metadata that does not match the persisted chunk", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(() => store.enqueueChunkTranscription(chunk({ sessionId: "other" })), /session/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ trackId: "other" })), /track/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ sourceType: "mic" })), /source/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ sha256: "other" })), /hash/i);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("accepts only 24 kHz mono evidence tracks", (t) => {
  const { store, db } = fixture(t);

  assert.throws(() => createTrack(store, { sampleRate: 16_000 }), /24 kHz/i);
  assert.throws(() => createTrack(store, { channels: 2 }), /mono/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 0);
});

test("rejects invalid chunk duration and retention deadlines", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  assert.throws(() => store.commitChunk(chunk({ endedAt: 10, durationMs: 0 })), /positive/i);
  assert.throws(
    () =>
      store.commitChunk(
        chunk({ endedAt: 60_011, durationMs: 60_001, expiresAt: 60_011 + sevenDaysMs })
      ),
    /60000/i
  );
  assert.throws(() => store.commitChunk(chunk({ expiresAt: 20 + sevenDaysMs + 1 })), /seven days/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects an actual capture span over 60000 ms", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () =>
      store.commitChunk(
        chunk({ startedAt: 10, endedAt: 120_010, durationMs: 60_000, expiresAt: 120_020 })
      ),
    /capture span.*60000/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("requires durationMs to equal the integer capture span", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () => store.commitChunk(chunk({ endedAt: 30, durationMs: 19, expiresAt: 40 })),
    /durationMs.*capture span/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("tombstones multiple chunks once while retaining evidence metadata", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  store.commitChunk(chunk({ id: "c2", sequenceNumber: 1, path: "c2.wav", sha256: "def" }));

  assert.equal(store.tombstoneChunk("c1", 200).changes, 1);
  assert.equal(store.tombstoneChunk("c2", 201).changes, 1);
  assert.equal(store.tombstoneChunk("c1", 300).changes, 0);

  const rows = db.prepare("SELECT * FROM audio_chunks ORDER BY id").all();
  assert.equal(rows[0].path, "tombstone:c1");
  assert.equal(rows[0].deleted_at, 200);
  assert.equal(rows[0].sha256, "abc");
  assert.equal(rows[0].started_at, 10);
  assert.equal(rows[1].path, "tombstone:c2");
  assert.equal(rows[1].deleted_at, 201);
});

test("tombstoning atomically expires unfinished chunk jobs without rewriting terminal jobs", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const inputs = [
    ["pending", "pending", null],
    ["running", "running", null],
    ["retry", "retry", null],
    ["completed", "completed", 88],
    ["failed", "failed", 89],
  ];
  inputs.forEach(([id], index) => {
    store.commitChunk(
      chunk({
        id: `c-${id}`,
        sequenceNumber: index,
        path: `${id}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: id,
        expiresAt: 100,
      })
    );
  });
  for (const [id, state, completedAt] of inputs) {
    db.prepare(
      `UPDATE processing_jobs
       SET state = ?, completed_at = ?, lease_owner = 'worker', lease_expires_at = 999,
           next_retry_at = 500
       WHERE chunk_id = ?`
    ).run(state, completedAt, `c-${id}`);
  }
  db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, input_hash, created_at
    ) VALUES ('diarize-pending', 's1', 't1', 'c-pending', 'diarize_chunk', 'pending', 'diarize', 1)`
  ).run();

  for (const [id] of inputs) store.tombstoneChunk(`c-${id}`, 200);

  const jobs = db
    .prepare(
      `SELECT chunk_id, state, error_code, completed_at, lease_owner, lease_expires_at,
              next_retry_at
       FROM processing_jobs ORDER BY chunk_id`
    )
    .all();
  for (const row of jobs.filter((job) =>
    ["c-pending", "c-retry", "c-running"].includes(job.chunk_id)
  )) {
    assert.equal(row.state, "audio_expired_before_processing");
    assert.equal(row.error_code, "audio_expired_before_processing");
    assert.equal(row.completed_at, 200);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.next_retry_at, null);
  }
  assert.equal(jobs.filter((job) => job.chunk_id === "c-pending").length, 2);
  assert.deepEqual(
    jobs.find((job) => job.chunk_id === "c-completed"),
    {
      chunk_id: "c-completed",
      state: "completed",
      error_code: null,
      completed_at: 88,
      lease_owner: "worker",
      lease_expires_at: 999,
      next_retry_at: 500,
    }
  );
  assert.equal(jobs.find((job) => job.chunk_id === "c-failed").state, "failed");
});

test("promotes only unfinished transcription jobs strictly inside the 24-hour urgency range", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const expiries = [100, 101, 200, 201];
  expiries.forEach((expiresAt, index) => {
    store.commitChunk(
      chunk({
        id: `c${index}`,
        sequenceNumber: index,
        path: `c${index}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: `hash${index}`,
        expiresAt,
      })
    );
  });
  db.prepare(
    "UPDATE processing_jobs SET state = 'completed', completed_at = 50 WHERE chunk_id = 'c2'"
  ).run();

  assert.equal(store.promoteSoonExpiringAudioJobs(100, 200), 1);
  assert.equal(store.promoteSoonExpiringAudioJobs(100, 200), 0);
  assert.deepEqual(
    db.prepare("SELECT chunk_id, state, priority FROM processing_jobs ORDER BY chunk_id").all(),
    [
      { chunk_id: "c0", state: "pending", priority: 30 },
      { chunk_id: "c1", state: "retention_urgent", priority: 0 },
      { chunk_id: "c2", state: "completed", priority: 30 },
      { chunk_id: "c3", state: "pending", priority: 30 },
    ]
  );
});

test("promotes live WAV compression jobs for storage recovery idempotently", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  for (let index = 0; index < 4; index += 1) {
    store.commitChunk(
      chunk({
        id: `c${index}`,
        sequenceNumber: index,
        path: `c${index}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: `hash${index}`,
        expiresAt: 1_000,
        encoderVersion: "flac-v1",
      })
    );
  }
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'retry', next_retry_at = 900, blocked_reason = 'resource_busy',
         error_code = 'PRIOR_FAILURE'
     WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'`
  ).run();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', lease_owner = 'worker-a', lease_expires_at = 900
     WHERE chunk_id = 'c2' AND job_type = 'compress_chunk'`
  ).run();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 90
     WHERE chunk_id = 'c3' AND job_type = 'compress_chunk'`
  ).run();

  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 2);
  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 0);
  assert.deepEqual(
    db
      .prepare(
        `SELECT chunk_id, state, priority, next_retry_at, blocked_reason, error_code
         FROM processing_jobs
         WHERE job_type = 'compress_chunk'
         ORDER BY chunk_id`
      )
      .all(),
    [
      {
        chunk_id: "c0",
        state: "storage_recovery_compress",
        priority: 10,
        next_retry_at: 100,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c1",
        state: "storage_recovery_compress",
        priority: 10,
        next_retry_at: 100,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c2",
        state: "running",
        priority: 60,
        next_retry_at: null,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c3",
        state: "completed",
        priority: 60,
        next_retry_at: null,
        blocked_reason: null,
        error_code: null,
      },
    ]
  );
});

test("storage pressure preserves backoff after an already-promoted job is deferred", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(
    chunk({
      expiresAt: 1_000,
      encoderVersion: "flac-v1",
    })
  );
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 50
     WHERE chunk_id = 'c1' AND job_type = 'transcribe_chunk'`
  ).run();

  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 1);
  const [claimed] = store.claimJobs({ owner: "worker-a", at: 100, leaseMs: 100, limit: 1 });
  assert.equal(claimed.job_type, "compress_chunk");
  assert.equal(
    store.deferJob(claimed.id, {
      owner: "worker-a",
      at: 101,
      nextRetryAt: 116,
      reason: "cpu_load_high",
    }),
    true
  );

  assert.equal(store.promoteCompressionJobsForStoragePressure(102), 0);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, priority, next_retry_at, blocked_reason, error_code
         FROM processing_jobs WHERE id = ?`
      )
      .get(claimed.id),
    {
      state: "retry",
      priority: 10,
      next_retry_at: 116,
      blocked_reason: "cpu_load_high",
      error_code: null,
    }
  );
});

test("leased FLAC promotion rejects expiry and leaves terminal ownership to the runner", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, encoderVersion: "flac-v1" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 50
     WHERE chunk_id = 'c1' AND job_type = 'transcribe_chunk'`
  ).run();
  const compressionJob = db
    .prepare("SELECT id FROM processing_jobs WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'")
    .get();
  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 100, leaseMs: 100, limit: 1 })[0].id,
    compressionJob.id
  );
  const promotion = {
    chunkId: "c1",
    jobId: compressionJob.id,
    owner: "worker-a",
    encoderVersion: "flac-v1",
    pcmSha256: "abc",
    wavPath: "c1.wav",
    flacPath: "c1.flac",
    fileSha256: "def",
    fileBytes: 40,
    sampleRate: 24_000,
    channels: 1,
  };

  assert.equal(store.promoteLeasedChunkToFlac({ ...promotion, completedAt: 200 }), null);
  assert.deepEqual(db.prepare("SELECT path, format FROM audio_chunks WHERE id = 'c1'").get(), {
    path: "c1.wav",
    format: "wav",
  });

  assert.equal(store.recoverExpiredLeases(200), 1);
  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 200, leaseMs: 100, limit: 1 })[0].id,
    compressionJob.id
  );
  const promoted = store.promoteLeasedChunkToFlac({ ...promotion, completedAt: 201 });
  assert.equal(promoted.format, "flac");
  assert.deepEqual(
    db
      .prepare("SELECT state, lease_owner, completed_at FROM processing_jobs WHERE id = ?")
      .get(compressionJob.id),
    { state: "running", lease_owner: "worker-a", completed_at: null }
  );
  assert.equal(
    store.completeJob(compressionJob.id, {
      owner: "worker-a",
      at: 202,
      executionDevice: "cpu",
    }),
    true
  );
  assert.equal(
    store.completeJob(compressionJob.id, {
      owner: "worker-a",
      at: 203,
      executionDevice: "cpu",
    }),
    false
  );
});

test("records idempotent signed storage growth and deletion telemetry in evidence transactions", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(
    chunk({
      expiresAt: 1_000,
      fileBytes: 144,
      encoderVersion: "test-flac-v1",
    })
  );
  const job = db
    .prepare("SELECT id FROM processing_jobs WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'")
    .get();
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT job_type, priority
      FROM processing_jobs WHERE chunk_id = 'c1' ORDER BY job_type
    `
      )
      .all(),
    [
      { job_type: "compress_chunk", priority: 60 },
      { job_type: "transcribe_chunk", priority: 30 },
    ]
  );

  store.promoteChunkToFlac({
    chunkId: "c1",
    jobId: job.id,
    encoderVersion: "test-flac-v1",
    pcmSha256: "abc",
    wavPath: "c1.wav",
    flacPath: "c1.flac",
    fileSha256: "def",
    fileBytes: 40,
    sampleRate: 24_000,
    channels: 1,
    completedAt: 200,
  });
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, blocked_reason, error_code, execution_device
      FROM processing_jobs WHERE id = ?
    `
      )
      .get(job.id),
    {
      state: "completed",
      blocked_reason: null,
      error_code: null,
      execution_device: "cpu",
    }
  );
  db.prepare(
    `
    UPDATE audio_chunks
    SET retired_path = 'c1.wav', retired_format = 'wav',
        retired_file_sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    WHERE id = 'c1'
  `
  ).run();
  const retiredIdentity = {
    chunkId: "c1",
    retiredPath: "c1.wav",
    retiredFileSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    occurredAt: 201,
  };
  assert.equal(store.clearRetiredArtifact(retiredIdentity), 1);
  assert.equal(store.clearRetiredArtifact(retiredIdentity), 0);
  assert.equal(store.tombstoneChunk("c1", 202, { storageDeleted: true }).changes, 1);
  assert.equal(store.tombstoneChunk("c1", 203, { storageDeleted: true }).changes, 0);

  assert.deepEqual(
    db
      .prepare(
        `
      SELECT kind, chunk_id, bytes, delta_bytes, occurred_at
      FROM storage_usage_events ORDER BY occurred_at
    `
      )
      .all(),
    [
      { kind: "wav_written", chunk_id: "c1", bytes: 144, delta_bytes: 144, occurred_at: 20 },
      { kind: "flac_written", chunk_id: "c1", bytes: 40, delta_bytes: 40, occurred_at: 200 },
      {
        kind: "retired_deleted",
        chunk_id: "c1",
        bytes: 144,
        delta_bytes: -144,
        occurred_at: 201,
      },
      {
        kind: "retention_deleted",
        chunk_id: "c1",
        bytes: 40,
        delta_bytes: -40,
        occurred_at: 202,
      },
    ]
  );
});

test("rolls back a tombstone when unfinished job termination fails", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  db.exec(`
    CREATE TRIGGER reject_retention_job_update
    BEFORE UPDATE ON processing_jobs
    BEGIN
      SELECT RAISE(ABORT, 'job update rejected');
    END;
  `);

  assert.throws(() => store.tombstoneChunk("c1", 200), /job update rejected/i);
  assert.deepEqual(db.prepare("SELECT path, deleted_at FROM audio_chunks WHERE id = 'c1'").get(), {
    path: "c1.wav",
    deleted_at: null,
  });
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE chunk_id = 'c1'").get().state,
    "pending"
  );
});

test("JarvisRepository delegates the complete capture evidence interface", () => {
  const repository = new JarvisRepository(":memory:");
  try {
    repository.createSession({ id: "s1", startedAt: 10, micDeviceId: null });
    repository.createTrack({
      id: "t1",
      sessionId: "s1",
      sourceType: "system",
      strategy: "wasapi-loopback",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 10,
    });
    repository.createTracks([]);
    repository.interruptTrack({
      trackId: "t1",
      gap: { id: "g1", trackId: "t1", startedAt: 11, reason: "device_lost" },
    });
    repository.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 12, recoveryAttempts: 1 });
    repository.pauseCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", expectedState: "active" }],
      at: 12,
    });
    repository.resumeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", expectedState: "paused" }],
      at: 12,
    });
    repository.finalizeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", gapId: null }],
      trackState: "ended",
      sessionStatus: "completed",
      at: 20,
    });
    repository.commitChunk(chunk({ fileBytes: 144 }));
    const job = repository.enqueueChunkTranscription(chunk());
    repository.tombstoneChunk("c1", 200);

    assert.equal(repository.db.prepare("SELECT state FROM audio_tracks").get().state, "ended");
    assert.equal(repository.db.prepare("SELECT ended_at FROM audio_gaps").get().ended_at, 12);
    assert.equal(repository.getSession("s1").status, "completed");
    assert.equal(job.job_type, "transcribe_chunk");
    assert.equal(repository.getAudioChunk("c1").deleted_at, 200);
    assert.deepEqual(repository.getStorageUsageSince(20), {
      writtenBytes24h: 144,
      compressedBytes24h: 0,
      netGrowthBytes24h: 144,
    });
    assert.deepEqual(repository.getStorageUsageSince(21), {
      writtenBytes24h: 0,
      compressedBytes24h: 0,
      netGrowthBytes24h: 0,
    });
    assert.deepEqual(
      repository.listRetiredArtifactBacklog().map((row) => ({
        id: row.id,
        retired_path: row.retired_path,
        retired_file_sha256: row.retired_file_sha256,
      })),
      [{ id: "c1", retired_path: "c1.wav", retired_file_sha256: null }]
    );
    assert.equal(Object.hasOwn(repository.getAudioChunk("c1"), "retired_path"), false);
  } finally {
    repository.close();
  }
});

test("claims eligible jobs atomically in deterministic order without stealing leases", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, { id: "job-b", priority: 30, createdAt: 100 });
  seedProcessingJob(db, {
    id: "job-a",
    priority: 30,
    createdAt: 100,
    inputHash: "input-a",
  });
  seedProcessingJob(db, {
    id: "job-urgent",
    state: "retention_urgent",
    priority: 0,
    createdAt: 999,
    inputHash: "input-urgent",
  });
  seedProcessingJob(db, {
    id: "job-compress",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    createdAt: 50,
    inputHash: "input-compress",
  });
  seedProcessingJob(db, {
    id: "job-current",
    state: "running",
    inputHash: "input-current",
    leaseOwner: "worker-a",
    leaseExpiresAt: 501,
  });
  seedProcessingJob(db, {
    id: "job-later",
    state: "retry",
    inputHash: "input-later",
    nextRetryAt: 501,
  });

  const claimed = store.claimJobs({ owner: "worker-b", at: 500, leaseMs: 100, limit: 4 });

  assert.deepEqual(
    claimed.map((job) => job.id),
    ["job-urgent", "job-compress", "job-a", "job-b"]
  );
  for (const job of claimed) {
    assert.equal(job.state, "running");
    assert.equal(job.attempt_count, 1);
    assert.equal(job.lease_owner, "worker-b");
    assert.equal(job.lease_expires_at, 600);
  }
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id IN ('job-current', 'job-later') ORDER BY id
    `
      )
      .all(),
    [
      { id: "job-current", state: "running", lease_owner: "worker-a", lease_expires_at: 501 },
      { id: "job-later", state: "retry", lease_owner: null, lease_expires_at: null },
    ]
  );
});

test("claims by durable priority even when a lower-priority state was deferred", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "retention-first",
    state: "retry",
    priority: 0,
    nextRetryAt: 500,
    inputHash: "retention-input",
  });
  seedProcessingJob(db, {
    id: "storage-second",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    nextRetryAt: 500,
    inputHash: "storage-input",
  });

  assert.deepEqual(
    store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 2 }).map((job) => job.id),
    ["retention-first", "storage-second"]
  );
});

test("claims the newest session first among equal-priority diarization jobs", (t) => {
  const { db, store } = fixture(t);
  db.prepare(
    `INSERT INTO sessions (id, started_at, ended_at, status, created_at)
     VALUES ('s2', 200, 300, 'completed', 200)`
  ).run();
  db.prepare("UPDATE sessions SET ended_at = 100, status = 'completed' WHERE id = 's1'").run();
  createTrack(store, { id: "older-system", sessionId: "s1" });
  createTrack(store, { id: "newer-system", sessionId: "s2" });
  seedProcessingJob(db, {
    id: "older-diarize",
    sessionId: "s1",
    trackId: "older-system",
    jobType: "diarize_track",
    priority: 36,
    createdAt: 50,
    inputHash: "older-diarize-input",
  });
  seedProcessingJob(db, {
    id: "newer-diarize",
    sessionId: "s2",
    trackId: "newer-system",
    jobType: "diarize_track",
    priority: 36,
    createdAt: 250,
    inputHash: "newer-diarize-input",
  });

  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 1 })[0].id,
    "newer-diarize"
  );
});

test("application diarization cannot claim while a primary-track diarization is incomplete", (t) => {
  const { db, store } = fixture(t);
  createTrack(store, {
    id: "mic-primary",
    sourceType: "mic",
    deviceId: "mic-device",
    deviceLabel: "Physical microphone",
    strategy: "media-recorder",
  });
  createTrack(store, {
    id: "app-secondary",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 1,
  });
  seedProcessingJob(db, {
    id: "mic-diarize",
    trackId: "mic-primary",
    jobType: "diarize_track",
    state: "retry",
    priority: 35,
    nextRetryAt: 900,
    inputHash: "mic-diarize-input",
  });
  seedProcessingJob(db, {
    id: "app-diarize",
    trackId: "app-secondary",
    jobType: "diarize_track",
    priority: 40,
    inputHash: "app-diarize-input",
  });

  assert.deepEqual(store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 2 }), []);
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', next_retry_at = NULL, completed_at = 550
     WHERE id = 'mic-diarize'`
  ).run();
  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 600, leaseMs: 100, limit: 1 })[0].id,
    "app-diarize"
  );
});

test("daily digest jobs are sessionless idempotent and wake by immutable input", (t) => {
  const { db, store } = fixture(t, { createId: (prefix) => `${prefix}-fixed` });
  const input = seedDailyDigestInput(db, { inputHash: "4".repeat(64) });
  const first = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  const replay = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });

  assert.equal(first.id, replay.id);
  assert.equal(first.session_id, null);
  assert.equal(first.digest_input_id, input.inputId);
  assert.equal(first.priority, 80);
  assert.equal(first.lane, "cloud");
  assert.equal(store.getDailyDigestJobByInput(input.inputId).id, first.id);
  assert.equal(db.prepare("SELECT count(*) AS count FROM processing_jobs").get().count, 1);

  db.prepare(
    `UPDATE processing_jobs
     SET state = 'retry', next_retry_at = 999, error_code = 'OFFLINE'
     WHERE id = ?`
  ).run(first.id);
  const woken = store.wakeDailyDigestJob({ digestInputId: input.inputId, at: 500 });
  assert.equal(woken.id, first.id);
  assert.equal(woken.state, "retry");
  assert.equal(woken.next_retry_at, 500);

  assert.throws(
    () =>
      store.enqueueDailyDigestJob({
        digestInputId: input.inputId,
        inputHash: "3".repeat(64),
        inputVersion: 1,
        modelVersion: "MiniMax-M2.7",
      }),
    /identity|mismatch/i
  );
  assert.throws(
    () =>
      store.enqueueCloudJob({
        sessionId: "s1",
        jobType: "generate_daily_digest",
        inputHash: input.inputHash,
        modelVersion: "MiniMax-M2.7",
      }),
    /fixed cloud|analysis/i
  );
});

test("daily digest job APIs enforce exact objects and keep model metadata out of source identity", (t) => {
  const { db, store } = fixture(t);
  const input = seedDailyDigestInput(db, {
    inputHash: "2".repeat(64),
    modelVersion: "Model-A",
  });
  const validEnqueue = {
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "Model-B",
  };
  const job = store.enqueueDailyDigestJob(validEnqueue);
  assert.equal(job.model_version, "Model-B");
  for (const invalid of [
    null,
    {},
    { ...validEnqueue, unknown: true },
    Object.assign(Object.create({ inherited: true }), validEnqueue),
  ]) {
    assert.throws(() => store.enqueueDailyDigestJob(invalid), /plain|exact|keys|input/i);
  }
  for (const invalid of [
    null,
    {},
    { digestInputId: input.inputId, at: 100, unknown: true },
    Object.assign(Object.create({ inherited: true }), { digestInputId: input.inputId, at: 100 }),
  ]) {
    assert.throws(() => store.wakeDailyDigestJob(invalid), /plain|exact|keys|input/i);
  }
});

test("manual daily digest retry reopens only approved blocked failures", (t) => {
  for (const errorCode of [
    "daily_digest_invalid_response",
    "daily_digest_reconciled_without_candidate",
  ]) {
    const { db, store } = fixture(t);
    const input = seedDailyDigestInput(db, { inputHash: "6".repeat(64) });
    const job = store.enqueueDailyDigestJob({
      digestInputId: input.inputId,
      inputHash: input.inputHash,
      inputVersion: 1,
      modelVersion: "MiniMax-M2.7",
    });
    db.prepare(
      `UPDATE processing_jobs
       SET state = 'blocked',
           completed_at = 400,
           error_code = ?,
           blocked_reason = 'provider_failure',
           execution_device = 'cloud'
       WHERE id = ?`
    ).run(errorCode, job.id);

    const retried = store.authorizeManualDailyDigestRetry(job.id, {
      allowUsageUnknown: false,
      at: 500,
    });

    assert.equal(retried?.state, "retry", errorCode);
    assert.equal(retried?.next_retry_at, 500, errorCode);
    assert.equal(retried?.error_code, "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED", errorCode);
    assert.equal(retried?.completed_at, null, errorCode);
    assert.equal(retried?.blocked_reason, null, errorCode);
    assert.equal(retried?.execution_device, null, errorCode);
  }
});

test("usage-unknown daily digest retry requires explicit authorization", (t) => {
  const { db, store } = fixture(t);
  const input = seedDailyDigestInput(db, { inputHash: "7".repeat(64) });
  const job = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'blocked',
         completed_at = 400,
         error_code = 'daily_digest_usage_unknown',
         blocked_reason = 'transport_ambiguous'
     WHERE id = ?`
  ).run(job.id);

  assert.equal(
    store.authorizeManualDailyDigestRetry(job.id, {
      allowUsageUnknown: false,
      at: 500,
    }),
    null
  );
  assert.equal(store.getDailyDigestJobByInput(input.inputId).state, "blocked");

  const retried = store.authorizeManualDailyDigestRetry(job.id, {
    allowUsageUnknown: true,
    at: 501,
  });
  assert.equal(retried?.state, "retry");
  assert.equal(retried?.error_code, "DAILY_DIGEST_MANUAL_RETRY_AUTHORIZED");
  assert.throws(
    () =>
      store.authorizeManualDailyDigestRetry(job.id, {
        allowUsageUnknown: "yes",
        at: 501,
      }),
    /allowUsageUnknown.*boolean/i
  );
});

test("supersedeDailyDigestJob is lease fenced and terminal only for daily digest work", (t) => {
  const { db, store } = fixture(t);
  const input = seedDailyDigestInput(db, { inputHash: "8".repeat(64) });
  const job = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  const [claimed] = store.claimCloudJobs({
    owner: "digest-worker",
    at: 500,
    leaseMs: 100,
    limit: 1,
  });
  assert.equal(claimed.id, job.id);
  assert.equal(store.supersedeDailyDigestJob(job.id, { owner: "wrong-worker", at: 510 }), false);
  assert.equal(store.supersedeDailyDigestJob(job.id, { owner: "digest-worker", at: 600 }), false);
  assert.equal(store.supersedeDailyDigestJob(job.id, { owner: "digest-worker", at: 510 }), true);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, completed_at, next_retry_at, lease_owner, lease_expires_at,
              error_code, blocked_reason, execution_device
       FROM processing_jobs WHERE id = ?`
      )
      .get(job.id),
    {
      state: "superseded",
      completed_at: 510,
      next_retry_at: null,
      lease_owner: null,
      lease_expires_at: null,
      error_code: "DAILY_DIGEST_SUPERSEDED",
      blocked_reason: null,
      execution_device: null,
    }
  );
  assert.equal(store.supersedeDailyDigestJob(job.id, { owner: "digest-worker", at: 511 }), false);
  const analysisJob = setPrestartRecoveryState(db, store, "none");
  db.prepare(
    `UPDATE processing_jobs
     SET lease_owner = 'digest-worker', lease_expires_at = 900
     WHERE id = ?`
  ).run(analysisJob.id);
  assert.equal(
    store.supersedeDailyDigestJob(analysisJob.id, { owner: "digest-worker", at: 700 }),
    false
  );
  assert.deepEqual(
    db.prepare("SELECT job_type, state FROM processing_jobs WHERE id = ?").get(analysisJob.id),
    { job_type: "analyze_session", state: "running" }
  );
});

test("daily digest candidates require a reconciled daily-digest budget attempt", (t) => {
  const { db, store } = fixture(t);
  const input = seedDailyDigestInput(db, { inputHash: "1".repeat(64) });
  const job = store.enqueueDailyDigestJob({
    digestInputId: input.inputId,
    inputHash: input.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });
  const at = Date.UTC(2026, 6, 16, 4);
  const budget = new AnalysisBudgetRepository(db);
  budget.initialize({ monthlyLimitMicrousd: 5_000_000, timezone: "Asia/Shanghai", at });
  budget.reserve({
    requestId: "digest-attempt",
    jobId: job.id,
    attemptNumber: 1,
    provider: "minimax",
    model: "MiniMax-M2.7",
    operation: "daily_digest",
    estimatedUsage: { inputTokens: 100, outputTokens: 100 },
    at: at + 1,
  });
  const candidateJson = JSON.stringify({ schemaVersion: "jarvis-daily-digest-v1" });
  const insertCandidate = () =>
    db
      .prepare(
        `INSERT INTO daily_digest_response_candidates (
         id, job_id, digest_input_id, budget_attempt_id, response_schema_version,
         candidate_json, candidate_bytes, candidate_hash, state, created_at
       ) VALUES (
         'digest-candidate', ?, ?, 'digest-attempt', 'jarvis-daily-digest-v1',
         ?, ?, ?, 'validated', ?
       )`
      )
      .run(
        job.id,
        input.inputId,
        candidateJson,
        Buffer.byteLength(candidateJson, "utf8"),
        "3".repeat(64),
        at + 4
      );
  assert.throws(insertCandidate, /identity|linkage|mismatch/i);
  budget.markStarted({ requestId: "digest-attempt", at: at + 2 });
  budget.reconcile({
    requestId: "digest-attempt",
    usage: { inputTokens: 100, outputTokens: 100 },
    at: at + 3,
  });
  assert.doesNotThrow(insertCandidate);
});

test("keeps local and cloud claims disjoint and accepts only fixed cloud job types", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "local-final",
    jobType: "transcribe_chunk",
    priority: 30,
    inputHash: "local-final",
  });
  const digestInput = seedDailyDigestInput(db, { inputHash: "7".repeat(64) });
  seedProcessingJob(db, {
    id: "cloud-digest",
    sessionId: null,
    jobType: "generate_daily_digest",
    priority: 80,
    inputHash: digestInput.inputHash,
    modelVersion: "MiniMax-M2.7",
    lane: "cloud",
    digestInputId: digestInput.inputId,
  });
  seedProcessingJob(db, {
    id: "unknown-local",
    jobType: "future_unknown_job",
    priority: 5,
    inputHash: "unknown-local",
  });

  assert.deepEqual(
    store
      .claimJobs({ owner: "local-worker", at: 500, leaseMs: 100, limit: 10 })
      .map((job) => job.id),
    ["local-final"]
  );
  assert.deepEqual(
    store
      .claimCloudJobs({ owner: "cloud-worker", at: 500, leaseMs: 100, limit: 10 })
      .map((job) => job.id),
    ["cloud-digest"]
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, lease_owner FROM processing_jobs
         WHERE id IN ('cloud-digest','unknown-local') ORDER BY id`
      )
      .all(),
    [
      { id: "cloud-digest", state: "running", lease_owner: "cloud-worker" },
      { id: "unknown-local", state: "pending", lease_owner: null },
    ]
  );
});

test("cloud claims never create two simultaneously live leases", (t) => {
  const { db, store } = fixture(t);
  const analysisJob = seedCloudAnalysisRecovery(db, store, {
    attemptState: "none",
    persistCandidate: false,
  });
  const digestInput = seedDailyDigestInput(db, { inputHash: "6".repeat(64) });
  const digestJob = store.enqueueDailyDigestJob({
    digestInputId: digestInput.inputId,
    inputHash: digestInput.inputHash,
    inputVersion: 1,
    modelVersion: "MiniMax-M2.7",
  });

  assert.deepEqual(
    store.claimCloudJobs({ owner: "second-worker", at: 150, leaseMs: 100, limit: 2 }),
    []
  );
  assert.equal(
    db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(analysisJob.id)
      .lease_owner,
    "dead-cloud-worker"
  );
  const claimed = store.claimCloudJobs({
    owner: "second-worker",
    at: 200,
    leaseMs: 100,
    limit: 2,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, digestJob.id);
  assert.equal(claimed[0].lease_owner, "second-worker");
});

test("generic lease recovery never mutates cloud work", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "local-expired",
    state: "running",
    leaseOwner: "local-old",
    leaseExpiresAt: 200,
    inputHash: "local-expired",
  });
  const digestInput = seedDailyDigestInput(db, { inputHash: "6".repeat(64) });
  seedProcessingJob(db, {
    id: "cloud-expired",
    sessionId: null,
    jobType: "generate_daily_digest",
    state: "running",
    priority: 80,
    lane: "cloud",
    leaseOwner: "cloud-old",
    leaseExpiresAt: 200,
    inputHash: digestInput.inputHash,
    modelVersion: "MiniMax-M2.7",
    digestInputId: digestInput.inputId,
  });

  assert.equal(store.recoverExpiredLeases(200), 1);
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, state, lease_owner, error_code FROM processing_jobs
         WHERE id IN ('local-expired','cloud-expired') ORDER BY id`
      )
      .all(),
    [
      { id: "cloud-expired", state: "running", lease_owner: "cloud-old", error_code: null },
      { id: "local-expired", state: "retry", lease_owner: null, error_code: "LEASE_EXPIRED" },
    ]
  );
});

test("recovers only an expired cloud analysis lease backed by a reconciled candidate", (t) => {
  const { db, store } = fixture(t);
  const job = seedCloudAnalysisRecovery(db, store);

  assert.deepEqual(
    store.recoverExpiredCloudCandidateLeases({
      owner: "restart-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
    }),
    [
      {
        jobId: job.id,
        jobType: "analyze_session",
        candidateId: "analysis-candidate-recovery",
        candidateState: "validated",
        leaseOwner: "restart-cloud-worker",
        leaseExpiresAt: 500,
      },
    ]
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, lease_owner, lease_expires_at, execution_device
         FROM processing_jobs WHERE id = ?`
      )
      .get(job.id),
    {
      state: "running",
      attempt_count: 1,
      lease_owner: "restart-cloud-worker",
      lease_expires_at: 500,
      execution_device: null,
    }
  );
});

test("bounded cloud candidate recovery discovers applied work without a network claim", (t) => {
  const { db, store } = fixture(t);
  const job = seedCloudAnalysisRecovery(db, store, { candidateState: "applied" });

  assert.deepEqual(
    store.recoverExpiredCloudCandidateLeases({
      owner: "restart-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
    }),
    [
      {
        jobId: job.id,
        jobType: "analyze_session",
        candidateId: "analysis-candidate-recovery",
        candidateState: "applied",
        leaseOwner: "restart-cloud-worker",
        leaseExpiresAt: 500,
      },
    ]
  );
  assert.equal(
    db.prepare("SELECT attempt_count FROM processing_jobs WHERE id = ?").get(job.id).attempt_count,
    1
  );
});

test("restart recovery leases an exactly linked reconciled superseded candidate", (t) => {
  const { db, store } = fixture(t);
  const job = seedCloudAnalysisRecovery(db, store, { candidateState: "superseded" });

  assert.deepEqual(
    store.recoverExpiredCloudCandidateLeases({
      owner: "restart-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
    }),
    [
      {
        jobId: job.id,
        jobType: "analyze_session",
        candidateId: "analysis-candidate-recovery",
        candidateState: "superseded",
        leaseOwner: "restart-cloud-worker",
        leaseExpiresAt: 500,
      },
    ]
  );
});

test("digest candidate recovery renews validated applied and superseded unfinished work", (t) => {
  for (const candidateState of ["validated", "applied", "superseded"]) {
    const child = fixture(t);
    const seeded = seedCloudDigestRecovery(child.db, child.store, {
      candidateState,
      suffix: candidateState,
    });
    assert.deepEqual(
      child.store.recoverExpiredCloudCandidateLeases({
        owner: "restart-digest-worker",
        at: 200,
        leaseMs: 300,
        limit: 1,
      }),
      [
        {
          jobId: seeded.job.id,
          jobType: "generate_daily_digest",
          candidateId: seeded.candidateId,
          candidateState,
          leaseOwner: "restart-digest-worker",
          leaseExpiresAt: 500,
        },
      ],
      candidateState
    );
  }
});

test("shared cloud candidate recovery prefers analysis over an older digest", (t) => {
  const { db, store } = fixture(t);
  const analysisJob = seedCloudAnalysisRecovery(db, store);
  db.prepare("UPDATE processing_jobs SET lease_expires_at = 99 WHERE id = ?").run(analysisJob.id);
  seedCloudDigestRecovery(db, store, {
    suffix: "older-priority",
    candidateCreatedAt: 140,
  });
  db.prepare("UPDATE processing_jobs SET lease_expires_at = 200 WHERE id = ?").run(analysisJob.id);

  const recovered = store.recoverExpiredCloudCandidateLeases({
    owner: "shared-cloud-worker",
    at: 200,
    leaseMs: 300,
    limit: 1,
    priorityBefore: 81,
  });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].jobId, analysisJob.id);
  assert.equal(recovered[0].jobType, "analyze_session");
});

test("analysis-only candidate recovery cannot renew a daily digest lease", (t) => {
  const { db, store } = fixture(t);
  const seeded = seedCloudDigestRecovery(db, store, {
    candidateState: "validated",
    suffix: "candidate-priority-fence",
  });

  assert.deepEqual(
    store.recoverExpiredCloudCandidateLeases({
      owner: "analysis-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
      priorityBefore: 71,
    }),
    []
  );
  assert.equal(
    db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(seeded.job.id)
      .lease_owner,
    "dead-cloud-worker"
  );
  assert.deepEqual(
    store.recoverExpiredCloudCandidateLeases({
      owner: "shared-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
      priorityBefore: 81,
    }),
    [
      {
        jobId: seeded.job.id,
        jobType: "generate_daily_digest",
        candidateId: seeded.candidateId,
        candidateState: "validated",
        leaseOwner: "shared-cloud-worker",
        leaseExpiresAt: 500,
      },
    ]
  );
});

test("digest candidate recovery rejects every mismatched input job budget and state link", async (t) => {
  const scenarios = [
    {
      name: "job input hash",
      corrupt(db, seeded) {
        db.exec("DROP TRIGGER processing_jobs_cloud_contract_update");
        db.prepare("UPDATE processing_jobs SET input_hash = ? WHERE id = ?").run(
          "6".repeat(64),
          seeded.job.id
        );
      },
    },
    {
      name: "candidate input",
      corrupt(db, seeded) {
        seedDailyDigestInput(db, { inputId: "digest-input-forged", inputHash: "5".repeat(64) });
        db.exec("DROP TRIGGER daily_digest_response_candidates_validate_update");
        db.prepare(
          "UPDATE daily_digest_response_candidates SET digest_input_id = ? WHERE id = ?"
        ).run("digest-input-forged", seeded.candidateId);
      },
    },
    {
      name: "job budget model",
      corrupt(db, seeded) {
        db.prepare("UPDATE processing_jobs SET model_version = 'forged-model' WHERE id = ?").run(
          seeded.job.id
        );
      },
    },
    {
      name: "budget provider",
      corrupt(db, seeded) {
        db.exec(`
          DROP TRIGGER analysis_budget_attempts_immutable_identity;
          DROP TRIGGER analysis_budget_attempts_terminal;
        `);
        db.pragma("foreign_keys = OFF");
        db.prepare(
          "UPDATE analysis_budget_attempts SET provider = 'forged' WHERE request_id = ?"
        ).run(seeded.requestId);
        db.pragma("foreign_keys = ON");
      },
    },
    {
      name: "budget operation",
      corrupt(db, seeded) {
        db.exec(`
          DROP TRIGGER analysis_budget_attempts_immutable_identity;
          DROP TRIGGER analysis_budget_attempts_terminal;
          DROP TRIGGER analysis_budget_attempts_validate_actual_cost;
        `);
        db.pragma("foreign_keys = OFF");
        db.prepare(
          "UPDATE analysis_budget_attempts SET operation = 'session_analysis' WHERE request_id = ?"
        ).run(seeded.requestId);
        db.pragma("foreign_keys = ON");
      },
    },
    {
      name: "budget state",
      corrupt(db, seeded) {
        db.exec(`
          DROP TRIGGER analysis_budget_attempts_terminal;
          DROP TRIGGER analysis_budget_attempts_transition;
        `);
        db.pragma("ignore_check_constraints = ON");
        db.prepare(
          "UPDATE analysis_budget_attempts SET state = 'started' WHERE request_id = ?"
        ).run(seeded.requestId);
        db.pragma("ignore_check_constraints = OFF");
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, (childTest) => {
      const child = fixture(childTest);
      const seeded = seedCloudDigestRecovery(child.db, child.store, {
        suffix: scenario.name.replaceAll(" ", "-"),
      });
      scenario.corrupt(child.db, seeded);
      assert.deepEqual(
        child.store.recoverExpiredCloudCandidateLeases({
          owner: "restart-digest-worker",
          at: 200,
          leaseMs: 300,
          limit: 1,
        }),
        []
      );
      assert.equal(
        child.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(seeded.job.id)
          .lease_owner,
        "dead-cloud-worker"
      );
    });
  }
});

test("superseded candidate recovery rejects forged and unreconciled evidence", (t) => {
  const scenarios = [
    {
      name: "forged desired-vector linkage",
      corrupt(db) {
        db.exec("DROP TRIGGER analysis_response_candidates_immutable_update;");
        db.prepare(
          "UPDATE analysis_response_candidates SET desired_vector_hash = ? WHERE id = ?"
        ).run("9".repeat(64), "analysis-candidate-recovery");
      },
    },
    {
      name: "unreconciled budget attempt",
      corrupt(db) {
        db.exec("DROP TRIGGER analysis_budget_attempts_terminal;");
        db.pragma("ignore_check_constraints = ON");
        db.prepare(
          "UPDATE analysis_budget_attempts SET state = 'started' WHERE request_id = ?"
        ).run("analysis-request-recovery");
        db.pragma("ignore_check_constraints = OFF");
      },
    },
  ];

  for (const scenario of scenarios) {
    const child = fixture(t);
    const job = seedCloudAnalysisRecovery(child.db, child.store, {
      candidateState: "superseded",
    });
    scenario.corrupt(child.db);

    assert.deepEqual(
      child.store.recoverExpiredCloudCandidateLeases({
        owner: "restart-cloud-worker",
        at: 200,
        leaseMs: 300,
        limit: 1,
      }),
      [],
      scenario.name
    );
    assert.equal(
      child.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(job.id)
        .lease_owner,
      "dead-cloud-worker",
      scenario.name
    );
  }
});

test("cloud candidate lease recovery refuses live, ambiguous, and non-analysis work", (t) => {
  const scenarios = [
    {
      name: "live analysis lease",
      seed({ db, store }) {
        const job = seedCloudAnalysisRecovery(db, store);
        return { job, at: 199 };
      },
    },
    {
      name: "usage-unknown attempt without a candidate",
      seed({ db, store }) {
        const job = seedCloudAnalysisRecovery(db, store, { attemptState: "usage_unknown" });
        return { job, at: 200 };
      },
    },
    {
      name: "daily digest",
      seed({ db, store }) {
        const digestInput = seedDailyDigestInput(db, { inputHash: "9".repeat(64) });
        const job = store.enqueueDailyDigestJob({
          digestInputId: digestInput.inputId,
          inputHash: digestInput.inputHash,
          inputVersion: 1,
          modelVersion: "MiniMax-M2.7",
        });
        store.claimCloudJobs({ owner: "dead-cloud-worker", at: 100, leaseMs: 100 });
        return { job, at: 200 };
      },
    },
  ];

  for (const scenario of scenarios) {
    const child = fixture(t);
    const { job, at } = scenario.seed(child);
    assert.deepEqual(
      child.store.recoverExpiredCloudCandidateLeases({
        owner: "restart-cloud-worker",
        at,
        leaseMs: 300,
        limit: 1,
      }),
      [],
      scenario.name
    );
    assert.equal(
      child.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(job.id)
        .lease_owner,
      "dead-cloud-worker",
      scenario.name
    );
  }
});

test("expired cloud pre-start recovery reassigns safe and terminal-budget attempts", (t) => {
  for (const state of [
    "none",
    "released",
    "started",
    "usage_unknown",
    "reconciled_zero",
    "reconciled_nonzero",
  ]) {
    const child = fixture(t);
    const job = setPrestartRecoveryState(child.db, child.store, state);
    const recovered = child.store.recoverExpiredCloudPrestartLeases({
      owner: "restart-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
    });

    assert.equal(recovered.length, 1, state);
    assert.equal(recovered[0].id, job.id, state);
    assert.equal(recovered[0].state, "running", state);
    assert.equal(recovered[0].lease_owner, "restart-cloud-worker", state);
    assert.equal(recovered[0].lease_expires_at, 500, state);
    assert.equal(recovered[0].attempt_count, 1, state);
  }
});

test("expired digest pre-start recovery renews safe and terminal-budget attempts", (t) => {
  const scenarios = [
    { state: "none", actualUsage: undefined },
    { state: "released", actualUsage: undefined },
    { state: "started", actualUsage: undefined },
    { state: "usage_unknown", actualUsage: undefined },
    { state: "reconciled", actualUsage: { inputTokens: 0, outputTokens: 0 } },
    { state: "reconciled", actualUsage: { inputTokens: 100, outputTokens: 100 } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const child = fixture(t);
    const seeded = seedCloudDigestRecovery(child.db, child.store, {
      attemptState: scenario.state,
      persistCandidate: false,
      actualUsage: scenario.actualUsage,
      suffix: `prestart-${index}`,
    });
    const recovered = child.store.recoverExpiredCloudPrestartLeases({
      owner: "restart-digest-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
    });
    assert.equal(recovered.length, 1, scenario.state);
    assert.equal(recovered[0].id, seeded.job.id, scenario.state);
    assert.equal(recovered[0].lease_owner, "restart-digest-worker", scenario.state);
    assert.equal(recovered[0].lease_expires_at, 500, scenario.state);
  }
});

test("analysis-only recovery cannot claim a daily digest terminal-budget lease", (t) => {
  const { db, store } = fixture(t);
  const seeded = seedCloudDigestRecovery(db, store, {
    attemptState: "usage_unknown",
    persistCandidate: false,
    suffix: "priority-fence",
  });

  assert.deepEqual(
    store.recoverExpiredCloudPrestartLeases({
      owner: "analysis-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
      priorityBefore: 71,
    }),
    []
  );
  assert.equal(
    db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(seeded.job.id)
      .lease_owner,
    "dead-cloud-worker"
  );
  assert.equal(
    store.recoverExpiredCloudPrestartLeases({
      owner: "shared-cloud-worker",
      at: 200,
      leaseMs: 300,
      limit: 1,
      priorityBefore: 81,
    })[0].id,
    seeded.job.id
  );
});

test("shared cloud prestart recovery prefers analysis over an older digest", (t) => {
  const { db, store } = fixture(t);
  const analysisJob = seedCloudAnalysisRecovery(db, store, {
    attemptState: "none",
    persistCandidate: false,
  });
  db.prepare("UPDATE processing_jobs SET lease_expires_at = 99 WHERE id = ?").run(analysisJob.id);
  const digest = seedCloudDigestRecovery(db, store, {
    attemptState: "none",
    persistCandidate: false,
    suffix: "older-prestart-priority",
  });
  db.prepare(
    "UPDATE processing_jobs SET lease_expires_at = 200, created_at = 200 WHERE id = ?"
  ).run(analysisJob.id);
  db.prepare("UPDATE processing_jobs SET created_at = 100 WHERE id = ?").run(digest.job.id);

  const recovered = store.recoverExpiredCloudPrestartLeases({
    owner: "shared-cloud-worker",
    at: 200,
    leaseMs: 300,
    limit: 1,
    priorityBefore: 81,
  });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, analysisJob.id);
  assert.equal(recovered[0].job_type, "analyze_session");
});

test("recovered paid digest crash windows converge without another network request", async (t) => {
  const budgetAt = Date.UTC(2026, 6, 16, 4);
  const scenarios = [
    {
      state: "started",
      reason: "usage_unknown",
      errorCode: "daily_digest_usage_unknown",
    },
    {
      state: "usage_unknown",
      reason: "usage_unknown",
      errorCode: "daily_digest_usage_unknown",
    },
    {
      state: "reconciled",
      reason: "reconciled_without_candidate",
      errorCode: "daily_digest_reconciled_without_candidate",
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.state, async (childTest) => {
      const { db, store } = fixture(childTest);
      const seeded = seedCloudDigestRecovery(db, store, {
        attemptState: scenario.state,
        persistCandidate: false,
        suffix: `durable-convergence-${index}`,
      });
      const [job] = store.recoverExpiredCloudPrestartLeases({
        owner: "digest-recovery-worker",
        at: budgetAt + 10,
        leaseMs: 300,
        limit: 1,
        priorityBefore: 81,
      });
      assert.equal(job.id, seeded.job.id);

      const budgetGuard = new AnalysisBudgetGuard({
        repository: new AnalysisBudgetRepository(db),
        now: () => budgetAt + 20,
        defaultTimezone: "Asia/Shanghai",
      });
      const inputRow = db
        .prepare("SELECT * FROM daily_digest_inputs WHERE id = ?")
        .get(seeded.input.inputId);
      const memoryRepository = {
        createDailyDigestInput() {
          throw new Error("source rebuild must remain unreachable");
        },
        getLatestDailyDigest() {
          throw new Error("latest digest lookup must remain unreachable");
        },
        applyValidatedDailyDigestCandidate() {
          throw new Error("candidate apply must remain unreachable");
        },
        getDailyDigestInput(inputId) {
          assert.equal(inputId, seeded.input.inputId);
          return {
            status: "existing",
            digestInputId: inputRow.id,
            localDate: inputRow.local_date,
            timezone: inputRow.timezone,
            sourceHash: inputRow.source_hash,
            contractVersion: inputRow.contract_version,
            completeness: inputRow.completeness,
            inputWatermark: JSON.parse(inputRow.input_watermark_json),
            inputWatermarkJson: inputRow.input_watermark_json,
            cloudPayload: JSON.parse(inputRow.cloud_payload_json),
            cloudPayloadJson: inputRow.cloud_payload_json,
            inputBytes: inputRow.input_bytes,
            modelVersion: inputRow.model_version,
            createdAt: inputRow.created_at,
          };
        },
        getRecoverableDailyDigestCandidateByJob(jobId) {
          assert.equal(jobId, seeded.job.id);
          return null;
        },
        persistValidatedDailyDigestCandidate() {
          throw new Error("candidate persistence must remain unreachable");
        },
      };
      let networkRequests = 0;
      const service = new DailyDigestService({
        memoryRepository,
        store,
        budgetGuard,
        client: {
          model: "MiniMax-M2.7",
          async generate() {
            networkRequests += 1;
            throw new Error("network must remain unreachable");
          },
        },
        admit: () => {
          throw new Error("admission must remain unreachable");
        },
        estimatedUsage: { inputTokens: 100, outputTokens: 100 },
        createRequestId: () => {
          throw new Error("request creation must remain unreachable");
        },
        modelVersion: "MiniMax-M2.7",
        timezoneProvider: () => "Asia/Shanghai",
        now: () => budgetAt + 20,
        owner: "digest-recovery-worker",
      });

      assert.deepEqual(await service.execute(job), {
        status: "blocked",
        reason: scenario.reason,
        jobId: seeded.job.id,
      });
      assert.equal(networkRequests, 0);
      assert.deepEqual(
        db
          .prepare(
            `SELECT state, error_code, lease_owner, lease_expires_at, completed_at
           FROM processing_jobs WHERE id = ?`
          )
          .get(seeded.job.id),
        {
          state: "blocked",
          error_code: scenario.errorCode,
          lease_owner: null,
          lease_expires_at: null,
          completed_at: budgetAt + 20,
        }
      );
    });
  }
});

test("expired digest pre-start recovery refuses ambiguous or inexact work", async (t) => {
  const scenarios = [
    {
      name: "candidate present",
      seed(db, store) {
        return seedCloudDigestRecovery(db, store, { suffix: "prestart-candidate" });
      },
    },
    {
      name: "input hash mismatch",
      seed(db, store) {
        const seeded = seedCloudDigestRecovery(db, store, {
          attemptState: "none",
          persistCandidate: false,
          suffix: "prestart-hash",
        });
        db.exec("DROP TRIGGER processing_jobs_cloud_contract_update");
        db.prepare("UPDATE processing_jobs SET input_hash = ? WHERE id = ?").run(
          "4".repeat(64),
          seeded.job.id
        );
        return seeded;
      },
    },
    {
      name: "job budget model mismatch",
      seed(db, store) {
        const seeded = seedCloudDigestRecovery(db, store, {
          attemptState: "released",
          persistCandidate: false,
          suffix: "prestart-model",
        });
        db.prepare("UPDATE processing_jobs SET model_version = 'forged-model' WHERE id = ?").run(
          seeded.job.id
        );
        return seeded;
      },
    },
    {
      name: "budget provider mismatch",
      seed(db, store) {
        const seeded = seedCloudDigestRecovery(db, store, {
          attemptState: "released",
          persistCandidate: false,
          suffix: "prestart-provider",
        });
        db.exec(`
          DROP TRIGGER analysis_budget_attempts_immutable_identity;
          DROP TRIGGER analysis_budget_attempts_terminal;
        `);
        db.pragma("foreign_keys = OFF");
        db.prepare(
          "UPDATE analysis_budget_attempts SET provider = 'forged' WHERE request_id = ?"
        ).run(seeded.requestId);
        db.pragma("foreign_keys = ON");
        return seeded;
      },
    },
    {
      name: "budget operation mismatch",
      seed(db, store) {
        const seeded = seedCloudDigestRecovery(db, store, {
          attemptState: "released",
          persistCandidate: false,
          suffix: "prestart-operation",
        });
        db.exec(`
          DROP TRIGGER analysis_budget_attempts_immutable_identity;
          DROP TRIGGER analysis_budget_attempts_terminal;
        `);
        db.pragma("foreign_keys = OFF");
        db.prepare(
          "UPDATE analysis_budget_attempts SET operation = 'session_analysis' WHERE request_id = ?"
        ).run(seeded.requestId);
        db.pragma("foreign_keys = ON");
        return seeded;
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, (childTest) => {
      const child = fixture(childTest);
      const seeded = scenario.seed(child.db, child.store);
      assert.deepEqual(
        child.store.recoverExpiredCloudPrestartLeases({
          owner: "restart-digest-worker",
          at: 200,
          leaseMs: 300,
          limit: 1,
        }),
        []
      );
      assert.equal(
        child.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(seeded.job.id)
          .lease_owner,
        "dead-cloud-worker"
      );
    });
  }
});

test("expired cloud pre-start recovery refuses incomplete paid candidate and non-analysis work", async (t) => {
  const scenarios = [
    {
      name: "reconciled unknown",
      seed: ({ db, store }) => setPrestartRecoveryState(db, store, "reconciled_unknown"),
    },
    {
      name: "candidate present",
      seed: ({ db, store }) => seedCloudAnalysisRecovery(db, store),
    },
    {
      name: "unknown cloud",
      seed: ({ db }) => {
        db.pragma("ignore_check_constraints = ON");
        db.exec("DROP TRIGGER processing_jobs_cloud_contract_insert;");
        seedProcessingJob(db, {
          id: "unknown-cloud",
          jobType: "future_cloud_job",
          state: "running",
          lane: "cloud",
          leaseOwner: "dead-cloud-worker",
          leaseExpiresAt: 200,
          inputHash: "unknown-cloud",
        });
        db.pragma("ignore_check_constraints = OFF");
        return { id: "unknown-cloud" };
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, (childTest) => {
      const child = fixture(childTest);
      const job = scenario.seed(child);
      assert.deepEqual(
        child.store.recoverExpiredCloudPrestartLeases({
          owner: "restart-cloud-worker",
          at: 200,
          leaseMs: 300,
          limit: 1,
        }),
        []
      );
      assert.equal(
        child.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id = ?").get(job.id)
          .lease_owner,
        "dead-cloud-worker"
      );
    });
  }
});

test("analysis supersede is lease checked and persists an auditable terminal disposition", (t) => {
  const { db, store } = fixture(t);
  const job = setPrestartRecoveryState(db, store, "none");

  assert.equal(
    store.supersedeAnalysisJob(job.id, {
      owner: "wrong-cloud-worker",
      at: 199,
    }),
    false
  );
  assert.equal(
    store.supersedeAnalysisJob(job.id, {
      owner: "dead-cloud-worker",
      at: 199,
    }),
    true
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, completed_at, next_retry_at, lease_owner, lease_expires_at,
                error_code, blocked_reason, execution_device
         FROM processing_jobs WHERE id = ?`
      )
      .get(job.id),
    {
      state: "superseded",
      completed_at: 199,
      next_retry_at: null,
      lease_owner: null,
      lease_expires_at: null,
      error_code: "ANALYSIS_SUPERSEDED",
      blocked_reason: null,
      execution_device: null,
    }
  );
});

test("agent admission backlog includes running and future-retry local work only", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "running-final",
    state: "running",
    priority: 30,
    leaseOwner: "worker",
    leaseExpiresAt: 900,
    inputHash: "running-final",
  });
  seedProcessingJob(db, {
    id: "future-compress",
    jobType: "compress_chunk",
    state: "retry",
    priority: 60,
    nextRetryAt: 9_999,
    inputHash: "future-compress",
  });
  seedProcessingJob(db, {
    id: "terminal-final",
    state: "completed",
    priority: 30,
    completedAt: 400,
    inputHash: "terminal-final",
  });
  const digestInput = seedDailyDigestInput(db, { inputHash: "5".repeat(64) });
  seedProcessingJob(db, {
    id: "cloud-digest",
    sessionId: null,
    jobType: "generate_daily_digest",
    priority: 80,
    lane: "cloud",
    inputHash: digestInput.inputHash,
    modelVersion: "MiniMax-M2.7",
    digestInputId: digestInput.inputId,
  });
  seedProcessingJob(db, {
    id: "unknown-local",
    jobType: "unknown_local",
    priority: 1,
    inputHash: "unknown-backlog",
  });

  assert.deepEqual(store.listAgentAdmissionBacklog({ priorityBefore: 70 }), [
    {
      jobType: "transcribe_chunk",
      lane: "local",
      state: "running",
      priority: 30,
      nextRetryAt: null,
    },
    {
      jobType: "compress_chunk",
      lane: "local",
      state: "retry",
      priority: 60,
      nextRetryAt: 9_999,
    },
  ]);
  assert.equal(store.countCloudLaneInFlight(), 0);
  db.prepare(
    `UPDATE processing_jobs SET state = 'running', lease_owner = 'cloud', lease_expires_at = 900
     WHERE id = 'cloud-digest'`
  ).run();
  assert.equal(store.countCloudLaneInFlight(), 1);
  assert.equal(store.countCloudLaneInFlight({ excludeJobId: "cloud-digest" }), 0);
  assert.throws(
    () => store.countCloudLaneInFlight({ excludeJobId: "../cloud-digest" }),
    /identifier/i
  );
});

test("digest admission sees actionable analysis while analysis excludes its own claim", (t) => {
  const { db, store } = fixture(t);
  const job = seedCloudAnalysisRecovery(db, store, {
    attemptState: "none",
    persistCandidate: false,
  });

  assert.deepEqual(store.listAgentAdmissionBacklog({ priorityBefore: 70 }), []);
  assert.deepEqual(
    store.listAgentAdmissionBacklog({
      priorityBefore: 80,
      excludeJobId: "other-job",
    }),
    [
      {
        jobType: "analyze_session",
        lane: "cloud",
        state: "running",
        priority: 70,
        nextRetryAt: null,
      },
    ]
  );
  assert.deepEqual(
    store.listAgentAdmissionBacklog({
      priorityBefore: 80,
      excludeJobId: job.id,
    }),
    []
  );
});

test("atomically claims only durable jobs above the preview priority ceiling", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "retention-first",
    state: "retention_urgent",
    priority: 0,
    inputHash: "retention-ceiling",
  });
  seedProcessingJob(db, {
    id: "storage-second",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    inputHash: "storage-ceiling",
  });
  seedProcessingJob(db, {
    id: "final-later",
    priority: 30,
    inputHash: "final-ceiling",
  });

  const claimed = store.claimJobs({
    owner: "worker-a",
    at: 500,
    leaseMs: 100,
    limit: 10,
    priorityBefore: 20,
  });

  assert.deepEqual(
    claimed.map((job) => job.id),
    ["retention-first", "storage-second"]
  );
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE id = 'final-later'").get().state,
    "pending"
  );
});

test("rolls back every claim when a later lease update fails", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, { id: "job-a", inputHash: "input-a" });
  seedProcessingJob(db, { id: "job-b", inputHash: "input-b" });
  db.exec(`
    CREATE TRIGGER reject_second_job_claim
    BEFORE UPDATE OF state ON processing_jobs
    WHEN OLD.id = 'job-b' AND NEW.state = 'running'
    BEGIN
      SELECT RAISE(ABORT, 'second claim rejected');
    END;
  `);

  assert.throws(
    () => store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 2 }),
    /second claim rejected/i
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, attempt_count, lease_owner, lease_expires_at
      FROM processing_jobs ORDER BY id
    `
      )
      .all(),
    [
      {
        id: "job-a",
        state: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "job-b",
        state: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
  );
});

test("rejects stale lease owners and keeps terminal transitions idempotent", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "running",
    attemptCount: 1,
    leaseOwner: "worker-old",
    leaseExpiresAt: 150,
  });

  assert.equal(store.recoverExpiredLeases(200), 1);
  assert.equal(
    store.claimJobs({ owner: "worker-new", at: 200, leaseMs: 100, limit: 1 })[0].lease_owner,
    "worker-new"
  );
  assert.equal(store.completeJob("lease-job", { owner: "worker-old", at: 210 }), false);
  assert.equal(
    store.retryJob("lease-job", {
      owner: "worker-old",
      at: 210,
      nextRetryAt: 220,
      errorCode: "STALE",
    }),
    false
  );
  assert.equal(
    store.blockJob("lease-job", { owner: "worker-old", at: 210, errorCode: "STALE" }),
    false
  );
  assert.deepEqual(
    db.prepare("SELECT state, lease_owner FROM processing_jobs WHERE id = 'lease-job'").get(),
    { state: "running", lease_owner: "worker-new" }
  );

  assert.equal(store.completeJob("lease-job", { owner: "worker-new", at: 230 }), true);
  assert.equal(store.completeJob("lease-job", { owner: "worker-new", at: 231 }), false);
  assert.equal(
    store.retryJob("lease-job", {
      owner: "worker-new",
      at: 231,
      nextRetryAt: 231,
      errorCode: "TOO_LATE",
    }),
    false
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, completed_at, lease_owner, lease_expires_at, error_code
      FROM processing_jobs WHERE id = 'lease-job'
    `
      )
      .get(),
    {
      state: "completed",
      completed_at: 230,
      lease_owner: null,
      lease_expires_at: null,
      error_code: null,
    }
  );
});

test("records an admitted execution device only for the current live lease owner", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "running",
    attemptCount: 1,
    leaseOwner: "worker-current",
    leaseExpiresAt: 200,
  });

  assert.equal(
    store.recordJobExecutionDevice("lease-job", {
      owner: "worker-stale",
      at: 100,
      executionDevice: "cpu",
    }),
    false
  );
  assert.equal(
    store.recordJobExecutionDevice("lease-job", {
      owner: "worker-current",
      at: 100,
      executionDevice: "cpu",
    }),
    true
  );
  assert.equal(
    store.recordJobExecutionDevice("lease-job", {
      owner: "worker-current",
      at: 101,
      executionDevice: "cuda",
    }),
    false
  );
  assert.equal(
    store.recordJobExecutionDevice("lease-job", {
      owner: "worker-current",
      at: 200,
      executionDevice: "cpu",
    }),
    false
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT state, lease_owner, lease_expires_at, execution_device FROM processing_jobs WHERE id = 'lease-job'"
      )
      .get(),
    {
      state: "running",
      lease_owner: "worker-current",
      lease_expires_at: 200,
      execution_device: "cpu",
    }
  );
});

test("resource deferral releases the lease without consuming an attempt or retaining an error", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "retry",
    attemptCount: 2,
    nextRetryAt: 400,
    errorCode: "PRIOR_FAILURE",
  });
  const before = db
    .prepare(
      `SELECT input_hash, input_version, model_version, priority FROM processing_jobs WHERE id = ?`
    )
    .get("lease-job");
  const [claimed] = store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 1 });
  assert.equal(claimed.attempt_count, 3);

  assert.equal(
    store.deferJob("lease-job", {
      owner: "worker-a",
      at: 510,
      reason: "external_gpu_busy",
    }),
    true
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, next_retry_at, blocked_reason, error_code,
             lease_owner, lease_expires_at, completed_at,
             input_hash, input_version, model_version, priority
      FROM processing_jobs WHERE id = 'lease-job'
    `
      )
      .get(),
    {
      state: "retry",
      attempt_count: 2,
      next_retry_at: 15_510,
      blocked_reason: "external_gpu_busy",
      error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: null,
      ...before,
    }
  );
  assert.equal(
    store.deferJob("lease-job", {
      owner: "worker-a",
      at: 511,
      reason: "external_gpu_busy",
    }),
    false
  );
});

test("resource deferral can preserve an explicit analysis manual-retry authorization", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "retry",
    attemptCount: 2,
    nextRetryAt: 400,
    errorCode: "ANALYSIS_MANUAL_RETRY_AUTHORIZED",
  });
  const [claimed] = store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 1 });
  assert.equal(claimed.id, "lease-job");

  assert.equal(
    store.deferJob("lease-job", {
      owner: "worker-a",
      at: 510,
      reason: "external_gpu_busy",
      preserveManualRetry: true,
    }),
    true
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, attempt_count, blocked_reason, error_code,
                lease_owner, lease_expires_at, completed_at
         FROM processing_jobs WHERE id = 'lease-job'`
      )
      .get(),
    {
      state: "retry",
      attempt_count: 2,
      blocked_reason: "external_gpu_busy",
      error_code: "ANALYSIS_MANUAL_RETRY_AUTHORIZED",
      lease_owner: null,
      lease_expires_at: null,
      completed_at: null,
    }
  );
});

test("validates processing-job lease boundaries before touching durable state", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db);

  assert.throws(
    () => store.claimJobs({ owner: "", at: 100, leaseMs: 10, limit: 1 }),
    /owner.*safe identifier/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: -1, leaseMs: 10, limit: 1 }),
    /at.*non-negative/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: 100, leaseMs: 0, limit: 1 }),
    /leaseMs.*positive/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: 100, leaseMs: 10, limit: 0 }),
    /limit.*positive/i
  );
  assert.throws(
    () =>
      store.retryJob("lease-job", {
        owner: "worker",
        at: 100,
        nextRetryAt: 99,
        errorCode: "FAILED",
      }),
    /nextRetryAt.*before/i
  );
  assert.throws(
    () => store.retryJob("lease-job", { owner: "worker", at: 100 }),
    /errorCode.*safe identifier/i
  );
  assert.deepEqual(
    db.prepare("SELECT state, attempt_count FROM processing_jobs WHERE id = 'lease-job'").get(),
    { state: "pending", attempt_count: 0 }
  );
});
