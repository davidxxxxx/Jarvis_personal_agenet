const JARVIS_STABLE_WINDOW_MS = 12_000;
const JARVIS_OVERLAP_MS = 2_000;
const CONTEXT_CODE_POINT_LIMIT = 800;
const BLANK_MARKER = /^\[\s*(?:blank_audio|silence|inaudible)\s*\]$/iu;
const THIRD_LANGUAGE_FILLERS = new Set([
  "und",
  "der",
  "die",
  "das",
  "ein",
  "eine",
  "ist",
  "nicht",
  "bonjour",
  "merci",
  "grazie",
  "prego",
]);
const UNEXPECTED_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const INVALID_TRANSCRIPT_CHARACTER = /[\u0000\uFFFD]/u;
const SHORT_ENGLISH_HALLUCINATION =
  /^(?:thank\s+you(?:\s+(?:very\s+much|for\s+watching))?|thanks\s+for\s+watching)[\p{P}\p{S}\s]*$/iu;
const COMMON_MEDIA_HALLUCINATION =
  /^(?:优优独播剧场(?:[—\-:：\s]*YoYo Television Series Exclusive)?|字幕志愿者(?:\s+\S+){0,4}|明镜需要您的支持(?:\s+欢迎收看订阅明镜)?)[\p{P}\p{S}\s]*$/iu;
const MEDIA_PROMOTION_TERMS = [/点赞/u, /订阅/u, /转发/u, /打赏/u, /关注/u, /支持.{0,8}栏目/u];

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function takeCodePointTail(value, limit) {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join("");
}

function buildBilingualPrompt(previousText = "") {
  const context = takeCodePointTail(normalizeText(previousText), CONTEXT_CODE_POINT_LIMIT);
  const instruction =
    "这是中文和英文混合的真实对话。中文写中文，英文术语保持英文；不要翻译。完整保留原话中的口语、语气词和粗口/脏话，不美化、不消音、不替换成谐音。结合上一段上下文，不确定时写[听不清]，不要猜造人名或专有名词。";
  return context ? `${instruction}\n上一段：${context}` : instruction;
}

function normalizeOverlapToken(token) {
  return token.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function mergeOverlappingTranscript(previousText, nextText) {
  const previous = normalizeText(previousText);
  const next = normalizeText(nextText);
  if (!previous || !next) return next;

  const previousTokens = previous.split(" ");
  const nextTokens = next.split(" ");
  const maxOverlap = Math.min(previousTokens.length, nextTokens.length, 24);
  for (let size = maxOverlap; size >= 1; size -= 1) {
    const suffix = previousTokens.slice(-size).map(normalizeOverlapToken).join(" ");
    const prefix = nextTokens.slice(0, size).map(normalizeOverlapToken).join(" ");
    if (suffix && suffix === prefix) return nextTokens.slice(size).join(" ").trim();
  }
  return next;
}

function hasRepeatedThreeWordPhrase(words) {
  if (words.length < 9) return false;
  const seen = new Map();
  for (let index = 0; index <= words.length - 3; index += 1) {
    const phraseWords = words.slice(index, index + 3);
    const isSingleCharacterDisfluency =
      phraseWords.every((word) => word === phraseWords[0]) &&
      Array.from(phraseWords[0]).length === 1;
    if (isSingleCharacterDisfluency) continue;
    const phrase = phraseWords.join(" ");
    const count = (seen.get(phrase) || 0) + 1;
    if (count >= 3) return true;
    seen.set(phrase, count);
  }
  return false;
}

function isCommonHallucination(text) {
  if (SHORT_ENGLISH_HALLUCINATION.test(text)) return true;
  if (COMMON_MEDIA_HALLUCINATION.test(text)) return true;
  if (Array.from(text).length > 100) return false;
  return MEDIA_PROMOTION_TERMS.filter((pattern) => pattern.test(text)).length >= 3;
}

function classifyTranscriptQuality(value) {
  const text = normalizeText(value);
  const reasons = [];
  if (!text || BLANK_MARKER.test(text)) reasons.push("blank_marker");
  if (text && !/[\p{L}\p{N}]/u.test(text)) reasons.push("no_lexical_content");
  if (INVALID_TRANSCRIPT_CHARACTER.test(text)) reasons.push("invalid_character");
  if (isCommonHallucination(text)) reasons.push("common_hallucination");

  const words = text
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map(normalizeOverlapToken)
    .filter(Boolean);
  if (hasRepeatedThreeWordPhrase(words)) reasons.push("repeated_phrase");

  const thirdLanguageCount = words.filter((word) => THIRD_LANGUAGE_FILLERS.has(word)).length;
  const hasCjk = /\p{Script=Han}/u.test(text);
  if (UNEXPECTED_SCRIPT.test(text)) reasons.push("unexpected_script");
  if (!hasCjk && words.length >= 3 && thirdLanguageCount / words.length >= 0.6) {
    reasons.push("unexpected_language");
  }

  return { suspicious: reasons.length > 0, reasons };
}

module.exports = {
  JARVIS_OVERLAP_MS,
  JARVIS_STABLE_WINDOW_MS,
  buildBilingualPrompt,
  classifyTranscriptQuality,
  mergeOverlappingTranscript,
};
