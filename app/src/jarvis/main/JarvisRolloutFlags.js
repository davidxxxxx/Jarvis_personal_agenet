const FLAG_DEFINITIONS = Object.freeze({
  applicationAudioV1: Object.freeze({
    envKey: "JARVIS_ROLLOUT_APPLICATION_AUDIO_V1",
    defaultValue: true,
  }),
  dualSpeakerVerificationV1: Object.freeze({
    envKey: "JARVIS_ROLLOUT_DUAL_SPEAKER_VERIFICATION_V1",
    defaultValue: true,
  }),
  activityClassificationV1: Object.freeze({
    envKey: "JARVIS_ROLLOUT_ACTIVITY_CLASSIFICATION_V1",
    defaultValue: true,
  }),
  actionCenterV1: Object.freeze({
    envKey: "JARVIS_ROLLOUT_ACTION_CENTER_V1",
    defaultValue: true,
  }),
});

const ENABLED_VALUES = new Set(["1", "true", "on", "enabled"]);
const DISABLED_VALUES = new Set(["0", "false", "off", "disabled"]);

function parseRolloutFlag(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  return defaultValue;
}

function resolveJarvisRolloutFlags(readValue = (key) => process.env[key]) {
  if (typeof readValue !== "function")
    throw new TypeError("rollout flag reader must be a function");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(FLAG_DEFINITIONS).map(([name, definition]) => [
        name,
        parseRolloutFlag(readValue(definition.envKey), definition.defaultValue),
      ])
    )
  );
}

const DEFAULT_JARVIS_ROLLOUT_FLAGS = resolveJarvisRolloutFlags(() => undefined);

module.exports = {
  DEFAULT_JARVIS_ROLLOUT_FLAGS,
  FLAG_DEFINITIONS,
  parseRolloutFlag,
  resolveJarvisRolloutFlags,
};
