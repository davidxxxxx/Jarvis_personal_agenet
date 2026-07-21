const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildAiModelPack } = require("../../scripts/build-ai-model-pack");
const {
  installBundledAiModelPack,
  resolveBundledAiModelPackRoot,
} = require("../../src/jarvis/main/AiModelPackInstaller");

function write(filePath, value = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

async function buildFixture(root) {
  const runtime = path.join(root, "python");
  const pyannote = path.join(root, "pyannote");
  const smallModels = path.join(root, "small-models");
  write(path.join(runtime, "python.exe"));
  write(path.join(pyannote, "config.yaml"));
  write(path.join(smallModels, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "silero_vad.onnx"));
  const mossformer = path.join(root, "MossFormer2_SS_16K");
  write(path.join(mossformer, "last_best_checkpoint"), "model.pt\n");
  write(path.join(mossformer, "model.pt"));
  const sourceRoot = path.join(root, "bundle", "jarvis-ai-model-pack");
  await buildAiModelPack(
    {
      outputDir: sourceRoot,
      pythonRuntime: runtime,
      pyannoteDir: pyannote,
      mossformerDir: mossformer,
      diarizationModelsDir: smallModels,
    },
    { systemDrive: "C:" }
  );
  return sourceRoot;
}

test("bundled model pack resolves as a separate packaged component", () => {
  assert.equal(
    resolveBundledAiModelPackRoot({ resourcesPath: String.raw`G:\Jarvis\resources` }),
    path.resolve(String.raw`G:\Jarvis\resources\jarvis-ai-model-pack`)
  );
});

test("installs a verified model component atomically under the non-system data root", async (t) => {
  const scratch = path.join(String.raw`G:\Jarvis`, ".tmp", "ai-model-pack-installer-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = await buildFixture(root);
  const targetRoot = path.join(root, "JarvisData", "models", "ai-model-pack");

  const installed = await installBundledAiModelPack({
    sourceRoot,
    targetRoot,
    systemDrive: "C:",
  });
  assert.equal(installed.state, "installed");
  assert.equal(installed.targetRoot, path.resolve(targetRoot));
  assert.ok(fs.existsSync(path.join(targetRoot, "manifest.json")));

  const current = await installBundledAiModelPack({
    sourceRoot,
    targetRoot,
    systemDrive: "C:",
  });
  assert.equal(current.state, "current");
  assert.equal(current.manifestSha256, installed.manifestSha256);
});

test("replaces a corrupt target but never accepts a system-drive data destination", async (t) => {
  const scratch = path.join(String.raw`G:\Jarvis`, ".tmp", "ai-model-pack-installer-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = await buildFixture(root);
  const targetRoot = path.join(root, "JarvisData", "models", "ai-model-pack");
  write(path.join(targetRoot, "manifest.json"), "corrupt");

  const result = await installBundledAiModelPack({
    sourceRoot,
    targetRoot,
    systemDrive: "C:",
  });
  assert.equal(result.state, "replaced");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(targetRoot, "manifest.json"))));
  await assert.rejects(
    installBundledAiModelPack({
      sourceRoot,
      targetRoot: String.raw`C:\JarvisData\models\ai-model-pack`,
      systemDrive: "C:",
    }),
    (error) => error.code === "SPEAKER_MODEL_SYSTEM_DRIVE_FORBIDDEN"
  );
});
