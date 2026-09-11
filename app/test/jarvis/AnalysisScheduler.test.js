const test = require("node:test");
const assert = require("node:assert/strict");
const AnalysisScheduler = require("../../src/jarvis/main/AnalysisScheduler");

const HASH = "a".repeat(64);
const EMPTY_ACTIVITY_REVISION = "e".repeat(64);
const LOCAL_ACTIVITY_REVISION = "d".repeat(64);
const ADOPTED_ACTIVITY_REVISION = "f".repeat(64);

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
        projection_state: "visible",
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
        projection_state: "visible",
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

function harness(options = {}) {
  const {
    sendable = true,
    jobState = "pending",
    activityClassification = false,
    activityCloudReviewEnabled = true,
    cloudTransportEnabled = true,
  } = options;
  const events = [];
  const tracksParticipantSnapshot = Object.prototype.hasOwnProperty.call(
    options,
    "participantSnapshotRevision"
  );
  let participantSnapshotRevision = options.participantSnapshotRevision;
  let identity = desiredIdentity();
  let activityClassifications = [...(options.activityClassifications ?? [])];
  let activityClassificationRevision =
    options.activityClassificationRevision ?? EMPTY_ACTIVITY_REVISION;
  let enqueueFailures = 0;
  const inputsByKey = new Map();
  const inputsById = new Map();
  const headHashes = new Map();
  let currentHead = null;
  const repository = {
    getSessionDetail: () => options.sessionDetail ?? sessionDetail(),
    listPeople: () => [{ id: "person-real", display_name: "real name", is_self: 0 }],
    markSessionSummaryRefreshRecommended(sessionId, reason, at) {
      events.push(["recommend_summary_refresh", { sessionId, reason, at }]);
      return {
        session_id: sessionId,
        recommended: 1,
        reason,
        updated_at: at,
      };
    },
    ...(tracksParticipantSnapshot
      ? {
          getLatestParticipantSnapshot: () => participantSnapshotRevision,
        }
      : {}),
    ...(activityClassification
      ? {
          listSessionActivityClassifications: () => activityClassifications,
        }
      : {}),
  };
  const memoryRepository = {
    prepareAnalysisInput(request) {
      events.push(["prepare", request]);
      return preparedSnapshot(request);
    },
    createAnalysisInput(request) {
      events.push(["create", request]);
      const key = JSON.stringify({
        transcriptRevision: request.transcriptRevision,
        identityRevision: request.identityRevision,
        promptVersion: request.promptVersion,
        segmentIds: request.segmentIds,
        cloudPayloadJson: request.cloudPayloadJson,
      });
      let input = inputsByKey.get(key);
      const status = input ? "existing" : "created";
      if (!input) {
        const index = inputsByKey.size + 1;
        input = {
          analysisInputId: `input-${index}`,
          inputHash: index === 1 ? HASH : index.toString(16).repeat(64),
        };
        inputsByKey.set(key, input);
        inputsById.set(input.analysisInputId, input);
      }
      return {
        status,
        candidateState: "pending",
        ...input,
      };
    },
    setAnalysisDesiredHead(input) {
      events.push(["set_head", input]);
      const key = JSON.stringify(input);
      if (!headHashes.has(key)) {
        const digit = String(headHashes.size + 1);
        headHashes.set(key, digit.repeat(64));
      }
      currentHead = {
        analysisInputId: input.analysisInputId,
        analysisInputHash: inputsById.get(input.analysisInputId).inputHash,
        desiredVectorHash: headHashes.get(key),
        modelVersion: input.modelVersion,
        activityClassificationRevision: input.activityClassificationRevision ?? null,
      };
      return currentHead;
    },
    ...(activityClassification
      ? {
          getActivityActionPolicyRevision() {
            return activityClassificationRevision;
          },
          getAnalysisDesiredHead() {
            return currentHead;
          },
        }
      : {}),
  };
  const cloudQueue = {
    enqueueCloudJob(input) {
      events.push(["enqueue", input]);
      if (enqueueFailures > 0) {
        enqueueFailures -= 1;
        const error = new Error("durable cloud queue temporarily unavailable");
        error.code = "analysis_runtime_not_ready";
        throw error;
      }
      return { id: `job-${input.desiredHeadHash[0]}`, state: jobState };
    },
    authorizeManualAnalysisRetry(id, options) {
      events.push(["manual_retry", id, options]);
      return { id, state: "retry" };
    },
  };
  const scheduler = new AnalysisScheduler({
    repository,
    memoryRepository,
    inputBuilder: {
      build(_prepared, options) {
        events.push(["build", options]);
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
    cloudTransportEnabled,
    activityCloudReviewEnabled,
    ...(activityClassification
      ? {
          activityClassificationService: {
            classifyLocal(input) {
              events.push(["classify_activity_local", input]);
              const result = options.classifyLocalActivity
                ? options.classifyLocalActivity(input)
                : {
                    classifications: [{ id: "classification-local", decision: "adopted" }],
                    cloudStatus: "local_only",
                    activityClassificationRevision: LOCAL_ACTIVITY_REVISION,
                  };
              if (Array.isArray(result?.classifications)) {
                activityClassifications = result.classifications;
              }
              if (typeof result?.activityClassificationRevision === "string") {
                activityClassificationRevision = result.activityClassificationRevision;
              }
              return result;
            },
            async reviewSessionWithCloud(input) {
              events.push(["classify_activity_cloud", input]);
              const result = options.classifyActivity
                ? await options.classifyActivity(input)
                : { classifications: [], cloudStatus: "completed" };
              if (Array.isArray(result?.classifications)) {
                activityClassifications = result.classifications;
              }
              if (typeof result?.activityClassificationRevision === "string") {
                activityClassificationRevision = result.activityClassificationRevision;
              }
              return result;
            },
          },
          activityBuilder: {
            build() {
              return {
                activities: [
                  {
                    activityId: "activity-1",
                    startedAt: 2,
                    endedAt: 3,
                    applications: [],
                    sourceAttribution: "microphone",
                    speakerLabels: ["P1"],
                    segments: [],
                    statistics: {},
                  },
                ],
                redactionTerms: {
                  participants: [],
                  otherPeople: [],
                  deviceLabels: [],
                },
              };
            },
          },
        }
      : {}),
    now: () => 10,
  });
  return {
    scheduler,
    events,
    setIdentity(next) {
      identity = desiredIdentity(next);
    },
    setParticipantSnapshot(next) {
      if (!tracksParticipantSnapshot) {
        throw new Error("participant snapshot tracking was not enabled for this harness");
      }
      participantSnapshotRevision = next;
    },
    setActivityClassificationState(classifications, revision) {
      activityClassifications = [...classifications];
      activityClassificationRevision = revision;
    },
    failNextEnqueue() {
      enqueueFailures += 1;
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

test("cloud-disabled analysis still commits local activity classification without touching cloud state", async () => {
  const { scheduler, events } = harness({
    activityClassification: true,
    cloudTransportEnabled: false,
  });

  const status = await scheduler.analyzeSession("s1", "final");

  assert.equal(status.state, "blocked");
  assert.equal(status.errorCode, "analysis_runtime_not_ready");
  assert.equal(status.localClassification, "completed");
  assert.deepEqual(
    events.map(([name]) => name),
    ["classify_activity_local"]
  );
});

test("activity rollout rollback keeps local classification and analysis while skipping cloud review", async () => {
  const { scheduler, events } = harness({
    activityClassification: true,
    activityCloudReviewEnabled: false,
  });

  const status = await scheduler.analyzeSession("s1", "final");
  await scheduler.quiesce();

  assert.equal(status.state, "queued");
  assert.equal(events.filter(([name]) => name === "classify_activity_local").length, 1);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
  assert.equal(events.filter(([name]) => name === "classify_activity_cloud").length, 0);
});

test("forced local classification rebuilds latest activity evidence without touching cloud state", () => {
  const { scheduler, events } = harness({
    activityClassification: true,
    activityClassifications: [{ id: "classification-existing", decision: "adopted" }],
  });
  const originalBuild = scheduler.activityBuilder.build.bind(scheduler.activityBuilder);
  let builds = 0;
  scheduler.activityBuilder.build = (sessionId) => {
    builds += 1;
    assert.equal(sessionId, "s1");
    return originalBuild(sessionId);
  };

  assert.equal(scheduler.classifySessionLocally("s1"), null);
  const prepared = scheduler.classifySessionLocally("s1", { force: true });

  assert.equal(builds, 1);
  assert.equal(prepared.activities[0].activityId, "activity-1");
  assert.deepEqual(
    events.map(([name]) => name),
    ["classify_activity_local"]
  );
  assert.equal(
    events.some(([name]) => name === "classify_activity_cloud"),
    false
  );
  assert.equal(
    events.some(([name]) => name === "enqueue"),
    false
  );
});

test("local activity classification is durable before cloud input preparation and enqueue", async () => {
  const { scheduler, events } = harness({ activityClassification: true });

  await scheduler.analyzeSession("s1", "final");
  await scheduler.quiesce();

  const names = events.map(([name]) => name);
  assert.ok(names.indexOf("classify_activity_local") < names.indexOf("prepare"));
  assert.ok(names.indexOf("classify_activity_local") < names.indexOf("enqueue"));
  assert.ok(names.indexOf("enqueue") < names.indexOf("classify_activity_cloud"));
});

test("hidden participant projection segments never enter a paid summary input", async () => {
  const detail = sessionDetail();
  detail.segments = [
    ...detail.segments.map((segment) => ({ ...segment, projection_state: "visible" })),
    {
      id: "seg-media-hidden",
      started_at: 3,
      ended_at: 4,
      version: 1,
      person_id: null,
      text: "game commentary that must stay out of the personal summary",
      result_kind: "final",
      is_stable: 1,
      superseded_by: null,
      duplicate_of: null,
      projection_state: "audit_hidden",
    },
  ];
  const { scheduler, events } = harness({ sessionDetail: detail });

  const status = await scheduler.analyzeSession("s1", "final", { manual: true });

  assert.equal(status.state, "queued");
  assert.deepEqual(events.find(([name]) => name === "prepare")[1].segmentIds, ["seg-final"]);
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
  assert.deepEqual(events.find(([name]) => name === "build")[1], {
    strategy: "hierarchical",
  });
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

test("an adopted classification present before analysis is part of the durable desired head", async () => {
  const { scheduler, events } = harness({
    activityClassification: true,
    activityClassifications: [{ id: "classification-adopted", decision: "adopted" }],
    activityClassificationRevision: ADOPTED_ACTIVITY_REVISION,
  });

  await scheduler.analyzeSession("s1", "final");

  assert.equal(events.filter(([name]) => name === "classify_activity_local").length, 0);
  assert.equal(events.filter(([name]) => name === "classify_activity_cloud").length, 0);
  assert.equal(
    events.find(([name]) => name === "set_head")[1].activityClassificationRevision,
    ADOPTED_ACTIVITY_REVISION
  );
});

test("classification completing after analysis recommends a paid refresh without another cloud job", async () => {
  let releaseClassification;
  const classification = new Promise((resolve) => {
    releaseClassification = resolve;
  });
  const { scheduler, events } = harness({
    activityClassification: true,
    activityClassificationRevision: EMPTY_ACTIVITY_REVISION,
    classifyActivity: () => classification,
  });

  const first = await scheduler.analyzeSession("s1", "final");
  assert.equal(first.state, "queued");
  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
    summary: { summary: "keep the paid result" },
  });

  releaseClassification({
    classifications: [{ id: "classification-adopted", decision: "adopted" }],
    activityClassificationRevision: ADOPTED_ACTIVITY_REVISION,
    cloudStatus: "completed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
  assert.equal(events.filter(([name]) => name === "create").length, 1);
  assert.equal(events.filter(([name]) => name === "set_head").length, 1);
  assert.equal(events.filter(([name]) => name === "recommend_summary_refresh").length, 1);
});

test("an adopted user correction stays local until an explicit paid refresh", async () => {
  const { scheduler, events, setActivityClassificationState } = harness({
    activityClassification: true,
    activityClassifications: [{ id: "classification-original", decision: "adopted" }],
    activityClassificationRevision: ADOPTED_ACTIVITY_REVISION,
  });
  await scheduler.analyzeSession("s1", "final");
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
    summary: { summary: "keep the paid result" },
  });

  const correctedRevision = "9".repeat(64);
  setActivityClassificationState(
    [{ id: "classification-corrected", decision: "adopted" }],
    correctedRevision
  );
  await scheduler.refreshAfterActivityClassification("s1");
  scheduler.repository.listSessions = () => [
    { id: "s1", status: "completed", processing_state: "ready" },
  ];
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "ready",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 1,
    updatedAt: 9,
  });
  assert.equal(await scheduler.recoverReadySessions(), 1);
  const automatic = await scheduler.analyzeSession("s1", "final");

  assert.equal(automatic.summaryRefreshRecommended, true);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
  assert.deepEqual(
    events
      .filter(([name]) => name === "set_head")
      .map(([, input]) => input.activityClassificationRevision),
    [ADOPTED_ACTIVITY_REVISION]
  );
  assert.equal(events.filter(([name]) => name === "recommend_summary_refresh").length, 3);

  const paid = await scheduler.analyzeSession("s1", "final", { manual: true });

  assert.equal(paid.state, "queued");
  assert.equal(events.filter(([name]) => name === "enqueue").length, 2);
  assert.deepEqual(
    events
      .filter(([name]) => name === "set_head")
      .map(([, input]) => input.activityClassificationRevision),
    [ADOPTED_ACTIVITY_REVISION, correctedRevision]
  );
});

test("only an explicit manual request requeues a blocked analysis job", async () => {
  const { scheduler, events } = harness({ jobState: "blocked" });

  assert.equal((await scheduler.analyzeSession("s1", "final")).state, "queued");
  assert.equal(
    events.some(([name]) => name === "manual_retry"),
    false
  );

  const retried = await scheduler.analyzeSession("s1", "final", {
    manual: true,
    allowUsageUnknown: true,
  });
  assert.equal(retried.state, "queued");
  assert.deepEqual(events.find(([name]) => name === "manual_retry").slice(1), [
    "job-1",
    { allowUsageUnknown: true, at: 10 },
  ]);
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

test("durable participant snapshot revisions cannot reuse a stale analysis identity", async () => {
  const { scheduler, events, setParticipantSnapshot } = harness({
    participantSnapshotRevision: {
      revision: 1,
      sourceHash: "9".repeat(64),
      projectorVersion: "session-participants-v1",
    },
  });

  const baseline = await scheduler.analyzeSession("s1", "final");
  setParticipantSnapshot({
    revision: 2,
    sourceHash: "8".repeat(64),
    projectorVersion: "session-participants-v1",
  });
  const sourceChanged = await scheduler.analyzeSession("s1", "final");
  setParticipantSnapshot({
    revision: 3,
    sourceHash: "8".repeat(64),
    projectorVersion: "session-participants-v2",
  });
  const projectorChanged = await scheduler.analyzeSession("s1", "final");
  setParticipantSnapshot({
    revision: 4,
    sourceHash: "8".repeat(64),
    projectorVersion: "session-participants-v2",
  });
  const revisionOnlyChanged = await scheduler.analyzeSession("s1", "final");

  assert.equal(
    new Set(
      [baseline, sourceChanged, projectorChanged, revisionOnlyChanged].map((status) => status.jobId)
    ).size,
    4
  );
  const creates = events.filter(([name]) => name === "create").map(([, input]) => input);
  assert.equal(new Set(creates.map((input) => input.identityRevision)).size, 4);
  assert.deepEqual(
    creates.map((input) => input.participantSnapshotRevision),
    [
      {
        revision: 1,
        sourceHash: "9".repeat(64),
        projectorVersion: "session-participants-v1",
      },
      {
        revision: 2,
        sourceHash: "8".repeat(64),
        projectorVersion: "session-participants-v1",
      },
      {
        revision: 3,
        sourceHash: "8".repeat(64),
        projectorVersion: "session-participants-v2",
      },
      {
        revision: 4,
        sourceHash: "8".repeat(64),
        projectorVersion: "session-participants-v2",
      },
    ]
  );
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

test("getStatus prefers durable state and uses memory only during synchronous preparation", () => {
  const { scheduler } = harness();
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "retry_needed",
    retryable: true,
    errorCode: "offline",
    nextRetryAt: 20,
    attemptCount: 2,
    updatedAt: null,
  });

  scheduler._setStatus("s1", "blocked", "stale_memory_status");
  assert.deepEqual(scheduler.getStatus("s1"), {
    sessionId: "s1",
    state: "retry_needed",
    retryable: true,
    errorCode: "offline",
    nextRetryAt: 20,
    attemptCount: 2,
    updatedAt: null,
  });

  scheduler._setStatus("s1", "preparing");
  assert.deepEqual(scheduler.getStatus("s1"), {
    sessionId: "s1",
    state: "preparing",
    errorCode: null,
    updatedAt: 10,
  });
});

test("startup recovery schedules one newest ready session that never received durable analysis work", async () => {
  const { scheduler, events } = harness();
  scheduler.repository.listSessions = () => [
    {
      id: "already-summarized",
      status: "completed",
      processing_state: "ready",
    },
    {
      id: "s1",
      status: "completed",
      processing_state: "ready",
    },
    {
      id: "older-missed",
      status: "completed",
      processing_state: "ready",
    },
  ];
  scheduler.repository.getSessionDetail = (sessionId) => {
    if (sessionId === "already-summarized") {
      return { ...sessionDetail(), summary: { summary: "already durable" } };
    }
    return sessionDetail();
  };
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "waiting",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 0,
    updatedAt: null,
  });

  assert.equal(await scheduler.recoverReadySessions(), 1);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
  assert.equal(events.find(([name]) => name === "enqueue")[1].sessionId, "s1");
});

test("startup recovery does not duplicate a ready session with durable analysis work", async () => {
  const { scheduler, events } = harness();
  scheduler.repository.listSessions = () => [
    {
      id: "s1",
      status: "completed",
      processing_state: "ready",
    },
  ];
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "queued",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 0,
    updatedAt: 9,
  });

  assert.equal(await scheduler.recoverReadySessions(), 0);
  assert.equal(events.length, 0);
});

test("startup cloud recovery skips active historical local-only reprocessing", async () => {
  const { scheduler, events } = harness();
  scheduler.repository.listSessions = () => [
    { id: "historical", status: "completed", processing_state: "ready" },
    { id: "normal", status: "completed", processing_state: "ready" },
  ];
  scheduler.repository.isHistoricalLocalOnlyReprocessing = (sessionId) =>
    sessionId === "historical";
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "waiting",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 0,
    updatedAt: null,
  });

  assert.equal(await scheduler.recoverReadySessions(), 1);
  assert.equal(events.find(([name]) => name === "enqueue")[1].sessionId, "normal");
});

