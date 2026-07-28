const ANALYSIS_SCHEMA_VERSION = "jarvis-analysis-v2";
const MAX_COLLECTION_ITEMS = 100;
const MAX_EVIDENCE_ITEMS = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MEMORY_KINDS = Object.freeze([
  "fact",
  "event",
  "decision",
  "commitment",
  "preference",
  "relationship",
]);
const MEMORY_KIND_SET = new Set(MEMORY_KINDS);
const OWNER_LABEL_PATTERN = /^(?:SELF|P[1-9][0-9]*)$/u;

class AnalysisSchemaError extends Error {
  constructor(issueCode) {
    super("Analysis response failed validation");
    this.name = "AnalysisSchemaError";
    this.code = "invalid_structure";
    this.retryable = false;
    this.issueCode = issueCode;
  }
}

function fail(issueCode) {
  throw new AnalysisSchemaError(issueCode);
}

function plainObject(value, issueCode = "schema.object_type") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(issueCode);
  }
  return value;
}

function exactObject(value, requiredKeys, issueCode = "schema.object_type") {
  const input = plainObject(value, issueCode);
  const expected = new Set(requiredKeys);
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) fail("schema.unknown_field");
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail("schema.missing_field");
  }
  return input;
}

function boundedString(value, maxCodePoints) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Array.from(value).length > maxCodePoints ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("schema.string");
  }
  return value;
}

function collection(value, field) {
  if (!Array.isArray(value)) fail(`schema.collection_type.${field}`);
  if (value.length > MAX_COLLECTION_ITEMS) fail("schema.collection_count");
  return value;
}

function evidenceIds(value, { required, allowedSegmentIds }) {
  if (!Array.isArray(value)) fail("schema.evidence_type");
  if (value.length > MAX_EVIDENCE_ITEMS) fail("schema.evidence_count");
  if (required && value.length === 0) fail("schema.evidence_empty");
  if (value.some((id) => typeof id !== "string" || !id || id !== id.trim())) {
    fail("schema.evidence_id");
  }
  if (new Set(value).size !== value.length) fail("schema.evidence_duplicate");
  if (value.some((id) => !allowedSegmentIds.has(id))) fail("schema.evidence_out_of_scope");
  return [...value];
}

function normalizeContext(context) {
  const input = plainObject(context, "schema.validation_context");
  if (!(input.allowedSegmentIds instanceof Set) || !(input.allowedOwnerLabels instanceof Set)) {
    fail("schema.validation_context");
  }
  return input;
}

