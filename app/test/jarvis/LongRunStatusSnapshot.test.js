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
      backlogMs: 18 * 60_000,
      oldestCreatedAt: 10_000,
      latestExecutionDevice: "cuda",
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
    previewStatus: () => ({
      mode: "paused",
      cadenceMs: null,
      pending: 1,
      running: 0,
      pausedReason: "gpu_busy",
      executionDevice: null,
      lastError: null,
      recordingContinues: true,
    }),
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
      getState: () => ({
        sessionId: "session-1",
        status: "recording",
        captureMode: "dual",
        retentionMode: "speech_triggered",
        errorCode: null,
      }),
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
        backlogMs: 0,
        oldestCreatedAt: null,
        latestExecutionDevice: null,
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
      ) VALUES (?, 's1', ?, 1, 2, ?, ?, 999999)`
    );
    insertChunk.run("c1", "c1.wav", 600_000, "hash-c1");
    insertChunk.run("c2", "c2.wav", 480_000, "hash-c2");
    insertChunk.run("c3", "c3.wav", 120_000, "hash-c3");
    const insertJob = repo.db.prepare(
      `INSERT INTO processing_jobs (
        id, session_id, chunk_id, job_type, state, priority, input_hash,
        input_version, model_version, execution_device, created_at, completed_at
      ) VALUES (@id, 's1', @chunkId, @jobType, @state, @priority, @hash,
        1, '', @executionDevice, @createdAt, @completedAt)`
    );
    insertJob.run({
      id: "j1",
      chunkId: "c1",
      jobType: "transcribe_chunk",
      state: "pending",
      priority: 20,
      hash: "j1",
      executionDevice: null,
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
      createdAt: 50_000,
      completedAt: 60_000,
    });

    assert.deepEqual(repo.getRuntimeProcessingStatus(), {
      pending: 1,
      running: 1,
      retry: 1,
      blocked: 1,
      total: 4,
      byStage: {
        analysis: { pending: 0, running: 0, retry: 0, blocked: 1, total: 1 },
        final_transcription: { pending: 1, running: 1, retry: 0, blocked: 0, total: 2 },
        speaker: { pending: 0, running: 0, retry: 1, blocked: 0, total: 1 },
      },
      backlogMs: 1_080_000,
      oldestCreatedAt: 10_000,
      latestExecutionDevice: "cpu",
      finalCoveragePct: 10,
      provisionalCoveragePct: null,
    });
  } finally {
    repo.close();
  }
});
