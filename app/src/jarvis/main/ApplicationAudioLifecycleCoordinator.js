class ApplicationAudioLifecycleCoordinator {
  constructor({
    getPool,
    getSettings,
    getFullscreen,
    requestRenderer,
  } = {}) {
    for (const [name, value] of Object.entries({
      getPool,
      getSettings,
      getFullscreen,
      requestRenderer,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    }
    this.getPool = getPool;
    this.getSettings = getSettings;
    this.getFullscreen = getFullscreen;
    this.requestRenderer = requestRenderer;
    this.powerSnapshot = null;
    this.rotationSnapshots = new Map();
  }

  snapshot() {
    const status = this.getPool()?.getStatus?.() ?? {};
    return {
      wasRunning: status.running === true,
      configuredLimit: Number.isSafeInteger(status.configuredLimit) ? status.configuredLimit : 4,
      fullscreen: status.fullscreen === true,
    };
  }

  async startSession(sessionId, snapshot) {
    const pool = this.getPool();
    if (!pool || snapshot?.wasRunning !== true) return null;
    const settings = this.getSettings() ?? {};
    if (settings.enabled === false) return null;
    return pool.start({
      sessionId,
      configuredLimit: Number.isSafeInteger(settings.trackLimit)
        ? settings.trackLimit
        : snapshot.configuredLimit,
      fullscreen: this.getFullscreen() === true || snapshot.fullscreen,
    });
  }

  suspend(captureState) {
    const observed = this.snapshot();
    this.powerSnapshot = {
      wasRunning: this.powerSnapshot?.wasRunning === true || observed.wasRunning,
      configuredLimit: this.powerSnapshot?.configuredLimit ?? observed.configuredLimit,
      fullscreen: this.powerSnapshot?.fullscreen === true || observed.fullscreen,
    };
    // ApplicationAudioCapturePool.stop() closes its evidence synchronously
    // before returning the native-helper cleanup promise.
    const applicationStop = this.getPool()?.stop() ?? Promise.resolve();
    const rendererStop = this.requestRenderer("suspend", captureState);
    return Promise.all([applicationStop, rendererStop]).then(([, result]) => result);
  }

  async resume(resumeToken) {
    const result = await this.requestRenderer("resume", resumeToken);
    await this.startSession(resumeToken.sessionId, this.powerSnapshot);
    this.powerSnapshot = null;
    return result;
  }

  async rotate(rotation) {
    const rendererRotation = {
      ...rotation,
      sessionId: rotation.sessionId,
      sources: {},
    };
    if (rotation.phase === "prepare") {
      const snapshot = this.snapshot();
      this.rotationSnapshots.set(rotation.sessionId, snapshot);
      const applicationStop = this.getPool()?.stop() ?? Promise.resolve();
      try {
        await Promise.all([
          applicationStop,
          this.requestRenderer("rotate", rendererRotation),
        ]);
      } catch (error) {
        try {
          await this.startSession(rotation.previousSessionId, snapshot);
        } catch (restartError) {
          if (error && typeof error === "object") {
            error.applicationAudioRestartError = restartError;
          }
        }
        this.rotationSnapshots.delete(rotation.sessionId);
        throw error;
      }
      return;
    }

    const snapshot = this.rotationSnapshots.get(rotation.sessionId);
    if (rotation.phase === "activate") {
      await this.requestRenderer("rotate", rendererRotation);
      await this.startSession(rotation.sessionId, snapshot);
      return;
    }
    if (rotation.phase === "abort") {
      let rendererError = null;
      try {
        await this.requestRenderer("rotate", rendererRotation);
      } catch (error) {
        rendererError = error;
      }
      try {
        await this.startSession(rotation.previousSessionId, snapshot);
      } catch (restartError) {
        if (rendererError && typeof rendererError === "object") {
          rendererError.applicationAudioRestartError = restartError;
        } else {
          throw restartError;
        }
      } finally {
        this.rotationSnapshots.delete(rotation.sessionId);
      }
      if (rendererError) throw rendererError;
      return;
    }

    await this.requestRenderer("rotate", rendererRotation);
    if (rotation.phase === "commit") {
      this.rotationSnapshots.delete(rotation.sessionId);
    }
  }
}

module.exports = ApplicationAudioLifecycleCoordinator;
