const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function hashPart(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hashIdentifier(value) {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hashPart(value, seed))
    .join("");
}

function createStableSegmentId(sessionId, rawSegmentId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must not be empty");
  }
  if (typeof rawSegmentId !== "string" || rawSegmentId.length === 0) {
    throw new TypeError("rawSegmentId must not be empty");
  }

  const namespaced = `${sessionId}__${rawSegmentId}`;
  return SAFE_ID.test(namespaced)
    ? namespaced
    : `seg_${hashIdentifier(`${sessionId}\0${rawSegmentId}`)}`;
}

module.exports = { createStableSegmentId };
