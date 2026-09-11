const crypto = require("node:crypto");

const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v3";
const LEGACY_INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
// MiniMax M2.7 supports a 204,800-token combined context. A 384 KiB UTF-8
// transcript envelope leaves ample room for the system prompt, tool schema,
// reasoning, and response while allowing typical multi-hour sessions to carry
// every attributable segment instead of degrading to timeline sampling.
const DEFAULT_MAX_PAYLOAD_BYTES = 384 * 1024;
const HIERARCHICAL_WINDOW_MS = 20 * 60_000;
const LABEL_PATTERN = /^(?:SELF|P[1-9][0-9]*)$/u;
const LEARNING_GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const APPLICATION_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);
const ACTIVITY_CATEGORIES = new Set([
  "work_meeting",
  "learning",
  "social_call",
  "in_person_conversation",
  "entertainment",
  "gaming",
  "other",
  "unknown",
]);
const ACTIVITY_DECISIONS = new Set(["adopted", "tentative", "unknown"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function literalTerms(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim())),
  ]
    .filter(Boolean)
    .sort(
      (left, right) =>
        Array.from(right).length - Array.from(left).length || left.localeCompare(right)
    );
}

function compileLiteralReplacements(values, replacementFor) {
  return literalTerms(values).map((value) => ({
    pattern: new RegExp(escapeRegExp(value), "giu"),
    replacement: replacementFor(value),
  }));
}

function applyReplacements(text, replacements) {
  let output = text;
  for (const { pattern, replacement } of replacements) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return output;
}

