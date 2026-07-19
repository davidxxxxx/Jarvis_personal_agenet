"use strict";

const ACTIVITY_CATEGORIES = Object.freeze([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
const ACTIVITY_CATEGORY_SET = new Set(ACTIVITY_CATEGORIES);

const ADOPTED_CONFIDENCE = 0.8;
const TENTATIVE_CONFIDENCE = 0.55;
const MIXED_UNKNOWN_CONFIDENCE_CAP = 0.79;

const MEETING_APPS = new Set([
  "teams",
  "zoom",
  "google_meet",
  "webex",
  "feishu",
  "dingtalk",
  "tencent_meeting",
]);
const SOCIAL_APPS = new Set(["kook", "discord", "wechat", "qq", "telegram"]);
const GAME_APPS = new Set(["dota2", "steam", "cs2", "valorant", "league_of_legends"]);
const ENTERTAINMENT_APPS = new Set([
  "bilibili",
  "youtube",
  "netflix",
  "spotify",
  "vlc",
  "potplayer",
]);
const BROWSER_APPS = new Set(["chrome", "edge", "firefox"]);
const LEARNING_APPS = new Set(["anki", "coursera", "edx", "duolingo"]);

const MEETING_HINTS = new Set(["meeting", "work", "project", "deadline", "planning"]);
const LEARNING_HINTS = new Set([
  "learning",
  "lecture",
  "course",
  "tutorial",
  "study",
  "exam",
  "coding",
]);
const ENTERTAINMENT_HINTS = new Set([
  "entertainment",
  "sports",
  "match",
  "movie",
  "tv",
  "video",
  "music",
  "stream",
]);
const GAMING_HINTS = new Set(["gaming", "game", "gameplay", "esports"]);
const DAILY_HINTS = new Set([
  "daily",
  "shopping",
  "cooking",
  "exercise",
  "commute",
  "household",
  "personal",
]);

const ACTION_ELIGIBLE_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
]);

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function safeBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function safeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeRatio(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function normalizedApplicationKey(value) {
  const key = typeof value === "string" ? value : value?.key;
  if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(key)) {
    throw new TypeError("application key must be normalized");
  }
  return key;
}

function normalizeInput(input) {
  if (!isPlainObject(input)) throw new TypeError("activity input must be an object");
  const statistics = isPlainObject(input.statistics) ? input.statistics : input;
  const applications = input.applications ?? input.applicationKeys ?? [];
  if (!Array.isArray(applications) || applications.length > 16) {
    throw new TypeError("applications must be an array with at most 16 entries");
  }
  const applicationKeys = [...new Set(applications.map(normalizedApplicationKey))].sort();
  const sourceAttribution = input.sourceAttribution ?? "mixed_unknown";
  if (
    !["application", "microphone", "application_and_microphone", "mixed_unknown"].includes(
      sourceAttribution
    )
  ) {
    throw new TypeError("sourceAttribution is invalid");
  }
  const topicHints = input.topicHints ?? [];
  if (
    !Array.isArray(topicHints) ||
    topicHints.length > 16 ||
    topicHints.some((hint) => typeof hint !== "string" || !/^[a-z][a-z0-9_]{0,31}$/u.test(hint))
  ) {
    throw new TypeError("topicHints must contain normalized local feature keys");
  }
  const calendarBlockKind = input.calendarBlockKind ?? "none";
  if (
    !["none", "work", "meeting", "learning", "personal", "entertainment", "gaming"].includes(
      calendarBlockKind
    )
  ) {
    throw new TypeError("calendarBlockKind is invalid");
  }
  const foregroundAppKey =
    statistics.foregroundAppKey === null || statistics.foregroundAppKey === undefined
      ? null
      : normalizedApplicationKey(statistics.foregroundAppKey);
  if (foregroundAppKey !== null && !applicationKeys.includes(foregroundAppKey)) {
    throw new TypeError("foregroundAppKey must identify a supplied application");
  }
  return {
    sourceAttribution,
    applicationKeys,
    applicationSet: new Set(applicationKeys),
    topicHints: new Set(topicHints),
    calendarBlockKind,
    foregroundAppKey,
    microphoneParticipated: safeBoolean(
      statistics.microphoneParticipated ?? false,
      "microphoneParticipated"
    ),
    selfDetected: safeBoolean(statistics.selfDetected ?? false, "selfDetected"),
    speakerCount: safeInteger(statistics.speakerCount ?? 0, "speakerCount", 128),
    turnCount: safeInteger(statistics.turnCount ?? 0, "turnCount", 100_000),
    turnTakingScore: safeRatio(statistics.turnTakingScore ?? 0, "turnTakingScore"),
    durationMs: safeInteger(statistics.durationMs ?? 0, "durationMs"),
  };
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function add(scores, reasons, category, amount, reason) {
  scores[category] += amount;
  if (amount > 0 && !reasons[category].includes(reason)) reasons[category].push(reason);
}

function applyConfidenceGate(category, confidence, { sourceAttribution = "application" } = {}) {
  if (!ACTIVITY_CATEGORY_SET.has(category)) throw new TypeError("category is invalid");
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new TypeError("confidence must be finite");
  }
  let boundedConfidence = clamp01(confidence);
  if (sourceAttribution === "mixed_unknown") {
    boundedConfidence = Math.min(boundedConfidence, MIXED_UNKNOWN_CONFIDENCE_CAP);
  }
  if (category === "unknown") boundedConfidence = Math.min(boundedConfidence, 0.54);

  let decision = "unknown";
  let finalCategory = category;
  if (boundedConfidence >= ADOPTED_CONFIDENCE) {
    decision = "adopted";
  } else if (boundedConfidence >= TENTATIVE_CONFIDENCE) {
    decision = "tentative";
  } else {
    finalCategory = "unknown";
  }
  const activityPolicyEligible =
    decision === "adopted" && ACTION_ELIGIBLE_CATEGORIES.has(finalCategory);
  return {
    category: finalCategory,
    confidence: Number(boundedConfidence.toFixed(4)),
    decision,
    allowSummary: decision !== "unknown",
    allowSuggestions: activityPolicyEligible,
    allowTodos: activityPolicyEligible,
  };
}

