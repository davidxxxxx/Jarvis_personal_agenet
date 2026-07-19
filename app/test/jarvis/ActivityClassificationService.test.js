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

function fixture(t, { classifyImpl } = {}) {
  const jarvis = new JarvisRepository(":memory:", { now: () => 100_000 });
  t.after(() => jarvis.close());
  jarvis.createSession({ id: "session-activity", startedAt: 1_000, micDeviceId: "mic" });
  const events = [];
  const budgetGuard = {
    reserveNextAttempt(input) {
      events.push(["reserve", input]);
      return { ok: true, attemptNumber: 1 };
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
    isConfigured: () => true,
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
  assert.deepEqual(events.slice(1).map((entry) => entry[0]), ["started", "reconciled"]);
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
  assert.deepEqual(events.map((entry) => entry[0]), ["reserve", "started", "unknown"]);
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
