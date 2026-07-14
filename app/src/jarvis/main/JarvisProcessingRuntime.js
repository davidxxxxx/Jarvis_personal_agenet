const ProcessingJobRunner = require("./ProcessingJobRunner");
const JarvisTranscriptionWorker = require("./JarvisTranscriptionWorker");
const TranscriptReconciler = require("./TranscriptReconciler");
const DualTrackTranscriptDeduper = require("./DualTrackTranscriptDeduper");
const ResourceGovernor = require("./ResourceGovernor");
const HeavyJobGate = require("./HeavyJobGate");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_JOBS_PER_DRAIN = 25;
const DEFAULT_MAX_DRAIN_MS = 5_000;
const DEFAULT_MAX_SESSIONS_PER_DRAIN = 5;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

class JarvisProcessingRuntime {
  constructor({
    runner,
    repository,
    reconciler,
    deduper,
    now = Date.now,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxJobsPerDrain = DEFAULT_MAX_JOBS_PER_DRAIN,
    maxDrainMs = DEFAULT_MAX_DRAIN_MS,
    maxSessionsPerDrain = DEFAULT_MAX_SESSIONS_PER_DRAIN,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    log = () => {},
    governor = null,
    whisperController = null,
    startupBarrier = null,
  } = {}) {
    if (
      !runner ||
      typeof runner.runOnce !== "function" ||
      typeof runner.recoverExpiredLeases !== "function"
    ) {
      throw new TypeError("runner must implement durable processing execution");
    }
    if (
      !repository ||
      typeof repository.listProcessingSessions !== "function" ||
      typeof repository.isSessionReadyForPostProcessing !== "function" ||
      typeof repository.refreshSessionReadiness !== "function"
    ) {
      throw new TypeError("repository processing APIs are required");
    }
    if (!reconciler || typeof reconciler.reconcileSession !== "function") {
      throw new TypeError("reconciler.reconcileSession must be a function");
    }
    if (!deduper || typeof deduper.dedupe !== "function") {
      throw new TypeError("deduper.dedupe must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
      throw new TypeError("interval functions are required");
    }
    if (typeof log !== "function") throw new TypeError("log must be a function");
    if (startupBarrier !== null && typeof startupBarrier?.then !== "function") {
      throw new TypeError("startupBarrier must be a promise or null");
    }
    if (governor !== null && typeof governor.sample !== "function") {
      throw new TypeError("governor.sample must be a function");
    }
    if (
      whisperController !== null &&
      (typeof whisperController.isIdle !== "function" ||
        typeof whisperController.stop !== "function")
    ) {
      throw new TypeError("whisperController must implement isIdle and stop");
    }

    this.runner = runner;
    this.repository = repository;
    this.reconciler = reconciler;
    this.deduper = deduper;
    this.now = now;
    this.pollIntervalMs = positiveSafeInteger(pollIntervalMs, "pollIntervalMs");
    this.maxJobsPerDrain = positiveSafeInteger(maxJobsPerDrain, "maxJobsPerDrain");
    this.maxDrainMs = positiveSafeInteger(maxDrainMs, "maxDrainMs");
    this.maxSessionsPerDrain = positiveSafeInteger(maxSessionsPerDrain, "maxSessionsPerDrain");
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.log = log;
    this.governor = governor;
    this.whisperController = whisperController;
    this.startupBarrier = startupBarrier;
    this.restrictiveReleaseLatched = false;
    this.timer = null;
    this.inFlight = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.stopping = false;
    this.running = true;
    this.sessionCursor = null;
    this.sessionPhaseFirst = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopping) return Promise.resolve(0);
    this.startPromise = Promise.resolve().then(async () => {
      if (this.stopping) return 0;
      if (this.startupBarrier) await this.startupBarrier;
      if (this.stopping) return 0;
      try {
        this.runner.recoverExpiredLeases(this.now());
      } catch (error) {
        this.log({ phase: "recovery", error });
      }
      this.timer = this.setInterval(() => {
        void this.drainOnce().catch((error) => {
          this.log({ phase: "poll", error });
        });
      }, this.pollIntervalMs);
      this.timer?.unref?.();
      return this.drainOnce();
    });
    return this.startPromise;
  }

