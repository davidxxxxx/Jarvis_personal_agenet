const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const TranscriptReconciler = require("../../src/jarvis/main/TranscriptReconciler");

function fixture(t, { sources = ["mic"] } = {}) {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({
    id: "session-1",
    startedAt: 0,
    micDeviceId: sources.includes("mic") ? "physical-mic" : null,
    captureMode: sources.length === 2 ? "dual" : sources[0],
  });
  for (const sourceType of sources) {
    repository.createTrack({
      id: `track-${sourceType}`,
      sessionId: "session-1",
      sourceType,
      deviceId: sourceType === "mic" ? "physical-mic" : null,
      deviceLabel: sourceType === "mic" ? "Desk microphone" : "PC audio",
      strategy: sourceType === "mic" ? "web-audio" : "wasapi-loopback",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 0,
    });
  }
  return {
    repository,
    reconciler: new TranscriptReconciler({ repository }),
  };
}

function provisional(repository, {
  id,
  startedAt,
  endedAt,
  sourceType = "mic",
  text = id,
}) {
  repository.upsertTranscriptSegments("session-1", [
    {
      id,
      startedAt,
      endedAt,
      personId: null,
      speakerLabel: sourceType,
      sourceType,
      text,
      confidence: 0.6,
      isStable: true,
    },
  ]);
  return repository.getTranscriptSegment(id);
}

function final(repository, {
  chunkId,
  startedAt,
  endedAt,
  sourceType = "mic",
  modelVersion = "large-v3-turbo",
  completedAt = endedAt + 1_000,
  sequenceNumber = 0,
  text = chunkId,
}) {
  const chunk = {
    id: chunkId,
    sessionId: "session-1",
    trackId: `track-${sourceType}`,
    sourceType,
    sequenceNumber,
    path: `${chunkId}.wav`,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    sha256: crypto.createHash("sha256").update(chunkId).digest("hex"),
    expiresAt: 1_000_000,
  };
  repository.commitChunk(chunk);
  return repository.commitChunkTranscript({
    chunk: repository.getAudioChunk(chunkId),
    result: { text, confidence: 0.95 },
    modelVersion,
    completedAt,
  });
}

test("final transcript supersedes all same-track strict overlaps without deleting history", (t) => {
  const { repository, reconciler } = fixture(t);
  provisional(repository, { id: "p1", startedAt: 100, endedAt: 130 });
  provisional(repository, { id: "p2", startedAt: 130, endedAt: 170 });
  const finalSegment = final(repository, {
    chunkId: "chunk-1",
    startedAt: 110,
    endedAt: 160,
  });

  assert.deepEqual(reconciler.reconcileSession("session-1"), {
    inserted: 0,
    superseded: 2,
    unchanged: 0,
  });
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    [finalSegment.id]
  );
  assert.deepEqual(
    repository.listTranscriptHistory("session-1").map((row) => [row.id, row.superseded_by]),
    [
      ["p1", finalSegment.id],
      [finalSegment.id, null],
      ["p2", finalSegment.id],
    ]
  );
});

test("strict half-open overlap preserves exact boundaries and the non-overlap tail", (t) => {
  const { repository, reconciler } = fixture(t);
  provisional(repository, { id: "before", startedAt: 0, endedAt: 10 });
  provisional(repository, { id: "inside", startedAt: 10, endedAt: 20 });
  provisional(repository, { id: "tail", startedAt: 20, endedAt: 30 });
  const finalSegment = final(repository, {
    chunkId: "chunk-boundary",
    startedAt: 10,
    endedAt: 20,
  });

  reconciler.reconcileSession("session-1");

  assert.equal(repository.getTranscriptSegment("before").superseded_by, null);
  assert.equal(repository.getTranscriptSegment("inside").superseded_by, finalSegment.id);
  assert.equal(repository.getTranscriptSegment("tail").superseded_by, null);
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    ["before", finalSegment.id, "tail"]
  );
});

