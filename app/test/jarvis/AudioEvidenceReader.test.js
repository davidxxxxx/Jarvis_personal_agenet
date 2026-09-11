const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");

test("verified diarization evidence is normalized only in the temporary model lease", async () => {
  const original = {
    bytes: Buffer.from([1, 0, 2, 0, 3, 0]),
    sampleRate: 24000,
    channels: 1,
    sampleCount: 3,
  };
  const normalized = {
    bytes: Buffer.from([4, 0, 5, 0]),
    sampleRate: 16000,
    channels: 1,
    sampleCount: 2,
  };
  const calls = [];
  let leased = null;
  const reader = new AudioEvidenceReader({
    decoder: {
      decode: async () => original,
    },
    normalizer: {
      normalize: async (pcm, format) => {
        calls.push({ pcm, format });
        return normalized;
      },
    },
    temporaryWav: {
      write: async (pcm, authority) => {
        leased = { pcm, authority };
        return {
          path: "G:\\JarvisData\\.evidence-tmp\\normalized.wav",
          remove: async () => {},
        };
      },
    },
    now: () => 1000,
  });
  const sha256 = crypto.createHash("sha256").update(original.bytes).digest("hex");

  const result = await reader.withVerifiedWav(
    {
      id: "chunk-normalize",
      path: "G:\\JarvisData\\chunk.wav",
      format: "wav",
      sha256,
      expires_at: 5000,
    },
    async (wavPath) => wavPath,
    { sampleRate: 16000, channels: 1 }
  );

  assert.equal(result, "G:\\JarvisData\\.evidence-tmp\\normalized.wav");
  assert.deepEqual(calls, [
    {
      pcm: original,
      format: { sampleRate: 16000, channels: 1 },
    },
  ]);
  assert.deepEqual(leased, {
    pcm: normalized,
    authority: { chunkId: "chunk-normalize", pcmSha256: sha256 },
  });
});
