const test = require("node:test");
const assert = require("node:assert/strict");
const AnalysisInputBuilder = require("../../src/jarvis/main/AnalysisInputBuilder");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const {
  MODEL,
  createDesiredIdentity,
  createProductionAgentCloudComposition,
  digestInputIsFinalOnly,
} = require("../../src/jarvis/main/AgentCloudComposition");

test("desired identity is deterministic and changes with durable identity revision", () => {
  const prepared = {
    identityRevision: "a".repeat(64),
    segments: [{ segmentId: "segment-1", speakerBindingLabel: "SELF" }],
  };
  const first = createDesiredIdentity({ prepared });
  assert.deepEqual(createDesiredIdentity({ prepared }), first);
  assert.equal(first.modelVersion, MODEL);
  assert.equal(first.responseSchemaVersion, "jarvis-analysis-v3");
  assert.equal(Number.isSafeInteger(first.pseudonymBindingRevision), true);
  assert.equal(Number.isSafeInteger(first.segmentSubjectRevisions[0].subjectRevision), true);
  assert.notDeepEqual(
    createDesiredIdentity({ prepared: { ...prepared, identityRevision: "b".repeat(64) } }),
    first
  );
});

test("digest source admission accepts coverage-partial inputs but never untrusted inputs", () => {
  const base = {
    contractVersion: "jarvis-daily-digest-input-v1",
    completeness: "partial",
    inputWatermark: {
      schemaVersion: "jarvis-daily-digest-watermark-v1",
      evidence: [{ segmentId: "segment-1" }],
    },
  };
  assert.equal(digestInputIsFinalOnly(base), true);
  assert.equal(digestInputIsFinalOnly({ ...base, contractVersion: "forged" }), false);
  assert.equal(
    digestInputIsFinalOnly({ ...base, inputWatermark: { ...base.inputWatermark, evidence: [] } }),
    false
  );
});

test("production composition owns one guarded dispatcher and performs zero startup network", async (t) => {
  const inputBuilder = new AnalysisInputBuilder();
  const repository = new JarvisRepository(":memory:", {
    validateRedactedCloudPayload: (input) => inputBuilder.verifyRedactedCloudPayload(input),
  });
  t.after(() => repository.close());
  let networkCalls = 0;
  const composition = createProductionAgentCloudComposition({
    repository,
    inputBuilder,
    getApiKey: () => "configured-test-key",
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network must not run without a durable job");
    },
    governor: {
      cloudPressure: () =>
        Object.freeze({
          state: "normal",
          reason: null,
          cpuLoadPct: 10,
          memoryLoadPct: 20,
          onAcPower: true,
          batteryLevelPct: 100,
        }),
    },
    previewScheduler: { status: () => ({ running: 0 }) },
    timezoneProvider: () => "UTC",
    now: () => Date.UTC(2026, 6, 17, 12),
    owner: "production-agent",
  });

  assert.deepEqual(Object.keys(composition.cloudDispatcher.workers).sort(), [
    "analyze_session",
    "generate_daily_digest",
  ]);
  assert.equal(
    composition.analysisBudgetGuard,
    composition.cloudDispatcher.workers.analyze_session.budgetGuard
  );
  assert.equal(
    composition.analysisBudgetGuard,
    composition.cloudDispatcher.workers.generate_daily_digest.budgetGuard
  );
  assert.equal(composition.analysisScheduler.cloudTransportEnabled, true);
  await composition.dailyDigestScheduler.start();
  await composition.cloudDispatcher.start();
  await composition.dailyDigestScheduler.stop();
  await composition.cloudDispatcher.stop();
  assert.equal(networkCalls, 0);
});
