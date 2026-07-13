const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const MultiTrackAudioWriter = require("./MultiTrackAudioWriter");
const AudioEvidenceReader = require("./AudioEvidenceReader");
const FlacCompressionWorker = require("./FlacCompressionWorker");
const { FLAC_ENCODER_VERSION } = require("./JarvisMigrations");
const SpeechTriggeredCaptureGate = require("./SpeechTriggeredCaptureGate");
const StorageGovernor = require("./StorageGovernor");
const { assertId } = require("../shared/contracts");
const {
  assertSourceType,
  assertRetentionMode,
  normalizeCaptureStartInput,
  normalizeSource,
  parseCapturePolicyJson,
} = require("../shared/captureModes");

const AUDIO_RETENTION_MS = 7 * 86400000;
const ACTIVE_SESSION_STATUSES = new Set(["recording", "degraded"]);
const RECOVERY_SIDECAR_SUFFIX = ".wav.recovery.json";
const RECOVERY_SIDECAR_MAX_BYTES = 16 * 1024;
const LOW_DISK_RECOVERY_VERSION = 1;
const LOW_DISK_RECOVERY_KEYS = Object.freeze(["at", "sessionId", "sources", "version"]);
const WAV_HEADER_BYTES = 44;
const WAV_SAMPLE_RATE = 24_000;
const WAV_BYTES_PER_SAMPLE = 2;
const MAX_CHUNK_PCM_BYTES = 60 * WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE;
const VAD_FRAME_MS = 100;
const VAD_FRAME_BYTES = (WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE * VAD_FRAME_MS) / 1_000;
const DEFAULT_MAX_VAD_QUEUE_MS = 10_000;
const DEFAULT_VAD_TIMEOUT_MS = 5_000;
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
  constructor({
    repository,
    userDataDir,
    recordingsDir,
    broadcast,
    now = Date.now,
    fsImpl = fs,
    vadClassifier = null,
    maxVadQueueMs = DEFAULT_MAX_VAD_QUEUE_MS,
    vadTimeoutMs = DEFAULT_VAD_TIMEOUT_MS,
    flacCompressionWorker = undefined,
    audioEvidenceReader = undefined,
    storageGovernor = undefined,
    migrationGate = null,
  }) {
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
      "pauseCaptureForLowDisk",
      "resumeCapture",
      "finalizeCapture",
      "setSessionRetention",
      "recordEvidenceGap",
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
    if (
      migrationGate !== null &&
      (!migrationGate || typeof migrationGate.assertProducerAllowed !== "function")
    ) {
      throw new TypeError("migrationGate.assertProducerAllowed must be a function");
    }
    if (
      vadClassifier !== null &&
      (typeof vadClassifier !== "object" || typeof vadClassifier.classify !== "function")
    ) {
      throw new TypeError("vadClassifier.classify must be a function");
    }
    for (const [name, value] of Object.entries({ maxVadQueueMs, vadTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
        throw new RangeError(`${name} must be between 1 and 60000 ms`);
      }
    }

    this.repository = repository;
    if (recordingsDir !== undefined && !path.isAbsolute(recordingsDir)) {
      throw new TypeError("recordingsDir must be an absolute path");
    }
    this.recordingsDir = recordingsDir
      ? path.resolve(recordingsDir)
      : path.join(userDataDir, "recordings");
    if (audioEvidenceReader === undefined) {
      audioEvidenceReader = new AudioEvidenceReader({ recordingsRoot: this.recordingsDir });
    }
    if (flacCompressionWorker === undefined && repository.captureEvidenceStore) {
      flacCompressionWorker = new FlacCompressionWorker({
        store: repository.captureEvidenceStore,
        recordingsRoot: this.recordingsDir,
        reader: audioEvidenceReader,
      });
    }
    if (
      flacCompressionWorker !== null &&
      flacCompressionWorker !== undefined &&
      typeof flacCompressionWorker.recoverStartup !== "function"
    ) {
      throw new TypeError("flacCompressionWorker.recoverStartup must be a function");
    }
    this.flacCompressionWorker = flacCompressionWorker ?? null;
    this.audioEvidenceReader = audioEvidenceReader;
    this.compressionRecovery = Promise.resolve({
      promoted: 0,
      deletedWavs: 0,
      removedInvalid: 0,
      rolledBack: 0,
    });
    this.compressionWork = Promise.resolve({ completed: 0, failed: 0, skipped: 0 });
    this.broadcast = broadcast;
    this.now = now;
    this.fs = fsImpl;
    this.storageGovernor =
      storageGovernor ??
      new StorageGovernor({
        reserve: {
          ensure() {},
          release() {},
        },
      });
    if (
      !this.storageGovernor ||
      typeof this.storageGovernor.inspect !== "function" ||
      typeof this.storageGovernor.evaluate !== "function" ||
      typeof this.storageGovernor.ensureReserve !== "function"
    ) {
      throw new TypeError("storageGovernor must provide ensureReserve, evaluate, and inspect methods");
    }
    this.emergencyCommit = false;
    this.migrationGate = migrationGate;
    this.vadClassifier = vadClassifier;
    this.maxVadQueueBytes = Math.round(
      (WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE * maxVadQueueMs) / 1_000
    );
    this.vadTimeoutMs = vadTimeoutMs;
    this.retentionGeneration = 0;
    this.retentionWork = new Set();
    this.vadSessionReset = false;
    this.interruptingSources = new Set();
    this.writer = null;
    this.closing = false;
    this.closed = false;
    this.completedRestorations = new Map();
    this.state = this._idleState();
  }

  startCapture(input) {
    this._assertOpen();
    this.migrationGate?.assertProducerAllowed("capture");
    const normalized = normalizeCaptureStartInput(input);
    const id = assertId(normalized.sessionId, "sessionId");
    this.vadSessionReset = false;
    this._assertTime(normalized.startedAt, "startedAt");
    if (
      this.writer ||
      ACTIVE_SESSION_STATUSES.has(this.state.status) ||
      this.state.status === "paused"
    ) {
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
    const persistedRetentionMode = session.retention_mode ?? null;
    if (persistedRetentionMode !== null && persistedRetentionMode !== normalized.retentionMode) {
      throw new Error("retention mode does not match persisted session");
    }
    const persistedCapturePolicy = parseCapturePolicyJson(session.capture_policy_json);
    if (
      session.capture_policy_json !== null &&
      session.capture_policy_json !== undefined &&
      JSON.stringify(persistedCapturePolicy) !== JSON.stringify(normalized.capturePolicy)
    ) {
      throw new Error("capture policy does not match persisted session");
    }

    this.storageGovernor.ensureReserve();
    this.fs.mkdirSync(this.recordingsDir, { recursive: true });
    this.completedRestorations.clear();
    this.retentionGeneration += 1;
    const classifierReady = this._isVadReady();
    const effectiveRetentionMode =
      normalized.retentionMode === "speech_triggered" && classifierReady
        ? "speech_triggered"
        : normalized.retentionMode === "continuous" && classifierReady
          ? "continuous"
          : "continuous_fallback";
    const sources = {};
    for (const source of normalized.sources) {
      const gate = new SpeechTriggeredCaptureGate({
        sampleRate: WAV_SAMPLE_RATE,
        ...normalized.capturePolicy,
        mode: normalized.retentionMode,
      });
      if (!classifierReady) {
        gate.reportVadFailure(
          source.sourceType,
          new Error("VAD unavailable"),
          normalized.startedAt
        );
      }
      sources[source.sourceType] = {
        ...source,
        trackId: `track-${crypto.randomUUID()}`,
        state: "active",
        gapId: null,
        interruptedAt: null,
        reason: null,
        errorCode: null,
        gate,
        timelineAnchorAt: normalized.startedAt,
        timelineFrames: 0,
        captureCursorAt: normalized.startedAt,
        vadQueue: [],
        vadQueueBytes: 0,
        vadInFlight: null,
        vadProcessing: false,
        vadProcessingGeneration: null,
        vadGeneration: this.retentionGeneration,
        writerOpen: effectiveRetentionMode !== "speech_triggered",
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
      retentionMode: normalized.retentionMode,
      effectiveRetentionMode,
      retentionDegradedReason: classifierReady ? null : "vad_unavailable",
      capturePolicy: normalized.capturePolicy,
      sources,
    };

    try {
      this._assertSafeDiskSpace();
      this.writer = this._createWriter(id, path.join(this.recordingsDir, id), {
        openSources: effectiveRetentionMode !== "speech_triggered",
      });
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

  async prepareStorageMigration() {
    if (this.writer || ["recording", "degraded", "paused", "finalizing"].includes(this.state.status)) {
      throw new Error("capture must be inactive before storage migration");
    }
    await Promise.allSettled([this.compressionRecovery, this.compressionWork]);
    if (this.retentionWork.size > 0) {
      await Promise.allSettled([...this.retentionWork]);
    }
  }

  reconfigureStorage({ recordingsDir }) {
    if (this.writer || ["recording", "degraded", "paused", "finalizing"].includes(this.state.status)) {
      throw new Error("capture must be inactive before storage migration");
    }
    if (typeof recordingsDir !== "string" || !path.isAbsolute(recordingsDir)) {
      throw new TypeError("recordingsDir must be absolute");
    }
    this.recordingsDir = path.resolve(recordingsDir);
    this.fs.mkdirSync(this.recordingsDir, { recursive: true });
    this.audioEvidenceReader = new AudioEvidenceReader({ recordingsRoot: this.recordingsDir });
    this.flacCompressionWorker = this.repository.captureEvidenceStore
      ? new FlacCompressionWorker({
          store: this.repository.captureEvidenceStore,
          recordingsRoot: this.recordingsDir,
          reader: this.audioEvidenceReader,
        })
      : null;
    return this.recordingsDir;
  }

  appendPcm(sessionId, sourceType, pcmBuffer) {
    if (this.closing || this.closed) return false;
    const id = assertId(sessionId, "sessionId");
    const type = assertSourceType(sourceType);
    if (id !== this.state.sessionId) throw new Error("capture session mismatch");
    if (this.state.status === "failed" || this.state.status === "paused") return false;
    const source = this.state.sources[type];
    if (!source) throw new Error(`capture source was not requested: ${type}`);
    if (source.state !== "active") return false;
    if (!ACTIVE_SESSION_STATUSES.has(this.state.status) || !this.writer) {
      throw new Error("capture session is not recording");
    }
    const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer ?? []);
    if (pcm.length % WAV_BYTES_PER_SAMPLE !== 0) {
      throw new RangeError("PCM must contain complete signed 16-bit little-endian samples");
    }
    if (pcm.length === 0) return true;

    const frames = this._retentionFrames(source, pcm);
    for (const frame of frames) {
      if (this.state.effectiveRetentionMode === "speech_triggered") {
        if (!this._enqueueVadFrame(source, frame, true)) return false;
        continue;
      }

      if (!this._appendRetainedPcm(source, frame)) return false;
      if (this.state.effectiveRetentionMode === "continuous" && this._isVadReady()) {
        if (!this._enqueueVadFrame(source, frame, false)) return false;
      } else if (this.state.effectiveRetentionMode === "continuous_fallback") {
        // Audio is already fail-open durable. Feed deterministic placeholder probability only
        // to accumulate truthful degraded audio levels without running inference inline.
        source.gate.accept({
          sourceType: source.sourceType,
          pcm: frame.pcm,
          capturedAt: frame.startedAt,
          speechProbability: 0,
        });
      }
    }
    return true;
  }

  appendMicPcm(sessionId, pcmBuffer) {
    return this.appendPcm(sessionId, "mic", pcmBuffer);
  }

  async whenRetentionIdle() {
    while (this.retentionWork.size > 0) {
      await Promise.allSettled([...this.retentionWork]);
    }
  }

  setRetentionMode(sessionId, retentionMode, at = this.now()) {
    this._assertOpen();
    this._assertActive(sessionId, ["recording", "degraded", "paused"]);
    const requestedMode = assertRetentionMode(retentionMode);
    this._assertTime(at, "at");
    if (requestedMode === this.state.retentionMode) return this._publish(at);

    this.repository.setSessionRetention(
      this.state.sessionId,
      requestedMode,
      this.state.capturePolicy
    );
    this.state.retentionMode = requestedMode;
    try {
      this.retentionGeneration += 1;
      const generation = this.retentionGeneration;
      for (const source of Object.values(this.state.sources)) {
        const pending = this._cancelSourceVad(source);
        const gateDecision = source.gate.switchMode(source.sourceType, requestedMode, at);
        if (!this._applyGateDecision(source, gateDecision)) {
          return this._failRetentionSwitch(at);
        }
        for (const frame of pending.filter((entry) => entry.persistOnDecision)) {
          if (!this._appendRetainedPcm(source, frame)) {
            return this._failRetentionSwitch(at);
          }
        }
        if (requestedMode === "speech_triggered" && source.state === "active") {
          try {
            this._closeRetentionWriter(source, source.captureCursorAt);
          } catch (error) {
            this._handleAudioWriteFailure(source, error, source.captureCursorAt);
            return this._failRetentionSwitch(at);
          }
        }
        this._resetSourceVadRuntime(source, generation);
      }

      const classifierReady = this._isVadReady();
      this.state.effectiveRetentionMode = classifierReady ? requestedMode : "continuous_fallback";
      this.state.retentionDegradedReason = classifierReady ? null : "vad_unavailable";
      if (!classifierReady) {
        for (const source of Object.values(this.state.sources)) {
          if (
            !this._applyGateDecision(
              source,
              source.gate.reportVadFailure(source.sourceType, new Error("VAD unavailable"), at)
            )
          ) {
            return this._failRetentionSwitch(at);
          }
        }
      }
    } catch {
      return this._failRetentionSwitch(at);
    }
    return this._publish(at);
  }

  reportVadRecovered(at = this.now()) {
    if (this.closing || this.closed || !this._isVadReady()) {
      return this._publicState(at);
    }
    if (!ACTIVE_SESSION_STATUSES.has(this.state.status) && this.state.status !== "paused") {
      return this._publicState(at);
    }
    this._assertTime(at, "at");
    if (this.state.effectiveRetentionMode !== "continuous_fallback") {
      return this._publicState(at);
    }

    this.retentionGeneration += 1;
    const generation = this.retentionGeneration;
    for (const source of Object.values(this.state.sources)) {
      const pending = this._cancelSourceVad(source);
      for (const frame of pending.filter((entry) => entry.persistOnDecision)) {
        if (!this._appendRetainedPcm(source, frame)) return this._publicState(at);
      }
      if (
        !this._applyGateDecision(
          source,
          source.gate.reportVadRecovered(source.sourceType, source.captureCursorAt)
        )
      ) {
        return this._publicState(at);
      }
      if (this.state.retentionMode === "speech_triggered") {
        try {
          this._closeRetentionWriter(source, source.captureCursorAt);
        } catch (error) {
          this._handleAudioWriteFailure(source, error, source.captureCursorAt);
          return this._publicState(at);
        }
      }
      this._resetSourceVadRuntime(source, generation);
    }
    this.state.effectiveRetentionMode = this.state.retentionMode;
    this.state.retentionDegradedReason = null;
    return this._publish(at);
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
    if (restoration.sourceType !== undefined && restoration.sourceType !== source.sourceType) {
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
    this._resetSourceAfterBoundary(source, restoration.at);
    if (this.state.effectiveRetentionMode !== "speech_triggered") {
      this.writer.reopenSource(source.sourceType, {
        id: source.trackId,
        startedAt: restoration.at,
      });
      source.writerOpen = true;
    }
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
        source.writerOpen = false;
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
    if (!this._flushRetentionBoundary(at)) {
      return this.state.status === "failed" ? this._publicState(at) : this._failForAudioWrite(at);
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
      for (const source of Object.values(this.state.sources)) source.writerOpen = false;
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      return diskError ? this._failForDisk(diskError.code, at) : this._failForAudioWrite(at);
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
    this.storageGovernor.ensureReserve();
    try {
      this._assertSafeDiskSpace();
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      if (diskError && this.state.errorCode !== "capture_stopped_low_disk") {
        this.state.errorCode = "capture_stopped_low_disk";
        this._publish(at);
      }
      throw error;
    }
    const reopenedSourceTypes = [];
    try {
      for (const source of Object.values(this.state.sources)) {
        if (source.state !== "paused") continue;
        this._resetSourceAfterBoundary(source, at);
        if (this.state.effectiveRetentionMode !== "speech_triggered") {
          this.writer.reopenSource(source.sourceType, { id: source.trackId, startedAt: at });
          source.writerOpen = true;
          reopenedSourceTypes.push(source.sourceType);
        }
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
          this.state.sources[sourceType].writerOpen = false;
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
      if (!this._flushRetentionBoundary(at)) {
        return this.state.status === "failed" ? this._publicState(at) : this._failForAudioWrite(at);
      }
      try {
        this.writer.closeAll(at);
        for (const source of Object.values(this.state.sources)) source.writerOpen = false;
      } catch (error) {
        const diskError = this._findDiskSpaceError(error);
        return diskError ? this._failForDisk(diskError.code, at) : this._failForAudioWrite(at);
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
      if (!this._flushRetentionBoundary(at) && this.state.status === "failed") {
        return this._publicState(at);
      }
      try {
        this.writer.closeAll(at);
        for (const source of Object.values(this.state.sources)) source.writerOpen = false;
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
    this._reconcileLowDiskRecoveryRecords();
    this._reconcileChunkRecoverySidecars();
    if (this.flacCompressionWorker) {
      this.compressionRecovery = Promise.resolve()
        .then(() =>
          typeof this.audioEvidenceReader?.cleanupStaleTemporaryEvidence === "function"
            ? this.audioEvidenceReader.cleanupStaleTemporaryEvidence({
                getChunk: (id) =>
                  this.repository.getAudioChunk?.(id) ??
                  this.repository.captureEvidenceStore?.getChunk?.(id) ??
                  null,
              })
            : 0
        )
        .then(() => this.flacCompressionWorker.recoverStartup());
      this.compressionRecovery.catch(() => {});
      this.compressionWork = this.compressionWork
        .catch(() => {})
        .then(async () => {
          await this.compressionRecovery;
          return typeof this.flacCompressionWorker.runPending === "function"
            ? this.flacCompressionWorker.runPending()
            : { completed: 0, failed: 0, skipped: 0 };
        });
      this.compressionWork.catch(() => {});
    }
    return this.repository.recoverOpenSessions(at);
  }

  waitForCompressionRecovery() {
    return this.compressionRecovery;
  }

  waitForCompressionIdle() {
    return this.compressionWork;
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
        let flushFailed = false;
        if (["recording", "degraded", "paused"].includes(this.state.status)) {
          flushFailed = !this._flushRetentionBoundary(at);
          if (!this.writer) return;
        }
        try {
          this.writer.closeAll(at);
          for (const source of Object.values(this.state.sources)) source.writerOpen = false;
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
        if (flushFailed && ["recording", "degraded", "paused"].includes(this.state.status)) {
          this._finalizeCapture(at, {
            trackState: "failed",
            sessionStatus: "failed",
            errorCode: "AUDIO_WRITE_FAILED",
          });
          return;
        }
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
      retentionMode: null,
      effectiveRetentionMode: null,
      retentionDegradedReason: null,
      capturePolicy: null,
      sources: {},
    };
  }

  _isVadReady() {
    if (!this.vadClassifier) return false;
    if (typeof this.vadClassifier.isReady !== "function") return true;
    try {
      return this.vadClassifier.isReady() === true;
    } catch {
      return false;
    }
  }

  *_retentionFrames(source, pcm) {
    for (let offset = 0; offset < pcm.length; offset += VAD_FRAME_BYTES) {
      const slice = Buffer.from(
        pcm.subarray(offset, Math.min(offset + VAD_FRAME_BYTES, pcm.length))
      );
      const frames = slice.length / WAV_BYTES_PER_SAMPLE;
      const startedAt =
        source.timelineAnchorAt + Math.round((source.timelineFrames * 1_000) / WAV_SAMPLE_RATE);
      source.timelineFrames += frames;
      const endedAt =
        source.timelineAnchorAt + Math.round((source.timelineFrames * 1_000) / WAV_SAMPLE_RATE);
      source.captureCursorAt = endedAt;
      yield {
        sourceType: source.sourceType,
        pcm: slice,
        startedAt,
        endedAt,
      };
    }
  }

  _enqueueVadFrame(source, frame, persistOnDecision) {
    const queued = { ...frame, persistOnDecision };
    if (source.vadQueueBytes + queued.pcm.length > this.maxVadQueueBytes) {
      if (!this._degradeRetention("vad_queue_overflow", frame.startedAt)) return false;
      return !persistOnDecision || this._appendRetainedPcm(source, frame);
    }
    source.vadQueue.push(queued);
    source.vadQueueBytes += queued.pcm.length;
    this._scheduleVad(source);
    return true;
  }

  _scheduleVad(source) {
    if (source.vadProcessing || source.vadQueue.length === 0 || !this._isVadReady()) return;
    const generation = source.vadGeneration;
    source.vadProcessing = true;
    source.vadProcessingGeneration = generation;
    const work = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        while (source.vadQueue.length > 0 && source.vadGeneration === generation) {
          const frame = source.vadQueue.shift();
          source.vadInFlight = frame;
          let speechProbability;
          try {
            speechProbability = await this._classifyVad(source, frame, generation);
          } catch (error) {
            if (source.vadGeneration === generation) {
              this._degradeRetention("vad_unavailable", frame.startedAt, error);
            }
            return;
          }
          if (source.vadGeneration !== generation || source.vadInFlight !== frame) return;
          source.vadInFlight = null;
          source.vadQueueBytes = Math.max(0, source.vadQueueBytes - frame.pcm.length);
          const gateDecision = source.gate.accept({
            sourceType: source.sourceType,
            pcm: frame.pcm,
            capturedAt: frame.startedAt,
            speechProbability,
          });
          if (frame.persistOnDecision) {
            if (!this._applyGateDecision(source, gateDecision)) return;
          } else {
            if (!this._applyGateDecision(source, { ...gateDecision, writes: [] })) return;
          }
        }
      })
      .catch((error) => {
        if (source.vadGeneration === generation) {
          this._degradeRetention("vad_unavailable", source.captureCursorAt, error);
        }
      })
      .finally(() => {
        if (source.vadProcessingGeneration !== generation) return;
        source.vadProcessing = false;
        source.vadProcessingGeneration = null;
        if (source.vadQueue.length > 0) this._scheduleVad(source);
      });
    this.retentionWork.add(work);
    work.then(
      () => this.retentionWork.delete(work),
      () => this.retentionWork.delete(work)
    );
  }

  _classifyVad(source, frame, generation) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("VAD classification timed out")),
        this.vadTimeoutMs
      );
      timer.unref?.();
    });
    const classification = Promise.resolve().then(() =>
      this.vadClassifier.classify({
        sessionId: this.state.sessionId,
        sourceType: source.sourceType,
        streamId: `${this.state.sessionId}:${source.sourceType}:${generation}`,
        sampleRate: WAV_SAMPLE_RATE,
        pcm: Buffer.from(frame.pcm),
      })
    );
    return Promise.race([classification, timeout]).finally(() => clearTimeout(timer));
  }

  _cancelSourceVad(source) {
    const currentGeneration = Number.isSafeInteger(source.vadGeneration) ? source.vadGeneration : 0;
    if (this.state.sessionId) {
      this._resetVadStream(`${this.state.sessionId}:${source.sourceType}:${currentGeneration}`);
    }
    source.vadGeneration = currentGeneration + 1;
    const pending = [];
    if (source.vadInFlight) pending.push(source.vadInFlight);
    pending.push(...source.vadQueue);
    source.vadQueue = [];
    source.vadQueueBytes = 0;
    source.vadInFlight = null;
    source.vadProcessing = false;
    source.vadProcessingGeneration = null;
    return pending.sort((left, right) => left.startedAt - right.startedAt);
  }

  _cancelAllVadWork() {
    this.retentionGeneration += 1;
    const pendingBySource = new Map();
    for (const source of Object.values(this.state.sources)) {
      pendingBySource.set(source.sourceType, this._cancelSourceVad(source));
    }
    return pendingBySource;
  }

  _resetSourceVadRuntime(source, generation = this.retentionGeneration) {
    const currentGeneration = Number.isSafeInteger(source.vadGeneration) ? source.vadGeneration : 0;
    const minimumGeneration = Number.isSafeInteger(generation) ? generation : 0;
    source.vadGeneration = Math.max(currentGeneration + 1, minimumGeneration);
    source.vadQueue = [];
    source.vadQueueBytes = 0;
    source.vadInFlight = null;
    source.vadProcessing = false;
    source.vadProcessingGeneration = null;
  }

  _resetVadStream(streamId) {
    if (typeof this.vadClassifier?.reset !== "function") return;
    try {
      Promise.resolve(this.vadClassifier.reset(streamId)).catch(() => {});
    } catch {
      // VAD state cleanup is best effort and must not block synchronous capture control.
    }
  }

  _resetVadSessionOnce(sessionId) {
    if (
      !sessionId ||
      this.vadSessionReset ||
      typeof this.vadClassifier?.resetSession !== "function"
    ) {
      return;
    }
    this.vadSessionReset = true;
    try {
      Promise.resolve(this.vadClassifier.resetSession(sessionId)).catch(() => {});
    } catch {
      // VAD state cleanup is best effort and must not block synchronous finalization.
    }
  }

  _resetSourceAfterBoundary(source, at) {
    this._resetSourceVadRuntime(source);
    source.timelineAnchorAt = at;
    source.timelineFrames = 0;
    source.captureCursorAt = at;
    source.gate = new SpeechTriggeredCaptureGate({
      sampleRate: WAV_SAMPLE_RATE,
      ...this.state.capturePolicy,
      mode: this.state.retentionMode,
    });
    if (this.state.effectiveRetentionMode === "continuous_fallback") {
      source.gate.reportVadFailure(source.sourceType, new Error("VAD unavailable"), at);
    }
    source.writerOpen = this.writer?.hasSource?.(source.sourceType) ?? false;
  }

  _flushSourceRetentionBoundary(source, at) {
    const pending = this._cancelSourceVad(source);
    const boundaryAt = Math.max(source.captureCursorAt, Math.min(at, source.captureCursorAt));
    if (!this._applyGateDecision(source, source.gate.finish(source.sourceType, boundaryAt))) {
      return false;
    }
    for (const frame of pending) {
      if (frame.persistOnDecision && !this._appendRetainedPcm(source, frame)) return false;
    }
    return true;
  }

  _flushRetentionBoundary(at) {
    for (const source of Object.values(this.state.sources)) {
      if (!this._flushSourceRetentionBoundary(source, at)) {
        if (this.state.status === "failed" || !this.writer) return false;
        // A normal writer fault isolates only this source. Keep draining healthy lanes so
        // pause/finish can make one authoritative lifecycle transition for the session.
      }
    }
    return true;
  }

  _degradeRetention(reason, at, error = null) {
    try {
      this.vadClassifier?.reportFailure?.(error ?? new Error(reason));
    } catch {
      // The capture path still fails open if classifier invalidation itself fails.
    }
    if (
      this.closing ||
      this.closed ||
      (!ACTIVE_SESSION_STATUSES.has(this.state.status) && this.state.status !== "paused") ||
      !this.writer
    ) {
      return false;
    }
    if (this.state.effectiveRetentionMode === "continuous_fallback") {
      this.state.retentionDegradedReason = reason;
      return true;
    }
    const pendingBySource = this._cancelAllVadWork();
    this.state.effectiveRetentionMode = "continuous_fallback";
    this.state.retentionDegradedReason = reason;
    for (const source of Object.values(this.state.sources)) {
      const failed = source.gate.reportVadFailure(
        source.sourceType,
        error ?? new Error(reason),
        Math.min(source.captureCursorAt, Math.max(source.timelineAnchorAt, at))
      );
      if (!this._applyGateDecision(source, failed)) {
        if (this.state.status === "failed" || !this.writer) return false;
        continue;
      }
      for (const frame of pendingBySource.get(source.sourceType) || []) {
        if (frame.persistOnDecision && !this._appendRetainedPcm(source, frame)) {
          if (this.state.status === "failed" || !this.writer) return false;
          break;
        }
      }
    }
    try {
      this._publish(this.now());
    } catch {}
    return true;
  }

  _appendRetainedPcm(source, frame) {
    if (
      !this.writer ||
      source.state !== "active" ||
      !ACTIVE_SESSION_STATUSES.has(this.state.status)
    ) {
      return false;
    }
    try {
      if (!this.writer.hasSource(source.sourceType)) {
        this.writer.reopenSource(source.sourceType, {
          id: source.trackId,
          startedAt: frame.startedAt,
        });
        source.writerOpen = true;
      }
      this.writer.append(source.sourceType, frame.pcm);
      return true;
    } catch (error) {
      const durableEvidenceEnd = this._findEvidenceEndedAt(error);
      const evidenceEndedAt = Number.isSafeInteger(durableEvidenceEnd)
        ? Math.min(frame.endedAt, durableEvidenceEnd)
        : frame.startedAt;
      return this._handleAudioWriteFailure(
        source,
        error,
        Math.max(source.timelineAnchorAt, evidenceEndedAt)
      );
    }
  }

  _handleAudioWriteFailure(source, error, at) {
    const diskError = this._findDiskSpaceError(error);
    if (diskError) {
      this._failForDisk(diskError.code, at);
      return false;
    }
    this._cancelSourceVad(source);
    try {
      this._interruptSource(
        this.state.sessionId,
        source.sourceType,
        { at, reason: "audio-write-failed" },
        error
      );
    } catch {
      try {
        this._failForAudioWrite(at);
      } catch {}
    }
    return false;
  }

  _closeRetentionWriter(source, at) {
    if (!this.writer?.hasSource?.(source.sourceType)) {
      source.writerOpen = false;
      return;
    }
    this.writer.closeSource(source.sourceType, at);
    source.writerOpen = false;
  }

  _applyGateDecision(source, gateDecision) {
    let metadataError = null;
    for (const gap of gateDecision.gapsToCommit) {
      if (gap.reason === "silence_suppressed") {
        try {
          this._closeRetentionWriter(source, gap.startedAt);
        } catch (error) {
          return this._handleAudioWriteFailure(source, error, gap.startedAt);
        }
      }
      try {
        this._recordRetentionGap(source, gap);
      } catch (error) {
        metadataError = error;
        break;
      }
    }
    for (const write of gateDecision.writes) {
      if (!this._appendRetainedPcm(source, write)) return false;
    }
    if (metadataError) {
      this._failForCaptureEvidence(Math.max(source.captureCursorAt, this.now()));
      return false;
    }
    return true;
  }

  _recordRetentionGap(source, gap) {
    if (gap.endedAt <= gap.startedAt) return;
    this.repository.recordEvidenceGap({
      id: `gap-${crypto.randomUUID()}`,
      trackId: source.trackId,
      startedAt: gap.startedAt,
      endedAt: gap.endedAt,
      reason: gap.reason,
      averageLevel: gap.averageLevel,
      peakLevel: gap.peakLevel,
    });
  }

  _failForCaptureEvidence(at) {
    this._cancelAllVadWork();
    try {
      this.writer?.closeAll?.(at);
      for (const source of Object.values(this.state.sources)) source.writerOpen = false;
    } catch (error) {
      const diskError = this._findDiskSpaceError(error);
      return diskError ? this._failForDisk(diskError.code, at) : this._failForAudioWrite(at);
    }
    this.writer = null;
    try {
      return this._finalizeCapture(at, {
        trackState: "failed",
        sessionStatus: "failed",
        errorCode: "CAPTURE_EVIDENCE_FAILED",
      });
    } catch {
      return this._publicState(at);
    }
  }

  _failRetentionSwitch(at) {
    if (this.state.status === "paused" && this.state.errorCode === "capture_stopped_low_disk") {
      return this._publicState(at);
    }
    if (this.state.status === "failed") return this._publicState(at);
    this._cancelAllVadWork();
    try {
      this.writer?.closeAll?.(at);
      for (const source of Object.values(this.state.sources)) source.writerOpen = false;
    } catch {
      this.writer?.abortAll?.();
    }
    this.writer = null;
    try {
      return this._finalizeCapture(at, {
        trackState: "failed",
        sessionStatus: "failed",
        errorCode: "RETENTION_SWITCH_FAILED",
      });
    } catch {
      return this._publicState(at);
    }
  }

  _createWriter(sessionId, baseDir, { openSources = true } = {}) {
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
      beforeChunk: (pendingWriteBytes = 0) => this._assertSafeDiskSpace(pendingWriteBytes),
      openSources,
      onChunk: (chunk) => {
        if (this.closed) return null;
        const committed = this.repository.commitChunk({
          ...chunk,
          fileBytes: this.fs.statSync(chunk.path).size,
          expiresAt: chunk.endedAt + AUDIO_RETENTION_MS,
          format: "wav",
          sampleRate: WAV_SAMPLE_RATE,
          channels: 1,
          encoderVersion: FLAC_ENCODER_VERSION,
        });
        this._scheduleCompressionWork();
        return committed;
      },
    });
  }

  _scheduleCompressionWork() {
    if (
      !this.flacCompressionWorker ||
      typeof this.flacCompressionWorker.runPending !== "function"
    ) {
      return;
    }
    this.compressionWork = this.compressionWork
      .catch(() => {})
      .then(() => this.flacCompressionWorker.runPending());
    this.compressionWork.catch(() => {});
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
        const evidenceDirectories = [];
        const quarantineDir = this._recoveryDirectory(sourceDir, "recovery");
        if (quarantineDir) evidenceDirectories.push(quarantineDir);
        evidenceDirectories.push(sourceDir);

        for (const evidenceDir of evidenceDirectories) {
          let sidecarEntries;
          try {
            sidecarEntries = this.fs
              .readdirSync(evidenceDir, { withFileTypes: true })
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
                sourceDir: evidenceDir,
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
    if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(RECOVERY_SIDECAR_KEYS)) {
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
    if (wavStat.size <= WAV_HEADER_BYTES || wavStat.size > WAV_HEADER_BYTES + MAX_CHUNK_PCM_BYTES) {
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
      fileBytes: this.fs.statSync(wavRealPath).size,
      format: "wav",
      sampleRate: WAV_SAMPLE_RATE,
      channels: 1,
      encoderVersion: FLAC_ENCODER_VERSION,
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
      const matches =
        key === "path" ? this._samePath(existing[key], value) : existing[key] === value;
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
    if (source.state !== "active")
      throw new Error(`capture source is not active: ${source.sourceType}`);

    if (!writerError && !this._flushSourceRetentionBoundary(source, at)) {
      return this._publicState(at);
    }
    if (source.state === "reconnecting" || this.state.status === "failed") {
      return this._publicState(at);
    }
    if (this.interruptingSources.has(source.sourceType)) return this._publicState(at);
    this.interruptingSources.add(source.sourceType);

    try {
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
        this.writer?.closeSource?.(source.sourceType, at);
        source.writerOpen = false;
      } catch (error) {
        closeError ??= error;
        const diskError = this._findDiskSpaceError(error);
        if (diskError) return this._failForDisk(diskError.code, at);
      }
      source.errorCode = closeError ? "AUDIO_WRITE_FAILED" : null;
      this._transitionSessionStatus("degraded", at);
      return this._publish(at);
    } finally {
      this.interruptingSources.delete(source.sourceType);
    }
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

  _assertSafeDiskSpace(pendingWriteBytes = 0) {
    if (this.emergencyCommit) return;
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
    let inspection;
    try {
      inspection = this.storageGovernor.inspect({
        volumeBytes: totalBytes,
        freeBytes,
        pendingWriteBytes,
      });
    } catch {
      throw new DiskSpaceError("DISK_SPACE_CHECK_FAILED");
    }
    if (inspection.state === "stopped") {
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

  _findEvidenceEndedAt(error) {
    let endedAt = Number.isSafeInteger(error?.evidenceEndedAt) ? error.evidenceEndedAt : null;
    if (error instanceof AggregateError) {
      for (const nested of error.errors) {
        const nestedEndedAt = this._findEvidenceEndedAt(nested);
        if (Number.isSafeInteger(nestedEndedAt)) {
          endedAt = endedAt === null ? nestedEndedAt : Math.max(endedAt, nestedEndedAt);
        }
      }
    }
    const causeEndedAt = error?.cause ? this._findEvidenceEndedAt(error.cause) : null;
    if (Number.isSafeInteger(causeEndedAt)) {
      endedAt = endedAt === null ? causeEndedAt : Math.max(endedAt, causeEndedAt);
    }
    return endedAt;
  }

  _failForDisk(code, at, durableSources) {
    if (
      code === "DISK_SPACE_LOW" &&
      this.writer &&
      ACTIVE_SESSION_STATUSES.has(this.state.status)
    ) {
      return this._stopForLowDisk(at);
    }
    this.writer?.abortAll?.();
    this.writer = null;
    return this._finalizeCapture(at, {
      trackState: "failed",
      sessionStatus: "failed",
      errorCode: code,
      durableSources,
    });
  }

  _stopForLowDisk(at) {
    this._cancelAllVadWork();
    const durableStop = {
      sessionId: this.state.sessionId,
      sources: Object.values(this.state.sources).map((source) => ({
        trackId: source.trackId,
        expectedState: source.state === "reconnecting" ? "recovering" : source.state,
      })),
      at,
    };
    this.emergencyCommit = true;
    try {
      this.writer.closeAll(at);
      for (const source of Object.values(this.state.sources)) source.writerOpen = false;
    } catch (error) {
      // AudioChunkWriter quarantines the completed WAV and its durable sidecar when SQLite
      // commit fails. Never report that evidence as saved in this process.
      this.writer = null;
      for (const source of Object.values(this.state.sources)) source.writerOpen = false;
      this._transitionSessionStatus("paused", at);
      this.state.errorCode = "capture_stopped_low_disk";
      try {
        this.repository.pauseCaptureForLowDisk(durableStop);
      } catch (pauseError) {
        try {
          this._writeLowDiskRecoveryRecord(durableStop);
        } catch (recoveryError) {
          error.lowDiskPauseError = pauseError;
          error.lowDiskRecoveryError = recoveryError;
        }
      }
      for (const source of Object.values(this.state.sources)) {
        if (source.state === "active") source.state = "paused";
      }
      this._publish(at);
      throw error;
    } finally {
      this.emergencyCommit = false;
    }
    try {
      this.repository.pauseCaptureForLowDisk(durableStop);
    } catch (error) {
      this._writeLowDiskRecoveryRecord(durableStop);
      for (const source of Object.values(this.state.sources)) {
        if (source.state === "active") source.state = "paused";
      }
      this._transitionSessionStatus("paused", at);
      this.state.errorCode = "capture_stopped_low_disk";
      this._publish(at);
      throw error;
    }
    for (const source of Object.values(this.state.sources)) {
      if (source.state === "active") source.state = "paused";
    }
    this._transitionSessionStatus("paused", at);
    this.state.errorCode = "capture_stopped_low_disk";
    return this._publish(at);
  }

  _writeLowDiskRecoveryRecord({ sessionId, sources, at }) {
    const recoveryDir = path.join(this.recordingsDir, ".session-recovery");
    this.fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    const directoryStat = this.fs.lstatSync(recoveryDir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("low-disk recovery directory is unsafe");
    }
    const record = { version: LOW_DISK_RECOVERY_VERSION, sessionId, sources, at };
    const payload = Buffer.from(JSON.stringify(record), "utf8");
    if (payload.length > RECOVERY_SIDECAR_MAX_BYTES) {
      throw new Error("low-disk recovery record is too large");
    }
    const finalPath = path.join(recoveryDir, `${crypto.randomUUID()}.json`);
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    let handle = null;
    try {
      handle = this.fs.openSync(temporaryPath, "wx", 0o600);
      this.fs.writeFileSync(handle, payload);
      this.fs.fsyncSync(handle);
      this.fs.closeSync(handle);
      handle = null;
      this.fs.renameSync(temporaryPath, finalPath);
      this._fsyncRecoveryDirectory(recoveryDir);
    } catch (error) {
      if (handle !== null) this.fs.closeSync(handle);
      try {
        this.fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
      }
      throw error;
    }
  }

  _reconcileLowDiskRecoveryRecords() {
    const recoveryDir = path.join(this.recordingsDir, ".session-recovery");
    let names;
    try {
      const directoryStat = this.fs.lstatSync(recoveryDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("low-disk recovery directory is unsafe");
      }
      names = this.fs.readdirSync(recoveryDir).sort();
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || !this._isDirectChild(recoveryDir, path.join(recoveryDir, name))) {
        throw new Error("low-disk recovery directory contains an unexpected entry");
      }
      const recordPath = path.join(recoveryDir, name);
      const stat = this.fs.lstatSync(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > RECOVERY_SIDECAR_MAX_BYTES) {
        throw new Error("low-disk recovery record is unsafe");
      }
      const record = JSON.parse(this.fs.readFileSync(recordPath, "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...LOW_DISK_RECOVERY_KEYS]) ||
        record.version !== LOW_DISK_RECOVERY_VERSION ||
        !Number.isSafeInteger(record.at) ||
        !Array.isArray(record.sources)
      ) {
        throw new Error("low-disk recovery record is invalid");
      }
      assertId(record.sessionId, "sessionId");
      const session = this.repository.getSession(record.sessionId);
      if (
        session?.status !== "paused" ||
        session?.stop_reason !== "capture_stopped_low_disk" ||
        session?.durable_boundary_at !== record.at
      ) {
        this.repository.pauseCaptureForLowDisk(record);
      }
      this.fs.unlinkSync(recordPath);
      this._fsyncRecoveryDirectory(recoveryDir);
    }
  }

  _fsyncRecoveryDirectory(directory) {
    let handle = null;
    try {
      handle = this.fs.openSync(directory, "r");
      this.fs.fsyncSync(handle);
    } catch (error) {
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    } finally {
      if (handle !== null) this.fs.closeSync(handle);
    }
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

  _finalizeCapture(at, { trackState, sessionStatus, errorCode, durableSources = null }) {
    this._cancelAllVadWork();
    this._resetVadSessionOnce(this.state.sessionId);
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
      retentionMode: this.state.retentionMode,
      effectiveRetentionMode: this.state.effectiveRetentionMode,
      retentionDegradedReason: this.state.retentionDegradedReason,
      capturePolicy: this.state.capturePolicy,
      sources: Object.fromEntries(
        Object.entries(this.state.sources).map(([sourceType, source]) => {
          const {
            gate: _gate,
            vadQueue: _vadQueue,
            vadInFlight: _vadInFlight,
            vadProcessing: _vadProcessing,
            vadProcessingGeneration: _vadProcessingGeneration,
            vadGeneration: _vadGeneration,
            timelineAnchorAt: _timelineAnchorAt,
            timelineFrames: _timelineFrames,
            ...publicSource
          } = source;
          return [sourceType, publicSource];
        })
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
