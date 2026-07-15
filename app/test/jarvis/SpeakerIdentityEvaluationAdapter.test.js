"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const SpeakerIdentityResolver = require("../../src/jarvis/main/SpeakerIdentityResolver");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");
const { evaluateSpeakerReleaseGates } = require("./support/SpeakerIdentityMetrics");

function unitVector(index) {
  const vector = new Float32Array(512);
  vector[index] = 1;
  return vector;
}

test("local adapter converts anonymous production-shaped inference into passing aggregate metrics", async () => {
  const { evaluatePreparedSpeakerFixtures } = require("./support/SpeakerIdentityEvaluationAdapter");
  const manifest = {
    schemaVersion: 1,
    modelId: SPEAKER_IDENTITY_RESOLUTION_POLICY.modelId,
    profiles: [
      { personId: "self", kind: "self", audio: ["profiles/self-01.wav"] },
      { personId: "known-a", kind: "known", audio: ["profiles/known-a-01.wav"] },
    ],
    cases: [
      {
        id: "case-a",
        audio: "cases/case-a.wav",
        speakers: [
          { speakerId: "self", kind: "self" },
          { speakerId: "known-a", kind: "known" },
          { speakerId: "unknown-a", kind: "unknown" },
        ],
        segments: Array.from({ length: 9 }, (_, index) => ({
          speakerId: ["self", "known-a", "unknown-a"][index % 3],
          startMs: index * 5_000,
          endMs: (index + 1) * 5_000,
        })),
      },
    ],
  };
  const prepared = {
    status: "ready",
    manifest,
    audioFiles: new Map([
      ["profiles/self-01.wav", { path: "anonymous-profile-self.wav", durationMs: 15_000 }],
      ["profiles/known-a-01.wav", { path: "anonymous-profile-known.wav", durationMs: 15_000 }],
      ["cases/case-a.wav", { path: "anonymous-case.wav", durationMs: 45_000 }],
    ]),
  };
  const turns = manifest.cases[0].segments.map((segment) => ({
    speaker: `cluster-${segment.speakerId}`,
    start: segment.startMs / 1_000,
    end: segment.endMs / 1_000,
  }));
  const calls = [];
  const inference = {
    async diarizeAudio({ numSpeakers }) {
      calls.push(["diarize", numSpeakers]);
      return turns;
    },
    async embedAudio({ audioPath, startSec }) {
      calls.push(["embed", audioPath]);
      if (audioPath.includes("profile-self")) return unitVector(0);
      if (audioPath.includes("profile-known")) return unitVector(1);
      const interval = Math.floor(startSec / 5) % 3;
      return unitVector(interval);
    },
    computeCentroid(embeddings) {
      return embeddings[0];
    },
    cosineSimilarity(left, right) {
      let score = 0;
      for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
      return score;
    },
  };

  const report = await evaluatePreparedSpeakerFixtures({
    prepared,
    inference,
    resolver: new SpeakerIdentityResolver(),
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });

  assert.deepEqual(evaluateSpeakerReleaseGates(report), { passed: true, failures: [] });
  assert.deepEqual(report.speakerCount, { correctCases: 1, totalCases: 1, accuracy: 1 });
  assert.equal(report.self.precision, 1);
  assert.equal(report.known.precision, 1);
  assert.equal(report.unknown.falsePositiveRate, 0);
  assert.equal(report.automaticBoundaries.length, 2);
  assert.equal(calls.filter(([kind]) => kind === "diarize").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "embed").length, 11);
});

test("adapter rejects non-ready input and malformed inference without exposing private paths", async () => {
  const { evaluatePreparedSpeakerFixtures } = require("./support/SpeakerIdentityEvaluationAdapter");
  await assert.rejects(
    evaluatePreparedSpeakerFixtures({ prepared: { status: "skip" } }),
    (error) => error.code === "SPEAKER_EVAL_NOT_READY"
  );
  await assert.rejects(
    evaluatePreparedSpeakerFixtures({
      prepared: {
        status: "ready",
        manifest: {
          profiles: [],
          cases: [{ id: "case-a", audio: "cases/case-a.wav", speakers: [], segments: [] }],
        },
        audioFiles: new Map([
          ["cases/case-a.wav", { path: "private-value.wav", durationMs: 1_000 }],
        ]),
      },
      inference: {
        diarizeAudio: async () => "not-an-array",
        embedAudio: async () => unitVector(0),
        computeCentroid: (items) => items[0],
        cosineSimilarity: () => 1,
      },
      resolver: { resolveCluster: () => ({ state: "unknown" }) },
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    }),
    (error) => error.code === "SPEAKER_EVAL_INFERENCE_INVALID" && !error.message.includes(".wav")
  );
});
