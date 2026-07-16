const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const MemoryRepository = require("../../src/jarvis/main/MemoryRepository");
const { resolveLocalDate } = require("../../src/jarvis/main/ZonedCalendar");

function fixture(t, { idPrefix = "fixture" } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db, { now: () => 1_000 });
  let nextId = 0;
  const repository = new MemoryRepository(db, {
    createId: (prefix) => `${idPrefix}-${prefix}-${++nextId}`,
    now: () => 10_000,
    validateRedactedCloudPayload: () => true,
  });
  t.after(() => db.close());
  return { db, repository };
}

function seedSession(db, { id, startedAt, processingState = "ready", status = "completed" }) {
  db.prepare(
    `INSERT INTO sessions (
       id, started_at, ended_at, status, created_at, processing_state,
       timeline_version, finalized_at, ready_at
     ) VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?)`
  ).run(
    id,
    startedAt,
    status === "recording" ? null : startedAt + 10_000,
    status,
    startedAt,
    processingState,
    status === "recording" ? null : startedAt + 10_000,
    processingState === "ready" ? startedAt + 10_000 : null
  );
}

function seedSegment(
  db,
  { id, sessionId, startedAt, text, personId = null, speakerLabel = "Private Name", ordinal = 0 }
) {
  const trackId = `track-${sessionId}`;
  db.prepare(
    `INSERT OR IGNORE INTO audio_tracks (
       id, session_id, source_type, device_id, device_label, strategy,
       sample_rate, channels, started_at, state
     ) VALUES (?, ?, 'mic', 'private-device-id', 'Private microphone', 'web-audio',
       24000, 1, ?, 'active')`
  ).run(trackId, sessionId, startedAt - 1_000);
  const chunkId = `chunk-${id}`;
  db.prepare(
    `INSERT INTO audio_chunks (
       id, session_id, path, started_at, ended_at, duration_ms, sha256, expires_at,
       transcription_status, track_id, source_type, sequence_number, write_state,
       format, file_sha256, sample_rate, channels
     ) VALUES (?, ?, ?, ?, ?, 500, ?, ?, 'completed', ?, 'mic', ?, 'committed',
       'flac', ?, 24000, 1)`
  ).run(
    chunkId,
    sessionId,
    `G:\\private-audio\\${id}.flac`,
    startedAt,
    startedAt + 500,
    `${id}-pcm`,
    startedAt + 1_000_000,
    trackId,
    ordinal,
    `${id}-file`
  );
  db.prepare(
    `INSERT INTO transcript_segments (
       id, session_id, started_at, ended_at, person_id, speaker_label, text,
       confidence, is_stable, analysis_state, track_id, chunk_id, source_type,
       result_kind, version, model_version, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.95, 1, 'ready', ?, ?, 'mic',
       'final', 2, 'whisper-v1', ?)`
  ).run(
    id,
    sessionId,
    startedAt,
    startedAt + 500,
    personId,
    speakerLabel,
    text,
    trackId,
    chunkId,
    startedAt + 600
  );
}

function seedPerson(db, { id, displayName, isSelf = 0 }) {
  db.prepare(
    `INSERT INTO people (
       id, display_name, is_self, voice_profile_id, voice_confidence, created_at, last_seen_at
     ) VALUES (?, ?, ?, 12345, 0.99, 1, 1)`
  ).run(id, displayName, isSelf);
}

function seedLegacyMemoryEvidence(
  db,
  { id, kind, title, body, sessionId, segmentIds, hashDigit }
) {
  const slotHash = hashDigit.repeat(64);
  const valueHash = String((Number(hashDigit) + 1) % 10).repeat(64);
  db.prepare(
    `INSERT INTO memory_items_v2 (
       id, kind, canonical_slot_key, canonical_value_key, title, body, confidence,
       lifecycle, source_analysis_input_id, provenance, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0.9, 'active', NULL, 'evidence_linked', 1, 1)`
  ).run(id, kind, slotHash, valueHash, title, body);
  db.prepare(
    `INSERT INTO memory_item_canonical_slots (
       memory_item_id, canonical_slot_key, algorithm
     ) VALUES (?, ?, 'canonical-v1')`
  ).run(id, slotHash);
  const occurrenceId = `occurrence-${id}`;
  db.prepare(
    `INSERT INTO memory_occurrences (
       id, memory_value_id, analysis_input_id, legacy_session_id,
       occurrence_key, candidate_item_fingerprint, confidence, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, 0.9, 1)`
  ).run(occurrenceId, id, sessionId, hashDigit.repeat(64), valueHash);
  for (const [index, segmentId] of segmentIds.entries()) {
    const segment = db.prepare("SELECT * FROM transcript_segments WHERE id = ?").get(segmentId);
    db.prepare(
      `INSERT INTO evidence_refs (
         id, entity_type, entity_id, source_analysis_input_id, session_id,
         transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at,
         quote_text, audio_state, created_at
       ) VALUES (?, 'memory_occurrence', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'available', 1)`
    ).run(
      `evidence-${id}-${index}`,
      occurrenceId,
      sessionId,
      segmentId,
      `chunk-${segmentId}`,
      `track-${sessionId}`,
      segment.started_at,
      segment.ended_at,
      segment.text
    );
  }
}

