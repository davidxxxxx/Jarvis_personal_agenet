const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const { createStableSegmentId } = require("../../src/jarvis/shared/segmentIds.ts");

function insertTranscriptLineageRow(db, overrides = {}) {
  db.prepare(
    `
    INSERT INTO transcript_segments (
      id, session_id, started_at, ended_at, person_id, speaker_label,
      text, confidence, is_stable, analysis_state, track_id, chunk_id,
      source_type, result_kind, version, model_version, completed_at
    ) VALUES (
      @id, @sessionId, @startedAt, @endedAt, NULL, @speakerLabel,
      @text, @confidence, @isStable, 'pending', @trackId, @chunkId,
      @sourceType, @resultKind, @version, @modelVersion, @completedAt
    )
  `
  ).run({
    id: "lineage-row",
    sessionId: "lineage-session",
    startedAt: 2_000,
    endedAt: 3_000,
    speakerLabel: "system",
    text: "valid transcript",
    confidence: 0.5,
    isStable: 1,
    trackId: "lineage-track",
    chunkId: "lineage-chunk",
    sourceType: "system",
    resultKind: "final",
    version: 1,
    modelVersion: "large-v3-turbo",
    completedAt: 4_000,
    ...overrides,
  });
}

function legacyAnalysisInput(overrides = {}) {
  return {
    runId: "legacy-run",
    sessionId: "legacy-session",
    kind: "final",
    inputHash: "legacy-input-hash",
    model: "legacy-model",
    windowStart: 1_000,
    windowEnd: 2_000,
    completedAt: 2_100,
    result: {
      summary: "Legacy analysis summary",
      decisions: [],
      suggestions: [],
      topics: [],
      todos: [],
      memories: [],
    },
    ...overrides,
  };
}

test("persists the selected capture mode on session creation", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());

  const session = repo.createSession({
    id: "dual-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "dual",
  });

  assert.equal(session.capture_mode, "dual");
  assert.equal(repo.getSession("dual-session").capture_mode, "dual");
});

test("incomplete active summaries expose an explicit paid refresh recommendation", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "incremental-summary-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repo.db
    .prepare(
      `INSERT INTO session_summary_revisions (
         id, session_id, revision, previous_revision_id, completeness, lifecycle,
         content_json, source_analysis_input_id, provenance, created_at
       ) VALUES (
         'summary-incremental', 'incremental-summary-session', 1, NULL,
         'incremental', 'active', ?, NULL, 'evidence_linked', 2_000
       )`
    )
    .run(JSON.stringify({ title: "Partial", summary: "Only part of the session was covered." }));

  assert.deepEqual(repo.getSessionSpeakerProcessing("incremental-summary-session").summaryRefresh, {
    basis_policy_id: null,
    latest_policy_id: "jarvis-session-diarization-v1",
    recommended: 1,
    reason: "summary_incomplete",
    updated_at: 2_000,
  });
});

test("activity classification corrections idempotently recommend a paid summary refresh", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "classification-refresh-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repo.db
    .prepare(
      `INSERT INTO session_summary_revisions (
         id, session_id, revision, previous_revision_id, completeness, lifecycle,
         content_json, source_analysis_input_id, provenance, created_at
       ) VALUES (
         'summary-classification-refresh', 'classification-refresh-session', 1, NULL,
         'final', 'active', ?, NULL, 'evidence_linked', 2_000
       )`
    )
    .run(JSON.stringify({ title: "Paid summary", summary: "Keep this local result." }));

  const first = repo.markSessionSummaryRefreshRecommended(
    "classification-refresh-session",
    "activity_classification_changed",
    3_000
  );
  const repeated = repo.markSessionSummaryRefreshRecommended(
    "classification-refresh-session",
    "activity_classification_changed",
    3_000
  );

  assert.deepEqual(repeated, first);
  assert.deepEqual(first, {
    session_id: "classification-refresh-session",
    basis_policy_id: null,
    latest_policy_id: "jarvis-session-diarization-v1",
    recommended: 1,
    reason: "activity_classification_changed",
    updated_at: 3_000,
  });
  assert.equal(
    repo.db
      .prepare("SELECT count(*) AS count FROM session_summary_refresh_state WHERE session_id = ?")
      .get("classification-refresh-session").count,
    1
  );
  assert.equal(
    repo.db.prepare("SELECT count(*) AS count FROM processing_jobs WHERE lane = 'cloud'").get()
      .count,
    0
  );
});

test("session timeline returns deterministic source evidence, visible text, and job counts", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "timeline-session",
    startedAt: 1_000,
    micDeviceId: "mic-1",
    captureMode: "dual",
  });
  repo.createTracks([
    {
      id: "track-system",
      sessionId: "timeline-session",
      sourceType: "system",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
    {
      id: "track-mic",
      sessionId: "timeline-session",
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
  ]);
  repo.openGap({
    id: "gap-late",
    trackId: "track-system",
    startedAt: 3_600,
    reason: "device_interrupted",
  });
  repo.closeGap("gap-late", 3_900, 2);
  repo.openGap({
    id: "gap-early",
    trackId: "track-mic",
    startedAt: 1_800,
    reason: "device_interrupted",
  });
  repo.closeGap("gap-early", 1_900, 1);

  const chunks = [
    ["chunk-pending", "track-mic", "mic", 0, 1_100],
    ["chunk-running", "track-system", "system", 0, 1_300],
    ["chunk-retry", "track-mic", "mic", 1, 2_100],
    ["chunk-blocked", "track-system", "system", 1, 2_300],
    ["chunk-completed", "track-system", "system", 2, 3_100],
  ];
  for (const [id, trackId, sourceType, sequenceNumber, startedAt] of chunks) {
    repo.commitChunk({
      id,
      sessionId: "timeline-session",
      trackId,
      sourceType,
      sequenceNumber,
      path: `${id}.wav`,
      startedAt,
      endedAt: startedAt + 100,
      durationMs: 100,
      sha256: id.padEnd(64, "a"),
      expiresAt: startedAt + 10_000,
    });
  }
  for (const [chunkId, state] of [
    ["chunk-running", "running"],
    ["chunk-retry", "retry"],
    ["chunk-blocked", "blocked"],
    ["chunk-completed", "completed"],
  ]) {
    repo.db.prepare("UPDATE processing_jobs SET state = ? WHERE chunk_id = ?").run(state, chunkId);
  }
  repo.db.prepare("UPDATE audio_chunks SET deleted_at = 5_000 WHERE id = 'chunk-retry'").run();

  const final = repo.commitChunkTranscript({
    chunk: repo.getAudioChunk("chunk-completed"),
    result: { text: "visible system text", confidence: 0.9, noSpeech: false },
    modelVersion: "large-v3-turbo",
    completedAt: 4_000,
  });
  repo.db
    .prepare(
      `INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, track_id, source_type, result_kind, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?)`
    )
    .run(
      "hidden-superseded",
      "timeline-session",
      3_100,
      3_200,
      "system",
      "old system text",
      0.4,
      0,
      "track-system",
      "system",
      final.id
    );
  repo.db
    .prepare(
      `INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, track_id, source_type, result_kind, echo_score, duplicate_of
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?)`
    )
    .run(
      "hidden-duplicate",
      "timeline-session",
      3_100,
      3_200,
      "mic",
      "echoed system text",
      0.4,
      0,
      "track-mic",
      "mic",
      0.92,
      final.id
    );
  repo.upsertTranscriptSegments("timeline-session", [
    {
      id: "visible-mic",
      startedAt: 1_600,
      endedAt: 1_700,
      personId: null,
      speakerLabel: "我",
      sourceType: "mic",
      text: "visible mic text",
      confidence: 0.8,
      isStable: true,
    },
  ]);
  repo.db
    .prepare(
      `UPDATE sessions SET status = 'completed', ended_at = 4_500,
       processing_state = 'processing', timeline_version = 7, finalized_at = 4_500
       WHERE id = 'timeline-session'`
    )
    .run();

  const timeline = repo.getSessionTimeline("timeline-session");

  assert.deepEqual(
    timeline.tracks.map((track) => track.source_type),
    ["mic", "system"]
  );
  assert.deepEqual(
    timeline.gaps.map((gap) => gap.id),
    ["gap-early", "gap-late"]
  );
  assert.deepEqual(
    timeline.tracks[0].gaps.map((gap) => gap.id),
    ["gap-early"]
  );
  assert.deepEqual(
    timeline.chunks.map((chunk) => chunk.id),
    chunks.map((chunk) => chunk[0])
  );
  assert.equal(timeline.chunks[2].deleted_at, 5_000);
  assert.deepEqual(
    timeline.segments.map((segment) => segment.id),
    ["visible-mic", final.id]
  );
  assert.deepEqual(timeline.processing_counts, {
    pending: 1,
    leased: 1,
    retry: 1,
    blocked: 1,
    completed: 1,
    total: 5,
  });
  assert.deepEqual(
    {
      session_id: timeline.session_id,
      status: timeline.status,
      processing_state: timeline.processing_state,
      timeline_version: timeline.timeline_version,
      finalized_at: timeline.finalized_at,
      ready_at: timeline.ready_at,
    },
    {
      session_id: "timeline-session",
      status: "completed",
      processing_state: "processing",
      timeline_version: 7,
      finalized_at: 4_500,
      ready_at: null,
    }
  );
});

