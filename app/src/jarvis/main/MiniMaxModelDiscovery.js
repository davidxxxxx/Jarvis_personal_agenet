"use strict";

const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OFFICIAL_HOSTS = new Set(["api.minimaxi.com", "api.minimax.io"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function officialModelsEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("MiniMax models endpoint is invalid");
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
    throw new TypeError("MiniMax models endpoint is invalid");
  }
  return `${parsed.origin}/v1/models`;
}

function safeModelId(value, name = "model") {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function credentialRevision(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function unavailable({ configuredModel, checkedAt, status = "unavailable" }) {
  return Object.freeze({
    status,
    configuredModel,
    resolvedModel: DEFAULT_MODEL,
    fallbackUsed: configuredModel !== DEFAULT_MODEL,
    checkedAt,
  });
}

class MiniMaxModelDiscovery {
  constructor({
    fetchImpl = globalThis.fetch,
    getApiKey,
    configuredModel = DEFAULT_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheMs = DEFAULT_CACHE_MS,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof getApiKey !== "function") throw new TypeError("getApiKey must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError("timeoutMs is invalid");
    }
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 60 * 60_000) {
      throw new TypeError("cacheMs is invalid");
    }
    this.fetchImpl = fetchImpl;
    this.getApiKey = getApiKey;
    this.configuredModel = safeModelId(configuredModel, "configuredModel");
    this.endpoint = officialModelsEndpoint(baseUrl);
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cached = null;
  }

  async discover({ force = false } = {}) {
    const apiKey = this.getApiKey();
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      this.cached = null;
      return Object.freeze({
        status: "not_configured",
        configuredModel: this.configuredModel,
        resolvedModel: DEFAULT_MODEL,
        fallbackUsed: false,
        checkedAt: null,
      });
    }
    const key = apiKey.trim();
    const revision = credentialRevision(key);
    const currentTime = this.now();
    if (
      !force &&
      this.cached?.credentialRevision === revision &&
      currentTime - this.cached.cachedAt < this.cacheMs
    ) {
      return this.cached.result;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let result;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!response?.ok) {
        result = unavailable({ configuredModel: this.configuredModel, checkedAt: currentTime });
      } else {
        const declaredLength = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          throw new RangeError("MiniMax models response is too large");
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_RESPONSE_BYTES) {
          throw new RangeError("MiniMax models response is too large");
        }
        const parsed = JSON.parse(body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
          throw new TypeError("MiniMax models response is invalid");
        }
        const available = new Set(
          parsed.data
            .map((entry) => entry?.id)
            .filter((id) => typeof id === "string" && MODEL_ID_PATTERN.test(id))
            .slice(0, 512)
        );
        if (available.has(this.configuredModel)) {
          result = Object.freeze({
            status: "ready",
            configuredModel: this.configuredModel,
            resolvedModel: this.configuredModel,
            fallbackUsed: false,
            checkedAt: currentTime,
          });
        } else if (available.has(DEFAULT_MODEL)) {
          result = Object.freeze({
            status: "ready",
            configuredModel: this.configuredModel,
            resolvedModel: DEFAULT_MODEL,
            fallbackUsed: this.configuredModel !== DEFAULT_MODEL,
            checkedAt: currentTime,
          });
        } else {
          result = unavailable({
            configuredModel: this.configuredModel,
            checkedAt: currentTime,
            status: "model_unavailable",
          });
        }
      }
    } catch {
      result = unavailable({ configuredModel: this.configuredModel, checkedAt: currentTime });
    } finally {
      clearTimeout(timer);
    }
    this.cached = { credentialRevision: revision, cachedAt: currentTime, result };
    return result;
  }
}

MiniMaxModelDiscovery.DEFAULT_MODEL = DEFAULT_MODEL;
MiniMaxModelDiscovery.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
MiniMaxModelDiscovery.officialModelsEndpoint = officialModelsEndpoint;

module.exports = MiniMaxModelDiscovery;
