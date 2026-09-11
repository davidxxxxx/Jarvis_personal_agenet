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
const DECISIONS = new Set(["adopted", "tentative", "unknown"]);
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const APPLICATION_AUDIO_FALLBACK_POLICIES = new Set(["conservative", "transcript_only"]);
const SUGGESTION_BASES = new Set(["work_context", "learning_goal", "explicit_agreement"]);
const OUTPUT_POLICY_REASONS = Object.freeze({
  WORK_CONTEXT: "work_context",
  LEARNING_GOAL: "confirmed_learning_goal",
  LEARNING_GOAL_REQUIRED: "confirmed_learning_goal_required",
  EXPLICIT_AGREEMENT: "explicit_agreement",
  EXPLICIT_AGREEMENT_REQUIRED: "explicit_agreement_required",
  INTEREST_ONLY: "interest_only",
  SOURCE_UNCERTAIN: "source_uncertain",
  TENTATIVE: "activity_not_adopted",
  NO_SELF: "self_not_participating",
  UNDETERMINED: "activity_undetermined",
});

function assertInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("activity output policy input must be an object");
  }
  if (!ACTIVITY_CATEGORIES.has(input.category)) {
    throw new TypeError("activity output category is invalid");
  }
  if (!DECISIONS.has(input.decision)) {
    throw new TypeError("activity output decision is invalid");
  }
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new TypeError("activity output confidence must be between 0 and 1");
  }
  if (!SOURCE_ATTRIBUTIONS.has(input.sourceAttribution)) {
    throw new TypeError("activity output source attribution is invalid");
  }
  if (
    input.fallbackPolicy !== undefined &&
    !APPLICATION_AUDIO_FALLBACK_POLICIES.has(input.fallbackPolicy)
  ) {
    throw new TypeError("activity output fallback policy is invalid");
  }
  if (typeof input.selfParticipated !== "boolean") {
    throw new TypeError("activity output self participation must be a boolean");
  }
  if (input.explicitAgreement !== undefined && typeof input.explicitAgreement !== "boolean") {
    throw new TypeError("activity output explicit agreement must be a boolean");
  }
  if (
    input.learningGoalId !== undefined &&
    input.learningGoalId !== null &&
    (typeof input.learningGoalId !== "string" || !input.learningGoalId.trim())
  ) {
    throw new TypeError("activity output learning goal id is invalid");
  }
  if (
    input.confirmedLearningGoalIds !== undefined &&
    (!Array.isArray(input.confirmedLearningGoalIds) ||
      input.confirmedLearningGoalIds.some((entry) => typeof entry !== "string" || !entry.trim()))
  ) {
    throw new TypeError("confirmed learning goal ids must be an array of ids");
  }
}

function configuredFallbackPolicy(input) {
  const value = input.fallbackPolicy ?? process.env.JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY;
  return value === "transcript_only" ? "transcript_only" : "conservative";
}

class ActivityOutputPolicy {
  evaluate(input) {
    assertInput(input);
    const {
      category,
      decision,
      confidence,
      sourceAttribution,
      selfParticipated,
      explicitAgreement = false,
      learningGoalId = null,
      confirmedLearningGoalIds = [],
    } = input;
    const fallbackPolicy = configuredFallbackPolicy(input);

    if (category === "unknown" || decision === "unknown") {
      return {
        allowSummary: false,
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.UNDETERMINED,
      };
    }

    if (sourceAttribution === "mixed_unknown") {
      return {
        allowSummary: fallbackPolicy === "conservative",
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.SOURCE_UNCERTAIN,
      };
    }

    const allowSummary = true;
    if (category === "entertainment" || category === "gaming") {
      return {
        allowSummary,
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: true,
        reason: OUTPUT_POLICY_REASONS.INTEREST_ONLY,
      };
    }

    if (category === "other") {
      return {
        allowSummary,
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.UNDETERMINED,
      };
    }

    if (decision !== "adopted" || confidence < 0.8) {
      return {
        allowSummary,
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.TENTATIVE,
      };
    }
    if (!selfParticipated) {
      return {
        allowSummary,
        allowSuggestions: false,
        allowTodos: false,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.NO_SELF,
      };
    }

    if (category === "work_meeting") {
      return {
        allowSummary,
        allowSuggestions: true,
        allowTodos: true,
        interestOnly: false,
        reason: OUTPUT_POLICY_REASONS.WORK_CONTEXT,
      };
    }

    if (category === "learning") {
      const goalConfirmed =
        learningGoalId !== null && new Set(confirmedLearningGoalIds).has(learningGoalId);
      return {
        allowSummary,
        allowSuggestions: goalConfirmed,
        allowTodos: true,
        interestOnly: false,
        reason: goalConfirmed
          ? OUTPUT_POLICY_REASONS.LEARNING_GOAL
          : OUTPUT_POLICY_REASONS.LEARNING_GOAL_REQUIRED,
      };
    }

    const agreementAllowed = explicitAgreement === true;
    return {
      allowSummary,
      allowSuggestions: agreementAllowed,
      allowTodos: agreementAllowed,
      interestOnly: false,
      reason: agreementAllowed
        ? OUTPUT_POLICY_REASONS.EXPLICIT_AGREEMENT
        : OUTPUT_POLICY_REASONS.EXPLICIT_AGREEMENT_REQUIRED,
    };
  }

