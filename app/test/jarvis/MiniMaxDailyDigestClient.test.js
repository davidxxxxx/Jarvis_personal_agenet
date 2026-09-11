const test = require("node:test");
const assert = require("node:assert/strict");

const MiniMaxDailyDigestClient = require("../../src/jarvis/main/MiniMaxDailyDigestClient");
const {
  DailyDigestClientError,
  DEFAULT_MAX_REQUEST_BYTES,
} = require("../../src/jarvis/main/MiniMaxDailyDigestClient");
const { MAX_DAILY_DIGEST_INPUT_BYTES } = require("../../src/jarvis/main/DailyDigestContractLimits");

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

test("allows long MiniMax daily-digest reasoning with a finite timeout", () => {
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope()),
  });

  assert.equal(client.timeoutMs, 240_000);
});

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
  assert.equal(requestBody.reasoning_split, true);
  assert.equal(requestBody.messages[1].content, clientInput().cloudPayloadJson);
  assert.deepEqual(result, {
    result: digestCandidate(),
    usage: { inputTokens: 321, outputTokens: 123 },
    requestBytes: Buffer.byteLength(captured[0].options.body, "utf8"),
    responseBytes: Buffer.byteLength(JSON.stringify(envelope), "utf8"),
  });
});

test("accepts documented MiniMax reasoning content beside a valid digest tool call", async () => {
  const envelope = responseEnvelope();
  envelope.choices[0].message.content =
    "<think>Private reasoning stays outside the persisted daily digest.</think>";
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(envelope),
  });

  const result = await client.generate(clientInput());

  assert.equal(result.result.schemaVersion, "jarvis-daily-digest-v1");
});

test("accepts MiniMax digest tool-call compatibility fields and legacy function calls", async () => {
  const messages = [
    {
      content: [{ type: "text", text: "reasoning metadata" }],
      function_call: null,
      tool_calls: responseEnvelope().choices[0].message.tool_calls,
    },
    {
      content: null,
      tool_calls: [],
      function_call: {
        name: "submit_jarvis_daily_digest",
        arguments: JSON.stringify(digestCandidate()),
      },
    },
  ];
  let index = 0;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: messages[index++] }],
        usage: { prompt_tokens: 321, completion_tokens: 123 },
      }),
  });

  for (const _message of messages) {
    const result = await client.generate(clientInput());
    assert.deepEqual(result.result, digestCandidate());
  }
});

test("salvages grounded digest sections while dropping invalid refs and deriving processing state", async () => {
  const candidate = digestCandidate();
  candidate.sections.today.push({
    text: "Invented unsupported item.",
    evidenceSegmentIds: ["outside-input"],
  });
  candidate.sections.interactions.push({
    subjectRef: "subject-ffffffffffffffff",
    text: "Unknown person.",
    evidenceSegmentIds: ["segment-1"],
  });
  candidate.processing.missingStages = ["upstream_processing"];
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope(candidate)),
  });

  const result = await client.generate(clientInput());

  assert.deepEqual(result.result.sections.today, digestCandidate().sections.today);
  assert.deepEqual(result.result.sections.interactions, digestCandidate().sections.interactions);
  assert.deepEqual(result.result.processing, digestCandidate().processing);
});

test("salvages MiniMax responses that omit empty sections or untrusted processing metadata", async () => {
  const candidate = digestCandidate();
  delete candidate.sections.worthRemembering;
  delete candidate.processing;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope(candidate)),
  });

  const result = await client.generate(clientInput());

  assert.deepEqual(result.result, digestCandidate());
});

test("rejects a materially incomplete digest instead of defaulting most sections", async () => {
  const candidate = digestCandidate();
  for (const key of Object.keys(candidate.sections)) {
    if (key !== "today") delete candidate.sections[key];
  }
  delete candidate.processing;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope(candidate)),
  });

  await assert.rejects(
    () => client.generate(clientInput()),
    (error) =>
      expectClientError("invalid_structure")(error) &&
      error.issueCode === "schema.sections_incomplete"
  );
});

