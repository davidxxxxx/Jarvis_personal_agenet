const test = require("node:test");
const assert = require("node:assert/strict");

const EnvironmentManager = require("../../src/helpers/environment");

test("application audio settings default, persist all fields, and fail invalid policy closed", async () => {
  const manager = Object.create(EnvironmentManager.prototype);
  const values = new Map();
  manager._getKey = (key) => values.get(key) ?? "";
  manager._saveKey = (key, value) => {
    values.set(key, value);
    return value;
  };
  manager.saveAllKeysToEnvFile = async () => {};

  assert.deepEqual(manager.getApplicationAudioSettings(), {
    enabled: true,
    trackLimit: 4,
    fallbackPolicy: "conservative",
  });
  assert.deepEqual(
    await manager.saveApplicationAudioSettings({
      enabled: false,
      trackLimit: 99,
      fallbackPolicy: "transcript_only",
    }),
    { enabled: false, trackLimit: 8, fallbackPolicy: "transcript_only" }
  );
  assert.deepEqual(manager.getApplicationAudioSettings(), {
    enabled: false,
    trackLimit: 8,
    fallbackPolicy: "transcript_only",
  });
  assert.deepEqual(
    await manager.saveApplicationAudioSettings({
      enabled: true,
      trackLimit: -5,
      fallbackPolicy: "unsafe",
    }),
    { enabled: true, trackLimit: 1, fallbackPolicy: "conservative" }
  );
  assert.equal(values.get("JARVIS_APPLICATION_AUDIO_FALLBACK_POLICY"), "conservative");
});

test("application audio rollout rollback overrides the saved preference without erasing it", async () => {
  const manager = Object.create(EnvironmentManager.prototype);
  const values = new Map([["JARVIS_ROLLOUT_APPLICATION_AUDIO_V1", "false"]]);
  manager._getKey = (key) => values.get(key) ?? "";
  manager._saveKey = (key, value) => values.set(key, value);
  manager.saveAllKeysToEnvFile = async () => {};

  assert.equal(manager.getApplicationAudioSettings().enabled, false);
  assert.equal(
    (
      await manager.saveApplicationAudioSettings({
        enabled: true,
        trackLimit: 6,
        fallbackPolicy: "conservative",
      })
    ).enabled,
    false
  );
  assert.equal(values.get("JARVIS_APPLICATION_AUDIO_ENABLED"), "true");

  values.set("JARVIS_ROLLOUT_APPLICATION_AUDIO_V1", "true");
  assert.deepEqual(manager.getApplicationAudioSettings(), {
    enabled: true,
    trackLimit: 6,
    fallbackPolicy: "conservative",
  });
});