function validateCandidateAnalysis(payload, context) {
  const { allowedSegmentIds, allowedOwnerLabels } = normalizeContext(context);
  const serializedBytes = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
      fail("schema.top_level_type");
    }
  })();
  if (serializedBytes > MAX_RESPONSE_BYTES) fail("schema.response_too_large");
  const input = exactObject(
    payload,
    ["schemaVersion", "sessionSummary", "memories", "topics", "todos", "suggestions"],
    "schema.top_level_type"
  );
  if (input.schemaVersion !== ANALYSIS_SCHEMA_VERSION) fail("schema.version");

  const rawSummary = exactObject(input.sessionSummary, ["title", "summary", "evidenceSegmentIds"]);
  const sessionSummary = {
    title: boundedString(rawSummary.title, 200),
    summary: boundedString(rawSummary.summary, 4_000),
    evidenceSegmentIds: evidenceIds(rawSummary.evidenceSegmentIds, {
      required: true,
      allowedSegmentIds,
    }),
  };

  const memories = collection(input.memories, "memories").map((raw) => {
    const item = exactObject(raw, ["kind", "title", "body", "confidence", "evidenceSegmentIds"]);
    if (!MEMORY_KIND_SET.has(item.kind)) fail("schema.memory_kind");
    if (
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      fail("schema.confidence");
    }
    return {
      kind: item.kind,
      title: boundedString(item.title, 200),
      body: boundedString(item.body, 4_000),
      confidence: item.confidence,
      evidenceSegmentIds: evidenceIds(item.evidenceSegmentIds, {
        required: true,
        allowedSegmentIds,
      }),
    };
  });

  const topics = collection(input.topics, "topics").map((raw) => {
    const item = exactObject(raw, ["name", "summary", "evidenceSegmentIds"]);
    return {
      name: boundedString(item.name, 200),
      summary: boundedString(item.summary, 4_000),
      evidenceSegmentIds: evidenceIds(item.evidenceSegmentIds, {
        required: true,
        allowedSegmentIds,
      }),
    };
  });

  const todos = collection(input.todos, "todos").map((raw) => {
    const item = exactObject(raw, ["title", "ownerLabel", "dueText", "evidenceSegmentIds"]);
    let ownerLabel = null;
    if (item.ownerLabel !== null) {
      if (typeof item.ownerLabel !== "string" || !OWNER_LABEL_PATTERN.test(item.ownerLabel)) {
        fail("schema.owner_label");
      }
      if (!allowedOwnerLabels.has(item.ownerLabel)) fail("schema.owner_out_of_scope");
      ownerLabel = item.ownerLabel;
    }
    let dueText = null;
    if (item.dueText !== null) {
      if (typeof item.dueText !== "string" || item.dueText.length === 0) fail("schema.due_text");
      try {
        dueText = boundedString(item.dueText, 500);
      } catch (error) {
        if (error instanceof AnalysisSchemaError) fail("schema.due_text");
        throw error;
      }
    }
    return {
      title: boundedString(item.title, 500),
      ownerLabel,
      dueText,
      evidenceSegmentIds: evidenceIds(item.evidenceSegmentIds, {
        required: true,
        allowedSegmentIds,
      }),
    };
  });

  const suggestions = collection(input.suggestions, "suggestions").map((raw) => {
    const item = exactObject(raw, ["title", "rationale", "basedOnEvidenceSegmentIds"]);
    return {
      title: boundedString(item.title, 500),
      rationale: boundedString(item.rationale, 4_000),
      basedOnEvidenceSegmentIds: evidenceIds(item.basedOnEvidenceSegmentIds, {
        required: false,
        allowedSegmentIds,
      }),
    };
  });

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    sessionSummary,
    memories,
    topics,
    todos,
    suggestions,
  };
}

// Preserve valid, grounded output when MiniMax emits one malformed optional
// item. The strict validator remains the final trust boundary; this helper
// only removes invalid optional items and out-of-scope evidence references.
function salvageCandidateAnalysis(payload, context) {
  const { allowedSegmentIds, allowedOwnerLabels } = normalizeContext(context);
  const input = exactObject(
    payload,
    ["schemaVersion", "sessionSummary", "memories", "topics", "todos", "suggestions"],
    "schema.top_level_type"
  );
  if (input.schemaVersion !== ANALYSIS_SCHEMA_VERSION) fail("schema.version");

  const cleanEvidence = (value) => {
    if (!Array.isArray(value)) return [];
    const result = [];
    for (const id of value) {
      if (
        typeof id === "string" &&
        id.length > 0 &&
        id === id.trim() &&
        allowedSegmentIds.has(id) &&
        !result.includes(id)
      ) {
        result.push(id);
      }
      if (result.length >= MAX_EVIDENCE_ITEMS) break;
    }
    return result;
  };
  const keepValid = (value, repair) =>
    (Array.isArray(value) ? value.slice(0, MAX_COLLECTION_ITEMS) : []).flatMap((raw) => {
      try {
        const repaired = repair(raw);
        return repaired === null ? [] : [repaired];
      } catch (error) {
        if (error instanceof AnalysisSchemaError) return [];
        throw error;
      }
    });

  const rawSummary = exactObject(input.sessionSummary, ["title", "summary", "evidenceSegmentIds"]);
  const summaryEvidence = cleanEvidence(rawSummary.evidenceSegmentIds);
  if (summaryEvidence.length === 0) fail("schema.evidence_empty");
  const repaired = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    sessionSummary: {
      title: boundedString(rawSummary.title, 200),
      summary: boundedString(rawSummary.summary, 4_000),
      evidenceSegmentIds: summaryEvidence,
    },
    memories: keepValid(input.memories, (raw) => {
      const item = exactObject(raw, ["kind", "title", "body", "confidence", "evidenceSegmentIds"]);
      if (!MEMORY_KIND_SET.has(item.kind)) fail("schema.memory_kind");
      if (
        typeof item.confidence !== "number" ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      ) {
        fail("schema.confidence");
      }
      const evidence = cleanEvidence(item.evidenceSegmentIds);
      return evidence.length === 0
        ? null
        : {
            kind: item.kind,
            title: boundedString(item.title, 200),
            body: boundedString(item.body, 4_000),
            confidence: item.confidence,
            evidenceSegmentIds: evidence,
          };
    }),
    topics: keepValid(input.topics, (raw) => {
      const item = exactObject(raw, ["name", "summary", "evidenceSegmentIds"]);
      const evidence = cleanEvidence(item.evidenceSegmentIds);
      return evidence.length === 0
        ? null
        : {
            name: boundedString(item.name, 200),
            summary: boundedString(item.summary, 4_000),
            evidenceSegmentIds: evidence,
          };
    }),
    todos: keepValid(input.todos, (raw) => {
      const item = exactObject(raw, ["title", "ownerLabel", "dueText", "evidenceSegmentIds"]);
      if (
        item.ownerLabel !== null &&
        (typeof item.ownerLabel !== "string" ||
          !OWNER_LABEL_PATTERN.test(item.ownerLabel) ||
          !allowedOwnerLabels.has(item.ownerLabel))
      ) {
        return null;
      }
      let dueText = null;
      if (item.dueText !== null) {
        if (typeof item.dueText !== "string" || item.dueText.length === 0) fail("schema.due_text");
        dueText = boundedString(item.dueText, 500);
      }
      const evidence = cleanEvidence(item.evidenceSegmentIds);
      return evidence.length === 0
        ? null
        : {
            title: boundedString(item.title, 500),
            ownerLabel: item.ownerLabel,
            dueText,
            evidenceSegmentIds: evidence,
          };
    }),
    suggestions: keepValid(input.suggestions, (raw) => {
      const item = exactObject(raw, ["title", "rationale", "basedOnEvidenceSegmentIds"]);
      return {
        title: boundedString(item.title, 500),
        rationale: boundedString(item.rationale, 4_000),
        basedOnEvidenceSegmentIds: cleanEvidence(item.basedOnEvidenceSegmentIds),
      };
    }),
  };
  return validateCandidateAnalysis(repaired, { allowedSegmentIds, allowedOwnerLabels });
}

