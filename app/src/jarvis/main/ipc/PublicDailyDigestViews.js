const { normalizeEvidenceContextRequest } = require("../../shared/contracts");

function toPublicDailyDigestContent(content) {
  const factual = (items) =>
    (Array.isArray(items) ? items : []).map((item) => ({
      text: item.text,
      evidenceSegmentIds: [...item.evidenceSegmentIds],
    }));
  return {
    schemaVersion: content.schemaVersion,
    sections: {
      today: factual(content.sections.today),
      interactions: content.sections.interactions.map((item) => ({
        subjectRef: item.subjectRef,
        text: item.text,
        evidenceSegmentIds: [...item.evidenceSegmentIds],
      })),
      topicsAndDecisions: factual(content.sections.topicsAndDecisions),
      commitmentsAndTodos: factual(content.sections.commitmentsAndTodos),
      worthRemembering: factual(content.sections.worthRemembering),
      tomorrowSuggestions: content.sections.tomorrowSuggestions.map((item) => ({
        text: item.text,
        rationale: item.rationale,
        evidenceSegmentIds: [...item.evidenceSegmentIds],
        allowedActions: [...item.allowedActions],
      })),
    },
    processing: {
      completeness: content.processing.completeness,
      missingStages: [...content.processing.missingStages],
      transcriptCoverage: {
        selectedSegmentCount: content.processing.transcriptCoverage.selectedSegmentCount,
        incompleteSegmentCount: content.processing.transcriptCoverage.incompleteSegmentCount,
        sessionCount: content.processing.transcriptCoverage.sessionCount,
        startsAt: content.processing.transcriptCoverage.startsAt,
        endsAt: content.processing.transcriptCoverage.endsAt,
      },
    },
  };
}

function toPublicDailyDigest(digest) {
  if (!digest) return null;
  return {
    localDate: digest.localDate,
    revision: digest.revision,
    completeness: digest.completeness,
    content: toPublicDailyDigestContent(digest.content),
    evidence: digest.evidence.map((entry) => ({
      sessionId: entry.sessionId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      quote: entry.quote,
      audioState: entry.audioState,
      handle: normalizeEvidenceContextRequest(entry.handle),
    })),
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
  };
}

function toPublicDailyDigestStatus(status) {
  const states = new Set([
    "not_generated",
    "empty",
    "queued",
    "running",
    "retry_needed",
    "ready",
    "blocked",
  ]);
  const errorCodes = new Set([
    "offline",
    "budget_unavailable",
    "usage_unknown",
    "invalid_response",
    "runtime_unavailable",
    "generation_failed",
  ]);
  if (!status || !states.has(status.state)) {
    return {
      state: "blocked",
      retryable: false,
      errorCode: "generation_failed",
      nextRetryAt: null,
      attemptCount: 0,
    };
  }
  return {
    state: status.state,
    retryable: status.retryable === true,
    errorCode: errorCodes.has(status.errorCode) ? status.errorCode : null,
    nextRetryAt: Number.isSafeInteger(status.nextRetryAt) ? status.nextRetryAt : null,
    attemptCount:
      Number.isSafeInteger(status.attemptCount) && status.attemptCount >= 0
        ? status.attemptCount
        : 0,
  };
}

module.exports = { toPublicDailyDigestContent, toPublicDailyDigest, toPublicDailyDigestStatus };
