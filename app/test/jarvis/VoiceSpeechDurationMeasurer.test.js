const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceSpeechDurationMeasurer = require("../../src/jarvis/main/VoiceSpeechDurationMeasurer");

const SAMPLE_RATE = 24_000;
const VAD_FRAME_SAMPLES = 768;

function tenSeconds(value = 0.2) {
  return new Float32Array(SAMPLE_RATE * 10).fill(value);
}

test("measures full frames and the verified real-audio tail without double counting", async () => {
  const pcmReferences = [];
  const resetStreamIds = [];
  let call = 0;
  const classifier = {
    isReady: () => true,
    async classifyDetailed(input) {
      pcmReferences.push(input.pcm);
      call += 1;
      if (call === 1) {
        const probabilities = new Array(312).fill(0.9);
        probabilities[1] = 0.1;
        return { probability: 0.9, windowCount: 312, probabilities };
      }
      return { probability: 0.1, windowCount: 1, probabilities: [0.1] };
    },
    async reset(streamId) {
      resetStreamIds.push(streamId);
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
  assert.deepEqual(resetStreamIds, [
    "enrollment-1:voice-enrollment:2:main",
    "enrollment-1:voice-enrollment:2:tail",
  ]);
  assert.equal(pcmReferences.length, 2);
  assert.equal(pcmReferences[0].length, 312 * VAD_FRAME_SAMPLES * 2);
  assert.equal(pcmReferences[1].length, VAD_FRAME_SAMPLES * 2);
  assert.equal(
    pcmReferences.every((pcm) => pcm.every((value) => value === 0)),
    true
  );
});

test("initializes production VAD and clears both PCM buffers when tail validation fails", async () => {
  let initialized = 0;
  const capturedPcm = [];
  const classifier = {
    isReady: () => false,
    async initialize() {
      initialized += 1;
    },
    async classifyDetailed({ pcm }) {
      capturedPcm.push(pcm);
      const windowCount = pcm.length / (VAD_FRAME_SAMPLES * 2);
      if (windowCount === 312) {
        return { probability: 0.9, windowCount, probabilities: new Array(312).fill(0.9) };
      }
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
  assert.equal(capturedPcm.length, 2);
  assert.equal(
    capturedPcm.every((pcm) => pcm.every((value) => value === 0)),
    true
  );
});

test("uses the final 32ms of real audio for the 16ms tail and reaches exactly 10,000ms", async () => {
  const samples = tenSeconds(0.1);
  samples.fill(0.75, samples.length - VAD_FRAME_SAMPLES);
  const observedPcm = [];
  const classifier = {
    isReady: () => true,
    async classifyDetailed({ pcm }) {
      observedPcm.push(Buffer.from(pcm));
      const windowCount = pcm.length / (VAD_FRAME_SAMPLES * 2);
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
      samples,
    }),
    10_000
  );
  assert.equal(observedPcm.length, 2);
  assert.equal(observedPcm[1].length, VAD_FRAME_SAMPLES * 2);
  for (let offset = 0; offset < observedPcm[1].length; offset += 2) {
    assert.equal(observedPcm[1].readInt16LE(offset), Math.round(0.75 * 32_767));
  }
});

test("does not invent the final 16ms when the real-audio tail is not speech", async () => {
  let call = 0;
  const classifier = {
    isReady: () => true,
    async classifyDetailed({ pcm }) {
      call += 1;
      const windowCount = pcm.length / (VAD_FRAME_SAMPLES * 2);
      const probability = call === 1 ? 0.99 : 0.01;
      return {
        probability,
        windowCount,
        probabilities: new Array(windowCount).fill(probability),
      };
    },
    async reset() {},
  };
  const measurer = new VoiceSpeechDurationMeasurer({ classifier });

  assert.equal(
    await measurer.measureSpeechMs({
      sessionId: "enrollment-tail-rejected",
      windowIndex: 0,
      sampleRate: SAMPLE_RATE,
      samples: tenSeconds(),
    }),
    9_984
  );
});

test("attempts both stream resets when the main reset fails", async () => {
  const resets = [];
  const classifier = {
    isReady: () => true,
    async classifyDetailed({ pcm }) {
      const windowCount = pcm.length / (VAD_FRAME_SAMPLES * 2);
      return {
        probability: 0.99,
        windowCount,
        probabilities: new Array(windowCount).fill(0.99),
      };
    },
    async reset(streamId) {
      resets.push(streamId);
      if (streamId.endsWith(":main")) throw new Error("main reset failed");
    },
  };
  const measurer = new VoiceSpeechDurationMeasurer({ classifier });

  await assert.rejects(
    measurer.measureSpeechMs({
      sessionId: "enrollment-reset",
      windowIndex: 1,
      sampleRate: SAMPLE_RATE,
      samples: tenSeconds(),
    }),
    /voice enrollment VAD stream reset failed/
  );
  assert.deepEqual(resets, [
    "enrollment-reset:voice-enrollment:1:main",
    "enrollment-reset:voice-enrollment:1:tail",
  ]);
});