test("rejects a schema shell with no meaningful daily review section", async () => {
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () =>
      jsonResponse(
        responseEnvelope({
          schemaVersion: "jarvis-daily-digest-v1",
          sections: {},
        })
      ),
  });

  await assert.rejects(
    () => client.generate(clientInput()),
    (error) =>
      expectClientError("invalid_structure")(error) && error.issueCode === "schema.empty_digest"
  );
});

function expectClientError(code, retryable = false) {
  return (error) =>
    error instanceof DailyDigestClientError && error.code === code && error.retryable === retryable;
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
      () =>
        new MiniMaxDailyDigestClient({ baseUrl, fetchImpl: async () => {}, getApiKey: () => "x" }),
      expectClientError("configuration")
    );
  }
  assert.doesNotThrow(
    () =>
      new MiniMaxDailyDigestClient({
        baseUrl: "https://api.minimax.io/v1",
        fetchImpl: async () => {},
        getApiKey: () => "x",
      })
  );
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
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
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
    getApiKey: () => {
      keyReads += 1;
      return "secret";
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(responseEnvelope());
    },
  });
  await assert.rejects(
    () => client.generate(clientInput()),
    expectClientError("request_too_large")
  );
  assert.equal(keyReads, 0);
  assert.equal(calls, 0);
});

test("sends a valid persisted payload above 128 KiB under the shared 1 MiB boundary", async () => {
  const payload = cloudPayload();
  payload.sections.sessions[0].segments[0].text = "x".repeat(160 * 1024);
  const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(serializedBytes > 128 * 1024);
  assert.ok(serializedBytes < MAX_DAILY_DIGEST_INPUT_BYTES);
  assert.ok(DEFAULT_MAX_REQUEST_BYTES >= 3 * 1024 * 1024);
  let calls = 0;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(responseEnvelope());
    },
  });

  const result = await client.generate(clientInput(payload));

  assert.equal(calls, 1);
  assert.equal(result.result.schemaVersion, "jarvis-daily-digest-v1");
});

test("rejects a persisted payload above the shared 1 MiB boundary before credentials", async () => {
  const payload = cloudPayload();
  payload.sections.sessions[0].segments[0].text = "x".repeat(MAX_DAILY_DIGEST_INPUT_BYTES);
  let keyReads = 0;
  let calls = 0;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => {
      keyReads += 1;
      return "secret";
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(responseEnvelope());
    },
  });

  await assert.rejects(
    () => client.generate(clientInput(payload)),
    expectClientError("input_too_large")
  );
  assert.equal(keyReads, 0);
  assert.equal(calls, 0);
});

test("enforces declared and streamed response byte caps", async () => {
  const declared = new MiniMaxDailyDigestClient({
    maxResponseBytes: 100,
    getApiKey: () => "secret",
    fetchImpl: async () =>
      new Response("{}", {
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
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(60));
            controller.enqueue(new Uint8Array(60));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 }
      ),
  });
  await assert.rejects(
    () => streamed.generate(clientInput()),
    expectClientError("response_too_large")
  );
  assert.equal(cancelled, true);
});

test("rejects a non-streaming response body without unbounded arrayBuffer fallback", async () => {
  let arrayBufferReads = 0;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => {
        arrayBufferReads += 1;
        return new ArrayBuffer(0);
      },
    }),
  });

  await assert.rejects(
    () => client.generate(clientInput()),
    expectClientError("response_stream_required")
  );
  assert.equal(arrayBufferReads, 0);
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
      fetchImpl: async () => {
        calls += 1;
        return new Response("rejected", { status });
      },
    });
    await assert.rejects(() => client.generate(clientInput()), expectClientError(code, retryable));
    assert.equal(calls, 1);
  }
});

