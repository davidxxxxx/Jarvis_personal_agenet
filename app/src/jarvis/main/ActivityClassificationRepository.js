"use strict";

const crypto = require("node:crypto");
const { ACTIVITY_CATEGORIES } = require("./LocalActivityClassifier");

const CATEGORY_SET = new Set(ACTIVITY_CATEGORIES);
const DECISIONS = new Set(["adopted", "tentative", "unknown"]);
const SOURCES = new Set(["local", "minimax", "user"]);
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function confidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("confidence must be between 0 and 1");
  }
  return value;
}

function canonicalEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("classification evidence must be an object");
  }
  return JSON.stringify(value);
}

function deterministicId(values) {
  return `activity_classification_${crypto
    .createHash("sha256")
    .update(JSON.stringify(values), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    category: row.category,
    confidence: row.confidence,
    decision: row.decision,
    source: row.source,
    reason: row.reason,
    sourceAttribution: row.source_attribution,
    evidence: JSON.parse(row.evidence_json),
    supersedesId: row.supersedes_id,
    userCorrectedAt: row.user_corrected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ActivityClassificationRepository {
  constructor(db, { now = Date.now } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("an open better-sqlite3 database is required");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.db = db;
    this.now = now;
    this.insert = db.prepare(`
      INSERT OR IGNORE INTO activity_classifications (
        id, session_id, started_at, ended_at, category, confidence, decision,
        source, reason, source_attribution, evidence_json, supersedes_id,
        user_corrected_at, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @startedAt, @endedAt, @category, @confidence, @decision,
        @source, @reason, @sourceAttribution, @evidenceJson, @supersedesId,
        @userCorrectedAt, @createdAt, @updatedAt
      )
    `);
    this.get = db.prepare("SELECT * FROM activity_classifications WHERE id = ?");
    this.listSession = db.prepare(`
      SELECT * FROM activity_classifications
      WHERE session_id = ?
      ORDER BY started_at, ended_at, created_at, id
    `);
    this._saveBatch = db.transaction((rows) => {
      const persisted = [];
      for (const row of rows) {
        this.insert.run(row);
        persisted.push(this.get.get(row.id));
      }
      return persisted;
    });
  }

  saveBatch({ sessionId, activities, classifications, createdAt = this.now() } = {}) {
    const safeSessionId = text(sessionId, "sessionId");
    const safeCreatedAt = timestamp(createdAt, "createdAt");
    if (!Array.isArray(activities) || activities.length === 0) {
      throw new TypeError("activities must be a non-empty array");
    }
    if (!Array.isArray(classifications) || classifications.length !== activities.length) {
      throw new TypeError("classifications must cover every activity");
    }
    const activityById = new Map();
    for (const activity of activities) {
      const activityId = text(activity?.activityId, "activityId");
      if (activityById.has(activityId)) throw new TypeError("activityId must be unique");
      const startedAt = timestamp(activity.startedAt, "startedAt");
      const endedAt = timestamp(activity.endedAt, "endedAt");
      if (endedAt <= startedAt) throw new TypeError("activity must have positive duration");
      if (!SOURCE_ATTRIBUTIONS.has(activity.sourceAttribution)) {
        throw new TypeError("sourceAttribution is invalid");
      }
      activityById.set(activityId, { ...activity, activityId, startedAt, endedAt });
    }
    const rows = classifications.map((classification) => {
      const activityId = text(classification?.activityId, "classification activityId");
      const activity = activityById.get(activityId);
      if (!activity) throw new TypeError("classification references an unknown activity");
      const category = classification.category;
      const decision = classification.decision;
      const source = classification.source;
      if (!CATEGORY_SET.has(category) || !DECISIONS.has(decision) || !SOURCES.has(source)) {
        throw new TypeError("classification enum is invalid");
      }
      const safeConfidence = confidence(classification.confidence);
      const reason = Array.isArray(classification.reasons)
        ? classification.reasons.map((entry) => text(entry, "reason")).join(", ")
        : text(classification.reason, "reason");
      const evidence = {
        activityId,
        applicationKeys: [...new Set(activity.applications ?? [])].sort(),
        allowSummary: classification.allowSummary === true,
        allowSuggestions: classification.allowSuggestions === true,
        allowTodos: classification.allowTodos === true,
        evidenceSegmentIds: classification.evidenceSegmentIds ?? [],
        inputHash: classification.inputHash ?? null,
      };
      const identity = {
        sessionId: safeSessionId,
        activityId,
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
        category,
        confidence: safeConfidence,
        decision,
        source,
        reason,
        sourceAttribution: activity.sourceAttribution,
        evidence,
      };
      return {
        id: deterministicId(identity),
        sessionId: safeSessionId,
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
        category,
        confidence: safeConfidence,
        decision,
        source,
        reason,
        sourceAttribution: activity.sourceAttribution,
        evidenceJson: canonicalEvidence(evidence),
        supersedesId: null,
        userCorrectedAt: null,
        createdAt: safeCreatedAt,
        updatedAt: safeCreatedAt,
      };
    });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new TypeError("classification batch contains duplicates");
    }
    return this._saveBatch.immediate(rows).map(mapRow);
  }

  listSessionHistory(sessionId) {
    return this.listSession.all(text(sessionId, "sessionId")).map(mapRow);
  }

  listSessionEffective(sessionId) {
    const history = this.listSessionHistory(sessionId);
    const priority = { local: 1, minimax: 2, user: 3 };
    const effective = new Map();
    for (const entry of history) {
      const key = `${entry.startedAt}\0${entry.endedAt}`;
      const current = effective.get(key);
      if (
        !current ||
        priority[entry.source] > priority[current.source] ||
        (priority[entry.source] === priority[current.source] &&
          (entry.updatedAt > current.updatedAt ||
            (entry.updatedAt === current.updatedAt && entry.id > current.id)))
      ) {
        effective.set(key, entry);
      }
    }
    return [...effective.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.endedAt - right.endedAt ||
        left.id.localeCompare(right.id)
    );
  }
}

module.exports = ActivityClassificationRepository;
