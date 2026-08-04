const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const DualTrackTranscriptDeduper = require("../../src/jarvis/main/DualTrackTranscriptDeduper");
const { normalizedSimilarity } = DualTrackTranscriptDeduper;

function fixture(
  t,
  {
    sessionId = "session-1",
    acousticMatcher = null,
    acousticAdmission = null,
    acousticBatchSize = 4,
    acousticYield = async () => {},
  } = {}
) {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({
    id: sessionId,
    startedAt: 0,
    micDeviceId: "physical-mic",
    captureMode: "dual",
  });
  for (const sourceType of ["mic", "system"]) {
    repository.createTrack({
      id: `${sessionId}-track-${sourceType}`,
      sessionId,
      sourceType,
      deviceId: sourceType === "mic" ? "physical-mic" : null,
      deviceLabel: sourceType === "mic" ? "Desk microphone" : "PC audio",
      strategy: sourceType === "mic" ? "web-audio" : "wasapi-loopback",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 0,
    });
  }
  repository.createTrack({
    id: `${sessionId}-track-app-chrome`,
    sessionId,
    sourceType: "system",
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
    captureGeneration: 1,
    deviceLabel: "Chrome",
    strategy: "wasapi-application-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
  });
  return {
    repository,
    deduper: new DualTrackTranscriptDeduper({
      repository,
      acousticMatcher,
      acousticAdmission,
      acousticBatchSize,
      acousticYield,
    }),
    sessionId,
  };
}

function segment(
  repository,
  { id, sessionId = "session-1", sourceType, startedAt, endedAt, text, echoScore = null }
) {
  repository.upsertTranscriptSegments(sessionId, [
    {
      id,
      startedAt,
      endedAt,
      personId: null,
      speakerLabel: sourceType,
      sourceType,
      text,
      confidence: 0.9,
      isStable: true,
      echoScore,
    },
  ]);
  return repository.getTranscriptSegment(id);
}

function rawChunk(
  repository,
  {
    id,
    sourceType,
    sequenceNumber,
    sessionId = "session-1",
    trackId = `${sessionId}-track-${sourceType}`,
    startedAt = 100,
    endedAt = 200,
  }
) {
  repository.commitChunk({
    id,
    sessionId,
    trackId,
    sourceType,
    sequenceNumber,
    path: `${id}.wav`,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    sha256: crypto.createHash("sha256").update(id).digest("hex"),
    expiresAt: 1_000_000,
  });
  return repository.getAudioChunk(id);
}

function finalApplicationSegment(
  repository,
  {
    id,
    sessionId = "session-1",
    applicationKey = "chrome",
    startedAt = 100,
    endedAt = 200,
    text,
    sequenceNumber = 0,
  }
) {
  const chunkId = `${id}-chunk`;
  rawChunk(repository, {
    id: chunkId,
    sessionId,
    sourceType: "system",
    trackId: `${sessionId}-track-app-${applicationKey}`,
    sequenceNumber,
    startedAt,
    endedAt,
  });
  repository.commitChunkTranscript({
    chunk: repository.getAudioChunk(chunkId),
    result: { text, confidence: 0.95 },
    modelVersion: "whisper-test-v1",
    completedAt: endedAt + 1,
  });
  return repository.getTranscriptSegment(
    repository.db
      .prepare("SELECT id FROM transcript_segments WHERE chunk_id = ? AND result_kind = 'final'")
      .get(chunkId).id
  );
}

