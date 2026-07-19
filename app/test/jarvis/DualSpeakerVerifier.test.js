const assert = require("node:assert/strict");
const test = require("node:test");

const DualSpeakerVerifier = require("../../src/jarvis/main/DualSpeakerVerifier");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");

function unitVector(index) {
  const value = new Float32Array(192);
  value[index] = 1;
  return value;
}

function embeddingRuntime(embedding, calls, label) {
  return {
    async extractEmbeddingFromSamples(samples) {
      calls.push({ label, samples });
      return Float32Array.from(embedding);
    },
    cosineSimilarity(left, right) {
      let dot = 0;
      for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
      return dot;
    },
  };
}

function resourceGovernor(action = "run_cpu", reason = "cpu_backend") {
  return {
    admit(kind, snapshot, capability) {
      assert.equal(kind, "speaker");
      assert.equal(capability.executionDevice, "cpu");
      assert.equal(capability.available, true);
      return { action, reason, snapshot };
    },
  };
}

function passingReleaseEvidence() {
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  return {
    schemaVersion: 1,
    policyId: "jarvis-dual-speaker-identity-v1",
    evaluatedAt: 100,
    models: {
      primary: { modelId: primary.modelId, artifactSha256: primary.sha256 },
      review: { modelId: review.modelId, artifactSha256: review.sha256 },
    },
    report: {
      self: { truthSupport: 20, automaticSupport: 18, precision: 1 },
      known: { truthSupport: 20, automaticSupport: 17, precision: 1 },
      unknown: { truthSupport: 20, falsePositiveRate: 0 },
      automaticBoundaries: [{ primaryPass: true, reviewPass: true }],
    },
  };
}

test("all-day screening runs only CAM++ and reports its embedding space", async () => {
  const calls = [];
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const verifier = new DualSpeakerVerifier({
    primaryEmbeddings: embeddingRuntime(unitVector(0), calls, "primary"),
    reviewEmbeddings: embeddingRuntime(unitVector(1), calls, "review"),
    resourceGovernor: resourceGovernor(),
  });
  const samples = new Float32Array(24_000);

  const result = await verifier.screen({ samples, snapshot: { state: "unavailable" } });

  assert.equal(result.status, "completed");
  assert.equal(result.stage, "primary");
  assert.equal(result.modelId, primary.modelId);
  assert.equal(result.embeddingSpace, primary.embeddingSpace);
  assert.deepEqual(calls.map((entry) => entry.label), ["primary"]);
});

test("ERes2NetV2 review defers under pressure without running inference", async () => {
  const calls = [];
  let admissions = 0;
  const verifier = new DualSpeakerVerifier({
    primaryEmbeddings: embeddingRuntime(unitVector(0), calls, "primary"),
    reviewEmbeddings: embeddingRuntime(unitVector(0), calls, "review"),
    resourceGovernor: {
      admit() {
        admissions += 1;
        return admissions === 1
          ? { action: "run_cpu", reason: "cpu_backend" }
          : { action: "defer", reason: "fullscreen_game" };
      },
    },
  });

  const result = await verifier.verify({
    samples: new Float32Array(24_000),
    reason: "high_impact",
    snapshot: { state: "busy" },
    references: {
      primary: {
        modelId: getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY).modelId,
        embeddingSpace: getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY).embeddingSpace,
        embedding: unitVector(0),
        nearestOtherSimilarity: 0.1,
      },
      review: {
        modelId: getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW).modelId,
        embeddingSpace: getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW).embeddingSpace,
        embedding: unitVector(0),
        nearestOtherSimilarity: 0.1,
      },
    },
    quality: 0.95,
    contiguousWindows: 3,
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "fullscreen_game");
  assert.deepEqual(calls.map((entry) => entry.label), ["primary"]);
});

test("automatic identity requires both isolated models, margin gates, and evaluation release", async () => {
  const calls = [];
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  const references = {
    primary: {
      modelId: primary.modelId,
      embeddingSpace: primary.embeddingSpace,
      embedding: unitVector(0),
      nearestOtherSimilarity: 0.2,
    },
    review: {
      modelId: review.modelId,
      embeddingSpace: review.embeddingSpace,
      embedding: unitVector(0),
      nearestOtherSimilarity: 0.2,
    },
  };
  const verifier = new DualSpeakerVerifier({
    primaryEmbeddings: embeddingRuntime(unitVector(0), calls, "primary"),
    reviewEmbeddings: embeddingRuntime(unitVector(0), calls, "review"),
    resourceGovernor: resourceGovernor(),
    releaseEvidence: passingReleaseEvidence(),
  });

  const result = await verifier.verify({
    samples: new Float32Array(24_000),
    reason: "boundary",
    snapshot: { state: "available" },
    references,
    quality: 0.95,
    contiguousWindows: 3,
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.dualPass, true);
  assert.equal(result.autoAssociate, true);
  assert.equal(result.primary.modelId, primary.modelId);
  assert.equal(result.review.modelId, review.modelId);
  assert.notEqual(result.primary.embeddingSpace, result.review.embeddingSpace);
  assert.deepEqual(calls.map((entry) => entry.label), ["primary", "review"]);

  const gated = new DualSpeakerVerifier({
    primaryEmbeddings: embeddingRuntime(unitVector(0), [], "primary"),
    reviewEmbeddings: embeddingRuntime(unitVector(0), [], "review"),
    resourceGovernor: resourceGovernor(),
  });
  const candidate = await gated.verify({
    samples: new Float32Array(24_000),
    reason: "idle",
    snapshot: { state: "available" },
    references,
    quality: 0.95,
    contiguousWindows: 3,
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.dualPass, true);
  assert.equal(candidate.autoAssociate, false);
  assert.equal(candidate.reason, "evaluation_missing");
});

test("cross-model references are rejected before any embedding runs", async () => {
  const calls = [];
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  const verifier = new DualSpeakerVerifier({
    primaryEmbeddings: embeddingRuntime(unitVector(0), calls, "primary"),
    reviewEmbeddings: embeddingRuntime(unitVector(0), calls, "review"),
    resourceGovernor: resourceGovernor(),
  });

  await assert.rejects(
    verifier.verify({
      samples: new Float32Array(24_000),
      reason: "idle",
      snapshot: { state: "available" },
      quality: 0.95,
      contiguousWindows: 3,
      references: {
        primary: {
          modelId: review.modelId,
          embeddingSpace: review.embeddingSpace,
          embedding: unitVector(0),
          nearestOtherSimilarity: 0,
        },
        review: {
          modelId: primary.modelId,
          embeddingSpace: primary.embeddingSpace,
          embedding: unitVector(0),
          nearestOtherSimilarity: 0,
        },
      },
    }),
    (error) => error.code === "SPEAKER_EMBEDDING_SPACE_MISMATCH"
  );
  assert.deepEqual(calls, []);
});
