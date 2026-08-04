const assert = require("node:assert/strict");
const test = require("node:test");
const { HYBRID_DIARIZATION_POLICY } = require("../../src/jarvis/main/HybridDiarizationPolicy");
const {
  buildSpeakerCountConsensus,
  findOverlapWindows,
} = require("../../src/jarvis/main/DiarizationConsensus");
const OnDemandModelRuntime = require("../../src/jarvis/main/OnDemandModelRuntime");

test("hybrid policy pins the approved GPU-idle pipeline and five minute unload", () => {
  assert.equal(HYBRID_DIARIZATION_POLICY.policyId, "jarvis-hybrid-diarization-v4");
  assert.equal(HYBRID_DIARIZATION_POLICY.clusterMemberAgreementRatio, 0.75);
  assert.equal(HYBRID_DIARIZATION_POLICY.executionDevice, "cuda");
  assert.equal(HYBRID_DIARIZATION_POLICY.unloadDelayMs, 300_000);
  assert.equal(HYBRID_DIARIZATION_POLICY.models.primary.license, "CC-BY-4.0");
  assert.equal(HYBRID_DIARIZATION_POLICY.models.verifier.role, "windows_native_count_verifier");
  assert.equal(
    HYBRID_DIARIZATION_POLICY.models.separator.role,
    "overlap_only_two_speaker_separation"
  );
  assert.ok(Object.isFrozen(HYBRID_DIARIZATION_POLICY));
  assert.ok(Object.isFrozen(HYBRID_DIARIZATION_POLICY.models));
});

test("speaker count consensus is exact only when both eligible models agree", () => {
  assert.deepEqual(buildSpeakerCountConsensus({ primaryCount: 3, verifierCount: 3 }), {
    minimum: 3,
    maximum: 3,
    preferred: 3,
    confidence: 0.94,
    state: "models_agree",
  });
  assert.deepEqual(buildSpeakerCountConsensus({ primaryCount: 3, verifierCount: 4 }), {
    minimum: 3,
    maximum: 4,
    preferred: 3,
    confidence: 0.55,
    state: "models_disagree",
  });
  assert.equal(
    buildSpeakerCountConsensus({ primaryCount: 5, verifierCount: 4 }).state,
    "primary_only_above_verifier_limit"
  );
});

test("only strict overlap windows are padded and merged for expensive separation", () => {
  const windows = findOverlapWindows(
    [
      { speaker: "S1", startMs: 1_000, endMs: 4_000 },
      { speaker: "S2", startMs: 2_000, endMs: 3_000 },
      { speaker: "S1", startMs: 5_000, endMs: 7_000 },
      { speaker: "S3", startMs: 6_000, endMs: 6_500 },
    ],
    { paddingMs: 250, durationMs: 7_000 }
  );
  assert.deepEqual(windows, [
    { startMs: 1_750, endMs: 3_250 },
    { startMs: 5_750, endMs: 6_750 },
  ]);
});

test("on-demand runtime shares one load and unloads five minutes after the last job", async () => {
  const timers = [];
  const cleared = [];
  const events = [];
  const runtime = new OnDemandModelRuntime({
    unloadDelayMs: 300_000,
    load: async () => {
      events.push("load");
      return { id: "models" };
    },
    unload: async (instance) => events.push(`unload:${instance.id}`),
    setTimeoutImpl: (callback, delay) => {
      const token = { callback, delay, unref() {} };
      timers.push(token);
      return token;
    },
    clearTimeoutImpl: (token) => cleared.push(token),
  });
  assert.equal(await runtime.run(async (models) => models.id), "models");
  assert.deepEqual(events, ["load"]);
  assert.equal(timers[0].delay, 300_000);
  assert.equal(await runtime.run(async (models) => models.id), "models");
  assert.deepEqual(events, ["load"]);
  assert.deepEqual(cleared, [timers[0]]);
  await timers[1].callback();
  assert.deepEqual(events, ["load", "unload:models"]);
  assert.equal(runtime.status().loaded, false);
});
