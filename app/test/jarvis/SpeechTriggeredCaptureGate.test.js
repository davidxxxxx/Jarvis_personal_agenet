const test = require("node:test");
const assert = require("node:assert/strict");

const PcmRingBuffer = require("../../src/jarvis/main/PcmRingBuffer");
const SpeechTriggeredCaptureGate = require("../../src/jarvis/main/SpeechTriggeredCaptureGate");

const SAMPLE_RATE = 24_000;
const BYTES_PER_FRAME = 2;

function pcm(durationMs, amplitude = 0) {
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1_000);
  const output = Buffer.alloc(frames * BYTES_PER_FRAME);
  for (let offset = 0; offset < output.length; offset += BYTES_PER_FRAME) {
    output.writeInt16LE(amplitude, offset);
  }
  return output;
}

function input({ sourceType = "mic", startMs, durationMs = 1_000, speech = false }) {
  return {
    sourceType,
    pcm: pcm(durationMs, speech ? 16_384 : 0),
    capturedAt: startMs,
    speechProbability: speech ? 0.9 : 0.01,
  };
}

function mergeRanges(writes) {
  const ranges = [];
  for (const write of writes) {
    const previous = ranges.at(-1);
    if (previous && previous.endMs === write.startedAt) {
      previous.endMs = write.endedAt;
    } else {
      ranges.push({ startMs: write.startedAt, endMs: write.endedAt });
    }
  }
  return ranges;
}

test("PcmRingBuffer keeps a hard per-source frame bound and preserves order", () => {
  const ring = new PcmRingBuffer({ capacityFrames: 4, bytesPerFrame: 2 });
  const first = { pcm: Buffer.from([1, 0, 2, 0]), startedAt: 0, endedAt: 2 };
  const second = { pcm: Buffer.from([3, 0, 4, 0]), startedAt: 2, endedAt: 4 };
  const third = { pcm: Buffer.from([5, 0, 6, 0]), startedAt: 4, endedAt: 6 };

  assert.deepEqual(ring.push(first), []);
  assert.deepEqual(ring.push(second), []);
  assert.deepEqual(ring.push(third), [first]);
  assert.equal(ring.frameCount, 4);
  assert.equal(ring.byteLength, 8);
  assert.deepEqual(
    ring.drain().map((entry) => [...entry.pcm]),
    [
      [3, 0, 4, 0],
      [5, 0, 6, 0],
    ]
  );
  assert.equal(ring.frameCount, 0);
});

test("PcmRingBuffer truncates one oversized entry without exceeding its hard bound", () => {
  const ring = new PcmRingBuffer({ capacityFrames: 4, bytesPerFrame: 2 });
  const oversized = {
    pcm: Buffer.from(Array.from({ length: 10 }, (_, index) => [index + 1, 0]).flat()),
    startedAt: 0,
    endedAt: 10,
  };

  const evicted = ring.push(oversized);

  assert.equal(ring.frameCount, 4);
  assert.equal(ring.byteLength, 8);
  assert.deepEqual([...evicted[0].pcm], [1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
  assert.deepEqual([...ring.drain()[0].pcm], [7, 0, 8, 0, 9, 0, 10, 0]);
});

test("retains exactly two seconds before speech and three seconds after it", () => {
  const gate = new SpeechTriggeredCaptureGate({
    sampleRate: SAMPLE_RATE,
    preRollMs: 2_000,
    postRollMs: 3_000,
    mergeGapMs: 3_000,
  });
  const writes = [];
  const gaps = [];

  for (let second = 0; second < 5; second += 1) {
    const decision = gate.accept(input({ startMs: second * 1_000 }));
    writes.push(...decision.writes);
    gaps.push(...decision.gapsToCommit);
  }
  const speech = gate.accept(input({ startMs: 5_000, speech: true }));
  writes.push(...speech.writes);
  gaps.push(...speech.gapsToCommit);
  for (let second = 6; second < 10; second += 1) {
    const decision = gate.accept(input({ startMs: second * 1_000 }));
    writes.push(...decision.writes);
    gaps.push(...decision.gapsToCommit);
  }
  const finished = gate.finish("mic", 10_000);
  writes.push(...finished.writes);
  gaps.push(...finished.gapsToCommit);

  assert.deepEqual(mergeRanges(writes), [{ startMs: 3_000, endMs: 9_000 }]);
  assert.deepEqual(
    gaps.map(({ reason, startedAt, endedAt }) => ({ reason, startedAt, endedAt })),
    [
      { reason: "silence_suppressed", startedAt: 0, endedAt: 3_000 },
      { reason: "silence_suppressed", startedAt: 9_000, endedAt: 10_000 },
    ]
  );
  assert.equal(
    gaps.every((gap) => gap.averageLevel === 0 && gap.peakLevel === 0),
    true
  );
});

test("speech gaps of three seconds remain one retained region", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE });
  const writes = [];
  for (const frame of [
    input({ startMs: 0, speech: true }),
    input({ startMs: 1_000 }),
    input({ startMs: 2_000 }),
    input({ startMs: 3_000 }),
    input({ startMs: 4_000, speech: true }),
  ]) {
    writes.push(...gate.accept(frame).writes);
  }

  assert.deepEqual(mergeRanges(writes), [{ startMs: 0, endMs: 5_000 }]);
});

test("mergeGapMs extends the retained bridge when it is longer than post-roll", () => {
  const gate = new SpeechTriggeredCaptureGate({
    sampleRate: SAMPLE_RATE,
    preRollMs: 0,
    postRollMs: 1_000,
    mergeGapMs: 3_000,
  });
  const writes = [];
  for (let second = 0; second < 4; second += 1) {
    writes.push(...gate.accept(input({ startMs: second * 1_000, speech: second === 0 })).writes);
  }

  assert.deepEqual(mergeRanges(writes), [{ startMs: 0, endMs: 4_000 }]);
});

