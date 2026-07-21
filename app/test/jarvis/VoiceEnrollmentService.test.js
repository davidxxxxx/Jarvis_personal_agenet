const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceEnrollmentService = require("../../src/jarvis/main/VoiceEnrollmentService");
const {
  CAPTURE_SAMPLE_RATE,
  SELF_PROFILE_POLICY,
} = require("../../src/jarvis/main/VoiceEnrollmentService");
const {
  MAX_EMBEDDING_SECONDS,
  SPEAKER_EMBEDDING_MODEL_ID,
} = require("../../src/helpers/speakerEmbeddings");
const VoiceSpeechDurationMeasurer = require("../../src/jarvis/main/VoiceSpeechDurationMeasurer");

const OWNER_ID = 41;
const WINDOW_SAMPLES = CAPTURE_SAMPLE_RATE * 10;
const DIMENSION = 512;

function vector(entries) {
  const result = new Float32Array(DIMENSION);
  for (const [index, value] of entries) result[index] = value;
  return result;
}

function nearIdenticalVectors() {
  return [
    vector([[0, 1]]),
    vector([
      [0, 0.999],
      [1, 0.03],
    ]),
    vector([
      [0, 0.998],
      [2, 0.04],
    ]),
  ];
}

function speechWindow(index) {
  const startSample = index * WINDOW_SAMPLES;
  return {
    startSample,
    endSample: startSample + WINDOW_SAMPLES,
    samples: new Float32Array(WINDOW_SAMPLES).fill((index + 1) / 10),
  };
}

function validPayload() {
  return {
    sampleRate: CAPTURE_SAMPLE_RATE,
    channels: 1,
    format: "float32",
    recordedSampleCount: CAPTURE_SAMPLE_RATE * 32,
    windows: [speechWindow(0), speechWindow(1), speechWindow(2)],
  };
}

function createHarness({
  embeddings = nearIdenticalVectors(),
  speechDurations = [10_000, 10_000, 10_000],
  extractError = null,
  measureError = null,
  speechDurationMeasurer = null,
  status = null,
  sessionTtlMs,
  maxActiveSessions,
} = {}) {
  let now = 1_000;
  let index = 0;
  let nextId = 0;
  const saves = [];
  const extractedLengths = [];
  const extractedSamples = [];
  let measuredWindow = 0;
  const service = new VoiceEnrollmentService({
    speakerEmbeddings: {
      async extractEmbeddingFromSamples(samples) {
        extractedLengths.push(samples.length);
        extractedSamples.push(samples);
        if (extractError) throw extractError;
        return embeddings[index++] ?? null;
      },
    },
    speechDurationMeasurer: speechDurationMeasurer ?? {
      async measureSpeechMs() {
        if (measureError) throw measureError;
        return speechDurations[measuredWindow++] ?? 0;
      },
    },
    voiceProfileStore: {
      getStatus: () =>
        status ?? {
          enrolled: false,
          modelId: SPEAKER_EMBEDDING_MODEL_ID,
          acceptedSpeechMs: 0,
          windowCount: 0,
          selfConsistency: null,
          updatedAt: null,
        },
      saveEnrollment(input) {
        saves.push(input);
        return input;
      },
    },
    createId: () => `opaque-enrollment-id-${++nextId}`,
    now: () => now,
    ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
    ...(maxActiveSessions === undefined ? {} : { maxActiveSessions }),
  });
  return {
    service,
    saves,
    extractedLengths,
    extractedSamples,
    advance(ms) {
      now += ms;
    },
  };
}

function begin(harness) {
  const session = harness.service.begin({ ownerId: OWNER_ID });
  harness.advance(32_000);
  return session;
}

test("exports one exact CAMPPlus model policy with the approved SELF quality gates", () => {
  assert.equal(SPEAKER_EMBEDDING_MODEL_ID, "3dspeaker-campplus-voxceleb-16k-v1");
  assert.equal(MAX_EMBEDDING_SECONDS, 10);
  assert.deepEqual(SELF_PROFILE_POLICY, {
    modelId: SPEAKER_EMBEDDING_MODEL_ID,
    minimumSpeechMs: 18_000,
    minimumSpeechMsPerWindow: 5_000,
    minimumWindows: 3,
    minimumSelfConsistency: 0.78,
  });
});

test("accepts three near-identical ten-second windows and persists normalized evidence", async () => {
  const harness = createHarness();
  const payload = validPayload();
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.modelId, SPEAKER_EMBEDDING_MODEL_ID);
  assert.equal(result.acceptedSpeechMs, 30_000);
  assert.equal(result.windowCount, 3);
  assert.ok(result.selfConsistency >= 0.99 && result.selfConsistency <= 1);
  assert.deepEqual(harness.extractedLengths, [160_000, 160_000, 160_000]);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].samples.length, 3);
  const centroid = harness.saves[0].centroid;
  const norm = Math.sqrt(Array.from(centroid).reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);
  assert.equal(
    payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
  assert.equal(
    harness.extractedSamples.every((samples) => samples.every((sample) => sample === 0)),
    true
  );
});

