const crypto = require("node:crypto");
const {
  DAILY_DIGEST_TOOL,
  DailyDigestSchemaError,
  validateCandidateDailyDigest,
} = require("./DailyDigestSchema");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PERSISTED_PAYLOAD_BYTES = 96 * 1024;
const MAX_INPUT_ITEMS = 4_096;
const OFFICIAL_HOSTS = new Set(["api.minimaxi.com", "api.minimax.io"]);
const LOG_KEYS = new Set([
  "requestId",
  "inputHash",
  "requestBytes",
  "responseBytes",
  "durationMs",
  "model",
  "inputTokens",
  "outputTokens",
  "errorCode",
  "validatorIssueCode",
]);
const SECTION_KEYS = Object.freeze([
  "sessions",
  "peopleInteractions",
  "topics",
  "decisions",
  "commitments",
  "todosCreated",
  "todosCompleted",
  "unresolvedConflicts",
  "transcriptCoverage",
]);
const COVERAGE_KEYS = Object.freeze([
  "selectedSegmentCount",
  "incompleteSegmentCount",
  "sessionCount",
  "startsAt",
  "endsAt",
]);

class DailyDigestClientError extends Error {
  constructor(code, { retryable = false, issueCode } = {}) {
    super("MiniMax daily digest request failed");
    this.name = "DailyDigestClientError";
    this.code = code;
    this.retryable = retryable === true;
    if (issueCode !== undefined) this.issueCode = issueCode;
  }
}

function clientError(code, retryable = false, issueCode = undefined) {
  return new DailyDigestClientError(code, { retryable, issueCode });
}

function parseOfficialEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw clientError("configuration");
  }
  if (
    parsed.protocol !== "https:" ||
    !OFFICIAL_HOSTS.has(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/v1" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw clientError("configuration");
  }
  return `${parsed.origin}/v1/chat/completions`;
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validText(value, maxCodePoints = 8_000) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= maxCodePoints &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validPayloadText(value, maxCodePoints = 8_000) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maxCodePoints &&
    !/[\u0000\u007f]/u.test(value)
  );
}

function validUniquePayloadStrings(value, { min = 0, max = MAX_INPUT_ITEMS } = {}) {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every((item) => validPayloadText(item, 8_000)) &&
    new Set(value).size === value.length
  );
}

function validLocalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

