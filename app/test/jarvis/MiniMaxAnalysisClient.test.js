const test = require("node:test");
const assert = require("node:assert/strict");

const MiniMaxAnalysisClient = require("../../src/jarvis/main/MiniMaxAnalysisClient");
const { AnalysisClientError } = MiniMaxAnalysisClient;

test("allows long MiniMax reasoning responses while keeping a finite timeout", () => {
  assert.equal(MiniMaxAnalysisClient.DEFAULT_TIMEOUT_MS, 240_000);
});

function candidate(overrides = {}) {
  return {
    schemaVersion: "jarvis-analysis-v2",
    sessionSummary: {
      title: "Delivery",
      summary: "Delivery scope was agreed.",
      evidenceSegmentIds: ["seg-1"],
    },
    memories: [],
    topics: [],
    todos: [],
    suggestions: [],
    ...overrides,
  };
}

function analysisInput(overrides = {}) {
  return {
    cloudPayloadJson: JSON.stringify({
      inputVersion: "jarvis-analysis-input-v2",
      segments: [
        { segmentId: "seg-1", startedAt: 1, endedAt: 2, speakerLabel: "SELF", text: "交付" },
      ],
      omittedRanges: [],
    }),
    inputHash: "a".repeat(64),
    allowedSegmentIds: ["seg-1"],
    allowedOwnerLabels: ["SELF"],
    ...overrides,
  };
}

function envelope(message, overrides = {}) {
  return JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    ...overrides,
  });
}

function toolMessage(value = candidate(), overrides = {}) {
  return {
    content: null,
    tool_calls: [
      {
        type: "function",
        function: { name: "submit_jarvis_analysis", arguments: JSON.stringify(value) },
      },
    ],
    ...overrides,
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function expectClientError(code, retryable, issueCode = undefined) {
  return (error) => {
    assert.ok(error instanceof AnalysisClientError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(error.message, "MiniMax analysis request failed");
    assert.equal(error.issueCode, issueCode);
    assert.equal("cause" in error, false);
    assert.equal("stack" in JSON.parse(JSON.stringify(error)), false);
    return true;
  };
}

test("accepts documented MiniMax reasoning content beside a valid tool call", async () => {
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      response(
        envelope(
          toolMessage(candidate(), {
            content: "<think>private reasoning stays out of the result</think>",
          })
        )
      ),
    getApiKey: () => "unit-test-key",
  });

  assert.deepEqual((await client.analyze(analysisInput())).result, candidate());
});

test("accepts MiniMax tool-call compatibility fields, direct object, or JSON fence", async () => {
  const messages = [
    toolMessage(candidate(), {
      content: [{ type: "text", text: "separated reasoning metadata" }],
      function_call: null,
    }),
    {
      content: null,
      tool_calls: [],
      function_call: {
        name: "submit_jarvis_analysis",
        arguments: JSON.stringify(candidate()),
      },
    },
    { content: JSON.stringify(candidate()) },
    { content: `\n\`\`\`JSON\n${JSON.stringify(candidate())}\n\`\`\`\n` },
  ];
  let index = 0;
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () => response(envelope(messages[index++])),
    getApiKey: () => "unit-test-key",
    createRequestId: () => `request-${index}`,
  });

  for (let attempt = 0; attempt < messages.length; attempt += 1) {
    const result = await client.analyze(analysisInput());
    assert.deepEqual(result.result, candidate());
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
    assert.equal(result.model, "MiniMax-M2.7");
  }
  assert.equal(index, messages.length);
});

test("rejects ambiguous envelopes arrays primitives prose and malformed tool content", async () => {
  const invalidBodies = [
    [JSON.stringify({ choices: [] }), "envelope.choices_count"],
    [
      JSON.stringify({ choices: [{ message: {} }, { message: {} }] }),
      "envelope.choices_count",
    ],
    [
      envelope({
        ...toolMessage(),
        tool_calls: [...toolMessage().tool_calls, ...toolMessage().tool_calls],
      }),
      "envelope.tool_calls_count",
    ],
    [
      envelope({
        ...toolMessage(),
        function_call: {
          name: "submit_jarvis_analysis",
          arguments: JSON.stringify(candidate()),
        },
      }),
      "envelope.conflicting_function_call",
    ],
    [
      envelope({ content: `${JSON.stringify(candidate())}\ntrailing prose` }),
      "envelope.content.shape",
    ],
    [
      envelope({ content: `${JSON.stringify(candidate())}${JSON.stringify(candidate())}` }),
      "envelope.content.ambiguous",
    ],
    [envelope({ content: "```json\n{}\n```\n```json\n{}\n```" }), "envelope.content_fence"],
    [envelope({ content: "[]" }), "envelope.content.shape"],
    [envelope({ content: "1" }), "envelope.content.shape"],
    [envelope({ content: null, function_call: { name: "other", arguments: "{}" } }), "envelope.legacy_function_call_shape"],
  ];
  let calls = 0;
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () => response(invalidBodies[calls++][0]),
    getApiKey: () => "unit-test-key",
  });
  for (const [, issueCode] of invalidBodies) {
    await assert.rejects(
      client.analyze(analysisInput()),
      expectClientError("invalid_structure", false, issueCode)
    );
  }
  assert.equal(calls, invalidBodies.length);
});

