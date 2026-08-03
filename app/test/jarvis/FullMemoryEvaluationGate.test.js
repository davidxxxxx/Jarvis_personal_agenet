"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const MiniMaxAnalysisClient = require("../../src/jarvis/main/MiniMaxAnalysisClient");
const {
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_TOOL,
  validateCandidateAnalysis,
} = require("../../src/jarvis/main/JarvisAnalysisSchema");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const fixtureRoot = path.join(__dirname, "fixtures", "full-memory-eval");
const rubricPath = path.join(repoRoot, "docs", "evaluation", "JARVIS_FULL_MEMORY_RUBRIC.md");
const expectedCoverage = new Set([
  "chinese",
  "english",
  "mixed-language",
  "repeated-topic",
  "ambiguous-owner",
  "missing-due-date",
  "correction",
  "conflicting-claims",
  "empty-noisy",
  "malformed-json",
  "unknown-evidence-id",
  "duplicate-retry",
]);
const outputCollections = ["memories", "topics", "todos"];
const logAllowlist = new Set([
  "requestId",
  "inputHash",
  "requestBytes",
  "responseBytes",
  "durationMs",
  "model",
  "inputTokens",
  "outputTokens",
  "estimatedCostMicrousd",
  "errorCode",
  "validatorIssueCode",
]);
const forbiddenLifecycleKeys = new Set([
  "status",
  "completed",
  "completedAt",
  "completionState",
  "markCompleted",
]);

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
}

function loadFixtures() {
  const entries = fs.readdirSync(fixtureRoot, { withFileTypes: true });
  assert.equal(entries.length, 12, "the tracked corpus contains exactly 12 fixtures");
  assert.ok(entries.every((entry) => entry.isFile() && entry.name.endsWith(".json")));
  return entries
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(fixtureRoot, name), "utf8");
      return { name, text, fixture: JSON.parse(text) };
    });
}

function assertAnonymousAndSecretFree(value, label) {
  const forbiddenKey =
    /^(?:apiKey|authorization|password|secret|realName|displayName|speakerName|audio|rawAudio|audioBytes|audioUri|audioFile|audioPath|localPath|filePath|voiceprint|embedding)$/iu;
  const forbiddenText = [
    /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/u,
    /(?:^|[^\\])\\\\[^\\]/u,
    /\/(?:Users|home|private|tmp|var)\//iu,
    /\.(?:wav|mp3|m4a|flac|ogg|opus|pcm)(?:\b|$)/iu,
    /\bBearer\s+\S+/iu,
    /\bsk-(?:cp-)?[A-Za-z0-9_-]{8,}\b/u,
    /\b(?:api[_-]?key|authorization|password|secret)\s*[:=]/iu,
    /\b[A-Z][a-z]{1,30}\s+[A-Z][a-z]{1,30}\b/u,
    /\b(?:Alice|Bob|Carol|David|Jane|John|Michael|Sarah)\b/iu,
    /(?:张伟|王芳|李娜|刘洋|陈静|杨磊)/u,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  ];

  const visit = (current, currentLabel) => {
    if (typeof current === "string") {
      for (const pattern of forbiddenText) {
        assert.doesNotMatch(current, pattern, `${currentLabel} contains sensitive text`);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentLabel}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, item] of Object.entries(current)) {
      assert.doesNotMatch(key, forbiddenKey, `${currentLabel}.${key} is a forbidden field`);
      visit(item, `${currentLabel}.${key}`);
    }
  };
  visit(value, label);
}

function modelEnvelope(modelArguments) {
  const argumentsText =
    typeof modelArguments === "string" ? modelArguments : JSON.stringify(modelArguments);
  return JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: { name: "submit_jarvis_analysis", arguments: argumentsText },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
}

async function evaluateAttempt(fixture, attempt) {
  let fetchCount = 0;
  const runtimeLogs = [];
  const cloudPayloadJson = JSON.stringify(fixture.request.cloudPayload);
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      const requestBody = JSON.parse(options.body);
      assert.equal(requestBody.messages[1].content, cloudPayloadJson);
      return new Response(modelEnvelope(attempt.modelArguments), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    getApiKey: () => "x",
    logger: (record) => runtimeLogs.push(record),
    createRequestId: () => attempt.attemptId,
    now: (() => {
      let tick = 1_000;
      return () => tick++;
    })(),
  });
  const input = {
    cloudPayloadJson,
    inputHash: fixture.request.inputHash,
    allowedSegmentIds: fixture.request.allowedSegmentIds,
    allowedOwnerLabels: fixture.request.allowedOwnerLabels,
    allowedLearningGoalIds: fixture.request.allowedLearningGoalIds,
  };

  try {
    const response = await client.analyze(input);
    return {
      disposition: "accepted",
      result: response.result,
      errorCode: null,
      fetchCount,
      runtimeLogs,
    };
  } catch (error) {
    return {
      disposition: "rejected",
      result: null,
      errorCode: error.code,
      issueCode: error.issueCode,
      fetchCount,
      runtimeLogs,
    };
  }
}

