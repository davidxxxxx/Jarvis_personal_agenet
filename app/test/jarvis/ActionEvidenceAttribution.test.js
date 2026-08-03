"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildActionEvidenceAttribution,
  buildCapturedTodoActionEvidenceAttribution,
} = require("../../src/jarvis/main/ActionEvidenceAttribution");

test("action evidence exposes normalized application, anonymous speaker relation and confidence gates", () => {
  const result = buildActionEvidenceAttribution({
    sourceType: "system",
    applicationKey: "kook",
    attributionState: "exact",
    personId: "person-private-id",
    speakerLabel: "P2",
    transcriptConfidence: 0.91,
    voiceConfidence: 0.94,
    semanticConfidence: 0.96,
    startedAt: 1_000,
    endedAt: 3_000,
    classifications: [
      {
        id: "classification-social",
        started_at: 500,
        ended_at: 5_000,
        category: "social_call",
        confidence: 0.93,
        decision: "adopted",
        source: "minimax",
        source_attribution: "application",
        reason: "calling application with active conversation",
      },
    ],
  });

  assert.deepEqual(result, {
    basis: "current_local_state",
    applicationKey: "kook",
    applicationName: "KOOK",
    sourceAttribution: "application",
    speakerRelation: "P2",
    semanticConfidence: 0.96,
    voiceConfidence: 0.94,
    transcriptConfidence: 0.91,
    activityClassification: {
      id: "classification-social",
      category: "social_call",
      confidence: 0.93,
      decision: "adopted",
      source: "minimax",
      reason: "calling application with active conversation",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /person-private-id/u);
});

test("unknown system sources fail closed and never expose raw executable or speaker labels", () => {
  const result = buildActionEvidenceAttribution({
    sourceType: "system",
    applicationKey: "C:\\Games\\unknown.exe",
    attributionState: "mixed_unknown",
    personId: null,
    speakerLabel: "张三",
    transcriptConfidence: 2,
    voiceConfidence: -1,
    semanticConfidence: Number.NaN,
    startedAt: 10_000,
    endedAt: 12_000,
  });

  assert.deepEqual(result, {
    basis: "current_local_state",
    applicationKey: null,
    applicationName: "System audio · application unknown",
    sourceAttribution: "mixed_unknown",
    speakerRelation: "UNKNOWN",
    semanticConfidence: null,
    voiceConfidence: null,
    transcriptConfidence: null,
    activityClassification: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /unknown\.exe|张三/u);
});

test("microphone SELF evidence cannot be relabeled by an overlapping application-only scene", () => {
  const result = buildActionEvidenceAttribution({
    sourceType: "mic",
    applicationKey: "chrome",
    attributionState: "exact",
    personIsSelf: 1,
    speakerLabel: "speaker_private_name",
    startedAt: 20_000,
    endedAt: 22_000,
    classifications: [
      {
        id: "classification-media",
        started_at: 19_000,
        ended_at: 25_000,
        category: "entertainment",
        confidence: 0.95,
        decision: "adopted",
        source: "minimax",
        source_attribution: "application",
      },
    ],
  });

  assert.equal(result.applicationName, "Microphone");
  assert.equal(result.applicationKey, null);
  assert.equal(result.sourceAttribution, "microphone");
  assert.equal(result.speakerRelation, "SELF");
  assert.equal(result.activityClassification, null);
});

test("todo evidence is projected from its immutable creation snapshot", () => {
  const result = buildCapturedTodoActionEvidenceAttribution({
    transcriptSegmentId: "segment-1",
    applicationEvidence: [
      {
        segmentId: "segment-1",
        applicationKey: "kook",
        sourceAttribution: "application_and_microphone",
        speakerRelation: "SELF",
      },
    ],
    activityEvidence: [
      {
        segmentId: "segment-1",
        category: "social_call",
        confidence: 0.95,
        decision: "adopted",
      },
    ],
    semanticConfidence: 0.96,
    voiceprintConfidence: 0.97,
    transcriptContextConfidence: 0.91,
  });

  assert.deepEqual(result, {
    basis: "captured_todo_snapshot",
    applicationKey: "kook",
    applicationName: "KOOK",
    sourceAttribution: "application_and_microphone",
    speakerRelation: "SELF",
    semanticConfidence: 0.96,
    voiceConfidence: 0.97,
    transcriptConfidence: 0.91,
    activityClassification: {
      id: null,
      category: "social_call",
      confidence: 0.95,
      decision: "adopted",
      source: "captured_snapshot",
      reason: null,
    },
  });
});
