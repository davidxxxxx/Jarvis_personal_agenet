const crypto = require("node:crypto");
const {
  ANALYSIS_TOOL,
  AnalysisSchemaError,
  validateCandidateAnalysis,
} = require("./JarvisAnalysisSchema");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
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
  "estimatedCostMicrousd",
  "errorCode",
  "validatorIssueCode",
]);

class AnalysisClientError extends Error {
  constructor(code, { retryable = false, issueCode } = {}) {
    super("MiniMax analysis request failed");
    this.name = "AnalysisClientError";
    this.code = code;
    this.retryable = retryable === true;
    if (issueCode !== undefined) this.issueCode = issueCode;
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

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw clientError("invalid_structure");
  }
  if (
    typeof input.cloudPayloadJson !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.inputHash) ||
    !Array.isArray(input.allowedSegmentIds) ||
    !Array.isArray(input.allowedOwnerLabels)
  ) {
    throw clientError("invalid_structure");
  }
  let cloudPayload;
  try {
    cloudPayload = JSON.parse(input.cloudPayloadJson);
  } catch {
    throw clientError("invalid_json");
  }
  if (
    !exactKeys(cloudPayload, ["inputVersion", "segments", "omittedRanges"]) ||
    cloudPayload.inputVersion !== "jarvis-analysis-input-v2" ||
    !Array.isArray(cloudPayload.segments) ||
    cloudPayload.segments.length === 0 ||
    !Array.isArray(cloudPayload.omittedRanges)
  ) {
    throw clientError("invalid_structure");
  }
  const allowedSegmentIds = new Set(input.allowedSegmentIds);
  const allowedOwnerLabels = new Set(input.allowedOwnerLabels);
  if (
    allowedSegmentIds.size !== input.allowedSegmentIds.length ||
    allowedOwnerLabels.size !== input.allowedOwnerLabels.length
  ) {
    throw clientError("invalid_structure");
  }
  for (const segment of cloudPayload.segments) {
    if (
      !exactKeys(segment, ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"]) ||
      !allowedSegmentIds.has(segment.segmentId) ||
      !allowedOwnerLabels.has(segment.speakerLabel) ||
      typeof segment.text !== "string" ||
      !segment.text
    ) {
      throw clientError("invalid_structure");
    }
  }
  if (cloudPayload.segments.length !== allowedSegmentIds.size) {
    throw clientError("invalid_structure");
  }
  return {
    cloudPayloadJson: input.cloudPayloadJson,
    inputHash: input.inputHash,
    allowedSegmentIds,
    allowedOwnerLabels,
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw clientError("invalid_structure");
  }
  return parsed;
}

function extractCandidate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.choices)) {
    throw clientError("invalid_structure");
  }
  if (body.choices.length !== 1) throw clientError("invalid_structure");
  const message = body.choices[0]?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw clientError("invalid_structure");
  }
  if (Object.prototype.hasOwnProperty.call(message, "function_call")) {
    throw clientError("invalid_structure");
  }
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length > 0)) {
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw clientError("invalid_structure");
    }
    if (typeof message.content === "string" && message.content.trim() !== "") {
      throw clientError("invalid_structure");
    }
    if (message.content !== undefined && message.content !== null && message.content !== "") {
      throw clientError("invalid_structure");
    }
    const call = toolCalls[0];
    if (
      call?.function?.name !== "submit_jarvis_analysis" ||
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
    timeoutMs = 60_000,
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
              "Analyze only the supplied pseudonymous transcript text. Return exactly one jarvis-analysis-v2 object through submit_jarvis_analysis. Every factual item must cite only supplied segment IDs. Never invent IDs, state, dates, or calendar actions.",
          },
          { role: "user", content: normalized.cloudPayloadJson },
        ],
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "function", function: { name: "submit_jarvis_analysis" } },
        temperature: 0.1,
        max_completion_tokens: 2048,
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
        const parsed = extractCandidate(envelopeBody);
        let result;
        try {
          result = validateCandidateAnalysis(parsed, {
            allowedSegmentIds: normalized.allowedSegmentIds,
            allowedOwnerLabels: normalized.allowedOwnerLabels,
          });
        } catch (error) {
          if (error instanceof AnalysisSchemaError) {
            throw clientError("invalid_structure", false, error.issueCode);
          }
          throw error;
        }
        const usage = {
          inputTokens: safeTokenCount(
            envelopeBody?.usage?.prompt_tokens ?? envelopeBody?.usage?.input_tokens
          ),
          outputTokens: safeTokenCount(
            envelopeBody?.usage?.completion_tokens ?? envelopeBody?.usage?.output_tokens
          ),
        };
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
          result,
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
        error instanceof AnalysisClientError ? error : clientError("invalid_structure", false);
      this._log({
        requestId,
        inputHash,
        requestBytes,
        responseBytes,
        durationMs: Math.max(0, this.now() - startedAt),
        model: this.model,
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
