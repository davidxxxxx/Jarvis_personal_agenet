const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION = /^[0-9a-f]{64}$/;
const SAFE_POLICY_ID = /^[A-Za-z0-9_./@+-]{1,200}$/;

const SPEAKER_IDENTITY_RESOLUTION_POLICY = Object.freeze({
  id: "speaker-identity/3dspeaker-campplus-voxceleb-16k-v1@1",
  modelId: "3dspeaker-campplus-voxceleb-16k-v1",
  minimumSpeechMs: 12_000,
  minimumWindows: 3,
  minimumQualityScore: 0.78,
  autoConfirmSimilarity: 0.82,
  suggestSimilarity: 0.72,
  minimumMargin: 0.05,
});
const EXACT_POLICY_FIELDS = Object.freeze(Object.keys(SPEAKER_IDENTITY_RESOLUTION_POLICY));

function assertExactIdentityResolutionPolicy(policy) {
  const keys =
    policy && typeof policy === "object" && !Array.isArray(policy) ? Object.keys(policy) : [];
  if (
    !Object.isFrozen(policy) ||
    keys.length !== EXACT_POLICY_FIELDS.length ||
    EXACT_POLICY_FIELDS.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(policy, field) ||
        policy[field] !== SPEAKER_IDENTITY_RESOLUTION_POLICY[field]
    )
  ) {
    throw new TypeError("the exact identity policy is required");
  }
  return policy;
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function revision(value, name) {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function policyId(value) {
  if (typeof value !== "string" || !SAFE_POLICY_ID.test(value) || value.includes(":")) {
    throw new TypeError("policyId must be a versioned safe identifier");
  }
  return value;
}

function buildIdentityResolutionJobKey({
  sessionId,
  diarizationRevision,
  profileRevision,
  policyId: selectedPolicyId = SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
} = {}) {
  return [
    "resolve_identities",
    safeId(sessionId, "sessionId"),
    revision(diarizationRevision, "diarizationRevision"),
    revision(profileRevision, "profileRevision"),
    policyId(selectedPolicyId),
  ].join(":");
}

function parseIdentityResolutionJobKey(value) {
  if (typeof value !== "string") throw new TypeError("identity resolution job key is required");
  const [prefix, sessionId, diarizationRevision, profileRevision, selectedPolicyId, ...extra] =
    value.split(":");
  if (prefix !== "resolve_identities" || extra.length > 0) {
    throw new TypeError("invalid identity resolution job key");
  }
  return {
    sessionId: safeId(sessionId, "sessionId"),
    diarizationRevision: revision(diarizationRevision, "diarizationRevision"),
    profileRevision: revision(profileRevision, "profileRevision"),
    policyId: policyId(selectedPolicyId),
  };
}

module.exports = {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
  buildIdentityResolutionJobKey,
  parseIdentityResolutionJobKey,
};