test("binds finish_reason to the matching tool or content response path", async () => {
  for (const finishReason of ["length", "content_filter", "stop", "unknown"]) {
    const envelope = responseEnvelope();
    envelope.choices[0].finish_reason = finishReason;
    const client = new MiniMaxDailyDigestClient({
      getApiKey: () => "secret",
      fetchImpl: async () => jsonResponse(envelope),
    });
    await assert.rejects(
      () => client.generate(clientInput()),
      expectClientError("invalid_structure")
    );
  }

  const validTool = responseEnvelope();
  validTool.choices[0].finish_reason = "tool_calls";
  const toolClient = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(validTool),
  });
  assert.equal(
    (await toolClient.generate(clientInput())).result.schemaVersion,
    "jarvis-daily-digest-v1"
  );

  const validContent = responseEnvelope();
  validContent.choices[0] = {
    finish_reason: "stop",
    message: { content: JSON.stringify(digestCandidate()) },
  };
  const contentClient = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(validContent),
  });
  assert.equal(
    (await contentClient.generate(clientInput())).result.schemaVersion,
    "jarvis-daily-digest-v1"
  );

  validContent.choices[0].finish_reason = "tool_calls";
  const mismatchedContent = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(validContent),
  });
  await assert.rejects(
    () => mismatchedContent.generate(clientInput()),
    expectClientError("invalid_structure")
  );
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

test("drops an interaction whose evidence belongs to another persisted subject", async () => {
  const payload = cloudPayload();
  payload.sections.sessions[0].segments.push({
    segmentId: "segment-2",
    startedAt: 2_000,
    endedAt: 3_000,
    subjectRef: "SELF",
    text: "Self evidence",
  });
  payload.sections.peopleInteractions.push({
    subjectRef: "SELF",
    sessionRefs: ["session-0123456789abcdef"],
    evidenceSegmentIds: ["segment-2"],
  });
  payload.sections.transcriptCoverage = {
    selectedSegmentCount: 2,
    incompleteSegmentCount: 0,
    sessionCount: 1,
    startsAt: 1_000,
    endsAt: 3_000,
  };
  const output = digestCandidate();
  output.sections.interactions[0].evidenceSegmentIds = ["segment-2"];
  output.processing.transcriptCoverage = { ...payload.sections.transcriptCoverage };
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(responseEnvelope(output)),
  });

  const result = await client.generate(clientInput(payload));
  assert.deepEqual(result.result.sections.interactions, []);
  assert.deepEqual(
    result.result.processing.transcriptCoverage,
    payload.sections.transcriptCoverage
  );
});

test("rejects secret and absolute-path text before reading credentials or sending", async () => {
  const forbiddenTexts = [
    "Bearer private-bearer-token",
    "sk-cp-unitsecretvalue123",
    "MINIMAX_API_KEY=top-secret-value",
    "Open C:\\Users\\Private Person\\notes.txt",
    "Open /home/private/notes.txt",
  ];
  for (const forbiddenText of forbiddenTexts) {
    const payload = cloudPayload();
    payload.sections.sessions[0].segments[0].text = forbiddenText;
    let keyReads = 0;
    let calls = 0;
    const logs = [];
    const client = new MiniMaxDailyDigestClient({
      getApiKey: () => {
        keyReads += 1;
        return "secret";
      },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(responseEnvelope());
      },
      logger: (record) => logs.push(record),
    });

    await assert.rejects(
      () => client.generate(clientInput(payload)),
      expectClientError("redaction_unverified")
    );
    assert.equal(keyReads, 0);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(logs).includes(forbiddenText), false);
  }
});

