const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluateSpeakerIdentityRelease,
} = require("../../src/jarvis/main/SpeakerIdentityReleaseGate");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");

function evidence() {
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  return {
    schemaVersion: 1,
    policyId: "jarvis-dual-speaker-identity-v1",
    evaluatedAt: 123,
    models: {
      primary: { modelId: primary.modelId, artifactSha256: primary.sha256 },
      review: { modelId: review.modelId, artifactSha256: review.sha256 },
    },
    report: {
      self: { truthSupport: 30, automaticSupport: 25, precision: 0.96 },
      known: { truthSupport: 30, automaticSupport: 24, precision: 0.95 },
      unknown: { truthSupport: 20, falsePositiveRate: 0.05 },
      automaticBoundaries: [{ primaryPass: true, reviewPass: true }],
    },
  };
}

test("automatic speaker association opens only for both pinned models and passing held-out metrics", () => {
  assert.equal(evaluateSpeakerIdentityRelease(null).automaticAssociationEnabled, false);
  assert.equal(evaluateSpeakerIdentityRelease(evidence()).automaticAssociationEnabled, true);

  const lowPrecision = evidence();
  lowPrecision.report.known.precision = 0.949;
  assert.deepEqual(evaluateSpeakerIdentityRelease(lowPrecision), {
    automaticAssociationEnabled: false,
    reason: "evaluation_precision_gate_failed",
    policyId: "jarvis-dual-speaker-identity-v1",
  });

  const oneModelBoundary = evidence();
  oneModelBoundary.report.automaticBoundaries[0].reviewPass = false;
  assert.equal(
    evaluateSpeakerIdentityRelease(oneModelBoundary).reason,
    "evaluation_boundary_gate_failed"
  );
});
