const test = require("node:test");
const assert = require("node:assert/strict");
const WhisperManager = require("../../src/helpers/whisper");

test("verbose whisper JSON preserves ordered word timestamps and confidence", () => {
  const manager = new WhisperManager({ serverManager: {} });
  const result = manager.parseWhisperResult({
    text: "你好 Jarvis",
    language: "zh",
    segments: [
      {
        words: [
          { word: " Jarvis", start: 0.62, end: 1.18, probability: 0.8 },
          { word: "你好", start: 0.08, end: 0.55, probability: 0.96 },
          { word: "invalid", start: 2, end: 1.5, probability: 0.9 },
        ],
      },
    ],
  });

  assert.deepEqual(result, {
    success: true,
    text: "你好 Jarvis",
    language: "zh",
    confidence: 0.88,
    words: [
      { word: "你好", startedAtMs: 80, endedAtMs: 550, probability: 0.96 },
      { word: " Jarvis", startedAtMs: 620, endedAtMs: 1180, probability: 0.8 },
    ],
  });
});

test("whisper.cpp word times accept clock strings without inventing invalid words", () => {
  const manager = new WhisperManager({ serverManager: {} });
  const result = manager.parseWhisperResult({
    language: "zh",
    transcription: [
      {
        text: "测试",
        words: [{ text: "测试", from: "00:00:01.250", to: "00:00:01.900" }],
      },
    ],
  });

  assert.deepEqual(result.words, [
    { word: "测试", startedAtMs: 1250, endedAtMs: 1900, probability: null },
  ]);
});
