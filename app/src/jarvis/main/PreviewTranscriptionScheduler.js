const MAX_CONTEXT_MS = 120_000;
const NORMAL_CADENCE_MS = 15_000;
const CONSTRAINED_CADENCE_MS = 60_000;
const CPU_CADENCE_MS = 75_000;
const CPU_UNSAFE_LOAD_PCT = 90;

const RESOURCE_STATES = new Set(["available", "busy", "constrained", "unavailable"]);
const SAFE_CONSTRAINED_REASONS = new Set(["recovery_hysteresis"]);

function identifier(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function boundary(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function keyFor(sessionId, trackId) {
  return `${sessionId}\u0000${trackId}`;
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "preview failed");
}

function previewPolicy(snapshot) {
  if (!snapshot || !RESOURCE_STATES.has(snapshot.state)) {
    return {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "telemetry_unavailable",
    };
  }
  if (snapshot.previewEnabled === false) {
    return {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "preview_disabled",
    };
  }
  if (snapshot.state === "busy" || snapshot.externalGpuBusy === true) {
    return {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "gpu_busy",
    };
  }
  if (snapshot.batterySaver === true) {
    return {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "battery_saver",
    };
  }
  if (snapshot.state === "available") {
    return {
      mode: "normal",
      cadenceMs: NORMAL_CADENCE_MS,
      device: "cuda",
      selectedGpuUuid: snapshot.selectedGpuUuid ?? null,
      reason: null,
    };
  }
  if (snapshot.state === "constrained") {
    const reason = snapshot.reason || "resources_constrained";
    if (!SAFE_CONSTRAINED_REASONS.has(reason)) {
      return {
        mode: "paused",
        cadenceMs: null,
        device: null,
        selectedGpuUuid: null,
        reason,
      };
    }
    return {
      mode: "degraded",
      cadenceMs: CONSTRAINED_CADENCE_MS,
      device: "cuda",
      selectedGpuUuid: snapshot.selectedGpuUuid ?? null,
      reason: null,
    };
  }
  const cpuKnown =
    snapshot.cpuTelemetryAvailable === true &&
    Number.isFinite(snapshot.cpuLoadPct) &&
    snapshot.cpuLoadPct >= 0 &&
    snapshot.cpuLoadPct < CPU_UNSAFE_LOAD_PCT;
  const powerKnown = snapshot.powerTelemetryAvailable === true;
  if (!cpuKnown || !powerKnown || snapshot.batterySaver !== false) {
    return {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "telemetry_unavailable",
    };
  }
  return {
    mode: "degraded",
    cadenceMs: CPU_CADENCE_MS,
    device: "cpu",
    selectedGpuUuid: null,
    reason: null,
  };
}

class PreviewTranscriptionScheduler {
  constructor({ executePreview, persistProvisional, heavyGate, now = Date.now } = {}) {
    if (typeof executePreview !== "function") {
      throw new TypeError("executePreview must be a function");
    }
    if (typeof persistProvisional !== "function") {
      throw new TypeError("persistProvisional must be a function");
    }
    if (!heavyGate || typeof heavyGate.run !== "function") {
      throw new TypeError("heavyGate.run must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.executePreview = executePreview;
    this.persistProvisional = persistProvisional;
    this.heavyGate = heavyGate;
    this.now = now;
    this.entries = new Map();
    this.active = null;
    this.lastSelectedKey = null;
    this.lastStartedAt = null;
    this.currentPolicy = {
      mode: "paused",
      cadenceMs: null,
      device: null,
      selectedGpuUuid: null,
      reason: "waiting_for_telemetry",
    };
    this.lastError = null;
  }

  request({ sessionId, trackId, throughMs } = {}) {
    const safeSessionId = identifier(sessionId, "sessionId");
    const safeTrackId = identifier(trackId, "trackId");
    const safeThroughMs = boundary(throughMs, "throughMs");
    const key = keyFor(safeSessionId, safeTrackId);
    const entry = this.entries.get(key) ?? {
      sessionId: safeSessionId,
      trackId: safeTrackId,
      latestRequestedThroughMs: -1,
      coveredThroughMs: 0,
      pending: null,
      running: null,
    };
    if (safeThroughMs < entry.latestRequestedThroughMs) {
      throw new RangeError("throughMs must be monotonic for a session track");
    }
    entry.latestRequestedThroughMs = safeThroughMs;
    if (safeThroughMs > entry.coveredThroughMs && safeThroughMs !== entry.running?.throughMs) {
      entry.pending = {
        sessionId: safeSessionId,
        trackId: safeTrackId,
        throughMs: safeThroughMs,
      };
    }
    this.entries.set(key, entry);
    return this.status();
  }

  pending() {
    return [...this.entries.values()]
      .map((entry) => entry.pending)
      .filter(Boolean)
      .sort(
        (left, right) =>
          left.sessionId.localeCompare(right.sessionId) || left.trackId.localeCompare(right.trackId)
      )
      .map((request) => ({ ...request }));
  }

  status() {
    return {
      mode: this.currentPolicy.mode,
      cadenceMs: this.currentPolicy.cadenceMs,
      pending: this.pending().length,
      running: this.active ? 1 : 0,
      pausedReason: this.currentPolicy.reason,
      executionDevice: this.currentPolicy.device,
      lastError: this.lastError,
      recordingContinues: true,
    };
  }

  tick(resourceSnapshot) {
    this.currentPolicy = previewPolicy(resourceSnapshot);
    if (this.currentPolicy.mode === "paused") return Promise.resolve(0);
    if (this.active) return this.active;
    const now = this.now();
    if (this.lastStartedAt !== null && now - this.lastStartedAt < this.currentPolicy.cadenceMs) {
      return Promise.resolve(0);
    }
    const candidates = [...this.entries.entries()];
    const previousIndex = candidates.findIndex(([key]) => key === this.lastSelectedKey);
    let selected = null;
    for (let offset = 1; offset <= candidates.length; offset += 1) {
      const index = (Math.max(previousIndex, -1) + offset) % candidates.length;
      if (candidates[index]?.[1].pending !== null) {
        selected = candidates[index];
        break;
      }
    }
    if (!selected) return Promise.resolve(0);
    const [key, entry] = selected;
    this.lastSelectedKey = key;
    const request = entry.pending;
    entry.pending = null;
    entry.running = request;
    const fromMs = Math.max(entry.coveredThroughMs, request.throughMs - MAX_CONTEXT_MS, 0);
    const execution = {
      ...request,
      fromMs,
      executionDevice: this.currentPolicy.device,
      selectedGpuUuid: this.currentPolicy.selectedGpuUuid,
      cpuThreads: this.currentPolicy.device === "cpu" ? 4 : null,
      lowPriority: this.currentPolicy.device === "cpu",
    };
    const operation = this.heavyGate
      .run("preview", async () => {
        this.lastStartedAt = this.now();
        const result = await this.executePreview(execution);
        const segments = result?.segments;
        if (!Array.isArray(segments)) {
          throw new TypeError("preview result segments must be an array");
        }
        const provisional = segments.map((segment) => ({
          ...segment,
          resultKind: "provisional",
          result_kind: "provisional",
        }));
        await this.persistProvisional({
          ...request,
          fromMs,
          segments: provisional,
        });
        entry.coveredThroughMs = Math.max(entry.coveredThroughMs, request.throughMs);
        this.lastError = null;
        return 1;
      })
      .catch((error) => {
        this.lastError = errorMessage(error);
        if (!entry.pending || entry.pending.throughMs < request.throughMs) {
          entry.pending = request;
        }
        return 0;
      })
      .finally(() => {
        entry.running = null;
        if (this.active === operation) this.active = null;
        this.entries.set(key, entry);
      });
    this.active = operation;
    return operation;
  }
}

module.exports = PreviewTranscriptionScheduler;
module.exports.previewPolicy = previewPolicy;
module.exports.constants = {
  MAX_CONTEXT_MS,
  NORMAL_CADENCE_MS,
  CONSTRAINED_CADENCE_MS,
  CPU_CADENCE_MS,
};
