const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const WhisperCudaManager = require("../../src/helpers/whisperCudaManager");
const {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
} = require("../../src/jarvis/main/JarvisProcessingRuntime");

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function makeVerifiedCudaManager(t, { peakVramMb, gpuUuid }) {
  const componentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-runtime-cuda-"));
  t.after(() => fs.rmSync(componentRoot, { recursive: true, force: true }));
  const manifest = {
    repository: "example/runtime",
    tag: "test-v1",
    asset: "whisper-server-win32-x64-cuda.zip",
    size: 4,
    sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  };
  const manager = new WhisperCudaManager({
    platform: "win32",
    componentRoot,
    manifest,
    approvedManifests: [manifest],
    extractedSizeEstimate: 8,
    diskSafetyMargin: 0,
    checkDiskSpace: async () => ({ ok: true, availableBytes: 10_000 }),
    inspectArchive: async () => [
      { path: "runtime/whisper-server-win32-x64-cuda.exe", type: "File" },
    ],
    downloadFile: async (_url, destination) => {
      fs.writeFileSync(destination, Buffer.from([1, 2, 3, 4]));
    },
    extractArchive: async (_archive, destination) => {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "whisper-server-win32-x64-cuda.exe"), "exe");
      fs.writeFileSync(path.join(destination, "cublas64_12.dll"), "dll");
      fs.writeFileSync(path.join(destination, "cudart64_12.dll"), "dll");
    },
    verifyRuntime: async () => ({
      ok: true,
      backend: "cuda",
      gpuUuid,
      reason: "verified",
    }),
  });
  await manager.installPinnedCudaRuntime({
    consent: true,
    verification: {
      gpuUuid,
      getMetadata: () => ({ peakVramMb }),
    },
  });
  return manager;
}

function insertSession(
  repository,
  {
    id = "s1",
    status = "completed",
    processingState = "processing",
    captureMode = "mic",
    endedAt = 1_000,
  } = {}
) {
  repository.db
    .prepare(
      `
    INSERT INTO sessions (
      id, started_at, ended_at, status, language, created_at,
      capture_mode, processing_state, finalized_at
    ) VALUES (?, 100, ?, ?, 'zh', 100, ?, ?, ?)
  `
    )
    .run(id, endedAt, status, captureMode, processingState, endedAt);
}

function insertTrack(
  repository,
  { id = "track-mic", sessionId = "s1", sourceType = "mic", endedAt = 1_000 } = {}
) {
  repository.db
    .prepare(
      `
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels,
      started_at, ended_at, state
    ) VALUES (?, ?, ?, 24000, 1, 100, ?, 'completed')
  `
    )
    .run(id, sessionId, sourceType, endedAt);
}

function insertChunk(
  repository,
  {
    id = "chunk-mic",
    sessionId = "s1",
    trackId = "track-mic",
    sourceType = "mic",
    startedAt = 100,
    endedAt = 500,
    transcriptionStatus = "pending",
  } = {}
) {
  repository.db
    .prepare(
      `
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 999999,
      ?, 'committed', 'wav', 24000, 1)
  `
    )
    .run(
      id,
      sessionId,
      trackId,
      sourceType,
      `${sessionId}-${id}.wav`,
      startedAt,
      endedAt,
      endedAt - startedAt,
      id.padEnd(64, "0").slice(0, 64),
      transcriptionStatus
    );
}

function insertJob(
  repository,
  {
    id = "job-mic",
    sessionId = "s1",
    trackId = "track-mic",
    chunkId = "chunk-mic",
    state = "pending",
    completedAt = null,
    leaseOwner = null,
    leaseExpiresAt = null,
  } = {}
) {
  repository.db
    .prepare(
      `
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      priority, input_hash, input_version, model_version, attempt_count,
      lease_owner, lease_expires_at, created_at, completed_at
    ) VALUES (?, ?, ?, ?, 'transcribe_chunk', ?, 30, ?, 1, '', 0, ?, ?, 100, ?)
  `
    )
    .run(
      id,
      sessionId,
      trackId,
      chunkId,
      state,
      chunkId.padEnd(64, "0").slice(0, 64),
      leaseOwner,
      leaseExpiresAt,
      completedAt
    );
}

function insertFinalCoverage(repository, chunkId, completedAt = 700) {
  const chunk = repository.getAudioChunk(chunkId);
  return repository.commitChunkTranscript({
    chunk,
    result: { text: `final-${chunkId}`, confidence: 0.9 },
    modelVersion: "large-v3-turbo",
    completedAt,
  });
}

function noopPostProcessors(repository) {
  return {
    reconciler: { reconcileSession: () => ({ superseded: 0 }) },
    deduper: { dedupe: () => ({ duplicatesMarked: 0 }) },
    repository,
  };
}

