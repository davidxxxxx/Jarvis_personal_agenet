const ResourceGovernor = require("../ResourceGovernor");

const { JOB_PRIORITY } = ResourceGovernor;

const { SESSION_DIARIZATION_POLICY } = require("../SessionDiarizationPolicy");

const { resolveFullscreenYieldActive } = require("../FullscreenYieldPolicy");

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const DEFAULT_MAX_JOBS_PER_DRAIN = 25;

const DEFAULT_MAX_DRAIN_MS = 5_000;

const DEFAULT_MAX_SESSIONS_PER_DRAIN = 5;

const DEFAULT_ANALYSIS_RECOVERY_LIMIT = 25;

const DEFAULT_ANALYSIS_RECOVERY_INTERVAL_MS = 30_000;

const DEFAULT_ACOUSTIC_DEDUPE_RETRY_MS = 60_000;

const ACOUSTIC_DEDUPE_RESOURCE_DEFERRED = "ACOUSTIC_DEDUPE_RESOURCE_DEFERRED";

const RESOURCE_DEFER_WAKE_REASONS = new Set(["external_gpu_busy", "gpu_utilization_high"]);

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeTimestampAdd(base, relative, name) {
  const result = base + relative;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} safe integer overflow`);
  return result;
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
    acousticDedupeRetryMs = DEFAULT_ACOUSTIC_DEDUPE_RETRY_MS,
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
    this.acousticDedupeRetryMs = positiveSafeInteger(
      acousticDedupeRetryMs,
      "acousticDedupeRetryMs"
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
    this.resourceDeferredWakePending = true;
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
    this.acousticDedupeRetryAtBySession = new Map();
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
        const acousticRetryAt = this.acousticDedupeRetryAtBySession.get(session.id);
        if (acousticRetryAt !== undefined) {
          if (this.now() < acousticRetryAt) continue;
          this.acousticDedupeRetryAtBySession.delete(session.id);
        }
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
            const started = this.repository.startHistoricalLocalOnlyReprocessing?.(
              session.id,
              this.now()
            );
            if (started?.state !== "processing") {
              throw new Error("historical local-only reprocessing did not enter processing");
            }
            if (typeof this.analysisScheduler?.classifySessionLocally !== "function") {
              throw new Error("local activity classification is unavailable");
            }
            await Promise.resolve(
              this.analysisScheduler.classifySessionLocally(session.id, { force: true })
            );
            if (typeof this.repository.refreshSessionParticipantSnapshot !== "function") {
              throw new Error("participant snapshot refresh is unavailable");
            }
            await Promise.resolve(this.repository.refreshSessionParticipantSnapshot(session.id));
            const completed = this.repository.finalizeHistoricalLocalOnlyReprocessing?.(
              session.id,
              this.now()
            );
            if (completed?.state !== "completed") {
              throw new Error("historical local-only reprocessing did not finalize");
            }
          }
        }
      } catch (error) {
        if (error?.code === ACOUSTIC_DEDUPE_RESOURCE_DEFERRED) {
          const retryAt = safeTimestampAdd(
            this.now(),
            this.acousticDedupeRetryMs,
            "acoustic dedupe retry"
          );
          this.acousticDedupeRetryAtBySession.set(session.id, retryAt);
          this.log({ phase: "post_process", sessionId: session.id, retryAt, error });
        } else {
          this.log({ phase: "post_process", sessionId: session.id, error });
        }
      } finally {
        this.sessionCursor = this._sessionCursorFor(session);
        inspected += 1;
      }
    }
    return inspected;
  }

  async _drain() {
    const startedAt = this.now();
    for (const [sessionId, retryAt] of this.acousticDedupeRetryAtBySession) {
      if (retryAt <= startedAt) this.acousticDedupeRetryAtBySession.delete(sessionId);
    }
    const resourceSnapshot = await this._releaseIdleWhisperUnderPressure();
    if (this.stopping || !this.running) return 0;
    try {
      await Promise.resolve(this.onResourceSnapshot(resourceSnapshot));
    } catch (error) {
      this.log({ phase: "resource_snapshot", error });
    }
    if (this.stopping || !this.running) return 0;
    if (
      resourceSnapshot &&
      this.acousticDedupeRetryAtBySession.size > 0 &&
      typeof this.governor?.admit === "function"
    ) {
      try {
        const decision = this.governor.admit("maintenance", resourceSnapshot);
        if (decision?.action === "run_cpu") {
          this.acousticDedupeRetryAtBySession.clear();
        }
      } catch (error) {
        this.log({ phase: "application_mix_acoustic_recovery", error });
      }
    }
    if (RESOURCE_DEFER_WAKE_REASONS.has(resourceSnapshot?.reason)) {
      this.resourceDeferredWakePending = true;
    }
    if (resourceSnapshot?.state === "available" && this.resourceDeferredWakePending) {
      try {
        this.runner.wakeResourceDeferredJobs?.(this.now());
        this.resourceDeferredWakePending = false;
      } catch (error) {
        this.log({ phase: "resource_deferred_wake", error });
      }
    }
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

module.exports = { JarvisProcessingRuntime };
