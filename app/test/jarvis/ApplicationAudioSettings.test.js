const test = require("node:test");
const assert = require("node:assert/strict");

const EnvironmentManager = require("../../src/helpers/environment");

test("application audio settings default to enabled with four tracks and clamp to 1-8", async () => {
  const manager = Object.create(EnvironmentManager.prototype);
  const values = new Map();
  manager._getKey = (key) => values.get(key) ?? "";
  manager._saveKey = (key, value) => {
    values.set(key, value);
    return value;
  };
  manager.saveAllKeysToEnvFile = async () => {};

  assert.deepEqual(manager.getApplicationAudioSettings(), { enabled: true, trackLimit: 4 });
  assert.deepEqual(
    await manager.saveApplicationAudioSettings({ enabled: false, trackLimit: 99 }),
    { enabled: false, trackLimit: 8 }
  );
  assert.deepEqual(manager.getApplicationAudioSettings(), { enabled: false, trackLimit: 8 });
  assert.deepEqual(
    await manager.saveApplicationAudioSettings({ enabled: true, trackLimit: -5 }),
    { enabled: true, trackLimit: 1 }
  );
});
