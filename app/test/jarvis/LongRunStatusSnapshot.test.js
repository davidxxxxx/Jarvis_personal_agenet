const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNELS } = require("../../src/jarvis/shared/contracts");
const registerJarvisIpc = require("../../src/jarvis/main/registerJarvisIpc");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function repository(overrides = {}) {
  return {
    createSession: () => null,
    setSessionStatus: () => null,
    getSession: () => null,
    listSessions: () => [],
    upsertTranscriptSegments: () => [],
    syncTranscriptSegments: () => [],
    listTranscriptSegments: () => [],
    renamePerson: () => null,
    listPeople: () => [],
    listAudioChunks: () => [],
    getSessionTimeline: () => null,
    getCloudBudgetStatus: () => ({}),
    setCloudBudgetSettings: () => ({}),
    getRuntimeProcessingStatus: () => ({
      pending: 4,
      running: 1,
      retry: 2,
      blocked: 0,
      total: 7,
      byStage: {
        final_transcription: { pending: 3, running: 1, retry: 1, blocked: 0, total: 5 },
        speaker: { pending: 1, running: 0, retry: 1, blocked: 0, total: 2 },
      },
      deferrals: [
        {
          stage: "speaker",
          jobType: "diarize_track",
          state: "retry",
          reason: "external_gpu_busy",
          count: 1,
          nextRetryAt: 110_000,
        },
      ],
      backlogMs: 18 * 60_000,
      oldestCreatedAt: 10_000,
      activeExecutionDevice: "cuda",
      finalCoveragePct: 72,
      provisionalCoveragePct: null,
    }),
    ...overrides,
  };
}

function register(overrides = {}) {
  const handlers = new Map();
  let resourceSamples = 0;
  const runtime = {
    previewStatus: () =>
      overrides.previewStatus ?? {
        mode: "paused",
        cadenceMs: null,
        pending: 1,
        running: 0,
        pausedReason: "gpu_busy",
        executionDevice: null,
        lastError: null,
        recordingContinues: true,
      },
    governor: {
      latestSnapshot: {
        sampledAt: 99_000,
        state: "busy",
        reason: "external_gpu_busy",
        selectedGpuUuid: "GPU-verified",
        cudaInstalled: true,
        cudaVerified: true,
        cudaQuarantined: false,
      },
      sample() {
        resourceSamples += 1;
        throw new Error("status reads must not sample resources");
      },
    },
  };
  const storageManager = Object.hasOwn(overrides, "storageManager")
    ? overrides.storageManager
    : {
        getStatus: async () => ({
          state: "warning",
          freeBytes: 2_000_000_000,
          remainingDays: 3,
          recoveryAction: "Move old recordings or choose another data directory.",
        }),
        migrate: async () => ({ switched: true }),
      };
  const registration = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: repository(overrides.repository),
    service: {
      startCapture: () => null,
      setRetentionMode: () => null,
      sourceInterrupted: () => null,
      sourceRestored: () => null,
      pauseCapture: () => null,
      resumeCapture: () => null,
      finishCapture: () => null,
      failCapture: () => null,
      getState: () =>
        overrides.serviceState ?? {
          sessionId: "session-1",
          status: "recording",
          captureMode: "dual",
          retentionMode: "speech_triggered",
          errorCode: null,
        },
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
    processingLifecycle: Object.hasOwn(overrides, "processingLifecycle")
      ? overrides.processingLifecycle
      : { runtime },
    now: () => 100_000,
  };
  if (storageManager !== undefined) {
    registration.storageManager = storageManager;
    registration.pickStorageDirectory = async () => "G:\\Jarvis";
  }
  registerJarvisIpc(registration);
  return { handlers, getResourceSamples: () => resourceSamples };
}

