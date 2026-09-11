const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");
const DataDirectoryMigrator = require("../../src/jarvis/main/DataDirectoryMigrator");
const DataRootRelocator = require("../../src/jarvis/main/DataRootRelocator");
const FlacCompressionWorker = require("../../src/jarvis/main/FlacCompressionWorker");
const HeavyJobGate = require("../../src/jarvis/main/HeavyJobGate");
const { createJarvisProcessingRuntime } = require("../../src/jarvis/main/JarvisProcessingRuntime");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");
const { createSafeRecordingDelete } = require("../../src/jarvis/main/SafeRecordingDelete");
const StorageGovernor = require("../../src/jarvis/main/StorageGovernor");

const SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const VIRTUAL_HOUR_MS = 60 * 60 * 1_000;
const THREE_HOURS_MS = 3 * VIRTUAL_HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
// The migration phase verifies and relocates the complete three-hour evidence tree.
// Windows antivirus and concurrent test workers can make that legitimate I/O exceed
// the old 20-second unit-scale deadline without indicating a deadlock.
const OPERATION_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;

const pcmCache = new Map();

function pcm(durationMs, amplitude = 0) {
  const key = `${durationMs}:${amplitude}`;
  if (!pcmCache.has(key)) {
    const bytes = Buffer.alloc(Math.round((BYTES_PER_SECOND * durationMs) / 1_000));
    if (amplitude !== 0) {
      for (let offset = 0; offset < bytes.length; offset += 2) {
        bytes.writeInt16LE(amplitude, offset);
      }
    }
    pcmCache.set(key, bytes);
  }
  return pcmCache.get(key);
}

function dualSources() {
  return [
    {
      sourceType: "mic",
      deviceId: "shure-mv7-simulated-boundary",
      deviceLabel: "Deterministic physical microphone boundary",
      strategy: "web-audio",
    },
    {
      sourceType: "system",
      deviceId: null,
      deviceLabel: "Deterministic Windows output boundary",
      strategy: "wasapi-loopback",
    },
  ];
}

function withTimeout(promise, label, timeoutMs = OPERATION_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function createGovernedSoakRuntime({
  repository,
  service,
  now,
  owner = "soak-worker",
  deferFinalTranscription = false,
}) {
  return createJarvisProcessingRuntime({
    repository,
    service,
    ipcHandlers: {
      createJarvisTranscribeWavAdapter:
        () =>
        async ({ executionContext }) => ({
          noSpeech: true,
          executionDevice: executionContext.device,
        }),
    },
    model: "soak-model",
    owner,
    now,
    governor: {
      sample: async () => ({
        state: deferFinalTranscription ? "busy" : "available",
        reason: deferFinalTranscription ? "external_gpu_busy" : "resources_available",
        externalGpuBusy: deferFinalTranscription,
        selectedGpuUuid: null,
        restrictiveForMs: 0,
      }),
      admit: (kind) =>
        deferFinalTranscription && kind === "final_transcription"
          ? { action: "defer", reason: "external_gpu_busy" }
          : { action: "run_cpu", reason: "bounded_soak" },
    },
    heavyGate: new HeavyJobGate(),
    maxJobsPerDrain: 100,
    maxDrainMs: 20_000,
  });
}

async function drainGovernedSoakRuntime(runtime, label, maxDrains = 100) {
  let processed = 0;
  for (let drain = 0; drain < maxDrains; drain += 1) {
    const count = await withTimeout(runtime.drainOnce(), `${label} drain ${drain + 1}`);
    processed += count;
    if (count === 0) return processed;
  }
  throw new Error(`${label} exceeded ${maxDrains} governed drains`);
}

function createVirtualClock(startedAt = 0) {
  let value = startedAt;
  return {
    now: () => value,
    set(next) {
      assert.ok(Number.isSafeInteger(next) && next >= value, "virtual time must be monotonic");
      value = next;
      return value;
    },
  };
}

class DeterministicVad {
  constructor() {
    this.ready = true;
    this.failNext = false;
  }

  isReady() {
    return this.ready;
  }

  classify({ pcm: input }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("deterministic VAD interruption");
    }
    return input.readInt16LE(0) === 0 ? 0.01 : 0.9;
  }

  reportFailure() {
    this.ready = false;
  }

  recover() {
    this.ready = true;
  }

  async reset() {}

  async resetSession() {}
}

function parseWav(wav) {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  const channels = wav.readUInt16LE(22);
  return {
    bytes: Buffer.from(wav.subarray(44)),
    sampleRate: wav.readUInt32LE(24),
    channels,
    sampleCount: wav.readUInt32LE(40) / (channels * 2),
  };
}

class DeterministicLosslessCodec {
  async encode(inputPath, outputPath) {
    const decoded = parseWav(await fsp.readFile(inputPath));
    const metadata = Buffer.alloc(12);
    metadata.writeUInt32LE(decoded.sampleRate, 0);
    metadata.writeUInt32LE(decoded.channels, 4);
    metadata.writeUInt32LE(decoded.sampleCount, 8);
    await fsp.writeFile(outputPath, Buffer.concat([Buffer.from("fLaC"), metadata, decoded.bytes]));
  }

  async decode(inputPath, format) {
    if (format === "wav") return parseWav(await fsp.readFile(inputPath));
    const encoded = await fsp.readFile(inputPath);
    assert.equal(encoded.toString("ascii", 0, 4), "fLaC");
    return {
      bytes: Buffer.from(encoded.subarray(16)),
      sampleRate: encoded.readUInt32LE(4),
      channels: encoded.readUInt32LE(8),
      sampleCount: encoded.readUInt32LE(12),
    };
  }
}

