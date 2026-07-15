const { randomUUID } = require("node:crypto");

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} is required`);
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function defaultLocalDateKey(at) {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

class RendererPowerResumeHandshake {
  constructor({
    send,
    isAvailable,
    createId = randomUUID,
    timeoutMs = 10_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.send = requiredFunction(send, "send");
    this.isAvailable = requiredFunction(isAvailable, "isAvailable");
    this.createId = requiredFunction(createId, "createId");
    this.setTimer = requiredFunction(setTimer, "setTimer");
    this.clearTimer = requiredFunction(clearTimer, "clearTimer");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("timeoutMs must be between 1 and 60000");
    }
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  request(kind, token) {
    if (!new Set(["suspend", "enumerate", "resume", "rotate"]).has(kind)) {
      return Promise.reject(new TypeError("unsupported renderer power recovery kind"));
    }
    if (!token || typeof token !== "object" || typeof token.sessionId !== "string") {
      return Promise.reject(new TypeError("renderer power recovery token is required"));
    }
    if (!this.isAvailable()) {
      return Promise.reject(new Error("Jarvis renderer is unavailable for power recovery"));
    }
    const id = this.createId();
    const request = { id, kind, token: structuredClone(token) };
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new Error(`Jarvis renderer power ${kind} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { kind, resolve, reject, timer });
      try {
        this.send(request);
      } catch (error) {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(error);
      }
    });
  }

  acknowledge(id, outcome, payload) {
    const pending = this.pending.get(id);
    if (!pending) return { status: "unknown" };
    this.pending.delete(id);
    this.clearTimer(pending.timer);
    if (outcome === "ok") {
      pending.resolve(payload);
      return { status: "acknowledged" };
    }
    const message =
      typeof payload?.message === "string" && payload.message.length > 0
        ? payload.message
        : `Jarvis renderer power ${pending.kind} failed`;
    pending.reject(new Error(message));
    return { status: "failed" };
  }

  markUnavailable(reason = "renderer unavailable") {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.clearTimer(pending.timer);
      pending.reject(new Error(reason));
    }
  }
}

class JarvisPowerLifecycle {
  constructor({
    service,
    processingLifecycle,
    releaseWhisper,
    suspendUpstream,
    resumeDevices,
    resumeUpstream,
    rebindPcmSession,
    rotateUpstream,
    ensureGpuReady,
    localDateKey = defaultLocalDateKey,
    createSessionId,
    now = Date.now,
  } = {}) {
    this.service = requiredObject(service, "service");
    for (const method of [
      "getState",
      "suspendForPower",
      "resumeAfterPower",
      "confirmPowerRestorations",
      "rotateAtLocalDate",
      "recoverOpenSessions",
    ]) {
      requiredFunction(service[method], `service.${method}`);
    }
    this.processingLifecycle = requiredObject(processingLifecycle, "processingLifecycle");
    requiredFunction(processingLifecycle.start, "processingLifecycle.start");
    requiredFunction(processingLifecycle.stop, "processingLifecycle.stop");
    this.releaseWhisper = requiredFunction(releaseWhisper, "releaseWhisper");
    this.suspendUpstream = requiredFunction(suspendUpstream, "suspendUpstream");
    this.resumeDevices = requiredFunction(resumeDevices, "resumeDevices");
    this.resumeUpstream = requiredFunction(resumeUpstream, "resumeUpstream");
    this.rebindPcmSession = requiredFunction(rebindPcmSession, "rebindPcmSession");
    this.rotateUpstream = requiredFunction(rotateUpstream, "rotateUpstream");
    this.ensureGpuReady = requiredFunction(ensureGpuReady, "ensureGpuReady");
    this.localDateKey = requiredFunction(localDateKey, "localDateKey");
    this.createSessionId = requiredFunction(createSessionId, "createSessionId");
    this.now = requiredFunction(now, "now");
    this.resumeToken = null;
    this.observedLocalDate = null;
    this.rotationsByLocalDate = new Map();
    this.pendingRotationsByLocalDate = new Map();
    this.inFlight = new Map();
    this.runtimeQuiesce = Promise.resolve();
    this.upstreamQuiesce = Promise.resolve();
  }

  getResumeToken() {
    return this.resumeToken ? structuredClone(this.resumeToken) : null;
  }

  onSuspend(at = this.now()) {
    const existing = this.inFlight.get("suspend");
    if (existing) return existing;
    const state = this.service.getState();
    let capture = { state, resumeToken: null, suspended: false };
    let captureError = null;
    let upstreamWork = Promise.resolve();
    if (["recording", "degraded"].includes(state.status)) {
      try {
        upstreamWork = Promise.resolve(this.suspendUpstream(structuredClone(state)));
      } catch (error) {
        upstreamWork = Promise.reject(error);
      }
      try {
        capture = this.service.suspendForPower(at);
        this.resumeToken = structuredClone(capture.resumeToken);
      } catch (error) {
        captureError = error;
      }
    }
    this.upstreamQuiesce = upstreamWork.then(
      () => undefined,
      () => undefined
    );
    const runtimeWork = (async () => {
      try {
        await this.processingLifecycle.stop();
      } finally {
        await this.releaseWhisper();
      }
    })();
    this.runtimeQuiesce = runtimeWork.then(
      () => undefined,
      () => undefined
    );
    const pending = (async () => {
      const [upstreamResult, runtimeResult] = await Promise.allSettled([upstreamWork, runtimeWork]);
      const upstreamError = upstreamResult.status === "rejected" ? upstreamResult.reason : null;
      const runtimeError = runtimeResult.status === "rejected" ? runtimeResult.reason : null;
      if (captureError) {
        if (upstreamError) captureError.upstreamStopError = upstreamError;
        if (runtimeError) captureError.runtimeStopError = runtimeError;
        throw captureError;
      }
      if (upstreamError) {
        if (runtimeError) upstreamError.runtimeStopError = runtimeError;
        throw upstreamError;
      }
      if (runtimeError) throw runtimeError;
      return { ...capture, resumeToken: this.getResumeToken() };
    })();
    this.inFlight.set("suspend", pending);
    const clear = () => {
      if (this.inFlight.get("suspend") === pending) this.inFlight.delete("suspend");
    };
    pending.then(clear, clear);
    return pending;
  }

