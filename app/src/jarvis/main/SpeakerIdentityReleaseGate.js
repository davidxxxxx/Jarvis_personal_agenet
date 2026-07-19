const {
  SPEAKER_IDENTITY_MODEL_POLICY,
} = require("./SessionDiarizationPolicy");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");

const MINIMUM_PRECISION = 0.95;
const MAXIMUM_UNKNOWN_FALSE_POSITIVE_RATE = 0.05;

function finiteRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function closed(reason) {
  return Object.freeze({
    automaticAssociationEnabled: false,
    reason,
    policyId: SPEAKER_IDENTITY_MODEL_POLICY.policyId,
  });
}

function evaluateSpeakerIdentityRelease(evidence) {
  if (!evidence) return closed("evaluation_missing");
  if (
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.policyId !== SPEAKER_IDENTITY_MODEL_POLICY.policyId
  ) {
    return closed("evaluation_invalid");
  }
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);
  if (
    evidence.models?.primary?.modelId !== primary.modelId ||
    evidence.models?.primary?.artifactSha256 !== primary.sha256 ||
    evidence.models?.review?.modelId !== review.modelId ||
    evidence.models?.review?.artifactSha256 !== review.sha256
  ) {
    return closed("evaluation_model_mismatch");
  }
  const report = evidence.report;
  if (
    !report ||
    !Number.isSafeInteger(report.self?.truthSupport) ||
    report.self.truthSupport < 1 ||
    !Number.isSafeInteger(report.self?.automaticSupport) ||
    report.self.automaticSupport < 1 ||
    !Number.isSafeInteger(report.known?.truthSupport) ||
    report.known.truthSupport < 1 ||
    !Number.isSafeInteger(report.known?.automaticSupport) ||
    report.known.automaticSupport < 1 ||
    !Number.isSafeInteger(report.unknown?.truthSupport) ||
    report.unknown.truthSupport < 1 ||
    !finiteRatio(report.self.precision) ||
    !finiteRatio(report.known.precision) ||
    !finiteRatio(report.unknown.falsePositiveRate)
  ) {
    return closed("evaluation_support_invalid");
  }
  if (
    report.self.precision < MINIMUM_PRECISION ||
    report.known.precision < MINIMUM_PRECISION ||
    report.unknown.falsePositiveRate > MAXIMUM_UNKNOWN_FALSE_POSITIVE_RATE
  ) {
    return closed("evaluation_precision_gate_failed");
  }
  if (
    !Array.isArray(report.automaticBoundaries) ||
    report.automaticBoundaries.length === 0 ||
    report.automaticBoundaries.some(
      (entry) => entry?.primaryPass !== true || entry?.reviewPass !== true
    )
  ) {
    return closed("evaluation_boundary_gate_failed");
  }
  return Object.freeze({
    automaticAssociationEnabled: true,
    reason: null,
    policyId: evidence.policyId,
    evaluatedAt: Number.isSafeInteger(evidence.evaluatedAt) ? evidence.evaluatedAt : null,
  });
}

module.exports = {
  MAXIMUM_UNKNOWN_FALSE_POSITIVE_RATE,
  MINIMUM_PRECISION,
  evaluateSpeakerIdentityRelease,
};