test("strict schema failures make one request and never upload a repair", async () => {
  const requests = [];
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response(envelope(toolMessage(candidate({ todos: { items: [] } }))));
    },
    getApiKey: () => "unit-test-key",
  });

  await assert.rejects(
    client.analyze(analysisInput()),
    expectClientError("invalid_structure", false, "schema.collection_type.todos")
  );
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /repair|invalidAnalysis/i);
});

test("preserves authoritative usage when MiniMax returns an invalid candidate", async () => {
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      response(envelope(toolMessage(candidate({ todos: { items: [] } })))),
    getApiKey: () => "unit-test-key",
  });

  await assert.rejects(client.analyze(analysisInput()), (error) => {
    assert.ok(expectClientError("invalid_structure", false, "schema.collection_type.todos")(error));
    assert.deepEqual(error.authoritativeUsage, { inputTokens: 10, outputTokens: 20 });
    return true;
  });
});

test("rejects missing usage instead of treating it as authoritative zero", async () => {
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      response(
        JSON.stringify({
          choices: [{ message: toolMessage() }],
        })
      ),
    getApiKey: () => "unit-test-key",
  });

  await assert.rejects(client.analyze(analysisInput()), expectClientError("usage_unknown", false));
});

test("uses only the official HTTPS endpoint and privacy-preserving fetch options", async () => {
  let captured;
  const client = new MiniMaxAnalysisClient({
    baseUrl: "https://api.minimax.io/v1",
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return response(envelope(toolMessage()));
    },
    getApiKey: () => "unit-test-key",
  });
  await client.analyze(analysisInput());

  assert.equal(captured.url, "https://api.minimax.io/v1/chat/completions");
  assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.useSessionCookies, false);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.tools[0].function.name, "submit_jarvis_analysis");
  assert.equal(captured.body.tool_choice.function.name, "submit_jarvis_analysis");
  assert.equal(captured.body.reasoning_split, true);
  assert.equal(captured.body.temperature, 0.1);
  assert.equal(captured.body.max_completion_tokens, 8192);
  assert.equal(captured.body.messages[1].content, analysisInput().cloudPayloadJson);
  assert.equal("allowedSegmentIds" in captured.body, false);

  for (const baseUrl of [
    "http://api.minimaxi.com/v1",
    "https://evil.example/v1",
    "https://api.minimaxi.com:444/v1",
    "https://user@api.minimaxi.com/v1",
    "https://api.minimaxi.com/v1?redirect=evil",
    "https://api.minimaxi.com/v1#fragment",
    "https://api.minimaxi.com/v2",
  ]) {
    assert.throws(
      () => new MiniMaxAnalysisClient({ baseUrl, fetchImpl: async () => {}, getApiKey: () => "x" }),
      expectClientError("configuration", false)
    );
  }
});

test("rejects an oversized serialized request before reading the key or fetching", async () => {
  let keyReads = 0;
  let fetches = 0;
  const client = new MiniMaxAnalysisClient({
    maxRequestBytes: 256,
    fetchImpl: async () => {
      fetches += 1;
      return response(envelope(toolMessage()));
    },
    getApiKey: () => {
      keyReads += 1;
      return "unit-test-key";
    },
  });
  await assert.rejects(
    client.analyze(
      analysisInput({
        cloudPayloadJson: JSON.stringify({
          inputVersion: "jarvis-analysis-input-v2",
          segments: [
            {
              segmentId: "seg-1",
              startedAt: 1,
              endedAt: 2,
              speakerLabel: "SELF",
              text: "大".repeat(1_000),
            },
          ],
          omittedRanges: [],
        }),
      })
    ),
    expectClientError("request_too_large", false)
  );
  assert.equal(keyReads, 0);
  assert.equal(fetches, 0);
});

