const test = require("node:test");
const assert = require("node:assert/strict");

const MiniMaxDailyDigestClient = require("../../src/jarvis/main/MiniMaxDailyDigestClient");
const {
  DailyDigestClientError,
} = require("../../src/jarvis/main/MiniMaxDailyDigestClient");

const SOURCE_HASH = "a".repeat(64);
const SUBJECT_REF = "subject-0123456789abcdef";

function cloudPayload() {
  return {
    schemaVersion: "jarvis-daily-digest-input-v1",
    localDate: "2026-07-17",
    timezone: "Asia/Shanghai",
    completeness: "final",
    sections: {
      sessions: [
        {
          sessionRef: "session-0123456789abcdef",
          processingState: "ready",
          timelineVersion: 1,
          readyAt: 2_000,
          segments: [
            {
              segmentId: "segment-1",
              startedAt: 1_000,
              endedAt: 2_000,
              subjectRef: SUBJECT_REF,
              text: "Project launch evidence",
            },
          ],
        },
      ],
      peopleInteractions: [
        {
          subjectRef: SUBJECT_REF,
          sessionRefs: ["session-0123456789abcdef"],
          evidenceSegmentIds: ["segment-1"],
        },
      ],
      topics: [],
      decisions: [],
      commitments: [],
      todosCreated: [],
      todosCompleted: [],
      unresolvedConflicts: [],
      transcriptCoverage: {
        selectedSegmentCount: 1,
        incompleteSegmentCount: 0,
        sessionCount: 1,
        startsAt: 1_000,
        endsAt: 2_000,
      },
    },
  };
}

function clientInput(payload = cloudPayload()) {
  return { cloudPayloadJson: JSON.stringify(payload), inputHash: SOURCE_HASH };
}

function digestCandidate() {
  return {
    schemaVersion: "jarvis-daily-digest-v1",
    sections: {
      today: [{ text: "Reviewed the launch plan.", evidenceSegmentIds: ["segment-1"] }],
      interactions: [
        {
          subjectRef: SUBJECT_REF,
          text: "Aligned on the launch plan.",
          evidenceSegmentIds: ["segment-1"],
        },
      ],
      topicsAndDecisions: [],
      commitmentsAndTodos: [],
      worthRemembering: [],
      tomorrowSuggestions: [
        {
          text: "Review the launch checklist.",
          rationale: "The launch plan was discussed today.",
          evidenceSegmentIds: ["segment-1"],
          allowedActions: ["accept", "dismiss", "convert_to_todo"],
        },
      ],
    },
    processing: {
      completeness: "final",
      missingStages: [],
      transcriptCoverage: { ...cloudPayload().sections.transcriptCoverage },
    },
  };
}

function responseEnvelope(result = digestCandidate(), usage = {}) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              function: {
                name: "submit_jarvis_daily_digest",
                arguments: JSON.stringify(result),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 123, ...usage },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("sends one operation-specific request and returns validated usage and byte accounting", async () => {
  const captured = [];
  const envelope = responseEnvelope();
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "subscription-secret",
    fetchImpl: async (url, options) => {
      captured.push({ url, options });
      return jsonResponse(envelope);
    },
  });

  const result = await client.generate(clientInput());

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(captured[0].options.redirect, "error");
  const requestBody = JSON.parse(captured[0].options.body);
  assert.equal(requestBody.tools[0].function.name, "submit_jarvis_daily_digest");
  assert.equal(requestBody.messages[1].content, clientInput().cloudPayloadJson);
  assert.deepEqual(result, {
    result: digestCandidate(),
    usage: { inputTokens: 321, outputTokens: 123 },
    requestBytes: Buffer.byteLength(captured[0].options.body, "utf8"),
    responseBytes: Buffer.byteLength(JSON.stringify(envelope), "utf8"),
  });
});

function expectClientError(code, retryable = false) {
  return (error) =>
    error instanceof DailyDigestClientError &&
    error.code === code &&
    error.retryable === retryable;
}