  drainOnce() {
    if (this.stopping) return this.inFlight ?? Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const operation = this._drain();
    this.inFlight = operation.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = null;
    });
    const wrapped = this.inFlight;
    return wrapped;
  }

  _hasDrainBudget(startedAt) {
    return !this.stopping && this.running && this.now() - startedAt < this.maxDrainMs;
  }

  _sessionCursorFor(session) {
    return {
      sortAt: session.finalized_at ?? session.ended_at ?? 0,
      id: session.id,
    };
  }

  _listProcessingWindow(limit) {
    if (limit <= 0) return [];
    const rows = this.repository
      .listProcessingSessions({ after: this.sessionCursor, limit })
      .slice(0, limit);
    if (this.sessionCursor === null || rows.length >= limit) return rows;
    const seen = new Set(rows.map((session) => session.id));
    const wrapped = this.repository.listProcessingSessions({
      after: null,
      limit: limit - rows.length,
    });
    for (const session of wrapped) {
      if (rows.length >= limit) break;
      if (!seen.has(session.id)) {
        rows.push(session);
        seen.add(session.id);
      }
    }
    return rows;
  }

  async _runJobPhase(startedAt) {
    let processed = 0;
    while (processed < this.maxJobsPerDrain) {
      if (!this._hasDrainBudget(startedAt)) break;
      const count = await this.runner.runOnce(this.now());
      if (count === 0) break;
      processed += count;
    }
    return processed;
  }

  async _releaseIdleWhisperUnderPressure() {
    if (!this.governor) return;
    try {
      const snapshot = await this.governor.sample();
      if (snapshot?.state === "available") {
        this.restrictiveReleaseLatched = false;
        return;
      }
      if (
        this.restrictiveReleaseLatched ||
        !this.whisperController ||
        (snapshot?.restrictiveForMs ?? 0) < 60_000 ||
        !(await this.whisperController.isIdle())
      ) {
        return;
      }
      await this.whisperController.stop();
      this.restrictiveReleaseLatched = true;
    } catch (error) {
      this.log({ phase: "resource_release", error });
    }
  }

  async _runSessionPhase(sessions, startedAt, limit, visited) {
    let inspected = 0;
    for (const session of sessions) {
      if (inspected >= limit || !this._hasDrainBudget(startedAt)) break;
      if (!session?.id || visited.has(session.id)) continue;
      visited.add(session.id);
      try {
        if (!this.repository.isSessionReadyForPostProcessing(session.id)) {
          this.repository.markSessionProcessing?.(session.id);
          continue;
        }
        this.repository.markSessionProcessing?.(session.id);
        await this.reconciler.reconcileSession(session.id);
        await this.deduper.dedupe(session.id);
        this.repository.refreshSessionReadiness(session.id, this.now());
      } catch (error) {
        this.log({ phase: "post_process", sessionId: session.id, error });
      } finally {
        this.sessionCursor = this._sessionCursorFor(session);
        inspected += 1;
      }
    }
    return inspected;
  }

  async _drain() {
    const startedAt = this.now();
    await this._releaseIdleWhisperUnderPressure();
    const sessionsFirst = this.sessionPhaseFirst;
    this.sessionPhaseFirst = !this.sessionPhaseFirst;
    const candidatesBefore = this._listProcessingWindow(this.maxSessionsPerDrain);
    const visited = new Set();
    let inspected = 0;
    let processed = 0;

    if (sessionsFirst) {
      inspected += await this._runSessionPhase(
        candidatesBefore,
        startedAt,
        this.maxSessionsPerDrain,
        visited
      );
    }
    if (this._hasDrainBudget(startedAt)) {
      processed = await this._runJobPhase(startedAt);
    }
    if (inspected >= this.maxSessionsPerDrain || !this._hasDrainBudget(startedAt)) {
      return processed;
    }

    const candidatesAfter = this._listProcessingWindow(this.maxSessionsPerDrain - inspected);
    const candidates = sessionsFirst ? candidatesAfter : [...candidatesBefore, ...candidatesAfter];
    await this._runSessionPhase(
      candidates,
      startedAt,
      this.maxSessionsPerDrain - inspected,
      visited
    );
    return processed;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.running = false;
    if (this.timer !== null) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    this.stopPromise = Promise.resolve(this.inFlight).then(() => undefined);
    return this.stopPromise;
  }
}

