"use strict";

const ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
const SUGGESTION_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
]);
const DECISIONS = new Set(["adopted", "tentative", "unknown"]);
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const REQUIRED_CONTEXT_KEYS = new Set([
  "category",
  "confidence",
  "decision",
  "sourceAttribution",
  "selfParticipated",
  "allowSuggestions",
]);
const OPTIONAL_CONTEXT_KEYS = new Set(["applicationKey"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPolicyContext(segmentId, context) {
  if (typeof segmentId !== "string" || !segmentId || segmentId !== segmentId.trim()) {
    throw new TypeError("daily digest policy segment id is invalid");
  }
  if (!isPlainObject(context)) {
    throw new TypeError("daily digest policy context must be a plain object");
  }
  const keys = Object.keys(context);
  if (
    keys.some((key) => !REQUIRED_CONTEXT_KEYS.has(key) && !OPTIONAL_CONTEXT_KEYS.has(key)) ||
    [...REQUIRED_CONTEXT_KEYS].some((key) => !Object.prototype.hasOwnProperty.call(context, key))
  ) {
    throw new TypeError("daily digest policy context has invalid keys");
  }
  if (!ACTIVITY_CATEGORIES.has(context.category)) {
    throw new TypeError("daily digest policy category is invalid");
  }
  if (
    typeof context.confidence !== "number" ||
    !Number.isFinite(context.confidence) ||
    context.confidence < 0 ||
    context.confidence > 1
  ) {
    throw new TypeError("daily digest policy confidence must be between 0 and 1");
  }
  if (!DECISIONS.has(context.decision)) {
    throw new TypeError("daily digest policy decision is invalid");
  }
  if (!SOURCE_ATTRIBUTIONS.has(context.sourceAttribution)) {
    throw new TypeError("daily digest policy source attribution is invalid");
  }
  if (typeof context.selfParticipated !== "boolean") {
    throw new TypeError("daily digest policy self participation must be a boolean");
  }
  if (typeof context.allowSuggestions !== "boolean") {
    throw new TypeError("daily digest policy suggestion permission must be a boolean");
  }
  if (
    Object.prototype.hasOwnProperty.call(context, "applicationKey") &&
    context.applicationKey !== null &&
    (typeof context.applicationKey !== "string" ||
      !context.applicationKey ||
      context.applicationKey !== context.applicationKey.trim())
  ) {
    throw new TypeError("daily digest policy application key is invalid");
  }
}

function validatePolicyContextBySegmentId(policyContextBySegmentId) {
  if (!(policyContextBySegmentId instanceof Map)) {
    throw new TypeError("daily digest policy context must be a Map");
  }
  for (const [segmentId, context] of policyContextBySegmentId) {
    assertPolicyContext(segmentId, context);
  }
}

function assertCandidate(candidate) {
  if (!isPlainObject(candidate) || !isPlainObject(candidate.sections)) {
    throw new TypeError("daily digest candidate must be a validated object");
  }
  if (!Array.isArray(candidate.sections.tomorrowSuggestions)) {
    throw new TypeError("daily digest candidate suggestions must be an array");
  }
  for (const suggestion of candidate.sections.tomorrowSuggestions) {
    if (!isPlainObject(suggestion) || !Array.isArray(suggestion.evidenceSegmentIds)) {
      throw new TypeError("daily digest suggestion evidence must be an array");
    }
  }
}

function isSuggestionAllowed(suggestion, policyContextBySegmentId) {
  if (suggestion.evidenceSegmentIds.length === 0) return false;

  const evidence = suggestion.evidenceSegmentIds.map((segmentId) =>
    policyContextBySegmentId.get(segmentId)
  );
  if (evidence.some((context) => context === undefined)) return false;
  if (evidence.some((context) => context.sourceAttribution === "mixed_unknown")) {
    return false;
  }
  if (
    evidence.some(
      (context) =>
        context.decision !== "adopted" ||
        context.confidence < 0.8 ||
        !SUGGESTION_CATEGORIES.has(context.category) ||
        context.allowSuggestions !== true
    )
  ) {
    return false;
  }
  return evidence.some((context) => context.selfParticipated === true);
}

function applyDailyDigestOutputPolicy(candidate, policyContextBySegmentId) {
  assertCandidate(candidate);
  validatePolicyContextBySegmentId(policyContextBySegmentId);

  const result = structuredClone(candidate);
  result.sections.tomorrowSuggestions = result.sections.tomorrowSuggestions.filter((suggestion) =>
    isSuggestionAllowed(suggestion, policyContextBySegmentId)
  );
  return result;
}

module.exports = {
  applyDailyDigestOutputPolicy,
};
