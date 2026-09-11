const assert = require("node:assert/strict");
const test = require("node:test");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const VoiceEmbeddingCipher = require("../../src/jarvis/main/VoiceEmbeddingCipher");
const VoiceEnrollmentService = require("../../src/jarvis/main/VoiceEnrollmentService");
const VoiceProfileStore = require("../../src/jarvis/main/VoiceProfileStore");
const {
  CAPTURE_SAMPLE_RATE,
  DUAL_SELF_PROFILE_POLICY,
} = require("../../src/jarvis/main/VoiceEnrollmentService");

const OWNER_ID = 77;
const WINDOW_SAMPLES = CAPTURE_SAMPLE_RATE * 10;
const DIMENSION = 192;

function vector(index = 0, secondary = null) {
  const value = new Float32Array(DIMENSION);
  value[index] = 1;
  if (secondary !== null) value[secondary] = 0.02;
  return value;
}

function payload(label = "RØDE NT-USB Microphone") {
  return {
    sampleRate: CAPTURE_SAMPLE_RATE,
    channels: 1,
    format: "float32",
    recordedSampleCount: CAPTURE_SAMPLE_RATE * 32,
    source: {
      kind: "microphone",
      deviceId: "physical-mic-1",
      label,
    },
    windows: [0, 1, 2].map((index) => ({
      startSample: index * WINDOW_SAMPLES,
      endSample: (index + 1) * WINDOW_SAMPLES,
      samples: new Float32Array(WINDOW_SAMPLES).fill(0.2),
    })),
  };
}

function runtime(vectors) {
  let index = 0;
  return {
    calls: 0,
    async extractEmbeddingFromSamples(samples) {
      this.calls += 1;
      assert.equal(samples.length, 160_000);
      return vectors[index++] ?? null;
    },
  };
}

function serviceHarness({ primaryVectors, reviewVectors, speechDurations } = {}) {
  let now = 1_000;
  let speechWindow = 0;
  const primary = runtime(
    primaryVectors ?? [vector(0, 1), vector(0, 2), vector(0, 3)]
  );
  const review = runtime(
    reviewVectors ?? [vector(5, 6), vector(5, 7), vector(5, 8)]
  );
  const saved = [];
  const service = new VoiceEnrollmentService({
    primarySpeakerEmbeddings: primary,
    reviewSpeakerEmbeddings: review,
    speechDurationMeasurer: {
      async measureSpeechMs() {
        return speechDurations?.[speechWindow++] ?? 10_000;
      },
    },
    voiceProfileStore: {
      getDualStatus: () => ({ enrolled: false }),
      saveDualEnrollment(input) {
        saved.push({
          policyId: input.policyId,
          modelIds: input.models.map((entry) => entry.modelId),
          dimensions: input.models.map((entry) => entry.centroid.length),
          consistency: input.models.map((entry) => entry.selfConsistency),
        });
      },
    },
    createId: () => "dual-enrollment",
    now: () => now,
  });
  const session = service.begin({ ownerId: OWNER_ID });
  now += 32_000;
  return { service, session, primary, review, saved };
}

function normalized(index) {
  return vector(index);
}

function dualEnrollment() {
  return {
    policyId: DUAL_SELF_PROFILE_POLICY.policyId,
    sampleSpeechMs: [10_000, 10_000, 10_000],
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    models: [
      {
        role: "primary",
        modelId: DUAL_SELF_PROFILE_POLICY.primary.modelId,
        embeddingSpace: DUAL_SELF_PROFILE_POLICY.primary.embeddingSpace,
        samples: [normalized(0), normalized(0), normalized(0)],
        centroid: normalized(0),
        selfConsistency: 1,
      },
      {
        role: "review",
        modelId: DUAL_SELF_PROFILE_POLICY.review.modelId,
        embeddingSpace: DUAL_SELF_PROFILE_POLICY.review.embeddingSpace,
        samples: [normalized(1), normalized(1), normalized(1)],
        centroid: normalized(1),
        selfConsistency: 1,
      },
    ],
  };
}

function fakeCipher() {
  return new VoiceEmbeddingCipher({
    secretCrypto: {
      isAvailable: () => true,
      encrypt(value) {
        return Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
      },
      decrypt(value) {
        const text = Buffer.from(value).toString("utf8");
        if (!text.startsWith("sealed:")) throw new Error("bad ciphertext");
        return {
          value: Buffer.from(text.slice(7), "base64").toString("utf8"),
          needsReencrypt: false,
        };
      },
    },
  });
}

