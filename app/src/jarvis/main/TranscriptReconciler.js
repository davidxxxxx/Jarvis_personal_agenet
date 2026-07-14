function compareFinalWinner(left, right) {
  const version = (right.version ?? 1) - (left.version ?? 1);
  if (version !== 0) return version;
  const completedAt = (right.completed_at ?? -1) - (left.completed_at ?? -1);
  if (completedAt !== 0) return completedAt;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function strictlyOverlaps(left, right) {
  return left.started_at < right.ended_at && right.started_at < left.ended_at;
}

class TranscriptReconciler {
  constructor({ repository }) {
    if (!repository || typeof repository.reconcileTranscriptTransaction !== "function") {
      throw new TypeError("repository.reconcileTranscriptTransaction must be a function");
    }
    this.repository = repository;
  }

  reconcileSession(sessionId) {
    return this.repository.reconcileTranscriptTransaction(
      sessionId,
      ({ provisional, final }) => {
        const assignments = [];
        for (const preview of provisional) {
          if (preview.superseded_by !== null) continue;
          const winner = final
            .filter(
              (candidate) =>
                preview.track_id === candidate.track_id && strictlyOverlaps(preview, candidate)
            )
            .sort(compareFinalWinner)[0];
          if (winner) {
            assignments.push({ provisionalId: preview.id, finalId: winner.id });
          }
        }
        return assignments;
      }
    );
  }
}

module.exports = TranscriptReconciler;
module.exports.compareFinalWinner = compareFinalWinner;
module.exports.strictlyOverlaps = strictlyOverlaps;
