const ANALYSIS_SCHEMA_VERSION = "jarvis-analysis-v3";
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
const LEARNING_GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SUGGESTION_BASES = Object.freeze(["work_context", "learning_goal", "explicit_agreement"]);
const SUGGESTION_BASIS_SET = new Set([...SUGGESTION_BASES, "legacy_unverified"]);
const TODO_ACTION_KINDS = Object.freeze(["self_commitment", "assignment_accepted"]);
const TODO_ACTION_KIND_SET = new Set(TODO_ACTION_KINDS);

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

function confidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("schema.confidence");
  }
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
  if (
    input.allowedLearningGoalIds !== undefined &&
    !(input.allowedLearningGoalIds instanceof Set)
  ) {
    fail("schema.validation_context");
  }
  return {
    ...input,
    allowedLearningGoalIds: input.allowedLearningGoalIds ?? new Set(),
  };
}

function suggestionItem(raw, { allowedLearningGoalIds, cleanEvidence }) {
  const input = plainObject(raw);
  const legacyKeys = ["title", "rationale", "basedOnEvidenceSegmentIds"];
  const currentKeys = [...legacyKeys, "basis", "learningGoalId"];
  const legacy = Object.keys(input).length === legacyKeys.length;
  const item = exactObject(input, legacy ? legacyKeys : currentKeys);
  const basis = legacy ? "legacy_unverified" : item.basis;
  if (typeof basis !== "string" || !SUGGESTION_BASIS_SET.has(basis)) {
    fail("schema.suggestion_basis");
  }
  let learningGoalId = legacy ? null : item.learningGoalId;
  if (basis === "learning_goal") {
    if (typeof learningGoalId !== "string" || !LEARNING_GOAL_ID_PATTERN.test(learningGoalId)) {
      fail("schema.learning_goal_required");
    }
    if (!allowedLearningGoalIds.has(learningGoalId)) {
      fail("schema.learning_goal_out_of_scope");
    }
  } else if (learningGoalId !== null) {
    fail("schema.learning_goal_unexpected");
  }
  return {
    title: boundedString(item.title, 500),
    rationale: boundedString(item.rationale, 4_000),
    basis,
    learningGoalId,
    basedOnEvidenceSegmentIds: cleanEvidence(item.basedOnEvidenceSegmentIds),
  };
}

function todoShape(raw) {
  const input = plainObject(raw);
  const legacyKeys = ["title", "ownerLabel", "dueText", "semanticConfidence", "evidenceSegmentIds"];
  const currentKeys = [...legacyKeys, "actionKind", "assignmentSegmentIds", "acceptanceSegmentIds"];
  const isLegacy =
    Object.keys(input).length === legacyKeys.length &&
    legacyKeys.every((key) => Object.prototype.hasOwnProperty.call(input, key));
  return { item: exactObject(input, isLegacy ? legacyKeys : currentKeys), isLegacy };
}

function validateTodoActionEvidence({
  actionKind,
  evidenceSegmentIds,
  assignmentSegmentIds,
  acceptanceSegmentIds,
}) {
  if (!TODO_ACTION_KIND_SET.has(actionKind)) fail("schema.todo_action_kind");
  if (actionKind === "self_commitment") {
    if (assignmentSegmentIds.length > 0 || acceptanceSegmentIds.length > 0) {
      fail("schema.todo_action_evidence");
    }
    return;
  }
  const assignment = new Set(assignmentSegmentIds);
  const acceptance = new Set(acceptanceSegmentIds);
  if (
    assignment.size === 0 ||
    acceptance.size === 0 ||
    [...assignment].some((id) => acceptance.has(id)) ||
    evidenceSegmentIds.length !== assignment.size + acceptance.size ||
    evidenceSegmentIds.some((id) => !assignment.has(id) && !acceptance.has(id))
  ) {
    fail("schema.todo_action_evidence");
  }
}

