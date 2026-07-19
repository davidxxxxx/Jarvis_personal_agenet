const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHANNELS,
  assertId,
  assertSessionStatus,
  assertCaptureMode,
  assertSourceType,
  assertRetentionMode,
  normalizeResourceGovernanceSettings,
  normalizeApplicationAudioSettings,
} = require("../../src/jarvis/shared/contracts");
const registerJarvisIpcImpl = require("../../src/jarvis/main/registerJarvisIpc");

function createSpeakerCorrectionService(overrides = {}) {
  return {
    listSessionClusters: () => [],
    confirm: () => ({ cluster: { id: "c1" } }),
    reject: () => ({ id: "c1" }),
    undo: () => ({ id: "c1" }),
    listCorrections: () => [],
    mergePeople: () => ({ person: { id: "p-target" } }),
    ...overrides,
  };
}

function registerJarvisIpc(options) {
  return registerJarvisIpcImpl({
    speakerCorrectionService: createSpeakerCorrectionService(),
    ...options,
  });
}

function createRepository(overrides = {}) {
  return {
    memoryRepository: {
      readPublicSnapshot: () => ({
        memories: [],
        topics: [],
        todos: [],
        suggestions: [],
        memoryConflicts: [],
      }),
      acceptSuggestion: () => ({ status: "accepted" }),
      dismissSuggestion: () => ({ status: "dismissed" }),
      resolveMemoryConflict: () => ({ status: "resolved" }),
      completeTodo: () => ({ status: "completed" }),
      getEvidenceContext: () => null,
    },
    createSession: () => "created",
    setSessionStatus: () => "status-set",
    getSession: () => "session",
    listSessions: () => [],
    upsertTranscriptSegments: () => "segments-upserted",
    syncTranscriptSegments: () => "segments-synced",
    listTranscriptSegments: () => [],
    renamePerson: () => "renamed",
    listPeople: () => [],
    listAudioChunks: () => [],
    getAudioChunk: () => null,
    getSessionTimeline: () => null,
    getSessionDetail: () => ({ session: { id: "s1" } }),
    searchMemory: () => [],
    listPeopleOverview: () => [],
    getPersonDetail: () => null,
    listTopics: () => [],
    getTopicDetail: () => null,
    renameTopic: () => null,
    listTodos: () => [],
    setTodoStatus: () => null,
    listMemories: () => [],
    getTodayInsights: () => null,
    getCloudBudgetStatus: () => ({
      monthUtc: "2026-07",
      enabled: false,
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      remainingMicrousd: 5_000_000,
      blockedReason: "cloud_disabled",
    }),
    setCloudBudgetSettings: () => ({ enabled: 0 }),
    ...overrides,
  };
}

test("activity classification IPC exposes only decision evidence and normalized applications", () => {
  const handlers = new Map();
  const repository = createRepository({
    listSessionActivityClassifications: (sessionId) => [
      {
        id: "classification-1",
        sessionId,
        startedAt: 1_000,
        endedAt: 91_000,
        category: "learning",
        confidence: 0.88,
        decision: "adopted",
        source: "minimax",
        reason: "course-like explanatory content",
        sourceAttribution: "application_and_microphone",
        evidence: {
          activityId: "activity-1",
          applicationKeys: ["Chrome", "C:\\private\\chrome.exe", "Chrome"],
          allowSummary: true,
          allowSuggestions: false,
          allowTodos: false,
          evidenceSegmentIds: ["segment-1"],
          inputHash: "private-input-hash",
        },
        supersedesId: "private-history-id",
        userCorrectedAt: null,
        createdAt: 100_000,
        updatedAt: 100_000,
        embedding: [0.5],
        windowTitle: "private title",
      },
    ],
  });
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository,
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  const result = handlers.get(CHANNELS.listActivityClassifications)(null, "session-1");
  assert.deepEqual(result, [
    {
      id: "classification-1",
      sessionId: "session-1",
      startedAt: 1_000,
      endedAt: 91_000,
      category: "learning",
      confidence: 0.88,
      decision: "adopted",
      source: "minimax",
      reason: "course-like explanatory content",
      sourceAttribution: "application_and_microphone",
      applications: ["Chrome", "Chrome"],
      allowSummary: true,
      allowSuggestions: false,
      allowTodos: false,
      evidenceSegmentIds: ["segment-1"],
      createdAt: 100_000,
      updatedAt: 100_000,
    },
  ]);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "private-input-hash",
    "private-history-id",
    "private title",
    "private\\chrome.exe",
    "embedding",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.throws(() => handlers.get(CHANNELS.listActivityClassifications)(null, "../escape"));
  assert.throws(() =>
    handlers.get(CHANNELS.listActivityClassifications)(null, "session-1", "extra")
  );
});

test("v2 knowledge IPC projects bounded safe fields and keeps action ownership in main", async () => {
  const calls = [];
  const handlers = new Map();
  const repository = createRepository({
    memoryRepository: {
      readPublicSnapshot: () => ({
        memories: [
          {
            id: "memory_1",
            kind: "decision",
            title: "Choose local storage",
            body: "Keep private data local.",
            confidence: 0.9,
            lifecycle: "active",
            provenance: "private-provenance",
            createdAt: 1,
            updatedAt: 2,
            occurrences: [
              {
                id: "occurrence_1",
                sessionId: "session_1",
                startedAt: 10,
                endedAt: 20,
                confidence: 0.9,
                createdAt: 21,
                inputHash: "private-hash",
                evidence: [
                  {
                    sessionId: "session_1",
                    segmentId: "segment_1",
                    startedAt: 10,
                    endedAt: 20,
                    quote: "Keep private data local.",
                    audioState: "available",
                    handle: {
                      ownerType: "memory_value",
                      ownerId: "memory_1",
                      evidenceId: "evidence_1",
                    },
                    path: "C:\\private.wav",
                  },
                ],
              },
            ],
          },
        ],
        topics: [],
        todos: [],
        suggestions: [],
        memoryConflicts: [],
        dailyDigests: [{ sourceHash: "private-source" }],
        sessionSummaries: [{ content: { prompt: "private-prompt" } }],
      }),
      acceptSuggestion: (input) => (calls.push(["accept", input]), { status: "accepted" }),
      dismissSuggestion: (input) => (calls.push(["dismiss", input]), { status: "dismissed" }),
      resolveMemoryConflict: (input) => (calls.push(["resolve", input]), { status: "resolved" }),
      completeTodo: (input) => (calls.push(["complete", input]), { status: "completed" }),
      getEvidenceContext: () => null,
    },
  });
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository,
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    now: () => 7_000,
  });

  const overview = await handlers.get(CHANNELS.getKnowledgeOverview)(null);
  assert.deepEqual(Object.keys(overview).sort(), [
    "conflicts",
    "memories",
    "suggestions",
    "todos",
    "topics",
    "truncated",
  ]);
  assert.equal(overview.memories[0].occurrences[0].evidence[0].quote, "Keep private data local.");
  assert.deepEqual(overview.memories[0].occurrences[0].evidence[0].handle, {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  });
  const serialized = JSON.stringify(overview);
  for (const secret of [
    "private-provenance",
    "private-hash",
    "C:\\private.wav",
    "private-source",
    "private-prompt",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  await handlers.get(CHANNELS.decideKnowledgeSuggestion)(null, {
    suggestionId: "suggestion_1",
    action: "accept",
  });
  await handlers.get(CHANNELS.resolveKnowledgeConflict)(null, {
    conflictGroupId: "conflict_1",
    selectedMemoryItemId: "memory_1",
  });
  await handlers.get(CHANNELS.completeKnowledgeTodo)(null, { todoId: "todo_1" });
  assert.deepEqual(calls, [
    ["accept", { suggestionId: "suggestion_1", at: 7_000 }],
    ["resolve", { conflictGroupId: "conflict_1", selectedMemoryItemId: "memory_1" }],
    ["complete", { todoId: "todo_1" }],
  ]);
  assert.throws(() =>
    handlers.get(CHANNELS.completeKnowledgeTodo)(null, { todoId: "todo_1", status: "open" })
  );
});

