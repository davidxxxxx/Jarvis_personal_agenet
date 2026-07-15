const crypto = require("node:crypto");
const { assertId } = require("../shared/contracts");

const PROMPT_VERSION = "jarvis-analysis-v2";

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isCallable(value, method) {
  return value && typeof value[method] === "function";
}

function eligibleSegments(detail) {
  return detail.segments
    .filter(
      (segment) =>
        segment.result_kind === "final" &&
        segment.is_stable === 1 &&
        segment.superseded_by == null &&
        segment.duplicate_of == null &&
        typeof segment.text === "string" &&
        segment.text.trim()
    )
    .sort(
      (left, right) =>
        left.started_at - right.started_at ||
        left.ended_at - right.ended_at ||
        left.id.localeCompare(right.id)
    );
}

function inputRevisions(segments, people) {
  const transcriptRevision = hashJson(
    segments.map((segment) => ({
      id: segment.id,
      version: segment.version,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      text: segment.text,
      personId: segment.person_id ?? null,
    }))
  );
  const identityRevision = hashJson(
    people
      .map((person) => ({
        id: person.id,
        displayName: person.display_name ?? null,
        isSelf: person.is_self === 1,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  return { transcriptRevision, identityRevision };
}

class AnalysisScheduler {
  constructor({
    repository,
    memoryRepository = repository?.memoryRepository,
    inputBuilder,
    client,
    cloudTransportEnabled = false,
    now = Date.now,
  } = {}) {
    if (!isCallable(repository, "getSessionDetail")) {
      throw new TypeError("analysis repository is required");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof cloudTransportEnabled !== "boolean") {
      throw new TypeError("cloudTransportEnabled must be a boolean");
    }
    if (cloudTransportEnabled) {
      for (const method of [
        "prepareAnalysisInput",
        "createAnalysisInput",
        "getAnalysisInputForCloud",
        "applyCandidateAnalysis",
      ]) {
        if (!isCallable(memoryRepository, method)) {
          throw new TypeError("analysis memory repository is required");
        }
      }
      if (!isCallable(inputBuilder, "build")) {
        throw new TypeError("analysis input builder is required");
      }
      if (!isCallable(client, "analyze")) throw new TypeError("analysis client is required");
    }
    this.repository = repository;
    this.memoryRepository = memoryRepository;
    this.inputBuilder = inputBuilder;
    this.client = client;
    this.cloudTransportEnabled = cloudTransportEnabled;
    this.now = now;
    this.inFlight = new Map();
    this.status = new Map();
    this.quiesced = false;
  }

  _setStatus(sessionId, state, errorCode = null, extra = {}) {
    const status = {
      sessionId,
      state,
      errorCode,
      updatedAt: this.now(),
      ...extra,
    };
    this.status.set(sessionId, status);
    return status;
  }

  getStatus(sessionId) {
    const id = assertId(sessionId, "sessionId");
    return (
      this.status.get(id) ?? { sessionId: id, state: "waiting", errorCode: null, updatedAt: null }
    );
  }

  analyzeSession(sessionId, kind = "incremental") {
    const id = assertId(sessionId, "sessionId");
    if (kind !== "incremental" && kind !== "final") throw new TypeError("invalid analysis kind");
    if (this.quiesced) {
      const error = new Error("storage migration in progress");
      error.code = "STORAGE_MIGRATION_IN_PROGRESS";
      throw error;
    }
    if (!this.cloudTransportEnabled) {
      return Promise.resolve(this._setStatus(id, "blocked", "analysis_runtime_not_ready"));
    }
    let plan;
    try {
      plan = this._prepare(id);
    } catch (error) {
      this._setFailureStatus(id, error);
      throw error;
    }
    if (plan.status) return Promise.resolve(plan.status);
    const key = plan.persisted.inputHash;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if (plan.persisted.status === "existing") {
      if (plan.persisted.candidateState === "applied") {
        return Promise.resolve(this._setStatus(id, "ready", null, { reused: true }));
      }
      return Promise.resolve(
        this._setStatus(id, "retry_needed", "analysis_input_pending", { reused: true })
      );
    }
    const promise = this._execute(plan).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async quiesce() {
    this.quiesced = true;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  resume() {
    this.quiesced = false;
  }

  _setFailureStatus(sessionId, error) {
    const errorCode = typeof error?.code === "string" ? error.code : "analysis_failed";
    const state =
      errorCode === "rate_limit"
        ? "quota_limited"
        : error?.retryable === true
          ? "retry_needed"
          : "blocked";
    return this._setStatus(sessionId, state, errorCode);
  }

  _prepare(sessionId) {
    const detail = this.repository.getSessionDetail(sessionId);
    if (!detail) {
      const error = new Error("analysis session does not exist");
      error.code = "ANALYSIS_SESSION_NOT_FOUND";
      throw error;
    }
    const segments = eligibleSegments(detail);
    if (segments.length === 0) {
      return { status: this._setStatus(sessionId, "blocked", "analysis_input_empty") };
    }
    const people = isCallable(this.repository, "listPeople") ? this.repository.listPeople() : [];
    const revisions = inputRevisions(segments, people);
    const request = {
      sessionId,
      ...revisions,
      promptVersion: PROMPT_VERSION,
      segmentIds: segments.map((segment) => segment.id),
    };
    this._setStatus(sessionId, "analyzing");
    const prepared = this.memoryRepository.prepareAnalysisInput(request);
    const built = this.inputBuilder.build(prepared);
    if (!built?.sendable) {
      return {
        status: this._setStatus(sessionId, "blocked", built?.reason || "analysis_input_invalid"),
      };
    }
    const persisted = this.memoryRepository.createAnalysisInput({
      ...request,
      prepareToken: prepared.prepareToken,
      inputContractVersion: built.inputContractVersion,
      redactionVersion: built.redactionVersion,
      cloudPayloadJson: built.cloudPayloadJson,
    });
    if (
      !persisted ||
      !new Set(["created", "existing"]).has(persisted.status) ||
      !new Set(["pending", "applied"]).has(persisted.candidateState) ||
      (persisted.status === "created" && persisted.candidateState !== "pending") ||
      typeof persisted.analysisInputId !== "string" ||
      !/^[0-9a-f]{64}$/u.test(persisted.inputHash)
    ) {
      const error = new Error("analysis input state unavailable");
      error.code = "analysis_input_state_invalid";
      throw error;
    }
    return { sessionId, persisted };
  }

  async _execute({ sessionId, persisted }) {
    try {
      const cloudInput = this.memoryRepository.getAnalysisInputForCloud(persisted.analysisInputId);
      if (!cloudInput) {
        const error = new Error("analysis input unavailable");
        error.code = "analysis_input_unavailable";
        throw error;
      }
      const response = await this.client.analyze(cloudInput);
      this.memoryRepository.applyCandidateAnalysis({
        analysisInputId: persisted.analysisInputId,
        inputHash: persisted.inputHash,
        candidate: response.result,
      });
      return this._setStatus(sessionId, "ready", null, { usage: response.usage });
    } catch (error) {
      this._setFailureStatus(sessionId, error);
      throw error;
    }
  }
}

module.exports = AnalysisScheduler;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
