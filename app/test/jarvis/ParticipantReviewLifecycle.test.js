const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function createRepository(dbPath = ":memory:") {
  let nextId = 0;
  return new JarvisRepository(dbPath, {
    createId: (prefix) => `${prefix}-${++nextId}`,
    now: () => 50_000 + nextId,
  });
}

function createCluster(repository, input) {
  return repository.createSpeakerCluster({
    modelId: "campplus-v1",
    embedding: new Float32Array(512).fill(input.embeddingValue ?? 0.01),
    windowCount: 4,
    qualityScore: 0.92,
    ...input,
  });
}

function seedParticipantFixture(repository, { includeHistoricalIdentity = false } = {}) {
  repository.createSession({
    id: "review-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repository.createTrack({
    id: "track-mic",
    sessionId: "review-session",
    sourceType: "mic",
    deviceId: "physical-mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repository.insertAudioChunk({
    id: "chunk-known-early",
    sessionId: "review-session",
    path: "audio/review-session/chunk-known-early.flac",
    startedAt: 2_000,
    endedAt: 8_000,
    durationMs: 6_000,
    sha256: "a".repeat(64),
    expiresAt: 40_000,
  });
  repository.db
    .prepare(
      `UPDATE audio_chunks
       SET track_id = 'track-mic', source_type = 'mic'
       WHERE id = 'chunk-known-early'`
    )
    .run();
  repository.upsertTranscriptSegments("review-session", [
    {
      id: "segment-known-early",
      startedAt: 2_000,
      endedAt: 8_000,
      personId: "person-known",
      speakerLabel: "speaker_1",
      text: "我来确认第一段发言。",
      confidence: 0.95,
      isStable: true,
      trackId: "track-mic",
    },
    {
      id: "segment-known-late",
      startedAt: 9_000,
      endedAt: 15_000,
      personId: "person-known",
      speakerLabel: "speaker_1",
      text: "这一段其实是另一位参与者。",
      confidence: 0.94,
      isStable: true,
      trackId: "track-mic",
    },
    {
      id: "segment-anonymous",
      startedAt: 16_000,
      endedAt: 22_000,
      personId: null,
      speakerLabel: "speaker_2",
      text: "这是尚未命名的参与者。",
      confidence: 0.93,
      isStable: true,
      trackId: "track-mic",
    },
  ]);
  repository.renamePerson({
    personId: "person-known",
    displayName: "张三",
    isSelf: false,
  });
  repository.addVoiceProfileSample({
    id: "profile-person-known",
    personId: "person-known",
    modelId: "campplus-v1",
    embedding: new Float32Array(512).fill(0.01),
    sourceKind: "enrollment",
    sourceClusterId: null,
    speechMs: 12_000,
    windowCount: 4,
    createdAt: 22_000,
  });
  createCluster(repository, {
    id: "cluster-known",
    sessionId: "review-session",
    trackId: "track-mic",
    localLabel: "speaker_1",
    speechMs: 12_000,
    embeddingValue: 0.01,
  });
  createCluster(repository, {
    id: "cluster-anonymous",
    sessionId: "review-session",
    trackId: "track-mic",
    localLabel: "speaker_2",
    speechMs: 6_000,
    embeddingValue: 0.02,
  });
  repository.replaceSpeakerClusterSegments("cluster-known", [
    "segment-known-early",
    "segment-known-late",
  ]);
  repository.replaceSpeakerClusterSegments("cluster-anonymous", ["segment-anonymous"]);
  repository.db
    .prepare(
      `UPDATE transcript_segments
       SET chunk_id = 'chunk-known-early'
       WHERE id = 'segment-known-early'`
    )
    .run();
  repository.db
    .prepare(
      `UPDATE speaker_clusters
       SET person_id = 'person-known', link_state = 'confirmed', updated_at = 23000
       WHERE id = 'cluster-known'`
    )
    .run();

  if (!includeHistoricalIdentity) return;
  repository.createSession({
    id: "historical-session",
    startedAt: 30_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repository.createTrack({
    id: "track-history",
    sessionId: "historical-session",
    sourceType: "mic",
    deviceId: "physical-mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 30_000,
  });
  repository.upsertTranscriptSegments("historical-session", [
    {
      id: "segment-history",
      startedAt: 31_000,
      endedAt: 37_000,
      personId: "person-known",
      speakerLabel: "speaker_1",
      text: "历史会话中的同一个人物。",
      confidence: 0.93,
      isStable: true,
      trackId: "track-history",
    },
  ]);
  createCluster(repository, {
    id: "cluster-history",
    sessionId: "historical-session",
    trackId: "track-history",
    localLabel: "speaker_1",
    speechMs: 6_000,
    embeddingValue: 0.01,
  });
  repository.replaceSpeakerClusterSegments("cluster-history", ["segment-history"]);
  repository.db
    .prepare(
      `UPDATE speaker_clusters
       SET person_id = 'person-known', link_state = 'confirmed', updated_at = 38000
       WHERE id = 'cluster-history'`
    )
    .run();
}

test("segment split affects only selected evidence and undo restores the participant projection", (t) => {
  const repository = createRepository();
  t.after(() => repository.close());
  seedParticipantFixture(repository);

  const before = repository.getSessionSpeakerProcessing("review-session").participants;
  const preview = repository.previewParticipantReview({
    sessionId: "review-session",
    action: "split",
    clusterIds: ["cluster-known"],
    segmentIds: ["segment-known-late"],
  });
  assert.equal(preview.affectedClusterCount, 1);
  assert.equal(preview.affectedSegmentCount, 1);
  assert.deepEqual(preview.segmentIds, ["segment-known-late"]);

  const applied = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "split",
    clusterIds: ["cluster-known"],
    segmentIds: ["segment-known-late"],
    at: 60_000,
  });
  const override = repository.db
    .prepare(
      `SELECT cluster_id, group_ref, disposition, source_event_id
       FROM speaker_segment_review_overrides
       WHERE transcript_segment_id = 'segment-known-late'`
    )
    .get();
  assert.equal(override.cluster_id, "cluster-known");
  assert.match(override.group_ref, /^manual-group-/u);
  assert.equal(override.disposition, "social");
  assert.equal(override.source_event_id, applied.event.id);
  assert.equal(
    applied.speakerProcessing.participants.participants.length,
    before.participants.length + 1
  );

  repository.undoParticipantReview(applied.event.id, 61_000);
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM speaker_segment_review_overrides WHERE transcript_segment_id = ?"
      )
      .get("segment-known-late").count,
    0
  );
  assert.equal(
    repository.getSessionSpeakerProcessing("review-session").participants.participants.length,
    before.participants.length
  );
});