test("evidence context IPC validates ownership and returns only the safe context allowlist", async () => {
  const calls = [];
  const repository = createRepository();
  repository.memoryRepository.getEvidenceContext = (input) => {
    calls.push(input);
    return {
      ...input,
      sessionId: "session_1",
      sessionStartedAt: 1_000,
      sessionEndedAt: 5_000,
      transcriptSegmentId: "segment_1",
      transcriptState: "available",
      trackId: "track_1",
      sourceType: "mic",
      startedAt: 1_500,
      endedAt: 2_500,
      quoteText: "Stored quote",
      audioState: "available",
      path: "C:\\private\\capture.flac",
      sha256: "a".repeat(64),
      device_id: "private-device",
      rawError: "private stack",
    };
  };
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository,
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });
  const request = {
    ownerType: "memory_value",
    ownerId: "memory_1",
    evidenceId: "evidence_1",
  };

  const result = await handlers.get(CHANNELS.getEvidenceContext)(null, request);
  assert.deepEqual(calls, [request]);
  assert.deepEqual(Object.keys(result), [
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
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.throws(() =>
    handlers.get(CHANNELS.getEvidenceContext)(null, { ...request, sessionId: "forged" })
  );
  assert.throws(() => handlers.get(CHANNELS.getEvidenceContext)(null, request, request));
  assert.equal(calls.length, 1);

  repository.memoryRepository.getEvidenceContext = () => {
    throw new Error("C:\\private\\jarvis.db SQL failed");
  };
  await assert.rejects(
    Promise.resolve().then(() => handlers.get(CHANNELS.getEvidenceContext)(null, request)),
    (error) => {
      assert.equal(error.code, "EVIDENCE_CONTEXT_UNAVAILABLE");
      assert.equal(error.message, "Evidence context is unavailable");
      return true;
    }
  );
});

function createService(overrides = {}) {
  return {
    startCapture: () => "capture-started",
    setRetentionMode: () => "retention-mode-set",
    sourceInterrupted: () => "source-interrupted",
    sourceRestored: () => "source-restored",
    pauseCapture: () => "capture-paused",
    resumeCapture: () => "capture-resumed",
    finishCapture: () => "capture-finished",
    failCapture: () => "capture-failed",
    ...overrides,
  };
}

function createVoiceEnrollmentService(overrides = {}) {
  return {
    getStatus: () => "voice-status",
    begin: () => "voice-begun",
    complete: () => "voice-enrolled",
    cancel: () => "voice-cancelled",
    cancelOwner: () => 0,
    ...overrides,
  };
}

function createIpcHarness(overrides = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const repository = createRepository(overrides);
  const service = createService();
  const voiceEnrollmentService = createVoiceEnrollmentService();
  const environmentManager = {
    getOpenAIKey: () => "sk-project-test",
    getMiniMaxKey: () => "sk-cp-test",
    saveMiniMaxKey: () => ({ success: true }),
    clearMiniMaxKey: () => ({ success: true }),
  };
  const analysisScheduler = {
    analyzeSession: () => Promise.resolve({ state: "ready" }),
    getStatus: () => ({ state: "waiting" }),
  };
  const analysisBudgetGuard = {
    getStatus: () => ({
      monthKey: "2026-07",
      timezone: "Asia/Shanghai",
      currency: "USD",
      monthlyLimitMicrousd: 5_000_000,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      remainingMicrousd: 5_000_000,
      blockedReason: null,
    }),
    setPolicy(input) {
      return { ...this.getStatus(), ...input };
    },
  };
  const resourceSettings = {
    getStatus: () => ({
      profile: "balanced",
      externalGpuThresholdPct: 45,
      recoveryWaitMs: 60_000,
    }),
    setPolicy(input) {
      return input;
    },
  };
  registerJarvisIpc({
    ipcMain,
    repository,
    service,
    voiceEnrollmentService,
    environmentManager,
    analysisScheduler,
    analysisBudgetGuard,
    resourceSettings,
  });
  return {
    handlers,
    repository,
    service,
    voiceEnrollmentService,
    environmentManager,
    analysisScheduler,
    analysisBudgetGuard,
    resourceSettings,
  };
}

test("contract rejects path traversal and unknown states", () => {
  assert.throws(() => assertId("../secret", "sessionId"), /safe identifier/);
  assert.throws(() => assertSessionStatus("hidden-recording"), /invalid session status/);
  assert.equal(assertSessionStatus("recording"), "recording");
  assert.throws(() => assertSessionStatus("degraded"), /invalid session status/);
  assert.equal(assertCaptureMode("dual"), "dual");
  assert.equal(assertSourceType("system"), "system");
  assert.equal(assertRetentionMode("speech_triggered"), "speech_triggered");
  assert.throws(() => assertCaptureMode("auto"), /invalid capture mode/);
  assert.throws(() => assertSourceType("mixed"), /invalid source type/);
  assert.throws(() => assertRetentionMode("adaptive"), /invalid retention mode/);
});

test("retention mode IPC validates mode and forwards a sanitized session id", () => {
  const calls = [];
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({ setRetentionMode: (...args) => calls.push(args) }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  handlers.get(CHANNELS.setRetentionMode)(null, "session-1", "continuous", 1_100);
  assert.deepEqual(calls, [["session-1", "continuous", 1_100]]);
  assert.throws(
    () => handlers.get(CHANNELS.setRetentionMode)(null, "session-1", "adaptive", 1_200),
    /invalid retention mode/
  );
  assert.throws(
    () => handlers.get(CHANNELS.setRetentionMode)(null, "../escape", "continuous", 1_200),
    /safe identifier/
  );
  assert.equal(calls.length, 1);
});

test("audio read IPC returns a verified playable WAV for authoritative FLAC", async () => {
  const handlers = new Map();
  const chunk = { id: "c1", format: "flac", path: "opaque.flac", pcm_sha256: "hash" };
  const playable = Buffer.from("verified-wav");
  const calls = [];
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({ getAudioChunk: () => chunk }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    audioEvidenceReader: {
      async readPlayableWav(input) {
        calls.push(input);
        return playable;
      },
    },
  });

  const result = await handlers.get(CHANNELS.readAudioChunk)(null, "c1");

  assert.equal(result, playable);
  assert.deepEqual(calls, [chunk]);
});

test("audio read IPC returns null for missing evidence and never returns unverified raw bytes", async () => {
  const missingHandlers = new Map();
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => missingHandlers.set(channel, handler) },
    repository: createRepository({
      getAudioChunk: () => ({ id: "c1", path: __filename, format: "wav" }),
    }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    audioEvidenceReader: { readPlayableWav: async () => Promise.reject(missing) },
  });

  assert.equal(await missingHandlers.get(CHANNELS.readAudioChunk)(null, "c1"), null);

  const unsafeHandlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => unsafeHandlers.set(channel, handler) },
    repository: createRepository({
      getAudioChunk: () => ({ id: "c1", path: __filename, format: "wav" }),
    }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  await assert.rejects(
    unsafeHandlers.get(CHANNELS.readAudioChunk)(null, "c1"),
    /verified audio reader is unavailable/
  );
});

test("session timeline IPC is reachable and keeps retired provenance private", () => {
  const handlers = new Map();
  const timeline = {
    session_id: "s1",
    status: "recording",
    tracks: [],
    gaps: [],
    chunks: [
      {
        id: "c1",
        session_id: "s1",
        path: "speech.flac",
        format: "flac",
        retired_path: "private.wav",
        retired_format: "wav",
        retired_file_sha256: "f".repeat(64),
      },
    ],
    segments: [],
    processing_counts: { pending: 0, leased: 0, retry: 0, blocked: 0, completed: 1, total: 1 },
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({ getSessionTimeline: () => timeline }),
    service: createService({ getState: () => ({ sessionId: "s1", status: "recording" }) }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    processingLifecycle: {
      runtime: {
        previewStatus: () => ({
          mode: "degraded",
          cadenceMs: 60_000,
          pending: 1,
          running: 0,
          pausedReason: null,
          executionDevice: "cuda",
          lastError: null,
          recordingContinues: true,
        }),
      },
    },
  });

  const result = handlers.get(CHANNELS.getSessionTimeline)(null, "s1");
  assert.equal(result.session_id, "s1");
  assert.equal(result.chunks[0].format, "flac");
  assert.equal(Object.hasOwn(result.chunks[0], "retired_path"), false);
  assert.equal(Object.hasOwn(result.chunks[0], "retired_format"), false);
  assert.equal(Object.hasOwn(result.chunks[0], "retired_file_sha256"), false);
  assert.equal(result.preview_status.mode, "degraded");
  assert.equal(result.preview_status.cadenceMs, 60_000);
});

