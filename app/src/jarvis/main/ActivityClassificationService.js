"use strict";

const crypto = require("node:crypto");
const LocalActivityClassifier = require("./LocalActivityClassifier");
const ActivityClassificationInputBuilder = require("./ActivityClassificationInputBuilder");

const DEFAULT_ESTIMATED_USAGE = Object.freeze({ inputTokens: 4_000, outputTokens: 1_500 });

function activityForCloud(activity) {
  return {
    activityId: activity.activityId,
    applications: activity.applications,
    sourceAttribution: activity.sourceAttribution,
    speakerLabels: activity.speakerLabels,
    segments: activity.segments,
    statistics: activity.statistics,
  };
}

function localInput(activity) {
  return {
    applications: activity.applications,
    sourceAttribution: activity.sourceAttribution,
    topicHints: activity.topicHints ?? [],
    calendarBlockKind: activity.calendarBlockKind ?? "none",
    statistics: activity.statistics,
  };
}

class ActivityClassificationService {
  constructor({
    repository,
    localClassifier = new LocalActivityClassifier(),
    inputBuilder = new ActivityClassificationInputBuilder(),
    cloudClient = null,
    budgetGuard = null,
    createRequestId = () => `activity_${crypto.randomUUID().replaceAll("-", "")}`,
    estimatedUsage = DEFAULT_ESTIMATED_USAGE,
    now = Date.now,
  } = {}) {
    for (const method of ["saveBatch", "listSessionEffective"]) {
      if (!repository || typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} must be a function`);
      }
    }
    if (!localClassifier || typeof localClassifier.classify !== "function") {
      throw new TypeError("localClassifier.classify is required");
    }
    if (!inputBuilder || typeof inputBuilder.build !== "function") {
      throw new TypeError("inputBuilder.build is required");
    }
    if (cloudClient !== null && typeof cloudClient.classify !== "function") {
      throw new TypeError("cloudClient.classify must be a function");
    }
    if (budgetGuard !== null) {
      for (const method of [
        "reserveNextAttempt",
        "markStarted",
        "reconcile",
        "release",
        "markUsageUnknown",
      ]) {
        if (typeof budgetGuard[method] !== "function") {
          throw new TypeError(`budgetGuard.${method} must be a function`);
        }
      }
    }
    if ((cloudClient === null) !== (budgetGuard === null)) {
      throw new TypeError("cloudClient and budgetGuard must be configured together");
    }
    if (typeof createRequestId !== "function" || typeof now !== "function") {
      throw new TypeError("classification id factory and clock are required");
    }
    this.repository = repository;
    this.localClassifier = localClassifier;
    this.inputBuilder = inputBuilder;
    this.cloudClient = cloudClient;
    this.budgetGuard = budgetGuard;
    this.createRequestId = createRequestId;
    this.estimatedUsage = estimatedUsage;
    this.now = now;
  }

  async classifySession({
    sessionId,
    jobId,
    activities,
    redactionTerms = { participants: [], otherPeople: [], deviceLabels: [] },
    cloudReview = true,
  } = {}) {
    if (!Array.isArray(activities) || activities.length === 0) {
      throw new TypeError("activities must be a non-empty array");
    }
    const local = activities.map((activity) => ({
      activityId: activity.activityId,
      ...this.localClassifier.classify(localInput(activity)),
    }));
    this.repository.saveBatch({
      sessionId,
      activities,
      classifications: local,
      createdAt: this.now(),
    });
    if (
      cloudReview !== true ||
      this.cloudClient === null ||
      this.cloudClient.isConfigured?.() === false
    ) {
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: this.cloudClient === null ? "local_only" : "not_configured",
      };
    }

    let built;
    try {
      built = this.inputBuilder.build({
        activities: activities.map(activityForCloud),
        redactionTerms,
      });
    } catch {
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: "local_preflight_failed",
      };
    }
    const requestId = this.createRequestId();
    const cloudRequest = {
      cloudPayloadJson: built.cloudPayloadJson,
      inputHash: built.inputHash,
      validationContext: built.validationContext,
    };
    try {
      this.cloudClient.validateInput?.(cloudRequest);
    } catch {
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: "local_preflight_failed",
      };
    }
    const reservation = this.budgetGuard.reserveNextAttempt({
      requestId,
      jobId,
      provider: "minimax",
      model: this.cloudClient.model,
      operation: "activity_classification",
      estimatedUsage: this.estimatedUsage,
    });
    if (!reservation?.ok) {
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: reservation?.reason ?? "budget_unavailable",
      };
    }
    this.budgetGuard.markStarted(requestId);
    try {
      const cloud = await this.cloudClient.classify(cloudRequest);
      this.budgetGuard.reconcile({ requestId, usage: cloud.usage });
      this.repository.saveBatch({
        sessionId,
        activities,
        classifications: cloud.classifications.map((classification) => ({
          ...classification,
          inputHash: built.inputHash,
        })),
        createdAt: this.now(),
      });
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: "completed",
        requestId,
        inputHash: built.inputHash,
      };
    } catch (error) {
      if (
        Number.isSafeInteger(error?.usage?.inputTokens) &&
        error.usage.inputTokens >= 0 &&
        Number.isSafeInteger(error?.usage?.outputTokens) &&
        error.usage.outputTokens >= 0
      ) {
        this.budgetGuard.reconcile({ requestId, usage: error.usage });
      } else {
        this.budgetGuard.markUsageUnknown({
          requestId,
          reasonCode: "transport_ambiguous",
        });
      }
      return {
        classifications: this.repository.listSessionEffective(sessionId),
        cloudStatus: "cloud_failed_local_fallback",
        errorCode: typeof error?.code === "string" ? error.code : "classification_failed",
      };
    }
  }
}

module.exports = ActivityClassificationService;
module.exports.DEFAULT_ESTIMATED_USAGE = DEFAULT_ESTIMATED_USAGE;
