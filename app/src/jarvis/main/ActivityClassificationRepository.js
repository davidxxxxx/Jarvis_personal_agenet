"use strict";

const crypto = require("node:crypto");
const { ACTIVITY_CATEGORIES } = require("./LocalActivityClassifier");

const CATEGORY_SET = new Set(ACTIVITY_CATEGORIES);
const DECISIONS = new Set(["adopted", "tentative", "unknown"]);
const SOURCES = new Set(["local", "minimax", "user"]);
const RULE_STATES = new Set(["proposed", "enabled", "disabled", "deleted"]);
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

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timeBucket(startedAt) {
  const hour = new Date(startedAt).getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function speakerCountBucket(value) {
  const count = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (count === 0) return "none";
  if (count === 1) return "one";
  return "multiple";
}

function activityFeatures(activity) {
  const statistics = activity?.statistics ?? {};
  return {
    applicationKeys: [...new Set(activity?.applications ?? [])]
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim().toLowerCase())
      .sort(),
    selfParticipated:
      statistics.selfDetected === true || statistics.microphoneParticipated === true,
    speakerCountBucket: speakerCountBucket(statistics.speakerCount),
    timeBucket: timeBucket(activity?.startedAt ?? 0),
  };
}

function evidenceFeatures(entry) {
  const evidence = entry?.evidence ?? {};
  return {
    applicationKeys: [...new Set(evidence.applicationKeys ?? [])]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().toLowerCase())
      .sort(),
    selfParticipated:
      evidence.selfDetected === true || evidence.microphoneParticipated === true,
    speakerCountBucket: speakerCountBucket(evidence.speakerCount),
    timeBucket: timeBucket(entry?.startedAt ?? 0),
  };
}

function classificationEvidenceBasis(entry) {
  const evidence = entry?.evidence ?? {};
  return JSON.stringify({
    applicationKeys: [...new Set(evidence.applicationKeys ?? [])].sort(),
    microphoneParticipated: evidence.microphoneParticipated === true,
    selfDetected: evidence.selfDetected === true,
    speakerCount: Number.isSafeInteger(evidence.speakerCount) ? evidence.speakerCount : 0,
    timeBucket: typeof evidence.timeBucket === "string" ? evidence.timeBucket : null,
    personalizationRuleId:
      typeof evidence.personalizationRuleId === "string"
        ? evidence.personalizationRuleId
        : null,
    sourceAttribution: entry?.sourceAttribution ?? null,
  });
}