test("session timeline IPC scopes live preview to the authoritative active capture session", () => {
  const handlers = new Map();
  const timeline = (sessionId, status, processingState = "processing") => ({
    session_id: sessionId,
    status,
    processing_state: processingState,
    tracks: [],
    gaps: [],
    chunks: [],
    segments: [],
    processing_counts: {
      pending: 0,
      leased: 0,
      retry: 0,
      blocked: 0,
      completed: 1,
      total: 1,
    },
  });
  const timelines = new Map([
    ["s1", timeline("s1", "recording")],
    ["s2", timeline("s2", "recording")],
    ["s3", timeline("s3", "completed", "ready")],
  ]);

  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({ getSessionTimeline: (sessionId) => timelines.get(sessionId) }),
    service: createService({ getState: () => ({ sessionId: "s1", status: "recording" }) }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    processingLifecycle: {
      runtime: {
        previewStatus: () => ({
          mode: "normal",
          cadenceMs: 30_000,
          pending: 1,
          running: 0,
          pausedReason: null,
          executionDevice: "cuda",
          lastError: null,
          recordingContinues: true,
        }),
      },
    },
  });

  const getTimeline = handlers.get(CHANNELS.getSessionTimeline);
  assert.equal(getTimeline(null, "s1").preview_status.mode, "normal");
  assert.equal(getTimeline(null, "s2").preview_status, null);
  assert.equal(getTimeline(null, "s3").preview_status, null);
});

