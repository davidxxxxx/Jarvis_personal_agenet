const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mainRoot = path.resolve(__dirname, "../../src/jarvis/main");
const evidence = require("../../src/jarvis/main/speakers/SpeakerEvidenceSelection");
const analysis = require("../../src/jarvis/main/analysis/MemoryRepositorySupport");
const {
  createCommittedAudioPreviewExecutor,
} = require("../../src/jarvis/main/runtime/CommittedAudioPreview");
const { toPublicDailyDigestStatus } = require("../../src/jarvis/main/ipc/PublicDailyDigestViews");
const { toPublicActivityClassification } = require("../../src/jarvis/main/ipc/PublicEntityViews");

test("extracted leaf modules never import their parent orchestration or UI", () => {
  for (const directory of ["ipc", "analysis", "speakers", "runtime"]) {
    for (const file of fs.readdirSync(path.join(mainRoot, directory))) {
      if (!file.endsWith(".js")) continue;
      const source = fs.readFileSync(path.join(mainRoot, directory, file), "utf8");
      const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/gu)].map((m) => m[1]);
      for (const imported of imports) {
        assert.doesNotMatch(
          imported,
          /(?:^|\/)(?:JarvisProcessingRuntime|JarvisRepository|MemoryRepository|registerJarvisIpc)(?:\.js)?$/u,
          file
        );
        assert.doesNotMatch(imported, /(?:renderer|main\.js)/u, file);
      }
    }
  }
});

test("legacy runtime exports are the exact new implementations", () => {
  const legacy = require("../../src/jarvis/main/JarvisProcessingRuntime");
  const core = require("../../src/jarvis/main/runtime/ProcessingRuntime");
  const factory = require("../../src/jarvis/main/runtime/createProcessingRuntime");
  assert.equal(legacy.JarvisProcessingRuntime, core.JarvisProcessingRuntime);
  assert.equal(legacy.createJarvisProcessingRuntime, factory.createJarvisProcessingRuntime);
  assert.equal(legacy.shouldEnableOverlapSeparation, factory.shouldEnableOverlapSeparation);
  assert.equal(legacy.createCommittedAudioPreviewExecutor, createCommittedAudioPreviewExecutor);
});

test("speaker selection pools generations, excludes virtual tracks and preserves fallback coverage", () => {
  const tracks = [
    { id: "mic", track_kind: "microphone" },
    { id: "mix", track_kind: "system_mix" },
    ...[1, 2].map((n) => ({
      id: `kook${n}`,
      track_kind: "application",
      attribution_state: "exact",
      application_key: "kook",
      capture_generation: n,
    })),
    {
      id: "virtual",
      track_kind: "application",
      attribution_state: "exact",
      application_key: "audiodg",
      application_display_name: "audiodg",
    },
  ];
  const chunks = [
    { track_id: "mix", started_at: 0, ended_at: 60000, duration_ms: 60000 },
    { track_id: "kook1", started_at: 0, ended_at: 30000, duration_ms: 30000 },
    { track_id: "kook2", started_at: 30000, ended_at: 60000, duration_ms: 30000 },
    { track_id: "virtual", started_at: 0, ended_at: 60000, duration_ms: 60000 },
  ];
  const original = JSON.stringify({ tracks, chunks });
  const selected = evidence.preferredSpeakerEvidenceTracks(tracks, chunks);
  assert.deepEqual(
    selected.preferred.map((t) => t.id),
    ["mic", "kook1"]
  );
  assert.deepEqual([...selected.logicalMemberTrackIdsByCanonical.get("kook1")], ["kook1", "kook2"]);
  assert.equal(selected.coverageBySystemTrack.get("mix"), 1);
  assert.equal(JSON.stringify({ tracks, chunks }), original);
  const incomplete = evidence.preferredSpeakerEvidenceTracks(
    tracks,
    chunks.filter((c) => c.track_id !== "kook2")
  );
  assert.deepEqual(
    incomplete.preferred.map((t) => t.id),
    ["mic", "mix"]
  );
});

