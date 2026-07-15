const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertCaptureFailureCode,
  assertSourceType,
  assertRetentionMode,
} = require("../shared/contracts");
const { normalizeCaptureStartInput } = require("../shared/captureModes");
const { toPublicAudioChunk, toPublicSessionDetail } = require("./AudioChunkPublicView");
const path = require("node:path");

const REQUIRED_REPOSITORY_METHODS = [
  "createSession",
  "setSessionStatus",
  "getSession",
  "listSessions",
  "upsertTranscriptSegments",
  "syncTranscriptSegments",
  "listTranscriptSegments",
  "renamePerson",
  "listPeople",
  "listAudioChunks",
  "getSessionTimeline",
  "getCloudBudgetStatus",
  "setCloudBudgetSettings",
];

const REQUIRED_SERVICE_METHODS = [
  "startCapture",
  "setRetentionMode",
  "sourceInterrupted",
  "sourceRestored",
  "pauseCapture",
  "resumeCapture",
  "finishCapture",
  "failCapture",
];

function assertExactKeys(input, expected, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(input).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new TypeError(`${name} has an invalid structure`);
  }
}

function assertLifecycleTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("source lifecycle at must be a non-negative safe integer");
  }
  return value;
}

function assertLifecycleString(value, name, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new TypeError(`${name} must be non-empty and at most ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeSourceInterruption(input) {
  assertExactKeys(input, ["at", "reason"], "source interruption");
  return {
    at: assertLifecycleTime(input.at),
    reason: assertLifecycleString(input.reason, "source interruption reason", 128),
  };
}

function normalizeSourceRestoration(input) {
  assertExactKeys(input, ["at", "deviceId", "deviceLabel", "strategy"], "source restoration");
  return {
    at: assertLifecycleTime(input.at),
    deviceId: assertLifecycleString(input.deviceId, "source deviceId", 512, {
      nullable: true,
    }),
    deviceLabel: assertLifecycleString(input.deviceLabel, "source deviceLabel", 512, {
      nullable: true,
    }),
    strategy: assertLifecycleString(input.strategy, "source strategy", 128, {
      nullable: true,
    }),
  };
}

function unavailableProcessingStatus() {
  return {
    pending: 0,
    running: 0,
    retry: 0,
    blocked: 0,
    total: 0,
    byStage: {},
    backlogMs: 0,
    oldestCreatedAt: null,
    latestExecutionDevice: null,
    finalCoveragePct: null,
    provisionalCoveragePct: null,
  };
}

function nextRecoveryAction({ capture, resources, queue, disk }) {
  if (disk.state === "critical" || disk.state === "stopped") return "free_disk";
  if (capture.status === "degraded") return "restore_microphone";
  if (resources.state === "busy") return "wait_for_gpu";
  if (resources.state === "unavailable") return "check_cuda";
  if (queue.blocked > 0 || queue.retry > 0) return "retry_jobs";
  return null;
}

function registerJarvisIpc({
  ipcMain,
  repository,
  service,
  voiceEnrollmentService,
  environmentManager,
  analysisScheduler,
  audioEvidenceReader,
  storageManager,
  pickStorageDirectory,
  processingLifecycle = null,
  now = Date.now,
}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("ipcMain with a handle method is required");
  }
  if (!repository || typeof repository !== "object") {
    throw new TypeError("repository is required");
  }
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
  if (!service || typeof service !== "object") {
    throw new TypeError("service is required");
  }
  for (const method of REQUIRED_SERVICE_METHODS) {
    if (typeof service[method] !== "function") {
      throw new TypeError(`service.${method} must be a function`);
    }
  }
  for (const method of ["getStatus", "begin", "complete", "cancel", "cancelOwner"]) {
    if (!voiceEnrollmentService || typeof voiceEnrollmentService[method] !== "function") {
      throw new TypeError(`voiceEnrollmentService.${method} must be a function`);
    }
  }
  if (!environmentManager || typeof environmentManager.getOpenAIKey !== "function") {
    throw new TypeError("environmentManager.getOpenAIKey must be a function");
  }

  const cloudBudgetStatus = () => ({
    ...repository.getCloudBudgetStatus(),
    keyConfigured: Boolean(environmentManager.getOpenAIKey()),
  });

  const enrollmentOwnerListeners = new WeakSet();
  const bindEnrollmentOwner = (event) => {
    const sender = event?.sender;
    if (!sender || typeof sender !== "object" || enrollmentOwnerListeners.has(sender)) return;
    if (typeof sender.once !== "function") return;
    const ownerId = sender.id;
    enrollmentOwnerListeners.add(sender);
    sender.once("destroyed", () => {
      try {
        voiceEnrollmentService.cancelOwner(ownerId);
      } catch {
        // Renderer destruction cleanup is best-effort and must not escape Electron's event loop.
      }
    });
  };

  ipcMain.handle(CHANNELS.createSession, (_event, input) => repository.createSession(input));
  ipcMain.handle(CHANNELS.setSessionStatus, (_event, id, status, at) =>
    repository.setSessionStatus(assertId(id, "sessionId"), assertSessionStatus(status), at)
  );
  ipcMain.handle(CHANNELS.getSession, (_event, id) =>
    repository.getSession(assertId(id, "sessionId"))
  );
  ipcMain.handle(CHANNELS.listSessions, (_event, query) => repository.listSessions(query));
  ipcMain.handle(CHANNELS.upsertSegments, (_event, sessionId, segments) =>
    repository.upsertTranscriptSegments(assertId(sessionId, "sessionId"), segments)
  );
  ipcMain.handle(CHANNELS.syncSegments, (_event, sessionId, segments) =>
    repository.syncTranscriptSegments(assertId(sessionId, "sessionId"), segments)
  );
  ipcMain.handle(CHANNELS.listSegments, (_event, sessionId) =>
    repository.listTranscriptSegments(assertId(sessionId, "sessionId"))
  );
  ipcMain.handle(CHANNELS.renamePerson, (_event, input) => repository.renamePerson(input));
  ipcMain.handle(CHANNELS.listPeople, () => repository.listPeople());
  ipcMain.handle(CHANNELS.listAudioChunks, (_event, sessionId) =>
    repository.listAudioChunks(assertId(sessionId, "sessionId")).map(toPublicAudioChunk)
  );
  ipcMain.handle(CHANNELS.readAudioChunk, async (_event, audioChunkId) => {
    const chunk = repository.getAudioChunk(assertId(audioChunkId, "audioChunkId"));
    if (!chunk || chunk.deleted_at != null) return null;
    try {
      const currentReader = service.audioEvidenceReader ?? audioEvidenceReader;
      if (!currentReader || typeof currentReader.readPlayableWav !== "function") {
        throw new Error("verified audio reader is unavailable");
      }
      return await currentReader.readPlayableWav(chunk);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle(CHANNELS.getSessionDetail, (_event, sessionId) =>
    toPublicSessionDetail(repository.getSessionDetail(assertId(sessionId, "sessionId")))
  );
  ipcMain.handle(CHANNELS.getSessionTimeline, (_event, sessionId) => {
    const timeline = repository.getSessionTimeline(assertId(sessionId, "sessionId"));
    if (!timeline) return null;
    const activeCapture = typeof service.getState === "function" ? service.getState() : null;
    const activelyRecording =
      activeCapture?.status === "recording" || activeCapture?.status === "degraded";
    const previewStatus =
      timeline.status === "recording" &&
      activelyRecording &&
      activeCapture.sessionId === timeline.session_id
        ? (processingLifecycle?.runtime?.previewStatus?.() ?? null)
        : null;
    return {
      ...timeline,
      chunks: timeline.chunks.map(toPublicAudioChunk),
      preview_status: previewStatus,
    };
  });
  ipcMain.handle(CHANNELS.getRuntimeStatus, async () => {
    const observedAt = now();
    const captureState = typeof service.getState === "function" ? service.getState() : null;
    const capture = {
      sessionId: captureState?.sessionId ?? null,
      status: captureState?.status ?? "idle",
      captureMode: captureState?.captureMode ?? null,
      retentionMode: captureState?.retentionMode ?? null,
      errorCode: captureState?.errorCode ?? null,
    };
    const runtime = processingLifecycle?.runtime ?? null;
    const preview = runtime?.previewStatus?.() ?? null;
    const resourceSnapshot = runtime?.governor?.latestSnapshot ?? null;
    const resources = resourceSnapshot
      ? {
          sampledAt: resourceSnapshot.sampledAt ?? null,
          state: resourceSnapshot.state ?? "unavailable",
          reason: resourceSnapshot.reason ?? "unknown",
          cudaInstalled: resourceSnapshot.cudaInstalled === true,
          cudaVerified: resourceSnapshot.cudaVerified === true,
          cudaQuarantined: resourceSnapshot.cudaQuarantined === true,
        }
      : {
          sampledAt: null,
          state: "unavailable",
          reason: "not_sampled",
          cudaInstalled: null,
          cudaVerified: null,
          cudaQuarantined: null,
        };
    const processing =
      typeof repository.getRuntimeProcessingStatus === "function"
        ? repository.getRuntimeProcessingStatus(observedAt)
        : unavailableProcessingStatus();
    const queue = {
      pending: processing.pending,
      running: processing.running,
      retry: processing.retry,
      blocked: processing.blocked,
      total: processing.total,
      byStage: processing.byStage,
      backlogMinutes: processing.backlogMs / 60_000,
      oldestJobAgeMs:
        processing.oldestCreatedAt === null
          ? null
          : Math.max(0, observedAt - processing.oldestCreatedAt),
      finalCoveragePct: processing.finalCoveragePct,
      provisionalCoveragePct: processing.provisionalCoveragePct,
    };
    const storage =
      storageManager && typeof storageManager.getStatus === "function"
        ? await storageManager.getStatus()
        : null;
    const disk = {
      state: storage?.state ?? "unavailable",
      freeBytes: storage?.freeBytes ?? null,
      remainingDays: storage?.remainingDays ?? null,
      recoveryAction: storage?.recoveryAction ?? null,
    };
    const backend = {
      actualBackend: processing.latestExecutionDevice ?? preview?.executionDevice ?? null,
      cudaGpuUuid:
        resourceSnapshot?.cudaVerified === true ? (resourceSnapshot.selectedGpuUuid ?? null) : null,
    };
    return {
      observedAt,
      capture,
      backend,
      resources,
      queue,
      preview,
      disk,
      nextRecoveryAction: nextRecoveryAction({ capture, resources, queue, disk }),
    };
  });
  ipcMain.handle(CHANNELS.searchMemory, (_event, query, limit) => {
    if (typeof query !== "string") throw new TypeError("query must be a string");
    return query.trim()
      ? repository.searchMemory(query, limit)
      : repository.listSessions({ limit: limit ?? 100 });
  });
  ipcMain.handle(CHANNELS.listPeopleOverview, () => repository.listPeopleOverview());
  ipcMain.handle(CHANNELS.getPersonDetail, (_event, personId) =>
    repository.getPersonDetail(assertId(personId, "personId"))
  );
  ipcMain.handle(CHANNELS.listTopics, () => repository.listTopics());
  ipcMain.handle(CHANNELS.getTopicDetail, (_event, topicId) =>
    repository.getTopicDetail(assertId(topicId, "topicId"))
  );
  ipcMain.handle(CHANNELS.renameTopic, (_event, topicId, title) =>
    repository.renameTopic(assertId(topicId, "topicId"), title)
  );
  ipcMain.handle(CHANNELS.listTodos, (_event, status) => repository.listTodos(status ?? null));
  ipcMain.handle(CHANNELS.setTodoStatus, (_event, todoId, status) => {
    if (status !== "open" && status !== "completed") throw new TypeError("invalid todo status");
    return repository.setTodoStatus(assertId(todoId, "todoId"), status);
  });
  ipcMain.handle(CHANNELS.listMemories, (_event, limit) => repository.listMemories(limit ?? 200));
  ipcMain.handle(CHANNELS.getTodayInsights, (_event, sessionId) =>
    repository.getTodayInsights(assertId(sessionId, "sessionId"))
  );
  if (analysisScheduler) {
    ipcMain.handle(CHANNELS.analyzeSession, (_event, sessionId, kind) =>
      analysisScheduler.analyzeSession(assertId(sessionId, "sessionId"), kind ?? "incremental")
    );
    ipcMain.handle(CHANNELS.getAnalysisStatus, (_event, sessionId) =>
      analysisScheduler.getStatus(assertId(sessionId, "sessionId"))
    );
  }
  if (
    typeof environmentManager.getMiniMaxKey === "function" &&
    typeof environmentManager.saveMiniMaxKey === "function"
  ) {
    const miniMaxConfig = () => ({
      keyConfigured: Boolean(environmentManager.getMiniMaxKey()),
      model: process.env.MINIMAX_MODEL || "MiniMax-M2.7",
    });
    ipcMain.handle(CHANNELS.getMiniMaxConfig, miniMaxConfig);
    ipcMain.handle(CHANNELS.setMiniMaxKey, (_event, key) => {
      if (typeof key !== "string" || !key.trim() || key.length > 512) {
        throw new TypeError("MiniMax key must be a non-empty string");
      }
      environmentManager.saveMiniMaxKey(key.trim());
      return miniMaxConfig();
    });
  }
  ipcMain.handle(CHANNELS.startCapture, (_event, input) =>
    service.startCapture(normalizeCaptureStartInput(input))
  );
  ipcMain.handle(CHANNELS.setRetentionMode, (_event, id, retentionMode, at) =>
    service.setRetentionMode(assertId(id, "sessionId"), assertRetentionMode(retentionMode), at)
  );
  ipcMain.handle(CHANNELS.sourceInterrupted, (_event, id, sourceType, input) =>
    service.sourceInterrupted(
      assertId(id, "sessionId"),
      assertSourceType(sourceType),
      normalizeSourceInterruption(input)
    )
  );
  ipcMain.handle(CHANNELS.sourceRestored, (_event, id, sourceType, input) =>
    service.sourceRestored(
      assertId(id, "sessionId"),
      assertSourceType(sourceType),
      normalizeSourceRestoration(input)
    )
  );
  ipcMain.handle(CHANNELS.pauseCapture, (_event, id, at, errorCode) =>
    service.pauseCapture(assertId(id, "sessionId"), at, errorCode)
  );
  ipcMain.handle(CHANNELS.resumeCapture, (_event, id, at) =>
    service.resumeCapture(assertId(id, "sessionId"), at)
  );
  ipcMain.handle(CHANNELS.finishCapture, (_event, id, at) =>
    service.finishCapture(assertId(id, "sessionId"), at)
  );
  ipcMain.handle(CHANNELS.failCapture, (_event, id, errorCode, at) =>
    service.failCapture(assertId(id, "sessionId"), assertCaptureFailureCode(errorCode), at)
  );
  ipcMain.handle(CHANNELS.beginVoiceEnrollment, (event) => {
    bindEnrollmentOwner(event);
    return voiceEnrollmentService.begin({ ownerId: event?.sender?.id });
  });
  ipcMain.handle(CHANNELS.getVoiceEnrollmentStatus, () => voiceEnrollmentService.getStatus());
  ipcMain.handle(CHANNELS.completeVoiceEnrollment, (event, sessionId, payload) =>
    voiceEnrollmentService.complete({ ownerId: event?.sender?.id, sessionId, payload })
  );
  ipcMain.handle(CHANNELS.cancelVoiceEnrollment, (event, sessionId) =>
    voiceEnrollmentService.cancel({ ownerId: event?.sender?.id, sessionId })
  );
  ipcMain.handle(CHANNELS.getCloudBudget, cloudBudgetStatus);
  ipcMain.handle(CHANNELS.setCloudBudget, (_event, input) => {
    if (!input || typeof input !== "object") throw new TypeError("cloud budget input is required");
    if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    if (
      !Number.isSafeInteger(input.monthlyLimitMicrousd) ||
      input.monthlyLimitMicrousd < 5_000_000 ||
      input.monthlyLimitMicrousd > 10_000_000
    ) {
      throw new RangeError("monthlyLimitMicrousd must be between 5000000 and 10000000");
    }
    repository.setCloudBudgetSettings({
      enabled: input.enabled,
      monthlyLimitMicrousd: input.monthlyLimitMicrousd,
    });
    return cloudBudgetStatus();
  });
  if (storageManager !== undefined) {
    if (
      !storageManager ||
      typeof storageManager.getStatus !== "function" ||
      typeof storageManager.migrate !== "function"
    ) {
      throw new TypeError("storageManager must provide getStatus and migrate methods");
    }
    if (typeof pickStorageDirectory !== "function") {
      throw new TypeError("pickStorageDirectory is required with storageManager");
    }
    ipcMain.handle(CHANNELS.getStorageStatus, () => storageManager.getStatus());
    ipcMain.handle(CHANNELS.pickStorageDirectory, async () => {
      const selected = await pickStorageDirectory();
      if (selected === null) return null;
      if (typeof selected !== "string" || !path.isAbsolute(selected) || selected.includes("\0")) {
        throw new Error("storage directory picker returned an invalid path");
      }
      return path.resolve(selected);
    });
    ipcMain.handle(CHANNELS.migrateStorage, async (_event, input) => {
      try {
        assertExactKeys(input, ["to"], "storage migration request");
        if (
          typeof input.to !== "string" ||
          input.to.length === 0 ||
          input.to.length > 1024 ||
          !path.isAbsolute(input.to) ||
          input.to.includes("\0")
        ) {
          throw new TypeError("invalid storage migration request");
        }
      } catch {
        throw new TypeError("invalid storage migration request");
      }
      const state = typeof service.getState === "function" ? service.getState() : null;
      if (["recording", "degraded", "paused", "finalizing"].includes(state?.status)) {
        throw new Error("capture must be inactive before storage migration");
      }
      try {
        return await storageManager.migrate({ to: path.resolve(input.to) });
      } catch (error) {
        if (
          typeof error?.message === "string" &&
          /^(migration already in progress|destination is unsafe|migration interrupted)/.test(
            error.message
          )
        ) {
          throw error;
        }
        throw new Error("storage migration failed; the current data directory is unchanged");
      }
    });
  }
}

module.exports = registerJarvisIpc;