test("retired provenance is private at audio IPC boundaries", () => {
  const handlers = new Map();
  const privateChunk = {
    id: "c1",
    session_id: "s1",
    path: "speech.wav",
    sha256: "a".repeat(64),
    pcm_sha256: "b".repeat(64),
    file_sha256: "c".repeat(64),
    format: "wav",
    retired_path: "private.flac",
    retired_format: "flac",
    retired_file_sha256: "b".repeat(64),
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({
      listAudioChunks: () => [privateChunk],
      getSessionDetail: () => ({
        session: {
          id: "s1",
          mic_device_id: "private-device-id",
          capture_policy_json: '{"strategy":"private"}',
        },
        audioChunks: [privateChunk],
      }),
    }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  const list = handlers.get(CHANNELS.listAudioChunks)(null, "s1");
  const detail = handlers.get(CHANNELS.getSessionDetail)(null, "s1");
  assert.equal(Object.hasOwn(detail.session, "mic_device_id"), false);
  assert.equal(Object.hasOwn(detail.session, "capture_policy_json"), false);
  for (const chunk of [list[0], detail.audioChunks[0]]) {
    assert.deepEqual(
      Object.keys(chunk),
      [
        "id",
        "session_id",
        "started_at",
        "ended_at",
        "duration_ms",
        "track_id",
        "source_type",
        "sequence_number",
        "write_state",
        "deleted_at",
        "format",
      ].filter((key) => Object.hasOwn(privateChunk, key))
    );
    assert.equal(Object.hasOwn(chunk, "path"), false);
    assert.equal(Object.hasOwn(chunk, "sha256"), false);
    assert.equal(Object.hasOwn(chunk, "pcm_sha256"), false);
    assert.equal(Object.hasOwn(chunk, "file_sha256"), false);
    assert.equal(Object.hasOwn(chunk, "retired_path"), false);
    assert.equal(Object.hasOwn(chunk, "retired_format"), false);
    assert.equal(Object.hasOwn(chunk, "retired_file_sha256"), false);
  }
});

test("audio timeline IPC projects strict chunk track and gap allowlists", () => {
  const handlers = new Map();
  const privateGap = {
    id: "gap_1",
    track_id: "track_1",
    started_at: 1_500,
    ended_at: 1_700,
    reason: "device_lost",
    recovery_attempts: 2,
    average_level: 0.2,
    peak_level: 0.8,
    restored_device_id: "private-restored-id",
    restored_device_label: "Private restored microphone",
    restored_strategy: "private-strategy",
  };
  const privateTrack = {
    id: "track_1",
    session_id: "s1",
    source_type: "mic",
    track_kind: "mic",
    application_key: null,
    application_display_name: null,
    attribution_state: "exact",
    capture_generation: 0,
    device_id: "private-device-id",
    device_label: "Private microphone",
    strategy: "private-capture-strategy",
    sample_rate: 24_000,
    channels: 1,
    started_at: 1_000,
    ended_at: 5_000,
    state: "ended",
    gaps: [privateGap],
  };
  const privateApplicationInterval = {
    id: "interval_1",
    session_id: "s1",
    track_id: "track_1",
    interval_kind: "mixed_fallback",
    application_key: null,
    attribution_state: "mixed_unknown",
    capture_generation: 1,
    started_at: 2_000,
    ended_at: 2_500,
    reason: "application_capture_failed",
    raw_process_path: "C:\\private\\chrome.exe",
    raw_window_title: "Private meeting title",
    created_at: 2_000,
  };
  const privateChunk = {
    id: "chunk_1",
    session_id: "s1",
    track_id: "track_1",
    source_type: "mic",
    started_at: 1_000,
    ended_at: 5_000,
    duration_ms: 4_000,
    sequence_number: 0,
    write_state: "committed",
    deleted_at: null,
    format: "flac",
    path: "C:\\private\\capture.flac",
    sha256: "a".repeat(64),
    pcm_sha256: "b".repeat(64),
    file_sha256: "c".repeat(64),
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository({
      getSessionTimeline: () => ({
        session_id: "s1",
        started_at: 1_000,
        ended_at: 5_000,
        status: "completed",
        processing_state: "ready",
        timeline_version: 1,
        finalized_at: 5_100,
        ready_at: 5_200,
        tracks: [privateTrack],
        application_audio_intervals: [privateApplicationInterval],
        gaps: [privateGap],
        chunks: [privateChunk],
        segments: [],
        processing_counts: { pending: 0, leased: 0, retry: 0, blocked: 0, completed: 1, total: 1 },
        rawError: "private timeline stack",
      }),
    }),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  const result = handlers.get(CHANNELS.getSessionTimeline)(null, "s1");
  assert.deepEqual(Object.keys(result.tracks[0]), [
    "id",
    "session_id",
    "source_type",
    "track_kind",
    "application_key",
    "application_display_name",
    "attribution_state",
    "capture_generation",
    "sample_rate",
    "channels",
    "started_at",
    "ended_at",
    "state",
    "gaps",
  ]);
  assert.deepEqual(Object.keys(result.application_audio_intervals[0]), [
    "id",
    "session_id",
    "track_id",
    "interval_kind",
    "application_key",
    "attribution_state",
    "capture_generation",
    "started_at",
    "ended_at",
    "reason",
  ]);
  assert.deepEqual(result.application_capture, {
    exact_duration_ms: 0,
    fallback_duration_ms: 500,
    exact_coverage_pct: 0,
    degraded_intervals: [
      {
        id: "interval_1",
        session_id: "s1",
        track_id: "track_1",
        interval_kind: "mixed_fallback",
        application_key: null,
        attribution_state: "mixed_unknown",
        capture_generation: 1,
        started_at: 2_000,
        ended_at: 2_500,
        reason: "application_capture_failed",
      },
    ],
    recovery_points: [],
  });
  assert.deepEqual(Object.keys(result.gaps[0]), [
    "id",
    "track_id",
    "started_at",
    "ended_at",
    "reason",
    "recovery_attempts",
    "average_level",
    "peak_level",
  ]);
  assert.deepEqual(Object.keys(result.chunks[0]), [
    "id",
    "session_id",
    "started_at",
    "ended_at",
    "duration_ms",
    "track_id",
    "source_type",
    "sequence_number",
    "write_state",
    "deleted_at",
    "format",
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of [
    "private-device-id",
    "Private microphone",
    "private-capture-strategy",
    "private-restored-id",
    "Private restored microphone",
    "private-strategy",
    "C:\\private\\capture.flac",
    "private timeline stack",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("start capture IPC rejects invalid source selections before calling the service", () => {
  let calls = 0;
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({
      startCapture() {
        calls += 1;
      },
    }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        captureMode: "dual",
        sources: [{ sourceType: "mic" }],
      }),
    /sources must exactly match capture mode dual/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        captureMode: "auto",
        sources: [],
      }),
    /invalid capture mode/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        micDeviceId: "contradictory-mic",
        captureMode: "system",
        sources: [
          {
            sourceType: "system",
            deviceId: null,
            deviceLabel: null,
            strategy: "wasapi-loopback",
          },
        ],
      }),
    /micDeviceId must match the selected capture sources/
  );
  assert.throws(
    () =>
      handlers.get(CHANNELS.startCapture)(null, {
        sessionId: "s1",
        startedAt: 10,
        micDeviceId: "mic-a",
        captureMode: "dual",
        sources: [
          { sourceType: "mic", deviceId: "mic-b" },
          { sourceType: "system", deviceId: null },
        ],
      }),
    /micDeviceId must match the selected capture sources/
  );
  assert.equal(calls, 0);
});

test("capture modes require their exact unique source set", () => {
  const { normalizeCaptureSources } = require("../../src/jarvis/shared/captureModes");
  const mic = { sourceType: "mic" };
  const system = { sourceType: "system" };

  assert.throws(() => normalizeCaptureSources("dual", [mic, mic]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("mic", [mic, system]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("system", [mic]), /exactly match/);
  assert.throws(() => normalizeCaptureSources("mic", [system]), /exactly match/);
  assert.deepEqual(
    normalizeCaptureSources("dual", [system, mic]).map((source) => source.sourceType),
    ["mic", "system"]
  );
});

test("source lifecycle IPC validates metadata and forwards only sanitized inputs", () => {
  const interrupted = [];
  const restored = [];
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService({
      sourceInterrupted: (...args) => interrupted.push(args),
      sourceRestored: (...args) => restored.push(args),
    }),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  handlers.get(CHANNELS.sourceInterrupted)(null, "session-1", "mic", {
    at: 1_100,
    reason: "mic-track-ended",
  });
  handlers.get(CHANNELS.sourceRestored)(null, "session-1", "mic", {
    at: 1_200,
    deviceId: "physical-mic",
    deviceLabel: "Physical microphone",
    strategy: "web-audio",
  });

  assert.deepEqual(interrupted, [["session-1", "mic", { at: 1_100, reason: "mic-track-ended" }]]);
  assert.deepEqual(restored, [
    [
      "session-1",
      "mic",
      {
        at: 1_200,
        deviceId: "physical-mic",
        deviceLabel: "Physical microphone",
        strategy: "web-audio",
      },
    ],
  ]);

  for (const [channel, args] of [
    [CHANNELS.sourceInterrupted, ["../escape", "mic", { at: 1, reason: "ended" }]],
    [CHANNELS.sourceInterrupted, ["session-1", "mixed", { at: 1, reason: "ended" }]],
    [CHANNELS.sourceInterrupted, ["session-1", "mic", { at: 1, reason: "" }]],
    [
      CHANNELS.sourceRestored,
      ["session-1", "mic", { at: 2, deviceId: 7, deviceLabel: null, strategy: null }],
    ],
  ]) {
    assert.throws(() => handlers.get(channel)(null, ...args));
  }
  assert.equal(interrupted.length, 1);
  assert.equal(restored.length, 1);
});

test("contract exposes only the named Jarvis channels", () => {
  assert.deepEqual(
    Object.keys(CHANNELS).sort(),
    [
      "beginVoiceEnrollment",
      "cancelVoiceEnrollment",
      "completeVoiceEnrollment",
      "completeKnowledgeTodo",
      "control",
      "createSession",
      "failCapture",
      "finishCapture",
      "getAnalysisBudget",
      "getAnalysisStatus",
      "getApplicationAudioSettings",
      "getCloudBudget",
      "getDailyDigest",
      "getEvidenceContext",
      "getKnowledgeOverview",
      "getMiniMaxConfig",
      "getResourceGovernance",
      "getPersonDetail",
      "getRuntimeStatus",
      "getSession",
      "getSessionDetail",
      "getSessionTimeline",
      "getStorageStatus",
      "getTodayInsights",
      "getTopicDetail",
      "getVoiceEnrollmentStatus",
      "analyzeSession",
      "listAudioChunks",
      "listActivityClassifications",
      "readAudioChunk",
      "listMemories",
      "listPeople",
      "listPeopleOverview",
      "listSegments",
      "listSessions",
      "listTodos",
      "listTopics",
      "migrateStorage",
      "pauseCapture",
      "pickStorageDirectory",
      "renamePerson",
      "regenerateDailyDigest",
      "confirmSpeaker",
      "listSessionSpeakerClusters",
      "listSpeakerCorrections",
      "mergePeople",
      "rejectSpeaker",
      "undoSpeakerCorrection",
      "resumeCapture",
      "clearMiniMaxKey",
      "setAnalysisBudget",
      "setApplicationAudioSettings",
      "setCloudBudget",
      "setMiniMaxKey",
      "setResourceGovernance",
      "setSessionStatus",
      "setRetentionMode",
      "setTodoStatus",
      "sourceInterrupted",
      "sourceRestored",
      "startCapture",
      "stateChanged",
      "syncSegments",
      "searchMemory",
      "renameTopic",
      "decideKnowledgeSuggestion",
      "resolveKnowledgeConflict",
      "upsertSegments",
    ].sort()
  );
  assert.equal(Object.isFrozen(CHANNELS), true);
});

test("IPC registers only request-response repository channels", () => {
  const { handlers } = createIpcHarness();

  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      CHANNELS.createSession,
      CHANNELS.getSession,
      CHANNELS.listAudioChunks,
      CHANNELS.listActivityClassifications,
      CHANNELS.readAudioChunk,
      CHANNELS.listPeople,
      CHANNELS.listSegments,
      CHANNELS.listSessions,
      CHANNELS.renamePerson,
      CHANNELS.listSessionSpeakerClusters,
      CHANNELS.confirmSpeaker,
      CHANNELS.rejectSpeaker,
      CHANNELS.undoSpeakerCorrection,
      CHANNELS.listSpeakerCorrections,
      CHANNELS.mergePeople,
      CHANNELS.setSessionStatus,
      CHANNELS.setRetentionMode,
      CHANNELS.syncSegments,
      CHANNELS.upsertSegments,
      CHANNELS.startCapture,
      CHANNELS.sourceInterrupted,
      CHANNELS.sourceRestored,
      CHANNELS.pauseCapture,
      CHANNELS.resumeCapture,
      CHANNELS.finishCapture,
      CHANNELS.failCapture,
      CHANNELS.beginVoiceEnrollment,
      CHANNELS.getVoiceEnrollmentStatus,
      CHANNELS.completeVoiceEnrollment,
      CHANNELS.completeKnowledgeTodo,
      CHANNELS.cancelVoiceEnrollment,
      CHANNELS.getCloudBudget,
      CHANNELS.setCloudBudget,
      CHANNELS.getSessionDetail,
      CHANNELS.getSessionTimeline,
      CHANNELS.getEvidenceContext,
      CHANNELS.getKnowledgeOverview,
      CHANNELS.getRuntimeStatus,
      CHANNELS.searchMemory,
      CHANNELS.listPeopleOverview,
      CHANNELS.getPersonDetail,
      CHANNELS.listTopics,
      CHANNELS.getTopicDetail,
      CHANNELS.renameTopic,
      CHANNELS.listTodos,
      CHANNELS.setTodoStatus,
      CHANNELS.listMemories,
      CHANNELS.getTodayInsights,
      CHANNELS.analyzeSession,
      CHANNELS.getAnalysisStatus,
      CHANNELS.getAnalysisBudget,
      CHANNELS.getResourceGovernance,
      CHANNELS.getMiniMaxConfig,
      CHANNELS.clearMiniMaxKey,
      CHANNELS.setMiniMaxKey,
      CHANNELS.setAnalysisBudget,
      CHANNELS.setResourceGovernance,
      CHANNELS.decideKnowledgeSuggestion,
      CHANNELS.resolveKnowledgeConflict,
    ].sort()
  );
  assert.equal(handlers.has(CHANNELS.control), false);
  assert.equal(handlers.has(CHANNELS.stateChanged), false);
});

test("daily digest IPC accepts only localDate and rebuilds a private-safe public view", async () => {
  const handlers = new Map();
  const calls = [];
  const content = {
    schemaVersion: "jarvis-daily-digest-v1",
    sections: {
      today: [{ text: "Did the work", evidenceSegmentIds: ["segment-1"], secret: "drop" }],
      interactions: [],
      topicsAndDecisions: [],
      commitmentsAndTodos: [],
      worthRemembering: [],
      tomorrowSuggestions: [],
    },
    processing: {
      completeness: "final",
      missingStages: [],
      transcriptCoverage: {
        selectedSegmentCount: 1,
        incompleteSegmentCount: 0,
        sessionCount: 1,
        startsAt: 1,
        endsAt: 2,
        privateHash: "drop",
      },
    },
    providerResponse: "drop",
  };
  const dailyDigestScheduler = {
    getLatest(input) {
      calls.push(["get", input]);
      return {
        id: "digest-1",
        timezone: "Asia/Shanghai",
        lifecycle: "active",
        sourceHash: "private-source-hash",
        localDate: input.localDate,
        revision: 2,
        completeness: "final",
        content,
        evidence: [
          {
            sessionId: "session-1",
            segmentId: "segment-1",
            startedAt: 1,
            endedAt: 2,
            quote: "Did the work",
            audioState: "available",
            handle: {
              ownerType: "daily_digest_item",
              ownerId: "digest-1",
              evidenceId: "evidence-1",
            },
            path: "G:\\private.wav",
          },
        ],
        createdAt: 3,
        updatedAt: 4,
      };
    },
    getPublicStatus(input) {
      calls.push(["status", input]);
      return {
        state: "ready",
        retryable: false,
        errorCode: null,
        nextRetryAt: null,
        attemptCount: 1,
        jobId: "private-job-id",
      };
    },
    regenerate(input) {
      calls.push(["regenerate", input]);
    },
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    dailyDigestScheduler,
  });

  const result = await handlers.get(CHANNELS.getDailyDigest)(null, {
    localDate: "2026-07-17",
  });
  assert.deepEqual(Object.keys(result), ["digest", "status"]);
  assert.deepEqual(Object.keys(result.digest), [
    "localDate",
    "revision",
    "completeness",
    "content",
    "evidence",
    "createdAt",
    "updatedAt",
  ]);
  assert.deepEqual(result.digest.evidence[0].handle, {
    ownerType: "daily_digest_item",
    ownerId: "digest-1",
    evidenceId: "evidence-1",
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "private-source-hash",
    "private-job-id",
    "G:\\private.wav",
    "providerResponse",
    "privateHash",
    "secret",
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.deepEqual(
    await handlers.get(CHANNELS.regenerateDailyDigest)(null, {
      localDate: "2026-07-17",
      allowUsageUnknown: true,
    }),
    result.status
  );
  assert.deepEqual(calls[2], ["regenerate", { localDate: "2026-07-17", allowUsageUnknown: true }]);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["get", "status", "regenerate", "status"]
  );
  await assert.rejects(
    async () =>
      handlers.get(CHANNELS.getDailyDigest)(null, {
        localDate: "2026-07-17",
        timezone: "UTC",
      }),
    /only localDate|invalid structure/i
  );
  await assert.rejects(
    async () =>
      handlers.get(CHANNELS.regenerateDailyDigest)(null, {
        localDate: "2026-07-17",
      }),
    /allowUsageUnknown|invalid structure|exact keys/i
  );
  await assert.rejects(
    async () =>
      handlers.get(CHANNELS.regenerateDailyDigest)(null, {
        localDate: "2026-07-17",
        allowUsageUnknown: "yes",
      }),
    /allowUsageUnknown.*boolean/i
  );
  await assert.rejects(
    async () => handlers.get(CHANNELS.getDailyDigest)(null, { localDate: "2026-02-29" }),
    /valid calendar date/i
  );
  await assert.rejects(
    async () => handlers.get(CHANNELS.getDailyDigest)(null, { localDate: "2026-07-17" }, {}),
    /one argument/i
  );
});

test("speaker correction IPC validates renderer input and routes only to the correction service", () => {
  const calls = [];
  const speakerCorrectionService = createSpeakerCorrectionService({
    listSessionClusters: (...args) => calls.push(["list", ...args]),
    confirm: (...args) => calls.push(["confirm", ...args]),
    reject: (...args) => calls.push(["reject", ...args]),
    undo: (...args) => calls.push(["undo", ...args]),
    listCorrections: (...args) => calls.push(["corrections", ...args]),
    mergePeople: (...args) => calls.push(["merge", ...args]),
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    speakerCorrectionService,
    environmentManager: { getOpenAIKey: () => null },
  });

  handlers.get(CHANNELS.listSessionSpeakerClusters)(null, "s1");
  handlers.get(CHANNELS.confirmSpeaker)(null, {
    clusterId: "c1",
    personId: "p1",
    scope: "session",
  });
  handlers.get(CHANNELS.rejectSpeaker)(null, "c1", "p1");
  handlers.get(CHANNELS.undoSpeakerCorrection)(null, "c1");
  handlers.get(CHANNELS.listSpeakerCorrections)(null, "c1");
  handlers.get(CHANNELS.mergePeople)(null, "p-source", "p-target");
  assert.deepEqual(calls, [
    ["list", "s1"],
    ["confirm", { clusterId: "c1", personId: "p1", scope: "session" }],
    ["reject", "c1", "p1"],
    ["undo", "c1"],
    ["corrections", "c1"],
    ["merge", "p-source", "p-target"],
  ]);

  for (const invoke of [
    () => handlers.get(CHANNELS.listSessionSpeakerClusters)(null, "../s1"),
    () =>
      handlers.get(CHANNELS.confirmSpeaker)(null, {
        clusterId: "c1",
        personId: "p1",
        scope: "session",
        actor: "system",
      }),
    () =>
      handlers.get(CHANNELS.confirmSpeaker)(null, {
        clusterId: "c1",
        personId: "p1",
        newPersonName: "P1",
        scope: "session",
      }),
    () =>
      handlers.get(CHANNELS.confirmSpeaker)(null, {
        clusterId: "c1",
        newPersonName: "P1",
        scope: "persistent-ish",
      }),
    () => handlers.get(CHANNELS.rejectSpeaker)(null, "../c1", "p1"),
    () => handlers.get(CHANNELS.mergePeople)(null, "same", "same"),
  ]) {
    assert.throws(invoke);
  }
  assert.equal(calls.length, 6);
});

test("speaker confirmation serializes only public ambiguous duplicate candidates", async () => {
  const error = new Error("database duplicate details");
  error.code = "ambiguous_duplicate_name";
  error.candidates = [
    {
      id: "p1",
      displayName: "Alice",
      isSelf: false,
      embedding: new Float32Array([0.5]),
      path: "private.wav",
    },
  ];
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    speakerCorrectionService: createSpeakerCorrectionService({
      confirm: async () => {
        throw error;
      },
    }),
    environmentManager: { getOpenAIKey: () => null },
  });

  assert.deepEqual(
    await handlers.get(CHANNELS.confirmSpeaker)(null, {
      clusterId: "c1",
      newPersonName: "Alice",
      scope: "session",
    }),
    {
      speakerCorrectionError: {
        code: "ambiguous_duplicate_name",
        candidates: [{ id: "p1", displayName: "Alice", isSelf: false }],
      },
    }
  );
});