test("same time windows on another track are never superseded", (t) => {
  const { repository, reconciler } = fixture(t, { sources: ["mic", "system"] });
  provisional(repository, {
    id: "system-provisional",
    startedAt: 100,
    endedAt: 200,
    sourceType: "system",
  });
  final(repository, { chunkId: "mic-final", startedAt: 100, endedAt: 200 });

  assert.deepEqual(reconciler.reconcileSession("session-1"), {
    inserted: 0,
    superseded: 0,
    unchanged: 1,
  });
  assert.equal(repository.getTranscriptSegment("system-provisional").superseded_by, null);
});

test("repeat reconciliation is idempotent", (t) => {
  const { repository, reconciler } = fixture(t);
  provisional(repository, { id: "repeat", startedAt: 100, endedAt: 200 });
  const finalSegment = final(repository, {
    chunkId: "repeat-final",
    startedAt: 100,
    endedAt: 200,
  });

  assert.equal(reconciler.reconcileSession("session-1").superseded, 1);
  assert.deepEqual(reconciler.reconcileSession("session-1"), {
    inserted: 0,
    superseded: 0,
    unchanged: 1,
  });
  assert.equal(repository.getTranscriptSegment("repeat").superseded_by, finalSegment.id);
});

test("a deterministic newest final wins regardless of insertion order", (t) => {
  const run = (suffix, order) => {
    const repository = new JarvisRepository(":memory:");
    t.after(() => repository.close());
    repository.createSession({
      id: `session-${suffix}`,
      startedAt: 0,
      micDeviceId: "physical-mic",
      captureMode: "mic",
    });
    repository.createTrack({
      id: `track-${suffix}`,
      sessionId: `session-${suffix}`,
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 0,
    });
    repository.upsertTranscriptSegments(`session-${suffix}`, [{
      id: `provisional-${suffix}`,
      startedAt: 100,
      endedAt: 200,
      personId: null,
      speakerLabel: "mic",
      sourceType: "mic",
      text: "preview",
      confidence: 0.5,
      isStable: true,
    }]);
    const chunk = {
      id: `chunk-${suffix}`,
      sessionId: `session-${suffix}`,
      trackId: `track-${suffix}`,
      sourceType: "mic",
      sequenceNumber: 0,
      path: `chunk-${suffix}.wav`,
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      sha256: crypto.createHash("sha256").update(suffix).digest("hex"),
      expiresAt: 1_000_000,
    };
    repository.commitChunk(chunk);
    const finals = new Map();
    for (const version of order) {
      finals.set(version, repository.commitChunkTranscript({
        chunk: repository.getAudioChunk(chunk.id),
        result: { text: version, confidence: 0.9 },
        modelVersion: version,
        completedAt: version === "older" ? 300 : 400,
      }));
    }
    new TranscriptReconciler({ repository }).reconcileSession(`session-${suffix}`);
    return {
      supersededBy: repository.getTranscriptSegment(`provisional-${suffix}`).superseded_by,
      expected: finals.get("newer").id,
    };
  };

  const forward = run("forward", ["older", "newer"]);
  const reverse = run("reverse", ["newer", "older"]);
  assert.equal(forward.supersededBy, forward.expected);
  assert.equal(reverse.supersededBy, reverse.expected);
});

test("renderer snapshots cannot overwrite a colliding final id or delete stale finals", (t) => {
  const { repository } = fixture(t);
  provisional(repository, { id: "stale", startedAt: 1, endedAt: 2 });
  const finalSegment = final(repository, {
    chunkId: "collision-final",
    startedAt: 100,
    endedAt: 200,
    text: "authoritative final",
  });

  repository.syncTranscriptSegments("session-1", [{
    id: finalSegment.id,
    startedAt: 300,
    endedAt: 301,
    personId: null,
    speakerLabel: "mic",
    sourceType: "mic",
    text: "hostile stale preview",
    confidence: 0.1,
    isStable: true,
  }]);

  assert.deepEqual(repository.getTranscriptSegment(finalSegment.id), finalSegment);
  assert.equal(repository.getTranscriptSegment("stale"), null);
  repository.syncTranscriptSegments("session-1", []);
  assert.deepEqual(repository.getTranscriptSegment(finalSegment.id), finalSegment);
});
