const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const { createJarvisProcessingRuntime } = require("../../src/jarvis/main/JarvisProcessingRuntime");
const {
  JarvisProcessingLifecycle,
  createJarvisRuntimeMigrationParticipant,
} = require("../../src/jarvis/main/JarvisProcessingLifecycle");

test("migration stops the old runtime and rebuilds production handlers from reconfigured storage", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-processing-lifecycle-"));
  const oldRoot = path.join(root, "old");
  const nextRoot = path.join(root, "next");
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(nextRoot, { recursive: true });
  const repository = new JarvisRepository(path.join(oldRoot, "jarvis.db"));
  const events = [];
  const readerCalls = [];
  const compressionCalls = [];
  const makeReader = (name) => ({
    name,
    withVerifiedWav: async (_chunk, callback) => {
      readerCalls.push(name);
      return callback(`${name}.wav`);
    },
  });
  const makeCompressionWorker = (name) => ({
    name,
    run: async () => compressionCalls.push(name),
  });
  const service = {
    audioEvidenceReader: makeReader("old-reader"),
    flacCompressionWorker: makeCompressionWorker("old-flac"),
    async prepareStorageMigration() {
      events.push("service-prepare");
    },
    reconfigureStorage() {
      events.push("service-reconfigure");
      this.audioEvidenceReader = makeReader("new-reader");
      this.flacCompressionWorker = makeCompressionWorker("new-flac");
    },
  };
  const ipcHandlers = {
    createJarvisTranscribeWavAdapter:
      () =>
      async ({ executionContext }) => ({
        noSpeech: true,
        executionDevice: executionContext.device,
      }),
  };
  const builds = [];
  const lifecycle = new JarvisProcessingLifecycle({
    buildRuntime: () => {
      const snapshot = {
        store: repository.captureEvidenceStore,
        reader: service.audioEvidenceReader,
        flac: service.flacCompressionWorker,
      };
      const runtime = createJarvisProcessingRuntime({
        repository,
        service,
        ipcHandlers,
        model: "large-v3-turbo",
        owner: `migration-worker-${builds.length}`,
        now: () => 2_000,
        governor: {
          sample: async () => ({
            state: "available",
            selectedGpuUuid: null,
            restrictiveForMs: 0,
          }),
          admit: () => ({ action: "run_cpu", reason: "test_resources_available" }),
        },
        heavyGate: new HeavyJobGate(),
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
      });
      const stop = runtime.stop.bind(runtime);
      runtime.stop = async () => {
        events.push(`runtime-stop:${snapshot.reader.name}`);
        return stop();
      };
      builds.push({ runtime, ...snapshot });
      return runtime;
    },
  });
  t.after(async () => {
    await lifecycle.stop();
    if (repository.db?.open) repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const oldRuntime = lifecycle.start();
  await oldRuntime.start();
  const oldStore = repository.captureEvidenceStore;
  events.length = 0;

  const participant = createJarvisRuntimeMigrationParticipant({
    processingLifecycle: lifecycle,
    prepareStorageMigration: () => service.prepareStorageMigration(),
    stopRetention: async () => events.push("retention-stop"),
    quiesceAnalysis: async () => events.push("analysis-quiesce"),
    checkpointAndCloseRepository: async () => {
      events.push("repository-close");
      repository.checkpointForMigration();
      repository.close();
    },
    reconfigureStorageHolders: async (dataRoot) => {
      events.push("repository-reopen");
      repository.reopen(path.join(dataRoot, "jarvis.db"));
      service.reconfigureStorage();
    },
    resumeAnalysis: () => events.push("analysis-resume"),
    startRetention: () => events.push("retention-start"),
  });

  await participant.quiesce();
  await participant.close();
  await participant.reopen(nextRoot);
  const newStore = repository.captureEvidenceStore;
  repository.db
    .prepare(
      `
    INSERT INTO sessions (
      id, started_at, ended_at, status, language, created_at,
      capture_mode, processing_state, finalized_at
    ) VALUES ('migrated-session', 100, 1000, 'completed', 'zh', 100,
      'mic', 'processing', 1000)
  `
    )
    .run();
  repository.createTrack({
    id: "migrated-track",
    sessionId: "migrated-session",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 100,
  });
  repository.setTrackState("migrated-track", "ended", 1_000);
  repository.commitChunk({
    id: "migrated-chunk",
    sessionId: "migrated-session",
    trackId: "migrated-track",
    sourceType: "mic",
    sequenceNumber: 0,
    path: "migrated.wav",
    startedAt: 200,
    endedAt: 900,
    durationMs: 700,
    sha256: "a".repeat(64),
    expiresAt: 999_999,
    encoderVersion: "flac-v1",
  });

  const newRuntime = await participant.resume();
  await newRuntime.start();

  assert.deepEqual(events.slice(0, 8), [
    "runtime-stop:old-reader",
    "service-prepare",
    "retention-stop",
    "analysis-quiesce",
    "repository-close",
    "repository-reopen",
    "service-reconfigure",
    "analysis-resume",
  ]);
  assert.equal(events[8], "retention-start");
  assert.equal(oldRuntime.stopping, true);
  assert.equal(builds.length, 2);
  assert.notEqual(newStore, oldStore);
  assert.equal(builds[1].store, newStore);
  assert.equal(builds[1].reader, service.audioEvidenceReader);
  assert.equal(builds[1].flac, service.flacCompressionWorker);
  assert.deepEqual(readerCalls, ["new-reader"]);
  assert.deepEqual(compressionCalls, ["new-flac"]);
  assert.equal(repository.getSession("migrated-session").processing_state, "ready");
});