function createDiskBoundary() {
  const disk = {
    volumeBytes: 200 * 1024 ** 3,
    freeBytes: 40 * 1024 ** 3,
  };
  const implementation = Object.create(fs);
  implementation.statfsSync = () => ({
    bsize: 1,
    blocks: disk.volumeBytes,
    bavail: disk.freeBytes,
  });
  return { disk, implementation };
}

function createHelperTracker() {
  const active = new Set();
  let maxActive = 0;
  let spawned = 0;
  return {
    active,
    get maxActive() {
      return maxActive;
    },
    get spawned() {
      return spawned;
    },
    spawn(...args) {
      const child = spawn(...args);
      spawned += 1;
      active.add(child);
      maxActive = Math.max(maxActive, active.size);
      const remove = () => active.delete(child);
      child.once("close", remove);
      child.once("error", remove);
      return child;
    },
  };
}

function createInProcessLeaseProvider() {
  const acquire = async (candidate) => {
    const original = await fsp.lstat(candidate);
    if (!original.isDirectory() || original.isSymbolicLink()) {
      throw new Error("directory lease acquisition failed");
    }
    let active = true;
    return {
      path: candidate,
      identity: `soak:${String(original.dev)}:${String(original.ino)}`,
      assertActive() {
        if (!active) throw new Error("directory lease is not active");
      },
      async assertCurrent() {
        if (!active) throw new Error("directory lease is not active");
        const current = await fsp.lstat(candidate);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          String(current.dev) !== String(original.dev) ||
          String(current.ino) !== String(original.ino)
        ) {
          throw new Error("directory lease path changed");
        }
      },
      async release() {
        active = false;
      },
    };
  };
  return {
    acquire,
    async createAndAcquire(candidate) {
      await fsp.mkdir(candidate, { recursive: false });
      return acquire(candidate);
    },
  };
}

function currentChildren() {
  return (process._getActiveHandles?.() ?? []).filter(
    (handle) => handle?.constructor?.name === "ChildProcess" && handle.exitCode === null
  );
}

function createOwnedFileHandleTracker(root) {
  const ownedRoot = path.resolve(root);
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const active = new Set();
  let peak = 0;
  let installed = false;

  function trackedOpenSync(candidate, ...args) {
    const descriptor = originalOpenSync.call(fs, candidate, ...args);
    if (typeof candidate === "string") {
      const resolved = path.resolve(candidate);
      const relative = path.relative(ownedRoot, resolved);
      if (
        relative.length === 0 ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      ) {
        active.add(descriptor);
        peak = Math.max(peak, active.size);
      }
    }
    return descriptor;
  }

  function trackedCloseSync(descriptor) {
    const result = originalCloseSync.call(fs, descriptor);
    active.delete(descriptor);
    return result;
  }

  return {
    active,
    get peak() {
      return peak;
    },
    install() {
      assert.equal(installed, false);
      installed = true;
      fs.openSync = trackedOpenSync;
      fs.closeSync = trackedCloseSync;
    },
    restore() {
      if (!installed) return;
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      installed = false;
    },
  };
}

function createOwnedTimerTracker() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const active = new Set();
  let peak = 0;
  let installed = false;
  return {
    active,
    get peak() {
      return peak;
    },
    install() {
      assert.equal(installed, false);
      installed = true;
      global.setTimeout = function trackedSetTimeout(callback, delay, ...args) {
        const taskOwned =
          delay === 1_000 &&
          typeof callback === "function" &&
          callback.toString().includes("VAD classification timed out");
        if (!taskOwned) return originalSetTimeout(callback, delay, ...args);
        let timer = null;
        timer = originalSetTimeout(
          (...callbackArgs) => {
            active.delete(timer);
            callback(...callbackArgs);
          },
          delay,
          ...args
        );
        active.add(timer);
        peak = Math.max(peak, active.size);
        return timer;
      };
      global.clearTimeout = function trackedClearTimeout(timer) {
        active.delete(timer);
        return originalClearTimeout(timer);
      };
    },
    restore() {
      if (!installed) return;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      installed = false;
    },
  };
}

async function teardownOwnedInstrumentation(teardown, restorers) {
  let teardownError = null;
  const restoreErrors = [];
  try {
    await teardown();
  } catch (error) {
    teardownError = error;
  } finally {
    for (const restore of restorers) {
      try {
        restore();
      } catch (error) {
        restoreErrors.push(error);
      }
    }
  }

  if (teardownError && restoreErrors.length === 0) throw teardownError;
  if (!teardownError && restoreErrors.length === 1) throw restoreErrors[0];
  if (teardownError || restoreErrors.length > 0) {
    throw new AggregateError(
      [...(teardownError ? [teardownError] : []), ...restoreErrors],
      "instrumentation teardown failed",
      teardownError ? { cause: teardownError } : undefined
    );
  }
}

async function settleEventLoop() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function taskOwnedResourceSnapshot(service, fileHandles, timerHandles) {
  const sources = Object.values(service.state.sources);
  return {
    writerHandles: service.writer?.writers?.size ?? 0,
    fileHandles: fileHandles.active.size,
    timerHandles: timerHandles.active.size,
    vadWorkers: sources.filter((source) => source.vadProcessing || source.vadInFlight).length,
    retentionWork: service.retentionWork.size,
  };
}

