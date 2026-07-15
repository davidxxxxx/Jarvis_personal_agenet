const test = require("node:test");
const assert = require("node:assert/strict");
const AnalysisScheduler = require("../../src/jarvis/main/AnalysisScheduler");
const AnalysisInputBuilder = require("../../src/jarvis/main/AnalysisInputBuilder");

const HASH = "a".repeat(64);

function sessionDetail() {
  return {
    session: { id: "s1", started_at: 1 },
    summary: { summary: "must never be sent as a legacy previousSummary" },
    segments: [
      {
        id: "seg-provisional",
        started_at: 1,
        ended_at: 2,
        version: 1,
        person_id: null,
        text: "preview",
        result_kind: "provisional",
        is_stable: 1,
        superseded_by: null,
        duplicate_of: null,
      },
      {
        id: "seg-final",
        started_at: 2,
        ended_at: 3,
        version: 2,
        person_id: "person-real",
        text: "张三 discussed C:\\secret\\notes.txt",
        result_kind: "final",
        is_stable: 1,
        superseded_by: null,
        duplicate_of: null,
      },
      {
        id: "seg-unstable",
        started_at: 3,
        ended_at: 4,
        version: 1,
        person_id: null,
        text: "not final yet",
        result_kind: "final",
        is_stable: 0,
        superseded_by: null,
        duplicate_of: null,
      },
    ],
  };
}

function preparedSnapshot(request) {
  return {
    ...request,
    prepareToken: "b".repeat(64),
    segments: [
      {
        ordinal: 0,
        segmentId: "seg-final",
        segmentVersion: 2,
        textHash: "c".repeat(64),
        textSnapshot: "张三 discussed C:\\secret\\notes.txt",
        resultKind: "final",
        isStable: true,
        isCurrent: true,
        supersededBy: null,
        duplicateOf: null,
        speakerBindingLabel: "P1",
        startedAt: 2,
        endedAt: 3,
      },
    ],
    speakerBindings: [
      {
        label: "P1",
        subjectKind: "person",
        subjectId: "person-real",
        subjectDisplayNameSnapshot: "张三",
      },
    ],
    redactionTerms: {
      participants: [{ label: "P1", names: ["张三"] }],
      otherPeople: [],
      deviceLabels: [],
    },
  };
}

function candidate() {
  return {
    schemaVersion: "jarvis-analysis-v2",
    sessionSummary: {
      title: "Discussion",
      summary: "A discussion occurred.",
      evidenceSegmentIds: ["seg-final"],
    },
    memories: [],
    topics: [],
    todos: [],
    suggestions: [],
  };
}

test(
  "production-default analysis is explicitly blocked and cannot reach persistence or network",
  async () => {
    let calls = 0;
    const scheduler = new AnalysisScheduler({
      repository: {
        getSessionDetail() {
          calls += 1;
          return sessionDetail();
        },
      },
      now: () => 10,
    });

    const status = await scheduler.analyzeSession("s1", "final");
    assert.deepEqual(status, {
      sessionId: "s1",
      state: "blocked",
      errorCode: "analysis_runtime_not_ready",
      updatedAt: 10,
    });
    assert.equal(calls, 0);
  },
  { timeout: 1_000 }
);

