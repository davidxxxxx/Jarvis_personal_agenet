const CAPTURE_MODES = Object.freeze({
  MIC: "mic",
  SYSTEM: "system",
  DUAL: "dual",
});

const RETENTION_MODES = Object.freeze({
  SPEECH_TRIGGERED: "speech_triggered",
  CONTINUOUS: "continuous",
});

const DEFAULT_SPEECH_POLICY = Object.freeze({
  schemaVersion: 1,
  preRollMs: 2_000,
  postRollMs: 3_000,
  mergeGapMs: 3_000,
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

function assertRetentionMode(value) {
  if (value !== RETENTION_MODES.SPEECH_TRIGGERED && value !== RETENTION_MODES.CONTINUOUS) {
    throw new TypeError("invalid retention mode");
  }
  return value;
}

function normalizeCapturePolicy(value) {
  const candidate = value ?? DEFAULT_SPEECH_POLICY;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("capture policy must be an object");
  }
  const policy = {
    schemaVersion: candidate.schemaVersion ?? DEFAULT_SPEECH_POLICY.schemaVersion,
    preRollMs: candidate.preRollMs ?? DEFAULT_SPEECH_POLICY.preRollMs,
    postRollMs: candidate.postRollMs ?? DEFAULT_SPEECH_POLICY.postRollMs,
    mergeGapMs: candidate.mergeGapMs ?? DEFAULT_SPEECH_POLICY.mergeGapMs,
  };
  if (policy.schemaVersion !== 1) throw new RangeError("unsupported capture policy version");
  for (const [name, duration] of Object.entries(policy).filter(([key]) => key !== "schemaVersion")) {
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > 60_000) {
      throw new RangeError(`${name} must be between 0 and 60000 ms`);
    }
  }
  return policy;
}

function parseCapturePolicyJson(value) {
  try {
    if (typeof value !== "string") return normalizeCapturePolicy(value);
    return normalizeCapturePolicy(JSON.parse(value));
  } catch {
    return { ...DEFAULT_SPEECH_POLICY };
  }
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
  const retentionMode = assertRetentionMode(
    input.retentionMode ?? RETENTION_MODES.SPEECH_TRIGGERED
  );
  const capturePolicy = normalizeCapturePolicy(input.capturePolicy);
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
  return { ...input, captureMode, sources, retentionMode, capturePolicy };
}

module.exports = {
  CAPTURE_MODES,
  RETENTION_MODES,
  DEFAULT_SPEECH_POLICY,
  SOURCES_BY_MODE,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
  normalizeCapturePolicy,
  parseCapturePolicyJson,
  normalizeSource,
  normalizeCaptureSources,
  normalizeCaptureStartInput,
};
