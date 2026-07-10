const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceEnrollmentService = require("../../src/jarvis/main/VoiceEnrollmentService");
const {
  CAPTURE_SAMPLE_RATE,
  SELF_VOICE_PROFILE_ID,
} = require("../../src/jarvis/main/VoiceEnrollmentService");

const OWNER_ID = 41;
const WINDOW_SAMPLES = CAPTURE_SAMPLE_RATE * 8;

function speechWindow(index, length = WINDOW_SAMPLES) {
  const startSample = index * WINDOW_SAMPLES;
  return {
    startSample,
    endSample: startSample + length,
    samples: new Float32Array(length).fill((index + 1) / 10),
  };
}

function validPayload(overrides = {}) {
  return {
    sampleRate: CAPTURE_SAMPLE_RATE,
    channels: 1,
    format: "float32",
    recordedSampleCount: CAPTURE_SAMPLE_RATE * 30,
    windows: [speechWindow(0), speechWindow(1), speechWindow(2)],
    ...overrides,
  };
}

function createService({ embeddings, now = 1_000, profileId = SELF_VOICE_PROFILE_ID } = {}) {
  const savedProfiles = [];
  const renamedPeople = [];
  const extractedWindows = [];
  let currentTime = now;
  let nextEmbedding = 0;
  const deterministicEmbeddings = embeddings ?? [
    new Float32Array([1, 2, 3]),
    new Float32Array([4, 5, 6]),
    new Float32Array([7, 8, 9]),
  ];
  const service = new VoiceEnrollmentService({
    speakerEmbeddings: {
      extractEmbeddingFromSamples: async (samples) => {
        extractedWindows.push(samples);
        return deterministicEmbeddings[nextEmbedding++] ?? null;
      },
      computeCentroid(items) {
        const centroid = new Float32Array(items[0].length);
        for (const item of items) {
          for (let index = 0; index < item.length; index += 1) centroid[index] += item[index];
        }
        for (let index = 0; index < centroid.length; index += 1) centroid[index] /= items.length;
        return centroid;
      },
    },
    databaseManager: {
      upsertSpeakerProfile(name, email, embedding, requestedProfileId) {
        savedProfiles.push({ name, email, embedding, requestedProfileId });
        return { id: profileId };
      },
    },
    repository: {
      renamePerson(input) {
        renamedPeople.push(input);
        return { id: input.personId };
      },
    },
    createId: () => "opaque-enrollment-id",
    now: () => currentTime,
  });
  return {
    service,
    savedProfiles,
    renamedPeople,
    extractedWindows,
    advance(ms) {
      currentTime += ms;
    },
  };
}

async function begin(service, ownerId = OWNER_ID) {
  return service.begin({ ownerId });
}

test("begins an opaque owner-bound 24 kHz mono Float32 enrollment session", () => {
  const { service } = createService();

  const session = service.begin({ ownerId: OWNER_ID });

  assert.deepEqual(session, {
    sessionId: "opaque-enrollment-id",
    expiresAt: 121_000,
    sampleRate: 24_000,
    channels: 1,
    format: "float32",
    targetDurationSeconds: 30,
  });
});

test("saves three downsampled embeddings to the reserved self profile exactly once", async () => {
  const { service, savedProfiles, renamedPeople, extractedWindows } = createService();
  const session = await begin(service);

  const result = await service.complete({
    ownerId: OWNER_ID,
    sessionId: session.sessionId,
    payload: validPayload(),
  });

  assert.equal(result.profileId, SELF_VOICE_PROFILE_ID);
  assert.deepEqual(
    extractedWindows.map((samples) => samples.length),
    [16_000 * 8, 16_000 * 8, 16_000 * 8]
  );
  assert.equal(savedProfiles.length, 1);
  assert.equal(savedProfiles[0].name, "我");
  assert.equal(savedProfiles[0].email, null);
  assert.equal(savedProfiles[0].requestedProfileId, SELF_VOICE_PROFILE_ID);
  assert.deepEqual(
    Array.from(
      new Float32Array(
        savedProfiles[0].embedding.buffer,
        savedProfiles[0].embedding.byteOffset,
        savedProfiles[0].embedding.byteLength / Float32Array.BYTES_PER_ELEMENT
      )
    ),
    [4, 5, 6]
  );
  assert.deepEqual(renamedPeople, [
    {
      personId: "self",
      displayName: "我",
      isSelf: true,
      voiceProfileId: SELF_VOICE_PROFILE_ID,
    },
  ]);
  await assert.rejects(
    service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload: validPayload() }),
    /unknown enrollment session/
  );
});