function validTimezone(value) {
  if (!validText(value, 128)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validInteger(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function validUniqueStrings(value, { min = 0, max = MAX_INPUT_ITEMS } = {}) {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every((item) => validText(item, 512)) &&
    new Set(value).size === value.length
  );
}

function validateEvidence(value, allowedSegmentIds, { min = 1 } = {}) {
  return (
    validUniqueStrings(value, { min }) &&
    value.every((segmentId) => allowedSegmentIds.has(segmentId))
  );
}

function normalizeCloudPayload(cloudPayload) {
  if (
    !exactKeys(cloudPayload, ["schemaVersion", "localDate", "timezone", "completeness", "sections"]) ||
    cloudPayload.schemaVersion !== "jarvis-daily-digest-input-v1" ||
    !validLocalDate(cloudPayload.localDate) ||
    !validTimezone(cloudPayload.timezone) ||
    !new Set(["partial", "final"]).has(cloudPayload.completeness) ||
    !exactKeys(cloudPayload.sections, SECTION_KEYS)
  ) {
    throw clientError("invalid_structure");
  }
  const sections = cloudPayload.sections;
  if (
    !Array.isArray(sections.sessions) ||
    sections.sessions.length < 1 ||
    sections.sessions.length > MAX_INPUT_ITEMS
  ) {
    throw clientError("invalid_structure");
  }
  const allowedSegmentIds = new Set();
  const allowedSubjectRefs = new Set();
  const sessionRefs = new Set();
  for (const session of sections.sessions) {
    if (
      !exactKeys(session, [
        "sessionRef",
        "processingState",
        "timelineVersion",
        "readyAt",
        "segments",
      ]) ||
      !/^session-[0-9a-f]{16}$/u.test(session.sessionRef) ||
      sessionRefs.has(session.sessionRef) ||
      !validText(session.processingState, 64) ||
      !validInteger(session.timelineVersion) ||
      (session.readyAt !== null && !validInteger(session.readyAt)) ||
      !Array.isArray(session.segments) ||
      session.segments.length < 1 ||
      session.segments.length > MAX_INPUT_ITEMS
    ) {
      throw clientError("invalid_structure");
    }
    sessionRefs.add(session.sessionRef);
    for (const segment of session.segments) {
      if (
        !exactKeys(segment, [
          "segmentId",
          "startedAt",
          "endedAt",
          "subjectRef",
          "text",
        ]) ||
        !validText(segment.segmentId, 512) ||
        allowedSegmentIds.has(segment.segmentId) ||
        !validInteger(segment.startedAt) ||
        !validInteger(segment.endedAt) ||
        segment.startedAt >= segment.endedAt ||
        !/^(?:SELF|subject-[0-9a-f]{16})$/u.test(segment.subjectRef) ||
        !validPayloadText(segment.text)
      ) {
        throw clientError("invalid_structure");
      }
      allowedSegmentIds.add(segment.segmentId);
      allowedSubjectRefs.add(segment.subjectRef);
    }
  }

  if (
    !Array.isArray(sections.peopleInteractions) ||
    sections.peopleInteractions.length > MAX_INPUT_ITEMS
  ) {
    throw clientError("invalid_structure");
  }
  const interactionRefs = new Set();
  for (const interaction of sections.peopleInteractions) {
    if (
      !exactKeys(interaction, ["subjectRef", "sessionRefs", "evidenceSegmentIds"]) ||
      !allowedSubjectRefs.has(interaction.subjectRef) ||
      interactionRefs.has(interaction.subjectRef) ||
      !validUniqueStrings(interaction.sessionRefs, { min: 1 }) ||
      interaction.sessionRefs.some((ref) => !sessionRefs.has(ref)) ||
      !validateEvidence(interaction.evidenceSegmentIds, allowedSegmentIds)
    ) {
      throw clientError("invalid_structure");
    }
    interactionRefs.add(interaction.subjectRef);
  }
  if (
    interactionRefs.size !== allowedSubjectRefs.size ||
    [...allowedSubjectRefs].some((ref) => !interactionRefs.has(ref))
  ) {
    throw clientError("invalid_structure");
  }

  const validateEvidenceSection = (items, refKey, extraKeys = [], extraCheck = () => true) => {
    if (!Array.isArray(items) || items.length > MAX_INPUT_ITEMS) {
      throw clientError("invalid_structure");
    }
    for (const item of items) {
      if (
        !exactKeys(item, [refKey, "text", "evidenceSegmentIds", ...extraKeys]) ||
        !validText(item[refKey], 512) ||
        !validPayloadText(item.text) ||
        !validateEvidence(item.evidenceSegmentIds, allowedSegmentIds) ||
        !extraCheck(item)
      ) {
        throw clientError("invalid_structure");
      }
    }
  };
  validateEvidenceSection(sections.topics, "topicRef");
  validateEvidenceSection(sections.decisions, "itemRef");
  validateEvidenceSection(sections.commitments, "itemRef");
  validateEvidenceSection(
    sections.todosCreated,
    "todoRef",
    ["status"],
    (item) => item.status === "open"
  );
  validateEvidenceSection(
    sections.todosCompleted,
    "todoRef",
    ["status"],
    (item) => item.status === "completed"
  );
  if (
    !Array.isArray(sections.unresolvedConflicts) ||
    sections.unresolvedConflicts.length > MAX_INPUT_ITEMS
  ) {
    throw clientError("invalid_structure");
  }
  const conflictRefs = new Set();
  for (const conflict of sections.unresolvedConflicts) {
    if (
      !exactKeys(conflict, ["conflictRef", "alternatives", "evidenceSegmentIds"]) ||
      !validText(conflict.conflictRef, 512) ||
      conflictRefs.has(conflict.conflictRef) ||
      !validUniquePayloadStrings(conflict.alternatives, { min: 1 }) ||
      !validateEvidence(conflict.evidenceSegmentIds, allowedSegmentIds)
    ) {
      throw clientError("invalid_structure");
    }
    conflictRefs.add(conflict.conflictRef);
  }

  const coverage = sections.transcriptCoverage;
  if (!exactKeys(coverage, COVERAGE_KEYS)) throw clientError("invalid_structure");
  for (const key of COVERAGE_KEYS) {
    if (!validInteger(coverage[key])) throw clientError("invalid_structure");
  }
  if (
    coverage.selectedSegmentCount !== allowedSegmentIds.size ||
    coverage.sessionCount !== sessionRefs.size ||
    coverage.startsAt >= coverage.endsAt ||
    (cloudPayload.completeness === "final" && coverage.incompleteSegmentCount !== 0)
  ) {
    throw clientError("invalid_structure");
  }
  return {
    allowedSegmentIds,
    allowedSubjectRefs,
    completeness: cloudPayload.completeness,
    transcriptCoverage: { ...coverage },
  };
}

function normalizeInput(input) {
  if (
    !exactKeys(input, ["cloudPayloadJson", "inputHash"]) ||
    typeof input.cloudPayloadJson !== "string" ||
    Buffer.byteLength(input.cloudPayloadJson, "utf8") > MAX_PERSISTED_PAYLOAD_BYTES ||
    !/^[0-9a-f]{64}$/u.test(input.inputHash)
  ) {
    throw clientError("invalid_structure");
  }
  let cloudPayload;
  try {
    cloudPayload = JSON.parse(input.cloudPayloadJson);
  } catch {
    throw clientError("invalid_json");
  }
  const validationContext = normalizeCloudPayload(cloudPayload);
  return {
    cloudPayloadJson: input.cloudPayloadJson,
    inputHash: input.inputHash,
    validationContext,
  };
}

function parseJsonObject(text, { ambiguityIsStructure = false } = {}) {
  if (typeof text !== "string") throw clientError("invalid_structure");
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw clientError("invalid_structure");
  }
  if (ambiguityIsStructure && /\}\s*\{/u.test(trimmed)) {
    throw clientError("invalid_structure");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw clientError("invalid_json");
  }
  if (!isPlainObject(parsed)) throw clientError("invalid_structure");
  return parsed;
}

function extractCandidate(body) {
  if (!isPlainObject(body) || !Array.isArray(body.choices) || body.choices.length !== 1) {
    throw clientError("invalid_structure");
  }
  const message = body.choices[0]?.message;
  if (!isPlainObject(message) || Object.prototype.hasOwnProperty.call(message, "function_call")) {
    throw clientError("invalid_structure");
  }
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length > 0)) {
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw clientError("invalid_structure");
    }
    if (message.content !== undefined && message.content !== null && message.content !== "") {
      throw clientError("invalid_structure");
    }
    const call = toolCalls[0];
    if (
      call?.function?.name !== "submit_jarvis_daily_digest" ||
      typeof call?.function?.arguments !== "string"
    ) {
      throw clientError("invalid_structure");
    }
    return parseJsonObject(call.function.arguments);
  }
  if (typeof message.content !== "string") throw clientError("invalid_structure");
  const content = message.content.trim();
  if (content.startsWith("```")) {
    const match = /^```json\s*\r?\n?([\s\S]*?)\r?\n?```$/iu.exec(content);
    if (!match || match[1].includes("```")) throw clientError("invalid_structure");
    return parseJsonObject(match[1], { ambiguityIsStructure: true });
  }
  if (content.includes("```")) throw clientError("invalid_structure");
  return parseJsonObject(content, { ambiguityIsStructure: true });
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function extractUsage(body) {
  return {
    inputTokens: safeTokenCount(body?.usage?.prompt_tokens ?? body?.usage?.input_tokens),
    outputTokens: safeTokenCount(
      body?.usage?.completion_tokens ?? body?.usage?.output_tokens
    ),
  };
}

