const crypto = require("node:crypto");

const INPUT_CONTRACT_VERSION = "jarvis-analysis-input-v2";
const REDACTION_VERSION = "jarvis-redaction-v1";
const DEFAULT_MAX_PAYLOAD_BYTES = 96 * 1024;
const LABEL_PATTERN = /^(?:SELF|P[1-9][0-9]*)$/u;

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
    return {
      segmentId: segment.segmentId,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      speakerLabel: segment.speakerBindingLabel,
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

function payloadFor(segments, selected) {
  const selectedIds = new Set(selected.map((segment) => segment.segmentId));
  return {
    inputVersion: INPUT_CONTRACT_VERSION,
    segments: selected.map((segment) => ({ ...segment })),
    omittedRanges: collapsedOmittedRanges(segments, selectedIds),
  };
}

class AnalysisInputBuilder {
  constructor({ maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 64) {
      throw new TypeError("maxPayloadBytes must be a safe integer of at least 64");
    }
    this.maxPayloadBytes = maxPayloadBytes;
  }

  build(preparedSnapshot, { cursor = 0 } = {}) {
    const prepared = plainObject(preparedSnapshot, "preparedSnapshot");
    const segments = normalizeSegments(prepared);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > segments.length) {
      throw new TypeError("cursor is invalid");
    }

    const selected = [];
    let nextCursor = cursor;
    for (let index = cursor; index < segments.length; index += 1) {
      const candidate = payloadFor(segments, [...selected, segments[index]]);
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (candidateBytes > this.maxPayloadBytes) {
        if (selected.length > 0) {
          nextCursor = index;
          break;
        }
        nextCursor = index + 1;
        continue;
      }
      selected.push(segments[index]);
      nextCursor = index + 1;
    }

    const cloudPayload = payloadFor(segments, selected);
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
        complete: nextCursor >= segments.length,
        inputBytes: Buffer.byteLength(cloudPayloadJson, "utf8"),
        payloadHash: sha256(cloudPayloadJson),
      },
    };
  }

  verifyRedactedCloudPayload({ cloudPayload, preparedSnapshot } = {}) {
    try {
      const payload = plainObject(cloudPayload, "cloudPayload");
      const prepared = plainObject(preparedSnapshot, "preparedSnapshot");
      if (
        !exactKeys(payload, ["inputVersion", "segments", "omittedRanges"]) ||
        payload.inputVersion !== INPUT_CONTRACT_VERSION ||
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
        if (!exactKeys(segment, ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"])) {
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
module.exports.REDACTION_VERSION = REDACTION_VERSION;
module.exports.DEFAULT_MAX_PAYLOAD_BYTES = DEFAULT_MAX_PAYLOAD_BYTES;
module.exports.redactText = redactText;
module.exports.compileRedactionTerms = compileRedactionTerms;
