"use strict";

const { NORMALIZED_APPLICATIONS } = require("./ActivityClassificationInputBuilder");

const SAFE_SPEAKER_LABEL = /^(?:SELF|P[1-9][0-9]*)$/u;
const SAFE_SNAPSHOT_SPEAKER_LABEL = /^(?:SELF|P[1-9][0-9]*|UNKNOWN)$/u;
const SOURCE_PRIORITY = Object.freeze({ local: 1, minimax: 2, user: 3 });
const SNAPSHOT_SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const SNAPSHOT_ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
const SNAPSHOT_ACTIVITY_DECISIONS = new Set(["adopted", "tentative", "unknown"]);

function confidenceOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function overlapMs(classification, startedAt, endedAt) {
  return Math.max(
    0,
    Math.min(endedAt, classification.ended_at) - Math.max(startedAt, classification.started_at)
  );
}

function sourceMatches(classification, sourceType) {
  if (sourceType === "mic") {
    return new Set(["microphone", "application_and_microphone"]).has(
      classification.source_attribution
    );
  }
  return new Set(["application", "application_and_microphone", "mixed_unknown"]).has(
    classification.source_attribution
  );
}

function selectClassification(classifications, sourceType, startedAt, endedAt) {
  return (Array.isArray(classifications) ? classifications : [])
    .filter(
      (classification) =>
        classification &&
        Number.isSafeInteger(classification.started_at) &&
        Number.isSafeInteger(classification.ended_at) &&
        classification.started_at < endedAt &&
        startedAt < classification.ended_at &&
        sourceMatches(classification, sourceType)
    )
    .sort((left, right) => {
      const overlap = overlapMs(right, startedAt, endedAt) - overlapMs(left, startedAt, endedAt);
      if (overlap !== 0) return overlap;
      const source = (SOURCE_PRIORITY[right.source] ?? 0) - (SOURCE_PRIORITY[left.source] ?? 0);
      if (source !== 0) return source;
      const confidence = Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
      if (confidence !== 0) return confidence;
      return String(left.id ?? "").localeCompare(String(right.id ?? ""));
    })[0];
}

function normalizedApplication(sourceType, applicationKey, attributionState) {
  if (sourceType === "mic") {
    return { applicationKey: null, applicationName: "Microphone" };
  }
  if (
    attributionState === "exact" &&
    typeof applicationKey === "string" &&
    Object.prototype.hasOwnProperty.call(NORMALIZED_APPLICATIONS, applicationKey)
  ) {
    return {
      applicationKey,
      applicationName: NORMALIZED_APPLICATIONS[applicationKey],
    };
  }
  return { applicationKey: null, applicationName: "System audio · application unknown" };
}

function speakerRelation({ personIsSelf, personId, speakerLabel }) {
  if (personIsSelf === 1 || speakerLabel === "SELF") return "SELF";
  if (typeof speakerLabel === "string" && SAFE_SPEAKER_LABEL.test(speakerLabel)) {
    return speakerLabel;
  }
  return typeof personId === "string" && personId ? "P1" : "UNKNOWN";
}

function buildActionEvidenceAttribution({
  sourceType,
  applicationKey = null,
  attributionState = null,
  personIsSelf = null,
  personId = null,
  speakerLabel = null,
  transcriptConfidence = null,
  voiceConfidence = null,
  semanticConfidence = null,
  startedAt,
  endedAt,
  classifications = [],
} = {}) {
  if (!new Set(["mic", "system"]).has(sourceType)) {
    throw new TypeError("action evidence source type is invalid");
  }
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endedAt) || endedAt <= startedAt) {
    throw new TypeError("action evidence interval is invalid");
  }
  const application = normalizedApplication(sourceType, applicationKey, attributionState);
  const classification = selectClassification(classifications, sourceType, startedAt, endedAt);
  const fallbackAttribution =
    sourceType === "mic"
      ? "microphone"
      : application.applicationKey
        ? "application"
        : "mixed_unknown";
  return {
    basis: "current_local_state",
    ...application,
    sourceAttribution: classification?.source_attribution ?? fallbackAttribution,
    speakerRelation: speakerRelation({ personIsSelf, personId, speakerLabel }),
    semanticConfidence: confidenceOrNull(semanticConfidence),
    voiceConfidence: confidenceOrNull(voiceConfidence),
    transcriptConfidence: confidenceOrNull(transcriptConfidence),
    activityClassification:
      classification === undefined
        ? null
        : {
            id: classification.id,
            category: classification.category,
            confidence: confidenceOrNull(classification.confidence),
            decision: classification.decision,
            source: classification.source,
            reason: typeof classification.reason === "string" ? classification.reason : null,
          },
  };
}

function snapshotEntryForSegment(entries, transcriptSegmentId) {
  if (!Array.isArray(entries) || typeof transcriptSegmentId !== "string") return null;
  return entries.find((entry) => entry?.segmentId === transcriptSegmentId) ?? null;
}

function buildCapturedTodoActionEvidenceAttribution({
  transcriptSegmentId,
  applicationEvidence,
  activityEvidence,
  semanticConfidence = null,
  voiceprintConfidence = null,
  transcriptContextConfidence = null,
} = {}) {
  const applicationSnapshot = snapshotEntryForSegment(applicationEvidence, transcriptSegmentId);
  const activitySnapshot = snapshotEntryForSegment(activityEvidence, transcriptSegmentId);
  if (!applicationSnapshot || !activitySnapshot) return null;
  if (
    !SNAPSHOT_SOURCE_ATTRIBUTIONS.has(applicationSnapshot.sourceAttribution) ||
    typeof applicationSnapshot.speakerRelation !== "string" ||
    !SAFE_SNAPSHOT_SPEAKER_LABEL.test(applicationSnapshot.speakerRelation) ||
    !SNAPSHOT_ACTIVITY_CATEGORIES.has(activitySnapshot.category) ||
    !SNAPSHOT_ACTIVITY_DECISIONS.has(activitySnapshot.decision)
  ) {
    return null;
  }
  const sourceType = applicationSnapshot.sourceAttribution === "microphone" ? "mic" : "system";
  const application = normalizedApplication(
    sourceType,
    applicationSnapshot.applicationKey,
    typeof applicationSnapshot.applicationKey === "string" ? "exact" : "mixed_unknown"
  );
  return {
    basis: "captured_todo_snapshot",
    ...application,
    sourceAttribution: applicationSnapshot.sourceAttribution,
    speakerRelation: applicationSnapshot.speakerRelation,
    semanticConfidence: confidenceOrNull(semanticConfidence),
    voiceConfidence: confidenceOrNull(voiceprintConfidence),
    transcriptConfidence: confidenceOrNull(transcriptContextConfidence),
    activityClassification: {
      id: null,
      category: activitySnapshot.category,
      confidence: confidenceOrNull(activitySnapshot.confidence),
      decision: activitySnapshot.decision,
      source: "captured_snapshot",
      reason: null,
    },
  };
}

module.exports = {
  buildActionEvidenceAttribution,
  buildCapturedTodoActionEvidenceAttribution,
  selectClassification,
};