class LocalActivityClassifier {
  classify(input) {
    const features = normalizeInput(input);
    const scores = Object.fromEntries(ACTIVITY_CATEGORIES.map((category) => [category, 0.05]));
    const reasons = Object.fromEntries(ACTIVITY_CATEGORIES.map((category) => [category, []]));
    const {
      applicationSet,
      topicHints,
      calendarBlockKind,
      foregroundAppKey,
      microphoneParticipated,
      selfDetected,
      speakerCount,
      turnCount,
      turnTakingScore,
      durationMs,
    } = features;
    const hasConversation =
      microphoneParticipated &&
      selfDetected &&
      speakerCount >= 2 &&
      (turnCount >= 4 || turnTakingScore >= 0.45);

    if (intersects(applicationSet, MEETING_APPS)) {
      add(scores, reasons, "work_meeting", 0.45, "meeting_application");
    }
    if (intersects(applicationSet, SOCIAL_APPS)) {
      add(scores, reasons, "social_call", 0.45, "social_call_application");
    }
    if (intersects(applicationSet, GAME_APPS)) {
      add(scores, reasons, "gaming", 0.65, "game_application");
    }
    if (intersects(applicationSet, ENTERTAINMENT_APPS)) {
      add(scores, reasons, "entertainment", 0.6, "entertainment_application");
    }
    if (intersects(applicationSet, LEARNING_APPS)) {
      add(scores, reasons, "learning", 0.58, "learning_application");
    }
    if (intersects(applicationSet, BROWSER_APPS)) {
      add(scores, reasons, "learning", 0.1, "browser_application");
      add(scores, reasons, "entertainment", 0.1, "browser_application");
    }

    if (hasConversation) {
      add(scores, reasons, "work_meeting", 0.32, "self_conversation");
      add(scores, reasons, "social_call", 0.32, "self_conversation");
      add(scores, reasons, "in_person_conversation", 0.42, "self_conversation");
    }
    if (microphoneParticipated && selfDetected && applicationSet.size === 0 && speakerCount >= 2) {
      add(scores, reasons, "in_person_conversation", 0.35, "physical_microphone_conversation");
    }
    if (microphoneParticipated && selfDetected) {
      add(scores, reasons, "work_meeting", 0.08, "self_present");
      add(scores, reasons, "social_call", 0.08, "self_present");
      add(scores, reasons, "in_person_conversation", 0.08, "self_present");
    }
    if (speakerCount >= 2 && turnCount >= 4) {
      add(scores, reasons, "work_meeting", 0.04, "multiple_speakers");
      add(scores, reasons, "social_call", 0.04, "multiple_speakers");
      add(scores, reasons, "in_person_conversation", 0.04, "multiple_speakers");
    }
    if (turnTakingScore >= 0.65) {
      add(scores, reasons, "work_meeting", 0.05, "strong_turn_taking");
      add(scores, reasons, "social_call", 0.05, "strong_turn_taking");
      add(scores, reasons, "in_person_conversation", 0.05, "strong_turn_taking");
    }

    if (intersects(topicHints, MEETING_HINTS)) {
      add(scores, reasons, "work_meeting", 0.35, "work_topic");
    }
    if (intersects(topicHints, LEARNING_HINTS)) {
      add(scores, reasons, "learning", 0.58, "learning_topic");
    }
    if (intersects(topicHints, ENTERTAINMENT_HINTS)) {
      add(scores, reasons, "entertainment", 0.58, "entertainment_topic");
    }
    if (intersects(topicHints, GAMING_HINTS)) {
      add(scores, reasons, "gaming", 0.58, "gaming_topic");
    }
    if (intersects(topicHints, DAILY_HINTS)) {
      add(scores, reasons, "other", 0.62, "daily_topic");
    }

    if (calendarBlockKind === "meeting" || calendarBlockKind === "work") {
      add(scores, reasons, "work_meeting", 0.18, "work_calendar_block");
    } else if (calendarBlockKind === "learning") {
      add(scores, reasons, "learning", 0.2, "learning_calendar_block");
    } else if (calendarBlockKind === "entertainment") {
      add(scores, reasons, "entertainment", 0.18, "entertainment_calendar_block");
    } else if (calendarBlockKind === "gaming") {
      add(scores, reasons, "gaming", 0.18, "gaming_calendar_block");
    } else if (calendarBlockKind === "personal") {
      add(scores, reasons, "other", 0.2, "personal_calendar_block");
    }

    if (foregroundAppKey && GAME_APPS.has(foregroundAppKey)) {
      add(scores, reasons, "gaming", 0.13, "game_in_foreground");
    } else if (foregroundAppKey && ENTERTAINMENT_APPS.has(foregroundAppKey)) {
      add(scores, reasons, "entertainment", 0.1, "entertainment_in_foreground");
    } else if (foregroundAppKey && LEARNING_APPS.has(foregroundAppKey)) {
      add(scores, reasons, "learning", 0.1, "learning_in_foreground");
    }

    if (!microphoneParticipated && !selfDetected) {
      add(scores, reasons, "entertainment", 0.06, "passive_consumption");
      add(scores, reasons, "learning", 0.03, "passive_consumption");
    }
    if (durationMs >= 60_000) {
      for (const category of ACTIVITY_CATEGORIES) {
        if (category !== "unknown") add(scores, reasons, category, 0.03, "sustained_activity");
      }
    }

    const ranked = ACTIVITY_CATEGORIES.filter((category) => category !== "unknown")
      .map((category) => ({ category, score: clamp01(scores[category]) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          ACTIVITY_CATEGORIES.indexOf(left.category) - ACTIVITY_CATEGORIES.indexOf(right.category)
      );
    const winner = ranked[0];
    const runnerUp = ranked[1];
    let confidence = winner.score;
    if (winner.score - runnerUp.score < 0.05 && winner.score < ADOPTED_CONFIDENCE) {
      confidence = Math.max(0, winner.score - 0.08);
    }
    const gate = applyConfidenceGate(winner.category, confidence, features);
    const finalReasons = [...reasons[winner.category]];
    if (features.sourceAttribution === "mixed_unknown") {
      finalReasons.push("source_attribution_unknown");
    }
    if (gate.decision === "unknown") finalReasons.push("insufficient_evidence");
    return {
      ...gate,
      source: "local",
      reasons: Object.freeze([...new Set(finalReasons)]),
    };
  }
}

module.exports = LocalActivityClassifier;
module.exports.ACTIVITY_CATEGORIES = ACTIVITY_CATEGORIES;
module.exports.ADOPTED_CONFIDENCE = ADOPTED_CONFIDENCE;
module.exports.TENTATIVE_CONFIDENCE = TENTATIVE_CONFIDENCE;
module.exports.MIXED_UNKNOWN_CONFIDENCE_CAP = MIXED_UNKNOWN_CONFIDENCE_CAP;
module.exports.applyConfidenceGate = applyConfidenceGate;
