const crypto = require("node:crypto");

const CANONICAL_ALGORITHM = "canonical-v1";
const TOPIC_SIMILARITY_ALGORITHM = "dice-bigram-v1";
const TOPIC_SIMILARITY_THRESHOLD = 0.72;
const EVENT_DEDUPE_WINDOW_MS = 30 * 60 * 1_000;
const CANDIDATE_MEMORY_KINDS = new Set([
  "fact",
  "event",
  "decision",
  "commitment",
  "preference",
  "relationship",
]);
const EXISTING_MEMORY_KINDS = new Set([...CANDIDATE_MEMORY_KINDS, "opinion"]);
const SUBJECT_KINDS = new Set(["person", "speaker_cluster"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

class MemoryMergerValidationError extends Error {
  constructor(issueCode) {
    super("Memory merger input failed validation");
    this.name = "MemoryMergerValidationError";
    this.code = "MEMORY_MERGER_INVALID_INPUT";
    this.issueCode = issueCode;
  }
}

function validationFail(issueCode) {
  throw new MemoryMergerValidationError(issueCode);
}

function plainObject(value, issueCode) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    validationFail(issueCode);
  }
  return value;
}

function exactObject(value, keys, issueCode) {
  const object = plainObject(value, issueCode);
  const expected = new Set(keys);
  if (
    Object.keys(object).some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    validationFail(issueCode);
  }
  return object;
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function requireId(value, issueCode) {
  if (!validId(value)) validationFail(issueCode);
  return value;
}

function requireText(value, issueCode) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    validationFail(issueCode);
  }
  return value;
}

function requireNullableText(value, issueCode) {
  if (value !== null) requireText(value, issueCode);
  return value;
}

function requireHash(value, issueCode) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) validationFail(issueCode);
  return value;
}

function requireInteger(value, issueCode) {
  if (!Number.isSafeInteger(value) || value < 0) validationFail(issueCode);
  return value;
}

function requireArray(value, issueCode) {
  if (!Array.isArray(value)) validationFail(issueCode);
  return value;
}

function validateIdSet(value, { issueCode, allowEmpty }) {
  const ids = requireArray(value, issueCode);
  if (!allowEmpty && ids.length === 0) {
    validationFail(issueCode === "untrusted_replacement" ? issueCode : "factual_zero_evidence");
  }
  if (ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    validationFail(issueCode);
  }
  return ids;
}

function canonicalizeText(value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  return value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();
}

function canonicalTupleHash(tuple) {
  if (!Array.isArray(tuple)) throw new TypeError("tuple must be an array");
  return crypto.createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, (point) => point.codePointAt(0));
  const rightPoints = Array.from(right, (point) => point.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeStringSet(values, fieldName = "values") {
  if (!Array.isArray(values)) throw new TypeError(`${fieldName} must be an array`);
  const normalized = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new TypeError(`${fieldName} must contain non-empty strings`);
    }
    normalized.add(value);
  }
  return [...normalized].sort(compareCodePoints);
}

function diceBigramScore(left, right) {
  const leftText = canonicalizeText(left);
  const rightText = canonicalizeText(right);
  if (leftText === rightText) return 1;
  const bigrams = (value) => {
    const points = Array.from(value);
    const result = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      result.push(`${points[index]}${points[index + 1]}`);
    }
    return result;
  };
  const leftBigrams = bigrams(leftText);
  const rightBigrams = bigrams(rightText);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const available = new Map();
  for (const bigram of leftBigrams) available.set(bigram, (available.get(bigram) ?? 0) + 1);
  let intersection = 0;
  for (const bigram of rightBigrams) {
    const count = available.get(bigram) ?? 0;
    if (count === 0) continue;
    intersection += 1;
    available.set(bigram, count - 1);
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function roundSix(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function diceBigramSimilarity(left, right) {
  return roundSix(diceBigramScore(left, right));
}

function compareCanonicalItems(left, right) {
  return (
    compareCodePoints(left.canonicalHash, right.canonicalHash) ||
    compareCodePoints(
      canonicalTupleHash(left.semanticTuple),
      canonicalTupleHash(right.semanticTuple)
    ) ||
    compareCodePoints(
      JSON.stringify(left.displayTuple ?? []),
      JSON.stringify(right.displayTuple ?? [])
    )
  );
}

function canonicalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("candidate must be an object");
  }

  const sessionSummary = {
    ...candidate.sessionSummary,
    normalizedTitle: canonicalizeText(candidate.sessionSummary.title),
    normalizedSummary: canonicalizeText(candidate.sessionSummary.summary),
    evidenceSegmentIds: normalizeStringSet(
      candidate.sessionSummary.evidenceSegmentIds,
      "sessionSummary.evidenceSegmentIds"
    ),
  };
  sessionSummary.semanticTuple = [
    "session_summary",
    sessionSummary.normalizedTitle,
    sessionSummary.normalizedSummary,
    sessionSummary.evidenceSegmentIds,
  ];

  const memories = candidate.memories
    .map((memory) => {
      const normalizedTitle = canonicalizeText(memory.title);
      const normalizedBody = canonicalizeText(memory.body);
      const canonicalTuple = ["memory", memory.kind, normalizedTitle, []];
      const evidenceSegmentIds = normalizeStringSet(
        memory.evidenceSegmentIds,
        "memory.evidenceSegmentIds"
      );
      return {
        ...memory,
        normalizedTitle,
        normalizedBody,
        evidenceSegmentIds,
        canonicalTuple,
        canonicalHash: canonicalTupleHash(canonicalTuple),
        semanticTuple: [canonicalTuple, normalizedBody, memory.confidence, evidenceSegmentIds],
        displayTuple: ["memory", memory.kind, memory.title, memory.body, memory.confidence],
      };
    })
    .sort(compareCanonicalItems);

  const topics = candidate.topics
    .map((topic) => {
      const normalizedName = canonicalizeText(topic.name);
      const normalizedSummary = canonicalizeText(topic.summary);
      const canonicalTuple = ["topic", normalizedName];
      const evidenceSegmentIds = normalizeStringSet(
        topic.evidenceSegmentIds,
        "topic.evidenceSegmentIds"
      );
      return {
        ...topic,
        normalizedName,
        normalizedSummary,
        evidenceSegmentIds,
        canonicalTuple,
        canonicalHash: canonicalTupleHash(canonicalTuple),
        semanticTuple: [canonicalTuple, normalizedSummary, evidenceSegmentIds],
        displayTuple: ["topic", topic.name, topic.summary],
      };
    })
    .sort(compareCanonicalItems);

  const todos = candidate.todos
    .map((todo) => {
      const normalizedTitle = canonicalizeText(todo.title);
      const normalizedDueText = todo.dueText === null ? null : canonicalizeText(todo.dueText);
      const canonicalTuple = ["todo", normalizedTitle, todo.ownerLabel];
      const evidenceSegmentIds = normalizeStringSet(
        todo.evidenceSegmentIds,
        "todo.evidenceSegmentIds"
      );
      return {
        ...todo,
        normalizedTitle,
        normalizedDueText,
        evidenceSegmentIds,
        canonicalTuple,
        canonicalHash: canonicalTupleHash(canonicalTuple),
        semanticTuple: [canonicalTuple, normalizedDueText, evidenceSegmentIds],
        displayTuple: ["todo", todo.title, todo.ownerLabel, todo.dueText],
      };
    })
    .sort(compareCanonicalItems);

  const suggestions = candidate.suggestions
    .map((suggestion) => {
      const normalizedTitle = canonicalizeText(suggestion.title);
      const normalizedRationale = canonicalizeText(suggestion.rationale);
      const canonicalTuple = ["suggestion", normalizedTitle, normalizedRationale];
      const basedOnEvidenceSegmentIds = normalizeStringSet(
        suggestion.basedOnEvidenceSegmentIds,
        "suggestion.basedOnEvidenceSegmentIds"
      );
      return {
        ...suggestion,
        normalizedTitle,
        normalizedRationale,
        basedOnEvidenceSegmentIds,
        canonicalTuple,
        canonicalHash: canonicalTupleHash(canonicalTuple),
        semanticTuple: [canonicalTuple, basedOnEvidenceSegmentIds],
        displayTuple: ["suggestion", suggestion.title, suggestion.rationale],
      };
    })
    .sort(compareCanonicalItems);

  return {
    schemaVersion: candidate.schemaVersion,
    sessionSummary,
    memories,
    topics,
    todos,
    suggestions,
  };
}