test("allows only the two official MiniMax HTTPS v1 origins", () => {
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
      () => new MiniMaxDailyDigestClient({ baseUrl, fetchImpl: async () => {}, getApiKey: () => "x" }),
      expectClientError("configuration")
    );
  }
  assert.doesNotThrow(() => new MiniMaxDailyDigestClient({
    baseUrl: "https://api.minimax.io/v1",
    fetchImpl: async () => {},
    getApiKey: () => "x",
  }));
});

test("fails redirects closed and does not retry inside the client", async () => {
  let calls = 0;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, "error");
      throw new TypeError("redirect blocked");
    },
  });
  await assert.rejects(() => client.generate(clientInput()), expectClientError("network", true));
  assert.equal(calls, 1);
});

test("aborts a timed-out request and marks it retryable", async () => {
  let calls = 0;
  const client = new MiniMaxDailyDigestClient({
    timeoutMs: 10,
    getApiKey: () => "secret",
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  });
  await assert.rejects(() => client.generate(clientInput()), expectClientError("network", true));
  assert.equal(calls, 1);
});

test("enforces the request byte cap before reading credentials or sending", async () => {
  let keyReads = 0;
  let calls = 0;
  const client = new MiniMaxDailyDigestClient({
    maxRequestBytes: 100,
    getApiKey: () => { keyReads += 1; return "secret"; },
    fetchImpl: async () => { calls += 1; return jsonResponse(responseEnvelope()); },
  });
  await assert.rejects(
    () => client.generate(clientInput()),
    expectClientError("request_too_large")
  );
  assert.equal(keyReads, 0);
  assert.equal(calls, 0);
});

test("enforces declared and streamed response byte caps", async () => {
  const declared = new MiniMaxDailyDigestClient({
    maxResponseBytes: 100,
    getApiKey: () => "secret",
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "101" },
    }),
  });
  await assert.rejects(
    () => declared.generate(clientInput()),
    expectClientError("response_too_large")
  );

  let cancelled = false;
  const streamed = new MiniMaxDailyDigestClient({
    maxResponseBytes: 100,
    getApiKey: () => "secret",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
      },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  });
  await assert.rejects(
    () => streamed.generate(clientInput()),
    expectClientError("response_too_large")
  );
  assert.equal(cancelled, true);
});

test("maps authoritative HTTP statuses without following another request", async () => {
  for (const [status, code, retryable] of [
    [401, "configuration", false],
    [408, "network", true],
    [429, "rate_limit", true],
    [503, "service_unavailable", true],
    [400, "request_rejected", false],
  ]) {
    let calls = 0;
    const client = new MiniMaxDailyDigestClient({
      getApiKey: () => "secret",
      fetchImpl: async () => { calls += 1; return new Response("rejected", { status }); },
    });
    await assert.rejects(() => client.generate(clientInput()), expectClientError(code, retryable));
    assert.equal(calls, 1);
  }
});

test("accepts only the exact persisted digest cloud payload contract", async () => {
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope()),
  });
  const invalidInputs = [
    [{ ...clientInput(), extra: true }, "invalid_structure"],
    [{ ...clientInput(), inputHash: "not-a-hash" }, "invalid_structure"],
    [{ cloudPayloadJson: "not json", inputHash: SOURCE_HASH }, "invalid_json"],
    [clientInput({ ...cloudPayload(), schemaVersion: "other" }), "invalid_structure"],
    [clientInput({ ...cloudPayload(), privateName: "Alice" }), "invalid_structure"],
    (() => {
      const payload = cloudPayload();
      payload.sections.sessions[0].segments.push({ ...payload.sections.sessions[0].segments[0] });
      return [clientInput(payload), "invalid_structure"];
    })(),
    (() => {
      const payload = cloudPayload();
      payload.sections.peopleInteractions[0].subjectRef = "subject-ffffffffffffffff";
      return [clientInput(payload), "invalid_structure"];
    })(),
    (() => {
      const payload = cloudPayload();
      payload.sections.peopleInteractions[0].evidenceSegmentIds = ["outside-input"];
      return [clientInput(payload), "invalid_structure"];
    })(),
    (() => {
      const payload = cloudPayload();
      payload.sections.transcriptCoverage.selectedSegmentCount = 2;
      return [clientInput(payload), "invalid_structure"];
    })(),
  ];
  for (const [input, errorCode] of invalidInputs) {
    await assert.rejects(() => client.generate(input), expectClientError(errorCode));
  }
});