test("runtime snapshot reports truthful capture, resource, queue, preview, and disk state", async () => {
  assert.equal(CHANNELS.getRuntimeStatus, "jarvis:runtime:status");
  const { handlers, getResourceSamples } = register();

  const result = await handlers.get(CHANNELS.getRuntimeStatus)(null);

  assert.deepEqual(result, {
    observedAt: 100_000,
    capture: {
      sessionId: "session-1",
      status: "recording",
      captureMode: "dual",
      retentionMode: "speech_triggered",
      errorCode: null,
    },
    backend: {
      actualBackend: "cuda",
      cudaGpuUuid: "GPU-verified",
    },
    resources: {
      sampledAt: 99_000,
      state: "busy",
      reason: "external_gpu_busy",
      cudaInstalled: true,
      cudaVerified: true,
      cudaQuarantined: false,
    },
    queue: {
      pending: 4,
      running: 1,
      retry: 2,
      blocked: 0,
      total: 7,
      byStage: {
        final_transcription: { pending: 3, running: 1, retry: 1, blocked: 0, total: 5 },
        speaker: { pending: 1, running: 0, retry: 1, blocked: 0, total: 2 },
      },
      deferrals: [
        {
          stage: "speaker",
          jobType: "diarize_track",
          state: "retry",
          reason: "external_gpu_busy",
          count: 1,
          nextRetryAt: 110_000,
        },
      ],
      backlogMinutes: 18,
      oldestJobAgeMs: 90_000,
      finalCoveragePct: 72,
      provisionalCoveragePct: null,
    },
    preview: {
      mode: "paused",
      cadenceMs: null,
      pending: 1,
      running: 0,
      pausedReason: "gpu_busy",
      executionDevice: null,
      lastError: null,
      recordingContinues: true,
    },
    disk: {
      state: "warning",
      freeBytes: 2_000_000_000,
      remainingDays: 3,
      recoveryAction: "Move old recordings or choose another data directory.",
    },
    nextRecoveryAction: "wait_for_gpu",
  });
  assert.equal(getResourceSamples(), 0);
});

test("runtime snapshot marks missing subsystems as unavailable instead of inventing values", async () => {
  const { handlers } = register({
    processingLifecycle: null,
    storageManager: undefined,
    repository: {
      getRuntimeProcessingStatus: () => ({
        pending: 0,
        running: 0,
        retry: 0,
        blocked: 0,
        total: 0,
        byStage: {},
        deferrals: [],
        backlogMs: 0,
        oldestCreatedAt: null,
        activeExecutionDevice: null,
        finalCoveragePct: null,
        provisionalCoveragePct: null,
      }),
    },
  });

  const result = await handlers.get(CHANNELS.getRuntimeStatus)(null);

  assert.equal(result.queue.oldestJobAgeMs, null);
  assert.equal(result.queue.backlogMinutes, 0);
  assert.deepEqual(result.resources, {
    sampledAt: null,
    state: "unavailable",
    reason: "not_sampled",
    cudaInstalled: null,
    cudaVerified: null,
    cudaQuarantined: null,
  });
  assert.deepEqual(result.backend, { actualBackend: null, cudaGpuUuid: null });
  assert.deepEqual(result.disk, {
    state: "unavailable",
    freeBytes: null,
    remainingDays: null,
    recoveryAction: null,
  });
});

