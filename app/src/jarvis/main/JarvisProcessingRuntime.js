const ProcessingJobRunner = require("./ProcessingJobRunner");
const JarvisTranscriptionWorker = require("./JarvisTranscriptionWorker");
const SessionDiarizationWorker = require("./SessionDiarizationWorker");
const SpeakerProcessingPolicy = require("./SpeakerProcessingPolicy");
const SpeakerIdentityResolutionWorker = require("./SpeakerIdentityResolutionWorker");
const DualSpeakerVerifier = require("./DualSpeakerVerifier");
const DualSpeakerEvidenceProvider = require("./DualSpeakerEvidenceProvider");
const DualSpeakerIdentityResolver = require("./DualSpeakerIdentityResolver");
const TranscriptReconciler = require("./TranscriptReconciler");
const DualTrackTranscriptDeduper = require("./DualTrackTranscriptDeduper");
const ResourceGovernor = require("./ResourceGovernor");
const { JOB_PRIORITY } = ResourceGovernor;
const HeavyJobGate = require("./HeavyJobGate");
const PreviewTranscriptionScheduler = require("./PreviewTranscriptionScheduler");
const { createHash } = require("node:crypto");
const { SESSION_DIARIZATION_POLICY } = require("./SessionDiarizationPolicy");
const { HYBRID_DIARIZATION_POLICY } = require("./HybridDiarizationPolicy");
const HybridDiarizationManager = require("./HybridDiarizationManager");
const HistoricalDiarizationBackfillService = require("./HistoricalDiarizationBackfillService");
const { resolveFullscreenYieldActive } = require("./FullscreenYieldPolicy");
const defaultSpeakerEmbeddingHelper = require("../../helpers/speakerEmbeddings");
const { SpeakerEmbeddings } = require("../../helpers/speakerEmbeddings");
const { SPEAKER_MODEL_KEYS } = require("./SpeakerModelManifest");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_JOBS_PER_DRAIN = 25;
const DEFAULT_MAX_DRAIN_MS = 5_000;
const DEFAULT_MAX_SESSIONS_PER_DRAIN = 5;
const DEFAULT_ANALYSIS_RECOVERY_LIMIT = 25;
const DEFAULT_ANALYSIS_RECOVERY_INTERVAL_MS = 30_000;
const PREVIEW_CONTEXT_ROW_LIMIT = 16;
const PREVIEW_PROMPT_CODE_POINT_LIMIT = 1_024;
const OVERLAP_SEPARATION_APPLICATION_KEYS = new Set([
  "discord",
  "kook",
  "qq",
  "skype",
  "teams",
  "telegram",
  "tencent_meeting",
  "wechat",
  "wecom",
  "zoom",
]);

