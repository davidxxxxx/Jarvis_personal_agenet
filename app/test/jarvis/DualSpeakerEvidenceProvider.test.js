const assert = require("node:assert/strict");
const test = require("node:test");

const DualSpeakerEvidenceProvider = require("../../src/jarvis/main/DualSpeakerEvidenceProvider");

function vector(index) {
  const value = new Float32Array(192);
  value[index] = 1;
  return value;
}

function windows({ attributionState = "exact", overlap = false } = {}) {
  return [0, 1, 2].map((index) => ({
    id: `turn-${index}`,
    startMs: 1_000 + index * 5_000,
    endMs: 6_000 + index * 5_000,
    attributionState,
    trackKind: attributionState === "exact" ? "mic" : "system_mix",
    overlapDetected: overlap && index === 1,
    echoDetected: false,
    excludedFromCentroid: false,
    chunk: {
      id: `chunk-${index}`,
      started_at: 1_000 + index * 5_000,
      ended_at: 6_000 + index * 5_000,
      expires_at: 99_000,
      path: `G:\\private\\chunk-${index}.wav`,
      format: "wav",
      pcm_sha256: "a".repeat(64),
    },
  }));
}

function runtime(baseIndex) {
  let call = 0;
  return {
    calls: [],
    async extractEmbedding(path, startSec, endSec) {
      this.calls.push({ path, startSec, endSec });
      return vector(baseIndex + call++);
    },
  };
}

function harness(inputWindows = windows()) {
  const persisted = [];
  const primary = runtime(0);
  const review = runtime(10);
  const provider = new DualSpeakerEvidenceProvider({
    repository: {
      listSpeakerIdentityAudioWindows: () => inputWindows,
      replaceSpeakerClusterModelEmbeddings(input) {
        persisted.push({
          ...input,
          models: input.models.map((entry) => ({
            ...entry,
            embedding: Float32Array.from(entry.embedding),
          })),
        });
        return input.models.map((entry) => ({ modelId: entry.modelId }));
      },
    },
    audioEvidenceReader: {
      async withVerifiedWav(chunk, consume) {
        return consume(chunk.path);
      },
    },
    primaryEmbeddings: primary,
    reviewEmbeddings: review,
  });
  return { provider, persisted, primary, review };
}

test("provider extracts three exact non-overlapping windows in both isolated model spaces", async () => {
  const current = harness();
  const result = await current.provider.buildClusterEvidence({
    sessionId: "s1",
    evidenceRunId: "run1",
    clusterId: "c1",
    createdAt: 50_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.speechMs, 15_000);
  assert.equal(result.windowCount, 3);
  assert.equal(current.primary.calls.length, 3);
  assert.equal(current.review.calls.length, 3);
  assert.equal(current.persisted.length, 1);
  assert.equal(current.persisted[0].models.every((entry) => entry.embedding.length === 192), true);
});

test("provider does not run identity inference for mixed attribution or insufficient safe windows", async () => {
  const mixed = harness(windows({ attributionState: "mixed_unknown" }));
  assert.equal(
    (await mixed.provider.buildClusterEvidence({
      sessionId: "s",
      evidenceRunId: "r",
      clusterId: "c",
      createdAt: 1,
    })).reason,
    "source_unknown"
  );
  assert.equal(mixed.primary.calls.length, 0);

  const overlap = harness(windows({ overlap: true }));
  assert.equal(
    (await overlap.provider.buildClusterEvidence({
      sessionId: "s",
      evidenceRunId: "r",
      clusterId: "c",
      createdAt: 1,
    })).reason,
    "overlapping_speech"
  );
  assert.equal(overlap.persisted.length, 0);
});