test("session timeline exposes distinct application tracks and conservative fallback intervals", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "application-session",
    startedAt: 1_000,
    micDeviceId: "mic-1",
    captureMode: "dual",
  });
  repo.createTracks([
    {
      id: "track-mic",
      sessionId: "application-session",
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
    {
      id: "track-mix",
      sessionId: "application-session",
      sourceType: "system",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
    },
    {
      id: "track-chrome",
      sessionId: "application-session",
      sourceType: "system",
      applicationKey: "chrome",
      applicationDisplayName: "Chrome",
      captureGeneration: 1,
      strategy: "include-process-tree",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_050,
    },
    {
      id: "track-kook",
      sessionId: "application-session",
      sourceType: "system",
      applicationKey: "kook",
      applicationDisplayName: "KOOK",
      captureGeneration: 1,
      strategy: "include-process-tree",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_060,
    },
  ]);
  repo.createApplicationAudioInterval({
    id: "chrome-active",
    sessionId: "application-session",
    trackId: "track-chrome",
    intervalKind: "application_active",
    applicationKey: "chrome",
    attributionState: "exact",
    captureGeneration: 1,
    startedAt: 1_050,
    endedAt: 2_000,
  });
  repo.createApplicationAudioInterval({
    id: "chrome-fallback",
    sessionId: "application-session",
    trackId: "track-mix",
    intervalKind: "mixed_fallback",
    attributionState: "mixed_unknown",
    captureGeneration: 2,
    startedAt: 2_000,
    endedAt: 2_500,
    reason: "application_process_restarted",
  });
  repo.db
    .prepare(
      `INSERT INTO transcript_segments (
        id, session_id, started_at, ended_at, speaker_label, text, confidence,
        is_stable, track_id, source_type, result_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "kook-segment",
      "application-session",
      1_200,
      1_600,
      "说话人 1",
      "来自 KOOK 的文字",
      0.9,
      1,
      "track-kook",
      "system",
      "provisional"
    );

  const timeline = repo.getSessionTimeline("application-session");
  assert.deepEqual(
    timeline.tracks.map((track) => [track.id, track.track_kind, track.application_key]),
    [
      ["track-mic", "mic", null],
      ["track-chrome", "application", "chrome"],
      ["track-kook", "application", "kook"],
      ["track-mix", "system_mix", null],
    ]
  );
  assert.deepEqual(
    timeline.application_audio_intervals.map((interval) => [
      interval.id,
      interval.attribution_state,
      interval.application_key,
    ]),
    [
      ["chrome-active", "exact", "chrome"],
      ["chrome-fallback", "mixed_unknown", null],
    ]
  );
  assert.equal(repo.getSessionApplicationTrack("application-session", "chrome").id, "track-chrome");
  assert.equal(repo.getSessionApplicationTrack("application-session", "dota2"), null);
  assert.deepEqual(
    timeline.segments.map((segment) => [segment.id, segment.application_display_name]),
    [["kook-segment", "KOOK"]]
  );

  const paged = repo.getSessionTimeline("application-session", {
    trackOffset: 1,
    trackLimit: 2,
    intervalOffset: 1,
    intervalLimit: 1,
  });
  assert.deepEqual(
    paged.tracks.map((track) => track.id),
    ["track-chrome", "track-kook"]
  );
  assert.deepEqual(
    paged.application_audio_intervals.map((interval) => interval.id),
    ["chrome-fallback"]
  );
  assert.deepEqual(paged.evidence_page, {
    tracks: { total: 4, offset: 1, limit: 2 },
    intervals: { total: 2, offset: 1, limit: 1 },
  });
  assert.equal(paged.application_capture.exact_duration_ms, 950);
  assert.equal(paged.application_capture.fallback_duration_ms, 500);
  assert.equal(paged.application_capture.degraded_interval_count, 1);
});

test("system-only session persistence cannot retain a microphone device id", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());

  assert.throws(
    () =>
      repo.createSession({
        id: "system-session-invalid",
        startedAt: 1_000,
        micDeviceId: "must-not-persist",
        captureMode: "system",
      }),
    /system capture cannot persist a microphone device id/
  );
  assert.equal(repo.getSession("system-session-invalid"), null);

  const session = repo.createSession({
    id: "system-session-valid",
    startedAt: 2_000,
    micDeviceId: null,
    captureMode: "system",
  });

  assert.equal(session.capture_mode, "system");
  assert.equal(session.mic_device_id, null);
});

test("session-namespaced segment ids avoid restart-local raw id collisions", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const firstId = createStableSegmentId("s1", "seg-1");
  const secondId = createStableSegmentId("s2", "seg-1");
  const segment = {
    id: firstId,
    startedAt: 1100,
    endedAt: 1200,
    personId: null,
    speakerLabel: "mic",
    text: "First session",
    confidence: 0.5,
    isStable: true,
  };

  assert.notEqual(firstId, secondId);
  assert.match(firstId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(secondId, /^[A-Za-z0-9_-]{1,128}$/);
  const longId = createStableSegmentId("s".repeat(128), "raw".repeat(50));
  assert.match(longId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(longId, createStableSegmentId("s".repeat(128), "raw".repeat(50)));
  assert.notEqual(longId, createStableSegmentId("t".repeat(128), "raw".repeat(50)));
  repo.upsertTranscriptSegments("s1", [segment]);
  repo.upsertTranscriptSegments("s2", [
    { ...segment, id: secondId, startedAt: 2100, endedAt: 2200, text: "Second session" },
  ]);
  repo.upsertTranscriptSegments("s1", [{ ...segment, text: "Updated first session" }]);

  assert.equal(repo.listTranscriptSegments("s1")[0].id, firstId);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated first session");
  assert.equal(repo.listTranscriptSegments("s2")[0].id, secondId);
  repo.close();
});

test("session lifecycle and stable transcript upsert are idempotent", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: "mic-1" });
  repo.setSessionStatus("s1", "paused", 2000);
  const segment = {
    id: "seg-1",
    startedAt: 1100,
    endedAt: 1600,
    personId: "person-2",
    speakerLabel: "Speaker 2",
    text: "Send me the test feedback before Friday",
    confidence: 0.91,
    isStable: true,
  };
  repo.upsertTranscriptSegments("s1", [segment, segment]);

  const session = repo.getSession("s1");
  assert.equal(session.status, "paused");
  assert.equal(repo.listTranscriptSegments("s1").length, 1);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, segment.text);
  repo.close();
});

test("cross-session segment collisions reject and roll back the whole batch", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const original = {
    id: "seg-shared",
    startedAt: 1100,
    endedAt: 1200,
    personId: "p-original",
    speakerLabel: "Speaker 1",
    text: "Original session text",
    confidence: 0.9,
    isStable: true,
  };
  repo.upsertTranscriptSegments("s1", [original]);

  assert.throws(
    () =>
      repo.upsertTranscriptSegments("s2", [
        {
          id: "seg-new",
          startedAt: 2100,
          endedAt: 2200,
          personId: "p-new",
          speakerLabel: "Speaker 2",
          text: "Must roll back",
          confidence: 0.8,
          isStable: true,
        },
        {
          ...original,
          personId: "p-collision",
          speakerLabel: "Wrong speaker",
          text: "Must not overwrite session one",
        },
      ]),
    /segment belongs to a different session/
  );

  assert.deepEqual(repo.listTranscriptSegments("s2"), []);
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-new"),
    false
  );
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-collision"),
    false
  );
  assert.equal(repo.listTranscriptSegments("s1")[0].text, original.text);

  repo.upsertTranscriptSegments("s1", [{ ...original, text: "Updated in session one" }]);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated in session one");
  repo.close();
});

test("stable transcript snapshot sync deletes retractions transactionally and only within its session", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  const keep = {
    id: createStableSegmentId("s1", "seg-1"),
    startedAt: 1100,
    endedAt: 1200,
    personId: "p1",
    speakerLabel: "Speaker 1",
    text: "Keep me",
    confidence: 0.8,
    isStable: true,
  };
  const retract = {
    ...keep,
    id: createStableSegmentId("s1", "seg-2"),
    startedAt: 1300,
    endedAt: 1400,
    text: "Retract me",
  };
  const other = {
    ...keep,
    id: createStableSegmentId("s2", "seg-1"),
    startedAt: 2100,
    endedAt: 2200,
    personId: "p2",
    speakerLabel: "Speaker 2",
    text: "Other session",
  };
  repo.upsertTranscriptSegments("s1", [keep, retract]);
  repo.upsertTranscriptSegments("s2", [other]);
  repo.db
    .prepare("UPDATE transcript_segments SET analysis_state = 'ready' WHERE id = ?")
    .run(keep.id);

  repo.syncTranscriptSegments("s1", [{ ...keep, text: "Updated keep" }]);
  assert.deepEqual(
    repo.listTranscriptSegments("s1").map((segment) => segment.id),
    [keep.id]
  );
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Updated keep");
  assert.equal(repo.listTranscriptSegments("s1")[0].analysis_state, "ready");
  assert.equal(repo.listTranscriptSegments("s2")[0].id, other.id);

  assert.throws(
    () =>
      repo.syncTranscriptSegments("s1", [
        retract,
        { ...other, personId: "p-rollback", text: "Cross-session collision" },
      ]),
    /segment belongs to a different session/
  );
  assert.deepEqual(
    repo.listTranscriptSegments("s1").map((segment) => segment.id),
    [keep.id]
  );
  assert.equal(
    repo.listPeople().some((person) => person.id === "p-rollback"),
    false
  );
  assert.equal(repo.listTranscriptSegments("s2")[0].text, "Other session");

  repo.syncTranscriptSegments("s1", []);
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  assert.equal(repo.listTranscriptSegments("s2")[0].id, other.id);
  repo.close();
});

test("renaming a person changes display metadata without rewriting transcript text", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 1000,
      endedAt: 1200,
      personId: "p2",
      speakerLabel: "Speaker 2",
      text: "Hello",
      confidence: 0.8,
      isStable: true,
    },
  ]);
  repo.renamePerson({ personId: "p2", displayName: "Zhang San", isSelf: false });

  assert.equal(repo.listPeople()[0].display_name, "Zhang San");
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "Hello");
  repo.close();
});

test("renaming a profiled self preserves self and voice-profile identity", () => {
  const repo = new JarvisRepository(":memory:");
  repo.renamePerson({
    personId: "self",
    displayName: "Original",
    isSelf: true,
    voiceProfileId: 77,
  });

  const renamed = repo.renamePerson({ personId: "self", displayName: "Renamed" });

  assert.equal(renamed.display_name, "Renamed");
  assert.equal(renamed.is_self, 1);
  assert.equal(renamed.voice_profile_id, 77);
  repo.close();
});

test("ordinary rename preserves voice profile and mark-self preserves display name", () => {
  const repo = new JarvisRepository(":memory:");
  repo.renamePerson({
    personId: "p2",
    displayName: "张三",
    isSelf: false,
    voiceProfileId: 88,
  });

  const renamed = repo.renamePerson({ personId: "p2", displayName: "张先生" });
  const markedSelf = repo.renamePerson({ personId: "p2", isSelf: true });

  assert.equal(renamed.voice_profile_id, 88);
  assert.equal(renamed.is_self, 0);
  assert.equal(markedSelf.display_name, "张先生");
  assert.equal(markedSelf.voice_profile_id, 88);
  assert.equal(markedSelf.is_self, 1);
  repo.close();
});

test("speaker names are trimmed and bounded to 80 Unicode code points", () => {
  const repo = new JarvisRepository(":memory:");
  const eightyEmoji = "😀".repeat(80);

  const person = repo.renamePerson({ personId: "p2", displayName: `  ${eightyEmoji}  ` });

  assert.equal(person.display_name, eightyEmoji);
  assert.equal(Array.from(person.display_name).length, 80);
  assert.throws(
    () => repo.renamePerson({ personId: "p2", displayName: "😀".repeat(81) }),
    /at most 80 Unicode code points/
  );
  repo.close();
});

test("person and segment writes roll back together when a segment violates the schema", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });

  assert.throws(
    () =>
      repo.upsertTranscriptSegments("s1", [
        {
          id: "seg-1",
          startedAt: 1000,
          endedAt: 1200,
          personId: "p2",
          speakerLabel: "Speaker 2",
          text: null,
          confidence: 0.8,
          isStable: true,
        },
      ]),
    /NOT NULL/
  );
  assert.deepEqual(repo.listPeople(), []);
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  repo.close();
});

test("audio metadata retention and interrupted session recovery stay in jarvis.db", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: "mic-1" });
  repo.createSession({ id: "s2", startedAt: 2000, micDeviceId: null });
  repo.setSessionStatus("s2", "completed", 2600);
  repo.insertAudioChunk({
    id: "chunk-1",
    sessionId: "s1",
    path: "audio/s1/chunk-1.wav",
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    sha256: "a".repeat(64),
    expiresAt: 4000,
  });

  assert.equal(repo.listSessions({ from: 1500, to: 2500 })[0].id, "s2");
  assert.equal(repo.listExpiredAudioChunks(3999).length, 0);
  assert.equal(repo.listExpiredAudioChunks(4000)[0].id, "chunk-1");
  assert.deepEqual(
    repo.recoverOpenSessions(5000).map((session) => session.id),
    ["s1"]
  );
  assert.equal(repo.getSession("s1").status, "recovered");
  assert.equal(repo.getSession("s1").ended_at, 5000);
  assert.equal(repo.tombstoneChunk("chunk-1", 5_000).changes, 1);
  const retained = repo.listAudioChunks("s1");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].path, "tombstone:chunk-1");
  assert.equal(retained[0].deleted_at, 5_000);
  assert.equal(retained[0].sha256, "a".repeat(64));
  assert.equal(retained[0].started_at, 1_000);
  repo.close();
});

test("low-disk stop atomically persists paused tracks, reason, and durable boundary across restart recovery", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "low-disk", startedAt: 1_000, micDeviceId: "mic-1" });
  repo.createTrack({
    id: "track-low-disk",
    sessionId: "low-disk",
    sourceType: "mic",
    deviceId: "mic-1",
    deviceLabel: "Mic",
    strategy: "web-audio",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
    state: "active",
  });

  repo.pauseCaptureForLowDisk({
    sessionId: "low-disk",
    sources: [{ trackId: "track-low-disk", expectedState: "active" }],
    at: 2_000,
  });

  const paused = repo.getSession("low-disk");
  assert.equal(paused.status, "paused");
  assert.equal(paused.stop_reason, "capture_stopped_low_disk");
  assert.equal(paused.durable_boundary_at, 2_000);
  assert.equal(
    repo.db.prepare("SELECT state FROM audio_tracks WHERE id = ?").get("track-low-disk").state,
    "paused"
  );

  const recovered = repo.recoverOpenSessions(5_000);
  assert.equal(
    recovered.find((session) => session.id === "low-disk").stop_reason,
    "capture_stopped_low_disk"
  );
  assert.equal(repo.getSession("low-disk").status, "paused");

  repo.resumeCapture({
    sessionId: "low-disk",
    sources: [{ trackId: "track-low-disk", expectedState: "paused" }],
    at: 6_000,
  });
  assert.equal(repo.getSession("low-disk").stop_reason, null);
  assert.equal(repo.getSession("low-disk").durable_boundary_at, null);
  repo.close();
});

test("retired provenance is private across repository audio views", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repo.insertAudioChunk({
    id: "chunk-1",
    sessionId: "s1",
    path: "audio/s1/chunk-1.wav",
    startedAt: 1_000,
    endedAt: 1_500,
    durationMs: 500,
    sha256: "a".repeat(64),
    expiresAt: 4_000,
  });
  repo.db
    .prepare(
      `UPDATE audio_chunks
       SET retired_path = 'private.flac', retired_format = 'flac',
           retired_file_sha256 = ?
       WHERE id = 'chunk-1'`
    )
    .run("b".repeat(64));

  for (const chunk of [
    repo.getAudioChunk("chunk-1"),
    repo.listAudioChunks("s1")[0],
    repo.getSessionDetail("s1").audioChunks[0],
  ]) {
    assert.equal(Object.hasOwn(chunk, "retired_path"), false);
    assert.equal(Object.hasOwn(chunk, "retired_format"), false);
    assert.equal(Object.hasOwn(chunk, "retired_file_sha256"), false);
  }
  assert.deepEqual(repo.getSessionDetail("s1", { includeAudioChunks: false }).audioChunks, []);
});

test("schema initialization is idempotent and file databases use WAL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-repository-"));
  const dbPath = path.join(directory, "jarvis.db");

  try {
    const first = new JarvisRepository(dbPath);
    first.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
    first.close();

    const second = new JarvisRepository(dbPath);
    assert.equal(second.getSession("s1").language, "zh");
    assert.equal(second.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(second.db.pragma("synchronous", { simple: true }), 2);
    assert.equal(second.db.pragma("busy_timeout", { simple: true }), 5_000);
    assert.equal(second.db.pragma("wal_autocheckpoint", { simple: true }), 1_000);
    assert.equal(second.db.pragma("foreign_keys", { simple: true }), 1);
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("repository startup imports pre-existing legacy analysis on the same live connection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-startup-"));
  const dbPath = path.join(directory, "jarvis.db");
  let first = null;
  let second = null;
  try {
    first = new JarvisRepository(dbPath);
    first.createSession({ id: "legacy-session", startedAt: 1_000, micDeviceId: null });
    first.db
      .prepare(
        `INSERT INTO analysis_runs (
           id, session_id, kind, window_start, window_end, input_hash, model,
           status, attempt_count, response_json, created_at, completed_at
         ) VALUES (?, ?, 'final', 1000, 2000, ?, 'legacy-model',
                   'completed', 1, '{}', 2000, 2100)`
      )
      .run("legacy-run", "legacy-session", "legacy-input-hash");
    first.db
      .prepare(
        `INSERT INTO session_summaries (
           session_id, summary, decisions_json, suggestions_json,
           analysis_run_id, updated_at, is_final
         ) VALUES (?, 'Startup legacy summary', '[]', '[]', ?, 2100, 1)`
      )
      .run("legacy-session", "legacy-run");
    first.close();
    first = null;

    second = new JarvisRepository(dbPath);
    assert.ok(second.memoryRepository);
    assert.equal(second.memoryRepository.db, second.db);
    assert.equal(second.memoryRepository.validateRedactedCloudPayload({}), false);
    assert.deepEqual(
      second.db
        .prepare(
          `SELECT session_id, provenance, completeness
           FROM session_summary_revisions`
        )
        .get(),
      {
        session_id: "legacy-session",
        provenance: "legacy_unverified",
        completeness: "final",
      }
    );
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy apply and import share one transaction and completed-run recovery still scans", () => {
  const repo = new JarvisRepository(":memory:");
  try {
    repo.createSession({ id: "legacy-session", startedAt: 1_000, micDeviceId: null });
    const baselineRuns = repo.db
      .prepare("SELECT count(*) count FROM legacy_import_runs")
      .get().count;
    repo.db.exec(`
      CREATE TRIGGER fail_legacy_summary_import
      BEFORE INSERT ON legacy_import_map
      WHEN NEW.source_table = 'session_summaries'
      BEGIN
        SELECT RAISE(ABORT, 'injected repository legacy import failure');
      END;
    `);

    assert.throws(
      () => repo.applyAnalysisResult(legacyAnalysisInput()),
      /injected repository legacy import failure/
    );
    assert.equal(repo.db.prepare("SELECT count(*) count FROM analysis_runs").get().count, 0);
    assert.equal(repo.db.prepare("SELECT count(*) count FROM session_summaries").get().count, 0);
    assert.equal(
      repo.db.prepare("SELECT count(*) count FROM session_summary_revisions").get().count,
      0
    );
    assert.equal(
      repo.db.prepare("SELECT count(*) count FROM legacy_import_runs").get().count,
      baselineRuns
    );

    repo.db.exec("DROP TRIGGER fail_legacy_summary_import");
    repo.applyAnalysisResult(legacyAnalysisInput());
    assert.equal(repo.db.prepare("SELECT count(*) count FROM analysis_runs").get().count, 1);
    assert.equal(
      repo.db.prepare("SELECT count(*) count FROM session_summary_revisions").get().count,
      1
    );
    repo.db.exec(`
      INSERT INTO topics (
        id, canonical_title, normalized_title, description, status, created_at, last_seen_at
      ) VALUES (
        'late-legacy-topic', 'Late legacy topic', 'late legacy topic',
        'Imported through completed-run recovery', 'active', 2000, 2200
      );
      INSERT INTO session_topics (session_id, topic_id, analysis_run_id)
      VALUES ('legacy-session', 'late-legacy-topic', 'legacy-run');
    `);

    repo.applyAnalysisResult(legacyAnalysisInput());
    assert.equal(repo.db.prepare("SELECT count(*) count FROM topics_v2").get().count, 1);
    assert.equal(repo.db.prepare("SELECT count(*) count FROM topic_occurrences").get().count, 1);
    assert.equal(
      repo.db.prepare("SELECT count(*) count FROM legacy_import_runs").get().count,
      baselineRuns + 2
    );
  } finally {
    repo.close();
  }
});

test("real legacy applies keep one imported memory occurrence per evidence session across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-memory-session-import-"));
  const dbPath = path.join(directory, "jarvis.db");
  let repo = null;
  try {
    repo = new JarvisRepository(dbPath);
    const addEvidenceSession = (suffix, startedAt) => {
      const sessionId = `memory-session-${suffix}`;
      const trackId = `memory-track-${suffix}`;
      const chunkId = `memory-chunk-${suffix}`;
      repo.createSession({
        id: sessionId,
        startedAt,
        micDeviceId: `memory-mic-${suffix}`,
        captureMode: "mic",
      });
      repo.createTrack({
        id: trackId,
        sessionId,
        sourceType: "mic",
        deviceId: `memory-mic-${suffix}`,
        sampleRate: 24_000,
        channels: 1,
        startedAt,
      });
      repo.commitChunk({
        id: chunkId,
        sessionId,
        trackId,
        sourceType: "mic",
        sequenceNumber: 0,
        path: `${chunkId}.wav`,
        startedAt: startedAt + 100,
        endedAt: startedAt + 1_100,
        durationMs: 1_000,
        sha256: suffix.repeat(64),
        expiresAt: startedAt + 10_000,
      });
      const segment = repo.commitChunkTranscript({
        chunk: repo.getAudioChunk(chunkId),
        result: { text: `memory evidence ${suffix}`, confidence: 0.95 },
        modelVersion: "large-v3-turbo",
        completedAt: startedAt + 1_200,
      });
      return { sessionId, segmentId: segment.id, startedAt };
    };
    const applyMemory = ({ sessionId, segmentId, startedAt }, suffix) =>
      repo.applyAnalysisResult(
        legacyAnalysisInput({
          runId: `memory-run-${suffix}`,
          sessionId,
          inputHash: `memory-input-${suffix}`,
          windowStart: startedAt,
          windowEnd: startedAt + 1_100,
          completedAt: startedAt + 1_300,
          result: {
            summary: `Memory summary ${suffix}`,
            decisions: [],
            suggestions: [],
            topics: [],
            todos: [],
            memories: [
              {
                type: "fact",
                content: "Stable memory across sessions",
                personRef: null,
                topicRef: null,
                confidence: 0.9,
                evidenceSegmentIds: [segmentId],
              },
            ],
          },
        })
      );

    applyMemory(addEvidenceSession("a", 1_000), "a");
    applyMemory(addEvidenceSession("b", 20_000), "b");

    const occurrenceCounts = () =>
      repo.db
        .prepare(
          `SELECT legacy_session_id, count(*) AS count
           FROM memory_occurrences
           GROUP BY legacy_session_id ORDER BY legacy_session_id`
        )
        .all();
    const evidenceCounts = () =>
      repo.db
        .prepare(
          `SELECT occurrence.legacy_session_id, count(*) AS count
           FROM evidence_refs AS evidence
           JOIN memory_occurrences AS occurrence ON occurrence.id = evidence.entity_id
           WHERE evidence.entity_type = 'memory_occurrence'
           GROUP BY occurrence.legacy_session_id ORDER BY occurrence.legacy_session_id`
        )
        .all();
    const expectedCounts = [
      { legacy_session_id: "memory-session-a", count: 1 },
      { legacy_session_id: "memory-session-b", count: 1 },
    ];
    assert.deepEqual(occurrenceCounts(), expectedCounts);
    assert.deepEqual(evidenceCounts(), expectedCounts);

    repo.close();
    repo = new JarvisRepository(dbPath);
    assert.deepEqual(repo.memoryRepository.importLegacyAnalysis(), {
      status: "completed",
      importedRowCount: 0,
    });
    assert.deepEqual(occurrenceCounts(), expectedCounts);
    assert.deepEqual(evidenceCounts(), expectedCounts);
  } finally {
    repo?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reopen reconstructs MemoryRepository against only the replacement database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-memory-reopen-"));
  const firstPath = path.join(root, "first.db");
  const secondPath = path.join(root, "second.db");
  let repo = null;
  try {
    repo = new JarvisRepository(firstPath);
    const previousMemoryRepository = repo.memoryRepository;
    const previousDatabase = repo.db;

    repo.reopen(secondPath);

    assert.notEqual(repo.memoryRepository, previousMemoryRepository);
    assert.notEqual(repo.db, previousDatabase);
    assert.equal(previousDatabase.open, false);
    assert.equal(repo.memoryRepository.db, repo.db);
    assert.equal(repo.memoryRepository.db.open, true);
  } finally {
    repo?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema constraints reject unknown statuses and cascade session-owned rows", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.upsertTranscriptSegments("s1", [
    {
      id: "seg-1",
      startedAt: 1000,
      endedAt: 1200,
      personId: "p1",
      speakerLabel: "Speaker 1",
      text: "Hello",
      confidence: 0.8,
      isStable: true,
    },
  ]);

  assert.throws(() => repo.setSessionStatus("s1", "hidden-recording"), /invalid session status/);
  assert.throws(
    () =>
      repo.upsertTranscriptSegments("missing", [
        {
          id: "seg-2",
          startedAt: 1000,
          endedAt: 1200,
          personId: null,
          speakerLabel: "Speaker 1",
          text: "Hello",
          confidence: 0.8,
          isStable: true,
        },
      ]),
    /FOREIGN KEY/
  );
  repo.db.prepare("DELETE FROM people WHERE id = ?").run("p1");
  assert.equal(repo.listTranscriptSegments("s1")[0].person_id, null);
  repo.db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
  assert.deepEqual(repo.listTranscriptSegments("s1"), []);
  repo.close();
});

test("cloud budget settings and settled usage persist across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cloud-budget-"));
  const dbPath = path.join(directory, "jarvis.db");
  let first = null;
  let second = null;

  try {
    first = new JarvisRepository(dbPath);
    assert.deepEqual(first.getCloudBudgetSettings(), {
      provider: "openai",
      monthly_limit_microusd: 5_000_000,
      enabled: 0,
      updated_at: 0,
    });
    first.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 10 });
    assert.equal(
      first.reserveCloudUsage({
        id: "usage_1",
        monthUtc: "2026-07",
        model: "gpt-4o-transcribe",
        audioMs: 12_000,
        reservedMicrousd: 100_000,
        priceVersion: "openai-2026-07-11",
        createdAt: 20,
      }).ok,
      true
    );
    first.settleCloudUsage({
      id: "usage_1",
      inputTokens: 120,
      outputTokens: 18,
      actualMicrousd: 480,
      settledAt: 30,
    });
    first.close();
    first = null;

    second = new JarvisRepository(dbPath);
    assert.equal(second.getCloudBudgetSettings().enabled, 1);
    assert.deepEqual(second.getCloudBudgetStatus(Date.UTC(2026, 6, 20)), {
      monthUtc: "2026-07",
      enabled: true,
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 480,
      reservedMicrousd: 0,
      remainingMicrousd: 4_999_520,
      blockedReason: null,
    });
    second.close();
    second = null;
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cloud usage reservation atomically protects the monthly limit", () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  repo.db
    .prepare(
      `
    INSERT INTO cloud_usage (
      id, month_utc, provider, model, audio_ms, input_tokens, output_tokens,
      price_version, reserved_microusd, actual_microusd, status, created_at, settled_at
    ) VALUES (?, ?, 'openai', 'gpt-4o-transcribe', 1000, 0, 0, ?, 0, ?, 'settled', 1, 2)
  `
    )
    .run("spent", "2026-07", "openai-2026-07-11", 4_950_001);

  const result = repo.reserveCloudUsage({
    id: "usage_2",
    monthUtc: "2026-07",
    model: "gpt-4o-transcribe",
    audioMs: 12_000,
    reservedMicrousd: 100_000,
    priceVersion: "openai-2026-07-11",
    createdAt: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "budget_protected");
  assert.equal(repo.db.prepare("SELECT count(*) AS count FROM cloud_usage").get().count, 1);
  repo.close();
});

test("cloud budget validation rejects out-of-range limits and unknown usage fails closed", () => {
  const repo = new JarvisRepository(":memory:");
  assert.throws(
    () => repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 4_999_999 }),
    /between 5000000 and 10000000/
  );
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 10_000_000, at: 1 });
  assert.equal(
    repo.reserveCloudUsage({
      id: "usage_unknown",
      monthUtc: "2026-07",
      model: "gpt-4o-transcribe",
      audioMs: 1_000,
      reservedMicrousd: 100_000,
      priceVersion: "openai-2026-07-11",
      createdAt: 2,
    }).ok,
    true
  );
  repo.markCloudUsageUnknown({ id: "usage_unknown", settledAt: 3 });

  const blocked = repo.reserveCloudUsage({
    id: "usage_after_unknown",
    monthUtc: "2026-07",
    model: "gpt-4o-transcribe",
    audioMs: 1_000,
    reservedMicrousd: 100_000,
    priceVersion: "openai-2026-07-11",
    createdAt: 4,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "usage_unknown");
  repo.close();
});

test("transcript revisions preserve the original speaker and timestamp identity", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s_revision", startedAt: 1_000, micDeviceId: null });
  repo.upsertTranscriptSegments("s_revision", [
    {
      id: "seg_revision",
      startedAt: 1_900,
      endedAt: 1_900,
      personId: "self",
      speakerLabel: "我",
      text: "und der die das",
      confidence: 0.25,
      isStable: true,
    },
  ]);

  const revision = repo.addTranscriptRevision({
    id: "revision_1",
    sessionId: "s_revision",
    source: "mic",
    startedAt: 1_900,
    originalText: "und der die das",
    currentText: "我们 review 一下 API budget",
    confidence: 0.9,
    reason: "unexpected_language",
    correctedAt: 2_500,
  });

  assert.equal(revision.source, "openai_correction");
  assert.equal(revision.person_id, "self");
  assert.equal(revision.speaker_label, "我");
  assert.equal(revision.started_at, 1_900);
  assert.equal(repo.listTranscriptSegments("s_revision")[0].text, "und der die das");
  assert.equal(
    repo.addTranscriptRevision({
      id: "revision_wrong",
      sessionId: "missing",
      source: "mic",
      startedAt: 1_900,
      originalText: "und der die das",
      currentText: "wrong",
      confidence: 0.9,
      reason: "test",
      correctedAt: 2_500,
    }),
    null
  );
  repo.close();
});

test("derived memory analysis is idempotent and queryable from every Jarvis view", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "history-1", startedAt: 1_000, micDeviceId: "mv7", language: "auto" });
  repo.setSessionStatus("history-1", "completed", 61_000);
  repo.upsertTranscriptSegments("history-1", [
    {
      id: "seg-history-1",
      startedAt: 2_000,
      endedAt: 3_000,
      personId: "person-2",
      speakerLabel: "说话人 2",
      text: "周五前完成戒指 SDK 对接。",
      confidence: 0.94,
      isStable: true,
    },
  ]);
  const input = {
    runId: "run-history-1",
    sessionId: "history-1",
    kind: "final",
    inputHash: "hash-history-1",
    model: "MiniMax-M2.7",
    windowStart: 1_000,
    windowEnd: 61_000,
    completedAt: 62_000,
    result: {
      summary: "讨论了智能戒指 SDK 的交付安排。",
      decisions: ["采用厂商提供的 SDK"],
      suggestions: [{ content: "先确认 BLE 协议文档", reason: "减少逆向开发风险" }],
      topics: [
        {
          title: "智能戒指 SDK",
          description: "SDK、BLE 协议和交付计划",
          evidenceSegmentIds: ["seg-history-1"],
        },
      ],
      todos: [
        {
          content: "完成戒指 SDK 对接",
          ownerRef: "person-2",
          dueDate: "2026-07-17",
          topicRef: "智能戒指 SDK",
          evidenceSegmentIds: ["seg-history-1"],
        },
      ],
      memories: [
        {
          type: "decision",
          content: "采用厂商提供的 SDK",
          personRef: "person-2",
          topicRef: "智能戒指 SDK",
          confidence: 0.93,
          evidenceSegmentIds: ["seg-history-1"],
        },
      ],
    },
  };
  repo.applyAnalysisResult(input);
  repo.applyAnalysisResult(input);
  const detail = repo.getSessionDetail("history-1");
  assert.equal(detail.summary.summary, "讨论了智能戒指 SDK 的交付安排。");
  assert.equal(detail.segments.length, 1);
  assert.equal(detail.topics.length, 1);
  assert.equal(detail.todos.length, 1);
  assert.equal(repo.listTopics().length, 1);
  const changesBeforeTopicRead = repo.db.prepare("SELECT total_changes() AS count").get().count;
  const topicDetail = repo.getTopicDetail(repo.listTopics()[0].id);
  const changesAfterTopicRead = repo.db.prepare("SELECT total_changes() AS count").get().count;
  assert.equal(changesAfterTopicRead, changesBeforeTopicRead);
  assert.equal(topicDetail.people[0].id, "person-2");
  assert.deepEqual(topicDetail.decisions, [
    { sessionId: "history-1", content: "采用厂商提供的 SDK" },
  ]);
  assert.equal(topicDetail.sessions[0].id, "history-1");
  assert.equal(topicDetail.todos[0].owner_name, "说话人 2");
  assert.equal(topicDetail.memories[0].person_name, "说话人 2");
  assert.equal(repo.listTodos().length, 1);
  assert.equal(repo.listMemories().length, 1);
  const people = repo.listPeopleOverview();
  assert.equal(people[0].id, "person-2");
  assert.equal(people[0].session_count, 1);
  assert.equal(people[0].open_todo_count, 1);
  assert.deepEqual(
    repo.searchMemory("戒指", 20).map((row) => row.id),
    ["history-1"]
  );
  const todo = repo.listTodos()[0];
  assert.equal(repo.setTodoStatus(todo.id, "completed", 70_000).status, "completed");
  assert.equal(repo.setTodoStatus(todo.id, "open", 80_000).completed_at, null);
  repo.close();
});

test("session detail and search expose the active v2 summary when no legacy summary exists", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({ id: "v2-summary-session", startedAt: 1_000, micDeviceId: null });
  repo.db
    .prepare(
      `INSERT INTO session_summary_revisions (
         id, session_id, revision, previous_revision_id, completeness, lifecycle,
         content_json, source_analysis_input_id, provenance, created_at
       ) VALUES (?, ?, 1, NULL, 'final', 'active', ?, NULL, 'evidence_linked', ?)`
    )
    .run(
      "v2-summary-revision",
      "v2-summary-session",
      JSON.stringify({
        title: "Project Northstar",
        summary: "The unique v2 summary is visible in the completed session.",
      }),
      2_000
    );

  assert.deepEqual(repo.getSessionDetail("v2-summary-session").summary, {
    session_id: "v2-summary-session",
    summary: "The unique v2 summary is visible in the completed session.",
    decisions_json: "[]",
    suggestions_json: "[]",
    updated_at: 2_000,
    is_final: 1,
  });
  assert.deepEqual(
    repo.searchMemory("Northstar", 10).map((session) => session.id),
    ["v2-summary-session"]
  );
  assert.deepEqual(
    repo.searchMemory("unique v2 summary", 10).map((session) => session.id),
    ["v2-summary-session"]
  );
});

test("analysis evidence must belong to the target session and rolls back as a unit", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s-analysis", startedAt: 1, micDeviceId: null });
  repo.upsertTranscriptSegments("s-analysis", [
    {
      id: "seg-allowed",
      startedAt: 1,
      endedAt: 2,
      personId: null,
      speakerLabel: "mic",
      text: "有效证据",
      confidence: 1,
      isStable: true,
    },
  ]);
  assert.throws(
    () =>
      repo.applyAnalysisResult({
        runId: "run-invalid",
        sessionId: "s-analysis",
        kind: "incremental",
        inputHash: "hash-invalid",
        model: "MiniMax-M2.7",
        windowStart: 1,
        windowEnd: 2,
        completedAt: 3,
        result: {
          summary: "不应保存",
          decisions: [],
          suggestions: [],
          topics: [],
          todos: [],
          memories: [
            {
              type: "fact",
              content: "无证据事实",
              personRef: null,
              topicRef: null,
              confidence: 0.9,
              evidenceSegmentIds: ["seg-other-session"],
            },
          ],
        },
      }),
    /evidence segment/
  );
  assert.equal(repo.getSessionDetail("s-analysis").summary, null);
  assert.equal(repo.listMemories().length, 0);
  repo.close();
});

test("fresh schema rejects hostile final transcript lineage at the SQL boundary", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "lineage-session",
    startedAt: 1_000,
    micDeviceId: null,
    captureMode: "system",
  });
  repo.createTrack({
    id: "lineage-track",
    sessionId: "lineage-session",
    sourceType: "system",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repo.commitChunk({
    id: "lineage-chunk",
    sessionId: "lineage-session",
    trackId: "lineage-track",
    sourceType: "system",
    sequenceNumber: 0,
    path: "lineage.wav",
    startedAt: 2_000,
    endedAt: 3_000,
    durationMs: 1_000,
    sha256: "a".repeat(64),
    expiresAt: 10_000,
  });
  repo.createSession({
    id: "other-session",
    startedAt: 1_000,
    micDeviceId: null,
    captureMode: "system",
  });
  repo.createTrack({
    id: "other-track",
    sessionId: "other-session",
    sourceType: "system",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repo.commitChunk({
    id: "other-chunk",
    sessionId: "other-session",
    trackId: "other-track",
    sourceType: "system",
    sequenceNumber: 0,
    path: "other.wav",
    startedAt: 2_000,
    endedAt: 3_000,
    durationMs: 1_000,
    sha256: "b".repeat(64),
    expiresAt: 10_000,
  });

  for (const [name, overrides] of [
    ["source type", { sourceType: "cloud" }],
    ["result kind", { resultKind: "draft" }],
    ["version", { version: 0 }],
    ["confidence", { confidence: 1.1 }],
    ["stable flag", { isStable: 2 }],
    ["missing track", { trackId: null }],
    ["unknown track", { trackId: "missing-track" }],
    ["missing chunk", { chunkId: null }],
    ["unknown chunk", { chunkId: "missing-chunk" }],
    ["missing model", { modelVersion: null }],
    ["missing completion", { completedAt: null }],
    ["cross-session lineage", { trackId: "other-track", chunkId: "other-chunk" }],
    ["mismatched chunk time", { startedAt: 2_001 }],
  ]) {
    assert.throws(
      () => insertTranscriptLineageRow(repo.db, { id: `invalid-${name}`, ...overrides }),
      undefined,
      name
    );
  }

  insertTranscriptLineageRow(repo.db, {
    id: "valid-provisional",
    confidence: null,
    isStable: 0,
    trackId: null,
    chunkId: null,
    sourceType: "mic",
    resultKind: "provisional",
    modelVersion: null,
    completedAt: null,
  });
  insertTranscriptLineageRow(repo.db, { id: "valid-final" });
  assert.equal(repo.db.prepare("SELECT count(*) count FROM transcript_segments").get().count, 2);
});

test("an empty renderer snapshot never deletes a durable final transcript", (t) => {
  const repo = new JarvisRepository(":memory:");
  t.after(() => repo.close());
  repo.createSession({
    id: "snapshot-final-session",
    startedAt: 1_000,
    micDeviceId: "physical-mic",
    captureMode: "mic",
  });
  repo.createTrack({
    id: "snapshot-final-track",
    sessionId: "snapshot-final-session",
    sourceType: "mic",
    deviceId: "physical-mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  const chunk = {
    id: "snapshot-final-chunk",
    sessionId: "snapshot-final-session",
    trackId: "snapshot-final-track",
    sourceType: "mic",
    sequenceNumber: 0,
    path: "snapshot-final.wav",
    startedAt: 2_000,
    endedAt: 3_000,
    durationMs: 1_000,
    sha256: "c".repeat(64),
    expiresAt: 10_000,
  };
  repo.commitChunk(chunk);
  const finalSegment = repo.commitChunkTranscript({
    chunk: repo.getAudioChunk(chunk.id),
    result: { text: "durable final", confidence: 0.95 },
    modelVersion: "large-v3-turbo",
    completedAt: 4_000,
  });

  repo.syncTranscriptSegments("snapshot-final-session", []);

  assert.deepEqual(
    repo.listTranscriptSegments("snapshot-final-session").map((segment) => segment.id),
    [finalSegment.id]
  );
});

test("reopens the same repository object against a verified migrated database", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reopen-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldPath = path.join(root, "old", "jarvis.db");
  const newPath = path.join(root, "new", "jarvis.db");
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  const repo = new JarvisRepository(oldPath);
  repo.createSession({ id: "migrated", startedAt: 1_000, micDeviceId: null });
  repo.close();
  fs.copyFileSync(oldPath, newPath);

  repo.reopen(newPath);

  assert.equal(repo.getSession("migrated").id, "migrated");
  assert.equal(repo.dbPath, newPath);
  repo.close();
});

test("checkpoints WAL and relocates every contained audio locator in one transaction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-relocate-locators-"));
  const oldRecordingsRoot = path.join(root, "old", "recordings");
  const newRecordingsRoot = path.join(root, "new", "recordings");
  const dbPath = path.join(root, "old", "jarvis.db");
  fs.mkdirSync(path.join(oldRecordingsRoot, "s1", "mic"), { recursive: true });
  const wavPath = path.join(oldRecordingsRoot, "s1", "mic", "chunk.wav");
  const retiredPath = path.join(oldRecordingsRoot, "s1", "mic", "chunk.flac");
  const repo = new JarvisRepository(dbPath);
  t.after(() => {
    repo.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  repo.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repo.insertAudioChunk({
    id: "c1",
    sessionId: "s1",
    path: wavPath,
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    sha256: "a".repeat(64),
    expiresAt: 10_000,
  });
  repo.db
    .prepare("UPDATE audio_chunks SET retired_path = ?, retired_format = 'flac' WHERE id = ?")
    .run(retiredPath, "c1");

  repo.checkpointForMigration();
  repo.relocateDataRoot({
    fromRecordingsRoot: oldRecordingsRoot,
    toRecordingsRoot: newRecordingsRoot,
  });
  repo.relocateDataRoot({
    fromRecordingsRoot: oldRecordingsRoot,
    toRecordingsRoot: newRecordingsRoot,
  });

  const row = repo.db.prepare("SELECT path, retired_path FROM audio_chunks WHERE id = ?").get("c1");
  assert.equal(row.path, path.join(newRecordingsRoot, "s1", "mic", "chunk.wav"));
  assert.equal(row.retired_path, path.join(newRecordingsRoot, "s1", "mic", "chunk.flac"));
  assert.equal(repo.db.pragma("wal_checkpoint(PASSIVE)", { simple: true }), 0);
});

test("locator relocation rejects one escaping absolute path without partially updating rows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reject-locator-"));
  const oldRecordingsRoot = path.join(root, "old", "recordings");
  const newRecordingsRoot = path.join(root, "new", "recordings");
  fs.mkdirSync(oldRecordingsRoot, { recursive: true });
  const repo = new JarvisRepository(path.join(root, "old", "jarvis.db"));
  t.after(() => {
    repo.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  repo.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  for (const [id, chunkPath] of [
    ["safe", path.join(oldRecordingsRoot, "safe.wav")],
    ["escape", path.join(root, "outside.wav")],
  ]) {
    repo.insertAudioChunk({
      id,
      sessionId: "s1",
      path: chunkPath,
      startedAt: 1_000,
      endedAt: 2_000,
      durationMs: 1_000,
      sha256: id === "safe" ? "a".repeat(64) : "b".repeat(64),
      expiresAt: 10_000,
    });
  }

  assert.throws(
    () =>
      repo.relocateDataRoot({
        fromRecordingsRoot: oldRecordingsRoot,
        toRecordingsRoot: newRecordingsRoot,
      }),
    /audio locator escapes the previous recordings root/
  );
  assert.equal(repo.getAudioChunk("safe").path, path.join(oldRecordingsRoot, "safe.wav"));
});
