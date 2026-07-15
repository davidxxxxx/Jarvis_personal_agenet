const crypto = require("node:crypto");
const { AnalysisSchemaError, validateCandidateAnalysis } = require("./JarvisAnalysisSchema");

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const CANONICAL_INPUT_VERSION = "jarvis-analysis-input-canonical-v2";
const PREPARE_TOKEN_VERSION = "jarvis-analysis-prepare-v1";
const LEGACY_IMPORTER_VERSION = "jarvis-legacy-analysis-v1";
const MAX_CLOUD_PAYLOAD_BYTES = 96 * 1024;
const MAX_ANALYSIS_CANDIDATE_BYTES = 512 * 1024;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEqual(left, right) {
  const validLeft = typeof left === "string" && HASH_PATTERN.test(left);
  const validRight = typeof right === "string" && HASH_PATTERN.test(right);
  const leftBytes = validLeft ? Buffer.from(left, "hex") : Buffer.alloc(32);
  const rightBytes = validRight ? Buffer.from(right, "hex") : Buffer.alloc(32);
  return crypto.timingSafeEqual(leftBytes, rightBytes) && validLeft && validRight;
}

function assertHash(value, name) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function assertText(value, name, maxLength = 128) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty`);
  if (Array.from(trimmed).length > maxLength) throw new RangeError(`${name} is too long`);
  return trimmed;
}

function assertId(value, name) {
  return assertText(value, name, 512);
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertJsonObject(value, name) {
  const seen = new Set();
  const visit = (node) => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new TypeError(`${name} must contain finite JSON values`);
      return;
    }
    if (typeof node !== "object") throw new TypeError(`${name} must contain JSON values`);
    if (seen.has(node)) throw new TypeError(`${name} must not contain cycles`);
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${name} must contain plain objects`);
      }
      for (const item of Object.values(node)) visit(item);
    }
    seen.delete(node);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  visit(value);
  return value;
}

function assertLocalDate(value) {
  if (typeof value !== "string") throw new TypeError("localDate must be a string");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("localDate must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new TypeError("localDate must be a real calendar date");
  }
  return value;
}

function assertTimezone(value) {
  const timezone = assertText(value, "timezone", 256);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("timezone must be a supported IANA timezone");
  }
  return timezone;
}

