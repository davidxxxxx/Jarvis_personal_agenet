const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION = /^[0-9a-f]{64}$/;

const SESSION_DIARIZATION_POLICY = Object.freeze({
  policyId: "jarvis-session-diarization-v1",
  diarizerModelId: "sherpa-segmentation+3dspeaker-campplus",
  embeddingModelId: "3dspeaker-campplus-voxceleb-16k-v1",
  embeddingDimension: 512,
  sampleRate: 16_000,
  minimumEmbeddingMs: 1_500,
  maximumEmbeddingMs: 8_000,
  inputVersion: 1,
  clusterSimilarityThreshold: 0.72,
  echoSimilarityThreshold: 0.95,
});

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function revision(value) {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new TypeError("transcriptRevision must be a lowercase SHA-256 digest");
  }
  return value;
}

function buildDiarizationJobKey({
  sessionId,
  trackId,
  transcriptRevision,
  policyId = SESSION_DIARIZATION_POLICY.policyId,
} = {}) {
  return [
    "diarize_track",
    safeId(sessionId, "sessionId"),
    safeId(trackId, "trackId"),
    revision(transcriptRevision),
    safeId(policyId, "policyId"),
  ].join(":");
}

function parseDiarizationJobKey(value) {
  if (typeof value !== "string") throw new TypeError("diarization job key must be a string");
  const [prefix, sessionId, trackId, transcriptRevision, policyId, ...extra] = value.split(":");
  if (prefix !== "diarize_track" || extra.length > 0) {
    throw new TypeError("invalid diarization job key");
  }
  return {
    sessionId: safeId(sessionId, "sessionId"),
    trackId: safeId(trackId, "trackId"),
    transcriptRevision: revision(transcriptRevision),
    policyId: safeId(policyId, "policyId"),
  };
}

module.exports = {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
  parseDiarizationJobKey,
};