test("accepts natural pauses when every window and the total speech pass the quality gates", async () => {
  const harness = createHarness({ speechDurations: [7_000, 6_500, 7_000] });
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload: validPayload(),
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.acceptedSpeechMs, 20_500);
  assert.equal(result.windowCount, 3);
  assert.equal(harness.saves.length, 1);
});

test("uses measured VAD speech duration instead of treating finite embeddings as speech", async (t) => {
  for (const [name, speechDurations, expectedMs] of [
    ["silence", [0, 0, 0], 0],
    ["stable noise", [1_200, 800, 1_000], 3_000],
    ["one mostly silent window", [9_000, 4_999, 9_000], 22_999],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ speechDurations });
      const result = await harness.service.complete({
        ownerId: OWNER_ID,
        sessionId: begin(harness).sessionId,
        payload: validPayload(),
      });

      assert.equal(result.status, "insufficient_speech");
      assert.equal(result.acceptedSpeechMs, expectedMs);
      assert.deepEqual(result.sampleSpeechMs, speechDurations);
      assert.equal(result.windowCount, 3);
      assert.equal(harness.extractedLengths.length, 3);
      assert.equal(harness.saves.length, 0);
    });
  }
});

test("returns model_error when production speech measurement is unavailable", async () => {
  const harness = createHarness({ measureError: new Error("VAD unavailable") });
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload: validPayload(),
  });

  assert.equal(result.status, "model_error");
  assert.equal(harness.extractedLengths.length, 0);
  assert.equal(harness.saves.length, 0);
});

test("rejects exactly 17,999 measured speech milliseconds", async () => {
  const harness = createHarness({ speechDurations: [6_000, 6_000, 5_999] });
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload: validPayload(),
  });

  assert.equal(result.status, "insufficient_speech");
  assert.equal(result.acceptedSpeechMs, 17_999);
  assert.equal(harness.saves.length, 0);
});

test("production VAD duration path rejects silence or stable noise despite finite embeddings", async (t) => {
  for (const name of ["silence", "stable noise"]) {
    await t.test(name, async () => {
      const measurer = new VoiceSpeechDurationMeasurer({
        classifier: {
          isReady: () => true,
          async classifyDetailed({ pcm }) {
            const windowCount = pcm.length / (768 * 2);
            return {
              probability: 0.01,
              windowCount,
              probabilities: new Array(windowCount).fill(0.01),
            };
          },
          async reset() {},
        },
      });
      const harness = createHarness({ speechDurationMeasurer: measurer });
      const payload = validPayload();
      for (const window of payload.windows) {
        window.samples.fill(name === "silence" ? 0 : 0.1);
      }

      const result = await harness.service.complete({
        ownerId: OWNER_ID,
        sessionId: begin(harness).sessionId,
        payload,
      });

      assert.equal(result.status, "insufficient_speech");
      assert.equal(result.acceptedSpeechMs, 0);
      assert.equal(harness.extractedLengths.length, 3);
      assert.equal(harness.saves.length, 0);
    });
  }
});

test("returns insufficient_speech without writing when any accepted window is missing", async () => {
  const harness = createHarness({
    embeddings: [nearIdenticalVectors()[0], null, nearIdenticalVectors()[2]],
  });
  const payload = validPayload();
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload,
  });

  assert.deepEqual(result, {
    status: "insufficient_speech",
    modelId: SPEAKER_EMBEDDING_MODEL_ID,
    acceptedSpeechMs: 20_000,
    windowCount: 2,
    selfConsistency: null,
    sampleSpeechMs: [10_000, 10_000],
  });
  assert.equal(harness.saves.length, 0);
  assert.equal(
    payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
});

test("returns inconsistent_samples for orthogonal windows without writing", async () => {
  const harness = createHarness({
    embeddings: [vector([[0, 1]]), vector([[1, 1]]), vector([[2, 1]])],
  });
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: begin(harness).sessionId,
    payload: validPayload(),
  });

  assert.equal(result.status, "inconsistent_samples");
  assert.ok(result.selfConsistency < 0.78);
  assert.equal(harness.saves.length, 0);
});

test("returns model_error for thrown, malformed, NaN, or zero embeddings and zeroes PCM", async (t) => {
  const cases = [
    ["throw", { extractError: new Error("worker failed") }],
    ["short", { embeddings: [new Float32Array(511), ...nearIdenticalVectors().slice(1)] }],
    [
      "NaN",
      {
        embeddings: [
          Object.assign(vector([[0, 1]]), { 3: Number.NaN }),
          ...nearIdenticalVectors().slice(1),
        ],
      },
    ],
    ["zero", { embeddings: [new Float32Array(DIMENSION), ...nearIdenticalVectors().slice(1)] }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const harness = createHarness(options);
      const payload = validPayload();
      const result = await harness.service.complete({
        ownerId: OWNER_ID,
        sessionId: begin(harness).sessionId,
        payload,
      });
      assert.deepEqual(result, {
        status: "model_error",
        modelId: SPEAKER_EMBEDDING_MODEL_ID,
        acceptedSpeechMs: 0,
        windowCount: 0,
        selfConsistency: null,
      });
      assert.equal(harness.saves.length, 0);
      assert.equal(
        harness.extractedSamples.every((samples) => samples.every((sample) => sample === 0)),
        true
      );
      assert.equal(
        payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
        true
      );
    });
  }
});

