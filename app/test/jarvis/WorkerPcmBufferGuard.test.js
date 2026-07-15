const assert = require("node:assert/strict");
const test = require("node:test");

const {
  withRequiredAudioRuntime,
  zeroSamplesBuffer,
} = require("../../src/workers/WorkerPcmBufferGuard");

test("worker PCM guard clears cloned input when speaker model or VAD runtime is absent", async (t) => {
  for (const message of ["speaker session not loaded", "VAD session not loaded"]) {
    await t.test(message, async () => {
      const samplesBuffer = new ArrayBuffer(32);
      new Uint8Array(samplesBuffer).fill(9);

      await assert.rejects(
        withRequiredAudioRuntime({ samplesBuffer }, null, message, async () => {}),
        new RegExp(message)
      );
      assert.equal(
        new Uint8Array(samplesBuffer).every((value) => value === 0),
        true
      );
    });
  }
});

test("required worker runtime operation runs under the same PCM cleanup guard", async () => {
  const samplesBuffer = new ArrayBuffer(16);
  new Uint8Array(samplesBuffer).fill(5);
  const runtime = { kind: "vad" };
  assert.equal(
    await withRequiredAudioRuntime(
      { samplesBuffer },
      runtime,
      "missing",
      async (selected) => selected.kind
    ),
    "vad"
  );
  assert.equal(
    new Uint8Array(samplesBuffer).every((value) => value === 0),
    true
  );
});

test("worker PCM cleanup is safe when a typed view cannot be constructed", () => {
  const samplesBuffer = new ArrayBuffer(8);
  structuredClone(samplesBuffer, { transfer: [samplesBuffer] });
  assert.equal(samplesBuffer.byteLength, 0);
  assert.doesNotThrow(() => zeroSamplesBuffer(samplesBuffer));
  assert.equal(zeroSamplesBuffer({ invalid: true }), false);
});
