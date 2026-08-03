const test = require("node:test");
const assert = require("node:assert/strict");

const ApplicationMixAcousticMatcher = require("../../src/jarvis/main/ApplicationMixAcousticMatcher");

const SAMPLE_RATE = 8_000;

function deterministicEnvelope(frame, seed) {
  let hash = Math.imul(frame + 1, 0x45d9f3b) ^ Math.imul(seed + 17, 0x119de1f3);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  const unit = (hash >>> 0) / 0xffffffff;
  const burst = unit > 0.28 ? 1 : 0.04;
  const contour = 0.2 + unit * 0.78;
  return burst * contour;
}

function speechLike(durationMs, seed) {
  const sampleCount = Math.round((durationMs * SAMPLE_RATE) / 1_000);
  const samples = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const frame = Math.floor(index / (SAMPLE_RATE / 50));
    const envelope = deterministicEnvelope(frame, seed);
    samples[index] =
      envelope *
      (0.65 * Math.sin((2 * Math.PI * (170 + seed * 11) * index) / SAMPLE_RATE) +
        0.25 * Math.sin((2 * Math.PI * (310 + seed * 13) * index) / SAMPLE_RATE));
  }
  return samples;
}

function envelopedTone(durationMs, frequency, seed) {
  const sampleCount = Math.round((durationMs * SAMPLE_RATE) / 1_000);
  const samples = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const frame = Math.floor(index / (SAMPLE_RATE / 50));
    const envelope = 0.3 + deterministicEnvelope(frame, seed) * 0.65;
    samples[index] = envelope * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }
  return samples;
}

function mixWindow(primary, secondary, { startMs, durationMs }) {
  const start = Math.round((startMs * SAMPLE_RATE) / 1_000);
  const count = Math.round((durationMs * SAMPLE_RATE) / 1_000);
  const result = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const primaryValue = primary[start + index] ?? 0;
    const secondaryValue = secondary[start + index] ?? 0;
    const noise = ((((index * 17) % 31) - 15) / 15) * 0.003;
    result[index] = primaryValue * 0.72 + secondaryValue * 0.08 + noise;
  }
  return result;
}

function pcm(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const bounded = Math.max(-1, Math.min(1, samples[index]));
    bytes.writeInt16LE(Math.round(bounded * 30_000), index * 2);
  }
  return { bytes, sampleRate: SAMPLE_RATE, channels: 1 };
}

function chunk(id) {
  return {
    id,
    path: `${id}.flac`,
    format: "flac",
    sha256: id.padEnd(64, "0").slice(0, 64),
    deleted_at: null,
  };
}

test("matches an exact application despite chunk-clock drift, gain, noise and unrelated ASR text", async () => {
  const kook = speechLike(20_000, 3);
  const dota = speechLike(20_000, 11);
  const mixed = mixWindow(kook, dota, { startMs: 3_500, durationMs: 12_000 });
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["kook", chunk("kook")],
    ["dota", chunk("dota")],
  ]);
  const pcms = new Map([
    ["mix", pcm(mixed)],
    ["kook", pcm(kook)],
    ["dota", pcm(dota)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });
  const winner = await matcher.findWinner(
    {
      id: "mixed-segment",
      chunk_id: "mix",
      started_at: 4_500,
      ended_at: 16_500,
      text: "两个女居士",
    },
    [
      {
        id: "kook-segment",
        chunk_id: "kook",
        track_id: "track-kook",
        application_key: "kook",
        attribution_state: "exact",
        started_at: 1_200,
        ended_at: 21_200,
        text: "两个女机师",
      },
      {
        id: "dota-segment",
        chunk_id: "dota",
        track_id: "track-dota",
        application_key: "dota2",
        attribution_state: "exact",
        started_at: 1_200,
        ended_at: 21_200,
        text: "十秒",
      },
    ]
  );

  assert.equal(winner.segment.id, "kook-segment");
  assert.ok(winner.correlation >= 0.88);
  assert.ok(Math.abs(winner.lagMs + 200) <= 20);
  assert.ok(winner.voicedCoverage >= 0.8);
});

test("preserves a mixed row when an application explains only eight of ten seconds", async () => {
  const application = speechLike(8_000, 29);
  const unrelated = speechLike(2_000, 41);
  const mixed = new Float64Array(SAMPLE_RATE * 10);
  mixed.set(unrelated, 0);
  mixed.set(application, unrelated.length);
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["application", chunk("application")],
  ]);
  const pcms = new Map([
    ["mix", pcm(mixed)],
    ["application", pcm(application)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });

  const winner = await matcher.findWinner(
    { id: "mixed", chunk_id: "mix", started_at: 0, ended_at: 10_000 },
    [
      {
        id: "application",
        chunk_id: "application",
        track_id: "track-application",
        application_key: "application",
        attribution_state: "exact",
        started_at: 0,
        ended_at: 8_000,
      },
    ]
  );

  assert.equal(winner, null);
});

test("ranks fuller mixed coverage ahead of a perfect shorter edge alignment", () => {
  const signal = (index) => 2 + Math.sin(index * 0.055) + 0.35 * Math.sin(index * 0.019 + 0.4);
  const mixed = Float64Array.from({ length: 100 }, (_, index) => signal(index));
  const application = Float64Array.from({ length: 100 }, (_, index) => signal(index + 2));

  const alignment = ApplicationMixAcousticMatcher.bestAlignment(mixed, application, {
    mixedStartedAt: 0,
    applicationStartedAt: 0,
    frameMs: 20,
    maxDriftMs: 40,
    minMixedCoverage: 0.98,
    maxUnmatchedMixedMs: 250,
  });

  assert.equal(alignment.shiftFrames, 0);
  assert.equal(alignment.mixedCoverage, 1);
  assert.ok(alignment.correlation >= 0.97);
});

