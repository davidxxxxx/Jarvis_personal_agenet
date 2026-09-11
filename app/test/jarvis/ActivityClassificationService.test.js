const test = require("node:test");
const assert = require("node:assert/strict");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const ActivityClassificationService = require("../../src/jarvis/main/ActivityClassificationService");
const AnalysisBudgetRepository = require("../../src/jarvis/main/AnalysisBudgetRepository");
const AnalysisBudgetGuard = require("../../src/jarvis/main/AnalysisBudgetGuard");

function activity() {
  return {
    activityId: "activity-dota",
    startedAt: 1_000,
    endedAt: 61_000,
    applications: ["dota2"],
    sourceAttribution: "application",
    speakerLabels: ["P1"],
    segments: [
      {
        segmentId: "segment-game",
        startedAt: 1_000,
        endedAt: 3_000,
        speakerLabel: "P1",
        text: "Welcome to the match",
      },
    ],
    statistics: {
      durationMs: 60_000,
      microphoneParticipated: false,
      selfDetected: false,
      speakerCount: 1,
      turnCount: 1,
      turnTakingScore: 0,
      foregroundAppKey: "dota2",
    },
    topicHints: ["gaming"],
    calendarBlockKind: "gaming",
  };
}

function fixture(
  t,
  { classifyImpl, validateInputImpl, isConfiguredImpl = () => true, reserveImpl } = {}
) {
  const jarvis = new JarvisRepository(":memory:", { now: () => 100_000 });
  t.after(() => jarvis.close());
  jarvis.createSession({ id: "session-activity", startedAt: 1_000, micDeviceId: "mic" });
  const events = [];
  const budgetGuard = {
    reserveNextAttempt(input) {
      events.push(["reserve", input]);
      return reserveImpl?.(input) ?? { ok: true, attemptNumber: 1 };
    },
    markStarted(requestId) {
      events.push(["started", requestId]);
    },
    reconcile(input) {
      events.push(["reconciled", input]);
    },
    release(input) {
      events.push(["released", input]);
    },
    markUsageUnknown(input) {
      events.push(["unknown", input]);
    },
  };
  const cloudClient = {
    model: "MiniMax-M2.7",
    isConfigured: isConfiguredImpl,
    ...(validateInputImpl === undefined ? {} : { validateInput: validateInputImpl }),
    classify:
      classifyImpl ??
      (async () => ({
        classifications: [
          {
            activityId: "activity-dota",
            category: "entertainment",
            confidence: 0.93,
            decision: "adopted",
            allowSummary: true,
            allowSuggestions: false,
            allowTodos: false,
            source: "minimax",
            reason: "passive game content",
            evidenceSegmentIds: ["segment-game"],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
      })),
  };
  const service = new ActivityClassificationService({
    repository: jarvis.activityClassificationRepository,
    cloudClient,
    budgetGuard,
    createRequestId: () => "activity-request-1",
    now: () => 100_000,
  });
  return { jarvis, service, events };
}

test("local classification is durable and MiniMax review supersedes it under one budget", async (t) => {
  const { jarvis, service, events } = fixture(t);

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-1",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "completed");
  assert.equal(result.classifications.length, 1);
  assert.equal(result.classifications[0].source, "minimax");
  assert.equal(result.classifications[0].category, "entertainment");
  assert.equal(result.classifications[0].evidence.allowTodos, false);
  const history = jarvis.listSessionActivityClassificationHistory("session-activity");
  assert.deepEqual(
    history.map((entry) => [entry.source, entry.category]),
    [
      ["local", "gaming"],
      ["minimax", "entertainment"],
    ]
  );
  assert.equal(events[0][0], "reserve");
  assert.equal(events[0][1].operation, "activity_classification");
  assert.deepEqual(
    events.slice(1).map((entry) => entry[0]),
    ["started", "reconciled"]
  );
});

test("local classification can be committed before any cloud job or budget attempt exists", (t) => {
  let cloudCalls = 0;
  const { jarvis, service, events } = fixture(t, {
    classifyImpl: async () => {
      cloudCalls += 1;
      throw new Error("cloud review must not run");
    },
  });

  const result = service.classifyLocal({
    sessionId: "session-activity",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "local_only");
  assert.equal(result.classifications.length, 1);
  assert.equal(result.classifications[0].source, "local");
  assert.equal(result.classifications[0].category, "gaming");
  assert.equal(cloudCalls, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(
    jarvis
      .listSessionActivityClassificationHistory("session-activity")
      .map((entry) => [entry.source, entry.category]),
    [["local", "gaming"]]
  );
});

test("cloud review reuses an already durable local classification without writing it twice", async (t) => {
  const { jarvis, service } = fixture(t);
  service.classifyLocal({ sessionId: "session-activity", activities: [activity()] });

  const result = await service.reviewSessionWithCloud({
    sessionId: "session-activity",
    jobId: "analysis-job-review",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "completed");
  assert.deepEqual(
    jarvis
      .listSessionActivityClassificationHistory("session-activity")
      .map((entry) => entry.source),
    ["local", "minimax"]
  );
});

test("new local evidence supersedes a stale MiniMax result until that evidence is reviewed", async (t) => {
  const { service } = fixture(t);
  await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-before-self",
    activities: [activity()],
  });

  const withConfirmedSelf = {
    ...activity(),
    sourceAttribution: "application_and_microphone",
    speakerLabels: ["SELF", "P1"],
    statistics: {
      ...activity().statistics,
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 2,
      turnCount: 4,
      turnTakingScore: 0.75,
    },
  };
  const refreshed = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-after-self",
    activities: [withConfirmedSelf],
    cloudReview: false,
  });

  assert.equal(refreshed.cloudStatus, "not_configured");
  assert.equal(refreshed.classifications.length, 1);
  assert.equal(refreshed.classifications[0].source, "local");
  assert.equal(refreshed.classifications[0].evidence.selfDetected, true);
  assert.equal(refreshed.classifications[0].sourceAttribution, "application_and_microphone");
});

test("MiniMax failure keeps the conservative local result and closes budget as unknown", async (t) => {
  const error = Object.assign(new Error("network"), {
    code: "network",
    requestSent: true,
  });
  const { service, events } = fixture(t, {
    classifyImpl: async () => {
      throw error;
    },
  });

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-2",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "cloud_failed_local_fallback");
  assert.equal(result.classifications[0].source, "local");
  assert.equal(result.classifications[0].category, "gaming");
  assert.deepEqual(
    events.map((entry) => entry[0]),
    ["reserve", "started", "unknown"]
  );
});

test("missing MiniMax configuration leaves the local classification durable without budget use", async (t) => {
  let cloudCalls = 0;
  const { service, events } = fixture(t, {
    isConfiguredImpl: () => false,
    classifyImpl: async () => {
      cloudCalls += 1;
      throw new Error("unconfigured cloud must not run");
    },
  });

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-no-key",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "not_configured");
  assert.equal(result.classifications[0].source, "local");
  assert.equal(cloudCalls, 0);
  assert.deepEqual(events, []);
});

test("a hard-budget rejection keeps the local classification and never starts cloud transport", async (t) => {
  let cloudCalls = 0;
  const { service, events } = fixture(t, {
    reserveImpl: () => ({ ok: false, reason: "hard_limit_reached" }),
    classifyImpl: async () => {
      cloudCalls += 1;
      throw new Error("budget-blocked cloud must not run");
    },
  });

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-budget-blocked",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "hard_limit_reached");
  assert.equal(result.classifications[0].source, "local");
  assert.equal(cloudCalls, 0);
  assert.deepEqual(
    events.map((entry) => entry[0]),
    ["reserve"]
  );
});

test("deterministic cloud preflight failures never reserve or start a paid attempt", async (t) => {
  let classifyCalls = 0;
  const { service, events } = fixture(t, {
    validateInputImpl() {
      throw Object.assign(new Error("invalid context"), { code: "invalid_structure" });
    },
    classifyImpl: async () => {
      classifyCalls += 1;
      throw new Error("classify should not run");
    },
  });

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-preflight",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "local_preflight_failed");
  assert.equal(result.classifications[0].source, "local");
  assert.equal(classifyCalls, 0);
  assert.deepEqual(events, []);
});

test("MiniMax invalid output with authoritative usage reconciles cost instead of marking it unknown", async (t) => {
  const error = Object.assign(new Error("invalid"), {
    code: "invalid_structure",
    requestSent: true,
    usage: { inputTokens: 321, outputTokens: 45 },
  });
  const { service, events } = fixture(t, {
    classifyImpl: async () => {
      throw error;
    },
  });

  const result = await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-invalid",
    activities: [activity()],
  });

  assert.equal(result.cloudStatus, "cloud_failed_local_fallback");
  assert.deepEqual(
    events.map((entry) => entry[0]),
    ["reserve", "started", "reconciled"]
  );
  assert.deepEqual(events[2][1].usage, { inputTokens: 321, outputTokens: 45 });
});