function semanticCandidateHash(candidate) {
  const canonical = canonicalizeCandidate(candidate);
  return canonicalTupleHash([
    "semantic_candidate",
    canonical.schemaVersion,
    canonical.sessionSummary.semanticTuple,
    canonical.memories.map((memory) => memory.semanticTuple),
    canonical.topics.map((topic) => topic.semanticTuple),
    canonical.todos.map((todo) => todo.semanticTuple),
    canonical.suggestions.map((suggestion) => suggestion.semanticTuple),
  ]);
}

function compareActions(left, right) {
  return compareCodePoints(JSON.stringify(left), JSON.stringify(right));
}

function dedupeCandidateItems(
  items,
  entityKind,
  identityOf = (item) => item.semanticFingerprint,
  evidenceField = null
) {
  const groups = new Map();
  for (const item of items) {
    const identity = identityOf(item);
    const group = groups.get(identity) ?? [];
    group.push(item);
    groups.set(identity, group);
  }
  const unique = [];
  const ignored = [];
  for (const group of groups.values()) {
    const selected = { ...group[0] };
    if (evidenceField !== null) {
      selected[evidenceField] = normalizeStringSet(
        group.flatMap((item) => item[evidenceField]),
        `${entityKind}.${evidenceField}`
      );
    }
    unique.push(selected);
    if (group.length > 1) {
      ignored.push({
        entityKind,
        canonicalKey: selected.planCanonicalKey,
        semanticFingerprint: selected.semanticFingerprint,
        reason: "candidate_internal_duplicate",
        ignoredCount: group.length - 1,
      });
    }
  }
  return { unique, ignored };
}

function convergeMemoryCandidates(items, segmentById) {
  const ordinary = dedupeCandidateItems(
    items.filter((item) => item.kind !== "event"),
    "memory",
    (memory) => memory.canonicalValueKey,
    "evidenceSegmentIds"
  );
  const eventGroups = new Map();
  for (const item of items.filter((candidate) => candidate.kind === "event")) {
    const group = eventGroups.get(item.canonicalValueKey) ?? [];
    group.push(item);
    eventGroups.set(item.canonicalValueKey, group);
  }

  const uniqueEvents = [];
  const ignoredEvents = [];
  for (const group of eventGroups.values()) {
    const intervals = group
      .map((item) => {
        const segments = item.evidenceSegmentIds.map((segmentId) => segmentById.get(segmentId));
        return {
          item,
          startedAt: Math.min(...segments.map((segment) => segment.startedAt)),
          endedAt: Math.max(...segments.map((segment) => segment.endedAt)),
        };
      })
      .sort(
        (left, right) =>
          left.startedAt - right.startedAt ||
          left.endedAt - right.endedAt ||
          compareCanonicalItems(left.item, right.item)
      );
    const clusters = [];
    for (const interval of intervals) {
      const cluster = clusters.at(-1);
      if (!cluster || interval.startedAt - cluster.endedAt > EVENT_DEDUPE_WINDOW_MS) {
        clusters.push({
          startedAt: interval.startedAt,
          endedAt: interval.endedAt,
          items: [interval.item],
        });
        continue;
      }
      cluster.endedAt = Math.max(cluster.endedAt, interval.endedAt);
      cluster.items.push(interval.item);
    }

    for (const [eventClusterIndex, cluster] of clusters.entries()) {
      const members = [...cluster.items].sort(compareCanonicalItems);
      const selected = {
        ...members[0],
        evidenceSegmentIds: normalizeStringSet(
          members.flatMap((item) => item.evidenceSegmentIds),
          "memory.evidenceSegmentIds"
        ),
        eventClusterIndex,
      };
      uniqueEvents.push(selected);
      if (members.length > 1) {
        ignoredEvents.push({
          entityKind: "memory",
          canonicalKey: selected.planCanonicalKey,
          semanticFingerprint: selected.semanticFingerprint,
          reason: "candidate_internal_duplicate",
          ignoredCount: members.length - 1,
        });
      }
    }
  }

  return {
    unique: [...ordinary.unique, ...uniqueEvents],
    ignored: [...ordinary.ignored, ...ignoredEvents].sort(compareActions),
  };
}

function validateCandidate(candidate) {
  const input = exactObject(
    candidate,
    ["schemaVersion", "sessionSummary", "memories", "topics", "todos", "suggestions"],
    "malformed_candidate"
  );
  if (input.schemaVersion !== "jarvis-analysis-v2") validationFail("malformed_candidate");
  const summary = exactObject(
    input.sessionSummary,
    ["title", "summary", "evidenceSegmentIds"],
    "malformed_candidate"
  );
  requireText(summary.title, "malformed_candidate");
  requireText(summary.summary, "malformed_candidate");
  validateIdSet(summary.evidenceSegmentIds, {
    issueCode: "malformed_candidate",
    allowEmpty: false,
  });

  for (const memory of requireArray(input.memories, "malformed_candidate")) {
    const item = exactObject(
      memory,
      ["kind", "title", "body", "confidence", "evidenceSegmentIds"],
      "malformed_candidate"
    );
    if (!CANDIDATE_MEMORY_KINDS.has(item.kind)) validationFail("unknown_entity_kind");
    requireText(item.title, "malformed_candidate");
    requireText(item.body, "malformed_candidate");
    if (
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      validationFail("malformed_candidate");
    }
    validateIdSet(item.evidenceSegmentIds, {
      issueCode: "malformed_candidate",
      allowEmpty: false,
    });
  }
  for (const topic of requireArray(input.topics, "malformed_candidate")) {
    const item = exactObject(
      topic,
      ["name", "summary", "evidenceSegmentIds"],
      "malformed_candidate"
    );
    requireText(item.name, "malformed_candidate");
    requireText(item.summary, "malformed_candidate");
    validateIdSet(item.evidenceSegmentIds, {
      issueCode: "malformed_candidate",
      allowEmpty: false,
    });
  }
  for (const todo of requireArray(input.todos, "malformed_candidate")) {
    const item = exactObject(
      todo,
      ["title", "ownerLabel", "dueText", "evidenceSegmentIds"],
      "malformed_candidate"
    );
    requireText(item.title, "malformed_candidate");
    if (item.ownerLabel !== null) requireId(item.ownerLabel, "malformed_candidate");
    requireNullableText(item.dueText, "malformed_candidate");
    validateIdSet(item.evidenceSegmentIds, {
      issueCode: "malformed_candidate",
      allowEmpty: false,
    });
  }
  for (const suggestion of requireArray(input.suggestions, "malformed_candidate")) {
    const item = exactObject(
      suggestion,
      ["title", "rationale", "basedOnEvidenceSegmentIds"],
      "malformed_candidate"
    );
    requireText(item.title, "malformed_candidate");
    requireText(item.rationale, "malformed_candidate");
    validateIdSet(item.basedOnEvidenceSegmentIds, {
      issueCode: "malformed_candidate",
      allowEmpty: true,
    });
  }
  return input;
}

