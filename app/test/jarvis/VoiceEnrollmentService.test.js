const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceEnrollmentService = require("../../src/jarvis/main/VoiceEnrollmentService");

const SAMPLE_RATE = 16_000;

function speechWindow(index) {
  const startSample = index * SAMPLE_RATE * 8;
  const endSample = startSample + SAMPLE_RATE * 8;
  return {
    startSample,
    endSample,
    samples: new Float32Array(SAMPLE_RATE * 8).fill((index + 1) / 10),
  };
}

function createService(embeddings) {
  const savedProfiles = [];
  const renamedPeople = [];
  let nextEmbedding = 0;
  const service = new VoiceEnrollmentService({
    speakerEmbeddings: {
      extractEmbeddingFromSamples: async () => embeddings[nextEmbedding++] ?? null,
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
      upsertSpeakerProfile(name, email, embedding) {
        savedProfiles.push({ name, email, embedding });
        return { id: 17 };
      },
    },
    repository: {
      renamePerson(input) {
        renamedPeople.push(input);
        return { id: input.personId };
      },
    },
  });
  return { service, savedProfiles, renamedPeople };
}

test("saves the centroid of three local speech embeddings as the self profile", async () => {
  const { service, savedProfiles, renamedPeople } = createService([
    new Float32Array([1, 2, 3]),
    new Float32Array([4, 5, 6]),
    new Float32Array([7, 8, 9]),
  ]);

  const result = await service.enroll([speechWindow(0), speechWindow(1), speechWindow(2)]);

  assert.equal(result.profileId, 17);
  assert.equal(savedProfiles.length, 1);
  assert.equal(savedProfiles[0].name, "我");
  assert.equal(savedProfiles[0].email, null);
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
    { personId: "self", displayName: "我", isSelf: true, voiceProfileId: 17 },
  ]);
});

test("rejects enrollment when fewer than three windows produce valid embeddings", async () => {
  const { service, savedProfiles, renamedPeople } = createService([
    new Float32Array([1, 2]),
    null,
    new Float32Array([3, 4]),
  ]);

  await assert.rejects(
    service.enroll([speechWindow(0), speechWindow(1), speechWindow(2)]),
    /three valid speech samples/
  );
  assert.equal(savedProfiles.length, 0);
  assert.equal(renamedPeople.length, 0);
});

test("rejects overlapping or undersized sample windows", async () => {
  const { service } = createService([
    new Float32Array([1]),
    new Float32Array([2]),
    new Float32Array([3]),
  ]);
  const overlap = speechWindow(1);
  overlap.startSample = SAMPLE_RATE * 7;
  overlap.endSample = overlap.startSample + overlap.samples.length;

  await assert.rejects(
    service.enroll([speechWindow(0), overlap, speechWindow(2)]),
    /must not overlap/
  );
  await assert.rejects(
    service.enroll([
      {
        ...speechWindow(0),
        endSample: SAMPLE_RATE * 7,
        samples: speechWindow(0).samples.slice(0, SAMPLE_RATE * 7),
      },
      speechWindow(1),
      speechWindow(2),
    ]),
    /at least 24 seconds/
  );
});
