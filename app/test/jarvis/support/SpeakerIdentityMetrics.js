"use strict";

function compareIds(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function finiteInterval(item, idKey, label) {
  if (!item || typeof item !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  const id = item[idKey];
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`${label}.${idKey} must be a non-empty string`);
  }
  if (
    !Number.isSafeInteger(item.startMs) ||
    !Number.isSafeInteger(item.endMs) ||
    item.startMs < 0 ||
    item.endMs <= item.startMs
  ) {
    throw new TypeError(`${label} must have a valid millisecond interval`);
  }
}

function maximumWeightAssignment(weights) {
  const size = weights.length;
  if (size === 0) return [];

  let maximum = 0;
  for (const row of weights) {
    for (const weight of row) maximum = Math.max(maximum, weight);
  }

  // Deterministic O(n^3) Hungarian assignment. Rows and columns are sorted by
  // their caller before padding, so equal-cost choices have stable tie breaks.
  const u = Array(size + 1).fill(0);
  const v = Array(size + 1).fill(0);
  const p = Array(size + 1).fill(0);
  const way = Array(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column0 = 0;
    const minimum = Array(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array(size + 1).fill(false);

    do {
      used[column0] = true;
      const row0 = p[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;

      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const cost = maximum - weights[row0 - 1][column - 1];
        const current = cost - u[row0] - v[column];
        if (current < minimum[column]) {
          minimum[column] = current;
          way[column] = column0;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          column1 = column;
        }
      }

      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      column0 = column1;
    } while (p[column0] !== 0);

    do {
      const column1 = way[column0];
      p[column0] = p[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = Array(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    if (p[column] > 0) assignment[p[column] - 1] = column - 1;
  }
  return assignment;
}

function maximumWeightSpeakerMatching({ predictedTurns, truthSegments }) {
  if (!Array.isArray(predictedTurns) || !Array.isArray(truthSegments)) {
    throw new TypeError("predictedTurns and truthSegments must be arrays");
  }
  predictedTurns.forEach((turn) => finiteInterval(turn, "clusterId", "predicted turn"));
  truthSegments.forEach((segment) => finiteInterval(segment, "speakerId", "truth segment"));

  const clusterIds = [...new Set(predictedTurns.map((turn) => turn.clusterId))].sort(compareIds);
  const speakerIds = [...new Set(truthSegments.map((segment) => segment.speakerId))].sort(
    compareIds
  );
  const size = Math.max(clusterIds.length, speakerIds.length);
  if (size === 0) return [];

  const weights = Array.from({ length: size }, () => Array(size).fill(0));
  const clusterIndexes = new Map(clusterIds.map((id, index) => [id, index]));
  const speakerIndexes = new Map(speakerIds.map((id, index) => [id, index]));

  for (const turn of predictedTurns) {
    for (const segment of truthSegments) {
      const overlapMs = Math.max(
        0,
        Math.min(turn.endMs, segment.endMs) - Math.max(turn.startMs, segment.startMs)
      );
      if (overlapMs > 0) {
        weights[clusterIndexes.get(turn.clusterId)][speakerIndexes.get(segment.speakerId)] +=
          overlapMs;
      }
    }
  }

  return maximumWeightAssignment(weights)
    .map((column, row) => ({ row, column }))
    .filter(
      ({ row, column }) =>
        row < clusterIds.length &&
        column >= 0 &&
        column < speakerIds.length &&
        weights[row][column] > 0
    )
    .map(({ row, column }) => ({
      clusterId: clusterIds[row],
      speakerId: speakerIds[column],
      overlapMs: weights[row][column],
    }));
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function emptyIdentityMetric() {
  return {
    truthSupport: 0,
    automaticSupport: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    precision: null,
    recall: null,
  };
}

function assertPolicy(policy) {
  if (
    !policy ||
    !Number.isFinite(policy.autoConfirmSimilarity) ||
    !Number.isFinite(policy.minimumMargin)
  ) {
    throw new TypeError("policy must define finite production score and margin thresholds");
  }
}

function computeSpeakerIdentityMetrics({ cases, policy }) {
  if (!Array.isArray(cases)) throw new TypeError("cases must be an array");
  assertPolicy(policy);

  const self = emptyIdentityMetric();
  const known = emptyIdentityMetric();
  const unknown = {
    truthSupport: 0,
    automaticFalsePositives: 0,
    falsePositiveRate: null,
  };
  let correctCases = 0;
  let correctionsNeeded = 0;
  const automaticBoundaries = [];

  const sortedCases = [...cases].sort((left, right) => compareIds(left.caseId, right.caseId));
  for (const evaluationCase of sortedCases) {
    if (!evaluationCase || typeof evaluationCase.caseId !== "string") {
      throw new TypeError("each case must have a string caseId");
    }
    if (
      !Array.isArray(evaluationCase.truthSpeakers) ||
      !Array.isArray(evaluationCase.predictedTurns) ||
      !Array.isArray(evaluationCase.truthSegments) ||
      !Array.isArray(evaluationCase.decisions)
    ) {
      throw new TypeError("each case must define truth speakers, segments, turns, and decisions");
    }

    const truthById = new Map();
    for (const truth of evaluationCase.truthSpeakers) {
      if (!truth || typeof truth.speakerId !== "string" || truthById.has(truth.speakerId)) {
        throw new TypeError("truth speaker ids must be unique strings");
      }
      if (!["self", "known", "unknown"].includes(truth.kind)) {
        throw new TypeError("truth speaker kind must be self, known, or unknown");
      }
      if (truth.kind !== "unknown" && typeof truth.personId !== "string") {
        throw new TypeError("self and known truth speakers require a personId");
      }
      truthById.set(truth.speakerId, truth);
      if (truth.kind === "self") self.truthSupport += 1;
      if (truth.kind === "known") known.truthSupport += 1;
      if (truth.kind === "unknown") unknown.truthSupport += 1;
    }

    for (const segment of evaluationCase.truthSegments) {
      if (!truthById.has(segment.speakerId)) {
        throw new TypeError("truth segment references an unknown speaker");
      }
    }

    const predictedIds = new Set(evaluationCase.predictedTurns.map((turn) => turn.clusterId));
    if (predictedIds.size === truthById.size) correctCases += 1;

    const matches = maximumWeightSpeakerMatching({
      predictedTurns: evaluationCase.predictedTurns,
      truthSegments: evaluationCase.truthSegments,
    });
    const truthByCluster = new Map(
      matches.map((match) => [match.clusterId, truthById.get(match.speakerId)])
    );
    const decisionByCluster = new Map();
    for (const decision of evaluationCase.decisions) {
      if (!decision || typeof decision.clusterId !== "string") {
        throw new TypeError("decision clusterId must be a string");
      }
      if (decisionByCluster.has(decision.clusterId)) {
        throw new TypeError("a cluster may have only one decision");
      }
      decisionByCluster.set(decision.clusterId, decision);
    }

    for (const [clusterId, decision] of [...decisionByCluster].sort(([left], [right]) =>
      compareIds(left, right)
    )) {
      const truth = truthByCluster.get(clusterId) ?? null;
      const hasCandidate = typeof decision.candidatePersonId === "string";

      if (decision.state === "confirmed") {
        if (decision.candidateKind === "self") self.automaticSupport += 1;
        if (decision.candidateKind === "known") known.automaticSupport += 1;

        const category =
          decision.candidateKind === "self"
            ? self
            : decision.candidateKind === "known"
              ? known
              : null;
        if (category) {
          if (
            truth &&
            truth.kind === decision.candidateKind &&
            truth.personId === decision.candidatePersonId
          ) {
            category.tp += 1;
          } else {
            category.fp += 1;
          }
        }
        if (
          truth?.kind === "unknown" &&
          hasCandidate &&
          (decision.candidateKind === "self" || decision.candidateKind === "known")
        ) {
          unknown.automaticFalsePositives += 1;
        }

        automaticBoundaries.push({
          caseId: evaluationCase.caseId,
          clusterId,
          candidatePersonId: decision.candidatePersonId ?? null,
          score: decision.score ?? null,
          requiredScore: policy.autoConfirmSimilarity,
          scorePass:
            Number.isFinite(decision.score) && decision.score >= policy.autoConfirmSimilarity,
          margin: decision.margin ?? null,
          requiredMargin: policy.minimumMargin,
          marginPass: Number.isFinite(decision.margin) && decision.margin >= policy.minimumMargin,
        });
      }

      if ((decision.state === "confirmed" || decision.state === "suggested") && hasCandidate) {
        const correctCandidate =
          truth && truth.kind !== "unknown" && truth.personId === decision.candidatePersonId;
        if (!correctCandidate) correctionsNeeded += 1;
      }
    }
  }

  self.fn = self.truthSupport - self.tp;
  known.fn = known.truthSupport - known.tp;
  self.precision = safeRatio(self.tp, self.automaticSupport);
  self.recall = safeRatio(self.tp, self.truthSupport);
  known.precision = safeRatio(known.tp, known.automaticSupport);
  known.recall = safeRatio(known.tp, known.truthSupport);
  unknown.falsePositiveRate = safeRatio(unknown.automaticFalsePositives, unknown.truthSupport);

  return {
    speakerCount: {
      correctCases,
      totalCases: cases.length,
      accuracy: safeRatio(correctCases, cases.length),
    },
    self,
    known,
    unknown,
    correctionsNeeded,
    automaticBoundaries,
  };
}

function evaluateSpeakerReleaseGates(report) {
  if (!report || typeof report !== "object") throw new TypeError("report is required");
  const failures = [];

  if (!(report.self?.truthSupport > 0)) failures.push("self_truth_support_zero");
  if (!(report.self?.automaticSupport > 0)) failures.push("self_automatic_support_zero");
  if (
    report.self?.truthSupport > 0 &&
    report.self?.automaticSupport > 0 &&
    !(report.self.precision >= 0.95)
  ) {
    failures.push("self_precision_below_0_95");
  }

  if (!(report.known?.truthSupport > 0)) failures.push("known_truth_support_zero");
  if (!(report.known?.automaticSupport > 0)) failures.push("known_automatic_support_zero");
  if (
    report.known?.truthSupport > 0 &&
    report.known?.automaticSupport > 0 &&
    !(report.known.precision >= 0.95)
  ) {
    failures.push("known_precision_below_0_95");
  }

  if (!(report.unknown?.truthSupport > 0)) failures.push("unknown_truth_support_zero");
  if (report.unknown?.truthSupport > 0 && !(report.unknown.falsePositiveRate <= 0.05)) {
    failures.push("unknown_false_positive_rate_above_0_05");
  }

  const boundaries = Array.isArray(report.automaticBoundaries) ? report.automaticBoundaries : [];
  if (boundaries.some((boundary) => boundary.scorePass !== true)) {
    failures.push("automatic_score_boundary_failed");
  }
  if (boundaries.some((boundary) => boundary.marginPass !== true)) {
    failures.push("automatic_margin_boundary_failed");
  }

  return { passed: failures.length === 0, failures };
}

module.exports = {
  maximumWeightSpeakerMatching,
  computeSpeakerIdentityMetrics,
  evaluateSpeakerReleaseGates,
};