async function evaluateCorpus(fixtures) {
  const evaluations = [];
  for (const { fixture } of fixtures) {
    for (const attempt of fixture.attempts) {
      evaluations.push({ fixture, attempt, ...(await evaluateAttempt(fixture, attempt)) });
    }
  }
  return evaluations;
}

function allEvidenceIds(result) {
  return [
    ...result.sessionSummary.evidenceSegmentIds,
    ...result.memories.flatMap((item) => item.evidenceSegmentIds),
    ...result.topics.flatMap((item) => item.evidenceSegmentIds),
    ...result.todos.flatMap((item) => [
      ...item.evidenceSegmentIds,
      ...item.assignmentSegmentIds,
      ...item.acceptanceSegmentIds,
    ]),
    ...result.suggestions.flatMap((item) => item.basedOnEvidenceSegmentIds),
  ];
}

test("tracked Full Memory corpus has exactly 12 anonymous v3 fixtures with complete coverage", () => {
  const fixtures = loadFixtures();
  const actualCoverage = new Set();
  const ids = new Set();

  for (const { name, fixture } of fixtures) {
    exactKeys(
      fixture,
      ["fixtureVersion", "id", "coverage", "sessionId", "request", "attempts", "logs", "rendered"],
      name
    );
    assert.equal(fixture.fixtureVersion, 1);
    assert.match(fixture.id, /^fm-[0-9]{2}-[a-z0-9-]+$/u);
    assert.equal(name, `${fixture.id}.json`);
    assert.match(fixture.sessionId, /^session-fm-[0-9]{2}$/u);
    assert.equal(ids.has(fixture.id), false, `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    assert.equal(fixture.coverage.length, 1, `${fixture.id} owns one coverage case`);
    actualCoverage.add(fixture.coverage[0]);

    exactKeys(
      fixture.request,
      [
        "inputHash",
        "allowedSegmentIds",
        "allowedOwnerLabels",
        "allowedLearningGoalIds",
        "cloudPayload",
      ],
      `${fixture.id}.request`
    );
    assert.equal(fixture.request.cloudPayload.inputVersion, "jarvis-analysis-input-v3");
    assert.equal(
      fixture.request.inputHash,
      sha256(JSON.stringify(fixture.request.cloudPayload)),
      `${fixture.id} input hash`
    );
    assert.ok(fixture.attempts.length > 0, `${fixture.id} has an evaluation attempt`);
    assert.equal(fixture.logs.length, fixture.attempts.length, `${fixture.id} logs every attempt`);
    for (const attempt of fixture.attempts) {
      exactKeys(
        attempt,
        ["attemptId", "expectedDisposition", "expectedErrorCode", "modelArguments"],
        `${fixture.id}.${attempt.attemptId}`
      );
      assert.match(attempt.attemptId, /^attempt-fm-[0-9]{2}-[0-9]+$/u);
      assert.ok(new Set(["accepted", "rejected"]).has(attempt.expectedDisposition));
      assert.equal(
        attempt.expectedErrorCode === null,
        attempt.expectedDisposition === "accepted",
        `${fixture.id}.${attempt.attemptId} error contract`
      );
    }
    exactKeys(fixture.rendered, outputCollections, `${fixture.id}.rendered`);
  }

  assert.deepEqual(actualCoverage, expectedCoverage);
});

test("fixture contents substantively exercise each declared edge case", () => {
  const byCoverage = new Map(loadFixtures().map(({ fixture }) => [fixture.coverage[0], fixture]));
  const requestText = (coverage) => {
    return byCoverage
      .get(coverage)
      .request.cloudPayload.segments.map((segment) => segment.text)
      .join(" ");
  };
  const acceptedOutput = (coverage) => {
    const fixture = byCoverage.get(coverage);
    return fixture.attempts.find((attempt) => attempt.expectedDisposition === "accepted")
      ?.modelArguments;
  };

  assert.match(requestText("chinese"), /[\u3400-\u9fff]/u);
  assert.doesNotMatch(requestText("english"), /[^\u0000-\u007f]/u);
  assert.match(requestText("mixed-language"), /[\u3400-\u9fff]/u);
  assert.match(requestText("mixed-language"), /[A-Za-z]/u);
  assert.equal(requestText("repeated-topic").match(/sync strategy/giu)?.length, 2);
  assert.deepEqual(acceptedOutput("ambiguous-owner").todos, []);
  assert.ok(acceptedOutput("missing-due-date").todos.some((todo) => todo.dueText === null));
  assert.match(requestText("correction"), /correction/iu);
  assert.equal(acceptedOutput("correction").memories[0].evidenceSegmentIds.length, 2);
  assert.ok(acceptedOutput("conflicting-claims").memories[0].confidence < 0.8);
  assert.equal(acceptedOutput("conflicting-claims").memories[0].evidenceSegmentIds.length, 2);
  assert.match(requestText("empty-noisy"), /\[(?:NOISE|NO_SPEECH)\]/u);
  for (const collection of [...outputCollections, "suggestions"]) {
    assert.deepEqual(acceptedOutput("empty-noisy")[collection], []);
  }

  const malformed = byCoverage.get("malformed-json");
  assert.equal(malformed.attempts[0].expectedDisposition, "rejected");
  assert.throws(() => JSON.parse(malformed.attempts[0].modelArguments), SyntaxError);
  const unknown = byCoverage.get("unknown-evidence-id");
  assert.equal(unknown.attempts[0].expectedDisposition, "rejected");
  assert.ok(
    unknown.attempts[0].modelArguments.sessionSummary.evidenceSegmentIds.some(
      (segmentId) => !unknown.request.allowedSegmentIds.includes(segmentId)
    )
  );
  const duplicate = byCoverage.get("duplicate-retry");
  assert.equal(duplicate.attempts.length, 2);
  assert.deepEqual(duplicate.attempts[0].modelArguments, duplicate.attempts[1].modelArguments);
});

test("request and log fixtures contain only pseudonymous text and safe diagnostic fields", () => {
  for (const { fixture } of loadFixtures()) {
    assertAnonymousAndSecretFree(fixture.request, `${fixture.id}.request`);
    assertAnonymousAndSecretFree(fixture.logs, `${fixture.id}.logs`);
    assert.ok(fixture.logs.length > 0, `${fixture.id} has a log fixture`);
    for (const [index, record] of fixture.logs.entries()) {
      assert.ok(
        Object.keys(record).every((key) => logAllowlist.has(key)),
        `${fixture.id}.logs[${index}] uses the production allowlist`
      );
      assert.equal(record.inputHash, fixture.request.inputHash);
      assert.match(record.requestId, /^request-fm-[0-9]{2}(?:-[0-9]+)?$/u);
    }
    for (const segment of fixture.request.cloudPayload.segments) {
      assert.match(segment.speakerLabel, /^(?:SELF|P[1-9][0-9]*)$/u);
    }
  }
});

test("runtime accepts or rejects every fixture as declared without making a network request", async () => {
  const fixtures = loadFixtures();
  const evaluations = await evaluateCorpus(fixtures);
  for (const evaluation of evaluations) {
    assert.equal(
      evaluation.disposition,
      evaluation.attempt.expectedDisposition,
      `${evaluation.fixture.id}/${evaluation.attempt.attemptId} disposition`
    );
    assert.equal(
      evaluation.errorCode,
      evaluation.attempt.expectedErrorCode,
      `${evaluation.fixture.id}/${evaluation.attempt.attemptId} error`
    );
    assert.equal(evaluation.fetchCount, 1, "the injected in-memory transport handled the request");
    assert.equal(evaluation.runtimeLogs.length, 1);
  }
});

test("all accepted outputs pass v3 schema, evidence scope, and identical-hash idempotency gates", async () => {
  const fixtures = loadFixtures();
  const evaluations = await evaluateCorpus(fixtures);
  const accepted = evaluations.filter((evaluation) => evaluation.disposition === "accepted");
  const declaredAccepted = evaluations.filter(
    (evaluation) => evaluation.attempt.expectedDisposition === "accepted"
  );
  assert.equal(
    accepted.length,
    declaredAccepted.length,
    "100% of declared accepted output survived"
  );

  const acceptedByHash = new Map();
  for (const evaluation of accepted) {
    const { fixture, result } = evaluation;
    assert.equal(result.schemaVersion, ANALYSIS_SCHEMA_VERSION);
    const context = {
      allowedSegmentIds: new Set(fixture.request.allowedSegmentIds),
      allowedOwnerLabels: new Set(fixture.request.allowedOwnerLabels),
      allowedLearningGoalIds: new Set(fixture.request.allowedLearningGoalIds),
    };
    assert.deepEqual(validateCandidateAnalysis(result, context), result);
    const allowed = context.allowedSegmentIds;
    assert.ok(allEvidenceIds(result).every((segmentId) => allowed.has(segmentId)));

    const serialized = JSON.stringify(result);
    const previous = acceptedByHash.get(fixture.request.inputHash);
    if (previous !== undefined)
      assert.equal(serialized, previous, "identical hashes are idempotent");
    acceptedByHash.set(fixture.request.inputHash, serialized);
  }

  const repeatedHashes = [...acceptedByHash].filter(([inputHash]) => {
    return accepted.filter((entry) => entry.fixture.request.inputHash === inputHash).length > 1;
  });
  assert.equal(repeatedHashes.length, 1, "the corpus exercises one duplicate retry hash");
});

test("the current v3 AI schema has no todo-completion path", async () => {
  const todoSchema = ANALYSIS_TOOL.function.parameters.properties.todos.items;
  const expectedTodoFields = new Set([
    "title",
    "ownerLabel",
    "dueText",
    "semanticConfidence",
    "evidenceSegmentIds",
    "actionKind",
    "assignmentSegmentIds",
    "acceptanceSegmentIds",
  ]);
  assert.deepEqual(new Set(Object.keys(todoSchema.properties)), expectedTodoFields);
  assert.ok([...forbiddenLifecycleKeys].every((key) => !(key in todoSchema.properties)));

  const evaluations = await evaluateCorpus(loadFixtures());
  for (const { result } of evaluations.filter((entry) => entry.disposition === "accepted")) {
    for (const todo of result.todos) {
      assert.ok(Object.keys(todo).every((key) => !forbiddenLifecycleKeys.has(key)));
    }
  }
});

test("every rendered memory, topic, and todo has navigable session and segment evidence", async () => {
  const fixtures = loadFixtures();
  const evaluations = await evaluateCorpus(fixtures);
  const totals = Object.fromEntries(outputCollections.map((collection) => [collection, 0]));

  for (const { fixture } of fixtures) {
    const accepted = evaluations.find(
      (entry) => entry.fixture.id === fixture.id && entry.disposition === "accepted"
    );
    const result = accepted?.result ?? { memories: [], topics: [], todos: [] };
    for (const collection of outputCollections) {
      const rendered = fixture.rendered[collection];
      const output = result[collection];
      assert.equal(
        rendered.length,
        output.length,
        `${fixture.id} renders every ${collection} item`
      );
      assert.deepEqual(
        rendered.map((item) => item.outputIndex).sort((left, right) => left - right),
        output.map((_item, index) => index),
        `${fixture.id} has one navigation record per ${collection} item`
      );
      for (const item of rendered) {
        exactKeys(
          item,
          ["outputIndex", "sourceSessionId", "sourceSegmentId"],
          `${fixture.id}.rendered.${collection}`
        );
        assert.equal(item.sourceSessionId, fixture.sessionId);
        assert.ok(
          output[item.outputIndex].evidenceSegmentIds.includes(item.sourceSegmentId),
          `${fixture.id} ${collection} navigation cites output evidence`
        );
        assert.ok(fixture.request.allowedSegmentIds.includes(item.sourceSegmentId));
      }
      totals[collection] += rendered.length;
    }
  }

  assert.ok(outputCollections.every((collection) => totals[collection] > 0));
});

test("the dedicated script and human 1-5 rubric encode the release thresholds", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "app", "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["test:full-memory-eval"],
    "node --test test/jarvis/FullMemoryEvaluationGate.test.js"
  );

  const rubric = fs.readFileSync(rubricPath, "utf8");
  for (const required of [
    "Summary faithfulness",
    "Topic usefulness",
    "Todo precision",
    "Person attribution",
    "Suggestion grounding",
    "Each dimension: >= 3",
    "Average: >= 4",
    "1-5",
  ]) {
    assert.ok(rubric.includes(required), `rubric missing ${required}`);
  }
  for (const coverage of expectedCoverage) {
    assert.ok(rubric.includes(coverage), `rubric is missing fixture row ${coverage}`);
  }
});
