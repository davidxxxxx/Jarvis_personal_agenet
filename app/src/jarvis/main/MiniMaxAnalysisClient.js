const { validateAnalysisPayload, ANALYSIS_TOOL } = require("./JarvisAnalysisSchema");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COLLECTION_FIELDS = ["topics", "memories", "todos", "decisions", "suggestions"];

function failure(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function normalizeCollection(value, field) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (value && typeof value === "object") {
    for (const key of [field, "items", "results"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    if (Object.keys(value).length === 0) return [];
    return [value];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^(?:none|null|n\/a)$/i.test(trimmed)) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== value) return normalizeCollection(parsed, field);
    } catch {
      // A plain decision string is a valid single decision. Structured collections
      // remain unchanged so the strict validator can reject ungrounded prose.
    }
    if (field === "decisions") return [trimmed];
  }
  return value;
}

function normalizeToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...value };
  for (const field of COLLECTION_FIELDS) {
    normalized[field] = normalizeCollection(value[field], field);
  }
  return normalized;
}

class MiniMaxAnalysisClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getApiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    timeoutMs = 60_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof getApiKey !== "function") throw new TypeError("getApiKey is required");
    this.fetchImpl = fetchImpl;
    this.getApiKey = getApiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async _requestTool({ apiKey, messages }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: "function", function: { name: "submit_jarvis_analysis" } },
          temperature: 0.1,
          max_completion_tokens: 2048,
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError")
        throw failure("MINIMAX_TIMEOUT", "MiniMax request timed out", true);
      throw failure("MINIMAX_NETWORK", "MiniMax network request failed", true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw failure("MINIMAX_AUTH", "MiniMax authentication failed");
      if (response.status === 429)
        throw failure("MINIMAX_RATE_LIMITED", "MiniMax quota is temporarily limited", true);
      if (response.status >= 500)
        throw failure("MINIMAX_UNAVAILABLE", "MiniMax service is temporarily unavailable", true);
      throw failure("MINIMAX_REQUEST_FAILED", `MiniMax request failed (${response.status})`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw failure("MINIMAX_RESPONSE_TOO_LARGE", "MiniMax response is too large");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw failure("MINIMAX_INVALID_RESPONSE", "MiniMax returned invalid JSON");
    }
    const toolCall = body?.choices?.[0]?.message?.tool_calls?.find(
      (call) => call?.function?.name === "submit_jarvis_analysis"
    );
    if (!toolCall)
      throw failure("MINIMAX_TOOL_MISSING", "MiniMax did not return structured analysis");
    let parsed;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      throw failure("MINIMAX_INVALID_ANALYSIS", "MiniMax analysis arguments are invalid", true);
    }
    return {
      parsed,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? 0,
      },
      model: body?.model || this.model,
    };
  }

  async analyze({ kind, segments, previousSummary = null }) {
    if (kind !== "incremental" && kind !== "final") throw new TypeError("invalid analysis kind");
    if (!Array.isArray(segments) || segments.length === 0)
      throw new TypeError("segments are required");
    const apiKey = this.getApiKey();
    if (typeof apiKey !== "string" || !apiKey)
      throw failure("MINIMAX_KEY_MISSING", "MiniMax key is not configured");
    const allowedIds = new Set();
    const transcript = segments.map((segment) => {
      if (typeof segment.id !== "string" || !segment.id)
        throw new TypeError("segment id is required");
      allowedIds.add(segment.id);
      return {
        id: segment.id,
        startedAt: segment.startedAt ?? null,
        endedAt: segment.endedAt ?? null,
        speaker: segment.speakerRef || "unknown",
        text: segment.text,
      };
    });
    const requestInput = { kind, previousSummary, segments: transcript };
    const first = await this._requestTool({
      apiKey,
      messages: [
        {
          role: "system",
          content:
            "Analyze only the supplied transcript. Do not invent facts. Every topic, memory, and todo must cite supplied segment ids. Keep Chinese and English terms in their original language. Call the required tool exactly once. The topics, memories, todos, decisions, and suggestions fields MUST be JSON arrays; use [] when a collection has no items and never wrap arrays in an object.",
        },
        { role: "user", content: JSON.stringify(requestInput) },
      ],
    });
    let result;
    try {
      result = validateAnalysisPayload(normalizeToolArguments(first.parsed), allowedIds);
    } catch {
      const repaired = await this._requestTool({
        apiKey,
        messages: [
          {
            role: "system",
            content:
              "Repair the supplied analysis so it exactly matches the submit_jarvis_analysis tool schema. Re-check the transcript for grounding. All collection fields MUST be JSON arrays. Use only supplied segment ids as evidence, use null for unknown optional values, omit no required fields, and call the tool exactly once.",
          },
          {
            role: "user",
            content: JSON.stringify({ ...requestInput, invalidAnalysis: first.parsed }),
          },
        ],
      });
      try {
        result = validateAnalysisPayload(normalizeToolArguments(repaired.parsed), allowedIds);
      } catch {
        throw failure(
          "MINIMAX_INVALID_ANALYSIS",
          "MiniMax returned analysis with an invalid structure",
          true
        );
      }
      return {
        result,
        usage: {
          inputTokens: first.usage.inputTokens + repaired.usage.inputTokens,
          outputTokens: first.usage.outputTokens + repaired.usage.outputTokens,
        },
        model: repaired.model,
      };
    }
    return {
      result,
      usage: first.usage,
      model: first.model,
    };
  }
}

module.exports = MiniMaxAnalysisClient;
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
