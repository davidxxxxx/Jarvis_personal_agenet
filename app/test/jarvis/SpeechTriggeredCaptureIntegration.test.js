const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const SpeechVadClassifier = require("../../src/jarvis/main/SpeechVadClassifier");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

function pcm(durationMs, amplitude = 0) {
  const output = Buffer.alloc(Math.round((BYTES_PER_SECOND * durationMs) / 1_000));
  for (let offset = 0; offset < output.length; offset += 2) {
    output.writeInt16LE(amplitude, offset);
  }
  return output;
}

function source(sourceType = "mic") {
  return {
    sourceType,
    deviceId: sourceType === "mic" ? "physical-mic" : null,
    deviceLabel: sourceType === "mic" ? "Physical mic" : "Computer audio",
    strategy: sourceType === "mic" ? "web-audio" : "wasapi-loopback",
  };
}

function createSafeFs() {
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  return fsImpl;
}

class DeterministicVad {
  isReady() {
    return true;
  }

  async classify({ pcm: input }) {
    for (let offset = 0; offset < input.length; offset += 2) {
      if (input.readInt16LE(offset) !== 0) return 0.9;
    }
    return 0.01;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate, message) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

class DeferredVad {
  constructor() {
    this.requests = [];
  }

  isReady() {
    return true;
  }

  classify(input) {
    const pending = deferred();
    this.requests.push({ input, ...pending });
    return pending.promise;
  }
}

function runtime(
  t,
  {
    startedAt = 0,
    captureMode = "mic",
    retentionMode = "speech_triggered",
    vadClassifier,
    maxVadQueueMs,
    vadTimeoutMs,
    now = () => startedAt,
    fsImpl = createSafeFs(),
  } = {}
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speech-retention-"));
  const repository = new JarvisRepository(":memory:");
  repository.createSession({
    id: "s1",
    startedAt,
    micDeviceId: captureMode === "system" ? null : "physical-mic",
    captureMode,
    retentionMode,
  });
  const service = new JarvisService({
    repository,
    userDataDir: directory,
    broadcast() {},
    now,
    fsImpl,
    vadClassifier,
    ...(maxVadQueueMs === undefined ? {} : { maxVadQueueMs }),
    ...(vadTimeoutMs === undefined ? {} : { vadTimeoutMs }),
  });
  const sources =
    captureMode === "dual" ? [source("mic"), source("system")] : [source(captureMode)];
  service.startCapture({
    sessionId: "s1",
    startedAt,
    micDeviceId: captureMode === "system" ? null : "physical-mic",
    captureMode,
    retentionMode,
    sources,
  });
  t.after(() => {
    service.shutdown();
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, repository, service };
}

async function appendAndDrain(service, sourceType, input) {
  assert.equal(service.appendPcm("s1", sourceType, input), true);
  await service.whenRetentionIdle();
}

test("new sessions default to versioned speech-triggered policy", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());

  const session = repository.createSession({
    id: "new-session",
    startedAt: 10,
    micDeviceId: "mic",
  });

  assert.equal(session.retention_mode, "speech_triggered");
  assert.deepEqual(JSON.parse(session.capture_policy_json), {
    schemaVersion: 1,
    preRollMs: 2_000,
    postRollMs: 3_000,
    mergeGapMs: 3_000,
  });
});

