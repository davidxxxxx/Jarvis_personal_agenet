function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

class JarvisProcessingLifecycle {
  constructor({ buildRuntime, log = () => {} } = {}) {
    this.buildRuntime = requiredFunction(buildRuntime, "buildRuntime");
    this.log = requiredFunction(log, "log");
    this.runtime = null;
  }

  start() {
    if (this.runtime) return this.runtime;
    const runtime = this.buildRuntime();
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("buildRuntime must return a startable and stoppable runtime");
    }
    this.runtime = runtime;
    try {
      void Promise.resolve(runtime.start()).catch((error) => {
        this.log({ phase: "startup", error });
      });
    } catch (error) {
      this.log({ phase: "startup", error });
    }
    return runtime;
  }

  async stop() {
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.stop();
  }
}

function createJarvisRuntimeMigrationParticipant({
  processingLifecycle,
  prepareStorageMigration,
  stopRetention,
  quiesceAnalysis,
  checkpointAndCloseRepository,
  reconfigureStorageHolders,
  resumeAnalysis,
  startRetention,
} = {}) {
  if (
    !processingLifecycle ||
    typeof processingLifecycle.start !== "function" ||
    typeof processingLifecycle.stop !== "function"
  ) {
    throw new TypeError("processingLifecycle must provide start and stop");
  }
  const prepare = requiredFunction(prepareStorageMigration, "prepareStorageMigration");
  const stopCleaner = requiredFunction(stopRetention, "stopRetention");
  const stopAnalysis = requiredFunction(quiesceAnalysis, "quiesceAnalysis");
  const closeRepository = requiredFunction(
    checkpointAndCloseRepository,
    "checkpointAndCloseRepository"
  );
  const reconfigure = requiredFunction(reconfigureStorageHolders, "reconfigureStorageHolders");
  const restartAnalysis = requiredFunction(resumeAnalysis, "resumeAnalysis");
  const restartCleaner = requiredFunction(startRetention, "startRetention");

  return {
    name: "jarvis-runtime",
    async quiesce() {
      await processingLifecycle.stop();
      await prepare();
      await stopCleaner();
      await stopAnalysis();
    },
    async close() {
      await closeRepository();
    },
    reopen: reconfigure,
    rollback: reconfigure,
    resume() {
      restartAnalysis();
      restartCleaner();
      return processingLifecycle.start();
    },
  };
}

module.exports = {
  JarvisProcessingLifecycle,
  createJarvisRuntimeMigrationParticipant,
};
