const fs = require("fs");

const defaultWorkerClient = require("../../helpers/onnxWorkerClient");

const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;

class SpeechVadClassifier {
  constructor({ workerClient = defaultWorkerClient, getModelPath, fsImpl = fs } = {}) {
    if (!workerClient || typeof workerClient.request !== "function") {
      throw new TypeError("workerClient.request must be a function");
    }
    if (typeof getModelPath !== "function") {
      throw new TypeError("getModelPath must be a function");
    }
    if (!fsImpl || typeof fsImpl.existsSync !== "function") {
      throw new TypeError("fsImpl.existsSync must be a function");
    }
    this.workerClient = workerClient;
    this.getModelPath = getModelPath;
    this.fs = fsImpl;
    this.ready = false;
    this.initializePromise = null;
    this.recoveryTimer = null;
    this.recoveryActive = false;
    this.recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS;
    this.onRecovered = null;
    this.lifecycleGeneration = 0;
    this.inFlightClassifications = new Set();
    this.recoveryAttemptActive = false;
  }

  isReady() {
    return this.ready;
  }

  async initialize({ forceReload = false } = {}) {
    if (this.ready && !forceReload) return { ok: true };
    if (this.initializePromise) return this.initializePromise;

    const generation = this.lifecycleGeneration;
    this.initializePromise = (async () => {
      const modelPath = this.getModelPath();
      if (typeof modelPath !== "string" || modelPath.length === 0) {
        throw new Error("Silero VAD model path is unavailable");
      }
      if (!this.fs.existsSync(modelPath)) {
        throw new Error("Silero VAD model is not installed");
      }
      let health;
      if (forceReload) {
        health = await this.workerClient.request("vad.reload", { modelPath });
        if (generation !== this.lifecycleGeneration) return { ok: false, cancelled: true };
      } else {
        await this.workerClient.request("vad.load", { modelPath });
        if (generation !== this.lifecycleGeneration) return { ok: false, cancelled: true };
        health = await this.workerClient.request("vad.health", {});
      }
      const probability = Number(health?.probability);
      if (
        health?.ok !== true ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      ) {
        throw new Error("Silero VAD health inference returned an invalid result");
      }
      if (generation !== this.lifecycleGeneration) return { ok: false, cancelled: true };
      this.ready = true;
      return { ok: true };
    })();

    try {
      return await this.initializePromise;
    } catch (error) {
      if (generation === this.lifecycleGeneration) this.ready = false;
      throw error;
    } finally {
      this.initializePromise = null;
    }
  }

  async classify({ sessionId, sourceType, streamId, sampleRate, pcm }) {
    const result = await this._classify(
      { sessionId, sourceType, streamId, sampleRate, pcm },
      false
    );
    return result.probability;
  }

  async classifyDetailed({ sessionId, sourceType, streamId, sampleRate, pcm }) {
    return this._classify({ sessionId, sourceType, streamId, sampleRate, pcm }, true);
  }

  async _classify({ sessionId, sourceType, streamId, sampleRate, pcm }, detailed) {
    if (!this.ready) throw new Error("Silero VAD is unavailable");
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw new TypeError("streamId is required");
    }
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a positive safe integer");
    }
    if (!Buffer.isBuffer(pcm) && !(pcm instanceof Uint8Array)) {
      throw new TypeError("pcm must be a Buffer or Uint8Array");
    }

    const samplesBuffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    const request = Promise.resolve().then(() =>
      this.workerClient.request("vad.classify", {
        sessionId,
        sourceType,
        streamId,
        sampleRate,
        samplesBuffer,
      })
    );
    this.inFlightClassifications.add(request);
    try {
      const result = await request;
      const probability = Number(result?.probability);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("Silero VAD returned an invalid probability");
      }
      if (!detailed) return { probability };
      if (
        !Number.isSafeInteger(result?.windowCount) ||
        result.windowCount < 0 ||
        !Array.isArray(result?.probabilities) ||
        result.probabilities.length !== result.windowCount ||
        result.probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
      ) {
        throw new Error("Silero VAD returned an invalid detailed result");
      }
      return {
        probability,
        windowCount: result.windowCount,
        probabilities: [...result.probabilities],
      };
    } catch (error) {
      this.reportFailure(error);
      throw error;
    } finally {
      new Uint8Array(samplesBuffer).fill(0);
      this.inFlightClassifications.delete(request);
      if (!this.ready) this._scheduleRecovery(0);
    }
  }

  reportFailure(_error = null) {
    if (this.ready || this.initializePromise) this.lifecycleGeneration += 1;
    this.ready = false;
    this._scheduleRecovery(0);
  }

  async reset(streamId) {
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw new TypeError("streamId is required");
    }
    return this.workerClient.request("vad.reset", { streamId });
  }

  async resetSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    return this.workerClient.request("vad.resetSession", { sessionId });
  }

  startRecovery({ intervalMs = DEFAULT_RECOVERY_INTERVAL_MS, onRecovered } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError("intervalMs must be a positive safe integer");
    }
    if (onRecovered !== undefined && typeof onRecovered !== "function") {
      throw new TypeError("onRecovered must be a function");
    }
    this.recoveryActive = true;
    this.recoveryIntervalMs = intervalMs;
    this.onRecovered = onRecovered || null;
    this._scheduleRecovery(0);
  }

  _scheduleRecovery(delayMs) {
    if (!this.recoveryActive) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      if (this.recoveryAttemptActive) return;
      this.recoveryAttemptActive = true;
      try {
        if (!this.ready && this.inFlightClassifications.size === 0) {
          try {
            const result = await this.initialize({ forceReload: true });
            if (result?.ok === true && this.ready && this.onRecovered) {
              try {
                this.onRecovered();
              } catch {
                // Capture may have stopped while verified health was being reported.
              }
            }
          } catch {
            // The model may still be downloading or the worker may be restarting.
          }
        }
      } finally {
        this.recoveryAttemptActive = false;
        this._scheduleRecovery(this.recoveryIntervalMs);
      }
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  async stop() {
    this.lifecycleGeneration += 1;
    this.recoveryActive = false;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.ready = false;
    this.recoveryAttemptActive = false;
    try {
      await this.workerClient.request("vad.reset", {});
    } catch {
      // Shutdown cleanup is best effort because the utility process may already be gone.
    }
  }
}

module.exports = SpeechVadClassifier;