function observeRuntimeBounds(service, metrics, fileHandles, timerHandles) {
  let totalRingBufferBytes = 0;
  for (const source of Object.values(service.state.sources)) {
    metrics.maxVadQueueBytes = Math.max(metrics.maxVadQueueBytes, source.vadQueueBytes);
    metrics.maxVadQueueEntries = Math.max(metrics.maxVadQueueEntries, source.vadQueue.length);
    totalRingBufferBytes += source.gate.bufferedFrames(source.sourceType) * 2;
  }
  metrics.maxRingBufferBytes = Math.max(metrics.maxRingBufferBytes, totalRingBufferBytes);
  metrics.maxRetentionWork = Math.max(metrics.maxRetentionWork, service.retentionWork.size);
  const resources = taskOwnedResourceSnapshot(service, fileHandles, timerHandles);
  metrics.maxWriterHandles = Math.max(metrics.maxWriterHandles, resources.writerHandles);
  metrics.maxVadWorkers = Math.max(metrics.maxVadWorkers, resources.vadWorkers);
}

function durableDurationBySource(repository) {
  const rows = repository.db
    .prepare(
      `SELECT source_type sourceType, COALESCE(SUM(duration_ms), 0) durationMs
       FROM audio_chunks GROUP BY source_type`
    )
    .all();
  return Object.fromEntries(
    ["mic", "system"]
      .map((sourceType) => [sourceType, 0])
      .concat(rows.map((row) => [row.sourceType, row.durationMs]))
  );
}

function scheduledSpeech(second) {
  const cycleSecond = second % 100;
  if (second < 100) {
    return cycleSecond === 5 || cycleSecond === 50 || (cycleSecond >= 54 && cycleSecond < 70);
  }
  return cycleSecond < 18;
}

async function evidenceFiles(recordingsRoot) {
  const files = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.resolve(absolute));
    }
  }
  await walk(recordingsRoot);
  return files;
}

async function assertEvidenceIntegrity(repository, reader, recordingsRoot) {
  const chunks = repository.db
    .prepare("SELECT * FROM audio_chunks WHERE deleted_at IS NULL ORDER BY id")
    .all();
  let corruptChunks = 0;
  for (const chunk of chunks) {
    try {
      const decoded = await reader.readVerifiedPcm(chunk);
      assert.ok(decoded.bytes.length > 0);
    } catch (error) {
      corruptChunks += 1;
      throw error;
    }
  }

  const files = await evidenceFiles(recordingsRoot);
  const durableAudio = files.filter((file) => /\.(?:wav|flac)$/i.test(file));
  const authoritative = new Set(chunks.map((chunk) => path.resolve(chunk.path)));
  const retired = new Set(
    chunks.filter((chunk) => chunk.retired_path).map((chunk) => path.resolve(chunk.retired_path))
  );
  const orphaned = durableAudio.filter(
    (file) => !authoritative.has(path.resolve(file)) && !retired.has(path.resolve(file))
  );
  const incomplete = files.filter(
    (file) => /\.(?:partial|tmp)$/i.test(file) || file.endsWith(".recovery.json")
  );

  assert.deepEqual(orphaned, []);
  assert.deepEqual(incomplete, []);
  assert.equal(corruptChunks, 0);
  return { chunks, corruptChunks, orphanedChunks: orphaned.length };
}

async function nonDatabaseFileHashes(root) {
  const rows = [];
  for (const file of await evidenceFiles(root)) {
    const relative = path.relative(root, file);
    if (relative.startsWith("jarvis.db") || relative.startsWith(".jarvis-relocate-")) continue;
    const bytes = await fsp.readFile(file);
    rows.push([relative, crypto.createHash("sha256").update(bytes).digest("hex")]);
  }
  return rows.sort((left, right) => left[0].localeCompare(right[0]));
}

test("task-owned instrumentation cleanup preserves teardown errors and restores globals", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-soak-cleanup-"));
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let fileHandles = null;
  let timerHandles = null;
  t.after(() =>
    teardownOwnedInstrumentation(
      () => fsp.rm(base, { recursive: true, force: true }),
      [() => fileHandles?.restore(), () => timerHandles?.restore()]
    )
  );

  fileHandles = createOwnedFileHandleTracker(base);
  timerHandles = createOwnedTimerTracker();
  fileHandles.install();
  timerHandles.install();
  const teardownError = new Error("forced instrumentation teardown failure");

  await assert.rejects(
    () =>
      teardownOwnedInstrumentation(async () => {
        throw teardownError;
      }, [() => fileHandles.restore(), () => timerHandles.restore()]),
    (error) => error === teardownError
  );
  assert.equal(fs.openSync, originalOpenSync);
  assert.equal(fs.closeSync, originalCloseSync);
  assert.equal(global.setTimeout, originalSetTimeout);
  assert.equal(global.clearTimeout, originalClearTimeout);

  const restoreError = new Error("forced restore failure");
  let secondRestoreRan = false;
  await assert.rejects(
    () =>
      teardownOwnedInstrumentation(async () => {
        throw teardownError;
      }, [
        () => {
          throw restoreError;
        },
        () => {
          secondRestoreRan = true;
        },
      ]),
    (error) =>
      error instanceof AggregateError &&
      error.cause === teardownError &&
      error.errors[0] === teardownError &&
      error.errors[1] === restoreError
  );
  assert.equal(secondRestoreRan, true);
});

