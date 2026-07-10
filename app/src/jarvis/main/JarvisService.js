const fs = require("node:fs");
const path = require("node:path");
const AudioChunkWriter = require("./AudioChunkWriter");
const { assertId } = require("../shared/contracts");

const AUDIO_RETENTION_MS = 7 * 86400000;

class JarvisService {
  constructor({ repository, userDataDir, broadcast, now = Date.now }) {
    if (!repository || typeof repository !== "object") {
      throw new TypeError("repository is required");
    }
    for (const method of [
      "getSession",
      "setSessionStatus",
      "insertAudioChunk",
      "recoverOpenSessions",
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

    this.repository = repository;
    this.recordingsDir = path.join(userDataDir, "recordings");
    this.broadcast = broadcast;
    this.now = now;
    this.writer = null;
    this.state = {
      sessionId: null,
      status: "idle",
      startedAt: null,
      activeSince: null,
      accumulatedMs: 0,
      errorCode: null,
    };
  }

  startCapture({ sessionId, startedAt, micDeviceId }) {
    const id = assertId(sessionId, "sessionId");
    this._assertTime(startedAt, "startedAt");
    if (micDeviceId !== null && micDeviceId !== undefined && typeof micDeviceId !== "string") {
      throw new TypeError("micDeviceId must be a string or null");
    }
    if (this.writer || this.state.status === "recording" || this.state.status === "paused") {
      throw new Error("a capture session is already active");
    }
    const session = this.repository.getSession(id);
    if (!session) throw new Error("capture session does not exist");

    fs.mkdirSync(this.recordingsDir, { recursive: true });
    this.writer = this._createWriter(id, path.join(this.recordingsDir, id), startedAt);
    this.state = {
      sessionId: id,
      status: "recording",
      startedAt,
      activeSince: startedAt,
      accumulatedMs: 0,
      errorCode: null,
    };
    return this._publish(startedAt);
  }

  appendMicPcm(sessionId, pcmBuffer) {
    const id = assertId(sessionId, "sessionId");
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    if (this.state.status !== "recording" || !this.writer) {
      throw new Error("capture session is not recording");
    }
    this.writer.append(pcmBuffer);
  }

  pauseCapture(sessionId, at = this.now()) {
    this._assertActive(sessionId, "recording");
    this._assertTime(at, "at");
    this.writer.close(at);
    this.writer = null;
    this.state.accumulatedMs += Math.max(0, at - this.state.activeSince);
    this.state.activeSince = null;
    this.state.status = "paused";
    this.repository.setSessionStatus(this.state.sessionId, "paused", at);
    return this._publish(at);
  }

  resumeCapture(sessionId, at = this.now()) {
    this._assertActive(sessionId, "paused");
    this._assertTime(at, "at");
    const writer = this._createWriter(
      this.state.sessionId,
      path.join(this.recordingsDir, this.state.sessionId),
      at
    );
    this.repository.setSessionStatus(this.state.sessionId, "recording", at);
    this.writer = writer;
    this.state.activeSince = at;
    this.state.status = "recording";
    this.state.errorCode = null;
    return this._publish(at);
  }

  finishCapture(sessionId, at = this.now()) {
    this._assertActive(sessionId, ["recording", "paused"]);
    this._assertTime(at, "at");
    if (this.state.status === "recording") {
      this.writer.close(at);
      this.writer = null;
      this.state.accumulatedMs += Math.max(0, at - this.state.activeSince);
    }
    this.state.activeSince = null;
    this.repository.setSessionStatus(this.state.sessionId, "completed", at);
    this.state.status = "completed";
    return this._publish(at);
  }

  failCapture(sessionId, code, at = this.now()) {
    this._assertActive(sessionId, ["recording", "paused"]);
    this._assertTime(at, "at");
    if (typeof code !== "string" || code.length === 0) {
      throw new TypeError("code must be a non-empty string");
    }
    if (this.state.status === "recording") {
      this.writer.close(at);
      this.writer = null;
      this.state.accumulatedMs += Math.max(0, at - this.state.activeSince);
    }
    this.state.activeSince = null;
    this.state.status = "failed";
    this.state.errorCode = code;
    this.repository.setSessionStatus(this.state.sessionId, "failed", at);
    return this._publish(at);
  }

  recoverOpenSessions(at = this.now()) {
    this._assertTime(at, "at");
    return this.repository.recoverOpenSessions(at);
  }

  getState() {
    return this._publicState(this.now());
  }

  shutdown() {
    if (this.writer) {
      this.writer.close(this.now());
      this.writer = null;
    }
  }

  _createWriter(sessionId, baseDir, startedAt) {
    return new AudioChunkWriter({
      sessionId,
      baseDir,
      sampleRate: 24000,
      chunkSeconds: 60,
      now: this.now,
      startedAt,
      onChunk: (chunk) =>
        this.repository.insertAudioChunk({
          ...chunk,
          expiresAt: chunk.endedAt + AUDIO_RETENTION_MS,
        }),
    });
  }

  _assertActive(sessionId, expectedStatuses) {
    const id = assertId(sessionId, "sessionId");
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
    if (!expected.includes(this.state.status)) {
      throw new Error(`capture session must be ${expected.join(" or ")}`);
    }
  }

  _assertTime(value, name) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }

  _publicState(at) {
    const activeMs =
      this.state.status === "recording" && this.state.activeSince !== null
        ? Math.max(0, at - this.state.activeSince)
        : 0;
    return {
      sessionId: this.state.sessionId,
      status: this.state.status,
      startedAt: this.state.startedAt,
      elapsedMs: this.state.accumulatedMs + activeMs,
      errorCode: this.state.errorCode,
    };
  }

  _publish(at) {
    const publicState = this._publicState(at);
    this.broadcast(publicState);
    return publicState;
  }
}

module.exports = JarvisService;