async function readResponseBytes(response, maxBytes, controller) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && /^\d+$/u.test(declared)) {
    const size = Number(declared);
    if (Number.isSafeInteger(size) && size > maxBytes) {
      controller.abort();
      await response.body?.cancel?.().catch(() => {});
      throw clientError("response_too_large");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw clientError("response_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw clientError("response_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function enrichError(error, metadata) {
  if (metadata.requestBytes !== undefined) error.requestBytes = metadata.requestBytes;
  if (metadata.responseBytes !== undefined) error.responseBytes = metadata.responseBytes;
  if (metadata.usage !== undefined) error.usage = metadata.usage;
  if (metadata.requestSent === true) error.requestSent = true;
  return error;
}

class MiniMaxDailyDigestClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getApiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    timeoutMs = 60_000,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    logger = () => {},
    createRequestId = () => `digest_${crypto.randomUUID().replaceAll("-", "")}`,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof getApiKey !== "function") throw new TypeError("getApiKey is required");
    if (typeof logger !== "function") throw new TypeError("logger must be a function");
    if (typeof createRequestId !== "function") {
      throw new TypeError("createRequestId must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof model !== "string" || !model.trim() || model !== model.trim()) {
      throw clientError("configuration");
    }
    for (const [value, name] of [
      [timeoutMs, "timeoutMs"],
      [maxRequestBytes, "maxRequestBytes"],
      [maxResponseBytes, "maxResponseBytes"],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
    }
    this.fetchImpl = fetchImpl;
    this.getApiKey = getApiKey;
    this.endpoint = parseOfficialEndpoint(baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRequestBytes = maxRequestBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.logger = logger;
    this.createRequestId = createRequestId;
    this.now = now;
  }

  _log(record) {
    const safe = {};
    for (const [key, value] of Object.entries(record)) {
      if (LOG_KEYS.has(key) && value !== undefined) safe[key] = value;
    }
    try {
      this.logger(safe);
    } catch {
      // Digest generation must not fail because diagnostics are unavailable.
    }
  }

  async generate(input) {
    const requestId = this.createRequestId();
    const startedAt = this.now();
    let inputHash;
    let requestBytes;
    let responseBytes;
    let usage;
    let requestSent = false;
    try {
      const normalized = normalizeInput(input);
      inputHash = normalized.inputHash;
      const body = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Summarize only the supplied pseudonymous daily evidence. Return exactly one jarvis-daily-digest-v1 object through submit_jarvis_daily_digest. Every factual item must cite supplied segment IDs. Suggestions are proposals only: never create todos, calendar events, or messages automatically, and never invent IDs, people, timestamps, or completed actions.",
          },
          { role: "user", content: normalized.cloudPayloadJson },
        ],
        tools: [DAILY_DIGEST_TOOL],
        tool_choice: {
          type: "function",
          function: { name: "submit_jarvis_daily_digest" },
        },
        temperature: 0.1,
        max_completion_tokens: 4_096,
        stream: false,
      });
      requestBytes = Buffer.byteLength(body, "utf8");
      if (requestBytes > this.maxRequestBytes) throw clientError("request_too_large");
      const apiKey = this.getApiKey();
      if (typeof apiKey !== "string" || !apiKey) throw clientError("configuration");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response;
        try {
          requestSent = true;
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            useSessionCookies: false,
          });
        } catch (error) {
          if (error instanceof DailyDigestClientError) throw error;
          throw clientError("network", true);
        }
        if (!response || typeof response.status !== "number") {
          throw clientError("network", true);
        }
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          if (response.status === 401 || response.status === 403) {
            throw clientError("configuration");
          }
          if (response.status === 408) throw clientError("network", true);
          if (response.status === 429) throw clientError("rate_limit", true);
          if (response.status >= 500) throw clientError("service_unavailable", true);
          throw clientError("request_rejected");
        }
        let raw;
        try {
          raw = await readResponseBytes(response, this.maxResponseBytes, controller);
        } catch (error) {
          if (error instanceof DailyDigestClientError) throw error;
          throw clientError("network", true);
        }
        responseBytes = raw.byteLength;
        let envelopeBody;
        try {
          envelopeBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch {
          throw clientError("invalid_json");
        }
        usage = extractUsage(envelopeBody);
        const parsed = extractCandidate(envelopeBody);
        let result;
        try {
          result = validateCandidateDailyDigest(parsed, normalized.validationContext);
        } catch (error) {
          if (error instanceof DailyDigestSchemaError) {
            throw clientError("invalid_structure", false, error.issueCode);
          }
          throw error;
        }
        this._log({
          requestId,
          inputHash,
          requestBytes,
          responseBytes,
          durationMs: Math.max(0, this.now() - startedAt),
          model: this.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        return { result, usage, requestBytes, responseBytes };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const safeError = error instanceof DailyDigestClientError
        ? error
        : clientError("invalid_structure");
      enrichError(safeError, { requestBytes, responseBytes, usage, requestSent });
      this._log({
        requestId,
        inputHash,
        requestBytes,
        responseBytes,
        durationMs: Math.max(0, this.now() - startedAt),
        model: this.model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        errorCode: safeError.code,
        validatorIssueCode: safeError.issueCode,
      });
      throw safeError;
    }
  }
}

module.exports = MiniMaxDailyDigestClient;
module.exports.DailyDigestClientError = DailyDigestClientError;
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.DEFAULT_MAX_REQUEST_BYTES = DEFAULT_MAX_REQUEST_BYTES;
module.exports.DEFAULT_MAX_RESPONSE_BYTES = DEFAULT_MAX_RESPONSE_BYTES;
