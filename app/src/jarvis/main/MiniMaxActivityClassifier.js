"use strict";

const crypto = require("node:crypto");
const {
  INPUT_CONTRACT_VERSION,
  normalizeCloudPayload,
} = require("./ActivityClassificationInputBuilder");
const { ACTIVITY_CATEGORIES, applyConfidenceGate } = require("./LocalActivityClassifier");

const OUTPUT_CONTRACT_VERSION = "jarvis-activity-classification-output-v1";
const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const OFFICIAL_HOSTS = new Set(["api.minimaxi.com", "api.minimax.io"]);
const ACTIVITY_CATEGORY_SET = new Set(ACTIVITY_CATEGORIES);
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
  "issueCode",
]);

const ACTIVITY_CLASSIFICATION_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "submit_jarvis_activity_classification",
    description: "Return conservative classifications for the supplied pseudonymous activities.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["outputVersion", "classifications"],
      properties: {
        outputVersion: { type: "string", enum: [OUTPUT_CONTRACT_VERSION] },
        classifications: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["activityId", "category", "confidence", "reason", "evidenceSegmentIds"],
            properties: {
              activityId: { type: "string" },
              category: { type: "string", enum: ACTIVITY_CATEGORIES },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string", minLength: 1, maxLength: 240 },
              evidenceSegmentIds: {
                type: "array",
                maxItems: 12,
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
});

class ActivityClassificationClientError extends Error {
  constructor(code, { retryable = false, issueCode, usage } = {}) {
    super("MiniMax activity classification request failed");
    this.name = "ActivityClassificationClientError";
    this.code = code;
    this.retryable = retryable === true;
    if (issueCode !== undefined) this.issueCode = issueCode;
    if (usage !== undefined) this.usage = usage;
  }
}

function clientError(code, retryable = false, issueCode = undefined) {
  return new ActivityClassificationClientError(code, { retryable, issueCode });
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, issueCode) {
  if (!isPlainObject(value)) throw clientError("invalid_structure", false, issueCode);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
    throw clientError("invalid_structure", false, issueCode);
  }
  return value;
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
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/v1" ||
    parsed.search ||
    parsed.hash
  ) {
    throw clientError("configuration");
  }
  return `${parsed.origin}/v1/chat/completions`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function deriveValidationContext(payload) {
  return {
    activityIds: payload.activities.map((activity) => activity.activityId),
    sourceAttributionByActivity: Object.fromEntries(
      payload.activities.map((activity) => [activity.activityId, activity.sourceAttribution])
    ),
    selfParticipationByActivity: Object.fromEntries(
      payload.activities.map((activity) => [
        activity.activityId,
        activity.statistics.selfDetected === true ||
          activity.statistics.microphoneParticipated === true,
      ])
    ),
    segmentIdsByActivity: Object.fromEntries(
      payload.activities.map((activity) => [
        activity.activityId,
        activity.segments.map((segment) => segment.segmentId),
      ])
    ),
  };
}