function normalizedKey(value) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseLegacyArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function legacyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function legacyConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function legacyDueText(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function validateCandidate(candidate, { allowedSegmentIds, allowedOwnerLabels }) {
  try {
    return validateCandidateAnalysis(candidate, { allowedSegmentIds, allowedOwnerLabels });
  } catch (error) {
    if (!(error instanceof AnalysisSchemaError)) throw error;
    if (error.issueCode === "schema.evidence_empty") throw codedError("MEMORY_EVIDENCE_REQUIRED");
    if (error.issueCode === "schema.evidence_out_of_scope") {
      throw codedError("MEMORY_EVIDENCE_OUT_OF_SCOPE");
    }
    if (error.issueCode === "schema.owner_out_of_scope") {
      throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");
    }
    throw codedError("MEMORY_CANDIDATE_INVALID");
  }
}

class MemoryRepository {
  constructor(db, { createId, now, validateRedactedCloudPayload } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("database must be a live better-sqlite3 connection");
    }
    if (db.open === false) throw new TypeError("database must be open");
    if (typeof createId !== "function") throw new TypeError("createId must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof validateRedactedCloudPayload !== "function") {
      throw new TypeError("validateRedactedCloudPayload must be a function");
    }
    this.db = db;
    this.createId = createId;
    this.now = now;
    this.validateRedactedCloudPayload = validateRedactedCloudPayload;
  }

  _normalizeInputRequest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("analysis input is required");
    }
    const sessionId = assertId(input.sessionId, "sessionId");
    const transcriptRevision = assertHash(input.transcriptRevision, "transcriptRevision");
    const identityRevision = assertHash(input.identityRevision, "identityRevision");
    const promptVersion = assertText(input.promptVersion, "promptVersion");
    if (!Array.isArray(input.segmentIds)) throw new TypeError("segmentIds must be an array");
    if (input.segmentIds.length === 0) throw codedError("MEMORY_INPUT_EMPTY");
    const segmentIds = input.segmentIds.map((id) => assertId(id, "segmentId"));
    if (new Set(segmentIds).size !== segmentIds.length) {
      throw codedError("MEMORY_INPUT_DUPLICATE_SEGMENT");
    }
    return { sessionId, transcriptRevision, identityRevision, promptVersion, segmentIds };
  }

  _deriveLiveInput(normalized) {
    const { sessionId, transcriptRevision, identityRevision, promptVersion, segmentIds } =
      normalized;
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
      throw codedError("MEMORY_SESSION_NOT_FOUND");
    }

    const labelsBySubject = new Map();
    const bindings = [];
    const deviceLabels = new Set();
    let nextOtherLabel = 1;
    const selectedSegments = segmentIds.map((segmentId) =>
      this.db
        .prepare(
          `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                  segment.version, segment.text, segment.person_id, segment.result_kind,
                  segment.is_stable, segment.superseded_by, segment.duplicate_of,
                  track.device_label
           FROM transcript_segments AS segment
           LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
           WHERE segment.id = ?`
        )
        .get(segmentId)
    );
    selectedSegments.sort(
      (left, right) =>
        (left?.started_at ?? Number.MAX_SAFE_INTEGER) -
          (right?.started_at ?? Number.MAX_SAFE_INTEGER) ||
        (left?.ended_at ?? Number.MAX_SAFE_INTEGER) -
          (right?.ended_at ?? Number.MAX_SAFE_INTEGER) ||
        String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
    );
    const segments = selectedSegments.map((segment, ordinal) => {
      if (
        !segment ||
        segment.session_id !== sessionId ||
        segment.result_kind !== "final" ||
        segment.is_stable !== 1 ||
        segment.superseded_by !== null ||
        segment.duplicate_of !== null ||
        typeof segment.text !== "string" ||
        segment.text.length === 0 ||
        !Number.isSafeInteger(segment.started_at) ||
        !Number.isSafeInteger(segment.ended_at) ||
        segment.started_at < 0 ||
        segment.ended_at <= segment.started_at
      ) {
        throw codedError("MEMORY_INPUT_STALE");
      }
      if (segment.device_label?.trim()) deviceLabels.add(segment.device_label);

      let subject;
      if (segment.person_id) {
        const person = this.db
          .prepare("SELECT id, display_name, is_self FROM people WHERE id = ?")
          .get(segment.person_id);
        if (!person?.display_name?.trim()) throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");
        if (person.is_self !== 1) {
          const confirmed = this.db
            .prepare(
              `SELECT 1 FROM speaker_clusters
               WHERE session_id = ? AND person_id = ? AND link_state = 'confirmed' LIMIT 1`
            )
            .get(sessionId, person.id);
          if (!confirmed) throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");
        }
        subject = {
          key: `person:${person.id}`,
          subjectKind: "person",
          subjectId: person.id,
          subjectDisplayNameSnapshot: person.display_name,
          isSelf: person.is_self === 1,
        };
      } else {
        const cluster = this.db
          .prepare(
            `SELECT cluster.id, cluster.local_label
             FROM speaker_cluster_segments AS link
             JOIN speaker_clusters AS cluster ON cluster.id = link.cluster_id
             WHERE link.transcript_segment_id = ? AND cluster.session_id = ?
             ORDER BY cluster.id LIMIT 1`
          )
          .get(segment.id, sessionId);
        if (!cluster?.local_label?.trim()) throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");
        subject = {
          key: `speaker_cluster:${cluster.id}`,
          subjectKind: "speaker_cluster",
          subjectId: cluster.id,
          subjectDisplayNameSnapshot: cluster.local_label,
          isSelf: false,
        };
      }

      let label = labelsBySubject.get(subject.key);
      if (!label) {
        label = subject.isSelf ? "SELF" : `P${nextOtherLabel++}`;
        labelsBySubject.set(subject.key, label);
        bindings.push({
          label,
          subjectKind: subject.subjectKind,
          subjectId: subject.subjectId,
          subjectDisplayNameSnapshot: subject.subjectDisplayNameSnapshot,
        });
      }
      return {
        ordinal,
        segmentId: segment.id,
        segmentVersion: segment.version,
        textHash: sha256(segment.text),
        textSnapshot: segment.text,
        resultKind: segment.result_kind,
        isStable: segment.is_stable === 1,
        isCurrent: segment.superseded_by === null,
        supersededBy: segment.superseded_by,
        duplicateOf: segment.duplicate_of,
        startedAt: segment.started_at,
        endedAt: segment.ended_at,
        speakerBindingLabel: label,
      };
    });

    bindings.sort((left, right) => {
      if (left.label === "SELF") return -1;
      if (right.label === "SELF") return 1;
      return Number(left.label.slice(1)) - Number(right.label.slice(1));
    });
    const otherPeople = this.db
      .prepare("SELECT display_name FROM people WHERE length(trim(display_name)) > 0 ORDER BY id")
      .all()
      .map((row) => row.display_name)
      .filter((name) => !bindings.some((binding) => binding.subjectDisplayNameSnapshot === name));
    return {
      sessionId,
      transcriptRevision,
      identityRevision,
      promptVersion,
      segmentIds: [...segmentIds],
      segments,
      speakerBindings: bindings,
      redactionTerms: {
        participants: bindings.map((binding) => ({
          label: binding.label,
          names: [binding.subjectDisplayNameSnapshot],
        })),
        otherPeople,
        deviceLabels: [...deviceLabels].sort(),
      },
    };
  }

  prepareAnalysisInput(input) {
    const normalized = this._normalizeInputRequest(input);
    const read = this.db.transaction(() => this._deriveLiveInput(normalized));
    const prepared = read.deferred();
    prepared.prepareToken = this._prepareToken(prepared);
    delete prepared.participantIds;
    return prepared;
  }

  _prepareTokenTuple(prepared) {
    return {
      schemaVersion: PREPARE_TOKEN_VERSION,
      sessionId: prepared.sessionId,
      transcriptRevision: prepared.transcriptRevision,
      identityRevision: prepared.identityRevision,
      promptVersion: prepared.promptVersion,
      speakerBindings: prepared.speakerBindings,
      segments: prepared.segments.map((segment) => ({
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
        segmentVersion: segment.segmentVersion,
        textHash: segment.textHash,
        resultKind: segment.resultKind,
        isStable: segment.isStable,
        isCurrent: segment.isCurrent,
        supersededBy: segment.supersededBy,
        duplicateOf: segment.duplicateOf,
        speakerBindingLabel: segment.speakerBindingLabel,
      })),
    };
  }

  _prepareToken(prepared) {
    return sha256(canonicalJson(this._prepareTokenTuple(prepared)));
  }

  _validateCloudPayload(cloudPayloadJson, inputContractVersion, prepared) {
    if (typeof cloudPayloadJson !== "string") throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    const bytes = Buffer.byteLength(cloudPayloadJson, "utf8");
    if (bytes < 2 || bytes > MAX_CLOUD_PAYLOAD_BYTES) {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    let payload;
    try {
      payload = JSON.parse(cloudPayloadJson);
    } catch {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    if (
      !hasExactKeys(payload, ["inputVersion", "segments", "omittedRanges"]) ||
      payload.inputVersion !== inputContractVersion ||
      !Array.isArray(payload.segments) ||
      payload.segments.length === 0 ||
      !Array.isArray(payload.omittedRanges)
    ) {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    const manifestById = new Map(prepared.segments.map((segment) => [segment.segmentId, segment]));
    let lastOrdinal = -1;
    const selected = new Set();
    for (const segment of payload.segments) {
      if (
        !hasExactKeys(segment, ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"]) ||
        typeof segment.text !== "string" ||
        segment.text.length === 0
      ) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
      const manifest = manifestById.get(segment.segmentId);
      if (
        !manifest ||
        selected.has(segment.segmentId) ||
        manifest.ordinal <= lastOrdinal ||
        segment.startedAt !== manifest.startedAt ||
        segment.endedAt !== manifest.endedAt ||
        segment.speakerLabel !== manifest.speakerBindingLabel
      ) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
      selected.add(segment.segmentId);
      lastOrdinal = manifest.ordinal;
    }
    const minStart = Math.min(...prepared.segments.map((segment) => segment.startedAt));
    const maxEnd = Math.max(...prepared.segments.map((segment) => segment.endedAt));
    for (const range of payload.omittedRanges) {
      if (
        !hasExactKeys(range, ["startedAt", "endedAt"]) ||
        !Number.isSafeInteger(range.startedAt) ||
        !Number.isSafeInteger(range.endedAt) ||
        range.startedAt < minStart ||
        range.endedAt > maxEnd ||
        range.endedAt <= range.startedAt
      ) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
    }
    const canonicalOmittedRanges = prepared.segments
      .filter((segment) => !selected.has(segment.segmentId))
      .map((segment) => ({ startedAt: segment.startedAt, endedAt: segment.endedAt }))
      .sort((left, right) => left.startedAt - right.startedAt || left.endedAt - right.endedAt)
      .reduce((ranges, range) => {
        const previous = ranges.at(-1);
        if (previous && range.startedAt <= previous.endedAt) {
          previous.endedAt = Math.max(previous.endedAt, range.endedAt);
        } else {
          ranges.push({ ...range });
        }
        return ranges;
      }, []);
    if (
      payload.omittedRanges.length !== canonicalOmittedRanges.length ||
      payload.omittedRanges.some(
        (range, index) =>
          range.startedAt !== canonicalOmittedRanges[index].startedAt ||
          range.endedAt !== canonicalOmittedRanges[index].endedAt
      )
    ) {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    for (const manifest of prepared.segments.filter((segment) => selected.has(segment.segmentId))) {
      const overlappingOmission = canonicalOmittedRanges.some(
        (range) => range.startedAt < manifest.endedAt && manifest.startedAt < range.endedAt
      );
      if (overlappingOmission) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
    }
    const selectedOwnerLabels = prepared.speakerBindings
      .map((binding) => binding.label)
      .filter((label) => payload.segments.some((segment) => segment.speakerLabel === label));
    return {
      payload,
      bytes,
      sha256: sha256(cloudPayloadJson),
      selectedSegmentIds: payload.segments.map((segment) => segment.segmentId),
      selectedOwnerLabels,
    };
  }

  _canonicalInputTuple(prepared, persisted) {
    return {
      schemaVersion: CANONICAL_INPUT_VERSION,
      sessionId: prepared.sessionId,
      transcriptRevision: prepared.transcriptRevision,
      identityRevision: prepared.identityRevision,
      promptVersion: prepared.promptVersion,
      inputContractVersion: persisted.inputContractVersion,
      redactionVersion: persisted.redactionVersion,
      cloudPayloadBytes: persisted.cloudPayloadBytes,
      cloudPayloadSha256: persisted.cloudPayloadSha256,
      speakerBindings: prepared.speakerBindings,
      segments: prepared.segments.map((segment) => ({
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
        segmentVersion: segment.segmentVersion,
        textHash: segment.textHash,
        speakerBindingLabel: segment.speakerBindingLabel,
      })),
    };
  }

  _loadStoredAnalysisInput(analysisInputId) {
    const row = this.db.prepare("SELECT * FROM analysis_inputs WHERE id = ?").get(analysisInputId);
    if (!row) return null;
    const segments = this.db
      .prepare(
        `SELECT ordinal, segment_id, segment_version, text_hash, text_snapshot,
                speaker_binding_label
         FROM analysis_input_segments WHERE analysis_input_id = ? ORDER BY ordinal`
      )
      .all(analysisInputId)
      .map((segment) => ({
        ordinal: segment.ordinal,
        segmentId: segment.segment_id,
        segmentVersion: segment.segment_version,
        textHash: segment.text_hash,
        textSnapshot: segment.text_snapshot,
        speakerBindingLabel: segment.speaker_binding_label,
      }));
    const bindings = this.db
      .prepare(
        `SELECT label, subject_kind, subject_id, subject_display_name_snapshot
         FROM analysis_input_speaker_bindings WHERE analysis_input_id = ?
         ORDER BY CASE label WHEN 'SELF' THEN 0 ELSE CAST(substr(label, 2) AS INTEGER) END`
      )
      .all(analysisInputId)
      .map((binding) => ({
        label: binding.label,
        subjectKind: binding.subject_kind,
        subjectId: binding.subject_id,
        subjectDisplayNameSnapshot: binding.subject_display_name_snapshot,
      }));
    if (segments.length === 0 || bindings.length === 0) {
      throw codedError("MEMORY_INPUT_CORRUPT");
    }
    const liveSegments = segments.map((segment) => {
      const live = this.db
        .prepare("SELECT started_at, ended_at FROM transcript_segments WHERE id = ?")
        .get(segment.segmentId);
      if (!live) throw codedError("MEMORY_INPUT_CORRUPT");
      return { ...segment, startedAt: live.started_at, endedAt: live.ended_at };
    });
    const prepared = {
      sessionId: row.session_id,
      transcriptRevision: row.transcript_revision,
      identityRevision: row.identity_revision,
      promptVersion: row.prompt_version,
      segments: liveSegments,
      speakerBindings: bindings,
    };
    const payload = this._validateCloudPayload(
      row.cloud_payload_json,
      row.input_contract_version,
      prepared
    );
    const tuple = this._canonicalInputTuple(prepared, {
      inputContractVersion: row.input_contract_version,
      redactionVersion: row.redaction_version,
      cloudPayloadBytes: payload.bytes,
      cloudPayloadSha256: payload.sha256,
    });
    const rebuiltInputHash = sha256(canonicalJson(tuple));
    if (
      payload.bytes !== row.cloud_payload_bytes ||
      !safeHashEqual(payload.sha256, row.cloud_payload_sha256) ||
      !safeHashEqual(rebuiltInputHash, row.input_hash)
    ) {
      throw codedError("MEMORY_INPUT_CORRUPT");
    }
    return { row, prepared, payload, tuple };
  }

  createAnalysisInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("analysis input is required");
    }
    const normalized = this._normalizeInputRequest(input);
    const prepareToken = assertHash(input.prepareToken, "prepareToken");
    if (input.inputContractVersion !== INPUT_CONTRACT_VERSION) {
      throw codedError("MEMORY_INPUT_CONTRACT_UNSUPPORTED");
    }
    if (input.redactionVersion !== REDACTION_VERSION) {
      throw codedError("MEMORY_REDACTION_VERSION_UNSUPPORTED");
    }
    const transaction = this.db.transaction(() => {
      const prepared = this._deriveLiveInput(normalized);
      const rebuiltPrepareToken = this._prepareToken(prepared);
      if (!safeHashEqual(prepareToken, rebuiltPrepareToken)) {
        throw codedError("MEMORY_PREPARE_STALE");
      }
      prepared.prepareToken = rebuiltPrepareToken;
      const payload = this._validateCloudPayload(
        input.cloudPayloadJson,
        input.inputContractVersion,
        prepared
      );
      let redactionVerified = false;
      try {
        redactionVerified =
          this.validateRedactedCloudPayload({
            cloudPayload: JSON.parse(JSON.stringify(payload.payload)),
            preparedSnapshot: JSON.parse(JSON.stringify(prepared)),
          }) === true;
      } catch {
        redactionVerified = false;
      }
      if (!redactionVerified) throw codedError("MEMORY_REDACTION_UNVERIFIED");
      const tuple = this._canonicalInputTuple(prepared, {
        inputContractVersion: input.inputContractVersion,
        redactionVersion: input.redactionVersion,
        cloudPayloadBytes: payload.bytes,
        cloudPayloadSha256: payload.sha256,
      });
      const inputHash = sha256(canonicalJson(tuple));
      const existing = this.db
        .prepare("SELECT id FROM analysis_inputs WHERE input_hash = ?")
        .get(inputHash);
      if (existing) {
        const stored = this._loadStoredAnalysisInput(existing.id);
        const storedTupleHash = sha256(canonicalJson(stored.tuple));
        if (
          !safeHashEqual(stored.row.input_hash, inputHash) ||
          !safeHashEqual(storedTupleHash, inputHash)
        ) {
          throw codedError("MEMORY_INPUT_CORRUPT");
        }
        return {
          status: "existing",
          candidateState: stored.row.candidate_hash === null ? "pending" : "applied",
          analysisInputId: existing.id,
          inputHash,
        };
      }

      const analysisInputId = assertId(this.createId("analysis_input"), "analysisInputId");
      const createdAt = assertTimestamp(this.now(), "createdAt");
      this.db
        .prepare(
          `INSERT INTO analysis_inputs (
             id, session_id, transcript_revision, identity_revision, prompt_version, input_hash,
             input_contract_version, redaction_version, cloud_payload_json,
             cloud_payload_bytes, cloud_payload_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          analysisInputId,
          prepared.sessionId,
          prepared.transcriptRevision,
          prepared.identityRevision,
          prepared.promptVersion,
          inputHash,
          input.inputContractVersion,
          input.redactionVersion,
          input.cloudPayloadJson,
          payload.bytes,
          payload.sha256,
          createdAt
        );
      const insertBinding = this.db.prepare(
        `INSERT INTO analysis_input_speaker_bindings (
           analysis_input_id, label, subject_kind, subject_id, subject_display_name_snapshot
         ) VALUES (?, ?, ?, ?, ?)`
      );
      for (const binding of prepared.speakerBindings) {
        insertBinding.run(
          analysisInputId,
          binding.label,
          binding.subjectKind,
          binding.subjectId,
          binding.subjectDisplayNameSnapshot
        );
      }
      const insertSegment = this.db.prepare(
        `INSERT INTO analysis_input_segments (
           analysis_input_id, ordinal, segment_id, segment_version, text_hash,
           text_snapshot, speaker_binding_label
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const segment of prepared.segments) {
        insertSegment.run(
          analysisInputId,
          segment.ordinal,
          segment.segmentId,
          segment.segmentVersion,
          segment.textHash,
          segment.textSnapshot,
          segment.speakerBindingLabel
        );
      }
      return {
        status: "created",
        candidateState: "pending",
        analysisInputId,
        inputHash,
      };
    });
    return transaction.immediate();
  }

  getAnalysisInputForCloud(analysisInputId) {
    const id = assertId(analysisInputId, "analysisInputId");
    const read = this.db.transaction(() => {
      const stored = this._loadStoredAnalysisInput(id);
      if (!stored) return null;
      return {
        inputHash: stored.row.input_hash,
        cloudPayloadJson: stored.row.cloud_payload_json,
        allowedSegmentIds: [...stored.payload.selectedSegmentIds],
        allowedOwnerLabels: [...stored.payload.selectedOwnerLabels],
      };
    });
    return read.deferred();
  }

  _mapAnalysisDesiredHead(row) {
    if (!row) return null;
    let vector;
    try {
      vector = JSON.parse(row.desired_vector_json);
    } catch {
      throw codedError("MEMORY_DESIRED_HEAD_CORRUPT");
    }
    const expectedKeys = [
      "analysisInputId",
      "analysisInputHash",
      "transcriptRevision",
      "identityRevision",
      "promptVersion",
      "responseSchemaVersion",
      "pseudonymBindingRevision",
      "modelVersion",
      "cloudPayloadHash",
      "segments",
    ];
    const validSegments =
      Array.isArray(vector?.segments) &&
      vector.segments.length > 0 &&
      vector.segments.every((segment) =>
        hasExactKeys(segment, [
          "ordinal",
          "segmentId",
          "segmentVersion",
          "textHash",
          "subjectRevision",
        ])
      );
    if (
      !hasExactKeys(vector, expectedKeys) ||
      !validSegments ||
      vector.analysisInputId !== row.analysis_input_id ||
      !safeHashEqual(vector.analysisInputHash, row.analysis_input_hash) ||
      !safeHashEqual(sha256(canonicalJson(vector)), row.desired_vector_hash)
    ) {
      throw codedError("MEMORY_DESIRED_HEAD_CORRUPT");
    }
    return {
      ...vector,
      desiredVectorHash: row.desired_vector_hash,
      headRevision: row.head_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAnalysisDesiredHead(sessionId) {
    const id = assertId(sessionId, "sessionId");
    const read = this.db.transaction(() =>
      this._mapAnalysisDesiredHead(
        this.db.prepare("SELECT * FROM analysis_desired_heads WHERE session_id = ?").get(id)
      )
    );
    return read.deferred();
  }

  setAnalysisDesiredHead(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("analysis desired head is required");
    }
    const sessionId = assertId(input.sessionId, "sessionId");
    const analysisInputId = assertId(input.analysisInputId, "analysisInputId");
    const responseSchemaVersion = assertText(input.responseSchemaVersion, "responseSchemaVersion");
    const pseudonymBindingRevision = assertTimestamp(
      input.pseudonymBindingRevision,
      "pseudonymBindingRevision"
    );
    const modelVersion = assertText(input.modelVersion, "modelVersion");
    if (!Array.isArray(input.segmentSubjectRevisions)) {
      throw new TypeError("segmentSubjectRevisions must be an array");
    }

    const transaction = this.db.transaction(() => {
      const stored = this._loadStoredAnalysisInput(analysisInputId);
      if (!stored) throw codedError("MEMORY_INPUT_NOT_FOUND");
      if (stored.row.session_id !== sessionId) throw codedError("MEMORY_INPUT_MISMATCH");
      if (input.segmentSubjectRevisions.length !== stored.prepared.segments.length) {
        throw new TypeError("segmentSubjectRevisions must match the ordered input segments");
      }
      const subjectRevisionByOrdinal = input.segmentSubjectRevisions.map((revision, ordinal) => {
        if (!hasExactKeys(revision, ["segmentId", "subjectRevision"])) {
          throw new TypeError("segmentSubjectRevisions entries must have exact keys");
        }
        const segmentId = assertId(revision.segmentId, "segmentSubjectRevisions.segmentId");
        const subjectRevision = assertTimestamp(
          revision.subjectRevision,
          "segmentSubjectRevisions.subjectRevision"
        );
        if (segmentId !== stored.prepared.segments[ordinal].segmentId) {
          throw new TypeError("segmentSubjectRevisions must match the ordered input segments");
        }
        return subjectRevision;
      });
      const vector = {
        analysisInputId,
        analysisInputHash: stored.row.input_hash,
        transcriptRevision: stored.row.transcript_revision,
        identityRevision: stored.row.identity_revision,
        promptVersion: stored.row.prompt_version,
        responseSchemaVersion,
        pseudonymBindingRevision,
        modelVersion,
        cloudPayloadHash: stored.row.cloud_payload_sha256,
        segments: stored.prepared.segments.map((segment, ordinal) => ({
          ordinal: segment.ordinal,
          segmentId: segment.segmentId,
          segmentVersion: segment.segmentVersion,
          textHash: segment.textHash,
          subjectRevision: subjectRevisionByOrdinal[ordinal],
        })),
      };
      const desiredVectorJson = canonicalJson(vector);
      const desiredVectorHash = sha256(desiredVectorJson);
      const existing = this.db
        .prepare("SELECT * FROM analysis_desired_heads WHERE session_id = ?")
        .get(sessionId);
      if (existing && safeHashEqual(existing.desired_vector_hash, desiredVectorHash)) {
        return this._mapAnalysisDesiredHead(existing);
      }
      const updatedAt = assertTimestamp(this.now(), "updatedAt");
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO analysis_desired_heads (
               session_id, analysis_input_id, analysis_input_hash, desired_vector_json,
               desired_vector_hash, head_revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
          )
          .run(
            sessionId,
            analysisInputId,
            stored.row.input_hash,
            desiredVectorJson,
            desiredVectorHash,
            updatedAt,
            updatedAt
          );
      } else {
        this.db
          .prepare(
            `UPDATE analysis_desired_heads
             SET analysis_input_id = ?, analysis_input_hash = ?, desired_vector_json = ?,
                 desired_vector_hash = ?, head_revision = head_revision + 1, updated_at = ?
             WHERE session_id = ?`
          )
          .run(
            analysisInputId,
            stored.row.input_hash,
            desiredVectorJson,
            desiredVectorHash,
            updatedAt,
            sessionId
          );
      }
      return this._mapAnalysisDesiredHead(
        this.db.prepare("SELECT * FROM analysis_desired_heads WHERE session_id = ?").get(sessionId)
      );
    });
    return transaction.immediate();
  }

  persistValidatedAnalysisCandidate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("validated analysis candidate is required");
    }
    const jobId = assertId(input.jobId, "jobId");
    const analysisInputId = assertId(input.analysisInputId, "analysisInputId");
    const budgetAttemptId = assertId(input.budgetAttemptId, "budgetAttemptId");
    assertJsonObject(input.candidate, "candidate");

    const transaction = this.db.transaction(() => {
      const stored = this._loadStoredAnalysisInput(analysisInputId);
      if (!stored) throw codedError("MEMORY_INPUT_NOT_FOUND");
      validateCandidate(input.candidate, {
        allowedSegmentIds: new Set(stored.payload.selectedSegmentIds),
        allowedOwnerLabels: new Set(stored.payload.selectedOwnerLabels),
      });
      const candidateJson = canonicalJson(input.candidate);
      const candidateBytes = Buffer.byteLength(candidateJson, "utf8");
      if (candidateBytes > MAX_ANALYSIS_CANDIDATE_BYTES) {
        throw codedError("MEMORY_CANDIDATE_TOO_LARGE");
      }
      const candidateHash = sha256(candidateJson);
      const job = this.db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(jobId);
      if (
        !job ||
        job.job_type !== "analyze_session" ||
        job.lane !== "cloud" ||
        job.analysis_input_id !== analysisInputId ||
        !safeHashEqual(job.input_hash, stored.row.input_hash) ||
        typeof job.desired_head_hash !== "string" ||
        !HASH_PATTERN.test(job.desired_head_hash)
      ) {
        throw codedError("MEMORY_CANDIDATE_JOB_MISMATCH");
      }
      const attempt = this.db
        .prepare("SELECT job_id, state FROM analysis_budget_attempts WHERE request_id = ?")
        .get(budgetAttemptId);
      if (!attempt || attempt.job_id !== jobId || attempt.state !== "reconciled") {
        throw codedError("MEMORY_CANDIDATE_BUDGET_UNRECONCILED");
      }
      const currentHead = this.db
        .prepare("SELECT * FROM analysis_desired_heads WHERE session_id = ?")
        .get(stored.row.session_id);
      const mappedCurrentHead = this._mapAnalysisDesiredHead(currentHead);
      if (
        mappedCurrentHead &&
        safeHashEqual(mappedCurrentHead.desiredVectorHash, job.desired_head_hash) &&
        mappedCurrentHead.responseSchemaVersion !== input.candidate.schemaVersion
      ) {
        throw codedError("MEMORY_CANDIDATE_SCHEMA_MISMATCH");
      }
      const existing = this.db
        .prepare("SELECT * FROM analysis_response_candidates WHERE job_id = ?")
        .get(jobId);
      if (existing) {
        if (
          existing.analysis_input_id !== analysisInputId ||
          existing.budget_attempt_id !== budgetAttemptId ||
          !safeHashEqual(existing.desired_vector_hash, job.desired_head_hash) ||
          !safeHashEqual(existing.candidate_hash, candidateHash) ||
          existing.candidate_json !== candidateJson
        ) {
          throw codedError("MEMORY_CANDIDATE_ALREADY_PERSISTED");
        }
        return {
          status: "existing",
          candidateId: existing.id,
          candidateHash: existing.candidate_hash,
          state: existing.state,
        };
      }
      const candidateId = this._nextId("analysis_candidate");
      const createdAt = assertTimestamp(this.now(), "createdAt");
      this.db
        .prepare(
          `INSERT INTO analysis_response_candidates (
             id, job_id, analysis_input_id, budget_attempt_id, desired_vector_hash,
             response_schema_version, candidate_json, candidate_bytes, candidate_hash,
             state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?)`
        )
        .run(
          candidateId,
          jobId,
          analysisInputId,
          budgetAttemptId,
          job.desired_head_hash,
          input.candidate.schemaVersion,
          candidateJson,
          candidateBytes,
          candidateHash,
          createdAt
        );
      return { status: "created", candidateId, candidateHash, state: "validated" };
    });
    return transaction.immediate();
  }

  listRecoverableAnalysisCandidates({ afterId = "", limit = 100 } = {}) {
    if (typeof afterId !== "string" || Array.from(afterId).length > 512) {
      throw new TypeError("afterId must be a bounded string");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("limit must be between 1 and 1000");
    }
    return this.db
      .prepare(
        `SELECT candidate.id AS candidate_id, candidate.job_id,
                candidate.analysis_input_id, candidate.budget_attempt_id,
                candidate.desired_vector_hash, candidate.candidate_hash,
                candidate.state AS candidate_state, job.state AS job_state,
                job.lease_owner, job.lease_expires_at, attempt.state AS budget_state
         FROM analysis_response_candidates AS candidate
         JOIN processing_jobs AS job ON job.id = candidate.job_id
         JOIN analysis_budget_attempts AS attempt
           ON attempt.request_id = candidate.budget_attempt_id
         WHERE candidate.state = 'validated' AND candidate.id > ?
         ORDER BY candidate.id LIMIT ?`
      )
      .all(afterId, limit)
      .map((row) => ({
        candidateId: row.candidate_id,
        jobId: row.job_id,
        analysisInputId: row.analysis_input_id,
        budgetAttemptId: row.budget_attempt_id,
        desiredVectorHash: row.desired_vector_hash,
        candidateHash: row.candidate_hash,
        candidateState: row.candidate_state,
        jobState: row.job_state,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        budgetState: row.budget_state,
      }));
  }

  applyStoredAnalysisCandidate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("stored candidate application is required");
    }
    const candidateId = assertId(input.candidateId, "candidateId");
    const jobId = assertId(input.jobId, "jobId");
    const owner = assertText(input.owner, "owner");
    const at = assertTimestamp(input.at, "at");
    const transaction = this.db.transaction(() => {
      const candidateRow = this.db
        .prepare("SELECT * FROM analysis_response_candidates WHERE id = ?")
        .get(candidateId);
      if (!candidateRow || candidateRow.job_id !== jobId) {
        throw codedError("MEMORY_CANDIDATE_NOT_FOUND");
      }
      const job = this.db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(jobId);
      if (
        !job ||
        job.job_type !== "analyze_session" ||
        job.lane !== "cloud" ||
        job.state !== "running" ||
        job.completed_at !== null ||
        job.lease_owner !== owner ||
        !Number.isSafeInteger(job.lease_expires_at) ||
        job.lease_expires_at <= at
      ) {
        throw codedError("MEMORY_CANDIDATE_LEASE_LOST");
      }
      const attempt = this.db
        .prepare("SELECT job_id, state FROM analysis_budget_attempts WHERE request_id = ?")
        .get(candidateRow.budget_attempt_id);
      if (!attempt || attempt.job_id !== jobId || attempt.state !== "reconciled") {
        throw codedError("MEMORY_CANDIDATE_BUDGET_UNRECONCILED");
      }
      if (candidateRow.state === "applied") {
        return {
          status: "already_applied",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
        };
      }
      if (candidateRow.state === "superseded") {
        return {
          status: "superseded",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
        };
      }
      const inputRow = this.db
        .prepare("SELECT session_id, input_hash FROM analysis_inputs WHERE id = ?")
        .get(candidateRow.analysis_input_id);
      const desiredHead = inputRow
        ? this.db
            .prepare("SELECT * FROM analysis_desired_heads WHERE session_id = ?")
            .get(inputRow.session_id)
        : null;
      const mappedDesiredHead = this._mapAnalysisDesiredHead(desiredHead);
      const isCurrent =
        inputRow &&
        mappedDesiredHead &&
        mappedDesiredHead.analysisInputId === candidateRow.analysis_input_id &&
        safeHashEqual(mappedDesiredHead.analysisInputHash, inputRow.input_hash) &&
        safeHashEqual(mappedDesiredHead.desiredVectorHash, candidateRow.desired_vector_hash) &&
        job.analysis_input_id === candidateRow.analysis_input_id &&
        safeHashEqual(job.input_hash, inputRow.input_hash) &&
        safeHashEqual(job.desired_head_hash, candidateRow.desired_vector_hash);
      if (!isCurrent) {
        this.db
          .prepare(
            `UPDATE analysis_response_candidates
             SET state = 'superseded', disposition_at = ?
             WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
          )
          .run(at, candidateId);
        return {
          status: "superseded",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
        };
      }
      if (
        Buffer.byteLength(candidateRow.candidate_json, "utf8") !== candidateRow.candidate_bytes ||
        !safeHashEqual(sha256(candidateRow.candidate_json), candidateRow.candidate_hash)
      ) {
        throw codedError("MEMORY_CANDIDATE_CORRUPT");
      }
      let candidate;
      try {
        candidate = JSON.parse(candidateRow.candidate_json);
      } catch {
        throw codedError("MEMORY_CANDIDATE_CORRUPT");
      }
      if (candidate.schemaVersion !== candidateRow.response_schema_version) {
        throw codedError("MEMORY_CANDIDATE_CORRUPT");
      }
      const result = this.applyCandidateAnalysis({
        analysisInputId: candidateRow.analysis_input_id,
        inputHash: inputRow.input_hash,
        candidate,
        claimedCandidateHash: candidateRow.candidate_hash,
      });
      this.db
        .prepare(
          `UPDATE analysis_response_candidates
           SET state = 'applied', disposition_at = ?
           WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
        )
        .run(at, candidateId);
      return result;
    });
    return transaction.immediate();
  }

  _nextId(prefix) {
    return assertId(this.createId(prefix), `${prefix}Id`);
  }

  _candidateContext(inputRow) {
    const manifest = this.db
      .prepare(
        `SELECT manifest.ordinal, manifest.segment_id, manifest.segment_version,
                manifest.text_hash, manifest.text_snapshot, manifest.speaker_binding_label,
                segment.session_id, segment.started_at, segment.ended_at, segment.version,
                segment.text, segment.result_kind, segment.is_stable, segment.superseded_by,
                segment.duplicate_of, segment.chunk_id, segment.track_id,
                chunk.deleted_at
         FROM analysis_input_segments AS manifest
         JOIN transcript_segments AS segment ON segment.id = manifest.segment_id
         LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
         WHERE manifest.analysis_input_id = ? ORDER BY manifest.ordinal`
      )
      .all(inputRow.id);
    if (manifest.length === 0) throw codedError("MEMORY_INPUT_CORRUPT");
    for (const segment of manifest) {
      if (
        segment.session_id !== inputRow.session_id ||
        segment.result_kind !== "final" ||
        segment.is_stable !== 1 ||
        segment.superseded_by !== null ||
        segment.duplicate_of !== null ||
        segment.version !== segment.segment_version ||
        segment.text !== segment.text_snapshot ||
        !safeHashEqual(sha256(segment.text), segment.text_hash)
      ) {
        throw codedError("MEMORY_INPUT_STALE");
      }
    }
    const bindings = this.db
      .prepare(
        `SELECT label, subject_kind, subject_id, subject_display_name_snapshot
         FROM analysis_input_speaker_bindings WHERE analysis_input_id = ?`
      )
      .all(inputRow.id);
    return {
      manifest,
      manifestById: new Map(manifest.map((segment) => [segment.segment_id, segment])),
      bindings,
      bindingByLabel: new Map(bindings.map((binding) => [binding.label, binding])),
    };
  }

  applyCandidateAnalysis(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("candidate application is required");
    }
    const analysisInputId = assertId(input.analysisInputId, "analysisInputId");
    const inputHash = assertHash(input.inputHash, "inputHash");
    const candidate = input.candidate;
    const candidateHash = sha256(canonicalJson(candidate));
    if (
      Object.prototype.hasOwnProperty.call(input, "claimedCandidateHash") &&
      !safeHashEqual(candidateHash, input.claimedCandidateHash)
    ) {
      throw codedError("MEMORY_CANDIDATE_HASH_MISMATCH");
    }

    const transaction = this.db.transaction(() => {
      const inputRow = this.db
        .prepare("SELECT * FROM analysis_inputs WHERE id = ?")
        .get(analysisInputId);
      if (!inputRow) throw codedError("MEMORY_INPUT_NOT_FOUND");
      if (!safeHashEqual(inputHash, inputRow.input_hash)) throw codedError("MEMORY_INPUT_MISMATCH");
      if (inputRow.candidate_hash !== null) {
        if (safeHashEqual(candidateHash, inputRow.candidate_hash)) {
          return { status: "already_applied", analysisInputId, candidateHash };
        }
        throw codedError("MEMORY_CANDIDATE_ALREADY_APPLIED");
      }

      const storedInput = this._loadStoredAnalysisInput(analysisInputId);
      const context = this._candidateContext(inputRow);
      const allowedSegmentIds = new Set(storedInput.payload.selectedSegmentIds);
      const allowedOwnerLabels = new Set(storedInput.payload.selectedOwnerLabels);
      validateCandidate(candidate, { allowedSegmentIds, allowedOwnerLabels });
      const appliedAt = assertTimestamp(this.now(), "appliedAt");

      const evidenceStatement = this.db.prepare(
        `INSERT INTO evidence_refs (
           id, entity_type, entity_id, source_analysis_input_id, session_id,
           transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
           quote_text, audio_state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertEvidence = (entityType, entityId, evidenceSegmentIds) => {
        for (const segmentId of evidenceSegmentIds) {
          const segment = context.manifestById.get(segmentId);
          evidenceStatement.run(
            this._nextId("evidence"),
            entityType,
            entityId,
            analysisInputId,
            inputRow.session_id,
            segment.segment_id,
            segment.chunk_id,
            segment.track_id,
            segment.started_at,
            segment.ended_at,
            segment.text_snapshot,
            segment.chunk_id === null
              ? "missing"
              : segment.deleted_at === null
                ? "available"
                : "expired",
            appliedAt
          );
        }
      };
      const evidenceBounds = (ids) => {
        const rows = ids.map((id) => context.manifestById.get(id));
        return {
          startedAt: Math.min(...rows.map((row) => row.started_at)),
          endedAt: Math.max(...rows.map((row) => row.ended_at)),
        };
      };

      const previousSummary = this.db
        .prepare(
          `SELECT id, revision FROM session_summary_revisions
           WHERE session_id = ? ORDER BY revision DESC LIMIT 1`
        )
        .get(inputRow.session_id);
      if (previousSummary) {
        this.db
          .prepare("UPDATE session_summary_revisions SET lifecycle = 'superseded' WHERE id = ?")
          .run(previousSummary.id);
      }
      const summaryId = this._nextId("session_summary_revision");
      const cloudPayload = JSON.parse(inputRow.cloud_payload_json);
      this.db
        .prepare(
          `INSERT INTO session_summary_revisions (
             id, session_id, revision, previous_revision_id, completeness, lifecycle,
             content_json, source_analysis_input_id, provenance, created_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'evidence_linked', ?)`
        )
        .run(
          summaryId,
          inputRow.session_id,
          (previousSummary?.revision ?? 0) + 1,
          previousSummary?.id ?? null,
          cloudPayload.omittedRanges.length === 0 ? "final" : "incremental",
          JSON.stringify({
            title: candidate.sessionSummary.title,
            summary: candidate.sessionSummary.summary,
          }),
          analysisInputId,
          appliedAt
        );
      insertEvidence(
        "session_summary_revision",
        summaryId,
        candidate.sessionSummary.evidenceSegmentIds
      );

      for (const [index, memory] of candidate.memories.entries()) {
        const slotKey = sha256(
          canonicalJson({ kind: memory.kind, title: normalizedKey(memory.title) })
        );
        const valueKey = sha256(canonicalJson({ slotKey, body: normalizedKey(memory.body) }));
        let memoryRow = this.db
          .prepare("SELECT id FROM memory_items_v2 WHERE canonical_value_key = ?")
          .get(valueKey);
        let memoryCreated = false;
        if (!memoryRow) {
          memoryCreated = true;
          memoryRow = { id: this._nextId("memory") };
          this.db
            .prepare(
              `INSERT INTO memory_items_v2 (
                 id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
                 lifecycle, source_analysis_input_id, provenance, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'evidence_linked', ?, ?)`
            )
            .run(
              memoryRow.id,
              memory.kind,
              slotKey,
              valueKey,
              memory.title,
              memory.body,
              memory.confidence,
              analysisInputId,
              appliedAt,
              appliedAt
            );
        }
        if (memoryCreated) {
          const openConflict = this.db
            .prepare(
              `SELECT id FROM memory_conflict_groups
               WHERE slot_key = ? AND state = 'open'`
            )
            .get(slotKey);
          if (openConflict) {
            this.db
              .prepare(
                `INSERT OR IGNORE INTO memory_conflict_members (
                   group_id, memory_item_id, created_at
                 ) VALUES (?, ?, ?)`
              )
              .run(openConflict.id, memoryRow.id, appliedAt);
            this.db
              .prepare(
                `UPDATE memory_items_v2
                 SET lifecycle = 'conflict', updated_at = ?
                 WHERE id = ? AND lifecycle = 'active'`
              )
              .run(appliedAt, memoryRow.id);
          } else {
            let previousValues = this.db
              .prepare(
                `SELECT id FROM memory_items_v2
                 WHERE canonical_slot_key = ? AND id <> ? AND lifecycle = 'active'
                 ORDER BY created_at, id`
              )
              .all(slotKey, memoryRow.id);
            if (previousValues.length === 0) {
              const selected = this.db
                .prepare(
                  `SELECT selected_member_id AS id
                   FROM memory_conflict_groups
                   WHERE slot_key = ? AND state = 'resolved'
                   ORDER BY episode DESC LIMIT 1`
                )
                .get(slotKey);
              previousValues = selected ? [selected] : [];
            }
            if (previousValues.length > 0) {
              const episode = this.db
                .prepare(
                  `SELECT COALESCE(MAX(episode), 0) + 1 AS episode
                     FROM memory_conflict_groups WHERE slot_key = ?`
                )
                .get(slotKey).episode;
              const conflictGroupId = this._nextId("memory_conflict");
              this.db
                .prepare(
                  `INSERT INTO memory_conflict_groups (
                     id, slot_key, episode, state, selected_member_id, resolved_at,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, 'open', NULL, NULL, ?, ?)`
                )
                .run(conflictGroupId, slotKey, episode, appliedAt, appliedAt);
              const addMember = this.db.prepare(
                `INSERT INTO memory_conflict_members (
                   group_id, memory_item_id, created_at
                 ) VALUES (?, ?, ?)`
              );
              for (const value of [...previousValues, memoryRow]) {
                addMember.run(conflictGroupId, value.id, appliedAt);
              }
              this.db
                .prepare(
                  `UPDATE memory_items_v2
                   SET lifecycle = 'conflict', updated_at = ?
                   WHERE canonical_slot_key = ? AND lifecycle = 'active'`
                )
                .run(appliedAt, slotKey);
            }
          }
        }
        const fingerprint = sha256(canonicalJson(memory));
        const occurrenceId = this._nextId("memory_occurrence");
        const bounds = evidenceBounds(memory.evidenceSegmentIds);
        this.db
          .prepare(
            `INSERT INTO memory_occurrences (
               id, memory_value_id, analysis_input_id, legacy_session_id, occurrence_key,
               candidate_item_fingerprint, started_at, ended_at, confidence, created_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            memoryRow.id,
            analysisInputId,
            sha256(`${analysisInputId}\0memory\0${index}\0${fingerprint}`),
            fingerprint,
            bounds.startedAt,
            bounds.endedAt,
            memory.confidence,
            appliedAt
          );
        insertEvidence("memory_occurrence", occurrenceId, memory.evidenceSegmentIds);
      }

      for (const [index, topic] of candidate.topics.entries()) {
        const canonicalKey = sha256(normalizedKey(topic.name));
        let topicRow = this.db
          .prepare("SELECT id FROM topics_v2 WHERE canonical_key = ?")
          .get(canonicalKey);
        if (!topicRow) {
          topicRow = { id: this._nextId("topic") };
          this.db
            .prepare(
              `INSERT INTO topics_v2 (
                 id, canonical_key, name, canonical_algorithm, lifecycle,
                 source_analysis_input_id, provenance, created_at, updated_at
               ) VALUES (?, ?, ?, 'canonical-v1', 'active', ?, 'evidence_linked', ?, ?)`
            )
            .run(topicRow.id, canonicalKey, topic.name, analysisInputId, appliedAt, appliedAt);
        }
        const previous = this.db
          .prepare(
            `SELECT id, revision, summary FROM topic_revisions
             WHERE topic_id = ? ORDER BY revision DESC LIMIT 1`
          )
          .get(topicRow.id);
        let revision = previous;
        if (!previous || previous.summary !== topic.summary) {
          revision = {
            id: this._nextId("topic_revision"),
            revision: (previous?.revision ?? 0) + 1,
          };
          this.db
            .prepare(
              `INSERT INTO topic_revisions (
                 id, topic_id, revision, previous_revision_id, summary,
                 source_analysis_input_id, provenance, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'evidence_linked', ?)`
            )
            .run(
              revision.id,
              topicRow.id,
              revision.revision,
              previous?.id ?? null,
              topic.summary,
              analysisInputId,
              appliedAt
            );
        }
        const fingerprint = sha256(canonicalJson(topic));
        const occurrenceId = this._nextId("topic_occurrence");
        this.db
          .prepare(
            `INSERT INTO topic_occurrences (
               id, topic_id, topic_revision_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            topicRow.id,
            revision.id,
            analysisInputId,
            sha256(`${analysisInputId}\0topic\0${index}\0${fingerprint}`),
            fingerprint,
            appliedAt
          );
        insertEvidence("topic_occurrence", occurrenceId, topic.evidenceSegmentIds);
      }

      for (const [index, todo] of candidate.todos.entries()) {
        const binding =
          todo.ownerLabel === null ? null : context.bindingByLabel.get(todo.ownerLabel);
        const baseKey = sha256(
          canonicalJson({
            title: normalizedKey(todo.title),
            ownerKind: binding?.subject_kind ?? null,
            ownerId: binding?.subject_id ?? null,
          })
        );
        let todoRow = this.db
          .prepare(
            `SELECT * FROM todos_v2
             WHERE canonical_base_key = ? ORDER BY created_at, id LIMIT 1`
          )
          .get(baseKey);
        if (!todoRow) {
          todoRow = { id: this._nextId("todo"), status: "open" };
          this.db
            .prepare(
              `INSERT INTO todos_v2 (
                 id, canonical_base_key, instance_key, title, owner_subject_kind,
                 owner_subject_id, owner_display_name_snapshot, status,
                 source_analysis_input_id, provenance,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 'evidence_linked', ?, ?)`
            )
            .run(
              todoRow.id,
              baseKey,
              baseKey,
              todo.title,
              binding?.subject_kind ?? null,
              binding?.subject_id ?? null,
              binding?.subject_display_name_snapshot ?? null,
              analysisInputId,
              appliedAt,
              appliedAt
            );
          this.db
            .prepare(
              `INSERT INTO todo_state_transitions (
                 id, todo_instance_id, from_status, to_status, reason,
                 source_analysis_input_id, actor, occurred_at
               ) VALUES (?, ?, NULL, 'open', 'analysis_created', ?, 'system', ?)`
            )
            .run(this._nextId("todo_transition"), todoRow.id, analysisInputId, appliedAt);
        }
        const previous = this.db
          .prepare(
            `SELECT id, revision, title, due_text FROM todo_revisions
             WHERE todo_instance_id = ? ORDER BY revision DESC LIMIT 1`
          )
          .get(todoRow.id);
        let revision = previous;
        if (!previous || previous.title !== todo.title || previous.due_text !== todo.dueText) {
          revision = { id: this._nextId("todo_revision"), revision: (previous?.revision ?? 0) + 1 };
          this.db
            .prepare(
              `INSERT INTO todo_revisions (
                 id, todo_instance_id, revision, previous_revision_id, title, due_text,
                 source_analysis_input_id, provenance, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence_linked', ?)`
            )
            .run(
              revision.id,
              todoRow.id,
              revision.revision,
              previous?.id ?? null,
              todo.title,
              todo.dueText,
              analysisInputId,
              appliedAt
            );
        }
        const fingerprint = sha256(canonicalJson(todo));
        const occurrenceId = this._nextId("todo_occurrence");
        const bounds = evidenceBounds(todo.evidenceSegmentIds);
        this.db
          .prepare(
            `INSERT INTO todo_occurrences (
               id, todo_instance_id, todo_revision_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, started_at, ended_at, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            todoRow.id,
            revision.id,
            analysisInputId,
            sha256(`${analysisInputId}\0todo\0${index}\0${fingerprint}`),
            fingerprint,
            bounds.startedAt,
            bounds.endedAt,
            appliedAt
          );
        insertEvidence("todo_occurrence", occurrenceId, todo.evidenceSegmentIds);
      }

      for (const [index, suggestion] of candidate.suggestions.entries()) {
        const canonicalKey = sha256(
          canonicalJson({
            title: normalizedKey(suggestion.title),
            rationale: normalizedKey(suggestion.rationale),
          })
        );
        let suggestionRow = this.db
          .prepare("SELECT id FROM suggestions_v2 WHERE canonical_key = ?")
          .get(canonicalKey);
        if (!suggestionRow) {
          suggestionRow = { id: this._nextId("suggestion") };
          this.db
            .prepare(
              `INSERT INTO suggestions_v2 (
                 id, canonical_key, title, rationale, state, source_analysis_input_id,
                 provenance, created_at, updated_at
               ) VALUES (?, ?, ?, ?, 'proposed', ?, 'suggestion', ?, ?)`
            )
            .run(
              suggestionRow.id,
              canonicalKey,
              suggestion.title,
              suggestion.rationale,
              analysisInputId,
              appliedAt,
              appliedAt
            );
        }
        const fingerprint = sha256(canonicalJson(suggestion));
        const occurrenceId = this._nextId("suggestion_occurrence");
        this.db
          .prepare(
            `INSERT INTO suggestion_occurrences (
               id, suggestion_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, created_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            suggestionRow.id,
            analysisInputId,
            sha256(`${analysisInputId}\0suggestion\0${index}\0${fingerprint}`),
            fingerprint,
            appliedAt
          );
        insertEvidence("suggestion_occurrence", occurrenceId, suggestion.basedOnEvidenceSegmentIds);
      }

      const cas = this.db
        .prepare(
          `UPDATE analysis_inputs SET candidate_hash = ?, applied_at = ?
           WHERE id = ? AND candidate_hash IS NULL AND applied_at IS NULL`
        )
        .run(candidateHash, appliedAt, analysisInputId);
      if (cas.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
      return { status: "applied", analysisInputId, candidateHash };
    });
    return transaction.immediate();
  }

  importLegacyAnalysis() {
    const transaction = this.db.transaction(() => {
      let importedAt = null;
      let importRunId = null;
      const ensureImportRun = () => {
        if (importRunId !== null) return;
        importedAt = assertTimestamp(this.now(), "importedAt");
        importRunId = this._nextId("legacy_import_run");
        this.db
          .prepare(
            `INSERT INTO legacy_import_runs (
               id, importer_version, status, started_at, completed_at, imported_row_count
             ) VALUES (?, ?, 'running', ?, NULL, 0)`
          )
          .run(importRunId, LEGACY_IMPORTER_VERSION, importedAt);
      };

      const getMap = this.db.prepare(
        `SELECT target_entity_type, target_entity_id
         FROM legacy_import_map
         WHERE source_table = ? AND source_key = ? AND source_fingerprint = ?`
      );
      const insertMap = this.db.prepare(
        `INSERT INTO legacy_import_map (
           source_table, source_key, source_fingerprint, target_entity_type,
           target_entity_id, import_run_id, imported_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      let importedRowCount = 0;
      const mapped = (sourceTable, sourceKey, fingerprint) =>
        getMap.get(sourceTable, sourceKey, fingerprint) ?? null;
      const recordMap = (sourceTable, sourceKey, fingerprint, targetType, targetId) => {
        if (importRunId === null || importedAt === null) {
          throw codedError("MEMORY_LEGACY_IMPORT_STATE_INVALID");
        }
        insertMap.run(
          sourceTable,
          sourceKey,
          fingerprint,
          targetType,
          targetId,
          importRunId,
          importedAt
        );
        importedRowCount += 1;
      };
      const sourceKeyFor = (...parts) => canonicalJson(parts);
      const fingerprintFor = (...parts) => sha256(canonicalJson(parts));
      const occurrenceKeyFor = (sourceTable, sourceKey, fingerprint) =>
        sha256(canonicalJson(["legacy", sourceTable, sourceKey, fingerprint]));

      const resolveLegacyEvidence = (segmentId, expectedSessionId) => {
        const segment = this.db
          .prepare(
            `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                    segment.version, segment.text, segment.result_kind, segment.is_stable,
                    segment.superseded_by, segment.duplicate_of, segment.chunk_id,
                    segment.track_id, chunk.session_id AS chunk_session_id,
                    chunk.track_id AS chunk_track_id, chunk.started_at AS chunk_started_at,
                    chunk.ended_at AS chunk_ended_at, chunk.deleted_at,
                    track.session_id AS track_session_id
             FROM transcript_segments AS segment
             LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
             LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
             WHERE segment.id = ?`
          )
          .get(segmentId);
        const lineageFingerprint = fingerprintFor(
          segmentId,
          expectedSessionId,
          segment
            ? {
                id: segment.id,
                sessionId: segment.session_id,
                startedAt: segment.started_at,
                endedAt: segment.ended_at,
                version: segment.version,
                text: segment.text,
                resultKind: segment.result_kind,
                isStable: segment.is_stable,
                supersededBy: segment.superseded_by,
                duplicateOf: segment.duplicate_of,
                chunkId: segment.chunk_id,
                trackId: segment.track_id,
                chunkSessionId: segment.chunk_session_id,
                chunkTrackId: segment.chunk_track_id,
                chunkStartedAt: segment.chunk_started_at,
                chunkEndedAt: segment.chunk_ended_at,
                trackSessionId: segment.track_session_id,
              }
            : null
        );
        if (
          !segment ||
          segment.session_id !== expectedSessionId ||
          segment.result_kind !== "final" ||
          segment.is_stable !== 1 ||
          segment.superseded_by !== null ||
          segment.duplicate_of !== null ||
          !legacyText(segment.text) ||
          segment.chunk_id === null ||
          segment.track_id === null ||
          segment.chunk_session_id !== expectedSessionId ||
          segment.chunk_track_id !== segment.track_id ||
          segment.track_session_id !== expectedSessionId ||
          segment.started_at < segment.chunk_started_at ||
          segment.ended_at > segment.chunk_ended_at
        ) {
          return { valid: false, lineageFingerprint, segment };
        }
        return {
          valid: true,
          lineageFingerprint,
          segment,
          evidence: {
            sessionId: expectedSessionId,
            segmentId: segment.id,
            audioChunkId: segment.chunk_id,
            trackId: segment.track_id,
            startedAt: segment.started_at,
            endedAt: segment.ended_at,
            quoteText: segment.text,
            audioState: segment.deleted_at === null ? "available" : "expired",
          },
        };
      };

      const insertEvidence = (entityType, entityId, evidence) => {
        const existing = this.db
          .prepare(
            `SELECT id FROM evidence_refs
             WHERE entity_type = ? AND entity_id = ? AND transcript_segment_id = ?
               AND started_at = ? AND ended_at = ?`
          )
          .get(entityType, entityId, evidence.segmentId, evidence.startedAt, evidence.endedAt);
        if (existing) return existing.id;
        const evidenceId = this._nextId("evidence");
        this.db
          .prepare(
            `INSERT INTO evidence_refs (
               id, entity_type, entity_id, source_analysis_input_id, session_id,
               transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
               quote_text, audio_state, created_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            evidenceId,
            entityType,
            entityId,
            evidence.sessionId,
            evidence.segmentId,
            evidence.audioChunkId,
            evidence.trackId,
            evidence.startedAt,
            evidence.endedAt,
            evidence.quoteText,
            evidence.audioState,
            importedAt
          );
        return evidenceId;
      };

      const legacyMemoryKeys = (kind, title, body) => {
        const normalizedTitle = normalizedKey(title);
        const slotKey = sha256(canonicalJson({ kind, title: normalizedTitle }));
        return {
          slotKey,
          valueKey: sha256(canonicalJson({ slotKey, body: normalizedKey(body) })),
        };
      };

      const ensureLegacyMemory = ({ kind, title, body, confidence, provenance }) => {
        const { slotKey, valueKey } = legacyMemoryKeys(kind, title, body);
        let row = this.db
          .prepare("SELECT id, provenance FROM memory_items_v2 WHERE canonical_value_key = ?")
          .get(valueKey);
        if (!row) {
          row = { id: this._nextId("memory"), provenance };
          this.db
            .prepare(
              `INSERT INTO memory_items_v2 (
                 id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
                 lifecycle, source_analysis_input_id, provenance, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`
            )
            .run(
              row.id,
              kind,
              slotKey,
              valueKey,
              title,
              body,
              confidence,
              provenance,
              importedAt,
              importedAt
            );
        }
        return row.id;
      };

      const summaryRows = this.db
        .prepare(
          `SELECT session_id, summary, decisions_json, suggestions_json,
                  analysis_run_id, updated_at, is_final
           FROM session_summaries ORDER BY updated_at, session_id`
        )
        .all();
      for (const summary of summaryRows) {
        const decisions = parseLegacyArray(summary.decisions_json);
        const suggestions = parseLegacyArray(summary.suggestions_json);
        const sourceKey = sourceKeyFor(summary.session_id, summary.analysis_run_id);
        const fingerprint = fingerprintFor(
          summary.session_id,
          summary.summary,
          summary.decisions_json,
          summary.suggestions_json,
          summary.analysis_run_id,
          summary.updated_at,
          summary.is_final
        );
        if (!mapped("session_summaries", sourceKey, fingerprint)) {
          ensureImportRun();
          const previous = this.db
            .prepare(
              `SELECT id, revision, completeness FROM session_summary_revisions
               WHERE session_id = ? ORDER BY revision DESC LIMIT 1`
            )
            .get(summary.session_id);
          if (previous) {
            this.db
              .prepare(
                `UPDATE session_summary_revisions
                 SET lifecycle = 'superseded' WHERE id = ? AND lifecycle = 'active'`
              )
              .run(previous.id);
          }
          const summaryId = this._nextId("session_summary_revision");
          this.db
            .prepare(
              `INSERT INTO session_summary_revisions (
                 id, session_id, revision, previous_revision_id, completeness, lifecycle,
                 content_json, source_analysis_input_id, provenance, created_at
               ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, 'legacy_unverified', ?)`
            )
            .run(
              summaryId,
              summary.session_id,
              (previous?.revision ?? 0) + 1,
              previous?.id ?? null,
              previous?.completeness === "final" || summary.is_final === 1
                ? "final"
                : "incremental",
              canonicalJson({
                summary: typeof summary.summary === "string" ? summary.summary : "",
                decisions,
                suggestions,
              }),
              importedAt
            );
          recordMap("session_summaries", sourceKey, fingerprint, "session_summary", summaryId);
        }

        for (const [index, decisionValue] of decisions.entries()) {
          const decision = legacyText(decisionValue);
          if (!decision) continue;
          const decisionSourceKey = sourceKeyFor(
            summary.session_id,
            summary.analysis_run_id,
            index
          );
          const decisionFingerprint = fingerprintFor(decisionValue);
          if (mapped("session_summary_decisions", decisionSourceKey, decisionFingerprint)) continue;
          ensureImportRun();
          const memoryId = ensureLegacyMemory({
            kind: "decision",
            title: decision,
            body: decision,
            confidence: 1,
            provenance: "legacy_unverified",
          });
          const occurrenceId = this._nextId("memory_occurrence");
          this.db
            .prepare(
              `INSERT INTO memory_occurrences (
                 id, memory_value_id, analysis_input_id, legacy_session_id, occurrence_key,
                 candidate_item_fingerprint, started_at, ended_at, confidence, created_at
               ) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, 1, ?)`
            )
            .run(
              occurrenceId,
              memoryId,
              summary.session_id,
              occurrenceKeyFor("session_summary_decisions", decisionSourceKey, decisionFingerprint),
              decisionFingerprint,
              importedAt
            );
          recordMap(
            "session_summary_decisions",
            decisionSourceKey,
            decisionFingerprint,
            "memory",
            memoryId
          );
        }

        for (const [index, suggestionValue] of suggestions.entries()) {
          if (
            !suggestionValue ||
            typeof suggestionValue !== "object" ||
            Array.isArray(suggestionValue)
          ) {
            continue;
          }
          const title = legacyText(suggestionValue.content ?? suggestionValue.title);
          const rationale = legacyText(suggestionValue.reason ?? suggestionValue.rationale);
          if (!title || !rationale) continue;
          const suggestionSourceKey = sourceKeyFor(
            summary.session_id,
            summary.analysis_run_id,
            index
          );
          const suggestionFingerprint = fingerprintFor(suggestionValue);
          if (mapped("session_summary_suggestions", suggestionSourceKey, suggestionFingerprint)) {
            continue;
          }
          ensureImportRun();
          const canonicalKey = sha256(
            canonicalJson({ title: normalizedKey(title), rationale: normalizedKey(rationale) })
          );
          let suggestionRow = this.db
            .prepare("SELECT id FROM suggestions_v2 WHERE canonical_key = ?")
            .get(canonicalKey);
          if (!suggestionRow) {
            suggestionRow = { id: this._nextId("suggestion") };
            this.db
              .prepare(
                `INSERT INTO suggestions_v2 (
                   id, canonical_key, title, rationale, state, source_analysis_input_id,
                   provenance, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, 'proposed', NULL, 'legacy_unverified', ?, ?)`
              )
              .run(suggestionRow.id, canonicalKey, title, rationale, importedAt, importedAt);
          }
          const occurrenceId = this._nextId("suggestion_occurrence");
          this.db
            .prepare(
              `INSERT INTO suggestion_occurrences (
                 id, suggestion_id, analysis_input_id, legacy_session_id,
                 occurrence_key, candidate_item_fingerprint, created_at
               ) VALUES (?, ?, NULL, ?, ?, ?, ?)`
            )
            .run(
              occurrenceId,
              suggestionRow.id,
              summary.session_id,
              occurrenceKeyFor(
                "session_summary_suggestions",
                suggestionSourceKey,
                suggestionFingerprint
              ),
              suggestionFingerprint,
              importedAt
            );
          recordMap(
            "session_summary_suggestions",
            suggestionSourceKey,
            suggestionFingerprint,
            "suggestion",
            suggestionRow.id
          );
        }
      }

      const legacyTopicTargets = new Map();
      const topicRows = this.db.prepare("SELECT * FROM topics ORDER BY created_at, id").all();
      for (const topic of topicRows) {
        const name = legacyText(topic.canonical_title);
        if (!name) continue;
        const sourceKey = sourceKeyFor(topic.id);
        const fingerprint = fingerprintFor(topic);
        const existingMap = mapped("topics", sourceKey, fingerprint);
        if (existingMap) {
          legacyTopicTargets.set(topic.id, existingMap.target_entity_id);
          continue;
        }
        ensureImportRun();
        const canonicalKey = sha256(normalizedKey(name));
        let topicRow = this.db
          .prepare("SELECT id FROM topics_v2 WHERE canonical_key = ?")
          .get(canonicalKey);
        if (!topicRow) {
          topicRow = { id: this._nextId("topic") };
          this.db
            .prepare(
              `INSERT INTO topics_v2 (
                 id, canonical_key, name, canonical_algorithm, lifecycle,
                 source_analysis_input_id, provenance, created_at, updated_at
               ) VALUES (?, ?, ?, 'canonical-v1', 'active', NULL, 'legacy_unverified', ?, ?)`
            )
            .run(topicRow.id, canonicalKey, name, importedAt, importedAt);
        }
        const previous = this.db
          .prepare(
            `SELECT id, revision, summary FROM topic_revisions
             WHERE topic_id = ? ORDER BY revision DESC LIMIT 1`
          )
          .get(topicRow.id);
        const description = typeof topic.description === "string" ? topic.description : "";
        if (!previous || previous.summary !== description) {
          this.db
            .prepare(
              `INSERT INTO topic_revisions (
                 id, topic_id, revision, previous_revision_id, summary,
                 source_analysis_input_id, provenance, created_at
               ) VALUES (?, ?, ?, ?, ?, NULL, 'legacy_unverified', ?)`
            )
            .run(
              this._nextId("topic_revision"),
              topicRow.id,
              (previous?.revision ?? 0) + 1,
              previous?.id ?? null,
              description,
              importedAt
            );
        }
        legacyTopicTargets.set(topic.id, topicRow.id);
        recordMap("topics", sourceKey, fingerprint, "topic", topicRow.id);
      }

      const sessionTopicRows = this.db
        .prepare(
          `SELECT session_id, topic_id, analysis_run_id
           FROM session_topics ORDER BY session_id, topic_id`
        )
        .all();
      for (const relation of sessionTopicRows) {
        const topicId = legacyTopicTargets.get(relation.topic_id);
        if (!topicId) continue;
        const sourceKey = sourceKeyFor(
          relation.session_id,
          relation.topic_id,
          relation.analysis_run_id
        );
        const fingerprint = fingerprintFor(relation);
        if (mapped("session_topics", sourceKey, fingerprint)) continue;
        ensureImportRun();
        const revision = this.db
          .prepare(
            `SELECT id FROM topic_revisions
             WHERE topic_id = ? ORDER BY revision DESC LIMIT 1`
          )
          .get(topicId);
        const occurrenceId = this._nextId("topic_occurrence");
        this.db
          .prepare(
            `INSERT INTO topic_occurrences (
               id, topic_id, topic_revision_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, created_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            topicId,
            revision.id,
            relation.session_id,
            occurrenceKeyFor("session_topics", sourceKey, fingerprint),
            fingerprint,
            importedAt
          );
        recordMap("session_topics", sourceKey, fingerprint, "topic", topicId);
      }

      const todoRows = this.db
        .prepare(
          `SELECT todo.*, person.display_name AS owner_display_name
           FROM todos AS todo
           LEFT JOIN people AS person ON person.id = todo.owner_person_id
           ORDER BY todo.created_at, todo.id`
        )
        .all();
      for (const todo of todoRows) {
        const title = legacyText(todo.content);
        if (!title) continue;
        const sourceKey = sourceKeyFor(todo.id);
        const evidence = todo.source_segment_id
          ? resolveLegacyEvidence(todo.source_segment_id, todo.source_session_id)
          : { valid: false, lineageFingerprint: fingerprintFor(null) };
        const fingerprint = fingerprintFor(todo, evidence.lineageFingerprint);
        if (mapped("todos", sourceKey, fingerprint)) continue;
        ensureImportRun();
        const baseKey = sha256(
          canonicalJson({
            title: normalizedKey(title),
            ownerKind: todo.owner_person_id ? "person" : null,
            ownerId: todo.owner_person_id ?? null,
          })
        );
        const instanceKey = sha256(canonicalJson(["legacy-todo", todo.id]));
        let todoRow = this.db
          .prepare("SELECT * FROM todos_v2 WHERE instance_key = ?")
          .get(instanceKey);
        const completed = todo.status === "completed";
        const completedAt = completed
          ? Number.isSafeInteger(todo.completed_at)
            ? todo.completed_at
            : todo.updated_at
          : null;
        const provenance = evidence.valid ? "evidence_linked" : "legacy_unverified";
        if (!todoRow) {
          todoRow = { id: this._nextId("todo"), status: completed ? "completed" : "open" };
          this.db
            .prepare(
              `INSERT INTO todos_v2 (
                 id, canonical_base_key, instance_key, title, owner_subject_kind,
                 owner_subject_id, owner_display_name_snapshot, status, completed_at,
                 dismissed_at, source_analysis_input_id, provenance, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
            )
            .run(
              todoRow.id,
              baseKey,
              instanceKey,
              title,
              todo.owner_person_id ? "person" : null,
              todo.owner_person_id ?? null,
              todo.owner_person_id ? legacyText(todo.owner_display_name) : null,
              todoRow.status,
              completedAt,
              provenance,
              importedAt,
              importedAt
            );
        } else {
          if (todoRow.status === "open" && completed) {
            this.db
              .prepare(
                `INSERT INTO todo_state_transitions (
                   id, todo_instance_id, from_status, to_status, reason,
                   source_analysis_input_id, actor, occurred_at
                 ) VALUES (?, ?, 'open', 'completed', 'user_action', NULL, 'user', ?)`
              )
              .run(this._nextId("todo_transition"), todoRow.id, completedAt);
            todoRow.status = "completed";
          }
        }
        const previous = this.db
          .prepare(
            `SELECT id, revision, title, due_text FROM todo_revisions
             WHERE todo_instance_id = ? ORDER BY revision DESC LIMIT 1`
          )
          .get(todoRow.id);
        const dueText = legacyDueText(todo.due_at);
        let revision = previous;
        if (!previous || previous.title !== title || previous.due_text !== dueText) {
          revision = { id: this._nextId("todo_revision"), revision: (previous?.revision ?? 0) + 1 };
          this.db
            .prepare(
              `INSERT INTO todo_revisions (
                 id, todo_instance_id, revision, previous_revision_id, title, due_text,
                 source_analysis_input_id, provenance, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
            )
            .run(
              revision.id,
              todoRow.id,
              revision.revision,
              previous?.id ?? null,
              title,
              dueText,
              provenance,
              importedAt
            );
        }
        const occurrenceId = this._nextId("todo_occurrence");
        this.db
          .prepare(
            `INSERT INTO todo_occurrences (
               id, todo_instance_id, todo_revision_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, started_at, ended_at, created_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            todoRow.id,
            revision.id,
            todo.source_session_id,
            occurrenceKeyFor("todos", sourceKey, fingerprint),
            fingerprint,
            evidence.valid ? evidence.evidence.startedAt : null,
            evidence.valid ? evidence.evidence.endedAt : null,
            importedAt
          );
        if (evidence.valid) insertEvidence("todo_occurrence", occurrenceId, evidence.evidence);
        recordMap("todos", sourceKey, fingerprint, "todo", todoRow.id);
      }

      const memoryTargets = new Map();
      const memoryRows = this.db.prepare("SELECT * FROM memories ORDER BY first_seen_at, id").all();
      for (const memory of memoryRows) {
        const body = legacyText(memory.content);
        if (!body) continue;
        const evidenceRows = this.db
          .prepare(
            `SELECT evidence.segment_id, evidence.analysis_run_id,
                    run.session_id AS run_session_id
             FROM memory_evidence AS evidence
             JOIN analysis_runs AS run ON run.id = evidence.analysis_run_id
             WHERE evidence.memory_id = ?
             ORDER BY run.completed_at, evidence.segment_id`
          )
          .all(memory.id);
        const resolvedEvidence = evidenceRows.map((row) => ({
          row,
          resolved: resolveLegacyEvidence(row.segment_id, row.run_session_id),
        }));
        const evidenceBySession = new Map();
        for (const item of resolvedEvidence) {
          const sessionEvidence = evidenceBySession.get(item.row.run_session_id) ?? [];
          sessionEvidence.push(item);
          evidenceBySession.set(item.row.run_session_id, sessionEvidence);
        }
        const sourceKey = sourceKeyFor(memory.id);
        const fingerprint = fingerprintFor(
          memory,
          resolvedEvidence.map(({ row, resolved }) => [
            row.segment_id,
            row.analysis_run_id,
            resolved.lineageFingerprint,
          ])
        );
        const existingMap = mapped("memories", sourceKey, fingerprint);
        const firstValidEvidence = resolvedEvidence.find(({ resolved }) => resolved.valid);
        const stableMemoryValueKey = legacyMemoryKeys(memory.type, body, body).valueKey;
        let memoryId = existingMap?.target_entity_id ?? null;
        if (!memoryId) {
          ensureImportRun();
          memoryId = ensureLegacyMemory({
            kind: memory.type,
            title: body,
            body,
            confidence: legacyConfidence(memory.confidence),
            provenance: firstValidEvidence ? "evidence_linked" : "legacy_unverified",
          });
        }
        const occurrenceIdsBySession = new Map();
        for (const [legacySessionId, sessionEvidence] of evidenceBySession) {
          const occurrenceFingerprint = fingerprintFor(
            stableMemoryValueKey,
            legacySessionId,
            sessionEvidence.map(({ row, resolved }) => [
              row.segment_id,
              row.analysis_run_id,
              resolved.lineageFingerprint,
            ])
          );
          const occurrenceKey = occurrenceKeyFor(
            "memories",
            sourceKeyFor(memory.id, legacySessionId),
            occurrenceFingerprint
          );
          let occurrenceId = this.db
            .prepare("SELECT id FROM memory_occurrences WHERE occurrence_key = ?")
            .get(occurrenceKey)?.id;
          if (!occurrenceId) {
            ensureImportRun();
            occurrenceId = this._nextId("memory_occurrence");
            const validEvidence = sessionEvidence
              .filter(({ resolved }) => resolved.valid)
              .map(({ resolved }) => resolved.evidence);
            this.db
              .prepare(
                `INSERT INTO memory_occurrences (
                   id, memory_value_id, analysis_input_id, legacy_session_id, occurrence_key,
                   candidate_item_fingerprint, started_at, ended_at, confidence, created_at
                 ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                occurrenceId,
                memoryId,
                legacySessionId,
                occurrenceKey,
                occurrenceFingerprint,
                validEvidence.length > 0
                  ? Math.min(...validEvidence.map((item) => item.startedAt))
                  : null,
                validEvidence.length > 0
                  ? Math.max(...validEvidence.map((item) => item.endedAt))
                  : null,
                legacyConfidence(memory.confidence),
                importedAt
              );
            for (const evidence of validEvidence) {
              insertEvidence("memory_occurrence", occurrenceId, evidence);
            }
          }
          occurrenceIdsBySession.set(legacySessionId, occurrenceId);
        }
        memoryTargets.set(memory.id, { memoryId, occurrenceIdsBySession });
        if (!existingMap) {
          recordMap("memories", sourceKey, fingerprint, "memory", memoryId);
        }
      }

      const legacyEvidenceRows = this.db
        .prepare(
          `SELECT evidence.memory_id, evidence.segment_id, evidence.analysis_run_id,
                  run.session_id AS run_session_id
           FROM memory_evidence AS evidence
           JOIN analysis_runs AS run ON run.id = evidence.analysis_run_id
           ORDER BY evidence.memory_id, evidence.segment_id, evidence.analysis_run_id`
        )
        .all();
      for (const legacyEvidence of legacyEvidenceRows) {
        const target = memoryTargets.get(legacyEvidence.memory_id);
        if (!target) continue;
        const resolved = resolveLegacyEvidence(
          legacyEvidence.segment_id,
          legacyEvidence.run_session_id
        );
        const sourceKey = sourceKeyFor(
          legacyEvidence.memory_id,
          legacyEvidence.segment_id,
          legacyEvidence.analysis_run_id
        );
        const fingerprint = fingerprintFor(legacyEvidence, resolved.lineageFingerprint);
        if (mapped("memory_evidence", sourceKey, fingerprint)) continue;
        ensureImportRun();
        let targetType = "memory";
        let targetId = target.memoryId;
        const occurrenceId = target.occurrenceIdsBySession.get(legacyEvidence.run_session_id);
        if (resolved.valid && occurrenceId) {
          targetType = "evidence";
          targetId = insertEvidence("memory_occurrence", occurrenceId, resolved.evidence);
        }
        recordMap("memory_evidence", sourceKey, fingerprint, targetType, targetId);
      }

      if (importRunId !== null) {
        this.db
          .prepare(
            `UPDATE legacy_import_runs
             SET status = 'completed', completed_at = ?, imported_row_count = ?
             WHERE id = ? AND status = 'running'`
          )
          .run(importedAt, importedRowCount, importRunId);
      }
      return { status: "completed", importedRowCount };
    });
    return transaction.immediate();
  }

  resolveMemoryConflict(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("memory conflict resolution is required");
    }
    if (!hasExactKeys(input, ["conflictGroupId", "selectedMemoryItemId"])) {
      throw codedError("MEMORY_CONFLICT_RESOLUTION_INVALID");
    }
    const conflictGroupId = assertId(input.conflictGroupId, "conflictGroupId");
    const selectedMemoryItemId = assertId(input.selectedMemoryItemId, "selectedMemoryItemId");
    const transaction = this.db.transaction(() => {
      const conflict = this.db
        .prepare("SELECT * FROM memory_conflict_groups WHERE id = ?")
        .get(conflictGroupId);
      if (!conflict) throw codedError("MEMORY_CONFLICT_NOT_FOUND");
      if (conflict.state === "resolved") {
        if (conflict.selected_member_id === selectedMemoryItemId) {
          return {
            status: "already_resolved",
            conflictGroupId,
            selectedMemoryItemId,
          };
        }
        throw codedError("MEMORY_CONFLICT_ALREADY_RESOLVED");
      }
      const selectedMember = this.db
        .prepare(
          `SELECT 1 FROM memory_conflict_members
           WHERE group_id = ? AND memory_item_id = ?`
        )
        .get(conflictGroupId, selectedMemoryItemId);
      if (!selectedMember) throw codedError("MEMORY_CONFLICT_MEMBER_INVALID");
      const resolvedAt = assertTimestamp(this.now(), "resolvedAt");
      const otherMembers = this.db
        .prepare(
          `SELECT memory_item_id FROM memory_conflict_members
           WHERE group_id = ? AND memory_item_id <> ? ORDER BY memory_item_id`
        )
        .all(conflictGroupId, selectedMemoryItemId);
      const resolved = this.db
        .prepare(
          `UPDATE memory_conflict_groups
           SET state = 'resolved', selected_member_id = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'open'`
        )
        .run(selectedMemoryItemId, resolvedAt, resolvedAt, conflictGroupId);
      if (resolved.changes !== 1) throw codedError("MEMORY_CONFLICT_RESOLUTION_CONFLICT");
      const insertSupersession = this.db.prepare(
        `INSERT OR IGNORE INTO memory_supersessions (
           previous_id, next_id, reason, analysis_input_id, created_at
         ) VALUES (?, ?, 'conflict_resolution', NULL, ?)`
      );
      for (const member of otherMembers) {
        insertSupersession.run(member.memory_item_id, selectedMemoryItemId, resolvedAt);
        const superseded = this.db
          .prepare(
            `UPDATE memory_items_v2
             SET lifecycle = 'superseded', updated_at = ?
             WHERE id = ? AND lifecycle = 'conflict'`
          )
          .run(resolvedAt, member.memory_item_id);
        if (superseded.changes !== 1) {
          throw codedError("MEMORY_CONFLICT_RESOLUTION_CONFLICT");
        }
      }
      const selected = this.db
        .prepare(
          `UPDATE memory_items_v2
           SET lifecycle = 'active', updated_at = ?
           WHERE id = ? AND lifecycle = 'conflict'`
        )
        .run(resolvedAt, selectedMemoryItemId);
      if (selected.changes !== 1) throw codedError("MEMORY_CONFLICT_RESOLUTION_CONFLICT");
      return {
        status: "resolved",
        conflictGroupId,
        selectedMemoryItemId,
      };
    });
    return transaction.immediate();
  }

  saveDigestRevision(input) {
    if (
      !hasExactKeys(input, [
        "localDate",
        "timezone",
        "sourceHash",
        "inputWatermark",
        "content",
        "completeness",
      ])
    ) {
      throw codedError("MEMORY_DIGEST_INVALID");
    }
    const localDate = assertLocalDate(input.localDate);
    const timezone = assertTimezone(input.timezone);
    const sourceHash = assertHash(input.sourceHash, "sourceHash");
    assertJsonObject(input.inputWatermark, "inputWatermark");
    assertJsonObject(input.content, "content");
    if (input.completeness !== "partial" && input.completeness !== "final") {
      throw new TypeError("completeness must be partial or final");
    }
    const inputWatermarkJson = canonicalJson(input.inputWatermark);
    const contentJson = canonicalJson(input.content);
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id, revision, completeness, input_watermark_json, content_json
           FROM daily_digests
           WHERE local_date = ? AND timezone = ? AND source_hash = ?`
        )
        .get(localDate, timezone, sourceHash);
      if (existing) {
        if (
          existing.completeness !== input.completeness ||
          existing.input_watermark_json !== inputWatermarkJson ||
          existing.content_json !== contentJson
        ) {
          throw codedError("MEMORY_DIGEST_HASH_COLLISION");
        }
        return {
          status: "existing",
          digestId: existing.id,
          revision: existing.revision,
          sourceHash,
        };
      }
      const previous = this.db
        .prepare(
          `SELECT id, revision, completeness
           FROM daily_digests
           WHERE local_date = ? AND timezone = ?
           ORDER BY revision DESC LIMIT 1`
        )
        .get(localDate, timezone);
      if (previous?.completeness === "final" && input.completeness === "partial") {
        throw codedError("MEMORY_DIGEST_COMPLETENESS_REGRESSION");
      }
      const digestId = this._nextId("daily_digest");
      const createdAt = assertTimestamp(this.now(), "createdAt");
      if (previous) {
        this.db
          .prepare("UPDATE daily_digests SET lifecycle = 'superseded', updated_at = ? WHERE id = ?")
          .run(createdAt, previous.id);
      }
      const revision = (previous?.revision ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO daily_digests (
             id, local_date, timezone, revision, completeness, lifecycle,
             input_watermark_json, content_json, previous_revision_id,
             source_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          digestId,
          localDate,
          timezone,
          revision,
          input.completeness,
          inputWatermarkJson,
          contentJson,
          previous?.id ?? null,
          sourceHash,
          createdAt,
          createdAt
        );
      return { status: "created", digestId, revision, sourceHash };
    });
    return transaction.immediate();
  }

  readPublicSnapshot() {
    const read = this.db.transaction(() => {
      const parsePublicObject = (json) => {
        try {
          const value = JSON.parse(json);
          assertJsonObject(value, "public content");
          return value;
        } catch {
          throw codedError("MEMORY_PUBLIC_READ_CORRUPT");
        }
      };
      const evidenceStatement = this.db.prepare(
        `SELECT session_id, transcript_segment_id, started_at, ended_at,
                quote_text, audio_state
         FROM evidence_refs
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY started_at, ended_at, transcript_segment_id`
      );
      const evidenceFor = (entityType, entityId) =>
        evidenceStatement.all(entityType, entityId).map((row) => ({
          sessionId: row.session_id,
          segmentId: row.transcript_segment_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          quote: row.quote_text,
          audioState: row.audio_state,
        }));

      const memoryOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.started_at, occurrence.ended_at,
                occurrence.confidence, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM memory_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.memory_value_id = ?
         ORDER BY occurrence.created_at, occurrence.id`
      );
      const memories = this.db
        .prepare(
          `SELECT id, kind, title, body, confidence, lifecycle, provenance,
                  created_at, updated_at
           FROM memory_items_v2 ORDER BY updated_at DESC, id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          confidence: row.confidence,
          lifecycle: row.lifecycle,
          provenance: row.provenance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          occurrences: memoryOccurrences.all(row.id).map((occurrence) => ({
            id: occurrence.id,
            sessionId: occurrence.session_id,
            startedAt: occurrence.started_at,
            endedAt: occurrence.ended_at,
            confidence: occurrence.confidence,
            createdAt: occurrence.created_at,
            evidence: evidenceFor("memory_occurrence", occurrence.id),
          })),
        }));

      const topicRevisions = this.db.prepare(
        `SELECT id, revision, summary, provenance, created_at
         FROM topic_revisions WHERE topic_id = ? ORDER BY revision`
      );
      const topicOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.topic_revision_id, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM topic_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.topic_id = ? ORDER BY occurrence.created_at, occurrence.id`
      );
      const topics = this.db
        .prepare(
          `SELECT id, name, lifecycle, provenance, created_at, updated_at
           FROM topics_v2 ORDER BY updated_at DESC, id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          lifecycle: row.lifecycle,
          provenance: row.provenance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revisions: topicRevisions.all(row.id).map((revision) => ({
            id: revision.id,
            revision: revision.revision,
            summary: revision.summary,
            provenance: revision.provenance,
            createdAt: revision.created_at,
          })),
          occurrences: topicOccurrences.all(row.id).map((occurrence) => ({
            id: occurrence.id,
            sessionId: occurrence.session_id,
            revisionId: occurrence.topic_revision_id,
            createdAt: occurrence.created_at,
            evidence: evidenceFor("topic_occurrence", occurrence.id),
          })),
        }));

      const todoRevisions = this.db.prepare(
        `SELECT id, revision, title, due_text, provenance, created_at
         FROM todo_revisions WHERE todo_instance_id = ? ORDER BY revision`
      );
      const todoOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.todo_revision_id, occurrence.started_at,
                occurrence.ended_at, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM todo_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.todo_instance_id = ?
         ORDER BY occurrence.created_at, occurrence.id`
      );
      const todoTransitions = this.db.prepare(
        `SELECT id, from_status, to_status, reason, actor, occurred_at
         FROM todo_state_transitions WHERE todo_instance_id = ?
         ORDER BY occurred_at, id`
      );
      const todos = this.db
        .prepare(
          `SELECT todo.id, todo.title, todo.status, todo.completed_at, todo.dismissed_at,
                  todo.provenance, todo.created_at, todo.updated_at,
                  todo.owner_display_name_snapshot AS owner_label
           FROM todos_v2 AS todo ORDER BY todo.updated_at DESC, todo.id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          title: row.title,
          ownerLabel: row.owner_label,
          status: row.status,
          completedAt: row.completed_at,
          dismissedAt: row.dismissed_at,
          provenance: row.provenance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revisions: todoRevisions.all(row.id).map((revision) => ({
            id: revision.id,
            revision: revision.revision,
            title: revision.title,
            dueText: revision.due_text,
            provenance: revision.provenance,
            createdAt: revision.created_at,
          })),
          occurrences: todoOccurrences.all(row.id).map((occurrence) => ({
            id: occurrence.id,
            sessionId: occurrence.session_id,
            revisionId: occurrence.todo_revision_id,
            startedAt: occurrence.started_at,
            endedAt: occurrence.ended_at,
            createdAt: occurrence.created_at,
            evidence: evidenceFor("todo_occurrence", occurrence.id),
          })),
          transitions: todoTransitions.all(row.id).map((transition) => ({
            id: transition.id,
            fromStatus: transition.from_status,
            toStatus: transition.to_status,
            reason: transition.reason,
            actor: transition.actor,
            occurredAt: transition.occurred_at,
          })),
        }));

      const suggestionOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM suggestion_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.suggestion_id = ?
         ORDER BY occurrence.created_at, occurrence.id`
      );
      const suggestions = this.db
        .prepare(
          `SELECT id, title, rationale, state, provenance, decided_at, created_at, updated_at
           FROM suggestions_v2 ORDER BY updated_at DESC, id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          title: row.title,
          rationale: row.rationale,
          state: row.state,
          provenance: row.provenance,
          decidedAt: row.decided_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          occurrences: suggestionOccurrences.all(row.id).map((occurrence) => ({
            id: occurrence.id,
            sessionId: occurrence.session_id,
            createdAt: occurrence.created_at,
            evidence: evidenceFor("suggestion_occurrence", occurrence.id),
          })),
        }));

      const sessionSummaries = this.db
        .prepare(
          `SELECT id, session_id, revision, completeness, lifecycle, content_json,
                  provenance, created_at
           FROM session_summary_revisions ORDER BY created_at DESC, id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          revision: row.revision,
          completeness: row.completeness,
          lifecycle: row.lifecycle,
          content: parsePublicObject(row.content_json),
          provenance: row.provenance,
          createdAt: row.created_at,
          evidence: evidenceFor("session_summary_revision", row.id),
        }));

      const dailyDigests = this.db
        .prepare(
          `SELECT id, local_date, timezone, revision, completeness, lifecycle,
                  content_json, created_at, updated_at
           FROM daily_digests ORDER BY local_date DESC, timezone, revision DESC`
        )
        .all()
        .map((row) => ({
          id: row.id,
          localDate: row.local_date,
          timezone: row.timezone,
          revision: row.revision,
          completeness: row.completeness,
          lifecycle: row.lifecycle,
          content: parsePublicObject(row.content_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

      const conflictMembers = this.db.prepare(
        `SELECT item.id, item.title, item.body, item.lifecycle
         FROM memory_conflict_members AS member
         JOIN memory_items_v2 AS item ON item.id = member.memory_item_id
         WHERE member.group_id = ? ORDER BY item.created_at, item.id`
      );
      const memoryConflicts = this.db
        .prepare(
          `SELECT id, episode, state, selected_member_id, resolved_at, created_at, updated_at
           FROM memory_conflict_groups ORDER BY created_at DESC, id`
        )
        .all()
        .map((row) => ({
          id: row.id,
          episode: row.episode,
          state: row.state,
          selectedMemoryItemId: row.selected_member_id,
          resolvedAt: row.resolved_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          members: conflictMembers.all(row.id).map((member) => ({
            memoryItemId: member.id,
            title: member.title,
            body: member.body,
            lifecycle: member.lifecycle,
            selected: member.id === row.selected_member_id,
          })),
        }));

      return {
        memories,
        topics,
        todos,
        suggestions,
        sessionSummaries,
        dailyDigests,
        memoryConflicts,
      };
    });
    return read.deferred();
  }
}

module.exports = MemoryRepository;
