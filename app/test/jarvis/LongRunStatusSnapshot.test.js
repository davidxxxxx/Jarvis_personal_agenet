const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
        id, session_id, chunk_id, job_type, state, priority, input_hash, lane,
        input_version, model_version, execution_device, blocked_reason, next_retry_at,
        created_at, completed_at
      ) VALUES (@id, 's1', @chunkId, @jobType, @state, @priority, @hash, @lane,
        1, '', @executionDevice, @blockedReason, @nextRetryAt, @createdAt, @completedAt)`
    );
    insertJob.run({
      id: "j1",
      chunkId: "c1",
      jobType: "transcribe_chunk",
      state: "pending",
      priority: 20,
      hash: "j1",
      lane: "local",
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
      lane: "local",
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
      lane: "local",
      executionDevice: null,
      blockedReason: "resources_constrained",
      nextRetryAt: 90_000,
      createdAt: 30_000,
      completedAt: null,
    });
    const statusHash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const analysisInputHash = statusHash("runtime status analysis input");
    const cloudPayloadJson = JSON.stringify({
      inputVersion: "jarvis-analysis-input-v2",
      segments: [],
      omittedRanges: [],
    });
    const cloudPayloadHash = statusHash(cloudPayloadJson);
    const analysisModelVersion = "runtime-status-model-v1";
    repo.db
      .prepare(
        `INSERT INTO analysis_inputs (
           id, session_id, transcript_revision, identity_revision, prompt_version,
           input_hash, input_contract_version, redaction_version, cloud_payload_json,
           cloud_payload_bytes, cloud_payload_sha256, created_at
         ) VALUES (
           'status-analysis-input', 's1', ?, ?, 'jarvis-analysis-v2', ?,
           'jarvis-analysis-input-v2', 'jarvis-redaction-v1', ?, ?, ?, 39000
         )`
      )
      .run(
        statusHash("runtime status transcript"),
        statusHash("runtime status identity"),
        analysisInputHash,
        cloudPayloadJson,
        Buffer.byteLength(cloudPayloadJson, "utf8"),
        cloudPayloadHash
      );
    const desiredVectorJson = JSON.stringify({
      analysisInputId: "status-analysis-input",
      analysisInputHash,
      transcriptRevision: statusHash("runtime status transcript"),
      identityRevision: statusHash("runtime status identity"),
      promptVersion: "jarvis-analysis-v2",
      cloudPayloadHash,
      modelVersion: analysisModelVersion,
      segments: [],
    });
    const desiredVectorHash = statusHash(desiredVectorJson);
    repo.db
      .prepare(
        `INSERT INTO analysis_desired_heads (
           session_id, analysis_input_id, analysis_input_hash, desired_vector_json,
           desired_vector_hash, head_revision, created_at, updated_at
         ) VALUES ('s1', 'status-analysis-input', ?, ?, ?, 1, 39000, 39000)`
      )
      .run(analysisInputHash, desiredVectorJson, desiredVectorHash);
    repo.db
      .prepare(
        `INSERT INTO processing_jobs (
           id, session_id, chunk_id, job_type, state, priority, input_hash, lane,
           input_version, model_version, execution_device, blocked_reason, next_retry_at,
           analysis_input_id, desired_head_hash, created_at, completed_at
         ) VALUES (
           'j4', 's1', NULL, 'analyze_session', 'blocked', 70, ?, 'cloud',
           1, ?, NULL, NULL, NULL, 'status-analysis-input', ?, 40000, NULL
         )`
      )
      .run(analysisInputHash, analysisModelVersion, desiredVectorHash);
    insertJob.run({
      id: "j5",
      chunkId: "c3",
      jobType: "transcribe_chunk",
      state: "completed",
      priority: 20,
      hash: "j5",
      lane: "local",
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
      lane: "local",
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
      lane: "local",
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
      lane: "local",
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
      lane: "local",
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

test("runtime IPC reports durable running CPU work separately from CUDA inventory", async (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({ id: "cpu-session", startedAt: 10, micDeviceId: null });
  repo.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, job_type, state, priority, input_hash,
        input_version, model_version, attempt_count, lease_owner,
        lease_expires_at, execution_device, created_at
      ) VALUES (
        'cpu-speaker-job', 'cpu-session', 'resolve_identities', 'running', 45,
        'cpu-speaker-input', 1, 'speaker-identity-resolution-v1', 1,
        'cpu-worker', 200000, 'cpu', 90000
      )`
    )
    .run();
  const { handlers } = register({
    repository: {
      getRuntimeProcessingStatus: () => repo.getRuntimeProcessingStatus(),
    },
  });

  const result = await handlers.get(CHANNELS.getRuntimeStatus)(null);

  assert.deepEqual(result.backend, {
    actualBackend: "cpu",
    cudaGpuUuid: "GPU-verified",
  });
  assert.equal(result.queue.running, 1);
  assert.equal(result.queue.byStage.speaker.running, 1);
});
