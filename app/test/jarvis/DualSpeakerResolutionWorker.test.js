const test = require("node:test");
const assert = require("node:assert/strict");

const SpeakerIdentityResolutionWorker = require("../../src/jarvis/main/SpeakerIdentityResolutionWorker");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  buildIdentityResolutionJobKey,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");

function fixture({ evidenceResult, resolverResult }) {
  const identity = {
    sessionId: "session-dual",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const cluster = {
    evidenceRunId: "run-dual",
    clusterId: "cluster-dual",
    speechMs: 14_000,
    windowCount: 3,
    qualityScore: 0.9,
  };
  const commits = [];
  const repository = {
    getSpeakerIdentityResolutionSnapshot: () => ({
      eligible: true,
      ...identity,
      evidenceRunIds: ["run-dual"],
      clusters: [cluster],
      samples: [{ id: "profile", modelId: "dual", embedding: new Float32Array([1]) }],
    }),
    listRejectedSpeakerPersonIds: () => [],
    applySystemSpeakerResolutions: (input) => {
      commits.push(input);
      return input.results;
    },
  };
  const providerCalls = [];
  const dualEvidenceProvider = {
    async buildClusterEvidence(input) {
      providerCalls.push(input);
      return evidenceResult;
    },
  };
  const resolverCalls = [];
  const dualResolver = {
    resolveCluster(input) {
      resolverCalls.push(input);
      return resolverResult;
    },
  };
  const worker = new SpeakerIdentityResolutionWorker({
    repository,
    dualEvidenceProvider,
    dualResolver,
    clock: () => 20_000,
    yieldToEventLoop: async () => {},
  });
  const job = {
    job_type: "resolve_identities",
    session_id: identity.sessionId,
    track_id: null,
    chunk_id: null,
    input_hash: buildIdentityResolutionJobKey(identity),
    input_version: 1,
    model_version: identity.policyId,
  };
  return { worker, job, commits, providerCalls, resolverCalls, cluster };
}

test("resolution worker uses persisted dual-model evidence and clears private vectors", async () => {
  const primary = new Float32Array([1, 0]);
  const review = new Float32Array([0, 1]);
  const setup = fixture({
    evidenceResult: {
      eligible: true,
      attributionState: "exact",
      overlapDetected: false,
      echoDetected: false,
      speechMs: 14_000,
      windowCount: 3,
      qualityScore: 0.9,
      models: {
        primary: {
          modelId: "primary",
          embeddingSpace: "primary-space",
          embedding: primary,
        },
        review: {
          modelId: "review",
          embeddingSpace: "review-space",
          embedding: review,
        },
      },
    },
    resolverResult: {
      candidatePersonId: "person-3",
      state: "suggested",
      score: 0.91,
      margin: 0.12,
      reason: "evaluation_missing",
    },
  });

  const result = await setup.worker.run(setup.job);

  assert.deepEqual(result, {
    status: "completed",
    executionDevice: "cpu",
    resultCount: 1,
  });
  assert.deepEqual(setup.providerCalls, [
    {
      sessionId: "session-dual",
      evidenceRunId: "run-dual",
      clusterId: "cluster-dual",
      createdAt: 20_000,
    },
  ]);
  assert.equal(setup.resolverCalls.length, 1);
  assert.equal(setup.resolverCalls[0].cluster.attributionState, "exact");
  assert.equal(setup.commits[0].results[0].candidatePersonId, "person-3");
  assert.equal(setup.commits[0].results[0].state, "suggested");
  assert.deepEqual([...primary], [0, 0]);
  assert.deepEqual([...review], [0, 0]);
});

test("resolution worker persists unknown when safe dual evidence cannot be built", async () => {
  const setup = fixture({
    evidenceResult: { eligible: false, reason: "overlapping_speech" },
    resolverResult: null,
  });

  await setup.worker.run(setup.job);

  assert.equal(setup.resolverCalls.length, 0);
  assert.deepEqual(setup.commits[0].results[0], {
    evidenceRunId: "run-dual",
    clusterId: "cluster-dual",
    candidatePersonId: null,
    state: "unknown",
    score: null,
    margin: null,
    reason: "overlapping_speech",
  });
});