test("forget identity previews historical impact and undo restores every affected association", (t) => {
  const repository = createRepository();
  t.after(() => repository.close());
  seedParticipantFixture(repository, { includeHistoricalIdentity: true });

  const preview = repository.previewParticipantReview({
    sessionId: "review-session",
    action: "forget_identity",
    personId: "person-known",
  });
  assert.deepEqual(preview.affectedPersonIds, ["person-known"]);
  assert.equal(preview.historyImpact.sessionCount, 2);
  assert.equal(preview.historyImpact.clusterCount, 2);
  assert.deepEqual(preview.historyImpact.sessionIds, [
    "historical-session",
    "review-session",
  ]);

  const applied = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "forget_identity",
    personId: "person-known",
    at: 70_000,
  });
  assert.equal(
    repository.listVoiceProfiles("campplus-v1").some((profile) => profile.personId === "person-known"),
    false
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT id, person_id, link_state
         FROM speaker_clusters
         WHERE id IN ('cluster-known', 'cluster-history')
         ORDER BY id`
      )
      .all(),
    [
      { id: "cluster-history", person_id: null, link_state: "unknown" },
      { id: "cluster-known", person_id: null, link_state: "unknown" },
    ]
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT id, person_id
         FROM transcript_segments
         WHERE id IN ('segment-known-early', 'segment-known-late', 'segment-history')
         ORDER BY id`
      )
      .all(),
    [
      { id: "segment-history", person_id: null },
      { id: "segment-known-early", person_id: null },
      { id: "segment-known-late", person_id: null },
    ]
  );

  repository.undoParticipantReview(applied.event.id, 71_000);
  assert.equal(
    repository.listVoiceProfiles("campplus-v1").some((profile) => profile.personId === "person-known"),
    true
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT id, person_id, link_state
         FROM speaker_clusters
         WHERE id IN ('cluster-known', 'cluster-history')
         ORDER BY id`
      )
      .all(),
    [
      { id: "cluster-history", person_id: "person-known", link_state: "confirmed" },
      { id: "cluster-known", person_id: "person-known", link_state: "confirmed" },
    ]
  );
  assert.equal(
    repository.db
      .prepare(
        `SELECT count(*) AS count
         FROM transcript_segments
         WHERE id IN ('segment-known-early', 'segment-known-late', 'segment-history')
           AND person_id = 'person-known'`
      )
      .get().count,
    3
  );
});

test("pin and unpin evidence are reversible immutable review events", (t) => {
  const repository = createRepository();
  t.after(() => repository.close());
  seedParticipantFixture(repository);

  const pinned = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "pin_evidence",
    clusterIds: ["cluster-known"],
    segmentIds: ["segment-known-early"],
    label: "清晰代表片段",
    at: 80_000,
  });
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT transcript_segment_id, cluster_id, session_id, label, source_event_id, pinned_at
         FROM pinned_speaker_evidence`
      )
      .get(),
    {
      transcript_segment_id: "segment-known-early",
      cluster_id: "cluster-known",
      session_id: "review-session",
      label: "清晰代表片段",
      source_event_id: pinned.event.id,
      pinned_at: 80_000,
    }
  );
  assert.deepEqual(
    repository.listExpiredAudioChunks(80_000).map((chunk) => chunk.id),
    []
  );

  const unpinned = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "unpin_evidence",
    clusterIds: ["cluster-known"],
    segmentIds: ["segment-known-early"],
    at: 81_000,
  });
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM pinned_speaker_evidence").get().count,
    0
  );
  assert.deepEqual(
    repository.listExpiredAudioChunks(81_000).map((chunk) => chunk.id),
    ["chunk-known-early"]
  );

  repository.undoParticipantReview(unpinned.event.id, 82_000);
  const restored = repository.db
    .prepare(
      `SELECT transcript_segment_id, cluster_id, session_id, label, source_event_id, pinned_at
       FROM pinned_speaker_evidence`
    )
    .get();
  assert.equal(restored.transcript_segment_id, "segment-known-early");
  assert.equal(restored.cluster_id, "cluster-known");
  assert.equal(restored.session_id, "review-session");
  assert.equal(restored.label, "清晰代表片段");
  assert.notEqual(restored.source_event_id, pinned.event.id);
  assert.equal(restored.pinned_at, 82_000);
  assert.deepEqual(
    repository.listExpiredAudioChunks(82_000).map((chunk) => chunk.id),
    []
  );

  repository.undoParticipantReview(pinned.event.id, 83_000);
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM pinned_speaker_evidence").get().count,
    0
  );
  assert.deepEqual(
    repository.listExpiredAudioChunks(83_000).map((chunk) => chunk.id),
    ["chunk-known-early"]
  );
});