test("counts streamed response bytes and cancels immediately on overflow", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  let chunkIndex = 0;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(`${chunkIndex++}`.repeat(40)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new MiniMaxAnalysisClient({
    maxResponseBytes: 64,
    fetchImpl: async () => new Response(stream, { status: 200 }),
    getApiKey: () => "unit-test-key",
  });
  await assert.rejects(
    client.analyze(analysisInput()),
    expectClientError("response_too_large", false)
  );
  assert.equal(cancelled, true);
});

test("enforces the response byte limit at the adjacent byte boundary", async () => {
  const body = envelope(toolMessage());
  const bytes = Buffer.byteLength(body, "utf8");
  const passing = new MiniMaxAnalysisClient({
    maxResponseBytes: bytes,
    fetchImpl: async () => response(body),
    getApiKey: () => "unit-test-key",
  });
  assert.deepEqual((await passing.analyze(analysisInput())).result, candidate());

  const failing = new MiniMaxAnalysisClient({
    maxResponseBytes: bytes - 1,
    fetchImpl: async () => response(body),
    getApiKey: () => "unit-test-key",
  });
  await assert.rejects(
    failing.analyze(analysisInput()),
    expectClientError("response_too_large", false)
  );
});

test("maps transport and HTTP failures to closed retryability", async () => {
  const cases = [
    [{ name: "AbortError" }, "network", true],
    [response("", 408), "network", true],
    [response("", 401), "configuration", false],
    [response("", 403), "configuration", false],
    [response("", 429), "rate_limit", true],
    [response("", 500), "service_unavailable", true],
    [response("", 400), "request_rejected", false],
  ];
  for (const [outcome, code, retryable] of cases) {
    const client = new MiniMaxAnalysisClient({
      fetchImpl: async () => {
        if (outcome instanceof Response) return outcome;
        throw outcome;
      },
      getApiKey: () => "unit-test-key",
    });
    await assert.rejects(client.analyze(analysisInput()), expectClientError(code, retryable));
  }
});

test("maps response body timeout and disconnect to retryable network failures", async () => {
  const disconnected = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error("private stream failure");
          },
        }),
        { status: 200 }
      ),
    getApiKey: () => "unit-test-key",
  });
  await assert.rejects(disconnected.analyze(analysisInput()), expectClientError("network", true));

  const timedOut = new MiniMaxAnalysisClient({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("private timeout")), {
                once: true,
              });
            }),
          cancel: async () => {},
        }),
      },
    }),
    getApiKey: () => "unit-test-key",
  });
  await assert.rejects(timedOut.analyze(analysisInput()), expectClientError("network", true));
});

test("cancels every non-success response body before returning a typed HTTP failure", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("private service response"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () => new Response(body, { status: 503 }),
    getApiKey: () => "unit-test-key",
  });

  await assert.rejects(
    client.analyze(analysisInput()),
    expectClientError("service_unavailable", true)
  );
  assert.equal(cancelled, true);
});

test("logs only the exact privacy allowlist on success and validation failure", async () => {
  const logs = [];
  const forbidden = {
    key: "unit-test-key",
    transcript: "private transcript poison",
    person: "private person poison",
    map: "private map poison",
    header: "private header poison",
    cause: "private cause poison",
  };
  let valid = true;
  const client = new MiniMaxAnalysisClient({
    fetchImpl: async () =>
      response(
        envelope(
          toolMessage(valid ? candidate() : candidate({ todos: { poison: forbidden.person } }))
        )
      ),
    getApiKey: () => forbidden.key,
    logger: (record) => logs.push(record),
    createRequestId: () => "request-safe",
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
  });
  await client.analyze(analysisInput());
  valid = false;
  await assert.rejects(client.analyze(analysisInput()));

  const allowed = new Set([
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
  assert.equal(logs.length, 2);
  for (const record of logs) {
    assert.ok(Object.keys(record).every((key) => allowed.has(key)));
  }
  assert.deepEqual(logs[0], {
    requestId: "request-safe",
    inputHash: "a".repeat(64),
    requestBytes: logs[0].requestBytes,
    responseBytes: logs[0].responseBytes,
    durationMs: 1,
    model: "MiniMax-M2.7",
    inputTokens: 10,
    outputTokens: 20,
  });
  assert.equal(logs[1].errorCode, "invalid_structure");
  assert.equal(logs[1].validatorIssueCode, "schema.collection_type.todos");
  const serializedLogs = JSON.stringify(logs);
  for (const value of Object.values(forbidden)) assert.equal(serializedLogs.includes(value), false);
  assert.equal(serializedLogs.includes(analysisInput().cloudPayloadJson), false);
});