test("accepts an all-day persisted input with more than one hundred evidence segments", async () => {
  const payload = cloudPayload();
  payload.sections.sessions[0].segments = Array.from({ length: 101 }, (_, index) => ({
    segmentId: `segment-${index + 1}`,
    startedAt: 1_000 + index * 10,
    endedAt: 1_005 + index * 10,
    subjectRef: SUBJECT_REF,
    text: `Evidence ${index + 1}`,
  }));
  payload.sections.peopleInteractions[0].evidenceSegmentIds = payload.sections.sessions[0]
    .segments.map((segment) => segment.segmentId);
  payload.sections.transcriptCoverage = {
    selectedSegmentCount: 101,
    incompleteSegmentCount: 0,
    sessionCount: 1,
    startsAt: 1_000,
    endsAt: 2_005,
  };
  const output = digestCandidate();
  output.processing.transcriptCoverage = { ...payload.sections.transcriptCoverage };
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope(output)),
  });

  const result = await client.generate(clientInput(payload));

  assert.equal(result.result.processing.transcriptCoverage.selectedSegmentCount, 101);
});

test("accepts repeated derived entity refs from distinct persisted occurrences", async () => {
  const payload = cloudPayload();
  payload.sections.topics = [
    {
      topicRef: "topic-0123456789abcdef",
      text: "Launch: first occurrence",
      evidenceSegmentIds: ["segment-1"],
    },
    {
      topicRef: "topic-0123456789abcdef",
      text: "Launch: later occurrence",
      evidenceSegmentIds: ["segment-1"],
    },
  ];
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope()),
  });

  const result = await client.generate(clientInput(payload));

  assert.equal(result.result.schemaVersion, "jarvis-daily-digest-v1");
});

test("accepts persisted multiline evidence text without normalizing it", async () => {
  const payload = cloudPayload();
  payload.sections.sessions[0].segments[0].text = " Line one\nLine two ";
  payload.sections.topics = [{
    topicRef: "topic-0123456789abcdef",
    text: " Launch\nnotes ",
    evidenceSegmentIds: ["segment-1"],
  }];
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope()),
  });

  const result = await client.generate(clientInput(payload));

  assert.equal(result.result.schemaVersion, "jarvis-daily-digest-v1");
});

test("returns authoritative token usage and response bytes on invalid model output", async () => {
  const envelope = responseEnvelope({ ...digestCandidate(), createdAt: 123 }, {
    prompt_tokens: 17,
    completion_tokens: 9,
  });
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(envelope),
  });
  await assert.rejects(
    () => client.generate(clientInput()),
    (error) =>
      expectClientError("invalid_structure")(error) &&
      error.issueCode === "schema.unknown_field" &&
      error.usage?.inputTokens === 17 &&
      error.usage?.outputTokens === 9 &&
      error.responseBytes === Buffer.byteLength(JSON.stringify(envelope), "utf8") &&
      Number.isSafeInteger(error.requestBytes) &&
      error.requestSent === true
  );
});

test("allowlists diagnostics and never logs credentials or private payload content", async () => {
  const logs = [];
  const apiKey = "sk-cp-super-private-subscription-key";
  const privatePayload = cloudPayload();
  privatePayload.sections.sessions[0].segments[0].text = "Alice said secret evidence phrase";
  const input = clientInput(privatePayload);
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => apiKey,
    logger: (record) => logs.push(record),
    createRequestId: () => "digest_request_safe",
    now: (() => { let value = 1_000; return () => value += 10; })(),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
      assert.equal(options.credentials, "omit");
      assert.equal(options.useSessionCookies, false);
      return jsonResponse(responseEnvelope());
    },
  });
  await client.generate(input);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), [
    "durationMs",
    "inputHash",
    "inputTokens",
    "model",
    "outputTokens",
    "requestBytes",
    "requestId",
    "responseBytes",
  ].sort());
  const serialized = JSON.stringify(logs);
  for (const secret of [
    apiKey,
    input.cloudPayloadJson,
    "Alice",
    "secret evidence phrase",
    "segment-1",
    SUBJECT_REF,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
