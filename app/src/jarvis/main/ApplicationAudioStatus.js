function safeReason(reason) {
  return typeof reason === "string" && /^[a-z0-9_-]{1,64}$/i.test(reason)
    ? reason
    : "application_capture_unavailable";
}

function safeFailureCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(code) ? code : null;
}

function createApplicationAudioStatus({
  running,
  configuredLimit,
  effectiveLimit,
  fullscreen,
  activeTracks,
  fallbacks,
} = {}) {
  return {
    running: running === true,
    configuredLimit,
    effectiveLimit,
    fullscreen: fullscreen === true,
    activeTracks: [...activeTracks.values()]
      .map((track) => ({
        applicationKey: track.applicationKey,
        applicationDisplayName: track.applicationDisplayName,
        captureGeneration: track.captureGeneration,
        state: "recording",
      }))
      .sort((left, right) => left.applicationKey.localeCompare(right.applicationKey)),
    fallbacks: [...fallbacks.values()]
      .map((fallback) => ({
        applicationKey: fallback.applicationKey,
        applicationDisplayName: fallback.applicationDisplayName,
        reason: safeReason(fallback.reason),
        failureCode: safeFailureCode(fallback.failureCode),
        retryAt: fallback.retryAt,
        state: "mixed_unknown",
      }))
      .sort((left, right) => left.applicationKey.localeCompare(right.applicationKey)),
  };
}

module.exports = { createApplicationAudioStatus };