test("deduplicates the actual input across kinds and never refetches an applied input", async () => {
  const events = [];
  const releaseClients = [];
  let created = false;
  let applied = false;
  let cloudPayloadJson = null;
  const repository = {
    getSessionDetail: () => sessionDetail(),
    listPeople: () => [{ id: "person-real", display_name: "张三", is_self: 0 }],
    applyAnalysisResult() {
      assert.fail("legacy applyAnalysisResult must never be used");
    },
  };
  const memoryRepository = {
    prepareAnalysisInput(request) {
      events.push(["prepare", request]);
      return preparedSnapshot(request);
    },
    createAnalysisInput(request) {
      events.push(["create", request]);
      cloudPayloadJson = request.cloudPayloadJson;
      if (created) {
        return {
          status: "existing",
          candidateState: applied ? "applied" : "pending",
          analysisInputId: "input-1",
          inputHash: HASH,
        };
      }
      created = true;
      return {
        status: "created",
        candidateState: "pending",
        analysisInputId: "input-1",
        inputHash: HASH,
      };
    },
    getAnalysisInputForCloud(id) {
      events.push(["cloud", id]);
      return {
        inputHash: HASH,
        cloudPayloadJson,
        allowedSegmentIds: ["seg-final"],
        allowedOwnerLabels: ["P1"],
      };
    },
    applyCandidateAnalysis(request) {
      events.push(["apply", request]);
      applied = true;
      return { status: "applied" };
    },
  };
  const scheduler = new AnalysisScheduler({
    repository,
    memoryRepository,
    inputBuilder: new AnalysisInputBuilder(),
    client: {
      analyze(input) {
        events.push(["client", input]);
        return new Promise((resolve) => {
          releaseClients.push(() =>
            resolve({
              result: candidate(),
              usage: { inputTokens: 12, outputTokens: 4 },
              model: "fixture",
            })
          );
        });
      },
    },
    cloudTransportEnabled: true,
    now: () => 10,
  });

  const first = scheduler.analyzeSession("s1", "final");
  const second = scheduler.analyzeSession("s1", "incremental");
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseClients.length, 1);
  releaseClients[0]();
  const status = await first;

  assert.equal(events.filter(([name]) => name === "client").length, 1);
  assert.equal(events.filter(([name]) => name === "cloud").length, 1);
  assert.equal(events.filter(([name]) => name === "apply").length, 1);
  assert.deepEqual(events[0][1].segmentIds, ["seg-final"]);
  assert.match(events[0][1].transcriptRevision, /^[0-9a-f]{64}$/u);
  assert.match(events[0][1].identityRevision, /^[0-9a-f]{64}$/u);
  assert.equal(events[0][1].promptVersion, "jarvis-analysis-v2");
  const clientInput = events.find(([name]) => name === "client")[1];
  assert.deepEqual(Object.keys(clientInput).sort(), [
    "allowedOwnerLabels",
    "allowedSegmentIds",
    "cloudPayloadJson",
    "inputHash",
  ]);
  assert.doesNotMatch(clientInput.cloudPayloadJson, /张三|secret|notes\.txt/u);
  assert.deepEqual(events.find(([name]) => name === "apply")[1], {
    analysisInputId: "input-1",
    inputHash: HASH,
    candidate: candidate(),
  });
  assert.equal(status.state, "ready");
  assert.deepEqual(status.usage, { inputTokens: 12, outputTokens: 4 });

  const reused = await scheduler.analyzeSession("s1", "final");
  assert.equal(reused.state, "ready");
  assert.equal(reused.reused, true);
  assert.equal(events.filter(([name]) => name === "client").length, 1);
  assert.equal(events.filter(([name]) => name === "cloud").length, 1);
});

test("an unsendable complete-segment budget result is blocked before durable input or network", async () => {
  let durableWrites = 0;
  let networkCalls = 0;
  const scheduler = new AnalysisScheduler({
    repository: { getSessionDetail: () => sessionDetail(), listPeople: () => [] },
    memoryRepository: {
      prepareAnalysisInput: (request) => preparedSnapshot(request),
      createAnalysisInput() {
        durableWrites += 1;
      },
      getAnalysisInputForCloud() {},
      applyCandidateAnalysis() {},
    },
    inputBuilder: { build: () => ({ sendable: false, reason: "budget_exceeded" }) },
    client: {
      analyze() {
        networkCalls += 1;
      },
    },
    cloudTransportEnabled: true,
    now: () => 11,
  });

  const status = await scheduler.analyzeSession("s1", "final");
  assert.equal(status.state, "blocked");
  assert.equal(status.errorCode, "budget_exceeded");
  assert.equal(durableWrites, 0);
  assert.equal(networkCalls, 0);
});