test("restart resumes a persisted pending chunk and no-speech can make it ready", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-processing-restart-"));
  const dbPath = path.join(root, "jarvis.db");

  const first = new JarvisRepository(dbPath);
  insertSession(first);
  insertTrack(first);
  insertChunk(first);
  insertJob(first);
  first.close();

  const repository = new JarvisRepository(dbPath);
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner: "restart-worker",
    now: () => 2_000,
    leaseMs: 1_000,
  });
  runner.register("transcribe_chunk", async (job) => {
    repository.commitChunkTranscript({
      chunk: repository.getAudioChunk(job.chunk_id),
      result: { noSpeech: true },
      modelVersion: "large-v3-turbo",
      completedAt: 2_000,
    });
  });
  const runtime = new JarvisProcessingRuntime({
    runner,
    ...noopPostProcessors(repository),
    now: () => 2_000,
  });

  assert.equal(await runtime.drainOnce(), 1);
  assert.equal(repository.getSession("s1").processing_state, "ready");
  assert.equal(repository.getAudioChunk("chunk-mic").transcription_status, "no_speech");
  assert.equal(repository.listPendingJobs("s1").length, 0);
  assert.deepEqual(repository.listTranscriptSegments("s1"), []);
});

test("open sessions and every incomplete transcription job state stay non-ready", () => {
  const states = ["pending", "retry", "running", "retention_urgent", "blocked"];
  for (const state of states) {
    const repository = new JarvisRepository(":memory:");
    insertSession(repository, { id: `s-${state}` });
    insertTrack(repository, { id: `track-${state}`, sessionId: `s-${state}` });
    insertChunk(repository, {
      id: `chunk-${state}`,
      sessionId: `s-${state}`,
      trackId: `track-${state}`,
      transcriptionStatus: "no_speech",
    });
    insertJob(repository, {
      id: `job-${state}`,
      sessionId: `s-${state}`,
      trackId: `track-${state}`,
      chunkId: `chunk-${state}`,
      state,
      completedAt: state === "blocked" ? 500 : null,
      leaseOwner: state === "running" ? "old-worker" : null,
      leaseExpiresAt: state === "running" ? 9_000 : null,
    });
    assert.equal(
      repository.refreshSessionReadiness(`s-${state}`, 2_000).processing_state,
      "processing"
    );
    repository.close();
  }

  const open = new JarvisRepository(":memory:");
  insertSession(open, {
    id: "open",
    status: "recording",
    endedAt: null,
    processingState: "pending",
  });
  assert.notEqual(open.refreshSessionReadiness("open", 2_000).processing_state, "ready");
  open.close();
});

test("readiness requires linked tracks and final coverage through every retained chunk end", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  insertChunk(repository, { transcriptionStatus: "completed" });
  insertJob(repository, { state: "completed", completedAt: 600 });

  assert.equal(repository.refreshSessionReadiness("s1", 700).processing_state, "processing");
  insertFinalCoverage(repository, "chunk-mic");
  assert.equal(repository.refreshSessionReadiness("s1", 701).processing_state, "ready");
  assert.equal(repository.getSession("s1").ready_at, 701);
  assert.equal(repository.refreshSessionReadiness("s1", 900).ready_at, 701);

  repository.db
    .prepare("UPDATE audio_chunks SET ended_at = 501, duration_ms = 401 WHERE id = 'chunk-mic'")
    .run();
  assert.equal(repository.refreshSessionReadiness("s1", 901).processing_state, "processing");
  assert.equal(repository.getSession("s1").ready_at, null);

  repository.db.prepare("UPDATE audio_chunks SET track_id = NULL WHERE id = 'chunk-mic'").run();
  assert.equal(repository.refreshSessionReadiness("s1", 902).processing_state, "processing");
});

test("dual-track readiness waits for terminal coverage on both sources", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { captureMode: "dual" });
  insertTrack(repository);
  insertTrack(repository, { id: "track-system", sourceType: "system" });
  insertChunk(repository, { transcriptionStatus: "no_speech" });
  insertChunk(repository, {
    id: "chunk-system",
    trackId: "track-system",
    sourceType: "system",
    transcriptionStatus: "pending",
  });
  insertJob(repository, { state: "completed", completedAt: 600 });
  insertJob(repository, {
    id: "job-system",
    trackId: "track-system",
    chunkId: "chunk-system",
    state: "pending",
  });

  assert.equal(repository.refreshSessionReadiness("s1", 700).processing_state, "processing");
  repository.db
    .prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-system'")
    .run();
  repository.db
    .prepare(
      "UPDATE processing_jobs SET state = 'completed', completed_at = 701 WHERE id = 'job-system'"
    )
    .run();
  assert.equal(repository.refreshSessionReadiness("s1", 701).processing_state, "ready");
});

