const assert = require("node:assert/strict");
const test = require("node:test");

const OpenAiCorrectionService = require("../../src/jarvis/main/OpenAiCorrectionService");

function createHarness({ responseStatus = 200, responseBody, apiKey = "test-project-key" } = {}) {
  const calls = { reserve: [], settle: [], release: [], fetch: [], log: [] };
  const budgetGuard = {
    async reserve(input) {
      calls.reserve.push(input);
      return { ok: true, reservationId: "cloud_1" };
    },
    async settle(id, usage) {
      calls.settle.push({ id, usage });
      return { ok: true, actualMicrousd: 480 };
    },
    async release(id) {
      calls.release.push(id);
      return { ok: true };
    },
  };
  const fetchImpl = async (url, options) => {
    calls.fetch.push({ url, options });
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      async json() {
        return (
          responseBody ?? {
            text: "我们 review 一下 API budget",
            usage: {
              type: "tokens",
              input_tokens: 120,
              output_tokens: 18,
              total_tokens: 138,
            },
            logprobs: [],
          }
        );
      },
    };
  };
  const service = new OpenAiCorrectionService({
    budgetGuard,
    getApiKey: () => apiKey,
    fetchImpl,
    log: (entry) => calls.log.push(entry),
  });
  return { service, calls };
}

test("skips a normal bilingual local transcript without reserving or uploading", async () => {
  const { service, calls } = createHarness();

  const result = await service.maybeCorrect({
    audioWav: Buffer.from("wav"),
    audioMs: 12_000,
    localText: "我们 review 一下 API budget",
    contextText: "",
  });

  assert.deepEqual(result, { status: "not_needed" });
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("uploads one suspicious WAV with bilingual prompt and settles returned token usage", async () => {
  const { service, calls } = createHarness();

  const result = await service.maybeCorrect({
    audioWav: Buffer.from("RIFF-private-audio"),
    audioMs: 12_000,
    localText: "und der die das",
    contextText: "我们讨论 API budget",
  });

  assert.equal(result.status, "corrected");
  assert.equal(result.text, "我们 review 一下 API budget");
  assert.deepEqual(calls.reserve, [{ audioMs: 12_000 }]);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls.fetch[0].options.headers.Authorization, "Bearer test-project-key");
  const body = calls.fetch[0].options.body.toString("utf8");
  assert.match(body, /name="model"[\s\S]*gpt-4o-transcribe/);
  assert.match(body, /name="include\[\]"[\s\S]*logprobs/);
  assert.match(body, /中文和英文混合/);
  assert.match(body, /RIFF-private-audio/);
  assert.equal(calls.settle.length, 1);
  assert.equal(calls.release.length, 0);
});

test("does not reserve or upload when no OpenAI project key is configured", async () => {
  const { service, calls } = createHarness({ apiKey: "" });

  const result = await service.maybeCorrect({
    audioWav: Buffer.from("wav"),
    audioMs: 1_000,
    localText: "und der die das",
    contextText: "",
  });

  assert.deepEqual(result, { status: "no_key" });
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("releases the reservation and keeps the local draft after an HTTP failure", async () => {
  const { service, calls } = createHarness({ responseStatus: 429, responseBody: { error: "rate" } });

  const result = await service.maybeCorrect({
    audioWav: Buffer.from("wav"),
    audioMs: 1_000,
    localText: "und der die das",
    contextText: "",
  });

  assert.deepEqual(result, { status: "local_fallback", reason: "http_429" });
  assert.deepEqual(calls.release, ["cloud_1"]);
  assert.equal(calls.settle.length, 0);
});

test("never logs the API key, audio bytes, or transcript body", async () => {
  const { service, calls } = createHarness();

  await service.maybeCorrect({
    audioWav: Buffer.from("SECRET_AUDIO_BYTES"),
    audioMs: 1_000,
    localText: "und der die das SECRET_TRANSCRIPT",
    contextText: "",
  });

  const serialized = JSON.stringify(calls.log);
  assert.doesNotMatch(serialized, /test-project-key|SECRET_AUDIO_BYTES|SECRET_TRANSCRIPT/);
});