function featurePatternKey(features) {
  return sha256(JSON.stringify(features));
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    patternKey: row.pattern_key,
    targetValue: row.target_value,
    label: row.label,
    rule: JSON.parse(row.rule_json),
    supportCount: row.support_count,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    this.insertFeedback = db.prepare(`
      INSERT OR IGNORE INTO personalization_feedback (
        id, domain, source_entity_id, original_value, corrected_value,
        pattern_key, feature_json, occurred_at
      ) VALUES (
        @id, @domain, @sourceEntityId, @originalValue, @correctedValue,
        @patternKey, @featureJson, @occurredAt
      )
    `);
    this.countFeedback = db.prepare(`
      SELECT COUNT(*) AS count
      FROM personalization_feedback
      WHERE domain = ? AND pattern_key = ? AND corrected_value = ?
    `);
    this.insertRule = db.prepare(`
      INSERT OR IGNORE INTO personalization_rules (
        id, domain, pattern_key, target_value, label, rule_json,
        support_count, state, created_at, updated_at
      ) VALUES (
        @id, @domain, @patternKey, @targetValue, @label, @ruleJson,
        @supportCount, 'proposed', @createdAt, @updatedAt
      )
    `);
    this.updateRuleSupport = db.prepare(`
      UPDATE personalization_rules
      SET support_count = MAX(support_count, ?), updated_at = MAX(updated_at, ?)
      WHERE domain = ? AND pattern_key = ? AND target_value = ?
    `);
    this.getRule = db.prepare("SELECT * FROM personalization_rules WHERE id = ?");
    this.getRuleByPattern = db.prepare(`
      SELECT * FROM personalization_rules
      WHERE domain = ? AND pattern_key = ? AND target_value = ?
    `);
    this.listRulesStatement = db.prepare(`
      SELECT * FROM personalization_rules
      WHERE state <> 'deleted'
      ORDER BY
        CASE state WHEN 'proposed' THEN 0 WHEN 'enabled' THEN 1 ELSE 2 END,
        updated_at DESC,
        id
    `);
    this.findEnabledActivityRule = db.prepare(`
      SELECT * FROM personalization_rules
      WHERE domain = 'activity_classification'
        AND pattern_key = ?
        AND state = 'enabled'
      ORDER BY support_count DESC, updated_at DESC, id
      LIMIT 1
    `);
    this.insertRuleEvent = db.prepare(`
      INSERT INTO personalization_rule_events (
        id, rule_id, action, previous_state, next_state, detail_json, occurred_at
      ) VALUES (
        @id, @ruleId, @action, @previousState, @nextState, @detailJson, @occurredAt
      )
    `);
    this.getNotificationPreferencesStatement = db.prepare(`
      SELECT focus_mode, muted_until, updated_at
      FROM jarvis_notification_preferences
      WHERE singleton = 1
    `);
    this.setNotificationPreferencesStatement = db.prepare(`
      UPDATE jarvis_notification_preferences
      SET focus_mode = @focusMode, muted_until = @mutedUntil, updated_at = @updatedAt
      WHERE singleton = 1
    `);
    this.suggestionFeedbackCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM personalization_feedback
      WHERE domain = 'suggestion' AND pattern_key = ?
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
        microphoneParticipated: activity.statistics?.microphoneParticipated === true,
        selfDetected: activity.statistics?.selfDetected === true,
        speakerCount: Number.isSafeInteger(activity.statistics?.speakerCount)
          ? activity.statistics.speakerCount
          : 0,
        timeBucket: timeBucket(activity.startedAt),
        allowSummary: classification.allowSummary === true,
        allowSuggestions: classification.allowSuggestions === true,
        allowTodos: classification.allowTodos === true,
        evidenceSegmentIds: classification.evidenceSegmentIds ?? [],
        inputHash: classification.inputHash ?? null,
        personalizationRuleId: classification.personalizationRuleId ?? null,
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
    const byActivityWindow = new Map();
    for (const entry of history) {
      const key = `${entry.startedAt}\0${entry.endedAt}`;
      const entries = byActivityWindow.get(key) ?? [];
      entries.push(entry);
      byActivityWindow.set(key, entries);
    }
    const newer = (left, right) =>
      left.updatedAt > right.updatedAt ||
      (left.updatedAt === right.updatedAt && left.id > right.id);
    const select = (entries) => {
      const userEntries = entries.filter((entry) => entry.source === "user");
      if (userEntries.length > 0) {
        return userEntries.reduce((current, entry) => (newer(entry, current) ? entry : current));
      }
      const localEntries = entries.filter((entry) => entry.source === "local");
      const candidates =
        localEntries.length === 0
          ? entries
          : (() => {
              const latestLocal = localEntries.reduce((current, entry) =>
                newer(entry, current) ? entry : current
              );
              const basis = classificationEvidenceBasis(latestLocal);
              return entries.filter((entry) => classificationEvidenceBasis(entry) === basis);
            })();
      return candidates.reduce((current, entry) => {
        if (priority[entry.source] > priority[current.source]) return entry;
        if (priority[entry.source] === priority[current.source] && newer(entry, current)) {
          return entry;
        }
        return current;
      });
    };
    return [...byActivityWindow.values()].map(select).sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.endedAt - right.endedAt ||
        left.id.localeCompare(right.id)
    );
  }

  applyPersonalizationRule(activity, classification) {
    const features = activityFeatures(activity);
    const rule = mapRule(this.findEnabledActivityRule.get(featurePatternKey(features)));
    if (!rule) return classification;
    const exactAttribution = activity?.sourceAttribution !== "mixed_unknown";
    return {
      ...classification,
      category: rule.targetValue,
      confidence: exactAttribution ? Math.max(classification.confidence ?? 0, 0.9) : 0.79,
      decision: exactAttribution ? "adopted" : "tentative",
      source: "local",
      reason: `enabled_personalization_rule:${rule.id}`,
      personalizationRuleId: rule.id,
      allowSummary: true,
      allowSuggestions:
        exactAttribution &&
        ["work_meeting", "learning", "social_call", "in_person_conversation"].includes(
          rule.targetValue
        ),
      allowTodos:
        exactAttribution &&
        ["work_meeting", "social_call", "in_person_conversation"].includes(rule.targetValue),
    };
  }

  recordUserCorrection({ classificationId, category, correctedAt = this.now() } = {}) {
    const source = mapRow(this.get.get(text(classificationId, "classificationId")));
    if (!source) throw new Error("activity classification does not exist");
    if (!CATEGORY_SET.has(category)) throw new TypeError("activity category is invalid");
    const at = timestamp(correctedAt, "correctedAt");
    const features = evidenceFeatures(source);
    const patternKey = featurePatternKey(features);
    const evidence = {
      ...source.evidence,
      personalizationFeedback: {
        originalCategory: source.category,
        correctedCategory: category,
        patternKey,
      },
    };
    const identity = {
      sessionId: source.sessionId,
      startedAt: source.startedAt,
      endedAt: source.endedAt,
      category,
      supersedesId: source.id,
      correctedAt: at,
    };
    const mixedUnknown = source.sourceAttribution === "mixed_unknown";
    const row = {
      id: deterministicId(identity),
      sessionId: source.sessionId,
      startedAt: source.startedAt,
      endedAt: source.endedAt,
      category,
      // A manual category correction does not make an unknown audio source exact.
      // Preserve the attribution gate required by the database and by Todo policy.
      confidence: mixedUnknown ? 0.79 : 1,
      decision: mixedUnknown ? "tentative" : "adopted",
      source: "user",
      reason: "user_activity_correction",
      sourceAttribution: source.sourceAttribution,
      evidenceJson: canonicalEvidence(evidence),
      supersedesId: source.id,
      userCorrectedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    const result = this.db.transaction(() => {
      this.insert.run(row);
      this.insertFeedback.run({
        id: `feedback_${sha256(`${source.id}\0${category}`).slice(0, 32)}`,
        domain: "activity_classification",
        sourceEntityId: source.id,
        originalValue: source.category,
        correctedValue: category,
        patternKey,
        featureJson: JSON.stringify(features),
        occurredAt: at,
      });
      const supportCount = this.countFeedback.get(
        "activity_classification",
        patternKey,
        category
      ).count;
      let proposedRule = this.getRuleByPattern.get(
        "activity_classification",
        patternKey,
        category
      );
      if (supportCount >= 3) {
        const applicationLabel =
          features.applicationKeys.length > 0
            ? features.applicationKeys.join("、")
            : "未知应用";
        const ruleId = `rule_${sha256(`activity\0${patternKey}\0${category}`).slice(0, 32)}`;
        const inserted = this.insertRule.run({
          id: ruleId,
          domain: "activity_classification",
          patternKey,
          targetValue: category,
          label: `${applicationLabel} 的相似活动通常归为 ${category}`,
          ruleJson: JSON.stringify({ features, category }),
          supportCount,
          createdAt: at,
          updatedAt: at,
        });
        this.updateRuleSupport.run(
          supportCount,
          at,
          "activity_classification",
          patternKey,
          category
        );
        if (inserted.changes > 0) {
          this._appendRuleEvent({
            ruleId,
            action: "proposed",
            previousState: null,
            nextState: "proposed",
            detail: { supportCount },
            at,
          });
        }
        proposedRule = this.getRule.get(ruleId);
      }
      return {
        classification: mapRow(this.get.get(row.id)),
        proposedRule: mapRule(proposedRule),
        supportCount,
      };
    });
    return result.immediate();
  }

  recordSuggestionDismissal({ suggestionId, summary, occurredAt = this.now() } = {}) {
    const safeId = text(suggestionId, "suggestionId");
    const normalized = text(summary, "suggestion summary").toLowerCase().replace(/\s+/gu, " ");
    const features = { contentFingerprint: sha256(normalized) };
    const patternKey = featurePatternKey(features);
    const at = timestamp(occurredAt, "occurredAt");
    this.insertFeedback.run({
      id: `feedback_${sha256(`suggestion\0${safeId}`).slice(0, 32)}`,
      domain: "suggestion",
      sourceEntityId: safeId,
      originalValue: "visible",
      correctedValue: "lower_priority",
      patternKey,
      featureJson: JSON.stringify(features),
      occurredAt: at,
    });
    return {
      patternKey,
      dismissalCount: this.suggestionFeedbackCount.get(patternKey).count,
    };
  }

  suggestionPenalty(summary) {
    if (typeof summary !== "string" || !summary.trim()) return 0;
    const normalized = summary.trim().toLowerCase().replace(/\s+/gu, " ");
    const patternKey = featurePatternKey({ contentFingerprint: sha256(normalized) });
    const count = this.suggestionFeedbackCount.get(patternKey).count;
    return Math.min(0.45, count * 0.15);
  }

  listPersonalizationRules() {
    return this.listRulesStatement.all().map(mapRule);
  }

  decidePersonalizationRule({ ruleId, action, label, at = this.now() } = {}) {
    const safeRuleId = text(ruleId, "ruleId");
    const rule = this.getRule.get(safeRuleId);
    if (!rule) throw new Error("personalization rule does not exist");
    if (rule.state === "deleted") throw new Error("personalization rule was deleted");
    if (!["enable", "disable", "delete", "edit"].includes(action)) {
      throw new TypeError("personalization rule action is invalid");
    }
    const occurredAt = timestamp(at, "at");
    const nextState =
      action === "enable"
        ? "enabled"
        : action === "disable"
          ? "disabled"
          : action === "delete"
            ? "deleted"
            : rule.state;
    if (!RULE_STATES.has(nextState)) throw new TypeError("personalization rule state is invalid");
    let nextLabel = rule.label;
    if (action === "edit") {
      nextLabel = text(label, "label");
      if (Array.from(nextLabel).length > 500) throw new RangeError("label is too long");
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE personalization_rules
           SET state = ?, label = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nextState, nextLabel, occurredAt, safeRuleId);
      this._appendRuleEvent({
        ruleId: safeRuleId,
        action: action === "enable" ? "enabled" : action === "disable" ? "disabled" : action === "delete" ? "deleted" : "edited",
        previousState: rule.state,
        nextState,
        detail: action === "edit" ? { previousLabel: rule.label, nextLabel } : {},
        at: occurredAt,
      });
    }).immediate();
    return mapRule(this.getRule.get(safeRuleId));
  }

  resetPersonalizationRules({ at = this.now() } = {}) {
    const occurredAt = timestamp(at, "at");
    const result = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE personalization_rules
           SET state = 'deleted', updated_at = ?
           WHERE state <> 'deleted'`
        )
        .run(occurredAt).changes;
      this._appendRuleEvent({
        ruleId: null,
        action: "reset",
        previousState: null,
        nextState: null,
        detail: { changed },
        at: occurredAt,
      });
      return changed;
    }).immediate();
    return { resetCount: result, resetAt: occurredAt };
  }

  getNotificationPreferences() {
    const row = this.getNotificationPreferencesStatement.get();
    return {
      focusMode: row?.focus_mode === 1,
      mutedUntil: row?.muted_until ?? null,
      updatedAt: row?.updated_at ?? 0,
      effectiveMuted: row?.focus_mode === 1 || (row?.muted_until ?? 0) > this.now(),
    };
  }

  setNotificationPreferences({ focusMode, mutedUntil, at = this.now() } = {}) {
    if (typeof focusMode !== "boolean") throw new TypeError("focusMode must be a boolean");
    if (
      mutedUntil !== null &&
      (!Number.isSafeInteger(mutedUntil) || mutedUntil < 0)
    ) {
      throw new TypeError("mutedUntil must be null or a non-negative safe integer");
    }
    const occurredAt = timestamp(at, "at");
    this.setNotificationPreferencesStatement.run({
      focusMode: focusMode ? 1 : 0,
      mutedUntil,
      updatedAt: occurredAt,
    });
    return this.getNotificationPreferences();
  }

  _appendRuleEvent({ ruleId, action, previousState, nextState, detail, at }) {
    this.insertRuleEvent.run({
      id: `rule_event_${crypto.randomUUID().replaceAll("-", "")}`,
      ruleId,
      action,
      previousState,
      nextState,
      detailJson: JSON.stringify(detail ?? {}),
      occurredAt: at,
    });
  }
}

module.exports = ActivityClassificationRepository;
