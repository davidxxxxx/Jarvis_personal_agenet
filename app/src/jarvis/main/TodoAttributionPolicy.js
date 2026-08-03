"use strict";

const TODO_ATTRIBUTION_POLICY_VERSION = "todo-attribution-v2";
const AUTO_CONFIRM_THRESHOLD = 0.9;
const ACTION_KINDS = new Set(["self_commitment", "assignment_accepted"]);
const ACTIONABLE_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
]);
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const SPEAKER_RELATION = /^(?:SELF|P[1-9][0-9]*|UNKNOWN)$/u;
const APPLICATION_KEY = /^[a-z0-9._-]{1,64}$/u;

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function confidence(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} confidence is invalid`);
  }
  return value;
}

function nonEmptyText(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function optionalTimestamp(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeEvidence(value) {
  const input = plainObject(value, "todo attribution evidence");
  const segmentId = nonEmptyText(input.segmentId, "evidence segment id");
  if (typeof input.speakerRelation !== "string" || !SPEAKER_RELATION.test(input.speakerRelation)) {
    throw new TypeError("speaker relation is invalid");
  }
  if (typeof input.speakerEvidenceVerified !== "boolean") {
    throw new TypeError("speaker evidence verification is invalid");
  }
  if (typeof input.overlapDetected !== "boolean") {
    throw new TypeError("overlap evidence is invalid");
  }
  if (!SOURCE_ATTRIBUTIONS.has(input.sourceAttribution)) {
    throw new TypeError("source attribution is invalid");
  }
  if (
    input.applicationKey !== null &&
    (typeof input.applicationKey !== "string" || !APPLICATION_KEY.test(input.applicationKey))
  ) {
    throw new TypeError("application key is invalid");
  }
  if (typeof input.activityCategory !== "string" || !input.activityCategory) {
    throw new TypeError("activity category is invalid");
  }
  if (!new Set(["adopted", "tentative", "unknown"]).has(input.activityDecision)) {
    throw new TypeError("activity decision is invalid");
  }
  if (typeof input.allowTodos !== "boolean") {
    throw new TypeError("activity todo permission is invalid");
  }
  return {
    segmentId,
    speakerRelation: input.speakerRelation,
    speakerEvidenceVerified: input.speakerEvidenceVerified,
    overlapDetected: input.overlapDetected,
    sourceAttribution: input.sourceAttribution,
    applicationKey: input.applicationKey,
    activityCategory: input.activityCategory,
    activityConfidence: confidence(input.activityConfidence, "activity"),
    activityDecision: input.activityDecision,
    allowTodos: input.allowTodos,
    voiceConfidence: confidence(input.voiceConfidence, "voice"),
    transcriptConfidence: confidence(input.transcriptConfidence, "transcript"),
    startedAt: optionalTimestamp(input.startedAt, "evidence start time"),
    endedAt: optionalTimestamp(input.endedAt, "evidence end time"),
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function minimum(values) {
  return Math.min(...values);
}

function normalizeSegmentIds(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const ids = value.map((segmentId) => nonEmptyText(segmentId, name));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} must be unique`);
  return ids;
}

