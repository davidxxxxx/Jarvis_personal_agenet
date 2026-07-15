const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LIVE_SPEAKER_SCOPES,
  createLiveSpeakerRouter,
} = require("../../src/helpers/liveSpeakerRouting");

function createIdentifierProbe() {
  const calls = [];
  return {
    calls,
    identifier: {
      start(options) {
        calls.push({ operation: "start", options });
        return Promise.resolve(true);
      },
      feedAudio(pcmBuffer) {
        calls.push({ operation: "feed", pcmBuffer });
        return Promise.resolve("fed");
      },
      stop() {
        calls.push({ operation: "stop" });
        return Promise.resolve({ speaker_0: { displayName: "Legacy speaker" } });
      },
    },
  };
}

test("one virtual Jarvis hour routes zero start, mic/system feed, and stop calls", async () => {
  const probe = createIdentifierProbe();
  const router = createLiveSpeakerRouter({ identifier: probe.identifier });
  const options = Object.freeze({ enabled: true });

  assert.equal(await router.start(LIVE_SPEAKER_SCOPES.JARVIS, options), false);
  for (let second = 0; second < 60 * 60; second += 1) {
    assert.equal(
      await router.feed(LIVE_SPEAKER_SCOPES.JARVIS, Buffer.alloc(320, second % 255)),
      null
    );
    assert.equal(
      await router.feed(LIVE_SPEAKER_SCOPES.JARVIS, Buffer.alloc(320, (second + 1) % 255)),
      null
    );
  }
  assert.equal(await router.stop(LIVE_SPEAKER_SCOPES.JARVIS), null);

  assert.deepEqual(probe.calls, []);
});

test("explicit legacy meeting scope delegates start, every mic/system feed, and stop", async () => {
  const probe = createIdentifierProbe();
  const router = createLiveSpeakerRouter({ identifier: probe.identifier });
  const options = Object.freeze({ enabled: true });
  const frames = [];
  for (let second = 0; second < 60 * 60; second += 1) {
    frames.push(Buffer.alloc(8, second % 255), Buffer.alloc(8, (second + 1) % 255));
  }

  assert.equal(await router.start(LIVE_SPEAKER_SCOPES.LEGACY_MEETING, options), true);
  for (const frame of frames) {
    assert.equal(await router.feed(LIVE_SPEAKER_SCOPES.LEGACY_MEETING, frame), "fed");
  }
  assert.deepEqual(await router.stop(LIVE_SPEAKER_SCOPES.LEGACY_MEETING), {
    speaker_0: { displayName: "Legacy speaker" },
  });

  assert.equal(probe.calls[0].operation, "start");
  assert.equal(probe.calls[0].options, options);
  assert.equal(probe.calls.at(-1).operation, "stop");
  assert.equal(probe.calls.filter(({ operation }) => operation === "feed").length, frames.length);
});

test("router rejects every scope except the two exact production scopes", async () => {
  const probe = createIdentifierProbe();
  const router = createLiveSpeakerRouter({ identifier: probe.identifier });

  await assert.rejects(router.start("legacy-meeting", {}), /live speaker scope/i);
  await assert.rejects(router.feed(null, Buffer.alloc(1)), /live speaker scope/i);
  await assert.rejects(router.stop("JARVIS"), /live speaker scope/i);
  assert.deepEqual(probe.calls, []);
});