test("a silence longer than merged context creates two retained ranges and one gap", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE });
  const writes = [];
  const gaps = [];
  for (let second = 0; second < 8; second += 1) {
    const result = gate.accept(
      input({ startMs: second * 1_000, speech: second === 0 || second === 7 })
    );
    writes.push(...result.writes);
    gaps.push(...result.gapsToCommit);
  }

  assert.deepEqual(mergeRanges(writes), [
    { startMs: 0, endMs: 4_000 },
    { startMs: 5_000, endMs: 8_000 },
  ]);
  assert.deepEqual(
    gaps.map(({ reason, startedAt, endedAt }) => ({ reason, startedAt, endedAt })),
    [{ reason: "silence_suppressed", startedAt: 4_000, endedAt: 5_000 }]
  );
});

test("microphone and system audio keep independent bounded context", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE, preRollMs: 2_000 });
  const micWrites = [];
  const systemWrites = [];

  for (let second = 0; second < 4; second += 1) {
    micWrites.push(...gate.accept(input({ sourceType: "mic", startMs: second * 1_000 })).writes);
    systemWrites.push(
      ...gate.accept(input({ sourceType: "system", startMs: second * 1_000, speech: second === 1 }))
        .writes
    );
  }
  micWrites.push(...gate.accept(input({ sourceType: "mic", startMs: 4_000, speech: true })).writes);

  assert.deepEqual(mergeRanges(micWrites), [{ startMs: 2_000, endMs: 5_000 }]);
  assert.deepEqual(mergeRanges(systemWrites), [{ startMs: 0, endMs: 4_000 }]);
  assert.ok(gate.bufferedFrames("mic") <= SAMPLE_RATE * 2);
  assert.ok(gate.bufferedFrames("system") <= SAMPLE_RATE * 2);
});

test("VAD failure fails open, flushes buffered PCM, and records a visible degraded span", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE });
  gate.accept(input({ startMs: 0 }));
  gate.accept(input({ startMs: 1_000 }));
  gate.accept(input({ startMs: 2_000 }));

  const failed = gate.reportVadFailure("mic", new Error("model unavailable"), 3_000);
  assert.equal(gate.mode, "continuous_fallback");
  assert.equal(gate.status().degradedReason, "vad_unavailable");
  assert.deepEqual(mergeRanges(failed.writes), [{ startMs: 1_000, endMs: 3_000 }]);
  assert.deepEqual(
    failed.gapsToCommit.map(({ reason, startedAt, endedAt }) => ({
      reason,
      startedAt,
      endedAt,
    })),
    [{ reason: "silence_suppressed", startedAt: 0, endedAt: 1_000 }]
  );

  const retained = gate.accept(input({ startMs: 3_000 }));
  assert.equal(retained.retain, true);
  assert.deepEqual(mergeRanges(retained.writes), [{ startMs: 3_000, endMs: 4_000 }]);

  const recovered = gate.reportVadRecovered("mic", 4_000);
  assert.equal(gate.mode, "speech_triggered");
  assert.equal(gate.status().degradedReason, null);
  assert.deepEqual(
    recovered.gapsToCommit.map(({ reason, startedAt, endedAt }) => ({
      reason,
      startedAt,
      endedAt,
    })),
    [{ reason: "vad_degraded", startedAt: 3_000, endedAt: 4_000 }]
  );
});

test("continuous mode indexes speech probability without cropping audio", () => {
  const gate = new SpeechTriggeredCaptureGate({
    sampleRate: SAMPLE_RATE,
    mode: "continuous",
  });

  const silence = gate.accept(input({ startMs: 0 }));
  const speech = gate.accept(input({ startMs: 1_000, speech: true }));

  assert.equal(silence.retain, true);
  assert.equal(speech.retain, true);
  assert.deepEqual(mergeRanges([...silence.writes, ...speech.writes]), [
    { startMs: 0, endMs: 2_000 },
  ]);
  assert.equal(gate.status().lastSpeechProbability, 0.9);
});

test("VAD recovery returns an important meeting to requested continuous mode", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE, mode: "continuous" });
  gate.reportVadFailure("mic", new Error("worker restart"), 0);
  gate.accept(input({ startMs: 0 }));

  const recovered = gate.reportVadRecovered("mic", 1_000);

  assert.equal(gate.mode, "continuous");
  assert.equal(gate.status().requestedMode, "continuous");
  assert.deepEqual(
    recovered.gapsToCommit.map(({ reason, startedAt, endedAt }) => ({
      reason,
      startedAt,
      endedAt,
    })),
    [{ reason: "vad_degraded", startedAt: 0, endedAt: 1_000 }]
  );
});

test("suppression levels use sample-weighted normalized RMS and absolute peak", () => {
  const gate = new SpeechTriggeredCaptureGate({ sampleRate: SAMPLE_RATE, preRollMs: 0 });
  const samples = Buffer.alloc(SAMPLE_RATE * BYTES_PER_FRAME);
  for (let frame = 1; frame < SAMPLE_RATE; frame += 2) {
    samples.writeInt16LE(16_384, frame * BYTES_PER_FRAME);
  }

  const accepted = gate.accept({
    sourceType: "mic",
    pcm: samples,
    capturedAt: 0,
    speechProbability: 0,
  });
  const gap = accepted.gapsToCommit[0] ?? gate.finish("mic", 1_000).gapsToCommit[0];

  assert.ok(Math.abs(gap.averageLevel - Math.sqrt(0.125)) < 0.000001);
  assert.equal(gap.peakLevel, 0.5);
});
