const { validateAnalysisPayload, ANALYSIS_TOOL } = require("./JarvisAnalysisSchema");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function failure(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

class MiniMaxAnalysisClient {
  constructor({ fetchImpl = globalThis.fetch, getApiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, timeoutMs = 60_000 } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof getApiKey !== "function") throw new TypeError("getApiKey is required");
    this.fetchImpl = fetchImpl;
    this.getApiKey = getApiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async analyze({ kind, segments, previousSummary = null }) {
    if (kind !== "incremental" && kind !== "final") throw new TypeError("invalid analysis kind");
    if (!Array.isArray(segments) || segments.length === 0) throw new TypeError("segments are required");
    const apiKey = this.getApiKey();
    if (typeof apiKey !== "string" || !apiKey) throw failure("MINIMAX_KEY_MISSING", "MiniMax key is not configured");
    const allowedIds = new Set();
    const transcript = segments.map((segment) => {
      if (typeof segment.id !== "string" || !segment.id) throw new TypeError("segment id is required");
      allowedIds.add(segment.id);
      return {
        id: segment.id,
        startedAt: segment.startedAt ?? null,
        endedAt: segment.endedAt ?? null,
        speaker: segment.speakerRef || "unknown",
        text: segment.text,
      };
    });
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
          messages: [
            {
              role: "system",
              content: "Analyze only the supplied transcript. Do not invent facts. Every topic, memory, and todo must cite supplied segment ids. Keep Chinese and English terms in their original language. Call the required tool exactly once.",
            },
            {
              role: "user",
              content: JSON.stringify({ kind, previousSummary, segments: transcript }),
            },
          ],
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: "function", function: { name: "submit_jarvis_analysis" } },
          temperature: 0.1,
          max_completion_tokens: 4096,
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw failure("MINIMAX_TIMEOUT", "MiniMax request timed out", true);
      throw failure("MINIMAX_NETWORK", "MiniMax network request failed", true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw failure("MINIMAX_AUTH", "MiniMax authentication failed");
      if (response.status === 429) throw failure("MINIMAX_RATE_LIMITED", "MiniMax quota is temporarily limited", true);
      if (response.status >= 500) throw failure("MINIMAX_UNAVAILABLE", "MiniMax service is temporarily unavailable", true);
      throw failure("MINIMAX_REQUEST_FAILED", `MiniMax request failed (${response.status})`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failure("MINIMAX_RESPONSE_TOO_LARGE", "MiniMax response is too large");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw failure("MINIMAX_INVALID_RESPONSE", "MiniMax returned invalid JSON");
    }
    const toolCall = body?.choices?.[0]?.message?.tool_calls?.find((call) => call?.function?.name === "submit_jarvis_analysis");
    if (!toolCall) throw failure("MINIMAX_TOOL_MISSING", "MiniMax did not return structured analysis");
    let parsed;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      throw failure("MINIMAX_INVALID_ANALYSIS", "MiniMax analysis arguments are invalid");
    }
    return {
      result: validateAnalysisPayload(parsed, allowedIds),
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? 0,
      },
      model: body?.model || this.model,
    };
  }
}

module.exports = MiniMaxAnalysisClient;
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
