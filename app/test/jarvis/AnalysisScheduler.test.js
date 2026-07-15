const test = require("node:test");
const assert = require("node:assert/strict");
const AnalysisScheduler = require("../../src/jarvis/main/AnalysisScheduler");

const HASH = "a".repeat(64);

function sessionDetail() {
  return {
    session: { id: "s1", started_at: 1, status: "completed", processing_state: "ready" },
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
        text: "real name discussed C:\\secret\\notes.txt",
        result_kind: "final",
        is_stable: 1,
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
        textSnapshot: "real name discussed C:\\secret\\notes.txt",
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
        subjectDisplayNameSnapshot: "real name",
      },
    ],
  };
}

function desiredIdentity(overrides = {}) {
  return {
    responseSchemaVersion: "jarvis-analysis-v2",
    pseudonymBindingRevision: 7,
    modelVersion: "MiniMax-M2.7",
    segmentSubjectRevisions: [{ segmentId: "seg-final", subjectRevision: 9 }],
    ...overrides,
  };
}

function harness({ sendable = true } = {}) {
  const events = [];
  let inputCreated = false;
  let identity = desiredIdentity();
  const headHashes = new Map();
  const repository = {
    getSessionDetail: () => sessionDetail(),
    listPeople: () => [{ id: "person-real", display_name: "real name", is_self: 0 }],
  };
  const memoryRepository = {
    prepareAnalysisInput(request) {
      events.push(["prepare", request]);
      return preparedSnapshot(request);
    },
    createAnalysisInput(request) {
      events.push(["create", request]);
      const status = inputCreated ? "existing" : "created";
      inputCreated = true;
      return {
        status,
        candidateState: "pending",
        analysisInputId: "input-1",
        inputHash: HASH,
      };
    },
    setAnalysisDesiredHead(input) {
      events.push(["set_head", input]);
      const key = JSON.stringify(input);
      if (!headHashes.has(key)) {
        const digit = String(headHashes.size + 1);
        headHashes.set(key, digit.repeat(64));
      }
      return {
        analysisInputId: input.analysisInputId,
        analysisInputHash: HASH,
        desiredVectorHash: headHashes.get(key),
        modelVersion: input.modelVersion,
      };
    },
  };
  const cloudQueue = {
    enqueueCloudJob(input) {
      events.push(["enqueue", input]);
      return { id: `job-${input.desiredHeadHash[0]}`, state: "pending" };
    },
  };
  const scheduler = new AnalysisScheduler({
    repository,
    memoryRepository,
    inputBuilder: {
      build() {
        events.push(["build"]);
        if (!sendable) return { sendable: false, reason: "analysis_input_invalid" };
        return {
          sendable: true,
          inputContractVersion: "jarvis-analysis-input-v2",
          redactionVersion: "jarvis-redaction-v1",
          cloudPayloadJson: JSON.stringify({
            inputVersion: "jarvis-analysis-input-v2",
            segments: [
              {
                segmentId: "seg-final",
                startedAt: 2,
                endedAt: 3,
                speakerLabel: "P1",
                text: "redacted evidence",
              },
            ],
            omittedRanges: [],
          }),
        };
      },
    },
    desiredIdentityProvider: () => identity,
    cloudQueue,
    cloudTransportEnabled: true,
    now: () => 10,
  });
  return {
    scheduler,
    events,
    setIdentity(next) {
      identity = desiredIdentity(next);
    },
  };
}

test("production-default analysis is blocked before reading a session or cloud state", async () => {
  let reads = 0;
  const scheduler = new AnalysisScheduler({
    repository: {
      getSessionDetail() {
        reads += 1;
      },
    },
    now: () => 10,
  });

  assert.deepEqual(await scheduler.analyzeSession("s1", "final"), {
    sessionId: "s1",
    state: "blocked",
    errorCode: "analysis_runtime_not_ready",
    updatedAt: 10,
  });
  assert.equal(reads, 0);
});

test("checkpoint and stop triggers only enqueue an exact redacted durable cloud job", async () => {
  const { scheduler, events } = harness();

  const status = await scheduler.analyzeSession("s1", "final");
  assert.equal(status.state, "queued");
  assert.equal(status.reused, false);
  assert.deepEqual(
    events.map(([name]) => name),
    ["prepare", "build", "create", "set_head", "enqueue"]
  );
  const created = events.find(([name]) => name === "create")[1];
  assert.doesNotMatch(created.cloudPayloadJson, /real name|secret|notes\.txt/u);
  const enqueued = events.find(([name]) => name === "enqueue")[1];
  assert.deepEqual(Object.keys(enqueued).sort(), [
    "analysisInputId",
    "desiredHeadHash",
    "inputHash",
    "inputVersion",
    "jobType",
    "modelVersion",
    "sessionId",
  ]);
  assert.doesNotMatch(JSON.stringify(enqueued), /transcript|audio|secret|redacted evidence/u);
});

test("ten-minute and final triggers target the same durable identity without direct execution", async () => {
  const { scheduler, events } = harness();

  const checkpoint = await scheduler.analyzeSession("s1", "incremental");
  const final = await scheduler.analyzeSession("s1", "final");
  assert.equal(checkpoint.jobId, final.jobId);
  assert.equal(checkpoint.desiredVectorHash, final.desiredVectorHash);
  assert.equal(final.reused, true);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 2);
  assert.equal(
    events.some(([name]) => name === "client"),
    false
  );
});

test("changed schema or subject identity targets a replacement desired-head job", async () => {
  const { scheduler, setIdentity } = harness();

  const first = await scheduler.analyzeSession("s1", "final");
  setIdentity({
    responseSchemaVersion: "jarvis-analysis-v3",
    segmentSubjectRevisions: [{ segmentId: "seg-final", subjectRevision: 10 }],
  });
  const replacement = await scheduler.analyzeSession("s1", "final");
  assert.notEqual(replacement.desiredVectorHash, first.desiredVectorHash);
  assert.notEqual(replacement.jobId, first.jobId);
});

test("an unsendable immutable input is blocked before input, head, or job persistence", async () => {
  const { scheduler, events } = harness({ sendable: false });

  const status = await scheduler.analyzeSession("s1", "final");
  assert.equal(status.state, "blocked");
  assert.equal(status.errorCode, "analysis_input_invalid");
  assert.equal(
    events.some(([name]) => name === "create"),
    false
  );
  assert.equal(
    events.some(([name]) => name === "set_head"),
    false
  );
  assert.equal(
    events.some(([name]) => name === "enqueue"),
    false
  );
});

test("quiesce rejects new enqueue work and resume restores enqueue-only scheduling", async () => {
  const { scheduler } = harness();

  await scheduler.quiesce();
  assert.throws(
    () => scheduler.analyzeSession("s1", "final"),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  scheduler.resume();
  assert.equal((await scheduler.analyzeSession("s1", "final")).state, "queued");
});
