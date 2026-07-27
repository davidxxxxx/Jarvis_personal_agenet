const test = require("node:test");
const assert = require("node:assert/strict");

const AnalysisInputBuilder = require("../../src/jarvis/main/AnalysisInputBuilder");

function prepared(overrides = {}) {
  return {
    sessionId: "local-session",
    transcriptRevision: "a".repeat(64),
    identityRevision: "b".repeat(64),
    promptVersion: "jarvis-analysis-v2",
    prepareToken: "c".repeat(64),
    segments: [
      {
        ordinal: 1,
        segmentId: "seg-later",
        segmentVersion: 1,
        textHash: "d".repeat(64),
        textSnapshot: "Later text from Other Person",
        resultKind: "final",
        isStable: true,
        isCurrent: true,
        supersededBy: null,
        duplicateOf: null,
        startedAt: 20,
        endedAt: 30,
        speakerBindingLabel: "P1",
      },
      {
        ordinal: 0,
        segmentId: "seg-first",
        segmentVersion: 1,
        textHash: "e".repeat(64),
        textSnapshot: "First text from Local Self",
        resultKind: "final",
        isStable: true,
        isCurrent: true,
        supersededBy: null,
        duplicateOf: null,
        startedAt: 10,
        endedAt: 20,
        speakerBindingLabel: "SELF",
      },
    ],
    speakerBindings: [
      {
        label: "SELF",
        subjectKind: "person",
        subjectId: "person-private-self",
        subjectDisplayNameSnapshot: "Local Self",
      },
      {
        label: "P1",
        subjectKind: "person",
        subjectId: "person-private-other",
        subjectDisplayNameSnapshot: "Other Person",
      },
    ],
    redactionTerms: {
      participants: [
        { label: "SELF", names: ["Local Self"] },
        { label: "P1", names: ["Other Person"] },
      ],
      otherPeople: ["A+B"],
      deviceLabels: ["SteelSeries Sonar - Microphone"],
    },
    ...overrides,
  };
}

test("builds a deterministic chronological payload with local-only bindings", () => {
  const source = prepared();
  const before = structuredClone(source);
  const builder = new AnalysisInputBuilder();

  const first = builder.build(source);
  const second = builder.build(structuredClone(source));

  assert.equal(first.sendable, true);
  assert.deepEqual(
    first.cloudPayload.segments.map((segment) => segment.segmentId),
    ["seg-first", "seg-later"]
  );
  assert.deepEqual(
    first.cloudPayload.segments.map((segment) => segment.speakerLabel),
    ["SELF", "P1"]
  );
  assert.equal(first.cloudPayload.inputVersion, "jarvis-analysis-input-v2");
  assert.deepEqual(first.cloudPayload.omittedRanges, []);
  assert.deepEqual(first, second);
  assert.deepEqual(source, before);
  assert.doesNotMatch(first.cloudPayloadJson, /local-session|person-private|transcriptRevision/i);
  assert.deepEqual(first.local.pseudonymBindings, source.speakerBindings);
  assert.equal(JSON.stringify(first.cloudPayload).includes("pseudonymBindings"), false);
  assert.equal(first.local.complete, true);
  assert.equal(first.local.nextCursor, 2);
});

