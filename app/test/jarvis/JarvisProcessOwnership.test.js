const assert = require("node:assert/strict");
const test = require("node:test");

const { createJarvisOwnedPidsProvider } = require("../../src/jarvis/main/JarvisProcessOwnership");

test("Jarvis owns its Electron children and active Whisper process", () => {
  const provider = createJarvisOwnedPidsProvider({
    mainPid: 100,
    getAppMetrics: () => [{ pid: 101 }, { pid: 102 }, { pid: 101 }],
    getWhisperPid: () => 103,
  });

  assert.deepEqual(provider(), [100, 101, 102, 103]);
});

test("Jarvis process ownership ignores invalid and unavailable child metrics", () => {
  const provider = createJarvisOwnedPidsProvider({
    mainPid: 200,
    getAppMetrics: () => {
      throw new Error("metrics unavailable");
    },
    getWhisperPid: () => null,
  });

  assert.deepEqual(provider(), [200]);
});