test("repository aggregates active work by runtime stage without double-counting transcript backlog", () => {
  const repo = new JarvisRepository(":memory:");
  try {
    repo.db
      .prepare(
        `INSERT INTO sessions (id, started_at, status, created_at)
         VALUES ('s1', 1, 'completed', 1)`
      )
      .run();
    const insertChunk = repo.db.prepare(
      `INSERT INTO audio_chunks (
        id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at
      ) VALUES (?, 's1', ?, ?, ?, ?, ?, 999999)`
    );
    insertChunk.run("c1", "c1.wav", 0, 600_000, 600_000, "hash-c1");
    insertChunk.run("c2", "c2.wav", 600_000, 1_080_000, 480_000, "hash-c2");
    insertChunk.run("c3", "c3.wav", 1_080_000, 1_200_000, 120_000, "hash-c3");
    const insertJob = repo.db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, chunk_id, job_type, state, priority, input_hash,
        input_version, model_version, execution_device, blocked_reason, next_retry_at,
        created_at, completed_at
      ) VALUES (@id, 's1', @chunkId, @jobType, @state, @priority, @hash,
        1, '', @executionDevice, @blockedReason, @nextRetryAt, @createdAt, @completedAt)`
    );
    insertJob.run({
      id: "j1",
      chunkId: "c1",
      jobType: "transcribe_chunk",
      state: "pending",
      priority: 20,
      hash: "j1",
      executionDevice: null,
      blockedReason: null,
      nextRetryAt: null,
      createdAt: 10_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j2",
      chunkId: "c2",
      jobType: "transcribe_chunk",
      state: "running",
      priority: 20,
      hash: "j2",
      executionDevice: "cuda",
      blockedReason: null,
      nextRetryAt: null,
      createdAt: 20_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j3",
      chunkId: "c1",
      jobType: "speaker",
      state: "retry",
      priority: 30,
      hash: "j3",
      executionDevice: null,
      blockedReason: "resources_constrained",
      nextRetryAt: 90_000,
      createdAt: 30_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j4",
      chunkId: null,
      jobType: "analyze_session",
      state: "blocked",
      priority: 50,
      hash: "j4",
      executionDevice: null,
      blockedReason: null,
      nextRetryAt: null,
      createdAt: 40_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j5",
      chunkId: "c3",
      jobType: "transcribe_chunk",
      state: "completed",
      priority: 20,
      hash: "j5",
      executionDevice: "cpu",
      blockedReason: null,
      nextRetryAt: null,
      createdAt: 50_000,
      completedAt: 60_000,
    });
    insertJob.run({
      id: "j7",
      chunkId: null,
      jobType: "diarize_track",
      state: "retry",
      priority: 40,
      hash: "j7",
      executionDevice: null,
      blockedReason: "cpu_load_high",
      nextRetryAt: 80_000,
      createdAt: 55_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j8",
      chunkId: null,
      jobType: "diarize_track",
      state: "retry",
      priority: 40,
      hash: "j8",
      executionDevice: null,
      blockedReason: "cpu_load_high",
      nextRetryAt: 70_000,
      createdAt: 56_000,
      completedAt: null,
    });
    insertJob.run({
      id: "j9",
      chunkId: null,
      jobType: "resolve_identities",
      state: "blocked",
      priority: 45,
      hash: "j9",
      executionDevice: null,
      blockedReason: "battery_saver",
      nextRetryAt: null,
      createdAt: 57_000,
      completedAt: null,
    });
    repo.db
      .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'c3'")
      .run();
    repo.upsertTranscriptSegments("s1", [
      {
        id: "preview-1",
        startedAt: 0,
        endedAt: 240_000,
        personId: null,
        speakerLabel: "speaker",
        text: "provisional",
        confidence: 0.8,
        isStable: true,
        sourceType: "mic",
      },
    ]);

    assert.deepEqual(repo.getRuntimeProcessingStatus(), {
      pending: 1,
      running: 1,
      retry: 3,
      blocked: 2,
      total: 7,
      byStage: {
        analysis: { pending: 0, running: 0, retry: 0, blocked: 1, total: 1 },
        final_transcription: { pending: 1, running: 1, retry: 0, blocked: 0, total: 2 },
        speaker: { pending: 0, running: 0, retry: 3, blocked: 1, total: 4 },
      },
      deferrals: [
        {
          stage: "speaker",
          jobType: "diarize_track",
          state: "retry",
          reason: "cpu_load_high",
          count: 2,
          nextRetryAt: 70_000,
        },
        {
          stage: "speaker",
          jobType: "resolve_identities",
          state: "blocked",
          reason: "battery_saver",
          count: 1,
          nextRetryAt: null,
        },
        {
          stage: "speaker",
          jobType: "speaker",
          state: "retry",
          reason: "resources_constrained",
          count: 1,
          nextRetryAt: 90_000,
        },
      ],
      backlogMs: 1_080_000,
      oldestCreatedAt: 10_000,
      activeExecutionDevice: "cuda",
      finalCoveragePct: 10,
      provisionalCoveragePct: 20,
    });

    insertJob.run({
      id: "j6",
      chunkId: "c3",
      jobType: "transcribe_chunk",
      state: "pending",
      priority: 20,
      hash: "j6",
      executionDevice: null,
      blockedReason: null,
      nextRetryAt: null,
      createdAt: 70_000,
      completedAt: null,
    });
    assert.equal(repo.getRuntimeProcessingStatus().finalCoveragePct, 0);
  } finally {
    repo.close();
  }
});

test("runtime snapshot makes a failed microphone capture actionable", async () => {
  const { handlers } = register({
    serviceState: {
      sessionId: "session-1",
      status: "failed",
      captureMode: "mic",
      retentionMode: "speech_triggered",
      errorCode: "MIC_DISCONNECTED",
    },
  });

  const result = await handlers.get(CHANNELS.getRuntimeStatus)(null);

  assert.equal(result.capture.status, "failed");
  assert.equal(result.nextRecoveryAction, "restore_microphone");
});

test("runtime snapshot prefers the currently running preview backend", async () => {
  const { handlers } = register({
    previewStatus: {
      mode: "normal",
      cadenceMs: 30_000,
      pending: 0,
      running: 1,
      pausedReason: null,
      executionDevice: "cpu",
      lastError: null,
      recordingContinues: true,
    },
  });

  const result = await handlers.get(CHANNELS.getRuntimeStatus)(null);

  assert.equal(result.backend.actualBackend, "cpu");
});