test("startup recovery backfills local classification and only recommends summary refresh", async () => {
  const { scheduler, events } = harness({
    jobState: "completed",
    activityClassification: true,
  });
  scheduler.repository.listSessions = () => [
    {
      id: "s1",
      status: "completed",
      processing_state: "ready",
    },
  ];
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
    summary: { summary: "already durable" },
  });
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "ready",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 1,
    updatedAt: 9,
  });

  assert.equal(await scheduler.recoverReadySessions(), 1);
  await scheduler.quiesce();
  assert.equal(events.filter(([name]) => name === "enqueue").length, 0);
  assert.equal(events.filter(([name]) => name === "classify_activity_local").length, 1);
  assert.equal(events.filter(([name]) => name === "classify_activity_cloud").length, 0);
  assert.equal(events.filter(([name]) => name === "recommend_summary_refresh").length, 1);
});

test("startup recovery never replaces a paid head for a newer classification revision", async () => {
  const { scheduler, events } = harness({
    jobState: "completed",
    activityClassification: true,
    activityClassifications: [{ id: "classification-adopted", decision: "adopted" }],
    activityClassificationRevision: ADOPTED_ACTIVITY_REVISION,
  });
  scheduler.repository.listSessions = () => [
    { id: "s1", status: "completed", processing_state: "ready" },
  ];
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
    summary: { summary: "already durable" },
  });
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "ready",
    retryable: false,
    errorCode: null,
    nextRetryAt: null,
    attemptCount: 1,
    updatedAt: 9,
  });
  scheduler.memoryRepository.getAnalysisDesiredHead = () => ({
    activityClassificationRevision: EMPTY_ACTIVITY_REVISION,
  });

  assert.equal(await scheduler.recoverReadySessions(), 1);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 0);
  assert.equal(events.filter(([name]) => name === "classify_activity_local").length, 0);
  assert.equal(events.filter(([name]) => name === "classify_activity_cloud").length, 0);
  assert.equal(events.filter(([name]) => name === "recommend_summary_refresh").length, 1);
});

