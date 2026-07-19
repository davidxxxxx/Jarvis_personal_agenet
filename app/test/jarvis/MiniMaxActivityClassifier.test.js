"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ActivityClassificationInputBuilder = require("../../src/jarvis/main/ActivityClassificationInputBuilder");
const MiniMaxActivityClassifier = require("../../src/jarvis/main/MiniMaxActivityClassifier");
const {
  ActivityClassificationClientError,
  OUTPUT_CONTRACT_VERSION,
} = require("../../src/jarvis/main/MiniMaxActivityClassifier");

function sourceActivity({
  activityId = "activity-1",
  applications = ["chrome"],
  sourceAttribution = "application",
  speakerLabels = ["P1"],
} = {}) {
  return {
    activityId,
    applications,
    sourceAttribution,
    speakerLabels,
    segments: [
      {
        segmentId: `${activityId}-segment-1`,
        startedAt: 0,
        endedAt: 10_000,
        speakerLabel: speakerLabels[0],
        text: "这是比赛直播内容，不是我的任务。",
      },
    ],
    statistics: {
      durationMs: 90_000,
      microphoneParticipated: speakerLabels.includes("SELF"),
      selfDetected: speakerLabels.includes("SELF"),
      speakerCount: speakerLabels.length,
      turnCount: 1,
      turnTakingScore: 0,
      foregroundAppKey: applications[0] ?? null,
    },
  };
}

function classifierInput(activities) {
  const built = new ActivityClassificationInputBuilder().build({
    activities,
    redactionTerms: { participants: [], otherPeople: [], deviceLabels: [] },
  });
  return {
    cloudPayloadJson: built.cloudPayloadJson,
    inputHash: built.inputHash,
    validationContext: built.validationContext,
  };
}

function responseBody(classifications, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "submit_jarvis_activity_classification",
                arguments: JSON.stringify({
                  outputVersion: OUTPUT_CONTRACT_VERSION,
                  classifications,
                }),
              },
            },
          ],
        },
      },
    ],
    usage,
  };
}

function jsonResponse(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(bytes.byteLength) },
    arrayBuffer: async () => bytes,
    body: {
      cancel: async () => {},
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
    },
  };
}

test("sends a batch through the strict tool and returns gated activity classifications", async () => {
  let request;
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-test-only",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return jsonResponse(
        responseBody([
          {
            activityId: "activity-1",
            category: "entertainment",
            confidence: 0.94,
            reason: "Chrome contains passive sports commentary and SELF is absent.",
            evidenceSegmentIds: ["activity-1-segment-1"],
          },
        ])
      );
    },
    createRequestId: () => "activity_request_1",
  });

  const result = await client.classify(classifierInput([sourceActivity()]));

  assert.equal(result.classifications[0].category, "entertainment");
  assert.equal(result.classifications[0].decision, "adopted");
  assert.equal(result.classifications[0].allowSuggestions, false);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(request.tool_choice.function.name, "submit_jarvis_activity_classification");
  assert.equal(request.messages[1].role, "user");
  assert.equal(typeof request.messages[1].content, "string");
});

test("classifies every batched activity exactly once and preserves input order", async () => {
  const activities = [
    sourceActivity(),
    sourceActivity({
      activityId: "activity-2",
      applications: ["kook"],
      sourceAttribution: "application_and_microphone",
      speakerLabels: ["SELF", "P1"],
    }),
  ];
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-test-only",
    fetchImpl: async () =>
      jsonResponse(
        responseBody([
          {
            activityId: "activity-2",
            category: "social_call",
            confidence: 0.91,
            reason: "SELF participates in a multi-speaker KOOK call.",
            evidenceSegmentIds: ["activity-2-segment-1"],
          },
          {
            activityId: "activity-1",
            category: "entertainment",
            confidence: 0.92,
            reason: "Passive sports video in Chrome.",
            evidenceSegmentIds: ["activity-1-segment-1"],
          },
        ])
      ),
  });

  const result = await client.classify(classifierInput(activities));

  assert.deepEqual(
    result.classifications.map((classification) => classification.activityId),
    ["activity-1", "activity-2"]
  );
  assert.equal(result.classifications[1].allowTodos, true);
});

test("caps MiniMax confidence for mixed unknown system audio", async () => {
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-test-only",
    fetchImpl: async () =>
      jsonResponse(
        responseBody([
          {
            activityId: "activity-1",
            category: "work_meeting",
            confidence: 0.99,
            reason: "The words resemble a meeting, but the application source is unknown.",
            evidenceSegmentIds: ["activity-1-segment-1"],
          },
        ])
      ),
  });
  const input = classifierInput([
    sourceActivity({ applications: [], sourceAttribution: "mixed_unknown" }),
  ]);

  const result = await client.classify(input);

  assert.equal(result.classifications[0].confidence, 0.79);
  assert.equal(result.classifications[0].decision, "tentative");
  assert.equal(result.classifications[0].allowTodos, false);
});

test("rejects invented evidence, duplicate activities, and unsupported categories", async () => {
  const candidates = [
    [
      {
        activityId: "activity-1",
        category: "work_meeting",
        confidence: 0.9,
        reason: "Invented evidence.",
        evidenceSegmentIds: ["not-supplied"],
      },
    ],
    [
      {
        activityId: "activity-1",
        category: "podcast",
        confidence: 0.9,
        reason: "Unsupported category.",
        evidenceSegmentIds: ["activity-1-segment-1"],
      },
    ],
  ];
  for (const classifications of candidates) {
    const client = new MiniMaxActivityClassifier({
      getApiKey: () => "sk-cp-test-only",
      fetchImpl: async () => jsonResponse(responseBody(classifications)),
    });
    await assert.rejects(
      () => client.classify(classifierInput([sourceActivity()])),
      (error) =>
        error instanceof ActivityClassificationClientError && error.code === "invalid_structure"
    );
  }
});

test("marks transient MiniMax failures retryable so the caller can fall back locally", async () => {
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-test-only",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });

  await assert.rejects(
    () => client.classify(classifierInput([sourceActivity()])),
    (error) =>
      error instanceof ActivityClassificationClientError &&
      error.code === "network" &&
      error.retryable === true
  );
});

test("rejects tampered payload hashes before any network request", async () => {
  let called = false;
  const input = classifierInput([sourceActivity()]);
  input.cloudPayloadJson = input.cloudPayloadJson.replace("Chrome", "KOOK");
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-test-only",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    () => client.classify(input),
    (error) => error.code === "invalid_structure" && error.issueCode === "input.hash"
  );
  assert.equal(called, false);
});
