const assert = require("node:assert/strict");
const test = require("node:test");

const HistoricalSelfVoiceRecoveryService = require("../../src/jarvis/main/HistoricalSelfVoiceRecoveryService");

function pcm(durationMs, amplitude = 4_000) {
  const sampleCount = Math.round((24_000 * durationMs) / 1_000);
  const bytes = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    bytes.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return { bytes, sampleRate: 24_000, channels: 1, sampleCount };
}

function embedding(index) {
  const value = new Float32Array(192);
  value[0] = 1;
  value[1] = index * 0.01;
  return value;
}

function turn(id, durationMs, overrides = {}) {
  return {
    id,
    clusterId: `cluster-${id}`,
    startMs: 10_000,
    endMs: 10_000 + durationMs,
    overlapDetected: false,
    echoDetected: false,
    excludedFromCentroid: false,
    sourceType: "mic",
    micDeviceId: "physical-mic",
    chunk: {
      id: `chunk-${id}`,
      started_at: 10_000,
      ended_at: 10_000 + durationMs,
      duration_ms: durationMs,
      expires_at: 99_999,
      path: `G:\\recordings\\${id}.flac`,
      format: "flac",
      sha256: "a".repeat(64),
    },
    ...overrides,
  };
}

function harness(overrides = {}) {
  const turns = new Map([
    ["one", turn("one", 7_600)],
    ["two", turn("two", 5_900)],
    ["three", turn("three", 4_300)],
    ["four", turn("four", 3_800)],
  ]);
  const saved = [];
  let embeddingCalls = 0;
  const service = new HistoricalSelfVoiceRecoveryService({
    repository: {
      getHistoricalVoiceTurn: (id) => turns.get(id) ?? null,
      ...overrides.repository,
    },
    audioEvidenceReader: {
      readVerifiedPcm: async (chunk) => pcm(chunk.duration_ms),
      ...overrides.audioEvidenceReader,
    },
    primarySpeakerEmbeddings: {
      extractEmbeddingFromSamples: async () => embedding(embeddingCalls++),
    },
    reviewSpeakerEmbeddings: {
      extractEmbeddingFromSamples: async () => embedding(embeddingCalls++),
    },
    speechDurationMeasurer: {
      measureSpeechMs: async ({ windowIndex }) => [6_500, 5_100, 7_500][windowIndex],
      ...overrides.speechDurationMeasurer,
    },
    voiceProfileStore: {
      getDualStatus: () => ({ enrolled: false }),
      saveDualEnrollment(input) {
        saved.push(input);
        return { saved: true };
      },
      ...overrides.voiceProfileStore,
    },
    createSessionId: () => "historical-recovery",
  });
  return { service, saved };
}

test("recovers a dual SELF enrollment from three verified historical microphone windows", async () => {
  const current = harness();
  const result = await current.service.recover({
    turnGroups: [["one"], ["two"], ["three", "four"]],
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.sampleSpeechMs, [6_500, 5_100, 7_500]);
  assert.equal(result.acceptedSpeechMs, 19_100);
  assert.equal(current.saved.length, 1);
  assert.equal(current.saved[0].models.length, 2);
  assert.equal(
    current.saved[0].models.every((model) => model.samples.length === 3),
    true
  );
});

test("rejects mixed, overlapping, or repeated historical evidence before model inference", async () => {
  for (const unsafe of [
    { sourceType: "system" },
    { overlapDetected: true },
    { echoDetected: true },
    { excludedFromCentroid: true },
    { micDeviceId: null },
  ]) {
    const current = harness({
      repository: {
        getHistoricalVoiceTurn(id) {
          return id === "two" ? turn("two", 5_900, unsafe) : turn(id, 7_000);
        },
      },
    });
    await assert.rejects(
      current.service.recover({ turnGroups: [["one"], ["two"], ["three"]] }),
      /historical voice evidence is not safe/
    );
    assert.equal(current.saved.length, 0);
  }

  await assert.rejects(
    harness().service.recover({ turnGroups: [["one"], ["two"], ["one"]] }),
    /unique/
  );
});