test("concurrent drains coalesce and stop waits for the in-flight handler", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
        return calls === 1 ? 1 : 0;
      },
    },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    maxJobsPerDrain: 1,
  });

  const first = runtime.drainOnce();
  const second = runtime.drainOnce();
  assert.equal(first, second);
  await entered.promise;
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  await Promise.all([first, stopping]);
  assert.equal(calls, 1);
});

test("post-processing runs reconcile then dedupe before readiness and isolates sessions", async () => {
  const order = [];
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: () => [{ id: "bad" }, { id: "good" }],
      isSessionReadyForPostProcessing: () => true,
      markSessionProcessing: (id) => order.push(`processing:${id}`),
      refreshSessionReadiness: (id) => order.push(`ready:${id}`),
    },
    reconciler: {
      reconcileSession: (id) => {
        order.push(`reconcile:${id}`);
        if (id === "bad") throw new Error("bad transcript");
      },
    },
    deduper: { dedupe: (id) => order.push(`dedupe:${id}`) },
    log: (entry) => order.push(`error:${entry.sessionId}`),
  });

  await runtime.drainOnce();
  assert.deepEqual(order, [
    "processing:bad",
    "reconcile:bad",
    "error:bad",
    "processing:good",
    "reconcile:good",
    "dedupe:good",
    "ready:good",
  ]);
});

test("start recovers expired leases immediately and owns an unref polling timer", async () => {
  const calls = [];
  const timer = { unref: () => calls.push("unref") };
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: (at) => calls.push(`recover:${at}`),
      runOnce: async () => 0,
    },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    now: () => 500,
    setIntervalImpl: (callback, delay) => {
      calls.push(`timer:${delay}`);
      timer.callback = callback;
      return timer;
    },
    clearIntervalImpl: (value) => calls.push(value === timer ? "clear" : "wrong-clear"),
    pollIntervalMs: 2_500,
  });

  const first = runtime.start();
  const second = runtime.start();
  assert.equal(first, second);
  await first;
  await runtime.stop();
  assert.deepEqual(calls, ["recover:500", "timer:2500", "unref", "clear"]);
});

test("startup recovery errors are surfaced without disabling immediate drain or polling", async () => {
  const calls = [];
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => {
        calls.push("recover");
        throw new Error("temporary database contention");
      },
      runOnce: async () => {
        calls.push("drain");
        return 0;
      },
    },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    setIntervalImpl: () => ({ unref: () => calls.push("unref") }),
    clearIntervalImpl: () => {},
    log: ({ phase }) => calls.push(`error:${phase}`),
  });

  assert.equal(await runtime.start(), 0);
  await runtime.stop();
  assert.deepEqual(calls, ["recover", "error:recovery", "unref", "drain"]);
});

test("production composition binds transcribe and compression handlers to current service references", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  insertChunk(repository);
  insertJob(repository);
  repository.db
    .prepare(
      `
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, priority, created_at
    ) VALUES (
      'compress-job', 's1', 'track-mic', 'chunk-mic', 'compress_chunk', 'pending',
      ?, 1, 'flac-v1', 60, 101
    )
  `
    )
    .run("chunk-mic".padEnd(64, "0").slice(0, 64));

  const calls = [];
  const compressionContexts = [];
  const admissions = [];
  const governor = {
    sample: async () => ({
      state: "available",
      selectedGpuUuid: "GPU-verified",
      restrictiveForMs: 0,
    }),
    admit: (kind) => {
      admissions.push(kind);
      return kind === "final_transcription"
        ? { action: "run_cuda", reason: "resources_available" }
        : { action: "run_cpu", reason: "resources_available" };
    },
  };
  const service = {
    audioEvidenceReader: {
      withVerifiedWav: async (_chunk, callback) => callback("verified.wav"),
    },
    flacCompressionWorker: {
      run: async (job, context) => {
        calls.push(`compress:${job.id}`);
        compressionContexts.push(context);
      },
    },
  };
  const ipcHandlers = {
    createJarvisTranscribeWavAdapter: ({ model }) => {
      calls.push(`model:${model}`);
      return async ({ executionContext }) => {
        calls.push("transcribe");
        return { noSpeech: true, executionDevice: executionContext.device };
      };
    },
  };
  const runtime = createJarvisProcessingRuntime({
    repository,
    service,
    ipcHandlers,
    model: "large-v3-turbo",
    owner: "production-worker",
    now: () => 2_000,
    governor,
    heavyGate: new HeavyJobGate(),
  });

  assert.equal(await runtime.drainOnce(), 2);
  assert.deepEqual(calls, ["model:large-v3-turbo", "transcribe", "compress:compress-job"]);
  assert.deepEqual(admissions, ["final_transcription", "maintenance"]);
  assert.deepEqual(compressionContexts, [{ owner: "production-worker" }]);
  assert.deepEqual(
    repository.db.prepare("SELECT id, execution_device FROM processing_jobs ORDER BY id").all(),
    [
      { id: "compress-job", execution_device: "cpu" },
      { id: "job-mic", execution_device: "cuda" },
    ]
  );
  assert.equal(repository.getSession("s1").processing_state, "ready");
});

