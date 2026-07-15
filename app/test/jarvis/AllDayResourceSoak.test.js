const test = require("node:test");
const assert = require("node:assert/strict");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const PreviewTranscriptionScheduler = require("../../src/jarvis/main/PreviewTranscriptionScheduler");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const ResourceGovernor = require("../../src/jarvis/main/ResourceGovernor");
const registerJarvisIpc = require("../../src/jarvis/main/registerJarvisIpc");
const { CHANNELS } = require("../../src/jarvis/shared/contracts");

const TICK_MS = 15_000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;
const GPU_UUID = "GPU-resource-soak";
const BUSY_WINDOWS = [
  [30 * 60_000, 40 * 60_000],
  [90 * 60_000, 100 * 60_000],
];
const CUDA_CRASH_AT = 45 * 60_000;
const CUDA_RECOVERY_MS = 5 * 60_000;
const SLEEP_AT = 60 * 60_000;

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function isGpuBusy(at) {
  return BUSY_WINDOWS.some(([from, to]) => at >= from && at < to);
}

function insertFinalJob(db, { id, createdAt, state = "pending", leaseExpiresAt = null }) {
  db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, job_type, state, priority, input_hash, input_version,
      model_version, attempt_count, next_retry_at, lease_owner,
      lease_expires_at, created_at
    ) VALUES (
      @id, 'resource-soak', 'transcribe_chunk', @state, 30, @id, 1,
      'resource-soak-model', @attemptCount, NULL, @leaseOwner,
      @leaseExpiresAt, @createdAt
    )`
  ).run({
    id,
    createdAt,
    state,
    attemptCount: state === "running" ? 1 : 0,
    leaseOwner: state === "running" ? "sleeping-worker" : null,
    leaseExpiresAt,
  });
}

function queueCounts(db) {
  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS count
       FROM processing_jobs
       WHERE state <> 'completed'
       GROUP BY state`
    )
    .all();
  const counts = { pending: 0, running: 0, retry: 0, blocked: 0, total: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    counts[row.state] = (counts[row.state] ?? 0) + count;
    counts.total += count;
  }
  return counts;
}

