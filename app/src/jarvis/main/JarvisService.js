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
const RECOVERY_SIDECAR_SUFFIX = ".wav.recovery.json";
const RECOVERY_SIDECAR_MAX_BYTES = 16 * 1024;
const WAV_HEADER_BYTES = 44;
const WAV_SAMPLE_RATE = 24_000;
const WAV_BYTES_PER_SAMPLE = 2;
const MAX_CHUNK_PCM_BYTES = 60 * WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE;
const RECOVERY_SIDECAR_KEYS = Object.freeze([
  "durationMs",
  "endedAt",
  "id",
  "path",
  "sequenceNumber",
  "sessionId",
  "sha256",
  "sourceType",
  "startedAt",
  "trackId",
]);

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
      "createTracks",
      "setTrackState",
      "openGap",
      "interruptTrack",
      "closeGap",
      "restoreTrack",
      "pauseCapture",
      "resumeCapture",
      "finalizeCapture",
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
    this.completedRestorations = new Map();
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
    if (session.capture_mode !== null && session.capture_mode !== undefined) {
      if (session.capture_mode !== normalized.captureMode) {
        throw new Error("capture mode does not match persisted session");
      }
      const persistedMicDeviceId = session.mic_device_id ?? null;
      const micSource = normalized.sources.find((source) => source.sourceType === "mic");
      if (normalized.captureMode === "system") {
        if (persistedMicDeviceId !== null) {
          throw new Error("system capture session must not persist a microphone device id");
        }
      } else if (persistedMicDeviceId !== (micSource?.deviceId ?? null)) {
        throw new Error("microphone source does not match persisted session");
      }
    }

    this.fs.mkdirSync(this.recordingsDir, { recursive: true });
    this.completedRestorations.clear();
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
      this.writer = this._createWriter(id, path.join(this.recordingsDir, id));
      this.repository.createTracks(
        Object.values(sources).map((source) => ({
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
        }))
      );
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) {
        this._failForDisk(diskError.code, normalized.startedAt, []);
      } else {
        this.writer?.abortAll?.();
        this.writer = null;
        for (const source of Object.values(this.state.sources)) source.state = "failed";
        this._transitionSessionStatus("failed", normalized.startedAt);
        this.state.errorCode = "CAPTURE_START_FAILED";
        this._persistSessionStatus("failed", normalized.startedAt);
        this._publish(normalized.startedAt);
      }
      throw error;
    }
    return this._publish(normalized.startedAt);
  }

  appendPcm(sessionId, sourceType, pcmBuffer) {
    if (this.closing || this.closed) return false;
    const id = assertId(sessionId, "sessionId");
    const type = assertSourceType(sourceType);
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    if (this.state.status === "failed") return false;
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
    const source = this._assertSourceSession(sessionId, sourceType, [
      "recording",
      "degraded",
      "paused",
    ]);
    if (!restoration || typeof restoration !== "object") {
      throw new TypeError("restoration is required");
    }
    this._assertTime(restoration.at, "at");
    if (
      restoration.sourceType !== undefined &&
      restoration.sourceType !== source.sourceType
    ) {
      throw new TypeError("restoration source type must match the requested source");
    }
    const restored = normalizeSource({ ...restoration, sourceType: source.sourceType });
    if (source.state !== "reconnecting") {
      const completed = this.completedRestorations.get(source.sourceType);
      if (
        completed?.sessionId === this.state.sessionId &&
        completed.trackId === source.trackId &&
        completed.at === restoration.at &&
        completed.deviceId === restored.deviceId &&
        completed.deviceLabel === restored.deviceLabel &&
        completed.strategy === restored.strategy &&
        completed.targetState === source.state
      ) {
        return this._publish(restoration.at);
      }
      throw new Error(`capture source is not reconnecting: ${source.sourceType}`);
    }
    if (source.interruptedAt !== null && restoration.at < source.interruptedAt) {
      throw new RangeError("restoration time is before the current interruption");
    }
    const restoredGapId = source.gapId;
    const isManualPause = this.state.status === "paused";

    if (isManualPause) {
      this.repository.restoreTrack({
        trackId: source.trackId,
        gapId: source.gapId,
        endedAt: restoration.at,
        recoveryAttempts: 1,
        targetState: "paused",
        sessionId: this.state.sessionId,
        sessionStatus: "paused",
        deviceId: restored.deviceId,
        deviceLabel: restored.deviceLabel,
        strategy: restored.strategy,
      });
      Object.assign(source, restored, {
        state: "paused",
        gapId: null,
        interruptedAt: null,
        reason: null,
        errorCode: null,
      });
      this._rememberCompletedRestoration(source, restoredGapId, restoration.at, "paused");
      return this._publish(restoration.at);
    }

    try {
      this._assertSafeDiskSpace();
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) return this._failForDisk(diskError.code, restoration.at);
      throw error;
    }
    this.writer.reopenSource(source.sourceType, {
      id: source.trackId,
      startedAt: restoration.at,
    });
    try {
      const status = Object.values(this.state.sources).every(
        (entry) => entry === source || entry.state === "active"
      )
        ? "recording"
        : "degraded";
      this.repository.restoreTrack({
        trackId: source.trackId,
        gapId: source.gapId,
        endedAt: restoration.at,
        recoveryAttempts: 1,
        sessionId: this.state.sessionId,
        sessionStatus: "recording",
        deviceId: restored.deviceId,
        deviceLabel: restored.deviceLabel,
        strategy: restored.strategy,
      });
      Object.assign(source, restored, {
        state: "active",
        gapId: null,
        interruptedAt: null,
        reason: null,
        errorCode: null,
      });
      this._transitionSessionStatus(status, restoration.at);
      this._rememberCompletedRestoration(source, restoredGapId, restoration.at, "active");
    } catch (error) {
      try {
        this.writer.closeSource(source.sourceType, restoration.at);
      } catch {}
      throw error;
    }
    return this._publish(restoration.at);
  }

  pauseCapture(sessionId, at = this.now(), errorCode = null) {
    this._assertOpen();
    this._assertActive(sessionId, ["recording", "degraded"]);
    this._assertTime(at, "at");
    if (errorCode !== null && (typeof errorCode !== "string" || errorCode.length === 0)) {
      throw new TypeError("errorCode must be a non-empty string or null");
    }
    this.repository.pauseCapture({
      sessionId: this.state.sessionId,
      sources: Object.values(this.state.sources).map((source) => ({
        trackId: source.trackId,
        expectedState: source.state === "reconnecting" ? "recovering" : source.state,
      })),
      at,
    });
    try {
      this.writer.closeAll(at);
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      return diskError
        ? this._failForDisk(diskError.code, at)
        : this._failForAudioWrite(at);
    }
    for (const source of Object.values(this.state.sources)) {
      if (source.state !== "active") continue;
      source.state = "paused";
    }
    this._transitionSessionStatus("paused", at);
    this.state.errorCode = errorCode;
    return this._publish(at);
  }

  resumeCapture(sessionId, at = this.now()) {
    this._assertOpen();
    this._assertActive(sessionId, "paused");
    this._assertTime(at, "at");
    if (!Object.values(this.state.sources).some((source) => source.state === "paused")) {
      throw new Error("capture has no paused sources to resume");
    }
    try {
      this._assertSafeDiskSpace();
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError) this._failForDisk(diskError.code, at);
      throw error;
    }
    const reopenedSourceTypes = [];
    try {
      for (const source of Object.values(this.state.sources)) {
        if (source.state !== "paused") continue;
        this.writer.reopenSource(source.sourceType, { id: source.trackId, startedAt: at });
        reopenedSourceTypes.push(source.sourceType);
      }
      this.repository.resumeCapture({
        sessionId: this.state.sessionId,
        sources: Object.values(this.state.sources).map((source) => ({
          trackId: source.trackId,
          expectedState: source.state === "reconnecting" ? "recovering" : source.state,
        })),
        at,
      });
    } catch (error) {
      for (const sourceType of reopenedSourceTypes) {
        try {
          this.writer.closeSource(sourceType, at);
        } catch {}
      }
      throw error;
    }
    for (const source of Object.values(this.state.sources)) {
      if (source.state === "paused") source.state = "active";
    }
    const status = this._deriveSessionStatus();
    this._transitionSessionStatus(status, at);
    this.state.errorCode = null;
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
        return diskError
          ? this._failForDisk(diskError.code, at)
          : this._failForAudioWrite(at);
      }
    }
    this.writer = null;
    return this._finalizeCapture(at, {
      trackState: "ended",
      sessionStatus: "completed",
      errorCode: null,
    });
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
    return this._finalizeCapture(at, {
      trackState: "failed",
      sessionStatus: "failed",
      errorCode: code,
    });
  }

  recoverOpenSessions(at = this.now()) {
    this._assertOpen();
    this._assertTime(at, "at");
    this._reconcileChunkRecoverySidecars();
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
          this.writer = null;
          if (["recording", "degraded", "paused"].includes(this.state.status)) {
            const diskError = this._findDiskSpaceError(error);
            this._finalizeCapture(at, {
              trackState: "failed",
              sessionStatus: "failed",
              errorCode: diskError?.code ?? "AUDIO_WRITE_FAILED",
            });
          }
          return;
        }
        this.writer = null;
      }
      if (["recording", "degraded", "paused"].includes(this.state.status)) {
        this._finalizeCapture(at, {
          trackState: "recovered",
          sessionStatus: "recovered",
          errorCode: null,
        });
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

  _reconcileChunkRecoverySidecars() {
    let root;
    try {
      const rootStat = this.fs.lstatSync(this.recordingsDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
      root = this.fs.realpathSync(this.recordingsDir);
    } catch {
      return;
    }

    let sessionEntries;
    try {
      sessionEntries = this.fs
        .readdirSync(root, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }

    for (const sessionEntry of sessionEntries) {
      let sessionId;
      try {
        sessionId = assertId(sessionEntry.name, "recovery sessionId");
      } catch {
        continue;
      }
      const sessionDir = this._recoveryDirectory(root, sessionId);
      if (!sessionDir) continue;

      for (const sourceType of ["mic", "system"]) {
        const sourceDir = this._recoveryDirectory(sessionDir, sourceType);
        if (!sourceDir) continue;
        let sidecarEntries;
        try {
          sidecarEntries = this.fs
            .readdirSync(sourceDir, { withFileTypes: true })
            .filter((entry) => entry.name.endsWith(RECOVERY_SIDECAR_SUFFIX))
            .sort((left, right) => left.name.localeCompare(right.name));
        } catch {
          continue;
        }
        for (const sidecarEntry of sidecarEntries) {
          try {
            this._reconcileChunkRecoverySidecar({
              root,
              sessionId,
              sourceType,
              sourceDir,
              sidecarName: sidecarEntry.name,
            });
          } catch {
            // Preserve invalid/conflicting evidence for diagnosis while allowing startup and
            // valid sibling recovery to continue.
          }
        }
      }
    }
  }

  _recoveryDirectory(parent, name) {
    const candidate = path.join(parent, name);
    try {
      const stat = this.fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const real = this.fs.realpathSync(candidate);
      return this._isDirectChild(parent, real) ? real : null;
    } catch {
      return null;
    }
  }

  _reconcileChunkRecoverySidecar({ root, sessionId, sourceType, sourceDir, sidecarName }) {
    const sidecarPath = path.join(sourceDir, sidecarName);
    const sidecarStat = this.fs.lstatSync(sidecarPath);
    if (
      !sidecarStat.isFile() ||
      sidecarStat.isSymbolicLink() ||
      sidecarStat.size <= 0 ||
      sidecarStat.size > RECOVERY_SIDECAR_MAX_BYTES
    ) {
      throw new Error("invalid audio recovery sidecar");
    }
    const sidecarRealPath = this.fs.realpathSync(sidecarPath);
    if (!this._isDirectChild(sourceDir, sidecarRealPath)) {
      throw new Error("audio recovery sidecar escapes its source directory");
    }

    const metadata = JSON.parse(this.fs.readFileSync(sidecarRealPath, "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new TypeError("audio recovery metadata must be an object");
    }
    if (
      JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(RECOVERY_SIDECAR_KEYS)
    ) {
      throw new TypeError("audio recovery metadata has an invalid structure");
    }

    const chunkId = assertId(metadata.id, "audio recovery chunkId");
    const metadataSessionId = assertId(metadata.sessionId, "audio recovery sessionId");
    const trackId = assertId(metadata.trackId, "audio recovery trackId");
    const metadataSourceType = assertSourceType(metadata.sourceType);
    if (metadataSessionId !== sessionId || metadataSourceType !== sourceType) {
      throw new Error("audio recovery metadata does not match its directory");
    }
    if (sidecarName !== `${chunkId}${RECOVERY_SIDECAR_SUFFIX}`) {
      throw new Error("audio recovery filename does not match its chunk id");
    }
    if (!Number.isSafeInteger(metadata.sequenceNumber) || metadata.sequenceNumber < 0) {
      throw new RangeError("audio recovery sequenceNumber must be non-negative");
    }
    for (const name of ["startedAt", "endedAt", "durationMs"]) {
      if (!Number.isSafeInteger(metadata[name])) {
        throw new TypeError(`audio recovery ${name} must be a safe integer`);
      }
    }
    if (
      metadata.durationMs <= 0 ||
      metadata.durationMs > 60_000 ||
      metadata.endedAt - metadata.startedAt !== metadata.durationMs
    ) {
      throw new RangeError("audio recovery duration is invalid");
    }
    if (typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256)) {
      throw new TypeError("audio recovery sha256 is invalid");
    }
    if (typeof metadata.path !== "string" || !path.isAbsolute(metadata.path)) {
      throw new TypeError("audio recovery path must be absolute");
    }
    if (!this.repository.getSession(metadataSessionId)) {
      throw new Error("audio recovery session does not exist");
    }

    const wavName = sidecarName.slice(0, -".recovery.json".length);
    const wavPath = path.join(sourceDir, wavName);
    const wavStat = this.fs.lstatSync(wavPath);
    if (!wavStat.isFile() || wavStat.isSymbolicLink()) {
      throw new Error("audio recovery WAV is not a regular file");
    }
    if (
      wavStat.size <= WAV_HEADER_BYTES ||
      wavStat.size > WAV_HEADER_BYTES + MAX_CHUNK_PCM_BYTES
    ) {
      throw new RangeError("audio recovery WAV size is invalid");
    }
    const wavRealPath = this.fs.realpathSync(wavPath);
    if (
      !this._isDirectChild(sourceDir, wavRealPath) ||
      !this._isContainedPath(root, wavRealPath) ||
      !this._samePath(path.resolve(metadata.path), wavRealPath)
    ) {
      throw new Error("audio recovery WAV path is invalid");
    }
    const pcm = this._validatedRecoveryPcm(wavRealPath, metadata.durationMs);
    const sha256 = crypto.createHash("sha256").update(pcm).digest("hex");
    if (sha256 !== metadata.sha256) {
      throw new Error("audio recovery WAV hash does not match metadata");
    }

    const chunk = {
      id: chunkId,
      sessionId: metadataSessionId,
      trackId,
      sourceType: metadataSourceType,
      sequenceNumber: metadata.sequenceNumber,
      path: wavRealPath,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      durationMs: metadata.durationMs,
      sha256: metadata.sha256,
      expiresAt: metadata.endedAt + AUDIO_RETENTION_MS,
    };
    const existing =
      typeof this.repository.getAudioChunk === "function"
        ? this.repository.getAudioChunk(chunk.id)
        : null;
    if (existing) {
      this._assertRecoveryChunkMatches(existing, chunk);
      if (typeof this.repository.enqueueChunkTranscription !== "function") {
        throw new TypeError("repository.enqueueChunkTranscription must be a function");
      }
      this.repository.enqueueChunkTranscription(chunk);
    } else {
      this.repository.commitChunk(chunk);
    }
    this.fs.unlinkSync(sidecarRealPath);
  }

  _validatedRecoveryPcm(wavPath, durationMs) {
    const wav = this.fs.readFileSync(wavPath);
    if (wav.length <= WAV_HEADER_BYTES || wav.length > WAV_HEADER_BYTES + MAX_CHUNK_PCM_BYTES) {
      throw new RangeError("audio recovery WAV size is invalid");
    }
    const pcmBytes = wav.length - WAV_HEADER_BYTES;
    if (
      pcmBytes % WAV_BYTES_PER_SAMPLE !== 0 ||
      wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.readUInt32LE(4) !== 36 + pcmBytes ||
      wav.toString("ascii", 8, 16) !== "WAVEfmt " ||
      wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 ||
      wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== WAV_SAMPLE_RATE ||
      wav.readUInt32LE(28) !== WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE ||
      wav.readUInt16LE(32) !== WAV_BYTES_PER_SAMPLE ||
      wav.readUInt16LE(34) !== 16 ||
      wav.toString("ascii", 36, 40) !== "data" ||
      wav.readUInt32LE(40) !== pcmBytes
    ) {
      throw new Error("audio recovery WAV format is invalid");
    }
    if (
      Math.max(1, Math.round((pcmBytes * 1000) / (WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE))) !==
      durationMs
    ) {
      throw new Error("audio recovery WAV duration does not match metadata");
    }
    return wav.subarray(WAV_HEADER_BYTES);
  }

  _assertRecoveryChunkMatches(existing, chunk) {
    const expected = {
      id: chunk.id,
      session_id: chunk.sessionId,
      track_id: chunk.trackId,
      source_type: chunk.sourceType,
      sequence_number: chunk.sequenceNumber,
      path: chunk.path,
      started_at: chunk.startedAt,
      ended_at: chunk.endedAt,
      duration_ms: chunk.durationMs,
      sha256: chunk.sha256,
      expires_at: chunk.expiresAt,
    };
    for (const [key, value] of Object.entries(expected)) {
      const matches = key === "path" ? this._samePath(existing[key], value) : existing[key] === value;
      if (!matches) throw new Error(`audio recovery chunk conflicts on ${key}`);
    }
  }

  _isDirectChild(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return (
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.includes(path.sep)
    );
  }

  _isContainedPath(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return (
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  }

  _samePath(left, right) {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  _interruptSource(sessionId, sourceType, { at, reason }, writerError = null) {
    const source = this._assertSourceSession(sessionId, sourceType, [
      "recording",
      "degraded",
      "paused",
    ]);
    this._assertTime(at, "at");
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TypeError("reason must be a non-empty string");
    }
    if (source.state === "reconnecting") return this._publicState(at);
    if (source.state !== "active") throw new Error(`capture source is not active: ${source.sourceType}`);

    const gapId = `gap-${crypto.randomUUID()}`;
    this.repository.interruptTrack({
      trackId: source.trackId,
      sessionId: this.state.sessionId,
      sessionStatus: "recording",
      gap: {
        id: gapId,
        trackId: source.trackId,
        startedAt: at,
        reason,
        recoveryAttempts: 0,
      },
    });
    this.completedRestorations.delete(source.sourceType);

    Object.assign(source, {
      state: "reconnecting",
      gapId,
      interruptedAt: at,
      reason,
      errorCode: writerError ? "AUDIO_WRITE_FAILED" : null,
    });

    let closeError = writerError;
    try {
      this.writer.closeSource(source.sourceType, at);
    } catch (error) {
      closeError ??= error;
      const diskError = this._findDiskSpaceError(error);
      if (diskError) return this._failForDisk(diskError.code, at);
    }
    source.errorCode = closeError ? "AUDIO_WRITE_FAILED" : null;
    this._transitionSessionStatus("degraded", at);
    return this._publish(at);
  }

  _deriveSessionStatus() {
    const sources = Object.values(this.state.sources);
    const activeCount = sources.filter((source) => source.state === "active").length;
    if (activeCount === sources.length) return "recording";
    return "degraded";
  }

  _rememberCompletedRestoration(source, gapId, at, targetState) {
    this.completedRestorations.set(source.sourceType, {
      sessionId: this.state.sessionId,
      trackId: source.trackId,
      gapId,
      at,
      deviceId: source.deviceId,
      deviceLabel: source.deviceLabel,
      strategy: source.strategy,
      targetState,
    });
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

  _failForDisk(code, at, durableSources) {
    this.writer?.abortAll?.();
    this.writer = null;
    return this._finalizeCapture(at, {
      trackState: "failed",
      sessionStatus: "failed",
      errorCode: code,
      durableSources,
    });
  }

  _failForAudioWrite(at) {
    this.writer?.abortAll?.();
    this.writer = null;
    return this._finalizeCapture(at, {
      trackState: "failed",
      sessionStatus: "failed",
      errorCode: "AUDIO_WRITE_FAILED",
    });
  }

  _finalizeCapture(
    at,
    { trackState, sessionStatus, errorCode, durableSources = null }
  ) {
    const sources = Object.values(this.state.sources);
    const evidenceSources =
      durableSources ?? sources.map((source) => ({ trackId: source.trackId, gapId: source.gapId }));

    for (const source of sources) {
      source.state = trackState;
      source.gapId = null;
    }
    this._transitionSessionStatus(sessionStatus, at);
    this.state.errorCode = errorCode;

    try {
      this.repository.finalizeCapture({
        sessionId: this.state.sessionId,
        sources: evidenceSources,
        trackState,
        sessionStatus,
        at,
      });
    } catch (error) {
      if (sessionStatus !== "failed") {
        for (const source of sources) source.state = "failed";
        this._transitionSessionStatus("failed", at);
        this.state.errorCode = "CAPTURE_FINALIZATION_FAILED";
      }
      try {
        this._publish(at);
      } catch {}
      throw error;
    }
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