test("transcription and storage compression share one heavy-work concurrency permit", async () => {
  const gate = new HeavyJobGate();
  const releaseTranscription = deferred();
  let active = 0;
  let peak = 0;
  const order = [];
  const run = (kind, release = null) =>
    gate.run(kind, async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`${kind}:start`);
      if (release) await release.promise;
      order.push(`${kind}:end`);
      active -= 1;
    });

  const transcription = run("final_transcription", releaseTranscription);
  const compression = run("storage_recovery_compress");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.getState(), { activeKind: "final_transcription", queueLength: 1 });
  releaseTranscription.resolve();
  await Promise.all([transcription, compression]);

  assert.equal(peak, 1);
  assert.deepEqual(order, [
    "final_transcription:start",
    "final_transcription:end",
    "storage_recovery_compress:start",
    "storage_recovery_compress:end",
  ]);
});

test("two production drains serialize transcription and compression through the shared gate", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  insertChunk(repository);
  insertJob(repository);
  repository.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state,
        input_hash, input_version, model_version, priority, created_at
      ) VALUES (
        'compress-job', 's1', 'track-mic', 'chunk-mic', 'compress_chunk', 'pending',
        ?, 1, 'flac-v1', 60, 101
      )`
    )
    .run("chunk-mic".padEnd(64, "0").slice(0, 64));
  const transcriptionStarted = deferred();
  const releaseTranscription = deferred();
  let active = 0;
  let peak = 0;
  const compressionContexts = [];
  const service = {
    audioEvidenceReader: {
      withVerifiedWav: async (_chunk, callback) => callback("verified.wav"),
    },
    flacCompressionWorker: {
      run: async (_job, context) => {
        compressionContexts.push(context);
        active += 1;
        peak = Math.max(peak, active);
        active -= 1;
      },
    },
  };
  const ipcHandlers = {
    createJarvisTranscribeWavAdapter:
      () =>
      async ({ executionContext }) => {
        active += 1;
        peak = Math.max(peak, active);
        transcriptionStarted.resolve();
        await releaseTranscription.promise;
        active -= 1;
        return { noSpeech: true, executionDevice: executionContext.device };
      },
  };
  const governor = {
    sample: async () => ({
      state: "available",
      selectedGpuUuid: "GPU-verified",
      restrictiveForMs: 0,
    }),
    admit: (kind) =>
      kind === "final_transcription"
        ? { action: "run_cuda", reason: "resources_available" }
        : { action: "run_cpu", reason: "resources_available" },
  };
  const gate = new HeavyJobGate();
  const common = {
    repository,
    service,
    ipcHandlers,
    model: "large-v3-turbo",
    now: () => 2_000,
    governor,
    heavyGate: gate,
    maxJobsPerDrain: 1,
  };
  const transcriptionRuntime = createJarvisProcessingRuntime({
    ...common,
    owner: "transcription-worker",
  });
  const compressionRuntime = createJarvisProcessingRuntime({
    ...common,
    owner: "compression-worker",
  });

  const transcriptionDrain = transcriptionRuntime.drainOnce();
  await transcriptionStarted.promise;
  const compressionDrain = compressionRuntime.drainOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.getState(), { activeKind: "final_transcription", queueLength: 1 });
  assert.deepEqual(compressionContexts, []);
  releaseTranscription.resolve();
  assert.deepEqual(await Promise.all([transcriptionDrain, compressionDrain]), [1, 1]);

  assert.equal(peak, 1);
  assert.deepEqual(compressionContexts, [{ owner: "compression-worker" }]);
  assert.deepEqual(
    repository.db
      .prepare("SELECT id, state, attempt_count, completed_at FROM processing_jobs ORDER BY id")
      .all(),
    [
      { id: "compress-job", state: "completed", attempt_count: 1, completed_at: 2_000 },
      { id: "job-mic", state: "completed", attempt_count: 1, completed_at: 2_000 },
    ]
  );
});

test("production runtime startup waits for FLAC authority recovery before claiming jobs", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  insertChunk(repository);
  insertJob(repository);
  const recovery = deferred();
  const calls = [];
  const service = {
    waitForCompressionRecovery: () => recovery.promise,
    audioEvidenceReader: {
      withVerifiedWav: async (_chunk, callback) => callback("verified.wav"),
    },
    flacCompressionWorker: { run: async () => {} },
  };
  const runtime = createJarvisProcessingRuntime({
    repository,
    service,
    ipcHandlers: {
      createJarvisTranscribeWavAdapter:
        () =>
        async ({ executionContext }) => {
          calls.push("transcribe");
          return { noSpeech: true, executionDevice: executionContext.device };
        },
    },
    model: "large-v3-turbo",
    owner: "startup-worker",
    now: () => 2_000,
    governor: {
      sample: async () => ({
        state: "available",
        selectedGpuUuid: "GPU-verified",
        restrictiveForMs: 0,
      }),
      admit: () => ({ action: "run_cuda", reason: "resources_available" }),
    },
    heavyGate: new HeavyJobGate(),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  const startup = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(
    repository.db.prepare("SELECT state FROM processing_jobs WHERE id = 'job-mic'").get().state,
    "pending"
  );
  recovery.resolve({ promoted: 1 });
  assert.equal(await startup, 1);
  assert.deepEqual(calls, ["transcribe"]);
  await runtime.stop();
});

test("production admission uses the real CUDA status peak at the exact safety-margin boundary", async (t) => {
  const gpuUuid = "GPU-equality";
  const peakVramMb = 2_048;
  const cudaManager = await makeVerifiedCudaManager(t, { peakVramMb, gpuUuid });
  const previousEnabled = process.env.WHISPER_CUDA_ENABLED;
  const previousUuid = process.env.TRANSCRIPTION_GPU_UUID;
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.TRANSCRIPTION_GPU_UUID = gpuUuid;
  t.after(() => {
    if (previousEnabled == null) delete process.env.WHISPER_CUDA_ENABLED;
    else process.env.WHISPER_CUDA_ENABLED = previousEnabled;
    if (previousUuid == null) delete process.env.TRANSCRIPTION_GPU_UUID;
    else process.env.TRANSCRIPTION_GPU_UUID = previousUuid;
  });

  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  let now = 1_000;
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: { withVerifiedWav: async () => ({}) },
      flacCompressionWorker: { run: async () => ({}) },
    },
    ipcHandlers: {
      whisperCudaManager: cudaManager,
      createJarvisTranscribeWavAdapter: () => async () => ({ text: "unused" }),
    },
    model: "large-v3-turbo",
    now: () => now,
    telemetryProvider: async ({ ownedPids }) => ({
      telemetryAvailable: true,
      processTelemetryAvailable: true,
      ownedPids,
      gpus: [
        {
          uuid: gpuUuid,
          totalVramMb: 8_192,
          usedVramMb: 5_120,
          freeVramMb: peakVramMb + 1_024,
          utilizationPct: 0,
        },
      ],
      processes: [],
    }),
    cpuProvider: async () => ({ loadPct: 10 }),
    powerProvider: async () => ({
      onAcPower: true,
      batteryLevelPct: 100,
      batterySaver: false,
    }),
  });

  await runtime.governor.sample();
  now += 15_000;
  const recovered = await runtime.governor.sample();
  assert.equal(cudaManager.getStatus({ gpuUuid }).verification.peakVramMb, peakVramMb);
  assert.equal(recovered.freeVramMb, peakVramMb + 1_024);
  assert.deepEqual(runtime.governor.admit("final_transcription", recovered), {
    action: "run_cuda",
    reason: "resources_available",
  });
});

test("sustained restrictive state releases only an idle Whisper server once per episode", async () => {
  let snapshot = { state: "constrained", restrictiveForMs: 59_999 };
  let idle = true;
  let stops = 0;
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    governor: { sample: async () => snapshot },
    whisperController: {
      isIdle: () => idle,
      stop: async () => {
        stops += 1;
      },
    },
  });

  await runtime.drainOnce();
  assert.equal(stops, 0);
  snapshot = { state: "constrained", restrictiveForMs: 60_000 };
  idle = false;
  await runtime.drainOnce();
  assert.equal(stops, 0);
  idle = true;
  await runtime.drainOnce();
  assert.equal(stops, 1);
  snapshot = { state: "busy", restrictiveForMs: 75_000 };
  await runtime.drainOnce();
  assert.equal(stops, 1);
  snapshot = { state: "available", restrictiveForMs: 0 };
  await runtime.drainOnce();
  snapshot = { state: "constrained", restrictiveForMs: 60_000 };
  await runtime.drainOnce();
  assert.equal(stops, 2);
});

test("stop reached during the first handler prevents every later claim in the same drain", async () => {
  const entered = deferred();
  const release = deferred();
  let claims = 0;
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async () => {
        claims += 1;
        if (claims === 1) {
          entered.resolve();
          await release.promise;
        }
        return 1;
      },
    },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    maxJobsPerDrain: 3,
  });

  const draining = runtime.drainOnce();
  await entered.promise;
  const stopping = runtime.stop();
  release.resolve();
  await Promise.all([draining, stopping]);

  assert.equal(claims, 1);
});

test("committing required evidence invalidates ready atomically and same drain post-processes it", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { processingState: "processing" });
  insertTrack(repository);
  const initiallyReady = repository.refreshSessionReadiness("s1", 1_500);
  assert.equal(initiallyReady.processing_state, "ready");
  const previousTimeline = initiallyReady.timeline_version;

  repository.commitChunk({
    id: "chunk-late",
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    sequenceNumber: 0,
    path: "chunk-late.wav",
    startedAt: 500,
    endedAt: 900,
    durationMs: 400,
    sha256: "f".repeat(64),
    expiresAt: 999_999,
  });

  const invalidated = repository.getSession("s1");
  assert.equal(invalidated.processing_state, "processing");
  assert.equal(invalidated.ready_at, null);
  assert.equal(invalidated.timeline_version, previousTimeline + 1);

  const order = [];
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner: "same-drain-worker",
    now: () => 2_000,
  });
  runner.register("transcribe_chunk", async (job) => {
    repository.commitChunkTranscript({
      chunk: repository.getAudioChunk(job.chunk_id),
      result: { noSpeech: true },
      modelVersion: "large-v3-turbo",
      completedAt: 2_000,
    });
  });
  const runtime = new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: { reconcileSession: (id) => order.push(`reconcile:${id}`) },
    deduper: { dedupe: (id) => order.push(`dedupe:${id}`) },
    now: () => 2_000,
  });
  const originalRefresh = repository.refreshSessionReadiness.bind(repository);
  repository.refreshSessionReadiness = (id, at) => {
    order.push(`ready:${id}`);
    return originalRefresh(id, at);
  };

  assert.equal(await runtime.drainOnce(), 1);
  assert.deepEqual(order, ["reconcile:s1", "dedupe:s1", "ready:s1"]);
  const readyAgain = repository.getSession("s1");
  assert.equal(readyAgain.processing_state, "ready");
  assert.equal(readyAgain.ready_at, 2_000);
  assert.equal(readyAgain.timeline_version, previousTimeline + 2);
});

test("enqueueing a new transcription version invalidates ready in the job transaction", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { processingState: "processing" });
  insertTrack(repository);
  insertChunk(repository, { transcriptionStatus: "no_speech" });
  insertJob(repository, { state: "completed", completedAt: 700 });
  const ready = repository.refreshSessionReadiness("s1", 1_500);
  assert.equal(ready.processing_state, "ready");

  repository.captureEvidenceStore.enqueueChunkTranscription({
    id: "chunk-mic",
    sessionId: "s1",
    trackId: "track-mic",
    sourceType: "mic",
    sequenceNumber: 0,
    path: "s1-chunk-mic.wav",
    startedAt: 100,
    endedAt: 500,
    durationMs: 400,
    sha256: "chunk-mic".padEnd(64, "0").slice(0, 64),
    expiresAt: 999_999,
    inputVersion: 2,
    modelVersion: "replacement-model",
  });

  const invalidated = repository.getSession("s1");
  assert.equal(invalidated.processing_state, "processing");
  assert.equal(invalidated.ready_at, null);
  assert.equal(invalidated.timeline_version, ready.timeline_version + 1);
});

test("post-processing shares the drain deadline and does not start another session after expiry", async () => {
  let now = 0;
  const order = [];
  const sessions = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: ({ after = null, limit = sessions.length } = {}) => {
        const start =
          after === null ? 0 : sessions.findIndex((session) => session.id === after.id) + 1;
        return sessions.slice(start, start + limit);
      },
      isSessionReadyForPostProcessing: () => true,
      markSessionProcessing: () => {},
      refreshSessionReadiness: (id) => order.push(`ready:${id}`),
    },
    reconciler: {
      reconcileSession: (id) => {
        order.push(`reconcile:${id}`);
        now = 11;
      },
    },
    deduper: { dedupe: (id) => order.push(`dedupe:${id}`) },
    now: () => now,
    maxDrainMs: 10,
    maxSessionsPerDrain: 3,
  });

  await runtime.drainOnce();
  assert.deepEqual(order, ["reconcile:s1", "dedupe:s1", "ready:s1"]);
});

test("session post-processing cap rotates a stable backlog without starvation", async () => {
  const order = [];
  const sessions = ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ id }));
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: ({ after = null, limit = sessions.length } = {}) => {
        const start =
          after === null ? 0 : sessions.findIndex((session) => session.id === after.id) + 1;
        return sessions.slice(start, start + limit);
      },
      isSessionReadyForPostProcessing: () => true,
      markSessionProcessing: () => {},
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: (id) => order.push(id) },
    deduper: { dedupe: () => {} },
    maxSessionsPerDrain: 2,
  });

  await runtime.drainOnce();
  assert.deepEqual(order, ["s1", "s2"]);
  await runtime.drainOnce();
  assert.deepEqual(order, ["s1", "s2", "s3", "s4"]);
  await runtime.drainOnce();
  assert.deepEqual(order, ["s1", "s2", "s3", "s4", "s5", "s1"]);
});

test("pre-drain and post-drain processing candidates are unioned in one bounded pass", async () => {
  let lists = 0;
  const order = [];
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: () => {
        lists += 1;
        return lists === 1 ? [{ id: "before" }] : [{ id: "after" }];
      },
      isSessionReadyForPostProcessing: () => true,
      markSessionProcessing: () => {},
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: (id) => order.push(`reconcile:${id}`) },
    deduper: { dedupe: () => {} },
    maxSessionsPerDrain: 2,
  });

  await runtime.drainOnce();
  assert.deepEqual(order, ["reconcile:before", "reconcile:after"]);
});

test("blocked and retry transcription sessions stay processing without heavy post-processing", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  for (const state of ["blocked", "retry"]) {
    const sessionId = `s-${state}`;
    const trackId = `track-${state}`;
    const chunkId = `chunk-${state}`;
    insertSession(repository, { id: sessionId });
    insertTrack(repository, { id: trackId, sessionId });
    insertChunk(repository, {
      id: chunkId,
      sessionId,
      trackId,
      transcriptionStatus: "no_speech",
    });
    insertJob(repository, {
      id: `job-${state}`,
      sessionId,
      trackId,
      chunkId,
      state,
      completedAt: state === "blocked" ? 600 : null,
    });
  }
  const heavy = [];
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository,
    reconciler: { reconcileSession: (id) => heavy.push(`reconcile:${id}`) },
    deduper: { dedupe: (id) => heavy.push(`dedupe:${id}`) },
    maxSessionsPerDrain: 2,
  });

  await runtime.drainOnce();
  assert.deepEqual(heavy, []);
  assert.equal(repository.getSession("s-blocked").processing_state, "processing");
  assert.equal(repository.getSession("s-retry").processing_state, "processing");
});

test("long jobs cannot permanently starve eligible session post-processing across drains", async () => {
  let now = 0;
  let claims = 0;
  const post = [];
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async () => {
        claims += 1;
        now += 6;
        return 1;
      },
    },
    repository: {
      listProcessingSessions: () => [{ id: "eligible", finalized_at: 1, ended_at: 1 }],
      isSessionReadyForPostProcessing: () => true,
      markSessionProcessing: () => {},
      refreshSessionReadiness: (id) => post.push(`ready:${id}`),
    },
    reconciler: { reconcileSession: (id) => post.push(`reconcile:${id}`) },
    deduper: { dedupe: (id) => post.push(`dedupe:${id}`) },
    now: () => now,
    maxJobsPerDrain: 1,
    maxSessionsPerDrain: 1,
    maxDrainMs: 5,
  });

  await runtime.drainOnce();
  await runtime.drainOnce();
  await runtime.drainOnce();

  assert.equal(claims, 3);
  assert.deepEqual(post, ["reconcile:eligible", "dedupe:eligible", "ready:eligible"]);
});

test("bounded processing-session pages rotate past blocked backlog to an eligible session", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  for (let index = 1; index <= 6; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const sessionId = `s${suffix}`;
    const trackId = `track-${suffix}`;
    const chunkId = `chunk-${suffix}`;
    const state = index % 2 === 0 ? "retry" : "blocked";
    insertSession(repository, { id: sessionId });
    insertTrack(repository, { id: trackId, sessionId });
    insertChunk(repository, {
      id: chunkId,
      sessionId,
      trackId,
      transcriptionStatus: "no_speech",
    });
    insertJob(repository, {
      id: `job-${suffix}`,
      sessionId,
      trackId,
      chunkId,
      state,
      completedAt: state === "blocked" ? 600 : null,
    });
  }
  insertSession(repository, { id: "s99-eligible" });
  insertTrack(repository, { id: "track-eligible", sessionId: "s99-eligible" });
  insertChunk(repository, {
    id: "chunk-eligible",
    sessionId: "s99-eligible",
    trackId: "track-eligible",
    transcriptionStatus: "no_speech",
  });
  insertJob(repository, {
    id: "job-eligible",
    sessionId: "s99-eligible",
    trackId: "track-eligible",
    chunkId: "chunk-eligible",
    state: "completed",
    completedAt: 700,
  });
  repository.db
    .prepare(
      `
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'compress-eligible', 's99-eligible', 'track-eligible', 'chunk-eligible',
      'compress_chunk', 'retry', ?, 1, 'flac-v1', 101
    )
  `
    )
    .run("chunk-eligible".padEnd(64, "0").slice(0, 64));

  const queries = [];
  const listProcessingSessions = repository.listProcessingSessions.bind(repository);
  repository.listProcessingSessions = (options) => {
    const rows = listProcessingSessions(options);
    queries.push({ options, count: rows.length });
    return rows;
  };
  const heavy = [];
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases: () => 0, runOnce: async () => 0 },
    repository,
    reconciler: { reconcileSession: (id) => heavy.push(`reconcile:${id}`) },
    deduper: { dedupe: (id) => heavy.push(`dedupe:${id}`) },
    now: () => 2_000,
    maxSessionsPerDrain: 2,
  });

  for (let drain = 0; drain < 4; drain += 1) await runtime.drainOnce();

  assert.ok(queries.length >= 4);
  assert.ok(
    queries.every(
      ({ options, count }) =>
        Number.isSafeInteger(options?.limit) &&
        options.limit > 0 &&
        options.limit <= 2 &&
        count <= options.limit
    )
  );
  assert.deepEqual(heavy, ["reconcile:s99-eligible", "dedupe:s99-eligible"]);
  assert.equal(repository.getSession("s99-eligible").processing_state, "ready");
  assert.equal(
    repository.listPendingJobs("s99-eligible").some((job) => job.job_type === "compress_chunk"),
    true
  );
});

test("production runtime ticks an injected preview through the shared heavy gate", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { status: "recording", processingState: "pending", endedAt: null });
  insertTrack(repository, { endedAt: null });
  const gate = new HeavyJobGate();
  const releaseHeavy = deferred();
  const heavyStarted = deferred();
  const previewCalls = [];
  const persisted = [];
  const governor = {
    sample: async () => ({
      state: "available",
      reason: "resources_available",
      selectedGpuUuid: "GPU-verified",
      restrictiveForMs: 0,
      previewEnabled: true,
      cpuTelemetryAvailable: true,
      cpuLoadPct: 10,
      powerTelemetryAvailable: true,
      batterySaver: false,
    }),
    admit: () => ({ action: "run_cuda", reason: "resources_available" }),
  };
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: { withVerifiedWav: async () => ({}) },
      flacCompressionWorker: { run: async () => {} },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async () => ({ noSpeech: true }),
    },
    model: "large-v3-turbo",
    now: () => 0,
    governor,
    heavyGate: gate,
    previewExecutor: async (input) => {
      previewCalls.push(input);
      return { segments: [] };
    },
    previewPersist: (input) => persisted.push(input),
  });

  const heavy = gate.run("final_transcription", async () => {
    heavyStarted.resolve();
    await releaseHeavy.promise;
  });
  await heavyStarted.promise;
  runtime.requestPreview({ sessionId: "s1", trackId: "track-mic", throughMs: 30_000 });
  const drain = runtime.drainOnce();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(previewCalls, []);
  assert.deepEqual(gate.getState(), { activeKind: "final_transcription", queueLength: 1 });
  assert.equal(runtime.previewStatus().pending, 0);
  assert.equal(runtime.previewStatus().running, 1);

  releaseHeavy.resolve();
  await Promise.all([heavy, drain]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(previewCalls.length, 1);
  assert.equal(previewCalls[0].executionDevice, "cuda");
  assert.equal(persisted.length, 1);
  assert.equal(runtime.previewStatus().mode, "normal");
});

test("production default preview path transcribes bounded committed audio as provisional", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { status: "recording", processingState: "pending", endedAt: null });
  insertTrack(repository, { endedAt: null });
  insertChunk(repository, { transcriptionStatus: "pending" });
  const adapterCalls = [];
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: {
        withVerifiedWav: async (chunk, callback) => callback(`verified-${chunk.id}.wav`),
      },
      flacCompressionWorker: { run: async () => {} },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async (input) => {
        adapterCalls.push(input);
        return { text: "preview text", confidence: 0.8, executionDevice: "cuda" };
      },
    },
    model: "large-v3-turbo",
    now: () => 1_000,
    governor: {
      sample: async () => ({
        state: "available",
        reason: "resources_available",
        restrictiveForMs: 0,
        selectedGpuUuid: "GPU-verified",
        previewEnabled: true,
      }),
      admit: () => ({ action: "run_cuda", reason: "resources_available" }),
    },
    heavyGate: new HeavyJobGate(),
  });

  runtime.requestPreview({ sessionId: "s1", trackId: "track-mic", throughMs: 1_000 });
  await runtime.drainOnce();
  await runtime.previewInFlight;

  assert.equal(adapterCalls.length, 1);
  assert.deepEqual(
    repository.listTranscriptHistory("s1").map((row) => ({
      text: row.text,
      resultKind: row.result_kind,
      trackId: row.track_id,
    })),
    [{ text: "preview text", resultKind: "provisional", trackId: "track-mic" }]
  );
  assert.equal(runtime.previewStatus().lastError, null);
  assert.equal(repository.getSession("s1").processing_state, "pending");
});