test("an existing pending input is reported without issuing an unowned network retry", async () => {
  let cloudReads = 0;
  let networkCalls = 0;
  const scheduler = new AnalysisScheduler({
    repository: { getSessionDetail: () => sessionDetail(), listPeople: () => [] },
    memoryRepository: {
      prepareAnalysisInput: (request) => preparedSnapshot(request),
      createAnalysisInput: () => ({
        status: "existing",
        candidateState: "pending",
        analysisInputId: "input-existing",
        inputHash: HASH,
      }),
      getAnalysisInputForCloud() {
        cloudReads += 1;
      },
      applyCandidateAnalysis() {},
    },
    inputBuilder: new AnalysisInputBuilder(),
    client: {
      analyze() {
        networkCalls += 1;
      },
    },
    cloudTransportEnabled: true,
    now: () => 11,
  });

  const status = await scheduler.analyzeSession("s1", "final");
  assert.equal(status.state, "retry_needed");
  assert.equal(status.errorCode, "analysis_input_pending");
  assert.equal(status.reused, true);
  assert.equal(cloudReads, 0);
  assert.equal(networkCalls, 0);
});

test("typed client failures preserve a closed analysis status", async () => {
  const error = Object.assign(new Error("safe"), { code: "network", retryable: true });
  const memoryRepository = {
    prepareAnalysisInput: (request) => preparedSnapshot(request),
    createAnalysisInput: () => ({
      status: "created",
      candidateState: "pending",
      analysisInputId: "input-1",
      inputHash: HASH,
    }),
    getAnalysisInputForCloud: () => ({
      inputHash: HASH,
      cloudPayloadJson: JSON.stringify({
        inputVersion: "jarvis-analysis-input-v2",
        segments: [
          { segmentId: "seg-final", startedAt: 2, endedAt: 3, speakerLabel: "P1", text: "x" },
        ],
        omittedRanges: [],
      }),
      allowedSegmentIds: ["seg-final"],
      allowedOwnerLabels: ["P1"],
    }),
    applyCandidateAnalysis: () => assert.fail("failed candidates cannot be applied"),
  };
  const scheduler = new AnalysisScheduler({
    repository: { getSessionDetail: () => sessionDetail(), listPeople: () => [] },
    memoryRepository,
    inputBuilder: new AnalysisInputBuilder(),
    client: { analyze: async () => Promise.reject(error) },
    cloudTransportEnabled: true,
    now: () => 12,
  });

  await assert.rejects(scheduler.analyzeSession("s1", "final"), (actual) => actual === error);
  assert.deepEqual(scheduler.getStatus("s1"), {
    sessionId: "s1",
    state: "retry_needed",
    errorCode: "network",
    updatedAt: 12,
  });
});

test("quiesce blocks new analysis and waits for an in-flight v2 request", async () => {
  let resolveAnalysis;
  const memoryRepository = {
    prepareAnalysisInput: (request) => preparedSnapshot(request),
    createAnalysisInput: () => ({
      status: "created",
      candidateState: "pending",
      analysisInputId: "input-1",
      inputHash: HASH,
    }),
    getAnalysisInputForCloud: () => ({
      inputHash: HASH,
      cloudPayloadJson: JSON.stringify({
        inputVersion: "jarvis-analysis-input-v2",
        segments: [
          { segmentId: "seg-final", startedAt: 2, endedAt: 3, speakerLabel: "P1", text: "x" },
        ],
        omittedRanges: [],
      }),
      allowedSegmentIds: ["seg-final"],
      allowedOwnerLabels: ["P1"],
    }),
    applyCandidateAnalysis() {},
  };
  const scheduler = new AnalysisScheduler({
    repository: { getSessionDetail: () => sessionDetail(), listPeople: () => [] },
    memoryRepository,
    inputBuilder: new AnalysisInputBuilder(),
    client: {
      analyze: () =>
        new Promise((resolve) => {
          resolveAnalysis = () => resolve({ result: candidate(), usage: {}, model: "fixture" });
        }),
    },
    cloudTransportEnabled: true,
    now: () => 10,
  });
  const running = scheduler.analyzeSession("s1", "final");
  let drained = false;
  const quiesced = scheduler.quiesce().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(drained, false);
  assert.throws(
    () => scheduler.analyzeSession("s1", "incremental"),
    (actual) => actual?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  resolveAnalysis();
  await Promise.all([running, quiesced]);
  scheduler.resume();
  assert.doesNotThrow(() => scheduler.analyzeSession("s1", "final"));
});