function validateEvidence(analysisInput, evidence, candidate) {
  const identity = exactObject(analysisInput, ["id", "sessionId"], "malformed_input");
  requireId(identity.id, "malformed_input");
  requireId(identity.sessionId, "malformed_input");
  const localEvidence = exactObject(evidence, ["segments", "bindings"], "malformed_evidence");
  const segmentIds = new Set();
  const segmentById = new Map();
  for (const segment of requireArray(localEvidence.segments, "malformed_evidence")) {
    const row = exactObject(
      segment,
      ["id", "sessionId", "startedAt", "endedAt", "speakerLabel"],
      "malformed_evidence"
    );
    requireId(row.id, "malformed_evidence");
    requireId(row.sessionId, "malformed_evidence");
    if (segmentIds.has(row.id)) validationFail("malformed_evidence");
    segmentIds.add(row.id);
    if (row.sessionId !== identity.sessionId) validationFail("cross_session_evidence");
    requireInteger(row.startedAt, "invalid_interval");
    requireInteger(row.endedAt, "invalid_interval");
    if (row.endedAt < row.startedAt) validationFail("invalid_interval");
    if (row.speakerLabel !== null) requireId(row.speakerLabel, "malformed_evidence");
    segmentById.set(row.id, row);
  }

  const bindingByLabel = new Map();
  for (const binding of requireArray(localEvidence.bindings, "malformed_evidence")) {
    const row = exactObject(binding, ["label", "subjectKind", "subjectId"], "malformed_evidence");
    requireId(row.label, "malformed_evidence");
    requireId(row.subjectId, "malformed_evidence");
    if (!SUBJECT_KINDS.has(row.subjectKind) || bindingByLabel.has(row.label)) {
      validationFail("malformed_evidence");
    }
    bindingByLabel.set(row.label, row);
  }
  for (const segment of segmentById.values()) {
    if (segment.speakerLabel !== null && !bindingByLabel.has(segment.speakerLabel)) {
      validationFail("missing_binding");
    }
  }
  for (const todo of candidate.todos) {
    if (todo.ownerLabel !== null && !bindingByLabel.has(todo.ownerLabel)) {
      validationFail("missing_binding");
    }
  }
  const candidateEvidenceSets = [
    candidate.sessionSummary.evidenceSegmentIds,
    ...candidate.memories.map((item) => item.evidenceSegmentIds),
    ...candidate.topics.map((item) => item.evidenceSegmentIds),
    ...candidate.todos.map((item) => item.evidenceSegmentIds),
    ...candidate.suggestions.map((item) => item.basedOnEvidenceSegmentIds),
  ];
  for (const ids of candidateEvidenceSets) {
    if (ids.some((id) => !segmentById.has(id))) validationFail("missing_evidence");
  }
  return { identity, localEvidence, segmentById, bindingByLabel };
}

