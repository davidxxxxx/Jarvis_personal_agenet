const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.resolve(__dirname, "../..");

test("voice recorder enables the preload bridge required by its renderer", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/windowConfig.js"), "utf8");
  const mainWindowConfig = source.match(
    /const MAIN_WINDOW_CONFIG = \{[\s\S]*?\r?\n\};\r?\n\r?\n\/\/ Control panel window configuration/
  )?.[0];

  assert.ok(mainWindowConfig, "MAIN_WINDOW_CONFIG should remain discoverable");
  assert.match(mainWindowConfig, /preload:\s*path\.join\(/);
  assert.match(mainWindowConfig, /contextIsolation:\s*true/);
  assert.match(mainWindowConfig, /sandbox:\s*false/);
});

test("voice recorder tolerates a missing preload bridge without crashing its error boundary", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/hooks/useAudioRecording.js"), "utf8");
  const guardedReads = source.match(/window\.electronAPI\?\.getSttConfig\?\.\(/g) ?? [];

  assert.equal(guardedReads.length, 2);
  assert.doesNotMatch(source, /window\.electronAPI\.getSttConfig\?\.\(/);
});