test("IPC registration requires every speaker correction service capability", () => {
  for (const method of [
    "listSessionClusters",
    "confirm",
    "reject",
    "undo",
    "listCorrections",
    "mergePeople",
  ]) {
    const speakerCorrectionService = createSpeakerCorrectionService();
    delete speakerCorrectionService[method];
    const registered = [];
    assert.throws(
      () =>
        registerJarvisIpcImpl({
          ipcMain: { handle: (channel) => registered.push(channel) },
          repository: createRepository(),
          service: createService(),
          voiceEnrollmentService: createVoiceEnrollmentService(),
          speakerCorrectionService,
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`speakerCorrectionService\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }
});

test("IPC exposes MiniMax configured state without returning the secret", async () => {
  const calls = [];
  const { handlers, environmentManager } = createIpcHarness();
  environmentManager.saveMiniMaxKey = async (key) => {
    calls.push(["save", key]);
  };
  environmentManager.clearMiniMaxKey = async () => {
    calls.push(["clear"]);
  };
  const config = await handlers.get(CHANNELS.getMiniMaxConfig)();
  const expectedModel = "MiniMax-M2.7";
  assert.deepEqual(config, { keyConfigured: true, model: expectedModel });
  assert.doesNotMatch(JSON.stringify(config), /sk-cp/);
  const saved = await handlers.get(CHANNELS.setMiniMaxKey)(null, { key: "new-token-plan-key" });
  assert.deepEqual(saved, { keyConfigured: true, model: expectedModel });
  const cleared = await handlers.get(CHANNELS.clearMiniMaxKey)(null);
  assert.deepEqual(cleared, { keyConfigured: true, model: expectedModel });
  assert.deepEqual(calls, [["save", "new-token-plan-key"], ["clear"]]);
  await assert.rejects(
    handlers.get(CHANNELS.setMiniMaxKey)(null, {
      key: "new-token-plan-key",
      extra: "forbidden",
    })
  );
});

test("analysis IPC projects a strict safe status and masks scheduler failures", async () => {
  const { handlers, analysisScheduler } = createIpcHarness();
  analysisScheduler.analyzeSession = async (sessionId, kind) => ({
    sessionId,
    state: kind === "final" ? "queued" : "preparing",
    errorCode: null,
    updatedAt: 7_000,
    jobId: "private-job",
    desiredVectorHash: "private-hash",
    reused: true,
    rawError: "C:\\private\\provider.log",
  });
  analysisScheduler.getStatus = (sessionId) => ({
    sessionId,
    state: "retry_needed",
    errorCode: "rate_limit",
    updatedAt: 8_000,
    jobId: "private-job",
    rawError: "provider body",
  });

  assert.deepEqual(await handlers.get(CHANNELS.analyzeSession)(null, "session-1", "final"), {
    sessionId: "session-1",
    state: "queued",
    errorCode: null,
    updatedAt: 7_000,
  });
  assert.deepEqual(handlers.get(CHANNELS.getAnalysisStatus)(null, "session-1"), {
    sessionId: "session-1",
    state: "retry_needed",
    errorCode: "rate_limit",
    updatedAt: 8_000,
  });

  analysisScheduler.getStatus = () => {
    throw new Error("C:\\private\\jarvis.db raw scheduler failure");
  };
  assert.throws(
    () => handlers.get(CHANNELS.getAnalysisStatus)(null, "session-1"),
    (error) => {
      assert.equal(error.code, "ANALYSIS_STATUS_UNAVAILABLE");
      assert.equal(error.message, "Analysis status is unavailable");
      return true;
    }
  );
});

test("analysis budget IPC enforces exact policy input and returns a safe allowlist", async () => {
  const calls = [];
  const { handlers, analysisBudgetGuard } = createIpcHarness();
  analysisBudgetGuard.getStatus = () => ({
    mode: "capped",
    monthKey: "2026-07",
    timezone: "Asia/Shanghai",
    currency: "USD",
    monthlyLimitMicrousd: 5_000_000,
    spentMicrousd: 1_000_000,
    reservedMicrousd: 500_000,
    remainingMicrousd: 3_500_000,
    blockedReason: null,
    requestId: "private-request",
    rawError: "C:\\private\\ledger.db",
  });
  analysisBudgetGuard.setPolicy = (input) => {
    calls.push(input);
    return {
      ...analysisBudgetGuard.getStatus(),
      ...input,
      remainingMicrousd: input.mode === "unlimited" ? null : 3_500_000,
    };
  };

  assert.deepEqual(await handlers.get(CHANNELS.getAnalysisBudget)(null), {
    mode: "capped",
    monthKey: "2026-07",
    timezone: "Asia/Shanghai",
    currency: "USD",
    monthlyLimitMicrousd: 5_000_000,
    spentMicrousd: 1_000_000,
    reservedMicrousd: 500_000,
    remainingMicrousd: 3_500_000,
    blockedReason: null,
  });
  const updated = await handlers.get(CHANNELS.setAnalysisBudget)(null, {
    mode: "unlimited",
    monthlyLimitMicrousd: 200_000_000,
    timezone: "UTC",
  });
  assert.equal(updated.mode, "unlimited");
  assert.equal(updated.monthlyLimitMicrousd, 200_000_000);
  assert.equal(updated.timezone, "UTC");
  assert.deepEqual(calls, [
    { mode: "unlimited", monthlyLimitMicrousd: 200_000_000, timezone: "UTC" },
  ]);
  for (const invalid of [
    { mode: "capped", monthlyLimitMicrousd: -1, timezone: "UTC" },
    { mode: "capped", monthlyLimitMicrousd: 1_000_000_000_001, timezone: "UTC" },
    { mode: "forever", monthlyLimitMicrousd: 5_000_000, timezone: "UTC" },
    { mode: "capped", monthlyLimitMicrousd: 5_000_000, timezone: "UTC", extra: true },
  ]) {
    assert.throws(() => handlers.get(CHANNELS.setAnalysisBudget)(null, invalid));
  }
  assert.equal(calls.length, 1);
});

test("resource governance IPC enforces exact presets and bounded advanced values", async () => {
  const calls = [];
  const { handlers, resourceSettings } = createIpcHarness();
  resourceSettings.getStatus = () => ({
    profile: "balanced",
    externalGpuThresholdPct: 45,
    recoveryWaitMs: 60_000,
    privatePath: "C:\\private\\resource.json",
  });
  resourceSettings.setPolicy = async (input) => {
    calls.push(input);
    return { ...input, privatePath: "C:\\private\\resource.json" };
  };

  assert.deepEqual(await handlers.get(CHANNELS.getResourceGovernance)(null), {
    profile: "balanced",
    externalGpuThresholdPct: 45,
    recoveryWaitMs: 60_000,
  });
  assert.deepEqual(
    await handlers.get(CHANNELS.setResourceGovernance)(null, {
      profile: "processing_priority",
      externalGpuThresholdPct: 80,
      recoveryWaitMs: 30_000,
    }),
    {
      profile: "processing_priority",
      externalGpuThresholdPct: 80,
      recoveryWaitMs: 30_000,
    }
  );
  assert.deepEqual(calls, [
    {
      profile: "processing_priority",
      externalGpuThresholdPct: 80,
      recoveryWaitMs: 30_000,
    },
  ]);
  for (const invalid of [
    { profile: "unknown", externalGpuThresholdPct: 45, recoveryWaitMs: 60_000 },
    { profile: "balanced", externalGpuThresholdPct: 9, recoveryWaitMs: 60_000 },
    { profile: "balanced", externalGpuThresholdPct: 45, recoveryWaitMs: 14_999 },
    {
      profile: "balanced",
      externalGpuThresholdPct: 45,
      recoveryWaitMs: 60_000,
      extra: true,
    },
  ]) {
    assert.throws(() => normalizeResourceGovernanceSettings(invalid));
    assert.throws(() => handlers.get(CHANNELS.setResourceGovernance)(null, invalid));
  }
  assert.equal(calls.length, 1);
});

test("application audio IPC exposes bounded runtime state and exact 1-8 track settings", async () => {
  const handlers = new Map();
  const calls = [];
  const applicationAudioSettings = {
    getStatus: () => ({
      enabled: true,
      trackLimit: 4,
      runtime: {
        running: true,
        configuredLimit: 4,
        effectiveLimit: 2,
        fullscreen: true,
        activeTracks: [
          {
            applicationKey: "chrome",
            applicationDisplayName: "Chrome",
            captureGeneration: 3,
            state: "recording",
            processId: 1234,
          },
        ],
        fallbacks: [
          {
            applicationKey: "kook",
            applicationDisplayName: "KOOK",
            reason: "capture_failed",
            retryAt: 9_000,
            state: "mixed_unknown",
            executablePath: "C:\\private\\kook.exe",
          },
        ],
      },
      privatePath: "C:\\private\\application-audio.json",
    }),
    setPolicy: async (input) => {
      calls.push(input);
      return { ...applicationAudioSettings.getStatus(), ...input };
    },
  };
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    applicationAudioSettings,
  });

  const status = await handlers.get(CHANNELS.getApplicationAudioSettings)(null);
  assert.deepEqual(status, {
    enabled: true,
    trackLimit: 4,
    runtime: {
      running: true,
      configuredLimit: 4,
      effectiveLimit: 2,
      fullscreen: true,
      activeTracks: [
        {
          applicationKey: "chrome",
          applicationDisplayName: "Chrome",
          captureGeneration: 3,
          state: "recording",
        },
      ],
      fallbacks: [
        {
          applicationKey: "kook",
          applicationDisplayName: "KOOK",
          reason: "capture_failed",
          retryAt: 9_000,
          state: "mixed_unknown",
        },
      ],
    },
  });
  assert.deepEqual(
    await handlers.get(CHANNELS.setApplicationAudioSettings)(null, {
      enabled: false,
      trackLimit: 8,
    }),
    { ...status, enabled: false, trackLimit: 8 }
  );
  assert.deepEqual(calls, [{ enabled: false, trackLimit: 8 }]);

  for (const invalid of [
    { enabled: "yes", trackLimit: 4 },
    { enabled: true, trackLimit: 0 },
    { enabled: true, trackLimit: 9 },
    { enabled: true, trackLimit: 4, extra: true },
  ]) {
    assert.throws(() => normalizeApplicationAudioSettings(invalid));
    assert.throws(() => handlers.get(CHANNELS.setApplicationAudioSettings)(null, invalid));
  }
});

test("MiniMax and analysis budget IPC failures expose only fixed safe errors", async () => {
  const { handlers, environmentManager, analysisBudgetGuard } = createIpcHarness();
  environmentManager.saveMiniMaxKey = async () => {
    throw new Error("C:\\private\\secure-store sk-cp-secret");
  };
  environmentManager.clearMiniMaxKey = async () => {
    throw new Error("C:\\private\\secure-store sk-cp-secret");
  };
  analysisBudgetGuard.getStatus = () => {
    throw new Error("C:\\private\\ledger.db SQL failed");
  };

  await assert.rejects(
    handlers.get(CHANNELS.setMiniMaxKey)(null, { key: "sk-cp-secret" }),
    (error) => {
      assert.equal(error.code, "MINIMAX_SETTINGS_UNAVAILABLE");
      assert.equal(error.message, "MiniMax settings are unavailable");
      return true;
    }
  );
  await assert.rejects(handlers.get(CHANNELS.clearMiniMaxKey)(null), (error) => {
    assert.equal(error.code, "MINIMAX_SETTINGS_UNAVAILABLE");
    assert.equal(error.message, "MiniMax settings are unavailable");
    return true;
  });
  assert.throws(
    () => handlers.get(CHANNELS.getAnalysisBudget)(null),
    (error) => {
      assert.equal(error.code, "ANALYSIS_BUDGET_UNAVAILABLE");
      assert.equal(error.message, "Analysis budget is unavailable");
      return true;
    }
  );
});

test("IPC returns metadata-only self voice enrollment status", async () => {
  const { handlers } = createIpcHarness();

  assert.equal(
    await handlers.get(CHANNELS.getVoiceEnrollmentStatus)({ sender: { id: 7 } }),
    "voice-status"
  );
});

test("IPC returns cloud budget status without exposing the project key", async () => {
  let savedSettings = null;
  const { handlers } = createIpcHarness({
    setCloudBudgetSettings(input) {
      savedSettings = input;
    },
    getCloudBudgetStatus() {
      return {
        monthUtc: "2026-07",
        enabled: true,
        monthlyLimitMicrousd: 10_000_000,
        spentMicrousd: 1200,
        reservedMicrousd: 100_000,
        remainingMicrousd: 9_898_800,
        blockedReason: null,
      };
    },
  });

  const initial = await handlers.get(CHANNELS.getCloudBudget)();
  assert.equal(initial.keyConfigured, true);
  assert.equal(JSON.stringify(initial).includes("sk-project-test"), false);

  const updated = await handlers.get(CHANNELS.setCloudBudget)(null, {
    enabled: true,
    monthlyLimitMicrousd: 10_000_000,
  });
  assert.deepEqual(savedSettings, {
    enabled: true,
    monthlyLimitMicrousd: 10_000_000,
  });
  assert.equal(updated.keyConfigured, true);
  assert.equal(updated.monthlyLimitMicrousd, 10_000_000);
});

test("IPC validates identifiers and statuses before calling the repository", () => {
  let calls = 0;
  const { handlers } = createIpcHarness({
    setSessionStatus() {
      calls += 1;
    },
    listTranscriptSegments() {
      calls += 1;
    },
  });

  assert.throws(
    () => handlers.get(CHANNELS.setSessionStatus)(null, "../s1", "recording", 1000),
    /safe identifier/
  );
  assert.throws(
    () => handlers.get(CHANNELS.setSessionStatus)(null, "s1", "hidden-recording", 1000),
    /invalid session status/
  );
  assert.throws(() => handlers.get(CHANNELS.listSegments)(null, "../s1"), /safe identifier/);
  assert.equal(calls, 0);
});

test("IPC preserves repository errors for Electron invoke rejection", () => {
  const expected = new Error("database closed");
  const { handlers } = createIpcHarness({
    getSession() {
      throw expected;
    },
  });

  assert.throws(() => handlers.get(CHANNELS.getSession)(null, "s1"), expected);
});

test("session list and search IPC remove device and storage-private fields", async () => {
  const privateSession = {
    id: "s1",
    started_at: 1,
    ended_at: null,
    status: "recording",
    mic_device_id: "private-device-id",
    language: "zh",
    created_at: 1,
    capture_mode: "mic",
    capture_policy_json: '{"private":true}',
    storage_root: "C:\\private\\recordings",
  };
  const { handlers } = createIpcHarness({
    getSession: () => privateSession,
    listSessions: () => [privateSession],
    searchMemory: () => [privateSession],
  });

  for (const result of [
    await handlers.get(CHANNELS.getSession)(null, "s1"),
    (await handlers.get(CHANNELS.listSessions)(null, {}))[0],
    (await handlers.get(CHANNELS.searchMemory)(null, "session", 10))[0],
  ]) {
    assert.deepEqual(Object.keys(result).sort(), [
      "capture_mode",
      "created_at",
      "ended_at",
      "id",
      "language",
      "started_at",
      "status",
    ]);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("IPC binds narrow voice enrollment sessions to the requesting renderer", async () => {
  const expectedEnrollment = {
    status: "accepted",
    modelId: "3dspeaker-campplus-voxceleb-16k-v1",
    acceptedSpeechMs: 30_000,
    windowCount: 3,
    selfConsistency: 0.99,
  };
  const voiceEnrollmentService = createVoiceEnrollmentService({
    complete: () => expectedEnrollment,
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService,
    environmentManager: { getOpenAIKey: () => null },
  });
  const event = { sender: { id: 42 } };
  const payload = { sampleRate: 24_000, channels: 1, format: "float32", windows: [] };

  assert.equal(await handlers.get(CHANNELS.beginVoiceEnrollment)(event), "voice-begun");
  assert.deepEqual(
    await handlers.get(CHANNELS.completeVoiceEnrollment)(event, "opaque-id", payload),
    expectedEnrollment
  );
  assert.equal(handlers.get(CHANNELS.cancelVoiceEnrollment)(event, "opaque-id"), "voice-cancelled");
  assert.equal(typeof voiceEnrollmentService.complete, "function");
});

test("IPC cancels renderer-owned enrollment when the sender is destroyed", () => {
  let destroyedListener;
  const cancelOwnerCalls = [];
  const voiceEnrollmentService = createVoiceEnrollmentService({
    cancelOwner(ownerId) {
      cancelOwnerCalls.push(ownerId);
      return 1;
    },
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service: createService(),
    voiceEnrollmentService,
    environmentManager: { getOpenAIKey: () => null },
  });
  const event = {
    sender: {
      id: 42,
      once(name, listener) {
        assert.equal(name, "destroyed");
        destroyedListener = listener;
      },
    },
  };

  handlers.get(CHANNELS.beginVoiceEnrollment)(event);
  handlers.get(CHANNELS.beginVoiceEnrollment)(event);
  assert.equal(typeof destroyedListener, "function");
  destroyedListener();
  assert.deepEqual(cancelOwnerCalls, [42]);
});

test("IPC registration rejects invalid IPC and missing handler capabilities", () => {
  assert.throws(() => registerJarvisIpc({ ipcMain: null, repository: {}, service: {} }), /ipcMain/);
  assert.throws(
    () =>
      registerJarvisIpc({
        ipcMain: { handle() {} },
        repository: null,
        service: {},
        voiceEnrollmentService: {},
      }),
    /repository/
  );

  const requiredMethods = [
    "createSession",
    "setSessionStatus",
    "getSession",
    "listSessions",
    "upsertTranscriptSegments",
    "syncTranscriptSegments",
    "listTranscriptSegments",
    "renamePerson",
    "listPeople",
    "listAudioChunks",
    "getSessionTimeline",
    "getCloudBudgetStatus",
    "setCloudBudgetSettings",
  ];
  for (const method of requiredMethods) {
    const repository = createRepository();
    delete repository[method];
    const registered = [];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle: (channel) => registered.push(channel) },
          repository,
          service: createService(),
          voiceEnrollmentService: createVoiceEnrollmentService(),
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`repository\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  for (const method of [
    "startCapture",
    "setRetentionMode",
    "sourceInterrupted",
    "sourceRestored",
    "pauseCapture",
    "resumeCapture",
    "finishCapture",
    "failCapture",
  ]) {
    const service = createService();
    delete service[method];
    const registered = [];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle: (channel) => registered.push(channel) },
          repository: createRepository(),
          service,
          voiceEnrollmentService: createVoiceEnrollmentService(),
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`service\\.${method} must be a function`)
    );
    assert.deepEqual(registered, []);
  }

  for (const method of ["begin", "complete", "cancel", "cancelOwner"]) {
    const voiceEnrollmentService = createVoiceEnrollmentService();
    delete voiceEnrollmentService[method];
    assert.throws(
      () =>
        registerJarvisIpc({
          ipcMain: { handle() {} },
          repository: createRepository(),
          service: createService(),
          voiceEnrollmentService,
          environmentManager: { getOpenAIKey: () => null },
        }),
      new RegExp(`voiceEnrollmentService\\.${method} must be a function`)
    );
  }
});

test("storage IPC validates migration input, blocks active capture, and sanitizes failures", async () => {
  const handlers = new Map();
  const migrations = [];
  let runtimeState = { status: "idle" };
  const service = createService({ getState: () => runtimeState });
  const storageManager = {
    getStatus: async () => ({ state: "ok", currentRoot: "C:\\private\\jarvis" }),
    migrate: async (input) => {
      migrations.push(input);
      if (input.to.endsWith("failure")) throw new Error(`secret path ${input.to}`);
      return { switched: true };
    },
  };
  const pickStorageDirectory = async () => "D:\\Jarvis";
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service,
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
    storageManager,
    pickStorageDirectory,
  });

  assert.equal(await handlers.get(CHANNELS.pickStorageDirectory)(), "D:\\Jarvis");

  assert.deepEqual(await handlers.get(CHANNELS.getStorageStatus)(), {
    state: "ok",
    currentRoot: "C:\\private\\jarvis",
  });
  await assert.rejects(
    handlers.get(CHANNELS.migrateStorage)(null, { to: "relative" }),
    /invalid storage migration request/
  );
  await assert.rejects(
    handlers.get(CHANNELS.migrateStorage)(null, {
      to: "C:\\target",
      unexpected: true,
    }),
    /invalid storage migration request/
  );

  runtimeState = { status: "recording" };
  await assert.rejects(
    handlers.get(CHANNELS.migrateStorage)(null, { to: "C:\\target" }),
    /capture must be inactive/
  );
  runtimeState = { status: "idle" };
  assert.deepEqual(await handlers.get(CHANNELS.migrateStorage)(null, { to: "C:\\target" }), {
    switched: true,
  });
  assert.deepEqual(migrations, [{ to: "C:\\target" }]);
  await assert.rejects(
    handlers.get(CHANNELS.migrateStorage)(null, { to: "C:\\failure" }),
    (error) =>
      error.message === "storage migration failed; the current data directory is unchanged" &&
      !error.message.includes("C:\\failure")
  );
});