  evaluateSuggestionCandidate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("suggestion output policy input must be an object");
    }
    if (!SUGGESTION_BASES.has(input.basis)) {
      throw new TypeError("suggestion output basis is invalid");
    }
    const learningGoalId = input.learningGoalId ?? null;
    const confirmedLearningGoalIds = input.confirmedLearningGoalIds ?? [];
    if (learningGoalId !== null && (typeof learningGoalId !== "string" || !learningGoalId.trim())) {
      throw new TypeError("suggestion output learning goal id is invalid");
    }
    if (
      !Array.isArray(confirmedLearningGoalIds) ||
      confirmedLearningGoalIds.some((goalId) => typeof goalId !== "string" || !goalId.trim())
    ) {
      throw new TypeError("suggestion output confirmed learning goal ids are invalid");
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new TypeError("suggestion output evidence is required");
    }
    const evidence = input.evidence.map((entry) => {
      assertInput(entry);
      return entry;
    });

    if (evidence.some((entry) => entry.sourceAttribution === "mixed_unknown")) {
      return { allowed: false, reason: OUTPUT_POLICY_REASONS.SOURCE_UNCERTAIN };
    }
    if (
      evidence.some(
        (entry) =>
          entry.decision !== "adopted" ||
          entry.confidence < 0.8 ||
          entry.category === "unknown" ||
          entry.category === "other"
      )
    ) {
      return { allowed: false, reason: OUTPUT_POLICY_REASONS.TENTATIVE };
    }
    if (!evidence.some((entry) => entry.selfParticipated)) {
      return { allowed: false, reason: OUTPUT_POLICY_REASONS.NO_SELF };
    }

    const allowedCategories =
      input.basis === "work_context"
        ? new Set(["work_meeting"])
        : input.basis === "learning_goal"
          ? new Set(["learning"])
          : new Set(["social_call", "in_person_conversation"]);
    if (evidence.some((entry) => !allowedCategories.has(entry.category))) {
      return { allowed: false, reason: OUTPUT_POLICY_REASONS.UNDETERMINED };
    }

    if (input.basis === "learning_goal") {
      const goalConfirmed =
        learningGoalId !== null && new Set(confirmedLearningGoalIds).has(learningGoalId);
      return {
        allowed: goalConfirmed,
        reason: goalConfirmed
          ? OUTPUT_POLICY_REASONS.LEARNING_GOAL
          : OUTPUT_POLICY_REASONS.LEARNING_GOAL_REQUIRED,
      };
    }
    if (learningGoalId !== null) {
      throw new TypeError("only learning suggestions may reference a learning goal");
    }
    return {
      allowed: true,
      reason:
        input.basis === "work_context"
          ? OUTPUT_POLICY_REASONS.WORK_CONTEXT
          : OUTPUT_POLICY_REASONS.EXPLICIT_AGREEMENT,
    };
  }
}

module.exports = {
  ActivityOutputPolicy,
  OUTPUT_POLICY_REASONS,
};