test("review history exposes complete state transitions and undo lifecycle", (t) => {
  const repository = createRepository();
  t.after(() => repository.close());
  seedParticipantFixture(repository);

  const applied = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "mark_media",
    clusterIds: ["cluster-anonymous"],
    at: 90_000,
  });
  repository.undoParticipantReview(applied.event.id, 91_000);

  const history = repository.listParticipantReviewHistory("review-session");
  assert.equal(history.length, 2);
  assert.equal(history[0].action, "undo");
  assert.equal(history[0].revertsEventId, applied.event.id);
  assert.equal(history[0].canUndo, false);
  assert.deepEqual(history[0].previousState, history[1].nextState);
  assert.deepEqual(history[0].nextState, history[1].previousState);
  assert.equal(history[1].action, "mark_media");
  assert.equal(history[1].canUndo, false);
  assert.deepEqual(history[1].payload.clusterIds, ["cluster-anonymous"]);
  assert.deepEqual(history[1].previousState, { overrides: [] });
  assert.deepEqual(history[1].nextState, {
    overrides: [
      {
        clusterId: "cluster-anonymous",
        groupRef: null,
        disposition: "media",
      },
    ],
  });
  assert.throws(
    () => repository.undoParticipantReview(applied.event.id, 92_000),
    /already undone/u
  );
  assert.throws(
    () => repository.undoParticipantReview(history[0].id, 92_000),
    /not undoable/u
  );
});