test("production enrollment accepts one physical microphone sample set in both model spaces", async () => {
  const harness = serviceHarness();
  const input = payload();
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: harness.session.sessionId,
    payload: input,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.modelId, DUAL_SELF_PROFILE_POLICY.policyId);
  assert.equal(result.models.length, 2);
  assert.equal(result.models.every((entry) => entry.selfConsistency >= 0.99), true);
  assert.equal(harness.primary.calls, 3);
  assert.equal(harness.review.calls, 3);
  assert.deepEqual(harness.saved[0].dimensions, [DIMENSION, DIMENSION]);
  assert.equal(
    input.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
});

test("dual enrollment accepts natural pauses but rejects a mostly silent sample window", async () => {
  const accepted = serviceHarness({ speechDurations: [7_000, 6_500, 7_000] });
  const acceptedResult = await accepted.service.complete({
    ownerId: OWNER_ID,
    sessionId: accepted.session.sessionId,
    payload: payload(),
  });
  assert.equal(acceptedResult.status, "accepted");
  assert.equal(acceptedResult.acceptedSpeechMs, 20_500);
  assert.equal(accepted.saved.length, 1);

  const rejected = serviceHarness({ speechDurations: [10_000, 4_999, 10_000] });
  const rejectedResult = await rejected.service.complete({
    ownerId: OWNER_ID,
    sessionId: rejected.session.sessionId,
    payload: payload(),
  });
  assert.equal(rejectedResult.status, "insufficient_speech");
  assert.equal(rejectedResult.acceptedSpeechMs, 24_999);
  assert.deepEqual(rejectedResult.sampleSpeechMs, [10_000, 4_999, 10_000]);
  assert.equal(rejected.saved.length, 0);
});

test("production enrollment rejects virtual microphones before running either model", async () => {
  const harness = serviceHarness();
  const input = payload("SteelSeries Sonar - Microphone");
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: harness.session.sessionId,
    payload: input,
  });

  assert.equal(result.status, "unsupported_microphone");
  assert.equal(harness.primary.calls, 0);
  assert.equal(harness.review.calls, 0);
  assert.equal(harness.saved.length, 0);
});

test("dual enrollment persistence is atomic and encrypted at rest", (t) => {
  const repository = new JarvisRepository(":memory:", { embeddingCipher: fakeCipher() });
  t.after(() => repository.close());
  repository.renamePerson({ personId: "self", displayName: "我", isSelf: true });
  const store = new VoiceProfileStore({ repository, now: () => 50_000 });

  store.saveDualEnrollment(dualEnrollment());
  const status = store.getDualStatus();
  assert.equal(status.enrolled, true);
  assert.equal(status.models.length, 2);
  assert.equal(status.models.every((entry) => entry.enrolled), true);
  const raw = repository.db
    .prepare("SELECT embedding FROM voice_profile_samples ORDER BY model_id, id")
    .all();
  assert.equal(raw.length, 6);
  assert.equal(raw.every((row) => row.embedding.subarray(0, 4).toString() === "JVE1"), true);
  assert.equal(repository.listVoiceProfiles(DUAL_SELF_PROFILE_POLICY.primary.modelId).length, 3);

  repository.db.exec(`
    CREATE TRIGGER abort_review_enrollment
    BEFORE UPDATE ON voice_profile_aggregates
    WHEN NEW.model_id = '${DUAL_SELF_PROFILE_POLICY.review.modelId}'
    BEGIN SELECT RAISE(ABORT, 'forced dual rollback'); END;
  `);
  const before = repository.db
    .prepare("SELECT id, embedding FROM voice_profile_samples ORDER BY id")
    .all()
    .map((row) => ({ id: row.id, embedding: Buffer.from(row.embedding) }));
  assert.throws(() => store.saveDualEnrollment(dualEnrollment()), /forced dual rollback/);
  const after = repository.db
    .prepare("SELECT id, embedding FROM voice_profile_samples ORDER BY id")
    .all()
    .map((row) => ({ id: row.id, embedding: Buffer.from(row.embedding) }));
  assert.deepEqual(after, before);

  assert.throws(
    () =>
      store.saveDualEnrollment({
        ...dualEnrollment(),
        sampleSpeechMs: [10_000, 4_999, 10_000],
        acceptedSpeechMs: 24_999,
      }),
    /evidence policy/
  );
});
