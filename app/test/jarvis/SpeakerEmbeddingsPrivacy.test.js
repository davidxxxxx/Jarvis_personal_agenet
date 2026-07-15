const assert = require("node:assert/strict");
const test = require("node:test");

const { SpeakerEmbeddings } = require("../../src/helpers/speakerEmbeddings");

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
