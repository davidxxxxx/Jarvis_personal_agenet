const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeEvidenceContextRequest,
  normalizeEvidenceContextResponse,
} = require("../../src/jarvis/shared/contracts");

const OWNER_TYPES = [
  "memory_value",
  "topic_revision",
  "todo_instance",
  "session_summary_revision",
  "daily_digest_item",
  "suggestion",
  "speaker_cluster",
];

function context(overrides = {}) {
  return {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
    sessionId: "session_1",
    sessionStartedAt: 1_000,
    sessionEndedAt: 5_500,
    transcriptSegmentId: "segment_1",
    transcriptState: "available",
    trackId: "track_1",
    sourceType: "mic",
    startedAt: 1_500,
    endedAt: 2_500,
    quoteText: "Stored evidence",
    audioState: "available",
    ...overrides,
  };
}

test("evidence context requests accept only exact safe owner handles", () => {
  for (const ownerType of OWNER_TYPES) {
    assert.deepEqual(
      normalizeEvidenceContextRequest({
        ownerType,
        ownerId: "owner_1",
        evidenceId: "evidence_1",
      }),
      { ownerType, ownerId: "owner_1", evidenceId: "evidence_1" }
    );
  }

  const inherited = Object.assign(Object.create({ forged: "ignored" }), {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  });
  assert.deepEqual(normalizeEvidenceContextRequest(inherited), {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  });

  for (const invalid of [
    null,
    [],
    { ownerType: "memory_value", ownerId: "memory_1" },
    {
      ownerType: "memory_value",
      ownerId: "memory_1",
      evidenceId: "evidence_1",
      sessionId: "forged",
    },
    { ownerType: "memory", ownerId: "memory_1", evidenceId: "evidence_1" },
    { ownerType: "memory_value", ownerId: "../memory", evidenceId: "evidence_1" },
    { ownerType: "memory_value", ownerId: "memory_1", evidenceId: "C:\\private" },
  ]) {
    assert.throws(() => normalizeEvidenceContextRequest(invalid), /evidence|safe|owner/i);
  }
});

test("evidence context responses are reconstructed from an exact privacy allowlist", () => {
  const normalized = normalizeEvidenceContextResponse({
    ...context(),
    path: "C:\\private\\capture.flac",
    sha256: "a".repeat(64),
    device_id: "private-device",
    rawError: "private stack",
  });
  assert.deepEqual(Object.keys(normalized), [
    "ownerType",
    "ownerId",
    "evidenceId",
    "sessionId",
    "sessionStartedAt",
    "sessionEndedAt",
    "transcriptSegmentId",
    "transcriptState",
    "trackId",
    "sourceType",
    "startedAt",
    "endedAt",
    "quoteText",
    "audioState",
  ]);
  assert.equal(JSON.stringify(normalized).includes("private"), false);
  assert.equal(normalizeEvidenceContextResponse(null), null);

  for (const invalid of [
    context({ sessionStartedAt: 1_501 }),
    context({ startedAt: 2_500, endedAt: 2_500 }),
    context({ sessionEndedAt: 2_499 }),
    context({ transcriptState: "missing", transcriptSegmentId: "segment_1" }),
    context({ transcriptState: "missing", quoteText: "fabricated" }),
    context({ sourceType: "loopback" }),
    context({ audioState: "deleted" }),
  ]) {
    assert.throws(() => normalizeEvidenceContextResponse(invalid), /evidence context response/i);
  }
});
