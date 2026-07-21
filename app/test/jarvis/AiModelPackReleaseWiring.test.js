const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

test("Windows release carries the offline component and installs it before processing starts", () => {
  const builder = JSON.parse(read("electron-builder.json"));
  assert.ok(
    builder.win.extraResources.some(
      (entry) =>
        entry.from === "resources/ai-model-pack/prebuilt" && entry.to === "jarvis-ai-model-pack"
    )
  );

  const main = read("main.js");
  const installation = main.indexOf("await installBundledAiModelPackIfPresent()");
  const processing = main.indexOf("startJarvisProcessingRuntime();", installation);
  assert.ok(installation >= 0, "model component installation must be awaited");
  assert.ok(processing > installation, "processing must start only after model component adoption");
});

test("release preparation keeps staging off C and performs an offline CUDA model load test", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["prepare:ai-model-pack"], /prepare-ai-model-pack\.ps1/u);
  assert.match(packageJson.scripts["prebuild:win"], /npm run verify:ai-model-pack$/u);

  const script = read("scripts/prepare-ai-model-pack.ps1");
  assert.match(script, /G:\\Jarvis\\\.tmp/u);
  assert.match(script, /download\.pytorch\.org\/whl\/cu128/u);
  assert.match(script, /--self-test/u);
  assert.match(script, /--load-separator/u);
  assert.match(script, /HF_HUB_OFFLINE/u);
  assert.match(script, /TRANSFORMERS_OFFLINE/u);
});
