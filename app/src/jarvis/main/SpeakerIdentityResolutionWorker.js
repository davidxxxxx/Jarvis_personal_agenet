const crypto = require("node:crypto");
const SpeakerIdentityResolver = require("./SpeakerIdentityResolver");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
  parseIdentityResolutionJobKey,
} = require("./SpeakerIdentityResolutionPolicy");
const { SESSION_DIARIZATION_POLICY } = require("./SessionDiarizationPolicy");
const { clusterAnonymousSpeakers } = require("./AnonymousSpeakerClusterer");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolutionRunId(inputHash) {
  return `identity_resolution_run_${crypto
    .createHash("sha256")
    .update(inputHash)
    .digest("hex")
    .slice(0, 32)}`;
}

const CLUSTER_BATCH_SIZE = 16;

function defaultYieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareClusters(left, right) {
  return (
    compareText(left.evidenceRunId, right.evidenceRunId) ||
    compareText(left.clusterId, right.clusterId)
  );
}

function anonymousSourceGroup(cluster) {
  if (typeof cluster?.applicationKey === "string" && cluster.applicationKey.trim()) {
    return `application:${cluster.applicationKey.trim().toLocaleLowerCase()}`;
  }
  if (cluster?.trackKind === "mic") return "microphone";
  if (cluster?.trackKind === "system_mix") return "system_mix";
  return null;
}

function canReplaceWeakCandidate(result) {
  return new Set([
    "primary_gate_failed",
    "review_gate_failed",
    "models_disagree",
    "no_dual_candidate",
  ]).has(result?.reason);
}