test("public speaker quality and coverage retain conservative boundaries", () => {
  assert.equal(
    evidence.isPublicSpeakerCluster({ speechMs: 4999, windowCount: 3, qualityScore: 0.99 }),
    false
  );
  assert.equal(
    evidence.isPublicSpeakerCluster({ speechMs: 5000, windowCount: 3, qualityScore: 0.72 }),
    true
  );
  assert.equal(evidence.isPublicSpeakerCluster({ linkState: "confirmed" }), true);
  assert.equal(
    evidence.coveredAudioRatio(
      [{ started_at: 0, ended_at: 100 }],
      [
        { started_at: 0, ended_at: 50 },
        { started_at: 25, ended_at: 75 },
      ]
    ),
    0.75
  );
});

test("analysis canonicalization, hashes and input validation remain independent of SQLite", () => {
  assert.equal(analysis.canonicalJson({ b: [2, 1], a: "中" }), '{"a":"中","b":[2,1]}');
  const digest = analysis.sha256("fixture");
  assert.equal(analysis.safeHashEqual(digest, digest), true);
  assert.equal(analysis.safeHashEqual("bad", "bad"), false);
  assert.equal(
    analysis.publicAnalysisErrorCode("ANALYSIS_MANUAL_RETRY_AUTHORIZED", "network"),
    "offline"
  );
  assert.equal(analysis.publicAnalysisErrorCode("private failure detail", null), "analysis_failed");
  assert.throws(() => analysis.assertLocalDate("2025-02-29"), /real calendar date/);
  assert.equal(analysis.assertLocalDate("2024-02-29"), "2024-02-29");
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => analysis.assertJsonObject(cyclic, "candidate"), /cycles/);
});

test("IPC projections omit raw application metadata and fail closed on unknown status", () => {
  const entry = toPublicActivityClassification({
    id: "activity-1",
    sessionId: "session-1",
    privatePath: "private",
    evidence: { applicationKeys: ["KOOK", "G:\\private\\app.exe"], evidenceSegmentIds: [] },
  });
  assert.deepEqual(entry.applications, ["KOOK"]);
  assert.equal(Object.hasOwn(entry, "privatePath"), false);
  assert.deepEqual(toPublicDailyDigestStatus({ state: "unexpected", errorCode: "private error" }), {
    state: "blocked",
    retryable: false,
    errorCode: "generation_failed",
    nextRetryAt: null,
    attemptCount: 0,
  });
});

function previewExecutor(device = "cuda") {
  return createCommittedAudioPreviewExecutor({
    repository: {
      getSession: () => ({ started_at: 1000 }),
      listPreviewTranscriptContext: () => [],
    },
    previewAudioRing: {
      withPreviewWav: async (range, operation) =>
        operation({ ...range, path: "fixture.wav", sha256: "fixture", sourceType: "mic" }),
    },
    transcribeWav: async () => ({
      executionDevice: device,
      success: true,
      text: "你好 hello",
      confidence: 0.9,
    }),
  });
}

test("committed preview preserves timeline and never accepts an unexpected inference device", async () => {
  const input = {
    sessionId: "session-1",
    trackId: "mic",
    fromMs: 0,
    throughMs: 1000,
    executionDevice: "cuda",
  };
  const result = await previewExecutor()(input);
  assert.equal(result.segments[0].startedAt, 1000);
  assert.equal(result.segments[0].endedAt, 2000);
  assert.equal(result.segments[0].text, "你好 hello");
  assert.equal(result.segments[0].isStable, false);
  assert.equal(result.segments[0].personId, null);
  await assert.rejects(previewExecutor("cpu")(input), /EXECUTION_DEVICE_MISMATCH/);
  await assert.rejects(previewExecutor()({ ...input, throughMs: 0 }), /fromMs < throughMs/);
});