function createJarvisProcessingRuntime({
  repository,
  service,
  ipcHandlers,
  model,
  owner = `jarvis-${process.pid}`,
  now = Date.now,
  log = () => {},
  governor = null,
  heavyGate = null,
  telemetryProvider,
  cpuProvider,
  powerProvider,
  previewEnabled = true,
  whisperController = null,
  ...runtimeOptions
} = {}) {
  if (!repository?.captureEvidenceStore) {
    throw new TypeError("repository.captureEvidenceStore is required");
  }
  if (!service?.audioEvidenceReader || !service?.flacCompressionWorker) {
    throw new TypeError("current Jarvis service processing workers are required");
  }
  if (!ipcHandlers || typeof ipcHandlers.createJarvisTranscribeWavAdapter !== "function") {
    throw new TypeError("ipcHandlers transcription adapter is required");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("configured Jarvis Whisper model is required");
  }
  const configuredModel = model.trim();
  const whisperManager = ipcHandlers.whisperManager || null;
  const cudaManager = ipcHandlers.whisperCudaManager || null;
  const effectiveGovernor =
    governor ??
    new ResourceGovernor({
      now,
      ...(telemetryProvider ? { telemetryProvider } : {}),
      ...(cpuProvider ? { cpuProvider } : {}),
      ...(powerProvider ? { powerProvider } : {}),
      previewEnabled,
      ownedPidsProvider: () =>
        [process.pid, whisperManager?.serverManager?.process?.pid].filter(
          (pid) => Number.isSafeInteger(pid) && pid > 0
        ),
      cudaProvider: async () => {
        const startOptions = cudaManager?.getVerifiedStartOptions?.() ?? {
          useCuda: false,
          gpuUuid: null,
        };
        const status = cudaManager?.getStatus?.({ gpuUuid: startOptions.gpuUuid }) ?? null;
        return {
          installed: status?.present === true || status?.downloaded === true,
          verified: startOptions.useCuda === true && status?.verified === true,
          quarantined: /quarantin/iu.test(status?.reason || ""),
          gpuUuid: startOptions.useCuda ? startOptions.gpuUuid : null,
          peakVramMb: status?.verification?.peakVramMb ?? null,
        };
      },
    });
  const effectiveGate = heavyGate ?? new HeavyJobGate();
  const effectiveWhisperController =
    whisperController ??
    (whisperManager
      ? {
          isIdle: () => whisperManager._transcribing !== true,
          stop: () => whisperManager.stopServer(),
        }
      : null);
  const worker = new JarvisTranscriptionWorker({
    repository,
    audioEvidenceReader: service.audioEvidenceReader,
    transcribeWav: ipcHandlers.createJarvisTranscribeWavAdapter({ model: configuredModel }),
    modelVersion: configuredModel,
    now,
  });
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner,
    now,
    governor: effectiveGovernor,
    heavyGate: effectiveGate,
  });
  runner.register("transcribe_chunk", (job, context) => worker.handle(job, context));
  runner.register("compress_chunk", async (job) => {
    await service.flacCompressionWorker.run(job, { owner });
    return { executionDevice: "cpu" };
  });
  const startupBarrier =
    runtimeOptions.startupBarrier ?? service.waitForCompressionRecovery?.() ?? null;
  return new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: new TranscriptReconciler({ repository }),
    deduper: new DualTrackTranscriptDeduper({ repository }),
    now,
    log,
    governor: effectiveGovernor,
    whisperController: effectiveWhisperController,
    ...runtimeOptions,
    startupBarrier,
  });
}

module.exports = {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
};
