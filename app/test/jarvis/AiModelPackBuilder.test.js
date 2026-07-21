const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildAiModelPack } = require("../../scripts/build-ai-model-pack");
const { verifyAiModelPack } = require("../../src/jarvis/main/AiModelPackManifest");

function write(filePath, value = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

test("model pack builder creates one verified offline component tree", async (t) => {
  const scratch = path.join("G:\\Jarvis", ".tmp", "ai-model-pack-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "jarvis-model-pack-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "python");
  const pyannote = path.join(root, "pyannote");
  const smallModels = path.join(root, "small-models");
  write(path.join(runtime, "python.exe"));
  write(path.join(runtime, "__pycache__", "ignored.pyc"));
  write(path.join(pyannote, "config.yaml"));
  write(path.join(pyannote, ".cache", "ignored-metadata"));
  write(path.join(pyannote, ".git", "config"));
  write(path.join(smallModels, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "silero_vad.onnx"));
  const mossformer = path.join(root, "MossFormer2_SS_16K");
  write(path.join(mossformer, "last_best_checkpoint"), "model.pt\n");
  write(path.join(mossformer, "model.pt"));
  const output = path.join(root, "output", "ai-model-pack");
  const built = await buildAiModelPack(
    {
      outputDir: output,
      pythonRuntime: runtime,
      pyannoteDir: pyannote,
      mossformerDir: mossformer,
      diarizationModelsDir: smallModels,
    },
    { now: () => new Date("2026-07-21T00:00:00.000Z"), systemDrive: "C:" }
  );
  assert.equal(built.output, path.resolve(output));
  const verified = await verifyAiModelPack({ root: output });
  assert.equal(verified.manifest.createdAt, "2026-07-21T00:00:00.000Z");
  assert.ok(fs.existsSync(path.join(output, "runtime", "jarvis_diarization_sidecar.py")));
  assert.ok(fs.existsSync(path.join(output, "THIRD_PARTY_NOTICES.txt")));
  assert.equal(fs.existsSync(path.join(output, "runtime", "__pycache__")), false);
  assert.equal(fs.existsSync(path.join(output, "models", "pyannote-community-1", ".cache")), false);
  assert.equal(fs.existsSync(path.join(output, "models", "pyannote-community-1", ".git")), false);
});

test("model pack builder rejects a MossFormer pointer without its referenced weights", async (t) => {
  const scratch = path.join("G:\\Jarvis", ".tmp", "ai-model-pack-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "jarvis-model-pack-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "python");
  const pyannote = path.join(root, "pyannote");
  const smallModels = path.join(root, "small-models");
  const mossformer = path.join(root, "MossFormer2_SS_16K");
  write(path.join(runtime, "python.exe"));
  write(path.join(pyannote, "config.yaml"));
  write(path.join(smallModels, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"));
  write(path.join(smallModels, "silero_vad.onnx"));
  write(path.join(mossformer, "last_best_checkpoint"), "missing.pt\n");

  await assert.rejects(
    buildAiModelPack(
      {
        outputDir: path.join(root, "output", "ai-model-pack"),
        pythonRuntime: runtime,
        pyannoteDir: pyannote,
        mossformerDir: mossformer,
        diarizationModelsDir: smallModels,
      },
      { systemDrive: "C:" }
    ),
    (error) => error.code === "AI_MODEL_PACK_INCOMPLETE"
  );
});
