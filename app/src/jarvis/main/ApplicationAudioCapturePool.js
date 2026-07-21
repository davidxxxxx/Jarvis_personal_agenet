const WindowsAudioSessionWatcher = require("../../helpers/windowsAudioSessionWatcher");
const WindowsLoopbackAudioManager = require("../../helpers/windowsLoopbackAudioManager");
const ApplicationAudioPolicy = require("./ApplicationAudioPolicy");
const { createApplicationAudioStatus } = require("./ApplicationAudioStatus");

const DEFAULT_SILENCE_RELEASE_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_PREBUFFER_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;
const PCM_ACTIVITY_THRESHOLD = 256;
const MAX_CANDIDATE_COUNT = 256;

function safeReason(error, fallback = "application_capture_unavailable") {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return /^[a-z0-9_-]{1,64}$/i.test(candidate) ? candidate : fallback;
}

function safeFailureCode(error, fallback = "application_capture_unavailable") {
  const candidate =
    typeof error?.failureCode === "string" ? error.failureCode : safeReason(error, fallback);
  return /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : fallback;
}

function isAudiblePcm(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) return false;
  for (let offset = 0; offset + 1 < pcm.length; offset += 16) {
    if (Math.abs(pcm.readInt16LE(offset)) >= PCM_ACTIVITY_THRESHOLD) return true;
  }
  return false;
}

class ApplicationAudioCapturePool {
  constructor({
    policy = new ApplicationAudioPolicy(),
    watcherFactory = (callbacks) => new WindowsAudioSessionWatcher(callbacks),
    managerFactory = () => new WindowsLoopbackAudioManager(),
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    silenceReleaseMs = DEFAULT_SILENCE_RELEASE_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    prebufferMs = DEFAULT_PREBUFFER_MS,
    onTrackStarted = () => {},
    onTrackEnded = () => {},
    onAttributionChange = () => {},
    onChunk = () => {},
    onWarning = () => {},
    onError = () => {},
  } = {}) {
    this.policy = policy;
    this.watcherFactory = watcherFactory;
    this.managerFactory = managerFactory;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.silenceReleaseMs = Math.max(1_000, silenceReleaseMs ?? DEFAULT_SILENCE_RELEASE_MS);
    this.retryDelayMs = Math.max(250, retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.prebufferMs = Math.max(0, Math.min(10_000, prebufferMs ?? DEFAULT_PREBUFFER_MS));
    this.onTrackStarted = onTrackStarted;
    this.onTrackEnded = onTrackEnded;
    this.onAttributionChange = onAttributionChange;
    this.onChunk = onChunk;
    this.onWarning = onWarning;
    this.onError = onError;
    this.candidates = new Map();
    this.activeTracks = new Map();
    this.fallbacks = new Map();
    this.nextCaptureGeneration = 0;
    this.watcher = null;
    this.timer = null;
    this.running = false;
    this.sessionId = null;
    this.configuredLimit = ApplicationAudioPolicy.DEFAULT_LIMIT;
    this.fullscreen = false;
    this.work = Promise.resolve();
    this.stopWork = null;
  }

  async start({
    sessionId = null,
    configuredLimit = ApplicationAudioPolicy.DEFAULT_LIMIT,
    fullscreen = false,
  } = {}) {
    if (this.stopWork) await this.stopWork;
    if (this.running) {
      if (sessionId !== null && sessionId !== this.sessionId) {
        throw new Error("application audio pool is bound to another session");
      }
      return this.getStatus();
    }
    if (
      sessionId !== null &&
      (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128)
    ) {
      throw new TypeError("sessionId must be a bounded string");
    }
    this.sessionId = sessionId;
    this.configuredLimit = this._boundedConfiguredLimit(configuredLimit);
    this.fullscreen = fullscreen === true;
    this.running = true;
    this.watcher = this.watcherFactory({
      onSession: (event) => this.handleSession(event),
      onWarning: (warning) => this.onWarning(warning),
      onError: (error) => this._enqueue(() => this._handleWatcherError(error)),
    });
    try {
      await this.watcher.start();
      this.timer = this.setIntervalImpl(() => {
        void this.sweep();
      }, SWEEP_INTERVAL_MS);
      this.timer?.unref?.();
      return this.getStatus();
    } catch (error) {
      this.running = false;
      this.watcher = null;
      throw error;
    }
  }

  async stop() {
    if (this.stopWork) return this.stopWork;
    if (!this.running && !this.watcher) return;
    this.running = false;
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }

    // Evidence must be closed in the same main-process turn as a suspend or
    // local-date prepare. Native helpers can take a moment to acknowledge
    // stdin closure, but late PCM is already rejected once the track leaves
    // activeTracks, so it is safe to finish process cleanup asynchronously.
    const sessionId = this.sessionId;
    const stoppedAt = this.now();
    const tracks = [...this.activeTracks.values()];
    this.activeTracks.clear();
    for (const track of tracks) {
      this._notifyTrackStopped(track, "pool_stopped", stoppedAt, sessionId);
    }

    const watcher = this.watcher;
    this.watcher = null;
    this.candidates.clear();
    this.fallbacks.clear();
    this.sessionId = null;
    const pendingWork = this.work;
    const cleanup = (async () => {
      await pendingWork;
      const cleanupWork = [];
      if (watcher) cleanupWork.push(watcher.stop());
      for (const track of tracks) cleanupWork.push(track.manager.stop());
      const settled = await Promise.allSettled(cleanupWork);
      for (const result of settled) {
        if (result.status === "rejected") {
          this.onWarning({
            code: safeReason(result.reason, "application_capture_stop_failed"),
          });
        }
      }
    })();
    const stopWork = cleanup.finally(() => {
      if (this.stopWork === stopWork) this.stopWork = null;
    });
    this.stopWork = stopWork;
    return this.stopWork;
  }

