const TOP_LEVEL_FIELDS = new Set([
  "summary",
  "topics",
  "memories",
  "todos",
  "decisions",
  "suggestions",
]);
const MEMORY_TYPES = new Set(["fact", "decision", "commitment", "opinion"]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function string(value, name, max = 2_000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must not be empty`);
  const trimmed = value.trim();
  if (Array.from(trimmed).length > max) throw new RangeError(`${name} is too long`);
  return trimmed;
}

function array(value, name, max = 100) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > max) throw new RangeError(`${name} has too many items`);
  return value;
}

function evidence(value, allowedSegmentIds) {
  const ids = array(value, "evidenceSegmentIds", 100).map((id) => string(id, "evidence id", 128));
  if (ids.length === 0) throw new TypeError("evidenceSegmentIds must not be empty");
  for (const id of ids) {
    if (!allowedSegmentIds.has(id)) throw new Error(`unknown evidence segment: ${id}`);
  }
  return ids;
}

function nullableString(value, name) {
  return value === null || value === undefined || value === "" ? null : string(value, name, 200);
}

function exactFields(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unknown field ${name}.${key}`);
  }
}

function validateAnalysisPayload(payload, allowedSegmentIds) {
  const input = object(payload, "analysis payload");
  exactFields(input, TOP_LEVEL_FIELDS, "analysis");
  if (!(allowedSegmentIds instanceof Set)) throw new TypeError("allowedSegmentIds must be a Set");

  const result = {
    summary: string(input.summary, "summary", 10_000),
    topics: array(input.topics, "topics").map((raw) => {
      const item = object(raw, "topic");
      exactFields(item, new Set(["title", "description", "evidenceSegmentIds"]), "topic");
      return {
        title: string(item.title, "topic title", 200),
        description: string(item.description, "topic description", 2_000),
        evidenceSegmentIds: evidence(item.evidenceSegmentIds, allowedSegmentIds),
      };
    }),
    memories: array(input.memories, "memories").map((raw) => {
      const item = object(raw, "memory");
      exactFields(item, new Set(["type", "content", "personRef", "topicRef", "confidence", "evidenceSegmentIds"]), "memory");
      if (!MEMORY_TYPES.has(item.type)) throw new TypeError("unsupported memory type");
      if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        throw new RangeError("memory confidence must be between 0 and 1");
      }
      return {
        type: item.type,
        content: string(item.content, "memory content"),
        personRef: nullableString(item.personRef, "personRef"),
        topicRef: nullableString(item.topicRef, "topicRef"),
        confidence: item.confidence,
        evidenceSegmentIds: evidence(item.evidenceSegmentIds, allowedSegmentIds),
      };
    }),
    todos: array(input.todos, "todos").map((raw) => {
      const item = object(raw, "todo");
      exactFields(item, new Set(["content", "ownerRef", "dueDate", "topicRef", "evidenceSegmentIds"]), "todo");
      const dueDate = nullableString(item.dueDate, "dueDate");
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new TypeError("dueDate must use YYYY-MM-DD");
      return {
        content: string(item.content, "todo content"),
        ownerRef: nullableString(item.ownerRef, "ownerRef"),
        dueDate,
        topicRef: nullableString(item.topicRef, "topicRef"),
        evidenceSegmentIds: evidence(item.evidenceSegmentIds, allowedSegmentIds),
      };
    }),
    decisions: array(input.decisions, "decisions").map((value) => string(value, "decision")),
    suggestions: array(input.suggestions, "suggestions").map((raw) => {
      const item = object(raw, "suggestion");
      exactFields(item, new Set(["content", "reason"]), "suggestion");
      return { content: string(item.content, "suggestion content"), reason: string(item.reason, "suggestion reason") };
    }),
  };
  return result;
}

const ANALYSIS_TOOL = {
  type: "function",
  function: {
    name: "submit_jarvis_analysis",
    description: "Return grounded structured analysis of the supplied transcript segments.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "topics", "memories", "todos", "decisions", "suggestions"],
      properties: {
        summary: { type: "string" },
        topics: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "description", "evidenceSegmentIds"], properties: { title: { type: "string" }, description: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } } } },
        memories: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "content", "personRef", "topicRef", "confidence", "evidenceSegmentIds"], properties: { type: { type: "string", enum: [...MEMORY_TYPES] }, content: { type: "string" }, personRef: { type: ["string", "null"] }, topicRef: { type: ["string", "null"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, evidenceSegmentIds: { type: "array", items: { type: "string" } } } } },
        todos: { type: "array", items: { type: "object", additionalProperties: false, required: ["content", "ownerRef", "dueDate", "topicRef", "evidenceSegmentIds"], properties: { content: { type: "string" }, ownerRef: { type: ["string", "null"] }, dueDate: { type: ["string", "null"] }, topicRef: { type: ["string", "null"] }, evidenceSegmentIds: { type: "array", items: { type: "string" } } } } },
        decisions: { type: "array", items: { type: "string" } },
        suggestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["content", "reason"], properties: { content: { type: "string" }, reason: { type: "string" } } } },
      },
    },
  },
};

module.exports = { validateAnalysisPayload, ANALYSIS_TOOL };
