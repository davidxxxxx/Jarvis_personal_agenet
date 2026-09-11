const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_JARVIS_ROLLOUT_FLAGS,
  FLAG_DEFINITIONS,
  resolveJarvisRolloutFlags,
} = require("../../src/jarvis/main/JarvisRolloutFlags");

test("the four approved rollout flags default on for the release candidate", () => {
  assert.deepEqual(DEFAULT_JARVIS_ROLLOUT_FLAGS, {
    applicationAudioV1: true,
    dualSpeakerVerificationV1: true,
    activityClassificationV1: true,
    actionCenterV1: true,
  });
  assert.deepEqual(Object.keys(FLAG_DEFINITIONS), Object.keys(DEFAULT_JARVIS_ROLLOUT_FLAGS));
});

test("rollout flags accept explicit operational overrides without treating typos as rollbacks", () => {
  const values = new Map([
    ["JARVIS_ROLLOUT_APPLICATION_AUDIO_V1", "off"],
    ["JARVIS_ROLLOUT_DUAL_SPEAKER_VERIFICATION_V1", "0"],
    ["JARVIS_ROLLOUT_ACTIVITY_CLASSIFICATION_V1", "FALSE"],
    ["JARVIS_ROLLOUT_ACTION_CENTER_V1", "mistyped"],
  ]);
  assert.deepEqual(
    resolveJarvisRolloutFlags((key) => values.get(key)),
    {
      applicationAudioV1: false,
      dualSpeakerVerificationV1: false,
      activityClassificationV1: false,
      actionCenterV1: true,
    }
  );
});

test("rollout flag snapshots are immutable and require a reader", () => {
  const snapshot = resolveJarvisRolloutFlags(() => "enabled");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => resolveJarvisRolloutFlags(null), /reader/u);
});
