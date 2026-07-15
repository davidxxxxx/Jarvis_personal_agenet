const assert = require("node:assert/strict");
const test = require("node:test");

const liveSpeakerIdentifier = require("../../src/helpers/liveSpeakerIdentifier");

test("one virtual Jarvis hour routes zero PCM frames into legacy live embeddings", async () => {
  let embeddingCalls = 0;
  const pcmBuffer = Buffer.alloc(320);
  for (let second = 0; second < 60 * 60; second += 1) {
    await liveSpeakerIdentifier.routeLegacyMeetingAudio({
      jarvisSessionActive: true,
      meetingLiveSpeakerActive: true,
      pcmBuffer,
      feedAudio: async () => {
        embeddingCalls += 1;
      },
    });
  }

  assert.equal(embeddingCalls, 0);
});

test("legacy meeting-only capture still routes PCM into live speaker identification", async () => {
  let embeddingCalls = 0;
  const result = await liveSpeakerIdentifier.routeLegacyMeetingAudio({
    jarvisSessionActive: false,
    meetingLiveSpeakerActive: true,
    pcmBuffer: Buffer.alloc(320),
    feedAudio: async () => {
      embeddingCalls += 1;
      return "fed";
    },
  });

  assert.equal(result, "fed");
  assert.equal(embeddingCalls, 1);
});