test("failCapture IPC validates known codes and preserves authoritative failed broadcast", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const JarvisService = require("../../src/jarvis/main/JarvisService");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fail-ipc-"));
  const session = { id: "s1", status: "recording" };
  const broadcasts = [];
  const repository = {
    getSession: () => session,
    setSessionStatus: (_id, status) => {
      session.status = status;
    },
    insertAudioChunk: () => {},
    createTrack: () => {},
    createTracks: () => {},
    setTrackState: () => {},
    openGap: () => {},
    interruptTrack: () => {},
    closeGap: () => {},
    restoreTrack: () => {},
    pauseCapture: () => {},
    pauseCaptureForLowDisk: () => {},
    resumeCapture: () => {},
    finalizeCapture: ({ sessionStatus }) => {
      session.status = sessionStatus;
    },
    setSessionRetention: () => {},
    recordEvidenceGap: () => {},
    commitChunk: () => {},
    recoverOpenSessions: () => [],
  };
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  const service = new JarvisService({
    repository,
    userDataDir,
    now: () => 1_100,
    fsImpl,
    broadcast: (state) => broadcasts.push(state),
  });
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository: createRepository(),
    service,
    voiceEnrollmentService: createVoiceEnrollmentService(),
    environmentManager: { getOpenAIKey: () => null },
  });

  try {
    service.startCapture({ sessionId: "s1", startedAt: 1_000, micDeviceId: null });
    assert.throws(
      () => handlers.get(CHANNELS.failCapture)(null, "s1", "upstream_stop_failed", 1_100),
      /capture failure code/
    );
    handlers.get(CHANNELS.failCapture)(null, "s1", "capture_source_unavailable", 1_100);

    assert.equal(service.getState().status, "failed");
    assert.equal(service.getState().errorCode, "capture_source_unavailable");
    assert.equal(session.status, "failed");
    assert.equal(broadcasts.at(-1).status, "failed");
    assert.equal(broadcasts.at(-1).errorCode, "capture_source_unavailable");
  } finally {
    service.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