test("migration preserves legacy full audio as continuous and adds nullable gap levels", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        mic_device_id TEXT,
        language TEXT NOT NULL DEFAULT 'zh',
        created_at INTEGER NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'mic',
        processing_state TEXT NOT NULL DEFAULT 'pending',
        timeline_version INTEGER NOT NULL DEFAULT 1,
        finalized_at INTEGER,
        ready_at INTEGER
      );
      CREATE TABLE audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        transcription_status TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'mic',
        sequence_number INTEGER NOT NULL DEFAULT 0,
        write_state TEXT NOT NULL DEFAULT 'committed',
        deleted_at INTEGER
      );
      INSERT INTO sessions (id, started_at, status, created_at) VALUES ('legacy', 1, 'completed', 1);
      PRAGMA user_version = 3;
    `);

    assert.deepEqual(applyJarvisMigrations(db), { fromVersion: 3, toVersion: TARGET_VERSION });
    const session = db.prepare("SELECT retention_mode, capture_policy_json FROM sessions").get();
    assert.equal(session.retention_mode, "continuous");
    assert.equal(JSON.parse(session.capture_policy_json).schemaVersion, 1);
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(audio_gaps)")
        .all()
        .filter((column) => ["average_level", "peak_level"].includes(column.name))
        .map((column) => ({ name: column.name, notnull: column.notnull })),
      [
        { name: "average_level", notnull: 0 },
        { name: "peak_level", notnull: 0 },
      ]
    );
  } finally {
    db.close();
  }
});

test("closed suppression evidence does not transition an active track", (t) => {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({ id: "s1", startedAt: 0, micDeviceId: "mic" });
  repository.createTrack({
    id: "t1",
    sessionId: "s1",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
    state: "active",
  });

  repository.recordEvidenceGap({
    id: "suppressed",
    trackId: "t1",
    startedAt: 0,
    endedAt: 1_000,
    reason: "silence_suppressed",
    averageLevel: 0.25,
    peakLevel: 0.5,
  });

  assert.equal(
    repository.db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "active"
  );
  assert.deepEqual(repository.db.prepare("SELECT * FROM audio_gaps WHERE id='suppressed'").get(), {
    id: "suppressed",
    track_id: "t1",
    started_at: 0,
    ended_at: 1_000,
    reason: "silence_suppressed",
    recovery_attempts: 0,
    restored_device_id: null,
    restored_device_label: null,
    restored_strategy: null,
    average_level: 0.25,
    peak_level: 0.5,
  });
});

test("initial silence keeps the writer closed and first retained chunk starts at pre-roll", async (t) => {
  const { repository, service } = runtime(t, { vadClassifier: new DeterministicVad() });
  for (let second = 0; second < 5; second += 1) {
    await appendAndDrain(service, "mic", pcm(1_000));
  }

  assert.equal(service.writer.hasSource("mic"), false);
  assert.deepEqual(repository.listAudioChunks("s1"), []);

  await appendAndDrain(service, "mic", pcm(1_000, 12_000));
  assert.equal(service.writer.hasSource("mic"), true);
  service.finishCapture("s1", 6_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
      durationMs: chunk.duration_ms,
    })),
    [{ startedAt: 3_000, endedAt: 6_000, durationMs: 3_000 }]
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT started_at, ended_at, reason FROM audio_gaps ORDER BY started_at")
      .all(),
    [{ started_at: 0, ended_at: 3_000, reason: "silence_suppressed" }]
  );
});

test("a confirmed gap flushes retained tail before reopening at the next exact range", async (t) => {
  const { repository, service } = runtime(t, { vadClassifier: new DeterministicVad() });
  for (let second = 0; second < 8; second += 1) {
    await appendAndDrain(service, "mic", pcm(1_000, second === 0 || second === 7 ? 12_000 : 0));
  }
  service.finishCapture("s1", 8_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      sequence: chunk.sequence_number,
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
    })),
    [
      { sequence: 0, startedAt: 0, endedAt: 4_000 },
      { sequence: 1, startedAt: 5_000, endedAt: 8_000 },
    ]
  );
  assert.deepEqual(
    repository.db
      .prepare(
        "SELECT started_at, ended_at, reason FROM audio_gaps WHERE reason='silence_suppressed'"
      )
      .all(),
    [{ started_at: 4_000, ended_at: 5_000, reason: "silence_suppressed" }]
  );
});

test("restoration realigns each source cursor to restoration time", async (t) => {
  const { repository, service } = runtime(t, {
    startedAt: 1_000,
    vadClassifier: new DeterministicVad(),
  });
  await appendAndDrain(service, "mic", pcm(1_000, 12_000));
  service.sourceInterrupted("s1", "mic", { at: 3_000, reason: "device-change" });
  service.sourceRestored("s1", "mic", {
    at: 10_000,
    deviceId: "replacement",
    deviceLabel: "Replacement",
    strategy: "web-audio",
  });
  await appendAndDrain(service, "mic", pcm(1_000, 12_000));
  service.finishCapture("s1", 11_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
    })),
    [
      { startedAt: 1_000, endedAt: 2_000 },
      { startedAt: 10_000, endedAt: 11_000 },
    ]
  );
});

test("finish fail-opens in-flight PCM exactly once and ignores the late generation", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, { vadClassifier: vad });
  assert.equal(service.appendPcm("s1", "mic", pcm(100, 12_000)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vad.requests.length, 1);

  service.finishCapture("s1", 100);
  vad.requests[0].resolve(0.9);
  await service.whenRetentionIdle();

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [100]
  );
});

test("queue overflow fails open all pending PCM within the configured hard bound", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, { vadClassifier: vad, maxVadQueueMs: 200 });
  let peakQueueBytesAtFallback = 0;
  const degradeRetention = service._degradeRetention.bind(service);
  service._degradeRetention = (...args) => {
    peakQueueBytesAtFallback = Math.max(
      peakQueueBytesAtFallback,
      service.state.sources.mic.vadQueueBytes
    );
    return degradeRetention(...args);
  };
  service.appendPcm("s1", "mic", pcm(100, 1_000));
  await new Promise((resolve) => setImmediate(resolve));
  service.appendPcm("s1", "mic", pcm(100, 2_000));
  service.appendPcm("s1", "mic", pcm(100, 3_000));

  const state = service.getState();
  assert.equal(state.effectiveRetentionMode, "continuous_fallback");
  assert.equal(state.retentionDegradedReason, "vad_queue_overflow");
  assert.ok(peakQueueBytesAtFallback <= Math.round((BYTES_PER_SECOND * 200) / 1_000));
  assert.ok(state.sources.mic.vadQueueBytes <= Math.round((BYTES_PER_SECOND * 200) / 1_000));
  service.finishCapture("s1", 300);
  vad.requests[0].resolve(0.9);
  await service.whenRetentionIdle();

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [300]
  );
});

test("classifier rejection is visible and retains audio continuously", async (t) => {
  const classifier = {
    isReady: () => true,
    classify: async () => {
      throw new Error("worker unavailable");
    },
  };
  const { repository, service } = runtime(t, { vadClassifier: classifier });
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await service.whenRetentionIdle();

  assert.equal(service.getState().effectiveRetentionMode, "continuous_fallback");
  assert.equal(service.getState().retentionDegradedReason, "vad_unavailable");
  service.finishCapture("s1", 100);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [100]
  );
});

test("runtime switch to continuous flushes buffered PCM once in timestamp order", async (t) => {
  const { repository, service } = runtime(t, { vadClassifier: new DeterministicVad() });
  await appendAndDrain(service, "mic", pcm(1_000));
  await appendAndDrain(service, "mic", pcm(1_000));
  assert.equal(service.writer.hasSource("mic"), false);

  const switched = service.setRetentionMode("s1", "continuous", 2_000);
  assert.equal(switched.retentionMode, "continuous");
  assert.equal(switched.effectiveRetentionMode, "continuous");
  service.appendPcm("s1", "mic", pcm(1_000));
  service.finishCapture("s1", 3_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [3_000]
  );
  assert.equal(repository.getSession("s1").retention_mode, "continuous");
});

test("runtime switch from continuous closes the old writer before speech-triggered gaps", async (t) => {
  const { repository, service } = runtime(t, {
    retentionMode: "continuous",
    vadClassifier: new DeterministicVad(),
  });
  await appendAndDrain(service, "mic", pcm(1_000));
  const switched = service.setRetentionMode("s1", "speech_triggered", 1_000);
  assert.equal(switched.retentionMode, "speech_triggered");
  assert.equal(service.writer.hasSource("mic"), false);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
    })),
    [{ startedAt: 0, endedAt: 1_000 }]
  );

  for (let second = 1; second < 6; second += 1) {
    await appendAndDrain(service, "mic", pcm(1_000));
  }
  await appendAndDrain(service, "mic", pcm(1_000, 12_000));
  service.finishCapture("s1", 7_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      sequence: chunk.sequence_number,
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
    })),
    [
      { sequence: 0, startedAt: 0, endedAt: 1_000 },
      { sequence: 1, startedAt: 4_000, endedAt: 7_000 },
    ]
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT started_at, ended_at FROM audio_gaps WHERE reason='silence_suppressed'")
      .all(),
    [{ started_at: 1_000, ended_at: 4_000 }]
  );
});

test("continuous to speech close preserves a recoverable low-disk safe-stop", async (t) => {
  let diskChecks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: ++diskChecks === 1 ? 20 * 1024 ** 3 : 1024 ** 3,
  });
  const { repository, service } = runtime(t, {
    retentionMode: "continuous",
    vadClassifier: new DeterministicVad(),
    fsImpl,
    now: () => 8_000,
  });
  await appendAndDrain(service, "mic", pcm(1_000, 8_000));

  const state = service.setRetentionMode("s1", "speech_triggered", 8_000);

  assert.equal(state.status, "paused");
  assert.equal(state.errorCode, "capture_stopped_low_disk");
  assert.equal(state.sources.mic.state, "paused");
  assert.equal(repository.getSession("s1").status, "paused");
  assert.equal(repository.getSession("s1").retention_mode, "speech_triggered");
});

test("continuous to speech post-write close fault anchors evidence before terminal failure", async (t) => {
  const { repository, service } = runtime(t, {
    retentionMode: "continuous",
    vadClassifier: new DeterministicVad(),
  });
  await appendAndDrain(service, "mic", pcm(1_000, 8_000));
  const closeSource = service.writer.closeSource.bind(service.writer);
  let injectFault = true;
  service.writer.closeSource = (sourceType, at) => {
    closeSource(sourceType, at);
    if (injectFault) {
      injectFault = false;
      const error = new Error("post-write close fault");
      error.evidenceEndedAt = 1_000;
      throw error;
    }
  };

  const state = service.setRetentionMode("s1", "speech_triggered", 1_000);

  assert.equal(state.status, "failed");
  assert.equal(state.errorCode, "RETENTION_SWITCH_FAILED");
  assert.equal(state.sources.mic.state, "failed");
  assert.equal(repository.getSession("s1").status, "failed");
  assert.equal(repository.getSession("s1").retention_mode, "speech_triggered");
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => [chunk.started_at, chunk.ended_at]),
    [[0, 1_000]]
  );
  assert.deepEqual(
    repository.db
      .prepare("SELECT started_at, ended_at FROM audio_gaps WHERE track_id = ?")
      .all(service.state.sources.mic.trackId),
    [{ started_at: 1_000, ended_at: 1_000 }]
  );
});

test("continuous to speech does not close a reconnecting source twice", async (t) => {
  const { service } = runtime(t, {
    captureMode: "dual",
    retentionMode: "continuous",
    vadClassifier: new DeterministicVad(),
  });
  assert.equal(service.appendPcm("s1", "mic", pcm(100, 8_000)), true);
  assert.equal(service.appendPcm("s1", "system", pcm(100, 8_000)), true);
  service.sourceInterrupted("s1", "mic", { at: 100, reason: "device-change" });
  const closeSource = service.writer.closeSource.bind(service.writer);
  const closedSources = [];
  service.writer.closeSource = (sourceType, at) => {
    closedSources.push(sourceType);
    return closeSource(sourceType, at);
  };

  const state = service.setRetentionMode("s1", "speech_triggered", 100);

  assert.equal(state.status, "degraded");
  assert.equal(state.sources.mic.state, "reconnecting");
  assert.equal(state.sources.system.state, "active");
  assert.deepEqual(closedSources, ["system"]);
  service.finishCapture("s1", 100);
});

test("continuous to speech leaves an already paused source closed", (t) => {
  const { service } = runtime(t, {
    retentionMode: "continuous",
    vadClassifier: new DeterministicVad(),
  });
  assert.equal(service.appendPcm("s1", "mic", pcm(100, 8_000)), true);
  service.pauseCapture("s1", 100);
  const closeSource = service.writer.closeSource.bind(service.writer);
  const closedSources = [];
  service.writer.closeSource = (sourceType, at) => {
    closedSources.push(sourceType);
    return closeSource(sourceType, at);
  };

  const state = service.setRetentionMode("s1", "speech_triggered", 100);

  assert.equal(state.status, "paused");
  assert.equal(state.sources.mic.state, "paused");
  assert.deepEqual(closedSources, []);
  service.finishCapture("s1", 100);
});

test("dual capture never lets one source speech drain the other source ring", async (t) => {
  const { repository, service } = runtime(t, {
    captureMode: "dual",
    vadClassifier: new DeterministicVad(),
  });
  await appendAndDrain(service, "mic", pcm(1_000));
  await appendAndDrain(service, "system", pcm(1_000, 12_000));
  service.finishCapture("s1", 1_000);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.source_type),
    ["system"]
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT t.source_type sourceType, g.reason
         FROM audio_gaps g JOIN audio_tracks t ON t.id = g.track_id`
      )
      .all(),
    [{ sourceType: "mic", reason: "silence_suppressed" }]
  );
});