test("rejects secrets and paths in every outbound string field before credentials", async () => {
  const cases = [
    (payload) => {
      payload.sections.sessions[0].processingState = "MINIMAX_API_KEY=top-secret-value";
    },
    (payload) => {
      payload.sections.sessions[0].sessionRef = "C:\\private\\session";
    },
    (payload) => {
      payload.sections.sessions[0].segments[0].segmentId = "sk-cp-unitsecretvalue123";
    },
    (payload) => {
      payload.sections.topics = [
        {
          topicRef: "/private/topic/ref",
          text: "Safe topic text",
          evidenceSegmentIds: ["segment-1"],
        },
      ];
    },
  ];
  for (const mutate of cases) {
    const payload = cloudPayload();
    mutate(payload);
    const serializedPayload = JSON.stringify(payload);
    let keyReads = 0;
    let calls = 0;
    const logs = [];
    const client = new MiniMaxDailyDigestClient({
      getApiKey: () => {
        keyReads += 1;
        return "secret";
      },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(responseEnvelope());
      },
      logger: (record) => logs.push(record),
    });

    await assert.rejects(
      () => client.generate(clientInput(payload)),
      expectClientError("redaction_unverified")
    );
    assert.equal(keyReads, 0);
    assert.equal(calls, 0);
    const serializedLogs = JSON.stringify(logs);
    assert.equal(serializedLogs.includes(serializedPayload), false);
    assert.equal(serializedLogs.includes("top-secret-value"), false);
    assert.equal(serializedLogs.includes("C:\\private"), false);
    assert.equal(serializedLogs.includes("sk-cp-unitsecretvalue123"), false);
    assert.equal(serializedLogs.includes("/private/topic/ref"), false);
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
  payload.sections.peopleInteractions[0].evidenceSegmentIds =
    payload.sections.sessions[0].segments.map((segment) => segment.segmentId);
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
  payload.sections.topics = [
    {
      topicRef: "topic-0123456789abcdef",
      text: " Launch\nnotes ",
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

test("returns authoritative token usage and response bytes on invalid model output", async () => {
  const envelope = responseEnvelope(
    { ...digestCandidate(), createdAt: 123 },
    {
      prompt_tokens: 17,
      completion_tokens: 9,
    }
  );
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

test("fails closed when authoritative usage is missing invalid or conflicting", async () => {
  const cases = [
    (envelope) => {
      delete envelope.usage;
    },
    (envelope) => {
      envelope.usage = {};
    },
    (envelope) => {
      envelope.usage.prompt_tokens = -1;
    },
    (envelope) => {
      envelope.usage.completion_tokens = "123";
    },
    (envelope) => {
      delete envelope.usage.completion_tokens;
    },
    (envelope) => {
      envelope.usage.input_tokens = 999;
    },
    (envelope) => {
      envelope.usage.output_tokens = 999;
    },
  ];
  for (const mutate of cases) {
    const envelope = responseEnvelope();
    mutate(envelope);
    let calls = 0;
    const client = new MiniMaxDailyDigestClient({
      getApiKey: () => "secret",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(envelope);
      },
    });
    await assert.rejects(
      () => client.generate(clientInput()),
      (error) =>
        expectClientError("usage_unknown")(error) &&
        error.requestSent === true &&
        error.responseBytes === Buffer.byteLength(JSON.stringify(envelope), "utf8")
    );
    assert.equal(calls, 1);
  }
});

test("accepts consistent MiniMax token usage aliases", async () => {
  const envelope = responseEnvelope();
  envelope.usage.input_tokens = envelope.usage.prompt_tokens;
  envelope.usage.output_tokens = envelope.usage.completion_tokens;
  const client = new MiniMaxDailyDigestClient({
    getApiKey: () => "secret",
    fetchImpl: async () => jsonResponse(envelope),
  });

  const result = await client.generate(clientInput());

  assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 123 });
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
    now: (() => {
      let value = 1_000;
      return () => (value += 10);
    })(),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
      assert.equal(options.credentials, "omit");
      assert.equal(options.useSessionCookies, false);
      return jsonResponse(responseEnvelope());
    },
  });
  await client.generate(input);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    Object.keys(logs[0]).sort(),
    [
      "durationMs",
      "inputHash",
      "inputTokens",
      "model",
      "outputTokens",
      "requestBytes",
      "requestId",
      "responseBytes",
    ].sort()
  );
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
