const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

test("Windows release ships the model as a verified sibling component", () => {
  const builder = JSON.parse(read("electron-builder.json"));
  assert.equal(builder.toolsets?.nsis, "1.2.1");
  assert.equal(
    builder.win.extraResources.some((entry) => entry.from === "resources/ai-model-pack/prebuilt"),
    false
  );
  assert.deepEqual(builder.win.target, ["nsis"]);

  const main = read("main.js");
  const installation = main.indexOf("await installBundledAiModelPackIfPresent()");
  const processing = main.indexOf("startJarvisProcessingRuntime();", installation);
  assert.ok(installation >= 0, "model component installation must be awaited");
  assert.ok(processing > installation, "processing must start only after model component adoption");

  const nsis = read("resources/nsis/cleanup-models.nsh");
  assert.match(nsis, /model-pack-release\.generated\.nsh/u);
  assert.match(nsis, /StdUtils\.HashFile/u);
  assert.match(nsis, /Nsis7z::Extract/u);
  assert.match(nsis, /jarvis-ai-model-pack\\manifest\.json/u);
});

test("release preparation keeps staging off C and performs an offline CUDA model load test", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["prepare:ai-model-pack"], /prepare-ai-model-pack\.ps1/u);
  assert.match(packageJson.scripts["prebuild:win"], /npm run verify:ai-model-pack$/u);
  assert.match(packageJson.scripts["build:win"], /build-windows-model-bundle\.js/u);
  assert.equal(packageJson.devDependencies["7zip-bin"], "^5.2.0");

  const script = read("scripts/prepare-ai-model-pack.ps1");
  assert.match(script, /G:\\Jarvis\\\.tmp/u);
  assert.match(script, /download\.pytorch\.org\/whl\/cu128/u);
  assert.match(script, /--self-test/u);
  assert.match(script, /--load-separator/u);
  assert.match(script, /HF_HUB_OFFLINE/u);
  assert.match(script, /TRANSFORMERS_OFFLINE/u);
  assert.match(script, /\$runtimeForBuild = \$pythonSource/u);
  assert.match(script, /missing JARVIS_PYTHON_LOCK\.txt/u);
  assert.match(script, /"-I", "-m", "pip", "check"/u);
});

test("offline dependency lock vendors ClearerVoice source without its conflicting PyPI metadata", () => {
  const requirements = read("resources/ai-model-pack/requirements.lock.txt");
  assert.match(requirements, /^numpy==2\.3\.5$/mu);
  assert.match(requirements, /^soundfile==0\.12\.1$/mu);
  assert.doesNotMatch(requirements, /^clearvoice(?:==|[<>])/mu);

  const builder = read("scripts/build-ai-model-pack.js");
  assert.match(builder, /clearer-voice-dir/u);
  assert.match(builder, /vendor["'], ["']clearervoice-studio/u);

  const worker = read("resources/ai-model-pack/runtime/jarvis_overlap_separator.py");
  assert.match(worker, /vendor" \/ "clearervoice-studio/u);
  assert.match(worker, /from clearvoice import ClearVoice/u);
  assert.match(worker, /with redirect_stdout\(sys\.stderr\)/u);
});

test("generated model component stays outside source lint and format scans", () => {
  const eslintConfig = read("eslint.config.js");
  const prettierIgnore = read(".prettierignore");

  assert.match(eslintConfig, /resources\/ai-model-pack\/prebuilt\/\*\*/u);
  assert.match(prettierIgnore, /^resources\/ai-model-pack\/prebuilt$/mu);
});
