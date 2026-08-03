"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const registerJarvisIpc = require("../../src/jarvis/main/registerJarvisIpc");
const { CHANNELS } = require("../../src/jarvis/shared/contracts");

const NOW = 1_786_200_000_000;
const SESSION_ID = "restart-persistence-session";
const PERSON_ID = "restart-persistence-person";
const MEMORY_TEXT = "张三确认发布前继续使用本地优先的记忆库。";
const TODO_TITLE = "检查个人助手冷重启结果";

function createRepository(databasePath) {
  return new JarvisRepository(databasePath, { now: () => NOW });
}

function activity(index) {
  const startedAt = 10_000 + index * 20_000;
  return {
    activityId: `restart-activity-${index}`,
    startedAt,
    endedAt: startedAt + 10_000,
    applications: ["chrome"],
    sourceAttribution: "application_and_microphone",
    statistics: {
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 2,
    },
  };
}

function localClassification(index) {
  return {
    activityId: `restart-activity-${index}`,
    category: "entertainment",
    confidence: 0.9,
    decision: "adopted",
    source: "local",
    reason: "restart persistence fixture",
    allowSummary: true,
    allowSuggestions: false,
    allowTodos: false,
    evidenceSegmentIds: [],
  };
}

function seedDurablePersonalAgentState(repository) {
  repository.createSession({
    id: SESSION_ID,
    startedAt: 1_000,
    micDeviceId: "physical-microphone",
    captureMode: "mic",
  });
  repository.insertAudioChunk({
    id: "restart-persistence-chunk",
    sessionId: SESSION_ID,
    path: "recordings/restart-persistence-session/chunk.flac",
    startedAt: 2_000,
    endedAt: 8_000,
    durationMs: 6_000,
    sha256: "a".repeat(64),
    expiresAt: NOW + 7 * 24 * 60 * 60 * 1_000,
  });
  repository.backfillLegacyMicChunks({
    sessionId: SESSION_ID,
    deterministicTrackId: "restart-persistence-track",
    chunkIds: ["restart-persistence-chunk"],
    createdAt: 8_100,
  });
  const segment = repository.commitChunkTranscript({
    chunk: repository.getAudioChunk("restart-persistence-chunk"),
    result: {
      text: "张三确认发布前继续使用本地优先的记忆库。",
      confidence: 0.97,
    },
    modelVersion: "restart-fixture-whisper",
    completedAt: 8_200,
  });
  repository.renamePerson({
    personId: PERSON_ID,
    displayName: "张三",
    isSelf: false,
  });
  repository.applyAnalysisResult({
    runId: "restart-persistence-analysis",
    sessionId: SESSION_ID,
    kind: "final",
    inputHash: "restart-persistence-input-v1",
    model: "restart-fixture-analysis",
    windowStart: 1_000,
    windowEnd: 80_000,
    completedAt: 80_100,
    result: {
      summary: "张三确认了个人助手的本地优先发布方案。",
      topics: [
        {
          title: "个人助手发布",
          description: "冷重启持久化验收",
          evidenceSegmentIds: [segment.id],
        },
      ],
      todos: [],
      memories: [
        {
          type: "decision",
          content: MEMORY_TEXT,
          confidence: 0.98,
          personRef: PERSON_ID,
          topicRef: "个人助手发布",
          evidenceSegmentIds: [segment.id],
        },
      ],
      decisions: [],
      suggestions: [],
    },
  });
  repository.memoryRepository.applyKnowledgeAction({
    commandId: "restart-persistence-manual-create",
    type: "manual_create",
    todoId: "restart-persistence-todo",
    title: TODO_TITLE,
    dueText: null,
    at: 80_200,
  });

  let proposedRule = null;
  for (let index = 0; index < 3; index += 1) {
    const [classification] = repository.saveActivityClassificationBatch({
      sessionId: SESSION_ID,
      activities: [activity(index)],
      classifications: [localClassification(index)],
      createdAt: 80_300 + index * 2,
    });
    proposedRule =
      repository.correctActivityClassification({
        classificationId: classification.id,
        category: "learning",
        correctedAt: 80_301 + index * 2,
      }).proposedRule ?? proposedRule;
  }
  assert.ok(proposedRule, "three similar corrections should propose a durable rule");
  repository.decidePersonalizationRule({
    ruleId: proposedRule.id,
    action: "enable",
    at: 80_400,
  });
  repository.setSessionStatus(SESSION_ID, "completed", 90_000);
}

