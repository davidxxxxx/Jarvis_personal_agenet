const fs = require("node:fs");

const DEFAULT_JARVIS_WHISPER_MODEL = "turbo";
const INSTALLED_MODEL_PREFERENCE = Object.freeze([
  DEFAULT_JARVIS_WHISPER_MODEL,
  "large",
  "medium",
  "small",
  "base",
]);

function configuredModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveJarvisWhisperModel({
  env = process.env,
  whisperManager,
  existsSync = fs.existsSync,
} = {}) {
  if (!whisperManager || typeof whisperManager.getModelPath !== "function") {
    throw new TypeError("whisperManager.getModelPath must be a function");
  }
  if (typeof existsSync !== "function") throw new TypeError("existsSync must be a function");

  const dedicated = configuredModel(env?.JARVIS_WHISPER_MODEL);
  const shared = configuredModel(env?.LOCAL_WHISPER_MODEL);
  const candidates = [
    ...new Set([dedicated, shared, ...INSTALLED_MODEL_PREFERENCE].filter(Boolean)),
  ];

  for (const model of candidates) {
    try {
      if (existsSync(whisperManager.getModelPath(model))) return model;
    } catch {
      // Ignore unknown or unavailable models and continue to a verified local artifact.
    }
  }

  return dedicated ?? shared ?? DEFAULT_JARVIS_WHISPER_MODEL;
}

module.exports = {
  DEFAULT_JARVIS_WHISPER_MODEL,
  resolveJarvisWhisperModel,
};
