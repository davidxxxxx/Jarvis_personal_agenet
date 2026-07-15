const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const PreviewTranscriptionScheduler = require("../../src/jarvis/main/PreviewTranscriptionScheduler");
const ResourceGovernor = require("../../src/jarvis/main/ResourceGovernor");
const WhisperCudaManager = require("../../src/helpers/whisperCudaManager");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("../../src/jarvis/main/SessionDiarizationPolicy");
const {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
  createCommittedAudioPreviewExecutor,
} = require("../../src/jarvis/main/JarvisProcessingRuntime");

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function finalSpeakerPolicy(model = "large-v3-turbo") {
  return new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: model,
  });
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
    speakerProcessingPolicy: finalSpeakerPolicy(),
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
      enqueueDiarizationJobs: (id) => order.push(`diarize:${id}`),
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
    "diarize:good",
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
      runOnce: async (_at, { priorityBefore } = {}) => {
        if (priorityBefore === 20) return 0;
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
    previewAudioRing: { withPreviewWav: async () => null },
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

test("production composition registers diarize_track as CPU speaker work", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  const revision = "a".repeat(64);
  const jobKey = buildDiarizationJobKey({
    sessionId: "s1",
    trackId: "track-mic",
    evidenceRevision: revision,
  });
  repository.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      ) VALUES (
        'diarize-job', 's1', 'track-mic', NULL, 'diarize_track', 'pending', 40,
        ?, 1, ?, 100
      )`
    )
    .run(jobKey, SESSION_DIARIZATION_POLICY.policyId);
  const calls = [];
  const capabilities = [];
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: { withVerifiedWav: async (_chunk, consume) => consume("verified.wav") },
      flacCompressionWorker: { run: async () => {} },
      previewAudioRing: { withPreviewWav: async () => null },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async () => ({ noSpeech: true }),
    },
    sessionDiarizationWorker: {
      run: async (job, context) => {
        calls.push(job.id);
        assert.equal(typeof context.renewLease, "function");
        return { executionDevice: "cpu" };
      },
    },
    model: "large-v3-turbo",
    owner: "speaker-worker",
    now: () => 2000,
    governor: {
      sample: async () => ({
        state: "available",
        selectedGpuUuid: "GPU-a",
        cpuLoadPct: 10,
        cpuTelemetryAvailable: true,
        powerTelemetryAvailable: true,
        batterySaver: false,
      }),
      admit: (kind, _snapshot, capability) => {
        capabilities.push({ kind, capability });
        return { action: "run_cpu", reason: "cpu_backend" };
      },
    },
    heavyGate: new HeavyJobGate(),
    maxJobsPerDrain: 1,
  });

  assert.equal(Object.isFrozen(runtime.speakerProcessingPolicy), true);
  assert.equal(runtime.speakerProcessingPolicy.transcriptionInputVersion, 1);
  assert.equal(runtime.speakerProcessingPolicy.transcriptionModelVersion, "large-v3-turbo");

  assert.equal(await runtime.drainOnce(), 1);
  assert.deepEqual(calls, ["diarize-job"]);
  assert.deepEqual(capabilities, [{ kind: "speaker", capability: { executionDevice: "cpu" } }]);
  assert.deepEqual(
    repository.db
      .prepare("SELECT state, execution_device FROM processing_jobs WHERE id = 'diarize-job'")
      .get(),
    { state: "completed", execution_device: "cpu" }
  );
});

test("production composition builds the durable diarization worker from local managers", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository, { endedAt: 4_000 });
  insertTrack(repository, { endedAt: 4_000 });
  repository.db.prepare("UPDATE audio_tracks SET state = 'ended' WHERE id = 'track-mic'").run();
  insertChunk(repository, { startedAt: 100, endedAt: 4_000 });
  insertJob(repository, { state: "completed", completedAt: 4_200 });
  repository.db
    .prepare("UPDATE processing_jobs SET model_version = 'large-v3-turbo' WHERE id = 'job-mic'")
    .run();
  insertFinalCoverage(repository, "chunk-mic", 4_200);
  const speakerProcessingPolicy = new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: "large-v3-turbo",
  });
  const snapshot = repository.getDiarizationEvidenceSnapshot({
    sessionId: "s1",
    trackId: "track-mic",
    at: 5_000,
    speakerProcessingPolicy,
  });
  assert.equal(snapshot.eligible, true);
  let modelsAvailable = true;
  repository.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      ) VALUES (
        'default-diarize-job', 's1', 'track-mic', NULL, 'diarize_track', 'pending', 40,
        ?, 1, ?, 4_300
      )`
    )
    .run(
      buildDiarizationJobKey({
        sessionId: "s1",
        trackId: "track-mic",
        evidenceRevision: snapshot.evidenceRevision,
      }),
      SESSION_DIARIZATION_POLICY.policyId
    );
  const calls = [];
  const capabilities = [];
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: {
        withVerifiedWav: async (_chunk, consume) => consume("verified-final.wav"),
      },
      flacCompressionWorker: { run: async () => {} },
      previewAudioRing: { withPreviewWav: async () => null },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async () => ({ noSpeech: true }),
      diarizationManager: {
        isAvailable: () => modelsAvailable,
        diarizeStrict: async (wavPath) => {
          calls.push(["diarize", wavPath]);
          return [{ start: 0, end: 2, speaker: "speaker-a" }];
        },
        getModelArtifactSha256: async () => "b".repeat(64),
      },
    },
    speakerEmbeddingHelper: {
      isAvailable: () => true,
      getModelArtifactSha256: async () => "c".repeat(64),
      extractEmbedding: async (wavPath, startSec, endSec) => {
        calls.push(["embed", wavPath, startSec, endSec]);
        const embedding = new Float32Array(512);
        embedding[0] = 1;
        return embedding;
      },
    },
    model: "large-v3-turbo",
    owner: "default-speaker-worker",
    now: () => 5_000,
    governor: {
      sample: async () => ({
        state: "available",
        cpuLoadPct: 10,
        cpuTelemetryAvailable: true,
        powerTelemetryAvailable: true,
        batterySaver: false,
      }),
      admit: (kind, _snapshot, capability) => {
        capabilities.push({ kind, capability });
        return { action: "run_cpu", reason: "cpu_backend" };
      },
    },
    heavyGate: new HeavyJobGate(),
    maxJobsPerDrain: 1,
  });

  assert.equal(await runtime.drainOnce(), 1);
  assert.deepEqual(capabilities, [
    {
      kind: "speaker",
      capability: { executionDevice: "cpu", available: true },
    },
  ]);
  assert.deepEqual(calls, [
    ["diarize", "verified-final.wav"],
    ["embed", "verified-final.wav", 0, 2],
  ]);
  const [run] = repository.listDiarizationRuns("s1");
  assert.ok(run);
  const expectedArtifactHash = require("node:crypto")
    .createHash("sha256")
    .update(`diarization-manager\0${"b".repeat(64)}\0`)
    .update(`speaker-embedding-helper\0${"c".repeat(64)}\0`)
    .digest("hex");
  assert.equal(run.model_artifact_sha256, expectedArtifactHash);
  modelsAvailable = false;
  assert.deepEqual(runtime.runner.classifyCapability({ job_type: "diarize_track" }), {
    executionDevice: "cpu",
    available: false,
    unavailableReason: "diarization_model_unavailable",
  });
});