test("pause fail-opens in-flight PCM once and resume starts a fresh working VAD generation", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, { vadClassifier: vad });
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await new Promise((resolve) => setImmediate(resolve));
  service.pauseCapture("s1", 100);
  vad.requests[0].resolve(0.9);
  await service.whenRetentionIdle();
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [100]
  );

  service.resumeCapture("s1", 1_000);
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vad.requests.length, 2);
  vad.requests[1].resolve(0.9);
  await service.whenRetentionIdle();
  service.finishCapture("s1", 1_100);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => ({
      sequence: chunk.sequence_number,
      startedAt: chunk.started_at,
      durationMs: chunk.duration_ms,
    })),
    [
      { sequence: 0, startedAt: 0, durationMs: 100 },
      { sequence: 1, startedAt: 1_000, durationMs: 100 },
    ]
  );
});

test("resume repairs an invalid prior VAD generation before scheduling new work", async (t) => {
  const vad = new DeferredVad();
  const { service } = runtime(t, { vadClassifier: vad });
  service.state.sources.mic.vadGeneration = Number.NaN;
  service.pauseCapture("s1", 0);
  service.resumeCapture("s1", 1_000);

  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(vad.requests.length, 1);
  vad.requests[0].resolve(0.9);
  await service.whenRetentionIdle();
});

