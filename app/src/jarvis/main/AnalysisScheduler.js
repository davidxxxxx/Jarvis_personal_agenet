const crypto = require("node:crypto");
const { assertId } = require("../shared/contracts");

class AnalysisScheduler {
  constructor({ repository, client, createId = () => `analysis_${crypto.randomUUID().replaceAll("-", "")}`, now = Date.now } = {}) {
    if (!repository || typeof repository.getSessionDetail !== "function" || typeof repository.applyAnalysisResult !== "function") {
      throw new TypeError("analysis repository is required");
    }
    if (!client || typeof client.analyze !== "function") throw new TypeError("analysis client is required");
    this.repository = repository;
    this.client = client;
    this.createId = createId;
    this.now = now;
    this.inFlight = new Map();
    this.status = new Map();
  }

  getStatus(sessionId) {
    const id = assertId(sessionId, "sessionId");
    return this.status.get(id) ?? { sessionId: id, state: "waiting", errorCode: null, updatedAt: null };
  }

  analyzeSession(sessionId, kind = "incremental") {
    const id = assertId(sessionId, "sessionId");
    if (kind !== "incremental" && kind !== "final") throw new TypeError("invalid analysis kind");
    const key = `${id}:${kind}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = this._run(id, kind).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async _run(sessionId, kind) {
    const detail = this.repository.getSessionDetail(sessionId);
    if (!detail) throw new Error("analysis session does not exist");
    const stable = detail.segments.filter((segment) => segment.is_stable === 1 && segment.text?.trim());
    if (stable.length === 0) {
      const error = new Error("No stable transcript is available for analysis");
      error.code = "ANALYSIS_EMPTY";
      throw error;
    }
    const people = typeof this.repository.listPeople === "function" ? this.repository.listPeople() : [];
    const selfIds = new Set(people.filter((person) => person.is_self === 1).map((person) => person.id));
    const otherIds = [...new Set(stable.map((segment) => segment.person_id).filter((personId) => personId && !selfIds.has(personId)))].sort();
    const aliases = new Map(otherIds.map((personId, index) => [personId, `person_${index + 2}`]));
    const segments = stable.map((segment) => ({
      id: segment.id,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      speakerRef: segment.person_id && selfIds.has(segment.person_id)
        ? "self"
        : (aliases.get(segment.person_id) ?? "unknown"),
      text: segment.text,
    }));
    const inputHash = crypto.createHash("sha256").update(JSON.stringify({ kind, segments })).digest("hex");
    const startedAt = this.now();
    this.status.set(sessionId, { sessionId, state: "analyzing", errorCode: null, updatedAt: startedAt });
    try {
      const response = await this.client.analyze({
        kind,
        segments,
        previousSummary: detail.summary?.summary ?? null,
      });
      const completedAt = this.now();
      this.repository.applyAnalysisResult({
        runId: this.createId(),
        sessionId,
        kind,
        inputHash,
        model: response.model,
        windowStart: stable[0].started_at,
        windowEnd: stable.at(-1).ended_at,
        completedAt,
        result: response.result,
      });
      const state = { sessionId, state: "ready", errorCode: null, updatedAt: completedAt, usage: response.usage };
      this.status.set(sessionId, state);
      return state;
    } catch (error) {
      const state = { sessionId, state: error?.code === "MINIMAX_RATE_LIMITED" ? "quota_limited" : "retry_needed", errorCode: error?.code || "ANALYSIS_FAILED", updatedAt: this.now() };
      this.status.set(sessionId, state);
      throw error;
    }
  }
}

module.exports = AnalysisScheduler;
