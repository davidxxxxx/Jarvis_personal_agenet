function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 64) {
    throw new RangeError(`${name} must be a safe speaker count`);
  }
  return value;
}

function buildSpeakerCountConsensus({
  primaryCount,
  verifierCount = null,
  verifierLimit = 4,
} = {}) {
  const primary = assertCount(primaryCount, "primaryCount");
  const limit = assertCount(verifierLimit, "verifierLimit");
  if (verifierCount === null || primary > limit) {
    return Object.freeze({
      minimum: primary,
      maximum: primary,
      preferred: primary,
      confidence: primary === 0 ? 1 : 0.72,
      state: primary > limit ? "primary_only_above_verifier_limit" : "primary_only",
    });
  }
  const verifier = assertCount(verifierCount, "verifierCount");
  if (primary === verifier) {
    return Object.freeze({
      minimum: primary,
      maximum: primary,
      preferred: primary,
      confidence: 0.94,
      state: "models_agree",
    });
  }
  return Object.freeze({
    minimum: Math.min(primary, verifier),
    maximum: Math.max(primary, verifier),
    preferred: primary,
    confidence: 0.55,
    state: "models_disagree",
  });
}

function findOverlapWindows(turns, { paddingMs = 250, durationMs = null } = {}) {
  if (!Array.isArray(turns)) throw new TypeError("turns must be an array");
  if (!Number.isSafeInteger(paddingMs) || paddingMs < 0 || paddingMs > 5_000) {
    throw new RangeError("paddingMs must be between zero and five seconds");
  }
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) {
    throw new RangeError("durationMs must be null or a non-negative safe integer");
  }
  const events = [];
  for (const turn of turns) {
    const startMs = Math.round(turn?.startMs ?? turn?.start * 1_000);
    const endMs = Math.round(turn?.endMs ?? turn?.end * 1_000);
    const speaker = turn?.speaker ?? turn?.label ?? turn?.rawLabel;
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      typeof speaker !== "string" ||
      !speaker
    ) {
      throw new TypeError("invalid diarization turn");
    }
    events.push({ at: startMs, kind: 1, speaker });
    events.push({ at: endMs, kind: -1, speaker });
  }
  events.sort((left, right) => left.at - right.at || left.kind - right.kind);
  const active = new Map();
  const raw = [];
  let overlapStartedAt = null;
  for (const event of events) {
    const wasOverlap = active.size >= 2;
    const next = (active.get(event.speaker) ?? 0) + event.kind;
    if (next <= 0) active.delete(event.speaker);
    else active.set(event.speaker, next);
    const isOverlap = active.size >= 2;
    if (!wasOverlap && isOverlap) overlapStartedAt = event.at;
    if (wasOverlap && !isOverlap && overlapStartedAt !== null && event.at > overlapStartedAt) {
      raw.push({ startMs: overlapStartedAt, endMs: event.at });
      overlapStartedAt = null;
    }
  }
  const padded = raw.map((window) => ({
    startMs: Math.max(0, window.startMs - paddingMs),
    endMs:
      durationMs === null
        ? window.endMs + paddingMs
        : Math.min(durationMs, window.endMs + paddingMs),
  }));
  const merged = [];
  for (const window of padded) {
    const previous = merged.at(-1);
    if (previous && window.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }
  return Object.freeze(merged.map((window) => Object.freeze(window)));
}

module.exports = {
  buildSpeakerCountConsensus,
  findOverlapWindows,
};
