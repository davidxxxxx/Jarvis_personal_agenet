const test = require("node:test");
const assert = require("node:assert/strict");

const {
  projectSessionParticipants,
  selectRepresentativeSegments,
} = require("../../src/jarvis/main/SessionParticipantProjector");

function vector(...values) {
  return new Float32Array(values);
}

function track(overrides = {}) {
  return {
    id: "track-default",
    source_type: "system",
    application_key: null,
    application_display_name: null,
    capture_generation: 0,
    started_at: 1_000,
    ended_at: 60_000,
    ...overrides,
  };
}

function segment(id, startedAt, overrides = {}) {
  return {
    id,
    started_at: startedAt,
    ended_at: startedAt + 2_000,
    text: `text-${id}`,
    confidence: 0.9,
    ...overrides,
  };
}

function cluster(overrides = {}) {
  return {
    id: "cluster-default",
    trackId: "track-default",
    localLabel: "speaker_1",
    linkState: "unknown",
    person: null,
    candidatePersonRef: null,
    reason: "no_dual_candidate",
    score: null,
    margin: null,
    speechMs: 12_000,
    windowCount: 4,
    qualityScore: 0.9,
    embedding: vector(1, 0, 0),
    resolutionModels: [],
    evidenceSegments: [segment("segment-default", 2_000)],
    ...overrides,
  };
}

test("collapses confirmed SELF clusters across tracks and excludes media voices", () => {
  const result = projectSessionParticipants({
    tracks: [
      track({ id: "mic", source_type: "mic" }),
      track({
        id: "dota",
        application_key: "dota2",
        application_display_name: "DOTA 2",
      }),
    ],
    clusters: [
      cluster({
        id: "self-1",
        trackId: "mic",
        localLabel: "speaker_1",
        linkState: "confirmed",
        person: { id: "self", displayName: "我", isSelf: true },
      }),
      cluster({
        id: "self-2",
        trackId: "mic",
        localLabel: "speaker_7",
        linkState: "confirmed",
        person: { id: "self", displayName: "我", isSelf: true },
      }),
      cluster({ id: "dota-voice", trackId: "dota", speechMs: 40_000 }),
    ],
  });

  assert.deepEqual(result.count, {
    minimum: 1,
    maximum: 1,
    confirmed: 1,
    needsReview: 0,
    selfIncluded: true,
  });
  assert.equal(result.participants.length, 1);
  assert.equal(result.participants[0].kind, "self");
  assert.equal(result.participants[0].clusterCount, 2);
  assert.equal(result.mediaVoices.length, 1);
  assert.equal(result.mediaVoices[0].sourceNames[0], "DOTA 2");
});

test("groups a dual-model anonymous reference across KOOK capture generations", () => {
  const anonymousRef = "anonymous-speaker-1234567890abcdef1234567890abcdef";
  const result = projectSessionParticipants({
    tracks: [
      track({
        id: "kook-6",
        application_key: "kook",
        application_display_name: "KOOK",
        capture_generation: 6,
      }),
      track({
        id: "kook-41",
        application_key: "kook",
        application_display_name: "KOOK",
        capture_generation: 41,
      }),
    ],
    clusters: [
      cluster({
        id: "kook-a",
        trackId: "kook-6",
        candidatePersonRef: anonymousRef,
        reason: "dual_model_anonymous_group",
        speechMs: 14_000,
        evidenceSegments: [
          segment("ka-1", 2_000),
          segment("ka-2", 8_000),
        ],
      }),
      cluster({
        id: "kook-b",
        trackId: "kook-41",
        candidatePersonRef: anonymousRef,
        reason: "dual_model_anonymous_profile",
        speechMs: 18_000,
        evidenceSegments: [
          segment("kb-1", 20_000),
          segment("kb-2", 30_000),
        ],
      }),
    ],
  });

  assert.equal(result.participants.length, 1);
  assert.equal(result.participants[0].kind, "anonymous");
  assert.equal(result.participants[0].durable, true);
  assert.equal(result.participants[0].clusterCount, 2);
  assert.equal(result.participants[0].speechMs, 32_000);
  assert.equal(result.count.minimum, 1);
  assert.equal(result.count.maximum, 1);
});

test("uses conservative session-only similarity to express an unresolved count range", () => {
  const result = projectSessionParticipants({
    tracks: [
      track({
        id: "kook-1",
        application_key: "kook",
        application_display_name: "KOOK",
        capture_generation: 1,
        ended_at: 10_000,
      }),
      track({
        id: "kook-2",
        application_key: "kook",
        application_display_name: "KOOK",
        capture_generation: 2,
        started_at: 11_000,
      }),
    ],
    clusters: [
      cluster({
        id: "kook-fragment-a",
        trackId: "kook-1",
        embedding: vector(1, 0, 0),
      }),
      cluster({
        id: "kook-fragment-b",
        trackId: "kook-2",
        embedding: vector(0.99, 0.01, 0),
      }),
    ],
  });

  assert.equal(result.participants.length, 1);
  assert.equal(result.participants[0].kind, "temporary");
  assert.equal(result.participants[0].clusterCount, 2);
  assert.equal(result.participants[0].reviewState, "needs_review");
  assert.deepEqual(result.count, {
    minimum: 1,
    maximum: 2,
    confirmed: 0,
    needsReview: 1,
    selfIncluded: false,
  });
});