test("shutdown fail-opens in-flight PCM once and late VAD cannot append", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, {
    vadClassifier: vad,
    now: () => 100,
  });
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await new Promise((resolve) => setImmediate(resolve));

  service.shutdown();
  vad.requests[0].resolve(0.9);
  await service.whenRetentionIdle();

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [100]
  );
  assert.equal(repository.getSession("s1").status, "recovered");
});

test("classifier timeout becomes visible fallback and retains the timed-out frame", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, {
    vadClassifier: vad,
    vadTimeoutMs: 10,
  });
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await service.whenRetentionIdle();

  assert.equal(service.getState().effectiveRetentionMode, "continuous_fallback");
  assert.equal(service.getState().retentionDegradedReason, "vad_unavailable");
  service.finishCapture("s1", 100);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [100]
  );
});

for (const serviceFailure of ["timeout", "queue_overflow"]) {
  test(`${serviceFailure} invalidates VAD and recovers only after the old inference settles`, async (t) => {
    const classification = deferred();
    let loadCalls = 0;
    let reloadCalls = 0;
    const workerClient = {
      async request(method) {
        if (method === "vad.load") {
          loadCalls += 1;
          return { ok: true };
        }
        if (method === "vad.reload") {
          reloadCalls += 1;
          return { ok: true, probability: 0.01 };
        }
        if (method === "vad.health") return { ok: true, probability: 0.01 };
        if (method === "vad.classify") return classification.promise;
        return { ok: true };
      },
    };
    const classifier = new SpeechVadClassifier({
      workerClient,
      getModelPath: () => "vad.onnx",
      fsImpl: { existsSync: () => true },
    });
    await classifier.initialize();
    let service;
    classifier.startRecovery({
      intervalMs: 5,
      onRecovered: () => service.reportVadRecovered(500),
    });
    ({ service } = runtime(t, {
      vadClassifier: classifier,
      ...(serviceFailure === "timeout" ? { vadTimeoutMs: 10 } : { maxVadQueueMs: 200 }),
    }));

    service.appendPcm("s1", "mic", pcm(100, 12_000));
    await new Promise((resolve) => setImmediate(resolve));
    if (serviceFailure === "timeout") {
      await service.whenRetentionIdle();
    } else {
      service.appendPcm("s1", "mic", pcm(100, 12_000));
      service.appendPcm("s1", "mic", pcm(100, 12_000));
    }

    assert.equal(service.getState().effectiveRetentionMode, "continuous_fallback");
    assert.equal(classifier.isReady(), false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(loadCalls, 1);

    classification.resolve({ probability: 0.9 });
    await waitForCondition(
      () => service.getState().effectiveRetentionMode === "speech_triggered",
      `${serviceFailure} did not recover speech-triggered retention`
    );
    assert.equal(classifier.isReady(), true);
    assert.equal(loadCalls, 1);
    assert.ok(reloadCalls >= 1);

    service.finishCapture("s1", 500);
    await classifier.stop();
  });
}

test("persistent writer fault stops a multi-write decision and cancels late VAD work", async (t) => {
  const unhandledRejections = [];
  const onUnhandledRejection = (error) => unhandledRejections.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => process.off("unhandledRejection", onUnhandledRejection));
  let classifyCalls = 0;
  const classifier = {
    isReady: () => true,
    classify: async ({ pcm: input }) => {
      classifyCalls += 1;
      for (let offset = 0; offset < input.length; offset += 2) {
        if (input.readInt16LE(offset) !== 0) return 0.9;
      }
      return 0.01;
    },
  };
  const { service } = runtime(t, { vadClassifier: classifier, now: () => 10_000 });
  await appendAndDrain(service, "mic", pcm(100));
  service.writer.abortAll();
  let appendCalls = 0;
  let interruptCalls = 0;
  let writerOpen = false;
  service.writer = {
    hasSource: () => writerOpen,
    reopenSource: () => {
      writerOpen = true;
    },
    append: () => {
      appendCalls += 1;
      throw new Error("persistent writer fault");
    },
    closeSource: () => {
      writerOpen = false;
    },
    closeAll: () => {
      writerOpen = false;
    },
    abortAll: () => {
      writerOpen = false;
    },
  };
  const interruptSource = service._interruptSource.bind(service);
  service._interruptSource = (...args) => {
    interruptCalls += 1;
    if (interruptCalls > 1) throw new RangeError("recursive interrupt guard");
    return interruptSource(...args);
  };

  service.appendPcm("s1", "mic", pcm(100, 12_000));
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await service.whenRetentionIdle();
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getState();
  assert.equal(appendCalls, 1);
  assert.equal(interruptCalls, 1);
  assert.equal(classifyCalls, 2);
  assert.equal(state.status, "degraded");
  assert.equal(state.sources.mic.state, "reconnecting");
  assert.equal(state.sources.mic.interruptedAt, 0);
  assert.equal(state.effectiveRetentionMode, "speech_triggered");
  assert.equal(state.retentionDegradedReason, null);
  assert.deepEqual(unhandledRejections, []);
});

