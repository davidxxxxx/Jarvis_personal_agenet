const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceEnrollmentService = require("../../src/jarvis/main/VoiceEnrollmentService");
const {
  CAPTURE_SAMPLE_RATE,
  SELF_VOICE_PROFILE_ID,
} = require("../../src/jarvis/main/VoiceEnrollmentService");

const OWNER_ID = 41;
const WINDOW_SAMPLES = CAPTURE_SAMPLE_RATE * 8;
const EMBEDDING_DIMENSION = 512;

function embedding(value = 1, dimension = EMBEDDING_DIMENSION) {
  return new Float32Array(dimension).fill(value);
}

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

function createService({
  embeddings,
  centroid,
  now = 1_000,
  profileId = SELF_VOICE_PROFILE_ID,
  sessionTtlMs,
  maxActiveSessions,
} = {}) {
  const savedProfiles = [];
  const renamedPeople = [];
  const extractedWindows = [];
  let currentTime = now;
  let nextEmbedding = 0;
  const deterministicEmbeddings = embeddings ?? [embedding(1), embedding(4), embedding(7)];
  let nextId = 0;
  const service = new VoiceEnrollmentService({
    speakerEmbeddings: {
      extractEmbeddingFromSamples: async (samples) => {
        extractedWindows.push(samples);
        return deterministicEmbeddings[nextEmbedding++] ?? null;
      },
      computeCentroid(items) {
        if (centroid !== undefined) return centroid;
        const computed = new Float32Array(items[0].length);
        for (const item of items) {
          for (let index = 0; index < item.length; index += 1) computed[index] += item[index];
        }
        for (let index = 0; index < computed.length; index += 1) computed[index] /= items.length;
        return computed;
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
    createId: () => {
      nextId += 1;
      return nextId === 1 ? "opaque-enrollment-id" : `opaque-enrollment-id-${nextId}`;
    },
    now: () => currentTime,
    ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
    ...(maxActiveSessions === undefined ? {} : { maxActiveSessions }),
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

async function begin(harness, ownerId = OWNER_ID) {
  const session = harness.service.begin({ ownerId });
  harness.advance(30_000);
  return session;
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
  const harness = createService();
  const { service, savedProfiles, renamedPeople, extractedWindows } = harness;
  const session = await begin(harness);

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
    new Array(EMBEDDING_DIMENSION).fill(4)
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

  const foreign = await begin(harness);
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

  const expired = await begin(harness);
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
      const harness = createService();
      const { service, extractedWindows } = harness;
      const session = await begin(harness);
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
      const harness = createService();
      const { service, extractedWindows } = harness;
      const session = await begin(harness);
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
      const harness = createService();
      const { service, extractedWindows } = harness;
      const session = await begin(harness);
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
    embeddings: [embedding(1), null, embedding(3)],
  });
  const missingSession = await begin(missing);
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
  const mismatchedSession = await begin(mismatched);
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

test("attests minimum real elapsed capture time without sleeping", async () => {
  const harness = createService();
  const session = harness.service.begin({ ownerId: OWNER_ID });
  harness.advance(28_999);

  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      payload: validPayload(),
    }),
    /minimum real capture duration/
  );
  assert.equal(harness.extractedWindows.length, 0);

  harness.advance(1);
  const result = await harness.service.complete({
    ownerId: OWNER_ID,
    sessionId: session.sessionId,
    payload: validPayload(),
  });
  assert.equal(result.profileId, SELF_VOICE_PROFILE_ID);
});

test("bounds active sessions per owner and globally while sweeping expiry", () => {
  const harness = createService({ maxActiveSessions: 3, sessionTtlMs: 1_000 });
  const first = harness.service.begin({ ownerId: 1 });
  assert.throws(() => harness.service.begin({ ownerId: 1 }), /already active/);
  harness.service.begin({ ownerId: 2 });
  harness.service.begin({ ownerId: 3 });
  assert.throws(() => harness.service.begin({ ownerId: 4 }), /capacity/);

  harness.advance(1_001);
  const replacement = harness.service.begin({ ownerId: 1 });
  assert.notEqual(replacement.sessionId, first.sessionId);
  assert.doesNotThrow(() => harness.service.begin({ ownerId: 4 }));
});

test("cancelOwner clears renderer-owned sessions and completion consumes invalid payloads", async () => {
  const harness = createService();
  const destroyed = harness.service.begin({ ownerId: OWNER_ID });
  assert.equal(harness.service.cancelOwner(OWNER_ID), 1);
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: destroyed.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );

  const invalid = await begin(harness);
  const payload = validPayload();
  payload.windows[0].samples[0] = Number.NaN;
  await assert.rejects(
    harness.service.complete({ ownerId: OWNER_ID, sessionId: invalid.sessionId, payload }),
    /finite normalized PCM/
  );
  await assert.rejects(
    harness.service.complete({
      ownerId: OWNER_ID,
      sessionId: invalid.sessionId,
      payload: validPayload(),
    }),
    /unknown enrollment session/
  );
});

test("zeroes main-owned PCM after a completion validation failure", async () => {
  const harness = createService();
  const session = await begin(harness);
  const payload = validPayload();
  payload.windows[1].samples[5] = Number.NaN;

  await assert.rejects(
    harness.service.complete({ ownerId: OWNER_ID, sessionId: session.sessionId, payload }),
    /finite normalized PCM/
  );

  assert.equal(
    payload.windows.every((entry) => entry.samples.every((sample) => sample === 0)),
    true
  );
});

test("rejects malformed 512-dimensional embeddings and centroids before persistence", async (t) => {
  const malformedEmbeddings = [
    ["short", embedding(1, 511)],
    ["long", embedding(1, 513)],
    ["NaN", Object.assign(embedding(1), { 8: Number.NaN })],
    ["Infinity", Object.assign(embedding(1), { 8: Number.POSITIVE_INFINITY })],
  ];
  for (const [name, badEmbedding] of malformedEmbeddings) {
    await t.test(name, async () => {
      const harness = createService({ embeddings: [badEmbedding, embedding(2), embedding(3)] });
      const session = await begin(harness);
      await assert.rejects(
        harness.service.complete({
          ownerId: OWNER_ID,
          sessionId: session.sessionId,
          payload: validPayload(),
        }),
        /512 finite Float32 values/
      );
      assert.equal(harness.savedProfiles.length, 0);
    });
  }

  for (const [name, badCentroid] of [
    ["short centroid", embedding(1, 511)],
    ["long centroid", embedding(1, 513)],
    ["NaN centroid", Object.assign(embedding(1), { 3: Number.NaN })],
    ["Infinity centroid", Object.assign(embedding(1), { 3: Number.POSITIVE_INFINITY })],
  ]) {
    await t.test(name, async () => {
      const harness = createService({ centroid: badCentroid });
      const session = await begin(harness);
      await assert.rejects(
        harness.service.complete({
          ownerId: OWNER_ID,
          sessionId: session.sessionId,
          payload: validPayload(),
        }),
        /centroid must contain 512 finite Float32 values/
      );
      assert.equal(harness.savedProfiles.length, 0);
    });
  }
});
