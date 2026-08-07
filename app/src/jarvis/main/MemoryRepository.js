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
const { compileRedactionTerms, normalizedSegmentContext } = require("./AnalysisInputBuilder");
const { MAX_DAILY_DIGEST_INPUT_BYTES } = require("./DailyDigestContractLimits");
const {
  DAILY_DIGEST_SCHEMA_VERSION,
  validateCandidateDailyDigest,
} = require("./DailyDigestSchema");
const {
  TODO_ATTRIBUTION_POLICY_VERSION,
  evaluateTodoAttribution,
} = require("./TodoAttributionPolicy");
const { ActivityOutputPolicy } = require("./ActivityOutputPolicy");
const {
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
} = require("../shared/contracts");
const ApplicationAudioPolicy = require("./ApplicationAudioPolicy");
const {
  buildActionEvidenceAttribution,
  buildCapturedTodoActionEvidenceAttribution,
} = require("./ActionEvidenceAttribution");
const { KnowledgeActionRepository } = require("./KnowledgeActionRepository");
const PersonalizationFeedbackRepository = require("./PersonalizationFeedbackRepository");
const { applyDailyDigestOutputPolicy } = require("./DailyDigestOutputPolicy");

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const APPLICATION_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v3";
const LEGACY_INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const CANONICAL_INPUT_VERSION = "jarvis-analysis-input-canonical-v3";
const LEGACY_CANONICAL_INPUT_VERSION = "jarvis-analysis-input-canonical-v2";
const PREPARE_TOKEN_VERSION = "jarvis-analysis-prepare-v1";
const LEGACY_IMPORTER_VERSION = "jarvis-legacy-analysis-v1";
const MAX_CLOUD_PAYLOAD_BYTES = 384 * 1024;
const MAX_ANALYSIS_CANDIDATE_BYTES = 512 * 1024;
const MAX_DAILY_DIGEST_CANDIDATE_BYTES = 512 * 1024;
const MIN_CLOUD_ANONYMOUS_SPEECH_MS = 5_000;
const MIN_CLOUD_ANONYMOUS_WINDOWS = 3;
const DAILY_DIGEST_INPUT_CONTRACT_VERSION = "jarvis-daily-digest-input-v1";
const DAILY_DIGEST_WATERMARK_VERSION = "jarvis-daily-digest-watermark-v2";
const PUBLIC_SNAPSHOT_LIST_LIMIT = 101;
const PUBLIC_SNAPSHOT_HISTORY_LIMIT = 20;
const PUBLIC_SNAPSHOT_EVIDENCE_LIMIT = 8;
const CARD_CONTEXT_SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const CARD_CONTEXT_ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
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
  "analysis_invalid_response",
  "analysis_candidate_apply_failed",
  "ANALYSIS_RESPONSE_INVALID",
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicAnalysisErrorCode(errorCode, blockedReason, fallback = "analysis_failed") {
  const raw =
    errorCode === "ANALYSIS_MANUAL_RETRY_AUTHORIZED" ? blockedReason : (errorCode ?? blockedReason);
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

function emptyKnowledgeCardContext() {
  return {
    sessionId: null,
    startedAt: null,
    applicationName: null,
    activityCategory: null,
    activityConfidence: null,
    sourceAttribution: "mixed_unknown",
  };
}

function latestCardEvidence(item, preferredSegmentIds = null) {
  const evidence = (Array.isArray(item?.occurrences) ? item.occurrences : [])
    .flatMap((occurrence) => (Array.isArray(occurrence?.evidence) ? occurrence.evidence : []))
    .filter(
      (entry) =>
        entry &&
        typeof entry.sessionId === "string" &&
        typeof entry.segmentId === "string" &&
        typeof entry.handle?.evidenceId === "string" &&
        (!preferredSegmentIds || preferredSegmentIds.has(entry.segmentId))
    );
  return (
    evidence.sort(
      (left, right) =>
        Number(right.startedAt ?? -1) - Number(left.startedAt ?? -1) ||
        Number(right.endedAt ?? -1) - Number(left.endedAt ?? -1) ||
        right.handle.evidenceId.localeCompare(left.handle.evidenceId)
    )[0] ?? null
  );
}

function latestCardSessionId(item) {
  const occurrence = (Array.isArray(item?.occurrences) ? item.occurrences : [])
    .filter((entry) => entry && typeof entry.sessionId === "string")
    .sort(
      (left, right) =>
        Number(right.createdAt ?? -1) - Number(left.createdAt ?? -1) ||
        right.sessionId.localeCompare(left.sessionId)
    )[0];
  return (
    occurrence?.sessionId ??
    (typeof item?.sourceSessionId === "string" ? item.sourceSessionId : null)
  );
}

function cardContextFromAttribution(sessionId, startedAt, attribution) {
  const context = emptyKnowledgeCardContext();
  context.sessionId = typeof sessionId === "string" ? sessionId : null;
  context.startedAt = Number.isSafeInteger(startedAt) && startedAt >= 0 ? startedAt : null;
  if (!attribution || !CARD_CONTEXT_SOURCE_ATTRIBUTIONS.has(attribution.sourceAttribution)) {
    return context;
  }
  context.sourceAttribution = attribution.sourceAttribution;
  if (
    (attribution.sourceAttribution === "microphone" &&
      attribution.applicationName === "Microphone") ||
    ((attribution.sourceAttribution === "application" ||
      attribution.sourceAttribution === "application_and_microphone") &&
      typeof attribution.applicationKey === "string" &&
      typeof attribution.applicationName === "string")
  ) {
    context.applicationName = attribution.applicationName;
  }
  const classification = attribution.activityClassification;
  if (
    classification &&
    CARD_CONTEXT_ACTIVITY_CATEGORIES.has(classification.category) &&
    typeof classification.confidence === "number" &&
    Number.isFinite(classification.confidence) &&
    classification.confidence >= 0 &&
    classification.confidence <= 1
  ) {
    context.activityCategory = classification.category;
    context.activityConfidence = classification.confidence;
  }
  return context;
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

function validateCandidate(
  candidate,
  { allowedSegmentIds, allowedOwnerLabels, allowedLearningGoalIds = new Set() }
) {
  try {
    return validateCandidateAnalysis(candidate, {
      allowedSegmentIds,
      allowedOwnerLabels,
      allowedLearningGoalIds,
    });
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
    this.activityOutputPolicy = new ActivityOutputPolicy();
    this.personalizationFeedbackRepository = new PersonalizationFeedbackRepository(db);
    this.knowledgeActionRepository = new KnowledgeActionRepository(db, {
      createId: (prefix) => this._nextId(prefix),
      feedbackRepository: this.personalizationFeedbackRepository,
    });
    this.actionVerificationByCandidate = new WeakMap();
    this.actionCenterWatermarkStatement = null;
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
    let participantSnapshotRevision;
    if (Object.prototype.hasOwnProperty.call(input, "participantSnapshotRevision")) {
      const value = input.participantSnapshotRevision;
      if (value === null) {
        participantSnapshotRevision = null;
      } else {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !hasExactKeys(value, ["revision", "sourceHash", "projectorVersion"])
        ) {
          throw new TypeError("participantSnapshotRevision must be an exact snapshot tuple");
        }
        const revision = assertTimestamp(value.revision, "participantSnapshotRevision.revision");
        if (revision < 1) {
          throw new TypeError("participantSnapshotRevision.revision must be positive");
        }
        participantSnapshotRevision = {
          revision,
          sourceHash: assertHash(value.sourceHash, "participantSnapshotRevision.sourceHash"),
          projectorVersion: assertText(
            value.projectorVersion,
            "participantSnapshotRevision.projectorVersion"
          ),
        };
      }
    }
    return {
      sessionId,
      transcriptRevision,
      identityRevision,
      promptVersion,
      segmentIds,
      participantSnapshotRevision,
    };
  }

  _classificationMatchesSegmentSource(classification, segment) {
    if (segment.source_type === "mic" || segment.track_kind === "mic") {
      return new Set(["microphone", "application_and_microphone"]).has(
        classification.source_attribution
      );
    }
    if (segment.track_kind === "application") {
      return new Set(["application", "application_and_microphone", "mixed_unknown"]).has(
        classification.source_attribution
      );
    }
    return classification.source_attribution === "mixed_unknown";
  }

  _classificationForAnalysisSegment(classifications, segment) {
    const sourcePriority = { local: 1, minimax: 2, user: 3 };
    return (
      classifications
        .filter(
          (classification) =>
            classification.started_at < segment.ended_at &&
            segment.started_at < classification.ended_at &&
            this._classificationMatchesSegmentSource(classification, segment)
        )
        .sort((left, right) => {
          const leftOverlap =
            Math.min(left.ended_at, segment.ended_at) -
            Math.max(left.started_at, segment.started_at);
          const rightOverlap =
            Math.min(right.ended_at, segment.ended_at) -
            Math.max(right.started_at, segment.started_at);
          const leftSpan = left.ended_at - left.started_at;
          const rightSpan = right.ended_at - right.started_at;
          return (
            rightOverlap - leftOverlap ||
            leftSpan - rightSpan ||
            (sourcePriority[right.source] ?? 0) - (sourcePriority[left.source] ?? 0) ||
            right.updated_at - left.updated_at ||
            right.id.localeCompare(left.id)
          );
        })[0] ?? null
    );
  }

  _analysisSegmentContext(segment, speakerBindingLabel, classifications) {
    const classification = this._classificationForAnalysisSegment(classifications, segment);
    const exactApplicationKey =
      segment.track_kind === "application" &&
      segment.attribution_state === "exact" &&
      typeof segment.application_key === "string" &&
      APPLICATION_KEY_PATTERN.test(segment.application_key)
        ? segment.application_key
        : null;
    const classifiedApplicationKeys = [
      ...new Set(
        (Array.isArray(classification?.evidence?.applicationKeys)
          ? classification.evidence.applicationKeys
          : []
        ).filter(
          (applicationKey) =>
            typeof applicationKey === "string" && APPLICATION_KEY_PATTERN.test(applicationKey)
        )
      ),
    ].sort();
    const sourceAttribution =
      classification?.source_attribution ??
      (segment.source_type === "mic" || segment.track_kind === "mic"
        ? "microphone"
        : exactApplicationKey
          ? "application"
          : "mixed_unknown");
    const applicationKey = ["application", "application_and_microphone"].includes(sourceAttribution)
      ? (exactApplicationKey ??
        (classifiedApplicationKeys.length === 1 ? classifiedApplicationKeys[0] : null))
      : null;
    try {
      return normalizedSegmentContext({
        applicationKey,
        sourceAttribution,
        activityCategory: classification?.category ?? "unknown",
        activityConfidence: classification?.confidence ?? 0,
        activityDecision: classification?.decision ?? "unknown",
        selfParticipated:
          speakerBindingLabel === "SELF" || classification?.evidence?.selfDetected === true,
      });
    } catch {
      return normalizedSegmentContext({
        applicationKey: null,
        sourceAttribution:
          segment.source_type === "mic" || segment.track_kind === "mic"
            ? "microphone"
            : "mixed_unknown",
        activityCategory: "unknown",
        activityConfidence: 0,
        activityDecision: "unknown",
        selfParticipated: speakerBindingLabel === "SELF",
      });
    }
  }

  _deriveLiveInput(normalized) {
    const {
      sessionId,
      transcriptRevision,
      identityRevision,
      promptVersion,
      segmentIds,
      participantSnapshotRevision,
    } = normalized;
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
      throw codedError("MEMORY_SESSION_NOT_FOUND");
    }

    const participantSnapshot = this.db
      .prepare(
        `SELECT id, revision, projector_version, source_hash
         FROM session_participant_snapshots
         WHERE session_id = ?
         ORDER BY revision DESC LIMIT 1`
      )
      .get(sessionId);
    const participantProjectionActive = Boolean(participantSnapshot);
    if (participantSnapshotRevision !== undefined) {
      const matchesExpectedSnapshot =
        participantSnapshotRevision === null
          ? !participantSnapshot
          : participantSnapshot &&
            participantSnapshot.revision === participantSnapshotRevision.revision &&
            participantSnapshot.source_hash === participantSnapshotRevision.sourceHash &&
            participantSnapshot.projector_version === participantSnapshotRevision.projectorVersion;
      if (!matchesExpectedSnapshot) throw codedError("MEMORY_PREPARE_STALE");
    }

    // Use the latest durable participant projection as the cloud-facing identity
    // boundary. It collapses duplicate/churned diarization clusters into one local
    // participant and keeps media voices out of summaries without exposing the
    // projection or any real identity to the provider.
    const participantMemberships = this.db
      .prepare(
        `SELECT membership.participant_ref, membership.cluster_id,
                membership.membership_kind, link.transcript_segment_id
         FROM session_participant_snapshots AS snapshot
         JOIN session_participant_snapshot_clusters AS membership
           ON membership.snapshot_id = snapshot.id
         LEFT JOIN speaker_cluster_segments AS link
           ON link.cluster_id = membership.cluster_id
         WHERE snapshot.id = ?
         ORDER BY
           CASE membership.membership_kind
             WHEN 'self' THEN 0
             WHEN 'known' THEN 1
             WHEN 'reviewed' THEN 2
             WHEN 'anonymous' THEN 3
             WHEN 'temporary' THEN 4
             ELSE 5
           END,
           membership.participant_ref, membership.cluster_id`
      )
      .all(participantSnapshot?.id ?? null);
    const participantMembershipByCluster = new Map();
    const participantMembershipBySegment = new Map();
    for (const membership of participantMemberships) {
      const projected = {
        participantRef: membership.participant_ref,
        clusterId: membership.cluster_id,
        membershipKind: membership.membership_kind,
      };
      participantMembershipByCluster.set(membership.cluster_id, projected);
      if (
        membership.transcript_segment_id &&
        !participantMembershipBySegment.has(membership.transcript_segment_id)
      ) {
        participantMembershipBySegment.set(membership.transcript_segment_id, projected);
      }
    }

    const labelsBySubject = new Map();
    const bindings = [];
    const deviceLabels = new Set();
    const classifications = this._effectiveActivityActionClassifications(sessionId);
    let nextOtherLabel = 1;
    const selectedSegments = segmentIds.map((segmentId) =>
      this.db
        .prepare(
          `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                  segment.version, segment.text, segment.person_id, segment.result_kind,
                  segment.is_stable, segment.superseded_by, segment.duplicate_of,
                  segment.projection_state,
                  segment.source_type,
                  track.device_label, track.track_kind, track.application_key,
                  track.application_display_name, track.attribution_state
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
    let selectedOrdinal = 0;
    const segments = selectedSegments.flatMap((segment) => {
      if (
        !segment ||
        segment.session_id !== sessionId ||
        segment.result_kind !== "final" ||
        segment.is_stable !== 1 ||
        segment.superseded_by !== null ||
        segment.duplicate_of !== null ||
        segment.projection_state !== "visible" ||
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
      if (
        segment.track_kind === "application" &&
        ApplicationAudioPolicy.isVirtualAudioInfrastructure({
          applicationKey: segment.application_key,
          applicationDisplayName: segment.application_display_name,
        })
      ) {
        return [];
      }
      const projectedSegmentParticipant = participantMembershipBySegment.get(segment.id) ?? null;
      if (projectedSegmentParticipant?.membershipKind === "media") return [];

      let subject;
      if (segment.person_id) {
        const person = this.db
          .prepare("SELECT id, display_name, is_self FROM people WHERE id = ?")
          .get(segment.person_id);
        if (!person?.display_name?.trim()) return [];
        if (
          participantProjectionActive &&
          person.is_self !== 1 &&
          projectedSegmentParticipant === null
        ) {
          return [];
        }
        if (person.is_self !== 1) {
          const confirmed = this.db
            .prepare(
              `SELECT 1
               FROM speaker_cluster_segments AS link
               JOIN speaker_clusters AS cluster ON cluster.id = link.cluster_id
               WHERE link.transcript_segment_id = ?
                 AND cluster.session_id = ?
                 AND cluster.person_id = ?
                 AND cluster.link_state = 'confirmed'
               LIMIT 1`
            )
            .get(segment.id, sessionId, person.id);
          if (!confirmed) return [];
        }
        subject = {
          key: projectedSegmentParticipant
            ? `participant_projection:${projectedSegmentParticipant.participantRef}`
            : `person:${person.id}`,
          subjectKind: "person",
          subjectId: person.id,
          subjectDisplayNameSnapshot: person.display_name,
          isSelf: person.is_self === 1 || projectedSegmentParticipant?.membershipKind === "self",
        };
      } else {
        const cluster = this.db
          .prepare(
            `SELECT cluster.id, cluster.local_label, cluster_track.track_kind,
                    cluster_track.application_key, cluster_track.attribution_state,
                    CASE
                      WHEN resolution.resolution_state = 'unknown'
                       AND resolution.reason IN (
                         'dual_model_anonymous_group',
                         'dual_model_anonymous_profile'
                       )
                      THEN resolution.candidate_person_ref
                      ELSE NULL
                    END AS anonymous_person_ref
             FROM speaker_cluster_segments AS link
             JOIN speaker_clusters AS cluster ON cluster.id = link.cluster_id
             JOIN audio_tracks AS cluster_track ON cluster_track.id = cluster.track_id
             LEFT JOIN speaker_identity_resolutions AS resolution
               ON resolution.id = (
                 SELECT candidate.id
                 FROM speaker_identity_resolutions AS candidate
                 JOIN speaker_identity_resolution_runs AS run
                   ON run.id = candidate.resolution_run_id
                 WHERE candidate.cluster_id = cluster.id
                   AND candidate.actor = 'system'
                 ORDER BY run.commit_sequence DESC, candidate.rowid DESC
                 LIMIT 1
             )
             WHERE link.transcript_segment_id = ? AND cluster.session_id = ?
               AND (
                 NOT EXISTS (
                   SELECT 1
                   FROM speaker_diarization_runs AS any_run
                   WHERE any_run.session_id = cluster.session_id
                     AND any_run.track_id = cluster.track_id
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM speaker_diarization_run_clusters AS membership
                   JOIN speaker_diarization_runs AS current_run
                     ON current_run.id = membership.run_id
                   WHERE membership.cluster_id = cluster.id
                     AND current_run.id = (
                       SELECT latest_run.id
                       FROM speaker_diarization_runs AS latest_run
                       WHERE latest_run.session_id = cluster.session_id
                         AND latest_run.track_id = cluster.track_id
                       ORDER BY latest_run.commit_sequence DESC, latest_run.id DESC
                       LIMIT 1
                     )
                 )
               )
               AND (
                 cluster.link_state = 'confirmed'
                 OR (
                   cluster.speech_ms >= ?
                   AND cluster.window_count >= ?
                 )
               )
             ORDER BY
               CASE cluster.link_state WHEN 'confirmed' THEN 0 ELSE 1 END,
               cluster.speech_ms DESC,
               cluster.window_count DESC,
               COALESCE(cluster.quality_score, 0) DESC,
               cluster.id
             LIMIT 1`
          )
          .get(segment.id, sessionId, MIN_CLOUD_ANONYMOUS_SPEECH_MS, MIN_CLOUD_ANONYMOUS_WINDOWS);
        if (!cluster?.local_label?.trim()) return [];
        const projectedParticipant =
          participantMembershipByCluster.get(cluster.id) ?? projectedSegmentParticipant;
        if (projectedParticipant?.membershipKind === "media") return [];
        if (participantProjectionActive && !projectedParticipant) return [];
        const applicationSpeakerKey =
          cluster.track_kind === "application" &&
          cluster.attribution_state === "exact" &&
          cluster.application_key?.trim()
            ? `application_speaker:${cluster.application_key
                .trim()
                .toLocaleLowerCase()}:${cluster.local_label.trim().toLocaleLowerCase()}`
            : null;
        subject = {
          key: projectedParticipant
            ? `participant_projection:${projectedParticipant.participantRef}`
            : cluster.anonymous_person_ref
              ? `anonymous_speaker:${cluster.anonymous_person_ref}`
              : (applicationSpeakerKey ?? `speaker_cluster:${cluster.id}`),
          subjectKind: "speaker_cluster",
          subjectId: cluster.id,
          subjectDisplayNameSnapshot: cluster.local_label,
          isSelf: projectedParticipant?.membershipKind === "self",
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
      const segmentContext = this._analysisSegmentContext(segment, label, classifications);
      return [
        {
          ordinal: selectedOrdinal++,
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
          ...segmentContext,
        },
      ];
    });
    if (segments.length === 0) throw codedError("MEMORY_OWNER_OUT_OF_SCOPE");

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
    const learningGoals = this.db
      .prepare(
        `SELECT id, title FROM learning_goals
         WHERE state = 'confirmed' ORDER BY id LIMIT 32`
      )
      .all()
      .map((goal) => ({ goalId: goal.id, title: goal.title }));
    return {
      sessionId,
      transcriptRevision,
      identityRevision,
      promptVersion,
      segmentIds: segments.map((segment) => segment.segmentId),
      segments,
      speakerBindings: bindings,
      learningGoals,
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
      ...(prepared.learningGoals?.length
        ? {
            learningGoals: prepared.learningGoals.map((goal) => ({
              goalId: goal.goalId,
              titleHash: sha256(goal.title),
            })),
          }
        : {}),
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
        applicationKey: segment.applicationKey,
        sourceAttribution: segment.sourceAttribution,
        activityCategory: segment.activityCategory,
        activityConfidence: segment.activityConfidence,
        activityDecision: segment.activityDecision,
        selfParticipated: segment.selfParticipated,
        memoryMode: segment.memoryMode,
        allowedSuggestionBases: segment.allowedSuggestionBases,
        todoCandidateAllowed: segment.todoCandidateAllowed,
      })),
    };
  }

  _prepareToken(prepared) {
    return sha256(canonicalJson(this._prepareTokenTuple(prepared)));
  }

  _validateCloudPayload(cloudPayloadJson, inputContractVersion, prepared) {
    if (![INPUT_CONTRACT_VERSION, LEGACY_INPUT_CONTRACT_VERSION].includes(inputContractVersion)) {
      throw codedError("MEMORY_INPUT_CONTRACT_UNSUPPORTED");
    }
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
    const payloadKeys = Object.keys(payload).sort();
    const baseKeys = ["inputVersion", "segments", "omittedRanges"].sort();
    const goalKeys = ["inputVersion", "learningGoals", "segments", "omittedRanges"].sort();
    const validPayloadKeys =
      (payloadKeys.length === baseKeys.length &&
        payloadKeys.every((key, index) => key === baseKeys[index])) ||
      (payloadKeys.length === goalKeys.length &&
        payloadKeys.every((key, index) => key === goalKeys[index]));
    if (
      !validPayloadKeys ||
      payload.inputVersion !== inputContractVersion ||
      !Array.isArray(payload.segments) ||
      payload.segments.length === 0 ||
      !Array.isArray(payload.omittedRanges)
    ) {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    const learningGoals = payload.learningGoals ?? [];
    if (!Array.isArray(learningGoals) || learningGoals.length > 32) {
      throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
    }
    const selectedLearningGoalIds = [];
    for (const goal of learningGoals) {
      if (
        !hasExactKeys(goal, ["goalId", "title"]) ||
        typeof goal.goalId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(goal.goalId) ||
        selectedLearningGoalIds.includes(goal.goalId) ||
        typeof goal.title !== "string" ||
        !goal.title.trim() ||
        Array.from(goal.title).length > 500
      ) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
      selectedLearningGoalIds.push(goal.goalId);
    }
    if (Array.isArray(prepared.learningGoals)) {
      const expectedLearningGoalIds = prepared.learningGoals.map((goal) => goal.goalId).sort();
      if (
        JSON.stringify([...selectedLearningGoalIds].sort()) !==
        JSON.stringify(expectedLearningGoalIds)
      ) {
        throw codedError("MEMORY_CLOUD_PAYLOAD_INVALID");
      }
    }
    const manifestById = new Map(prepared.segments.map((segment) => [segment.segmentId, segment]));
    const segmentKeys =
      inputContractVersion === INPUT_CONTRACT_VERSION
        ? [
            "segmentId",
            "startedAt",
            "endedAt",
            "speakerLabel",
            "applicationKey",
            "sourceAttribution",
            "activityCategory",
            "activityConfidence",
            "activityDecision",
            "selfParticipated",
            "memoryMode",
            "allowedSuggestionBases",
            "todoCandidateAllowed",
            "text",
          ]
        : ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"];
    let lastOrdinal = -1;
    const selected = new Set();
    for (const segment of payload.segments) {
      if (
        !hasExactKeys(segment, segmentKeys) ||
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
        segment.speakerLabel !== manifest.speakerBindingLabel ||
        (inputContractVersion === INPUT_CONTRACT_VERSION &&
          (segment.applicationKey !== manifest.applicationKey ||
            segment.sourceAttribution !== manifest.sourceAttribution ||
            segment.activityCategory !== manifest.activityCategory ||
            segment.activityConfidence !== manifest.activityConfidence ||
            segment.activityDecision !== manifest.activityDecision ||
            segment.selfParticipated !== manifest.selfParticipated ||
            segment.memoryMode !== manifest.memoryMode ||
            JSON.stringify(segment.allowedSuggestionBases) !==
              JSON.stringify(manifest.allowedSuggestionBases) ||
            segment.todoCandidateAllowed !== manifest.todoCandidateAllowed))
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
    // Omitted ranges describe omitted segment time spans, not gaps in one
    // continuous timeline. Independent microphone and application tracks can
    // legitimately overlap a selected segment. Exact canonical-range matching
    // above still proves that every omitted range came from the prepared
    // manifest without rejecting valid multi-track captures.
    const selectedOwnerLabels = prepared.speakerBindings
      .map((binding) => binding.label)
      .filter((label) => payload.segments.some((segment) => segment.speakerLabel === label));
    return {
      payload,
      bytes,
      sha256: sha256(cloudPayloadJson),
      selectedSegmentIds: payload.segments.map((segment) => segment.segmentId),
      selectedOwnerLabels,
      selectedLearningGoalIds,
    };
  }

  _canonicalInputTuple(prepared, persisted) {
    const isCurrentContract = persisted.inputContractVersion === INPUT_CONTRACT_VERSION;
    return {
      schemaVersion: isCurrentContract ? CANONICAL_INPUT_VERSION : LEGACY_CANONICAL_INPUT_VERSION,
      sessionId: prepared.sessionId,
      transcriptRevision: prepared.transcriptRevision,
      identityRevision: prepared.identityRevision,
      promptVersion: prepared.promptVersion,
      inputContractVersion: persisted.inputContractVersion,
      redactionVersion: persisted.redactionVersion,
      cloudPayloadBytes: persisted.cloudPayloadBytes,
      cloudPayloadSha256: persisted.cloudPayloadSha256,
      speakerBindings: prepared.speakerBindings,
      ...(prepared.learningGoals?.length
        ? { learningGoalIds: prepared.learningGoals.map((goal) => goal.goalId).sort() }
        : {}),
      segments: prepared.segments.map((segment) => ({
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
        segmentVersion: segment.segmentVersion,
        textHash: segment.textHash,
        speakerBindingLabel: segment.speakerBindingLabel,
        ...(isCurrentContract
          ? {
              applicationKey: segment.applicationKey,
              sourceAttribution: segment.sourceAttribution,
              activityCategory: segment.activityCategory,
              activityConfidence: segment.activityConfidence,
              activityDecision: segment.activityDecision,
              selfParticipated: segment.selfParticipated,
              memoryMode: segment.memoryMode,
              allowedSuggestionBases: segment.allowedSuggestionBases,
              todoCandidateAllowed: segment.todoCandidateAllowed,
            }
          : {}),
      })),
    };
  }

  _loadStoredAnalysisInput(analysisInputId) {
    const row = this.db.prepare("SELECT * FROM analysis_inputs WHERE id = ?").get(analysisInputId);
    if (!row) return null;
    const segments = this.db
      .prepare(
        `SELECT ordinal, segment_id, segment_version, text_hash, text_snapshot,
                speaker_binding_label, application_key, source_attribution,
                activity_category, activity_confidence, activity_decision,
                self_participated, memory_mode, allowed_suggestion_bases_json,
                todo_candidate_allowed
         FROM analysis_input_segments WHERE analysis_input_id = ? ORDER BY ordinal`
      )
      .all(analysisInputId)
      .map((segment) => {
        const base = {
          ordinal: segment.ordinal,
          segmentId: segment.segment_id,
          segmentVersion: segment.segment_version,
          textHash: segment.text_hash,
          textSnapshot: segment.text_snapshot,
          speakerBindingLabel: segment.speaker_binding_label,
        };
        if (row.input_contract_version === LEGACY_INPUT_CONTRACT_VERSION) return base;
        if (row.input_contract_version !== INPUT_CONTRACT_VERSION) {
          throw codedError("MEMORY_INPUT_CORRUPT");
        }
        let allowedSuggestionBases;
        try {
          allowedSuggestionBases = JSON.parse(segment.allowed_suggestion_bases_json);
        } catch {
          throw codedError("MEMORY_INPUT_CORRUPT");
        }
        let context;
        try {
          context = normalizedSegmentContext({
            applicationKey: segment.application_key,
            sourceAttribution: segment.source_attribution,
            activityCategory: segment.activity_category,
            activityConfidence: segment.activity_confidence,
            activityDecision: segment.activity_decision,
            selfParticipated: segment.self_participated === 1,
          });
        } catch {
          throw codedError("MEMORY_INPUT_CORRUPT");
        }
        if (
          segment.self_participated !== (context.selfParticipated ? 1 : 0) ||
          segment.memory_mode !== context.memoryMode ||
          segment.todo_candidate_allowed !== (context.todoCandidateAllowed ? 1 : 0) ||
          JSON.stringify(allowedSuggestionBases) !== JSON.stringify(context.allowedSuggestionBases)
        ) {
          throw codedError("MEMORY_INPUT_CORRUPT");
        }
        return { ...base, ...context };
      });
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
    prepared.learningGoals = (payload.payload.learningGoals ?? []).map((goal) => ({ ...goal }));
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
             AND projection_state = 'visible'
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
             AND projection_state = 'visible'
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
             AND projection_state = 'visible'
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
             AND projection_state = 'visible'
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
             AND projection_state = 'visible'
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
             AND segment.projection_state = 'visible'
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
          `SELECT session_id, job_type
           FROM processing_jobs
           WHERE session_id IN (${placeholders})
              AND job_type <> 'generate_daily_digest'
              AND completed_at IS NULL
              AND state NOT IN (
                'completed','failed','cancelled','superseded','audio_expired_before_processing'
              )
           GROUP BY session_id, job_type
           ORDER BY session_id, job_type`
        )
        .all(...rawSessionIds);
      const incompleteSegmentCount = this.db
        .prepare(
          `SELECT count(*) AS count
           FROM transcript_segments
           WHERE started_at < ? AND ended_at > ?
             AND superseded_by IS NULL
             AND duplicate_of IS NULL
             AND projection_state = 'visible'
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
           text_snapshot, speaker_binding_label, application_key, source_attribution,
           activity_category, activity_confidence, activity_decision, self_participated,
           memory_mode, allowed_suggestion_bases_json, todo_candidate_allowed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const segment of prepared.segments) {
        insertSegment.run(
          analysisInputId,
          segment.ordinal,
          segment.segmentId,
          segment.segmentVersion,
          segment.textHash,
          segment.textSnapshot,
          segment.speakerBindingLabel,
          segment.applicationKey,
          segment.sourceAttribution,
          segment.activityCategory,
          segment.activityConfidence,
          segment.activityDecision,
          segment.selfParticipated ? 1 : 0,
          segment.memoryMode,
          JSON.stringify(segment.allowedSuggestionBases),
          segment.todoCandidateAllowed ? 1 : 0
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
        allowedLearningGoalIds: [...stored.payload.selectedLearningGoalIds],
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
    const legacyExpectedKeys = [
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
    const expectedKeys = [...legacyExpectedKeys, "activityClassificationRevision"];
    const hasCurrentShape = hasExactKeys(vector, expectedKeys);
    const hasLegacyShape = hasExactKeys(vector, legacyExpectedKeys);
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
      (!hasCurrentShape && !hasLegacyShape) ||
      (hasCurrentShape && !/^[0-9a-f]{64}$/u.test(vector.activityClassificationRevision)) ||
      !validSegments ||
      vector.analysisInputId !== row.analysis_input_id ||
      !safeHashEqual(vector.analysisInputHash, row.analysis_input_hash) ||
      !safeHashEqual(sha256(canonicalJson(vector)), row.desired_vector_hash)
    ) {
      throw codedError("MEMORY_DESIRED_HEAD_CORRUPT");
    }
    return {
      ...vector,
      activityClassificationRevision: hasCurrentShape
        ? vector.activityClassificationRevision
        : null,
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
    const hasActivityClassificationRevision = Object.prototype.hasOwnProperty.call(
      input,
      "activityClassificationRevision"
    );
    const activityClassificationRevision = hasActivityClassificationRevision
      ? assertHash(input.activityClassificationRevision, "activityClassificationRevision")
      : null;
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
        ...(hasActivityClassificationRevision ? { activityClassificationRevision } : {}),
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
        allowedLearningGoalIds: new Set(stored.payload.selectedLearningGoalIds),
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

  _dailyDigestOutputPolicyContext(storedInput) {
    const segmentIds = storedInput.inputWatermark.evidence.map((entry) => entry.segmentId);
    const rows = this.db
      .prepare(
        `SELECT segment.id, segment.session_id, segment.started_at, segment.ended_at,
                segment.speaker_label, segment.source_type,
                track.track_kind, track.application_key, track.attribution_state
         FROM transcript_segments AS segment
         LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
         JOIN json_each(?) AS selected ON selected.value = segment.id
         ORDER BY segment.session_id, segment.started_at, segment.ended_at, segment.id`
      )
      .all(JSON.stringify(segmentIds));
    if (rows.length !== new Set(segmentIds).size) {
      throw codedError("DAILY_DIGEST_INPUT_CORRUPT");
    }
    const classificationsBySession = new Map();
    const result = new Map();
    for (const segment of rows) {
      let classifications = classificationsBySession.get(segment.session_id);
      if (!classifications) {
        classifications = this._effectiveActivityActionClassifications(segment.session_id);
        classificationsBySession.set(segment.session_id, classifications);
      }
      const classification = this._classificationForAnalysisSegment(classifications, segment);
      const context = this._analysisSegmentContext(segment, segment.speaker_label, classifications);
      result.set(segment.id, {
        category: context.activityCategory,
        confidence: context.activityConfidence,
        decision: context.activityDecision,
        sourceAttribution: context.sourceAttribution,
        selfParticipated: context.selfParticipated,
        allowSuggestions:
          classification?.evidence?.allowSuggestions === true &&
          context.allowedSuggestionBases.length > 0,
        applicationKey: context.applicationKey,
      });
    }
    return result;
  }

  _projectDailyDigestCandidate(storedInput, candidate) {
    return applyDailyDigestOutputPolicy(
      candidate,
      this._dailyDigestOutputPolicyContext(storedInput)
    );
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
      const candidateContext = this._dailyDigestCandidateContext(storedInput);
      const candidate = validateCandidateDailyDigest(
        this._projectDailyDigestCandidate(
          storedInput,
          validateCandidateDailyDigest(input.candidate, candidateContext)
        ),
        candidateContext
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
      const context = this._candidateContext({
        id: candidateRow.analysis_input_id,
        session_id: inputRow.session_id,
      });
      const projectionCandidate = this._cloudActionProjectionCandidate(
        inputRow,
        candidate,
        context
      );
      const result = this.applyCandidateAnalysis({
        analysisInputId: candidateRow.analysis_input_id,
        inputHash: inputRow.input_hash,
        candidate: projectionCandidate,
      });
      const applied = this.db
        .prepare(
          `UPDATE analysis_response_candidates
           SET state = 'applied', disposition_at = ?
           WHERE id = ? AND state = 'validated' AND disposition_at IS NULL`
        )
        .run(at, candidateId);
      if (applied.changes !== 1) throw codedError("MEMORY_CAS_CONFLICT");
      return {
        ...result,
        candidateHash: candidateRow.candidate_hash,
        rawCandidateHash: candidateRow.candidate_hash,
      };
    });
    return transaction.immediate();
  }

  _nextId(prefix) {
    return assertId(this.createId(prefix), `${prefix}Id`);
  }

  applyKnowledgeAction(input) {
    return this.knowledgeActionRepository.apply(input);
  }

  _candidateContext(inputRow) {
    const manifest = this.db
      .prepare(
        `SELECT manifest.ordinal, manifest.segment_id, manifest.segment_version,
                manifest.text_hash, manifest.text_snapshot, manifest.speaker_binding_label,
                manifest.application_key AS input_application_key,
                manifest.source_attribution AS input_source_attribution,
                manifest.activity_category AS input_activity_category,
                manifest.activity_confidence AS input_activity_confidence,
                manifest.activity_decision AS input_activity_decision,
                manifest.self_participated AS input_self_participated,
                manifest.memory_mode AS input_memory_mode,
                manifest.allowed_suggestion_bases_json AS input_allowed_suggestion_bases_json,
                manifest.todo_candidate_allowed AS input_todo_candidate_allowed,
                segment.session_id, segment.started_at, segment.ended_at, segment.version,
                segment.text, segment.source_type, segment.result_kind, segment.is_stable,
                segment.superseded_by,
                segment.duplicate_of, segment.chunk_id, segment.track_id,
                segment.confidence AS transcript_confidence,
                track.track_kind, track.application_key, track.attribution_state,
                chunk.deleted_at
         FROM analysis_input_segments AS manifest
         JOIN transcript_segments AS segment ON segment.id = manifest.segment_id
         LEFT JOIN audio_chunks AS chunk ON chunk.id = segment.chunk_id
         LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
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

  _effectiveActivityActionClassifications(sessionId) {
    const sourcePriority = { local: 1, minimax: 2, user: 3 };
    const history = this.db
      .prepare(
        `SELECT started_at, ended_at, category, confidence, decision, source, reason,
                 source_attribution, evidence_json, updated_at, id
         FROM activity_classifications
         WHERE session_id = ?
         ORDER BY started_at, ended_at, updated_at, id`
      )
      .all(sessionId)
      .map((row) => {
        let evidence = null;
        try {
          evidence = JSON.parse(row.evidence_json);
        } catch {
          // A malformed local policy record must fail closed for projected actions.
        }
        return { ...row, evidence };
      });
    const byActivityWindow = new Map();
    for (const entry of history) {
      const key = `${entry.started_at}\0${entry.ended_at}`;
      const entries = byActivityWindow.get(key) ?? [];
      entries.push(entry);
      byActivityWindow.set(key, entries);
    }
    const newer = (left, right) =>
      left.updated_at > right.updated_at ||
      (left.updated_at === right.updated_at && left.id > right.id);
    const evidenceBasis = (entry) => {
      const evidence = entry.evidence ?? {};
      return JSON.stringify({
        applicationKeys: [...new Set(evidence.applicationKeys ?? [])].sort(),
        microphoneParticipated: evidence.microphoneParticipated === true,
        selfDetected: evidence.selfDetected === true,
        speakerCount: Number.isSafeInteger(evidence.speakerCount) ? evidence.speakerCount : 0,
        timeBucket: typeof evidence.timeBucket === "string" ? evidence.timeBucket : null,
        personalizationRuleId:
          typeof evidence.personalizationRuleId === "string"
            ? evidence.personalizationRuleId
            : null,
        sourceAttribution: entry.source_attribution ?? null,
      });
    };
    const select = (entries) => {
      const userEntries = entries.filter((entry) => entry.source === "user");
      if (userEntries.length > 0) {
        return userEntries.reduce((current, entry) => (newer(entry, current) ? entry : current));
      }
      const localEntries = entries.filter((entry) => entry.source === "local");
      const candidates =
        localEntries.length === 0
          ? entries
          : (() => {
              const latestLocal = localEntries.reduce((current, entry) =>
                newer(entry, current) ? entry : current
              );
              const basis = evidenceBasis(latestLocal);
              return entries.filter((entry) => evidenceBasis(entry) === basis);
            })();
      return candidates.reduce((current, entry) => {
        if (sourcePriority[entry.source] > sourcePriority[current.source]) return entry;
        if (
          sourcePriority[entry.source] === sourcePriority[current.source] &&
          newer(entry, current)
        ) {
          return entry;
        }
        return current;
      });
    };
    return [...byActivityWindow.values()]
      .map(select)
      .sort(
        (left, right) =>
          left.started_at - right.started_at ||
          left.ended_at - right.ended_at ||
          left.id.localeCompare(right.id)
      );
  }

  getActivityActionPolicyRevision(sessionId) {
    const id = assertId(sessionId, "sessionId");
    const classifications = this._effectiveActivityActionClassifications(id);
    return sha256(
      canonicalJson(
        classifications.map((classification) => ({
          startedAt: classification.started_at,
          endedAt: classification.ended_at,
          category: classification.category,
          confidence: classification.confidence,
          decision: classification.decision,
          sourceAttribution: classification.source_attribution,
          allowTodos: classification.evidence?.allowTodos === true,
          allowSuggestions: classification.evidence?.allowSuggestions === true,
        }))
      )
    );
  }

  _todoSpeakerTrust(inputRow, context, segment) {
    const binding = context.bindingByLabel.get(segment.speaker_binding_label) ?? null;
    const resolution = this.db
      .prepare(
        `SELECT identity.candidate_person_id, identity.resolution_state,
                identity.match_score, identity.reason, identity.projection_applied,
                person.is_self, track.track_kind, track.attribution_state,
                (
                  SELECT COUNT(*)
                  FROM speaker_cluster_model_embeddings AS embedding
                  WHERE embedding.cluster_id = cluster.id
                ) AS embedding_model_count,
                EXISTS(
                  SELECT 1
                  FROM speaker_cluster_model_embeddings AS embedding
                  WHERE embedding.cluster_id = cluster.id
                    AND (
                      embedding.overlap_detected = 1
                      OR embedding.echo_detected = 1
                      OR embedding.attribution_state <> 'exact'
                    )
                ) AS untrusted_embedding,
                EXISTS(
                  SELECT 1
                  FROM speaker_turns AS turn
                  LEFT JOIN speaker_turns AS other
                    ON other.run_id = turn.run_id
                   AND other.cluster_id <> turn.cluster_id
                   AND other.started_at < turn.ended_at
                   AND turn.started_at < other.ended_at
                  WHERE turn.transcript_segment_id = link.transcript_segment_id
                    AND (
                      turn.echo_state <> 'none'
                      OR turn.duplicate_of_turn_id IS NOT NULL
                      OR other.id IS NOT NULL
                    )
                ) AS overlap_or_echo
                ,(
                  SELECT COUNT(*)
                  FROM speaker_identity_resolution_model_evidence AS model_evidence
                  WHERE model_evidence.resolution_id = identity.id
                ) AS resolution_model_count
                ,EXISTS(
                  SELECT 1
                  FROM speaker_identity_resolution_model_evidence AS model_evidence
                  WHERE model_evidence.resolution_id = identity.id
                    AND model_evidence.passed <> 1
                ) AS resolution_model_failed
         FROM speaker_cluster_segments AS link
         JOIN speaker_clusters AS cluster ON cluster.id = link.cluster_id
         LEFT JOIN audio_tracks AS track ON track.id = cluster.track_id
         JOIN speaker_identity_resolutions AS identity ON identity.cluster_id = cluster.id
         JOIN speaker_identity_resolution_runs AS identity_run
           ON identity_run.id = identity.resolution_run_id
         LEFT JOIN people AS person ON person.id = identity.candidate_person_id
         WHERE link.transcript_segment_id = ?
           AND cluster.session_id = ?
           AND identity.actor = 'system'
         ORDER BY identity_run.commit_sequence DESC, identity.rowid DESC
         LIMIT 1`
      )
      .get(segment.segment_id, inputRow.session_id);
    const relation = segment.speaker_binding_label;
    const isSelf = relation === "SELF";
    const bindingMatches =
      binding?.subject_kind === "person" &&
      resolution?.candidate_person_id === binding.subject_id &&
      (isSelf ? resolution?.is_self === 1 : resolution?.is_self !== 1);
    const reasonMatches = isSelf
      ? resolution?.reason === "dual_model_self_enrollment_confirmed"
      : resolution?.reason === "dual_model_auto_confirmed";
    const sourceMatches = isSelf
      ? resolution?.track_kind === "mic" && resolution?.attribution_state === "exact"
      : resolution?.attribution_state === "exact";
    const overlapDetected =
      resolution?.untrusted_embedding === 1 || resolution?.overlap_or_echo === 1;
    const verified = Boolean(
      resolution &&
      resolution.resolution_state === "confirmed" &&
      resolution.projection_applied === 1 &&
      Number(resolution.embedding_model_count) >= 2 &&
      Number(resolution.resolution_model_count) >= 2 &&
      resolution.resolution_model_failed !== 1 &&
      typeof resolution.match_score === "number" &&
      bindingMatches &&
      reasonMatches &&
      sourceMatches &&
      !overlapDetected
    );
    return {
      voiceConfidence:
        typeof resolution?.match_score === "number" && Number.isFinite(resolution.match_score)
          ? Math.max(0, resolution.match_score)
          : 0,
      speakerEvidenceVerified: verified,
      overlapDetected,
    };
  }

  _analysisPolicySnapshotForSegment(segment, classifications) {
    const hasStoredSnapshot = segment.input_source_attribution !== null;
    if (!hasStoredSnapshot) {
      return this._analysisSegmentContext(segment, segment.speaker_binding_label, classifications);
    }
    let allowedSuggestionBases;
    try {
      allowedSuggestionBases = JSON.parse(segment.input_allowed_suggestion_bases_json);
    } catch {
      throw codedError("MEMORY_INPUT_CORRUPT");
    }
    let snapshot;
    try {
      snapshot = normalizedSegmentContext({
        applicationKey: segment.input_application_key,
        sourceAttribution: segment.input_source_attribution,
        activityCategory: segment.input_activity_category,
        activityConfidence: segment.input_activity_confidence,
        activityDecision: segment.input_activity_decision,
        selfParticipated: segment.input_self_participated === 1,
      });
    } catch {
      throw codedError("MEMORY_INPUT_CORRUPT");
    }
    if (
      segment.input_self_participated !== (snapshot.selfParticipated ? 1 : 0) ||
      segment.input_memory_mode !== snapshot.memoryMode ||
      segment.input_todo_candidate_allowed !== (snapshot.todoCandidateAllowed ? 1 : 0) ||
      JSON.stringify(allowedSuggestionBases) !== JSON.stringify(snapshot.allowedSuggestionBases)
    ) {
      throw codedError("MEMORY_INPUT_CORRUPT");
    }
    return snapshot;
  }

  _cloudActionProjectionCandidate(inputRow, candidate, context) {
    const selfBinding = context.bindingByLabel.get("SELF");
    const classifications = this._effectiveActivityActionClassifications(inputRow.session_id);
    const policyBySegmentId = new Map(
      context.manifest.map((segment) => [
        segment.segment_id,
        this._analysisPolicySnapshotForSegment(segment, classifications),
      ])
    );
    const evidencePolicies = (segmentIds) =>
      segmentIds.map((segmentId) => policyBySegmentId.get(segmentId) ?? null);
    const memories = candidate.memories.filter((memory) => {
      const policies = evidencePolicies(memory.evidenceSegmentIds);
      if (policies.some((policy) => policy === null)) return false;
      if (memory.kind === "preference") {
        return (
          policies.every((policy) => ["full", "interest_only"].includes(policy.memoryMode)) &&
          (policies.every((policy) => policy.memoryMode === "full") ||
            policies.every((policy) => policy.memoryMode === "interest_only"))
        );
      }
      if (memory.kind === "commitment") {
        if (memory.confidence < 0.9 || !selfBinding || selfBinding.subject_kind !== "person") {
          return false;
        }
        return memory.evidenceSegmentIds.every((segmentId, index) => {
          const segment = context.manifestById.get(segmentId);
          const policy = policies[index];
          if (
            !segment ||
            segment.speaker_binding_label !== "SELF" ||
            policy.memoryMode !== "full" ||
            policy.todoCandidateAllowed !== true ||
            policy.sourceAttribution === "mixed_unknown"
          ) {
            return false;
          }
          return this._todoSpeakerTrust(inputRow, context, segment).speakerEvidenceVerified;
        });
      }
      if (memory.kind === "relationship") {
        const hasSocialParticipant = memory.evidenceSegmentIds.some((segmentId) => {
          const label = context.manifestById.get(segmentId)?.speaker_binding_label;
          return label !== "SELF" && context.bindingByLabel.has(label);
        });
        return hasSocialParticipant && policies.every((policy) => policy.memoryMode === "full");
      }
      return policies.every((policy) => policy.memoryMode === "full");
    });
    const topics = candidate.topics.filter((topic) => {
      const policies = evidencePolicies(topic.evidenceSegmentIds);
      return (
        policies.length > 0 &&
        (policies.every((policy) => policy?.memoryMode === "full") ||
          policies.every((policy) => policy?.memoryMode === "interest_only"))
      );
    });
    const actionCategories = new Set([
      "work_meeting",
      "learning",
      "social_call",
      "in_person_conversation",
    ]);
    const classificationMatchesSource = (classification, segment) => {
      if (segment.source_type === "mic") {
        return new Set(["microphone", "application_and_microphone"]).has(
          classification.source_attribution
        );
      }
      return new Set(["application", "application_and_microphone", "mixed_unknown"]).has(
        classification.source_attribution
      );
    };
    const matchingClassificationsForSegment = (segmentId) => {
      const segment = context.manifestById.get(segmentId);
      if (!segment) return [];
      return classifications.filter(
        (classification) =>
          classification.started_at < segment.ended_at &&
          segment.started_at < classification.ended_at &&
          classificationMatchesSource(classification, segment)
      );
    };
    const isSelfEvidence = (segmentId) =>
      context.manifestById.get(segmentId)?.speaker_binding_label === "SELF";
    const selfCommitmentConfidence = new Map();
    for (const memory of candidate.memories.filter((entry) => entry.kind === "commitment")) {
      for (const segmentId of memory.evidenceSegmentIds.filter(isSelfEvidence)) {
        selfCommitmentConfidence.set(
          segmentId,
          Math.max(selfCommitmentConfidence.get(segmentId) ?? 0, memory.confidence)
        );
      }
    }

    const verificationByTodo = new Map();
    const todos =
      !selfBinding || selfBinding.subject_kind !== "person"
        ? []
        : candidate.todos.filter((todo) => {
            if (this.personalizationFeedbackRepository.shouldSuppressTodo(todo.title)) {
              return false;
            }
            if (todo.ownerLabel !== "SELF" || !todo.evidenceSegmentIds.some(isSelfEvidence)) {
              return false;
            }
            const evidence = todo.evidenceSegmentIds.map((segmentId) => {
              const segment = context.manifestById.get(segmentId);
              if (!segment) return null;
              const matching = matchingClassificationsForSegment(segmentId).sort((left, right) => {
                const leftPass =
                  left.decision === "adopted" &&
                  left.source_attribution !== "mixed_unknown" &&
                  actionCategories.has(left.category) &&
                  left.evidence?.allowTodos === true;
                const rightPass =
                  right.decision === "adopted" &&
                  right.source_attribution !== "mixed_unknown" &&
                  actionCategories.has(right.category) &&
                  right.evidence?.allowTodos === true;
                if (leftPass !== rightPass) return leftPass ? 1 : -1;
                return left.confidence - right.confidence || left.id.localeCompare(right.id);
              });
              const classification = matching[0] ?? null;
              const explicitSemanticAction =
                todo.actionKind === "self_commitment" ||
                todo.actionKind === "assignment_accepted" ||
                (todo.actionKind === undefined && todo.evidenceSegmentIds.every(isSelfEvidence));
              const permissions = classification
                ? this.activityOutputPolicy.evaluate({
                    category: classification.category,
                    confidence: classification.confidence,
                    decision: classification.decision,
                    sourceAttribution: classification.source_attribution,
                    selfParticipated:
                      classification.evidence?.selfDetected === true ||
                      todo.evidenceSegmentIds.some(isSelfEvidence),
                    explicitAgreement: explicitSemanticAction,
                  })
                : null;
              const speakerTrust = this._todoSpeakerTrust(inputRow, context, segment);
              const fallbackSource =
                segment.source_type === "mic"
                  ? "microphone"
                  : segment.attribution_state === "exact"
                    ? "application"
                    : "mixed_unknown";
              return {
                segmentId,
                speakerRelation: segment.speaker_binding_label,
                ...speakerTrust,
                sourceAttribution: classification?.source_attribution ?? fallbackSource,
                applicationKey:
                  segment.track_kind === "application" && segment.attribution_state === "exact"
                    ? segment.application_key
                    : null,
                activityCategory: classification?.category ?? "unknown",
                activityConfidence: classification?.confidence ?? 0,
                activityDecision: classification?.decision ?? "unknown",
                allowTodos: permissions?.allowTodos === true,
                transcriptConfidence:
                  typeof segment.transcript_confidence === "number" &&
                  Number.isFinite(segment.transcript_confidence)
                    ? segment.transcript_confidence
                    : 0,
                startedAt: segment.started_at,
                endedAt: segment.ended_at,
              };
            });
            if (evidence.some((entry) => entry === null)) return false;
            const selfEvidence = evidence.filter((entry) => entry.speakerRelation === "SELF");
            const localCommitmentConfidence = Math.min(
              ...selfEvidence.map((entry) => selfCommitmentConfidence.get(entry.segmentId) ?? 0)
            );
            const evaluation = evaluateTodoAttribution({
              ownerLabel: todo.ownerLabel,
              semanticConfidence: todo.semanticConfidence,
              localCommitmentConfidence,
              actionKind: todo.actionKind,
              assignmentSegmentIds: todo.assignmentSegmentIds,
              acceptanceSegmentIds: todo.acceptanceSegmentIds,
              evidence,
            });
            if (evaluation.disposition === "rejected") return false;
            const key = canonicalTupleHash([
              "todo_verification",
              canonicalizeText(todo.title),
              todo.dueText,
              [...todo.evidenceSegmentIds].sort(),
            ]);
            verificationByTodo.set(key, {
              state:
                evaluation.disposition === "auto_confirmed" ? "confirmed" : "pending_confirmation",
              reason: evaluation.reason,
              trustSnapshot: {
                policyId: TODO_ATTRIBUTION_POLICY_VERSION,
                application: evidence
                  .map((entry) => ({
                    segmentId: entry.segmentId,
                    applicationKey: entry.applicationKey,
                    sourceAttribution: entry.sourceAttribution,
                    speakerRelation: entry.speakerRelation,
                  }))
                  .sort((left, right) => left.segmentId.localeCompare(right.segmentId)),
                activity: evidence
                  .map((entry) => ({
                    segmentId: entry.segmentId,
                    category: entry.activityCategory,
                    confidence: entry.activityConfidence,
                    decision: entry.activityDecision,
                  }))
                  .sort((left, right) => left.segmentId.localeCompare(right.segmentId)),
                semanticConfidence: evaluation.snapshot.semanticConfidence,
                voiceprintConfidence: evaluation.snapshot.voiceConfidence,
                sceneConfidence: evaluation.snapshot.sceneConfidence,
                transcriptContextConfidence: evaluation.snapshot.transcriptConfidence,
                speakerEvidenceVerified: evaluation.snapshot.speakerEvidenceVerified,
                overlapDetected: evaluation.snapshot.overlapDetected,
                automaticEligible: evaluation.disposition === "auto_confirmed",
              },
            });
            return true;
          });
    const confirmedLearningGoalIds = this.db
      .prepare("SELECT id FROM learning_goals WHERE state = 'confirmed' ORDER BY id")
      .all()
      .map((row) => row.id);
    const suggestions =
      !selfBinding || selfBinding.subject_kind !== "person"
        ? []
        : candidate.suggestions.filter((suggestion) => {
            if (!suggestion.basedOnEvidenceSegmentIds.some(isSelfEvidence)) {
              return false;
            }
            const basis =
              suggestion.basis === undefined || suggestion.basis === "legacy_unverified"
                ? "work_context"
                : suggestion.basis;
            const evidence = suggestion.basedOnEvidenceSegmentIds.flatMap((segmentId) => {
              const segment = context.manifestById.get(segmentId);
              return matchingClassificationsForSegment(segmentId).map((classification) => ({
                category: classification.category,
                confidence: classification.confidence,
                decision: classification.decision,
                sourceAttribution: classification.source_attribution,
                selfParticipated:
                  classification.evidence?.selfDetected === true ||
                  segment?.speaker_binding_label === "SELF",
              }));
            });
            if (evidence.length === 0) return false;
            return this.activityOutputPolicy.evaluateSuggestionCandidate({
              basis,
              learningGoalId: basis === "learning_goal" ? suggestion.learningGoalId : null,
              confirmedLearningGoalIds,
              evidence,
            }).allowed;
          });
    const projection = { ...candidate, memories, topics, todos, suggestions };
    this.actionVerificationByCandidate.set(projection, verificationByTodo);
    return projection;
  }

  applyCandidateAnalysis(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("candidate application is required");
    }
    const analysisInputId = assertId(input.analysisInputId, "analysisInputId");
    const inputHash = assertHash(input.inputHash, "inputHash");
    const candidate = input.candidate;
    const projectedTodoVerification =
      this.actionVerificationByCandidate.get(candidate) ?? new Map();
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
      const allowedLearningGoalIds = new Set(storedInput.payload.selectedLearningGoalIds);
      validateCandidate(candidate, {
        allowedSegmentIds,
        allowedOwnerLabels,
        allowedLearningGoalIds,
      });
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
      const ensureTodoActionMetadata = this.db.prepare(`
        INSERT OR IGNORE INTO todo_action_metadata (
          todo_instance_id, source_kind, source_session_id, pinned, urgency,
          user_modified, dismissed_from_verification_state, dismiss_reason_code,
          dismiss_local_note, suppressed, updated_at, last_event_sequence
        )
        SELECT
          todo.id,
          'existing',
          (
            SELECT CASE
              WHEN count(DISTINCT COALESCE(occurrence.legacy_session_id, input.session_id)) = 1
              THEN min(COALESCE(occurrence.legacy_session_id, input.session_id))
              ELSE NULL
            END
            FROM todo_occurrences AS occurrence
            LEFT JOIN analysis_inputs AS input ON input.id = occurrence.analysis_input_id
            WHERE occurrence.todo_instance_id = todo.id
          ),
          0,
          'normal',
          0,
          NULL,
          NULL,
          NULL,
          CASE WHEN todo.status = 'dismissed' THEN 1 ELSE 0 END,
          todo.updated_at,
          NULL
        FROM todos_v2 AS todo
        WHERE todo.id = ?
      `);
      const hasTodoActionMetadata = this.db.prepare(
        "SELECT 1 FROM todo_action_metadata WHERE todo_instance_id = ?"
      );
      const ensureSuggestionActionMetadata = this.db.prepare(`
        INSERT OR IGNORE INTO suggestion_action_metadata (
          suggestion_id, effective_state, dismiss_reason_code, converted_todo_id,
          acceptance_undone, updated_at, last_event_sequence
        )
        SELECT
          suggestion.id,
          suggestion.state,
          NULL,
          acceptance.todo_instance_id,
          0,
          suggestion.updated_at,
          NULL
        FROM suggestions_v2 AS suggestion
        LEFT JOIN suggestion_acceptances AS acceptance
          ON acceptance.suggestion_id = suggestion.id
        WHERE suggestion.id = ?
      `);
      const hasSuggestionActionMetadata = this.db.prepare(
        "SELECT 1 FROM suggestion_action_metadata WHERE suggestion_id = ?"
      );
      const ensureTodoActionProjection = (todoId) => {
        ensureTodoActionMetadata.run(todoId);
        if (!hasTodoActionMetadata.get(todoId)) {
          throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
        }
      };
      const ensureSuggestionActionProjection = (suggestionId) => {
        ensureSuggestionActionMetadata.run(suggestionId);
        if (!hasSuggestionActionMetadata.get(suggestionId)) {
          throw codedError("MEMORY_EXISTING_SNAPSHOT_CORRUPT");
        }
      };
      const referencedTodoCanonicalKeys = new Set(
        candidate.todos.map((todo) => {
          const ownerSubjectId =
            todo.ownerLabel === null
              ? null
              : (context.bindingByLabel.get(todo.ownerLabel)?.subject_id ?? null);
          return canonicalTupleHash(["todo", canonicalizeText(todo.title), ownerSubjectId]);
        })
      );
      for (const todo of plannerInput.existing.todos) {
        if (referencedTodoCanonicalKeys.has(todo.canonicalBaseKey)) {
          ensureTodoActionProjection(todo.id);
        }
      }
      const referencedSuggestionCanonicalKeys = new Set(
        candidate.suggestions.map((suggestion) =>
          canonicalTupleHash([
            "suggestion",
            canonicalizeText(suggestion.title),
            canonicalizeText(suggestion.rationale),
          ])
        )
      );
      for (const suggestion of plannerInput.existing.suggestions) {
        if (referencedSuggestionCanonicalKeys.has(suggestion.canonicalKey)) {
          ensureSuggestionActionProjection(suggestion.id);
        }
      }

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
        ensureTodoActionProjection(todoRow.id);

        const desiredVerification = projectedTodoVerification.get(
          canonicalTupleHash([
            "todo_verification",
            canonicalizeText(todo.title),
            todo.dueText,
            [...todo.evidenceSegmentIds].sort(),
          ])
        );
        const latestVerification = this._latestTodoVerification(todoRow.id);
        if (
          desiredVerification &&
          latestVerification?.actor !== "user" &&
          latestVerification?.state !== "confirmed" &&
          latestVerification?.state !== desiredVerification.state
        ) {
          this.db
            .prepare(
              `INSERT INTO todo_verification_decisions (
                 id, todo_instance_id, state, reason, actor,
                 source_analysis_input_id, occurred_at,
                 trust_policy_id, trust_snapshot_state,
                 application_snapshot_json, activity_snapshot_json,
                 semantic_confidence_snapshot, voiceprint_confidence_snapshot,
                 scene_confidence_snapshot, transcript_context_confidence_snapshot,
                 speaker_evidence_verified_snapshot, overlap_detected_snapshot,
                 automatic_eligible
               ) VALUES (
                 ?, ?, ?, ?, 'system', ?, ?, ?, 'captured', ?, ?, ?, ?, ?, ?, ?, ?, ?
               )`
            )
            .run(
              this._nextId("todo_verification"),
              todoRow.id,
              desiredVerification.state,
              desiredVerification.reason,
              analysisInputId,
              appliedAt,
              desiredVerification.trustSnapshot.policyId,
              canonicalJson(desiredVerification.trustSnapshot.application),
              canonicalJson(desiredVerification.trustSnapshot.activity),
              desiredVerification.trustSnapshot.semanticConfidence,
              desiredVerification.trustSnapshot.voiceprintConfidence,
              desiredVerification.trustSnapshot.sceneConfidence,
              desiredVerification.trustSnapshot.transcriptContextConfidence,
              desiredVerification.trustSnapshot.speakerEvidenceVerified ? 1 : 0,
              desiredVerification.trustSnapshot.overlapDetected ? 1 : 0,
              desiredVerification.trustSnapshot.automaticEligible ? 1 : 0
            );
        }
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
        ensureSuggestionActionProjection(suggestionRow.id);
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
          if (action.entityKind === "todo_occurrence") {
            ensureTodoActionProjection(action.todoId);
          } else if (action.entityKind === "suggestion_occurrence") {
            ensureSuggestionActionProjection(action.suggestionId);
          }
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
          ensureTodoActionProjection(action.todoId);
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
          ensureSuggestionActionProjection(suggestion.id);
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
        .prepare("SELECT id, title, state, decided_at FROM suggestions_v2 WHERE id = ?")
        .get(suggestionId);
      if (!row) throw codedError("MEMORY_SUGGESTION_NOT_FOUND");
      const ensureAcceptedTodo = (acceptedAt) => {
        const existing = this.db
          .prepare(
            `SELECT todo_instance_id
             FROM suggestion_acceptances WHERE suggestion_id = ?`
          )
          .get(suggestionId);
        if (existing) return existing.todo_instance_id;

        const todoId = this._nextId("todo");
        const canonicalBaseKey = canonicalTupleHash(["todo", canonicalizeText(row.title), null]);
        const instanceKey = canonicalTupleHash(["suggestion_acceptance", suggestionId]);
        this.db
          .prepare(
            `INSERT INTO todos_v2 (
               id, canonical_base_key, instance_key, title, owner_subject_kind,
               owner_subject_id, owner_display_name_snapshot, status,
               source_analysis_input_id, provenance, created_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'open', NULL, 'suggestion', ?, ?)`
          )
          .run(todoId, canonicalBaseKey, instanceKey, row.title, acceptedAt, acceptedAt);
        this.db
          .prepare(
            `INSERT INTO todo_revisions (
               id, todo_instance_id, revision, previous_revision_id, title, due_text,
               source_analysis_input_id, provenance, created_at
             ) VALUES (?, ?, 1, NULL, ?, NULL, NULL, 'suggestion', ?)`
          )
          .run(this._nextId("todo_revision"), todoId, row.title, acceptedAt);
        this.db
          .prepare(
            `INSERT INTO suggestion_acceptances (
               suggestion_id, todo_instance_id, user_action_id, actor, accepted_at
             ) VALUES (?, ?, ?, 'user', ?)`
          )
          .run(suggestionId, todoId, this._nextId("user_action"), acceptedAt);
        this.db
          .prepare(
            `INSERT INTO todo_verification_decisions (
               id, todo_instance_id, state, reason, actor,
               source_analysis_input_id, occurred_at,
               trust_policy_id, trust_snapshot_state
             ) VALUES (
               ?, ?, 'confirmed', 'user_confirmed', 'user', NULL, ?,
               'user-authority-v1', 'user_override'
             )`
          )
          .run(this._nextId("todo_verification"), todoId, acceptedAt);
        return todoId;
      };
      if (row.state === terminalState) {
        return {
          status: `already_${terminalState}`,
          suggestionId,
          decidedAt: row.decided_at,
          ...(terminalState === "accepted" ? { todoId: ensureAcceptedTodo(row.decided_at) } : {}),
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
      return {
        status: terminalState,
        suggestionId,
        decidedAt: at,
        ...(terminalState === "accepted" ? { todoId: ensureAcceptedTodo(at) } : {}),
      };
    });
    return transaction.immediate();
  }

  acceptSuggestion(input) {
    return this._transitionSuggestion(input, "accepted");
  }

  dismissSuggestion(input) {
    return this._transitionSuggestion(input, "dismissed");
  }

  _latestTodoVerification(todoId) {
    const verification = this.db
      .prepare(
        `SELECT effective_state AS state, reason, actor, occurred_at,
                trust_policy_id, trust_snapshot_state, application_snapshot_json,
                activity_snapshot_json, semantic_confidence_snapshot,
                voiceprint_confidence_snapshot, scene_confidence_snapshot,
                transcript_context_confidence_snapshot,
                speaker_evidence_verified_snapshot, overlap_detected_snapshot,
                automatic_eligible
         FROM todo_effective_verification
         WHERE todo_instance_id = ?`
      )
      .get(todoId);
    if (verification?.state !== "dismissed") return verification;
    const restored = this.db
      .prepare(
        `SELECT todo.status, metadata.dismissed_from_verification_state AS prior_state
         FROM todos_v2 AS todo
         LEFT JOIN todo_action_metadata AS metadata
           ON metadata.todo_instance_id = todo.id
         WHERE todo.id = ?`
      )
      .get(todoId);
    if (
      restored?.status === "open" &&
      ["confirmed", "pending_confirmation"].includes(restored.prior_state)
    ) {
      return { ...verification, state: restored.prior_state };
    }
    return verification;
  }

  decideTodo(input) {
    if (!hasExactKeys(input, ["todoId", "action"])) {
      throw new TypeError("todo decision must contain todoId and action");
    }
    const todoId = assertId(input.todoId, "todoId");
    const action = input.action;
    if (!["confirm", "dismiss", "reopen"].includes(action)) {
      throw new TypeError("todo decision action is invalid");
    }
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT status, completed_at, dismissed_at FROM todos_v2 WHERE id = ?")
        .get(todoId);
      if (!row) throw codedError("MEMORY_TODO_NOT_FOUND");
      const latest = this._latestTodoVerification(todoId);
      const at = assertTimestamp(this.now(), "decidedAt");

      if (action === "confirm") {
        if (row.status !== "open") throw codedError("MEMORY_TODO_ALREADY_TERMINAL");
        if (latest?.state === "confirmed") {
          return { status: "already_confirmed", todoId, decidedAt: latest.occurred_at };
        }
        this.db
          .prepare(
            `INSERT INTO todo_verification_decisions (
               id, todo_instance_id, state, reason, actor,
               source_analysis_input_id, occurred_at,
               trust_policy_id, trust_snapshot_state
             ) VALUES (
               ?, ?, 'confirmed', 'user_confirmed', 'user', NULL, ?,
               'user-authority-v1', 'user_override'
             )`
          )
          .run(this._nextId("todo_verification"), todoId, at);
        return { status: "confirmed", todoId, decidedAt: at };
      }

      if (action === "dismiss") {
        if (row.status === "dismissed" || latest?.state === "dismissed") {
          return {
            status: "already_dismissed",
            todoId,
            decidedAt: latest?.occurred_at ?? row.dismissed_at,
          };
        }
        if (row.status !== "open") throw codedError("MEMORY_TODO_ALREADY_TERMINAL");
        this.db
          .prepare(
            `INSERT INTO todo_verification_decisions (
               id, todo_instance_id, state, reason, actor,
               source_analysis_input_id, occurred_at,
               trust_policy_id, trust_snapshot_state
             ) VALUES (
               ?, ?, 'dismissed', 'user_dismissed', 'user', NULL, ?,
               'user-authority-v1', 'user_override'
             )`
          )
          .run(this._nextId("todo_verification"), todoId, at);
        this.db
          .prepare(
            `INSERT INTO todo_state_transitions (
               id, todo_instance_id, from_status, to_status, reason,
               source_analysis_input_id, actor, occurred_at
             ) VALUES (?, ?, 'open', 'dismissed', 'user_action', NULL, 'user', ?)`
          )
          .run(this._nextId("todo_transition"), todoId, at);
        return { status: "dismissed", todoId, decidedAt: at };
      }

      if (row.status === "open") {
        return { status: "already_open", todoId, decidedAt: latest?.occurred_at ?? at };
      }
      if (row.status !== "completed") throw codedError("MEMORY_TODO_ALREADY_TERMINAL");
      this.db
        .prepare(
          `INSERT INTO todo_state_transitions (
             id, todo_instance_id, from_status, to_status, reason,
             source_analysis_input_id, actor, occurred_at
           ) VALUES (?, ?, 'completed', 'open', 'user_action', NULL, 'user', ?)`
        )
        .run(this._nextId("todo_transition"), todoId, at);
      return { status: "reopened", todoId, decidedAt: at };
    });
    return transaction.immediate();
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
      const latest = this._latestTodoVerification(todoId);
      if (latest?.state !== "confirmed") {
        const systemGenerated = this.db
          .prepare(
            `SELECT source_analysis_input_id, provenance
             FROM todos_v2 WHERE id = ?`
          )
          .get(todoId);
        if (
          systemGenerated?.source_analysis_input_id !== null ||
          systemGenerated?.provenance === "legacy_unverified"
        ) {
          throw codedError("MEMORY_TODO_CONFIRMATION_REQUIRED");
        }
      }
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
             track.application_key, track.attribution_state,
             segment.person_id, segment.speaker_label,
             segment.confidence AS transcript_confidence,
             person.is_self AS person_is_self,
             person.voice_confidence,
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
      LEFT JOIN audio_tracks AS track ON track.id = ref.track_id
      LEFT JOIN people AS person ON person.id = segment.person_id`;
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
                  track.application_key, track.attribution_state,
                  segment.person_id, segment.speaker_label,
                  segment.confidence AS transcript_confidence,
                  person.is_self AS person_is_self,
                  person.voice_confidence,
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
           LEFT JOIN people AS person ON person.id = segment.person_id
           WHERE cluster.id = ? AND link.transcript_segment_id = ?`
        )
        .get(handle.ownerId, handle.evidenceId);
    } else {
      row = this.db.prepare(ownerQueries[handle.ownerType]).get(handle.evidenceId, handle.ownerId);
    }
    if (!row) return null;
    let transcriptContext = [];
    if (row.transcript_segment_id !== null) {
      const nearbySegments = this.db
        .prepare(
          `SELECT segment.id, segment.started_at, segment.ended_at, segment.text,
                  segment.person_id, segment.speaker_label,
                  segment.confidence AS transcript_confidence,
                  person.is_self AS person_is_self,
                  person.voice_confidence,
                  COALESCE(track.source_type, segment.source_type) AS source_type,
                  track.application_key, track.attribution_state
           FROM transcript_segments AS segment
           LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
           LEFT JOIN people AS person ON person.id = segment.person_id
           WHERE segment.session_id = ?
             AND segment.result_kind = 'final'
             AND segment.is_stable = 1
             AND segment.superseded_by IS NULL
             AND segment.started_at < ?
             AND segment.ended_at > ?
           ORDER BY CASE
             WHEN segment.id = ? THEN -1
             WHEN segment.ended_at <= ? THEN ? - segment.ended_at
             WHEN segment.started_at >= ? THEN segment.started_at - ?
             ELSE 0
           END,
           segment.started_at, segment.ended_at, segment.id
           LIMIT 7`
        )
        .all(
          row.session_id,
          row.ended_at + 30_000,
          Math.max(row.session_started_at, row.started_at - 30_000),
          row.transcript_segment_id,
          row.started_at,
          row.started_at,
          row.ended_at,
          row.ended_at
        );
      if (nearbySegments.some((segment) => segment.id === row.transcript_segment_id)) {
        transcriptContext = nearbySegments
          .map((segment) => {
            const attribution =
              segment.source_type === "mic" || segment.source_type === "system"
                ? buildActionEvidenceAttribution({
                    sourceType: segment.source_type,
                    applicationKey: segment.application_key,
                    attributionState:
                      segment.attribution_state ??
                      (segment.application_key
                        ? "exact"
                        : segment.source_type === "system"
                          ? "mixed_unknown"
                          : null),
                    personIsSelf: segment.person_is_self,
                    personId: segment.person_id,
                    speakerLabel: segment.speaker_label,
                    transcriptConfidence: segment.transcript_confidence,
                    voiceConfidence: segment.voice_confidence,
                    startedAt: segment.started_at,
                    endedAt: segment.ended_at,
                    classifications: [],
                  })
                : null;
            return {
              segmentId: segment.id,
              startedAt: segment.started_at,
              endedAt: segment.ended_at,
              text: Array.from(segment.text).slice(0, 2_048).join(""),
              speakerRelation: attribution?.speakerRelation ?? "UNKNOWN",
              applicationName: attribution?.applicationName ?? null,
              isEvidence: segment.id === row.transcript_segment_id,
            };
          })
          .sort(
            (left, right) =>
              left.startedAt - right.startedAt ||
              left.endedAt - right.endedAt ||
              left.segmentId.localeCompare(right.segmentId)
          );
      }
    }
    const quoteText =
      row.quote_text === null ? null : Array.from(row.quote_text).slice(0, 4_096).join("");
    const semanticConfidence =
      row.transcript_segment_id === null
        ? null
        : (this.db
            .prepare(
              `SELECT MAX(item.confidence) AS confidence
               FROM evidence_refs AS semantic_ref
               JOIN memory_occurrences AS occurrence
                 ON semantic_ref.entity_type = 'memory_occurrence'
                AND occurrence.id = semantic_ref.entity_id
               JOIN memory_items_v2 AS item ON item.id = occurrence.memory_value_id
               WHERE semantic_ref.transcript_segment_id = ? AND item.kind = 'commitment'`
            )
            .get(row.transcript_segment_id)?.confidence ?? null);
    let actionAttribution =
      row.source_type === "mic" || row.source_type === "system"
        ? buildActionEvidenceAttribution({
            sourceType: row.source_type,
            applicationKey: row.application_key,
            attributionState:
              row.attribution_state ??
              (row.application_key
                ? "exact"
                : row.source_type === "system"
                  ? "mixed_unknown"
                  : null),
            personIsSelf: row.person_is_self,
            personId: row.person_id,
            speakerLabel: row.speaker_label,
            transcriptConfidence: row.transcript_confidence,
            voiceConfidence: row.voice_confidence,
            semanticConfidence,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            classifications: this._effectiveActivityActionClassifications(row.session_id),
          })
        : null;
    if (handle.ownerType === "todo_instance") {
      const captured = this.db
        .prepare(
          `SELECT application_snapshot_json, activity_snapshot_json,
                  semantic_confidence_snapshot, voiceprint_confidence_snapshot,
                  transcript_context_confidence_snapshot
           FROM todo_verification_decisions
           WHERE todo_instance_id = ?
             AND trust_snapshot_state = 'captured'
           ORDER BY occurred_at, id
           LIMIT 1`
        )
        .get(handle.ownerId);
      actionAttribution = null;
      if (captured && row.transcript_segment_id !== null) {
        try {
          actionAttribution = buildCapturedTodoActionEvidenceAttribution({
            transcriptSegmentId: row.transcript_segment_id,
            applicationEvidence: JSON.parse(captured.application_snapshot_json),
            activityEvidence: JSON.parse(captured.activity_snapshot_json),
            semanticConfidence: captured.semantic_confidence_snapshot,
            voiceprintConfidence: captured.voiceprint_confidence_snapshot,
            transcriptContextConfidence: captured.transcript_context_confidence_snapshot,
          });
        } catch {
          throw codedError("MEMORY_PUBLIC_READ_CORRUPT");
        }
      }
    }
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
      transcriptContext,
      actionAttribution,
    });
  }

  _readActionCenterWatermarkSeed() {
    const todos = this.db
      .prepare(
        `SELECT todo.id, todo.status, todo.updated_at,
                verification.id AS verification_id,
                verification.effective_state AS verification_state,
                verification.reason AS verification_reason,
                verification.actor AS verification_actor,
                verification.occurred_at AS verification_occurred_at,
                reminder.reminder_at, reminder.generation AS reminder_generation,
                reminder.state AS reminder_state,
                reminder.deferred_reason AS reminder_deferred_reason,
                reminder.delivered_at AS reminder_delivered_at,
                reminder.updated_at AS reminder_updated_at,
                revision.id AS todo_revision_id,
                revision.revision AS todo_revision,
                revision.title AS todo_revision_title,
                revision.due_text AS todo_revision_due_text,
                revision.created_at AS todo_revision_created_at,
                occurrence.id AS todo_occurrence_id,
                occurrence.legacy_session_id AS todo_occurrence_session_id,
                occurrence.created_at AS todo_occurrence_created_at
         FROM todos_v2 AS todo
         LEFT JOIN todo_effective_verification AS verification
           ON verification.todo_instance_id = todo.id
         LEFT JOIN todo_reminders AS reminder ON reminder.todo_instance_id = todo.id
         LEFT JOIN todo_revisions AS revision
           ON revision.id = (
             SELECT latest.id
             FROM todo_revisions AS latest
             WHERE latest.todo_instance_id = todo.id
             ORDER BY latest.revision DESC, latest.id DESC
             LIMIT 1
           )
         LEFT JOIN todo_occurrences AS occurrence
           ON occurrence.id = (
             SELECT latest.id
             FROM todo_occurrences AS latest
             WHERE latest.todo_instance_id = todo.id
             ORDER BY latest.created_at DESC, latest.id DESC
             LIMIT 1
           )
         ORDER BY todo.id`
      )
      .all()
      .map((row) => ({
        id: row.id,
        status: row.status,
        updatedAt: row.updated_at,
        verificationId: row.verification_id,
        verificationState: row.verification_state,
        verificationReason: row.verification_reason,
        verificationActor: row.verification_actor,
        verificationOccurredAt: row.verification_occurred_at,
        reminderAt: row.reminder_at,
        reminderGeneration: row.reminder_generation,
        reminderState: row.reminder_state,
        reminderDeferredReason: row.reminder_deferred_reason,
        reminderDeliveredAt: row.reminder_delivered_at,
        reminderUpdatedAt: row.reminder_updated_at,
        revisionId: row.todo_revision_id,
        revision: row.todo_revision,
        revisionTitle: row.todo_revision_title,
        revisionDueText: row.todo_revision_due_text,
        revisionCreatedAt: row.todo_revision_created_at,
        occurrenceId: row.todo_occurrence_id,
        occurrenceSessionId: row.todo_occurrence_session_id,
        occurrenceCreatedAt: row.todo_occurrence_created_at,
      }));
    const suggestions = this.db
      .prepare(
        `SELECT suggestion.id, suggestion.state, suggestion.updated_at,
                occurrence.id AS occurrence_id,
                occurrence.legacy_session_id AS occurrence_session_id,
                occurrence.created_at AS occurrence_created_at
         FROM suggestions_v2 AS suggestion
         LEFT JOIN suggestion_occurrences AS occurrence
           ON occurrence.id = (
             SELECT latest.id
             FROM suggestion_occurrences AS latest
             WHERE latest.suggestion_id = suggestion.id
             ORDER BY latest.created_at DESC, latest.id DESC
             LIMIT 1
           )
         ORDER BY suggestion.id`
      )
      .all()
      .map((row) => ({
        id: row.id,
        state: row.state,
        updatedAt: row.updated_at,
        occurrenceId: row.occurrence_id,
        occurrenceSessionId: row.occurrence_session_id,
        occurrenceCreatedAt: row.occurrence_created_at,
      }));
    let updatedAt = null;
    const includeTimestamp = (value) => {
      if (Number.isSafeInteger(value) && (updatedAt === null || value > updatedAt)) {
        updatedAt = value;
      }
    };
    for (const todo of todos) {
      includeTimestamp(todo.updatedAt);
      includeTimestamp(todo.verificationOccurredAt);
      includeTimestamp(todo.reminderUpdatedAt);
      includeTimestamp(todo.revisionCreatedAt);
      includeTimestamp(todo.occurrenceCreatedAt);
    }
    for (const suggestion of suggestions) {
      includeTimestamp(suggestion.updatedAt);
      includeTimestamp(suggestion.occurrenceCreatedAt);
    }
    return {
      revision: sha256(
        canonicalJson({
          schemaVersion: "jarvis-action-center-watermark-v2",
          todos,
          suggestions,
        })
      ),
      todoCount: todos.length,
      suggestionCount: suggestions.length,
      updatedAt,
    };
  }

  _initializeActionCenterWatermark() {
    if (this.actionCenterWatermarkStatement) return;
    // JarvisRepository gives MemoryRepository, TodoReminderRepository, and the
    // notification scheduler this same SQLite connection. Seed once from the
    // durable tables after startup, then let TEMP triggers maintain a singleton
    // revision without changing the persistent schema or rescanning action history.
    const initialize = this.db.transaction(() => {
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS jarvis_action_center_runtime_watermark (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          base_revision TEXT NOT NULL CHECK(length(base_revision) = 64),
          change_revision INTEGER NOT NULL CHECK(change_revision >= 0),
          todo_count INTEGER NOT NULL CHECK(todo_count >= 0),
          suggestion_count INTEGER NOT NULL CHECK(suggestion_count >= 0),
          updated_at INTEGER CHECK(updated_at IS NULL OR updated_at >= 0)
        );
      `);
      const existing = this.db
        .prepare(
          `SELECT 1
           FROM temp.jarvis_action_center_runtime_watermark
           WHERE singleton = 1`
        )
        .get();
      if (!existing) {
        const seed = this._readActionCenterWatermarkSeed();
        this.db
          .prepare(
            `INSERT INTO temp.jarvis_action_center_runtime_watermark (
               singleton, base_revision, change_revision, todo_count,
               suggestion_count, updated_at
             ) VALUES (1, ?, 0, ?, ?, ?)`
          )
          .run(seed.revision, seed.todoCount, seed.suggestionCount, seed.updatedAt);
      }
      this.db.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_todo_insert
        AFTER INSERT ON main.todos_v2
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              todo_count = todo_count + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_todo_update
        AFTER UPDATE OF status, updated_at ON main.todos_v2
        WHEN NEW.status IS NOT OLD.status OR NEW.updated_at IS NOT OLD.updated_at
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_verification_insert
        AFTER INSERT ON main.todo_verification_decisions
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.occurred_at > updated_at THEN NEW.occurred_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_todo_revision_insert
        AFTER INSERT ON main.todo_revisions
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.created_at > updated_at THEN NEW.created_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_todo_occurrence_insert
        AFTER INSERT ON main.todo_occurrences
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.created_at > updated_at THEN NEW.created_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_reminder_insert
        AFTER INSERT ON main.todo_reminders
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_reminder_update
        AFTER UPDATE OF reminder_at, generation, state, deferred_reason, delivered_at, updated_at
        ON main.todo_reminders
        WHEN NEW.reminder_at IS NOT OLD.reminder_at
          OR NEW.generation IS NOT OLD.generation
          OR NEW.state IS NOT OLD.state
          OR NEW.deferred_reason IS NOT OLD.deferred_reason
          OR NEW.delivered_at IS NOT OLD.delivered_at
          OR NEW.updated_at IS NOT OLD.updated_at
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_reminder_delete
        AFTER DELETE ON main.todo_reminders
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_suggestion_insert
        AFTER INSERT ON main.suggestions_v2
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              suggestion_count = suggestion_count + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_suggestion_update
        AFTER UPDATE OF state, updated_at ON main.suggestions_v2
        WHEN NEW.state IS NOT OLD.state OR NEW.updated_at IS NOT OLD.updated_at
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.updated_at > updated_at THEN NEW.updated_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS jarvis_action_center_suggestion_occurrence_insert
        AFTER INSERT ON main.suggestion_occurrences
        BEGIN
          UPDATE jarvis_action_center_runtime_watermark
          SET change_revision = change_revision + 1,
              updated_at = CASE
                WHEN updated_at IS NULL OR NEW.created_at > updated_at THEN NEW.created_at
                ELSE updated_at
              END
          WHERE singleton = 1;
        END;
      `);
    });
    initialize.immediate();
    this.actionCenterWatermarkStatement = this.db.prepare(
      `SELECT base_revision, change_revision, todo_count, suggestion_count, updated_at
       FROM temp.jarvis_action_center_runtime_watermark
       WHERE singleton = 1`
    );
  }

  getActionCenterWatermark() {
    this._initializeActionCenterWatermark();
    const row = this.actionCenterWatermarkStatement.get();
    if (!row) throw codedError("MEMORY_ACTION_WATERMARK_UNAVAILABLE");
    return {
      revision:
        row.change_revision === 0
          ? row.base_revision
          : sha256(
              canonicalJson({
                schemaVersion: "jarvis-action-center-runtime-watermark-v1",
                baseRevision: row.base_revision,
                changeRevision: row.change_revision,
              })
            ),
      todoCount: row.todo_count,
      suggestionCount: row.suggestion_count,
      updatedAt: row.updated_at,
    };
  }

  getActionCenterDelta() {
    const read = this.db.transaction(() => {
      const state = this.db
        .prepare(
          `SELECT last_seen_sequence
           FROM action_center_read_state WHERE singleton = 1`
        )
        .get();
      if (!state) throw codedError("MEMORY_ACTION_READ_STATE_UNAVAILABLE");
      const throughSequence = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM action_center_events")
        .get().sequence;
      const rows = this.db
        .prepare(
          `WITH unread AS (
             SELECT event.sequence, event.session_id, event.action_kind,
                    CASE
                      WHEN event.action_kind = 'todo' THEN COALESCE(
                        (
                          SELECT decision.effective_state
                          FROM todo_effective_verification AS decision
                          WHERE decision.todo_instance_id = event.action_id
                        ),
                        'pending_confirmation'
                      )
                      ELSE NULL
                    END AS verification_state,
                    CASE
                      WHEN event.action_kind = 'suggestion' THEN (
                        SELECT suggestion.state
                        FROM suggestions_v2 AS suggestion
                        WHERE suggestion.id = event.action_id
                      )
                      ELSE NULL
                    END AS suggestion_state
             FROM action_center_events AS event
             WHERE event.sequence > ?
           )
           SELECT session_id,
                  SUM(CASE
                    WHEN action_kind = 'todo' AND verification_state = 'confirmed' THEN 1 ELSE 0
                  END) AS confirmed_todo_count,
                  SUM(CASE
                    WHEN action_kind = 'todo' AND verification_state = 'pending_confirmation'
                    THEN 1 ELSE 0
                  END) AS pending_todo_count,
                  SUM(CASE
                    WHEN action_kind = 'suggestion' AND suggestion_state = 'proposed' THEN 1 ELSE 0
                  END) AS suggestion_count,
                  MIN(sequence) AS first_sequence
           FROM unread
           GROUP BY session_id
           ORDER BY first_sequence, session_id`
        )
        .all(state.last_seen_sequence);
      const sessions = rows
        .map((row) => {
          const confirmedTodoCount = row.confirmed_todo_count;
          const pendingTodoCount = row.pending_todo_count;
          const suggestionCount = row.suggestion_count;
          return {
            sessionId: row.session_id,
            confirmedTodoCount,
            pendingTodoCount,
            suggestionCount,
            total: confirmedTodoCount + pendingTodoCount + suggestionCount,
          };
        })
        .filter((session) => session.total > 0);
      const totals = sessions.reduce(
        (result, session) => ({
          confirmedTodoCount: result.confirmedTodoCount + session.confirmedTodoCount,
          pendingTodoCount: result.pendingTodoCount + session.pendingTodoCount,
          suggestionCount: result.suggestionCount + session.suggestionCount,
        }),
        { confirmedTodoCount: 0, pendingTodoCount: 0, suggestionCount: 0 }
      );
      return {
        throughSequence,
        lastSeenSequence: state.last_seen_sequence,
        ...totals,
        total: totals.confirmedTodoCount + totals.pendingTodoCount + totals.suggestionCount,
        sessions,
      };
    });
    return read.deferred();
  }

  markActionCenterRead(input) {
    if (!hasExactKeys(input, ["throughSequence"])) {
      throw new TypeError("action center read input must contain throughSequence");
    }
    const requestedSequence = assertTimestamp(input.throughSequence, "throughSequence");
    const mark = this.db.transaction(() => {
      const state = this.db
        .prepare(
          `SELECT last_seen_sequence, updated_at
           FROM action_center_read_state WHERE singleton = 1`
        )
        .get();
      if (!state) throw codedError("MEMORY_ACTION_READ_STATE_UNAVAILABLE");
      const throughSequence = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM action_center_events")
        .get().sequence;
      const lastSeenSequence = Math.max(
        state.last_seen_sequence,
        Math.min(requestedSequence, throughSequence)
      );
      if (lastSeenSequence === state.last_seen_sequence) {
        return { lastSeenSequence, markedAt: state.updated_at };
      }
      const markedAt = assertTimestamp(this.now(), "markedAt");
      const updated = this.db
        .prepare(
          `UPDATE action_center_read_state
           SET last_seen_sequence = ?, updated_at = ?
           WHERE singleton = 1 AND last_seen_sequence = ?`
        )
        .run(lastSeenSequence, markedAt, state.last_seen_sequence);
      if (updated.changes !== 1) throw codedError("MEMORY_ACTION_READ_STATE_STALE");
      return { lastSeenSequence, markedAt };
    });
    return mark.immediate();
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
      const todoVerification = this.db.prepare(
        `SELECT effective_state AS state, reason, actor, occurred_at,
                trust_policy_id, trust_snapshot_state, application_snapshot_json,
                activity_snapshot_json, semantic_confidence_snapshot,
                voiceprint_confidence_snapshot, scene_confidence_snapshot,
                transcript_context_confidence_snapshot,
                speaker_evidence_verified_snapshot, overlap_detected_snapshot,
                automatic_eligible
         FROM todo_effective_verification
         WHERE todo_instance_id = ?`
      );
      const todos = this.db
        .prepare(
          `SELECT todo.id,
                  COALESCE((
                    SELECT revision.title
                    FROM todo_revisions AS revision
                    WHERE revision.todo_instance_id = todo.id
                    ORDER BY revision.revision DESC LIMIT 1
                  ), todo.title) AS title,
                  todo.status, todo.completed_at, todo.dismissed_at,
                  todo.source_analysis_input_id, todo.provenance,
                  todo.created_at,
                  MAX(todo.updated_at, COALESCE(metadata.updated_at, todo.updated_at)) AS updated_at,
                  todo.owner_display_name_snapshot AS owner_label,
                  COALESCE(metadata.source_kind, 'existing') AS source_kind,
                  metadata.source_session_id,
                  COALESCE(metadata.pinned, 0) AS pinned,
                  COALESCE(metadata.urgency, 'normal') AS urgency,
                  COALESCE(metadata.user_modified, 0) AS user_modified,
                  metadata.dismissed_from_verification_state,
                  metadata.dismiss_reason_code,
                  reminder.reminder_at, reminder.reminder_source,
                  reminder.state AS reminder_state,
                  reminder.deferred_reason AS reminder_deferred_reason,
                  reminder.delivered_at AS reminder_delivered_at,
                  (
                    SELECT acceptance.suggestion_id
                    FROM suggestion_acceptances AS acceptance
                    WHERE acceptance.todo_instance_id = todo.id
                  ) AS source_suggestion_id,
                  EXISTS(
                    SELECT 1 FROM todo_occurrences AS occurrence
                    WHERE occurrence.todo_instance_id = todo.id
                      AND occurrence.legacy_session_id IS NOT NULL
                  ) AS has_legacy_occurrence
           FROM todos_v2 AS todo
           LEFT JOIN todo_action_metadata AS metadata
             ON metadata.todo_instance_id = todo.id
           LEFT JOIN todo_reminders AS reminder ON reminder.todo_instance_id = todo.id
           WHERE COALESCE(metadata.suppressed, 0) = 0
           ORDER BY updated_at DESC, todo.id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
        .map((row) => {
          const transitions = todoTransitions
            .all(row.id, PUBLIC_SNAPSHOT_HISTORY_LIMIT)
            .reverse()
            .map((transition) => ({
              id: transition.id,
              fromStatus: transition.from_status,
              toStatus: transition.to_status,
              reason: transition.reason,
              actor: transition.actor,
              occurredAt: transition.occurred_at,
            }));
          const userConfirmed = transitions.some((transition) => transition.actor === "user");
          const systemGenerated =
            row.source_analysis_input_id !== null ||
            row.has_legacy_occurrence === 1 ||
            transitions.some((transition) =>
              ["analysis_created", "recurrence"].includes(transition.reason)
            );
          const verification = todoVerification.get(row.id);
          let trustSnapshot = null;
          if (verification) {
            try {
              trustSnapshot = {
                policyId: verification.trust_policy_id,
                state: verification.trust_snapshot_state,
                applicationEvidence: JSON.parse(verification.application_snapshot_json),
                activityEvidence: JSON.parse(verification.activity_snapshot_json),
                semanticConfidence: verification.semantic_confidence_snapshot,
                voiceprintConfidence: verification.voiceprint_confidence_snapshot,
                sceneConfidence: verification.scene_confidence_snapshot,
                transcriptContextConfidence: verification.transcript_context_confidence_snapshot,
                speakerEvidenceVerified:
                  verification.speaker_evidence_verified_snapshot === null
                    ? null
                    : verification.speaker_evidence_verified_snapshot === 1,
                overlapDetected:
                  verification.overlap_detected_snapshot === null
                    ? null
                    : verification.overlap_detected_snapshot === 1,
                automaticEligible: verification.automatic_eligible === 1,
              };
            } catch {
              throw codedError("MEMORY_PUBLIC_READ_CORRUPT");
            }
          }
          const restoredVerificationState =
            row.status === "open" &&
            verification?.state === "dismissed" &&
            ["confirmed", "pending_confirmation"].includes(row.dismissed_from_verification_state)
              ? row.dismissed_from_verification_state
              : null;
          const verificationState =
            restoredVerificationState ??
            verification?.state ??
            (userConfirmed || (row.provenance !== "legacy_unverified" && !systemGenerated)
              ? "confirmed"
              : "pending_confirmation");
          return {
            id: row.id,
            title: row.title,
            ownerLabel: row.owner_label,
            status: row.status,
            completedAt: row.completed_at,
            dismissedAt: row.dismissed_at,
            provenance: row.provenance,
            verificationState,
            verificationReason: verification?.reason ?? null,
            verificationActor: verification?.actor ?? null,
            trustSnapshot,
            sourceKind: row.source_kind,
            sourceSessionId: row.source_session_id,
            pinned: row.pinned === 1,
            urgency: row.urgency,
            userModified: row.user_modified === 1,
            dismissReasonCode: row.dismiss_reason_code,
            sourceSuggestionId: row.source_suggestion_id,
            reminder:
              row.reminder_at === null
                ? null
                : {
                    reminderAt: row.reminder_at,
                    reminderSource: row.reminder_source,
                    state: row.reminder_state,
                    deferredReason: row.reminder_deferred_reason,
                    deliveredAt: row.reminder_delivered_at,
                  },
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
            transitions,
          };
        });

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
          `SELECT suggestion.id, suggestion.title, suggestion.rationale,
                  CASE
                    WHEN metadata.last_event_sequence IS NULL THEN suggestion.state
                    ELSE metadata.effective_state
                  END AS state,
                  suggestion.provenance,
                  CASE
                    WHEN COALESCE(metadata.effective_state, suggestion.state) = 'proposed'
                    THEN NULL ELSE suggestion.decided_at
                  END AS decided_at,
                  suggestion.created_at,
                  MAX(suggestion.updated_at, COALESCE(metadata.updated_at, suggestion.updated_at))
                    AS updated_at,
                  metadata.dismiss_reason_code,
                  metadata.converted_todo_id,
                  COALESCE(metadata.acceptance_undone, 0) AS acceptance_undone
           FROM suggestions_v2 AS suggestion
           LEFT JOIN suggestion_action_metadata AS metadata
             ON metadata.suggestion_id = suggestion.id
           ORDER BY updated_at DESC, suggestion.id
           LIMIT ?`
        )
        .all(PUBLIC_SNAPSHOT_LIST_LIMIT)
        .map((row) => ({
          id: row.id,
          title: row.title,
          rationale: row.rationale,
          state: row.state,
          provenance: row.provenance,
          dismissReasonCode: row.dismiss_reason_code,
          convertedTodoId: row.converted_todo_id,
          acceptanceUndone: row.acceptance_undone === 1,
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

      const todoCardSeeds = todos.map((todo) => {
        const trustSnapshot =
          todo.trustSnapshot?.state === "captured" &&
          Array.isArray(todo.trustSnapshot.applicationEvidence) &&
          Array.isArray(todo.trustSnapshot.activityEvidence)
            ? todo.trustSnapshot
            : null;
        const capturedSegmentIds = trustSnapshot
          ? new Set(
              trustSnapshot.applicationEvidence
                .map((entry) => entry?.segmentId)
                .filter((segmentId) =>
                  trustSnapshot.activityEvidence.some(
                    (entry) => typeof segmentId === "string" && entry?.segmentId === segmentId
                  )
                )
            )
          : null;
        const capturedEvidence =
          capturedSegmentIds?.size > 0 ? latestCardEvidence(todo, capturedSegmentIds) : null;
        const evidence = capturedEvidence ?? latestCardEvidence(todo);
        return {
          item: todo,
          evidence,
          sessionId: evidence?.sessionId ?? latestCardSessionId(todo),
          trustSnapshot: capturedEvidence ? trustSnapshot : null,
        };
      });
      const suggestionCardSeeds = suggestions.map((suggestion) => {
        const evidence = latestCardEvidence(suggestion);
        return {
          item: suggestion,
          evidence,
          sessionId: evidence?.sessionId ?? latestCardSessionId(suggestion),
          trustSnapshot: null,
        };
      });
      const cardSeeds = [...todoCardSeeds, ...suggestionCardSeeds];
      const evidenceIds = [
        ...new Set(
          cardSeeds
            .map((seed) => seed.evidence?.handle?.evidenceId)
            .filter((evidenceId) => typeof evidenceId === "string")
        ),
      ];
      const cardEvidenceById = new Map(
        (evidenceIds.length === 0
          ? []
          : this.db
              .prepare(
                `SELECT ref.id AS evidence_id, ref.session_id, ref.transcript_segment_id,
                        ref.started_at, ref.ended_at,
                        COALESCE(track.source_type, segment.source_type) AS source_type,
                        track.application_key, track.attribution_state
                 FROM evidence_refs AS ref
                 LEFT JOIN transcript_segments AS segment
                   ON segment.id = ref.transcript_segment_id
                  AND segment.session_id = ref.session_id
                 LEFT JOIN audio_tracks AS track
                   ON track.id = ref.track_id AND track.session_id = ref.session_id
                 WHERE ref.id IN (${evidenceIds.map(() => "?").join(", ")})`
              )
              .all(...evidenceIds)
        ).map((row) => [row.evidence_id, row])
      );
      const sessionIds = [
        ...new Set(
          cardSeeds
            .map((seed) => {
              const evidenceId = seed.evidence?.handle?.evidenceId;
              return cardEvidenceById.get(evidenceId)?.session_id ?? seed.sessionId;
            })
            .filter((sessionId) => typeof sessionId === "string")
        ),
      ];
      const cardSessionStartedAt = new Map(
        (sessionIds.length === 0
          ? []
          : this.db
              .prepare(
                `SELECT id, started_at FROM sessions
                 WHERE id IN (${sessionIds.map(() => "?").join(", ")})`
              )
              .all(...sessionIds)
        ).map((row) => [row.id, row.started_at])
      );
      const currentClassificationsBySession = new Map();
      const currentClassifications = (sessionId) => {
        if (!currentClassificationsBySession.has(sessionId)) {
          currentClassificationsBySession.set(
            sessionId,
            this._effectiveActivityActionClassifications(sessionId).filter(
              (classification) => classification.decision === "adopted"
            )
          );
        }
        return currentClassificationsBySession.get(sessionId);
      };
      const projectCardContext = (seed) => {
        const evidenceId = seed.evidence?.handle?.evidenceId;
        const row = cardEvidenceById.get(evidenceId) ?? null;
        const sessionId = row?.session_id ?? seed.sessionId;
        const sessionStartedAt = cardSessionStartedAt.get(sessionId) ?? null;
        let attribution = null;
        if (seed.trustSnapshot && typeof seed.evidence?.segmentId === "string") {
          try {
            attribution = buildCapturedTodoActionEvidenceAttribution({
              transcriptSegmentId: seed.evidence.segmentId,
              applicationEvidence: seed.trustSnapshot.applicationEvidence,
              activityEvidence: seed.trustSnapshot.activityEvidence,
              semanticConfidence: seed.trustSnapshot.semanticConfidence,
              voiceprintConfidence: seed.trustSnapshot.voiceprintConfidence,
              transcriptContextConfidence: seed.trustSnapshot.transcriptContextConfidence,
            });
          } catch {
            attribution = null;
          }
        }
        if (
          attribution === null &&
          row &&
          (row.source_type === "mic" || row.source_type === "system") &&
          Number.isSafeInteger(row.started_at) &&
          Number.isSafeInteger(row.ended_at) &&
          row.ended_at > row.started_at
        ) {
          try {
            attribution = buildActionEvidenceAttribution({
              sourceType: row.source_type,
              applicationKey: row.application_key,
              attributionState:
                row.attribution_state ??
                (row.application_key
                  ? "exact"
                  : row.source_type === "system"
                    ? "mixed_unknown"
                    : null),
              startedAt: row.started_at,
              endedAt: row.ended_at,
              classifications: currentClassifications(sessionId),
            });
          } catch {
            attribution = null;
          }
        }
        return cardContextFromAttribution(sessionId, sessionStartedAt, attribution);
      };
      for (const seed of todoCardSeeds) seed.item.cardContext = projectCardContext(seed);
      for (const seed of suggestionCardSeeds) seed.item.cardContext = projectCardContext(seed);

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