function normalizeInput(input) {
  exactKeys(input, ["cloudPayloadJson", "inputHash", "validationContext"], "input.fields");
  if (
    typeof input.cloudPayloadJson !== "string" ||
    typeof input.inputHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.inputHash) ||
    sha256(input.cloudPayloadJson) !== input.inputHash
  ) {
    throw clientError("invalid_structure", false, "input.hash");
  }
  let payload;
  try {
    payload = JSON.parse(input.cloudPayloadJson);
    normalizeCloudPayload(payload);
  } catch {
    throw clientError("invalid_structure", false, "input.payload");
  }
  if (payload.inputVersion !== INPUT_CONTRACT_VERSION) {
    throw clientError("invalid_structure", false, "input.version");
  }
  exactKeys(
    input.validationContext,
    [
      "activityIds",
      "sourceAttributionByActivity",
      "selfParticipationByActivity",
      "segmentIdsByActivity",
    ],
    "input.validation_context"
  );
  const expectedContext = deriveValidationContext(payload);
  const suppliedActivityIds = input.validationContext.activityIds;
  const suppliedSources = input.validationContext.sourceAttributionByActivity;
  const suppliedSelfParticipation = input.validationContext.selfParticipationByActivity;
  const suppliedSegments = input.validationContext.segmentIdsByActivity;
  if (
    !Array.isArray(suppliedActivityIds) ||
    !isPlainObject(suppliedSources) ||
    !isPlainObject(suppliedSelfParticipation) ||
    !isPlainObject(suppliedSegments) ||
    JSON.stringify(suppliedActivityIds) !== JSON.stringify(expectedContext.activityIds) ||
    Object.keys(suppliedSources).length !== expectedContext.activityIds.length ||
    Object.keys(suppliedSelfParticipation).length !== expectedContext.activityIds.length ||
    Object.keys(suppliedSegments).length !== expectedContext.activityIds.length ||
    expectedContext.activityIds.some(
      (activityId) =>
        suppliedSources[activityId] !== expectedContext.sourceAttributionByActivity[activityId] ||
        suppliedSelfParticipation[activityId] !==
          expectedContext.selfParticipationByActivity[activityId] ||
        !Array.isArray(suppliedSegments[activityId]) ||
        JSON.stringify(suppliedSegments[activityId]) !==
          JSON.stringify(expectedContext.segmentIdsByActivity[activityId])
    )
  ) {
    throw clientError("invalid_structure", false, "input.validation_context_mismatch");
  }
  return {
    cloudPayloadJson: input.cloudPayloadJson,
    inputHash: input.inputHash,
    validationContext: expectedContext,
  };
}

function parseJsonObject(text, issueCode) {
  if (typeof text !== "string") throw clientError("invalid_structure", false, issueCode);
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || /\}\s*\{/u.test(trimmed)) {
    throw clientError("invalid_structure", false, issueCode);
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw clientError("invalid_json", false, issueCode);
  }
}

function extractCandidate(body) {
  if (!isPlainObject(body) || !Array.isArray(body.choices) || body.choices.length !== 1) {
    throw clientError("invalid_structure", false, "response.envelope");
  }
  const message = body.choices[0]?.message;
  if (!isPlainObject(message)) {
    throw clientError("invalid_structure", false, "response.message");
  }
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw clientError("invalid_structure", false, "response.tool_calls_type");
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    if (toolCalls.length !== 1) {
      throw clientError("invalid_structure", false, "response.tool_count");
    }
    const call = toolCalls[0];
    if (
      call?.type !== "function" ||
      call?.function?.name !== "submit_jarvis_activity_classification" ||
      (message.function_call !== undefined && message.function_call !== null)
    ) {
      throw clientError("invalid_structure", false, "response.tool_name");
    }
    return parseJsonObject(call.function.arguments, "response.tool_arguments");
  }
  if (message.function_call !== undefined && message.function_call !== null) {
    if (
      !isPlainObject(message.function_call) ||
      message.function_call.name !== "submit_jarvis_activity_classification"
    ) {
      throw clientError("invalid_structure", false, "response.function_call");
    }
    return parseJsonObject(message.function_call.arguments, "response.function_arguments");
  }
  if (typeof message.content !== "string" || message.content.includes("```")) {
    throw clientError("invalid_structure", false, "response.content");
  }
  return parseJsonObject(message.content, "response.content");
}

function sensitiveOutputText(value) {
  return (
    /\bBearer\s+\S+/iu.test(value) ||
    /\bsk-(?:cp-)?[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|etc)\/)/u.test(value)
  );
}

