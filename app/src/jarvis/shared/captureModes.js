const CAPTURE_MODES = Object.freeze({
  MIC: "mic",
  SYSTEM: "system",
  DUAL: "dual",
});

const SOURCES_BY_MODE = Object.freeze({
  mic: Object.freeze(["mic"]),
  system: Object.freeze(["system"]),
  dual: Object.freeze(["mic", "system"]),
});

function assertCaptureMode(value) {
  if (!Object.hasOwn(SOURCES_BY_MODE, value)) throw new TypeError("invalid capture mode");
  return value;
}

function assertSourceType(value) {
  if (value !== "mic" && value !== "system") throw new TypeError("invalid source type");
  return value;
}

function optionalString(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  return value;
}

function normalizeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("capture source must be an object");
  }
  return {
    sourceType: assertSourceType(source.sourceType),
    deviceId: optionalString(source.deviceId, "deviceId"),
    deviceLabel: optionalString(source.deviceLabel, "deviceLabel"),
    strategy: optionalString(source.strategy, "strategy"),
  };
}

function normalizeCaptureSources(captureMode, sources) {
  const mode = assertCaptureMode(captureMode);
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  const normalized = sources.map(normalizeSource);
  const actual = normalized.map((source) => source.sourceType);
  const expected = SOURCES_BY_MODE[mode];
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((sourceType) => !actual.includes(sourceType))
  ) {
    throw new TypeError(`sources must exactly match capture mode ${mode}`);
  }
  return expected.map((sourceType) => normalized.find((source) => source.sourceType === sourceType));
}

function normalizeCaptureStartInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("capture input is required");
  }
  const legacy = input.captureMode === undefined && input.sources === undefined;
  const captureMode = assertCaptureMode(input.captureMode ?? CAPTURE_MODES.MIC);
  const sources = normalizeCaptureSources(
    captureMode,
    legacy
      ? [
          {
            sourceType: "mic",
            deviceId: input.micDeviceId ?? null,
            deviceLabel: null,
            strategy: null,
          },
        ]
      : input.sources
  );
  if (input.micDeviceId !== undefined) {
    const requestedMicDeviceId = optionalString(input.micDeviceId, "micDeviceId");
    const sourceMicDeviceId = sources.find((source) => source.sourceType === "mic")?.deviceId ?? null;
    if (requestedMicDeviceId !== sourceMicDeviceId) {
      throw new TypeError("micDeviceId must match the selected capture sources");
    }
  }
  return { ...input, captureMode, sources };
}

module.exports = {
  CAPTURE_MODES,
  SOURCES_BY_MODE,
  assertCaptureMode,
  assertSourceType,
  normalizeSource,
  normalizeCaptureSources,
  normalizeCaptureStartInput,
};