test("participant projections persist idempotent snapshots and remain readable after restart", (t) => {
  const root = path.resolve(
    __dirname,
    "..",
    "..",
    ".tmp-tests",
    `participant-lifecycle-${crypto.randomUUID()}`
  );
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, "jarvis.db");
  let repository = createRepository(databasePath);
  t.after(() => {
    repository?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  seedParticipantFixture(repository);

  const firstProjection =
    repository.getSessionSpeakerProcessing("review-session").participants;
  assert.equal(repository.getLatestParticipantSnapshot("review-session"), null);
  const first = repository.refreshSessionParticipantSnapshot("review-session", {
    at: 95_000,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.projectorVersion, firstProjection.projectorVersion);
  assert.match(first.sourceHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.payload, firstProjection);
  assert.deepEqual(
    first.memberships.map((membership) => membership.clusterId).sort(),
    ["cluster-known"]
  );

  repository.getSessionSpeakerProcessing("review-session");
  assert.equal(
    repository.db
      .prepare(
        "SELECT count(*) AS count FROM session_participant_snapshots WHERE session_id = ?"
      )
      .get("review-session").count,
    1
  );

  const mediaReview = repository.applyParticipantReview({
    sessionId: "review-session",
    action: "mark_media",
    clusterIds: ["cluster-anonymous"],
    at: 100_000,
  });
  const second = repository.getLatestParticipantSnapshot("review-session");
  assert.equal(second.revision, 2);
  assert.notEqual(second.sourceHash, first.sourceHash);
  assert.equal(
    second.memberships.find((membership) => membership.clusterId === "cluster-anonymous")
      .membershipKind,
    "media"
  );
  repository.undoParticipantReview(mediaReview.event.id, 101_000);
  const third = repository.getLatestParticipantSnapshot("review-session");
  assert.equal(third.revision, 3);
  assert.notEqual(third.sourceHash, first.sourceHash);
  assert.deepEqual(third.payload, first.payload);

  repository.close();
  repository = createRepository(databasePath);
  assert.deepEqual(
    repository.getLatestParticipantSnapshot("review-session"),
    third
  );
});

test("participant review backfill batches select only bounded terminal sessions without snapshots", (t) => {
  const repository = createRepository();
  t.after(() => repository.close());
  seedParticipantFixture(repository);
  repository.setSessionStatus("review-session", "completed", 25_000);

  const batch = repository.beginParticipantReviewBackfillBatch({
    scope: "recent_audio",
    limit: 1,
    at: 30_000,
  });
  assert.equal(batch.state, "running");
  assert.deepEqual(batch.sessionIds, ["review-session"]);
  assert.equal(batch.sessionCount, 1);

  repository.refreshSessionParticipantSnapshot("review-session", { at: 30_000 });
  const progress = repository.recordParticipantReviewBackfillProgress(batch.id, {
    changed: true,
  });
  assert.equal(progress.processedCount, 1);
  assert.equal(progress.changedCount, 1);
  const completed = repository.finishParticipantReviewBackfillBatch(batch.id, {
    state: "completed",
    at: 30_001,
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.completedAt, 30_001);

  const empty = repository.beginParticipantReviewBackfillBatch({
    scope: "recent_audio",
    limit: 1,
    at: 30_002,
  });
  assert.equal(empty.state, "completed");
  assert.deepEqual(empty.sessionIds, []);
  assert.equal(empty.sessionCount, 0);
});