  handleSession(event) {
    return this._enqueue(async () => {
      if (!this.running || !this._isSafeSessionEvent(event)) return;
      const at = this.now();
      let candidate = this.candidates.get(event.applicationKey);
      if (!candidate) {
        if (this.candidates.size >= MAX_CANDIDATE_COUNT) {
          this.onWarning({ code: "application_candidate_limit_reached" });
          return;
        }
        candidate = {
          applicationKey: event.applicationKey,
          applicationDisplayName: event.applicationDisplayName,
          pids: new Map(),
          blockedUntil: 0,
        };
        this.candidates.set(event.applicationKey, candidate);
      }
      candidate.applicationDisplayName = event.applicationDisplayName;
      if (event.state === "active") {
        candidate.pids.set(event.pid, {
          pid: event.pid,
          peak: event.peak,
          isForeground: event.isForeground === true,
          lastSeenAt: at,
        });
      } else {
        candidate.pids.delete(event.pid);
        if (candidate.pids.size === 0) {
          this.candidates.delete(event.applicationKey);
          this.fallbacks.delete(event.applicationKey);
        }
      }
      await this._reconcile(at);
    });
  }

  setFullscreen(fullscreen) {
    return this._enqueue(async () => {
      this.fullscreen = fullscreen === true;
      await this._reconcile(this.now());
      return this.getStatus();
    });
  }

  setConfiguredLimit(configuredLimit) {
    return this._enqueue(async () => {
      this.configuredLimit = this._boundedConfiguredLimit(configuredLimit);
      await this._reconcile(this.now());
      return this.getStatus();
    });
  }

  sweep() {
    return this._enqueue(async () => {
      if (!this.running) return;
      const at = this.now();
      for (const [applicationKey, track] of [...this.activeTracks]) {
        if (at - track.lastSoundAt < this.silenceReleaseMs) continue;
        const candidate = this.candidates.get(applicationKey);
        if (candidate) candidate.blockedUntil = at + this.retryDelayMs;
        this._setFallback(track, "confirmed_silence", at + this.retryDelayMs);
        await this._stopTrack(applicationKey, "confirmed_silence", at);
      }
      await this._reconcile(at);
    });
  }

  waitForIdle() {
    return this.work;
  }

  getStatus() {
    return createApplicationAudioStatus({
      running: this.running,
      configuredLimit: this.configuredLimit,
      effectiveLimit: this.policy.resolveLimit({
        configuredLimit: this.configuredLimit,
        fullscreen: this.fullscreen,
      }),
      fullscreen: this.fullscreen,
      activeTracks: this.activeTracks,
      fallbacks: this.fallbacks,
    });
  }

  _enqueue(task) {
    const operation = this.work.then(task, task);
    this.work = operation.catch((error) => {
      this.onError(error);
    });
    return operation;
  }