test("wrapped post-write evidence end anchors the interruption gap after durable audio", (t) => {
  const { repository, service } = runtime(t);
  const durableFault = new Error("post-write metadata fault");
  durableFault.evidenceEndedAt = 100;
  service.writer.append = () => {
    throw new Error("writer wrapper", {
      cause: new AggregateError([durableFault], "nested writer faults"),
    });
  };

  assert.equal(service.appendPcm("s1", "mic", pcm(100, 8_000)), false);

  const evidence = repository.db
    .prepare(
      `SELECT t.ended_at trackEndedAt, g.started_at gapStartedAt
       FROM audio_tracks t JOIN audio_gaps g ON g.track_id = t.id
       WHERE t.session_id = ? AND t.source_type = 'mic'`
    )
    .get("s1");
  assert.deepEqual(evidence, { trackEndedAt: 100, gapStartedAt: 100 });
  service.finishCapture("s1", 100);
});

test("one source writer fault preserves the other source's pending VAD audio", async (t) => {
  const systemClassification = deferred();
  const classifier = {
    isReady: () => true,
    classify: ({ sourceType }) =>
      sourceType === "mic" ? Promise.resolve(0.9) : systemClassification.promise,
  };
  const { repository, service } = runtime(t, {
    captureMode: "dual",
    vadClassifier: classifier,
  });
  const append = service.writer.append.bind(service.writer);
  service.writer.append = (sourceType, input) => {
    if (sourceType === "mic") throw new Error("mic writer fault");
    return append(sourceType, input);
  };

  service.appendPcm("s1", "system", pcm(100, 8_000));
  await new Promise((resolve) => setImmediate(resolve));
  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await waitForCondition(
    () => service.getState().sources.mic.state === "reconnecting",
    "microphone source did not enter recovery"
  );

  systemClassification.resolve(0.9);
  await service.whenRetentionIdle();
  const state = service.getState();
  assert.equal(state.sources.mic.state, "reconnecting");
  assert.equal(state.sources.system.state, "active");
  assert.equal(state.effectiveRetentionMode, "speech_triggered");
  assert.equal(state.retentionDegradedReason, null);

  service.finishCapture("s1", 100);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => [chunk.source_type, chunk.duration_ms]),
    [["system", 100]]
  );
});

