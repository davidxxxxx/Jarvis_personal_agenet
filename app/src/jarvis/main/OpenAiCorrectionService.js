const { randomUUID } = require("node:crypto");
const { buildBilingualPrompt, classifyTranscriptQuality } = require("./transcriptionQuality");

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "gpt-4o-transcribe";
const REQUEST_TIMEOUT_MS = 30_000;

function multipart(audioWav, prompt) {
  const boundary = `----Jarvis${randomUUID().replaceAll("-", "")}`;
  const chunks = [];
  const addField = (name, value) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  };
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="jarvis.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ),
    audioWav,
    Buffer.from("\r\n")
  );
  addField("model", MODEL);
  addField("response_format", "json");
  addField("include[]", "logprobs");
  addField("prompt", prompt);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

class OpenAiCorrectionService {
  constructor({ budgetGuard, getApiKey, fetchImpl, log = () => {} }) {
    for (const method of ["reserve", "settle", "release"]) {
      if (!budgetGuard || typeof budgetGuard[method] !== "function") {
        throw new TypeError(`budgetGuard.${method} must be a function`);
      }
    }
    if (typeof getApiKey !== "function" || typeof fetchImpl !== "function") {
      throw new TypeError("OpenAI key provider and fetch implementation are required");
    }
    if (typeof log !== "function") throw new TypeError("log must be a function");
    this.budgetGuard = budgetGuard;
    this.getApiKey = getApiKey;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  async maybeCorrect({ audioWav, audioMs, localText, contextText = "" }) {
    const quality = classifyTranscriptQuality(localText);
    if (!quality.suspicious) return { status: "not_needed" };
    if (!Buffer.isBuffer(audioWav) || audioWav.length === 0) {
      return { status: "local_fallback", reason: "invalid_audio" };
    }
    if (!Number.isSafeInteger(audioMs) || audioMs < 0) {
      return { status: "local_fallback", reason: "invalid_audio_duration" };
    }

    const apiKey = this.getApiKey();
    if (typeof apiKey !== "string" || !apiKey.trim()) return { status: "no_key" };

    const reservation = await this.budgetGuard.reserve({ audioMs });
    if (!reservation.ok) return { status: reservation.reason };

    const { body, boundary } = multipart(audioWav, buildBilingualPrompt(contextText));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(OPENAI_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
        signal: controller.signal,
        useSessionCookies: false,
      });
    } catch (error) {
      await this.budgetGuard.release(reservation.reservationId);
      const reason = error?.name === "AbortError" ? "timeout" : "network";
      this.log({ status: "local_fallback", reason, audioMs });
      return { status: "local_fallback", reason };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      await this.budgetGuard.release(reservation.reservationId);
      const reason = `http_${response.status}`;
      this.log({ status: "local_fallback", reason, audioMs, httpStatus: response.status });
      return { status: "local_fallback", reason };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      await this.budgetGuard.release(reservation.reservationId);
      this.log({ status: "local_fallback", reason: "invalid_json", audioMs });
      return { status: "local_fallback", reason: "invalid_json" };
    }

    const settlement = await this.budgetGuard.settle(reservation.reservationId, data?.usage);
    if (!settlement.ok) {
      this.log({ status: "local_fallback", reason: settlement.reason, audioMs });
      return { status: "local_fallback", reason: settlement.reason };
    }

    const correctedText = typeof data?.text === "string" ? data.text.replace(/\s+/gu, " ").trim() : "";
    if (!correctedText) {
      this.log({ status: "local_fallback", reason: "empty_response", audioMs });
      return { status: "local_fallback", reason: "empty_response" };
    }
    const normalizedLocal = String(localText).replace(/\s+/gu, " ").trim();
    const status = correctedText === normalizedLocal ? "confirmed" : "corrected";
    this.log({ status, audioMs, actualMicrousd: settlement.actualMicrousd });
    return { status, text: correctedText, confidence: 0.9 };
  }
}

module.exports = OpenAiCorrectionService;
