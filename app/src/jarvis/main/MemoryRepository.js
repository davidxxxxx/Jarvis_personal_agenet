const crypto = require("node:crypto");

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const CANONICAL_INPUT_VERSION = "jarvis-analysis-input-canonical-v2";
const PREPARE_TOKEN_VERSION = "jarvis-analysis-prepare-v1";
const MAX_CLOUD_PAYLOAD_BYTES = 96 * 1024;

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

function validateCandidateText(value) {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 4000;
}

function validateEvidenceIds(ids, { required, allowedSegmentIds }) {
  if (!Array.isArray(ids) || ids.length > 100 || (required && ids.length === 0)) {
    throw codedError(required ? "MEMORY_EVIDENCE_REQUIRED" : "MEMORY_CANDIDATE_INVALID");
  }
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw codedError("MEMORY_CANDIDATE_INVALID");
  }
  if (ids.some((id) => !allowedSegmentIds.has(id))) {
    throw codedError("MEMORY_EVIDENCE_OUT_OF_SCOPE");
  }
}

function validateCandidate(candidate, { allowedSegmentIds, allowedOwnerLabels }) {
  if (
    !hasExactKeys(candidate, [
      "schemaVersion",
      "sessionSummary",
      "memories",
      "topics",
      "todos",
      "suggestions",
    ]) ||
    candidate.schemaVersion !== "jarvis-analysis-v2" ||
    !Array.isArray(candidate.memories) ||
    !Array.isArray(candidate.topics) ||
    !Array.isArray(candidate.todos) ||
    !Array.isArray(candidate.suggestions) ||
    [candidate.memories, candidate.topics, candidate.todos, candidate.suggestions].some(
      (items) => items.length > 100
    )
  ) {
    throw codedError("MEMORY_CANDIDATE_INVALID");
  }
  const summary = candidate.sessionSummary;
  if (
    !hasExactKeys(summary, ["title", "summary", "evidenceSegmentIds"]) ||
    !validateCandidateText(summary.title) ||
    !validateCandidateText(summary.summary)
  ) {
    throw codedError("MEMORY_CANDIDATE_INVALID");
  }
  validateEvidenceIds(summary.evidenceSegmentIds, { required: true, allowedSegmentIds });

  for (const memory of candidate.memories) {
    if (
      !hasExactKeys(memory, ["kind", "title", "body", "confidence", "evidenceSegmentIds"]) ||
      !new Set(["fact", "event", "decision", "commitment", "preference", "relationship"]).has(
        memory.kind
      ) ||
      !validateCandidateText(memory.title) ||
      !validateCandidateText(memory.body) ||
      typeof memory.confidence !== "number" ||
      !Number.isFinite(memory.confidence) ||
      memory.confidence < 0 ||
      memory.confidence > 1
    ) {
      throw codedError("MEMORY_CANDIDATE_INVALID");
    }
    validateEvidenceIds(memory.evidenceSegmentIds, { required: true, allowedSegmentIds });
  }
  for (const topic of candidate.topics) {
    if (
      !hasExactKeys(topic, ["name", "summary", "evidenceSegmentIds"]) ||
      !validateCandidateText(topic.name) ||
      !validateCandidateText(topic.summary)
    ) {
      throw codedError("MEMORY_CANDIDATE_INVALID");
    }
    validateEvidenceIds(topic.evidenceSegmentIds, { required: true, allowedSegmentIds });
  }
  for (const todo of candidate.todos) {
    if (
      !hasExactKeys(todo, ["title", "ownerLabel", "dueText", "evidenceSegmentIds"]) ||
      !validateCandidateText(todo.title) ||
      (todo.ownerLabel !== null &&
        (typeof todo.ownerLabel !== "string" || !allowedOwnerLabels.has(todo.ownerLabel))) ||
      (todo.dueText !== null &&
        (typeof todo.dueText !== "string" || Array.from(todo.dueText).length > 500))
    ) {
      if (
        todo?.ownerLabel !== null &&
        typeof todo?.ownerLabel === "string" &&
        !allowedOwnerLabels.has(todo.ownerLabel)
      ) {
        throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");
      }
      throw codedError("MEMORY_CANDIDATE_INVALID");
    }
    validateEvidenceIds(todo.evidenceSegmentIds, { required: true, allowedSegmentIds });
  }
  for (const suggestion of candidate.suggestions) {
    if (
      !hasExactKeys(suggestion, ["title", "rationale", "basedOnEvidenceSegmentIds"]) ||
      !validateCandidateText(suggestion.title) ||
      !validateCandidateText(suggestion.rationale)
    ) {
      throw codedError("MEMORY_CANDIDATE_INVALID");
    }
    validateEvidenceIds(suggestion.basedOnEvidenceSegmentIds, {
      required: false,
      allowedSegmentIds,
    });
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
    const segments = segmentIds.map((segmentId, ordinal) => {
      const segment = this.db
        .prepare(
          `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                  segment.version, segment.text, segment.person_id, segment.result_kind,
                  segment.is_stable, segment.superseded_by, segment.duplicate_of,
                  track.device_label
           FROM transcript_segments AS segment
           LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
           WHERE segment.id = ?`
        )
        .get(segmentId);
      if (
        !segment ||
        segment.session_id !== sessionId ||
        segment.result_kind !== "final" ||
        segment.is_stable !== 1 ||
        segment.superseded_by !== null ||
        segment.duplicate_of !== null ||
        typeof segment.text !== "string" ||
        segment.text.length === 0
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
        return { status: "existing", analysisInputId: existing.id, inputHash };
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
      return { status: "created", analysisInputId, inputHash };
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
        `SELECT id, started_at, ended_at, confidence, created_at
         FROM memory_occurrences WHERE memory_value_id = ?
         ORDER BY created_at, id`
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
        `SELECT id, topic_revision_id, created_at
         FROM topic_occurrences WHERE topic_id = ? ORDER BY created_at, id`
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
        `SELECT id, todo_revision_id, started_at, ended_at, created_at
         FROM todo_occurrences WHERE todo_instance_id = ? ORDER BY created_at, id`
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
        `SELECT id, created_at FROM suggestion_occurrences
         WHERE suggestion_id = ? ORDER BY created_at, id`
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