const evidenceArraySchema = (minItems) => ({
  type: "array",
  minItems,
  maxItems: MAX_EVIDENCE_ITEMS,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 512 },
});

const ANALYSIS_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "submit_jarvis_analysis",
    description: "Return evidence-grounded Jarvis analysis for the supplied pseudonymous text.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "sessionSummary", "memories", "topics", "todos", "suggestions"],
      properties: {
        schemaVersion: { const: ANALYSIS_SCHEMA_VERSION },
        sessionSummary: {
          type: "object",
          additionalProperties: false,
          required: ["title", "summary", "evidenceSegmentIds"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            summary: { type: "string", minLength: 1, maxLength: 4_000 },
            evidenceSegmentIds: evidenceArraySchema(1),
          },
        },
        memories: {
          type: "array",
          maxItems: MAX_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "title", "body", "confidence", "evidenceSegmentIds"],
            properties: {
              kind: { type: "string", enum: MEMORY_KINDS },
              title: { type: "string", minLength: 1, maxLength: 200 },
              body: { type: "string", minLength: 1, maxLength: 4_000 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidenceSegmentIds: evidenceArraySchema(1),
            },
          },
        },
        topics: {
          type: "array",
          maxItems: MAX_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "summary", "evidenceSegmentIds"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              summary: { type: "string", minLength: 1, maxLength: 4_000 },
              evidenceSegmentIds: evidenceArraySchema(1),
            },
          },
        },
        todos: {
          type: "array",
          maxItems: MAX_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "ownerLabel", "dueText", "evidenceSegmentIds"],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 500 },
              ownerLabel: {
                anyOf: [{ type: "null" }, { type: "string", pattern: "^(SELF|P[1-9][0-9]*)$" }],
              },
              dueText: {
                anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 500 }],
              },
              evidenceSegmentIds: evidenceArraySchema(1),
            },
          },
        },
        suggestions: {
          type: "array",
          maxItems: MAX_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "rationale", "basedOnEvidenceSegmentIds"],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 500 },
              rationale: { type: "string", minLength: 1, maxLength: 4_000 },
              basedOnEvidenceSegmentIds: evidenceArraySchema(0),
            },
          },
        },
      },
    },
  },
});

module.exports = {
  ANALYSIS_SCHEMA_VERSION,
  AnalysisSchemaError,
  salvageCandidateAnalysis,
  validateCandidateAnalysis,
  ANALYSIS_TOOL,
};
