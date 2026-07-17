const crypto = require("node:crypto");
const { AnalysisSchemaError, validateCandidateAnalysis } = require("./JarvisAnalysisSchema");
const {
  MemoryMerger,
  canonicalizeText,
  canonicalTupleHash,
  normalizeStringSet,
  semanticCandidateHash,
} = require("./MemoryMerger");
const { resolveLocalDate } = require("./ZonedCalendar");
const { compileRedactionTerms } = require("./AnalysisInputBuilder");
const { MAX_DAILY_DIGEST_INPUT_BYTES } = require("./DailyDigestContractLimits");
const {
  DAILY_DIGEST_SCHEMA_VERSION,
  validateCandidateDailyDigest,
} = require("./DailyDigestSchema");
const {
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
} = require("../shared/contracts");

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const CANONICAL_INPUT_VERSION = "jarvis-analysis-input-canonical-v2";
const PREPARE_TOKEN_VERSION = "jarvis-analysis-prepare-v1";
const LEGACY_IMPORTER_VERSION = "jarvis-legacy-analysis-v1";
const MAX_CLOUD_PAYLOAD_BYTES = 96 * 1024;
const MAX_ANALYSIS_CANDIDATE_BYTES = 512 * 1024;
const MAX_DAILY_DIGEST_CANDIDATE_BYTES = 512 * 1024;
const DAILY_DIGEST_INPUT_CONTRACT_VERSION = "jarvis-daily-digest-input-v1";
const DAILY_DIGEST_WATERMARK_VERSION = "jarvis-daily-digest-watermark-v1";
const PUBLIC_SNAPSHOT_LIST_LIMIT = 101;
const PUBLIC_SNAPSHOT_HISTORY_LIMIT = 20;
const PUBLIC_SNAPSHOT_EVIDENCE_LIMIT = 8;
const PUBLIC_ANALYSIS_ERROR_CODES = new Set([
  "analysis_runtime_not_ready",
  "analysis_input_empty",
  "analysis_input_invalid",
  "analysis_input_state_invalid",
  "analysis_desired_head_invalid",
  "analysis_cloud_job_invalid",
  "analysis_failed",
  "offline",
  "budget_exceeded",
  "usage_unknown",
  "over_limit",
  "rate_limit",
  "invalid_response",
]);
const OFFLINE_ANALYSIS_ERROR_CODES = new Set(["network", "service_unavailable", "timeout"]);
const BUDGET_ANALYSIS_ERROR_CODES = new Set(["analysis_budget_denied", "budget_unavailable"]);
const RUNTIME_ANALYSIS_ERROR_CODES = new Set([
  "analysis_deferred_for_local_work",
  "analysis_configuration_required",
  "configuration",
]);
const INVALID_ANALYSIS_ERROR_CODES = new Set([
  "invalid_json",
  "invalid_structure",
  "ANALYSIS_RESPONSE_INVALID",
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicAnalysisErrorCode(errorCode, blockedReason, fallback = "analysis_failed") {
  const raw = errorCode ?? blockedReason;
  if (PUBLIC_ANALYSIS_ERROR_CODES.has(raw)) return raw;
  if (OFFLINE_ANALYSIS_ERROR_CODES.has(raw)) return "offline";
  if (BUDGET_ANALYSIS_ERROR_CODES.has(raw)) return "budget_exceeded";
  if (raw === "analysis_usage_unknown") return "usage_unknown";
  if (RUNTIME_ANALYSIS_ERROR_CODES.has(raw)) return "analysis_runtime_not_ready";
  if (INVALID_ANALYSIS_ERROR_CODES.has(raw)) return "invalid_response";
  return fallback;
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

function compileDigestRedactor(redactionTerms) {
  const redactAnalysisText = compileRedactionTerms(redactionTerms);
  return (value) => redactAnalysisText(String(value)).replace(/\[SECRET\]/gu, "[REDACTED_SECRET]");
}

function digestFreeTextIsRedacted(value, redact, textContext = false) {
  if (typeof value === "string") {
    return !textContext || redact(value) === value;
  }
  if (Array.isArray(value)) {
    return value.every((item) => digestFreeTextIsRedacted(item, redact, textContext));
  }
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, item]) =>
    digestFreeTextIsRedacted(item, redact, key === "text" || key === "alternatives")
  );
}

