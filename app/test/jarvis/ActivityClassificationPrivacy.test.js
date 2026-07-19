"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ActivityClassificationInputBuilder = require("../../src/jarvis/main/ActivityClassificationInputBuilder");
const MiniMaxActivityClassifier = require("../../src/jarvis/main/MiniMaxActivityClassifier");
const { OUTPUT_CONTRACT_VERSION } = require("../../src/jarvis/main/MiniMaxActivityClassifier");

function privateInput() {
  return {
    activities: [
      {
        activityId: "private-activity",
        applications: ["kook"],
        sourceAttribution: "application_and_microphone",
        speakerLabels: ["SELF", "P1"],
        segments: [
          {
            segmentId: "private-segment",
            startedAt: 0,
            endedAt: 10_000,
            speakerLabel: "P1",
            text: "张三说请联系李四，token=sk-cp-not-a-real-key-123456。麦克风 SteelSeries Sonar，文件在 C:\\Users\\xujie\\secret.txt。",
          },
        ],
        statistics: {
          durationMs: 90_000,
          microphoneParticipated: true,
          selfDetected: true,
          speakerCount: 2,
          turnCount: 8,
          turnTakingScore: 0.72,
          foregroundAppKey: "kook",
        },
      },
    ],
    redactionTerms: {
      participants: [{ label: "P1", names: ["张三"] }],
      otherPeople: ["李四"],
      deviceLabels: ["SteelSeries Sonar"],
    },
  };
}

function jsonResponse(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    ok: true,
    status: 200,
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

test("cloud payload contains only normalized apps, anonymous speakers, transcript and statistics", () => {
  const builder = new ActivityClassificationInputBuilder();
  const built = builder.build(privateInput());
  const activity = built.cloudPayload.activities[0];

  assert.deepEqual(Object.keys(built.cloudPayload).sort(), ["activities", "inputVersion"]);
  assert.deepEqual(Object.keys(activity).sort(), [
    "activityId",
    "applications",
    "segments",
    "sourceAttribution",
    "speakerLabels",
    "statistics",
  ]);
  assert.deepEqual(activity.applications, [{ key: "kook", name: "KOOK" }]);
  assert.deepEqual(activity.speakerLabels, ["SELF", "P1"]);
  assert.equal(builder.verifyCloudPayload(built.cloudPayload), true);

  const serialized = built.cloudPayloadJson;
  for (const secret of [
    "张三",
    "李四",
    "SteelSeries Sonar",
    "C:\\Users\\xujie",
    "secret.txt",
    "sk-cp-not-a-real-key",
  ]) {
    assert.equal(serialized.includes(secret), false, `payload leaked ${secret}`);
  }
  assert.match(serialized, /P1/);
  assert.match(serialized, /\[PERSON\]/);
  assert.match(serialized, /\[DEVICE\]/);
  assert.match(serialized, /\[PATH\]/);
  assert.match(serialized, /\[SECRET\]/);
});

test("rejects raw audio, embeddings, paths, window titles and real speaker labels as fields", () => {
  const builder = new ActivityClassificationInputBuilder();
  const forbiddenFields = [
    ["audio", Buffer.from("audio")],
    ["embedding", [0.1, 0.2]],
    ["executablePath", "C:\\Program Files\\KOOK\\kook.exe"],
    ["windowTitle", "张三的语音房间"],
    ["commandLine", "--token secret"],
    ["realName", "张三"],
  ];

  for (const [key, value] of forbiddenFields) {
    const input = privateInput();
    input.activities[0][key] = value;
    assert.throws(() => builder.build(input), /unsupported fields/u);
  }

  const namedSpeaker = privateInput();
  namedSpeaker.activities[0].speakerLabels = ["SELF", "张三"];
  assert.throws(() => builder.build(namedSpeaker), /anonymous P-number/u);
});

test("rejects executable paths masquerading as normalized application names", () => {
  const builder = new ActivityClassificationInputBuilder();
  const input = privateInput();
  input.activities[0].applications = ["C:\\Program Files\\KOOK\\kook.exe"];
  assert.throws(() => builder.build(input), /unsupported or duplicate key/u);
});

test("MiniMax request never serializes local redaction dictionaries or metadata-only logs", async () => {
  const built = new ActivityClassificationInputBuilder().build(privateInput());
  let rawRequest;
  const logs = [];
  const client = new MiniMaxActivityClassifier({
    getApiKey: () => "sk-cp-runtime-test-key",
    logger: (record) => logs.push(record),
    fetchImpl: async (_url, options) => {
      rawRequest = options.body;
      return jsonResponse({
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
                      classifications: [
                        {
                          activityId: "private-activity",
                          category: "social_call",
                          confidence: 0.92,
                          reason: "SELF and P1 take turns in KOOK.",
                          evidenceSegmentIds: ["private-segment"],
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 60, completion_tokens: 20 },
      });
    },
  });

  await client.classify({
    cloudPayloadJson: built.cloudPayloadJson,
    inputHash: built.inputHash,
    validationContext: built.validationContext,
  });

  for (const secret of ["张三", "李四", "SteelSeries Sonar", "C:\\Users", "sk-cp-runtime"]) {
    assert.equal(rawRequest.includes(secret), false, `request leaked ${secret}`);
    assert.equal(JSON.stringify(logs).includes(secret), false, `logs leaked ${secret}`);
  }
  assert.equal(Object.hasOwn(logs[0], "transcript"), false);
  assert.equal(Object.hasOwn(logs[0], "applications"), false);
});
