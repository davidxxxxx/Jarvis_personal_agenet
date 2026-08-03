const crypto = require("node:crypto");
const {
  ANALYSIS_TOOL,
  AnalysisSchemaError,
  salvageCandidateAnalysis,
  validateCandidateAnalysis,
} = require("./JarvisAnalysisSchema");
const {
  INPUT_CONTRACT_VERSION,
  LEGACY_INPUT_CONTRACT_VERSION,
  normalizedSegmentContext,
} = require("./AnalysisInputBuilder");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const OFFICIAL_HOSTS = new Set(["api.minimaxi.com", "api.minimax.io"]);
const ANONYMOUS_SPEAKER_PATTERN = /^(?:SELF|P[1-9][0-9]*)$/u;
const LEARNING_GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const V2_SEGMENT_KEYS = ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"];
const V3_SEGMENT_KEYS = [
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
];
const RAW_SENSITIVE_TEXT_PATTERNS = Object.freeze([
  /\bBearer\s+[^\s"'<>]+/iu,
  /\bsk-(?:cp-)?[A-Za-z0-9_-]{8,}\b/u,
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/iu,
  /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/u,
  /(^|[\s(=])(?:[A-Za-z]:[\\/]|\\\\)[^"'<>\r\n,;)\]}]*/u,
  /(^|[\s(=])\/(?!\/)[^"'<>\r\n,;)\]}]*/u,
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u,
]);
const LOG_KEYS = new Set([
  "requestId",
  "inputHash",
  "requestBytes",
  "responseBytes",
  "durationMs",
  "model",
  "inputTokens",
  "outputTokens",
  "estimatedCostMicrousd",
  "errorCode",
  "validatorIssueCode",
]);

class AnalysisClientError extends Error {
  constructor(code, { retryable = false, issueCode, authoritativeUsage } = {}) {
    super("MiniMax analysis request failed");
    this.name = "AnalysisClientError";
    this.code = code;
    this.retryable = retryable === true;
    if (issueCode !== undefined) this.issueCode = issueCode;
    if (authoritativeUsage !== undefined) this.authoritativeUsage = authoritativeUsage;
  }
}

function clientError(code, retryable = false, issueCode = undefined) {
  return new AnalysisClientError(code, { retryable, issueCode });
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function containsRawSensitiveText(value) {
  return RAW_SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function validOpaqueId(value) {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    Array.from(value).length <= 512 &&
    !containsRawSensitiveText(value)
  );
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateOmittedRanges(ranges) {
  let previous = null;
  for (const range of ranges) {
    if (
      !exactKeys(range, ["startedAt", "endedAt"]) ||
      !Number.isSafeInteger(range.startedAt) ||
      !Number.isSafeInteger(range.endedAt) ||
      range.startedAt < 0 ||
      range.endedAt <= range.startedAt ||
      (previous !== null && range.startedAt <= previous.endedAt)
    ) {
      throw clientError("invalid_structure");
    }
    previous = range;
  }
}

function validateV3SegmentContext(segment) {
  let normalized;
  try {
    normalized = normalizedSegmentContext({
      applicationKey: segment.applicationKey,
      sourceAttribution: segment.sourceAttribution,
      activityCategory: segment.activityCategory,
      activityConfidence: segment.activityConfidence,
      activityDecision: segment.activityDecision,
      selfParticipated: segment.selfParticipated,
      speakerBindingLabel: segment.speakerLabel,
    });
  } catch {
    throw clientError("invalid_structure");
  }
  const supplied = Object.fromEntries(Object.keys(normalized).map((key) => [key, segment[key]]));
  if (JSON.stringify(supplied) !== JSON.stringify(normalized)) {
    throw clientError("invalid_structure");
  }
}

function normalizeInput(input) {
  const inputHasLearningGoalIds = isPlainObject(input) && hasOwn(input, "allowedLearningGoalIds");
  const expectedInputKeys = inputHasLearningGoalIds
    ? [
        "cloudPayloadJson",
        "inputHash",
        "allowedSegmentIds",
        "allowedOwnerLabels",
        "allowedLearningGoalIds",
      ]
    : ["cloudPayloadJson", "inputHash", "allowedSegmentIds", "allowedOwnerLabels"];
  if (!exactKeys(input, expectedInputKeys)) {
    throw clientError("invalid_structure");
  }
  if (
    typeof input.cloudPayloadJson !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.inputHash) ||
    !Array.isArray(input.allowedSegmentIds) ||
    !Array.isArray(input.allowedOwnerLabels) ||
    (inputHasLearningGoalIds && !Array.isArray(input.allowedLearningGoalIds))
  ) {
    throw clientError("invalid_structure");
  }
  let cloudPayload;
  try {
    cloudPayload = JSON.parse(input.cloudPayloadJson);
  } catch {
    throw clientError("invalid_json");
  }
  const allowedLearningGoalIdValues = input.allowedLearningGoalIds ?? [];
  const allowedSegmentIds = new Set(input.allowedSegmentIds);
  const allowedOwnerLabels = new Set(input.allowedOwnerLabels);
  const allowedLearningGoalIds = new Set(allowedLearningGoalIdValues);
  if (
    allowedSegmentIds.size !== input.allowedSegmentIds.length ||
    allowedOwnerLabels.size !== input.allowedOwnerLabels.length ||
    allowedLearningGoalIds.size !== allowedLearningGoalIdValues.length ||
    input.allowedSegmentIds.some((segmentId) => !validOpaqueId(segmentId)) ||
    input.allowedOwnerLabels.some(
      (ownerLabel) => typeof ownerLabel !== "string" || !ANONYMOUS_SPEAKER_PATTERN.test(ownerLabel)
    ) ||
    allowedLearningGoalIdValues.some(
      (goalId) => typeof goalId !== "string" || !LEARNING_GOAL_ID_PATTERN.test(goalId)
    )
  ) {
    throw clientError("invalid_structure");
  }
  const payloadHasLearningGoals = hasOwn(cloudPayload, "learningGoals");
  const expectedPayloadKeys = payloadHasLearningGoals
    ? ["inputVersion", "learningGoals", "segments", "omittedRanges"]
    : ["inputVersion", "segments", "omittedRanges"];
  if (
    !exactKeys(cloudPayload, expectedPayloadKeys) ||
    !new Set([INPUT_CONTRACT_VERSION, LEGACY_INPUT_CONTRACT_VERSION]).has(
      cloudPayload.inputVersion
    ) ||
    (payloadHasLearningGoals && !Array.isArray(cloudPayload.learningGoals)) ||
    !Array.isArray(cloudPayload.segments) ||
    cloudPayload.segments.length === 0 ||
    !Array.isArray(cloudPayload.omittedRanges)
  ) {
    throw clientError("invalid_structure");
  }
  if ((cloudPayload.learningGoals ?? []).length > 32) {
    throw clientError("invalid_structure");
  }
  const payloadLearningGoalIds = new Set();
  for (const goal of cloudPayload.learningGoals ?? []) {
    if (
      !exactKeys(goal, ["goalId", "title"]) ||
      typeof goal.goalId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(goal.goalId) ||
      !allowedLearningGoalIds.has(goal.goalId) ||
      payloadLearningGoalIds.has(goal.goalId) ||
      typeof goal.title !== "string" ||
      !goal.title.trim() ||
      goal.title !== goal.title.trim() ||
      Array.from(goal.title).length > 500 ||
      containsRawSensitiveText(goal.title)
    ) {
      throw clientError("invalid_structure");
    }
    payloadLearningGoalIds.add(goal.goalId);
  }
  if (
    payloadLearningGoalIds.size !== allowedLearningGoalIds.size ||
    [...allowedLearningGoalIds].some((goalId) => !payloadLearningGoalIds.has(goalId))
  ) {
    throw clientError("invalid_structure");
  }
  const payloadOwnerLabels = new Set();
  const payloadSegmentIds = new Set();
  let previousSegment = null;
  for (const segment of cloudPayload.segments) {
    const expectedSegmentKeys =
      cloudPayload.inputVersion === INPUT_CONTRACT_VERSION ? V3_SEGMENT_KEYS : V2_SEGMENT_KEYS;
    if (
      !exactKeys(segment, expectedSegmentKeys) ||
      !validOpaqueId(segment.segmentId) ||
      payloadSegmentIds.has(segment.segmentId) ||
      !allowedSegmentIds.has(segment.segmentId) ||
      !Number.isSafeInteger(segment.startedAt) ||
      !Number.isSafeInteger(segment.endedAt) ||
      segment.startedAt < 0 ||
      segment.endedAt <= segment.startedAt ||
      typeof segment.speakerLabel !== "string" ||
      !ANONYMOUS_SPEAKER_PATTERN.test(segment.speakerLabel) ||
      !allowedOwnerLabels.has(segment.speakerLabel) ||
      typeof segment.text !== "string" ||
      !segment.text ||
      containsRawSensitiveText(segment.text) ||
      (previousSegment !== null &&
        (segment.startedAt < previousSegment.startedAt ||
          (segment.startedAt === previousSegment.startedAt &&
            segment.endedAt < previousSegment.endedAt) ||
          (segment.startedAt === previousSegment.startedAt &&
            segment.endedAt === previousSegment.endedAt &&
            segment.segmentId.localeCompare(previousSegment.segmentId) < 0)))
    ) {
      throw clientError("invalid_structure");
    }
    if (cloudPayload.inputVersion === INPUT_CONTRACT_VERSION) {
      validateV3SegmentContext(segment);
    }
    payloadSegmentIds.add(segment.segmentId);
    payloadOwnerLabels.add(segment.speakerLabel);
    previousSegment = segment;
  }
  validateOmittedRanges(cloudPayload.omittedRanges);
  if (
    !sameSet(payloadSegmentIds, allowedSegmentIds) ||
    !sameSet(payloadOwnerLabels, allowedOwnerLabels)
  ) {
    throw clientError("invalid_structure");
  }
  return {
    cloudPayloadJson: input.cloudPayloadJson,
    inputHash: input.inputHash,
    allowedSegmentIds,
    allowedOwnerLabels,
    allowedLearningGoalIds,
  };
}

function parseJsonObject(
  text,
  { ambiguityIsStructure = false, issuePrefix = "envelope.content" } = {}
) {
  if (typeof text !== "string") {
    throw clientError("invalid_structure", false, `${issuePrefix}.type`);
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw clientError("invalid_structure", false, `${issuePrefix}.shape`);
  }
  if (ambiguityIsStructure && /\}\s*\{/u.test(trimmed)) {
    throw clientError("invalid_structure", false, `${issuePrefix}.ambiguous`);
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw clientError("invalid_json", false, `${issuePrefix}.json`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw clientError("invalid_structure", false, `${issuePrefix}.object`);
  }
  return parsed;
}

function extractCandidate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.choices)) {
    throw clientError("invalid_structure", false, "envelope.body");
  }
  if (body.choices.length !== 1) {
    throw clientError("invalid_structure", false, "envelope.choices_count");
  }
  const message = body.choices[0]?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw clientError("invalid_structure", false, "envelope.message");
  }

  const legacyCall = message.function_call;
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw clientError("invalid_structure", false, "envelope.tool_calls_type");
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    if (toolCalls.length !== 1) {
      throw clientError("invalid_structure", false, "envelope.tool_calls_count");
    }
    if (legacyCall !== undefined && legacyCall !== null) {
      throw clientError("invalid_structure", false, "envelope.conflicting_function_call");
    }
    const call = toolCalls[0];
    if (
      call?.type !== "function" ||
      call?.function?.name !== "submit_jarvis_analysis" ||
      typeof call?.function?.arguments !== "string"
    ) {
      throw clientError("invalid_structure", false, "envelope.tool_call_shape");
    }
    // MiniMax may include null or structured reasoning/content beside a valid
    // tool call. The analysis candidate lives exclusively in the arguments,
    // so unrelated assistant content is deliberately ignored.
    return parseJsonObject(call.function.arguments, {
      issuePrefix: "envelope.tool_arguments",
    });
  }

  if (legacyCall !== undefined && legacyCall !== null) {
    if (
      typeof legacyCall !== "object" ||
      Array.isArray(legacyCall) ||
      legacyCall.name !== "submit_jarvis_analysis" ||
      typeof legacyCall.arguments !== "string"
    ) {
      throw clientError("invalid_structure", false, "envelope.legacy_function_call_shape");
    }
    return parseJsonObject(legacyCall.arguments, {
      issuePrefix: "envelope.legacy_function_arguments",
    });
  }

  if (typeof message.content !== "string") {
    throw clientError("invalid_structure", false, "envelope.content_type");
  }
  const content = message.content.trim();
  if (content.startsWith("```")) {
    const match = /^```json\s*\r?\n?([\s\S]*?)\r?\n?```$/iu.exec(content);
    if (!match || match[1].includes("```")) {
      throw clientError("invalid_structure", false, "envelope.content_fence");
    }
    return parseJsonObject(match[1], {
      ambiguityIsStructure: true,
      issuePrefix: "envelope.content",
    });
  }
  if (content.includes("```")) {
    throw clientError("invalid_structure", false, "envelope.content_fence");
  }
  return parseJsonObject(content, {
    ambiguityIsStructure: true,
    issuePrefix: "envelope.content",
  });
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function extractAuthoritativeUsage(body) {
  const raw = body?.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inputTokens = safeTokenCount(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = safeTokenCount(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

function attachAuthoritativeUsage(error, authoritativeUsage) {
  if (error instanceof AnalysisClientError && authoritativeUsage) {
    error.authoritativeUsage = authoritativeUsage;
  }
  return error;
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

class MiniMaxAnalysisClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getApiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    logger = () => {},
    createRequestId = () => `analysis_${crypto.randomUUID().replaceAll("-", "")}`,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof getApiKey !== "function") throw new TypeError("getApiKey is required");
    if (typeof logger !== "function") throw new TypeError("logger must be a function");
    if (typeof createRequestId !== "function")
      throw new TypeError("createRequestId must be a function");
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
      // Analysis must not fail because diagnostic logging is unavailable.
    }
  }

  isConfigured() {
    try {
      const apiKey = this.getApiKey();
      return typeof apiKey === "string" && Boolean(apiKey.trim()) && apiKey === apiKey.trim();
    } catch {
      return false;
    }
  }

  async analyze(input) {
    const requestId = this.createRequestId();
    const startedAt = this.now();
    let inputHash;
    let requestBytes;
    let responseBytes;
    try {
      const normalized = normalizeInput(input);
      inputHash = normalized.inputHash;
      const body = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Analyze only the supplied pseudonymous transcript text and its explicit normalized application/activity policy fields. Treat the recording as a hierarchy: first derive a concise local account for each represented 20-minute time window using its timestamps, then reconcile recurring topics, decisions, people, and actions across windows into one session-level result. Do not over-weight only the beginning or end, and do not merge unrelated activities merely because they share words. Call submit_jarvis_analysis exactly once with one concise jarvis-analysis-v3 object; do not answer with prose. Copy evidenceSegmentIds character-for-character only from supplied segmentId values; never invent, shorten, translate, or reformat an ID. Pn speaker labels may be diarization evidence clusters, not verified people. Never infer participant count, language count, identity, gender, or relationships from the number of Pn labels; omit such counts unless the transcript explicitly states them. Treat isolated unexpected scripts and generic subtitle phrases as possible ASR noise unless corroborated by nearby evidence. Use ownerLabel only when it is exactly one supplied speakerLabel, otherwise use null. A todo is allowed only for an explicit SELF commitment or an assignment that SELF explicitly accepts; otherwise omit it. Every todo must include semanticConfidence and actionKind. For actionKind self_commitment, assignmentSegmentIds and acceptanceSegmentIds must both be empty and evidenceSegmentIds must contain only the SELF commitment sentence(s). For actionKind assignment_accepted, assignmentSegmentIds must contain only the other speaker's explicit assignment, acceptanceSegmentIds must contain only SELF's later explicit acceptance, and evidenceSegmentIds must be exactly their union. Never label mere co-occurrence of SELF and another speaker as assignment acceptance. Never turn commands, tactics, or dialogue from games, videos, streams, podcasts, courses, or entertainment into a todo. Every suggestion must cite SELF-participating evidence and set basis to exactly one of work_context, learning_goal, or explicit_agreement. For learning_goal, copy learningGoalId character-for-character from one supplied learningGoals entry and make the suggestion directly advance that goal; if no supplied goal matches, omit the suggestion. For work_context and explicit_agreement, learningGoalId must be null. Use explicit_agreement only when the cited dialogue contains an explicit agreement, not an inferred social obligation. Never invent a goal ID. Omit suggestions for games, entertainment, passive media, or uncertain activity. Omit any optional item that cannot cite an exact supplied segment ID. Use at most 20 memories, 12 topics, 20 todos, and 12 suggestions, with 1-6 strongest evidence IDs per item. For long recordings, prefer evidence spanning distinct relevant time windows. Never invent state, dates, or calendar actions.",
          },
          { role: "user", content: normalized.cloudPayloadJson },
        ],
        tools: [ANALYSIS_TOOL],
        tool_choice: {
          type: "function",
          function: { name: "submit_jarvis_analysis" },
        },
        reasoning_split: true,
        temperature: 0.1,
        max_completion_tokens: 8192,
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
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            useSessionCookies: false,
          });
        } catch (error) {
          if (error instanceof AnalysisClientError) throw error;
          throw clientError("network", true);
        }
        if (!response || typeof response.status !== "number") throw clientError("network", true);
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          if (response.status === 401 || response.status === 403)
            throw clientError("configuration");
          if (response.status === 408) throw clientError("network", true);
          if (response.status === 429) throw clientError("rate_limit", true);
          if (response.status >= 500) throw clientError("service_unavailable", true);
          throw clientError("request_rejected");
        }
        let raw;
        try {
          raw = await readResponseBytes(response, this.maxResponseBytes, controller);
        } catch (error) {
          if (error instanceof AnalysisClientError) throw error;
          throw clientError("network", true);
        }
        responseBytes = raw.byteLength;
        let envelopeBody;
        try {
          envelopeBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch {
          throw clientError("invalid_json");
        }
        const authoritativeUsage = extractAuthoritativeUsage(envelopeBody);
        let parsed;
        try {
          parsed = extractCandidate(envelopeBody);
        } catch (error) {
          throw attachAuthoritativeUsage(error, authoritativeUsage);
        }
        let result;
        try {
          const validationContext = {
            allowedSegmentIds: normalized.allowedSegmentIds,
            allowedOwnerLabels: normalized.allowedOwnerLabels,
            allowedLearningGoalIds: normalized.allowedLearningGoalIds,
          };
          try {
            result = validateCandidateAnalysis(parsed, validationContext);
          } catch (error) {
            if (!(error instanceof AnalysisSchemaError)) throw error;
            result = salvageCandidateAnalysis(parsed, validationContext);
          }
        } catch (error) {
          if (error instanceof AnalysisSchemaError) {
            throw attachAuthoritativeUsage(
              clientError("invalid_structure", false, error.issueCode),
              authoritativeUsage
            );
          }
          throw error;
        }
        if (!authoritativeUsage) throw clientError("usage_unknown");
        this._log({
          requestId,
          inputHash,
          requestBytes,
          responseBytes,
          durationMs: Math.max(0, this.now() - startedAt),
          model: this.model,
          inputTokens: authoritativeUsage.inputTokens,
          outputTokens: authoritativeUsage.outputTokens,
        });
        return {
          result,
          usage: authoritativeUsage,
          model: this.model,
          requestId,
          inputHash,
          requestBytes,
          responseBytes,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const safeError =
        error instanceof AnalysisClientError ? error : clientError("invalid_structure", false);
      this._log({
        requestId,
        inputHash,
        requestBytes,
        responseBytes,
        durationMs: Math.max(0, this.now() - startedAt),
        model: this.model,
        inputTokens: safeError.authoritativeUsage?.inputTokens,
        outputTokens: safeError.authoritativeUsage?.outputTokens,
        errorCode: safeError.code,
        validatorIssueCode: safeError.issueCode,
      });
      throw safeError;
    }
  }
}

module.exports = MiniMaxAnalysisClient;
module.exports.AnalysisClientError = AnalysisClientError;
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.DEFAULT_MAX_REQUEST_BYTES = DEFAULT_MAX_REQUEST_BYTES;
module.exports.DEFAULT_MAX_RESPONSE_BYTES = DEFAULT_MAX_RESPONSE_BYTES;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