function pseudonymousRef(kind, value) {
  return `${kind}-${sha256(`${kind}:${value}`).slice(0, 16)}`;
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

function assertExactPlainObject(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  if (!hasExactKeys(value, expected)) {
    throw new TypeError(`${name} must be a plain object with exact keys`);
  }
  return value;
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
  constructor(db, { createId, now, validateRedactedCloudPayload, memoryMerger } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("database must be a live better-sqlite3 connection");
    }
    if (db.open === false) throw new TypeError("database must be open");
    if (typeof createId !== "function") throw new TypeError("createId must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof validateRedactedCloudPayload !== "function") {
      throw new TypeError("validateRedactedCloudPayload must be a function");
    }
    if (memoryMerger !== undefined && (!memoryMerger || typeof memoryMerger.plan !== "function")) {
      throw new TypeError("memoryMerger must expose plan()");
    }
    this.db = db;
    this.createId = createId;
    this.now = now;
    this.validateRedactedCloudPayload = validateRedactedCloudPayload;
    this.memoryMerger = memoryMerger ?? new MemoryMerger();
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

  _mapDailyDigestInput(row, status = "existing") {
    if (!row) return null;
    let inputWatermark;
    let cloudPayload;
    try {
      inputWatermark = JSON.parse(row.input_watermark_json);
      cloudPayload = JSON.parse(row.cloud_payload_json);
    } catch {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    const canonicalWatermark = canonicalJson(inputWatermark);
    const canonicalPayload = canonicalJson(cloudPayload);
    const tuple = {
      contractVersion: row.contract_version,
      localDate: row.local_date,
      timezone: row.timezone,
      completeness: row.completeness,
      inputWatermark,
      cloudPayload,
    };
    const rebuiltHash = sha256(canonicalJson(tuple));
    if (
      row.contract_version !== DAILY_DIGEST_INPUT_CONTRACT_VERSION ||
      canonicalWatermark !== row.input_watermark_json ||
      canonicalPayload !== row.cloud_payload_json ||
      Buffer.byteLength(row.cloud_payload_json, "utf8") !== row.input_bytes ||
      !safeHashEqual(rebuiltHash, row.source_hash)
    ) {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    return {
      status,
      digestInputId: row.id,
      localDate: row.local_date,
      timezone: row.timezone,
      sourceHash: row.source_hash,
      contractVersion: row.contract_version,
      completeness: row.completeness,
      inputWatermark,
      inputWatermarkJson: row.input_watermark_json,
      cloudPayload,
      cloudPayloadJson: row.cloud_payload_json,
      inputBytes: row.input_bytes,
      modelVersion: row.model_version,
      createdAt: row.created_at,
    };
  }

  _dailyDigestRedactionTerms({ startsAt, endsAt }, segments) {
    const confirmedPeople = this.db
      .prepare(
        `SELECT display_name AS value FROM people
         WHERE length(trim(display_name)) > 0
         ORDER BY display_name`
      )
      .all()
      .map((row) => row.value);
    const localClusterLabels = this.db
      .prepare(
        `WITH active_manifest AS (
           SELECT id FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND result_kind = 'final' AND is_stable = 1
             AND superseded_by IS NULL AND duplicate_of IS NULL
         )
         SELECT DISTINCT cluster.local_label AS value
         FROM active_manifest AS manifest
         JOIN speaker_cluster_segments AS link
           ON link.transcript_segment_id = manifest.id
         JOIN speaker_clusters AS cluster ON cluster.id = link.cluster_id
         WHERE length(trim(cluster.local_label)) > 0
         ORDER BY cluster.local_label`
      )
      .all(endsAt, startsAt)
      .map((row) => row.value);
    const localSpeakerLabels = segments.map((segment) => segment.speaker_label);
    const localDeviceLabels = segments.flatMap((segment) => [
      segment.device_id,
      segment.device_label,
    ]);
    return {
      participants: [],
      otherPeople: [...confirmedPeople, ...localClusterLabels, ...localSpeakerLabels],
      deviceLabels: localDeviceLabels,
    };
  }

  _dailyEvidenceSections({ startsAt, endsAt }, allowedSegmentIds, redact) {
    const grouped = (rows, mapper) => {
      const groups = new Map();
      for (const row of rows) {
        let current = groups.get(row.entity_id);
        if (!current) {
          current = { row, evidenceSegmentIds: [] };
          groups.set(row.entity_id, current);
        }
        if (!current.evidenceSegmentIds.includes(row.transcript_segment_id)) {
          current.evidenceSegmentIds.push(row.transcript_segment_id);
        }
      }
      const result = [...groups.values()]
        .sort((left, right) => left.row.entity_id.localeCompare(right.row.entity_id))
        .map(({ row, evidenceSegmentIds }) => mapper(row, evidenceSegmentIds.sort()));
      for (const item of result) {
        for (const segmentId of item.evidenceSegmentIds) {
          if (!allowedSegmentIds.has(segmentId)) {
            throw codedError("DAILY_DIGEST_EVIDENCE_OUT_OF_SCOPE");
          }
        }
      }
      return result;
    };
    const memoryRows = this.db
      .prepare(
        `WITH active_manifest AS (
           SELECT id FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND result_kind = 'final' AND is_stable = 1
             AND superseded_by IS NULL AND duplicate_of IS NULL
         )
         SELECT ref.entity_id, ref.transcript_segment_id,
                item.id AS item_id, item.kind, item.title, item.body
         FROM evidence_refs AS ref
         JOIN active_manifest AS manifest ON manifest.id = ref.transcript_segment_id
         JOIN memory_occurrences AS occurrence
           ON ref.entity_type = 'memory_occurrence' AND occurrence.id = ref.entity_id
         JOIN memory_items_v2 AS item ON item.id = occurrence.memory_value_id
         WHERE ref.started_at < ? AND ref.ended_at > ?
           AND item.lifecycle IN ('active','conflict')
         ORDER BY ref.entity_id, ref.transcript_segment_id`
      )
      .all(endsAt, startsAt, endsAt, startsAt);
    const memoryItems = grouped(memoryRows, (row, evidenceSegmentIds) => ({
      kind: row.kind,
      itemRef: pseudonymousRef("memory", row.item_id),
      text: redact(`${row.title}: ${row.body}`),
      evidenceSegmentIds,
    }));
    const selectMemoryKind = (kind) =>
      memoryItems.filter((item) => item.kind === kind).map(({ kind: _kind, ...item }) => item);
    const decisions = selectMemoryKind("decision");
    const commitments = selectMemoryKind("commitment");

    const topicRows = this.db
      .prepare(
        `WITH active_manifest AS (
           SELECT id FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND result_kind = 'final' AND is_stable = 1
             AND superseded_by IS NULL AND duplicate_of IS NULL
         )
         SELECT ref.entity_id, ref.transcript_segment_id, topic.id AS topic_id,
                topic.name, revision.summary
         FROM evidence_refs AS ref
         JOIN active_manifest AS manifest ON manifest.id = ref.transcript_segment_id
         JOIN topic_occurrences AS occurrence
           ON ref.entity_type = 'topic_occurrence' AND occurrence.id = ref.entity_id
         JOIN topics_v2 AS topic ON topic.id = occurrence.topic_id
         JOIN topic_revisions AS revision ON revision.id = occurrence.topic_revision_id
         WHERE ref.started_at < ? AND ref.ended_at > ?
           AND topic.lifecycle = 'active'
         ORDER BY ref.entity_id, ref.transcript_segment_id`
      )
      .all(endsAt, startsAt, endsAt, startsAt);
    const topics = grouped(topicRows, (row, evidenceSegmentIds) => ({
      topicRef: pseudonymousRef("topic", row.topic_id),
      text: redact(row.summary ? `${row.name}: ${row.summary}` : row.name),
      evidenceSegmentIds,
    }));

    const todoRows = this.db
      .prepare(
        `WITH active_manifest AS (
           SELECT id FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND result_kind = 'final' AND is_stable = 1
             AND superseded_by IS NULL AND duplicate_of IS NULL
         )
         SELECT ref.entity_id, ref.transcript_segment_id, todo.id AS todo_id,
                todo.status, revision.title, revision.due_text
         FROM evidence_refs AS ref
         JOIN active_manifest AS manifest ON manifest.id = ref.transcript_segment_id
         JOIN todo_occurrences AS occurrence
           ON ref.entity_type = 'todo_occurrence' AND occurrence.id = ref.entity_id
         JOIN todos_v2 AS todo ON todo.id = occurrence.todo_instance_id
         JOIN todo_revisions AS revision ON revision.id = occurrence.todo_revision_id
         WHERE ref.started_at < ? AND ref.ended_at > ?
           AND todo.status IN ('open','completed')
         ORDER BY ref.entity_id, ref.transcript_segment_id`
      )
      .all(endsAt, startsAt, endsAt, startsAt);
    const todos = grouped(todoRows, (row, evidenceSegmentIds) => ({
      todoRef: pseudonymousRef("todo", row.todo_id),
      text: redact(row.due_text ? `${row.title} (${row.due_text})` : row.title),
      status: row.status,
      evidenceSegmentIds,
    }));

    const conflictRows = this.db
      .prepare(
        `WITH active_manifest AS (
           SELECT id FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND result_kind = 'final' AND is_stable = 1
             AND superseded_by IS NULL AND duplicate_of IS NULL
         )
         SELECT conflict.id AS entity_id, ref.transcript_segment_id,
                item.id AS item_id, item.title, item.body
         FROM memory_conflict_groups AS conflict
         JOIN memory_conflict_members AS member ON member.group_id = conflict.id
         JOIN memory_items_v2 AS item ON item.id = member.memory_item_id
         JOIN memory_occurrences AS occurrence ON occurrence.memory_value_id = item.id
         JOIN evidence_refs AS ref
           ON ref.entity_type = 'memory_occurrence' AND ref.entity_id = occurrence.id
         JOIN active_manifest AS manifest ON manifest.id = ref.transcript_segment_id
         WHERE conflict.state = 'open'
           AND ref.started_at < ? AND ref.ended_at > ?
         ORDER BY conflict.id, item.id, ref.transcript_segment_id`
      )
      .all(endsAt, startsAt, endsAt, startsAt);
    const conflictsById = new Map();
    for (const row of conflictRows) {
      let conflict = conflictsById.get(row.entity_id);
      if (!conflict) {
        conflict = {
          conflictRef: pseudonymousRef("conflict", row.entity_id),
          alternatives: [],
          evidenceSegmentIds: [],
        };
        conflictsById.set(row.entity_id, conflict);
      }
      const text = redact(`${row.title}: ${row.body}`);
      if (!conflict.alternatives.includes(text)) conflict.alternatives.push(text);
      if (!conflict.evidenceSegmentIds.includes(row.transcript_segment_id)) {
        conflict.evidenceSegmentIds.push(row.transcript_segment_id);
      }
    }
    const unresolvedConflicts = [...conflictsById.values()].map((conflict) => ({
      ...conflict,
      alternatives: conflict.alternatives.sort(),
      evidenceSegmentIds: conflict.evidenceSegmentIds.sort(),
    }));
    for (const conflict of unresolvedConflicts) {
      for (const segmentId of conflict.evidenceSegmentIds) {
        if (!allowedSegmentIds.has(segmentId)) {
          throw codedError("DAILY_DIGEST_EVIDENCE_OUT_OF_SCOPE");
        }
      }
    }
    return {
      topics,
      decisions,
      commitments,
      todosCreated: todos.filter((todo) => todo.status === "open"),
      todosCompleted: todos.filter((todo) => todo.status === "completed"),
      unresolvedConflicts,
    };
  }

  createDailyDigestInput(input) {
    assertExactPlainObject(input, ["localDate", "timezone", "modelVersion"], "daily digest input");
    const { localDate, timezone, modelVersion } = input;
    const boundary = resolveLocalDate({ localDate, timezone });
    const safeModelVersion = assertText(modelVersion, "modelVersion", 128);
    const transaction = this.db.transaction(() => {
      const segments = this.db
        .prepare(
          `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                  segment.text, segment.version, segment.person_id, segment.speaker_label,
                  person.is_self, session.processing_state, session.timeline_version,
                  session.ready_at, track.device_id, track.device_label
           FROM transcript_segments AS segment
           JOIN sessions AS session ON session.id = segment.session_id
           LEFT JOIN people AS person ON person.id = segment.person_id
           LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
           WHERE segment.started_at < ? AND segment.ended_at > ?
             AND segment.result_kind = 'final'
             AND segment.is_stable = 1
             AND segment.superseded_by IS NULL
             AND segment.duplicate_of IS NULL
           ORDER BY segment.started_at, segment.id`
        )
        .all(boundary.endsAt, boundary.startsAt);
      if (segments.length === 0) {
        return { status: "empty", localDate: boundary.localDate, timezone: boundary.timezone };
      }
      const redactionTerms = this._dailyDigestRedactionTerms(boundary, segments);
      const redact = compileDigestRedactor(redactionTerms);

      const sessionsById = new Map();
      const interactionsByRef = new Map();
      for (const segment of segments) {
        const sessionRef = pseudonymousRef("session", segment.session_id);
        let session = sessionsById.get(segment.session_id);
        if (!session) {
          session = {
            sessionRef,
            processingState: segment.processing_state,
            timelineVersion: segment.timeline_version,
            readyAt: segment.ready_at,
            segments: [],
          };
          sessionsById.set(segment.session_id, session);
        }
        const subjectRef =
          segment.is_self === 1
            ? "SELF"
            : pseudonymousRef(
                "subject",
                segment.person_id ?? `${segment.session_id}:${segment.speaker_label}`
              );
        const text = redact(segment.text);
        session.segments.push({
          segmentId: segment.id,
          startedAt: segment.started_at,
          endedAt: segment.ended_at,
          subjectRef,
          text,
        });
        let interaction = interactionsByRef.get(subjectRef);
        if (!interaction) {
          interaction = { subjectRef, sessionRefs: [], evidenceSegmentIds: [] };
          interactionsByRef.set(subjectRef, interaction);
        }
        if (!interaction.sessionRefs.includes(sessionRef)) interaction.sessionRefs.push(sessionRef);
        interaction.evidenceSegmentIds.push(segment.id);
      }
      const sessions = [...sessionsById.values()].sort((left, right) =>
        left.sessionRef.localeCompare(right.sessionRef)
      );
      const peopleInteractions = [...interactionsByRef.values()]
        .sort((left, right) => left.subjectRef.localeCompare(right.subjectRef))
        .map((interaction) => ({
          ...interaction,
          sessionRefs: interaction.sessionRefs.sort(),
          evidenceSegmentIds: interaction.evidenceSegmentIds.sort(),
        }));

      const rawSessionIds = [...sessionsById.keys()].sort();
      const placeholders = rawSessionIds.map(() => "?").join(",");
      const pendingUpstreamRows = this.db
        .prepare(
          `SELECT session_id, job_type, input_hash, input_version, model_version
           FROM processing_jobs
           WHERE session_id IN (${placeholders})
             AND job_type <> 'generate_daily_digest'
             AND completed_at IS NULL
             AND state NOT IN (
               'completed','failed','cancelled','superseded','audio_expired_before_processing'
             )
           ORDER BY session_id, job_type, input_hash, input_version, model_version`
        )
        .all(...rawSessionIds);
      const incompleteSegmentCount = this.db
        .prepare(
          `SELECT count(*) AS count
           FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND superseded_by IS NULL
             AND duplicate_of IS NULL
             AND (
               result_kind <> 'final' OR is_stable <> 1
             )`
        )
        .get(boundary.endsAt, boundary.startsAt).count;
      const completeness =
        pendingUpstreamRows.length > 0 ||
        incompleteSegmentCount > 0 ||
        sessions.some((session) => session.processingState !== "ready")
          ? "partial"
          : "final";
      const transcriptCoverage = {
        selectedSegmentCount: segments.length,
        incompleteSegmentCount,
        sessionCount: sessions.length,
        startsAt: Math.min(...segments.map((segment) => segment.started_at)),
        endsAt: Math.max(...segments.map((segment) => segment.ended_at)),
      };
      const allowedSegmentIds = new Set(segments.map((segment) => segment.id));
      const evidenceSections = this._dailyEvidenceSections(boundary, allowedSegmentIds, redact);
      const sections = {
        sessions,
        peopleInteractions,
        topics: evidenceSections.topics,
        decisions: evidenceSections.decisions,
        commitments: evidenceSections.commitments,
        todosCreated: evidenceSections.todosCreated,
        todosCompleted: evidenceSections.todosCompleted,
        unresolvedConflicts: evidenceSections.unresolvedConflicts,
        transcriptCoverage,
      };
      const inputWatermark = {
        schemaVersion: DAILY_DIGEST_WATERMARK_VERSION,
        localDate: boundary.localDate,
        timezone: boundary.timezone,
        startsAt: boundary.startsAt,
        endsAt: boundary.endsAt,
        evidence: segments.map((segment) => ({
          segmentId: segment.id,
          version: segment.version,
          textHash: sha256(segment.text),
          startedAt: segment.started_at,
          endedAt: segment.ended_at,
        })),
        sessionStates: sessions.map((session) => ({
          sessionRef: session.sessionRef,
          processingState: session.processingState,
          timelineVersion: session.timelineVersion,
          readyAt: session.readyAt,
        })),
        pendingUpstreamJobs: pendingUpstreamRows.map((job) => ({
          sessionRef: pseudonymousRef("session", job.session_id),
          jobType: job.job_type,
          inputHash: job.input_hash,
          inputVersion: job.input_version,
          modelVersion: job.model_version,
        })),
      };
      const cloudPayload = {
        schemaVersion: DAILY_DIGEST_INPUT_CONTRACT_VERSION,
        localDate: boundary.localDate,
        timezone: boundary.timezone,
        completeness,
        sections,
      };
      if (!digestFreeTextIsRedacted(cloudPayload, redact)) {
        throw codedError("DAILY_DIGEST_REDACTION_UNVERIFIED");
      }
      const inputWatermarkJson = canonicalJson(inputWatermark);
      const cloudPayloadJson = canonicalJson(cloudPayload);
      const inputBytes = Buffer.byteLength(cloudPayloadJson, "utf8");
      if (inputBytes > MAX_DAILY_DIGEST_INPUT_BYTES) {
        throw codedError("DAILY_DIGEST_INPUT_TOO_LARGE");
      }
      const sourceHash = sha256(
        canonicalJson({
          contractVersion: DAILY_DIGEST_INPUT_CONTRACT_VERSION,
          localDate: boundary.localDate,
          timezone: boundary.timezone,
          completeness,
          inputWatermark,
          cloudPayload,
        })
      );
      const existing = this.db
        .prepare("SELECT * FROM daily_digest_inputs WHERE source_hash = ?")
        .get(sourceHash);
      if (existing) {
        if (
          existing.local_date !== boundary.localDate ||
          existing.timezone !== boundary.timezone ||
          existing.contract_version !== DAILY_DIGEST_INPUT_CONTRACT_VERSION ||
          existing.completeness !== completeness ||
          existing.input_watermark_json !== inputWatermarkJson ||
          existing.cloud_payload_json !== cloudPayloadJson ||
          existing.input_bytes !== inputBytes
        ) {
          throw codedError("DAILY_DIGEST_SOURCE_HASH_COLLISION");
        }
        return this._mapDailyDigestInput(existing, "existing");
      }
      const digestInputId = this._nextId("daily_digest_input");
      const createdAt = assertTimestamp(this.now(), "createdAt");
      this.db
        .prepare(
          `INSERT INTO daily_digest_inputs (
             id, local_date, timezone, source_hash, contract_version, completeness,
             input_watermark_json, cloud_payload_json, input_bytes, model_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          digestInputId,
          boundary.localDate,
          boundary.timezone,
          sourceHash,
          DAILY_DIGEST_INPUT_CONTRACT_VERSION,
          completeness,
          inputWatermarkJson,
          cloudPayloadJson,
          inputBytes,
          safeModelVersion,
          createdAt
        );
      return this._mapDailyDigestInput(
        this.db.prepare("SELECT * FROM daily_digest_inputs WHERE id = ?").get(digestInputId),
        "created"
      );
    });
    return transaction.immediate();
  }

  getDailyDigestInput(inputId) {
    const id = assertId(inputId, "digestInputId");
    return this._mapDailyDigestInput(
      this.db.prepare("SELECT * FROM daily_digest_inputs WHERE id = ?").get(id)
    );
  }

  getDailyDigestInputBySourceHash(sourceHash) {
    const hash = assertHash(sourceHash, "sourceHash");
    return this._mapDailyDigestInput(
      this.db.prepare("SELECT * FROM daily_digest_inputs WHERE source_hash = ?").get(hash)
    );
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

  getAnalysisAdmissionManifest(analysisInputId) {
    const id = assertId(analysisInputId, "analysisInputId");
    const read = this.db.transaction(() => {
      const stored = this._loadStoredAnalysisInput(id);
      if (!stored) return null;
      const session = this.db
        .prepare("SELECT id, status, processing_state FROM sessions WHERE id = ?")
        .get(stored.row.session_id);
      if (!session) throw codedError("MEMORY_INPUT_CORRUPT");
      const bindings = new Map(
        stored.prepared.speakerBindings.map((binding) => [binding.label, binding])
      );
      return {
        manifestVersion: 1,
        sessionId: session.id,
        sessionState:
          session.status === "completed"
            ? "ended"
            : session.status === "recovered"
              ? "recovered_terminal"
              : "active",
        processingState: session.processing_state,
        segments: stored.prepared.segments.map((segment) => {
          const live = this.db
            .prepare(
              `SELECT result_kind, is_stable, superseded_by, duplicate_of
               FROM transcript_segments WHERE id = ?`
            )
            .get(segment.segmentId);
          if (!live) throw codedError("MEMORY_INPUT_CORRUPT");
          const binding = bindings.get(segment.speakerBindingLabel);
          return {
            ordinal: segment.ordinal,
            segmentId: segment.segmentId,
            segmentVersion: segment.segmentVersion,
            textHash: segment.textHash,
            final: live.result_kind === "final",
            stable: live.is_stable === 1,
            current: live.superseded_by === null,
            duplicate: live.duplicate_of !== null,
            identityKind:
              binding?.subjectKind === "person"
                ? "durable_subject"
                : binding
                  ? "temporary_subject"
                  : "unresolved",
          };
        }),
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

  getAnalysisWorkState(sessionId) {
    const id = assertId(sessionId, "sessionId");
    const read = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT head.updated_at AS head_updated_at, input.applied_at,
                  job.state, job.error_code, job.blocked_reason, job.next_retry_at,
                  job.attempt_count, job.created_at, job.completed_at
           FROM analysis_desired_heads AS head
           JOIN analysis_inputs AS input
             ON input.id = head.analysis_input_id
            AND input.session_id = head.session_id
            AND input.input_hash = head.analysis_input_hash
           LEFT JOIN processing_jobs AS job
             ON job.session_id = head.session_id
            AND job.job_type = 'analyze_session'
            AND job.lane = 'cloud'
            AND job.analysis_input_id = head.analysis_input_id
            AND job.input_hash = head.analysis_input_hash
            AND job.desired_head_hash = head.desired_vector_hash
            AND job.model_version = json_extract(
              head.desired_vector_json, '$.modelVersion'
            )
            AND job.input_version = 1
            AND job.track_id IS NULL
            AND job.chunk_id IS NULL
            AND job.digest_input_id IS NULL
           WHERE head.session_id = ?`
        )
        .get(id);
      if (!row) {
        return {
          state: "waiting",
          retryable: false,
          errorCode: null,
          nextRetryAt: null,
          attemptCount: 0,
          updatedAt: null,
        };
      }
      if (row.state === null) {
        return {
          state: "retry_needed",
          retryable: true,
          errorCode: "analysis_runtime_not_ready",
          nextRetryAt: null,
          attemptCount: 0,
          updatedAt: row.head_updated_at,
        };
      }

      const attemptCount =
        Number.isSafeInteger(row.attempt_count) && row.attempt_count >= 0 ? row.attempt_count : 0;
      if (row.state === "pending") {
        return {
          state: "queued",
          retryable: false,
          errorCode: null,
          nextRetryAt: null,
          attemptCount,
          updatedAt: Number.isSafeInteger(row.created_at) ? row.created_at : null,
        };
      }
      if (row.state === "running") {
        return {
          state: "analyzing",
          retryable: false,
          errorCode: null,
          nextRetryAt: null,
          attemptCount,
          updatedAt: null,
        };
      }
      if (row.state === "retry") {
        return {
          state: "retry_needed",
          retryable: true,
          errorCode: publicAnalysisErrorCode(
            row.error_code,
            row.blocked_reason,
            "analysis_runtime_not_ready"
          ),
          nextRetryAt: Number.isSafeInteger(row.next_retry_at) ? row.next_retry_at : null,
          attemptCount,
          updatedAt: null,
        };
      }
      if (row.state === "completed") {
        const ready = row.applied_at !== null;
        return {
          state: ready ? "ready" : "blocked",
          retryable: false,
          errorCode: ready ? null : "analysis_failed",
          nextRetryAt: null,
          attemptCount,
          updatedAt: Number.isSafeInteger(row.completed_at) ? row.completed_at : null,
        };
      }
      return {
        state: "blocked",
        retryable: false,
        errorCode: publicAnalysisErrorCode(row.error_code, row.blocked_reason),
        nextRetryAt: null,
        attemptCount,
        updatedAt: Number.isSafeInteger(row.completed_at) ? row.completed_at : null,
      };
    });
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

  _dailyDigestCandidateContext(storedInput) {
    const sections = storedInput?.cloudPayload?.sections;
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    if (!Array.isArray(sections.sessions) || !Array.isArray(sections.peopleInteractions)) {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    const allowedSegmentIds = new Set();
    const segmentSubjectById = new Map();
    for (const session of sections.sessions) {
      if (!session || typeof session !== "object" || !Array.isArray(session.segments)) {
        throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
      }
      for (const segment of session.segments) {
        if (
          !segment ||
          typeof segment !== "object" ||
          typeof segment.segmentId !== "string" ||
          segment.segmentId.length === 0 ||
          typeof segment.subjectRef !== "string" ||
          segment.subjectRef.length === 0 ||
          allowedSegmentIds.has(segment.segmentId)
        ) {
          throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
        }
        allowedSegmentIds.add(segment.segmentId);
        segmentSubjectById.set(segment.segmentId, segment.subjectRef);
      }
    }
    const allowedSubjectRefs = new Set();
    const subjectEvidenceByRef = new Map();
    for (const interaction of sections.peopleInteractions) {
      if (
        !interaction ||
        typeof interaction !== "object" ||
        typeof interaction.subjectRef !== "string" ||
        interaction.subjectRef.length === 0 ||
        !Array.isArray(interaction.evidenceSegmentIds) ||
        interaction.evidenceSegmentIds.length === 0 ||
        allowedSubjectRefs.has(interaction.subjectRef)
      ) {
        throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
      }
      const evidence = new Set();
      for (const segmentId of interaction.evidenceSegmentIds) {
        if (
          typeof segmentId !== "string" ||
          !allowedSegmentIds.has(segmentId) ||
          segmentSubjectById.get(segmentId) !== interaction.subjectRef ||
          evidence.has(segmentId)
        ) {
          throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
        }
        evidence.add(segmentId);
      }
      allowedSubjectRefs.add(interaction.subjectRef);
      subjectEvidenceByRef.set(interaction.subjectRef, evidence);
    }
    if (
      allowedSegmentIds.size === 0 ||
      [...segmentSubjectById].some(
        ([segmentId, subjectRef]) => !subjectEvidenceByRef.get(subjectRef)?.has(segmentId)
      )
    ) {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    return {
      allowedSegmentIds,
      allowedSubjectRefs,
      subjectEvidenceByRef,
      completeness: storedInput.completeness,
      transcriptCoverage: sections.transcriptCoverage,
    };
  }

  persistValidatedDailyDigestCandidate(input) {
    assertExactPlainObject(
      input,
      ["jobId", "digestInputId", "budgetAttemptId", "candidate"],
      "validated daily digest candidate"
    );
    const jobId = assertId(input.jobId, "jobId");
    const digestInputId = assertId(input.digestInputId, "digestInputId");
    const budgetAttemptId = assertId(input.budgetAttemptId, "budgetAttemptId");
    assertJsonObject(input.candidate, "candidate");

    const transaction = this.db.transaction(() => {
      const storedInput = this.getDailyDigestInput(digestInputId);
      if (!storedInput) throw codedError("MEMORY_DAILY_DIGEST_INPUT_NOT_FOUND");
      const candidate = validateCandidateDailyDigest(
        input.candidate,
        this._dailyDigestCandidateContext(storedInput)
      );
      const candidateJson = canonicalJson(candidate);
      const candidateBytes = Buffer.byteLength(candidateJson, "utf8");
      if (candidateBytes > MAX_DAILY_DIGEST_CANDIDATE_BYTES) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_TOO_LARGE");
      }
      const candidateHash = sha256(candidateJson);
      const job = this.db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(jobId);
      if (
        !job ||
        job.job_type !== "generate_daily_digest" ||
        job.lane !== "cloud" ||
        job.session_id !== null ||
        job.analysis_input_id !== null ||
        job.desired_head_hash !== null ||
        job.digest_input_id !== digestInputId ||
        !safeHashEqual(job.input_hash, storedInput.sourceHash) ||
        job.input_version !== 1 ||
        typeof job.model_version !== "string" ||
        job.model_version.length === 0
      ) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
      }
      const attempt = this.db
        .prepare(
          `SELECT job_id, provider, model, operation, state
           FROM analysis_budget_attempts WHERE request_id = ?`
        )
        .get(budgetAttemptId);
      if (
        !attempt ||
        attempt.job_id !== jobId ||
        attempt.provider !== "minimax" ||
        attempt.model !== job.model_version ||
        attempt.operation !== "daily_digest" ||
        attempt.state !== "reconciled"
      ) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_BUDGET_UNRECONCILED");
      }
      const existing = this.db
        .prepare("SELECT * FROM daily_digest_response_candidates WHERE job_id = ?")
        .get(jobId);
      if (existing) {
        if (
          existing.digest_input_id !== digestInputId ||
          existing.budget_attempt_id !== budgetAttemptId ||
          existing.response_schema_version !== DAILY_DIGEST_SCHEMA_VERSION ||
          existing.candidate_bytes !== candidateBytes ||
          !safeHashEqual(existing.candidate_hash, candidateHash) ||
          existing.candidate_json !== candidateJson
        ) {
          throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_ALREADY_PERSISTED");
        }
        return {
          status: "existing",
          candidateId: existing.id,
          candidateHash: existing.candidate_hash,
          state: existing.state,
        };
      }
      const candidateId = this._nextId("daily_digest_candidate");
      const createdAt = assertTimestamp(this.now(), "createdAt");
      this.db
        .prepare(
          `INSERT INTO daily_digest_response_candidates (
             id, job_id, digest_input_id, budget_attempt_id, response_schema_version,
             candidate_json, candidate_bytes, candidate_hash, state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?)`
        )
        .run(
          candidateId,
          jobId,
          digestInputId,
          budgetAttemptId,
          DAILY_DIGEST_SCHEMA_VERSION,
          candidateJson,
          candidateBytes,
          candidateHash,
          createdAt
        );
      return { status: "created", candidateId, candidateHash, state: "validated" };
    });
    return transaction.immediate();
  }

  listRecoverableDailyDigestCandidates(input = { afterId: "", limit: 100 }) {
    assertExactPlainObject(input, ["afterId", "limit"], "recoverable daily digest candidate query");
    const { afterId, limit } = input;
    if (typeof afterId !== "string" || Array.from(afterId).length > 512) {
      throw new TypeError("afterId must be a bounded string");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("limit must be between 1 and 1000");
    }
    return this.db
      .prepare(
        `SELECT candidate.id AS candidate_id, candidate.job_id,
                candidate.digest_input_id, candidate.state AS candidate_state,
                job.state AS job_state, job.lease_owner, job.lease_expires_at,
                attempt.state AS budget_state
         FROM daily_digest_response_candidates AS candidate
         JOIN processing_jobs AS job ON job.id = candidate.job_id
         JOIN analysis_budget_attempts AS attempt
           ON attempt.request_id = candidate.budget_attempt_id
         WHERE (
           candidate.state = 'validated'
           OR (candidate.state IN ('applied','superseded') AND job.completed_at IS NULL)
         ) AND candidate.id > ?
         ORDER BY candidate.id LIMIT ?`
      )
      .all(afterId, limit)
      .map((row) => ({
        candidateId: row.candidate_id,
        jobId: row.job_id,
        digestInputId: row.digest_input_id,
        candidateState: row.candidate_state,
        jobState: row.job_state,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        budgetState: row.budget_state,
      }));
  }

  getRecoverableDailyDigestCandidateByJob(jobId) {
    const id = assertId(jobId, "jobId");
    const row = this.db
      .prepare(
        `SELECT candidate.id AS candidate_id, candidate.job_id,
                candidate.digest_input_id, candidate.state AS candidate_state,
                candidate.budget_attempt_id,
                job.state AS job_state, job.completed_at AS job_completed_at,
                job.lease_owner, job.lease_expires_at, job.job_type, job.lane,
                job.session_id, job.analysis_input_id, job.desired_head_hash,
                job.digest_input_id AS job_digest_input_id, job.input_hash,
                job.input_version, job.model_version,
                digest_input.id AS stored_digest_input_id,
                digest_input.source_hash AS stored_source_hash,
                attempt.request_id AS attempt_request_id,
                attempt.job_id AS attempt_job_id, attempt.provider AS attempt_provider,
                attempt.model AS attempt_model, attempt.operation AS attempt_operation,
                attempt.state AS budget_state
         FROM daily_digest_response_candidates AS candidate
         LEFT JOIN processing_jobs AS job ON job.id = candidate.job_id
         LEFT JOIN daily_digest_inputs AS digest_input
           ON digest_input.id = candidate.digest_input_id
         LEFT JOIN analysis_budget_attempts AS attempt
           ON attempt.request_id = candidate.budget_attempt_id
         WHERE candidate.job_id = ?`
      )
      .get(id);
    if (!row) return null;
    if (
      row.job_id !== id ||
      row.job_type !== "generate_daily_digest" ||
      row.lane !== "cloud" ||
      row.session_id !== null ||
      row.analysis_input_id !== null ||
      row.desired_head_hash !== null ||
      row.job_digest_input_id !== row.digest_input_id ||
      row.stored_digest_input_id !== row.digest_input_id ||
      !safeHashEqual(row.input_hash, row.stored_source_hash) ||
      row.input_version !== 1
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    }
    if (
      row.attempt_request_id !== row.budget_attempt_id ||
      row.attempt_job_id !== id ||
      row.attempt_provider !== "minimax" ||
      row.attempt_model !== row.model_version ||
      row.attempt_operation !== "daily_digest" ||
      row.budget_state !== "reconciled"
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_BUDGET_UNRECONCILED");
    }
    if (
      row.candidate_state !== "validated" &&
      !(["applied", "superseded"].includes(row.candidate_state) && row.job_completed_at === null)
    ) {
      return null;
    }
    return {
      candidateId: row.candidate_id,
      jobId: row.job_id,
      digestInputId: row.digest_input_id,
      candidateState: row.candidate_state,
      jobState: row.job_state,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      budgetState: row.budget_state,
    };
  }

  _loadDailyDigestCandidateForApply(candidateId) {
    const candidateRow = this.db
      .prepare("SELECT * FROM daily_digest_response_candidates WHERE id = ?")
      .get(candidateId);
    if (!candidateRow) throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_NOT_FOUND");
    const storedInput = this.getDailyDigestInput(candidateRow.digest_input_id);
    if (!storedInput) throw codedError("MEMORY_DAILY_DIGEST_INPUT_NOT_FOUND");
    let parsedCandidate;
    try {
      parsedCandidate = JSON.parse(candidateRow.candidate_json);
      assertJsonObject(parsedCandidate, "daily digest candidate");
    } catch {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CORRUPT");
    }
    const candidate = validateCandidateDailyDigest(
      parsedCandidate,
      this._dailyDigestCandidateContext(storedInput)
    );
    const candidateJson = canonicalJson(candidate);
    const candidateBytes = Buffer.byteLength(candidateJson, "utf8");
    const candidateHash = sha256(candidateJson);
    if (
      candidateRow.response_schema_version !== DAILY_DIGEST_SCHEMA_VERSION ||
      candidateRow.candidate_json !== candidateJson ||
      candidateRow.candidate_bytes !== candidateBytes ||
      candidateBytes > MAX_DAILY_DIGEST_CANDIDATE_BYTES ||
      !safeHashEqual(candidateRow.candidate_hash, candidateHash)
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CORRUPT");
    }
    const job = this.db
      .prepare("SELECT * FROM processing_jobs WHERE id = ?")
      .get(candidateRow.job_id);
    if (
      !job ||
      job.job_type !== "generate_daily_digest" ||
      job.lane !== "cloud" ||
      job.session_id !== null ||
      job.analysis_input_id !== null ||
      job.desired_head_hash !== null ||
      job.digest_input_id !== storedInput.digestInputId ||
      !safeHashEqual(job.input_hash, storedInput.sourceHash) ||
      job.input_version !== 1 ||
      typeof job.model_version !== "string" ||
      job.model_version.length === 0
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_JOB_MISMATCH");
    }
    const attempt = this.db
      .prepare(
        `SELECT job_id, provider, model, operation, state
         FROM analysis_budget_attempts WHERE request_id = ?`
      )
      .get(candidateRow.budget_attempt_id);
    if (
      !attempt ||
      attempt.job_id !== job.id ||
      attempt.provider !== "minimax" ||
      attempt.model !== job.model_version ||
      attempt.operation !== "daily_digest" ||
      attempt.state !== "reconciled"
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_BUDGET_UNRECONCILED");
    }
    const evidenceSegmentIds = [
      ...new Set(
        Object.values(candidate.sections).flatMap((items) =>
          items.flatMap((item) => item.evidenceSegmentIds)
        )
      ),
    ].sort();
    return {
      candidateRow,
      storedInput,
      candidate,
      candidateJson,
      job,
      evidenceSegmentIds,
    };
  }

  _assertDailyDigestEvidenceLineage(storedInput, evidenceSegmentIds) {
    const watermarkEvidence = new Map(
      storedInput.inputWatermark.evidence.map((item) => [item.segmentId, item])
    );
    const loadSegment = this.db.prepare(
      `SELECT id, version, text, started_at, ended_at, result_kind, is_stable,
              superseded_by, duplicate_of
       FROM transcript_segments WHERE id = ?`
    );
    for (const segmentId of evidenceSegmentIds) {
      const expected = watermarkEvidence.get(segmentId);
      const actual = loadSegment.get(segmentId);
      if (
        !expected ||
        !actual ||
        actual.result_kind !== "final" ||
        actual.is_stable !== 1 ||
        actual.superseded_by !== null ||
        actual.duplicate_of !== null ||
        actual.version !== expected.version ||
        actual.started_at !== expected.startedAt ||
        actual.ended_at !== expected.endedAt ||
        !safeHashEqual(sha256(actual.text), expected.textHash)
      ) {
        throw codedError("MEMORY_DAILY_DIGEST_EVIDENCE_STALE");
      }
    }
  }

  _readAppliedDailyDigestReplay(storedInput, candidateJson, evidenceSegmentIds) {
    const digest = this.db
      .prepare(
        `SELECT * FROM daily_digests
         WHERE local_date = ? AND timezone = ? AND source_hash = ?`
      )
      .get(storedInput.localDate, storedInput.timezone, storedInput.sourceHash);
    if (
      !digest ||
      digest.completeness !== storedInput.completeness ||
      digest.input_watermark_json !== storedInput.inputWatermarkJson ||
      digest.content_json !== candidateJson
    ) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CORRUPT");
    }
    const durableEvidenceIds = this.db
      .prepare(
        `SELECT transcript_segment_id FROM evidence_refs
         WHERE entity_type = 'daily_digest' AND entity_id = ?
         ORDER BY transcript_segment_id`
      )
      .all(digest.id)
      .map((row) => row.transcript_segment_id);
    if (canonicalJson(durableEvidenceIds) !== canonicalJson(evidenceSegmentIds)) {
      throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CORRUPT");
    }
    return {
      status: "already_applied",
      digestId: digest.id,
      revision: digest.revision,
      sourceHash: digest.source_hash,
    };
  }

  applyValidatedDailyDigestCandidate(input) {
    assertExactPlainObject(
      input,
      ["candidateId", "leaseOwner"],
      "validated daily digest candidate application"
    );
    const candidateId = assertId(input.candidateId, "candidateId");
    const leaseOwner = assertText(input.leaseOwner, "leaseOwner");
    const transaction = this.db.transaction(() => {
      const loaded = this._loadDailyDigestCandidateForApply(candidateId);
      const { candidateRow, storedInput, candidate, candidateJson, job, evidenceSegmentIds } =
        loaded;
      const appliedAt = assertTimestamp(this.now(), "appliedAt");
      if (
        job.state !== "running" ||
        job.completed_at !== null ||
        job.lease_owner !== leaseOwner ||
        !Number.isSafeInteger(job.lease_expires_at) ||
        job.lease_expires_at <= appliedAt
      ) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_LEASE_LOST");
      }
      if (candidateRow.state === "applied") {
        return {
          ...this._readAppliedDailyDigestReplay(storedInput, candidateJson, evidenceSegmentIds),
          candidateId,
          jobId: job.id,
        };
      }
      if (candidateRow.state === "superseded") {
        return {
          status: "superseded",
          candidateId,
          jobId: job.id,
          digestInputId: storedInput.digestInputId,
        };
      }
      if (candidateRow.state !== "validated" || candidateRow.disposition_at !== null) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CORRUPT");
      }
      const latestInput = this.db
        .prepare(
          `SELECT id FROM daily_digest_inputs
           WHERE local_date = ? AND timezone = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(storedInput.localDate, storedInput.timezone);
      const activeDigest = this.db
        .prepare(
          `SELECT completeness FROM daily_digests
           WHERE local_date = ? AND timezone = ? AND lifecycle = 'active'
           ORDER BY revision DESC LIMIT 1`
        )
        .get(storedInput.localDate, storedInput.timezone);
      if (
        latestInput?.id !== storedInput.digestInputId ||
        (activeDigest?.completeness === "final" && storedInput.completeness === "partial")
      ) {
        const superseded = this.db
          .prepare(
            `UPDATE daily_digest_response_candidates
             SET state = 'superseded', disposition_at = ?
             WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
          )
          .run(appliedAt, candidateId);
        if (superseded.changes !== 1) {
          throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CAS_CONFLICT");
        }
        return {
          status: "superseded",
          candidateId,
          jobId: job.id,
          digestInputId: storedInput.digestInputId,
        };
      }
      this._assertDailyDigestEvidenceLineage(storedInput, evidenceSegmentIds);
      const digestResult = this._saveDigestRevisionInTransaction(
        this._normalizeDigestRevisionInput({
          localDate: storedInput.localDate,
          timezone: storedInput.timezone,
          sourceHash: storedInput.sourceHash,
          inputWatermark: storedInput.inputWatermark,
          content: candidate,
          completeness: storedInput.completeness,
          evidenceSegmentIds,
        }),
        appliedAt
      );
      const applied = this.db
        .prepare(
          `UPDATE daily_digest_response_candidates
           SET state = 'applied', disposition_at = ?
           WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
        )
        .run(appliedAt, candidateId);
      if (applied.changes !== 1) {
        throw codedError("MEMORY_DAILY_DIGEST_CANDIDATE_CAS_CONFLICT");
      }
      return { ...digestResult, status: "applied", candidateId, jobId: job.id };
    });
    return transaction.immediate();
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
      const inputRow = this.db
        .prepare(
          "SELECT session_id, input_hash, candidate_hash, applied_at FROM analysis_inputs WHERE id = ?"
        )
        .get(candidateRow.analysis_input_id);
      if (candidateRow.state === "applied") {
        if (!inputRow?.candidate_hash || inputRow.applied_at === null) {
          throw codedError("MEMORY_CANDIDATE_CORRUPT");
        }
        return {
          status: "already_applied",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
          rawCandidateHash: candidateRow.candidate_hash,
          semanticCandidateHash: inputRow.candidate_hash,
        };
      }
      if (candidateRow.state === "superseded") {
        return {
          status: "superseded",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
        };
      }
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
        const superseded = this.db
          .prepare(
            `UPDATE analysis_response_candidates
             SET state = 'superseded', disposition_at = ?
             WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
          )
          .run(at, candidateId);
        if (superseded.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
        return {
          status: "superseded",
          analysisInputId: candidateRow.analysis_input_id,
          candidateHash: candidateRow.candidate_hash,
        };
      }
      const result = this.applyCandidateAnalysis({
        analysisInputId: candidateRow.analysis_input_id,
        inputHash: inputRow.input_hash,
        candidate,
        claimedCandidateHash: candidateRow.candidate_hash,
      });
      const applied = this.db
        .prepare(
          `UPDATE analysis_response_candidates
           SET state = 'applied', disposition_at = ?
           WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
        )
        .run(at, candidateId);
      if (applied.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
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

  _plannerEvidenceSegmentIds(entityType, entityId) {
    return normalizeStringSet(
      this.db
        .prepare(
          `SELECT transcript_segment_id
           FROM evidence_refs
           WHERE entity_type = ? AND entity_id = ? AND transcript_segment_id IS NOT NULL
           ORDER BY transcript_segment_id`
        )
        .all(entityType, entityId)
        .map((row) => row.transcript_segment_id),
      `${entityType}.evidenceSegmentIds`
    );
  }

  _canonicalMemorySlotIdentity(memoryItemId) {
    const memory = this.db
      .prepare(
        `SELECT item.id, item.kind, item.title,
                slot.canonical_slot_key, slot.algorithm
         FROM memory_items_v2 AS item
         LEFT JOIN memory_item_canonical_slots AS slot ON slot.memory_item_id = item.id
         WHERE item.id = ?`
      )
      .get(memoryItemId);
    if (!memory) throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
    const subjectIds = [
      ...new Set(
        this.db
          .prepare(
            `SELECT subject_id FROM memory_item_subjects
             WHERE memory_item_id = ? ORDER BY subject_id, subject_kind`
          )
          .all(memoryItemId)
          .map((subject) => subject.subject_id)
      ),
    ];
    const canonicalSlotKey = canonicalTupleHash([
      "memory",
      memory.kind,
      canonicalizeText(memory.title),
      subjectIds,
    ]);
    if (memory.algorithm !== "canonical-v1" || memory.canonical_slot_key !== canonicalSlotKey) {
      throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
    }
    return canonicalSlotKey;
  }

  _validateConflictGroupSemanticIdentity(conflictGroupId) {
    const members = this.db
      .prepare(
        `SELECT memory_item_id FROM memory_conflict_members
         WHERE group_id = ? ORDER BY memory_item_id`
      )
      .all(conflictGroupId);
    if (members.length === 0) throw codedError("MEMORY_CONFLICT_AMBIGUOUS");
    const semanticSlots = new Set(
      members.map((member) => this._canonicalMemorySlotIdentity(member.memory_item_id))
    );
    if (semanticSlots.size !== 1) throw codedError("MEMORY_CONFLICT_AMBIGUOUS");
    return semanticSlots.values().next().value;
  }

  _validatedSemanticConflictGroups(canonicalSlotKey) {
    assertHash(canonicalSlotKey, "canonicalSlotKey");
    const groups = this.db
      .prepare(
        `SELECT conflict.id, conflict.slot_key, conflict.episode, conflict.state
         FROM memory_conflict_groups AS conflict
         WHERE conflict.slot_key = ?
            OR EXISTS (
              SELECT 1
              FROM memory_conflict_members AS member
              JOIN memory_item_canonical_slots AS slot
                ON slot.memory_item_id = member.memory_item_id
              WHERE member.group_id = conflict.id
                AND slot.canonical_slot_key = ?
            )
         ORDER BY conflict.id`
      )
      .all(canonicalSlotKey, canonicalSlotKey);
    return groups.filter((group) => {
      const semanticSlotKey = this._validateConflictGroupSemanticIdentity(group.id);
      if (group.slot_key === canonicalSlotKey && semanticSlotKey !== canonicalSlotKey) {
        throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
      }
      return semanticSlotKey === canonicalSlotKey;
    });
  }

  _existingPlannerSnapshot() {
    const memories = this.db
      .prepare(
        `SELECT id, kind, title, body, lifecycle
         FROM memory_items_v2 ORDER BY id`
      )
      .all()
      .map((row) => {
        const relatedSubjects = this.db
          .prepare(
            `SELECT subject_kind, subject_id
             FROM memory_item_subjects
             WHERE memory_item_id = ?
             ORDER BY subject_id, subject_kind`
          )
          .all(row.id)
          .map((subject) => ({
            subjectKind: subject.subject_kind,
            subjectId: subject.subject_id,
          }));
        const relatedSubjectIds = normalizeStringSet(
          relatedSubjects.map((subject) => subject.subjectId),
          "existing.memory.relatedSubjectIds"
        );
        const canonicalSlotKey = canonicalTupleHash([
          "memory",
          row.kind,
          canonicalizeText(row.title),
          relatedSubjectIds,
        ]);
        return {
          id: row.id,
          kind: row.kind,
          canonicalSlotKey,
          canonicalValueKey: canonicalTupleHash([
            "memory_value",
            canonicalSlotKey,
            canonicalizeText(row.body),
          ]),
          title: row.title,
          body: row.body,
          lifecycle: row.lifecycle,
          relatedSubjects,
          occurrences: this.db
            .prepare(
              `SELECT id, started_at, ended_at
               FROM memory_occurrences
               WHERE memory_value_id = ? ORDER BY id`
            )
            .all(row.id)
            .map((occurrence) => ({
              id: occurrence.id,
              startedAt: occurrence.started_at,
              endedAt: occurrence.ended_at,
              evidenceSegmentIds: this._plannerEvidenceSegmentIds(
                "memory_occurrence",
                occurrence.id
              ),
            })),
        };
      });

    const topics = this.db
      .prepare("SELECT id, name, lifecycle FROM topics_v2 ORDER BY id")
      .all()
      .map((row) => ({
        id: row.id,
        canonicalKey: canonicalTupleHash(["topic", canonicalizeText(row.name)]),
        name: row.name,
        lifecycle: row.lifecycle,
        revisions: this.db
          .prepare(
            `SELECT id, revision, summary
             FROM topic_revisions WHERE topic_id = ? ORDER BY revision, id`
          )
          .all(row.id)
          .map((revision) => ({
            id: revision.id,
            revision: revision.revision,
            summary: revision.summary,
          })),
        occurrences: this.db
          .prepare(
            `SELECT id, topic_revision_id
             FROM topic_occurrences WHERE topic_id = ? ORDER BY id`
          )
          .all(row.id)
          .map((occurrence) => ({
            id: occurrence.id,
            revisionId: occurrence.topic_revision_id,
            evidenceSegmentIds: this._plannerEvidenceSegmentIds("topic_occurrence", occurrence.id),
          })),
      }));

    const topicMergeSuggestions = this.db
      .prepare(
        `SELECT id, left_topic_id, right_topic_id, algorithm_version, score, state
         FROM topic_merge_suggestions ORDER BY id`
      )
      .all()
      .map((row) => ({
        id: row.id,
        leftTopicId: row.left_topic_id,
        rightTopicId: row.right_topic_id,
        algorithmVersion: row.algorithm_version,
        score: row.score,
        state: row.state,
      }));

    const todos = this.db
      .prepare(
        `SELECT id, title, owner_subject_kind, owner_subject_id, status, completed_at
         FROM todos_v2 ORDER BY id`
      )
      .all()
      .map((row) => ({
        id: row.id,
        canonicalBaseKey: canonicalTupleHash([
          "todo",
          canonicalizeText(row.title),
          row.owner_subject_id,
        ]),
        title: row.title,
        ownerSubjectKind: row.owner_subject_kind,
        ownerSubjectId: row.owner_subject_id,
        status: row.status,
        completedAt: row.status === "completed" ? row.completed_at : null,
        revisions: this.db
          .prepare(
            `SELECT id, revision, title, due_text
             FROM todo_revisions WHERE todo_instance_id = ? ORDER BY revision, id`
          )
          .all(row.id)
          .map((revision) => ({
            id: revision.id,
            revision: revision.revision,
            title: revision.title,
            dueText: revision.due_text,
          })),
        occurrences: this.db
          .prepare(
            `SELECT id, todo_revision_id, started_at, ended_at
             FROM todo_occurrences WHERE todo_instance_id = ? ORDER BY id`
          )
          .all(row.id)
          .map((occurrence) => ({
            id: occurrence.id,
            revisionId: occurrence.todo_revision_id,
            startedAt: occurrence.started_at,
            endedAt: occurrence.ended_at,
            evidenceSegmentIds: this._plannerEvidenceSegmentIds("todo_occurrence", occurrence.id),
          })),
      }));

    const suggestions = this.db
      .prepare("SELECT id, title, rationale, state FROM suggestions_v2 ORDER BY id")
      .all()
      .map((row) => ({
        id: row.id,
        canonicalKey: canonicalTupleHash([
          "suggestion",
          canonicalizeText(row.title),
          canonicalizeText(row.rationale),
        ]),
        title: row.title,
        rationale: row.rationale,
        state: row.state,
        occurrences: this.db
          .prepare(
            `SELECT id FROM suggestion_occurrences
             WHERE suggestion_id = ? ORDER BY id`
          )
          .all(row.id)
          .map((occurrence) => ({
            id: occurrence.id,
            evidenceSegmentIds: this._plannerEvidenceSegmentIds(
              "suggestion_occurrence",
              occurrence.id
            ),
          })),
      }));

    const memorySupersessions = this.db
      .prepare(
        `SELECT previous_id, next_id, reason
         FROM memory_supersessions ORDER BY previous_id, next_id`
      )
      .all()
      .map((row) => ({
        id: canonicalTupleHash(["memory_supersession", row.previous_id, row.next_id, row.reason]),
        priorMemoryId: row.previous_id,
        nextMemoryId: row.next_id,
        reason: row.reason,
      }));

    const todoRecurrences = this.db
      .prepare(
        `SELECT id, previous_todo_id, next_todo_id, source_occurrence_id
         FROM todo_recurrences ORDER BY id`
      )
      .all()
      .map((row) => ({
        id: row.id,
        previousTodoId: row.previous_todo_id,
        nextTodoId: row.next_todo_id,
        sourceOccurrenceId: row.source_occurrence_id,
      }));

    return {
      memories,
      topics,
      topicMergeSuggestions,
      todos,
      suggestions,
      memorySupersessions,
      todoRecurrences,
    };
  }

  _plannerSnapshot(inputRow, candidate, context) {
    return {
      analysisInput: { id: inputRow.id, sessionId: inputRow.session_id },
      candidate,
      evidence: {
        segments: context.manifest.map((segment) => ({
          id: segment.segment_id,
          sessionId: segment.session_id,
          startedAt: segment.started_at,
          endedAt: segment.ended_at,
          speakerLabel: segment.speaker_binding_label,
        })),
        bindings: context.bindings
          .map((binding) => ({
            label: binding.label,
            subjectKind: binding.subject_kind,
            subjectId: binding.subject_id,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
      },
      existing: this._existingPlannerSnapshot(),
      trustedTranscriptReplacements: [],
    };
  }

  applyCandidateAnalysis(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("candidate application is required");
    }
    const analysisInputId = assertId(input.analysisInputId, "analysisInputId");
    const inputHash = assertHash(input.inputHash, "inputHash");
    const candidate = input.candidate;
    const rawCandidateHash = sha256(canonicalJson(candidate));
    if (
      Object.prototype.hasOwnProperty.call(input, "claimedCandidateHash") &&
      !safeHashEqual(rawCandidateHash, input.claimedCandidateHash)
    ) {
      throw codedError("MEMORY_CANDIDATE_HASH_MISMATCH");
    }

    const apply = () => {
      const inputRow = this.db
        .prepare("SELECT * FROM analysis_inputs WHERE id = ?")
        .get(analysisInputId);
      if (!inputRow) throw codedError("MEMORY_INPUT_NOT_FOUND");
      if (!safeHashEqual(inputHash, inputRow.input_hash)) throw codedError("MEMORY_INPUT_MISMATCH");
      const storedInput = this._loadStoredAnalysisInput(analysisInputId);
      const context = this._candidateContext(inputRow);
      const allowedSegmentIds = new Set(storedInput.payload.selectedSegmentIds);
      const allowedOwnerLabels = new Set(storedInput.payload.selectedOwnerLabels);
      validateCandidate(candidate, { allowedSegmentIds, allowedOwnerLabels });
      if (inputRow.candidate_hash !== null) {
        const retrySemanticHash = semanticCandidateHash(candidate);
        if (safeHashEqual(retrySemanticHash, inputRow.candidate_hash)) {
          return {
            status: "already_applied",
            analysisInputId,
            candidateHash: rawCandidateHash,
            rawCandidateHash,
            semanticCandidateHash: retrySemanticHash,
          };
        }
        throw codedError("MEMORY_CANDIDATE_ALREADY_APPLIED");
      }

      const plannerInput = this._plannerSnapshot(inputRow, candidate, context);
      const plan = this.memoryMerger.plan(plannerInput);
      const semanticHash = assertHash(plan.semanticCandidateHash, "semanticCandidateHash");
      const semanticConflictGroupsBySlot = new Map();
      for (const conflict of plan.conflicts) {
        if (!semanticConflictGroupsBySlot.has(conflict.canonicalSlotKey)) {
          semanticConflictGroupsBySlot.set(
            conflict.canonicalSlotKey,
            this._validatedSemanticConflictGroups(conflict.canonicalSlotKey)
          );
        }
      }
      const appliedAt = assertTimestamp(this.now(), "appliedAt");

      const evidenceStatement = this.db.prepare(
        `INSERT INTO evidence_refs (
           id, entity_type, entity_id, source_analysis_input_id, session_id,
           transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
           quote_text, audio_state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const evidenceExists = this.db.prepare(
        `SELECT 1 FROM evidence_refs
         WHERE entity_type = ? AND entity_id = ? AND transcript_segment_id = ?`
      );
      const insertEvidence = (entityType, entityId, evidenceSegmentIds) => {
        for (const segmentId of evidenceSegmentIds) {
          const segment = context.manifestById.get(segmentId);
          if (!segment) throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          if (evidenceExists.get(entityType, entityId, segmentId)) continue;
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

      const cloudPayload = JSON.parse(inputRow.cloud_payload_json);
      const completeness = cloudPayload.omittedRanges.length === 0 ? "final" : "incremental";
      const previousSummary = this.db
        .prepare(
          `SELECT id, revision, completeness, lifecycle, content_json
           FROM session_summary_revisions
           WHERE session_id = ? ORDER BY revision DESC LIMIT 1`
        )
        .get(inputRow.session_id);
      let reuseSummary = false;
      if (previousSummary) {
        let previousContent;
        try {
          previousContent = JSON.parse(previousSummary.content_json);
        } catch {
          throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
        }
        if (
          !hasExactKeys(previousContent, ["title", "summary"]) ||
          typeof previousContent.title !== "string" ||
          typeof previousContent.summary !== "string" ||
          previousSummary.lifecycle !== "active"
        ) {
          throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
        }
        const linkedEvidence = new Set(
          this._plannerEvidenceSegmentIds("session_summary_revision", previousSummary.id)
        );
        reuseSummary =
          previousSummary.completeness === completeness &&
          canonicalizeText(previousContent.title) ===
            canonicalizeText(candidate.sessionSummary.title) &&
          canonicalizeText(previousContent.summary) ===
            canonicalizeText(candidate.sessionSummary.summary) &&
          candidate.sessionSummary.evidenceSegmentIds.every((segmentId) =>
            linkedEvidence.has(segmentId)
          );
      }
      if (!reuseSummary) {
        if (previousSummary) {
          const superseded = this.db
            .prepare(
              `UPDATE session_summary_revisions
               SET lifecycle = 'superseded' WHERE id = ? AND lifecycle = 'active'`
            )
            .run(previousSummary.id);
          if (superseded.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
        }
        const summaryId = this._nextId("session_summary_revision");
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
            completeness,
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
      }

      const memoryIdsByCanonicalValueKey = new Map(
        plannerInput.existing.memories.map((memory) => [memory.canonicalValueKey, memory.id])
      );
      const memoryCanonicalSlotById = new Map(
        plannerInput.existing.memories.map((memory) => [memory.id, memory.canonicalSlotKey])
      );
      const topicIdsByCanonicalKey = new Map(
        plannerInput.existing.topics.map((topic) => [topic.canonicalKey, topic.id])
      );
      const todoIdsByCanonicalBaseKey = new Map();
      for (const todo of plannerInput.existing.todos) {
        const ids = todoIdsByCanonicalBaseKey.get(todo.canonicalBaseKey) ?? [];
        ids.push(todo.id);
        todoIdsByCanonicalBaseKey.set(todo.canonicalBaseKey, ids);
      }
      const insertMemorySubject = this.db.prepare(
        `INSERT INTO memory_item_subjects (
           memory_item_id, subject_kind, subject_id
         ) VALUES (?, ?, ?)`
      );
      const occurrenceEntityTypes = new Set([
        "memory_occurrence",
        "topic_occurrence",
        "todo_occurrence",
        "suggestion_occurrence",
      ]);
      const occurrenceCreationModes = new Set(["create_occurrence", "attach_history"]);
      const addConflictMember = this.db.prepare(
        `INSERT OR IGNORE INTO memory_conflict_members (
           group_id, memory_item_id, created_at
         ) VALUES (?, ?, ?)`
      );

      const applyMemoryInsert = (memory) => {
        const slotKey = memory.canonicalSlotKey;
        const valueKey = memory.canonicalValueKey;
        let memoryRow = this.db
          .prepare("SELECT id FROM memory_items_v2 WHERE canonical_value_key = ?")
          .get(valueKey);
        if (!memoryRow) {
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
          for (const subject of memory.relatedSubjects) {
            insertMemorySubject.run(memoryRow.id, subject.subjectKind, subject.subjectId);
          }
          this.db
            .prepare(
              `INSERT INTO memory_item_canonical_slots (
                 memory_item_id, canonical_slot_key, algorithm
               ) VALUES (?, ?, 'canonical-v1')`
            )
            .run(memoryRow.id, memory.canonicalSlotKey);
          memoryIdsByCanonicalValueKey.set(memory.canonicalValueKey, memoryRow.id);
          memoryCanonicalSlotById.set(memoryRow.id, memory.canonicalSlotKey);
        }
        const fingerprint = canonicalTupleHash([
          "memory_insert",
          memory.canonicalValueKey,
          memory.evidenceSegmentIds,
        ]);
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
            canonicalTupleHash(["memory_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            bounds.startedAt,
            bounds.endedAt,
            memory.confidence,
            appliedAt
          );
        insertEvidence("memory_occurrence", occurrenceId, memory.evidenceSegmentIds);
      };

      const applyTopicInsert = (topic) => {
        const canonicalKey = topic.canonicalKey;
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
          topicIdsByCanonicalKey.set(topic.canonicalKey, topicRow.id);
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
        const fingerprint = canonicalTupleHash([
          "topic_insert",
          topic.canonicalKey,
          topic.normalizedSummary,
          topic.evidenceSegmentIds,
        ]);
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
            canonicalTupleHash(["topic_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            appliedAt
          );
        insertEvidence("topic_occurrence", occurrenceId, topic.evidenceSegmentIds);
      };

      const applyTodoInsert = (todo) => {
        const binding =
          todo.ownerSubjectId === null
            ? null
            : context.bindings.find(
                (item) =>
                  item.subject_kind === todo.ownerSubjectKind &&
                  item.subject_id === todo.ownerSubjectId
              );
        if (todo.ownerSubjectId !== null && !binding) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const baseKey = todo.canonicalBaseKey;
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
          todoIdsByCanonicalBaseKey.set(todo.canonicalBaseKey, [todoRow.id]);
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
        const fingerprint = canonicalTupleHash([
          "todo_insert",
          todo.canonicalBaseKey,
          todo.dueText,
          todo.evidenceSegmentIds,
        ]);
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
            canonicalTupleHash(["todo_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            bounds.startedAt,
            bounds.endedAt,
            appliedAt
          );
        insertEvidence("todo_occurrence", occurrenceId, todo.evidenceSegmentIds);
      };

      const applySuggestionInsert = (suggestion) => {
        const canonicalKey = suggestion.canonicalKey;
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
        const fingerprint = canonicalTupleHash([
          "suggestion_insert",
          suggestion.canonicalKey,
          suggestion.evidenceSegmentIds,
        ]);
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
            canonicalTupleHash(["suggestion_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            appliedAt
          );
        insertEvidence("suggestion_occurrence", occurrenceId, suggestion.evidenceSegmentIds);
      };

      for (const action of plan.inserts) {
        if (action.entityKind === "memory") applyMemoryInsert(action);
        else if (action.entityKind === "topic") applyTopicInsert(action);
        else if (action.entityKind === "todo") applyTodoInsert(action);
        else if (action.entityKind === "suggestion") applySuggestionInsert(action);
        else throw codedError("MEMORY_PLAN_ACTION_UNKNOWN");
      }

      const resolveMemoryId = ({ memoryId, canonicalValueKey }) => {
        const hasMemoryId = memoryId !== undefined && memoryId !== null;
        const hasCanonicalValueKey = canonicalValueKey !== undefined && canonicalValueKey !== null;
        if (!hasMemoryId && !hasCanonicalValueKey) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        if (hasMemoryId && !memoryCanonicalSlotById.has(memoryId)) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const byCanonical = hasCanonicalValueKey
          ? memoryIdsByCanonicalValueKey.get(canonicalValueKey)
          : undefined;
        if (hasCanonicalValueKey && !byCanonical) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        if (hasMemoryId && hasCanonicalValueKey && memoryId !== byCanonical) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const resolved = hasMemoryId ? memoryId : byCanonical;
        return resolved;
      };
      const requireEvidence = (action) => {
        if (!Array.isArray(action.evidenceSegmentIds) || action.evidenceSegmentIds.length === 0) {
          throw codedError("MEMORY_EVIDENCE_REQUIRED");
        }
      };
      const assertActionBounds = (action) => {
        const bounds = evidenceBounds(action.evidenceSegmentIds);
        if (action.startedAt !== bounds.startedAt || action.endedAt !== bounds.endedAt) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
      };

      for (const revision of plan.revisions) {
        if (revision.entityKind !== "topic") throw codedError("MEMORY_PLAN_ACTION_UNKNOWN");
        const topicId = topicIdsByCanonicalKey.get(revision.canonicalKey);
        if (!topicId || topicId !== revision.topicId) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const previous = this.db
          .prepare(
            `SELECT id, revision FROM topic_revisions
             WHERE topic_id = ? ORDER BY revision DESC, id DESC LIMIT 1`
          )
          .get(topicId);
        if (
          !previous ||
          previous.id !== revision.previousRevisionId ||
          previous.revision !== revision.previousRevision
        ) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        requireEvidence(revision);
        const revisionId = this._nextId("topic_revision");
        this.db
          .prepare(
            `INSERT INTO topic_revisions (
               id, topic_id, revision, previous_revision_id, summary,
               source_analysis_input_id, provenance, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'evidence_linked', ?)`
          )
          .run(
            revisionId,
            topicId,
            previous.revision + 1,
            previous.id,
            revision.summary,
            analysisInputId,
            appliedAt
          );
        const fingerprint = canonicalTupleHash([
          "topic_revision",
          revision.canonicalKey,
          revision.normalizedSummary,
          revision.evidenceSegmentIds,
        ]);
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
            topicId,
            revisionId,
            analysisInputId,
            canonicalTupleHash(["topic_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            appliedAt
          );
        insertEvidence("topic_occurrence", occurrenceId, revision.evidenceSegmentIds);
      }

      for (const action of plan.occurrenceLinks) {
        const actionFingerprint = canonicalTupleHash(["occurrence_action", action]);
        if (action.mode === "link_evidence") {
          if (!occurrenceEntityTypes.has(action.entityKind)) {
            throw codedError("MEMORY_PLAN_ACTION_UNKNOWN");
          }
          const occurrenceTable = {
            memory_occurrence: "memory_occurrences",
            topic_occurrence: "topic_occurrences",
            todo_occurrence: "todo_occurrences",
            suggestion_occurrence: "suggestion_occurrences",
          }[action.entityKind];
          const occurrence = this.db
            .prepare(`SELECT * FROM ${occurrenceTable} WHERE id = ?`)
            .get(action.occurrenceId);
          if (!occurrence) throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          if (
            (action.memoryId && occurrence.memory_value_id !== action.memoryId) ||
            (action.topicId && occurrence.topic_id !== action.topicId) ||
            (action.todoId && occurrence.todo_instance_id !== action.todoId) ||
            (action.suggestionId && occurrence.suggestion_id !== action.suggestionId) ||
            (action.revisionId && occurrence.topic_revision_id !== action.revisionId)
          ) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
          insertEvidence(action.entityKind, action.occurrenceId, action.evidenceSegmentIds);
          continue;
        }

        if (!occurrenceCreationModes.has(action.mode)) {
          throw codedError("MEMORY_PLAN_ACTION_UNKNOWN");
        }
        if (action.entityKind === "memory") {
          requireEvidence(action);
          assertActionBounds(action);
          const memoryId = resolveMemoryId(action);
          const occurrenceId = this._nextId("memory_occurrence");
          this.db
            .prepare(
              `INSERT INTO memory_occurrences (
                 id, memory_value_id, analysis_input_id, legacy_session_id, occurrence_key,
                 candidate_item_fingerprint, started_at, ended_at, confidence, created_at
               ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              occurrenceId,
              memoryId,
              analysisInputId,
              canonicalTupleHash(["memory_occurrence", analysisInputId, actionFingerprint]),
              actionFingerprint,
              action.startedAt,
              action.endedAt,
              action.confidence,
              appliedAt
            );
          insertEvidence("memory_occurrence", occurrenceId, action.evidenceSegmentIds);
        } else if (action.entityKind === "topic") {
          requireEvidence(action);
          const topic = this.db
            .prepare("SELECT id FROM topics_v2 WHERE id = ?")
            .get(action.topicId);
          const revision = this.db
            .prepare("SELECT topic_id FROM topic_revisions WHERE id = ?")
            .get(action.revisionId);
          if (!topic || revision?.topic_id !== topic.id) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
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
              topic.id,
              action.revisionId,
              analysisInputId,
              canonicalTupleHash(["topic_occurrence", analysisInputId, actionFingerprint]),
              actionFingerprint,
              appliedAt
            );
          insertEvidence("topic_occurrence", occurrenceId, action.evidenceSegmentIds);
        } else if (action.entityKind === "todo") {
          requireEvidence(action);
          assertActionBounds(action);
          const revision = this.db
            .prepare("SELECT todo_instance_id FROM todo_revisions WHERE id = ?")
            .get(action.revisionId);
          if (revision?.todo_instance_id !== action.todoId) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
          const occurrenceId = this._nextId("todo_occurrence");
          this.db
            .prepare(
              `INSERT INTO todo_occurrences (
                 id, todo_instance_id, todo_revision_id, analysis_input_id,
                 legacy_session_id, occurrence_key, candidate_item_fingerprint,
                 started_at, ended_at, created_at
               ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
            )
            .run(
              occurrenceId,
              action.todoId,
              action.revisionId,
              analysisInputId,
              canonicalTupleHash(["todo_occurrence", analysisInputId, actionFingerprint]),
              actionFingerprint,
              action.startedAt,
              action.endedAt,
              appliedAt
            );
          insertEvidence("todo_occurrence", occurrenceId, action.evidenceSegmentIds);
        } else if (action.entityKind === "suggestion" && action.mode === "create_occurrence") {
          const suggestion = this.db
            .prepare("SELECT id, state FROM suggestions_v2 WHERE id = ?")
            .get(action.suggestionId);
          if (!suggestion || suggestion.state !== "proposed") {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
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
              suggestion.id,
              analysisInputId,
              canonicalTupleHash(["suggestion_occurrence", analysisInputId, actionFingerprint]),
              actionFingerprint,
              appliedAt
            );
          insertEvidence("suggestion_occurrence", occurrenceId, action.evidenceSegmentIds);
        } else {
          throw codedError("MEMORY_PLAN_ACTION_UNKNOWN");
        }
      }

      for (const supersession of plan.supersessions) {
        const nextMemoryId = resolveMemoryId({
          canonicalValueKey: supersession.nextMemoryCanonicalValueKey,
        });
        if (
          !memoryCanonicalSlotById.has(supersession.priorMemoryId) ||
          memoryCanonicalSlotById.get(supersession.priorMemoryId) !==
            supersession.canonicalSlotKey ||
          memoryCanonicalSlotById.get(nextMemoryId) !== supersession.canonicalSlotKey ||
          supersession.priorMemoryId === nextMemoryId
        ) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        this.db
          .prepare(
            `INSERT INTO memory_supersessions (
               previous_id, next_id, reason, analysis_input_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            supersession.priorMemoryId,
            nextMemoryId,
            supersession.reason,
            analysisInputId,
            appliedAt
          );
        const lifecycle = this.db
          .prepare("SELECT lifecycle FROM memory_items_v2 WHERE id = ?")
          .get(supersession.priorMemoryId)?.lifecycle;
        if (lifecycle !== "active") throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        this.db
          .prepare(
            `UPDATE memory_items_v2
             SET lifecycle = 'superseded', updated_at = ?
             WHERE id = ? AND lifecycle = 'active'`
          )
          .run(appliedAt, supersession.priorMemoryId);
      }

      for (const conflict of plan.conflicts) {
        const memberIds = new Set(conflict.existingMemoryIds);
        for (const canonicalValueKey of conflict.candidateCanonicalValueKeys) {
          const memoryId = memoryIdsByCanonicalValueKey.get(canonicalValueKey);
          if (!memoryId) throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          memberIds.add(memoryId);
        }
        if (
          memberIds.size < 2 ||
          [...memberIds].some(
            (memoryId) => memoryCanonicalSlotById.get(memoryId) !== conflict.canonicalSlotKey
          )
        ) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const semanticGroups = semanticConflictGroupsBySlot.get(conflict.canonicalSlotKey);
        if (!semanticGroups) throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        const openGroups = semanticGroups.filter((row) => row.state === "open");
        if (openGroups.length > 1) throw codedError("MEMORY_CONFLICT_AMBIGUOUS");
        let group = openGroups[0];
        if (!group) {
          const episode = Math.max(0, ...semanticGroups.map((row) => row.episode)) + 1;
          group = { id: this._nextId("memory_conflict") };
          this.db
            .prepare(
              `INSERT INTO memory_conflict_groups (
                 id, slot_key, episode, state, selected_member_id, resolved_at,
                 created_at, updated_at
               ) VALUES (?, ?, ?, 'open', NULL, NULL, ?, ?)`
            )
            .run(group.id, conflict.canonicalSlotKey, episode, appliedAt, appliedAt);
        }
        for (const memoryId of [...memberIds].sort()) {
          addConflictMember.run(group.id, memoryId, appliedAt);
          const row = this.db
            .prepare("SELECT lifecycle FROM memory_items_v2 WHERE id = ?")
            .get(memoryId);
          if (!row || !["active", "conflict"].includes(row.lifecycle)) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
          if (row.lifecycle === "active") {
            this.db
              .prepare(
                `UPDATE memory_items_v2
                 SET lifecycle = 'conflict', updated_at = ? WHERE id = ? AND lifecycle = 'active'`
              )
              .run(appliedAt, memoryId);
          }
        }
      }

      for (const suggestion of plan.mergeSuggestions) {
        const resolveTopicRef = (reference) => {
          const topicId = topicIdsByCanonicalKey.get(reference.canonicalKey);
          if (!topicId || (reference.topicId && reference.topicId !== topicId)) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
          return topicId;
        };
        const resolvedIds = [
          resolveTopicRef(suggestion.leftTopic),
          resolveTopicRef(suggestion.rightTopic),
        ].sort();
        if (resolvedIds[0] === resolvedIds[1]) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const existing = this.db
          .prepare(
            `SELECT * FROM topic_merge_suggestions
             WHERE pair_key = ? OR (
               left_topic_id = ? AND right_topic_id = ? AND algorithm_version = ?
             )`
          )
          .get(suggestion.pairKey, resolvedIds[0], resolvedIds[1], suggestion.algorithmVersion);
        if (existing) {
          if (
            existing.pair_key !== suggestion.pairKey ||
            existing.left_topic_id !== resolvedIds[0] ||
            existing.right_topic_id !== resolvedIds[1] ||
            existing.algorithm_version !== suggestion.algorithmVersion
          ) {
            throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
          }
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO topic_merge_suggestions (
               id, left_topic_id, right_topic_id, pair_key, algorithm_version,
               score, state, decided_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, ?)`
          )
          .run(
            this._nextId("topic_merge_suggestion"),
            resolvedIds[0],
            resolvedIds[1],
            suggestion.pairKey,
            suggestion.algorithmVersion,
            suggestion.score,
            appliedAt,
            appliedAt
          );
      }

      for (const recurrence of plan.recurrences) {
        requireEvidence(recurrence);
        assertActionBounds(recurrence);
        const previous = this.db
          .prepare(
            `SELECT id, status, completed_at, title, owner_subject_id
             FROM todos_v2 WHERE id = ?`
          )
          .get(recurrence.previousTodoId);
        if (
          !previous ||
          previous.status !== "completed" ||
          recurrence.startedAt <= previous.completed_at ||
          this.db
            .prepare("SELECT 1 FROM todo_recurrences WHERE previous_todo_id = ?")
            .get(previous.id)
        ) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const derivedBaseKey = canonicalTupleHash([
          "todo",
          canonicalizeText(previous.title),
          previous.owner_subject_id,
        ]);
        if (derivedBaseKey !== recurrence.canonicalBaseKey) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const binding =
          recurrence.ownerSubjectId === null
            ? null
            : context.bindings.find(
                (item) =>
                  item.subject_kind === recurrence.ownerSubjectKind &&
                  item.subject_id === recurrence.ownerSubjectId
              );
        if (recurrence.ownerSubjectId !== null && !binding) {
          throw codedError("MEMORY_PLAN_REFERENCE_UNRESOLVED");
        }
        const nextTodoId = this._nextId("todo");
        this.db
          .prepare(
            `INSERT INTO todos_v2 (
               id, canonical_base_key, instance_key, title, owner_subject_kind,
               owner_subject_id, owner_display_name_snapshot, status, recurrence_of_id,
               source_analysis_input_id, provenance, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'evidence_linked', ?, ?)`
          )
          .run(
            nextTodoId,
            recurrence.canonicalBaseKey,
            recurrence.nextTodoInstanceKey,
            recurrence.title,
            recurrence.ownerSubjectKind,
            recurrence.ownerSubjectId,
            binding?.subject_display_name_snapshot ?? null,
            previous.id,
            analysisInputId,
            appliedAt,
            appliedAt
          );
        this.db
          .prepare(
            `INSERT INTO todo_state_transitions (
               id, todo_instance_id, from_status, to_status, reason,
               source_analysis_input_id, actor, occurred_at
             ) VALUES (?, ?, NULL, 'open', 'recurrence', ?, 'system', ?)`
          )
          .run(this._nextId("todo_transition"), nextTodoId, analysisInputId, appliedAt);
        const revisionId = this._nextId("todo_revision");
        this.db
          .prepare(
            `INSERT INTO todo_revisions (
               id, todo_instance_id, revision, previous_revision_id, title, due_text,
               source_analysis_input_id, provenance, created_at
             ) VALUES (?, ?, 1, NULL, ?, ?, ?, 'evidence_linked', ?)`
          )
          .run(
            revisionId,
            nextTodoId,
            recurrence.title,
            recurrence.dueText,
            analysisInputId,
            appliedAt
          );
        const occurrenceId = this._nextId("todo_occurrence");
        const fingerprint = canonicalTupleHash(["todo_recurrence", recurrence]);
        this.db
          .prepare(
            `INSERT INTO todo_occurrences (
               id, todo_instance_id, todo_revision_id, analysis_input_id, legacy_session_id,
               occurrence_key, candidate_item_fingerprint, started_at, ended_at, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceId,
            nextTodoId,
            revisionId,
            analysisInputId,
            canonicalTupleHash(["todo_occurrence", analysisInputId, fingerprint]),
            fingerprint,
            recurrence.startedAt,
            recurrence.endedAt,
            appliedAt
          );
        insertEvidence("todo_occurrence", occurrenceId, recurrence.evidenceSegmentIds);
        this.db
          .prepare(
            `INSERT INTO todo_recurrences (
               id, previous_todo_id, next_todo_id, source_occurrence_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(this._nextId("todo_recurrence"), previous.id, nextTodoId, occurrenceId, appliedAt);
        const todoIds = todoIdsByCanonicalBaseKey.get(recurrence.canonicalBaseKey) ?? [];
        todoIds.push(nextTodoId);
        todoIdsByCanonicalBaseKey.set(recurrence.canonicalBaseKey, todoIds);
      }

      const cas = this.db
        .prepare(
          `UPDATE analysis_inputs SET candidate_hash = ?, applied_at = ?
           WHERE id = ? AND candidate_hash IS NULL AND applied_at IS NULL`
        )
        .run(semanticHash, appliedAt, analysisInputId);
      if (cas.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
      return {
        status: "applied",
        analysisInputId,
        candidateHash: rawCandidateHash,
        rawCandidateHash,
        semanticCandidateHash: semanticHash,
      };
    };
    if (this.db.inTransaction) return apply();
    return this.db.transaction(apply).immediate();
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

      const durableMemorySubjectIds = this.db.prepare(
        `SELECT subject_id FROM memory_item_subjects
         WHERE memory_item_id = ? ORDER BY subject_id, subject_kind`
      );
      const insertCanonicalMemorySlot = this.db.prepare(
        `INSERT INTO memory_item_canonical_slots (
           memory_item_id, canonical_slot_key, algorithm
         ) VALUES (?, ?, 'canonical-v1')`
      );

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
          const subjectIds = normalizeStringSet(
            durableMemorySubjectIds.all(row.id).map((subject) => subject.subject_id),
            "legacy.memory.relatedSubjectIds"
          );
          insertCanonicalMemorySlot.run(
            row.id,
            canonicalTupleHash(["memory", kind, canonicalizeText(title), subjectIds])
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

  _transitionSuggestion(input, terminalState) {
    if (!hasExactKeys(input, ["suggestionId", "at"])) {
      throw new TypeError("suggestion transition must contain suggestionId and at");
    }
    const suggestionId = assertId(input.suggestionId, "suggestionId");
    const at = assertTimestamp(input.at, "at");
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT state, decided_at FROM suggestions_v2 WHERE id = ?")
        .get(suggestionId);
      if (!row) throw codedError("MEMORY_SUGGESTION_NOT_FOUND");
      if (row.state === terminalState) {
        return {
          status: `already_${terminalState}`,
          suggestionId,
          decidedAt: row.decided_at,
        };
      }
      if (row.state !== "proposed") throw codedError("MEMORY_SUGGESTION_ALREADY_DECIDED");
      const updated = this.db
        .prepare(
          `UPDATE suggestions_v2
           SET state = ?, decided_at = ?, updated_at = MAX(updated_at, ?)
           WHERE id = ? AND state = 'proposed' AND decided_at IS NULL`
        )
        .run(terminalState, at, at, suggestionId);
      if (updated.changes !== 1) throw codedError("MEMORY_SUGGESTION_STALE_TRANSITION");
      return { status: terminalState, suggestionId, decidedAt: at };
    });
    return transaction.immediate();
  }

  acceptSuggestion(input) {
    return this._transitionSuggestion(input, "accepted");
  }

  dismissSuggestion(input) {
    return this._transitionSuggestion(input, "dismissed");
  }

  completeTodo(input) {
    if (!hasExactKeys(input, ["todoId"])) {
      throw new TypeError("todo completion must contain only todoId");
    }
    const todoId = assertId(input.todoId, "todoId");
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT status, completed_at FROM todos_v2 WHERE id = ?")
        .get(todoId);
      if (!row) throw codedError("MEMORY_TODO_NOT_FOUND");
      if (row.status === "completed") {
        return { status: "already_completed", todoId, completedAt: row.completed_at };
      }
      if (row.status !== "open") throw codedError("MEMORY_TODO_ALREADY_TERMINAL");
      const completedAt = assertTimestamp(this.now(), "completedAt");
      this.db
        .prepare(
          `INSERT INTO todo_state_transitions (
             id, todo_instance_id, from_status, to_status, reason,
             source_analysis_input_id, actor, occurred_at
           ) VALUES (?, ?, 'open', 'completed', 'user_action', NULL, 'user', ?)`
        )
        .run(this._nextId("todo_transition"), todoId, completedAt);
      return { status: "completed", todoId, completedAt };
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
      this._validateConflictGroupSemanticIdentity(conflictGroupId);
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

  _normalizeDigestEvidenceRows(evidenceSegmentIds) {
    if (!Array.isArray(evidenceSegmentIds)) {
      throw new TypeError("evidenceSegmentIds must be an array");
    }
    const ids = evidenceSegmentIds.map((id) => assertId(id, "evidenceSegmentId"));
    if (new Set(ids).size !== ids.length) {
      throw codedError("MEMORY_DIGEST_EVIDENCE_DUPLICATE");
    }
    const loadSegment = this.db.prepare(
      `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
              segment.text, segment.track_id, segment.chunk_id, segment.result_kind,
              segment.is_stable, segment.superseded_by, segment.duplicate_of,
              chunk.deleted_at
       FROM transcript_segments AS segment
       LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
       WHERE segment.id = ?`
    );
    return ids
      .map((id) => {
        const row = loadSegment.get(id);
        if (
          !row ||
          row.result_kind !== "final" ||
          row.is_stable !== 1 ||
          row.superseded_by !== null ||
          row.duplicate_of !== null
        ) {
          throw codedError("MEMORY_DIGEST_EVIDENCE_OUT_OF_SCOPE");
        }
        return row;
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  _normalizeDigestRevisionInput(input) {
    if (
      !hasExactKeys(input, [
        "localDate",
        "timezone",
        "sourceHash",
        "inputWatermark",
        "content",
        "completeness",
        "evidenceSegmentIds",
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
    const evidenceRows = this._normalizeDigestEvidenceRows(input.evidenceSegmentIds);
    const localDateAt = (timestamp) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(timestamp));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    };
    for (const evidence of evidenceRows) {
      const firstLocalDate = localDateAt(evidence.started_at);
      const lastLocalDate = localDateAt(Math.max(evidence.started_at, evidence.ended_at - 1));
      if (localDate < firstLocalDate || localDate > lastLocalDate) {
        throw codedError("MEMORY_DIGEST_EVIDENCE_OUT_OF_SCOPE");
      }
    }
    return {
      localDate,
      timezone,
      sourceHash,
      completeness: input.completeness,
      inputWatermarkJson,
      contentJson,
      evidenceRows,
    };
  }

  _saveDigestRevisionInTransaction(input, createdAt = null) {
    const {
      localDate,
      timezone,
      sourceHash,
      completeness,
      inputWatermarkJson,
      contentJson,
      evidenceRows,
    } = input;
    const existing = this.db
      .prepare(
        `SELECT id, revision, completeness, input_watermark_json, content_json
           FROM daily_digests
           WHERE local_date = ? AND timezone = ? AND source_hash = ?`
      )
      .get(localDate, timezone, sourceHash);
    if (existing) {
      const existingEvidenceIds = this.db
        .prepare(
          `SELECT transcript_segment_id FROM evidence_refs
             WHERE entity_type = 'daily_digest' AND entity_id = ?
             ORDER BY transcript_segment_id`
        )
        .all(existing.id)
        .map((row) => row.transcript_segment_id);
      if (
        existing.completeness !== completeness ||
        existing.input_watermark_json !== inputWatermarkJson ||
        existing.content_json !== contentJson ||
        canonicalJson(existingEvidenceIds) !== canonicalJson(evidenceRows.map((row) => row.id))
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
    if (previous?.completeness === "final" && completeness === "partial") {
      throw codedError("MEMORY_DIGEST_COMPLETENESS_REGRESSION");
    }
    const digestId = this._nextId("daily_digest");
    const appliedAt =
      createdAt === null
        ? assertTimestamp(this.now(), "createdAt")
        : assertTimestamp(createdAt, "createdAt");
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
        completeness,
        inputWatermarkJson,
        contentJson,
        previous?.id ?? null,
        sourceHash,
        appliedAt,
        appliedAt
      );
    const insertEvidence = this.db.prepare(
      `INSERT INTO evidence_refs (
           id, entity_type, entity_id, source_analysis_input_id, session_id,
           transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
           quote_text, audio_state, created_at
         ) VALUES (?, 'daily_digest', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const evidence of evidenceRows) {
      insertEvidence.run(
        this._nextId("evidence"),
        digestId,
        evidence.session_id,
        evidence.id,
        evidence.chunk_id,
        evidence.track_id,
        evidence.started_at,
        evidence.ended_at,
        evidence.text,
        evidence.chunk_id === null
          ? "missing"
          : evidence.deleted_at === null
            ? "available"
            : "expired",
        appliedAt
      );
    }
    if (previous) {
      this.db
        .prepare("UPDATE daily_digests SET lifecycle = 'superseded', updated_at = ? WHERE id = ?")
        .run(appliedAt, previous.id);
    }
    return { status: "created", digestId, revision, sourceHash };
  }

  saveDigestRevision(input) {
    const normalized = this._normalizeDigestRevisionInput(input);
    const transaction = this.db.transaction(() => {
      return this._saveDigestRevisionInTransaction(normalized);
    });
    return transaction.immediate();
  }

  getLatestDailyDigest(input) {
    assertExactPlainObject(input, ["localDate", "timezone"], "latest daily digest query");
    const localDate = assertLocalDate(input.localDate);
    const timezone = assertTimezone(input.timezone);
    const row = this.db
      .prepare(
        `SELECT digest.id, digest.local_date, digest.timezone, digest.revision,
                digest.completeness, digest.lifecycle, digest.content_json,
                digest.created_at, digest.updated_at,
                (
                  SELECT COALESCE(json_group_array(json_object(
                    'evidenceId', ordered.id,
                    'sessionId', ordered.session_id,
                    'segmentId', ordered.transcript_segment_id,
                    'startedAt', ordered.started_at,
                    'endedAt', ordered.ended_at,
                    'quote', ordered.quote_text,
                    'audioState', ordered.audio_state
                  )), json('[]'))
                  FROM (
                    SELECT id, session_id, transcript_segment_id, started_at, ended_at,
                           quote_text, audio_state
                    FROM evidence_refs
                    WHERE entity_type = 'daily_digest' AND entity_id = digest.id
                    ORDER BY started_at, ended_at, transcript_segment_id
                  ) AS ordered
                ) AS evidence_json
         FROM daily_digests AS digest
         WHERE digest.local_date = ? AND digest.timezone = ? AND digest.lifecycle = 'active'
         ORDER BY digest.revision DESC LIMIT 1`
      )
      .get(localDate, timezone);
    if (!row) return null;
    let content;
    let evidence;
    try {
      content = JSON.parse(row.content_json);
      evidence = JSON.parse(row.evidence_json);
      assertJsonObject(content, "daily digest content");
      if (!Array.isArray(evidence)) throw new TypeError("daily digest evidence must be an array");
      evidence = evidence.map((entry) => ({
        sessionId: entry.sessionId,
        segmentId: entry.segmentId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        quote: entry.quote,
        audioState: entry.audioState,
        handle: normalizeEvidenceContextRequest({
          ownerType: "daily_digest_item",
          ownerId: row.id,
          evidenceId: entry.evidenceId,
        }),
      }));
    } catch {
      throw codedError("MEMORY_PUBLIC_READ_CORRUPT");
    }
    return {
      id: row.id,
      localDate: row.local_date,
      timezone: row.timezone,
      revision: row.revision,
      completeness: row.completeness,
      lifecycle: row.lifecycle,
      content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence,
    };
  }

  getLatestDailyDigestWorkState(input) {
    assertExactPlainObject(input, ["localDate", "timezone"], "latest daily digest work query");
    const localDate = assertLocalDate(input.localDate);
    const timezone = assertTimezone(input.timezone);
    const row = this.db
      .prepare(
        `SELECT job.state, job.error_code, job.blocked_reason, job.next_retry_at,
                job.attempt_count
         FROM daily_digest_inputs AS digest_input
         LEFT JOIN processing_jobs AS job
           ON job.digest_input_id = digest_input.id
          AND job.job_type = 'generate_daily_digest'
         WHERE digest_input.local_date = ? AND digest_input.timezone = ?
         ORDER BY digest_input.created_at DESC, digest_input.id DESC
         LIMIT 1`
      )
      .get(localDate, timezone);
    if (!row || row.state === null) return null;
    return {
      state: row.state,
      errorCode: row.error_code,
      blockedReason: row.blocked_reason,
      nextRetryAt: row.next_retry_at,
      attemptCount: row.attempt_count,
    };
  }

  getEvidenceContext(input) {
    const handle = normalizeEvidenceContextRequest(input);
    const lineageColumns = `
      SELECT ref.session_id, session.started_at AS session_started_at,
             session.ended_at AS session_ended_at,
             segment.id AS transcript_segment_id,
             COALESCE(track.source_type, segment.source_type) AS source_type,
             ref.track_id, ref.started_at, ref.ended_at,
             CASE WHEN segment.id IS NULL THEN NULL ELSE ref.quote_text END AS quote_text,
             CASE
               WHEN ref.audio_chunk_id IS NULL OR chunk.id IS NULL THEN 'missing'
               WHEN chunk.deleted_at IS NULL THEN 'available'
               ELSE 'expired'
             END AS current_audio_state
      FROM evidence_refs AS ref`;
    const lineageJoins = `
      JOIN sessions AS session ON session.id = ref.session_id
      LEFT JOIN transcript_segments AS segment ON segment.id = ref.transcript_segment_id
      LEFT JOIN audio_chunks AS chunk ON chunk.id = ref.audio_chunk_id
      LEFT JOIN audio_tracks AS track ON track.id = ref.track_id`;
    const ownerQueries = {
      memory_value: `${lineageColumns}
        JOIN memory_occurrences AS owner
          ON ref.entity_type = 'memory_occurrence' AND owner.id = ref.entity_id
        ${lineageJoins}
        WHERE ref.id = ? AND owner.memory_value_id = ?`,
      topic_revision: `${lineageColumns}
        JOIN topic_occurrences AS owner
          ON ref.entity_type = 'topic_occurrence' AND owner.id = ref.entity_id
        ${lineageJoins}
        WHERE ref.id = ? AND owner.topic_revision_id = ?`,
      todo_instance: `${lineageColumns}
        JOIN todo_occurrences AS owner
          ON ref.entity_type = 'todo_occurrence' AND owner.id = ref.entity_id
        ${lineageJoins}
        WHERE ref.id = ? AND owner.todo_instance_id = ?`,
      session_summary_revision: `${lineageColumns}
        ${lineageJoins}
        WHERE ref.id = ? AND ref.entity_type = 'session_summary_revision'
          AND ref.entity_id = ?`,
      daily_digest_item: `${lineageColumns}
        ${lineageJoins}
        WHERE ref.id = ? AND ref.entity_type = 'daily_digest'
          AND ref.entity_id = ?`,
      suggestion: `${lineageColumns}
        JOIN suggestion_occurrences AS owner
          ON ref.entity_type = 'suggestion_occurrence' AND owner.id = ref.entity_id
        ${lineageJoins}
        WHERE ref.id = ? AND owner.suggestion_id = ?`,
    };
    let row;
    if (handle.ownerType === "speaker_cluster") {
      row = this.db
        .prepare(
          `SELECT segment.session_id, session.started_at AS session_started_at,
                  session.ended_at AS session_ended_at,
                  segment.id AS transcript_segment_id,
                  COALESCE(track.source_type, segment.source_type) AS source_type,
                  segment.track_id, segment.started_at, segment.ended_at,
                  segment.text AS quote_text,
                  CASE
                    WHEN segment.chunk_id IS NULL OR chunk.id IS NULL THEN 'missing'
                    WHEN chunk.deleted_at IS NULL THEN 'available'
                    ELSE 'expired'
                  END AS current_audio_state
           FROM speaker_clusters AS cluster
           JOIN speaker_cluster_segments AS link ON link.cluster_id = cluster.id
           JOIN transcript_segments AS segment
             ON segment.id = link.transcript_segment_id
            AND segment.session_id = cluster.session_id
            AND segment.track_id = cluster.track_id
           JOIN sessions AS session ON session.id = segment.session_id
           LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
           LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
           WHERE cluster.id = ? AND link.transcript_segment_id = ?`
        )
        .get(handle.ownerId, handle.evidenceId);
    } else {
      row = this.db.prepare(ownerQueries[handle.ownerType]).get(handle.evidenceId, handle.ownerId);
    }
    if (!row) return null;
    const quoteText =
      row.quote_text === null ? null : Array.from(row.quote_text).slice(0, 4_096).join("");
    return normalizeEvidenceContextResponse({
      ...handle,
      sessionId: row.session_id,
      sessionStartedAt: row.session_started_at,
      sessionEndedAt: row.session_ended_at,
      transcriptSegmentId: row.transcript_segment_id,
      transcriptState: row.transcript_segment_id === null ? "missing" : "available",
      trackId: row.track_id,
      sourceType: row.source_type,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      quoteText,
      audioState: row.current_audio_state,
    });
  }

  readPublicSnapshot() {
    const read = this.db.transaction(() => {
      const evidenceStatement = this.db.prepare(
        `SELECT * FROM (
           SELECT id, session_id, transcript_segment_id, started_at, ended_at,
                  quote_text, audio_state
           FROM evidence_refs
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY started_at DESC, ended_at DESC, transcript_segment_id DESC
           LIMIT ?
         ) ORDER BY started_at, ended_at, transcript_segment_id`
      );
      const evidenceFor = (entityType, entityId, ownerType, ownerId) =>
        evidenceStatement.all(entityType, entityId, PUBLIC_SNAPSHOT_EVIDENCE_LIMIT).map((row) => ({
          sessionId: row.session_id,
          segmentId: row.transcript_segment_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          quote: row.quote_text,
          audioState: row.audio_state,
          handle: normalizeEvidenceContextRequest({
            ownerType,
            ownerId,
            evidenceId: row.id,
          }),
        }));

      const memoryOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.started_at, occurrence.ended_at,
                occurrence.confidence, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM memory_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.memory_value_id = ?
         ORDER BY occurrence.created_at DESC, occurrence.id DESC
         LIMIT ?`
      );
      const memories = this.db
        .prepare(
          `SELECT id, kind, title, body, confidence, lifecycle, provenance,
                  created_at, updated_at
           FROM memory_items_v2 ORDER BY updated_at DESC, id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
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
          occurrences: memoryOccurrences
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((occurrence) => ({
              id: occurrence.id,
              sessionId: occurrence.session_id,
              startedAt: occurrence.started_at,
              endedAt: occurrence.ended_at,
              confidence: occurrence.confidence,
              createdAt: occurrence.created_at,
              evidence: evidenceFor("memory_occurrence", occurrence.id, "memory_value", row.id),
            })),
        }));

      const topicRevisions = this.db.prepare(
        `SELECT id, revision, summary, provenance, created_at
         FROM topic_revisions WHERE topic_id = ? ORDER BY revision DESC
         LIMIT ?`
      );
      const topicOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.topic_revision_id, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM topic_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.topic_id = ? ORDER BY occurrence.created_at DESC, occurrence.id DESC
         LIMIT ?`
      );
      const topics = this.db
        .prepare(
          `SELECT id, name, lifecycle, provenance, created_at, updated_at
           FROM topics_v2 ORDER BY updated_at DESC, id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
        .map((row) => ({
          id: row.id,
          name: row.name,
          lifecycle: row.lifecycle,
          provenance: row.provenance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revisions: topicRevisions
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((revision) => ({
              id: revision.id,
              revision: revision.revision,
              summary: revision.summary,
              provenance: revision.provenance,
              createdAt: revision.created_at,
            })),
          occurrences: topicOccurrences
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((occurrence) => ({
              id: occurrence.id,
              sessionId: occurrence.session_id,
              revisionId: occurrence.topic_revision_id,
              createdAt: occurrence.created_at,
              evidence: evidenceFor(
                "topic_occurrence",
                occurrence.id,
                "topic_revision",
                occurrence.topic_revision_id
              ),
            })),
        }));

      const todoRevisions = this.db.prepare(
        `SELECT id, revision, title, due_text, provenance, created_at
         FROM todo_revisions WHERE todo_instance_id = ? ORDER BY revision DESC
         LIMIT ?`
      );
      const todoOccurrences = this.db.prepare(
        `SELECT occurrence.id, occurrence.todo_revision_id, occurrence.started_at,
                occurrence.ended_at, occurrence.created_at,
                COALESCE(occurrence.legacy_session_id, input.session_id) AS session_id
         FROM todo_occurrences AS occurrence
         LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
         WHERE occurrence.todo_instance_id = ?
         ORDER BY occurrence.created_at DESC, occurrence.id DESC
         LIMIT ?`
      );
      const todoTransitions = this.db.prepare(
        `SELECT id, from_status, to_status, reason, actor, occurred_at
         FROM todo_state_transitions WHERE todo_instance_id = ?
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`
      );
      const todos = this.db
        .prepare(
          `SELECT todo.id, todo.title, todo.status, todo.completed_at, todo.dismissed_at,
                  todo.provenance, todo.created_at, todo.updated_at,
                  todo.owner_display_name_snapshot AS owner_label
           FROM todos_v2 AS todo ORDER BY todo.updated_at DESC, todo.id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
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
          revisions: todoRevisions
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((revision) => ({
              id: revision.id,
              revision: revision.revision,
              title: revision.title,
              dueText: revision.due_text,
              provenance: revision.provenance,
              createdAt: revision.created_at,
            })),
          occurrences: todoOccurrences
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((occurrence) => ({
              id: occurrence.id,
              sessionId: occurrence.session_id,
              revisionId: occurrence.todo_revision_id,
              startedAt: occurrence.started_at,
              endedAt: occurrence.ended_at,
              createdAt: occurrence.created_at,
              evidence: evidenceFor("todo_occurrence", occurrence.id, "todo_instance", row.id),
            })),
          transitions: todoTransitions
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((transition) => ({
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
         ORDER BY occurrence.created_at DESC, occurrence.id DESC
         LIMIT ?`
      );
      const suggestions = this.db
        .prepare(
          `SELECT id, title, rationale, state, provenance, decided_at, created_at, updated_at
           FROM suggestions_v2 ORDER BY updated_at DESC, id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
        .map((row) => ({
          id: row.id,
          title: row.title,
          rationale: row.rationale,
          state: row.state,
          provenance: row.provenance,
          decidedAt: row.decided_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          occurrences: suggestionOccurrences
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((occurrence) => ({
              id: occurrence.id,
              sessionId: occurrence.session_id,
              createdAt: occurrence.created_at,
              evidence: evidenceFor("suggestion_occurrence", occurrence.id, "suggestion", row.id),
            })),
        }));

      const conflictMembers = this.db.prepare(
        `SELECT item.id, item.title, item.body, item.lifecycle
         FROM memory_conflict_members AS member
         JOIN memory_items_v2 AS item ON item.id = member.memory_item_id
         WHERE member.group_id = ? ORDER BY item.created_at, item.id
         LIMIT ?`
      );
      const memoryConflicts = this.db
        .prepare(
          `SELECT id, episode, state, selected_member_id, resolved_at, created_at, updated_at
           FROM memory_conflict_groups ORDER BY created_at DESC, id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
        .map((row) => ({
          id: row.id,
          episode: row.episode,
          state: row.state,
          selectedMemoryItemId: row.selected_member_id,
          resolvedAt: row.resolved_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          members: conflictMembers.all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT).map((member) => ({
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
        memoryConflicts,
      };
    });
    return read.deferred();
  }
}

module.exports = MemoryRepository;
