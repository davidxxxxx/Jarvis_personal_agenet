const ECHO_SCORE_THRESHOLD = 0.8;
const TEXT_SIMILARITY_THRESHOLD = 0.85;
const EXACT_APPLICATION_COVERAGE_THRESHOLD = 0.8;
const COMPETING_APPLICATION_COVERAGE_LIMIT = 0.2;
const DOMINANT_APPLICATION_COVERAGE_MARGIN = 0.5;
const MAX_LCS_CODE_POINTS = 4096;
const DEFAULT_ACOUSTIC_BATCH_SIZE = 4;

function defaultAcousticYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function acousticDeferredError() {
  const error = new Error("acoustic transcript dedupe deferred by resource governor");
  error.code = "ACOUSTIC_DEDUPE_RESOURCE_DEFERRED";
  return error;
}

function normalizeTranscriptText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function longestCommonSubsequenceLength(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  if (leftPoints.length === 0 || rightPoints.length === 0) return 0;
  const [rows, columns] =
    leftPoints.length >= rightPoints.length ? [leftPoints, rightPoints] : [rightPoints, leftPoints];
  let previous = new Uint32Array(columns.length + 1);
  let current = new Uint32Array(columns.length + 1);

  for (const row of rows) {
    for (let column = 1; column <= columns.length; column += 1) {
      current[column] =
        row === columns[column - 1]
          ? previous[column - 1] + 1
          : Math.max(previous[column], current[column - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[columns.length];
}

function normalizedSimilarity(leftValue, rightValue) {
  const left = normalizeTranscriptText(leftValue);
  const right = normalizeTranscriptText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftLength = Array.from(left).length;
  const rightLength = Array.from(right).length;
  const longest = Math.max(leftLength, rightLength);
  if (longest > MAX_LCS_CODE_POINTS) return 0;
  if (Math.min(leftLength, rightLength) / longest < TEXT_SIMILARITY_THRESHOLD) return 0;
  return longestCommonSubsequenceLength(left, right) / longest;
}

function overlapDuration(left, right) {
  return Math.max(
    0,
    Math.min(left.ended_at, right.ended_at) - Math.max(left.started_at, right.started_at)
  );
}

function coveredOverlap(target, segments) {
  const ranges = segments
    .map((segment) => [
      Math.max(target.started_at, segment.started_at),
      Math.min(target.ended_at, segment.ended_at),
    ])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let start = null;
  let end = null;
  for (const range of ranges) {
    if (start === null) {
      [start, end] = range;
      continue;
    }
    if (range[0] > end) {
      total += end - start;
      [start, end] = range;
    } else {
      end = Math.max(end, range[1]);
    }
  }
  return start === null ? 0 : total + end - start;
}

function exactApplicationCoverageWinner(mixed, applications) {
  const duration = mixed.ended_at - mixed.started_at;
  if (duration <= 0) return null;
  const groups = new Map();
  for (const segment of applications) {
    if (segment.attribution_state !== "exact" || !strictlyOverlaps(mixed, segment)) {
      continue;
    }
    const key = segment.application_key || segment.track_id;
    const current = groups.get(key) ?? [];
    current.push(segment);
    groups.set(key, current);
  }
  const ranked = [...groups.values()]
    .map((segments) => ({
      segments,
      coverage: coveredOverlap(mixed, segments) / duration,
    }))
    .sort(
      (left, right) =>
        right.coverage - left.coverage ||
        String(left.segments[0]?.application_key ?? left.segments[0]?.track_id).localeCompare(
          String(right.segments[0]?.application_key ?? right.segments[0]?.track_id)
        )
    );
  if (
    !ranked[0] ||
    ranked[0].coverage < EXACT_APPLICATION_COVERAGE_THRESHOLD ||
    ((ranked[1]?.coverage ?? 0) > COMPETING_APPLICATION_COVERAGE_LIMIT &&
      ranked[0].coverage - ranked[1].coverage < DOMINANT_APPLICATION_COVERAGE_MARGIN)
  ) {
    return null;
  }
  const winner = ranked[0].segments
    .map((segment) => ({
      segment,
      similarity: normalizedSimilarity(mixed.text, segment.text),
      overlap: overlapDuration(mixed, segment),
    }))
    .sort(compareWinner)[0];
  return winner ?? null;
}

function compareWinner(left, right) {
  if (left.similarity !== right.similarity) return right.similarity - left.similarity;
  const leftApplication = left.segment.track_kind === "application" ? 1 : 0;
  const rightApplication = right.segment.track_kind === "application" ? 1 : 0;
  if (leftApplication !== rightApplication) return rightApplication - leftApplication;
  const leftFinal = left.segment.result_kind === "final" ? 1 : 0;
  const rightFinal = right.segment.result_kind === "final" ? 1 : 0;
  if (leftFinal !== rightFinal) return rightFinal - leftFinal;
  const version = (right.segment.version ?? 1) - (left.segment.version ?? 1);
  if (version !== 0) return version;
  const completion = (right.segment.completed_at ?? -1) - (left.segment.completed_at ?? -1);
  if (completion !== 0) return completion;
  if (left.overlap !== right.overlap) return right.overlap - left.overlap;
  if (left.segment.started_at !== right.segment.started_at) {
    return left.segment.started_at - right.segment.started_at;
  }
  if (left.segment.id < right.segment.id) return -1;
  if (left.segment.id > right.segment.id) return 1;
  return 0;
}

function strictlyOverlaps(left, right) {
  return left.started_at < right.ended_at && right.started_at < left.ended_at;
}

function selectTranscriptDuplicates(
  rows,
  acousticAssignments = [],
  { allowCoverageFallback = true } = {}
) {
  const systems = rows.filter((row) => row.source_type === "system");
  const applicationSegments = systems.filter((row) => row.track_kind === "application");
  const assignments = [];
  const assigned = new Set();
  for (const mixed of systems.filter((row) => row.track_kind === "system_mix")) {
    const textWinner = applicationSegments
      .filter((application) => strictlyOverlaps(mixed, application))
      .map((application) => ({
        segment: application,
        similarity: normalizedSimilarity(mixed.text, application.text),
        overlap: overlapDuration(mixed, application),
      }))
      .filter((candidate) => candidate.similarity >= TEXT_SIMILARITY_THRESHOLD)
      .sort(compareWinner)[0];
    const winner =
      textWinner ??
      (allowCoverageFallback ? exactApplicationCoverageWinner(mixed, applicationSegments) : null);
    if (winner) {
      assignments.push({ duplicateId: mixed.id, masterId: winner.segment.id });
      assigned.add(mixed.id);
    }
  }
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const assignment of acousticAssignments) {
    const mixed = rowsById.get(assignment.duplicateId);
    const application = rowsById.get(assignment.masterId);
    if (
      assigned.has(assignment.duplicateId) ||
      mixed?.track_kind !== "system_mix" ||
      application?.track_kind !== "application" ||
      application.attribution_state !== "exact" ||
      !strictlyOverlaps(mixed, application)
    ) {
      continue;
    }
    assignments.push(assignment);
    assigned.add(assignment.duplicateId);
  }
  for (const mic of rows) {
    if (
      mic.source_type !== "mic" ||
      mic.echo_score === null ||
      mic.echo_score < ECHO_SCORE_THRESHOLD
    ) {
      continue;
    }
    const winner = systems
      .filter((system) => strictlyOverlaps(mic, system))
      .map((system) => ({
        segment: system,
        similarity: normalizedSimilarity(mic.text, system.text),
        overlap: overlapDuration(mic, system),
      }))
      .filter((candidate) => candidate.similarity >= TEXT_SIMILARITY_THRESHOLD)
      .sort(compareWinner)[0];
    if (winner) assignments.push({ duplicateId: mic.id, masterId: winner.segment.id });
  }
  return assignments;
}

class DualTrackTranscriptDeduper {
  constructor({
    repository,
    acousticMatcher = null,
    acousticAdmission = null,
    acousticBatchSize = DEFAULT_ACOUSTIC_BATCH_SIZE,
    acousticYield = defaultAcousticYield,
  }) {
    if (!repository || typeof repository.dedupeTranscriptTransaction !== "function") {
      throw new TypeError("repository.dedupeTranscriptTransaction must be a function");
    }
    if (acousticMatcher !== null && typeof acousticMatcher.findWinner !== "function") {
      throw new TypeError("acousticMatcher.findWinner must be a function or null");
    }
    if (
      acousticMatcher !== null &&
      typeof repository.listTranscriptDedupeCandidates !== "function"
    ) {
      throw new TypeError("repository.listTranscriptDedupeCandidates must be a function");
    }
    if (acousticAdmission !== null && typeof acousticAdmission !== "function") {
      throw new TypeError("acousticAdmission must be a function or null");
    }
    if (!Number.isSafeInteger(acousticBatchSize) || acousticBatchSize <= 0) {
      throw new TypeError("acousticBatchSize must be a positive safe integer");
    }
    if (typeof acousticYield !== "function") {
      throw new TypeError("acousticYield must be a function");
    }
    this.repository = repository;
    this.acousticMatcher = acousticMatcher;
    this.acousticAdmission = acousticAdmission;
    this.acousticBatchSize = acousticBatchSize;
    this.acousticYield = acousticYield;
  }

  dedupe(sessionId) {
    if (!this.acousticMatcher) {
      return this.repository.dedupeTranscriptTransaction(sessionId, (rows) =>
        selectTranscriptDuplicates(rows)
      );
    }
    return this._dedupeWithAcoustics(sessionId);
  }

  async _dedupeWithAcoustics(sessionId) {
    const rows = this.repository.listTranscriptDedupeCandidates(sessionId);
    const systems = rows.filter((row) => row.source_type === "system");
    const applications = systems.filter((row) => row.track_kind === "application");
    const fastAssignments = selectTranscriptDuplicates(rows, [], { allowCoverageFallback: false });
    const assigned = new Set(fastAssignments.map((assignment) => assignment.duplicateId));
    const unresolvedMixed = systems.filter(
      (row) => row.track_kind === "system_mix" && !assigned.has(row.id)
    );
    const acousticWork = unresolvedMixed
      .map((mixed) => ({
        mixed,
        applications: applications.filter((application) => strictlyOverlaps(mixed, application)),
      }))
      .filter((entry) => entry.applications.length > 0);
    const commitFastAssignments = () =>
      this.repository.dedupeTranscriptTransaction(sessionId, (currentRows) =>
        selectTranscriptDuplicates(currentRows, [], { allowCoverageFallback: false })
      );
    const admitBatch = async () => {
      if (!this.acousticAdmission) return;
      let admitted = false;
      try {
        admitted =
          (await this.acousticAdmission({
            sessionId,
            mixedCount: acousticWork.length,
            applicationCount: applications.length,
          })) === true;
      } catch {
        admitted = false;
      }
      if (!admitted) {
        commitFastAssignments();
        throw acousticDeferredError();
      }
    };
    const acousticAssignments = [];
    for (const [index, entry] of acousticWork.entries()) {
      if (index % this.acousticBatchSize === 0) {
        if (index > 0) await this.acousticYield();
        await admitBatch();
      }
      const winner = await this.acousticMatcher.findWinner(entry.mixed, entry.applications);
      if (winner?.segment?.id) {
        acousticAssignments.push({ duplicateId: entry.mixed.id, masterId: winner.segment.id });
      }
    }
    return this.repository.dedupeTranscriptTransaction(sessionId, (currentRows) =>
      selectTranscriptDuplicates(currentRows, acousticAssignments, { allowCoverageFallback: false })
    );
  }
}

module.exports = DualTrackTranscriptDeduper;
module.exports.normalizeTranscriptText = normalizeTranscriptText;
module.exports.normalizedSimilarity = normalizedSimilarity;
module.exports.strictlyOverlaps = strictlyOverlaps;
module.exports.compareWinner = compareWinner;
module.exports.selectTranscriptDuplicates = selectTranscriptDuplicates;
