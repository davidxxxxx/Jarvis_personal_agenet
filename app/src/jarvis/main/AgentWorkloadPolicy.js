const AGENT_WORK_PRIORITY = Object.freeze({
  analyze_session: 70,
  generate_daily_digest: 80,
});

const TOP_LEVEL_KEYS = new Set([
  "snapshotVersion",
  "kind",
  "manifest",
  "desiredHead",
  "backlog",
  "captureActive",
  "previewActive",
  "pressure",
  "cloudLaneInFlight",
]);
const DIGEST_TOP_LEVEL_KEYS = new Set([
  "snapshotVersion",
  "kind",
  "sourceCurrent",
  "sourceFinalOnly",
  "backlog",
  "captureActive",
  "previewActive",
  "pressure",
  "cloudLaneInFlight",
]);
const MANIFEST_KEYS = new Set([
  "manifestVersion",
  "sessionId",
  "sessionState",
  "processingState",
  "analysisInputId",
  "analysisInputHash",
  "transcriptRevision",
  "identityRevision",
  "promptVersion",
  "responseSchemaVersion",
  "pseudonymBindingRevision",
  "modelVersion",
  "cloudPayloadHash",
  "segments",
]);
const DESIRED_HEAD_KEYS = new Set([
  "analysisInputId",
  "analysisInputHash",
  "transcriptRevision",
  "identityRevision",
  "promptVersion",
  "responseSchemaVersion",
  "pseudonymBindingRevision",
  "modelVersion",
  "cloudPayloadHash",
  "segments",
]);
const MANIFEST_SEGMENT_KEYS = new Set([
  "ordinal",
  "segmentId",
  "segmentVersion",
  "textHash",
  "subjectRevision",
  "final",
  "stable",
  "current",
  "duplicate",
  "identityKind",
]);
const DESIRED_SEGMENT_KEYS = new Set([
  "ordinal",
  "segmentId",
  "segmentVersion",
  "textHash",
  "subjectRevision",
]);
const BACKLOG_KEYS = new Set(["jobType", "lane", "state", "priority", "nextRetryAt"]);
const PRESSURE_KEYS = new Set([
  "state",
  "reason",
  "cpuLoadPct",
  "memoryLoadPct",
  "onAcPower",
  "batteryLevelPct",
]);
const SESSION_STATES = new Set(["active", "ended", "recovered_terminal"]);
const PROCESSING_STATES = new Set(["pending", "processing", "ready"]);
const IDENTITY_KINDS = new Set(["durable_subject", "temporary_subject", "unresolved"]);
const JOB_LANES = new Set(["local", "cloud"]);
const JOB_STATES = new Set([
  "pending",
  "running",
  "retry",
  "completed",
  "superseded",
  "blocked",
  "failed",
  "cancelled",
  "audio_expired_before_processing",
]);
const PRESSURE_STATES = new Set(["normal", "busy", "constrained", "battery_saver"]);
const ACTIONABLE_JOB_STATES = new Set(["pending", "running", "retry"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_SNAPSHOTS = new WeakSet();

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (key === "nextRetryAt" || PRESSURE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name}.${key} is required`);
    }
  }
}

function text(value, name, maxLength = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function hash(value, name) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function enumValue(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function nullableMetric(value, name, { booleanMetric = false } = {}) {
  if (value === undefined || value === null) return;
  if (booleanMetric) {
    if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean or null`);
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`${name} must be a number from 0 to 100 or null`);
  }
}

function validateOrderedSegments(segments, { desired = false } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new TypeError(`${desired ? "desired" : "manifest"} segments must not be empty`);
  }
  const ids = new Set();
  for (const [index, segmentValue] of segments.entries()) {
    const name = `${desired ? "desiredHead" : "manifest"}.segments[${index}]`;
    const segment = plainObject(segmentValue, name);
    exactKeys(segment, desired ? DESIRED_SEGMENT_KEYS : MANIFEST_SEGMENT_KEYS, name);
    if (segment.ordinal !== index) {
      throw new TypeError(
        `${desired ? "desired" : "manifest"} segment ordinals must be contiguous`
      );
    }
    text(segment.segmentId, `${name}.segmentId`);
    if (ids.has(segment.segmentId)) {
      throw new TypeError(`${desired ? "desired" : "manifest"} segment ids must be unique`);
    }
    ids.add(segment.segmentId);
    positiveInteger(segment.segmentVersion, `${name}.segmentVersion`);
    hash(segment.textHash, `${name}.textHash`);
    nonNegativeInteger(segment.subjectRevision, `${name}.subjectRevision`);
    if (!desired) {
      boolean(segment.final, `${name}.final`);
      boolean(segment.stable, `${name}.stable`);
      boolean(segment.current, `${name}.current`);
      boolean(segment.duplicate, `${name}.duplicate`);
      enumValue(segment.identityKind, IDENTITY_KINDS, `${name}.identityKind`);
    }
  }
}