test("startup recovery recreates a genuinely missing initial cloud job", async () => {
  const { scheduler, events, failNextEnqueue } = harness();
  failNextEnqueue();
  assert.throws(
    () => scheduler.analyzeSession("s1", "final"),
    (error) => error?.code === "analysis_runtime_not_ready"
  );

  scheduler.repository.listSessions = () => [
    { id: "s1", status: "completed", processing_state: "ready" },
  ];
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
  });
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "retry_needed",
    retryable: true,
    errorCode: "analysis_runtime_not_ready",
    nextRetryAt: null,
    attemptCount: 0,
    updatedAt: 10,
  });

  assert.equal(await scheduler.recoverReadySessions(), 1);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 2);
});

test("startup missing-job recovery does not re-enqueue a normal rate-limit retry", async () => {
  const { scheduler, events } = harness({
    activityClassification: true,
    activityClassifications: [{ id: "classification-adopted", decision: "adopted" }],
    activityClassificationRevision: ADOPTED_ACTIVITY_REVISION,
  });
  await scheduler.analyzeSession("s1", "final");
  scheduler.repository.listSessions = () => [
    { id: "s1", status: "completed", processing_state: "ready" },
  ];
  scheduler.repository.getSessionDetail = () => ({
    ...sessionDetail(),
    summary: { summary: "already durable" },
  });
  scheduler.memoryRepository.getAnalysisWorkState = () => ({
    state: "retry_needed",
    retryable: true,
    errorCode: "rate_limit",
    nextRetryAt: 100,
    attemptCount: 1,
    updatedAt: 10,
  });

  assert.equal(await scheduler.recoverReadySessions(), 0);
  assert.equal(events.filter(([name]) => name === "enqueue").length, 1);
});
