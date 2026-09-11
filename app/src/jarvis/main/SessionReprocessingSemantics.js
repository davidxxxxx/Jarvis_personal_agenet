"use strict";

const crypto = require("node:crypto");
const ActivityClassificationRepository = require("./ActivityClassificationRepository");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticHash(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function compareCanonical(left, right) {
  const leftValue = canonical(left);
  const rightValue = canonical(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function contentState(db, sessionId) {
  return db
    .prepare(
      `SELECT segment.started_at, segment.ended_at, trim(segment.text) AS text,
              segment.source_type, track.application_key
       FROM transcript_segments AS segment
       LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
       WHERE segment.session_id = ?
         AND segment.result_kind = 'final'
         AND segment.is_stable = 1
         AND segment.superseded_by IS NULL
         AND segment.duplicate_of IS NULL
         AND length(trim(segment.text)) > 0
       ORDER BY segment.started_at, segment.ended_at, text,
                segment.source_type, track.application_key`
    )
    .all(sessionId)
    .map((row) => ({
      startedAt: row.started_at,
      endedAt: row.ended_at,
      text: row.text,
      sourceType: row.source_type,
      applicationKey: row.application_key ?? null,
    }));
}

function latestDiarizationRuns(db, sessionId) {
  return db
    .prepare(
      `SELECT run.id, run.track_id, track.source_type, track.application_key
       FROM speaker_diarization_runs AS run
       LEFT JOIN audio_tracks AS track ON track.id = run.track_id
       WHERE run.session_id = ?
         AND run.input_version = (
           SELECT max(candidate.input_version)
           FROM speaker_diarization_runs AS candidate
           WHERE candidate.session_id = run.session_id
         )
         AND run.commit_sequence = (
           SELECT max(candidate.commit_sequence)
           FROM speaker_diarization_runs AS candidate
           WHERE candidate.session_id = run.session_id
             AND candidate.track_id = run.track_id
             AND candidate.input_version = run.input_version
         )
       ORDER BY track.source_type, track.application_key, run.track_id`
    )
    .all(sessionId);
}

function identityState(db, sessionId) {
  const clustersForRun = db.prepare(
    `SELECT run_cluster.cluster_id, cluster.link_state, cluster.person_id,
            person.is_self, review.disposition AS review_disposition
     FROM speaker_diarization_run_clusters AS run_cluster
     JOIN speaker_clusters AS cluster ON cluster.id = run_cluster.cluster_id
     LEFT JOIN people AS person ON person.id = cluster.person_id
     LEFT JOIN speaker_cluster_review_overrides AS review
       ON review.session_id = cluster.session_id AND review.cluster_id = cluster.id
     WHERE run_cluster.run_id = ?
     ORDER BY run_cluster.cluster_id`
  );
  const segmentsForCluster = db.prepare(
    `SELECT segment.started_at, segment.ended_at, trim(segment.text) AS text,
            segment.source_type, track.application_key,
            review.group_ref, review.disposition AS review_disposition
     FROM speaker_cluster_segments AS membership
     JOIN transcript_segments AS segment ON segment.id = membership.transcript_segment_id
     LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
     LEFT JOIN speaker_segment_review_overrides AS review
       ON review.session_id = segment.session_id
      AND review.cluster_id = membership.cluster_id
      AND review.transcript_segment_id = segment.id
     WHERE membership.cluster_id = ?
       AND segment.session_id = ?
       AND segment.result_kind = 'final'
       AND segment.is_stable = 1
       AND segment.superseded_by IS NULL
       AND segment.duplicate_of IS NULL
     ORDER BY segment.started_at, segment.ended_at, text,
              segment.source_type, track.application_key`
  );
  const groups = [];
  for (const run of latestDiarizationRuns(db, sessionId)) {
    for (const cluster of clustersForRun.all(run.id)) {
      const segments = segmentsForCluster.all(cluster.cluster_id, sessionId).map((segment) => ({
        startedAt: segment.started_at,
        endedAt: segment.ended_at,
        text: segment.text,
        sourceType: segment.source_type,
        applicationKey: segment.application_key ?? null,
        reviewDisposition: segment.review_disposition ?? null,
      }));
      groups.push({
        track: {
          sourceType: run.source_type ?? null,
          applicationKey: run.application_key ?? null,
        },
        linkState: cluster.link_state,
        personRef:
          cluster.person_id === null ? null : cluster.is_self === 1 ? "SELF" : cluster.person_id,
        reviewDisposition: cluster.review_disposition ?? null,
        segments,
      });
    }
  }
  return groups.sort(compareCanonical);
}

function classificationState(db, sessionId) {
  const repository = new ActivityClassificationRepository(db);
  return repository.listSessionEffective(sessionId).map((entry) => ({
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    category: entry.category,
    decision: entry.decision,
    sourceAttribution: entry.sourceAttribution,
    applicationKeys: [...new Set(entry.evidence?.applicationKeys ?? [])].sort(),
    microphoneParticipated: entry.evidence?.microphoneParticipated === true,
    selfDetected: entry.evidence?.selfDetected === true,
    speakerCount: entry.evidence?.speakerCount ?? 0,
    allowSummary: entry.evidence?.allowSummary === true,
    allowSuggestions: entry.evidence?.allowSuggestions === true,
    allowTodos: entry.evidence?.allowTodos === true,
  }));
}

function computeSessionSemanticHashes(db, sessionId) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("an open better-sqlite3 database is required");
  }
  if (typeof sessionId !== "string" || !sessionId) {
    throw new TypeError("sessionId is required");
  }
  return {
    contentSha256: semanticHash(contentState(db, sessionId)),
    identitySha256: semanticHash(identityState(db, sessionId)),
    classificationSha256: semanticHash(classificationState(db, sessionId)),
  };
}

module.exports = {
  computeSessionSemanticHashes,
  semanticHash,
};