test("activity classification is charged to the shared durable MiniMax hard budget", async (t) => {
  const now = Date.UTC(2026, 6, 20, 4);
  const jarvis = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => jarvis.close());
  jarvis.createSession({ id: "session-activity", startedAt: 1_000, micDeviceId: "mic" });
  const budgetGuard = new AnalysisBudgetGuard({
    repository: new AnalysisBudgetRepository(jarvis.db),
    now: () => now,
    defaultTimezone: "Asia/Shanghai",
  });
  budgetGuard.initialize();
  const service = new ActivityClassificationService({
    repository: jarvis.activityClassificationRepository,
    budgetGuard,
    cloudClient: {
      model: "MiniMax-M2.7",
      isConfigured: () => true,
      classify: async () => ({
        classifications: [
          {
            activityId: "activity-dota",
            category: "gaming",
            confidence: 0.98,
            decision: "adopted",
            allowSummary: true,
            allowSuggestions: false,
            allowTodos: false,
            source: "minimax",
            reason: "foreground game",
            evidenceSegmentIds: ["segment-game"],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    },
    createRequestId: () => "activity-budget-request",
    now: () => now,
  });

  await service.classifySession({
    sessionId: "session-activity",
    jobId: "analysis-job-budget",
    activities: [activity()],
  });

  assert.deepEqual(
    jarvis.db
      .prepare(
        `SELECT operation, state, actual_input_tokens, actual_output_tokens
         FROM analysis_budget_attempts WHERE request_id = 'activity-budget-request'`
      )
      .get(),
    {
      operation: "activity_classification",
      state: "reconciled",
      actual_input_tokens: 100,
      actual_output_tokens: 20,
    }
  );
  assert.ok(budgetGuard.getStatus().spentMicrousd > 0);
});