function validateExisting(existing) {
  const snapshot = exactObject(
    existing,
    [
      "memories",
      "topics",
      "topicMergeSuggestions",
      "todos",
      "suggestions",
      "memorySupersessions",
      "todoRecurrences",
    ],
    "malformed_existing"
  );
  for (const key of Object.keys(snapshot)) requireArray(snapshot[key], "malformed_existing");

  const memoryIds = new Set();
  const memoryValueKeys = new Set();
  const memoryOccurrenceIds = new Set();
  for (const memory of snapshot.memories) {
    const row = exactObject(
      memory,
      [
        "id",
        "kind",
        "canonicalSlotKey",
        "canonicalValueKey",
        "title",
        "body",
        "lifecycle",
        "relatedSubjects",
        "occurrences",
      ],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    if (memoryIds.has(row.id) || !EXISTING_MEMORY_KINDS.has(row.kind)) {
      validationFail("malformed_existing");
    }
    memoryIds.add(row.id);
    requireHash(row.canonicalSlotKey, "malformed_existing");
    requireHash(row.canonicalValueKey, "malformed_existing");
    if (memoryValueKeys.has(row.canonicalValueKey)) validationFail("malformed_existing");
    memoryValueKeys.add(row.canonicalValueKey);
    requireText(row.title, "malformed_existing");
    requireText(row.body, "malformed_existing");
    if (!["active", "superseded", "conflict", "dismissed"].includes(row.lifecycle)) {
      validationFail("malformed_existing");
    }
    const subjectKeys = new Set();
    const relatedSubjectIds = [];
    for (const subject of requireArray(row.relatedSubjects, "malformed_existing")) {
      const item = exactObject(subject, ["subjectKind", "subjectId"], "malformed_existing");
      if (!SUBJECT_KINDS.has(item.subjectKind)) validationFail("malformed_existing");
      requireId(item.subjectId, "malformed_existing");
      const subjectKey = `${item.subjectKind}\0${item.subjectId}`;
      if (subjectKeys.has(subjectKey)) validationFail("malformed_existing");
      subjectKeys.add(subjectKey);
      relatedSubjectIds.push(item.subjectId);
    }
    const expectedSlotKey = canonicalTupleHash([
      "memory",
      row.kind,
      canonicalizeText(row.title),
      normalizeStringSet(relatedSubjectIds, "existing.memory.relatedSubjectIds"),
    ]);
    const expectedValueKey = canonicalTupleHash([
      "memory_value",
      expectedSlotKey,
      canonicalizeText(row.body),
    ]);
    if (row.canonicalSlotKey !== expectedSlotKey || row.canonicalValueKey !== expectedValueKey) {
      validationFail("malformed_existing");
    }
    for (const occurrence of requireArray(row.occurrences, "malformed_existing")) {
      const item = exactObject(
        occurrence,
        ["id", "startedAt", "endedAt", "evidenceSegmentIds"],
        "malformed_existing"
      );
      requireId(item.id, "malformed_existing");
      if (memoryOccurrenceIds.has(item.id)) validationFail("malformed_existing");
      memoryOccurrenceIds.add(item.id);
      requireInteger(item.startedAt, "malformed_existing");
      requireInteger(item.endedAt, "malformed_existing");
      if (item.endedAt < item.startedAt) validationFail("malformed_existing");
      validateIdSet(item.evidenceSegmentIds, {
        issueCode: "malformed_existing",
        allowEmpty: true,
      });
    }
  }

  const topicIds = new Set();
  const topicKeys = new Set();
  const topicRevisionIds = new Set();
  const topicOccurrenceIds = new Set();
  for (const topic of snapshot.topics) {
    const row = exactObject(
      topic,
      ["id", "canonicalKey", "name", "lifecycle", "revisions", "occurrences"],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    if (topicIds.has(row.id)) validationFail("malformed_existing");
    topicIds.add(row.id);
    requireHash(row.canonicalKey, "malformed_existing");
    if (topicKeys.has(row.canonicalKey)) validationFail("malformed_existing");
    topicKeys.add(row.canonicalKey);
    requireText(row.name, "malformed_existing");
    if (!["active", "superseded", "dismissed"].includes(row.lifecycle)) {
      validationFail("malformed_existing");
    }
    if (row.canonicalKey !== canonicalTupleHash(["topic", canonicalizeText(row.name)])) {
      validationFail("malformed_existing");
    }
    const revisions = requireArray(row.revisions, "malformed_existing");
    if (revisions.length === 0) validationFail("malformed_existing");
    const revisionIds = new Set();
    const revisionNumbers = new Set();
    for (const revision of revisions) {
      const item = exactObject(revision, ["id", "revision", "summary"], "malformed_existing");
      requireId(item.id, "malformed_existing");
      if (
        topicRevisionIds.has(item.id) ||
        revisionNumbers.has(item.revision) ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      ) {
        validationFail("malformed_existing");
      }
      revisionIds.add(item.id);
      topicRevisionIds.add(item.id);
      revisionNumbers.add(item.revision);
      if (typeof item.summary !== "string") validationFail("malformed_existing");
    }
    for (const occurrence of requireArray(row.occurrences, "malformed_existing")) {
      const item = exactObject(
        occurrence,
        ["id", "revisionId", "evidenceSegmentIds"],
        "malformed_existing"
      );
      requireId(item.id, "malformed_existing");
      if (topicOccurrenceIds.has(item.id) || !revisionIds.has(item.revisionId)) {
        validationFail("malformed_existing");
      }
      topicOccurrenceIds.add(item.id);
      validateIdSet(item.evidenceSegmentIds, {
        issueCode: "malformed_existing",
        allowEmpty: true,
      });
    }
  }

  const topicMergeIds = new Set();
  const topicMergePairs = new Set();
  for (const suggestion of snapshot.topicMergeSuggestions) {
    const row = exactObject(
      suggestion,
      ["id", "leftTopicId", "rightTopicId", "algorithmVersion", "score", "state"],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    const pairKey = `${row.leftTopicId}\0${row.rightTopicId}\0${row.algorithmVersion}`;
    if (
      topicMergeIds.has(row.id) ||
      topicMergePairs.has(pairKey) ||
      !topicIds.has(row.leftTopicId) ||
      !topicIds.has(row.rightTopicId) ||
      row.leftTopicId === row.rightTopicId ||
      compareCodePoints(row.leftTopicId, row.rightTopicId) >= 0 ||
      row.algorithmVersion !== TOPIC_SIMILARITY_ALGORITHM ||
      typeof row.score !== "number" ||
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1 ||
      !["proposed", "accepted", "dismissed"].includes(row.state)
    ) {
      validationFail("malformed_existing");
    }
    topicMergeIds.add(row.id);
    topicMergePairs.add(pairKey);
  }

  const todoIds = new Set();
  const todoRowsById = new Map();
  const todoRowsByBaseKey = new Map();
  const todoRevisionIds = new Set();
  const todoOccurrenceIds = new Set();
  for (const todo of snapshot.todos) {
    const row = exactObject(
      todo,
      [
        "id",
        "canonicalBaseKey",
        "title",
        "ownerSubjectKind",
        "ownerSubjectId",
        "status",
        "completedAt",
        "revisions",
        "occurrences",
      ],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    if (todoIds.has(row.id)) validationFail("malformed_existing");
    todoIds.add(row.id);
    requireHash(row.canonicalBaseKey, "malformed_existing");
    requireText(row.title, "malformed_existing");
    if ((row.ownerSubjectKind === null) !== (row.ownerSubjectId === null)) {
      validationFail("malformed_existing");
    }
    if (row.ownerSubjectKind !== null) {
      if (!SUBJECT_KINDS.has(row.ownerSubjectKind)) validationFail("malformed_existing");
      requireId(row.ownerSubjectId, "malformed_existing");
    }
    if (!["open", "completed", "dismissed"].includes(row.status)) {
      validationFail("malformed_existing");
    }
    if (row.status === "completed") requireInteger(row.completedAt, "malformed_existing");
    else if (row.completedAt !== null) validationFail("malformed_existing");
    if (
      row.canonicalBaseKey !==
      canonicalTupleHash(["todo", canonicalizeText(row.title), row.ownerSubjectId])
    ) {
      validationFail("malformed_existing");
    }
    const revisions = requireArray(row.revisions, "malformed_existing");
    if (revisions.length === 0) validationFail("malformed_existing");
    const revisionIds = new Set();
    const revisionNumbers = new Set();
    for (const revision of revisions) {
      const item = exactObject(
        revision,
        ["id", "revision", "title", "dueText"],
        "malformed_existing"
      );
      requireId(item.id, "malformed_existing");
      if (
        todoRevisionIds.has(item.id) ||
        revisionNumbers.has(item.revision) ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      ) {
        validationFail("malformed_existing");
      }
      revisionIds.add(item.id);
      todoRevisionIds.add(item.id);
      revisionNumbers.add(item.revision);
      requireText(item.title, "malformed_existing");
      requireNullableText(item.dueText, "malformed_existing");
    }
    for (const occurrence of requireArray(row.occurrences, "malformed_existing")) {
      const item = exactObject(
        occurrence,
        ["id", "revisionId", "startedAt", "endedAt", "evidenceSegmentIds"],
        "malformed_existing"
      );
      requireId(item.id, "malformed_existing");
      if (todoOccurrenceIds.has(item.id) || !revisionIds.has(item.revisionId)) {
        validationFail("malformed_existing");
      }
      todoOccurrenceIds.add(item.id);
      requireInteger(item.startedAt, "malformed_existing");
      requireInteger(item.endedAt, "malformed_existing");
      if (item.endedAt < item.startedAt) validationFail("malformed_existing");
      validateIdSet(item.evidenceSegmentIds, {
        issueCode: "malformed_existing",
        allowEmpty: true,
      });
    }
    todoRowsById.set(row.id, row);
    const baseRows = todoRowsByBaseKey.get(row.canonicalBaseKey) ?? [];
    baseRows.push(row);
    todoRowsByBaseKey.set(row.canonicalBaseKey, baseRows);
  }

  const suggestionIds = new Set();
  const suggestionKeys = new Set();
  const suggestionOccurrenceIds = new Set();
  for (const suggestion of snapshot.suggestions) {
    const row = exactObject(
      suggestion,
      ["id", "canonicalKey", "title", "rationale", "state", "occurrences"],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    if (suggestionIds.has(row.id)) validationFail("malformed_existing");
    suggestionIds.add(row.id);
    requireHash(row.canonicalKey, "malformed_existing");
    if (suggestionKeys.has(row.canonicalKey)) validationFail("malformed_existing");
    suggestionKeys.add(row.canonicalKey);
    requireText(row.title, "malformed_existing");
    requireText(row.rationale, "malformed_existing");
    if (!["proposed", "accepted", "dismissed"].includes(row.state)) {
      validationFail("malformed_existing");
    }
    if (
      row.canonicalKey !==
      canonicalTupleHash([
        "suggestion",
        canonicalizeText(row.title),
        canonicalizeText(row.rationale),
      ])
    ) {
      validationFail("malformed_existing");
    }
    for (const occurrence of requireArray(row.occurrences, "malformed_existing")) {
      const item = exactObject(occurrence, ["id", "evidenceSegmentIds"], "malformed_existing");
      requireId(item.id, "malformed_existing");
      if (suggestionOccurrenceIds.has(item.id)) validationFail("malformed_existing");
      suggestionOccurrenceIds.add(item.id);
      validateIdSet(item.evidenceSegmentIds, {
        issueCode: "malformed_existing",
        allowEmpty: true,
      });
    }
  }

  const supersessionIds = new Set();
  const supersessionPairs = new Set();
  for (const supersession of snapshot.memorySupersessions) {
    const row = exactObject(
      supersession,
      ["id", "priorMemoryId", "nextMemoryId", "reason"],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    const pairKey = `${row.priorMemoryId}\0${row.nextMemoryId}`;
    if (
      supersessionIds.has(row.id) ||
      supersessionPairs.has(pairKey) ||
      !memoryIds.has(row.priorMemoryId) ||
      !memoryIds.has(row.nextMemoryId) ||
      row.priorMemoryId === row.nextMemoryId ||
      !["transcript_replacement", "user_correction", "conflict_resolution"].includes(row.reason)
    ) {
      validationFail("malformed_existing");
    }
    supersessionIds.add(row.id);
    supersessionPairs.add(pairKey);
  }
  const recurrenceIds = new Set();
  const recurrencePreviousIds = new Set();
  const recurrenceNextIds = new Set();
  const recurrenceSourceIds = new Set();
  const recurrenceByPreviousId = new Map();
  for (const recurrence of snapshot.todoRecurrences) {
    const row = exactObject(
      recurrence,
      ["id", "previousTodoId", "nextTodoId", "sourceOccurrenceId"],
      "malformed_existing"
    );
    requireId(row.id, "malformed_existing");
    if (row.sourceOccurrenceId !== null) requireId(row.sourceOccurrenceId, "malformed_existing");
    if (
      recurrenceIds.has(row.id) ||
      recurrencePreviousIds.has(row.previousTodoId) ||
      recurrenceNextIds.has(row.nextTodoId) ||
      (row.sourceOccurrenceId !== null && recurrenceSourceIds.has(row.sourceOccurrenceId)) ||
      !todoIds.has(row.previousTodoId) ||
      !todoIds.has(row.nextTodoId) ||
      row.previousTodoId === row.nextTodoId
    ) {
      validationFail("malformed_existing");
    }
    if (
      todoRowsById.get(row.previousTodoId).canonicalBaseKey !==
      todoRowsById.get(row.nextTodoId).canonicalBaseKey
    ) {
      validationFail("malformed_existing");
    }
    recurrenceIds.add(row.id);
    recurrencePreviousIds.add(row.previousTodoId);
    recurrenceNextIds.add(row.nextTodoId);
    recurrenceByPreviousId.set(row.previousTodoId, row);
    if (row.sourceOccurrenceId !== null) recurrenceSourceIds.add(row.sourceOccurrenceId);
  }
  const visitState = new Map();
  const visitTodo = (todoId) => {
    if (visitState.get(todoId) === "visiting") validationFail("malformed_existing");
    if (visitState.get(todoId) === "visited") return;
    visitState.set(todoId, "visiting");
    const nextTodoId = recurrenceByPreviousId.get(todoId)?.nextTodoId;
    if (nextTodoId) visitTodo(nextTodoId);
    visitState.set(todoId, "visited");
  };
  for (const todoId of todoIds) visitTodo(todoId);
  for (const rows of todoRowsByBaseKey.values()) {
    const activeRows = rows.filter((row) => row.status === "open");
    const leafRows = rows.filter((row) => !recurrenceByPreviousId.has(row.id));
    if (
      activeRows.length > 1 ||
      leafRows.length !== 1 ||
      (activeRows.length === 1 && activeRows[0].id !== leafRows[0].id)
    ) {
      validationFail("malformed_existing");
    }
  }
  return snapshot;
}

function validateReplacements(replacements, evidenceContext, candidate) {
  const values = requireArray(replacements, "untrusted_replacement");
  const candidateMemoryEvidence = new Set(
    candidate.memories.flatMap((memory) => memory.evidenceSegmentIds)
  );
  const keys = new Set();
  return values.map((replacement) => {
    const row = exactObject(
      replacement,
      ["newSegmentId", "replacesSegmentIds"],
      "untrusted_replacement"
    );
    requireId(row.newSegmentId, "untrusted_replacement");
    const replacesSegmentIds = validateIdSet(row.replacesSegmentIds, {
      issueCode: "untrusted_replacement",
      allowEmpty: false,
    });
    if (
      replacesSegmentIds.includes(row.newSegmentId) ||
      !candidateMemoryEvidence.has(row.newSegmentId) ||
      !evidenceContext.segmentById.has(row.newSegmentId) ||
      replacesSegmentIds.some((id) => !evidenceContext.segmentById.has(id))
    ) {
      validationFail("untrusted_replacement");
    }
    const normalizedReplaces = normalizeStringSet(
      replacesSegmentIds,
      "trustedTranscriptReplacement.replacesSegmentIds"
    );
    const replacementKey = canonicalTupleHash([
      "transcript_replacement",
      row.newSegmentId,
      normalizedReplaces,
    ]);
    if (keys.has(replacementKey)) validationFail("untrusted_replacement");
    keys.add(replacementKey);
    return {
      newSegmentId: row.newSegmentId,
      replacesSegmentIds: normalizedReplaces,
      replacementKey,
    };
  });
}

function validatePlannerInput(input) {
  const value = exactObject(
    input,
    ["analysisInput", "candidate", "evidence", "existing", "trustedTranscriptReplacements"],
    "malformed_input"
  );
  const candidate = validateCandidate(value.candidate);
  const evidenceContext = validateEvidence(value.analysisInput, value.evidence, candidate);
  const existing = validateExisting(value.existing);
  const replacements = validateReplacements(
    value.trustedTranscriptReplacements,
    evidenceContext,
    candidate
  );
  return { value, candidate, evidenceContext, existing, replacements };
}

function resolveCandidateContext(input, validated) {
  const canonical = canonicalizeCandidate(input.candidate);
  const { segmentById, bindingByLabel } = validated.evidenceContext;
  const resolvedMemories = canonical.memories.map((memory) => {
    const relatedSubjects = [];
    const seenSubjects = new Set();
    for (const segmentId of memory.evidenceSegmentIds) {
      const speakerLabel = segmentById.get(segmentId)?.speakerLabel;
      if (speakerLabel === null || speakerLabel === undefined) continue;
      const binding = bindingByLabel.get(speakerLabel);
      if (!binding) continue;
      const subjectKey = `${binding.subjectKind}\0${binding.subjectId}`;
      if (seenSubjects.has(subjectKey)) continue;
      seenSubjects.add(subjectKey);
      relatedSubjects.push({
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
      });
    }
    relatedSubjects.sort(
      (left, right) =>
        compareCodePoints(left.subjectId, right.subjectId) ||
        compareCodePoints(left.subjectKind, right.subjectKind)
    );
    const relatedSubjectIds = normalizeStringSet(
      relatedSubjects.map((subject) => subject.subjectId),
      "memory.relatedSubjectIds"
    );
    const canonicalTuple = ["memory", memory.kind, memory.normalizedTitle, relatedSubjectIds];
    const planCanonicalKey = canonicalTupleHash(canonicalTuple);
    const canonicalValueKey = canonicalTupleHash([
      "memory_value",
      planCanonicalKey,
      memory.normalizedBody,
    ]);
    return {
      ...memory,
      relatedSubjects,
      canonicalTuple,
      planCanonicalKey,
      canonicalValueKey,
      semanticFingerprint: canonicalTupleHash([
        "memory_candidate",
        canonicalValueKey,
        memory.confidence,
        memory.evidenceSegmentIds,
      ]),
    };
  });
  const resolvedTopics = canonical.topics.map((topic) => ({
    ...topic,
    planCanonicalKey: topic.canonicalHash,
    semanticFingerprint: canonicalTupleHash(["topic_candidate", ...topic.semanticTuple]),
  }));
  const resolvedTodos = canonical.todos.map((todo) => {
    const binding = todo.ownerLabel === null ? null : bindingByLabel.get(todo.ownerLabel);
    const canonicalTuple = ["todo", todo.normalizedTitle, binding?.subjectId ?? null];
    const planCanonicalKey = canonicalTupleHash(canonicalTuple);
    return {
      ...todo,
      ownerSubjectKind: binding?.subjectKind ?? null,
      ownerSubjectId: binding?.subjectId ?? null,
      canonicalTuple,
      planCanonicalKey,
      semanticFingerprint: canonicalTupleHash([
        "todo_candidate",
        canonicalTuple,
        todo.normalizedDueText,
        todo.evidenceSegmentIds,
      ]),
    };
  });
  const resolvedSuggestions = canonical.suggestions.map((suggestion) => ({
    ...suggestion,
    planCanonicalKey: suggestion.canonicalHash,
    semanticFingerprint: canonicalTupleHash(["suggestion_candidate", ...suggestion.semanticTuple]),
  }));
  const memoryCandidates = convergeMemoryCandidates(resolvedMemories, segmentById);
  const topicCandidates = dedupeCandidateItems(
    resolvedTopics,
    "topic",
    (topic) => topic.planCanonicalKey
  );
  const todoCandidates = dedupeCandidateItems(
    resolvedTodos,
    "todo",
    (todo) => todo.planCanonicalKey
  );
  const suggestionCandidates = dedupeCandidateItems(
    resolvedSuggestions,
    "suggestion",
    (suggestion) => suggestion.planCanonicalKey,
    "basedOnEvidenceSegmentIds"
  );
  const memories = memoryCandidates.unique;
  const topics = topicCandidates.unique;
  const todos = todoCandidates.unique;
  const suggestions = suggestionCandidates.unique;
  const ignoredDuplicates = [
    ...memoryCandidates.ignored,
    ...topicCandidates.ignored,
    ...todoCandidates.ignored,
    ...suggestionCandidates.ignored,
  ].sort(compareActions);
  const topicsByKey = new Map(input.existing.topics.map((topic) => [topic.canonicalKey, topic]));
  const memoriesByValueKey = new Map(
    input.existing.memories.map((memory) => [memory.canonicalValueKey, memory])
  );
  const memoriesBySlotKey = new Map();
  for (const memory of input.existing.memories) {
    if (memory.lifecycle === "superseded") continue;
    const slot = memoriesBySlotKey.get(memory.canonicalSlotKey) ?? [];
    slot.push(memory);
    memoriesBySlotKey.set(memory.canonicalSlotKey, slot);
  }
  const todosByBaseKey = new Map();
  for (const todo of input.existing.todos) {
    const instances = todosByBaseKey.get(todo.canonicalBaseKey) ?? [];
    instances.push(todo);
    todosByBaseKey.set(todo.canonicalBaseKey, instances);
  }
  const suggestionsByKey = new Map(
    input.existing.suggestions.map((suggestion) => [suggestion.canonicalKey, suggestion])
  );
  const todoRecurrencePreviousIds = new Set(
    input.existing.todoRecurrences.map((recurrence) => recurrence.previousTodoId)
  );
  return {
    segmentById,
    memories,
    topics,
    todos,
    suggestions,
    ignoredDuplicates,
    topicsByKey,
    memoriesByValueKey,
    memoriesBySlotKey,
    todosByBaseKey,
    suggestionsByKey,
    todoRecurrencePreviousIds,
  };
}

function planTopics({ input, topics, topicsByKey }) {
  const inserts = topics
    .filter((topic) => !topicsByKey.has(topic.canonicalHash))
    .map((topic) => ({
      entityKind: "topic",
      canonicalKey: topic.canonicalHash,
      canonicalTuple: topic.canonicalTuple,
      name: topic.name,
      summary: topic.summary,
      normalizedSummary: topic.normalizedSummary,
      evidenceSegmentIds: topic.evidenceSegmentIds,
    }))
    .sort(compareActions);
  const revisions = [];
  const occurrenceLinks = [];
  for (const topic of topics) {
    const existingTopic = topicsByKey.get(topic.canonicalHash);
    if (!existingTopic) continue;
    const previous = [...existingTopic.revisions].sort(
      (left, right) => right.revision - left.revision || compareCodePoints(right.id, left.id)
    )[0];
    if (canonicalizeText(previous.summary) !== topic.normalizedSummary) {
      revisions.push({
        entityKind: "topic",
        topicId: existingTopic.id,
        previousRevisionId: previous.id,
        previousRevision: previous.revision,
        canonicalKey: topic.canonicalHash,
        summary: topic.summary,
        normalizedSummary: topic.normalizedSummary,
        evidenceSegmentIds: topic.evidenceSegmentIds,
      });
      continue;
    }
    const eligibleOccurrences = existingTopic.occurrences.filter(
      (occurrence) => occurrence.revisionId === previous.id
    );
    const covered = eligibleOccurrences.find((occurrence) =>
      topic.evidenceSegmentIds.every((segmentId) =>
        occurrence.evidenceSegmentIds.includes(segmentId)
      )
    );
    if (covered) continue;
    const candidateEvidence = new Set(topic.evidenceSegmentIds);
    const reusable = [...eligibleOccurrences]
      .filter((occurrence) =>
        occurrence.evidenceSegmentIds.some((segmentId) => candidateEvidence.has(segmentId))
      )
      .sort((left, right) => compareCodePoints(left.id, right.id))[0];
    if (reusable) {
      occurrenceLinks.push({
        entityKind: "topic_occurrence",
        topicId: existingTopic.id,
        occurrenceId: reusable.id,
        revisionId: previous.id,
        mode: "link_evidence",
        evidenceSegmentIds: topic.evidenceSegmentIds.filter(
          (segmentId) => !reusable.evidenceSegmentIds.includes(segmentId)
        ),
      });
    } else {
      occurrenceLinks.push({
        entityKind: "topic",
        topicId: existingTopic.id,
        revisionId: previous.id,
        mode: "create_occurrence",
        evidenceSegmentIds: topic.evidenceSegmentIds,
      });
    }
  }

  const existingMergePairs = new Set(
    input.existing.topicMergeSuggestions
      .filter((suggestion) => suggestion.algorithmVersion === TOPIC_SIMILARITY_ALGORITHM)
      .map((suggestion) =>
        [suggestion.leftTopicId, suggestion.rightTopicId].sort(compareCodePoints).join("\0")
      )
  );
  const plannedPairKeys = new Set();
  const mergeSuggestions = [];
  const topicRefsByKey = new Map();
  for (const existingTopic of input.existing.topics) {
    if (existingTopic.lifecycle !== "active") continue;
    topicRefsByKey.set(existingTopic.canonicalKey, {
      canonicalKey: existingTopic.canonicalKey,
      topicId: existingTopic.id,
      name: existingTopic.name,
      fromCandidate: false,
    });
  }
  for (const topic of topics) {
    const exactTopic = topicsByKey.get(topic.canonicalHash);
    if (exactTopic) {
      const existingRef = topicRefsByKey.get(topic.canonicalHash);
      if (existingRef) existingRef.fromCandidate = true;
      continue;
    }
    topicRefsByKey.set(topic.canonicalHash, {
      canonicalKey: topic.canonicalHash,
      name: topic.name,
      fromCandidate: true,
    });
  }
  const topicRefs = [...topicRefsByKey.values()].sort((left, right) =>
    compareCodePoints(left.canonicalKey, right.canonicalKey)
  );
  for (let leftIndex = 0; leftIndex < topicRefs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < topicRefs.length; rightIndex += 1) {
      const left = topicRefs[leftIndex];
      const right = topicRefs[rightIndex];
      if (!left.fromCandidate && !right.fromCandidate) continue;
      const score = diceBigramScore(left.name, right.name);
      if (score < TOPIC_SIMILARITY_THRESHOLD) continue;
      if (
        left.topicId &&
        right.topicId &&
        existingMergePairs.has([left.topicId, right.topicId].sort(compareCodePoints).join("\0"))
      ) {
        continue;
      }
      const pairKey = canonicalTupleHash([
        "topic_merge_pair",
        left.canonicalKey,
        right.canonicalKey,
        TOPIC_SIMILARITY_ALGORITHM,
      ]);
      if (plannedPairKeys.has(pairKey)) continue;
      plannedPairKeys.add(pairKey);
      mergeSuggestions.push({
        pairKey,
        leftTopic: {
          canonicalKey: left.canonicalKey,
          ...(left.topicId ? { topicId: left.topicId } : {}),
        },
        rightTopic: {
          canonicalKey: right.canonicalKey,
          ...(right.topicId ? { topicId: right.topicId } : {}),
        },
        algorithmVersion: TOPIC_SIMILARITY_ALGORITHM,
        score: roundSix(score),
        state: "proposed",
      });
    }
  }
  revisions.sort(compareActions);
  occurrenceLinks.sort(compareActions);
  mergeSuggestions.sort(compareActions);
  return { inserts, revisions, occurrenceLinks, mergeSuggestions };
}

function evidenceBoundsFor(evidenceSegmentIds, segmentById) {
  const segments = evidenceSegmentIds.map((segmentId) => segmentById.get(segmentId));
  return {
    startedAt: Math.min(...segments.map((segment) => segment.startedAt)),
    endedAt: Math.max(...segments.map((segment) => segment.endedAt)),
  };
}

function planMemories({
  input,
  validated,
  memories,
  memoriesByValueKey,
  memoriesBySlotKey,
  segmentById,
}) {
  const inserts = memories
    .filter(
      (memory) =>
        !memoriesByValueKey.has(memory.canonicalValueKey) &&
        (memory.kind !== "event" || memory.eventClusterIndex === 0)
    )
    .map((memory) => ({
      entityKind: "memory",
      canonicalSlotKey: memory.planCanonicalKey,
      canonicalValueKey: memory.canonicalValueKey,
      canonicalTuple: memory.canonicalTuple,
      kind: memory.kind,
      title: memory.title,
      body: memory.body,
      normalizedBody: memory.normalizedBody,
      confidence: memory.confidence,
      relatedSubjects: memory.relatedSubjects,
      evidenceSegmentIds: memory.evidenceSegmentIds,
    }));
  const occurrenceLinks = [];
  const conflictGroups = new Map();
  const recordMemoryConflict = (
    canonicalSlotKey,
    existingMemoryIds,
    candidateCanonicalValueKeys
  ) => {
    const group = conflictGroups.get(canonicalSlotKey) ?? {
      existingMemoryIds: new Set(),
      candidateCanonicalValueKeys: new Set(),
    };
    for (const memoryId of existingMemoryIds) group.existingMemoryIds.add(memoryId);
    for (const valueKey of candidateCanonicalValueKeys) {
      group.candidateCanonicalValueKeys.add(valueKey);
    }
    conflictGroups.set(canonicalSlotKey, group);
  };
  const candidateValuesBySlotKey = new Map();
  for (const memory of memories) {
    const valueKeys = candidateValuesBySlotKey.get(memory.planCanonicalKey) ?? new Set();
    valueKeys.add(memory.canonicalValueKey);
    candidateValuesBySlotKey.set(memory.planCanonicalKey, valueKeys);
  }
  for (const [canonicalSlotKey, candidateCanonicalValueKeys] of candidateValuesBySlotKey) {
    if (
      candidateCanonicalValueKeys.size > 1 &&
      [...candidateCanonicalValueKeys].some((valueKey) => !memoriesByValueKey.has(valueKey))
    ) {
      recordMemoryConflict(canonicalSlotKey, [], candidateCanonicalValueKeys);
    }
  }

  const supersessions = [];
  const normalizedReplacements = [...validated.replacements].sort(compareActions);
  const usedReplacementKeys = new Set();
  const replacementForOccurrence = (memory, occurrence) =>
    normalizedReplacements.find((replacement) => {
      if (
        replacement.replacesSegmentIds.length === 0 ||
        replacement.replacesSegmentIds.includes(replacement.newSegmentId) ||
        !memory.evidenceSegmentIds.includes(replacement.newSegmentId) ||
        !occurrence.evidenceSegmentIds.every((segmentId) =>
          replacement.replacesSegmentIds.includes(segmentId)
        )
      ) {
        return false;
      }
      return [replacement.newSegmentId, ...replacement.replacesSegmentIds].every(
        (segmentId) => segmentById.get(segmentId)?.sessionId === input.analysisInput.sessionId
      );
    });

  for (const memory of memories) {
    const exactMemory = memoriesByValueKey.get(memory.canonicalValueKey);
    if (exactMemory) {
      if (memory.kind === "event") {
        const candidateBounds = evidenceBoundsFor(memory.evidenceSegmentIds, segmentById);
        const reusableEvent = exactMemory.occurrences
          .map((occurrence) => {
            const gap = Math.max(
              0,
              candidateBounds.startedAt - occurrence.endedAt,
              occurrence.startedAt - candidateBounds.endedAt
            );
            return { occurrence, gap };
          })
          .filter(({ gap }) => gap <= EVENT_DEDUPE_WINDOW_MS)
          .sort(
            (left, right) =>
              left.gap - right.gap || compareCodePoints(left.occurrence.id, right.occurrence.id)
          )[0]?.occurrence;
        if (reusableEvent) {
          const missingEvidence = memory.evidenceSegmentIds.filter(
            (segmentId) => !reusableEvent.evidenceSegmentIds.includes(segmentId)
          );
          if (missingEvidence.length > 0) {
            occurrenceLinks.push({
              entityKind: "memory_occurrence",
              memoryId: exactMemory.id,
              occurrenceId: reusableEvent.id,
              mode: "link_evidence",
              evidenceSegmentIds: missingEvidence,
            });
          }
          continue;
        }
      }
      const candidateEvidence = new Set(memory.evidenceSegmentIds);
      const covered = exactMemory.occurrences.find((occurrence) =>
        memory.evidenceSegmentIds.every((segmentId) =>
          occurrence.evidenceSegmentIds.includes(segmentId)
        )
      );
      if (covered) continue;
      const reusable = [...exactMemory.occurrences]
        .sort((left, right) => compareCodePoints(left.id, right.id))
        .find((occurrence) =>
          occurrence.evidenceSegmentIds.some((segmentId) => candidateEvidence.has(segmentId))
        );
      if (reusable) {
        occurrenceLinks.push({
          entityKind: "memory_occurrence",
          memoryId: exactMemory.id,
          occurrenceId: reusable.id,
          mode: "link_evidence",
          evidenceSegmentIds: memory.evidenceSegmentIds.filter(
            (segmentId) => !reusable.evidenceSegmentIds.includes(segmentId)
          ),
        });
      } else {
        occurrenceLinks.push({
          entityKind: "memory",
          memoryId: exactMemory.id,
          canonicalValueKey: memory.canonicalValueKey,
          mode: "create_occurrence",
          ...evidenceBoundsFor(memory.evidenceSegmentIds, segmentById),
          confidence: memory.confidence,
          evidenceSegmentIds: memory.evidenceSegmentIds,
        });
      }
      continue;
    }

    if (memory.kind === "event" && memory.eventClusterIndex > 0) {
      occurrenceLinks.push({
        entityKind: "memory",
        canonicalValueKey: memory.canonicalValueKey,
        mode: "create_occurrence",
        ...evidenceBoundsFor(memory.evidenceSegmentIds, segmentById),
        confidence: memory.confidence,
        evidenceSegmentIds: memory.evidenceSegmentIds,
      });
      continue;
    }

    const priorValues = memoriesBySlotKey.get(memory.planCanonicalKey) ?? [];
    if (priorValues.length === 0) continue;
    const conflictingIds = [];
    for (const prior of priorValues) {
      let replacementAction = null;
      for (const occurrence of [...prior.occurrences].sort((left, right) =>
        compareCodePoints(left.id, right.id)
      )) {
        const replacement = replacementForOccurrence(memory, occurrence);
        if (!replacement) continue;
        replacementAction = {
          priorMemoryId: prior.id,
          priorOccurrenceId: occurrence.id,
          nextMemoryCanonicalValueKey: memory.canonicalValueKey,
          canonicalSlotKey: memory.planCanonicalKey,
          reason: "transcript_replacement",
          newSegmentId: replacement.newSegmentId,
          replacesSegmentIds: replacement.replacesSegmentIds,
        };
        break;
      }
      if (replacementAction) supersessions.push(replacementAction);
      if (replacementAction) {
        const replacement = normalizedReplacements.find(
          (item) =>
            item.newSegmentId === replacementAction.newSegmentId &&
            item.replacesSegmentIds.length === replacementAction.replacesSegmentIds.length &&
            item.replacesSegmentIds.every(
              (segmentId, index) => segmentId === replacementAction.replacesSegmentIds[index]
            )
        );
        usedReplacementKeys.add(replacement.replacementKey);
      } else conflictingIds.push(prior.id);
    }
    if (conflictingIds.length > 0) {
      recordMemoryConflict(memory.planCanonicalKey, conflictingIds, [memory.canonicalValueKey]);
    }
  }

  const conflicts = [...conflictGroups.entries()].map(([canonicalSlotKey, group]) => ({
    canonicalSlotKey,
    existingMemoryIds: [...group.existingMemoryIds].sort(compareCodePoints),
    candidateCanonicalValueKeys: [...group.candidateCanonicalValueKeys].sort(compareCodePoints),
    reason: "independent_changed_body",
  }));
  if (
    normalizedReplacements.some(
      (replacement) => !usedReplacementKeys.has(replacement.replacementKey)
    )
  ) {
    validationFail("untrusted_replacement");
  }

  occurrenceLinks.sort(compareActions);
  conflicts.sort(compareActions);
  supersessions.sort(compareActions);
  return { inserts, occurrenceLinks, supersessions, conflicts };
}

function planTodos({ input, todos, todosByBaseKey, todoRecurrencePreviousIds, segmentById }) {
  const inserts = todos
    .filter((todo) => !todosByBaseKey.has(todo.planCanonicalKey))
    .map((todo) => ({
      entityKind: "todo",
      canonicalBaseKey: todo.planCanonicalKey,
      canonicalTuple: todo.canonicalTuple,
      title: todo.title,
      ownerSubjectKind: todo.ownerSubjectKind,
      ownerSubjectId: todo.ownerSubjectId,
      dueText: todo.dueText,
      evidenceSegmentIds: todo.evidenceSegmentIds,
    }));
  const occurrenceLinks = [];
  const recurrences = [];

  for (const todo of todos) {
    const instances = todosByBaseKey.get(todo.planCanonicalKey) ?? [];
    if (instances.length === 0) continue;
    const active = [...instances]
      .filter((instance) => instance.status === "open")
      .sort((left, right) => compareCodePoints(left.id, right.id))[0];
    const terminalLeaf = [...instances]
      .filter((instance) => !todoRecurrencePreviousIds.has(instance.id))
      .sort((left, right) => compareCodePoints(left.id, right.id))[0];
    const existingTodo =
      active ??
      terminalLeaf ??
      [...instances].sort((left, right) => compareCodePoints(left.id, right.id))[0];
    const previousRevision = [...existingTodo.revisions].sort(
      (left, right) => right.revision - left.revision || compareCodePoints(right.id, left.id)
    )[0];
    const covered = existingTodo.occurrences.find((occurrence) =>
      todo.evidenceSegmentIds.every((segmentId) =>
        occurrence.evidenceSegmentIds.includes(segmentId)
      )
    );
    if (covered) continue;
    const bounds = evidenceBoundsFor(todo.evidenceSegmentIds, segmentById);

    if (existingTodo.status === "open") {
      const candidateEvidence = new Set(todo.evidenceSegmentIds);
      const reusable = [...existingTodo.occurrences]
        .sort((left, right) => compareCodePoints(left.id, right.id))
        .find((occurrence) =>
          occurrence.evidenceSegmentIds.some((segmentId) => candidateEvidence.has(segmentId))
        );
      if (reusable) {
        occurrenceLinks.push({
          entityKind: "todo_occurrence",
          todoId: existingTodo.id,
          occurrenceId: reusable.id,
          mode: "link_evidence",
          evidenceSegmentIds: todo.evidenceSegmentIds.filter(
            (segmentId) => !reusable.evidenceSegmentIds.includes(segmentId)
          ),
        });
      } else {
        occurrenceLinks.push({
          entityKind: "todo",
          todoId: existingTodo.id,
          revisionId: previousRevision.id,
          mode: "create_occurrence",
          ...bounds,
          evidenceSegmentIds: todo.evidenceSegmentIds,
        });
      }
      continue;
    }

    const isLater =
      existingTodo.status === "completed" && bounds.startedAt > existingTodo.completedAt;
    if (!isLater) {
      occurrenceLinks.push({
        entityKind: "todo",
        todoId: existingTodo.id,
        revisionId: previousRevision.id,
        mode: "attach_history",
        ...bounds,
        evidenceSegmentIds: todo.evidenceSegmentIds,
      });
      continue;
    }

    const existingRecurrence = input.existing.todoRecurrences.find(
      (recurrence) => recurrence.previousTodoId === existingTodo.id
    );
    if (existingRecurrence) continue;
    recurrences.push({
      previousTodoId: existingTodo.id,
      nextTodoInstanceKey: canonicalTupleHash([
        "todo_recurrence",
        existingTodo.id,
        todo.planCanonicalKey,
        todo.evidenceSegmentIds,
      ]),
      canonicalBaseKey: todo.planCanonicalKey,
      title: todo.title,
      ownerSubjectKind: todo.ownerSubjectKind,
      ownerSubjectId: todo.ownerSubjectId,
      dueText: todo.dueText,
      ...bounds,
      evidenceSegmentIds: todo.evidenceSegmentIds,
      reason: "later_evidence",
    });
  }

  occurrenceLinks.sort(compareActions);
  recurrences.sort(compareActions);
  return { inserts, occurrenceLinks, recurrences };
}

function planSuggestions({ suggestions, suggestionsByKey }) {
  const inserts = suggestions
    .filter((suggestion) => !suggestionsByKey.has(suggestion.planCanonicalKey))
    .map((suggestion) => ({
      entityKind: "suggestion",
      canonicalKey: suggestion.canonicalHash,
      canonicalTuple: suggestion.canonicalTuple,
      title: suggestion.title,
      rationale: suggestion.rationale,
      evidenceSegmentIds: suggestion.basedOnEvidenceSegmentIds,
    }));
  const occurrenceLinks = [];

  for (const suggestion of suggestions) {
    const existingSuggestion = suggestionsByKey.get(suggestion.planCanonicalKey);
    if (
      !existingSuggestion ||
      existingSuggestion.state !== "proposed" ||
      suggestion.basedOnEvidenceSegmentIds.length === 0
    ) {
      continue;
    }
    const covered = existingSuggestion.occurrences.find((occurrence) =>
      suggestion.basedOnEvidenceSegmentIds.every((segmentId) =>
        occurrence.evidenceSegmentIds.includes(segmentId)
      )
    );
    if (covered) continue;
    const occurrence = [...existingSuggestion.occurrences].sort((left, right) =>
      compareCodePoints(left.id, right.id)
    )[0];
    if (occurrence) {
      occurrenceLinks.push({
        entityKind: "suggestion_occurrence",
        suggestionId: existingSuggestion.id,
        occurrenceId: occurrence.id,
        mode: "link_evidence",
        evidenceSegmentIds: suggestion.basedOnEvidenceSegmentIds.filter(
          (segmentId) => !occurrence.evidenceSegmentIds.includes(segmentId)
        ),
      });
    } else {
      occurrenceLinks.push({
        entityKind: "suggestion",
        suggestionId: existingSuggestion.id,
        mode: "create_occurrence",
        evidenceSegmentIds: suggestion.basedOnEvidenceSegmentIds,
      });
    }
  }

  occurrenceLinks.sort(compareActions);
  return { inserts, occurrenceLinks };
}

class MemoryMerger {
  plan(input) {
    const validated = validatePlannerInput(input);
    input = validated.value;
    const {
      segmentById,
      memories,
      topics,
      todos,
      suggestions,
      ignoredDuplicates,
      topicsByKey,
      memoriesByValueKey,
      memoriesBySlotKey,
      todosByBaseKey,
      suggestionsByKey,
      todoRecurrencePreviousIds,
    } = resolveCandidateContext(input, validated);
    const topicPlan = planTopics({ input, topics, topicsByKey });
    const memoryPlan = planMemories({
      input,
      validated,
      memories,
      memoriesByValueKey,
      memoriesBySlotKey,
      segmentById,
    });
    const todoPlan = planTodos({
      input,
      todos,
      todosByBaseKey,
      todoRecurrencePreviousIds,
      segmentById,
    });
    const suggestionPlan = planSuggestions({ suggestions, suggestionsByKey });
    const inserts = suggestionPlan.inserts
      .concat(topicPlan.inserts)
      .concat(memoryPlan.inserts, todoPlan.inserts)
      .sort(compareActions);
    const revisions = topicPlan.revisions;

    const occurrenceLinks = [
      ...topicPlan.occurrenceLinks,
      ...memoryPlan.occurrenceLinks,
      ...todoPlan.occurrenceLinks,
      ...suggestionPlan.occurrenceLinks,
    ];
    const supersessions = memoryPlan.supersessions;
    const conflicts = memoryPlan.conflicts;
    const recurrences = todoPlan.recurrences;

    occurrenceLinks.sort(compareActions);
    conflicts.sort(compareActions);
    supersessions.sort(compareActions);
    recurrences.sort(compareActions);

    const mergeSuggestions = topicPlan.mergeSuggestions;

    return {
      inserts,
      revisions,
      occurrenceLinks,
      supersessions,
      conflicts,
      mergeSuggestions,
      recurrences,
      ignoredDuplicates,
      semanticCandidateHash: semanticCandidateHash(input.candidate),
    };
  }
}

module.exports = {
  CANONICAL_ALGORITHM,
  TOPIC_SIMILARITY_ALGORITHM,
  TOPIC_SIMILARITY_THRESHOLD,
  EVENT_DEDUPE_WINDOW_MS,
  canonicalizeText,
  canonicalTupleHash,
  canonicalizeCandidate,
  semanticCandidateHash,
  normalizeStringSet,
  diceBigramSimilarity,
  MemoryMergerValidationError,
  MemoryMerger,
};