test("daily input splits open sessions at exact local midnight by evidence timestamps", (t) => {
  const { db, repository } = fixture(t);
  const day = resolveLocalDate({ localDate: "2026-07-17", timezone: "Asia/Shanghai" });
  seedSession(db, {
    id: "spanning-session",
    startedAt: day.startsAt - 10_000,
    processingState: "processing",
    status: "recording",
  });
  seedSegment(db, {
    id: "before-midnight",
    sessionId: "spanning-session",
    startedAt: day.endsAt - 1_000,
    text: "before midnight",
    ordinal: 0,
  });
  seedSegment(db, {
    id: "at-midnight",
    sessionId: "spanning-session",
    startedAt: day.endsAt,
    text: "at midnight",
    ordinal: 1,
  });

  const first = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  const second = repository.createDailyDigestInput({
    localDate: "2026-07-18",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });

  assert.equal(first.status, "created");
  assert.equal(first.completeness, "partial");
  assert.deepEqual(first.cloudPayload.sections.sessions[0].segments.map((segment) => segment.segmentId), [
    "before-midnight",
  ]);
  assert.deepEqual(second.cloudPayload.sections.sessions[0].segments.map((segment) => segment.segmentId), [
    "at-midnight",
  ]);
});

test("daily input is insertion-order deterministic and excludes queue timing from its hash", (t) => {
  const left = fixture(t, { idPrefix: "left" });
  const right = fixture(t, { idPrefix: "right" });
  const { startsAt } = resolveLocalDate({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  });
  for (const child of [left, right]) {
    seedSession(child.db, { id: "session-a", startedAt: startsAt + 1_000 });
  }
  const segments = [
    { id: "segment-a", startedAt: startsAt + 2_000, text: "first fact", ordinal: 0 },
    { id: "segment-b", startedAt: startsAt + 3_000, text: "second fact", ordinal: 1 },
  ];
  for (const segment of segments) {
    seedSegment(left.db, { ...segment, sessionId: "session-a" });
  }
  for (const segment of [...segments].reverse()) {
    seedSegment(right.db, { ...segment, sessionId: "session-a" });
  }
  left.db.prepare(
    `INSERT INTO processing_jobs (
       id, session_id, job_type, state, priority, input_hash, input_version,
       model_version, attempt_count, next_retry_at, lease_owner, lease_expires_at,
       lane, created_at
     ) VALUES ('pending-upstream', 'session-a', 'transcribe_chunk', 'retry', 30,
       'stable-upstream-input', 1, 'whisper-v1', 7, 999999, 'old-worker', 888888,
       'local', 100)`
  ).run();
  right.db.prepare(
    `INSERT INTO processing_jobs (
       id, session_id, job_type, state, priority, input_hash, input_version,
       model_version, attempt_count, next_retry_at, lease_owner, lease_expires_at,
       lane, created_at
     ) VALUES ('pending-upstream', 'session-a', 'transcribe_chunk', 'pending', 30,
       'stable-upstream-input', 1, 'whisper-v1', 0, NULL, NULL, NULL,
       'local', 900)`
  ).run();

  const leftInput = left.repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  const rightInput = right.repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });

  assert.equal(leftInput.sourceHash, rightInput.sourceHash);
  assert.equal(leftInput.cloudPayloadJson, rightInput.cloudPayloadJson);
  assert.equal(leftInput.inputWatermarkJson, rightInput.inputWatermarkJson);
  for (const forbidden of [
    "attemptCount",
    "attempt_count",
    "nextRetryAt",
    "next_retry_at",
    "leaseOwner",
    "lease_owner",
    "leaseExpiresAt",
    "lease_expires_at",
  ]) {
    assert.equal(leftInput.inputWatermarkJson.includes(forbidden), false);
  }
});

