const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveMeetingCaptureMode,
  resolveMeetingCaptureModeWithPlan,
  routeMicOnlyPcm,
} = require("../../src/jarvis/main/meetingCaptureMode");
const {
  MIN_FREE_BYTES,
  requiredFreeBytes,
  hasSafeDiskSpace,
} = require("../../src/jarvis/main/retentionPolicy");

test("Jarvis mic-only mode disables every system-audio strategy", () => {
  assert.deepEqual(resolveMeetingCaptureMode({ micOnly: true }), {
    micOnly: true,
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
});

test("non-Jarvis meetings preserve the resolved upstream system-audio plan", () => {
  assert.deepEqual(
    resolveMeetingCaptureMode(
      {},
      { systemAudioMode: "loopback", systemAudioStrategy: "wasapi-loopback" }
    ),
    {
      micOnly: false,
      systemAudioMode: "loopback",
      systemAudioStrategy: "wasapi-loopback",
    }
  );
});

test("mic-only mode never evaluates the upstream system-audio plan", async () => {
  let planCalls = 0;
  const mode = await resolveMeetingCaptureModeWithPlan({ micOnly: true }, async () => {
    planCalls += 1;
    throw new Error("system-audio planning must be bypassed");
  });

  assert.equal(planCalls, 0);
  assert.deepEqual(mode, {
    micOnly: true,
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
});

test("mic-only PCM reaches each named consumer once using the same buffer", () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  const calls = [];

  routeMicOnlyPcm({
    sessionId: "s1",
    pcmBuffer: pcm,
    appendMicPcm: (sessionId, buffer) => calls.push(["persist", sessionId, buffer]),
    feedSpeaker: (buffer) => calls.push(["speaker", buffer]),
    writeDiarization: (buffer) => calls.push(["diarization", buffer]),
    dispatchTranscription: (buffer, source) => calls.push(["transcription", source, buffer]),
  });

  assert.deepEqual(
    calls.map((call) => call[0]),
    ["persist", "speaker", "diarization", "transcription"]
  );
  assert.equal(calls[0][1], "s1");
  assert.equal(calls[0][2], pcm);
  assert.equal(calls[1][1], pcm);
  assert.equal(calls[2][1], pcm);
  assert.equal(calls[3][1], "mic");
  assert.equal(calls[3][2], pcm);
});

test("disk cutoff is the greater of 5 GB and five percent of the volume", () => {
  assert.equal(MIN_FREE_BYTES, 5 * 1024 ** 3);
  assert.equal(requiredFreeBytes(80 * 1024 ** 3), MIN_FREE_BYTES);
  assert.equal(requiredFreeBytes(200 * 1024 ** 3), 10 * 1024 ** 3);
  assert.equal(
    hasSafeDiskSpace({ freeBytes: MIN_FREE_BYTES - 1, totalBytes: 80 * 1024 ** 3 }),
    false
  );
  assert.equal(hasSafeDiskSpace({ freeBytes: 10 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }), true);
});
