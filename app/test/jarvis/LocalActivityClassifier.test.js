"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const LocalActivityClassifier = require("../../src/jarvis/main/LocalActivityClassifier");
const {
  ACTIVITY_CATEGORIES,
  applyConfidenceGate,
} = require("../../src/jarvis/main/LocalActivityClassifier");

const classifier = new LocalActivityClassifier();

function activity({
  applications = [],
  sourceAttribution = applications.length ? "application" : "microphone",
  microphoneParticipated = false,
  selfDetected = false,
  speakerCount = selfDetected ? 1 : 0,
  turnCount = 0,
  turnTakingScore = 0,
  durationMs = 120_000,
  foregroundAppKey = applications[0] ?? null,
  topicHints = [],
  calendarBlockKind = "none",
} = {}) {
  return {
    applications,
    sourceAttribution,
    topicHints,
    calendarBlockKind,
    statistics: {
      microphoneParticipated,
      selfDetected,
      speakerCount,
      turnCount,
      turnTakingScore,
      durationMs,
      foregroundAppKey,
    },
  };
}

test("exports the approved stable eight-category set", () => {
  assert.deepEqual(ACTIVITY_CATEGORIES, [
    "work_meeting",
    "learning",
    "social_call",
    "in_person_conversation",
    "entertainment",
    "gaming",
    "other",
    "unknown",
  ]);
});

test("conservatively identifies a work meeting from application and participation evidence", () => {
  const result = classifier.classify(
    activity({
      applications: ["teams"],
      sourceAttribution: "application_and_microphone",
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 3,
      turnCount: 12,
      turnTakingScore: 0.8,
      foregroundAppKey: "teams",
    })
  );

  assert.equal(result.category, "work_meeting");
  assert.equal(result.decision, "adopted");
  assert.equal(result.allowSuggestions, true);
  assert.equal(result.allowTodos, true);
  assert.ok(result.reasons.includes("meeting_application"));
});

test("identifies learning only when browser evidence is strengthened by safe topic evidence", () => {
  const result = classifier.classify(
    activity({
      applications: ["chrome"],
      sourceAttribution: "application",
      speakerCount: 1,
      topicHints: ["course"],
      calendarBlockKind: "learning",
    })
  );

  assert.equal(result.category, "learning");
  assert.equal(result.decision, "adopted");
  assert.ok(result.reasons.includes("learning_topic"));
});

test("identifies social calls from a calling application and active SELF participation", () => {
  const result = classifier.classify(
    activity({
      applications: ["kook"],
      sourceAttribution: "application_and_microphone",
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 2,
      turnCount: 10,
      turnTakingScore: 0.76,
      foregroundAppKey: "kook",
    })
  );

  assert.equal(result.category, "social_call");
  assert.equal(result.decision, "adopted");
});

test("identifies an in-person conversation from physical microphone participation", () => {
  const result = classifier.classify(
    activity({
      applications: [],
      sourceAttribution: "microphone",
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 2,
      turnCount: 8,
      turnTakingScore: 0.72,
      foregroundAppKey: null,
    })
  );

  assert.equal(result.category, "in_person_conversation");
  assert.equal(result.decision, "adopted");
  assert.ok(result.reasons.includes("physical_microphone_conversation"));
});

test("separates passive entertainment in Chrome from meetings and advice-producing scenes", () => {
  const result = classifier.classify(
    activity({
      applications: ["chrome"],
      sourceAttribution: "application",
      speakerCount: 1,
      topicHints: ["sports"],
      foregroundAppKey: "chrome",
    })
  );

  assert.equal(result.category, "entertainment");
  assert.equal(result.decision, "adopted");
  assert.equal(result.allowSuggestions, false);
  assert.equal(result.allowTodos, false);
});

test("identifies a foreground game without treating its speech as a social task source", () => {
  const result = classifier.classify(
    activity({
      applications: ["dota2"],
      sourceAttribution: "application",
      speakerCount: 1,
      foregroundAppKey: "dota2",
    })
  );

  assert.equal(result.category, "gaming");
  assert.equal(result.decision, "adopted");
  assert.equal(result.allowSuggestions, false);
  assert.equal(result.allowTodos, false);
});

test("uses other for well-supported everyday activity and unknown for weak evidence", () => {
  const daily = classifier.classify(
    activity({
      applications: [],
      sourceAttribution: "microphone",
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 1,
      foregroundAppKey: null,
      topicHints: ["cooking"],
      calendarBlockKind: "personal",
    })
  );
  const weak = classifier.classify(
    activity({
      applications: ["chrome"],
      sourceAttribution: "application",
      durationMs: 30_000,
      speakerCount: 1,
      foregroundAppKey: "chrome",
    })
  );

  assert.equal(daily.category, "other");
  assert.equal(daily.decision, "adopted");
  assert.equal(weak.category, "unknown");
  assert.equal(weak.decision, "unknown");
  assert.equal(weak.allowSummary, false);
});

test("enforces the 80/55 confidence gates and blocks actions in the tentative band", () => {
  assert.deepEqual(applyConfidenceGate("learning", 0.8), {
    category: "learning",
    confidence: 0.8,
    decision: "adopted",
    allowSummary: true,
    allowSuggestions: false,
    allowTodos: false,
  });
  assert.deepEqual(applyConfidenceGate("work_meeting", 0.8, { selfParticipated: true }), {
    category: "work_meeting",
    confidence: 0.8,
    decision: "adopted",
    allowSummary: true,
    allowSuggestions: true,
    allowTodos: true,
  });
  assert.deepEqual(applyConfidenceGate("learning", 0.55), {
    category: "learning",
    confidence: 0.55,
    decision: "tentative",
    allowSummary: true,
    allowSuggestions: false,
    allowTodos: false,
  });
  assert.equal(applyConfidenceGate("learning", 0.5499).decision, "unknown");
});

test("caps mixed unknown sources below automatic adoption even with strong semantics", () => {
  const result = applyConfidenceGate("work_meeting", 0.99, {
    sourceAttribution: "mixed_unknown",
  });

  assert.equal(result.confidence, 0.79);
  assert.equal(result.decision, "tentative");
  assert.equal(result.allowSuggestions, false);
  assert.equal(result.allowTodos, false);
});
