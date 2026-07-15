const crypto = require("node:crypto");
const SpeakerIdentityResolver = require("./SpeakerIdentityResolver");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  parseIdentityResolutionJobKey,
} = require("./SpeakerIdentityResolutionPolicy");

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

class SpeakerIdentityResolutionWorker {
  constructor({
    repository,
    resolver = new SpeakerIdentityResolver(),
    policy = SPEAKER_IDENTITY_RESOLUTION_POLICY,
    clock = Date.now,
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
    if (!policy || policy.id !== SPEAKER_IDENTITY_RESOLUTION_POLICY.id) {
      throw new TypeError("the exact versioned identity policy is required");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.repository = repository;
    this.resolver = resolver;
    this.policy = policy;
    this.clock = clock;
  }

  async run(job) {
    if (!job || typeof job !== "object") throw new TypeError("job is required");
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
    const results = snapshot.clusters.map((cluster) => {
      const rejectedPersonIds = this.repository.listRejectedSpeakerPersonIds(
        cluster.clusterId,
        revision
      );
      rejectedByCluster.set(cluster.clusterId, rejectedPersonIds);
      const result = this.resolver.resolveCluster({
        cluster,
        samples: snapshot.samples,
        rejectedPersonIds,
      });
      return {
        evidenceRunId: cluster.evidenceRunId,
        clusterId: cluster.clusterId,
        candidatePersonId: result.candidatePersonId,
        state: result.state,
        score: result.score,
        margin: result.margin,
        reason: result.reason,
      };
    });
    const precommit = this.repository.getSpeakerIdentityResolutionSnapshot({
      sessionId: identity.sessionId,
      at: this.clock(),
      policy: this.policy,
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
    for (const cluster of snapshot.clusters) {
      const before = rejectedByCluster.get(cluster.clusterId);
      const after = this.repository.listRejectedSpeakerPersonIds(cluster.clusterId, revision);
      if (
        before.length !== after.length ||
        before.some((personId, index) => personId !== after[index])
      ) {
        throw codedError("IDENTITY_RESOLUTION_REJECTION_CHANGED");
      }
    }
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