test(
  "three virtual hours remain bounded and preserve every durable final job",
  { timeout: 30_000 },
  async (t) => {
    let now = 0;
    let cudaHealthy = true;
    let cudaRecoveryAt = null;
    let cudaCrashInjected = false;
    let totalFinalJobs = 0;
    let activeHeavy = 0;
    let maxHeavyConcurrency = 0;
    let heavyStartsDuringExternalGpuBusy = 0;
    let maxCpuFallbackThreads = 0;
    let maxGateQueue = 0;
    let maxFinalQueue = 0;
    let maxPreviewPending = 0;
    let provisionalWrites = 0;
    const previewLatencies = [];
    const busyObservedAt = new Map();
    const busyWindowEvidence = new Map(
      BUSY_WINDOWS.map(([windowStart]) => [
        windowStart,
        { initialBacklog: null, peakBacklog: 0, pausedTicks: 0 },
      ])
    );
    let statusPollBudgetMs = 0;
    let statusReads = 0;
    let lastRuntimeStatus = null;

    const repository = new JarvisRepository(":memory:");
    const db = repository.db;
    db.prepare(
      `INSERT INTO sessions (id, started_at, status, created_at)
       VALUES ('resource-soak', 0, 'recording', 0)`
    ).run();
    t.after(() => repository.close());

    const store = repository.captureEvidenceStore;
    const gate = new HeavyJobGate();
    const governor = new ResourceGovernor({
      now: () => now,
      sampleIntervalMs: TICK_MS,
      telemetryProvider: async () => ({
        telemetryAvailable: true,
        processTelemetryAvailable: true,
        ownedPids: [process.pid],
        gpus: [
          {
            uuid: GPU_UUID,
            utilizationPct: isGpuBusy(now) ? 70 : 10,
            totalVramMb: 16_000,
            usedVramMb: isGpuBusy(now) ? 10_000 : 2_000,
            freeVramMb: isGpuBusy(now) ? 6_000 : 14_000,
          },
        ],
        processes: isGpuBusy(now) ? [{ pid: 999_999, gpuUuid: GPU_UUID }] : [],
      }),
      cudaProvider: async () => ({
        installed: true,
        verified: cudaHealthy,
        quarantined: false,
        gpuUuid: cudaHealthy ? GPU_UUID : null,
        peakVramMb: 4_000,
      }),
      cpuProvider: async () => ({ loadPct: 20, telemetryAvailable: true }),
      powerProvider: async () => ({
        onAcPower: true,
        batteryPresent: false,
        batteryLevelPct: null,
        batterySaver: false,
        telemetryAvailable: true,
      }),
      ownedPidsProvider: () => [process.pid],
    });

    const enterHeavy = async (operation) => {
      if (isGpuBusy(now)) heavyStartsDuringExternalGpuBusy += 1;
      activeHeavy += 1;
      maxHeavyConcurrency = Math.max(maxHeavyConcurrency, activeHeavy);
      try {
        await immediate();
        return await operation();
      } finally {
        activeHeavy -= 1;
      }
    };

    const runner = new ProcessingJobRunner({
      store,
      owner: "resource-soak-worker",
      now: () => now,
      leaseMs: 60_000,
      retryBaseMs: TICK_MS,
      retryMaxMs: 60_000,
      governor,
      heavyGate: gate,
    });
    runner.register("transcribe_chunk", async (_job, context) =>
      enterHeavy(async () => {
        if (!cudaCrashInjected && now >= CUDA_CRASH_AT && context.device === "cuda") {
          cudaCrashInjected = true;
          cudaHealthy = false;
          cudaRecoveryAt = now + CUDA_RECOVERY_MS;
          const error = new Error("simulated CUDA worker crash");
          error.code = "CUDA_WORKER_CRASH";
          throw error;
        }
        return { executionDevice: context.device };
      })
    );

    const preview = new PreviewTranscriptionScheduler({
      heavyGate: gate,
      now: () => now,
      beforePreviewStart: (permit) =>
        runner.drainHigherPriorityWithinPermit(permit, {
          priorityBefore: ResourceGovernor.JOB_PRIORITY.preview,
          at: now,
        }),
      executePreview: async ({ throughMs, executionDevice, cpuThreads, lowPriority }) =>
        enterHeavy(async () => {
          if (executionDevice === "cuda" && !cudaHealthy) {
            const error = new Error("CUDA unavailable after worker crash");
            error.code = "CUDA_WORKER_CRASH";
            throw error;
          }
          if (executionDevice === "cpu") {
            assert.equal(lowPriority, true);
            maxCpuFallbackThreads = Math.max(maxCpuFallbackThreads, cpuThreads ?? 0);
          }
          previewLatencies.push(Math.max(0, now - Math.max(0, throughMs - TICK_MS)));
          return { segments: [] };
        }),
      persistProvisional: async () => {
        provisionalWrites += 1;
      },
    });

    const ipcHandlers = new Map();
    const serviceState = () => ({
      sessionId: "resource-soak",
      status: "recording",
      captureMode: "dual",
      retentionMode: "speech_triggered",
      errorCode: null,
    });
    registerJarvisIpc({
      ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
      repository,
      service: {
        startCapture: () => null,
        setRetentionMode: () => null,
        sourceInterrupted: () => null,
        sourceRestored: () => null,
        pauseCapture: () => null,
        resumeCapture: () => null,
        finishCapture: () => null,
        failCapture: () => null,
        getState: serviceState,
      },
      speakerCorrectionService: {
        listSessionClusters: () => [],
        confirm: () => null,
        reject: () => null,
        undo: () => null,
        listCorrections: () => [],
        mergePeople: () => null,
      },
      voiceEnrollmentService: {
        getStatus: () => ({}),
        begin: () => ({}),
        complete: () => ({}),
        cancel: () => ({}),
        cancelOwner: () => 0,
      },
      environmentManager: { getOpenAIKey: () => "" },
      processingLifecycle: {
        runtime: { previewStatus: () => preview.status(), governor },
      },
      storageManager: {
        getStatus: async () => ({
          state: "ok",
          freeBytes: 100 * 1024 ** 3,
          remainingDays: 30,
          recoveryAction: null,
        }),
        migrate: async () => ({ switched: true }),
      },
      pickStorageDirectory: async () => null,
      now: () => now,
    });
    const readRuntimeStatus = ipcHandlers.get(CHANNELS.getRuntimeStatus);
    assert.equal(typeof readRuntimeStatus, "function");

    const observeBounds = () => {
      const gateState = gate.getState();
      const previewState = preview.status();
      const queue = queueCounts(db);
      maxGateQueue = Math.max(maxGateQueue, gateState.queueLength);
      maxFinalQueue = Math.max(maxFinalQueue, queue.total);
      maxPreviewPending = Math.max(maxPreviewPending, previewState.pending);
    };

    for (let tick = 0; tick < THREE_HOURS_MS / TICK_MS; tick += 1) {
      now = tick * TICK_MS;
      if (cudaRecoveryAt !== null && now >= cudaRecoveryAt) {
        cudaHealthy = true;
        cudaRecoveryAt = null;
      }
      if (now % 60_000 === 0) {
        insertFinalJob(db, { id: `final-${totalFinalJobs}`, createdAt: now });
        totalFinalJobs += 1;
      }
      if (now === SLEEP_AT) {
        insertFinalJob(db, {
          id: "sleep-interrupted-final",
          createdAt: now,
          state: "running",
          leaseExpiresAt: now + 1,
        });
        totalFinalJobs += 1;
      }
      for (const trackId of ["mic", "system"]) {
        preview.request({ sessionId: "resource-soak", trackId, throughMs: now + TICK_MS });
      }

      const snapshot = await governor.sample();
      for (const [windowStart] of BUSY_WINDOWS) {
        if (snapshot.state === "busy" && now >= windowStart && !busyObservedAt.has(windowStart)) {
          busyObservedAt.set(windowStart, now);
        }
      }
      await Promise.all([runner.runOnce(now), preview.tick(snapshot)]);
      observeBounds();
      for (const [windowStart, windowEnd] of BUSY_WINDOWS) {
        if (now < windowStart || now >= windowEnd) continue;
        const evidence = busyWindowEvidence.get(windowStart);
        const backlog = queueCounts(db).total;
        evidence.initialBacklog ??= backlog;
        evidence.peakBacklog = Math.max(evidence.peakBacklog, backlog);
        const previewState = preview.status();
        assert.equal(previewState.mode, "paused");
        assert.equal(previewState.pausedReason, "gpu_busy");
        evidence.pausedTicks += 1;
      }
      statusPollBudgetMs += TICK_MS;
      while (statusPollBudgetMs >= 2_000) {
        statusPollBudgetMs -= 2_000;
        lastRuntimeStatus = await readRuntimeStatus(null);
        statusReads += 1;
      }
    }

    for (let drain = 0; drain < 1_000; drain += 1) {
      now += TICK_MS;
      if (cudaRecoveryAt !== null && now >= cudaRecoveryAt) {
        cudaHealthy = true;
        cudaRecoveryAt = null;
      }
      const snapshot = await governor.sample();
      await Promise.all([runner.runOnce(now), preview.tick(snapshot)]);
      observeBounds();
      if (
        queueCounts(db).total === 0 &&
        preview.status().pending === 0 &&
        preview.status().running === 0 &&
        gate.getState().queueLength === 0 &&
        gate.getState().activeKind === null
      ) {
        break;
      }
    }

    const completed = db
      .prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE state = 'completed'")
      .get().count;
    const outstanding = queueCounts(db);
    const recoveredSleepJob = db
      .prepare(
        `SELECT state, attempt_count, error_code
         FROM processing_jobs WHERE id = 'sleep-interrupted-final'`
      )
      .get();
    const sortedLatencies = previewLatencies.slice().sort((left, right) => left - right);
    const p95PreviewLatencyMs =
      sortedLatencies[Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)] ?? null;

    assert.equal(cudaCrashInjected, true);
    assert.equal(completed, totalFinalJobs);
    assert.deepEqual(outstanding, { pending: 0, running: 0, retry: 0, blocked: 0, total: 0 });
    assert.equal(recoveredSleepJob.state, "completed");
    assert.ok(recoveredSleepJob.attempt_count >= 2);
    assert.equal(recoveredSleepJob.error_code, null);
    assert.equal(maxHeavyConcurrency, 1);
    assert.equal(heavyStartsDuringExternalGpuBusy, 0);
    assert.ok(maxCpuFallbackThreads > 0 && maxCpuFallbackThreads <= 4);
    assert.ok(maxFinalQueue <= 20, `final queue grew to ${maxFinalQueue}`);
    assert.ok(maxPreviewPending <= 2, `preview pending grew to ${maxPreviewPending}`);
    assert.ok(maxGateQueue <= 1, `heavy gate queue grew to ${maxGateQueue}`);
    assert.equal(statusReads, THREE_HOURS_MS / 2_000);
    assert.equal(lastRuntimeStatus.capture.status, "recording");
    assert.ok(provisionalWrites <= THREE_HOURS_MS / TICK_MS);
    assert.equal(gate.getState().activeKind, null);
    assert.equal(gate.getState().queueLength, 0);
    assert.equal(preview.status().running, 0);
    assert.equal(preview.status().pending, 0);
    assert.ok(p95PreviewLatencyMs <= 30_000);
    assert.equal(busyObservedAt.size, BUSY_WINDOWS.length);
    for (const [windowStart, observedAt] of busyObservedAt) {
      assert.ok(observedAt - windowStart <= TICK_MS);
      const evidence = busyWindowEvidence.get(windowStart);
      assert.ok(evidence.pausedTicks > 0);
      assert.ok(
        evidence.peakBacklog > evidence.initialBacklog,
        `final backlog did not grow during busy window ${windowStart}`
      );
    }

    t.diagnostic(
      JSON.stringify({
        virtualHours: THREE_HOURS_MS / 3_600_000,
        finalJobs: totalFinalJobs,
        lostFinalJobs: totalFinalJobs - completed,
        maxHeavyConcurrency,
        maxCpuFallbackThreads,
        maxFinalQueue,
        maxPreviewPending,
        maxGateQueue,
        p95PreviewLatencyMs,
        statusReads,
        provisionalWrites,
        externalGpuBusyWindows: busyObservedAt.size,
        heavyStartsDuringExternalGpuBusy,
        busyBacklogGrowth: [...busyWindowEvidence.entries()].map(([windowStart, evidence]) => ({
          windowStart,
          initial: evidence.initialBacklog,
          peak: evidence.peakBacklog,
        })),
        sleeps: 1,
        cudaCrashes: 1,
      })
    );
  }
);