function validateCandidate(candidate, context) {
  exactKeys(candidate, ["outputVersion", "classifications"], "candidate.fields");
  if (
    candidate.outputVersion !== OUTPUT_CONTRACT_VERSION ||
    !Array.isArray(candidate.classifications) ||
    candidate.classifications.length !== context.activityIds.length
  ) {
    throw clientError("invalid_structure", false, "candidate.collection");
  }
  const activityIds = new Set(context.activityIds);
  const returned = new Set();
  const classifications = candidate.classifications.map((item, index) => {
    exactKeys(
      item,
      ["activityId", "category", "confidence", "reason", "evidenceSegmentIds"],
      `candidate.classifications.${index}.fields`
    );
    if (
      typeof item.activityId !== "string" ||
      !activityIds.has(item.activityId) ||
      returned.has(item.activityId) ||
      !ACTIVITY_CATEGORY_SET.has(item.category) ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      Array.from(item.reason).length > 240 ||
      sensitiveOutputText(item.reason) ||
      !Array.isArray(item.evidenceSegmentIds) ||
      item.evidenceSegmentIds.length > 12
    ) {
      throw clientError("invalid_structure", false, `candidate.classifications.${index}.value`);
    }
    const allowedEvidence = new Set(context.segmentIdsByActivity[item.activityId]);
    if (
      new Set(item.evidenceSegmentIds).size !== item.evidenceSegmentIds.length ||
      item.evidenceSegmentIds.some(
        (segmentId) => typeof segmentId !== "string" || !allowedEvidence.has(segmentId)
      )
    ) {
      throw clientError("invalid_structure", false, `candidate.classifications.${index}.evidence`);
    }
    returned.add(item.activityId);
    const gate = applyConfidenceGate(item.category, item.confidence, {
      sourceAttribution: context.sourceAttributionByActivity[item.activityId],
      selfParticipated: context.selfParticipationByActivity?.[item.activityId] === true,
    });
    return {
      activityId: item.activityId,
      ...gate,
      source: "minimax",
      reason: item.reason.trim(),
      evidenceSegmentIds: [...item.evidenceSegmentIds],
    };
  });
  return classifications.sort(
    (left, right) =>
      context.activityIds.indexOf(left.activityId) - context.activityIds.indexOf(right.activityId)
  );
}

// A malformed classification must not discard other independently valid
// activities. Invalid or sensitive items are omitted; the service keeps the
// previously persisted conservative local result for those activity ids.
function salvageCandidate(candidate, context) {
  exactKeys(candidate, ["outputVersion", "classifications"], "candidate.fields");
  if (
    candidate.outputVersion !== OUTPUT_CONTRACT_VERSION ||
    !Array.isArray(candidate.classifications) ||
    candidate.classifications.length > 32
  ) {
    throw clientError("invalid_structure", false, "candidate.collection");
  }
  const expectedIds = new Set(context.activityIds);
  const returned = new Set();
  const classifications = [];
  for (const item of candidate.classifications) {
    try {
      exactKeys(
        item,
        ["activityId", "category", "confidence", "reason", "evidenceSegmentIds"],
        "candidate.classification.fields"
      );
      if (
        typeof item.activityId !== "string" ||
        !expectedIds.has(item.activityId) ||
        returned.has(item.activityId) ||
        !ACTIVITY_CATEGORY_SET.has(item.category) ||
        typeof item.confidence !== "number" ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1 ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        sensitiveOutputText(item.reason) ||
        !Array.isArray(item.evidenceSegmentIds)
      ) {
        continue;
      }
      const allowedEvidence = new Set(context.segmentIdsByActivity[item.activityId]);
      const evidenceSegmentIds = [];
      for (const segmentId of item.evidenceSegmentIds) {
        if (
          typeof segmentId === "string" &&
          allowedEvidence.has(segmentId) &&
          !evidenceSegmentIds.includes(segmentId)
        ) {
          evidenceSegmentIds.push(segmentId);
        }
        if (evidenceSegmentIds.length >= 12) break;
      }
      returned.add(item.activityId);
      classifications.push({
        activityId: item.activityId,
        ...applyConfidenceGate(item.category, item.confidence, {
          sourceAttribution: context.sourceAttributionByActivity[item.activityId],
          selfParticipated: context.selfParticipationByActivity?.[item.activityId] === true,
        }),
        source: "minimax",
        reason: Array.from(item.reason.trim()).slice(0, 240).join(""),
        evidenceSegmentIds,
      });
    } catch (error) {
      if (!(error instanceof ActivityClassificationClientError)) throw error;
    }
  }
  if (classifications.length === 0) {
    throw clientError("invalid_structure", false, "candidate.no_valid_classifications");
  }
  return classifications.sort(
    (left, right) =>
      context.activityIds.indexOf(left.activityId) - context.activityIds.indexOf(right.activityId)
  );
}