test("production composition passes CPU speaker lease context into identity resolution", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  repository.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      ) VALUES (
        'resolve-job', 's1', NULL, NULL, 'resolve_identities', 'pending', 45,
        'resolve-input', 1, 'identity-policy', 100
      )`
    )
    .run();
  const calls = [];
  const admissions = [];
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: { withVerifiedWav: async (_chunk, consume) => consume("verified.wav") },
      flacCompressionWorker: { run: async () => {} },
      previewAudioRing: { withPreviewWav: async () => null },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async () => ({ noSpeech: true }),
    },
    speakerIdentityResolutionWorker: {
      run: async (job, context) => {
        calls.push({ job, context });
        return { executionDevice: "cpu" };
      },
    },
    model: "large-v3-turbo",
    owner: "identity-worker",
    now: () => 2_000,
    governor: {
      sample: async () => ({
        state: "available",
        selectedGpuUuid: "GPU-a",
        cpuLoadPct: 10,
        cpuTelemetryAvailable: true,
        powerTelemetryAvailable: true,
        batterySaver: false,
      }),
      admit: (kind, _snapshot, capability) => {
        admissions.push({ kind, capability });
        return { action: "run_cpu", reason: "cpu_backend" };
      },
    },
    heavyGate: new HeavyJobGate(),
    maxJobsPerDrain: 1,
  });

  assert.equal(await runtime.drainOnce(), 1);
  assert.equal(calls[0].job.id, "resolve-job");
  assert.equal(calls[0].context.device, "cpu");
  assert.equal(typeof calls[0].context.renewLease, "function");
  assert.deepEqual(admissions, [{ kind: "speaker", capability: { executionDevice: "cpu" } }]);
  assert.deepEqual(
    repository.db
      .prepare("SELECT state, execution_device FROM processing_jobs WHERE id = 'resolve-job'")
      .get(),
    { state: "completed", execution_device: "cpu" }
  );
});

test("missing local diarization dependencies defer instead of producing HANDLER_MISSING", async (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  insertSession(repository);
  insertTrack(repository);
  const revision = "c".repeat(64);
  repository.db
    .prepare(
      `INSERT INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      ) VALUES (
        'unavailable-diarize-job', 's1', 'track-mic', NULL, 'diarize_track', 'pending', 40,
        ?, 1, ?, 100
      )`
    )
    .run(
      buildDiarizationJobKey({
        sessionId: "s1",
        trackId: "track-mic",
        evidenceRevision: revision,
      }),
      SESSION_DIARIZATION_POLICY.policyId
    );
  const resourceGovernor = new ResourceGovernor();
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: { withVerifiedWav: async () => assert.fail("audio was read") },
      flacCompressionWorker: { run: async () => {} },
      previewAudioRing: { withPreviewWav: async () => null },
    },
    ipcHandlers: {
      createJarvisTranscribeWavAdapter: () => async () => ({ noSpeech: true }),
    },
    model: "large-v3-turbo",
    owner: "unavailable-speaker-worker",
    now: () => 2_000,
    governor: {
      sample: async () => ({
        state: "available",
        cpuLoadPct: 10,
        cpuTelemetryAvailable: true,
        powerTelemetryAvailable: true,
        batterySaver: false,
      }),
      admit: resourceGovernor.admit.bind(resourceGovernor),
    },
    heavyGate: new HeavyJobGate(),
    maxJobsPerDrain: 1,
  });

  assert.equal(runtime.runner.handlers.has("diarize_track"), true);
  assert.equal(await runtime.drainOnce(), 1);
  assert.deepEqual(
    repository.db
      .prepare(
        "SELECT state, attempt_count, next_retry_at, blocked_reason, error_code FROM processing_jobs WHERE id = 'unavailable-diarize-job'"
      )
      .get(),
    {
      state: "retry",
      attempt_count: 0,
      next_retry_at: 1_802_000,
      blocked_reason: "diarization_runtime_unavailable",
      error_code: null,
    }
  );
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
    previewAudioRing: { withPreviewWav: async () => null },
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
    previewAudioRing: { withPreviewWav: async () => null },
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
      previewAudioRing: { withPreviewWav: async () => null },
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

test("stop joins active work before releasing the owned Whisper server", async () => {
  const entered = deferred();
  const release = deferred();
  const order = [];
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async () => {
        order.push("work-entered");
        entered.resolve();
        await release.promise;
        order.push("work-finished");
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
    whisperController: {
      isIdle: () => false,
      stop: async () => order.push("whisper-released"),
    },
  });

  const draining = runtime.drainOnce();
  await entered.promise;
  const stopping = runtime.stop();
  assert.deepEqual(order, ["work-entered"]);
  release.resolve();
  await Promise.all([draining, stopping]);

  assert.deepEqual(order, ["work-entered", "work-finished", "whisper-released"]);
});

test("stop releases Whisper after a rejected join and preserves the original failure", async () => {
  const entered = deferred();
  const release = deferred();
  const joinFailure = new Error("processing join failed");
  const order = [];
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async () => {
        order.push("work-entered");
        entered.resolve();
        await release.promise;
        order.push("work-rejected");
        throw joinFailure;
      },
    },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness: () => {},
    },
    reconciler: { reconcileSession: () => {} },
    deduper: { dedupe: () => {} },
    whisperController: {
      isIdle: () => false,
      stop: async () => order.push("whisper-released"),
    },
  });

  const draining = runtime.drainOnce();
  await entered.promise;
  const stopping = runtime.stop();
  release.resolve();

  await assert.rejects(draining, (error) => error === joinFailure);
  await assert.rejects(stopping, (error) => error === joinFailure);
  assert.deepEqual(order, ["work-entered", "work-rejected", "whisper-released"]);
});

test("stop reached during the first handler prevents every later claim in the same drain", async () => {
  const entered = deferred();
  const release = deferred();
  let claims = 0;
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases: () => 0,
      runOnce: async (_at, { priorityBefore } = {}) => {
        if (priorityBefore === 20) return 0;
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
    speakerProcessingPolicy: finalSpeakerPolicy(),
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
    speakerProcessingPolicy: finalSpeakerPolicy("whisper-v1"),
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
      runOnce: async (_at, { priorityBefore } = {}) => {
        if (priorityBefore === 20) return 0;
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
    speakerProcessingPolicy: finalSpeakerPolicy("whisper-v1"),
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
  const adapterCalls = [];
  const ringCalls = [];
  const runtime = createJarvisProcessingRuntime({
    repository,
    service: {
      audioEvidenceReader: {
        withVerifiedWav: async () => assert.fail("live preview read durable final evidence"),
      },
      flacCompressionWorker: { run: async () => {} },
      previewAudioRing: {
        withPreviewWav: async (input, callback) => {
          ringCalls.push(input);
          return callback({
            path: "live-preview.preview.wav",
            sourceType: "mic",
            fromMs: input.fromMs,
            throughMs: input.throughMs,
            sha256: "a".repeat(64),
          });
        },
      },
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
  assert.deepEqual(ringCalls, [
    { sessionId: "s1", trackId: "track-mic", fromMs: 0, throughMs: 1_000 },
  ]);
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

test("idle runtime admits claimable retention and storage before preview, then final", async () => {
  const gate = new HeavyJobGate();
  const order = [];
  const durableKinds = ["retention_urgent", "storage_recovery_compress", "final_transcription"];
  const runner = {
    recoverExpiredLeases() {},
    async runOnce(_at, { priorityBefore = Number.MAX_SAFE_INTEGER } = {}) {
      const priority = {
        retention_urgent: 0,
        storage_recovery_compress: 10,
        final_transcription: 30,
      };
      const index = durableKinds.findIndex((kind) => priority[kind] < priorityBefore);
      if (index < 0) return 0;
      const [kind] = durableKinds.splice(index, 1);
      await gate.run(kind, () => {
        order.push(kind);
      });
      return 1;
    },
  };
  const previewScheduler = new PreviewTranscriptionScheduler({
    heavyGate: gate,
    now: () => 0,
    executePreview: async () => {
      order.push("preview");
      return { segments: [] };
    },
    persistProvisional() {},
  });
  const runtime = new JarvisProcessingRuntime({
    runner,
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => false,
      refreshSessionReadiness() {},
    },
    reconciler: { reconcileSession() {} },
    deduper: { dedupe() {} },
    governor: {
      sample: async () => ({
        state: "available",
        reason: "resources_available",
        selectedGpuUuid: "GPU-verified",
        restrictiveForMs: 0,
        previewEnabled: true,
      }),
    },
    previewScheduler,
    now: () => 0,
  });
  runtime.requestPreview({ sessionId: "s1", trackId: "track-mic", throughMs: 30_000 });

  await runtime.drainOnce();
  await runtime.previewInFlight;

  assert.deepEqual(order, [
    "retention_urgent",
    "storage_recovery_compress",
    "preview",
    "final_transcription",
  ]);
});

test("stop during governor sampling prevents a late preview from escaping the shutdown join", async () => {
  const sampled = deferred();
  let previewTicks = 0;
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases() {}, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => false,
      refreshSessionReadiness() {},
    },
    reconciler: { reconcileSession() {} },
    deduper: { dedupe() {} },
    governor: { sample: () => sampled.promise },
    previewScheduler: {
      request() {},
      status: () => ({ mode: "paused" }),
      tick: async () => {
        previewTicks += 1;
      },
    },
  });

  const drain = runtime.drainOnce();
  const stopped = runtime.stop();
  sampled.resolve({
    state: "available",
    reason: "resources_available",
    previewEnabled: true,
  });
  await Promise.all([drain, stopped]);

  assert.equal(previewTicks, 0);
  assert.equal(runtime.previewInFlight, null);
});

test("stop during atomic preview arbitration joins durable work without starting preview", async () => {
  const gate = new HeavyJobGate();
  const arbitrationStarted = deferred();
  const releaseArbitration = deferred();
  let previewExecutions = 0;
  const previewScheduler = new PreviewTranscriptionScheduler({
    heavyGate: gate,
    now: () => 0,
    beforePreviewStart: async () => {
      arbitrationStarted.resolve();
      await releaseArbitration.promise;
    },
    executePreview: async () => {
      previewExecutions += 1;
      return { segments: [] };
    },
    persistProvisional() {},
  });
  const runtime = new JarvisProcessingRuntime({
    runner: { recoverExpiredLeases() {}, runOnce: async () => 0 },
    repository: {
      listProcessingSessions: () => [],
      isSessionReadyForPostProcessing: () => false,
      refreshSessionReadiness() {},
    },
    reconciler: { reconcileSession() {} },
    deduper: { dedupe() {} },
    governor: {
      sample: async () => ({
        state: "available",
        reason: "resources_available",
        previewEnabled: true,
      }),
    },
    previewScheduler,
    now: () => 0,
  });
  runtime.requestPreview({ sessionId: "s1", trackId: "track-mic", throughMs: 15_000 });

  const drain = runtime.drainOnce();
  await arbitrationStarted.promise;
  const stopped = runtime.stop();
  releaseArbitration.resolve();
  await Promise.all([drain, stopped]);

  assert.equal(previewExecutions, 0);
  assert.equal(runtime.previewInFlight, null);
  assert.equal(gate.getState().activeKind, null);
});

test("delayed sampling and a slow session phase cannot move preview ahead of urgent durable work", async () => {
  const sampled = deferred();
  const releaseReconcile = deferred();
  const order = [];
  let urgentPending = true;
  const runtime = new JarvisProcessingRuntime({
    runner: {
      recoverExpiredLeases() {},
      async runOnce(_at, options = {}) {
        if (!urgentPending) return 0;
        if (options.priorityBefore !== 20) return 0;
        urgentPending = false;
        order.push("retention_urgent");
        return 1;
      },
    },
    repository: {
      listProcessingSessions: () => [{ id: "s1", ended_at: 100 }],
      isSessionReadyForPostProcessing: () => true,
      refreshSessionReadiness() {},
    },
    reconciler: {
      async reconcileSession() {
        order.push("reconcile");
        await releaseReconcile.promise;
      },
    },
    deduper: { dedupe() {} },
    governor: { sample: () => sampled.promise },
    previewScheduler: {
      request() {},
      status: () => ({ mode: "normal" }),
      tick: async () => order.push("preview"),
    },
    now: () => 0,
  });
  runtime.sessionPhaseFirst = true;

  const drain = runtime.drainOnce();
  sampled.resolve({
    state: "available",
    reason: "resources_available",
    previewEnabled: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order.slice(0, 3), ["retention_urgent", "preview", "reconcile"]);
  releaseReconcile.resolve();
  await drain;
});

test("production live preview persists PCM coverage within a 30-second p95 at a five-second poll", async () => {
  const pollWaits = [0, 1_000, 2_500, 4_000, 4_999];
  const latencies = [];
  const observedPollWaits = [];

  for (const pollWaitMs of pollWaits) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-preview-p95-"));
    const repository = new JarvisRepository(":memory:");
    const safeFs = Object.create(fs);
    safeFs.statfsSync = () => ({
      bsize: 1,
      blocks: 200 * 1024 ** 3,
      bavail: 20 * 1024 ** 3,
    });
    let wallNow = 0;
    let requestedAt = null;
    let persistedAt = null;
    let inferenceDuration = null;
    let runtime = null;
    const service = new JarvisService({
      repository,
      userDataDir,
      fsImpl: safeFs,
      now: () => wallNow,
      broadcast() {},
      flacCompressionWorker: {
        recoverStartup: async () => ({ promoted: 0, deletedWavs: 0, removedInvalid: 0 }),
        run: async () => {},
      },
      onPreviewWatermark: (request) => {
        requestedAt = wallNow;
        runtime.requestPreview(request);
      },
    });
    try {
      repository.createSession({
        id: "preview-latency",
        startedAt: 0,
        micDeviceId: null,
        captureMode: "mic",
        retentionMode: "continuous",
      });
      runtime = createJarvisProcessingRuntime({
        repository,
        service,
        ipcHandlers: {
          createJarvisTranscribeWavAdapter:
            () =>
            async ({ executionContext }) => {
              const inferenceStartedAt = wallNow;
              wallNow += 9_000;
              inferenceDuration = wallNow - inferenceStartedAt;
              return {
                text: "preview coverage",
                confidence: 0.9,
                executionDevice: executionContext.device,
              };
            },
        },
        model: "large-v3-turbo",
        now: () => wallNow,
        governor: {
          sample: async () => ({
            state: "available",
            reason: "resources_available",
            selectedGpuUuid: "GPU-preview",
            restrictiveForMs: 0,
            previewEnabled: true,
          }),
          admit: () => ({ action: "run_cuda", reason: "resources_available" }),
        },
        heavyGate: new HeavyJobGate(),
        pollIntervalMs: 5_000,
        previewPersist: ({ sessionId, segments }) => {
          persistedAt = wallNow;
          return repository.upsertTranscriptSegments(sessionId, segments);
        },
      });
      service.startCapture({
        sessionId: "preview-latency",
        startedAt: 0,
        micDeviceId: null,
        retentionMode: "continuous",
      });
      for (let second = 1; second <= 15; second += 1) {
        wallNow = second * 1_000;
        service.appendPcm("preview-latency", "mic", Buffer.alloc(48_000, second));
      }
      assert.equal(requestedAt, 15_000);
      assert.equal(repository.listAudioChunks("preview-latency").length, 0);
      wallNow += pollWaitMs;
      observedPollWaits.push(wallNow - requestedAt);
      await runtime.drainOnce();
      await runtime.previewInFlight;
      assert.equal(inferenceDuration, 9_000);
      assert.equal(repository.listAudioChunks("preview-latency").length, 0);
      assert.equal(repository.listTranscriptHistory("preview-latency").length, 1);
      latencies.push(persistedAt - 1_000);

      for (let second = 16; second <= 60; second += 1) {
        wallNow += 1_000;
        service.appendPcm("preview-latency", "mic", Buffer.alloc(48_000, second));
      }
      assert.deepEqual(
        repository.listAudioChunks("preview-latency").map((chunk) => chunk.duration_ms),
        [60_000]
      );
      service.finishCapture("preview-latency", wallNow);
    } finally {
      await runtime?.stop();
      await service.previewAudioRing.clear();
      repository.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }

  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  assert.ok(Math.max(...observedPollWaits) >= 4_900);
  assert.ok(p95 <= 30_000, `preview PCM-to-provisional p95 was ${p95}ms`);
});

test("preview context uses one bounded track range query and a finite Unicode prompt", async () => {
  const contextCalls = [];
  let prompt = null;
  const executor = createCommittedAudioPreviewExecutor({
    repository: {
      getSession: () => ({ started_at: 1_000 }),
      listTranscriptHistory: () => assert.fail("preview scanned all-day transcript history"),
      listPreviewTranscriptContext: (input) => {
        contextCalls.push(input);
        return Array.from({ length: 40 }, (_, index) => ({
          text: `${index.toString().padStart(2, "0")}:${"🙂".repeat(100)}`,
        }));
      },
    },
    previewAudioRing: {
      withPreviewWav: async (input, callback) =>
        callback({
          ...input,
          path: "bounded.preview.wav",
          sourceType: "mic",
          sha256: "b".repeat(64),
        }),
    },
    transcribeWav: async (input) => {
      prompt = input.initialPrompt;
      return { noSpeech: true, executionDevice: "cuda" };
    },
  });

  await executor({
    sessionId: "s1",
    trackId: "track-mic",
    fromMs: 100,
    throughMs: 900,
    executionDevice: "cuda",
    selectedGpuUuid: "GPU-preview",
    cpuThreads: null,
    lowPriority: false,
  });

  assert.deepEqual(contextCalls, [
    { sessionId: "s1", trackId: "track-mic", from: 1_100, to: 1_900, limit: 16 },
  ]);
  assert.ok(Array.from(prompt).length <= 1_024);
  assert.match(prompt, /39:/u);
});

test("preview context SQL bounds active lineage by track, strict overlap, and row count", () => {
  const repository = new JarvisRepository(":memory:");
  try {
    insertSession(repository, { status: "recording", processingState: "pending", endedAt: null });
    insertTrack(repository, { endedAt: null });
    insertTrack(repository, {
      id: "track-system",
      sourceType: "system",
      endedAt: null,
    });
    repository.upsertTranscriptSegments("s1", [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `mic-${index}`,
        startedAt: 150 + index * 40,
        endedAt: 190 + index * 40,
        personId: null,
        speakerLabel: "mic",
        sourceType: "mic",
        text: `mic ${index}`,
        confidence: 0.8,
        isStable: false,
      })),
      {
        id: "system-overlap",
        startedAt: 250,
        endedAt: 300,
        personId: null,
        speakerLabel: "system",
        sourceType: "system",
        text: "wrong track",
        confidence: 0.8,
        isStable: false,
      },
    ]);
    repository.db
      .prepare(
        "UPDATE transcript_segments SET echo_score = 0.9, duplicate_of = 'system-overlap' WHERE id = 'mic-2'"
      )
      .run();

    const rows = repository.listPreviewTranscriptContext({
      sessionId: "s1",
      trackId: "track-mic",
      from: 200,
      to: 400,
      limit: 3,
    });

    assert.deepEqual(
      rows.map((row) => row.id),
      ["mic-4", "mic-5", "mic-6"]
    );
    assert.ok(rows.every((row) => row.track_id === "track-mic"));
    assert.ok(rows.every((row) => row.ended_at > 200 && row.started_at < 400));
  } finally {
    repository.close();
  }
});

test("preview executor rejects unsafe absolute time overflow before audio or SQL access", async () => {
  let touched = false;
  const executor = createCommittedAudioPreviewExecutor({
    repository: {
      getSession: () => ({ started_at: Number.MAX_SAFE_INTEGER - 10 }),
      listPreviewTranscriptContext: () => {
        touched = true;
        return [];
      },
    },
    previewAudioRing: {
      withPreviewWav: async () => {
        touched = true;
      },
    },
    transcribeWav: async () => ({ noSpeech: true, executionDevice: "cuda" }),
  });

  await assert.rejects(
    executor({
      sessionId: "s1",
      trackId: "track-mic",
      fromMs: 0,
      throughMs: 11,
      executionDevice: "cuda",
    }),
    /safe integer|overflow/u
  );
  assert.equal(touched, false);
});

for (const order of ["provisional-first", "final-first"]) {
  test(`overlapping final and provisional stay atomic with history preserved: ${order}`, () => {
    const repository = new JarvisRepository(":memory:");
    try {
      insertSession(repository, { status: "recording", processingState: "pending", endedAt: null });
      insertTrack(repository, { endedAt: null });
      insertChunk(repository, { transcriptionStatus: "pending" });
      const provisional = {
        id: `preview-${order}`,
        startedAt: 150,
        endedAt: 250,
        personId: null,
        speakerLabel: "mic",
        sourceType: "mic",
        text: "temporary preview",
        confidence: 0.7,
        isStable: false,
      };
      const commitFinal = () =>
        repository.commitChunkTranscript({
          chunk: repository.getAudioChunk("chunk-mic"),
          result: { text: "durable final", confidence: 0.95 },
          modelVersion: "large-v3-turbo",
          completedAt: 900,
        });
      let final;
      if (order === "provisional-first") {
        repository.upsertTranscriptSegments("s1", [provisional]);
        final = commitFinal();
      } else {
        final = commitFinal();
        repository.upsertTranscriptSegments("s1", [provisional]);
      }

      assert.deepEqual(
        repository.listTranscriptSegments("s1").map((segment) => segment.id),
        [final.id]
      );
      const history = repository.listTranscriptHistory("s1");
      assert.equal(history.length, 2);
      assert.equal(
        history.find((segment) => segment.id === provisional.id).superseded_by,
        final.id
      );
      assert.equal(history.find((segment) => segment.id === final.id).result_kind, "final");
    } finally {
      repository.close();
    }
  });
}
