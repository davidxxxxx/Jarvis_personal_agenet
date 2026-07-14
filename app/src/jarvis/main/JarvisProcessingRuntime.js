const ProcessingJobRunner = require("./ProcessingJobRunner");
const JarvisTranscriptionWorker = require("./JarvisTranscriptionWorker");
const TranscriptReconciler = require("./TranscriptReconciler");
const DualTrackTranscriptDeduper = require("./DualTrackTranscriptDeduper");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_JOBS_PER_DRAIN = 25;
const DEFAULT_MAX_DRAIN_MS = 5_000;

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
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    log = () => {},
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

    this.runner = runner;
    this.repository = repository;
    this.reconciler = reconciler;
    this.deduper = deduper;
    this.now = now;
    this.pollIntervalMs = positiveSafeInteger(pollIntervalMs, "pollIntervalMs");
    this.maxJobsPerDrain = positiveSafeInteger(maxJobsPerDrain, "maxJobsPerDrain");
    this.maxDrainMs = positiveSafeInteger(maxDrainMs, "maxDrainMs");
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.log = log;
    this.timer = null;
    this.inFlight = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.stopping = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopping) return Promise.resolve(0);
    this.startPromise = Promise.resolve().then(async () => {
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

  async _drain() {
    const startedAt = this.now();
    let processed = 0;
    while (processed < this.maxJobsPerDrain) {
      if (this.now() - startedAt >= this.maxDrainMs) break;
      const count = await this.runner.runOnce(this.now());
      if (count === 0) break;
      processed += count;
    }

    const sessions = this.repository.listProcessingSessions();
    for (const session of sessions) {
      try {
        this.repository.markSessionProcessing?.(session.id);
        await this.reconciler.reconcileSession(session.id);
        await this.deduper.dedupe(session.id);
        this.repository.refreshSessionReadiness(session.id, this.now());
      } catch (error) {
        this.log({ phase: "post_process", sessionId: session.id, error });
      }
    }
    return processed;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
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
  });
  runner.register("transcribe_chunk", (job) => worker.handle(job));
  runner.register("compress_chunk", (job) => service.flacCompressionWorker.run(job));
  return new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: new TranscriptReconciler({ repository }),
    deduper: new DualTrackTranscriptDeduper({ repository }),
    now,
    log,
    ...runtimeOptions,
  });
}

module.exports = {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
};