  _candidateList(at) {
    const result = [];
    for (const candidate of this.candidates.values()) {
      if (candidate.blockedUntil > at || candidate.pids.size === 0) continue;
      const process = [...candidate.pids.values()].sort((left, right) => {
        if (right.isForeground !== left.isForeground) return right.isForeground ? 1 : -1;
        if (right.peak !== left.peak) return right.peak - left.peak;
        return right.lastSeenAt - left.lastSeenAt;
      })[0];
      result.push({
        state: "active",
        applicationKey: candidate.applicationKey,
        applicationDisplayName: candidate.applicationDisplayName,
        pid: process.pid,
        peak: process.peak,
        isForeground: process.isForeground,
        lastSeenAt: process.lastSeenAt,
      });
    }
    return result;
  }

  async _reconcile(at) {
    if (!this.running) return;
    const selected = this.policy.select(this._candidateList(at), {
      configuredLimit: this.configuredLimit,
      fullscreen: this.fullscreen,
    });
    const desired = new Map(selected.map((candidate) => [candidate.applicationKey, candidate]));

    for (const [applicationKey, track] of [...this.activeTracks]) {
      const candidate = desired.get(applicationKey);
      if (!candidate || candidate.pid !== track.pid) {
        const reason = candidate
          ? "application_process_changed"
          : this.candidates.has(applicationKey)
            ? "application_not_selected"
            : "application_inactive";
        await this._stopTrack(
          applicationKey,
          reason,
          at
        );
      }
    }
    for (const candidate of selected) {
      if (!this.activeTracks.has(candidate.applicationKey)) {
        await this._startTrack(candidate, at);
      }
    }
  }

  async _startTrack(candidate, at) {
    this.nextCaptureGeneration += 1;
    if (!Number.isSafeInteger(this.nextCaptureGeneration)) {
      this.nextCaptureGeneration = 1;
    }
    const captureGeneration = this.nextCaptureGeneration;
    const manager = this.managerFactory({
      applicationKey: candidate.applicationKey,
      applicationDisplayName: candidate.applicationDisplayName,
      pid: candidate.pid,
      captureGeneration,
    });
    const track = {
      applicationKey: candidate.applicationKey,
      applicationDisplayName: candidate.applicationDisplayName,
      pid: candidate.pid,
      captureGeneration,
      manager,
      startedAt: at,
      lastSoundAt: at,
    };
    this.activeTracks.set(candidate.applicationKey, track);
    try {
      await manager.start({
        mode: "application",
        targetPid: candidate.pid,
        onChunk: (pcm) => this._handleChunk(track, pcm),
        onWarning: (warning) =>
          this.onWarning({
            applicationKey: track.applicationKey,
            captureGeneration: track.captureGeneration,
            code: safeReason(warning, "application_capture_warning"),
          }),
        onError: (error) => {
          void this._enqueue(() => this._handleCaptureError(track, error));
        },
      });
    } catch (error) {
      if (this.activeTracks.get(candidate.applicationKey) === track) {
        this.activeTracks.delete(candidate.applicationKey);
      }
      try {
        await manager.stop();
      } catch {}
      const retryAt = at + this.retryDelayMs;
      const stored = this.candidates.get(candidate.applicationKey);
      if (stored) stored.blockedUntil = retryAt;
      const reason = safeReason(error, "capture_start_failed");
      const failureCode = safeFailureCode(error, reason);
      this._setFallback(track, reason, retryAt, failureCode);
      try {
        this.onAttributionChange({
          sessionId: this.sessionId,
          applicationKey: track.applicationKey,
          applicationDisplayName: track.applicationDisplayName,
          captureGeneration,
          attributionState: "mixed_unknown",
          at,
          reason,
          failureCode,
        });
      } catch (callbackError) {
        this.onError(callbackError);
      }
      return;
    }

    this.fallbacks.delete(candidate.applicationKey);
    try {
      this.onTrackStarted({
        sessionId: this.sessionId,
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        pid: track.pid,
        captureGeneration,
        startedAt: at,
      });
      if (this.prebufferMs > 0) {
        this.onAttributionChange({
          sessionId: this.sessionId,
          applicationKey: track.applicationKey,
          applicationDisplayName: track.applicationDisplayName,
          captureGeneration,
          attributionState: "mixed_unknown",
          at: Math.max(0, at - this.prebufferMs),
          reason: "dynamic_start_prebuffer",
        });
      }
      this.onAttributionChange({
        sessionId: this.sessionId,
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        captureGeneration,
        attributionState: "exact",
        at,
        reason: "application_capture_started",
      });
    } catch (error) {
      this.activeTracks.delete(candidate.applicationKey);
      try {
        await manager.stop();
      } catch {}
      const retryAt = at + this.retryDelayMs;
      const stored = this.candidates.get(candidate.applicationKey);
      if (stored) stored.blockedUntil = retryAt;
      const failureCode = safeFailureCode(error, "evidence_registration_failed");
      this._setFallback(track, "evidence_registration_failed", retryAt, failureCode);
      try {
        this.onTrackEnded({
          sessionId: this.sessionId,
          applicationKey: track.applicationKey,
          applicationDisplayName: track.applicationDisplayName,
          pid: track.pid,
          captureGeneration: track.captureGeneration,
          endedAt: at,
          reason: "evidence_registration_failed",
          failureCode,
        });
      } catch {}
      this.onError(error);
    }
  }

