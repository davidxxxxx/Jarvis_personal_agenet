const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

test("startup marks interrupted recording sessions recovered without resuming them", () => {
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repository.setSessionStatus("s1", "recording", 1_000);

  try {
    const recovered = repository.recoverOpenSessions(5_000);

    assert.deepEqual(
      recovered.map((row) => row.id),
      ["s1"]
    );
    assert.equal(repository.getSession("s1").status, "recovered");
    assert.equal(repository.getSession("s1").ended_at, 5_000);
  } finally {
    repository.close();
  }
});

test("startup recovery finalizes every degraded dual track and open gap", () => {
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: "mic-1" });
  repository.createTracks([
    {
      id: "tm",
      sessionId: "s1",
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
      state: "active",
    },
    {
      id: "ts",
      sessionId: "s1",
      sourceType: "system",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
      state: "active",
    },
  ]);
  repository.interruptTrack({
    trackId: "ts",
    gap: { id: "g1", trackId: "ts", startedAt: 2_000, reason: "device-change" },
  });

  try {
    const recovered = repository.recoverOpenSessions(5_000);

    assert.deepEqual(
      recovered.map((row) => row.id),
      ["s1"]
    );
    assert.deepEqual(repository.db.prepare("SELECT status, ended_at FROM sessions").get(), {
      status: "recovered",
      ended_at: 5_000,
    });
    assert.deepEqual(
      repository.db.prepare("SELECT DISTINCT state, ended_at FROM audio_tracks").all(),
      [{ state: "recovered", ended_at: 5_000 }]
    );
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get()
        .count,
      0
    );
    assert.equal(
      repository.db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at,
      5_000
    );
  } finally {
    repository.close();
  }
});

test("startup backfills legacy evidence before constructing retention cleanup", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");
  const repositoryIndex = mainSource.indexOf("jarvisRepository = new JarvisRepository");
  const backfillIndex = mainSource.indexOf("runLegacyRecordingBackfillAtStartup({");
  const retentionIndex = mainSource.indexOf("retentionCleaner = new RetentionCleaner");

  assert.ok(repositoryIndex >= 0);
  assert.ok(backfillIndex > repositoryIndex);
  assert.ok(retentionIndex > backfillIndex);
});

test("startup reconciles historical speaker readiness with the selected runtime policy", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");
  const profileIndex = mainSource.indexOf("const voiceProfileStore = new VoiceProfileStore");
  const runtimeIndex = mainSource.indexOf(
    "const processingRuntime = startJarvisProcessingRuntime();",
    profileIndex
  );
  const reconciliationIndex = mainSource.indexOf(
    "jarvisRepository.reconcileHistoricalSpeakerReadiness",
    runtimeIndex
  );

  assert.ok(profileIndex >= 0);
  assert.ok(runtimeIndex > profileIndex);
  assert.ok(reconciliationIndex > runtimeIndex);
  assert.match(
    mainSource.slice(reconciliationIndex, reconciliationIndex + 300),
    /diarizationPolicy:\s*processingRuntime\.diarizationPolicy/u
  );
});

test("model download wiring reports VAD recovery only after verified initialization", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");

  assert.match(
    mainSource,
    /const vadInitialization = await speechVadClassifier\?\.initialize\(\);[\s\S]*?vadInitialization\?\.ok === true[\s\S]*?speechVadClassifier\?\.isReady\?\.\(\) === true[\s\S]*?jarvisService\?\.reportVadRecovered/
  );
});

test("main registers runtime and production composition providers without optional gaps", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");
  const providerStart = mainSource.indexOf("createJarvisRuntimeMigrationParticipant({");
  const providerEnd = mainSource.indexOf(
    "storageComposition.registerWriterProvider()",
    providerStart
  );
  const provider = mainSource.slice(providerStart, providerEnd);
  const compositionStart = mainSource.indexOf("createProductionStorageComposition({");
  const compositionEnd = mainSource.indexOf("const hasSavedDataRoot", compositionStart);
  const composition = mainSource.slice(compositionStart, compositionEnd);

  assert.match(provider, /processingLifecycle: jarvisProcessingLifecycle/);
  assert.match(
    provider,
    /prepareStorageMigration: \(\) => jarvisService\.prepareStorageMigration\(\)/
  );
  assert.match(provider, /stopRetention: \(\) => retentionCleaner\.stop\(\)/);
  assert.match(provider, /quiesceAnalysis: \(\) => jarvisAnalysisScheduler\.quiesce\(\)/);
  assert.match(provider, /jarvisRepository\.checkpointForMigration\(\)/);
  assert.match(provider, /jarvisRepository\.close\(\)/);
  assert.match(provider, /reconfigureStorageHolders/);
  assert.match(
    provider,
    /resumeAnalysis: \(\) => \{[\s\S]*?jarvisAnalysisScheduler\.resume\(\);[\s\S]*?jarvisNotificationScheduler\?\.start\(\);[\s\S]*?\}/
  );
  assert.match(provider, /startRetention: \(\) => retentionCleaner\.start\(\)/);
  assert.doesNotMatch(
    provider,
    /jarvisAnalysisScheduler\?\.(?:quiesce|resume)|retentionCleaner\?\.(?:stop|start)/
  );
  assert.match(composition, /whisperCudaManager/);
  assert.match(composition, /whisperManager/);
  assert.match(composition, /parakeetManager/);
  assert.match(composition, /diarizationManager/);
  assert.match(composition, /modelManagerBridge/);
  assert.match(mainSource, /whisperCudaManager\?\.resetDataRoot\?\.\(\)/);
  assert.match(mainSource, /storageComposition\.registerWriterProvider\(\)/);
});

test("main passes speaker correction service only to the production IPC registrar", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");
  const lifecycleStart = mainSource.indexOf("jarvisPowerLifecycle = new JarvisPowerLifecycle({");
  const lifecycleEnd = mainSource.indexOf("  });", lifecycleStart);
  const ipcStart = mainSource.indexOf("registerJarvisIpc({", lifecycleEnd);
  const ipcEnd = mainSource.indexOf("  });", ipcStart);

  assert.ok(lifecycleStart >= 0);
  assert.ok(lifecycleEnd > lifecycleStart);
  assert.ok(ipcStart > lifecycleEnd);
  assert.ok(ipcEnd > ipcStart);
  assert.doesNotMatch(mainSource.slice(lifecycleStart, lifecycleEnd), /speakerCorrectionService/);
  assert.match(mainSource.slice(ipcStart, ipcEnd), /\bspeakerCorrectionService,/);
});