function evaluateTodoAttribution(value) {
  const input = plainObject(value, "todo attribution input");
  if (input.ownerLabel !== "SELF") {
    throw new TypeError("todo owner must be SELF");
  }
  const semanticConfidence = minimum([
    confidence(input.semanticConfidence, "semantic"),
    confidence(input.localCommitmentConfidence, "local commitment"),
  ]);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new TypeError("todo attribution evidence is required");
  }
  const evidence = input.evidence.map(normalizeEvidence);
  if (new Set(evidence.map((entry) => entry.segmentId)).size !== evidence.length) {
    throw new TypeError("todo attribution evidence contains duplicate segments");
  }

  const voiceConfidence = minimum(evidence.map((entry) => entry.voiceConfidence));
  const sceneConfidence = minimum(evidence.map((entry) => entry.activityConfidence));
  const transcriptConfidence = minimum(evidence.map((entry) => entry.transcriptConfidence));
  const speakerRelations = sortedUnique(evidence.map((entry) => entry.speakerRelation));
  const hasSelf = speakerRelations.includes("SELF");
  const hasOther = speakerRelations.some((relation) => relation.startsWith("P"));
  const actionKind =
    input.actionKind === undefined && evidence.every((entry) => entry.speakerRelation === "SELF")
      ? "self_commitment"
      : input.actionKind;
  const assignmentSegmentIds = normalizeSegmentIds(
    input.assignmentSegmentIds ?? [],
    "assignment segment ids"
  );
  const acceptanceSegmentIds = normalizeSegmentIds(
    input.acceptanceSegmentIds ?? [],
    "acceptance segment ids"
  );
  const evidenceById = new Map(evidence.map((entry) => [entry.segmentId, entry]));
  let actionEvidenceValid = ACTION_KINDS.has(actionKind);
  if (actionKind === "self_commitment") {
    actionEvidenceValid =
      actionEvidenceValid &&
      assignmentSegmentIds.length === 0 &&
      acceptanceSegmentIds.length === 0 &&
      evidence.every((entry) => entry.speakerRelation === "SELF");
  } else if (actionKind === "assignment_accepted") {
    const assignment = assignmentSegmentIds.map((segmentId) => evidenceById.get(segmentId));
    const acceptance = acceptanceSegmentIds.map((segmentId) => evidenceById.get(segmentId));
    const classifiedIds = new Set([...assignmentSegmentIds, ...acceptanceSegmentIds]);
    const maximumAssignmentEnd = Math.max(...assignment.map((entry) => entry?.endedAt ?? Infinity));
    const minimumAcceptanceStart = Math.min(
      ...acceptance.map((entry) => entry?.startedAt ?? -Infinity)
    );
    actionEvidenceValid =
      actionEvidenceValid &&
      assignment.length > 0 &&
      acceptance.length > 0 &&
      classifiedIds.size === evidence.length &&
      evidence.every((entry) => classifiedIds.has(entry.segmentId)) &&
      assignment.every(
        (entry) => entry?.speakerRelation.startsWith("P") && entry.endedAt !== null
      ) &&
      acceptance.every((entry) => entry?.speakerRelation === "SELF" && entry.startedAt !== null) &&
      maximumAssignmentEnd <= minimumAcceptanceStart;
  }
  const overlapDetected = evidence.some((entry) => entry.overlapDetected);
  const speakerEvidenceVerified = evidence.every((entry) => entry.speakerEvidenceVerified);
  const evidencePolicyPassed = evidence.every(
    (entry) =>
      entry.speakerRelation !== "UNKNOWN" &&
      entry.sourceAttribution !== "mixed_unknown" &&
      entry.activityDecision === "adopted" &&
      ACTIONABLE_CATEGORIES.has(entry.activityCategory) &&
      entry.allowTodos &&
      entry.activityConfidence >= AUTO_CONFIRM_THRESHOLD &&
      entry.voiceConfidence >= AUTO_CONFIRM_THRESHOLD &&
      entry.speakerEvidenceVerified &&
      !entry.overlapDetected
  );
  const trustGatePassed =
    hasSelf &&
    semanticConfidence >= AUTO_CONFIRM_THRESHOLD &&
    voiceConfidence >= AUTO_CONFIRM_THRESHOLD &&
    sceneConfidence >= AUTO_CONFIRM_THRESHOLD &&
    evidencePolicyPassed &&
    actionEvidenceValid;

  const snapshot = {
    schemaVersion: 2,
    policyVersion: TODO_ATTRIBUTION_POLICY_VERSION,
    actionKind: ACTION_KINDS.has(actionKind) ? actionKind : null,
    assignmentSegmentIds,
    acceptanceSegmentIds,
    evidenceSegmentIds: evidence.map((entry) => entry.segmentId),
    applicationKeys: sortedUnique(
      evidence.map((entry) => entry.applicationKey).filter((key) => key !== null)
    ),
    activityCategories: sortedUnique(evidence.map((entry) => entry.activityCategory)),
    sourceAttributions: sortedUnique(evidence.map((entry) => entry.sourceAttribution)),
    speakerRelations,
    semanticConfidence,
    voiceConfidence,
    sceneConfidence,
    transcriptConfidence,
    speakerEvidenceVerified,
    overlapDetected,
    trustGatePassed,
  };

  if (!trustGatePassed) {
    const reason =
      hasOther || actionKind === "assignment_accepted"
        ? "assignment_evidence_invalid"
        : actionKind === "self_commitment" && !actionEvidenceValid
          ? "self_commitment_evidence_invalid"
          : "strict_gate_failed";
    return { disposition: "rejected", reason, snapshot };
  }
  if (actionKind === "assignment_accepted" && hasOther) {
    return {
      disposition: "pending_confirmation",
      reason: "assigned_and_accepted",
      snapshot,
    };
  }
  if (
    actionKind === "self_commitment" &&
    speakerRelations.length === 1 &&
    speakerRelations[0] === "SELF"
  ) {
    return { disposition: "auto_confirmed", reason: "strict_self_commitment", snapshot };
  }
  return { disposition: "rejected", reason: "strict_gate_failed", snapshot };
}

module.exports = {
  AUTO_CONFIRM_THRESHOLD,
  TODO_ATTRIBUTION_POLICY_VERSION,
  evaluateTodoAttribution,
};