class SpeakerIdentityResolutionWorker {
  constructor({
    repository,
    resolver = new SpeakerIdentityResolver(),
    dualEvidenceProvider = null,
    dualResolver = null,
    policy = SPEAKER_IDENTITY_RESOLUTION_POLICY,
    diarizationPolicy = SESSION_DIARIZATION_POLICY,
    clock = Date.now,
    yieldToEventLoop = defaultYieldToEventLoop,
  } = {}) {
    const methods = [
      "getSpeakerIdentityResolutionSnapshot",
      "listRejectedSpeakerPersonIds",
      "applySystemSpeakerResolutions",
    ];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("repository must implement identity resolution persistence");
    }
    if (!resolver || typeof resolver.resolveCluster !== "function") {
      throw new TypeError("resolver.resolveCluster is required");
    }
    if ((dualEvidenceProvider === null) !== (dualResolver === null)) {
      throw new TypeError("dualEvidenceProvider and dualResolver must be configured together");
    }
    if (
      dualEvidenceProvider !== null &&
      typeof dualEvidenceProvider.buildClusterEvidence !== "function"
    ) {
      throw new TypeError("dualEvidenceProvider.buildClusterEvidence is required");
    }
    if (dualResolver !== null && typeof dualResolver.resolveCluster !== "function") {
      throw new TypeError("dualResolver.resolveCluster is required");
    }
    assertExactIdentityResolutionPolicy(policy);
    assertExactIdentityResolutionPolicy(resolver.policy);
    if (
      !diarizationPolicy ||
      typeof diarizationPolicy.policyId !== "string" ||
      !new Set([1, 2]).has(diarizationPolicy.inputVersion)
    ) {
      throw new TypeError("a versioned diarizationPolicy is required");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof yieldToEventLoop !== "function") {
      throw new TypeError("yieldToEventLoop must be a function");
    }
    this.repository = repository;
    this.resolver = resolver;
    this.dualEvidenceProvider = dualEvidenceProvider;
    this.dualResolver = dualResolver;
    this.policy = policy;
    this.diarizationPolicy = diarizationPolicy;
    this.clock = clock;
    this.yieldToEventLoop = yieldToEventLoop;
  }

  async run(job, executionContext = null) {
    if (!job || typeof job !== "object") throw new TypeError("job is required");
    if (
      executionContext !== null &&
      (typeof executionContext !== "object" || typeof executionContext.renewLease !== "function")
    ) {
      throw new TypeError("executionContext.renewLease must be a function");
    }
    const renewLease = async () => {
      if (executionContext === null) return true;
      const renewed = await executionContext.renewLease();
      if (renewed === false) throw codedError("JOB_LEASE_LOST");
      return true;
    };
    let identity;
    try {
      identity = parseIdentityResolutionJobKey(job.input_hash);
    } catch {
      throw codedError("IDENTITY_RESOLUTION_STALE_INPUT");
    }
    if (
      job.job_type !== "resolve_identities" ||
      job.session_id !== identity.sessionId ||
      job.track_id !== null ||
      job.chunk_id !== null ||
      job.input_version !== 1 ||
      job.model_version !== this.policy.id ||
      identity.policyId !== this.policy.id
    ) {
      throw codedError("IDENTITY_RESOLUTION_STALE_INPUT");
    }
    const snapshot = this.repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: identity.sessionId,
      at: this.clock(),
      policy: this.policy,
      diarizationPolicy: this.diarizationPolicy,
    });
    if (!snapshot.eligible) throw codedError("IDENTITY_RESOLUTION_DEPENDENCY_INCOMPLETE");
    if (
      snapshot.diarizationRevision !== identity.diarizationRevision ||
      snapshot.profileRevision !== identity.profileRevision
    ) {
      throw codedError("IDENTITY_RESOLUTION_SUPERSEDED");
    }
    const revision = {
      diarizationRevision: identity.diarizationRevision,
      profileRevision: identity.profileRevision,
      policyId: identity.policyId,
    };
    const rejectedByCluster = new Map();
    const clusters = [...snapshot.clusters].sort(compareClusters);
    const results = [];
    const anonymousEvidence = [];
    try {
      for (let index = 0; index < clusters.length; index += 1) {
        const cluster = clusters[index];
        const rejectedPersonIds = this.repository.listRejectedSpeakerPersonIds(
          cluster.clusterId,
          revision
        );
        rejectedByCluster.set(cluster.clusterId, rejectedPersonIds);
        let result;
        if (this.dualEvidenceProvider === null) {
          result = this.resolver.resolveCluster({
            cluster,
            samples: snapshot.samples,
            rejectedPersonIds,
          });
        } else {
          const evidence = await this.dualEvidenceProvider.buildClusterEvidence({
            sessionId: identity.sessionId,
            evidenceRunId: cluster.evidenceRunId,
            clusterId: cluster.clusterId,
            createdAt: this.clock(),
          });
          if (!evidence.eligible) {
            result = {
              candidatePersonId: null,
              state: "unknown",
              score: null,
              margin: null,
              reason: evidence.reason,
            };
          } else {
            try {
              result = this.dualResolver.resolveCluster({
                cluster: {
                  ...cluster,
                  sourceKind: evidence.sourceKind,
                  attributionState: evidence.attributionState,
                  overlapDetected: evidence.overlapDetected,
                  echoDetected: evidence.echoDetected,
                  speechMs: evidence.speechMs,
                  windowCount: evidence.windowCount,
                  qualityScore: evidence.qualityScore,
                  models: evidence.models,
                },
                samples: snapshot.samples,
                rejectedPersonIds,
              });
              if (
                result.state === "unknown" &&
                (!result.candidatePersonRef || canReplaceWeakCandidate(result))
              ) {
                anonymousEvidence.push({
                  clusterId: cluster.clusterId,
                  trackId: cluster.trackId,
                  sourceGroup: anonymousSourceGroup(cluster),
                  speechMs: evidence.speechMs,
                  windowCount: evidence.windowCount,
                  qualityScore: evidence.qualityScore,
                  models: {
                    primary: Float32Array.from(evidence.models.primary.embedding),
                    review: Float32Array.from(evidence.models.review.embedding),
                  },
                });
              }
            } finally {
              for (const model of Object.values(evidence.models ?? {})) {
                model?.embedding?.fill?.(0);
              }
            }
          }
        }
        results.push({
          evidenceRunId: cluster.evidenceRunId,
          clusterId: cluster.clusterId,
          candidatePersonId: result.candidatePersonId,
          ...(result.candidatePersonRef
            ? { candidatePersonRef: result.candidatePersonRef }
            : {}),
          state: result.state,
          score: result.score,
          margin: result.margin,
          reason: result.reason,
          ...(result.models ? { models: result.models } : {}),
        });
        await renewLease();
        if ((index + 1) % CLUSTER_BATCH_SIZE === 0 || index === clusters.length - 1) {
          await this.yieldToEventLoop();
        }
      }

      const anonymousAssignments = clusterAnonymousSpeakers(anonymousEvidence);
      for (const result of results) {
        const assignment = anonymousAssignments.get(result.clusterId);
        if (
          !assignment ||
          result.state !== "unknown" ||
          (result.candidatePersonRef && !canReplaceWeakCandidate(result))
        ) {
          continue;
        }
        result.candidatePersonId = null;
        result.candidatePersonRef = assignment.candidatePersonRef;
        result.score = assignment.score;
        result.margin = assignment.margin;
        result.reason = "dual_model_anonymous_group";
      }
    } finally {
      for (const evidence of anonymousEvidence) {
        evidence.models.primary.fill(0);
        evidence.models.review.fill(0);
      }
    }
    await renewLease();
    const precommit = this.repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: identity.sessionId,
      at: this.clock(),
      policy: this.policy,
      diarizationPolicy: this.diarizationPolicy,
    });
    if (
      !precommit.eligible ||
      precommit.diarizationRevision !== identity.diarizationRevision ||
      precommit.profileRevision !== identity.profileRevision ||
      precommit.evidenceRunIds.length !== snapshot.evidenceRunIds.length ||
      precommit.evidenceRunIds.some((runId, index) => runId !== snapshot.evidenceRunIds[index])
    ) {
      throw codedError("IDENTITY_RESOLUTION_SUPERSEDED");
    }
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      const before = rejectedByCluster.get(cluster.clusterId);
      const after = this.repository.listRejectedSpeakerPersonIds(cluster.clusterId, revision);
      if (
        before.length !== after.length ||
        before.some((personId, index) => personId !== after[index])
      ) {
        throw codedError("IDENTITY_RESOLUTION_REJECTION_CHANGED");
      }
      await renewLease();
      if ((index + 1) % CLUSTER_BATCH_SIZE === 0 || index === clusters.length - 1) {
        await this.yieldToEventLoop();
      }
    }
    await renewLease();
    const persisted = this.repository.applySystemSpeakerResolutions({
      id: resolutionRunId(job.input_hash),
      sessionId: identity.sessionId,
      ...revision,
      evidenceRunIds: snapshot.evidenceRunIds,
      results,
      at: this.clock(),
    });
    return {
      status: "completed",
      executionDevice: "cpu",
      resultCount: persisted.length,
    };
  }
}

module.exports = SpeakerIdentityResolutionWorker;
