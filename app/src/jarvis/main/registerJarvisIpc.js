const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertCaptureFailureCode,
  assertSourceType,
  assertRetentionMode,
} = require("../shared/contracts");
const { normalizeCaptureStartInput } = require("../shared/captureModes");
const fs = require("node:fs/promises");

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

function registerJarvisIpc({
  ipcMain,
  repository,
  service,
  voiceEnrollmentService,
  environmentManager,
  analysisScheduler,
  audioEvidenceReader,
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
    repository.listAudioChunks(assertId(sessionId, "sessionId"))
  );
  ipcMain.handle(CHANNELS.readAudioChunk, async (_event, audioChunkId) => {
    const chunk = repository.getAudioChunk(assertId(audioChunkId, "audioChunkId"));
    if (!chunk) return null;
    try {
      if (audioEvidenceReader) return await audioEvidenceReader.readPlayableWav(chunk);
      return await fs.readFile(chunk.path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle(CHANNELS.getSessionDetail, (_event, sessionId) =>
    repository.getSessionDetail(assertId(sessionId, "sessionId"))
  );
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
}

module.exports = registerJarvisIpc;