test("bounded soak harness drains capture compression only through the governed runtime", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-bounded-soak-"));
  const recordingsRoot = path.join(root, "recordings");
  const repository = new JarvisRepository(":memory:");
  const clock = createVirtualClock(0);
  const codec = new DeterministicLosslessCodec();
  const reader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot,
    now: clock.now,
  });
  const compressionWorker = new FlacCompressionWorker({
    store: repository.captureEvidenceStore,
    recordingsRoot,
    encoder: codec,
    reader,
    now: clock.now,
  });
  const { implementation: fsImpl } = createDiskBoundary();
  const service = new JarvisService({
    repository,
    userDataDir: root,
    recordingsDir: recordingsRoot,
    broadcast() {},
    now: clock.now,
    fsImpl,
    audioEvidenceReader: reader,
    flacCompressionWorker: compressionWorker,
  });
  const runtime = createGovernedSoakRuntime({ repository, service, now: clock.now });
  t.after(async () => {
    await runtime.stop();
    service.shutdown();
    await compressionWorker.shutdown();
    repository.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  repository.createSession({ id: "bounded-soak", startedAt: 0, micDeviceId: null });

  service.startCapture({ sessionId: "bounded-soak", startedAt: 0, micDeviceId: null });
  assert.equal(service.appendMicPcm("bounded-soak", pcm(100, 1_000)), true);
  clock.set(100);
  service.finishCapture("bounded-soak", clock.now());
  assert.equal(repository.db.prepare("SELECT format FROM audio_chunks").get().format, "wav");

  assert.equal(await drainGovernedSoakRuntime(runtime, "bounded compression"), 3);
  assert.equal(repository.db.prepare("SELECT format FROM audio_chunks").get().format, "flac");
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT job_type, state, attempt_count, model_version
         FROM processing_jobs ORDER BY job_type, model_version`
      )
      .all(),
    [
      {
        job_type: "compress_chunk",
        state: "completed",
        attempt_count: 1,
        model_version: "ffmpeg-flac-v1",
      },
      {
        job_type: "diarize_track",
        state: "retry",
        attempt_count: 1,
        model_version: "jarvis-session-diarization-v1",
      },
      {
        job_type: "transcribe_chunk",
        state: "completed",
        attempt_count: 1,
        model_version: "soak-model",
      },
    ]
  );
});

test(
  "three virtual hours keep production capture and evidence boundaries bounded and recoverable",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const initialChildren = new Set(currentChildren());
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-all-day-soak-"));
    const oldRoot = path.join(base, "old-root");
    const newRoot = path.join(base, "new-root");
    const restartedRoot = path.join(base, "new-root-restarted");
    const journalRoot = path.join(base, "migration-journal");
    const recordingsRoot = path.join(oldRoot, "recordings");
    const dbPath = path.join(oldRoot, "jarvis.db");
    const sessionId = "all-day-soak";
    const clock = createVirtualClock(0);
    const helperTracker = createHelperTracker();
    const fileHandles = createOwnedFileHandleTracker(base);
    const timerHandles = createOwnedTimerTracker();
    let repository = null;
    let service = null;
    let retentionCleaner = null;
    let compressionWorker = null;
    let processingRuntime = null;
    let reader = null;

    t.after(() =>
      teardownOwnedInstrumentation(async () => {
        if (retentionCleaner) {
          await withTimeout(retentionCleaner.stop(), "retention cleaner teardown", 5_000).catch(
            () => {}
          );
        }
        await withTimeout(processingRuntime?.stop(), "processing runtime teardown", 5_000).catch(
          () => {}
        );
        if (service) {
          service.shutdown();
          await withTimeout(service.whenRetentionIdle(), "retention teardown", 5_000).catch(
            () => {}
          );
        }
        await withTimeout(
          compressionWorker?.shutdown(),
          "compression worker teardown",
          5_000
        ).catch(() => {});
        if (repository?.db?.open) repository.close();
        await settleEventLoop();
        await fsp.rm(base, { recursive: true, force: true });
      }, [() => fileHandles.restore(), () => timerHandles.restore()])
    );
    fileHandles.install();
    timerHandles.install();

    await fsp.mkdir(oldRoot, { recursive: true });
    repository = new JarvisRepository(dbPath);
    repository.createSession({
      id: sessionId,
      startedAt: 0,
      micDeviceId: "shure-mv7-simulated-boundary",
      captureMode: "dual",
      retentionMode: "speech_triggered",
    });

    const codec = new DeterministicLosslessCodec();
    reader = new AudioEvidenceReader({
      decoder: codec,
      recordingsRoot,
      now: clock.now,
    });
    let crashInjected = false;
    compressionWorker = new FlacCompressionWorker({
      store: repository.captureEvidenceStore,
      recordingsRoot,
      encoder: codec,
      reader,
      now: clock.now,
      faultInjector(point) {
        if (!crashInjected && point === "after_rename") {
          crashInjected = true;
          throw new Error("simulated interrupted FLAC conversion");
        }
      },
    });
    const reserve = {
      ensureCount: 0,
      releaseCount: 0,
      ensure() {
        this.ensureCount += 1;
      },
      release() {
        this.releaseCount += 1;
        return true;
      },
    };
    const storageGovernor = new StorageGovernor({ reserve });
    const { disk, implementation: fsImpl } = createDiskBoundary();
    const vad = new DeterministicVad();
    const metrics = {
      maxRingBufferBytes: 0,
      maxRetentionWork: 0,
      maxVadQueueBytes: 0,
      maxVadQueueEntries: 0,
      maxWriterHandles: 0,
      maxVadWorkers: 0,
    };
    let broadcastCount = 0;

    service = new JarvisService({
      repository,
      userDataDir: oldRoot,
      recordingsDir: recordingsRoot,
      broadcast() {
        broadcastCount += 1;
      },
      now: clock.now,
      fsImpl,
      vadClassifier: vad,
      vadTimeoutMs: 1_000,
      maxVadQueueMs: 10_000,
      audioEvidenceReader: reader,
      flacCompressionWorker: compressionWorker,
      storageGovernor,
    });
    processingRuntime = createGovernedSoakRuntime({
      repository,
      service,
      now: clock.now,
      deferFinalTranscription: true,
    });
    service.startCapture({
      sessionId,
      startedAt: 0,
      captureMode: "dual",
      retentionMode: "speech_triggered",
      sources: dualSources(),
    });
    const resourceBaseline = taskOwnedResourceSnapshot(service, fileHandles, timerHandles);

    const failureSchedule = new Map(
      Array.from({ length: 12 }, (_, index) => [
        600 + index * 450,
        index % 2 === 0 ? "mic" : "system",
      ])
    );
    const reconnectUntil = { mic: null, system: null };
    const finalContinuousSubmittedBytes = { mic: 0, system: 0 };
    let finalContinuousInitialBytes = null;
    let finalContinuousDurationBefore = null;
    let importantMeetingDurationBefore = null;
    let vadFallbackDurationBefore = null;
    let sourceFailureCount = 0;
    const scheduledFrames = (THREE_HOURS_MS / 1_000) * 2;
    const speechFrames =
      Array.from({ length: THREE_HOURS_MS / 1_000 }, (_, second) => scheduledSpeech(second)).filter(
        Boolean
      ).length * 2;
    let interruptedFlac = null;
    let lowDiskStopSecond = null;
    let completedCaptureSeconds = 0;

    for (let second = 0; second < THREE_HOURS_MS / 1_000; second += 1) {
      clock.set(second * 1_000);
      const sourceToRestore = Object.entries(reconnectUntil).find(
        ([, restoreAt]) => restoreAt === second
      )?.[0];
      if (sourceToRestore) {
        service.sourceRestored(sessionId, sourceToRestore, {
          at: clock.now(),
          deviceId: sourceToRestore === "mic" ? `physical-mic-${second}` : null,
          deviceLabel:
            sourceToRestore === "mic" ? "Recovered physical microphone" : "Recovered output",
          strategy: sourceToRestore === "mic" ? "web-audio" : "wasapi-loopback",
        });
        reconnectUntil[sourceToRestore] = null;
      }

      const failedSource = failureSchedule.get(second);
      if (failedSource) {
        const survivor = failedSource === "mic" ? "system" : "mic";
        const survivorStateBefore = service.getState().sources[survivor].state;
        service.sourceInterrupted(sessionId, failedSource, {
          at: clock.now(),
          reason: "simulated-source-loss",
        });
        reconnectUntil[failedSource] = second + 5;
        sourceFailureCount += 1;
        assert.equal(service.getState().sources[survivor].state, survivorStateBefore);
      }

      if (second === 6_000) {
        vadFallbackDurationBefore = durableDurationBySource(repository);
        vad.failNext = true;
      }
      if (second === 6_005) {
        vad.recover();
        const recovered = service.reportVadRecovered(clock.now());
        assert.equal(recovered.retentionMode, "speech_triggered");
        assert.equal(recovered.effectiveRetentionMode, "speech_triggered");
        assert.equal(recovered.retentionDegradedReason, null);
        const durationAfter = durableDurationBySource(repository);
        for (const sourceType of ["mic", "system"]) {
          assert.ok(durationAfter[sourceType] - vadFallbackDurationBefore[sourceType] >= 5_000);
        }
      }
      if (second === 7_200) {
        importantMeetingDurationBefore = durableDurationBySource(repository);
        const continuous = service.setRetentionMode(sessionId, "continuous", clock.now());
        assert.equal(continuous.retentionMode, "continuous");
        assert.equal(continuous.effectiveRetentionMode, "continuous");
      }
      if (second === 7_210) {
        const speechTriggered = service.setRetentionMode(
          sessionId,
          "speech_triggered",
          clock.now()
        );
        assert.equal(speechTriggered.retentionMode, "speech_triggered");
        assert.equal(speechTriggered.effectiveRetentionMode, "speech_triggered");
        const durationAfter = durableDurationBySource(repository);
        for (const sourceType of ["mic", "system"]) {
          assert.ok(
            durationAfter[sourceType] - importantMeetingDurationBefore[sourceType] >= 10_000
          );
        }
      }
      if (second === 10_750) {
        const continuous = service.setRetentionMode(sessionId, "continuous", clock.now());
        assert.equal(continuous.effectiveRetentionMode, "continuous");
        finalContinuousDurationBefore = durableDurationBySource(repository);
        finalContinuousInitialBytes = Object.fromEntries(
          ["mic", "system"].map((sourceType) => [
            sourceType,
            service.writer.writers.get(sourceType).pendingBytes,
          ])
        );
      }
      const isSpeech = scheduledSpeech(second);
      for (const sourceType of ["mic", "system"]) {
        if (service.getState().sources[sourceType].state !== "active") continue;
        const finalContinuous = second >= 10_750;
        const importantMeeting = second >= 7_200 && second < 7_210;
        const input = pcm(
          1_000,
          finalContinuous ? 1_000 : importantMeeting ? 0 : isSpeech ? 12_000 : 0
        );
        const accepted = service.appendPcm(sessionId, sourceType, input);
        if (finalContinuous && (accepted || service.getState().status === "paused")) {
          finalContinuousSubmittedBytes[sourceType] += input.length;
        }
        observeRuntimeBounds(service, metrics, fileHandles, timerHandles);
        if (!accepted && service.getState().status === "paused") {
          lowDiskStopSecond = second;
          break;
        }
        assert.equal(accepted, true);
      }
      await withTimeout(service.whenRetentionIdle(), `VAD drain at virtual second ${second}`);
      observeRuntimeBounds(service, metrics, fileHandles, timerHandles);

      if (second === 6_000) {
        assert.equal(service.getState().retentionMode, "speech_triggered");
        assert.equal(service.getState().effectiveRetentionMode, "continuous_fallback");
        assert.equal(service.getState().retentionDegradedReason, "vad_unavailable");
      }

      if (second === 100) {
        const faultedCompressionWorker = compressionWorker;
        await drainGovernedSoakRuntime(processingRuntime, "interrupted compression attempt");
        assert.equal(crashInjected, true);
        interruptedFlac = repository.db
          .prepare(
            "SELECT * FROM audio_chunks WHERE format = 'wav' AND path LIKE '%.wav' ORDER BY started_at LIMIT 1"
          )
          .get();
        assert.ok(interruptedFlac);
        assert.equal(fs.existsSync(interruptedFlac.path), true);
        assert.equal(fs.existsSync(interruptedFlac.path.replace(/\.wav$/, ".flac")), true);
        compressionWorker = new FlacCompressionWorker({
          store: repository.captureEvidenceStore,
          recordingsRoot,
          encoder: codec,
          reader,
          now: clock.now,
        });
        const flacRecovery = await withTimeout(
          compressionWorker.recoverStartup(),
          "interrupted FLAC startup recovery"
        );
        assert.ok(flacRecovery.promoted >= 1);
        assert.equal(repository.getAudioChunk(interruptedFlac.id).format, "flac");
        assert.equal(fs.existsSync(interruptedFlac.path), false);
        service.flacCompressionWorker = compressionWorker;
        await withTimeout(faultedCompressionWorker.shutdown(), "faulted compression shutdown");
      } else if (second > 100 && second % 30 === 0) {
        await drainGovernedSoakRuntime(
          processingRuntime,
          `periodic governed processing at virtual second ${second}`
        );
      }

      if (service.getState().status === "paused") break;
      completedCaptureSeconds += 1;
    }

    clock.set(THREE_HOURS_MS);
    assert.equal(clock.now(), THREE_HOURS_MS);
    assert.equal(completedCaptureSeconds, THREE_HOURS_MS / 1_000);
    assert.equal(speechFrames / scheduledFrames, 0.18);
    assert.equal(sourceFailureCount, 12);
    assert.equal(service.getState().status, "recording");

    disk.freeBytes = 1024 ** 3;
    const micWriter = service.writer.writers.get("mic");
    const lowDiskInput = Buffer.alloc(micWriter.chunkBytes - micWriter.pendingBytes);
    const lowDiskInjectedAt = clock.now();
    const lowDiskAccepted = service.appendPcm(sessionId, "mic", lowDiskInput);
    if (lowDiskAccepted || service.getState().status === "paused") {
      finalContinuousSubmittedBytes.mic += lowDiskInput.length;
    }
    lowDiskStopSecond = lowDiskInjectedAt / 1_000;
    clock.set(lowDiskInjectedAt + (lowDiskInput.length * 1_000) / BYTES_PER_SECOND);
    assert.equal(lowDiskAccepted, false);
    assert.equal(lowDiskStopSecond, THREE_HOURS_MS / 1_000);
    assert.equal(service.getState().status, "paused");
    assert.equal(service.getState().errorCode, "capture_stopped_low_disk");
    assert.equal(reserve.ensureCount, 1);
    assert.equal(reserve.releaseCount, 1);
    assert.equal(service.appendPcm(sessionId, "system", pcm(1_000, 1_000)), false);
    await withTimeout(service.whenRetentionIdle(), "low-disk retention drain");
    await drainGovernedSoakRuntime(processingRuntime, "final compression drain");
    observeRuntimeBounds(service, metrics, fileHandles, timerHandles);

    const finalContinuousDurationAfter = durableDurationBySource(repository);
    for (const sourceType of ["mic", "system"]) {
      const durableBytes =
        ((finalContinuousDurationAfter[sourceType] - finalContinuousDurationBefore[sourceType]) *
          BYTES_PER_SECOND) /
        1_000;
      assert.equal(
        durableBytes,
        finalContinuousInitialBytes[sourceType] + finalContinuousSubmittedBytes[sourceType]
      );
    }
    assert.equal(
      repository.db
        .prepare("SELECT count(*) count FROM audio_gaps WHERE reason = 'simulated-source-loss'")
        .get().count,
      12
    );
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get()
        .count,
      0
    );
    const exactRanges = repository.db
      .prepare(
        `SELECT source_type sourceType, started_at startedAt, ended_at endedAt
         FROM audio_chunks WHERE started_at IN (3000, 48000)
         ORDER BY started_at, source_type`
      )
      .all();
    assert.deepEqual(exactRanges, [
      { sourceType: "mic", startedAt: 3_000, endedAt: 9_000 },
      { sourceType: "system", startedAt: 3_000, endedAt: 9_000 },
      { sourceType: "mic", startedAt: 48_000, endedAt: 73_000 },
      { sourceType: "system", startedAt: 48_000, endedAt: 73_000 },
    ]);
    assert.equal(
      repository.db
        .prepare(
          `SELECT count(*) count FROM audio_gaps
           WHERE reason = 'silence_suppressed' AND started_at = 51000 AND ended_at = 54000`
        )
        .get().count,
      0
    );
    assert.ok(metrics.maxRingBufferBytes <= 2 * 2 * SAMPLE_RATE * 2);
    assert.ok(metrics.maxVadQueueBytes <= BYTES_PER_SECOND * 10);
    assert.equal(
      Object.values(service.state.sources).reduce(
        (total, source) => total + source.vadQueueBytes,
        0
      ),
      0
    );
    assert.ok(metrics.maxRetentionWork <= 2);
    assert.deepEqual(resourceBaseline, {
      writerHandles: 0,
      fileHandles: 0,
      timerHandles: 0,
      vadWorkers: 0,
      retentionWork: 0,
    });
    assert.ok(metrics.maxWriterHandles > 0 && metrics.maxWriterHandles <= 2);
    assert.ok(fileHandles.peak > 0 && fileHandles.peak <= 2);
    assert.ok(timerHandles.peak > 0 && timerHandles.peak <= 2);
    assert.ok(metrics.maxVadWorkers > 0 && metrics.maxVadWorkers <= 2);

    service.shutdown();
    const resourceFinal = taskOwnedResourceSnapshot(service, fileHandles, timerHandles);
    assert.deepEqual(resourceFinal, {
      writerHandles: 0,
      fileHandles: 0,
      timerHandles: 0,
      vadWorkers: 0,
      retentionWork: 0,
    });
    service = null;
    await withTimeout(compressionWorker.shutdown(), "compression worker shutdown");

    const preMigrationIntegrity = await assertEvidenceIntegrity(repository, reader, recordingsRoot);
    assert.ok(preMigrationIntegrity.chunks.length > 0);
    const jobs = repository.db
      .prepare("SELECT chunk_id, job_type, state FROM processing_jobs ORDER BY chunk_id, job_type")
      .all();
    assert.equal(jobs.length, preMigrationIntegrity.chunks.length * 2);
    for (const chunk of preMigrationIntegrity.chunks) {
      assert.equal(jobs.filter((job) => job.chunk_id === chunk.id).length, 2);
    }
    assert.ok(jobs.filter((job) => job.state !== "completed").length > 0);
    assert.ok(broadcastCount <= 64);
    const sourceHashes = await nonDatabaseFileHashes(oldRoot);

    const migrationEvents = [];
    let configuredRoot = oldRoot;
    const holderCallbacks = {
      async closeHolders() {
        migrationEvents.push(`close:${path.basename(configuredRoot)}`);
        repository.checkpointForMigration();
        repository.close();
      },
      async persistRoot(root) {
        configuredRoot = root;
        migrationEvents.push(`persist:${path.basename(root)}`);
      },
      async reopenHolders(root) {
        configuredRoot = root;
        repository = new JarvisRepository(path.join(root, "jarvis.db"));
        migrationEvents.push(`reopen:${path.basename(root)}`);
      },
    };
    const leaseProvider = createInProcessLeaseProvider();
    const relocator = new DataRootRelocator();
    const migrationOptions = {
      journalRoot,
      directoryLeaseProvider: leaseProvider,
      volumeInspector: {
        inspect: async () => ({ kind: "fixed", writable: true }),
      },
      pathInspector: {
        inspect: async () => ({ reparse: false, mountPoint: false }),
      },
      closeHolders: holderCallbacks.closeHolders,
      persistRoot: holderCallbacks.persistRoot,
      reopenHolders: holderCallbacks.reopenHolders,
      relocateTarget: (input) => relocator.relocate(input),
    };

    const interruptedMigration = new DataDirectoryMigrator(migrationOptions);
    await assert.rejects(
      withTimeout(
        interruptedMigration.migrate({ from: oldRoot, to: newRoot, failAfterFiles: 2 }),
        "interrupted data-root migration"
      ),
      /migration interrupted/
    );
    assert.equal(configuredRoot, oldRoot);
    assert.equal(repository.db.open, true);

    const restartedMigrator = new DataDirectoryMigrator(migrationOptions);
    await assert.rejects(
      withTimeout(
        restartedMigrator.migrate({ from: oldRoot, to: newRoot }),
        "same-destination data-root migration retry"
      ),
      /migration source changed; restart migration with a new destination/
    );
    assert.equal(configuredRoot, oldRoot);
    assert.equal(repository.db.open, true);

    const recoveryMigrator = new DataDirectoryMigrator(migrationOptions);
    const migrated = await withTimeout(
      recoveryMigrator.migrate({ from: oldRoot, to: restartedRoot }),
      "fresh-destination data-root migration retry"
    );
    assert.equal(migrated.switched, true);
    assert.equal(migrated.currentRoot, restartedRoot);
    assert.equal(configuredRoot, restartedRoot);
    assert.equal(fs.existsSync(oldRoot), true);
    assert.deepEqual(await nonDatabaseFileHashes(restartedRoot), sourceHashes);
    assert.ok(migrationEvents.includes("reopen:old-root"));
    assert.ok(migrationEvents.includes("reopen:new-root-restarted"));

    const migratedRecordingsRoot = path.join(restartedRoot, "recordings");
    reader = new AudioEvidenceReader({
      decoder: codec,
      recordingsRoot: migratedRecordingsRoot,
      now: clock.now,
    });
    compressionWorker = new FlacCompressionWorker({
      store: repository.captureEvidenceStore,
      recordingsRoot: migratedRecordingsRoot,
      encoder: codec,
      reader,
      now: clock.now,
    });
    const postMigrationIntegrity = await assertEvidenceIntegrity(
      repository,
      reader,
      migratedRecordingsRoot
    );
    assert.equal(postMigrationIntegrity.chunks.length, preMigrationIntegrity.chunks.length);
    assert.ok(
      postMigrationIntegrity.chunks.every((chunk) =>
        path.resolve(chunk.path).startsWith(`${path.resolve(migratedRecordingsRoot)}${path.sep}`)
      )
    );

    const transcriptionJobs = repository.db
      .prepare("SELECT id FROM processing_jobs WHERE job_type != 'compress_chunk' ORDER BY id")
      .all();
    assert.ok(transcriptionJobs.length > 1);
    repository.db
      .prepare(
        `UPDATE processing_jobs
         SET state = 'running', lease_owner = 'soak-worker', lease_expires_at = ?
         WHERE id = ?`
      )
      .run(THREE_HOURS_MS + SEVEN_DAYS_MS, transcriptionJobs[0].id);

    const retentionLogs = [];
    const safeDelete = createSafeRecordingDelete({
      spawnImpl: (...args) => helperTracker.spawn(...args),
      timeoutMs: 10_000,
    });
    retentionCleaner = new RetentionCleaner({
      repository,
      recordingsRoot: migratedRecordingsRoot,
      deleteBatch: safeDelete,
      artifactCleaner: compressionWorker,
      temporaryEvidenceCleaner: reader,
      now: clock.now,
      log(record) {
        retentionLogs.push(record);
      },
    });
    const expiryRows = repository.db.prepare("SELECT expires_at FROM audio_chunks").all();
    const earliestExpiry = Math.min(...expiryRows.map((row) => row.expires_at));
    const latestExpiry = Math.max(...expiryRows.map((row) => row.expires_at));
    assert.equal(earliestExpiry >= SEVEN_DAYS_MS, true);

    await withTimeout(
      retentionCleaner.clean(earliestExpiry - 12 * 60 * 60 * 1_000),
      "pre-expiry retention promotion"
    );
    assert.ok(
      repository.db
        .prepare("SELECT count(*) count FROM processing_jobs WHERE state = 'retention_urgent'")
        .get().count > 0
    );

    const retentionResult = await withTimeout(
      retentionCleaner.clean(latestExpiry),
      "seven-day retention cleanup"
    );
    assert.equal(
      retentionResult.deleted + retentionResult.missing,
      preMigrationIntegrity.chunks.length
    );
    assert.equal(retentionResult.retry, 0);
    const tombstones = repository.db
      .prepare("SELECT path, deleted_at FROM audio_chunks ORDER BY id")
      .all();
    assert.ok(tombstones.every((chunk) => chunk.path.startsWith("tombstone:")));
    assert.ok(tombstones.every((chunk) => chunk.deleted_at === latestExpiry));
    assert.equal(
      repository.db
        .prepare(
          `SELECT count(*) count FROM processing_jobs
           WHERE job_type != 'compress_chunk' AND state != 'audio_expired_before_processing'`
        )
        .get().count,
      0
    );
    assert.equal(
      (await evidenceFiles(migratedRecordingsRoot)).filter((file) => /\.(wav|flac)$/i.test(file))
        .length,
      0
    );
    assert.equal(retentionLogs.length, 2);
    retentionCleaner.stop();
    retentionCleaner = null;
    await withTimeout(compressionWorker.shutdown(), "post-retention compression shutdown");
    repository.close();

    await settleEventLoop();
    assert.equal(helperTracker.active.size, 0);
    assert.ok(helperTracker.maxActive <= 8);
    assert.ok(helperTracker.spawned > 0);
    const leftoverChildren = currentChildren().filter((child) => !initialChildren.has(child));
    assert.deepEqual(
      leftoverChildren.map((child) => child.pid),
      []
    );

    t.diagnostic(
      JSON.stringify({
        virtualHours: completedCaptureSeconds / (VIRTUAL_HOUR_MS / 1_000),
        postSoakFaultSeconds: (clock.now() - THREE_HOURS_MS) / 1_000,
        speechDutyCycle: speechFrames / scheduledFrames,
        sourceFailures: sourceFailureCount,
        chunks: preMigrationIntegrity.chunks.length,
        maxRingBufferBytes: metrics.maxRingBufferBytes,
        expectedRingBufferBytes: 2 * 2 * SAMPLE_RATE * 2,
        maxVadQueueBytes: metrics.maxVadQueueBytes,
        maxVadQueueEntries: metrics.maxVadQueueEntries,
        resourceBaseline,
        peakWriterHandles: metrics.maxWriterHandles,
        peakOwnedFileHandles: fileHandles.peak,
        peakOwnedTimerHandles: timerHandles.peak,
        peakVadWorkers: metrics.maxVadWorkers,
        peakRetentionWork: metrics.maxRetentionWork,
        resourceFinal,
        processingJobs: jobs.length,
        orphanedChunks: preMigrationIntegrity.orphanedChunks,
        corruptChunks: preMigrationIntegrity.corruptChunks,
        broadcastRecords: broadcastCount,
        retentionLogRecords: retentionLogs.length,
        peakHelperProcesses: helperTracker.maxActive,
        leftoverHelperProcesses: helperTracker.active.size,
      })
    );
  }
);