test("global VAD degrade isolates one writer fault while preserving the other pending lane", async (t) => {
  const systemClassification = deferred();
  let micCalls = 0;
  const classifier = {
    isReady: () => true,
    reportFailure() {},
    classify: ({ sourceType }) => {
      if (sourceType === "system") return systemClassification.promise;
      micCalls += 1;
      if (micCalls === 1) return Promise.resolve(0.01);
      return Promise.reject(new Error("mic VAD failed"));
    },
  };
  const { repository, service } = runtime(t, {
    captureMode: "dual",
    vadClassifier: classifier,
  });
  await appendAndDrain(service, "mic", pcm(100));
  service.appendPcm("s1", "system", pcm(100, 8_000));
  await new Promise((resolve) => setImmediate(resolve));
  const append = service.writer.append.bind(service.writer);
  service.writer.append = (sourceType, input) => {
    if (sourceType === "mic") throw new Error("mic writer failed during degrade");
    return append(sourceType, input);
  };

  service.appendPcm("s1", "mic", pcm(100, 12_000));
  await waitForCondition(
    () => service.getState().effectiveRetentionMode === "continuous_fallback",
    "session did not enter fail-open retention"
  );
  systemClassification.resolve(0.9);
  await service.whenRetentionIdle();

  const state = service.getState();
  assert.equal(state.sources.mic.state, "reconnecting");
  assert.equal(state.sources.system.state, "active");
  assert.equal(state.effectiveRetentionMode, "continuous_fallback");
  assert.equal(state.retentionDegradedReason, "vad_unavailable");
  service.finishCapture("s1", 100);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => [chunk.source_type, chunk.duration_ms]),
    [["system", 100]]
  );
});

