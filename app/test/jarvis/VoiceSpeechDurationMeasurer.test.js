const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceSpeechDurationMeasurer = require("../../src/jarvis/main/VoiceSpeechDurationMeasurer");

const SAMPLE_RATE = 24_000;

function tenSeconds(value = 0.2) {
  return new Float32Array(SAMPLE_RATE * 10).fill(value);
}

test("measures only Silero-positive frame durations and clears every PCM16 copy", async () => {
  const pcmReferences = [];
  let resetStreamId = null;
  const probabilities = new Array(313).fill(0.9);
  probabilities[1] = 0.1;
  probabilities[312] = 0.1;
  const classifier = {
    isReady: () => true,
    async classifyDetailed(input) {
      pcmReferences.push(input.pcm);
      return { probability: 0.9, windowCount: 313, probabilities };
    },
    async reset(streamId) {
      resetStreamId = streamId;
    },
  };
  const measurer = new VoiceSpeechDurationMeasurer({ classifier });

  const speechMs = await measurer.measureSpeechMs({
    sessionId: "enrollment-1",
    windowIndex: 2,
    sampleRate: SAMPLE_RATE,
    samples: tenSeconds(),
  });

  assert.equal(speechMs, 9_952);
  assert.equal(resetStreamId, "enrollment-1:voice-enrollment:2");
  assert.equal(pcmReferences.length, 1);
  assert.equal(
    pcmReferences[0].every((value) => value === 0),
    true
  );
});

test("initializes the production VAD and rejects malformed detailed results", async () => {
  let initialized = 0;
  let capturedPcm = null;
  const classifier = {
    isReady: () => false,
    async initialize() {
      initialized += 1;
    },
    async classifyDetailed({ pcm }) {
      capturedPcm = pcm;
      return { probability: 0.1, windowCount: 1, probabilities: [] };
    },
    async reset() {},
  };
  const measurer = new VoiceSpeechDurationMeasurer({ classifier });

  await assert.rejects(
    measurer.measureSpeechMs({
      sessionId: "enrollment-2",
      windowIndex: 0,
      sampleRate: SAMPLE_RATE,
      samples: tenSeconds(0),
    }),
    /detailed VAD result/
  );
  assert.equal(initialized, 1);
  assert.equal(
    capturedPcm.every((value) => value === 0),
    true
  );
});

test("counts a padded all-speech ten-second window as exactly 10,000ms", async () => {
  const classifier = {
    isReady: () => true,
    async classifyDetailed({ pcm }) {
      const windowCount = pcm.length / (768 * 2);
      return {
        probability: 0.99,
        windowCount,
        probabilities: new Array(windowCount).fill(0.99),
      };
    },
    async reset() {},
  };
  const measurer = new VoiceSpeechDurationMeasurer({ classifier });

  assert.equal(
    await measurer.measureSpeechMs({
      sessionId: "enrollment-boundary",
      windowIndex: 0,
      sampleRate: SAMPLE_RATE,
      samples: tenSeconds(),
    }),
    10_000
  );
});
