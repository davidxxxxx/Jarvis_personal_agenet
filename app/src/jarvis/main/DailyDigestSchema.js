const DAILY_DIGEST_SCHEMA_VERSION = "jarvis-daily-digest-v1";
const MAX_COLLECTION_ITEMS = 100;
const MAX_EVIDENCE_ITEMS = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const ALLOWED_ACTIONS = Object.freeze(["accept", "dismiss", "convert_to_todo"]);
const ALLOWED_ACTION_SET = new Set(ALLOWED_ACTIONS);
const ALLOWED_MISSING_STAGES = new Set([
  "transcription",
  "speaker_identity",
  "session_analysis",
  "memory_resolution",
  "upstream_processing",
]);
const COVERAGE_KEYS = Object.freeze([
  "selectedSegmentCount",
  "incompleteSegmentCount",
  "sessionCount",
  "startsAt",
  "endsAt",
]);

class DailyDigestSchemaError extends Error {
  constructor(issueCode) {
    super("Daily digest response failed validation");
    this.name = "DailyDigestSchemaError";
    this.code = "invalid_structure";
    this.retryable = false;
    this.issueCode = issueCode;
  }
}

function fail(issueCode) {
  throw new DailyDigestSchemaError(issueCode);
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

function isAutomaticActionDirective(value) {
  const sentences = value.split(/[.!?。！？;；]+/u).filter((sentence) => sentence.trim());
  return sentences.some((sentence) => {
    const englishAction = /\b(?:create|add|write|schedule|send|post|convert|update|delete|remove|complete|mark)\b[^\n]{0,180}\b(?:todos?|tasks?|calendars?|events?|messages?|emails?)\b/iu;
    const englishMarker =
      /\b(?:auto(?:matically)?|immediately)\b|\bwithout\s+(?:asking|(?:user\s+)?confirmation)\b/iu;
    const englishActionIndex = sentence.search(
      /\b(?:create|add|write|schedule|send|post|convert|update|delete|remove|complete|mark)\b/iu
    );
    if (englishAction.test(sentence) && englishMarker.test(sentence)) {
      const beforeAction = englishActionIndex < 0 ? "" : sentence.slice(0, englishActionIndex);
      const negated =
        /\b(?:do\s+not|don't|never|must\s+not|should\s+not)\b/iu.test(beforeAction);
      const descriptive =
        /\b(?:document(?:ed|ing)?|describe(?:d|ing)?|explain(?:ed|ing)?|discuss(?:ed|ing)?|show(?:ed|ing)?|learn(?:ed|ing)?|teach(?:es|ing)?|taught|write|wrote)\b[^\n]{0,100}\bhow\s+to\b/iu.test(
          beforeAction
        );
      if (!negated && !descriptive) return true;
    }

    const chineseAction = /(?:创建|添加|写入|安排|发送|转换|转为|更新|删除|移除|完成|标记)[^\n]{0,80}(?:待办|任务|日历|事件|消息|邮件)/u;
    const chineseMarker = /(?:自动|立即|无需(?:用户)?确认|未经(?:用户)?确认|无需询问)/u;
    if (chineseAction.test(sentence) && chineseMarker.test(sentence)) {
      const actionIndex = sentence.search(
        /(?:创建|添加|写入|安排|发送|转换|转为|更新|删除|移除|完成|标记)/u
      );
      const beforeAction = actionIndex < 0 ? "" : sentence.slice(0, actionIndex);
      const negated = /(?:不会|不应|不能|不该|不可以|不要|不得|切勿|禁止)/u.test(
        beforeAction
      );
      const descriptive = /(?:讨论|记录|描述|解释|说明|记载)[^\n]{0,60}如何/u.test(
        beforeAction
      );
      if (!negated && !descriptive) return true;
    }
    return false;
  });
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
  if (isAutomaticActionDirective(value)) fail("schema.automatic_action");
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

function validateCoverage(value, issueCode) {
  const coverage = exactObject(value, COVERAGE_KEYS, issueCode);
  for (const key of COVERAGE_KEYS) {
    if (!Number.isSafeInteger(coverage[key]) || coverage[key] < 0) fail(issueCode);
  }
  if (
    coverage.selectedSegmentCount < 1 ||
    coverage.sessionCount < 1 ||
    coverage.startsAt >= coverage.endsAt
  ) {
    fail(issueCode);
  }
  return {
    selectedSegmentCount: coverage.selectedSegmentCount,
    incompleteSegmentCount: coverage.incompleteSegmentCount,
    sessionCount: coverage.sessionCount,
    startsAt: coverage.startsAt,
    endsAt: coverage.endsAt,
  };
}

function normalizeContext(context) {
  let input;
  try {
    input = exactObject(
      context,
      [
        "allowedSegmentIds",
        "allowedSubjectRefs",
        "subjectEvidenceByRef",
        "completeness",
        "transcriptCoverage",
      ],
      "schema.validation_context"
    );
  } catch (error) {
    if (error instanceof DailyDigestSchemaError) fail("schema.validation_context");
    throw error;
  }
  if (
    !(input.allowedSegmentIds instanceof Set) ||
    !(input.allowedSubjectRefs instanceof Set) ||
    !(input.subjectEvidenceByRef instanceof Map) ||
    input.allowedSegmentIds.size < 1 ||
    input.allowedSubjectRefs.size < 1 ||
    input.subjectEvidenceByRef.size !== input.allowedSubjectRefs.size ||
    ![...input.allowedSegmentIds].every((id) => typeof id === "string" && id.length > 0) ||
    ![...input.allowedSubjectRefs].every((id) => typeof id === "string" && id.length > 0) ||
    [...input.subjectEvidenceByRef].some(
      ([subjectRef, evidence]) =>
        !input.allowedSubjectRefs.has(subjectRef) ||
        !(evidence instanceof Set) ||
        evidence.size < 1 ||
        [...evidence].some((segmentId) => !input.allowedSegmentIds.has(segmentId))
    ) ||
    [...input.allowedSubjectRefs].some((subjectRef) => !input.subjectEvidenceByRef.has(subjectRef)) ||
    !new Set(["partial", "final"]).has(input.completeness)
  ) {
    fail("schema.validation_context");
  }
  let transcriptCoverage;
  try {
    transcriptCoverage = validateCoverage(input.transcriptCoverage, "schema.validation_context");
  } catch (error) {
    if (error instanceof DailyDigestSchemaError) fail("schema.validation_context");
    throw error;
  }
  if (
    transcriptCoverage.selectedSegmentCount !== input.allowedSegmentIds.size ||
    (input.completeness === "final" && transcriptCoverage.incompleteSegmentCount !== 0)
  ) {
    fail("schema.validation_context");
  }
  return {
    allowedSegmentIds: input.allowedSegmentIds,
    allowedSubjectRefs: input.allowedSubjectRefs,
    subjectEvidenceByRef: input.subjectEvidenceByRef,
    completeness: input.completeness,
    transcriptCoverage,
  };
}

function factualItems(value, field, allowedSegmentIds) {
  return collection(value, field).map((raw) => {
    const item = exactObject(raw, ["text", "evidenceSegmentIds"]);
    return {
      text: boundedString(item.text, 4_000),
      evidenceSegmentIds: evidenceIds(item.evidenceSegmentIds, {
        required: true,
        allowedSegmentIds,
      }),
    };
  });
}

function sameCoverage(left, right) {
  return COVERAGE_KEYS.every((key) => left[key] === right[key]);
}

function validateCandidateDailyDigest(payload, context) {
  const normalizedContext = normalizeContext(context);
  let serializedBytes;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    fail("schema.top_level_type");
  }
  if (serializedBytes > MAX_RESPONSE_BYTES) fail("schema.response_too_large");

  const input = exactObject(
    payload,
    ["schemaVersion", "sections", "processing"],
    "schema.top_level_type"
  );
  if (input.schemaVersion !== DAILY_DIGEST_SCHEMA_VERSION) fail("schema.version");
  const rawSections = exactObject(input.sections, [
    "today",
    "interactions",
    "topicsAndDecisions",
    "commitmentsAndTodos",
    "worthRemembering",
    "tomorrowSuggestions",
  ]);

  const sections = {
    today: factualItems(rawSections.today, "today", normalizedContext.allowedSegmentIds),
    interactions: collection(rawSections.interactions, "interactions").map((raw) => {
      const item = exactObject(raw, ["subjectRef", "text", "evidenceSegmentIds"]);
      if (
        typeof item.subjectRef !== "string" ||
        !normalizedContext.allowedSubjectRefs.has(item.subjectRef)
      ) {
        fail("schema.subject_out_of_scope");
      }
      const normalizedEvidence = evidenceIds(item.evidenceSegmentIds, {
        required: true,
        allowedSegmentIds: normalizedContext.allowedSegmentIds,
      });
      const subjectEvidence = normalizedContext.subjectEvidenceByRef.get(item.subjectRef);
      if (normalizedEvidence.some((segmentId) => !subjectEvidence.has(segmentId))) {
        fail("schema.interaction_evidence_out_of_scope");
      }
      return {
        subjectRef: item.subjectRef,
        text: boundedString(item.text, 4_000),
        evidenceSegmentIds: normalizedEvidence,
      };
    }),
    topicsAndDecisions: factualItems(
      rawSections.topicsAndDecisions,
      "topicsAndDecisions",
      normalizedContext.allowedSegmentIds
    ),
    commitmentsAndTodos: factualItems(
      rawSections.commitmentsAndTodos,
      "commitmentsAndTodos",
      normalizedContext.allowedSegmentIds
    ),
    worthRemembering: factualItems(
      rawSections.worthRemembering,
      "worthRemembering",
      normalizedContext.allowedSegmentIds
    ),
    tomorrowSuggestions: collection(
      rawSections.tomorrowSuggestions,
      "tomorrowSuggestions"
    ).map((raw) => {
      const item = exactObject(raw, [
        "text",
        "rationale",
        "evidenceSegmentIds",
        "allowedActions",
      ]);
      if (!Array.isArray(item.allowedActions)) fail("schema.actions_type");
      if (item.allowedActions.length === 0) fail("schema.actions_empty");
      if (new Set(item.allowedActions).size !== item.allowedActions.length) {
        fail("schema.actions_duplicate");
      }
      if (item.allowedActions.some((action) => !ALLOWED_ACTION_SET.has(action))) {
        fail("schema.action_unsupported");
      }
      return {
        text: boundedString(item.text, 500),
        rationale: boundedString(item.rationale, 4_000),
        evidenceSegmentIds: evidenceIds(item.evidenceSegmentIds, {
          required: false,
          allowedSegmentIds: normalizedContext.allowedSegmentIds,
        }),
        allowedActions: [...item.allowedActions],
      };
    }),
  };

  const rawProcessing = exactObject(input.processing, [
    "completeness",
    "missingStages",
    "transcriptCoverage",
  ]);
  if (rawProcessing.completeness !== normalizedContext.completeness) {
    fail("schema.completeness_mismatch");
  }
  if (!Array.isArray(rawProcessing.missingStages)) fail("schema.missing_stages_type");
  if (rawProcessing.missingStages.length > 16) fail("schema.missing_stages_count");
  if (new Set(rawProcessing.missingStages).size !== rawProcessing.missingStages.length) {
    fail("schema.missing_stages_duplicate");
  }
  if (
    rawProcessing.missingStages.some(
      (stage) => typeof stage !== "string" || !ALLOWED_MISSING_STAGES.has(stage)
    )
  ) {
    fail("schema.missing_stage_unsupported");
  }
  if (
    (normalizedContext.completeness === "final" && rawProcessing.missingStages.length !== 0) ||
    (normalizedContext.completeness === "partial" && rawProcessing.missingStages.length === 0)
  ) {
    fail("schema.missing_stages_mismatch");
  }
  const transcriptCoverage = validateCoverage(
    rawProcessing.transcriptCoverage,
    "schema.coverage"
  );
  if (!sameCoverage(transcriptCoverage, normalizedContext.transcriptCoverage)) {
    fail("schema.coverage_mismatch");
  }

  return {
    schemaVersion: DAILY_DIGEST_SCHEMA_VERSION,
    sections,
    processing: {
      completeness: normalizedContext.completeness,
      missingStages: [...rawProcessing.missingStages],
      transcriptCoverage,
    },
  };
}

const evidenceArraySchema = (minItems) => ({
  type: "array",
  minItems,
  maxItems: MAX_EVIDENCE_ITEMS,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 512 },
});

const factualItemSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text", "evidenceSegmentIds"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 4_000 },
    evidenceSegmentIds: evidenceArraySchema(1),
  },
});