test("returns the current model status and keeps sessions owner-bound and one-time", async () => {
  const expected = {
    enrolled: true,
    modelId: SPEAKER_EMBEDDING_MODEL_ID,
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 0.99,
    updatedAt: 50_000,
  };
  const harness = createHarness({ status: expected });
  assert.deepEqual(harness.service.getStatus(), expected);
  const session = begin(harness);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID + 1,
      sessionId: session.sessionId,
      payload: validPayload(),
    }),
    /does not belong/
  );
  await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: session.sessionId,
    payload: validPayload(),
  });
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );
});

test("requires the real 32-second guided capture margin and exact three 10-second windows", async () => {
  const harness = createHarness();
  const session = harness.service.begin({ ownerId: OWNER_ID });
  harness.advance(29_999);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      payload: validPayload(),
    }),
    /minimum real capture duration/
  );

  harness.advance(2_001);
  const payload = validPayload();
  payload.windows[2].samples = payload.windows[2].samples.slice(0, -1);
  payload.windows[2].endSample -= 1;
  await assert.rejects(
    harness.service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload }),
    /ten seconds/
  );
  assert.equal(
    payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
});

test("rejects unknown, expired, cancelled, and replayed owner-bound sessions", async () => {
  const harness = createHarness({ sessionTtlMs: 40_000 });
  await assert.rejects(
    harness.service.complete({ ownerId: OWNER_ID, sessionId: "missing", payload: validPayload() }),
    /unknown enrollment session/
  );
  const cancelled = harness.service.begin({ ownerId: OWNER_ID });
  harness.service.cancel({ ownerId: OWNER_ID, sessionId: cancelled.sessionId });
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: cancelled.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );
  const expired = harness.service.begin({ ownerId: OWNER_ID });
  harness.advance(40_001);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: expired.sessionId,
      payload: validPayload(),
    }),
    /expired/
  );
});

test("bounds sessions per owner and globally, cancelOwner releases capacity, and expiry is swept", () => {
  const harness = createHarness({ sessionTtlMs: 1_000, maxActiveSessions: 2 });
  harness.service.begin({ ownerId: 1 });
  assert.throws(() => harness.service.begin({ ownerId: 1 }), /already active/);
  harness.service.begin({ ownerId: 2 });
  assert.throws(() => harness.service.begin({ ownerId: 3 }), /capacity/);
  assert.equal(harness.service.cancelOwner(1), 1);
  assert.doesNotThrow(() => harness.service.begin({ ownerId: 3 }));
  harness.advance(1_001);
  assert.doesNotThrow(() => harness.service.begin({ ownerId: 1 }));
  assert.equal(harness.service.cancelOwner(99), 0);
});

test("rejects format, capture bounds, window bounds, overlap, and non-finite PCM before embedding", async (t) => {
  const cases = [
    ["sample rate", (payload) => (payload.sampleRate = 16_000), /24 kHz mono/],
    ["channels", (payload) => (payload.channels = 2), /24 kHz mono/],
    ["format", (payload) => (payload.format = "int16"), /24 kHz mono/],
    ["short capture", (payload) => (payload.recordedSampleCount = 24_000 * 29), /approximately 32/],
    ["long capture", (payload) => (payload.recordedSampleCount = 24_000 * 35), /approximately 32/],
    [
      "overlap",
      (payload) => {
        payload.windows[1].startSample = payload.windows[0].endSample - 1;
        payload.windows[1].endSample = payload.windows[1].startSample + WINDOW_SAMPLES;
      },
      /must not overlap/,
    ],
    ["boundary mismatch", (payload) => (payload.windows[2].endSample += 1), /boundaries/],
    ["NaN PCM", (payload) => (payload.windows[0].samples[4] = Number.NaN), /finite normalized PCM/],
    [
      "Infinity PCM",
      (payload) => (payload.windows[0].samples[4] = Number.POSITIVE_INFINITY),
      /finite normalized PCM/,
    ],
    [
      "out-of-range PCM",
      (payload) => (payload.windows[0].samples[4] = 1.01),
      /finite normalized PCM/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const harness = createHarness();
      const payload = validPayload();
      mutate(payload);
      await assert.rejects(
        harness.service.complete({
          ownerId: OWNER_ID,
          sessionId: begin(harness).sessionId,
          payload,
        }),
        pattern
      );
      assert.equal(harness.extractedLengths.length, 0);
      assert.equal(
        payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
        true
      );
    });
  }
});

test("does not consume a session on foreign-owner rejection but consumes invalid owner payload once", async () => {
  const harness = createHarness();
  const session = begin(harness);
  const foreignPayload = validPayload();
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID + 1,
      sessionId: session.sessionId,
      payload: foreignPayload,
    }),
    /does not belong/
  );
  assert.equal(
    foreignPayload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
  const invalid = validPayload();
  invalid.windows[0].samples[0] = Number.NaN;
  await assert.rejects(
    harness.service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload: invalid }),
    /finite normalized PCM/
  );
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );
});