test("rejects unknown, foreign-owner, expired, and cancelled enrollment sessions", async () => {
  const harness = createService();
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: "unknown",
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );

  const foreign = await begin(harness.service);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID + 1,
      sessionId: foreign.sessionId,
      payload: validPayload(),
    }),
    /does not belong to this renderer/
  );

  harness.service.cancel({ ownerId: OWNER_ID, sessionId: foreign.sessionId });
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: foreign.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );

  const expired = await begin(harness.service);
  harness.advance(120_001);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: expired.sessionId,
      payload: validPayload(),
    }),
    /enrollment session expired/
  );
});

test("rejects wrong sample rate, channels, or sample format before embedding", async (t) => {
  for (const [field, value] of [
    ["sampleRate", 16_000],
    ["channels", 2],
    ["format", "int16"],
  ]) {
    await t.test(`${field}=${value}`, async () => {
      const { service, extractedWindows } = createService();
      const session = await begin(service);
      await assert.rejects(
        service.complete({
          ownerId: OWNER_ID,
          sessionId: session.sessionId,
          payload: validPayload({ [field]: value }),
        }),
        /24 kHz mono Float32/
      );
      assert.equal(extractedWindows.length, 0);
    });
  }
});

test("rejects NaN, Infinity, and out-of-range PCM before embedding", async (t) => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.01, -1.01]) {
    await t.test(String(value), async () => {
      const { service, extractedWindows } = createService();
      const session = await begin(service);
      const payload = validPayload();
      payload.windows[1].samples[10] = value;
      await assert.rejects(
        service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload }),
        /finite normalized PCM/
      );
      assert.equal(extractedWindows.length, 0);
    });
  }
});

test("rejects undersized, oversized, overlapping, and implausible-duration payloads", async (t) => {
  const cases = [
    {
      name: "undersized",
      mutate(payload) {
        const short = speechWindow(2, CAPTURE_SAMPLE_RATE * 7);
        payload.windows[2] = short;
      },
      pattern: /at least 24 seconds/,
    },
    {
      name: "oversized",
      mutate(payload) {
        const size = CAPTURE_SAMPLE_RATE * 9;
        payload.windows = [speechWindow(0, size), speechWindow(1, size), speechWindow(2, size)];
      },
      pattern: /payload cap/,
    },
    {
      name: "overlapping",
      mutate(payload) {
        payload.windows[1].startSample = payload.windows[0].endSample - 1;
        payload.windows[1].endSample = payload.windows[1].startSample + WINDOW_SAMPLES;
      },
      pattern: /must not overlap/,
    },
    {
      name: "too short guided capture",
      mutate(payload) {
        payload.recordedSampleCount = CAPTURE_SAMPLE_RATE * 28;
      },
      pattern: /approximately 30 seconds/,
    },
    {
      name: "too long guided capture",
      mutate(payload) {
        payload.recordedSampleCount = CAPTURE_SAMPLE_RATE * 32;
      },
      pattern: /approximately 30 seconds/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { service, extractedWindows } = createService();
      const session = await begin(service);
      const payload = validPayload();
      entry.mutate(payload);
      await assert.rejects(
        service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload }),
        entry.pattern
      );
      assert.equal(extractedWindows.length, 0);
    });
  }
});

test("rejects fewer than three valid embeddings and a mismatched returned profile id", async () => {
  const missing = createService({
    embeddings: [new Float32Array([1, 2]), null, new Float32Array([3, 4])],
  });
  const missingSession = await begin(missing.service);
  await assert.rejects(
    missing.service.complete({
      ownerId: OWNER_ID,
      sessionId: missingSession.sessionId,
      payload: validPayload(),
    }),
    /three valid speech samples/
  );
  assert.equal(missing.savedProfiles.length, 0);

  const mismatched = createService({ profileId: 12 });
  const mismatchedSession = await begin(mismatched.service);
  await assert.rejects(
    mismatched.service.complete({
      ownerId: OWNER_ID,
      sessionId: mismatchedSession.sessionId,
      payload: validPayload(),
    }),
    /reserved self profile/
  );
  assert.equal(mismatched.renamedPeople.length, 0);
});
