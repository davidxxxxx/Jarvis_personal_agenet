const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveMeetingCaptureMode,
  resolveMeetingCaptureModeWithPlan,
  routeMicOnlyPcm,
  dispatchRealtimePcm,
  settleMeetingPrepareBeforeStart,
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

test("quiet mic-only PCM reaches realtime streaming with identical Buffer identity and bytes", () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  const received = [];

  routeMicOnlyPcm({
    sessionId: "s1",
    pcmBuffer: pcm,
    appendMicPcm() {},
    feedSpeaker() {},
    writeDiarization() {},
    dispatchTranscription: (buffer, source) =>
      dispatchRealtimePcm({
        buffer,
        source,
        preserveExactInput: true,
        transformMicBuffer: () => Buffer.alloc(buffer.length),
        streaming: {
          sendAudio(outbound) {
            received.push(outbound);
            return true;
          },
        },
      }),
  });

  assert.equal(received.length, 1);
  assert.equal(received[0], pcm);
  assert.deepEqual([...received[0]], [1, 0, 2, 0]);
});

test("normal realtime mic dispatch retains upstream buffer transformation", () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  let received = null;

  dispatchRealtimePcm({
    buffer: pcm,
    source: "mic",
    preserveExactInput: false,
    transformMicBuffer: (buffer) => Buffer.alloc(buffer.length),
    streaming: {
      sendAudio(outbound) {
        received = outbound;
        return true;
      },
    },
  });

  assert.notEqual(received, pcm);
  assert.deepEqual([...received], [0, 0, 0, 0]);
});

test("mic-only start cancels an incompatible in-flight prepare without awaiting or planning system audio", async () => {
  let cancelCalls = 0;
  let systemPlanCalls = 0;
  const neverSettles = new Promise(() => {});

  const result = await Promise.race([
    settleMeetingPrepareBeforeStart({
      options: { micOnly: true },
      activePrepare: { micOnly: false, promise: neverSettles },
      cancelIncompatible: () => {
        cancelCalls += 1;
      },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("mic-only start awaited incompatible prepare")), 50)
    ),
  ]);
  const mode = await resolveMeetingCaptureModeWithPlan({ micOnly: true }, async () => {
    systemPlanCalls += 1;
    return { mode: "native", strategy: "native" };
  });

  assert.equal(result, "cancelled");
  assert.equal(cancelCalls, 1);
  assert.equal(systemPlanCalls, 0);
  assert.equal(mode.systemAudioMode, "unsupported");
});

test("normal start continues to await a compatible in-flight prepare", async () => {
  let releasePrepare;
  const preparePromise = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  let settled = false;
  const waiting = settleMeetingPrepareBeforeStart({
    options: { micOnly: false },
    activePrepare: { micOnly: false, promise: preparePromise },
    cancelIncompatible() {
      throw new Error("compatible prepare must not be cancelled");
    },
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releasePrepare();
  assert.equal(await waiting, "awaited");
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