function shouldEnableOverlapSeparation(track) {
  if (track?.source_type === "mic") return true;
  return (
    typeof track?.application_key === "string" &&
    OVERLAP_SEPARATION_APPLICATION_KEYS.has(track.application_key)
  );
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function previewBoundary(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeTimestampAdd(base, relative, name) {
  const result = base + relative;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} safe integer overflow`);
  return result;
}

function takeCodePointTail(value, limit) {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join("");
}

function createCommittedAudioPreviewExecutor({ repository, previewAudioRing, transcribeWav }) {
  if (
    typeof repository?.getSession !== "function" ||
    typeof repository?.listPreviewTranscriptContext !== "function"
  ) {
    throw new TypeError("repository preview context APIs are required");
  }
  if (!previewAudioRing || typeof previewAudioRing.withPreviewWav !== "function") {
    throw new TypeError("previewAudioRing.withPreviewWav must be a function");
  }
  if (typeof transcribeWav !== "function") throw new TypeError("transcribeWav must be a function");
  return async ({
    sessionId,
    trackId,
    fromMs,
    throughMs,
    executionDevice,
    selectedGpuUuid,
    cpuThreads,
    lowPriority,
  }) => {
    const safeFromMs = previewBoundary(fromMs, "fromMs");
    const safeThroughMs = previewBoundary(throughMs, "throughMs");
    if (safeThroughMs <= safeFromMs) throw new RangeError("preview requires fromMs < throughMs");
    const session = repository.getSession(sessionId);
    if (!session) throw new Error("preview session is unavailable");
    const sessionStartedAt = previewBoundary(session.started_at, "session.started_at");
    const absoluteFrom = safeTimestampAdd(sessionStartedAt, safeFromMs, "preview from");
    const absoluteThrough = safeTimestampAdd(sessionStartedAt, safeThroughMs, "preview through");
    const contextRows = repository.listPreviewTranscriptContext({
      sessionId,
      trackId,
      from: absoluteFrom,
      to: absoluteThrough,
      limit: PREVIEW_CONTEXT_ROW_LIMIT,
    });
    if (!Array.isArray(contextRows)) throw new TypeError("preview context rows must be an array");
    const prompt = takeCodePointTail(
      contextRows
        .slice(-PREVIEW_CONTEXT_ROW_LIMIT)
        .map((segment) =>
          typeof segment?.text === "string" ? segment.text.replace(/\s+/gu, " ").trim() : ""
        )
        .filter(Boolean)
        .join(" "),
      PREVIEW_PROMPT_CODE_POINT_LIMIT
    );
    const segment = await previewAudioRing.withPreviewWav(
      { sessionId, trackId, fromMs: safeFromMs, throughMs: safeThroughMs },
      async (snapshot) => {
        const raw = await transcribeWav({
          path: snapshot.path,
          language: null,
          initialPrompt: prompt,
          executionContext: {
            device: executionDevice,
            selectedGpuUuid: executionDevice === "cuda" ? selectedGpuUuid : null,
            cpuThreads,
            lowPriority,
          },
        });
        if (raw?.executionDevice !== executionDevice) {
          throw new Error("EXECUTION_DEVICE_MISMATCH");
        }
        if (raw?.noSpeech === true) return null;
        if (raw?.success === false || typeof raw?.text !== "string") {
          throw new Error("TRANSCRIPTION_INVALID_RESULT");
        }
        const text = raw.text.replace(/\s+/gu, " ").trim();
        if (!text) return null;
        const confidence = raw.confidence ?? 0;
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error("TRANSCRIPTION_INVALID_RESULT");
        }
        const startedAt = session.started_at + snapshot.fromMs;
        const endedAt = session.started_at + snapshot.throughMs;
        const id = `preview_${createHash("sha256")
          .update(`${sessionId}\u0000${trackId}\u0000${snapshot.sha256}\u0000${throughMs}`)
          .digest("hex")
          .slice(0, 32)}`;
        return {
          id,
          startedAt,
          endedAt,
          personId: null,
          speakerLabel: snapshot.sourceType,
          sourceType: snapshot.sourceType,
          text,
          confidence,
          isStable: false,
        };
      }
    );
    return { segments: segment ? [segment] : [] };
  };
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
    analysisRecoveryIntervalMs = DEFAULT_ANALYSIS_RECOVERY_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    log = () => {},
    governor = null,
    onResourceSnapshot = () => {},
    whisperController = null,
    startupBarrier = null,
    previewScheduler = null,
    cloudDispatcher = null,
    analysisScheduler = null,
    analysisBudgetGuard = null,
    dailyDigestScheduler = null,
    speakerProcessingPolicy = null,
    diarizationPolicy = SESSION_DIARIZATION_POLICY,
    diarizationRuntime = null,
    historicalBackfillService = null,
    dualSpeakerVerifier = null,
    prepareTranscriptionJobs = null,
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
    if (typeof onResourceSnapshot !== "function") {
      throw new TypeError("onResourceSnapshot must be a function");
    }
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
    if (
      previewScheduler !== null &&
      (typeof previewScheduler.request !== "function" ||
        typeof previewScheduler.tick !== "function" ||
        typeof previewScheduler.status !== "function")
    ) {
      throw new TypeError("previewScheduler must implement request, tick, and status");
    }
    if (
      cloudDispatcher !== null &&
      (typeof cloudDispatcher.start !== "function" ||
        typeof cloudDispatcher.drainOnce !== "function" ||
        typeof cloudDispatcher.stop !== "function")
    ) {
      throw new TypeError("cloudDispatcher must implement start, drainOnce, and stop");
    }
    if (analysisScheduler !== null && typeof analysisScheduler.analyzeSession !== "function") {
      throw new TypeError("analysisScheduler.analyzeSession must be a function");
    }
    if (
      analysisBudgetGuard !== null &&
      (typeof analysisBudgetGuard.getStatus !== "function" ||
        typeof analysisBudgetGuard.setPolicy !== "function")
    ) {
      throw new TypeError("analysisBudgetGuard must implement getStatus and setPolicy");
    }
    if (
      dailyDigestScheduler !== null &&
      (typeof dailyDigestScheduler.start !== "function" ||
        typeof dailyDigestScheduler.tick !== "function" ||
        typeof dailyDigestScheduler.onSessionReady !== "function" ||
        typeof dailyDigestScheduler.stop !== "function")
    ) {
      throw new TypeError(
        "dailyDigestScheduler must implement start, tick, onSessionReady, and stop"
      );
    }
    if (
      speakerProcessingPolicy !== null &&
      (typeof speakerProcessingPolicy?.evaluate !== "function" ||
        !Object.isFrozen(speakerProcessingPolicy))
    ) {
      throw new TypeError("speakerProcessingPolicy must be immutable and implement evaluate");
    }
    if (
      !diarizationPolicy ||
      typeof diarizationPolicy.policyId !== "string" ||
      !new Set([1, 2]).has(diarizationPolicy.inputVersion)
    ) {
      throw new TypeError("a versioned diarizationPolicy is required");
    }
    if (diarizationRuntime !== null && typeof diarizationRuntime.dispose !== "function") {
      throw new TypeError("diarizationRuntime.dispose must be a function");
    }
    if (
      historicalBackfillService !== null &&
      typeof historicalBackfillService.runOnce !== "function"
    ) {
      throw new TypeError("historicalBackfillService.runOnce must be a function");
    }
    if (
      dualSpeakerVerifier !== null &&
      (typeof dualSpeakerVerifier.screen !== "function" ||
        typeof dualSpeakerVerifier.verify !== "function")
    ) {
      throw new TypeError("dualSpeakerVerifier must implement screen and verify");
    }
    if (prepareTranscriptionJobs !== null && typeof prepareTranscriptionJobs !== "function") {
      throw new TypeError("prepareTranscriptionJobs must be a function or null");
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
    this.analysisRecoveryIntervalMs = positiveSafeInteger(
      analysisRecoveryIntervalMs,
      "analysisRecoveryIntervalMs"
    );
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.log = log;
    this.governor = governor;
    this.onResourceSnapshot = onResourceSnapshot;
    this.whisperController = whisperController;
    this.startupBarrier = startupBarrier;
    this.previewScheduler = previewScheduler;
    this.cloudDispatcher = cloudDispatcher;
    this.analysisScheduler = analysisScheduler;
    this.analysisBudgetGuard = analysisBudgetGuard;
    this.dailyDigestScheduler = dailyDigestScheduler;
    this.speakerProcessingPolicy = speakerProcessingPolicy;
    this.diarizationPolicy = diarizationPolicy;
    this.diarizationRuntime = diarizationRuntime;
    this.historicalBackfillService = historicalBackfillService;
    this.dualSpeakerVerifier = dualSpeakerVerifier;
    this.prepareTranscriptionJobs = prepareTranscriptionJobs;
    this.restrictiveReleaseLatched = false;
    this.fullscreenYieldActive = false;
    this.timer = null;
    this.inFlight = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.previewInFlight = null;
    this.cloudInFlight = null;
    this.analysisRecoveryInFlight = null;
    this.lastAnalysisRecoveryAt = null;
    this.analysisStartupReady = true;
    this.cloudStartupReady = true;
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
      try {
        await Promise.resolve(this.historicalBackfillService?.runOnce?.());
      } catch (error) {
        this.log({ phase: "historical_diarization_backfill", error });
      }
      if (this.stopping) return 0;
      this.cloudStartupReady = this.cloudDispatcher === null;
      this.analysisStartupReady = this.cloudDispatcher === null;
      this.timer = this.setInterval(() => {
        void this.drainOnce().catch((error) => {
          this.log({ phase: "poll", error });
        });
      }, this.pollIntervalMs);
      this.timer?.unref?.();
      const initialDrain = this.drainOnce();
      // Cloud crash recovery can legitimately take minutes after a paid request.
      // Keep local evidence processing live without weakening cloud idempotency.
      void initialDrain.catch(() => {});
      await Promise.resolve(this.dailyDigestScheduler?.start?.());
      if (this.stopping) return 0;
      let cloudRecoveryReady = true;
      try {
        await Promise.resolve(this.cloudDispatcher?.recoverStartup?.());
      } catch (error) {
        cloudRecoveryReady = false;
        this.log({ phase: "analysis_budget_recovery", error });
      }
      if (this.stopping) return 0;
      try {
        if (cloudRecoveryReady) {
          await Promise.resolve(
            this.analysisScheduler?.recoverReadySessions?.({
              limit: DEFAULT_ANALYSIS_RECOVERY_LIMIT,
            })
          );
        }
      } catch (error) {
        this.log({ phase: "analysis_recovery", error });
      }
      if (this.stopping) return 0;
      this.analysisStartupReady = cloudRecoveryReady;
      this.cloudStartupReady = true;
      this._tickCloud({ startup: true });
      return initialDrain;
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

  requestPreview(input) {
    if (!this.previewScheduler) throw new Error("preview scheduler is not configured");
    return this.previewScheduler.request(input);
  }

  previewStatus() {
    return this.previewScheduler?.status() ?? null;
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

  async _runJobPhase(
    startedAt,
    { limit = this.maxJobsPerDrain, priorityBefore = Number.MAX_SAFE_INTEGER } = {}
  ) {
    let processed = 0;
    while (processed < limit) {
      if (!this._hasDrainBudget(startedAt)) break;
      const count = await this.runner.runOnce(this.now(), { priorityBefore });
      if (count === 0) break;
      processed += count;
    }
    return processed;
  }

  async _releaseIdleWhisperUnderPressure() {
    if (!this.governor) return null;
    try {
      const snapshot = await this.governor.sample();
      if (snapshot?.state === "available") {
        this.restrictiveReleaseLatched = false;
        return snapshot;
      }
      if (
        this.restrictiveReleaseLatched ||
        !this.whisperController ||
        (snapshot?.restrictiveForMs ?? 0) < 60_000 ||
        !(await this.whisperController.isIdle())
      ) {
        return snapshot;
      }
      await this.whisperController.stop();
      this.restrictiveReleaseLatched = true;
      return snapshot;
    } catch (error) {
      this.log({ phase: "resource_release", error });
      return null;
    }
  }

  _tickPreview(resourceSnapshot) {
    if (!this.previewScheduler || this.previewInFlight) return;
    const operation = Promise.resolve(this.previewScheduler.tick(resourceSnapshot)).catch(
      (error) => {
        this.log({ phase: "preview", error });
        return 0;
      }
    );
    const wrapped = operation.finally(() => {
      if (this.previewInFlight === wrapped) this.previewInFlight = null;
    });
    this.previewInFlight = wrapped;
  }

  _tickCloud({ startup = false } = {}) {
    if (!this.cloudDispatcher || this.cloudInFlight || this.stopping) return;
    if (!startup && !this.cloudStartupReady) return;
    const operation = Promise.resolve(
      startup ? this.cloudDispatcher.start() : this.cloudDispatcher.drainOnce()
    ).catch((error) => {
      this.log({ phase: "analysis_cloud", error });
      return 0;
    });
    const wrapped = operation.finally(() => {
      if (this.cloudInFlight === wrapped) this.cloudInFlight = null;
    });
    this.cloudInFlight = wrapped;
  }

  _tickReadyAnalysisRecovery() {
    if (
      !this.cloudStartupReady ||
      !this.analysisStartupReady ||
      this.stopping ||
      this.analysisRecoveryInFlight ||
      typeof this.analysisScheduler?.recoverReadySessions !== "function"
    ) {
      return;
    }
    const at = this.now();
    if (
      this.lastAnalysisRecoveryAt !== null &&
      at - this.lastAnalysisRecoveryAt < this.analysisRecoveryIntervalMs
    ) {
      return;
    }
    this.lastAnalysisRecoveryAt = at;
    const operation = Promise.resolve(
      this.analysisScheduler.recoverReadySessions({ limit: 1 })
    ).catch((error) => {
      this.log({ phase: "analysis_ready_recovery", error });
      return 0;
    });
    const wrapped = operation.finally(() => {
      if (this.analysisRecoveryInFlight === wrapped) {
        this.analysisRecoveryInFlight = null;
      }
    });
    this.analysisRecoveryInFlight = wrapped;
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
          this.repository.enqueueDiarizationJobs?.(session.id, {
            at: this.now(),
            policy: this.diarizationPolicy,
            speakerProcessingPolicy: this.speakerProcessingPolicy,
          });
          continue;
        }
        this.repository.markSessionProcessing?.(session.id);
        await this.reconciler.reconcileSession(session.id);
        await this.deduper.dedupe(session.id);
        this.repository.enqueueDiarizationJobs?.(session.id, {
          at: this.now(),
          policy: this.diarizationPolicy,
          speakerProcessingPolicy: this.speakerProcessingPolicy,
        });
        this.repository.enqueueSpeakerIdentityResolutionJob?.(session.id, {
          at: this.now(),
          diarizationPolicy: this.diarizationPolicy,
        });
        const readiness = this.repository.refreshSessionReadiness(session.id, this.now(), {
          diarizationPolicy: this.diarizationPolicy,
        });
        if (readiness?.processing_state === "ready") {
          const localOnly =
            this.repository.isHistoricalLocalOnlyReprocessing?.(session.id) === true;
          if (!localOnly) {
            try {
              await Promise.resolve(this.analysisScheduler?.analyzeSession?.(session.id, "final"));
            } catch (error) {
              this.log({ phase: "analysis_ready", sessionId: session.id, error });
            }
            try {
              await Promise.resolve(this.dailyDigestScheduler?.onSessionReady?.(session.id));
            } catch (error) {
              this.log({ phase: "daily_digest_ready", sessionId: session.id, error });
            }
          } else {
            this.repository.completeHistoricalLocalOnlyReprocessing?.(session.id, this.now());
          }
        }
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
    const resourceSnapshot = await this._releaseIdleWhisperUnderPressure();
    if (this.stopping || !this.running) return 0;
    try {
      await Promise.resolve(this.onResourceSnapshot(resourceSnapshot));
    } catch (error) {
      this.log({ phase: "resource_snapshot", error });
    }
    if (this.stopping || !this.running) return 0;
    this.fullscreenYieldActive = resolveFullscreenYieldActive(
      resourceSnapshot,
      this.fullscreenYieldActive
    );
    if (this.fullscreenYieldActive || resourceSnapshot?.reason === "cpu_load_high") {
      this._tickPreview(resourceSnapshot);
      return 0;
    }
    try {
      await Promise.resolve(this.dailyDigestScheduler?.tick?.());
    } catch (error) {
      this.log({ phase: "daily_digest_tick", error });
    }
    this._tickCloud();
    this._tickReadyAnalysisRecovery();
    if (this.prepareTranscriptionJobs) await this.prepareTranscriptionJobs();
    if (this.stopping || !this.running) return 0;
    let processed = await this._runJobPhase(startedAt, {
      priorityBefore: JOB_PRIORITY.preview,
    });
    if (processed >= this.maxJobsPerDrain || !this._hasDrainBudget(startedAt)) return processed;
    this._tickPreview(resourceSnapshot);
    const sessionsFirst = this.sessionPhaseFirst;
    this.sessionPhaseFirst = !this.sessionPhaseFirst;
    const candidatesBefore = this._listProcessingWindow(this.maxSessionsPerDrain);
    const visited = new Set();
    let inspected = 0;

    if (sessionsFirst) {
      inspected += await this._runSessionPhase(
        candidatesBefore,
        startedAt,
        this.maxSessionsPerDrain,
        visited
      );
    }
    if (this._hasDrainBudget(startedAt)) {
      processed += await this._runJobPhase(startedAt, {
        limit: this.maxJobsPerDrain - processed,
      });
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
    this.previewScheduler?.stop?.();
    if (this.timer !== null) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    this.stopPromise = (async () => {
      let primaryError = null;
      try {
        await Promise.resolve(this.dailyDigestScheduler?.stop?.());
      } catch (error) {
        primaryError = error;
      }
      try {
        await Promise.resolve(this.cloudDispatcher?.stop?.());
      } catch (error) {
        primaryError ??= error;
      }
      try {
        await Promise.resolve(this.inFlight);
      } catch (error) {
        primaryError = error;
      }
      try {
        await Promise.resolve(this.previewInFlight);
      } catch (error) {
        primaryError ??= error;
      }
      try {
        await Promise.resolve(this.diarizationRuntime?.dispose?.());
      } catch (error) {
        primaryError ??= error;
      }
      try {
        await Promise.resolve(this.cloudInFlight);
      } catch (error) {
        primaryError ??= error;
      }
      try {
        await Promise.resolve(this.analysisRecoveryInFlight);
      } catch (error) {
        primaryError ??= error;
      }
      try {
        await this.whisperController?.stop?.();
      } catch (error) {
        if (primaryError && typeof primaryError === "object") {
          primaryError.whisperReleaseError = error;
        } else {
          primaryError ??= error;
        }
      }
      if (primaryError) throw primaryError;
    })();
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
  ownedPidsProvider = null,
  foregroundActivityProvider,
  onResourceSnapshot = () => {},
  resourceSettings,
  previewEnabled = true,
  previewExecutor = null,
  previewPersist = null,
  previewScheduler = null,
  whisperController = null,
  prepareTranscriptionJobs = undefined,
  sessionDiarizationWorker = null,
  diarizationPolicy = null,
  hybridDiarizationManager = null,
  historicalBackfillService = null,
  speakerIdentityResolutionWorker = null,
  speakerEmbeddingHelper = defaultSpeakerEmbeddingHelper,
  primarySpeakerEmbeddingHelper = null,
  reviewSpeakerEmbeddingHelper = null,
  dualSpeakerVerifier = null,
  speakerIdentityReleaseEvidence = null,
  cloudCompositionFactory = null,
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
  if (sessionDiarizationWorker !== null && typeof sessionDiarizationWorker?.run !== "function") {
    throw new TypeError("sessionDiarizationWorker.run must be a function");
  }
  if (
    hybridDiarizationManager !== null &&
    (typeof hybridDiarizationManager.diarizeStrict !== "function" ||
      typeof hybridDiarizationManager.getModelArtifactSha256 !== "function" ||
      typeof hybridDiarizationManager.isAvailable !== "function" ||
      typeof hybridDiarizationManager.dispose !== "function")
  ) {
    throw new TypeError("hybridDiarizationManager must implement the hybrid runtime interface");
  }
  if (
    speakerIdentityResolutionWorker !== null &&
    typeof speakerIdentityResolutionWorker?.run !== "function"
  ) {
    throw new TypeError("speakerIdentityResolutionWorker.run must be a function");
  }
  if (cloudCompositionFactory !== null && typeof cloudCompositionFactory !== "function") {
    throw new TypeError("cloudCompositionFactory must be a function or null");
  }
  if (ownedPidsProvider !== null && typeof ownedPidsProvider !== "function") {
    throw new TypeError("ownedPidsProvider must be a function or null");
  }
  const configuredModel = model.trim();
  if (typeof service.configureTranscriptionModelVersion !== "function") {
    throw new TypeError("service.configureTranscriptionModelVersion must be a function");
  }
  service.configureTranscriptionModelVersion(configuredModel);
  if (service.transcriptionModelVersion !== configuredModel) {
    throw new Error("Jarvis service transcription model does not match processing runtime");
  }
  const speakerProcessingPolicy = new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: configuredModel,
  });
  const whisperManager = ipcHandlers.whisperManager || null;
  const cudaManager = ipcHandlers.whisperCudaManager || null;
  const legacyDiarizationManager = ipcHandlers.diarizationManager || null;
  let discoveredHybridManager = hybridDiarizationManager;
  if (discoveredHybridManager === null && typeof process.env.JARVIS_DATA_ROOT === "string") {
    try {
      const candidate = new HybridDiarizationManager({
        verifierDiarizer: legacyDiarizationManager,
        log,
      });
      if (candidate.isAvailable()) discoveredHybridManager = candidate;
    } catch (error) {
      log({ phase: "hybrid_diarization_discovery", error });
    }
  }
  const selectedDiarizationPolicy =
    diarizationPolicy ??
    (discoveredHybridManager?.isAvailable?.() === true
      ? HYBRID_DIARIZATION_POLICY
      : SESSION_DIARIZATION_POLICY);
  const diarizationManager =
    selectedDiarizationPolicy.inputVersion === 2
      ? discoveredHybridManager
      : legacyDiarizationManager;
  const canBuildDiarizationWorker = Boolean(
    diarizationManager &&
    typeof diarizationManager.diarizeStrict === "function" &&
    typeof diarizationManager.getModelArtifactSha256 === "function" &&
    speakerEmbeddingHelper &&
    typeof speakerEmbeddingHelper.extractEmbedding === "function" &&
    typeof speakerEmbeddingHelper.getModelArtifactSha256 === "function"
  );
  let combinedDiarizationArtifactHashPromise = null;
  const combinedDiarizationArtifactHash = () => {
    if (combinedDiarizationArtifactHashPromise) return combinedDiarizationArtifactHashPromise;
    combinedDiarizationArtifactHashPromise = Promise.all([
      diarizationManager.getModelArtifactSha256(),
      speakerEmbeddingHelper.getModelArtifactSha256(),
    ])
      .then(([managerHash, speakerHash]) => {
        if (!/^[0-9a-f]{64}$/.test(managerHash) || !/^[0-9a-f]{64}$/.test(speakerHash)) {
          const error = new Error("DIARIZATION_MODEL_ARTIFACT_INVALID");
          error.code = "DIARIZATION_MODEL_ARTIFACT_INVALID";
          throw error;
        }
        return createHash("sha256")
          .update(`diarization-manager\0${managerHash}\0`)
          .update(`speaker-embedding-helper\0${speakerHash}\0`)
          .digest("hex");
      })
      .catch((error) => {
        combinedDiarizationArtifactHashPromise = null;
        throw error;
      });
    return combinedDiarizationArtifactHashPromise;
  };
  const effectiveDiarizationWorker =
    sessionDiarizationWorker ??
    (canBuildDiarizationWorker
      ? new SessionDiarizationWorker({
          repository,
          audioEvidenceReader: service.audioEvidenceReader,
          diarizeAudio: ({
            wavPath,
            executionContext,
            track,
            releaseHighMemoryResources,
          }) =>
            diarizationManager.diarizeStrict(wavPath, {
              executionContext,
              enableOverlapSeparation: shouldEnableOverlapSeparation(track),
              releaseHighMemoryResources,
            }),
          embedWindow: ({ wavPath, turn }) =>
            speakerEmbeddingHelper.extractEmbedding(
              wavPath,
              turn.embeddingStartMs / 1_000,
              turn.embeddingEndMs / 1_000
            ),
          modelArtifactSha256: combinedDiarizationArtifactHash,
          policy: selectedDiarizationPolicy,
          speakerProcessingPolicy,
          releaseResources:
            selectedDiarizationPolicy.inputVersion === 2
              ? () => discoveredHybridManager?.dispose?.()
              : null,
          clock: now,
        })
      : null);
  const canBuildIdentityResolutionWorker = [
    "getSpeakerIdentityResolutionSnapshot",
    "listRejectedSpeakerPersonIds",
    "applySystemSpeakerResolutions",
  ].every((method) => typeof repository[method] === "function");
  const diarizationCapability = () => {
    if (sessionDiarizationWorker !== null) {
      return { executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu" };
    }
    if (!canBuildDiarizationWorker) {
      return {
        executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu",
        available: false,
        unavailableReason: "diarization_runtime_unavailable",
      };
    }
    let available = false;
    try {
      available =
        diarizationManager.isAvailable?.() === true &&
        speakerEmbeddingHelper.isAvailable?.() === true;
    } catch {
      available = false;
    }
    return {
      executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu",
      available,
      ...(available ? {} : { unavailableReason: "diarization_model_unavailable" }),
    };
  };
  const effectiveGovernor =
    governor ??
    new ResourceGovernor({
      now,
      ...(telemetryProvider ? { telemetryProvider } : {}),
      ...(cpuProvider ? { cpuProvider } : {}),
      ...(powerProvider ? { powerProvider } : {}),
      ...(foregroundActivityProvider ? { foregroundActivityProvider } : {}),
      ...(resourceSettings ? { resourceSettings } : {}),
      previewEnabled,
      ownedPidsProvider:
        ownedPidsProvider ??
        (() =>
          [
            process.pid,
            whisperManager?.serverManager?.process?.pid,
            ...(discoveredHybridManager?.ownedPids?.() ?? []),
          ].filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
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
  const effectivePrimarySpeakerEmbeddingHelper =
    primarySpeakerEmbeddingHelper ??
    new SpeakerEmbeddings({ modelKey: SPEAKER_MODEL_KEYS.PRIMARY });
  const effectiveReviewSpeakerEmbeddingHelper =
    reviewSpeakerEmbeddingHelper ?? new SpeakerEmbeddings({ modelKey: SPEAKER_MODEL_KEYS.REVIEW });
  const effectiveDualSpeakerVerifier =
    dualSpeakerVerifier ??
    new DualSpeakerVerifier({
      primaryEmbeddings: effectivePrimarySpeakerEmbeddingHelper,
      reviewEmbeddings: effectiveReviewSpeakerEmbeddingHelper,
      resourceGovernor: effectiveGovernor,
      releaseEvidence: speakerIdentityReleaseEvidence,
    });
  const canBuildDualIdentityResolutionWorker =
    canBuildIdentityResolutionWorker &&
    typeof repository.listSpeakerIdentityAudioWindows === "function" &&
    typeof repository.replaceSpeakerClusterModelEmbeddings === "function" &&
    typeof effectivePrimarySpeakerEmbeddingHelper.extractEmbedding === "function" &&
    typeof effectiveReviewSpeakerEmbeddingHelper.extractEmbedding === "function";
  const effectiveIdentityResolutionWorker =
    speakerIdentityResolutionWorker ??
    (canBuildIdentityResolutionWorker
      ? new SpeakerIdentityResolutionWorker({
          repository,
          clock: now,
          diarizationPolicy: selectedDiarizationPolicy,
          ...(canBuildDualIdentityResolutionWorker
            ? {
                dualEvidenceProvider: new DualSpeakerEvidenceProvider({
                  repository,
                  audioEvidenceReader: service.audioEvidenceReader,
                  primaryEmbeddings: effectivePrimarySpeakerEmbeddingHelper,
                  reviewEmbeddings: effectiveReviewSpeakerEmbeddingHelper,
                }),
                dualResolver: new DualSpeakerIdentityResolver({
                  releaseEvidence: speakerIdentityReleaseEvidence,
                }),
              }
            : {}),
        })
      : null);
  if (previewExecutor !== null && typeof previewExecutor !== "function") {
    throw new TypeError("previewExecutor must be a function or null");
  }
  if (previewPersist !== null && typeof previewPersist !== "function") {
    throw new TypeError("previewPersist must be a function or null");
  }
  const transcribeWav = ipcHandlers.createJarvisTranscribeWavAdapter({ model: configuredModel });
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner,
    now,
    governor: effectiveGovernor,
    heavyGate: effectiveGate,
    log,
    classifyCapability: (job) =>
      job.job_type === "diarize_track"
        ? diarizationCapability()
        : job.job_type === "resolve_identities"
          ? { executionDevice: "cpu" }
          : undefined,
  });
  const effectivePreviewScheduler =
    previewScheduler ??
    new PreviewTranscriptionScheduler({
      executePreview:
        previewExecutor ??
        createCommittedAudioPreviewExecutor({
          repository,
          previewAudioRing: service.previewAudioRing,
          transcribeWav,
        }),
      persistProvisional:
        previewPersist ??
        (({ sessionId, segments }) => repository.upsertTranscriptSegments(sessionId, segments)),
      heavyGate: effectiveGate,
      beforePreviewStart: (permit) =>
        runner.drainHigherPriorityWithinPermit(permit, {
          priorityBefore: JOB_PRIORITY.preview,
        }),
      now,
    });
  const effectiveWhisperController =
    whisperController ??
    (whisperManager
      ? {
          isIdle: () => whisperManager._transcribing !== true,
          stop: () => whisperManager.stopServer(),
        }
      : null);
  const cloudComposition =
    cloudCompositionFactory?.({
      repository,
      governor: effectiveGovernor,
      previewScheduler: effectivePreviewScheduler,
      owner,
      now,
    }) ?? null;
  const worker = new JarvisTranscriptionWorker({
    repository,
    audioEvidenceReader: service.audioEvidenceReader,
    transcribeWav,
    inputVersion: speakerProcessingPolicy.transcriptionInputVersion,
    modelVersion: configuredModel,
    now,
  });
  runner.register("transcribe_chunk", (job, context) => worker.handle(job, context));
  runner.register("diarize_track", (job, context) => {
    if (effectiveDiarizationWorker) return effectiveDiarizationWorker.run(job, context);
    const error = new Error("DIARIZATION_RUNTIME_UNAVAILABLE");
    error.code = "DIARIZATION_RUNTIME_UNAVAILABLE";
    throw error;
  });
  runner.register("resolve_identities", (job, context) => {
    if (effectiveIdentityResolutionWorker)
      return effectiveIdentityResolutionWorker.run(job, context);
    const error = new Error("IDENTITY_RESOLUTION_RUNTIME_UNAVAILABLE");
    error.code = "IDENTITY_RESOLUTION_RUNTIME_UNAVAILABLE";
    throw error;
  });
  runner.register("compress_chunk", async (job) => {
    await service.flacCompressionWorker.run(job, { owner });
    return { executionDevice: "cpu" };
  });
  const startupBarrier =
    runtimeOptions.startupBarrier ?? service.waitForCompressionRecovery?.() ?? null;
  const effectivePrepareTranscriptionJobs =
    prepareTranscriptionJobs ??
    (() =>
      repository.enqueueCurrentModelTranscriptionJobs({
        inputVersion: speakerProcessingPolicy.transcriptionInputVersion,
        modelVersion: speakerProcessingPolicy.transcriptionModelVersion,
        at: now(),
      }));
  const effectiveHistoricalBackfillService =
    historicalBackfillService ??
    (selectedDiarizationPolicy.inputVersion === 2 &&
    typeof repository.listHistoricalHybridCandidates === "function" &&
    typeof repository.enqueueHistoricalHybridReprocessing === "function"
      ? new HistoricalDiarizationBackfillService({
          repository,
          speakerProcessingPolicy,
          policy: selectedDiarizationPolicy,
          now,
          log,
        })
      : null);
  return new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: new TranscriptReconciler({ repository }),
    deduper: new DualTrackTranscriptDeduper({ repository }),
    now,
    log,
    governor: effectiveGovernor,
    onResourceSnapshot,
    whisperController: effectiveWhisperController,
    previewScheduler: effectivePreviewScheduler,
    speakerProcessingPolicy,
    diarizationPolicy: selectedDiarizationPolicy,
    diarizationRuntime:
      selectedDiarizationPolicy.inputVersion === 2 ? discoveredHybridManager : null,
    historicalBackfillService: effectiveHistoricalBackfillService,
    dualSpeakerVerifier: effectiveDualSpeakerVerifier,
    prepareTranscriptionJobs: effectivePrepareTranscriptionJobs,
    ...runtimeOptions,
    ...(cloudComposition ?? {}),
    startupBarrier,
  });
}

module.exports = {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
  createCommittedAudioPreviewExecutor,
  shouldEnableOverlapSeparation,
};