function registerPublicRendererProjection(repository) {
  const handlers = new Map();
  registerJarvisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    repository,
    service: {
      startCapture() {},
      setRetentionMode() {},
      sourceInterrupted() {},
      sourceRestored() {},
      pauseCapture() {},
      resumeCapture() {},
      finishCapture() {},
      failCapture() {},
    },
    speakerCorrectionService: {
      listSessionClusters: () => [],
      confirm: () => null,
      reject: () => null,
      undo: () => null,
      listCorrections: () => [],
      mergePeople: () => null,
    },
    voiceEnrollmentService: {
      getStatus: () => null,
      begin: () => null,
      complete: () => null,
      cancel: () => null,
      cancelOwner: () => 0,
    },
    environmentManager: { getOpenAIKey: () => null },
    now: () => NOW,
  });
  return (channel, ...args) => {
    const handler = handlers.get(channel);
    assert.equal(typeof handler, "function", `missing IPC handler ${channel}`);
    return handler(null, ...args);
  };
}

async function readRendererState(repository) {
  const invoke = registerPublicRendererProjection(repository);
  return {
    session: await invoke(CHANNELS.getSession, SESSION_ID),
    people: await invoke(CHANNELS.listPeopleOverview),
    knowledge: await invoke(CHANNELS.getKnowledgeOverview),
    personalization: await invoke(CHANNELS.getPersonalizationSettings),
  };
}

function assertExpectedPublicState(state) {
  assert.equal(state.session.id, SESSION_ID);
  assert.equal(state.session.status, "completed");
  assert.equal(state.people.filter((person) => person.id === PERSON_ID).length, 1);
  assert.equal(state.knowledge.memories.filter((memory) => memory.body === MEMORY_TEXT).length, 1);
  assert.equal(state.knowledge.todos.filter((todo) => todo.title === TODO_TITLE).length, 1);
  assert.equal(
    state.personalization.rules.filter(
      (rule) => rule.targetValue === "learning" && rule.state === "enabled"
    ).length,
    1
  );
}

test("personal agent state survives a cold restart through renderer public projections", async (t) => {
  const testRoot = path.resolve(__dirname, "../../.tmp-tests/restart-persistence");
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, "run-"));
  const databasePath = path.join(root, "jarvis.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = createRepository(databasePath);
  seedDurablePersonalAgentState(first);
  first.close();

  const restarted = createRepository(databasePath);
  const firstRestartState = await readRendererState(restarted);
  assertExpectedPublicState(firstRestartState);
  assert.equal(restarted.db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(restarted.db.pragma("foreign_key_check"), []);
  restarted.close();

  const restartedAgain = createRepository(databasePath);
  const secondRestartState = await readRendererState(restartedAgain);
  assertExpectedPublicState(secondRestartState);
  assert.deepEqual(secondRestartState, firstRestartState);
  assert.equal(
    restartedAgain.db
      .prepare("SELECT count(*) AS count FROM memory_items_v2 WHERE body = ?")
      .get(MEMORY_TEXT).count,
    1
  );
  assert.equal(
    restartedAgain.db
      .prepare("SELECT count(*) AS count FROM todos_v2 WHERE title = ?")
      .get(TODO_TITLE).count,
    1
  );
  assert.equal(
    restartedAgain.db
      .prepare(
        "SELECT count(*) AS count FROM personalization_rules WHERE target_value = 'learning'"
      )
      .get().count,
    1
  );
  restartedAgain.close();
});