const DAILY_DIGEST_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "submit_jarvis_daily_digest",
    description: "Return an evidence-grounded daily digest for supplied pseudonymous evidence.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "sections", "processing"],
      properties: {
        schemaVersion: { const: DAILY_DIGEST_SCHEMA_VERSION },
        sections: {
          type: "object",
          additionalProperties: false,
          required: [
            "today",
            "interactions",
            "topicsAndDecisions",
            "commitmentsAndTodos",
            "worthRemembering",
            "tomorrowSuggestions",
          ],
          properties: {
            today: { type: "array", maxItems: MAX_COLLECTION_ITEMS, items: factualItemSchema },
            interactions: {
              type: "array",
              maxItems: MAX_COLLECTION_ITEMS,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["subjectRef", "text", "evidenceSegmentIds"],
                properties: {
                  subjectRef: { type: "string", minLength: 1, maxLength: 512 },
                  text: { type: "string", minLength: 1, maxLength: 4_000 },
                  evidenceSegmentIds: evidenceArraySchema(1),
                },
              },
            },
            topicsAndDecisions: {
              type: "array",
              maxItems: MAX_COLLECTION_ITEMS,
              items: factualItemSchema,
            },
            commitmentsAndTodos: {
              type: "array",
              maxItems: MAX_COLLECTION_ITEMS,
              items: factualItemSchema,
            },
            worthRemembering: {
              type: "array",
              maxItems: MAX_COLLECTION_ITEMS,
              items: factualItemSchema,
            },
            tomorrowSuggestions: {
              type: "array",
              maxItems: MAX_COLLECTION_ITEMS,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "rationale", "evidenceSegmentIds", "allowedActions"],
                properties: {
                  text: { type: "string", minLength: 1, maxLength: 500 },
                  rationale: { type: "string", minLength: 1, maxLength: 4_000 },
                  evidenceSegmentIds: evidenceArraySchema(0),
                  allowedActions: {
                    type: "array",
                    minItems: 1,
                    maxItems: ALLOWED_ACTIONS.length,
                    uniqueItems: true,
                    items: { type: "string", enum: ALLOWED_ACTIONS },
                  },
                },
              },
            },
          },
        },
        processing: {
          type: "object",
          additionalProperties: false,
          required: ["completeness", "missingStages", "transcriptCoverage"],
          properties: {
            completeness: { type: "string", enum: ["partial", "final"] },
            missingStages: {
              type: "array",
              maxItems: 16,
              uniqueItems: true,
              items: { type: "string", enum: [...ALLOWED_MISSING_STAGES] },
            },
            transcriptCoverage: {
              type: "object",
              additionalProperties: false,
              required: COVERAGE_KEYS,
              properties: Object.fromEntries(
                COVERAGE_KEYS.map((key) => [key, { type: "integer", minimum: 0 }])
              ),
            },
          },
        },
      },
    },
  },
});

module.exports = {
  ALLOWED_ACTIONS,
  DAILY_DIGEST_TOOL,
  DailyDigestSchemaError,
  DAILY_DIGEST_SCHEMA_VERSION,
  validateCandidateDailyDigest,
};
