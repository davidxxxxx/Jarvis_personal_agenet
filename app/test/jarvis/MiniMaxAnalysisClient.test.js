const test = require("node:test");
const assert = require("node:assert/strict");
const MiniMaxAnalysisClient = require("../../src/jarvis/main/MiniMaxAnalysisClient");

const result = {
  summary: "讨论了产品交付。",
  topics: [{ title: "产品交付", description: "范围和时间", evidenceSegmentIds: ["seg-1"] }],
  memories: [],
  todos: [],
  decisions: [],
  suggestions: [],
};

test("sends transcript text through a forced MiniMax tool without audio or real names", async () => {
  let request;
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: { name: "submit_jarvis_analysis", arguments: JSON.stringify(result) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    getApiKey: () => "secret-token-plan-key",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7",
  });

  const response = await client.analyze({
    kind: "incremental",
    segments: [{ id: "seg-1", startedAt: 1, endedAt: 2, speakerRef: "person_2", text: "周五交付" }],
  });

  assert.equal(request.url, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer secret-token-plan-key");
  assert.equal(request.body.tool_choice.function.name, "submit_jarvis_analysis");
  assert.match(JSON.stringify(request.body.messages), /周五交付/);
  assert.doesNotMatch(JSON.stringify(request.body), /audio|张三/i);
  assert.deepEqual(response.result, result);
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 20 });
});

test("fails with redacted stable error codes", async () => {
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () => new Response("body containing secret transcript", { status: 429 }),
    getApiKey: () => "secret-token-plan-key",
  });
  await assert.rejects(
    client.analyze({
      kind: "final",
      segments: [{ id: "seg-1", speakerRef: "self", text: "secret transcript" }],
    }),
    (error) => {
      assert.equal(error.code, "MINIMAX_RATE_LIMITED");
      assert.doesNotMatch(error.message, /secret|transcript/i);
      return true;
    }
  );
});

test("normalizes common MiniMax tool argument wrappers before strict validation", async () => {
  const wrapped = {
    ...result,
    topics: null,
    todos: {
      content: "完成验收",
      ownerRef: "self",
      dueDate: null,
      topicRef: null,
      evidenceSegmentIds: ["seg-1"],
    },
    decisions: "按计划上线",
    suggestions: { items: [] },
  };
  let requestBody;
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_jarvis_analysis",
                      arguments: JSON.stringify(wrapped),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    getApiKey: () => "secret-token-plan-key",
  });

  const response = await client.analyze({
    kind: "final",
    segments: [{ id: "seg-1", speakerRef: "self", text: "完成验收，按计划上线" }],
  });

  assert.deepEqual(response.result.topics, []);
  assert.deepEqual(response.result.todos, [wrapped.todos]);
  assert.deepEqual(response.result.decisions, ["按计划上线"]);
  assert.deepEqual(response.result.suggestions, []);
  assert.match(requestBody.messages[0].content, /MUST be JSON arrays/);
});

test("repairs a deeper MiniMax schema mismatch once and validates the repaired tool call", async () => {
  const requests = [];
  const invalid = {
    ...result,
    todos: [{ task: "完成验收", evidenceSegmentIds: "seg-1" }],
  };
  const repaired = {
    ...result,
    todos: [
      {
        content: "完成验收",
        ownerRef: "self",
        dueDate: null,
        topicRef: null,
        evidenceSegmentIds: ["seg-1"],
      },
    ],
  };
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const argumentsValue = requests.length === 1 ? invalid : repaired;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_jarvis_analysis",
                      arguments: JSON.stringify(argumentsValue),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 13 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    getApiKey: () => "secret-token-plan-key",
  });

  const response = await client.analyze({
    kind: "final",
    segments: [{ id: "seg-1", speakerRef: "person_2", text: "完成验收" }],
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /repair/i);
  assert.match(requests[1].messages[1].content, /invalidAnalysis/);
  assert.match(requests[1].messages[1].content, /完成验收/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /audio|张三/i);
  assert.deepEqual(response.result, repaired);
  assert.deepEqual(response.usage, { inputTokens: 22, outputTokens: 26 });
});

test("redacts unrepairable MiniMax analysis shape errors", async () => {
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_jarvis_analysis",
                      arguments: JSON.stringify({ ...result, todos: 42 }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    getApiKey: () => "secret-token-plan-key",
  });

  await assert.rejects(
    client.analyze({
      kind: "final",
      segments: [{ id: "seg-1", speakerRef: "self", text: "private transcript" }],
    }),
    (error) => {
      assert.equal(error.code, "MINIMAX_INVALID_ANALYSIS");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /todos|private|transcript/i);
      return true;
    }
  );
});
