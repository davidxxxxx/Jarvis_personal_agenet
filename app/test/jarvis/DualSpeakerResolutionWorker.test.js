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

test("resolution worker assigns one local anonymous reference to the same speaker across tracks", async () => {
  const identity = {
    sessionId: "session-cross-track",
    diarizationRevision: "c".repeat(64),
    profileRevision: "d".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const clusters = [
    {
      evidenceRunId: "run-mic",
      clusterId: "cluster-mic",
      trackId: "track-mic",
      speechMs: 20_000,
      windowCount: 4,
      qualityScore: 0.95,
    },
    {
      evidenceRunId: "run-app",
      clusterId: "cluster-app",
      trackId: "track-app",
      speechMs: 18_000,
      windowCount: 4,
      qualityScore: 0.94,
    },
  ];
  const commits = [];
  const privateVectors = [];
  const worker = new SpeakerIdentityResolutionWorker({
    repository: {
      getSpeakerIdentityResolutionSnapshot: () => ({
        eligible: true,
        ...identity,
        evidenceRunIds: ["run-mic", "run-app"],
        clusters,
        samples: [],
      }),
      listRejectedSpeakerPersonIds: () => [],
      applySystemSpeakerResolutions(input) {
        commits.push(input);
        return input.results;
      },
    },
    dualEvidenceProvider: {
      async buildClusterEvidence({ clusterId }) {
        const primary = new Float32Array([1, clusterId === "cluster-mic" ? 0 : 0.01]);
        const review = new Float32Array([0.01, 1]);
        privateVectors.push(primary, review);
        return {
          eligible: true,
          attributionState: "exact",
          overlapDetected: false,
          echoDetected: false,
          speechMs: 16_000,
          windowCount: 4,
          qualityScore: 0.94,
          models: {
            primary: {
              modelId: "primary",
              artifactVersion: "primary-v1",
              embeddingSpace: "primary-space",
              embedding: primary,
            },
            review: {
              modelId: "review",
              artifactVersion: "review-v1",
              embeddingSpace: "review-space",
              embedding: review,
            },
          },
        };
      },
    },
    dualResolver: {
      resolveCluster() {
        return {
          candidatePersonId: null,
          state: "unknown",
          score: null,
          margin: null,
          reason: "no_dual_candidate",
        };
      },
    },
    clock: () => 30_000,
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

  await worker.run(job);

  const refs = commits[0].results.map((result) => result.candidatePersonRef);
  assert.match(refs[0], /^anonymous-speaker-[0-9a-f]{32}$/u);
  assert.deepEqual(refs, [refs[0], refs[0]]);
  assert.deepEqual(
    commits[0].results.map((result) => result.reason),
    ["dual_model_anonymous_group", "dual_model_anonymous_group"]
  );
  assert.equal(privateVectors.every((vector) => vector.every((value) => value === 0)), true);
});

test("weak SELF candidates can still form a same-application anonymous person", async () => {
  const identity = {
    sessionId: "session-weak-self",
    diarizationRevision: "e".repeat(64),
    profileRevision: "f".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const clusters = [
    {
      evidenceRunId: "run-kook-1",
      clusterId: "cluster-kook-1",
      trackId: "track-kook-1",
      trackKind: "application",
      applicationKey: "kook",
      speechMs: 20_000,
      windowCount: 4,
      qualityScore: 0.95,
    },
    {
      evidenceRunId: "run-kook-2",
      clusterId: "cluster-kook-2",
      trackId: "track-kook-2",
      trackKind: "application",
      applicationKey: "KOOK",
      speechMs: 18_000,
      windowCount: 4,
      qualityScore: 0.94,
    },
  ];
  const commits = [];
  const worker = new SpeakerIdentityResolutionWorker({
    repository: {
      getSpeakerIdentityResolutionSnapshot: () => ({
        eligible: true,
        ...identity,
        evidenceRunIds: ["run-kook-1", "run-kook-2"],
        clusters,
        samples: [],
      }),
      listRejectedSpeakerPersonIds: () => [],
      applySystemSpeakerResolutions(input) {
        commits.push(input);
        return input.results;
      },
    },
    dualEvidenceProvider: {
      async buildClusterEvidence({ clusterId }) {
        return {
          eligible: true,
          attributionState: "exact",
          overlapDetected: false,
          echoDetected: false,
          speechMs: 16_000,
          windowCount: 4,
          qualityScore: 0.94,
          models: {
            primary: {
              modelId: "primary",
              artifactVersion: "primary-v1",
              embeddingSpace: "primary-space",
              embedding: new Float32Array([
                1,
                clusterId === "cluster-kook-1" ? 0 : 0.01,
              ]),
            },
            review: {
              modelId: "review",
              artifactVersion: "review-v1",
              embeddingSpace: "review-space",
              embedding: new Float32Array([0.01, 1]),
            },
          },
        };
      },
    },
    dualResolver: {
      resolveCluster() {
        return {
          candidatePersonId: "self",
          candidatePersonRef: "self",
          state: "unknown",
          score: 0.68,
          margin: 0.08,
          reason: "review_gate_failed",
        };
      },
    },
    clock: () => 40_000,
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

  await worker.run(job);

  const results = commits[0].results;
  assert.match(results[0].candidatePersonRef, /^anonymous-speaker-[0-9a-f]{32}$/u);
  assert.equal(results[1].candidatePersonRef, results[0].candidatePersonRef);
  assert.deepEqual(
    results.map((result) => result.reason),
    ["dual_model_anonymous_group", "dual_model_anonymous_group"]
  );
  assert.deepEqual(
    results.map((result) => result.candidatePersonId),
    [null, null]
  );
});

test("anonymous grouping never joins different application sources", async () => {
  const identity = {
    sessionId: "session-source-boundary",
    diarizationRevision: "1".repeat(64),
    profileRevision: "2".repeat(64),
    policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
  };
  const clusters = [
    {
      evidenceRunId: "run-kook",
      clusterId: "cluster-kook",
      trackId: "track-kook",
      trackKind: "application",
      applicationKey: "kook",
    },
    {
      evidenceRunId: "run-dota",
      clusterId: "cluster-dota",
      trackId: "track-dota",
      trackKind: "application",
      applicationKey: "dota2",
    },
  ];
  const commits = [];
  const worker = new SpeakerIdentityResolutionWorker({
    repository: {
      getSpeakerIdentityResolutionSnapshot: () => ({
        eligible: true,
        ...identity,
        evidenceRunIds: ["run-kook", "run-dota"],
        clusters,
        samples: [],
      }),
      listRejectedSpeakerPersonIds: () => [],
      applySystemSpeakerResolutions(input) {
        commits.push(input);
        return input.results;
      },
    },
    dualEvidenceProvider: {
      async buildClusterEvidence() {
        return {
          eligible: true,
          attributionState: "exact",
          overlapDetected: false,
          echoDetected: false,
          speechMs: 16_000,
          windowCount: 4,
          qualityScore: 0.94,
          models: {
            primary: {
              modelId: "primary",
              artifactVersion: "primary-v1",
              embeddingSpace: "primary-space",
              embedding: new Float32Array([1, 0]),
            },
            review: {
              modelId: "review",
              artifactVersion: "review-v1",
              embeddingSpace: "review-space",
              embedding: new Float32Array([0, 1]),
            },
          },
        };
      },
    },
    dualResolver: {
      resolveCluster() {
        return {
          candidatePersonId: null,
          state: "unknown",
          score: null,
          margin: null,
          reason: "no_dual_candidate",
        };
      },
    },
    clock: () => 50_000,
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

  await worker.run(job);

  assert.deepEqual(
    commits[0].results.map((result) => result.candidatePersonRef ?? null),
    [null, null]
  );
});
