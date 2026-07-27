const assert = require("node:assert/strict");
const test = require("node:test");

const {
  JARVIS_OVERLAP_MS,
  JARVIS_STABLE_WINDOW_MS,
  buildBilingualPrompt,
  classifyTranscriptQuality,
  mergeOverlappingTranscript,
} = require("../../src/jarvis/main/transcriptionQuality");

test("builds a bounded Chinese-English context prompt without asking for translation", () => {
  const prompt = buildBilingualPrompt(`较早内容${"长".repeat(900)}我们讨论 API latency`);

  assert.match(prompt, /中文和英文混合/);
  assert.match(prompt, /不要翻译/);
  assert.match(prompt, /完整保留原话/);
  assert.match(prompt, /粗口\/脏话/);
  assert.match(prompt, /不美化/);
  assert.match(prompt, /不替换成谐音/);
  assert.match(prompt, /\[听不清\]/);
  assert.match(prompt, /API latency/);
  assert.ok(Array.from(prompt).length <= 1_100);
});

test("removes the longest word overlap from the next stable transcript", () => {
  assert.equal(
    mergeOverlappingTranscript("我们讨论 API latency", "API latency and budget"),
    "and budget"
  );
  assert.equal(mergeOverlappingTranscript("今天开会", "明天继续"), "明天继续");
});

test("flags isolated third-language filler while allowing natural Chinese-English code switching", () => {
  assert.deepEqual(classifyTranscriptQuality("und der die das"), {
    suspicious: true,
    reasons: ["unexpected_language"],
  });
  assert.deepEqual(classifyTranscriptQuality("我们 review 一下 API budget"), {
    suspicious: false,
    reasons: [],
  });
});

test("flags unexpected writing systems inside otherwise Chinese-English output", () => {
  assert.deepEqual(classifyTranscriptQuality("我们 review 一下 этот API budget"), {
    suspicious: true,
    reasons: ["unexpected_script"],
  });
  assert.deepEqual(classifyTranscriptQuality("我们 review カタカナ API budget"), {
    suspicious: true,
    reasons: ["unexpected_script"],
  });
  assert.deepEqual(classifyTranscriptQuality("我们 review 한글 API budget"), {
    suspicious: true,
    reasons: ["unexpected_script"],
  });
  assert.deepEqual(classifyTranscriptQuality("这是中文 mixed with English terms"), {
    suspicious: false,
    reasons: [],
  });
});

test("flags blank markers, punctuation-only output, and repeated three-word hallucinations", () => {
  assert.equal(classifyTranscriptQuality("[BLANK_AUDIO]").suspicious, true);
  assert.equal(classifyTranscriptQuality("……！！！").suspicious, true);
  assert.equal(
    classifyTranscriptQuality("thank you for thank you for thank you for watching").suspicious,
    true
  );
});

test("exports the approved Jarvis stable and overlap windows", () => {
  assert.equal(JARVIS_STABLE_WINDOW_MS, 12_000);
  assert.equal(JARVIS_OVERLAP_MS, 2_000);
});