function validateDesiredVector(value, { manifest = false } = {}) {
  const name = manifest ? "manifest" : "desiredHead";
  const vector = plainObject(value, name);
  exactKeys(vector, manifest ? MANIFEST_KEYS : DESIRED_HEAD_KEYS, name);
  text(vector.analysisInputId, `${name}.analysisInputId`);
  hash(vector.analysisInputHash, `${name}.analysisInputHash`);
  hash(vector.transcriptRevision, `${name}.transcriptRevision`);
  hash(vector.identityRevision, `${name}.identityRevision`);
  text(vector.promptVersion, `${name}.promptVersion`);
  text(vector.responseSchemaVersion, `${name}.responseSchemaVersion`);
  nonNegativeInteger(vector.pseudonymBindingRevision, `${name}.pseudonymBindingRevision`);
  text(vector.modelVersion, `${name}.modelVersion`);
  hash(vector.cloudPayloadHash, `${name}.cloudPayloadHash`);
  validateOrderedSegments(vector.segments, { desired: !manifest });
  if (manifest) {
    positiveInteger(vector.manifestVersion, "manifest.manifestVersion");
    text(vector.sessionId, "manifest.sessionId");
    enumValue(vector.sessionState, SESSION_STATES, "manifest.sessionState");
    enumValue(vector.processingState, PROCESSING_STATES, "manifest.processingState");
  }
}

function validateBacklog(value) {
  if (!Array.isArray(value)) throw new TypeError("backlog must be an array");
  for (const [index, jobValue] of value.entries()) {
    const name = `backlog[${index}]`;
    const job = plainObject(jobValue, name);
    exactKeys(job, BACKLOG_KEYS, name);
    text(job.jobType, `${name}.jobType`);
    enumValue(job.lane, JOB_LANES, `${name}.lane`);
    enumValue(job.state, JOB_STATES, `${name}.state`);
    nonNegativeInteger(job.priority, `${name}.priority`);
    if (job.nextRetryAt !== undefined && job.nextRetryAt !== null) {
      nonNegativeInteger(job.nextRetryAt, `${name}.nextRetryAt`);
    }
  }
}

function validatePressure(value) {
  const pressure = plainObject(value, "pressure");
  exactKeys(pressure, PRESSURE_KEYS, "pressure");
  enumValue(pressure.state, PRESSURE_STATES, "pressure.state");
  if (pressure.reason !== null && pressure.reason !== undefined) {
    text(pressure.reason, "pressure.reason");
  }
  nullableMetric(pressure.cpuLoadPct, "pressure.cpuLoadPct");
  nullableMetric(pressure.memoryLoadPct, "pressure.memoryLoadPct");
  nullableMetric(pressure.onAcPower, "pressure.onAcPower", { booleanMetric: true });
  nullableMetric(pressure.batteryLevelPct, "pressure.batteryLevelPct");
}