  async _stopTrack(applicationKey, reason, at, failureCode = null) {
    const track = this.activeTracks.get(applicationKey);
    if (!track) return;
    this.activeTracks.delete(applicationKey);
    try {
      await track.manager.stop();
    } catch (error) {
      this.onWarning({
        applicationKey,
        captureGeneration: track.captureGeneration,
        code: safeReason(error, "capture_stop_failed"),
      });
    }
    this._notifyTrackStopped(track, reason, at, this.sessionId, failureCode);
  }

  _notifyTrackStopped(track, reason, at, sessionId, failureCode = null) {
    try {
      this.onAttributionChange({
        sessionId,
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        captureGeneration: track.captureGeneration,
        attributionState: "mixed_unknown",
        at,
        reason,
        failureCode,
      });
      this.onTrackEnded({
        sessionId,
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        pid: track.pid,
        captureGeneration: track.captureGeneration,
        endedAt: at,
        reason,
        failureCode,
      });
    } catch (error) {
      this.onError(error);
    }
  }

  _handleChunk(track, pcm) {
    if (this.activeTracks.get(track.applicationKey) !== track || !Buffer.isBuffer(pcm)) return;
    const at = this.now();
    if (isAudiblePcm(pcm)) track.lastSoundAt = at;
    try {
      this.onChunk({
        sessionId: this.sessionId,
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        captureGeneration: track.captureGeneration,
        pcm,
        at,
      });
    } catch (error) {
      error.code = "evidence_delivery_failed";
      void this._enqueue(() => this._handleCaptureError(track, error));
    }
  }

  async _handleCaptureError(track, error) {
    if (this.activeTracks.get(track.applicationKey) !== track) return;
    const at = this.now();
    const reason = safeReason(error);
    const failureCode = safeFailureCode(error, reason);
    const retryAt = at + this.retryDelayMs;
    const candidate = this.candidates.get(track.applicationKey);
    if (candidate) candidate.blockedUntil = retryAt;
    this._setFallback(track, reason, retryAt, failureCode);
    await this._stopTrack(track.applicationKey, reason, at, failureCode);
    await this._reconcile(at);
  }

  async _handleWatcherError(error) {
    const at = this.now();
    const reason = safeReason(error, "session_watch_unavailable");
    const failureCode = safeFailureCode(error, reason);
    for (const track of this.activeTracks.values()) {
      this._setFallback(track, reason, at + this.retryDelayMs, failureCode);
    }
    for (const applicationKey of [...this.activeTracks.keys()]) {
      await this._stopTrack(applicationKey, reason, at, failureCode);
    }
    this.onError(error);
  }

  _setFallback(track, reason, retryAt, failureCode = null) {
    this.fallbacks.set(track.applicationKey, {
      applicationKey: track.applicationKey,
      applicationDisplayName: track.applicationDisplayName,
      reason,
      failureCode,
      retryAt,
    });
  }

  _boundedConfiguredLimit(value) {
    return this.policy.resolveLimit({ configuredLimit: value, fullscreen: false });
  }

  _isSafeSessionEvent(event) {
    return (
      (event?.state === "active" || event?.state === "inactive") &&
      Number.isSafeInteger(event.pid) &&
      event.pid > 0 &&
      typeof event.applicationKey === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(event.applicationKey) &&
      typeof event.applicationDisplayName === "string" &&
      event.applicationDisplayName.length > 0 &&
      event.applicationDisplayName.length <= 128 &&
      typeof event.peak === "number" &&
      Number.isFinite(event.peak) &&
      event.peak >= 0 &&
      event.peak <= 1
    );
  }
}

module.exports = ApplicationAudioCapturePool;
