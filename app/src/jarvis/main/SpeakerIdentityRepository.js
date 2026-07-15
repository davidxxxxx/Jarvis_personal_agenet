const crypto = require("node:crypto");

const PROFILE_SAMPLE_QUALITY_GATE = Object.freeze({
  minimumSpeechMs: 12_000,
  minimumWindows: 3,
  minimumQualityScore: 0.78,
});

const SCOPES = new Set(["session", "persistent"]);
const ACTORS = new Set(["user", "system"]);
const PROFILE_SOURCE_KINDS = new Set(["enrollment", "user_confirmed"]);

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
    createdAt: row.created_at,
    undoneAt: row.undone_at,
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
          scope, actor, correction_kind, created_at
        ) VALUES (
          @id, @clusterId, @previousPersonId, @nextPersonId,
          @previousPersonRef, @nextPersonRef, @previousState, @nextState,
          @scope, @actor, @correctionKind, @createdAt
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
      this.statements.insertCorrection.run({
        id: this.createId("speaker_correction"),
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
      }
    });

    this._rejectSuggestion = db.transaction((input) => {
      const cluster = this._requireCluster(input.clusterId);
      this._requirePerson(input.personId);
      const createdAt = this.now();
      this.statements.insertCorrection.run({
        id: this.createId("speaker_correction"),
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
      }
      this.statements.markCorrectionUndone.run(undoneAt, correction.id);
    });

    this._mergePeople = db.transaction((input) => {
      const source = this._requirePerson(input.sourcePersonId);
      if (source.is_self !== 0) throw new Error("self person cannot be merged into another person");
      const target = this._requirePerson(input.targetPersonId);
      const createdAt = this.now();
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
      return target;
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
    this.statements.insertProfile.run(values);
    return this._mapProfile(
      this.db.prepare("SELECT * FROM voice_profile_samples WHERE id = ?").get(values.id)
    );
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