test("marks an implausible legacy participant storm as anomalous", () => {
  const result = projectSessionParticipants({
    tracks: [track({ id: "legacy-mic", source_type: "mic" })],
    clusters: Array.from({ length: 25 }, (_, index) =>
      cluster({
        id: `legacy-${index}`,
        trackId: "legacy-mic",
        localLabel: `speaker_${index + 1}`,
        embedding: vector(index + 1, 1),
        speechMs: 6_000,
      })
    ),
  });

  assert.equal(result.count.maximum, 25);
  assert.equal(result.excluded.anomaly, true);
});

test("does not merge similar voices from different applications", () => {
  const result = projectSessionParticipants({
    tracks: [
      track({
        id: "kook",
        application_key: "kook",
        application_display_name: "KOOK",
      }),
      track({
        id: "dota",
        application_key: "dota2",
        application_display_name: "DOTA 2",
      }),
    ],
    clusters: [
      cluster({ id: "kook-voice", trackId: "kook", embedding: vector(1, 0, 0) }),
      cluster({ id: "dota-voice", trackId: "dota", embedding: vector(1, 0, 0) }),
    ],
  });

  assert.equal(result.participants.length, 1);
  assert.equal(result.mediaVoices.length, 1);
  assert.equal(result.participants[0].sourceNames[0], "KOOK");
});

test("hides short legacy fragments and shadowed system mix instead of counting them", () => {
  const result = projectSessionParticipants({
    tracks: [
      track({ id: "mix" }),
      track({
        id: "kook",
        application_key: "kook",
        application_display_name: "KOOK",
      }),
    ],
    clusters: [
      cluster({ id: "short", trackId: "kook", speechMs: 2_000, windowCount: 1 }),
      cluster({ id: "mix-voice", trackId: "mix", speechMs: 30_000 }),
      cluster({ id: "kook-voice", trackId: "kook", speechMs: 30_000 }),
    ],
  });

  assert.equal(result.participants.length, 1);
  assert.equal(result.excluded.fragmented, 1);
  assert.equal(result.excluded.shadowedSystemMix, 1);
  assert.equal(result.count.maximum, 1);
});

test("selects three representative segments across the candidate timeline", () => {
  const selected = selectRepresentativeSegments([
    { clusterId: "a", ...segment("early", 1_000, { confidence: 0.7 }) },
    { clusterId: "a", ...segment("best", 10_000, { confidence: 0.99 }) },
    { clusterId: "b", ...segment("middle", 20_000, { confidence: 0.8 }) },
    { clusterId: "b", ...segment("late", 30_000, { confidence: 0.85 }) },
  ]);

  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["early", "best", "late"]
  );
});

test("user review overrides can merge social clusters or exclude them as media", () => {
  const tracks = [
    track({
      id: "kook-a",
      application_key: "kook",
      application_display_name: "KOOK",
      started_at: 0,
      ended_at: 30_000,
    }),
    track({
      id: "kook-b",
      application_key: "kook",
      application_display_name: "KOOK",
      capture_generation: 2,
      started_at: 31_000,
      ended_at: 60_000,
    }),
  ];
  const merged = projectSessionParticipants({
    tracks,
    clusters: [
      cluster({
        id: "review-a",
        trackId: "kook-a",
        localLabel: "speaker_1",
        reviewOverride: {
          groupRef: "manual-group-1",
          disposition: "social",
        },
      }),
      cluster({
        id: "review-b",
        trackId: "kook-b",
        localLabel: "speaker_2",
        reviewOverride: {
          groupRef: "manual-group-1",
          disposition: "social",
        },
      }),
    ],
  });
  assert.equal(merged.participants.length, 1);
  assert.equal(merged.participants[0].kind, "reviewed");
  assert.equal(merged.count.minimum, 1);
  assert.equal(merged.count.maximum, 1);
  assert.equal(merged.count.confirmed, 1);

  const media = projectSessionParticipants({
    tracks,
    clusters: [
      cluster({
        id: "review-media",
        trackId: "kook-a",
        reviewOverride: {
          groupRef: null,
          disposition: "media",
        },
      }),
    ],
  });
  assert.equal(media.participants.length, 0);
  assert.equal(media.mediaVoices.length, 1);
});