for (const [lifecycle, expectedStatus] of [
  ["pauseCapture", "paused"],
  ["finishCapture", "completed"],
]) {
  test(`${lifecycle} drains the healthy in-flight lane exactly once after a peer writer fault`, async (t) => {
    const vad = new DeferredVad();
    const { repository, service } = runtime(t, {
      captureMode: "dual",
      vadClassifier: vad,
    });
    assert.equal(service.appendPcm("s1", "mic", pcm(100, 8_000)), true);
    assert.equal(service.appendPcm("s1", "system", pcm(100, 12_000)), true);
    await waitForCondition(() => vad.requests.length === 2, "both VAD lanes did not start");

    const append = service.writer.append.bind(service.writer);
    let healthyWrites = 0;
    service.writer.append = (sourceType, input) => {
      if (sourceType === "mic") throw new Error("mic writer failed at lifecycle boundary");
      healthyWrites += 1;
      return append(sourceType, input);
    };

    const state = service[lifecycle]("s1", 100);

    assert.equal(state.status, expectedStatus);
    assert.equal(service.getState().status, expectedStatus);
    assert.equal(repository.getSession("s1").status, expectedStatus);
    assert.equal(healthyWrites, 1);
    assert.deepEqual(
      repository.listAudioChunks("s1").map((chunk) => [chunk.source_type, chunk.duration_ms]),
      [["system", 100]]
    );
    if (lifecycle === "pauseCapture") service.finishCapture("s1", 100);

    for (const request of vad.requests) request.resolve(0.9);
    await service.whenRetentionIdle();
  });
}

test("gap metadata failure preserves drained decision audio then fails capture truthfully", async (t) => {
  const unhandledRejections = [];
  const onUnhandledRejection = (error) => unhandledRejections.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => process.off("unhandledRejection", onUnhandledRejection));
  const { repository, service } = runtime(t, { vadClassifier: new DeterministicVad() });
  repository.recordEvidenceGap = () => {
    throw new Error("gap database unavailable");
  };

  await appendAndDrain(service, "mic", pcm(2_100));
  await appendAndDrain(service, "mic", pcm(100, 12_000));
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getState();
  assert.equal(state.status, "failed");
  assert.equal(state.errorCode, "CAPTURE_EVIDENCE_FAILED");
  assert.equal(state.effectiveRetentionMode, "speech_triggered");
  assert.equal(state.retentionDegradedReason, null);
  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [2_100]
  );
  assert.deepEqual(unhandledRejections, []);
});

test("retention DB failure leaves gate, queue, writer, and runtime state unchanged", async (t) => {
  const vad = new DeferredVad();
  const { repository, service } = runtime(t, { vadClassifier: vad });
  service.appendPcm("s1", "mic", pcm(100));
  await new Promise((resolve) => setImmediate(resolve));
  const source = service.state.sources.mic;
  const before = {
    state: service.getState(),
    generation: service.retentionGeneration,
    queueBytes: source.vadQueueBytes,
    bufferedFrames: source.gate.bufferedFrames("mic"),
    writerOpen: source.writerOpen,
  };
  repository.setSessionRetention = () => {
    throw new Error("retention database unavailable");
  };

  assert.throws(
    () => service.setRetentionMode("s1", "continuous", 100),
    /retention database unavailable/
  );
  assert.deepEqual(service.getState(), before.state);
  assert.equal(service.retentionGeneration, before.generation);
  assert.equal(source.vadQueueBytes, before.queueBytes);
  assert.equal(source.gate.bufferedFrames("mic"), before.bufferedFrames);
  assert.equal(source.writerOpen, before.writerOpen);

  service.shutdown();
  vad.requests[0].resolve(0.01);
  await service.whenRetentionIdle();
});

test("runtime retention switch failure becomes a terminal state matching persisted mode", (t) => {
  const { repository, service } = runtime(t, { vadClassifier: new DeterministicVad() });
  service.state.sources.mic.gate.switchMode = () => {
    throw new Error("gate switch failed");
  };

  const state = service.setRetentionMode("s1", "continuous", 100);

  assert.equal(repository.getSession("s1").retention_mode, "continuous");
  assert.equal(state.retentionMode, "continuous");
  assert.equal(state.status, "failed");
  assert.equal(state.errorCode, "RETENTION_SWITCH_FAILED");
  assert.equal(state.retentionDegradedReason, null);
});

test("sequential sessions keep VAD reset bookkeeping constant-space", (t) => {
  const resetSessionIds = [];
  const classifier = {
    isReady: () => true,
    classify: async () => 0.01,
    reset: async () => ({ ok: true }),
    resetSession: async (sessionId) => {
      resetSessionIds.push(sessionId);
      return { ok: true };
    },
  };
  const { repository, service } = runtime(t, { vadClassifier: classifier });
  service.finishCapture("s1", 100);

  for (let index = 2; index <= 32; index += 1) {
    const id = `s${index}`;
    const at = index * 100;
    repository.createSession({
      id,
      startedAt: at,
      micDeviceId: "physical-mic",
      captureMode: "mic",
      retentionMode: "speech_triggered",
    });
    service.startCapture({
      sessionId: id,
      startedAt: at,
      micDeviceId: "physical-mic",
      captureMode: "mic",
      retentionMode: "speech_triggered",
      sources: [source("mic")],
    });
    service.finishCapture(id, at + 50);
  }

  assert.equal(resetSessionIds.length, 32);
  assert.equal(Object.hasOwn(service, "vadResetSessions"), false);
  assert.equal(typeof service.vadSessionReset, "boolean");
});