  onResume(at = this.now()) {
    return this._singleFlight("resume", async () => {
      await Promise.all([this.runtimeQuiesce, this.upstreamQuiesce]);
      const token = this.resumeToken;
      if (!token) {
        this.processingLifecycle.start();
        return { resumed: false, ...this.service.getState() };
      }
      const restoration = await this.resumeDevices(structuredClone(token));
      let state;
      try {
        state = this.service.resumeAfterPower(token, restoration, at);
        const actualRestorations = await this.resumeUpstream({
          ...structuredClone(token),
          restorations: structuredClone(restoration),
        });
        state = this.service.confirmPowerRestorations(token, actualRestorations ?? restoration, at);
        await this.ensureGpuReady();
        this.processingLifecycle.start();
      } catch (error) {
        if (["recording", "degraded"].includes(this.service.getState().status)) {
          let upstreamWork;
          try {
            upstreamWork = Promise.resolve(
              this.suspendUpstream(structuredClone(this.service.getState()))
            );
          } catch (upstreamError) {
            upstreamWork = Promise.reject(upstreamError);
          }
          const safe = this.service.suspendForPower(at);
          this.resumeToken = structuredClone(safe.resumeToken);
          this.upstreamQuiesce = upstreamWork.then(
            () => undefined,
            () => undefined
          );
          const upstreamResult = await Promise.allSettled([upstreamWork]);
          if (upstreamResult[0].status === "rejected") {
            error.upstreamStopError = upstreamResult[0].reason;
          }
        }
        throw error;
      }
      this.resumeToken = null;
      return { resumed: true, ...state };
    });
  }

  recoverAfterLaunch(at = this.now()) {
    return this._singleFlight("recover", async () => {
      const recovered = await this.service.recoverOpenSessions(at);
      const interruptedSessionIds = (Array.isArray(recovered) ? recovered : [])
        .map((session) => session?.id)
        .filter((id) => typeof id === "string" && id.length > 0);
      return {
        recovered,
        interruptedSessionIds,
        interruptedSessionId:
          interruptedSessionIds.length === 1
            ? interruptedSessionIds[0]
            : (interruptedSessionIds.at(-1) ?? null),
      };
    });
  }

  onLocalDateChange(now = this.now()) {
    const localDate = this.localDateKey(now);
    const key = `local-date:${localDate}`;
    return this._singleFlight(key, async () => {
      const previousLocalDate = this.observedLocalDate;
      this.observedLocalDate = localDate;
      const existing = this.rotationsByLocalDate.get(localDate);
      if (existing) return existing;
      const pendingRotation = this.pendingRotationsByLocalDate.get(localDate);
      if (pendingRotation) {
        return this._completeLocalDateRotation(localDate, pendingRotation);
      }
      const state = this.service.getState();
      if (!["recording", "degraded"].includes(state.status) || !state.sessionId) {
        return { rotated: false, localDate, ...state };
      }
      const sessionLocalDate = Number.isSafeInteger(state.startedAt)
        ? this.localDateKey(state.startedAt)
        : previousLocalDate;
      if (sessionLocalDate === null || sessionLocalDate === localDate) {
        return { rotated: false, localDate, ...state };
      }
      const rotationWork = this.service.rotateAtLocalDate({
        sessionId: state.sessionId,
        newSessionId: this.createSessionId(),
        localDate,
        at: now,
      });
      const result =
        rotationWork && typeof rotationWork.then === "function" ? await rotationWork : rotationWork;
      const pending = {
        result,
        pcmRebound: false,
        upstream: {
          previousSessionId: state.sessionId,
          sessionId: result.sessionId,
          startedAt: now,
          localDate,
        },
      };
      this.pendingRotationsByLocalDate.set(localDate, pending);
      return this._completeLocalDateRotation(localDate, pending);
    });
  }

  async _completeLocalDateRotation(localDate, pending) {
    if (!pending.pcmRebound) {
      this.rebindPcmSession(pending.upstream.previousSessionId, pending.upstream.sessionId);
      pending.pcmRebound = true;
    }
    await this.rotateUpstream(structuredClone(pending.upstream));
    const rotation = { rotated: true, ...pending.result };
    this.rotationsByLocalDate.set(localDate, rotation);
    if (this.pendingRotationsByLocalDate.get(localDate) === pending) {
      this.pendingRotationsByLocalDate.delete(localDate);
    }
    return rotation;
  }

  _singleFlight(key, operation) {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(operation);
    this.inFlight.set(key, pending);
    const clear = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    pending.then(clear, clear);
    return pending;
  }
}

module.exports = JarvisPowerLifecycle;
module.exports.defaultLocalDateKey = defaultLocalDateKey;
module.exports.RendererPowerResumeHandshake = RendererPowerResumeHandshake;