const GENERIC_REDACTION_REPLACEMENTS = Object.freeze([
  Object.freeze({ pattern: /\bBearer\s+[^\s"'<>]+/giu, replacement: "[SECRET]" }),
  Object.freeze({ pattern: /\bsk-(?:cp-)?[A-Za-z0-9_-]{8,}\b/giu, replacement: "[SECRET]" }),
  Object.freeze({
    pattern: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    replacement: "[SECRET]",
  }),
  Object.freeze({
    pattern:
      /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    replacement: "[SECRET]",
  }),
  Object.freeze({
    pattern: /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/gu,
    replacement: "[PATH]",
  }),
  Object.freeze({
    pattern: /(^|[\s(=])(?:[A-Za-z]:[\\/]|\\\\)[^"'<>\r\n,;)\]}]*/gu,
    replacement: (_match, prefix) => `${prefix}[PATH]`,
  }),
  Object.freeze({
    pattern: /(^|[\s(=])\/(?!\/)[^"'<>\r\n,;)\]}]*/gu,
    replacement: (_match, prefix) => `${prefix}[PATH]`,
  }),
]);

function compileRedactionTerms(redactionTerms) {
  const participants = Array.isArray(redactionTerms?.participants)
    ? redactionTerms.participants
    : [];
  const participantNames = [];
  for (const participant of participants) {
    if (
      !participant ||
      !LABEL_PATTERN.test(participant.label) ||
      !Array.isArray(participant.names)
    ) {
      continue;
    }
    for (const name of participant.names) {
      if (typeof name === "string" && name.trim()) {
        participantNames.push({ name: name.trim(), label: participant.label });
      }
    }
  }
  participantNames.sort(
    (left, right) =>
      Array.from(right.name).length - Array.from(left.name).length ||
      left.name.localeCompare(right.name) ||
      left.label.localeCompare(right.label)
  );
  const participantReplacements = participantNames.map((participant) => ({
    pattern: new RegExp(escapeRegExp(participant.name), "giu"),
    replacement: participant.label,
  }));
  const peopleReplacements = compileLiteralReplacements(
    redactionTerms?.otherPeople ?? [],
    () => "[PERSON]"
  );
  const deviceReplacements = compileLiteralReplacements(
    redactionTerms?.deviceLabels ?? [],
    () => "[DEVICE]"
  );
  return (text) => {
    let output = applyReplacements(text, participantReplacements);
    output = applyReplacements(output, peopleReplacements);
    output = applyReplacements(output, deviceReplacements);
    return applyReplacements(output, GENERIC_REDACTION_REPLACEMENTS);
  };
}

function redactText(text, redactionTerms) {
  return compileRedactionTerms(redactionTerms)(text);
}

function normalizedSegmentContext(segment) {
  const applicationKey = segment.applicationKey ?? null;
  const sourceAttribution = segment.sourceAttribution ?? "mixed_unknown";
  const activityCategory = segment.activityCategory ?? "unknown";
  const activityConfidence = segment.activityConfidence ?? 0;
  const activityDecision = segment.activityDecision ?? "unknown";
  const selfParticipated = segment.selfParticipated ?? segment.speakerBindingLabel === "SELF";
  if (
    (applicationKey !== null &&
      (typeof applicationKey !== "string" || !APPLICATION_KEY_PATTERN.test(applicationKey))) ||
    !SOURCE_ATTRIBUTIONS.has(sourceAttribution) ||
    !ACTIVITY_CATEGORIES.has(activityCategory) ||
    typeof activityConfidence !== "number" ||
    !Number.isFinite(activityConfidence) ||
    activityConfidence < 0 ||
    activityConfidence > 1 ||
    !ACTIVITY_DECISIONS.has(activityDecision) ||
    typeof selfParticipated !== "boolean" ||
    (["application", "application_and_microphone"].includes(sourceAttribution) &&
      applicationKey === null) ||
    (["microphone", "mixed_unknown"].includes(sourceAttribution) && applicationKey !== null)
  ) {
    throw new TypeError("prepared segment is invalid");
  }

  let memoryMode = "summary_only";
  let allowedSuggestionBases = [];
  let todoCandidateAllowed = false;
  if (activityCategory === "unknown" || activityDecision === "unknown") {
    memoryMode = "transcript_only";
  } else if (sourceAttribution === "mixed_unknown") {
    memoryMode = "summary_only";
  } else if (activityCategory === "entertainment" || activityCategory === "gaming") {
    memoryMode =
      activityDecision === "adopted" && activityConfidence >= 0.8
        ? "interest_only"
        : "summary_only";
  } else if (activityDecision === "adopted" && activityConfidence >= 0.8 && selfParticipated) {
    memoryMode = "full";
    if (activityCategory === "work_meeting") {
      allowedSuggestionBases = ["work_context"];
      todoCandidateAllowed = true;
    } else if (activityCategory === "learning") {
      allowedSuggestionBases = ["learning_goal"];
      todoCandidateAllowed = true;
    } else if (
      activityCategory === "social_call" ||
      activityCategory === "in_person_conversation"
    ) {
      allowedSuggestionBases = ["explicit_agreement"];
      todoCandidateAllowed = true;
    }
  }
  return {
    applicationKey,
    sourceAttribution,
    activityCategory,
    activityConfidence: Number(activityConfidence.toFixed(4)),
    activityDecision,
    selfParticipated,
    memoryMode,
    allowedSuggestionBases,
    todoCandidateAllowed,
  };
}

function normalizeSegments(preparedSnapshot) {
  if (!Array.isArray(preparedSnapshot.segments)) throw new TypeError("segments must be an array");
  const labels = new Set(
    (Array.isArray(preparedSnapshot.speakerBindings) ? preparedSnapshot.speakerBindings : []).map(
      (binding) => binding?.label
    )
  );
  const ids = new Set();
  const redact = compileRedactionTerms(preparedSnapshot.redactionTerms);
  const segments = preparedSnapshot.segments.map((segment) => {
    plainObject(segment, "segment");
    if (
      typeof segment.segmentId !== "string" ||
      !segment.segmentId ||
      ids.has(segment.segmentId) ||
      !Number.isSafeInteger(segment.startedAt) ||
      !Number.isSafeInteger(segment.endedAt) ||
      segment.startedAt < 0 ||
      segment.endedAt <= segment.startedAt ||
      typeof segment.textSnapshot !== "string" ||
      !segment.textSnapshot ||
      segment.resultKind !== "final" ||
      segment.isStable !== true ||
      segment.isCurrent !== true ||
      segment.supersededBy !== null ||
      segment.duplicateOf !== null ||
      !LABEL_PATTERN.test(segment.speakerBindingLabel) ||
      !labels.has(segment.speakerBindingLabel)
    ) {
      throw new TypeError("prepared segment is invalid");
    }
    ids.add(segment.segmentId);
    const context = normalizedSegmentContext(segment);
    return {
      segmentId: segment.segmentId,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      speakerLabel: segment.speakerBindingLabel,
      ...context,
      text: redact(segment.textSnapshot),
    };
  });
  return segments.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.endedAt - right.endedAt ||
      left.segmentId.localeCompare(right.segmentId)
  );
}

function normalizeLearningGoals(preparedSnapshot) {
  const goals = preparedSnapshot.learningGoals ?? [];
  if (!Array.isArray(goals) || goals.length > 32) {
    throw new TypeError("learningGoals must be an array with at most 32 entries");
  }
  const redact = compileRedactionTerms(preparedSnapshot.redactionTerms);
  const ids = new Set();
  return goals
    .map((goal) => {
      plainObject(goal, "learningGoal");
      if (
        !exactKeys(goal, ["goalId", "title"]) ||
        typeof goal.goalId !== "string" ||
        !LEARNING_GOAL_ID_PATTERN.test(goal.goalId) ||
        ids.has(goal.goalId) ||
        typeof goal.title !== "string" ||
        !goal.title.trim() ||
        Array.from(goal.title).length > 500
      ) {
        throw new TypeError("prepared learning goal is invalid");
      }
      ids.add(goal.goalId);
      return { goalId: goal.goalId, title: redact(goal.title.trim()) };
    })
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
}

function collapsedOmittedRanges(segments, selectedIds) {
  return segments
    .filter((segment) => !selectedIds.has(segment.segmentId))
    .map((segment) => ({ startedAt: segment.startedAt, endedAt: segment.endedAt }))
    .sort((left, right) => left.startedAt - right.startedAt || left.endedAt - right.endedAt)
    .reduce((ranges, range) => {
      const previous = ranges.at(-1);
      if (previous && range.startedAt <= previous.endedAt) {
        previous.endedAt = Math.max(previous.endedAt, range.endedAt);
      } else {
        ranges.push({ ...range });
      }
      return ranges;
    }, []);
}

function payloadFor(segments, selected, learningGoals = []) {
  const selectedIds = new Set(selected.map((segment) => segment.segmentId));
  return {
    inputVersion: INPUT_CONTRACT_VERSION,
    ...(learningGoals.length > 0
      ? { learningGoals: learningGoals.map((goal) => ({ ...goal })) }
      : {}),
    segments: selected.map((segment) => ({ ...segment })),
    omittedRanges: collapsedOmittedRanges(segments, selectedIds),
  };
}

function timelineCoverageOrder(length) {
  if (length === 0) return [];
  if (length === 1) return [0];
  const order = [0, length - 1];
  const queued = [[1, length - 2]];
  while (queued.length > 0) {
    const [start, end] = queued.shift();
    if (start > end) continue;
    const middle = Math.floor((start + end) / 2);
    order.push(middle);
    queued.push([start, middle - 1], [middle + 1, end]);
  }
  return order;
}

function hierarchicalCoverageOrder(segments, windowMs = HIERARCHICAL_WINDOW_MS) {
  if (segments.length === 0) return [];
  const origin = segments[0].startedAt;
  const windows = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const windowIndex = Math.floor(Math.max(0, segments[index].startedAt - origin) / windowMs);
    const indices = windows.get(windowIndex) ?? [];
    indices.push(index);
    windows.set(windowIndex, indices);
  }
  const perWindow = [...windows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, indices]) => timelineCoverageOrder(indices.length).map((index) => indices[index]));
  const order = [];
  for (let depth = 0; ; depth += 1) {
    let appended = false;
    for (const window of perWindow) {
      if (depth >= window.length) continue;
      order.push(window[depth]);
      appended = true;
    }
    if (!appended) return order;
  }
}

class AnalysisInputBuilder {
  constructor({ maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 64) {
      throw new TypeError("maxPayloadBytes must be a safe integer of at least 64");
    }
    this.maxPayloadBytes = maxPayloadBytes;
  }

  build(preparedSnapshot, { cursor = 0, strategy = "sequential" } = {}) {
    const prepared = plainObject(preparedSnapshot, "preparedSnapshot");
    const segments = normalizeSegments(prepared);
    const learningGoals = normalizeLearningGoals(prepared);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > segments.length) {
      throw new TypeError("cursor is invalid");
    }
    if (!new Set(["sequential", "timeline", "hierarchical"]).has(strategy)) {
      throw new TypeError("strategy is invalid");
    }
    if (strategy !== "sequential" && cursor !== 0) {
      throw new TypeError(`${strategy} strategy does not accept a cursor`);
    }

    const selected = [];
    let nextCursor = cursor;
    const selectionOrder =
      strategy === "timeline"
        ? timelineCoverageOrder(segments.length)
        : strategy === "hierarchical"
          ? hierarchicalCoverageOrder(segments)
          : Array.from({ length: segments.length - cursor }, (_value, index) => cursor + index);
    for (const index of selectionOrder) {
      const nextSelected =
        strategy !== "sequential"
          ? [...selected, segments[index]].sort(
              (left, right) =>
                left.startedAt - right.startedAt ||
                left.endedAt - right.endedAt ||
                left.segmentId.localeCompare(right.segmentId)
            )
          : [...selected, segments[index]];
      const candidate = payloadFor(segments, nextSelected, learningGoals);
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (candidateBytes > this.maxPayloadBytes) {
        if (strategy === "sequential" && selected.length > 0) {
          nextCursor = index;
          break;
        }
        if (strategy === "sequential") nextCursor = index + 1;
        continue;
      }
      selected.splice(0, selected.length, ...nextSelected);
      if (strategy === "sequential") nextCursor = index + 1;
    }
    if (strategy !== "sequential") nextCursor = segments.length;

    const cloudPayload = payloadFor(segments, selected, learningGoals);
    const cloudPayloadJson = JSON.stringify(cloudPayload);
    const selectedOwnerLabels = [...new Set(selected.map((segment) => segment.speakerLabel))];
    const localBindings = structuredClone(
      Array.isArray(prepared.speakerBindings) ? prepared.speakerBindings : []
    );
    return {
      sendable: selected.length > 0,
      ...(selected.length > 0 ? {} : { reason: "budget_exceeded" }),
      inputContractVersion: INPUT_CONTRACT_VERSION,
      redactionVersion: REDACTION_VERSION,
      cloudPayload,
      cloudPayloadJson,
      local: {
        prepareToken: prepared.prepareToken,
        selectedSegmentIds: selected.map((segment) => segment.segmentId),
        allowedOwnerLabels: selectedOwnerLabels,
        pseudonymBindings: localBindings,
        nextCursor,
        complete:
          strategy !== "sequential"
            ? selected.length === segments.length
            : nextCursor >= segments.length,
        inputBytes: Buffer.byteLength(cloudPayloadJson, "utf8"),
        payloadHash: sha256(cloudPayloadJson),
      },
    };
  }

  verifyRedactedCloudPayload({ cloudPayload, preparedSnapshot } = {}) {
    try {
      const payload = plainObject(cloudPayload, "cloudPayload");
      const prepared = plainObject(preparedSnapshot, "preparedSnapshot");
      const expectedLearningGoals = normalizeLearningGoals(prepared);
      const expectedPayloadKeys =
        expectedLearningGoals.length > 0
          ? ["inputVersion", "learningGoals", "segments", "omittedRanges"]
          : ["inputVersion", "segments", "omittedRanges"];
      if (
        !exactKeys(payload, expectedPayloadKeys) ||
        payload.inputVersion !== INPUT_CONTRACT_VERSION ||
        (expectedLearningGoals.length > 0 &&
          JSON.stringify(payload.learningGoals) !== JSON.stringify(expectedLearningGoals)) ||
        !Array.isArray(payload.segments) ||
        payload.segments.length === 0 ||
        !Array.isArray(payload.omittedRanges) ||
        Buffer.byteLength(JSON.stringify(payload), "utf8") > this.maxPayloadBytes
      ) {
        return false;
      }
      const expected = normalizeSegments(prepared);
      const expectedById = new Map(expected.map((segment) => [segment.segmentId, segment]));
      const selectedIds = new Set();
      let previous = null;
      for (const segment of payload.segments) {
        if (
          !exactKeys(segment, [
            "segmentId",
            "startedAt",
            "endedAt",
            "speakerLabel",
            "applicationKey",
            "sourceAttribution",
            "activityCategory",
            "activityConfidence",
            "activityDecision",
            "selfParticipated",
            "memoryMode",
            "allowedSuggestionBases",
            "todoCandidateAllowed",
            "text",
          ])
        ) {
          return false;
        }
        const expectedSegment = expectedById.get(segment.segmentId);
        if (!expectedSegment || selectedIds.has(segment.segmentId)) return false;
        if (JSON.stringify(segment) !== JSON.stringify(expectedSegment)) return false;
        if (
          previous &&
          (segment.startedAt < previous.startedAt ||
            (segment.startedAt === previous.startedAt && segment.endedAt < previous.endedAt) ||
            (segment.startedAt === previous.startedAt &&
              segment.endedAt === previous.endedAt &&
              segment.segmentId.localeCompare(previous.segmentId) < 0))
        ) {
          return false;
        }
        selectedIds.add(segment.segmentId);
        previous = segment;
      }
      const expectedRanges = collapsedOmittedRanges(expected, selectedIds);
      return JSON.stringify(payload.omittedRanges) === JSON.stringify(expectedRanges);
    } catch {
      return false;
    }
  }
}

module.exports = AnalysisInputBuilder;
module.exports.INPUT_CONTRACT_VERSION = INPUT_CONTRACT_VERSION;
module.exports.LEGACY_INPUT_CONTRACT_VERSION = LEGACY_INPUT_CONTRACT_VERSION;
module.exports.REDACTION_VERSION = REDACTION_VERSION;
module.exports.DEFAULT_MAX_PAYLOAD_BYTES = DEFAULT_MAX_PAYLOAD_BYTES;
module.exports.redactText = redactText;
module.exports.compileRedactionTerms = compileRedactionTerms;
module.exports.normalizedSegmentContext = normalizedSegmentContext;