test("one dual-source VAD failure records session-global degraded spans for both tracks", async (t) => {
  const classifier = {
    isReady: () => true,
    classify: async ({ sourceType }) => {
      if (sourceType === "mic") throw new Error("mic VAD stream failed");
      return 0.01;
    },
  };
  const { repository, service } = runtime(t, {
    captureMode: "dual",
    vadClassifier: classifier,
  });
  service.appendPcm("s1", "mic", pcm(100, 1_000));
  await service.whenRetentionIdle();
  service.appendPcm("s1", "system", pcm(100, 2_000));
  service.finishCapture("s1", 100);

  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT t.source_type sourceType, g.started_at startedAt, g.ended_at endedAt
         FROM audio_gaps g JOIN audio_tracks t ON t.id = g.track_id
         WHERE g.reason = 'vad_degraded' ORDER BY t.source_type`
      )
      .all(),
    [
      { sourceType: "mic", startedAt: 0, endedAt: 100 },
      { sourceType: "system", startedAt: 0, endedAt: 100 },
    ]
  );
});

test("important meeting remains continuous after VAD health recovery", async (t) => {
  let ready = false;
  const classifier = {
    isReady: () => ready,
    classify: async () => 0.01,
  };
  const { repository, service } = runtime(t, {
    retentionMode: "continuous",
    vadClassifier: classifier,
  });
  service.appendPcm("s1", "mic", pcm(100));
  assert.equal(service.getState().effectiveRetentionMode, "continuous_fallback");

  ready = true;
  const recovered = service.reportVadRecovered(100);
  assert.equal(recovered.retentionMode, "continuous");
  assert.equal(recovered.effectiveRetentionMode, "continuous");
  service.appendPcm("s1", "mic", pcm(100));
  service.finishCapture("s1", 200);

  assert.deepEqual(
    repository.listAudioChunks("s1").map((chunk) => chunk.duration_ms),
    [200]
  );
});

test("switching to continuous while VAD is unhealthy stays visibly fail-open until health recovers", (t) => {
  let ready = true;
  const classifier = {
    isReady: () => ready,
    classify: async () => 0.01,
  };
  const { repository, service } = runtime(t, { vadClassifier: classifier });

  ready = false;
  const switched = service.setRetentionMode("s1", "continuous", 100);
  assert.equal(repository.getSession("s1").retention_mode, "continuous");
  assert.equal(switched.retentionMode, "continuous");
  assert.equal(switched.effectiveRetentionMode, "continuous_fallback");
  assert.equal(switched.retentionDegradedReason, "vad_unavailable");

  ready = true;
  const recovered = service.reportVadRecovered(200);
  assert.equal(recovered.retentionMode, "continuous");
  assert.equal(recovered.effectiveRetentionMode, "continuous");
  assert.equal(recovered.retentionDegradedReason, null);
});

test("unverified or shutting-down VAD recovery cannot clear visible fallback", (t) => {
  let ready = false;
  const classifier = {
    isReady: () => ready,
    classify: async () => 0.01,
  };
  const { service } = runtime(t, { vadClassifier: classifier });
  const fallback = service.getState();

  assert.deepEqual(service.reportVadRecovered(0), fallback);
  ready = true;
  service.beginShutdown();
  assert.deepEqual(service.reportVadRecovered(0), fallback);
});

for (const terminalAction of ["finish", "fail", "shutdown"]) {
  test(`${terminalAction} resets the VAD worker session exactly once`, (t) => {
    const resetSessionIds = [];
    const classifier = {
      isReady: () => true,
      classify: async () => 0.01,
      reset: async () => ({ ok: true }),
      resetSession: async (sessionId) => {
        resetSessionIds.push(sessionId);
        return { ok: true };
      },
    };
    const { service } = runtime(t, { vadClassifier: classifier });

    if (terminalAction === "finish") service.finishCapture("s1", 100);
    if (terminalAction === "fail") service.failCapture("s1", "TEST_FAILURE", 100);
    if (terminalAction === "shutdown") service.shutdown();
    service.shutdown();

    assert.deepEqual(resetSessionIds, ["s1"]);
  });
}
