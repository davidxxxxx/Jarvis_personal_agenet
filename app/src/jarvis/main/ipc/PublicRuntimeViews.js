const {
  normalizeResourceGovernanceSettings,
  normalizeApplicationAudioSettings,
} = require("../../shared/contracts");

function toPublicResourceGovernanceSettings(input) {
  return normalizeResourceGovernanceSettings({
    profile: input?.profile,
    externalGpuThresholdPct: input?.externalGpuThresholdPct,
    recoveryWaitMs: input?.recoveryWaitMs,
  });
}

function assertApplicationKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9._-]{1,64}$/.test(value)) {
    throw new TypeError("application audio key is invalid");
  }
  return value;
}

function assertApplicationDisplayName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value.trim()).length > 80 ||
    /[\\/:]/u.test(value)
  ) {
    throw new TypeError("application audio display name is invalid");
  }
  return value.trim();
}

function toPublicApplicationAudioStatus(input) {
  const settings = normalizeApplicationAudioSettings({
    enabled: input?.enabled,
    trackLimit: input?.trackLimit,
    fallbackPolicy: input?.fallbackPolicy,
  });
  const runtime = input?.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("application audio runtime status is required");
  }
  const activeTracks = Array.isArray(runtime.activeTracks) ? runtime.activeTracks : [];
  const fallbacks = Array.isArray(runtime.fallbacks) ? runtime.fallbacks : [];
  const boundedInteger = (value, name, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} is invalid`);
    }
    return value;
  };
  return {
    ...settings,
    runtime: {
      running: runtime.running === true,
      configuredLimit: boundedInteger(runtime.configuredLimit, "configuredLimit", 1, 8),
      effectiveLimit: boundedInteger(runtime.effectiveLimit, "effectiveLimit", 1, 8),
      fullscreen: runtime.fullscreen === true,
      activeTracks: activeTracks.slice(0, 8).map((track) => ({
        applicationKey: assertApplicationKey(track?.applicationKey),
        applicationDisplayName: assertApplicationDisplayName(track?.applicationDisplayName),
        captureGeneration: boundedInteger(
          track?.captureGeneration,
          "captureGeneration",
          1,
          Number.MAX_SAFE_INTEGER
        ),
        state: "recording",
      })),
      fallbacks: fallbacks.slice(0, 256).map((fallback) => ({
        applicationKey: assertApplicationKey(fallback?.applicationKey),
        applicationDisplayName: assertApplicationDisplayName(fallback?.applicationDisplayName),
        reason:
          typeof fallback?.reason === "string" && /^[a-z0-9_-]{1,64}$/i.test(fallback.reason)
            ? fallback.reason
            : "application_capture_unavailable",
        retryAt:
          Number.isSafeInteger(fallback?.retryAt) && fallback.retryAt >= 0
            ? fallback.retryAt
            : null,
        state: "mixed_unknown",
      })),
    },
  };
}

module.exports = {
  toPublicResourceGovernanceSettings,
  assertApplicationKey,
  assertApplicationDisplayName,
  toPublicApplicationAudioStatus,
};