function validateSnapshot(value) {
  const snapshot = plainObject(value, "admission snapshot");
  if (snapshot.kind === "generate_daily_digest") {
    exactKeys(snapshot, DIGEST_TOP_LEVEL_KEYS, "admission snapshot");
    if (snapshot.snapshotVersion !== 1) throw new TypeError("snapshotVersion must be 1");
    boolean(snapshot.sourceCurrent, "sourceCurrent");
    boolean(snapshot.sourceFinalOnly, "sourceFinalOnly");
    validateBacklog(snapshot.backlog);
    boolean(snapshot.captureActive, "captureActive");
    boolean(snapshot.previewActive, "previewActive");
    validatePressure(snapshot.pressure);
    nonNegativeInteger(snapshot.cloudLaneInFlight, "cloudLaneInFlight");
    return snapshot;
  }
  exactKeys(snapshot, TOP_LEVEL_KEYS, "admission snapshot");
  if (snapshot.snapshotVersion !== 1) throw new TypeError("snapshotVersion must be 1");
  if (snapshot.kind !== "analyze_session") {
    throw new TypeError("kind must be analyze_session");
  }
  validateDesiredVector(snapshot.manifest, { manifest: true });
  validateDesiredVector(snapshot.desiredHead);
  validateBacklog(snapshot.backlog);
  boolean(snapshot.captureActive, "captureActive");
  boolean(snapshot.previewActive, "previewActive");
  validatePressure(snapshot.pressure);
  nonNegativeInteger(snapshot.cloudLaneInFlight, "cloudLaneInFlight");
  return snapshot;
}

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (value && typeof value === "object") {
    plainObject(value, "snapshot value");
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneData(child)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function freezeAgentAdmissionSnapshot(raw) {
  const snapshot = cloneData(raw);
  validateSnapshot(snapshot);
  const frozen = deepFreeze(snapshot);
  CANONICAL_SNAPSHOTS.add(frozen);
  return frozen;
}

function desiredVectorMatches(manifest, desiredHead) {
  for (const key of [
    "analysisInputId",
    "analysisInputHash",
    "transcriptRevision",
    "identityRevision",
    "promptVersion",
    "responseSchemaVersion",
    "pseudonymBindingRevision",
    "modelVersion",
    "cloudPayloadHash",
  ]) {
    if (manifest[key] !== desiredHead[key]) return false;
  }
  if (manifest.segments.length !== desiredHead.segments.length) return false;
  return manifest.segments.every((segment, index) => {
    const desired = desiredHead.segments[index];
    return ["ordinal", "segmentId", "segmentVersion", "textHash", "subjectRevision"].every(
      (key) => segment[key] === desired[key]
    );
  });
}

function hasFinalOnlyInput(manifest) {
  return (
    ["ended", "recovered_terminal"].includes(manifest.sessionState) &&
    manifest.processingState === "ready" &&
    manifest.segments.every(
      (segment) =>
        segment.final &&
        segment.stable &&
        segment.current &&
        !segment.duplicate &&
        segment.identityKind !== "unresolved"
    )
  );
}

function decision(kind, eligible, reason) {
  return Object.freeze({ eligible, reason, priority: AGENT_WORK_PRIORITY[kind] });
}

class AgentWorkloadPolicy {
  constructor() {
    Object.freeze(this);
  }

  evaluate(snapshot) {
    if (!CANONICAL_SNAPSHOTS.has(snapshot)) {
      throw new TypeError("snapshot must be created by freezeAgentAdmissionSnapshot");
    }
    validateSnapshot(snapshot);
    const kind = snapshot.kind;
    if (kind === "analyze_session") {
      if (!desiredVectorMatches(snapshot.manifest, snapshot.desiredHead)) {
        return decision(kind, false, "current_input_superseded");
      }
      if (!hasFinalOnlyInput(snapshot.manifest)) {
        return decision(kind, false, "final_inputs_pending");
      }
    } else {
      if (!snapshot.sourceCurrent) {
        return decision(kind, false, "current_input_superseded");
      }
      if (!snapshot.sourceFinalOnly) {
        return decision(kind, false, "final_inputs_pending");
      }
    }
    if (
      snapshot.backlog.some(
        (job) =>
          (kind === "generate_daily_digest" || job.lane === "local") &&
          ACTIONABLE_JOB_STATES.has(job.state) &&
          job.priority < AGENT_WORK_PRIORITY[kind]
      )
    ) {
      return decision(kind, false, "higher_priority_backlog");
    }
    if (snapshot.captureActive || snapshot.previewActive) {
      return decision(kind, false, "preview_active");
    }
    if (snapshot.pressure.state !== "normal") {
      return decision(kind, false, "system_constrained");
    }
    if (snapshot.cloudLaneInFlight > 0) {
      return decision(kind, false, "cloud_lane_busy");
    }
    return decision(kind, true, null);
  }
}

module.exports = AgentWorkloadPolicy;
module.exports.AgentWorkloadPolicy = AgentWorkloadPolicy;
module.exports.AGENT_WORK_PRIORITY = AGENT_WORK_PRIORITY;
module.exports.freezeAgentAdmissionSnapshot = freezeAgentAdmissionSnapshot;
