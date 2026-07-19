const assert = require("node:assert/strict");
const test = require("node:test");

const DualSpeakerIdentityResolver = require("../../src/jarvis/main/DualSpeakerIdentityResolver");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");

const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);

function vector(index) {
  const value = new Float32Array(192);
  value[index] = 1;
  return value;
}

function samples() {
  return [
    { personId: "self", modelId: primary.modelId, embedding: vector(0) },
    { personId: "person-2", modelId: primary.modelId, embedding: vector(1) },
    { personId: "self", modelId: review.modelId, embedding: vector(4) },
    { personId: "person-2", modelId: review.modelId, embedding: vector(5) },
  ];
}

function cluster(overrides = {}) {
  return {
    attributionState: "exact",
    overlapDetected: false,
    echoDetected: false,
    speechMs: 20_000,
    windowCount: 3,
    qualityScore: 0.95,
    models: {
      primary: {
        modelId: primary.modelId,
        embeddingSpace: primary.embeddingSpace,
        embedding: vector(0),
      },
      review: {
        modelId: review.modelId,
        embeddingSpace: review.embeddingSpace,
        embedding: vector(4),
      },
    },
    ...overrides,
  };
}

test("dual resolver emits a candidate while held-out evaluation remains closed", () => {
  const result = new DualSpeakerIdentityResolver().resolveCluster({
    cluster: cluster(),
    samples: samples(),
  });
  assert.equal(result.state, "suggested");
  assert.equal(result.candidatePersonId, "self");
  assert.equal(result.reason, "evaluation_missing");
  assert.equal(result.models.primary.passed, true);
  assert.equal(result.models.review.passed, true);
});

test("single-model matches, disagreement, unknown source, overlap, and rejection stay unknown", () => {
  const resolver = new DualSpeakerIdentityResolver();
  const missingReview = cluster({
    models: { ...cluster().models, review: null },
  });
  assert.equal(
    resolver.resolveCluster({ cluster: missingReview, samples: samples() }).reason,
    "dual_embedding_missing"
  );
  const disagreement = cluster({
    models: {
      ...cluster().models,
      review: { ...cluster().models.review, embedding: vector(5) },
    },
  });
  assert.equal(
    resolver.resolveCluster({ cluster: disagreement, samples: samples() }).reason,
    "models_disagree"
  );
  assert.equal(
    resolver.resolveCluster({
      cluster: cluster({ attributionState: "mixed_unknown" }),
      samples: samples(),
    }).reason,
    "source_unknown"
  );
  assert.equal(
    resolver.resolveCluster({
      cluster: cluster({ overlapDetected: true }),
      samples: samples(),
    }).reason,
    "overlapping_speech"
  );
  assert.equal(
    resolver.resolveCluster({
      cluster: cluster(),
      samples: samples(),
      rejectedPersonIds: ["self"],
    }).candidatePersonId,
    "person-2"
  );
});