function extractUsage(body) {
  const usage = body?.usage;
  if (!isPlainObject(usage)) throw clientError("usage_unknown");
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw clientError("usage_unknown");
  }
  return { inputTokens, outputTokens };
}

async function readResponseBytes(response, maxBytes, controller) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && /^\d+$/u.test(declared)) {
    const bytes = Number(declared);
    if (Number.isSafeInteger(bytes) && bytes > maxBytes) {
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

class MiniMaxActivityClassifier {
  constructor({
    fetchImpl = globalThis.fetch,
    getApiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    logger = () => {},
    createRequestId = () => `activity_${crypto.randomUUID().replaceAll("-", "")}`,
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
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
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

  isConfigured() {
    try {
      const apiKey = this.getApiKey();
      return typeof apiKey === "string" && Boolean(apiKey.trim()) && apiKey === apiKey.trim();
    } catch {
      return false;
    }
  }

  _log(record) {
    const safe = {};
    for (const [key, value] of Object.entries(record)) {
      if (LOG_KEYS.has(key) && value !== undefined) safe[key] = value;
    }
    try {
      this.logger(safe);
    } catch {
      // Classification must not fail because metadata-only diagnostics are unavailable.
    }
  }

  validateInput(input) {
    normalizeInput(input);
    return true;
  }

  async classify(input) {
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
              "Classify only the supplied pseudonymous activities. Call submit_jarvis_activity_classification exactly once. Return every activity exactly once using only supplied activity and segment IDs. Be conservative: entertainment video, sports, movies and gameplay are not meetings merely because they contain commands. Do not infer real identities, application details beyond the normalized names, todos, advice, paths, titles or audio properties.",
          },
          { role: "user", content: normalized.cloudPayloadJson },
        ],
        tools: [ACTIVITY_CLASSIFICATION_TOOL],
        tool_choice: {
          type: "function",
          function: { name: "submit_jarvis_activity_classification" },
        },
        reasoning_split: true,
        temperature: 0.1,
        max_completion_tokens: 2_048,
        stream: false,
      });
      requestBytes = Buffer.byteLength(body, "utf8");
      if (requestBytes > this.maxRequestBytes) throw clientError("request_too_large");
      const apiKey = this.getApiKey();
      if (typeof apiKey !== "string" || !apiKey || apiKey !== apiKey.trim()) {
        throw clientError("configuration");
      }
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
          if (error instanceof ActivityClassificationClientError) throw error;
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
        const raw = await readResponseBytes(response, this.maxResponseBytes, controller);
        responseBytes = raw.byteLength;
        let envelope;
        try {
          envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch {
          throw clientError("invalid_json");
        }
        usage = extractUsage(envelope);
        const candidate = extractCandidate(envelope);
        let classifications;
        try {
          classifications = validateCandidate(candidate, normalized.validationContext);
        } catch (error) {
          if (!(error instanceof ActivityClassificationClientError)) throw error;
          classifications = salvageCandidate(candidate, normalized.validationContext);
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
        return {
          classifications,
          usage,
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
        error instanceof ActivityClassificationClientError
          ? error
          : clientError("invalid_structure");
      if (requestBytes !== undefined) safeError.requestBytes = requestBytes;
      if (responseBytes !== undefined) safeError.responseBytes = responseBytes;
      if (usage !== undefined) safeError.usage = usage;
      if (requestSent) safeError.requestSent = true;
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
        issueCode: safeError.issueCode,
      });
      throw safeError;
    }
  }
}

module.exports = MiniMaxActivityClassifier;
module.exports.ActivityClassificationClientError = ActivityClassificationClientError;
module.exports.ACTIVITY_CLASSIFICATION_TOOL = ACTIVITY_CLASSIFICATION_TOOL;
module.exports.OUTPUT_CONTRACT_VERSION = OUTPUT_CONTRACT_VERSION;
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
module.exports.DEFAULT_MAX_REQUEST_BYTES = DEFAULT_MAX_REQUEST_BYTES;
module.exports.DEFAULT_MAX_RESPONSE_BYTES = DEFAULT_MAX_RESPONSE_BYTES;
