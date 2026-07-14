const ECHO_SCORE_THRESHOLD = 0.8;
const TEXT_SIMILARITY_THRESHOLD = 0.85;

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
    leftPoints.length >= rightPoints.length
      ? [leftPoints, rightPoints]
      : [rightPoints, leftPoints];
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
  const longest = Math.max(Array.from(left).length, Array.from(right).length);
  return longestCommonSubsequenceLength(left, right) / longest;
}

function overlapDuration(left, right) {
  return Math.max(0, Math.min(left.ended_at, right.ended_at) - Math.max(left.started_at, right.started_at));
}

function compareWinner(left, right) {
  if (left.similarity !== right.similarity) return right.similarity - left.similarity;
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

class DualTrackTranscriptDeduper {
  constructor({ repository }) {
    if (!repository || typeof repository.dedupeTranscriptTransaction !== "function") {
      throw new TypeError("repository.dedupeTranscriptTransaction must be a function");
    }
    this.repository = repository;
  }

  dedupe(sessionId) {
    return this.repository.dedupeTranscriptTransaction(sessionId, (rows) => {
      const systems = rows.filter((row) => row.source_type === "system");
      const assignments = [];
      for (const mic of rows) {
        if (mic.source_type !== "mic" || mic.echo_score === null || mic.echo_score < ECHO_SCORE_THRESHOLD) {
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
        if (winner) assignments.push({ micId: mic.id, systemId: winner.segment.id });
      }
      return assignments;
    });
  }
}

module.exports = DualTrackTranscriptDeduper;
module.exports.normalizeTranscriptText = normalizeTranscriptText;
module.exports.normalizedSimilarity = normalizedSimilarity;
module.exports.strictlyOverlaps = strictlyOverlaps;
module.exports.compareWinner = compareWinner;