function validateCandidateAnalysis(payload, context) {
  const { allowedSegmentIds, allowedOwnerLabels, allowedLearningGoalIds } =
    normalizeContext(context);
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
    return {
      kind: item.kind,
      title: boundedString(item.title, 200),
      body: boundedString(item.body, 4_000),
      confidence: confidence(item.confidence),
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
    const { item, isLegacy } = todoShape(raw);
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
    const evidenceSegmentIds = evidenceIds(item.evidenceSegmentIds, {
      required: true,
      allowedSegmentIds,
    });
    const action = isLegacy
      ? null
      : {
          actionKind: item.actionKind,
          assignmentSegmentIds: evidenceIds(item.assignmentSegmentIds, {
            required: false,
            allowedSegmentIds,
          }),
          acceptanceSegmentIds: evidenceIds(item.acceptanceSegmentIds, {
            required: false,
            allowedSegmentIds,
          }),
        };
    if (action) validateTodoActionEvidence({ ...action, evidenceSegmentIds });
    return {
      title: boundedString(item.title, 500),
      ownerLabel,
      dueText,
      semanticConfidence: confidence(item.semanticConfidence),
      evidenceSegmentIds,
      ...(action ?? {}),
    };
  });

  const suggestions = collection(input.suggestions, "suggestions").map((raw) => {
    return suggestionItem(raw, {
      allowedSegmentIds,
      allowedLearningGoalIds,
      cleanEvidence: (value) =>
        evidenceIds(value, {
          required: false,
          allowedSegmentIds,
        }),
    });
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
  const { allowedSegmentIds, allowedOwnerLabels, allowedLearningGoalIds } =
    normalizeContext(context);
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
      const evidence = cleanEvidence(item.evidenceSegmentIds);
      return evidence.length === 0
        ? null
        : {
            kind: item.kind,
            title: boundedString(item.title, 200),
            body: boundedString(item.body, 4_000),
            confidence: confidence(item.confidence),
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
      const { item, isLegacy } = todoShape(raw);
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
      if (evidence.length === 0) return null;
      let action = null;
      if (!isLegacy) {
        action = {
          actionKind: item.actionKind,
          assignmentSegmentIds: cleanEvidence(item.assignmentSegmentIds),
          acceptanceSegmentIds: cleanEvidence(item.acceptanceSegmentIds),
        };
        validateTodoActionEvidence({ ...action, evidenceSegmentIds: evidence });
      }
      return {
        title: boundedString(item.title, 500),
        ownerLabel: item.ownerLabel,
        dueText,
        semanticConfidence: confidence(item.semanticConfidence),
        evidenceSegmentIds: evidence,
        ...(action ?? {}),
      };
    }),
    suggestions: keepValid(input.suggestions, (raw) => {
      return suggestionItem(raw, {
        allowedSegmentIds,
        allowedLearningGoalIds,
        cleanEvidence,
      });
    }),
  };
  return validateCandidateAnalysis(repaired, {
    allowedSegmentIds,
    allowedOwnerLabels,
    allowedLearningGoalIds,
  });
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
            required: [
              "title",
              "ownerLabel",
              "dueText",
              "semanticConfidence",
              "evidenceSegmentIds",
              "actionKind",
              "assignmentSegmentIds",
              "acceptanceSegmentIds",
            ],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 500 },
              ownerLabel: {
                anyOf: [{ type: "null" }, { type: "string", pattern: "^(SELF|P[1-9][0-9]*)$" }],
              },
              dueText: {
                anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 500 }],
              },
              semanticConfidence: { type: "number", minimum: 0, maximum: 1 },
              evidenceSegmentIds: evidenceArraySchema(1),
              actionKind: { type: "string", enum: TODO_ACTION_KINDS },
              assignmentSegmentIds: evidenceArraySchema(0),
              acceptanceSegmentIds: evidenceArraySchema(0),
            },
          },
        },
        suggestions: {
          type: "array",
          maxItems: MAX_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "title",
              "rationale",
              "basis",
              "learningGoalId",
              "basedOnEvidenceSegmentIds",
            ],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 500 },
              rationale: { type: "string", minLength: 1, maxLength: 4_000 },
              basis: { type: "string", enum: SUGGESTION_BASES },
              learningGoalId: {
                anyOf: [
                  { type: "null" },
                  { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
                ],
              },
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
  SUGGESTION_BASES,
  AnalysisSchemaError,
  salvageCandidateAnalysis,
  validateCandidateAnalysis,
  ANALYSIS_TOOL,
};
