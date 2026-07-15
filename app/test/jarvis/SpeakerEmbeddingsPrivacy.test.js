const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SpeakerEmbeddings } = require("../../src/helpers/speakerEmbeddings");
const DiarizationManager = require("../../src/helpers/diarization");

test("speaker extraction clears its private PCM clone after success and failure", async (t) => {
  for (const [name, fail] of [
    ["success", false],
    ["failure", true],
  ]) {
    await t.test(name, async () => {
      let captured = null;
      const helper = new SpeakerEmbeddings({
        workerClient: {
          async request(method, payload) {
            if (method === "speaker.load") return { ok: true };
            captured = payload.samplesBuffer;
            if (fail) throw new Error("extract failed");
            return { embeddingBuffer: new Float32Array(512).fill(1).buffer };
          },
        },
      });
      helper._ensureLoaded = async () => {};
      const source = new Float32Array(24_000).fill(0.25);

      if (fail) await assert.rejects(helper.extractEmbeddingFromSamples(source), /extract failed/);
      else await helper.extractEmbeddingFromSamples(source);

      assert.ok(captured instanceof ArrayBuffer);
      assert.equal(
        new Uint8Array(captured).every((value) => value === 0),
        true
      );
      assert.equal(source[0], 0.25);
    });
  }
});

test("speaker model artifact hash is the SHA-256 of the local model file and is cached", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, "campplus.onnx");
  const bytes = Buffer.from("local-campplus-artifact");
  fs.writeFileSync(modelPath, bytes);
  const helper = new SpeakerEmbeddings({
    workerClient: { request: async () => ({ ok: true }) },
  });
  helper.getModelPath = () => modelPath;

  const first = await helper.getModelArtifactSha256();
  fs.writeFileSync(modelPath, Buffer.from("changed-after-cached-read"));
  const cached = await helper.getModelArtifactSha256();

  assert.equal(first, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(cached, first);
});

test("diarization artifact hash covers segmentation and embedding models and retries after failure", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diarization-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const segmentationPath = path.join(directory, "segmentation.onnx");
  const embeddingPath = path.join(directory, "embedding.onnx");
  const segmentation = Buffer.from("segmentation-model");
  const embedding = Buffer.from("embedding-model");
  fs.writeFileSync(segmentationPath, segmentation);
  const manager = new DiarizationManager();
  manager.getModelArtifacts = () => [
    { id: "sherpa-pyannote-segmentation-3.0", path: segmentationPath },
    { id: "3dspeaker-campplus-voxceleb-16k-v1", path: embeddingPath },
  ];

  await assert.rejects(manager.getModelArtifactSha256(), /ENOENT/);
  fs.writeFileSync(embeddingPath, embedding);

  const expected = crypto
    .createHash("sha256")
    .update("sherpa-pyannote-segmentation-3.0\0")
    .update(segmentation)
    .update("\0")
    .update("3dspeaker-campplus-voxceleb-16k-v1\0")
    .update(embedding)
    .update("\0")
    .digest("hex");
  const first = await manager.getModelArtifactSha256();
  fs.writeFileSync(segmentationPath, Buffer.from("changed-after-cache"));
  const cached = await manager.getModelArtifactSha256();

  assert.equal(first, expected);
  assert.equal(cached, first);
});
