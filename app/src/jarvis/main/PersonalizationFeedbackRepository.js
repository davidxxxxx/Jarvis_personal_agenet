"use strict";

const crypto = require("node:crypto");

const DOMAINS = new Set(["activity_classification", "suggestion", "todo", "person"]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

function boundedText(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || Array.from(normalized).length > 200) {
    throw new RangeError(`${name} must contain 1 to 200 characters`);
  }
  return normalized;
}

function entityId(value, name) {
  const normalized = boundedText(value, name);
  if (!TOKEN_PATTERN.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function token(value, name) {
  const normalized = boundedText(value, name).toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{0,63}$/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("personalization feedback features must be an object");
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (!["string", "number", "boolean"].includes(typeof entry) && entry !== null) {
      throw new TypeError("personalization feedback features must be scalar");
    }
    normalized[key] = entry;
  }
  return JSON.stringify(normalized);
}

function contentFingerprint(value) {
  const normalized = boundedText(value, "feedback content")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ");
  return sha256(normalized);
}

class PersonalizationFeedbackRepository {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") {
      throw new TypeError("database must be a live better-sqlite3 connection");
    }
    this.db = db;
    this.insert = db.prepare(`
      INSERT OR IGNORE INTO personalization_feedback (
        id, domain, source_entity_id, original_value, corrected_value,
        pattern_key, feature_json, occurred_at
      ) VALUES (
        @id, @domain, @sourceEntityId, @originalValue, @correctedValue,
        @patternKey, @featureJson, @occurredAt
      )
    `);
    this.insertEvent = db.prepare(`
      INSERT OR IGNORE INTO personalization_feedback_events (
        id, domain, source_entity_id, event_state, original_value,
        corrected_value, pattern_key, feature_json, occurred_at
      ) VALUES (
        @id, @domain, @sourceEntityId, @eventState, @originalValue,
        @correctedValue, @patternKey, @featureJson, @occurredAt
      )
    `);
    this.suggestionScore = db.prepare(`
      WITH latest_events AS (
        SELECT
          source_entity_id,
          event_state,
          corrected_value,
          row_number() OVER (
            PARTITION BY source_entity_id
            ORDER BY occurred_at DESC, id DESC
          ) AS rank
        FROM personalization_feedback_events
        WHERE domain = 'suggestion' AND pattern_key = @patternKey
      ), legacy_active AS (
        SELECT DISTINCT legacy.source_entity_id
        FROM personalization_feedback AS legacy
        WHERE legacy.domain = 'suggestion'
          AND legacy.pattern_key = @patternKey
          AND legacy.corrected_value = 'lower_priority'
          AND NOT EXISTS (
            SELECT 1 FROM personalization_feedback_events AS event
            WHERE event.domain = 'suggestion'
              AND event.source_entity_id = legacy.source_entity_id
          )
      )
      SELECT
        (SELECT count(*) FROM legacy_active) +
        (SELECT count(*) FROM latest_events
         WHERE rank = 1 AND event_state = 'active'
           AND corrected_value = 'lower_priority') AS score
    `);
    this.todoSuppressionScore = db.prepare(`
      WITH latest_events AS (
        SELECT
          source_entity_id,
          event_state,
          corrected_value,
          row_number() OVER (
            PARTITION BY source_entity_id
            ORDER BY occurred_at DESC, id DESC
          ) AS rank
        FROM personalization_feedback_events
        WHERE domain = 'todo'
          AND json_extract(feature_json, '$.contentFingerprint') = @contentFingerprint
      ), legacy_active AS (
        SELECT DISTINCT legacy.source_entity_id
        FROM personalization_feedback AS legacy
        WHERE legacy.domain = 'todo'
          AND json_extract(legacy.feature_json, '$.contentFingerprint') = @contentFingerprint
          AND legacy.corrected_value IN (
            'dismissed:not_relevant','dismissed:not_mine',
            'dismissed:wrong_context','dismissed:low_value'
          )
          AND NOT EXISTS (
            SELECT 1 FROM personalization_feedback_events AS event
            WHERE event.domain = 'todo'
              AND event.source_entity_id = legacy.source_entity_id
          )
      )
      SELECT
        (SELECT count(*) FROM legacy_active) +
        (SELECT count(*) FROM latest_events
         WHERE rank = 1 AND event_state = 'active'
           AND corrected_value IN (
             'dismissed:not_relevant','dismissed:not_mine',
             'dismissed:wrong_context','dismissed:low_value'
           )) AS score
    `);
    this._record = db.transaction((row) => {
      this.insert.run(row.legacy);
      this.insertEvent.run(row.event);
    });
  }

  record({
    domain,
    sourceEntityId,
    originalValue = null,
    correctedValue,
    features,
    occurredAt,
    eventState = "active",
    eventId = null,
  } = {}) {
    if (!DOMAINS.has(domain)) throw new TypeError("personalization feedback domain is invalid");
    const safeSourceId = entityId(sourceEntityId, "feedback source entity id");
    const safeOriginal = boundedText(originalValue, "feedback original value", { nullable: true });
    const safeCorrected = boundedText(correctedValue, "feedback corrected value");
    const featureJson = canonicalJson(features);
    const patternKey = sha256(featureJson);
    const at = timestamp(occurredAt, "feedback occurredAt");
    if (!new Set(["active", "retracted"]).has(eventState)) {
      throw new TypeError("personalization feedback event state is invalid");
    }
    const eventIdentity =
      eventId === null || eventId === undefined
        ? `${domain}\0${safeSourceId}\0${safeCorrected}\0${eventState}\0${at}`
        : `${domain}\0${entityId(eventId, "feedback event id")}`;
    const id = `feedback_${sha256(`${domain}\0${safeSourceId}\0${safeCorrected}`).slice(0, 32)}`;
    const eventRecordId = `feedback_event_${sha256(eventIdentity).slice(0, 32)}`;
    this._record.immediate({
      legacy: {
        id,
        domain,
        sourceEntityId: safeSourceId,
        originalValue: safeOriginal,
        correctedValue: safeCorrected,
        patternKey,
        featureJson,
        occurredAt: at,
      },
      event: {
        id: eventRecordId,
        domain,
        sourceEntityId: safeSourceId,
        eventState,
        originalValue: safeOriginal,
        correctedValue: safeCorrected,
        patternKey,
        featureJson,
        occurredAt: at,
      },
    });
    return { id, eventId: eventRecordId, domain, patternKey, occurredAt: at };
  }

  recordTodoDismissal({ todoId, title, sourceKind, reasonCode, occurredAt, eventId = null } = {}) {
    return this.record({
      domain: "todo",
      sourceEntityId: todoId,
      originalValue: "open",
      correctedValue: `dismissed:${token(reasonCode, "Todo dismissal reason")}`,
      features: {
        contentFingerprint: contentFingerprint(title),
        sourceKind: token(sourceKind ?? "unknown", "Todo source kind"),
      },
      occurredAt,
      eventId,
    });
  }

  recordTodoRestoration({ todoId, title, sourceKind, occurredAt, eventId = null } = {}) {
    return this.record({
      domain: "todo",
      sourceEntityId: todoId,
      originalValue: "dismissed",
      correctedValue: "restored",
      features: {
        contentFingerprint: contentFingerprint(title),
        sourceKind: token(sourceKind ?? "unknown", "Todo source kind"),
      },
      occurredAt,
      eventState: "retracted",
      eventId,
    });
  }

  recordTodoEdit({
    todoId,
    previousTitle,
    nextTitle,
    sourceKind,
    titleChanged,
    dueChanged,
    occurredAt,
    eventId = null,
  } = {}) {
    if (typeof titleChanged !== "boolean" || typeof dueChanged !== "boolean") {
      throw new TypeError("Todo edit flags must be booleans");
    }
    if (!titleChanged && !dueChanged) throw new TypeError("Todo edit must change a field");
    const changedFields = [titleChanged ? "title" : null, dueChanged ? "due" : null]
      .filter(Boolean)
      .join("+");
    return this.record({
      domain: "todo",
      sourceEntityId: todoId,
      originalValue: "open",
      correctedValue: `edited:${changedFields}`,
      features: {
        dueChanged,
        nextContentFingerprint: contentFingerprint(nextTitle),
        previousContentFingerprint: contentFingerprint(previousTitle),
        sourceKind: token(sourceKind ?? "unknown", "Todo source kind"),
        titleChanged,
      },
      occurredAt,
      eventId,
    });
  }

  recordSuggestionDismissal({ suggestionId, summary, occurredAt, eventId = null } = {}) {
    return this.record({
      domain: "suggestion",
      sourceEntityId: suggestionId,
      originalValue: "visible",
      correctedValue: "lower_priority",
      features: { contentFingerprint: contentFingerprint(summary) },
      occurredAt,
      eventId,
    });
  }

  recordSuggestionRestoration({ suggestionId, summary, occurredAt, eventId = null } = {}) {
    return this.record({
      domain: "suggestion",
      sourceEntityId: suggestionId,
      originalValue: "lower_priority",
      correctedValue: "restored",
      features: { contentFingerprint: contentFingerprint(summary) },
      occurredAt,
      eventState: "retracted",
      eventId,
    });
  }

  recordPersonCorrection({
    clusterId,
    originalPersonId = null,
    correctedPersonId,
    action,
    sourceKind = "unknown",
    scope = "session",
    occurredAt,
    eventState = "active",
    eventId = null,
  } = {}) {
    const safeAction = token(action, "person correction action");
    const safeCorrected = entityId(correctedPersonId, "corrected person id");
    return this.record({
      domain: "person",
      sourceEntityId: clusterId,
      originalValue:
        originalPersonId === null || originalPersonId === undefined
          ? null
          : entityId(originalPersonId, "original person id"),
      correctedValue: `${safeAction}:${safeCorrected}`,
      features: {
        action: safeAction,
        scope: token(scope, "person correction scope"),
        sourceKind: token(sourceKind, "person correction source kind"),
      },
      occurredAt,
      eventState,
      eventId,
    });
  }

  recordPersonMerge({ sourcePersonId, targetPersonId, occurredAt, eventId = null } = {}) {
    const safeTarget = entityId(targetPersonId, "target person id");
    return this.record({
      domain: "person",
      sourceEntityId: sourcePersonId,
      originalValue: entityId(sourcePersonId, "source person id"),
      correctedValue: `merged:${safeTarget}`,
      features: {
        action: "merged",
        scope: "persistent",
        sourceKind: "person_profile",
      },
      occurredAt,
      eventId,
    });
  }

  suggestionPenalty(summary) {
    if (typeof summary !== "string" || !summary.trim()) return 0;
    const patternKey = sha256(canonicalJson({ contentFingerprint: contentFingerprint(summary) }));
    const score = Math.max(0, Number(this.suggestionScore.get({ patternKey })?.score ?? 0));
    return Math.min(0.45, score * 0.15);
  }

  suggestionFeedbackScore(summary) {
    return Math.round(this.suggestionPenalty(summary) / 0.15);
  }

  shouldSuppressTodo(title) {
    if (typeof title !== "string" || !title.trim()) return false;
    const score = Number(
      this.todoSuppressionScore.get({
        contentFingerprint: contentFingerprint(title),
      })?.score ?? 0
    );
    return score > 0;
  }
}

module.exports = PersonalizationFeedbackRepository;