test("exact application transcript hides the covered system-mix audit copy by default", (t) => {
  const { repository } = fixture(t);
  rawChunk(repository, {
    id: "system-audit-chunk",
    sourceType: "system",
    sequenceNumber: 0,
    startedAt: 100,
    endedAt: 200,
  });
  repository.commitChunkTranscript({
    chunk: repository.getAudioChunk("system-audit-chunk"),
    result: { text: "KOOK 和 DOTA 的安全混音副本", confidence: 0.8 },
    modelVersion: "whisper-test-v1",
    completedAt: 201,
  });
  const systemSegment = repository.db
    .prepare(
      `SELECT id FROM transcript_segments
       WHERE chunk_id = 'system-audit-chunk' AND result_kind = 'final'`
    )
    .get();
  assert.deepEqual(repository.listTranscriptSegments("session-1").map((row) => row.id), [
    systemSegment.id,
  ]);

  const application = finalApplicationSegment(repository, {
    id: "kook-primary",
    startedAt: 100,
    endedAt: 200,
    text: "KOOK 独立应用主转写",
  });

  assert.deepEqual(repository.listTranscriptSegments("session-1").map((row) => row.id), [
    application.id,
  ]);
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT projection_state, projection_reason, duplicate_of
         FROM transcript_segments WHERE id = ?`
      )
      .get(systemSegment.id),
    {
      projection_state: "audit_hidden",
      projection_reason: "exact_application_primary",
      duplicate_of: null,
    }
  );
  assert.equal(repository.listAllTranscriptSegments("session-1").length, 2);
});

test("marks an acoustically proven MIC echo while retaining both rows and raw evidence", (t) => {
  const { repository, deduper } = fixture(t);
  const micChunkBefore = rawChunk(repository, {
    id: "mic-raw",
    sourceType: "mic",
    sequenceNumber: 0,
  });
  const systemChunkBefore = rawChunk(repository, {
    id: "system-raw",
    sourceType: "system",
    sequenceNumber: 0,
  });
  segment(repository, {
    id: "system-segment",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "周五交付 API v2",
  });
  segment(repository, {
    id: "mic-segment",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "周五交付，API V2。",
    echoScore: 0.92,
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mic-segment").duplicate_of, "system-segment");
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    ["system-segment"]
  );
  assert.deepEqual(
    repository.listAllTranscriptSegments("session-1").map((row) => [row.id, row.duplicate_of]),
    [
      ["system-segment", null],
      ["mic-segment", "system-segment"],
    ]
  );
  assert.deepEqual(repository.getAudioChunk("mic-raw"), micChunkBefore);
  assert.deepEqual(repository.getAudioChunk("system-raw"), systemChunkBefore);
});

test("requires every conservative predicate independently", async (t) => {
  const cases = [
    {
      name: "strict half-open overlap",
      mic: { startedAt: 200, endedAt: 300, text: "same", echoScore: 1 },
      system: { startedAt: 100, endedAt: 200, text: "same" },
    },
    {
      name: "durable acoustic evidence",
      mic: { startedAt: 110, endedAt: 190, text: "same", echoScore: 0.79 },
      system: { startedAt: 100, endedAt: 200, text: "same" },
    },
    {
      name: "normalized text similarity",
      mic: { startedAt: 110, endedAt: 190, text: "local answer", echoScore: 1 },
      system: { startedAt: 100, endedAt: 200, text: "remote question" },
    },
    {
      name: "non-empty normalized text",
      mic: { startedAt: 110, endedAt: 190, text: "...", echoScore: 1 },
      system: { startedAt: 100, endedAt: 200, text: "！！！" },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, (subtest) => {
      const sessionId = `negative-${index}`;
      const { repository, deduper } = fixture(subtest, { sessionId });
      segment(repository, {
        id: `system-${index}`,
        sessionId,
        sourceType: "system",
        ...entry.system,
      });
      segment(repository, {
        id: `mic-${index}`,
        sessionId,
        sourceType: "mic",
        ...entry.mic,
      });

      assert.deepEqual(deduper.dedupe(sessionId), { duplicatesMarked: 0 });
      assert.equal(repository.getVisibleTranscript(sessionId).length, 2);
    });
  }
});

test("ordinary overlap and double-talk without explicit acoustic evidence stay visible", (t) => {
  const { repository, deduper } = fixture(t);
  segment(repository, {
    id: "system",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "yes ship it",
  });
  segment(repository, {
    id: "mic",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "yes ship it",
    echoScore: null,
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    ["system", "mic"]
  );
});

test("keeps the exact application transcript as master over the mixed-system safety copy", (t) => {
  const { repository, deduper } = fixture(t);
  const mixedChunkBefore = rawChunk(repository, {
    id: "mixed-raw",
    sourceType: "system",
    sequenceNumber: 0,
  });
  const application = finalApplicationSegment(repository, {
    id: "chrome-final",
    text: "今晚八点观看英超比赛",
  });
  segment(repository, {
    id: "mixed-segment",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "今晚八点，观看英超比赛。",
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mixed-segment").duplicate_of, application.id);
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    [application.id]
  );
  assert.deepEqual(repository.getAudioChunk("mixed-raw"), mixedChunkBefore);
  assert.ok(repository.getAudioChunk("chrome-final-chunk"));
});

test("increments the session timeline version only when a duplicate relation changes", (t) => {
  const { repository, deduper } = fixture(t);
  finalApplicationSegment(repository, {
    id: "timeline-application",
    text: "周五交付 API v2",
  });
  segment(repository, {
    id: "timeline-mixed",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "周五交付，API V2。",
  });
  const version = () =>
    repository.db.prepare("SELECT timeline_version FROM sessions WHERE id = ?").get("session-1")
      .timeline_version;
  const before = version();

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(version(), before + 1);
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.equal(version(), before + 1);
});

test("suppresses a mixed fallback when one exact application covers the interval despite ASR drift", (t) => {
  const { repository, deduper } = fixture(t);
  const application = finalApplicationSegment(repository, {
    id: "meeting-final",
    startedAt: 100,
    endedAt: 1_100,
    text: "现在开始年度股东会议和财务报告",
  });
  segment(repository, {
    id: "mixed-drifted",
    sourceType: "system",
    startedAt: 150,
    endedAt: 1_050,
    text: "字幕志愿者 李宗盛 感谢观看",
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mixed-drifted").duplicate_of, application.id);
});

test("requires acoustic proof instead of timing-only application coverage when a matcher is enabled", async (t) => {
  const acousticCalls = [];
  const acousticMatcher = {
    async findWinner(mixed, applications) {
      acousticCalls.push({ mixed, applications });
      return null;
    },
  };
  const { repository, deduper } = fixture(t, { acousticMatcher });
  finalApplicationSegment(repository, {
    id: "application-unrelated",
    startedAt: 100,
    endedAt: 1_100,
    text: "年度股东会议和财务报告",
  });
  segment(repository, {
    id: "mixed-unrelated",
    sourceType: "system",
    startedAt: 150,
    endedAt: 1_050,
    text: "周末晚餐和天气预报",
  });

  assert.deepEqual(await deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.equal(repository.getTranscriptSegment("mixed-unrelated").duplicate_of, null);
  assert.equal(acousticCalls.length, 1);
});

test("suppresses a mixed fallback when one exact application dominates a short secondary app", (t) => {
  const { repository, deduper } = fixture(t);
  repository.createTrack({
    id: "session-1-track-app-wechat",
    sessionId: "session-1",
    sourceType: "system",
    applicationKey: "wechat",
    applicationDisplayName: "WeChat",
    captureGeneration: 1,
    strategy: "wasapi-application-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
  });
  const meeting = finalApplicationSegment(repository, {
    id: "meeting-final",
    startedAt: 100,
    endedAt: 1_100,
    text: "年度股东会议和财务报告",
  });
  finalApplicationSegment(repository, {
    id: "wechat-final",
    applicationKey: "wechat",
    startedAt: 350,
    endedAt: 600,
    text: "微信短消息",
  });
  segment(repository, {
    id: "mixed-drifted",
    sourceType: "system",
    startedAt: 100,
    endedAt: 1_100,
    text: "字幕志愿者 感谢观看",
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mixed-drifted").duplicate_of, meeting.id);
});

test("keeps a mixed fallback when two exact applications cover the same interval", (t) => {
  const { repository, deduper } = fixture(t);
  repository.createTrack({
    id: "session-1-track-app-kook",
    sessionId: "session-1",
    sourceType: "system",
    applicationKey: "kook",
    applicationDisplayName: "KOOK",
    captureGeneration: 1,
    strategy: "wasapi-application-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
  });
  finalApplicationSegment(repository, {
    id: "chrome-final",
    startedAt: 100,
    endedAt: 1_100,
    text: "Chrome 视频",
  });
  finalApplicationSegment(repository, {
    id: "kook-final",
    applicationKey: "kook",
    startedAt: 100,
    endedAt: 1_100,
    text: "KOOK 通话",
  });
  segment(repository, {
    id: "mixed-ambiguous",
    sourceType: "system",
    startedAt: 100,
    endedAt: 1_100,
    text: "混合系统音频",
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.equal(repository.getTranscriptSegment("mixed-ambiguous").duplicate_of, null);
});

test("uses strong acoustic evidence when KOOK and DOTA coverage makes ASR-only attribution ambiguous", async (t) => {
  const acousticCalls = [];
  const acousticMatcher = {
    async findWinner(mixed, applications) {
      acousticCalls.push({ mixed, applications });
      return {
        segment: applications.find((entry) => entry.application_key === "kook"),
        correlation: 0.986,
        lagMs: -280,
        voicedCoverage: 1,
      };
    },
  };
  const { repository, deduper } = fixture(t, { acousticMatcher });
  for (const [applicationKey, applicationDisplayName] of [
    ["kook", "KOOK"],
    ["dota2", "DOTA 2"],
  ]) {
    repository.createTrack({
      id: `session-1-track-app-${applicationKey}`,
      sessionId: "session-1",
      sourceType: "system",
      applicationKey,
      applicationDisplayName,
      captureGeneration: 1,
      strategy: "wasapi-application-loopback",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 0,
    });
  }
  const kook = finalApplicationSegment(repository, {
    id: "kook-final",
    applicationKey: "kook",
    startedAt: 100,
    endedAt: 60_100,
    text: "两个女机师。你把他两个女机师吃成啊!",
  });
  finalApplicationSegment(repository, {
    id: "dota-final",
    applicationKey: "dota2",
    startedAt: 100,
    endedAt: 60_100,
    text: "十秒。",
  });
  segment(repository, {
    id: "mixed-kook-copy",
    sourceType: "system",
    startedAt: 3_450,
    endedAt: 17_420,
    text: "两个女居士。你把她两个女居士吃成啊!",
  });

  assert.deepEqual(await deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mixed-kook-copy").duplicate_of, kook.id);
  assert.equal(acousticCalls.length, 1);
  assert.deepEqual(acousticCalls[0].applications.map((entry) => entry.application_key).sort(), [
    "dota2",
    "kook",
  ]);
});

test("governor admission is rechecked after cooperative acoustic batches", async (t) => {
  let admissionCalls = 0;
  let yieldCalls = 0;
  let acousticCalls = 0;
  const acousticMatcher = {
    async findWinner() {
      acousticCalls += 1;
      return null;
    },
  };
  const { repository, deduper } = fixture(t, {
    acousticMatcher,
    acousticAdmission: async () => {
      admissionCalls += 1;
      return true;
    },
    acousticBatchSize: 1,
    acousticYield: async () => {
      yieldCalls += 1;
    },
  });
  finalApplicationSegment(repository, {
    id: "application-budget",
    startedAt: 100,
    endedAt: 1_100,
    text: "application",
  });
  for (const [id, startedAt, endedAt] of [
    ["mixed-budget-1", 150, 450],
    ["mixed-budget-2", 650, 950],
  ]) {
    segment(repository, {
      id,
      sourceType: "system",
      startedAt,
      endedAt,
      text: id,
    });
  }

  assert.deepEqual(await deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.equal(acousticCalls, 2);
  assert.equal(admissionCalls, 2);
  assert.equal(yieldCalls, 1);
});

test("resource deferral keeps processing incomplete while preserving cheap text dedupe", async (t) => {
  let admissionCalls = 0;
  let acousticCalls = 0;
  const { repository, deduper } = fixture(t, {
    acousticAdmission: async () => {
      admissionCalls += 1;
      return false;
    },
    acousticMatcher: {
      async findWinner() {
        acousticCalls += 1;
        return null;
      },
    },
  });
  const application = finalApplicationSegment(repository, {
    id: "application-text",
    startedAt: 100,
    endedAt: 1_100,
    text: "周五交付 API v2",
  });
  segment(repository, {
    id: "mixed-text",
    sourceType: "system",
    startedAt: 150,
    endedAt: 1_050,
    text: "周五交付，API V2。",
  });
  segment(repository, {
    id: "mixed-weak",
    sourceType: "system",
    startedAt: 200,
    endedAt: 900,
    text: "完全不同的字幕",
  });

  await assert.rejects(deduper.dedupe("session-1"), (error) => {
    assert.equal(error.code, "ACOUSTIC_DEDUPE_RESOURCE_DEFERRED");
    return true;
  });
  assert.equal(repository.getTranscriptSegment("mixed-text").duplicate_of, application.id);
  assert.equal(repository.getTranscriptSegment("mixed-weak").duplicate_of, null);
  assert.equal(admissionCalls, 1);
  assert.equal(acousticCalls, 0);
});

test("skips resource admission when no mixed row has an overlapping application candidate", async (t) => {
  let admissionCalls = 0;
  let acousticCalls = 0;
  const { repository, deduper } = fixture(t, {
    acousticAdmission: async () => {
      admissionCalls += 1;
      return false;
    },
    acousticMatcher: {
      async findWinner() {
        acousticCalls += 1;
        return null;
      },
    },
  });
  segment(repository, {
    id: "mixed-without-application",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "系统提示音",
  });

  assert.deepEqual(await deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.equal(admissionCalls, 0);
  assert.equal(acousticCalls, 0);
});

test("prefers the application master when MIC echo matches both application and mixed system", (t) => {
  const { repository, deduper } = fixture(t);
  const application = finalApplicationSegment(repository, {
    id: "chrome-final",
    text: "release Friday",
  });
  segment(repository, {
    id: "system-mix",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "release Friday",
  });
  segment(repository, {
    id: "mic-echo",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "release Friday",
    echoScore: 0.95,
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 2 });
  assert.equal(repository.getTranscriptSegment("system-mix").duplicate_of, application.id);
  assert.equal(repository.getTranscriptSegment("mic-echo").duplicate_of, application.id);
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
});

test("never merges one exact application track into another application track", (t) => {
  const { repository, deduper } = fixture(t);
  repository.createTrack({
    id: "session-1-track-app-kook",
    sessionId: "session-1",
    sourceType: "system",
    applicationKey: "kook",
    applicationDisplayName: "KOOK",
    captureGeneration: 1,
    strategy: "wasapi-application-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
  });
  const chrome = finalApplicationSegment(repository, {
    id: "chrome-final",
    text: "今晚开黑",
  });
  const kook = finalApplicationSegment(repository, {
    id: "kook-final",
    applicationKey: "kook",
    text: "今晚开黑",
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
  assert.deepEqual(
    repository
      .getVisibleTranscript("session-1")
      .map((row) => row.id)
      .sort(),
    [chrome.id, kook.id].sort()
  );
});

test("chooses a deterministic SYSTEM winner and repeated runs are idempotent", (t) => {
  const { repository, deduper } = fixture(t);
  for (const id of ["system-z", "system-a"]) {
    segment(repository, {
      id,
      sourceType: "system",
      startedAt: 100,
      endedAt: 200,
      text: "release Friday",
    });
  }
  segment(repository, {
    id: "mic",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "release Friday",
    echoScore: 0.8,
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mic").duplicate_of, "system-a");
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 0 });
});

test("invalidates inbound duplicate relations when SYSTEM text changes through either write path", (t) => {
  const { repository, deduper } = fixture(t);
  const systemInput = {
    id: "system",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "release Friday",
  };
  segment(repository, systemInput);
  segment(repository, {
    id: "mic",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "release Friday",
    echoScore: 0.9,
  });

  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  segment(repository, { ...systemInput, text: "unrelated lunch plans" });
  assert.equal(repository.getTranscriptSegment("mic").duplicate_of, null);
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    ["system", "mic"]
  );

  segment(repository, systemInput);
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  repository.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run("direct SQL changed the subject", "system");
  assert.equal(repository.getTranscriptSegment("mic").duplicate_of, null);
  assert.deepEqual(
    repository.getVisibleTranscript("session-1").map((row) => row.id),
    ["system", "mic"]
  );

  repository.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE id = ?")
    .run(systemInput.text, "system");
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 1 });
  assert.equal(repository.getTranscriptSegment("mic").duplicate_of, "system");

  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET text = ?, source_type = ? WHERE id = ?")
        .run("must roll back", "invalid", "system"),
    /invalid transcript duplicate target|CHECK constraint failed/
  );
  assert.equal(repository.getTranscriptSegment("system").text, systemInput.text);
  assert.equal(repository.getTranscriptSegment("mic").duplicate_of, "system");
});

test("bounds pathological LCS work while preserving normal Chinese-English similarity", () => {
  assert.equal(
    normalizedSimilarity("今天 release ＡＰＩ v2，周五交付", "今天 RELEASE API V2 周五交付。"),
    1
  );
  assert.equal(normalizedSimilarity(`${"甲".repeat(4096)}A`, `${"甲".repeat(4096)}B`), 0);
});

test("schema rejects invalid echo scores and invalid MIC-to-SYSTEM relations", (t) => {
  const { repository, deduper } = fixture(t);
  segment(repository, {
    id: "system",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "same",
  });
  segment(repository, {
    id: "mic",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "same",
    echoScore: 0.9,
  });
  segment(repository, {
    id: "mic-other",
    sourceType: "mic",
    startedAt: 110,
    endedAt: 190,
    text: "same",
    echoScore: 0.9,
  });
  repository.createSession({
    id: "other-session",
    startedAt: 0,
    micDeviceId: null,
    captureMode: "system",
  });
  repository.createTrack({
    id: "other-session-track-system",
    sessionId: "other-session",
    sourceType: "system",
    deviceLabel: "Other PC audio",
    strategy: "wasapi-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 0,
  });
  segment(repository, {
    id: "other-system",
    sessionId: "other-session",
    sourceType: "system",
    startedAt: 100,
    endedAt: 200,
    text: "same",
  });
  assert.deepEqual(deduper.dedupe("session-1"), { duplicatesMarked: 2 });

  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET echo_score = 1.1 WHERE id = 'mic'")
        .run(),
    /CHECK constraint failed/
  );
  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET duplicate_of = 'mic-other' WHERE id = 'mic'")
        .run(),
    /invalid transcript duplicate/
  );
  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET duplicate_of = 'mic' WHERE id = 'system'")
        .run(),
    /invalid transcript duplicate/
  );
  const application = finalApplicationSegment(repository, {
    id: "chrome-final",
    text: "same",
    sequenceNumber: 2,
  });
  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET duplicate_of = ? WHERE id = ?")
        .run("system", application.id),
    /invalid transcript duplicate/
  );
  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET duplicate_of = 'other-system' WHERE id = 'mic'")
        .run(),
    /invalid transcript duplicate/
  );
  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE transcript_segments SET started_at = 200 WHERE id = 'system'")
        .run(),
    /invalid transcript duplicate target/
  );
});
