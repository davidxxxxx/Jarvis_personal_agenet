const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_JARVIS_WHISPER_MODEL,
  resolveJarvisWhisperModel,
} = require("../../src/jarvis/main/JarvisWhisperModel");

function fixture(models) {
  const downloaded = new Set(models);
  return {
    whisperManager: {
      getModelPath(model) {
        return `G:\\models\\ggml-${model}.bin`;
      },
    },
    existsSync: (modelPath) =>
      downloaded.has(modelPath.slice(modelPath.lastIndexOf("ggml-") + 5, -4)),
  };
}

test("Jarvis keeps its dedicated model when dictation preferences clear the shared model", () => {
  const model = resolveJarvisWhisperModel({
    env: {
      JARVIS_WHISPER_MODEL: "turbo",
      LOCAL_WHISPER_MODEL: "",
    },
    ...fixture(["turbo"]),
  });

  assert.equal(model, "turbo");
});

test("Jarvis prefers the installed bilingual model when no model is configured", () => {
  const model = resolveJarvisWhisperModel({
    env: {},
    ...fixture(["turbo"]),
  });

  assert.equal(model, DEFAULT_JARVIS_WHISPER_MODEL);
});

test("Jarvis does not select a configured model that is not downloaded", () => {
  const model = resolveJarvisWhisperModel({
    env: {
      JARVIS_WHISPER_MODEL: "base",
      LOCAL_WHISPER_MODEL: "small",
    },
    ...fixture(["turbo"]),
  });

  assert.equal(model, "turbo");
});

test("Jarvis falls back deterministically when no local model is downloaded", () => {
  const model = resolveJarvisWhisperModel({
    env: {},
    ...fixture([]),
  });

  assert.equal(model, DEFAULT_JARVIS_WHISPER_MODEL);
});
