const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
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

function insertSession(repository, {
  id = "s1",
  status = "completed",
  processingState = "processing",
  captureMode = "mic",
  endedAt = 1_000,
} = {}) {
  repository.db.prepare(`
    INSERT INTO sessions (
      id, started_at, ended_at, status, language, created_at,
      capture_mode, processing_state, finalized_at
    ) VALUES (?, 100, ?, ?, 'zh', 100, ?, ?, ?)
  `).run(id, endedAt, status, captureMode, processingState, endedAt);
}

function insertTrack(repository, {
  id = "track-mic",
  sessionId = "s1",
  sourceType = "mic",
  endedAt = 1_000,
} = {}) {
  repository.db.prepare(`
    INSERT INTO audio_tracks (
      id, session_id, source_type, sample_rate, channels,
      started_at, ended_at, state
    ) VALUES (?, ?, ?, 24000, 1, 100, ?, 'completed')
  `).run(id, sessionId, sourceType, endedAt);
}

function insertChunk(repository, {
  id = "chunk-mic",
  sessionId = "s1",
  trackId = "track-mic",
  sourceType = "mic",
  startedAt = 100,
  endedAt = 500,
  transcriptionStatus = "pending",
} = {}) {
  repository.db.prepare(`
    INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state, format, sample_rate, channels
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 999999,
      ?, 'committed', 'wav', 24000, 1)
  `).run(
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

function insertJob(repository, {
  id = "job-mic",
  sessionId = "s1",
  trackId = "track-mic",
  chunkId = "chunk-mic",
  state = "pending",
  completedAt = null,
  leaseOwner = null,
  leaseExpiresAt = null,
} = {}) {
  repository.db.prepare(`
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, attempt_count,
      lease_owner, lease_expires_at, created_at, completed_at
    ) VALUES (?, ?, ?, ?, 'transcribe_chunk', ?, ?, 1, '', 0, ?, ?, 100, ?)
  `).run(
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
    assert.equal(repository.refreshSessionReadiness(`s-${state}`, 2_000).processing_state, "processing");
    repository.close();
  }

  const open = new JarvisRepository(":memory:");
  insertSession(open, { id: "open", status: "recording", endedAt: null, processingState: "pending" });
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
  repository.db.prepare("UPDATE audio_chunks SET transcription_status = 'no_speech' WHERE id = 'chunk-system'").run();
  repository.db.prepare("UPDATE processing_jobs SET state = 'completed', completed_at = 701 WHERE id = 'job-system'").run();
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
  repository.db.prepare(`
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'compress-job', 's1', 'track-mic', 'chunk-mic', 'compress_chunk', 'pending',
      ?, 1, 'flac-v1', 101
    )
  `).run("chunk-mic".padEnd(64, "0").slice(0, 64));

  const calls = [];
  const service = {
    audioEvidenceReader: {
      withVerifiedWav: async (_chunk, callback) => callback("verified.wav"),
    },
    flacCompressionWorker: {
      run: async (job) => calls.push(`compress:${job.id}`),
    },
  };
  const ipcHandlers = {
    createJarvisTranscribeWavAdapter: ({ model }) => {
      calls.push(`model:${model}`);
      return async () => {
        calls.push("transcribe");
        return { noSpeech: true };
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
  });

  assert.equal(await runtime.drainOnce(), 2);
  assert.deepEqual(calls, ["model:large-v3-turbo", "transcribe", "compress:compress-job"]);
  assert.equal(repository.getSession("s1").processing_state, "ready");
});
