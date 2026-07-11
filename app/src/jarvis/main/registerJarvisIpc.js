const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertMicErrorCode,
} = require("../shared/contracts");

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
  "pauseCapture",
  "resumeCapture",
  "finishCapture",
  "failCapture",
];

function registerJarvisIpc({
  ipcMain,
  repository,
  service,
  voiceEnrollmentService,
  environmentManager,
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
  ipcMain.handle(CHANNELS.startCapture, (_event, input) => service.startCapture(input));
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
    service.failCapture(assertId(id, "sessionId"), assertMicErrorCode(errorCode), at)
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