test("rejects a long-row match that leaves more than 250 ms of mixed audio unexplained", () => {
  const application = Float64Array.from(
    { length: 2_940 },
    (_, index) => 2 + Math.sin(index * 0.071) + 0.3 * Math.sin(index * 0.023 + 0.7)
  );
  const mixed = new Float64Array(3_000);
  for (let index = 0; index < 60; index += 1) {
    mixed[index] = 2 + deterministicEnvelope(index, 53);
  }
  mixed.set(application, 60);

  const alignment = ApplicationMixAcousticMatcher.bestAlignment(mixed, application, {
    mixedStartedAt: 0,
    applicationStartedAt: 0,
    frameMs: 20,
    maxDriftMs: 1_200,
    minMixedCoverage: 0.98,
    maxUnmatchedMixedMs: 250,
  });

  assert.equal(alignment, null);
});

test("accepts a matching application with a two-millisecond capture boundary mismatch", async () => {
  const mixed = speechLike(10_000, 31);
  const application = mixed.subarray(0, mixed.length - Math.round(SAMPLE_RATE * 0.002));
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["application", chunk("application")],
  ]);
  const pcms = new Map([
    ["mix", pcm(mixed)],
    ["application", pcm(application)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });

  const winner = await matcher.findWinner(
    { id: "mixed", chunk_id: "mix", started_at: 0, ended_at: 10_000 },
    [
      {
        id: "application",
        chunk_id: "application",
        track_id: "track-application",
        application_key: "application",
        attribution_state: "exact",
        started_at: 0,
        ended_at: 9_998,
      },
    ]
  );

  assert.equal(winner.segment.id, "application");
  assert.ok(winner.correlation >= 0.92);
});

test("rejects a one-second edge match that covers only one sixth of both complete segments", async () => {
  const application = envelopedTone(6_000, 173, 7);
  const mixed = envelopedTone(6_000, 731, 19);
  mixed.set(application.subarray(0, SAMPLE_RATE), mixed.length - SAMPLE_RATE);
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["application", chunk("application")],
  ]);
  const pcms = new Map([
    ["mix", pcm(mixed)],
    ["application", pcm(application)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });

  const winner = await matcher.findWinner(
    { id: "mixed", chunk_id: "mix", started_at: 0, ended_at: 6_000 },
    [
      {
        id: "application",
        chunk_id: "application",
        track_id: "track-application",
        application_key: "application",
        attribution_state: "exact",
        started_at: 0,
        ended_at: 6_000,
      },
    ]
  );

  assert.equal(winner, null);
});

test("rejects different waveforms that share the same RMS amplitude envelope", async () => {
  const mixed = envelopedTone(6_000, 173, 23);
  const application = envelopedTone(6_000, 731, 23);
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["application", chunk("application")],
  ]);
  const pcms = new Map([
    ["mix", pcm(mixed)],
    ["application", pcm(application)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });

  const winner = await matcher.findWinner(
    { id: "mixed", chunk_id: "mix", started_at: 0, ended_at: 6_000 },
    [
      {
        id: "application",
        chunk_id: "application",
        track_id: "track-application",
        application_key: "application",
        attribution_state: "exact",
        started_at: 0,
        ended_at: 6_000,
      },
    ]
  );

  assert.equal(winner, null);
});

test("fails open for unrelated audio or two acoustically indistinguishable applications", async () => {
  const first = speechLike(10_000, 5);
  const unrelated = speechLike(10_000, 17);
  const chunks = new Map([
    ["mix", chunk("mix")],
    ["first", chunk("first")],
    ["same", chunk("same")],
    ["unrelated", chunk("unrelated")],
  ]);
  const pcms = new Map([
    ["mix", pcm(first)],
    ["first", pcm(first)],
    ["same", pcm(first)],
    ["unrelated", pcm(unrelated)],
  ]);
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: { readVerifiedPcm: async (entry) => pcms.get(entry.id) },
    getAudioChunk: (id) => chunks.get(id) ?? null,
  });
  const mixed = {
    id: "mixed",
    chunk_id: "mix",
    started_at: 0,
    ended_at: 10_000,
  };
  const application = (id, chunkId) => ({
    id,
    chunk_id: chunkId,
    track_id: `track-${id}`,
    application_key: id,
    attribution_state: "exact",
    started_at: 0,
    ended_at: 10_000,
  });

  assert.equal(await matcher.findWinner(mixed, [application("unrelated", "unrelated")]), null);
  assert.equal(
    await matcher.findWinner(mixed, [application("first", "first"), application("same", "same")]),
    null
  );
});

test("audio evidence errors preserve both transcript candidates", async () => {
  const matcher = new ApplicationMixAcousticMatcher({
    audioEvidenceReader: {
      async readVerifiedPcm() {
        throw new Error("pcm_hash_mismatch");
      },
    },
    getAudioChunk: (id) => chunk(id),
  });
  const winner = await matcher.findWinner(
    { id: "mixed", chunk_id: "mix", started_at: 0, ended_at: 5_000 },
    [
      {
        id: "app",
        chunk_id: "app",
        track_id: "track-app",
        application_key: "kook",
        attribution_state: "exact",
        started_at: 0,
        ended_at: 5_000,
      },
    ]
  );
  assert.equal(winner, null);
});