test("redacts local names devices credentials and absolute paths in the outbound copy", () => {
  const subscriptionShape = ["sk", "cp", "unitsecretvalue123"].join("-");
  const jwt = ["headerheader", "payloadpayload", "signaturesignature"].join(".");
  const privateText = [
    "LOCAL SELF met other person and A+B.",
    "SteelSeries Sonar - Microphone",
    `Bearer bearer-secret-value ${subscriptionShape} ${jwt}`,
    "api_key=my-private-value password: another-private-value",
    '"C:\\Users\\private\\Project Notes\\meeting draft.wav";',
    '"\\\\server\\shared folder\\recording final.flac";',
    "'/home/private/My Notes/audio final.wav';",
    "C:\\Work Folder\\daily note.txt; \\\\host\\Team Share\\call note.wav; /var/lib/Jarvis Data/day note.flac;",
    '"D:/Private Folder/quoted note.txt"; C:/Users/Private Person/secret notes.txt;',
    "Keep https://example.com/reference and the ordinary label Drive C: unchanged.",
  ].join(" ");
  const source = prepared({
    segments: [
      {
        ...prepared().segments[1],
        textSnapshot: privateText,
      },
    ],
  });

  const result = new AnalysisInputBuilder().build(source);
  const text = result.cloudPayload.segments[0].text;

  for (const forbidden of [
    "Local Self",
    "Other Person",
    "A+B",
    "SteelSeries Sonar",
    "bearer-secret-value",
    subscriptionShape,
    jwt,
    "my-private-value",
    "another-private-value",
    "C:\\Users",
    "Project Notes",
    "meeting draft.wav",
    "\\\\server",
    "shared folder",
    "recording final.flac",
    "/home/private",
    "My Notes",
    "audio final.wav",
    "Work Folder",
    "daily note.txt",
    "Team Share",
    "call note.wav",
    "Jarvis Data",
    "day note.flac",
    "Private Folder",
    "quoted note.txt",
    "Private Person",
    "secret notes.txt",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.match(text, /SELF met P1 and \[PERSON\]/);
  assert.doesNotMatch(text, /undefined/iu);
  assert.match(text, /\[DEVICE\]/);
  assert.match(text, /\[SECRET\]/);
  assert.match(text, /\[PATH\]/);
  assert.match(text, /https:\/\/example\.com\/reference/);
  assert.match(text, /Drive C: unchanged/);
  assert.equal(source.segments[0].textSnapshot, privateText);
});

test("compiles reusable redaction matchers without changing established output", () => {
  const { compileRedactionTerms, redactText } = AnalysisInputBuilder;
  assert.equal(typeof compileRedactionTerms, "function");
  const terms = prepared().redactionTerms;
  const text =
    "Local Self met Other Person and A+B using SteelSeries Sonar - Microphone " +
    "with api_key=private-value at C:\\Users\\private\\note.txt";

  const redact = compileRedactionTerms(terms);

  assert.equal(redact(text), redactText(text, terms));
  assert.equal(redact(text), redact(text));
  assert.equal(
    redact(text),
    "SELF met P1 and [PERSON] using [DEVICE] with [SECRET] at [PATH]"
  );
});

test("fails closed unless every prepared segment is final stable current and non-duplicate", () => {
  const builder = new AnalysisInputBuilder();
  const invalidStates = [
    ["resultKind", "provisional"],
    ["isStable", false],
    ["isCurrent", false],
    ["supersededBy", "seg-new"],
    ["duplicateOf", "seg-original"],
  ];

  for (const [field, value] of invalidStates) {
    const source = prepared({
      segments: [{ ...prepared().segments[0], [field]: value }],
    });
    assert.throws(() => builder.build(source), /prepared segment is invalid/);
    assert.equal(
      builder.verifyRedactedCloudPayload({
        cloudPayload: {
          inputVersion: "jarvis-analysis-input-v2",
          segments: [
            {
              segmentId: "seg-later",
              startedAt: 20,
              endedAt: 30,
              speakerLabel: "P1",
              text: "Later text from P1",
            },
          ],
          omittedRanges: [],
        },
        preparedSnapshot: source,
      }),
      false
    );
  }
});

test("uses UTF-8 bytes and complete segments when selecting a window", () => {
  const source = prepared({
    segments: [
      { ...prepared().segments[1], textSnapshot: "中文😀".repeat(10) },
      { ...prepared().segments[0], textSnapshot: "second complete segment" },
    ],
  });
  const probe = new AnalysisInputBuilder().build(source);
  const firstOnlyPayload = {
    ...probe.cloudPayload,
    segments: [probe.cloudPayload.segments[0]],
    omittedRanges: [{ startedAt: 20, endedAt: 30 }],
  };
  const exactBudget = Buffer.byteLength(JSON.stringify(firstOnlyPayload), "utf8");
  const result = new AnalysisInputBuilder({ maxPayloadBytes: exactBudget }).build(source);

  assert.equal(result.sendable, true);
  assert.deepEqual(
    result.cloudPayload.segments.map((segment) => segment.segmentId),
    ["seg-first"]
  );
  assert.equal(result.cloudPayload.segments[0].text, "中文😀".repeat(10));
  assert.deepEqual(result.cloudPayload.omittedRanges, [{ startedAt: 20, endedAt: 30 }]);
  assert.equal(result.local.inputBytes, exactBudget);
  assert.equal(result.local.nextCursor, 1);
  assert.equal(result.local.complete, false);
});

test("timeline coverage samples the beginning middle and end of a long recording", () => {
  const template = prepared().segments[0];
  const segments = Array.from({ length: 21 }, (_value, index) => ({
    ...template,
    ordinal: index,
    segmentId: `segment-${String(index).padStart(2, "0")}`,
    textHash: String(index % 10).repeat(64),
    textSnapshot: `timeline evidence ${index} ${"x".repeat(120)}`,
    startedAt: index * 1_000,
    endedAt: index * 1_000 + 900,
    speakerBindingLabel: "SELF",
  }));
  const source = prepared({
    segments,
    speakerBindings: [prepared().speakerBindings[0]],
    redactionTerms: {
      participants: [prepared().redactionTerms.participants[0]],
      otherPeople: [],
      deviceLabels: [],
    },
  });
  const result = new AnalysisInputBuilder({ maxPayloadBytes: 1_400 }).build(source, {
    strategy: "timeline",
  });
  const selectedIds = result.cloudPayload.segments.map((segment) => segment.segmentId);

  assert.equal(result.sendable, true);
  assert.equal(selectedIds.includes("segment-00"), true);
  assert.equal(selectedIds.includes("segment-10"), true);
  assert.equal(selectedIds.includes("segment-20"), true);
  assert.equal(selectedIds.length < segments.length, true);
  assert.equal(result.local.complete, false);
  assert.equal(result.local.nextCursor, segments.length);
  assert.equal(
    new AnalysisInputBuilder({ maxPayloadBytes: 1_400 }).verifyRedactedCloudPayload({
      cloudPayload: result.cloudPayload,
      preparedSnapshot: source,
    }),
    true
  );
});

test("hierarchical coverage gives every occupied time window evidence before adding detail", () => {
  const template = prepared().segments[0];
  const denseOpening = Array.from({ length: 30 }, (_value, index) => ({
    ...template,
    ordinal: index,
    segmentId: `opening-${String(index).padStart(2, "0")}`,
    textHash: String(index % 10).repeat(64),
    textSnapshot: `opening evidence ${index} ${"x".repeat(80)}`,
    startedAt: index * 1_000,
    endedAt: index * 1_000 + 1_000,
    speakerBindingLabel: "SELF",
  }));
  const sparseLaterWindows = [
    {
      ...template,
      ordinal: 30,
      segmentId: "middle-window",
      textHash: "a".repeat(64),
      textSnapshot: `middle window evidence ${"y".repeat(80)}`,
      startedAt: 20 * 60_000,
      endedAt: 20 * 60_000 + 900,
      speakerBindingLabel: "SELF",
    },
    {
      ...template,
      ordinal: 31,
      segmentId: "late-window",
      textHash: "b".repeat(64),
      textSnapshot: `late window evidence ${"z".repeat(80)}`,
      startedAt: 40 * 60_000,
      endedAt: 40 * 60_000 + 900,
      speakerBindingLabel: "SELF",
    },
  ];
  const source = prepared({
    segments: [...denseOpening, ...sparseLaterWindows],
    speakerBindings: [prepared().speakerBindings[0]],
    redactionTerms: {
      participants: [prepared().redactionTerms.participants[0]],
      otherPeople: [],
      deviceLabels: [],
    },
  });

  const result = new AnalysisInputBuilder({ maxPayloadBytes: 1_350 }).build(source, {
    strategy: "hierarchical",
  });
  const selectedIds = result.cloudPayload.segments.map((segment) => segment.segmentId);

  assert.equal(result.sendable, true);
  assert.equal(selectedIds.some((id) => id.startsWith("opening-")), true);
  assert.equal(selectedIds.includes("middle-window"), true);
  assert.equal(selectedIds.includes("late-window"), true);
  assert.equal(selectedIds.length < source.segments.length, true);
  assert.equal(result.local.complete, false);
  assert.equal(result.local.nextCursor, source.segments.length);
});

test("skips a single oversized segment and advances the cursor to a later complete segment", () => {
  const source = prepared({
    segments: [
      { ...prepared().segments[1], textSnapshot: "大".repeat(2_000) },
      { ...prepared().segments[0], textSnapshot: "small" },
    ],
  });
  const result = new AnalysisInputBuilder({ maxPayloadBytes: 400 }).build(source);

  assert.equal(result.sendable, true);
  assert.deepEqual(
    result.cloudPayload.segments.map((segment) => segment.segmentId),
    ["seg-later"]
  );
  assert.deepEqual(result.cloudPayload.omittedRanges, [{ startedAt: 10, endedAt: 20 }]);
  assert.equal(result.local.nextCursor, 2);
  assert.equal(result.local.complete, true);
});

test("returns a non-sendable advancing result when no complete segment fits", () => {
  const source = prepared({
    segments: [{ ...prepared().segments[1], textSnapshot: "大".repeat(2_000) }],
  });
  const result = new AnalysisInputBuilder({ maxPayloadBytes: 120 }).build(source);
  assert.equal(result.sendable, false);
  assert.equal(result.reason, "budget_exceeded");
  assert.equal(result.local.nextCursor, 1);
  assert.deepEqual(result.cloudPayload.segments, []);
});

test("verifyRedactedCloudPayload fails closed on text or structure tampering", () => {
  const builder = new AnalysisInputBuilder();
  const source = prepared();
  const result = builder.build(source);
  assert.equal(
    builder.verifyRedactedCloudPayload({
      cloudPayload: structuredClone(result.cloudPayload),
      preparedSnapshot: source,
    }),
    true
  );
  assert.equal(
    builder.verifyRedactedCloudPayload({
      cloudPayload: {
        ...structuredClone(result.cloudPayload),
        segments: [{ ...result.cloudPayload.segments[0], text: "Local Self" }],
      },
      preparedSnapshot: source,
    }),
    false
  );
  assert.equal(
    builder.verifyRedactedCloudPayload({
      cloudPayload: { ...structuredClone(result.cloudPayload), sessionId: "private" },
      preparedSnapshot: source,
    }),
    false
  );
  assert.equal(builder.verifyRedactedCloudPayload({}), false);
});