test("daily input has fixed sections and leaks no identity device audio embedding or secret fields", (t) => {
  const { db, repository } = fixture(t);
  const { startsAt } = resolveLocalDate({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  });
  seedPerson(db, { id: "person-alice", displayName: "Alice Private" });
  seedSession(db, { id: "private-session-id", startedAt: startsAt + 1_000 });
  seedSegment(db, {
    id: "private-segment",
    sessionId: "private-session-id",
    startedAt: startsAt + 2_000,
    personId: "person-alice",
    speakerLabel: "Alice Private",
    text: "Use token sk-cp-ABCDEFGHIJKLMNOPQRST for the demo",
  });

  const result = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  assert.deepEqual(Object.keys(result.cloudPayload.sections).sort(), [
    "sessions",
    "peopleInteractions",
    "topics",
    "decisions",
    "commitments",
    "todosCreated",
    "todosCompleted",
    "unresolvedConflicts",
    "transcriptCoverage",
  ].sort());
  const serialized = result.cloudPayloadJson;
  for (const forbidden of [
    "Alice Private",
    "person-alice",
    "private-session-id",
    "private-device-id",
    "Private microphone",
    "G:\\private-audio",
    "voice_profile_id",
    "embedding",
    "sk-cp-ABCDEFGHIJKLMNOPQRST",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /subject-[0-9a-f]{16}/);
  assert.match(serialized, /\[REDACTED_SECRET\]/);
});

test("daily input maps repeated evidence to the correct decision and commitment sections", (t) => {
  const { db, repository } = fixture(t);
  const { startsAt } = resolveLocalDate({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  });
  seedSession(db, { id: "session-memory", startedAt: startsAt + 1_000 });
  for (const [index, text] of ["decision evidence one", "decision evidence two", "commitment evidence"].entries()) {
    seedSegment(db, {
      id: `memory-segment-${index}`,
      sessionId: "session-memory",
      startedAt: startsAt + 2_000 + index * 1_000,
      text,
      ordinal: index,
    });
  }
  seedLegacyMemoryEvidence(db, {
    id: "decision-item",
    kind: "decision",
    title: "Decision title",
    body: "Decision body",
    sessionId: "session-memory",
    segmentIds: ["memory-segment-0", "memory-segment-1"],
    hashDigit: "1",
  });
  seedLegacyMemoryEvidence(db, {
    id: "z-commitment-item",
    kind: "commitment",
    title: "Commitment title",
    body: "Commitment body",
    sessionId: "session-memory",
    segmentIds: ["memory-segment-2"],
    hashDigit: "3",
  });

  const result = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  assert.deepEqual(result.cloudPayload.sections.decisions.map((item) => item.text), [
    "Decision title: Decision body",
  ]);
  assert.deepEqual(result.cloudPayload.sections.decisions[0].evidenceSegmentIds, [
    "memory-segment-0",
    "memory-segment-1",
  ]);
  assert.deepEqual(result.cloudPayload.sections.commitments.map((item) => item.text), [
    "Commitment title: Commitment body",
  ]);
});

test("daily inputs are immutable idempotent revisions and reload exact persisted bytes", (t) => {
  const { db, repository } = fixture(t);
  const { startsAt } = resolveLocalDate({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
  });
  seedSession(db, { id: "session-a", startedAt: startsAt + 1_000 });
  seedSegment(db, {
    id: "segment-a",
    sessionId: "session-a",
    startedAt: startsAt + 2_000,
    text: "stable evidence",
  });
  const first = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  const replay = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  assert.equal(replay.status, "existing");
  assert.equal(replay.digestInputId, first.digestInputId);
  assert.equal(db.prepare("SELECT count(*) AS count FROM daily_digest_inputs").get().count, 1);

  const restarted = new MemoryRepository(db, {
    createId: () => "must-not-be-used",
    now: () => 20_000,
    validateRedactedCloudPayload: () => true,
  });
  const loaded = restarted.getDailyDigestInput(first.digestInputId);
  assert.equal(loaded.cloudPayloadJson, first.cloudPayloadJson);
  assert.equal(loaded.inputWatermarkJson, first.inputWatermarkJson);
  assert.equal(restarted.getDailyDigestInputBySourceHash(first.sourceHash).digestInputId, first.digestInputId);

  seedSegment(db, {
    id: "segment-b",
    sessionId: "session-a",
    startedAt: startsAt + 3_000,
    text: "new immutable evidence",
    ordinal: 1,
  });
  const next = repository.createDailyDigestInput({
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    modelVersion: "MiniMax-M2.7",
  });
  assert.equal(next.status, "created");
  assert.notEqual(next.sourceHash, first.sourceHash);
  assert.equal(db.prepare("SELECT count(*) AS count FROM daily_digest_inputs").get().count, 2);
  assert.equal(restarted.getDailyDigestInput(first.digestInputId).cloudPayloadJson, first.cloudPayloadJson);
});

test("empty local days return explicit empty without persisting cloud input", (t) => {
  const { db, repository } = fixture(t);
  assert.deepEqual(
    repository.createDailyDigestInput({
      localDate: "2026-07-17",
      timezone: "Asia/Shanghai",
      modelVersion: "MiniMax-M2.7",
    }),
    { status: "empty", localDate: "2026-07-17", timezone: "Asia/Shanghai" }
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM daily_digest_inputs").get().count, 0);
});
