const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const MultiTrackAudioWriter = require("./MultiTrackAudioWriter");
const { hasSafeDiskSpace } = require("./retentionPolicy");
const { assertId } = require("../shared/contracts");
const {
  assertSourceType,
  normalizeCaptureStartInput,
  normalizeSource,
} = require("../shared/captureModes");

const AUDIO_RETENTION_MS = 7 * 86400000;
const ACTIVE_SESSION_STATUSES = new Set(["recording", "degraded"]);

class DiskSpaceError extends Error {
  constructor(code) {
    super(code === "DISK_SPACE_LOW" ? "insufficient safe disk space" : "disk space check failed");
    this.name = "DiskSpaceError";
    this.code = code;
  }
}

class JarvisService {
  constructor({ repository, userDataDir, recordingsDir, broadcast, now = Date.now, fsImpl = fs }) {
    if (!repository || typeof repository !== "object") {
      throw new TypeError("repository is required");
    }
    for (const method of [
      "getSession",
      "setSessionStatus",
      "recoverOpenSessions",
      "createTrack",
      "setTrackState",
      "openGap",
      "closeGap",
      "commitChunk",
    ]) {
      if (typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} must be a function`);
      }
    }
    if (typeof userDataDir !== "string" || userDataDir.length === 0) {
      throw new TypeError("userDataDir is required");
    }
    if (typeof broadcast !== "function") throw new TypeError("broadcast must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!fsImpl || typeof fsImpl.mkdirSync !== "function") {
      throw new TypeError("fsImpl.mkdirSync must be a function");
    }

    this.repository = repository;
    if (recordingsDir !== undefined && !path.isAbsolute(recordingsDir)) {
      throw new TypeError("recordingsDir must be an absolute path");
    }
    this.recordingsDir = recordingsDir
      ? path.resolve(recordingsDir)
      : path.join(userDataDir, "recordings");
    this.broadcast = broadcast;
    this.now = now;
    this.fs = fsImpl;
    this.writer = null;
    this.closing = false;
    this.closed = false;
    this.state = this._idleState();
  }

  startCapture(input) {
    this._assertOpen();
    const normalized = normalizeCaptureStartInput(input);
    const id = assertId(normalized.sessionId, "sessionId");
    this._assertTime(normalized.startedAt, "startedAt");
    if (this.writer || ACTIVE_SESSION_STATUSES.has(this.state.status) || this.state.status === "paused") {
      throw new Error("a capture session is already active");
    }
    const session = this.repository.getSession(id);
    if (!session) throw new Error("capture session does not exist");

    this.fs.mkdirSync(this.recordingsDir, { recursive: true });
    const sources = {};
    for (const source of normalized.sources) {
      sources[source.sourceType] = {
        ...source,
        trackId: `track-${crypto.randomUUID()}`,
        state: "active",
        gapId: null,
        interruptedAt: null,
        reason: null,
        errorCode: null,
      };
    }
    this.state = {
      sessionId: id,
      status: "recording",
      startedAt: normalized.startedAt,
      activeSince: normalized.startedAt,
      accumulatedMs: 0,
      errorCode: null,
      captureMode: normalized.captureMode,
      sources,
    };

    try {
      this._assertSafeDiskSpace();
      for (const source of Object.values(sources)) {
        this.repository.createTrack({
          id: source.trackId,
          sessionId: id,
          sourceType: source.sourceType,
          deviceId: source.deviceId,
          deviceLabel: source.deviceLabel,
          strategy: source.strategy,
          sampleRate: 24_000,
          channels: 1,
          startedAt: normalized.startedAt,
          state: "active",
        });
      }
      this.writer = this._createWriter(id, path.join(this.recordingsDir, id));
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) this._failForDisk(diskError.code, normalized.startedAt);
      throw error;
    }
    return this._publish(normalized.startedAt);
  }

  appendPcm(sessionId, sourceType, pcmBuffer) {
    if (this.closing || this.closed) return false;
    const id = assertId(sessionId, "sessionId");
    const type = assertSourceType(sourceType);
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    if (
      this.state.status === "failed" &&
      ["DISK_SPACE_LOW", "DISK_SPACE_CHECK_FAILED"].includes(this.state.errorCode)
    ) {
      return false;
    }
    const source = this.state.sources[type];
    if (!source) throw new Error(`capture source was not requested: ${type}`);
    if (source.state !== "active") return false;
    if (!ACTIVE_SESSION_STATUSES.has(this.state.status) || !this.writer) {
      throw new Error("capture session is not recording");
    }
    try {
      this.writer.append(type, pcmBuffer);
      return true;
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) {
        this._failForDisk(diskError.code, this.now());
        return false;
      }
      if (error instanceof TypeError || error instanceof RangeError) throw error;
      this._interruptSource(id, type, { at: this.now(), reason: "audio-write-failed" }, error);
      return false;
    }
  }

  appendMicPcm(sessionId, pcmBuffer) {
    return this.appendPcm(sessionId, "mic", pcmBuffer);
  }

  sourceInterrupted(sessionId, sourceType, interruption) {
    this._assertOpen();
    if (!interruption || typeof interruption !== "object") {
      throw new TypeError("interruption is required");
    }
    return this._interruptSource(sessionId, sourceType, interruption);
  }

  sourceRestored(sessionId, sourceType, restoration) {
    this._assertOpen();
    const source = this._assertSourceSession(sessionId, sourceType, ["degraded", "paused"]);
    if (!restoration || typeof restoration !== "object") {
      throw new TypeError("restoration is required");
    }
    this._assertTime(restoration.at, "at");
    if (source.state !== "reconnecting") {
      throw new Error(`capture source is not reconnecting: ${source.sourceType}`);
    }
    const restored = normalizeSource({ sourceType: source.sourceType, ...restoration });

    this._assertSafeDiskSpace();
    this.writer.reopenSource(source.sourceType, {
      id: source.trackId,
      startedAt: restoration.at,
    });
    if (source.gapId) this.repository.closeGap(source.gapId, restoration.at, 1);
    this.repository.setTrackState(source.trackId, "active", null);
    Object.assign(source, restored, {
      state: "active",
      gapId: null,
      interruptedAt: null,
      reason: null,
      errorCode: null,
    });
    const status = this._deriveSessionStatus();
    this._transitionSessionStatus(status, restoration.at);
    this._persistSessionStatus(status, restoration.at);
    return this._publish(restoration.at);
  }

  pauseCapture(sessionId, at = this.now(), errorCode = null) {
    this._assertOpen();
    this._assertActive(sessionId, ["recording", "degraded"]);
    this._assertTime(at, "at");
    if (errorCode !== null && (typeof errorCode !== "string" || errorCode.length === 0)) {
      throw new TypeError("errorCode must be a non-empty string or null");
    }
    try {
      this.writer.closeAll(at);
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (!diskError) throw error;
      return this._failForDisk(diskError.code, at);
    }
    for (const source of Object.values(this.state.sources)) {
      if (source.state !== "active") continue;
      source.state = "paused";
      this.repository.setTrackState(source.trackId, "paused", at);
    }
    this._transitionSessionStatus("paused", at);
    this.state.errorCode = errorCode;
    this._persistSessionStatus("paused", at);
    return this._publish(at);
  }

  resumeCapture(sessionId, at = this.now()) {
    this._assertOpen();
    this._assertActive(sessionId, "paused");
    this._assertTime(at, "at");
    try {
      this._assertSafeDiskSpace();
      for (const source of Object.values(this.state.sources)) {
        if (source.state !== "paused") continue;
        this.writer.reopenSource(source.sourceType, { id: source.trackId, startedAt: at });
        source.state = "active";
        this.repository.setTrackState(source.trackId, "active", null);
      }
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) this._failForDisk(diskError.code, at);
      throw error;
    }
    const status = this._deriveSessionStatus();
    this._transitionSessionStatus(status, at);
    this.state.errorCode = null;
    this._persistSessionStatus(status, at);
    return this._publish(at);
  }

  finishCapture(sessionId, at = this.now()) {
    this._assertOpen();
    this._assertActive(sessionId, ["recording", "degraded", "paused"]);
    this._assertTime(at, "at");
    if (ACTIVE_SESSION_STATUSES.has(this.state.status)) {
      try {
        this.writer.closeAll(at);
      } catch (error) {
        const diskError = this._findDiskSpaceError(error);
        if (!diskError) throw error;
        return this._failForDisk(diskError.code, at);
      }
    }
    this.writer = null;
    this._finishSources(at, "ended");
    this._transitionSessionStatus("completed", at);
    this._persistSessionStatus("completed", at);
    return this._publish(at);
  }

  failCapture(sessionId, code, at = this.now()) {
    this._assertOpen();
    this._assertActive(sessionId, ["recording", "degraded", "paused"]);
    this._assertTime(at, "at");
    if (typeof code !== "string" || code.length === 0) {
      throw new TypeError("code must be a non-empty string");
    }
    if (ACTIVE_SESSION_STATUSES.has(this.state.status)) {
      try {
        this.writer.closeAll(at);
      } catch {
        this.writer.abortAll?.();
      }
    }
    this.writer = null;
    this._finishSources(at, "failed");
    this._transitionSessionStatus("failed", at);
    this.state.errorCode = code;
    this._persistSessionStatus("failed", at);
    return this._publish(at);
  }

  recoverOpenSessions(at = this.now()) {
    this._assertOpen();
    this._assertTime(at, "at");
    return this.repository.recoverOpenSessions(at);
  }

  getState() {
    return this._publicState(this.now());
  }

  beginShutdown() {
    if (!this.closed) this.closing = true;
  }

  shutdown() {
    if (this.closed) return;
    this.beginShutdown();
    try {
      const at = this.now();
      if (this.writer) {
        try {
          this.writer.closeAll(at);
        } catch (error) {
          this.writer.abortAll?.();
          if (["recording", "degraded", "paused"].includes(this.state.status)) {
            const diskError = this._findDiskSpaceError(error);
            this._finishSources(at, "failed");
            this._transitionSessionStatus("failed", at);
            this.state.errorCode = diskError?.code ?? "AUDIO_WRITE_FAILED";
            this._persistSessionStatus("failed", at);
            this._publish(at);
          }
          this.writer = null;
          return;
        }
        this.writer = null;
      }
      if (["recording", "degraded", "paused"].includes(this.state.status)) {
        this._finishSources(at, "recovered");
        this._transitionSessionStatus("recovered", at);
        this._persistSessionStatus("recovered", at);
        this._publish(at);
      }
    } finally {
      this.closed = true;
    }
  }

  _idleState() {
    return {
      sessionId: null,
      status: "idle",
      startedAt: null,
      activeSince: null,
      accumulatedMs: 0,
      errorCode: null,
      captureMode: null,
      sources: {},
    };
  }

  _createWriter(sessionId, baseDir) {
    const tracks = Object.fromEntries(
      Object.values(this.state.sources).map((source) => [
        source.sourceType,
        { id: source.trackId, startedAt: this.state.startedAt },
      ])
    );
    return new MultiTrackAudioWriter({
      sessionId,
      tracks,
      baseDir,
      now: this.now,
      beforeChunk: () => this._assertSafeDiskSpace(),
      onChunk: (chunk) => {
        if (this.closed) return null;
        return this.repository.commitChunk({
          ...chunk,
          expiresAt: chunk.endedAt + AUDIO_RETENTION_MS,
        });
      },
    });
  }

  _interruptSource(sessionId, sourceType, { at, reason }, writerError = null) {
    const source = this._assertSourceSession(sessionId, sourceType, ["recording", "degraded"]);
    this._assertTime(at, "at");
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TypeError("reason must be a non-empty string");
    }
    if (source.state === "reconnecting") return this._publicState(at);
    if (source.state !== "active") throw new Error(`capture source is not active: ${source.sourceType}`);

    let closeError = writerError;
    try {
      this.writer.closeSource(source.sourceType, at);
    } catch (error) {
      closeError ??= error;
      const diskError = this._findDiskSpaceError(error);
      if (diskError) return this._failForDisk(diskError.code, at);
    }
    const gapId = `gap-${crypto.randomUUID()}`;
    this.repository.setTrackState(source.trackId, "recovering", at);
    this.repository.openGap({
      id: gapId,
      trackId: source.trackId,
      startedAt: at,
      reason,
      recoveryAttempts: 0,
    });
    Object.assign(source, {
      state: "reconnecting",
      gapId,
      interruptedAt: at,
      reason,
      errorCode: closeError ? "AUDIO_WRITE_FAILED" : null,
    });
    const status = this._deriveSessionStatus();
    this._transitionSessionStatus(status, at);
    this._persistSessionStatus(status, at);
    return this._publish(at);
  }

  _finishSources(at, state) {
    for (const source of Object.values(this.state.sources)) {
      if (source.gapId) {
        this.repository.closeGap(source.gapId, at, null);
        source.gapId = null;
      }
      source.state = state;
      this.repository.setTrackState(source.trackId, state, at);
    }
  }

  _deriveSessionStatus() {
    const sources = Object.values(this.state.sources);
    const activeCount = sources.filter((source) => source.state === "active").length;
    if (activeCount === sources.length) return "recording";
    if (activeCount > 0) return "degraded";
    return "paused";
  }

  _transitionSessionStatus(status, at) {
    const wasActive = ACTIVE_SESSION_STATUSES.has(this.state.status);
    const willBeActive = ACTIVE_SESSION_STATUSES.has(status);
    if (wasActive && !willBeActive && this.state.activeSince !== null) {
      this.state.accumulatedMs += Math.max(0, at - this.state.activeSince);
      this.state.activeSince = null;
    } else if (!wasActive && willBeActive) {
      this.state.activeSince = at;
    }
    this.state.status = status;
  }

  _persistSessionStatus(status, at) {
    return this.repository.setSessionStatus(
      this.state.sessionId,
      status === "degraded" ? "recording" : status,
      at
    );
  }

  _assertSafeDiskSpace() {
    let stats;
    try {
      stats = this.fs.statfsSync(this.recordingsDir);
    } catch {
      throw new DiskSpaceError("DISK_SPACE_CHECK_FAILED");
    }
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail ?? stats.bfree) * blockSize;
    if (
      !Number.isFinite(totalBytes) ||
      !Number.isFinite(freeBytes) ||
      totalBytes <= 0 ||
      freeBytes < 0
    ) {
      throw new DiskSpaceError("DISK_SPACE_CHECK_FAILED");
    }
    if (!hasSafeDiskSpace({ freeBytes, totalBytes })) {
      throw new DiskSpaceError("DISK_SPACE_LOW");
    }
  }

  _findDiskSpaceError(error) {
    if (error instanceof DiskSpaceError) return error;
    if (error instanceof AggregateError) {
      for (const nested of error.errors) {
        const found = this._findDiskSpaceError(nested);
        if (found) return found;
      }
    }
    return error?.cause ? this._findDiskSpaceError(error.cause) : null;
  }

  _failForDisk(code, at) {
    this.writer?.abortAll?.();
    this.writer = null;
    this._finishSources(at, "failed");
    this._transitionSessionStatus("failed", at);
    this.state.errorCode = code;
    this._persistSessionStatus("failed", at);
    return this._publish(at);
  }

  _assertSourceSession(sessionId, sourceType, expectedStatuses) {
    this._assertActive(sessionId, expectedStatuses);
    const type = assertSourceType(sourceType);
    const source = this.state.sources[type];
    if (!source) throw new Error(`capture source was not requested: ${type}`);
    return source;
  }

  _assertActive(sessionId, expectedStatuses) {
    const id = assertId(sessionId, "sessionId");
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
    if (!expected.includes(this.state.status)) {
      throw new Error(`capture session must be ${expected.join(" or ")}`);
    }
  }

  _assertOpen() {
    if (this.closing || this.closed) throw new Error("Jarvis capture is shutting down");
  }

  _assertTime(value, name) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }

  _publicState(at) {
    const activeMs =
      ACTIVE_SESSION_STATUSES.has(this.state.status) && this.state.activeSince !== null
        ? Math.max(0, at - this.state.activeSince)
        : 0;
    return {
      sessionId: this.state.sessionId,
      status: this.state.status,
      startedAt: this.state.startedAt,
      elapsedMs: this.state.accumulatedMs + activeMs,
      errorCode: this.state.errorCode,
      captureMode: this.state.captureMode,
      sources: Object.fromEntries(
        Object.entries(this.state.sources).map(([sourceType, source]) => [sourceType, { ...source }])
      ),
    };
  }

  _publish(at) {
    const publicState = this._publicState(at);
    this.broadcast(publicState);
    return publicState;
  }
}

module.exports = JarvisService;
