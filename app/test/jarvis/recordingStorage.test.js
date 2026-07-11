const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveRecordingsRoot } = require("../../src/jarvis/main/recordingStorage");

test("recording storage defaults under userData and accepts a safe absolute override", () => {
  const userDataDir = path.resolve("C:\\Users\\test\\AppData\\Roaming\\Jarvis Memory");
  const external = path.resolve("G:\\JarvisData\\recordings");

  assert.equal(resolveRecordingsRoot(userDataDir, ""), path.join(userDataDir, "recordings"));
  assert.equal(resolveRecordingsRoot(userDataDir, `  ${external}  `), external);
});

test("recording storage rejects relative paths and volume roots", () => {
  const userDataDir = path.resolve("C:\\Users\\test\\Jarvis Memory");

  assert.throws(() => resolveRecordingsRoot(userDataDir, "..\\recordings"), /absolute/);
  assert.throws(() => resolveRecordingsRoot(userDataDir, path.parse(userDataDir).root), /volume root/);
});
