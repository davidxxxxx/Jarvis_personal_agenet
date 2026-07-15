const crypto = require("node:crypto");

const PROFILE_SAMPLE_QUALITY_GATE = Object.freeze({
  minimumSpeechMs: 12_000,
  minimumWindows: 3,
  minimumQualityScore: 0.78,
});

const SCOPES = new Set(["session", "persistent"]);
const ACTORS = new Set(["user", "system"]);
const PROFILE_SOURCE_KINDS = new Set(["enrollment", "user_confirmed"]);
const RESOLUTION_STATES = new Set(["unknown", "suggested", "confirmed"]);
const SHA256 = /^[0-9a-f]{64}$/;

function assertId(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertOptionalScore(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function assertEnum(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`invalid ${name}`);
  return value;
}

function assertRevision(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertResolutionScore(value, name, { maximum = 1, minimum = -1 } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the valid range`);
  }
  return value;
}

function deterministicResolutionId(...parts) {
  return `speaker_resolution_${crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

function encodeEmbedding(embedding) {
  if (!(embedding instanceof Float32Array) || embedding.length === 0) {
    throw new TypeError("embedding must be a non-empty Float32Array");
  }
  const buffer = Buffer.allocUnsafe(embedding.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < embedding.length; index += 1) {
    const value = embedding[index];
    if (!Number.isFinite(value)) throw new TypeError("embedding values must be finite");
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  }
  return buffer;
}

function decodeEmbedding(blob, expectedDimension = null) {
  if (!Buffer.isBuffer(blob) && !(blob instanceof Uint8Array)) {
    throw new TypeError("embedding blob must be binary data");
  }
  if (blob.byteLength === 0 || blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError("embedding blob length must be a non-zero multiple of 4");
  }
  const dimension = blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (
    expectedDimension !== null &&
    (!Number.isSafeInteger(expectedDimension) ||
      expectedDimension <= 0 ||
      dimension !== expectedDimension)
  ) {
    throw new TypeError(`embedding dimension ${dimension} does not match ${expectedDimension}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const embedding = new Float32Array(dimension);
  for (let index = 0; index < dimension; index += 1) {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) throw new TypeError("stored embedding values must be finite");
    embedding[index] = value;
  }
  return embedding;
}

function mapCorrection(row) {
  if (!row) return null;
  return {
    id: row.id,
    clusterId: row.cluster_id,
    previousPersonId: row.previous_person_id,
    nextPersonId: row.next_person_id,
    previousPersonRef: row.previous_person_ref,
    nextPersonRef: row.next_person_ref,
    previousState: row.previous_state,
    nextState: row.next_state,
    scope: row.scope,
    actor: row.actor,
    correctionKind: row.correction_kind,
    resolutionCommitSequence: row.resolution_commit_sequence,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  };
}

function mapResolution(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    evidenceRunId: row.evidence_run_id,
    clusterId: row.cluster_id,
    diarizationRevision: row.diarization_revision,
    profileRevision: row.profile_revision,
    policyId: row.policy_id,
    candidatePersonId: row.candidate_person_id,
    candidatePersonRef: row.candidate_person_ref,
    state: row.resolution_state,
    score: row.match_score,
    margin: row.match_margin,
    reason: row.reason,
    actor: row.actor,
    projectionApplied: row.projection_applied === 1,
    createdAt: row.created_at,
  };
}

class SpeakerIdentityRepository {
  constructor(db, { createId, now = Date.now } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("db must be a better-sqlite3 database");
    }
    if (createId !== undefined && typeof createId !== "function") {
      throw new TypeError("createId must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.db = db;
    this.createId =
      createId ??
      ((prefix) => {
        const random = crypto.randomUUID().replaceAll("-", "");
        return `${prefix}_${random}`;
      });
    this.now = now;
    this.statements = {
      insertCluster: db.prepare(`
        INSERT INTO speaker_clusters (
          id, session_id, track_id, local_label, model_id, embedding,
          speech_ms, window_count, quality_score, person_id, link_state,
          match_score, match_margin, created_at, updated_at
        ) VALUES (
          @id, @sessionId, @trackId, @localLabel, @modelId, @embedding,
          @speechMs, @windowCount, @qualityScore, NULL, 'unknown',
          @matchScore, @matchMargin, @createdAt, @updatedAt
        )
      `),
      getCluster: db.prepare("SELECT * FROM speaker_clusters WHERE id = ?"),
      listSessionClusters: db.prepare(`
        SELECT * FROM speaker_clusters
        WHERE session_id = ?
        ORDER BY track_id, local_label, id
      `),
      listClusterSegments: db.prepare(`
        SELECT transcript_segment_id FROM speaker_cluster_segments
        WHERE cluster_id = ? ORDER BY transcript_segment_id
      `),
      deleteClusterSegments: db.prepare(
        "DELETE FROM speaker_cluster_segments WHERE cluster_id = ?"
      ),
      insertClusterSegment: db.prepare(`
        INSERT INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
        VALUES (?, ?)
      `),
      getTranscriptSegment: db.prepare(
        "SELECT id, session_id FROM transcript_segments WHERE id = ?"
      ),
      getPerson: db.prepare("SELECT * FROM people WHERE id = ?"),
      listProfiles: db.prepare(`
        SELECT * FROM voice_profile_samples
        WHERE model_id = ? ORDER BY person_id, created_at, id
      `),
      getProfileAggregate: db.prepare(`
        SELECT * FROM voice_profile_aggregates
        WHERE person_id = ? AND model_id = ?
      `),
      deleteEnrollmentProfiles: db.prepare(`
        DELETE FROM voice_profile_samples
        WHERE person_id = ? AND model_id = ? AND source_kind = 'enrollment'
      `),
      upsertProfileAggregate: db.prepare(`
        INSERT INTO voice_profile_aggregates (
          person_id, model_id, embedding, accepted_speech_ms,
          window_count, self_consistency, updated_at
        ) VALUES (
          @personId, @modelId, @embedding, @acceptedSpeechMs,
          @windowCount, @selfConsistency, @updatedAt
        )
        ON CONFLICT(person_id, model_id) DO UPDATE SET
          embedding = excluded.embedding,
          accepted_speech_ms = excluded.accepted_speech_ms,
          window_count = excluded.window_count,
          self_consistency = excluded.self_consistency,
          updated_at = excluded.updated_at
      `),
      getImportMarker: db.prepare(
        "SELECT marker_key FROM voice_profile_import_markers WHERE marker_key = ?"
      ),
      insertImportMarker: db.prepare(`
        INSERT INTO voice_profile_import_markers (marker_key, imported_at) VALUES (?, ?)
      `),
      insertProfile: db.prepare(`
        INSERT INTO voice_profile_samples (
          id, person_id, model_id, embedding, source_cluster_id,
          source_kind, speech_ms, window_count, created_at
        ) VALUES (
          @id, @personId, @modelId, @embedding, @sourceClusterId,
          @sourceKind, @speechMs, @windowCount, @createdAt
        )
      `),
      insertProfileIfMissing: db.prepare(`
        INSERT OR IGNORE INTO voice_profile_samples (
          id, person_id, model_id, embedding, source_cluster_id,
          source_kind, speech_ms, window_count, created_at
        ) VALUES (
          @id, @personId, @modelId, @embedding, @sourceClusterId,
          'user_confirmed', @speechMs, @windowCount, @createdAt
        )
      `),
      insertCorrection: db.prepare(`
        INSERT INTO speaker_identity_corrections (
          id, cluster_id, previous_person_id, next_person_id,
          previous_person_ref, next_person_ref, previous_state, next_state,
          scope, actor, correction_kind, resolution_commit_sequence, created_at
        ) VALUES (
          @id, @clusterId, @previousPersonId, @nextPersonId,
          @previousPersonRef, @nextPersonRef, @previousState, @nextState,
          @scope, @actor, @correctionKind, @resolutionCommitSequence, @createdAt
        )
      `),
      updateClusterLink: db.prepare(`
        UPDATE speaker_clusters
        SET person_id = @personId, link_state = @linkState,
            match_score = @matchScore, match_margin = @matchMargin,
            updated_at = @updatedAt
        WHERE id = @clusterId
      `),
      listCorrections: db.prepare(`
        SELECT * FROM speaker_identity_corrections
        WHERE cluster_id = ? ORDER BY created_at, rowid
      `),
      getLatestActiveCorrection: db.prepare(`
        SELECT * FROM speaker_identity_corrections
        WHERE cluster_id = ? AND undone_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `),
      getLatestActiveUserCorrection: db.prepare(`
        SELECT * FROM (
          SELECT * FROM speaker_identity_corrections
          WHERE cluster_id = ? AND actor = 'user' AND undone_at IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        ) AS latest
        WHERE correction_kind = 'merge' OR next_state IN ('confirmed','suggested')
      `),
      markCorrectionUndone: db.prepare(`
        UPDATE speaker_identity_corrections SET undone_at = ?
        WHERE id = ? AND undone_at IS NULL
      `),
      deleteConfirmedClusterProfiles: db.prepare(`
        DELETE FROM voice_profile_samples
        WHERE source_cluster_id = ? AND source_kind = 'user_confirmed'
      `),
      listModelEmbeddings: db.prepare(`
        SELECT embedding FROM speaker_clusters
        WHERE model_id = ? AND embedding IS NOT NULL
        UNION ALL
        SELECT embedding FROM voice_profile_samples
        WHERE model_id = ?
      `),
      getResolutionEvidence: db.prepare(`
        SELECT run.session_id, run_cluster.cluster_id
        FROM speaker_diarization_run_clusters AS run_cluster
        JOIN speaker_diarization_runs AS run ON run.id = run_cluster.run_id
        WHERE run_cluster.run_id = ? AND run_cluster.cluster_id = ?
      `),
      listResolutionEvidenceForSession: db.prepare(`
        SELECT run.id AS evidence_run_id, run.session_id, run_cluster.cluster_id
        FROM speaker_diarization_runs AS run
        JOIN speaker_diarization_run_clusters AS run_cluster ON run_cluster.run_id = run.id
        WHERE run.session_id = ?
        ORDER BY run.id, run_cluster.cluster_id
      `),
      getResolutionRun: db.prepare(`
        SELECT * FROM speaker_identity_resolution_runs
        WHERE session_id = @sessionId
          AND diarization_revision = @diarizationRevision
          AND profile_revision = @profileRevision
          AND policy_id = @policyId
      `),
      insertResolutionRun: db.prepare(`
        INSERT INTO speaker_identity_resolution_runs (
          id, session_id, diarization_revision, profile_revision, policy_id,
          commit_sequence, expected_cluster_count, created_at, completed_at
        ) VALUES (
          @id, @sessionId, @diarizationRevision, @profileRevision, @policyId,
          @commitSequence, @expectedClusterCount, @createdAt, @completedAt
        )
      `),
      nextResolutionCommitSequence: db.prepare(`
        SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value
        FROM speaker_identity_resolution_runs
      `),
      insertResolution: db.prepare(`
        INSERT INTO speaker_identity_resolutions (
          id, resolution_run_id, session_id, evidence_run_id, cluster_id,
          diarization_revision, profile_revision, policy_id,
          candidate_person_id, candidate_person_ref, resolution_state,
          match_score, match_margin, reason, actor, correction_id,
          projection_applied, created_at
        ) VALUES (
          @id, @resolutionRunId, @sessionId, @evidenceRunId, @clusterId,
          @diarizationRevision, @profileRevision, @policyId,
          @candidatePersonId, @candidatePersonRef, @state,
          @score, @margin, @reason, @actor, @correctionId,
          @projectionApplied, @createdAt
        )
      `),
      getResolution: db.prepare("SELECT * FROM speaker_identity_resolutions WHERE id = ?"),
      updateSystemResolution: db.prepare(`
        UPDATE speaker_identity_resolutions
        SET candidate_person_id = @candidatePersonId,
            candidate_person_ref = @candidatePersonRef,
            resolution_state = @state,
            match_score = @score,
            match_margin = @margin,
            reason = @reason,
            projection_applied = @projectionApplied
        WHERE id = @id AND actor = 'system'
      `),
      listResolutionRunResults: db.prepare(`
        SELECT * FROM speaker_identity_resolutions
        WHERE resolution_run_id = ? AND actor = 'system'
        ORDER BY cluster_id
      `),
      listResolutionHistory: db.prepare(`
        SELECT * FROM speaker_identity_resolutions
        WHERE cluster_id = ? ORDER BY created_at, rowid
      `),
      listRejectedPersonRefs: db.prepare(`
        SELECT DISTINCT resolution.candidate_person_ref
        FROM speaker_identity_resolutions AS resolution
        JOIN speaker_identity_corrections AS correction
          ON correction.id = resolution.correction_id
        WHERE resolution.cluster_id = @clusterId
          AND resolution.diarization_revision = @diarizationRevision
          AND resolution.profile_revision = @profileRevision
          AND resolution.policy_id = @policyId
          AND resolution.resolution_state = 'rejected'
          AND resolution.candidate_person_ref IS NOT NULL
          AND correction.undone_at IS NULL
        ORDER BY candidate_person_ref
      `),
      getLatestSystemCandidateResolution: db.prepare(`
        SELECT * FROM speaker_identity_resolutions
        WHERE cluster_id = @clusterId
          AND candidate_person_ref = @personId
          AND actor = 'system'
          AND resolution_state IN ('suggested','confirmed')
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `),
      getLatestSystemResolutionAfter: db.prepare(`
        SELECT resolution.*
        FROM speaker_identity_resolutions AS resolution
        JOIN speaker_identity_resolution_runs AS run
          ON run.id = resolution.resolution_run_id
        WHERE resolution.cluster_id = @clusterId
          AND resolution.actor = 'system'
          AND run.commit_sequence > @minimumCommitSequence
        ORDER BY run.commit_sequence DESC, resolution.rowid DESC LIMIT 1
      `),
      getLatestResolutionCommitSequence: db.prepare(`
        SELECT COALESCE(MAX(run.commit_sequence), 0) AS value
        FROM speaker_identity_resolutions AS resolution
        JOIN speaker_identity_resolution_runs AS run
          ON run.id = resolution.resolution_run_id
        WHERE resolution.cluster_id = ? AND resolution.actor = 'system'
      `),
      wakeResolvedSessionsForModel: db.prepare(`
        UPDATE sessions
        SET processing_state = 'processing', ready_at = NULL,
            timeline_version = timeline_version + 1
        WHERE status IN ('completed','recovered')
          AND id IN (
            SELECT DISTINCT session_id FROM speaker_clusters WHERE model_id = ?
          )
          AND (processing_state <> 'processing' OR ready_at IS NOT NULL)
      `),
    };

    this._replaceClusterSegments = db.transaction((clusterId, transcriptSegmentIds) => {
      const cluster = this.statements.getCluster.get(clusterId);
      if (!cluster) throw new Error("speaker cluster not found");
      for (const segmentId of transcriptSegmentIds) {
        const segment = this.statements.getTranscriptSegment.get(segmentId);
        if (!segment) throw new Error(`transcript segment not found: ${segmentId}`);
        if (segment.session_id !== cluster.session_id) {
          throw new Error("transcript segment must belong to the same session as the cluster");
        }
      }
      this.statements.deleteClusterSegments.run(clusterId);
      for (const segmentId of transcriptSegmentIds) {
        this.statements.insertClusterSegment.run(clusterId, segmentId);
      }
    });

    this._confirmLink = db.transaction((input) => {
      const cluster = this._requireCluster(input.clusterId);
      this._requirePerson(input.personId);
      const createdAt = this.now();
      const correctionId = this.createId("speaker_correction");
      this.statements.insertCorrection.run({
        id: correctionId,
        clusterId: cluster.id,
        previousPersonId: cluster.person_id,
        nextPersonId: input.personId,
        previousPersonRef: cluster.person_id,
        nextPersonRef: input.personId,
        previousState: cluster.link_state,
        nextState: "confirmed",
        scope: input.scope,
        actor: input.actor,
        correctionKind: "link",
        resolutionCommitSequence: this.statements.getLatestResolutionCommitSequence.get(cluster.id)
          .value,
        createdAt,
      });
      this.statements.updateClusterLink.run({
        clusterId: cluster.id,
        personId: input.personId,
        linkState: "confirmed",
        matchScore: input.matchScore ?? cluster.match_score,
        matchMargin: input.matchMargin ?? cluster.match_margin,
        updatedAt: createdAt,
      });
      if (input.scope === "persistent" && input.actor === "user") {
        this._syncConfirmedProfileSample({ ...cluster, person_id: input.personId }, createdAt);
        this.statements.wakeResolvedSessionsForModel.run(cluster.model_id);
      }
    });

    this._rejectSuggestion = db.transaction((input) => {
      const cluster = this._requireCluster(input.clusterId);
      this._requirePerson(input.personId);
      const createdAt = this.now();
      const correctionId = this.createId("speaker_correction");
      this.statements.insertCorrection.run({
        id: correctionId,
        clusterId: cluster.id,
        previousPersonId: cluster.person_id,
        nextPersonId: input.personId,
        previousPersonRef: cluster.person_id,
        nextPersonRef: input.personId,
        previousState: cluster.link_state,
        nextState: "rejected",
        scope: input.scope,
        actor: input.actor,
        correctionKind: "link",
        resolutionCommitSequence: this.statements.getLatestResolutionCommitSequence.get(cluster.id)
          .value,
        createdAt,
      });
      this.statements.updateClusterLink.run({
        clusterId: cluster.id,
        personId: null,
        linkState: "rejected",
        matchScore: cluster.match_score,
        matchMargin: cluster.match_margin,
        updatedAt: createdAt,
      });
      const resolution = this.statements.getLatestSystemCandidateResolution.get({
        clusterId: cluster.id,
        personId: input.personId,
      });
      if (resolution) {
        this.statements.insertResolution.run({
          id: deterministicResolutionId(resolution.id, correctionId, "rejected"),
          resolutionRunId: resolution.resolution_run_id,
          sessionId: resolution.session_id,
          evidenceRunId: resolution.evidence_run_id,
          clusterId: resolution.cluster_id,
          diarizationRevision: resolution.diarization_revision,
          profileRevision: resolution.profile_revision,
          policyId: resolution.policy_id,
          candidatePersonId: input.personId,
          candidatePersonRef: input.personId,
          state: "rejected",
          score: resolution.match_score,
          margin: resolution.match_margin,
          reason: "user_rejected_candidate",
          actor: "user",
          correctionId,
          projectionApplied: 1,
          createdAt,
        });
      }
    });

    this._applySystemResolutions = db.transaction((input) => {
      const existing = this.statements.getResolutionRun.get(input);
      if (existing) {
        const rows = this.statements.listResolutionRunResults.all(existing.id);
        if (
          rows.length !== existing.expected_cluster_count ||
          input.results.length !== existing.expected_cluster_count
        ) {
          throw new Error("identity resolution run is incomplete");
        }
        const expectedPairs = new Set(
          rows.map((row) => `${row.evidence_run_id}\0${row.cluster_id}`)
        );
        const actualPairs = new Set(
          input.results.map((result) => `${result.evidenceRunId}\0${result.clusterId}`)
        );
        if (
          actualPairs.size !== input.results.length ||
          expectedPairs.size !== actualPairs.size ||
          [...expectedPairs].some((pair) => !actualPairs.has(pair))
        ) {
          throw new Error("identity resolution batch must cover every evidence cluster exactly");
        }
        const byCluster = new Map(rows.map((row) => [row.cluster_id, row]));
        for (const result of input.results) {
          const row = byCluster.get(result.clusterId);
          if (!row || row.evidence_run_id !== result.evidenceRunId) {
            throw new Error("identity resolution retry changed immutable evidence");
          }
          if (result.candidatePersonId !== null) this._requirePerson(result.candidatePersonId);
          const userCorrection = this.statements.getLatestActiveUserCorrection.get(
            result.clusterId
          );
          const projectionApplied = userCorrection ? 0 : 1;
          this.statements.updateSystemResolution.run({
            id: row.id,
            candidatePersonId: result.candidatePersonId,
            candidatePersonRef: result.candidatePersonId,
            state: result.state,
            score: result.score,
            margin: result.margin,
            reason: result.reason,
            projectionApplied,
          });
          if (projectionApplied === 1) {
            this.statements.updateClusterLink.run({
              clusterId: result.clusterId,
              personId: result.state === "unknown" ? null : result.candidatePersonId,
              linkState: result.state,
              matchScore: result.score,
              matchMargin: result.margin,
              updatedAt: input.at,
            });
          }
        }
        return this.statements.listResolutionRunResults.all(existing.id);
      }
      const allowedRuns = new Set(input.evidenceRunIds);
      const expectedEvidence = this.statements.listResolutionEvidenceForSession
        .all(input.sessionId)
        .filter((row) => allowedRuns.has(row.evidence_run_id));
      const expectedPairs = new Set(
        expectedEvidence.map((row) => `${row.evidence_run_id}\0${row.cluster_id}`)
      );
      const actualPairs = new Set(
        input.results.map((result) => `${result.evidenceRunId}\0${result.clusterId}`)
      );
      if (
        expectedPairs.size !== input.results.length ||
        actualPairs.size !== input.results.length ||
        [...expectedPairs].some((pair) => !actualPairs.has(pair))
      ) {
        throw new Error("identity resolution batch must cover every evidence cluster exactly");
      }
      for (const evidenceRunId of allowedRuns) {
        const run = this.db
          .prepare("SELECT session_id FROM speaker_diarization_runs WHERE id = ?")
          .get(evidenceRunId);
        if (!run || run.session_id !== input.sessionId) {
          throw new Error("identity resolution evidence run belongs to another session");
        }
      }
      for (const result of input.results) {
        const cluster = this._requireCluster(result.clusterId);
        if (cluster.session_id !== input.sessionId) {
          throw new Error("identity resolution cluster belongs to another session");
        }
        if (result.candidatePersonId !== null) this._requirePerson(result.candidatePersonId);
      }
      this.statements.insertResolutionRun.run({
        id: input.id,
        sessionId: input.sessionId,
        diarizationRevision: input.diarizationRevision,
        profileRevision: input.profileRevision,
        policyId: input.policyId,
        commitSequence: this.statements.nextResolutionCommitSequence.get().value,
        expectedClusterCount: input.results.length,
        createdAt: input.at,
        completedAt: input.at,
      });
      const rows = [];
      for (const result of input.results) {
        const userCorrection = this.statements.getLatestActiveUserCorrection.get(result.clusterId);
        const projectionApplied = userCorrection ? 0 : 1;
        const id = deterministicResolutionId(input.id, result.clusterId);
        this.statements.insertResolution.run({
          id,
          resolutionRunId: input.id,
          sessionId: input.sessionId,
          evidenceRunId: result.evidenceRunId,
          clusterId: result.clusterId,
          diarizationRevision: input.diarizationRevision,
          profileRevision: input.profileRevision,
          policyId: input.policyId,
          candidatePersonId: result.candidatePersonId,
          candidatePersonRef: result.candidatePersonId,
          state: result.state,
          score: result.score,
          margin: result.margin,
          reason: result.reason,
          actor: "system",
          correctionId: null,
          projectionApplied,
          createdAt: input.at,
        });
        if (projectionApplied === 1) {
          this.statements.updateClusterLink.run({
            clusterId: result.clusterId,
            personId: result.state === "unknown" ? null : result.candidatePersonId,
            linkState: result.state,
            matchScore: result.score,
            matchMargin: result.margin,
            updatedAt: input.at,
          });
        }
        rows.push(this.statements.getResolution.get(id));
      }
      return rows;
    });

    this._undoLastCorrection = db.transaction((clusterId) => {
      const cluster = this._requireCluster(clusterId);
      const correction = this.statements.getLatestActiveCorrection.get(clusterId);
      if (!correction || correction.correction_kind !== "link") return;
      const undoneAt = this.now();
      const previousPersonId = correction.previous_person_id;
      const previousState =
        previousPersonId === null &&
        (correction.previous_state === "confirmed" || correction.previous_state === "suggested")
          ? "unknown"
          : correction.previous_state;
      this.statements.updateClusterLink.run({
        clusterId,
        personId: previousPersonId,
        linkState: previousState,
        matchScore: cluster.match_score,
        matchMargin: cluster.match_margin,
        updatedAt: undoneAt,
      });
      if (correction.scope === "persistent" && correction.actor === "user") {
        this._syncConfirmedProfileSample(
          {
            ...cluster,
            person_id: previousState === "confirmed" ? previousPersonId : null,
          },
          undoneAt
        );
        this.statements.wakeResolvedSessionsForModel.run(cluster.model_id);
      }
      this.statements.markCorrectionUndone.run(undoneAt, correction.id);
      const newerSystemResolution = this.statements.getLatestSystemResolutionAfter.get({
        clusterId,
        minimumCommitSequence: correction.resolution_commit_sequence ?? Number.MAX_SAFE_INTEGER,
      });
      if (newerSystemResolution) {
        this.statements.updateClusterLink.run({
          clusterId,
          personId:
            newerSystemResolution.resolution_state === "unknown"
              ? null
              : newerSystemResolution.candidate_person_id,
          linkState: newerSystemResolution.resolution_state,
          matchScore: newerSystemResolution.match_score,
          matchMargin: newerSystemResolution.match_margin,
          updatedAt: undoneAt,
        });
      }
    });

    this._mergePeople = db.transaction((input) => {
      const source = this._requirePerson(input.sourcePersonId);
      if (source.is_self !== 0) throw new Error("self person cannot be merged into another person");
      const target = this._requirePerson(input.targetPersonId);
      const createdAt = this.now();
      const affectedModels = db
        .prepare(
          `SELECT DISTINCT model_id FROM voice_profile_samples
           WHERE person_id IN (?, ?) ORDER BY model_id`
        )
        .all(input.sourcePersonId, input.targetPersonId)
        .map((row) => row.model_id);
      const clusters = db
        .prepare("SELECT * FROM speaker_clusters WHERE person_id = ? ORDER BY id")
        .all(input.sourcePersonId);
      for (const cluster of clusters) {
        this.statements.insertCorrection.run({
          id: this.createId("speaker_correction"),
          clusterId: cluster.id,
          previousPersonId: input.sourcePersonId,
          nextPersonId: input.targetPersonId,
          previousPersonRef: input.sourcePersonId,
          nextPersonRef: input.targetPersonId,
          previousState: cluster.link_state,
          nextState: cluster.link_state,
          scope: "persistent",
          actor: input.actor,
          correctionKind: "merge",
          resolutionCommitSequence: this.statements.getLatestResolutionCommitSequence.get(
            cluster.id
          ).value,
          createdAt,
        });
      }
      db.prepare(
        `DELETE FROM voice_profile_samples AS source
         WHERE source.person_id = @sourcePersonId
           AND source.source_kind = 'user_confirmed'
           AND EXISTS (
             SELECT 1 FROM voice_profile_samples AS target
             WHERE target.person_id = @targetPersonId
               AND target.model_id = source.model_id
               AND target.source_kind = source.source_kind
               AND target.source_cluster_id IS source.source_cluster_id
           )`
      ).run(input);
      db.prepare("UPDATE voice_profile_samples SET person_id = ? WHERE person_id = ?").run(
        input.targetPersonId,
        input.sourcePersonId
      );
      db.prepare(
        `UPDATE speaker_clusters
         SET person_id = ?, updated_at = ? WHERE person_id = ?`
      ).run(input.targetPersonId, createdAt, input.sourcePersonId);
      for (const [table, column] of [
        ["transcript_segments", "person_id"],
        ["todos", "owner_person_id"],
        ["memories", "person_id"],
      ]) {
        if (this._tableExists(table)) {
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
            input.targetPersonId,
            input.sourcePersonId
          );
        }
      }
      db.prepare("DELETE FROM people WHERE id = ?").run(input.sourcePersonId);
      for (const modelId of affectedModels) {
        this.statements.wakeResolvedSessionsForModel.run(modelId);
      }
      return target;
    });

    this._replaceEnrollmentSamples = db.transaction((values) => {
      this.statements.deleteEnrollmentProfiles.run(values.personId, values.modelId);
      for (const sample of values.samples) this.statements.insertProfile.run(sample);
      this.statements.upsertProfileAggregate.run(values.aggregate);
      this.statements.wakeResolvedSessionsForModel.run(values.modelId);
    });

    this._insertProfileAndWake = db.transaction((values) => {
      this.statements.insertProfile.run(values);
      this.statements.wakeResolvedSessionsForModel.run(values.modelId);
    });

    this._wakeSessionsForModels = db.transaction((modelIds) => {
      for (const modelId of modelIds) this.statements.wakeResolvedSessionsForModel.run(modelId);
    });

    this._importLegacyProfile = db.transaction((values) => {
      if (this.statements.getImportMarker.get(values.markerKey)) return false;
      this.statements.insertProfile.run(values.sample);
      this.statements.upsertProfileAggregate.run(values.aggregate);
      this.statements.insertImportMarker.run(values.markerKey, values.importedAt);
      this.statements.wakeResolvedSessionsForModel.run(values.sample.modelId);
      return true;
    });
  }

  _tableExists(table) {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    );
  }

  _requireCluster(clusterId) {
    const cluster = this.statements.getCluster.get(clusterId);
    if (!cluster) throw new Error("speaker cluster not found");
    return cluster;
  }

  _requirePerson(personId) {
    const person = this.statements.getPerson.get(personId);
    if (!person) throw new Error("person not found");
    return person;
  }

  _assertModelDimension(modelId, embedding) {
    let expectedDimension = null;
    for (const row of this.statements.listModelEmbeddings.all(modelId, modelId)) {
      const stored = decodeEmbedding(row.embedding, expectedDimension);
      expectedDimension ??= stored.length;
    }
    if (expectedDimension !== null && embedding.length !== expectedDimension) {
      throw new TypeError(
        `embedding dimension ${embedding.length} does not match ${expectedDimension} for model ${modelId}`
      );
    }
  }

  _mapCluster(row) {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      trackId: row.track_id,
      localLabel: row.local_label,
      modelId: row.model_id,
      embedding: row.embedding === null ? null : decodeEmbedding(row.embedding),
      speechMs: row.speech_ms,
      windowCount: row.window_count,
      qualityScore: row.quality_score,
      personId: row.person_id,
      linkState: row.link_state,
      matchScore: row.match_score,
      matchMargin: row.match_margin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      transcriptSegmentIds: this.statements.listClusterSegments
        .all(row.id)
        .map((segment) => segment.transcript_segment_id),
    };
  }

  _mapProfile(row) {
    return {
      id: row.id,
      personId: row.person_id,
      modelId: row.model_id,
      embedding: decodeEmbedding(row.embedding),
      sourceClusterId: row.source_cluster_id,
      sourceKind: row.source_kind,
      speechMs: row.speech_ms,
      windowCount: row.window_count,
      createdAt: row.created_at,
    };
  }

  _mapProfileAggregate(row) {
    if (!row) return null;
    return {
      personId: row.person_id,
      modelId: row.model_id,
      embedding: decodeEmbedding(row.embedding),
      acceptedSpeechMs: row.accepted_speech_ms,
      windowCount: row.window_count,
      selfConsistency: row.self_consistency,
      updatedAt: row.updated_at,
    };
  }

  _passesProfileSampleQuality(cluster) {
    return (
      cluster.embedding !== null &&
      cluster.quality_score !== null &&
      cluster.quality_score >= PROFILE_SAMPLE_QUALITY_GATE.minimumQualityScore &&
      cluster.speech_ms >= PROFILE_SAMPLE_QUALITY_GATE.minimumSpeechMs &&
      cluster.window_count >= PROFILE_SAMPLE_QUALITY_GATE.minimumWindows
    );
  }

  _syncConfirmedProfileSample(cluster, createdAt) {
    this.statements.deleteConfirmedClusterProfiles.run(cluster.id);
    if (!cluster.person_id || !this._passesProfileSampleQuality(cluster)) return;
    this.statements.insertProfileIfMissing.run({
      id: this.createId("voice_profile_sample"),
      personId: cluster.person_id,
      modelId: cluster.model_id,
      embedding: cluster.embedding,
      sourceClusterId: cluster.id,
      speechMs: cluster.speech_ms,
      windowCount: cluster.window_count,
      createdAt,
    });
  }

  createCluster(input) {
    if (!input || typeof input !== "object") throw new TypeError("cluster input is required");
    const embedding = input.embedding === null ? null : input.embedding;
    if (embedding !== null && embedding !== undefined && !(embedding instanceof Float32Array)) {
      throw new TypeError("embedding must be a Float32Array or null");
    }
    const modelId = assertText(input.modelId, "modelId");
    if (embedding) this._assertModelDimension(modelId, embedding);
    const createdAt = input.createdAt ?? this.now();
    assertNonNegativeInteger(createdAt, "createdAt");
    const values = {
      id:
        input.id === undefined ? this.createId("speaker_cluster") : assertId(input.id, "clusterId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      trackId:
        input.trackId === null || input.trackId === undefined
          ? null
          : assertId(input.trackId, "trackId"),
      localLabel: assertText(input.localLabel, "localLabel"),
      modelId,
      embedding: embedding ? encodeEmbedding(embedding) : null,
      speechMs: assertNonNegativeInteger(input.speechMs ?? 0, "speechMs"),
      windowCount: assertNonNegativeInteger(input.windowCount ?? 0, "windowCount"),
      qualityScore: assertOptionalScore(input.qualityScore, "qualityScore"),
      matchScore: assertOptionalScore(input.matchScore, "matchScore"),
      matchMargin: assertOptionalScore(input.matchMargin, "matchMargin"),
      createdAt,
      updatedAt: createdAt,
    };
    this.statements.insertCluster.run(values);
    return this.getCluster(values.id);
  }

  replaceClusterSegments(clusterId, transcriptSegmentIds) {
    const safeClusterId = assertId(clusterId, "clusterId");
    if (!Array.isArray(transcriptSegmentIds)) {
      throw new TypeError("transcriptSegmentIds must be an array");
    }
    const safeSegmentIds = [
      ...new Set(
        transcriptSegmentIds.map((segmentId) => assertId(segmentId, "transcriptSegmentId"))
      ),
    ];
    this._replaceClusterSegments(safeClusterId, safeSegmentIds);
    return this.getCluster(safeClusterId);
  }

  getCluster(clusterId) {
    return this._mapCluster(this.statements.getCluster.get(assertId(clusterId, "clusterId")));
  }

  listSessionClusters(sessionId) {
    return this.statements.listSessionClusters
      .all(assertId(sessionId, "sessionId"))
      .map((row) => this._mapCluster(row));
  }

  listProfiles(modelId) {
    const safeModelId = assertText(modelId, "modelId");
    let expectedDimension = null;
    return this.statements.listProfiles.all(safeModelId).map((row) => {
      const profile = this._mapProfile(row);
      expectedDimension ??= profile.embedding.length;
      if (profile.embedding.length !== expectedDimension) {
        throw new TypeError(`stored embedding dimension mismatch for model ${safeModelId}`);
      }
      return profile;
    });
  }

  addProfileSample(input) {
    if (!input || typeof input !== "object") throw new TypeError("profile sample is required");
    const modelId = assertText(input.modelId, "modelId");
    const personId = assertId(input.personId, "personId");
    const sourceKind = assertEnum(input.sourceKind, PROFILE_SOURCE_KINDS, "sourceKind");
    if (!(input.embedding instanceof Float32Array)) {
      throw new TypeError("embedding must be a non-empty Float32Array");
    }
    this._assertModelDimension(modelId, input.embedding);
    const encodedEmbedding = encodeEmbedding(input.embedding);
    const sourceClusterId =
      input.sourceClusterId === null || input.sourceClusterId === undefined
        ? null
        : assertId(input.sourceClusterId, "sourceClusterId");
    if (sourceKind === "user_confirmed" && sourceClusterId === null) {
      throw new TypeError("user-confirmed profile sample requires a source cluster");
    }
    let sourceCluster = null;
    if (sourceClusterId !== null) {
      sourceCluster = this._requireCluster(sourceClusterId);
      if (sourceCluster.model_id !== modelId) {
        throw new TypeError("profile sample model must match source cluster model");
      }
    }
    const speechMs = assertNonNegativeInteger(input.speechMs, "speechMs");
    const windowCount = assertNonNegativeInteger(input.windowCount, "windowCount");
    if (sourceKind === "user_confirmed") {
      if (sourceCluster.person_id !== personId || sourceCluster.link_state !== "confirmed") {
        throw new Error("user-confirmed profile sample requires the cluster confirmed person");
      }
      if (!this._passesProfileSampleQuality(sourceCluster)) {
        throw new Error("user-confirmed profile sample did not pass the quality gate");
      }
      if (!Buffer.from(sourceCluster.embedding).equals(encodedEmbedding)) {
        throw new Error("user-confirmed profile sample must match the cluster embedding");
      }
      if (speechMs !== sourceCluster.speech_ms || windowCount !== sourceCluster.window_count) {
        throw new Error("user-confirmed profile sample must match the cluster evidence counts");
      }
    }
    const values = {
      id:
        input.id === undefined
          ? this.createId("voice_profile_sample")
          : assertId(input.id, "profileSampleId"),
      personId,
      modelId,
      embedding: encodedEmbedding,
      sourceClusterId,
      sourceKind,
      speechMs,
      windowCount,
      createdAt: assertNonNegativeInteger(input.createdAt ?? this.now(), "createdAt"),
    };
    this._requirePerson(values.personId);
    this._insertProfileAndWake(values);
    return this._mapProfile(
      this.db.prepare("SELECT * FROM voice_profile_samples WHERE id = ?").get(values.id)
    );
  }

  getProfileAggregate(personId, modelId) {
    return this._mapProfileAggregate(
      this.statements.getProfileAggregate.get(
        assertId(personId, "personId"),
        assertText(modelId, "modelId")
      )
    );
  }

  replaceEnrollmentSamples(input) {
    if (!input || typeof input !== "object") throw new TypeError("enrollment profile is required");
    const personId = assertId(input.personId, "personId");
    const modelId = assertText(input.modelId, "modelId");
    this._requirePerson(personId);
    if (!Array.isArray(input.samples) || input.samples.length === 0) {
      throw new TypeError("enrollment samples must be a non-empty array");
    }
    if (!(input.centroid instanceof Float32Array)) {
      throw new TypeError("enrollment centroid must be a Float32Array");
    }
    const dimension = input.centroid.length;
    const encodedCentroid = encodeEmbedding(input.centroid);
    const acceptedSpeechMs = assertNonNegativeInteger(input.acceptedSpeechMs, "acceptedSpeechMs");
    const windowCount = assertNonNegativeInteger(input.windowCount, "windowCount");
    const selfConsistency = assertOptionalScore(input.selfConsistency, "selfConsistency");
    const updatedAt = assertNonNegativeInteger(input.updatedAt ?? this.now(), "updatedAt");
    const samples = input.samples.map((embedding, index) => {
      if (!(embedding instanceof Float32Array) || embedding.length !== dimension) {
        throw new TypeError("enrollment sample dimensions must match the centroid");
      }
      return {
        id: this.createId("voice_profile_sample"),
        personId,
        modelId,
        embedding: encodeEmbedding(embedding),
        sourceClusterId: null,
        sourceKind: "enrollment",
        speechMs: assertNonNegativeInteger(input.sampleSpeechMs?.[index] ?? 0, "sampleSpeechMs"),
        windowCount: 1,
        createdAt: updatedAt,
      };
    });
    this._assertModelDimension(modelId, input.centroid);
    this._replaceEnrollmentSamples({
      personId,
      modelId,
      samples,
      aggregate: {
        personId,
        modelId,
        embedding: encodedCentroid,
        acceptedSpeechMs,
        windowCount,
        selfConsistency,
        updatedAt,
      },
    });
    return this.getProfileAggregate(personId, modelId);
  }

  importLegacyProfile(input) {
    if (!input || typeof input !== "object") throw new TypeError("legacy profile is required");
    const markerKey = assertId(input.markerKey, "markerKey");
    if (this.statements.getImportMarker.get(markerKey)) return false;
    const personId = assertId(input.personId, "personId");
    const modelId = assertText(input.modelId, "modelId");
    this._requirePerson(personId);
    if (!(input.embedding instanceof Float32Array)) {
      throw new TypeError("legacy embedding must be a Float32Array");
    }
    const importedAt = assertNonNegativeInteger(input.importedAt ?? this.now(), "importedAt");
    const embedding = encodeEmbedding(input.embedding);
    return this._importLegacyProfile({
      markerKey,
      importedAt,
      sample: {
        id: this.createId("voice_profile_sample"),
        personId,
        modelId,
        embedding,
        sourceClusterId: null,
        sourceKind: "enrollment",
        speechMs: 0,
        windowCount: 0,
        createdAt: importedAt,
      },
      aggregate: {
        personId,
        modelId,
        embedding,
        acceptedSpeechMs: 0,
        windowCount: 0,
        selfConsistency: null,
        updatedAt: importedAt,
      },
    });
  }

  hasImportMarker(markerKey) {
    return Boolean(this.statements.getImportMarker.get(assertId(markerKey, "markerKey")));
  }

  confirmLink(input) {
    if (!input || typeof input !== "object") throw new TypeError("confirmation input is required");
    const safe = {
      clusterId: assertId(input.clusterId, "clusterId"),
      personId: assertId(input.personId, "personId"),
      scope: assertEnum(input.scope, SCOPES, "scope"),
      actor: assertEnum(input.actor, ACTORS, "actor"),
      matchScore: assertOptionalScore(input.matchScore, "matchScore"),
      matchMargin: assertOptionalScore(input.matchMargin, "matchMargin"),
    };
    this._confirmLink(safe);
    return this.getCluster(safe.clusterId);
  }

  rejectSuggestion(input) {
    if (!input || typeof input !== "object") throw new TypeError("rejection input is required");
    const safe = {
      clusterId: assertId(input.clusterId, "clusterId"),
      personId: assertId(input.personId, "personId"),
      scope: assertEnum(input.scope ?? "session", SCOPES, "scope"),
      actor: assertEnum(input.actor ?? "user", ACTORS, "actor"),
    };
    this._rejectSuggestion(safe);
    return this.getCluster(safe.clusterId);
  }

  applySystemResolution(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("system resolution input is required");
    }
    const state = assertEnum(input.state, RESOLUTION_STATES, "resolution state");
    const candidatePersonId =
      input.candidatePersonId === null || input.candidatePersonId === undefined
        ? null
        : assertId(input.candidatePersonId, "candidatePersonId");
    if (state !== "unknown" && candidatePersonId === null) {
      throw new TypeError("suggested and confirmed resolutions require a candidate person");
    }
    const evidenceRunId = assertId(input.evidenceRunId, "evidenceRunId");
    const clusterId = assertId(input.clusterId, "clusterId");
    const evidence = this.statements.getResolutionEvidence.get(evidenceRunId, clusterId);
    if (!evidence) throw new Error("identity resolution evidence was not found");
    const identity = {
      sessionId: evidence.session_id,
      diarizationRevision: assertRevision(input.diarizationRevision, "diarizationRevision"),
      profileRevision: assertRevision(input.profileRevision, "profileRevision"),
      policyId: assertText(input.policyId, "policyId"),
    };
    const runId = deterministicResolutionId(
      identity.sessionId,
      identity.diarizationRevision,
      identity.profileRevision,
      identity.policyId
    );
    return this.applySystemResolutions({
      id: runId,
      ...identity,
      evidenceRunIds: [evidenceRunId],
      results: [
        {
          evidenceRunId,
          clusterId,
          candidatePersonId,
          state,
          score: input.score,
          margin: input.margin,
          reason: input.reason,
        },
      ],
      at: input.at,
    })[0];
  }

  applySystemResolutions(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("system resolution batch is required");
    }
    if (!Array.isArray(input.evidenceRunIds) || input.evidenceRunIds.length === 0) {
      throw new TypeError("evidenceRunIds must be a non-empty array");
    }
    if (!Array.isArray(input.results)) throw new TypeError("resolution results must be an array");
    const safe = {
      id: assertId(input.id, "resolutionRunId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      diarizationRevision: assertRevision(input.diarizationRevision, "diarizationRevision"),
      profileRevision: assertRevision(input.profileRevision, "profileRevision"),
      policyId: assertText(input.policyId, "policyId"),
      evidenceRunIds: [...new Set(input.evidenceRunIds.map((id) => assertId(id, "evidenceRunId")))],
      results: input.results.map((result) => {
        const state = assertEnum(result?.state, RESOLUTION_STATES, "resolution state");
        const candidatePersonId =
          result.candidatePersonId === null || result.candidatePersonId === undefined
            ? null
            : assertId(result.candidatePersonId, "candidatePersonId");
        if (state !== "unknown" && candidatePersonId === null) {
          throw new TypeError("suggested and confirmed resolutions require a candidate person");
        }
        return {
          evidenceRunId: assertId(result.evidenceRunId, "evidenceRunId"),
          clusterId: assertId(result.clusterId, "clusterId"),
          candidatePersonId,
          state,
          score: assertResolutionScore(result.score, "score"),
          margin: assertResolutionScore(result.margin, "margin", {
            minimum: 0,
            maximum: 2,
          }),
          reason: assertText(result.reason, "reason"),
        };
      }),
      at: assertNonNegativeInteger(input.at ?? this.now(), "at"),
    };
    return this._applySystemResolutions.immediate(safe).map(mapResolution);
  }

  listRejectedPersonIds(clusterId, revision) {
    if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
      throw new TypeError("resolution revision is required");
    }
    return this.statements.listRejectedPersonRefs
      .all({
        clusterId: assertId(clusterId, "clusterId"),
        diarizationRevision: assertRevision(revision.diarizationRevision, "diarizationRevision"),
        profileRevision: assertRevision(revision.profileRevision, "profileRevision"),
        policyId: assertText(revision.policyId, "policyId"),
      })
      .map((row) => row.candidate_person_ref);
  }

  listResolutionHistory(clusterId) {
    return this.statements.listResolutionHistory
      .all(assertId(clusterId, "clusterId"))
      .map(mapResolution);
  }

  wakeSessionsForModels(modelIds) {
    if (!Array.isArray(modelIds)) throw new TypeError("modelIds must be an array");
    const safeModelIds = [
      ...new Set(modelIds.map((modelId) => assertText(modelId, "modelId"))),
    ].sort();
    this._wakeSessionsForModels(safeModelIds);
    return safeModelIds.length;
  }

  undoLastCorrection(clusterId) {
    const safeClusterId = assertId(clusterId, "clusterId");
    this._undoLastCorrection(safeClusterId);
    return this.getCluster(safeClusterId);
  }

  mergePeople(input) {
    if (!input || typeof input !== "object") throw new TypeError("merge input is required");
    const safe = {
      sourcePersonId: assertId(input.sourcePersonId, "sourcePersonId"),
      targetPersonId: assertId(input.targetPersonId, "targetPersonId"),
      actor: assertEnum(input.actor ?? "user", ACTORS, "actor"),
    };
    if (safe.sourcePersonId === safe.targetPersonId) {
      throw new TypeError("source and target people must be different");
    }
    return this._mergePeople(safe);
  }

  listCorrections(clusterId) {
    return this.statements.listCorrections.all(assertId(clusterId, "clusterId")).map(mapCorrection);
  }
}

module.exports = SpeakerIdentityRepository;
module.exports.PROFILE_SAMPLE_QUALITY_GATE = PROFILE_SAMPLE_QUALITY_GATE;
module.exports.decodeEmbedding = decodeEmbedding;
module.exports.encodeEmbedding = encodeEmbedding;
