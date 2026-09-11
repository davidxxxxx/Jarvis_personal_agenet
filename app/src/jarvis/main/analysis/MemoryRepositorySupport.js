const crypto = require("node:crypto");
const { AnalysisSchemaError, validateCandidateAnalysis } = require("../JarvisAnalysisSchema");
const { compileRedactionTerms } = require("../AnalysisInputBuilder");

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

module.exports = {
  HASH_PATTERN,
  APPLICATION_KEY_PATTERN,
  INPUT_CONTRACT_VERSION,
  LEGACY_INPUT_CONTRACT_VERSION,
  REDACTION_VERSION,
  CANONICAL_INPUT_VERSION,
  LEGACY_CANONICAL_INPUT_VERSION,
  PREPARE_TOKEN_VERSION,
  LEGACY_IMPORTER_VERSION,
  MAX_CLOUD_PAYLOAD_BYTES,
  MAX_ANALYSIS_CANDIDATE_BYTES,
  MAX_DAILY_DIGEST_CANDIDATE_BYTES,
  MIN_CLOUD_ANONYMOUS_SPEECH_MS,
  MIN_CLOUD_ANONYMOUS_WINDOWS,
  DAILY_DIGEST_INPUT_CONTRACT_VERSION,
  DAILY_DIGEST_WATERMARK_VERSION,
  PUBLIC_SNAPSHOT_LIST_LIMIT,
  PUBLIC_SNAPSHOT_HISTORY_LIMIT,
  PUBLIC_SNAPSHOT_EVIDENCE_LIMIT,
  CARD_CONTEXT_SOURCE_ATTRIBUTIONS,
  CARD_CONTEXT_ACTIVITY_CATEGORIES,
  PUBLIC_ANALYSIS_ERROR_CODES,
  OFFLINE_ANALYSIS_ERROR_CODES,
  BUDGET_ANALYSIS_ERROR_CODES,
  RUNTIME_ANALYSIS_ERROR_CODES,
  INVALID_ANALYSIS_ERROR_CODES,
  codedError,
  publicAnalysisErrorCode,
  canonicalJson,
  sha256,
  emptyKnowledgeCardContext,
  latestCardEvidence,
  latestCardSessionId,
  cardContextFromAttribution,
  compileDigestRedactor,
  digestFreeTextIsRedacted,
  pseudonymousRef,
  safeHashEqual,
  assertHash,
  assertText,
  assertId,
  assertTimestamp,
  hasExactKeys,
  assertExactPlainObject,
  assertJsonObject,
  assertLocalDate,
  assertTimezone,
  normalizedKey,
  parseLegacyArray,
  legacyText,
  legacyConfidence,
  legacyDueText,
  validateCandidate,
};
