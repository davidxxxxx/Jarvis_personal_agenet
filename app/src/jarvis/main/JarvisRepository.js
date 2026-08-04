const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const path = require("node:path");
const { assertCaptureMode, assertId, assertSessionStatus } = require("../shared/contracts");
const {
  RETENTION_MODES,
  assertRetentionMode,
  normalizeCapturePolicy,
} = require("../shared/captureModes");
const CaptureEvidenceStore = require("./CaptureEvidenceStore");
const MemoryRepository = require("./MemoryRepository");
const SpeakerIdentityRepository = require("./SpeakerIdentityRepository");
const ActivityClassificationRepository = require("./ActivityClassificationRepository");
const TodoReminderRepository = require("./TodoReminderRepository");
const LearningGoalRepository = require("./LearningGoalRepository");
const PersonalizationFeedbackRepository = require("./PersonalizationFeedbackRepository");
const {
  applyJarvisMigrations,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
} = require("./JarvisMigrations");
const { toPublicAudioChunk } = require("./AudioChunkPublicView");
const {
  SESSION_DIARIZATION_POLICY,
  buildDiarizationJobKey,
} = require("./SessionDiarizationPolicy");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
  assertExactIdentityResolutionPolicy,
  buildIdentityResolutionJobKey,
} = require("./SpeakerIdentityResolutionPolicy");
const { SPEAKER_MODEL_KEYS, getSpeakerModelManifest } = require("./SpeakerModelManifest");
const { buildBilingualPrompt, classifyTranscriptQuality } = require("./transcriptionQuality");
const ApplicationAudioPolicy = require("./ApplicationAudioPolicy");
const { PROJECTOR_VERSION, projectSessionParticipants } = require("./SessionParticipantProjector");
const { computeSessionSemanticHashes } = require("./SessionReprocessingSemantics");

const TERMINAL_SESSION_STATUSES = new Set(["completed", "recovered", "failed"]);
const SUMMARY_REFRESH_REASONS = new Set([
  "speaker_count_changed",
  "speaker_identity_changed",
  "application_source_changed",
  "transcript_changed",
  "activity_classification_changed",
  "manual_request",
]);
const SEGMENT_SESSION_MISMATCH_MESSAGE = "segment belongs to a different session";
const MAX_SPEAKER_NAME_CODE_POINTS = 80;
const DEFAULT_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MIN_CLOUD_LIMIT_MICROUSD = 5_000_000;
const MAX_CLOUD_LIMIT_MICROUSD = 10_000_000;
const CLOUD_RESERVATION_MICROUSD = 100_000;
const TRANSCRIPT_PROMPT_CODE_POINT_LIMIT = 1_024;
const TRANSCRIPT_CONTEXT_CODE_POINT_LIMIT = 800;
const TRANSCRIPT_PROMPT_UNEXPECTED_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const STABLE_CLUSTER_REUSE_THRESHOLD = 0.82;
const STABLE_CLUSTER_REUSE_MARGIN = 0.05;
const MIN_APPLICATION_DIARIZATION_AUDIO_MS = 60_000;
const EXACT_APPLICATION_SYSTEM_MIX_COVERAGE_THRESHOLD = 0.8;
const PUBLIC_SPEAKER_MIN_SPEECH_MS = 5_000;
const PUBLIC_SPEAKER_MIN_WINDOWS = 3;
const DIARIZATION_PRIORITY = Object.freeze({
  mic: 18,
  application: 26,
  system_mix: 28,
});
const LEGACY_TRACK_STATE_BY_SESSION_STATUS = Object.freeze({
  recording: "active",
  finalizing: "active",
  paused: "paused",
  completed: "ended",
  recovered: "recovered",
  failed: "failed",
});
const DUAL_SPEAKER_MANIFESTS = Object.freeze([
  getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY),
  getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW),
]);
const IDENTITY_PROFILE_DIMENSIONS = new Map([
  [SPEAKER_IDENTITY_RESOLUTION_POLICY.modelId, 512],
  ...DUAL_SPEAKER_MANIFESTS.map((manifest) => [manifest.modelId, manifest.embeddingDimension]),
]);

function isPublicSpeakerCluster(cluster) {
  return Boolean(
    cluster &&
    (cluster.linkState === "confirmed" ||
      (cluster.speechMs >= PUBLIC_SPEAKER_MIN_SPEECH_MS &&
        cluster.windowCount >= PUBLIC_SPEAKER_MIN_WINDOWS))
  );
}

function mergeAudioRanges(chunks) {
  const ranges = chunks
    .map((chunk) => [chunk.started_at, chunk.ended_at])
    .filter(
      ([startedAt, endedAt]) =>
        Number.isSafeInteger(startedAt) && Number.isSafeInteger(endedAt) && endedAt > startedAt
    )
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) {
      merged.push([...range]);
    } else {
      previous[1] = Math.max(previous[1], range[1]);
    }
  }
  return merged;
}

function coveredAudioRatio(targetChunks, coveringChunks) {
  const targets = mergeAudioRanges(targetChunks);
  const coverings = mergeAudioRanges(coveringChunks);
  const targetMs = targets.reduce((total, range) => total + range[1] - range[0], 0);
  if (targetMs <= 0 || coverings.length === 0) return 0;
  let coveredMs = 0;
  let coveringIndex = 0;
  for (const target of targets) {
    while (coveringIndex < coverings.length && coverings[coveringIndex][1] <= target[0]) {
      coveringIndex += 1;
    }
    for (let index = coveringIndex; index < coverings.length; index += 1) {
      const covering = coverings[index];
      if (covering[0] >= target[1]) break;
      coveredMs += Math.max(0, Math.min(target[1], covering[1]) - Math.max(target[0], covering[0]));
    }
  }
  return Math.min(1, coveredMs / targetMs);
}

function selectLogicalAudioChunks(chunks) {
  const selected = [];
  for (const chunk of [...chunks].sort(
    (left, right) =>
      left.started_at - right.started_at ||
      right.ended_at - left.ended_at ||
      left.id.localeCompare(right.id)
  )) {
    const previous = selected.at(-1);
    if (!previous) {
      selected.push(chunk);
      continue;
    }
    if (chunk.started_at <= previous.started_at && chunk.ended_at >= previous.ended_at) {
      selected[selected.length - 1] = chunk;
      continue;
    }
    if (previous.started_at <= chunk.started_at && previous.ended_at >= chunk.ended_at) {
      continue;
    }
    selected.push(chunk);
  }
  return selected;
}

function preferredSpeakerEvidenceTracks(
  tracks,
  chunks,
  { completedApplicationTrackIds = new Set() } = {}
) {
  const audioMsByTrack = new Map();
  for (const chunk of chunks) {
    audioMsByTrack.set(
      chunk.track_id,
      (audioMsByTrack.get(chunk.track_id) ?? 0) + Math.max(0, chunk.duration_ms ?? 0)
    );
  }
  const applicationTracks = tracks
    .filter(
      (track) =>
        track.track_kind === "application" &&
        track.attribution_state === "exact" &&
        !ApplicationAudioPolicy.isVirtualAudioInfrastructure({
          applicationKey: track.application_key,
          applicationDisplayName: track.application_display_name,
        })
    )
    .sort(
      (left, right) =>
        (left.capture_generation ?? 0) - (right.capture_generation ?? 0) ||
        (left.started_at ?? 0) - (right.started_at ?? 0) ||
        left.id.localeCompare(right.id)
    );
  const applicationTracksByKey = new Map();
  for (const track of applicationTracks) {
    const members = applicationTracksByKey.get(track.application_key) ?? [];
    members.push(track);
    applicationTracksByKey.set(track.application_key, members);
  }
  const preferredApplicationByKey = new Map();
  const logicalMemberTrackIdsByCanonical = new Map();
  const logicalCanonicalTrackIdByMember = new Map();
  for (const [applicationKey, members] of applicationTracksByKey) {
    const aggregateAudioMs = members.reduce(
      (total, member) => total + (audioMsByTrack.get(member.id) ?? 0),
      0
    );
    if (
      aggregateAudioMs < MIN_APPLICATION_DIARIZATION_AUDIO_MS &&
      !members.some((member) => completedApplicationTrackIds.has(member.id))
    ) {
      continue;
    }
    const canonical = members[0];
    preferredApplicationByKey.set(applicationKey, canonical);
    audioMsByTrack.set(canonical.id, aggregateAudioMs);
    const memberIds = new Set(members.map((member) => member.id));
    logicalMemberTrackIdsByCanonical.set(canonical.id, memberIds);
    for (const memberId of memberIds) {
      logicalCanonicalTrackIdByMember.set(memberId, canonical.id);
    }
  }
  const qualifiedApplicationTrackIds = new Set(
    [...preferredApplicationByKey.values()].map((track) => track.id)
  );
  const exactApplicationChunks = chunks.filter((chunk) =>
    logicalCanonicalTrackIdByMember.has(chunk.track_id)
  );
  const coverageBySystemTrack = new Map();
  const preferred = tracks.filter((track) => {
    if (track.track_kind === "application") {
      return qualifiedApplicationTrackIds.has(track.id);
    }
    if (track.track_kind !== "system_mix") return true;
    const ratio = coveredAudioRatio(
      chunks.filter((chunk) => chunk.track_id === track.id),
      exactApplicationChunks
    );
    coverageBySystemTrack.set(track.id, ratio);
    return ratio < EXACT_APPLICATION_SYSTEM_MIX_COVERAGE_THRESHOLD;
  });
  return {
    preferred,
    coverageBySystemTrack,
    qualifiedApplicationTrackIds,
    logicalMemberTrackIdsByCanonical,
    logicalCanonicalTrackIdByMember,
    audioMsByTrack,
  };
}

function runtimeJobStage({ job_type: jobType, state, priority }) {
  if (state === "retention_urgent" || (jobType === "transcribe_chunk" && priority === 0)) {
    return "retention_urgent";
  }
  if (state === "storage_recovery_compress" || (jobType === "compress_chunk" && priority === 10)) {
    return "storage_recovery_compress";
  }
  if (jobType === "transcribe_chunk") return "final_transcription";
  if (jobType === "preview_transcription") return "preview";
  if (["speaker", "diarize_track", "resolve_identities"].includes(jobType)) return "speaker";
  if (jobType === "analyze_session") return "analysis";
  if (jobType === "compress_chunk") return "compression";
  return jobType;
}

function runtimeQueueState(state) {
  if (state === "running" || state === "retry" || state === "blocked") return state;
  return "pending";
}

function emptyRuntimeCounts() {
  return { pending: 0, running: 0, retry: 0, blocked: 0, total: 0 };
}

function legacyTrackLifecycle(session) {
  const state = LEGACY_TRACK_STATE_BY_SESSION_STATUS[session.status];
  if (!state) throw new Error(`unsupported legacy session status: ${session.status}`);
  const terminal = state === "ended" || state === "recovered" || state === "failed";
  return {
    state,
    endedAt: terminal ? (session.ended_at ?? session.started_at) : null,
  };
}

function compareStableIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function l2NormalizeEmbedding(embedding) {
  let squaredNorm = 0;
  for (const value of embedding) {
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= Number.EPSILON) return null;
  const norm = Math.sqrt(squaredNorm);
  return Float64Array.from(embedding, (value) => value / norm);
}

function cosineSimilarity(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

function hasStableReuseMargin(rankedPairs) {
  return (
    rankedPairs.length === 1 ||
    rankedPairs[0].score - rankedPairs[1].score >= STABLE_CLUSTER_REUSE_MARGIN
  );
}

function coveredDurationMs(rows, groupColumn) {
  let total = 0;
  let group = null;
  let rangeStart = null;
  let rangeEnd = null;
  const flush = () => {
    if (rangeStart !== null && rangeEnd !== null) total += Math.max(0, rangeEnd - rangeStart);
  };
  for (const row of rows) {
    const nextGroup = row[groupColumn];
    const startedAt = Number(row.started_at);
    const endedAt = Number(row.ended_at);
    if (nextGroup !== group) {
      flush();
      group = nextGroup;
      rangeStart = startedAt;
      rangeEnd = endedAt;
      continue;
    }
    if (startedAt > rangeEnd) {
      flush();
      rangeStart = startedAt;
      rangeEnd = endedAt;
    } else {
      rangeEnd = Math.max(rangeEnd, endedAt);
    }
  }
  flush();
  return total;
}

function normalizeSpeakerName(value) {
  if (typeof value !== "string") throw new TypeError("displayName must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("displayName must not be empty");
  if (Array.from(trimmed).length > MAX_SPEAKER_NAME_CODE_POINTS) {
    throw new RangeError("displayName must contain at most 80 Unicode code points");
  }
  return trimmed;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 0,
    voice_profile_id INTEGER,
    voice_confidence REAL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  ${transcriptSegmentsSchema("transcript_segments", { ifNotExists: true })}
  CREATE TABLE IF NOT EXISTS cloud_budget_settings (
    provider TEXT PRIMARY KEY,
    monthly_limit_microusd INTEGER NOT NULL
      CHECK(monthly_limit_microusd BETWEEN 5000000 AND 10000000),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cloud_usage (
    id TEXT PRIMARY KEY,
    month_utc TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    audio_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    price_version TEXT NOT NULL,
    reserved_microusd INTEGER NOT NULL,
    actual_microusd INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('reserved','settled','released','unknown')),
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS transcript_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    audio_source TEXT NOT NULL CHECK(audio_source IN ('mic','system')),
    person_id TEXT,
    speaker_label TEXT NOT NULL,
    original_text TEXT NOT NULL,
    current_text TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source = 'openai_correction'),
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    corrected_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('incremental','final')),
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','retry','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    response_json TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE(session_id, kind, input_hash)
  );
  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '[]',
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 0 CHECK(is_final IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    canonical_title TEXT NOT NULL,
    normalized_title TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_topics (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    PRIMARY KEY(session_id, topic_id)
  );
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    owner_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
    due_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
    confidence REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('fact','decision','commitment','opinion')),
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    needs_confirmation INTEGER NOT NULL DEFAULT 0 CHECK(needs_confirmation IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    PRIMARY KEY(memory_id, segment_id)
  );
  INSERT OR IGNORE INTO cloud_budget_settings (
    provider, monthly_limit_microusd, enabled, updated_at
  ) VALUES ('openai', 5000000, 0, 0);
  ${TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS}
  CREATE INDEX IF NOT EXISTS idx_audio_expiry ON audio_chunks(expires_at);
  CREATE INDEX IF NOT EXISTS idx_cloud_usage_month ON cloud_usage(month_utc, provider, status);
  CREATE INDEX IF NOT EXISTS idx_analysis_session ON analysis_runs(session_id, window_end);
  CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_last_seen ON memories(last_seen_at DESC);
`;

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, name) {
  assertInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
  return value;
}

function assertMonthUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError("monthUtc must use YYYY-MM");
  }
  return value;
}

function monthUtcFromTimestamp(at) {
  assertInteger(at, "at");
  return new Date(at).toISOString().slice(0, 7);
}

function normalizeDerivedText(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty`);
  if (Array.from(trimmed).length > 2_000) throw new RangeError(`${name} is too long`);
  return trimmed.replace(/\s+/g, " ");
}

function normalizedKey(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function projectSessionSummaryRevision(row, sessionId) {
  if (!row) return null;
  let content;
  try {
    content = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  if (
    !content ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    typeof content.summary !== "string" ||
    !content.summary.trim()
  ) {
    return null;
  }
  return {
    session_id: sessionId,
    summary: content.summary,
    decisions_json: "[]",
    suggestions_json: "[]",
    updated_at: row.created_at,
    is_final: row.completeness === "final" ? 1 : 0,
  };
}

function parseTopicDecisions(rows) {
  const decisions = [];
  for (const row of rows) {
    let values;
    try {
      values = JSON.parse(row.decisions_json);
    } catch {
      continue;
    }
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const content = value.trim().replace(/\s+/g, " ");
      if (!content || Array.from(content).length > 2_000) continue;
      decisions.push({ sessionId: row.session_id, content });
    }
  }
  return decisions;
}

function derivedId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, normalize(entry[key])])
    );
  };
  return JSON.stringify(normalize(value));
}

function takeCodePointTail(value, limit) {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join("");
}

function sanitizeTranscriptPromptText(value) {
  const cleaned = value
    .replace(TRANSCRIPT_PROMPT_UNEXPECTED_SCRIPT, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return "";
  const quality = classifyTranscriptQuality(cleaned);
  if (
    quality.reasons.includes("repeated_phrase") ||
    quality.reasons.includes("unexpected_language")
  ) {
    return "";
  }
  return cleaned;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function encodeDiarizationEmbedding(value) {
  if (!(value instanceof Float32Array) || value.length !== 512) {
    throw new TypeError("diarization embedding must be a 512D Float32Array");
  }
  return SpeakerIdentityRepository.encodeEmbedding(value);
}

function assertOptionalUnitScore(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1 or null`);
  }
  return value;
}

function assertDiarizationModelId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.+:-]{1,200}$/.test(value)) {
    throw new TypeError(`${name} must be a versioned model identifier`);
  }
  return value;
}

function normalizeDiarizationPipelineMetadata(value, inputVersion) {
  const metadata = value ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("run.pipelineMetadata must be an object");
  }
  if (inputVersion === 2 && metadata.schemaVersion !== 1) {
    throw new TypeError("hybrid diarization metadata schemaVersion must be 1");
  }
  let encoded;
  try {
    encoded = JSON.stringify(metadata);
  } catch {
    throw new TypeError("run.pipelineMetadata must be JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024) {
    throw new RangeError("run.pipelineMetadata is too large");
  }
  return encoded;
}

function projectDiarizationRun(row) {
  let metadata = {};
  try {
    const parsed = JSON.parse(row.pipeline_metadata_json ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  const speakerCount =
    row.speaker_count_min === null || row.speaker_count_max === null
      ? null
      : {
          minimum: row.speaker_count_min,
          maximum: row.speaker_count_max,
          preferred: Number.isSafeInteger(metadata?.speakerCount?.preferred)
            ? metadata.speakerCount.preferred
            : row.speaker_count_min === row.speaker_count_max
              ? row.speaker_count_min
              : null,
          confidence: row.speaker_count_confidence,
          state:
            typeof metadata?.speakerCount?.state === "string"
              ? metadata.speakerCount.state
              : row.speaker_count_min === row.speaker_count_max
                ? "exact"
                : "range",
        };
  const modelValues = metadata?.chunks
    ?.flatMap((chunk) => Object.values(chunk?.models ?? {}))
    .filter((value) => typeof value === "string" && value.length <= 200);
  return {
    id: row.id,
    trackId: row.track_id,
    policyId: row.policy_id,
    inputVersion: row.input_version,
    executionDevice: row.execution_device,
    speakerCount,
    overlapMs: row.overlap_ms ?? 0,
    overlapSeparationState: row.overlap_separation_state ?? "not_needed",
    modelPackVersion: row.model_pack_version ?? null,
    models: [...new Set(modelValues ?? [])],
    commitSequence: row.commit_sequence,
    completedAt: row.completed_at,
  };
}

function assertSpeakerCount(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 64) {
    throw new RangeError(`${name} must be between 0 and 64 or null`);
  }
  return value;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class JarvisRepository {
  constructor(dbPath, memoryDependencies = {}) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("dbPath must be a non-empty string");
    }
    if (
      !memoryDependencies ||
      typeof memoryDependencies !== "object" ||
      Array.isArray(memoryDependencies)
    ) {
      throw new TypeError("memoryDependencies must be an object");
    }

    this.dbPath = dbPath;
    this.memoryDependencies = {
      createId:
        memoryDependencies.createId ??
        ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`),
      now: memoryDependencies.now ?? Date.now,
      validateRedactedCloudPayload:
        memoryDependencies.validateRedactedCloudPayload ?? (() => false),
      embeddingCipher: memoryDependencies.embeddingCipher ?? null,
      log: memoryDependencies.log ?? (() => {}),
    };
    if (typeof this.memoryDependencies.log !== "function") {
      throw new TypeError("log must be a function");
    }
    this._open(dbPath);
  }

  _open(dbPath) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("foreign_keys = ON");
      if (dbPath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = FULL");
        this.db.pragma("busy_timeout = 5000");
        this.db.pragma("wal_autocheckpoint = 1000");
        const health = this.db.pragma("quick_check");
        if (health.length !== 1 || health[0]?.quick_check !== "ok") {
          throw codedError("JARVIS_DATABASE_INTEGRITY_FAILED");
        }
      }
      // Evidence migrations are independently transactional and may need to suspend
      // FK enforcement before their transaction for SQLite's documented table-rebuild
      // procedure. Keep repository-only schema initialization atomic in its own step.
      applyJarvisMigrations(this.db);
      this.db.transaction(() => this.db.exec(SCHEMA))();
      this.personalizationFeedbackRepository = new PersonalizationFeedbackRepository(this.db);
      this.memoryRepository = new MemoryRepository(this.db, this.memoryDependencies);
      this.memoryRepository.importLegacyAnalysis();
      this._prepareStatements();
      this.captureEvidenceStore = new CaptureEvidenceStore(this.db, {
        createId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
      });
      this.speakerIdentityRepository = new SpeakerIdentityRepository(this.db, {
        createId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
        embeddingCipher: this.memoryDependencies.embeddingCipher,
        now: this.memoryDependencies.now,
      });
      this._encryptLegacySpeakerEmbeddings();
      this.activityClassificationRepository = new ActivityClassificationRepository(this.db, {
        now: this.memoryDependencies.now,
      });
      this.todoReminderRepository = new TodoReminderRepository(this.db, {
        now: this.memoryDependencies.now,
      });
      this.learningGoalRepository = new LearningGoalRepository(this.db, {
        createId: this.memoryDependencies.createId,
        now: this.memoryDependencies.now,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  _encryptLegacySpeakerEmbeddings() {
    if (!this.memoryDependencies.embeddingCipher) return { encrypted: 0 };
    const legacyClusters = this.db
      .prepare(
        `SELECT id, embedding FROM speaker_clusters
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    const legacyRunClusters = this.db
      .prepare(
        `SELECT run_id, local_label, embedding
         FROM speaker_diarization_run_clusters
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    const legacyTurns = this.db
      .prepare(
        `SELECT id, embedding FROM speaker_turns
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    const legacyClusterModels = this.db
      .prepare(
        `SELECT cluster_id, model_id, embedding FROM speaker_cluster_model_embeddings
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    const legacyProfileSamples = this.db
      .prepare(
        `SELECT id, embedding FROM voice_profile_samples
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    const legacyProfileAggregates = this.db
      .prepare(
        `SELECT person_id, model_id, embedding FROM voice_profile_aggregates
         WHERE typeof(embedding) = 'blob'
           AND length(embedding) > 0
           AND length(embedding) % 4 = 0
           AND hex(substr(embedding, 1, 4)) <> '4A564531'`
      )
      .all();
    if (
      legacyClusters.length +
        legacyRunClusters.length +
        legacyTurns.length +
        legacyClusterModels.length +
        legacyProfileSamples.length +
        legacyProfileAggregates.length ===
      0
    ) {
      return { encrypted: 0 };
    }

    const updateCluster = this.db.prepare(
      `UPDATE speaker_clusters SET embedding = ?
       WHERE id = ? AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const updateRunCluster = this.db.prepare(
      `UPDATE speaker_diarization_run_clusters SET embedding = ?
       WHERE run_id = ? AND local_label = ?
         AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const updateTurn = this.db.prepare(
      `UPDATE speaker_turns SET embedding = ?
       WHERE id = ? AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const updateClusterModel = this.db.prepare(
      `UPDATE speaker_cluster_model_embeddings SET embedding = ?
       WHERE cluster_id = ? AND model_id = ? AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const updateProfileSample = this.db.prepare(
      `UPDATE voice_profile_samples SET embedding = ?
       WHERE id = ? AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const updateProfileAggregate = this.db.prepare(
      `UPDATE voice_profile_aggregates SET embedding = ?
       WHERE person_id = ? AND model_id = ? AND typeof(embedding) = 'blob'
         AND hex(substr(embedding, 1, 4)) <> '4A564531'`
    );
    const encrypt = (blob) => this.speakerIdentityRepository.protectEncodedEmbedding(blob);
    const migrate = this.db.transaction(() => {
      let encrypted = 0;
      for (const row of legacyClusters) {
        encrypted += updateCluster.run(encrypt(row.embedding), row.id).changes;
      }
      for (const row of legacyRunClusters) {
        encrypted += updateRunCluster.run(
          encrypt(row.embedding),
          row.run_id,
          row.local_label
        ).changes;
      }
      for (const row of legacyTurns) {
        encrypted += updateTurn.run(encrypt(row.embedding), row.id).changes;
      }
      for (const row of legacyClusterModels) {
        encrypted += updateClusterModel.run(
          encrypt(row.embedding),
          row.cluster_id,
          row.model_id
        ).changes;
      }
      for (const row of legacyProfileSamples) {
        encrypted += updateProfileSample.run(encrypt(row.embedding), row.id).changes;
      }
      for (const row of legacyProfileAggregates) {
        encrypted += updateProfileAggregate.run(
          encrypt(row.embedding),
          row.person_id,
          row.model_id
        ).changes;
      }
      return { encrypted };
    });
    return migrate.immediate();
  }

  reopen(dbPath = this.dbPath) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("dbPath must be a non-empty string");
    }
    if (this.db?.open) this.db.close();
    this.dbPath = dbPath;
    this._open(dbPath);
    return this;
  }

  _prepareStatements() {
    this.statements = {
      createSession: this.db.prepare(`
        INSERT INTO sessions (
          id, started_at, status, mic_device_id, language, created_at, capture_mode,
          retention_mode, capture_policy_json
        ) VALUES (
          @id, @startedAt, 'recording', @micDeviceId, @language, @createdAt, @captureMode,
          @retentionMode, @capturePolicyJson
        )
      `),
      setSessionRetention: this.db.prepare(`
        UPDATE sessions
        SET retention_mode = @retentionMode, capture_policy_json = @capturePolicyJson
        WHERE id = @id
      `),
      setSessionStatus: this.db.prepare(`
        UPDATE sessions
        SET status = @status, ended_at = @endedAt
        WHERE id = @id
      `),
      getSession: this.db.prepare("SELECT * FROM sessions WHERE id = ?"),
      getSessionContinuation: this.db.prepare(`
        SELECT source_session_id, destination_session_id, reason, boundary_at,
               destination_local_date
        FROM session_continuations
        WHERE source_session_id = @sourceSessionId
          AND destination_local_date = @destinationLocalDate
      `),
      insertSessionContinuation: this.db.prepare(`
        INSERT OR IGNORE INTO session_continuations (
          source_session_id, destination_session_id, reason, boundary_at,
          destination_local_date
        ) VALUES (
          @sourceSessionId, @destinationSessionId, 'local_midnight', @boundaryAt,
          @destinationLocalDate
        )
      `),
      listSessionContinuations: this.db.prepare(`
        SELECT source_session_id, destination_session_id, reason, boundary_at,
               destination_local_date
        FROM session_continuations
        WHERE source_session_id = ?
        ORDER BY boundary_at, destination_session_id
      `),
      listRotationTracks: this.db.prepare(
        "SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY source_type"
      ),
      listRotationGaps: this.db.prepare(`
        SELECT gap.* FROM audio_gaps AS gap
        JOIN audio_tracks AS track ON track.id = gap.track_id
        WHERE track.session_id = ? AND gap.ended_at IS NULL
        ORDER BY gap.track_id, gap.id
      `),
      deleteRotationDestination: this.db.prepare("DELETE FROM sessions WHERE id = ?"),
      restoreRotationSession: this.db.prepare(`
        UPDATE sessions SET
          status = @status,
          ended_at = @ended_at,
          stop_reason = @stop_reason,
          durable_boundary_at = @durable_boundary_at,
          processing_state = @processing_state,
          finalized_at = @finalized_at,
          ready_at = @ready_at,
          timeline_version = @timeline_version
        WHERE id = @id
      `),
      restoreRotationTrack: this.db.prepare(`
        UPDATE audio_tracks SET state = @state, ended_at = @ended_at WHERE id = @id
      `),
      restoreRotationGap: this.db.prepare(`
        UPDATE audio_gaps SET
          ended_at = @ended_at,
          recovery_attempts = @recovery_attempts,
          restored_device_id = @restored_device_id,
          restored_device_label = @restored_device_label,
          restored_strategy = @restored_strategy
        WHERE id = @id
      `),
      listSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE started_at >= @from AND started_at <= @to
        ORDER BY started_at DESC, id DESC
        LIMIT @limit
      `),
      listProcessingSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('completed', 'recovered')
          AND ended_at IS NOT NULL
          AND (
            @afterSortAt IS NULL
            OR COALESCE(finalized_at, ended_at) > @afterSortAt
            OR (
              COALESCE(finalized_at, ended_at) = @afterSortAt
              AND id > @afterId
            )
          )
          AND (
            processing_state <> 'ready'
            OR EXISTS (
              SELECT 1 FROM session_reprocessing_state AS reprocessing
              WHERE reprocessing.session_id = sessions.id
                AND reprocessing.mode = 'historical_local_only'
                AND reprocessing.state IN ('queued','processing')
            )
            OR EXISTS (
              SELECT 1 FROM audio_chunks AS chunk
              WHERE chunk.session_id = sessions.id
                AND chunk.write_state = 'committed'
                AND chunk.deleted_at IS NULL
                AND (
                  chunk.track_id IS NULL
                  OR chunk.transcription_status NOT IN ('completed', 'no_speech')
                  OR NOT EXISTS (
                    SELECT 1 FROM audio_tracks AS track
                    WHERE track.id = chunk.track_id
                      AND track.session_id = chunk.session_id
                      AND track.source_type = chunk.source_type
                  )
                  OR NOT EXISTS (
                    SELECT 1 FROM processing_jobs AS job
                    WHERE job.chunk_id = chunk.id
                      AND job.job_type = 'transcribe_chunk'
                      AND job.state = 'completed'
                  )
                  OR EXISTS (
                    SELECT 1 FROM processing_jobs AS job
                    WHERE job.chunk_id = chunk.id
                      AND job.job_type = 'transcribe_chunk'
                      AND job.state NOT IN ('completed', 'superseded')
                  )
                  OR (
                    chunk.transcription_status = 'completed'
                    AND NOT EXISTS (
                      SELECT 1 FROM transcript_segments AS segment
                      WHERE segment.chunk_id = chunk.id
                        AND segment.result_kind = 'final'
                        AND segment.started_at <= chunk.started_at
                        AND segment.ended_at >= chunk.ended_at
                    )
                  )
                )
            )
          )
        ORDER BY COALESCE(finalized_at, ended_at) ASC, id ASC
        LIMIT @limit
      `),
      listPendingJobs: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE session_id = ? AND state NOT IN ('completed', 'superseded')
        ORDER BY created_at ASC, id ASC
      `),
      listSessionReadinessTracks: this.db.prepare(`
        SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY source_type, id
      `),
      listSessionIdentityTracks: this.db.prepare(`
        SELECT track.*
        FROM audio_tracks AS track
        WHERE track.session_id = ?
          AND (
            EXISTS (
              SELECT 1 FROM audio_chunks AS chunk
              WHERE chunk.session_id = track.session_id
                AND chunk.track_id = track.id
            )
            OR EXISTS (
              SELECT 1 FROM speaker_diarization_runs AS run
              WHERE run.session_id = track.session_id
                AND run.track_id = track.id
            )
          )
        ORDER BY track.source_type, track.id
      `),
      listSessionIdentityResolutionTracks: this.db.prepare(`
        SELECT track.*
        FROM audio_tracks AS track
        WHERE track.session_id = ?
          AND (
            (
              track.track_kind IN ('mic','system_mix')
              AND (
                EXISTS (
                  SELECT 1 FROM processing_jobs AS job
                  WHERE job.session_id = track.session_id
                    AND job.track_id = track.id
                    AND job.job_type = 'diarize_track'
                    AND job.state <> 'superseded'
                )
                OR EXISTS (
                  SELECT 1 FROM speaker_diarization_runs AS run
                  WHERE run.session_id = track.session_id
                    AND run.track_id = track.id
                )
              )
            )
            OR (
              track.track_kind = 'application'
              AND EXISTS (
                SELECT 1 FROM processing_jobs AS job
                WHERE job.session_id = track.session_id
                  AND job.track_id = track.id
                  AND job.job_type = 'diarize_track'
                  AND job.state = 'completed'
              )
            )
          )
        ORDER BY CASE track.track_kind
          WHEN 'mic' THEN 0
          WHEN 'system_mix' THEN 1
          ELSE 2
        END, track.id
      `),
      listSessionReadinessChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND write_state = 'committed' AND deleted_at IS NULL
        ORDER BY track_id, sequence_number, started_at, id
      `),
      listSessionTranscriptionJobs: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE session_id = ? AND job_type = 'transcribe_chunk'
        ORDER BY created_at, id
      `),
      listSessionFinalCoverage: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ? AND result_kind = 'final'
        ORDER BY started_at, id
      `),
      upsertLogicalApplicationTrack: this.db.prepare(`
        INSERT INTO logical_audio_tracks (
          id, session_id, canonical_track_id, track_kind, application_key,
          application_display_name, started_at, ended_at, generation_count,
          created_at, updated_at
        ) VALUES (
          @id, @sessionId, @canonicalTrackId, 'application', @applicationKey,
          @applicationDisplayName, @startedAt, @endedAt, @generationCount,
          @at, @at
        )
        ON CONFLICT(session_id, application_key) DO UPDATE SET
          canonical_track_id = excluded.canonical_track_id,
          application_display_name = excluded.application_display_name,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          generation_count = excluded.generation_count,
          updated_at = excluded.updated_at
      `),
      getLogicalApplicationTrack: this.db.prepare(`
        SELECT * FROM logical_audio_tracks
        WHERE session_id = @sessionId AND application_key = @applicationKey
      `),
      getLogicalApplicationTrackByCanonical: this.db.prepare(`
        SELECT * FROM logical_audio_tracks
        WHERE session_id = @sessionId AND canonical_track_id = @trackId
      `),
      deleteLogicalApplicationMembers: this.db.prepare(`
        DELETE FROM logical_audio_track_members WHERE logical_track_id = ?
      `),
      insertLogicalApplicationMember: this.db.prepare(`
        INSERT INTO logical_audio_track_members (
          logical_track_id, track_id, capture_generation, member_index
        ) VALUES (@logicalTrackId, @trackId, @captureGeneration, @memberIndex)
      `),
      listLogicalApplicationMembers: this.db.prepare(`
        SELECT member.*, track.*
        FROM logical_audio_track_members AS member
        JOIN audio_tracks AS track ON track.id = member.track_id
        WHERE member.logical_track_id = ?
        ORDER BY member.member_index, track.id
      `),
      listLogicalDiarizationChunks: this.db.prepare(`
        SELECT chunk.*
        FROM audio_chunks AS chunk
        JOIN logical_audio_track_members AS member ON member.track_id = chunk.track_id
        WHERE chunk.session_id = @sessionId
          AND member.logical_track_id = @logicalTrackId
        ORDER BY chunk.started_at, chunk.ended_at, member.member_index,
                 chunk.sequence_number, chunk.id
      `),
      getDiarizationTrack: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE id = @trackId AND session_id = @sessionId
      `),
      listDiarizationChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = @sessionId
          AND track_id = @trackId
        ORDER BY sequence_number, id
      `),
      getLatestChunkTranscriptionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE chunk_id = ? AND job_type = 'transcribe_chunk'
          AND state <> 'superseded'
        ORDER BY input_version DESC, created_at DESC, id DESC
        LIMIT 1
      `),
      listDiarizationSegments: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE chunk_id = ?
        ORDER BY started_at, ended_at, id
      `),
      getDiarizationRun: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND transcript_revision = @transcriptRevision
          AND policy_id = @policyId
      `),
      listDiarizationRuns: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = ?
        ORDER BY commit_sequence
      `),
      listSessionSpeakerEvidenceSegments: this.db.prepare(`
        SELECT
          link.cluster_id,
          segment.id,
          segment.started_at,
          segment.ended_at,
          segment.text,
          segment.confidence,
          segment.track_id,
          segment.source_type,
          segment.result_kind,
          segment.duplicate_of
        FROM speaker_cluster_segments AS link
        JOIN transcript_segments AS segment
          ON segment.id = link.transcript_segment_id
        WHERE segment.session_id = ?
          AND segment.superseded_by IS NULL
        ORDER BY segment.started_at, segment.ended_at, segment.id
      `),
      listDiarizationEchoCandidates: this.db.prepare(`
        SELECT turn.*
        FROM speaker_turns AS turn
        JOIN speaker_diarization_runs AS run ON run.id = turn.run_id
        WHERE run.session_id = @sessionId
          AND run.track_id <> @excludeTrackId
          AND run.policy_id = @policyId
          AND turn.embedding IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM speaker_diarization_runs AS newer
            WHERE newer.session_id = run.session_id
              AND newer.track_id = run.track_id
              AND newer.policy_id = run.policy_id
              AND newer.commit_sequence > run.commit_sequence
          )
        ORDER BY turn.started_at, turn.ended_at, turn.id
      `),
      listSpeakerIdentityAudioWindows: this.db.prepare(`
        SELECT
          turn.id,
          turn.chunk_id,
          turn.started_at,
          turn.ended_at,
          turn.echo_state,
          turn.duplicate_of_turn_id,
          turn.excluded_from_centroid,
          track.track_kind,
          track.attribution_state,
          EXISTS (
            SELECT 1
            FROM speaker_turns AS overlap
            WHERE overlap.run_id = turn.run_id
              AND overlap.cluster_id <> turn.cluster_id
              AND overlap.started_at < turn.ended_at
              AND turn.started_at < overlap.ended_at
          ) AS overlap_detected
        FROM speaker_turns AS turn
        JOIN speaker_diarization_runs AS run ON run.id = turn.run_id
        JOIN audio_chunks AS chunk ON chunk.id = turn.chunk_id
        JOIN audio_tracks AS track ON track.id = chunk.track_id
        WHERE run.session_id = @sessionId
          AND run.id = @evidenceRunId
          AND turn.cluster_id = @clusterId
          AND chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
        ORDER BY turn.started_at, turn.ended_at, turn.id
      `),
      getHistoricalVoiceTurn: this.db.prepare(`
        SELECT
          turn.id AS turn_id,
          turn.cluster_id,
          turn.started_at AS turn_started_at,
          turn.ended_at AS turn_ended_at,
          turn.echo_state,
          turn.duplicate_of_turn_id,
          turn.excluded_from_centroid,
          chunk.id AS chunk_id,
          chunk.path AS chunk_path,
          chunk.started_at AS chunk_started_at,
          chunk.ended_at AS chunk_ended_at,
          chunk.duration_ms AS chunk_duration_ms,
          chunk.sha256 AS chunk_sha256,
          chunk.expires_at AS chunk_expires_at,
          chunk.source_type,
          chunk.write_state,
          chunk.deleted_at,
          chunk.format,
          chunk.file_sha256,
          chunk.sample_rate,
          chunk.channels,
          session.mic_device_id,
          EXISTS (
            SELECT 1
            FROM speaker_turns AS overlap
            WHERE overlap.run_id = turn.run_id
              AND overlap.cluster_id <> turn.cluster_id
              AND overlap.started_at < turn.ended_at
              AND turn.started_at < overlap.ended_at
          ) AS overlap_detected
        FROM speaker_turns AS turn
        JOIN audio_chunks AS chunk ON chunk.id = turn.chunk_id
        JOIN sessions AS session ON session.id = chunk.session_id
        WHERE turn.id = ?
      `),
      insertDiarizationRun: this.db.prepare(`
        INSERT INTO speaker_diarization_runs (
          id, session_id, track_id, transcript_revision, policy_id,
          diarizer_model_id, embedding_model_id, model_artifact_sha256,
          embedding_dimension, sample_rate, input_version, execution_device,
          pipeline_metadata_json, speaker_count_min, speaker_count_max,
          speaker_count_confidence, overlap_ms, overlap_separation_state,
          model_pack_version, commit_sequence, created_at, completed_at
        ) VALUES (
          @id, @sessionId, @trackId, @transcriptRevision, @policyId,
          @diarizerModelId, @embeddingModelId, @modelArtifactSha256,
          @embeddingDimension, @sampleRate, @inputVersion, @executionDevice,
          @pipelineMetadataJson, @speakerCountMin, @speakerCountMax,
          @speakerCountConfidence, @overlapMs, @overlapSeparationState,
          @modelPackVersion, @commitSequence, @createdAt, @completedAt
        )
      `),
      nextDiarizationCommitSequence: this.db.prepare(`
        SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value
        FROM speaker_diarization_runs
      `),
      insertDiarizationJob: this.db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, NULL, 'diarize_track', 'pending', @priority,
          @inputHash, @inputVersion, @modelVersion, @createdAt
        )
      `),
      getDiarizationJobByIdentity: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
      `),
      supersedeShortApplicationDiarizationJobs: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'SPEAKER_AUDIO_TOO_SHORT',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = @at
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND state IN ('pending','retry','blocked')
          AND completed_at IS NULL
      `),
      supersedeCoveredSystemMixDiarizationJobs: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'SYSTEM_MIX_COVERED_BY_EXACT_APPLICATION',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = @at
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND state IN ('pending','retry','blocked')
          AND completed_at IS NULL
      `),
      supersedeNonPrimaryApplicationDiarizationJobs: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'APPLICATION_TRACK_NOT_PRIMARY',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = @at
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND state IN ('pending','retry','blocked')
          AND completed_at IS NULL
      `),
      supersedePriorDiarizationJobs: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'superseded',
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'DIARIZATION_EVIDENCE_SUPERSEDED',
            blocked_reason = NULL,
            execution_device = NULL,
            completed_at = @at
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND state IN ('pending','retry','blocked')
          AND completed_at IS NULL
          AND NOT (
            input_hash = @inputHash
            AND input_version = @inputVersion
            AND model_version = @modelVersion
          )
      `),
      reprioritizeDiarizationJobs: this.db.prepare(`
        UPDATE processing_jobs AS job
        SET priority = CASE (
          SELECT track.track_kind FROM audio_tracks AS track WHERE track.id = job.track_id
        )
          WHEN 'mic' THEN 18
          WHEN 'application' THEN 26
          WHEN 'system_mix' THEN 28
          ELSE priority
        END
        WHERE job.job_type = 'diarize_track'
          AND job.session_id = @sessionId
          AND job.state IN ('pending','retry','blocked')
          AND job.completed_at IS NULL
      `),
      insertDiarizationStableCluster: this.db.prepare(`
        INSERT INTO speaker_clusters (
          id, session_id, track_id, local_label, model_id, embedding,
          speech_ms, window_count, quality_score, identity_eligible,
          quality_gate_reason, link_state, created_at, updated_at
        ) VALUES (
          @id, @sessionId, @trackId, @localLabel, @modelId, @embedding,
          @speechMs, @windowCount, @qualityScore, @identityEligible,
          @qualityGateReason, 'unknown', @at, @at
        )
      `),
      getDiarizationStableCluster: this.db.prepare(`
        SELECT * FROM speaker_clusters
        WHERE session_id = @sessionId AND track_id = @trackId AND local_label = @localLabel
      `),
      listDiarizationStableClusters: this.db.prepare(`
        SELECT * FROM speaker_clusters
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND model_id = @modelId
        ORDER BY created_at, id
      `),
      promoteDiarizationStableCluster: this.db.prepare(`
        UPDATE speaker_clusters
        SET embedding = @embedding, speech_ms = @speechMs,
            window_count = @windowCount, quality_score = @qualityScore,
            updated_at = @at
        WHERE id = @id AND embedding IS NULL AND @embedding IS NOT NULL
      `),
      insertDiarizationRunCluster: this.db.prepare(`
        INSERT INTO speaker_diarization_run_clusters (
          run_id, cluster_id, local_label, embedding, speech_ms,
          window_count, quality_score, first_appearance_at,
          identity_eligible, quality_gate_reason
        ) VALUES (
          @runId, @clusterId, @localLabel, @embedding, @speechMs,
          @windowCount, @qualityScore, @firstAppearanceAt,
          @identityEligible, @qualityGateReason
        )
      `),
      insertSpeakerTurn: this.db.prepare(`
        INSERT INTO speaker_turns (
          id, run_id, cluster_id, chunk_id, transcript_segment_id,
          turn_index, raw_label, started_at, ended_at, embedding,
          echo_state, duplicate_of_turn_id, excluded_from_centroid, created_at
        ) VALUES (
          @id, @runId, @clusterId, @chunkId, @transcriptSegmentId,
          @turnIndex, @rawLabel, @startedAt, @endedAt, @embedding,
          @echoState, @duplicateOfTurnId, @excludedFromCentroid, @createdAt
        )
      `),
      insertDiarizationSegmentLink: this.db.prepare(`
        INSERT OR IGNORE INTO speaker_cluster_segments (cluster_id, transcript_segment_id)
        VALUES (@clusterId, @transcriptSegmentId)
      `),
      insertDiarizationRunSegmentLink: this.db.prepare(`
        INSERT INTO speaker_diarization_run_cluster_segments (
          run_id, cluster_id, transcript_segment_id
        ) VALUES (@runId, @clusterId, @transcriptSegmentId)
      `),
      insertSpeakerClusterCannotLink: this.db.prepare(`
        INSERT INTO speaker_cluster_cannot_links (
          run_id, left_cluster_id, right_cluster_id, reason, created_at
        ) VALUES (@runId, @leftClusterId, @rightClusterId, @reason, @createdAt)
      `),
      insertOverlapStemEvidence: this.db.prepare(`
        INSERT INTO overlap_stem_evidence (
          id, run_id, chunk_id, cluster_id, window_index, stem_index,
          started_at, ended_at, path, file_sha256, pcm_sha256,
          sample_rate, channels, rms, expires_at, transcript_text,
          confidence, created_at
        ) VALUES (
          @id, @runId, @chunkId, @clusterId, @windowIndex, @stemIndex,
          @startedAt, @endedAt, @path, @fileSha256, @pcmSha256,
          @sampleRate, @channels, @rms, @expiresAt, @transcriptText,
          @confidence, @createdAt
        )
      `),
      insertSpeakerUtterance: this.db.prepare(`
        INSERT INTO speaker_utterances (
          id, session_id, run_id, chunk_id, cluster_id,
          source_segment_id, stem_id, started_at, ended_at, text,
          confidence, overlap_state, evidence_kind, created_at
        ) VALUES (
          @id, @sessionId, @runId, @chunkId, @clusterId,
          @sourceSegmentId, @stemId, @startedAt, @endedAt, @text,
          @confidence, @overlapState, @evidenceKind, @createdAt
        )
      `),
      insertSpeakerUtteranceWord: this.db.prepare(`
        INSERT INTO speaker_utterance_words (
          utterance_id, transcript_word_id, ordinal
        ) VALUES (@utteranceId, @transcriptWordId, @ordinal)
      `),
      listTranscriptWordsForDiarizationSegment: this.db.prepare(`
        SELECT * FROM transcript_words
        WHERE transcript_segment_id = ?
        ORDER BY ordinal
      `),
      listSessionSpeakerUtterances: this.db.prepare(`
        SELECT utterance.*,
               cluster.local_label, cluster.person_id, cluster.link_state,
               person.display_name AS person_display_name,
               track.application_key, track.application_display_name, track.track_kind,
               stem.path AS stem_path, stem.file_sha256 AS stem_file_sha256,
               stem.expires_at AS stem_expires_at, stem.deleted_at AS stem_deleted_at
        FROM speaker_utterances AS utterance
        JOIN speaker_clusters AS cluster ON cluster.id = utterance.cluster_id
        JOIN speaker_diarization_runs AS run ON run.id = utterance.run_id
        JOIN audio_tracks AS track ON track.id = run.track_id
        LEFT JOIN people AS person ON person.id = cluster.person_id
        LEFT JOIN overlap_stem_evidence AS stem ON stem.id = utterance.stem_id
        WHERE utterance.session_id = ?
          AND run.input_version = (
            SELECT max(preferred.input_version)
            FROM speaker_diarization_runs AS preferred
            WHERE preferred.session_id = run.session_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM speaker_diarization_runs AS newer
            WHERE newer.session_id = run.session_id
              AND newer.track_id = run.track_id
              AND newer.policy_id = run.policy_id
              AND newer.commit_sequence > run.commit_sequence
          )
        ORDER BY utterance.started_at, utterance.ended_at, utterance.id
      `),
      getSpeakerUtteranceAudioEvidence: this.db.prepare(`
        SELECT utterance.id, utterance.session_id, utterance.chunk_id,
               utterance.evidence_kind, utterance.stem_id,
               stem.path AS stem_path, stem.file_sha256 AS stem_file_sha256,
               stem.expires_at AS stem_expires_at, stem.deleted_at AS stem_deleted_at
        FROM speaker_utterances AS utterance
        LEFT JOIN overlap_stem_evidence AS stem ON stem.id = utterance.stem_id
        WHERE utterance.id = ?
      `),
      listIdentityResolutionRunClusters: this.db.prepare(`
        SELECT run_cluster.*, run.embedding_model_id
        FROM speaker_diarization_run_clusters AS run_cluster
        JOIN speaker_diarization_runs AS run ON run.id = run_cluster.run_id
        WHERE run_cluster.run_id = ?
          AND run_cluster.identity_eligible = 1
        ORDER BY run_cluster.first_appearance_at, run_cluster.cluster_id
      `),
      getLatestIdentityDiarizationRun: this.db.prepare(`
        SELECT * FROM speaker_diarization_runs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND policy_id = @policyId
          AND embedding_model_id = @modelId
        ORDER BY commit_sequence DESC LIMIT 1
      `),
      listIdentityDiarizationJobs: this.db.prepare(`
        SELECT rowid AS job_sequence, * FROM processing_jobs
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND job_type = 'diarize_track'
        ORDER BY rowid
      `),
      getIdentityDiarizationJobByIdentity: this.db.prepare(`
        SELECT rowid AS job_sequence, * FROM processing_jobs
        WHERE job_type = 'diarize_track'
          AND session_id = @sessionId
          AND track_id = @trackId
          AND input_hash = @inputHash
          AND input_version = @inputVersion
          AND model_version = @modelVersion
      `),
      listIdentityResolutionProfiles: this.db.prepare(`
        SELECT sample.*, person.is_self
        FROM voice_profile_samples AS sample
        JOIN people AS person ON person.id = sample.person_id
        LEFT JOIN speaker_identity_review_overrides AS forgotten
          ON forgotten.person_id = sample.person_id AND forgotten.state = 'forgotten'
        WHERE sample.model_id = ? AND forgotten.person_id IS NULL
        ORDER BY sample.person_id, sample.id
      `),
      listIdentityResolutionProfilesAll: this.db.prepare(`
        SELECT sample.*, person.is_self
        FROM voice_profile_samples AS sample
        JOIN people AS person ON person.id = sample.person_id
        LEFT JOIN speaker_identity_review_overrides AS forgotten
          ON forgotten.person_id = sample.person_id AND forgotten.state = 'forgotten'
        WHERE forgotten.person_id IS NULL
        ORDER BY sample.model_id, sample.person_id, sample.id
      `),
      listAnonymousIdentityResolutionProfiles: this.db.prepare(`
        WITH ranked_resolution AS (
          SELECT
            resolution.*,
            run.commit_sequence,
            ROW_NUMBER() OVER (
              PARTITION BY resolution.cluster_id
              ORDER BY run.commit_sequence DESC, resolution.created_at DESC, resolution.id DESC
            ) AS rank
          FROM speaker_identity_resolutions AS resolution
          JOIN speaker_identity_resolution_runs AS run
            ON run.id = resolution.resolution_run_id
          WHERE resolution.actor = 'system'
        )
        SELECT
          ranked.candidate_person_ref,
          ranked.session_id,
          ranked.cluster_id,
          model.model_id,
          model.artifact_version,
          model.embedding_space,
          model.embedding,
          model.source_kind,
          model.speech_ms,
          model.window_count,
          model.quality_score,
          model.created_at
        FROM ranked_resolution AS ranked
        JOIN speaker_cluster_model_embeddings AS model
          ON model.cluster_id = ranked.cluster_id
        WHERE ranked.rank = 1
          AND ranked.session_id <> @sessionId
          AND ranked.candidate_person_id IS NULL
          AND ranked.candidate_person_ref LIKE 'anonymous-speaker-%'
          AND ranked.resolution_state = 'unknown'
          AND ranked.reason IN (
            'dual_model_anonymous_group',
            'dual_model_anonymous_profile'
          )
          AND ranked.projection_applied = 1
        ORDER BY
          ranked.candidate_person_ref,
          model.model_id,
          ranked.session_id,
          ranked.cluster_id
      `),
      insertIdentityResolutionJob: this.db.prepare(`
        INSERT OR IGNORE INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state, priority,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, NULL, NULL, 'resolve_identities', 'pending', 29,
          @inputHash, 1, @policyId, @createdAt
        )
      `),
      getIdentityResolutionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'resolve_identities'
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = @policyId
      `),
      requeueIdentityResolutionJob: this.db.prepare(`
        UPDATE processing_jobs
        SET state = 'pending', attempt_count = 0, next_retry_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
            blocked_reason = NULL, execution_device = NULL, completed_at = NULL
        WHERE job_type = 'resolve_identities'
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = @policyId
          AND state = 'completed'
      `),
      getIdentityResolutionRun: this.db.prepare(`
        SELECT * FROM speaker_identity_resolution_runs
        WHERE session_id = @sessionId
          AND diarization_revision = @diarizationRevision
          AND profile_revision = @profileRevision
          AND policy_id = @policyId
      `),
      countSessionDiarizationJobs: this.db.prepare(`
        SELECT count(*) AS count FROM processing_jobs
        WHERE session_id = ? AND job_type = 'diarize_track'
      `),
      countOpenSessionDiarizationJobs: this.db.prepare(`
        SELECT count(*) AS count FROM processing_jobs
        WHERE session_id = ?
          AND job_type = 'diarize_track'
          AND state NOT IN (
            'completed', 'superseded', 'blocked',
            'audio_expired_before_processing', 'failed'
          )
      `),
      listHistoricalDiarizedSessionIds: this.db.prepare(`
        SELECT DISTINCT session.id
        FROM sessions AS session
        JOIN speaker_diarization_runs AS run ON run.session_id = session.id
        WHERE session.status IN ('completed', 'recovered')
          AND session.ended_at IS NOT NULL
        ORDER BY COALESCE(session.finalized_at, session.ended_at), session.id
      `),
      listHistoricalHybridCandidates: this.db.prepare(`
        SELECT session.*
        FROM sessions AS session
        WHERE session.status IN ('completed','recovered')
          AND session.ended_at IS NOT NULL
          AND session.processing_state = 'ready'
          AND EXISTS (
            SELECT 1
            FROM audio_tracks AS track
            JOIN audio_chunks AS chunk ON chunk.track_id = track.id
            WHERE track.session_id = session.id
              AND chunk.deleted_at IS NULL
              AND chunk.write_state = 'committed'
              AND chunk.expires_at > @at
              AND length(chunk.path) > 0
              AND NOT EXISTS (
                SELECT 1 FROM speaker_diarization_runs AS current
                WHERE current.session_id = session.id
                  AND current.track_id = track.id
                  AND current.policy_id = @policyId
              )
          )
        ORDER BY COALESCE(session.finalized_at, session.ended_at) DESC, session.id DESC
        LIMIT @limit
      `),
      upsertHistoricalReprocessingState: this.db.prepare(`
        INSERT INTO session_reprocessing_state (
          session_id, policy_id, mode, state, started_at, completed_at,
          baseline_content_sha256, baseline_identity_sha256,
          baseline_classification_sha256
        ) VALUES (
          @sessionId, @policyId, 'historical_local_only', 'queued', @at, NULL,
          @contentSha256, @identitySha256, @classificationSha256
        )
        ON CONFLICT(session_id) DO UPDATE SET
          policy_id = excluded.policy_id,
          mode = 'historical_local_only',
          state = CASE
            WHEN session_reprocessing_state.state = 'completed' THEN 'queued'
            ELSE session_reprocessing_state.state
          END,
          started_at = CASE
            WHEN session_reprocessing_state.state = 'completed' THEN excluded.started_at
            ELSE session_reprocessing_state.started_at
          END,
          completed_at = CASE
            WHEN session_reprocessing_state.state = 'completed' THEN NULL
            ELSE session_reprocessing_state.completed_at
          END,
          baseline_content_sha256 = CASE
            WHEN session_reprocessing_state.state = 'completed'
              THEN excluded.baseline_content_sha256
            ELSE session_reprocessing_state.baseline_content_sha256
          END,
          baseline_identity_sha256 = CASE
            WHEN session_reprocessing_state.state = 'completed'
              THEN excluded.baseline_identity_sha256
            ELSE session_reprocessing_state.baseline_identity_sha256
          END,
          baseline_classification_sha256 = CASE
            WHEN session_reprocessing_state.state = 'completed'
              THEN excluded.baseline_classification_sha256
            ELSE session_reprocessing_state.baseline_classification_sha256
          END
      `),
      getSessionReprocessingState: this.db.prepare(`
        SELECT * FROM session_reprocessing_state WHERE session_id = ?
      `),
      startHistoricalReprocessingState: this.db.prepare(`
        UPDATE session_reprocessing_state
        SET state = 'processing', completed_at = NULL
        WHERE session_id = @sessionId
          AND mode = 'historical_local_only'
          AND state IN ('queued','processing')
      `),
      completeHistoricalReprocessingState: this.db.prepare(`
        UPDATE session_reprocessing_state
        SET state = 'completed', completed_at = @at
        WHERE session_id = @sessionId
          AND mode = 'historical_local_only'
          AND state IN ('queued','processing')
      `),
      getPriorDiarizationSpeakerCount: this.db.prepare(`
        SELECT run.id, run.policy_id,
               (SELECT count(*) FROM speaker_diarization_run_clusters AS cluster
                WHERE cluster.run_id = run.id) AS speaker_count
        FROM speaker_diarization_runs AS run
        WHERE run.session_id = @sessionId
          AND run.track_id = @trackId
          AND run.input_version < @inputVersion
        ORDER BY run.commit_sequence DESC
        LIMIT 1
      `),
      sessionHasRetainedSummary: this.db.prepare(`
        SELECT EXISTS(
          SELECT 1 FROM session_summary_revisions
          WHERE session_id = ? AND lifecycle = 'active'
          UNION ALL
          SELECT 1 FROM session_summaries WHERE session_id = ?
        ) AS value
      `),
      upsertSummaryRefreshState: this.db.prepare(`
        INSERT INTO session_summary_refresh_state (
          session_id, basis_policy_id, latest_policy_id,
          recommended, reason, updated_at
        ) VALUES (
          @sessionId, @basisPolicyId, @latestPolicyId,
          @recommended, @reason, @at
        )
        ON CONFLICT(session_id) DO UPDATE SET
          basis_policy_id = COALESCE(session_summary_refresh_state.basis_policy_id, excluded.basis_policy_id),
          latest_policy_id = excluded.latest_policy_id,
          recommended = MAX(session_summary_refresh_state.recommended, excluded.recommended),
          reason = CASE
            WHEN session_summary_refresh_state.recommended = 1
              THEN session_summary_refresh_state.reason
            ELSE excluded.reason
          END,
          updated_at = excluded.updated_at
      `),
      getSummaryRefreshState: this.db.prepare(`
        SELECT * FROM session_summary_refresh_state WHERE session_id = ?
      `),
      replaceSummaryRefreshState: this.db.prepare(`
        INSERT INTO session_summary_refresh_state (
          session_id, basis_policy_id, latest_policy_id,
          recommended, reason, updated_at
        ) VALUES (
          @sessionId, @basisPolicyId, @latestPolicyId,
          @recommended, @reason, @at
        )
        ON CONFLICT(session_id) DO UPDATE SET
          basis_policy_id = excluded.basis_policy_id,
          latest_policy_id = excluded.latest_policy_id,
          recommended = excluded.recommended,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `),
      countIdentityResolutionSystemResults: this.db.prepare(`
        SELECT count(*) AS count FROM speaker_identity_resolutions
        WHERE resolution_run_id = ? AND actor = 'system'
      `),
      markSessionProcessing: this.db.prepare(`
        UPDATE sessions
        SET processing_state = 'processing', ready_at = NULL,
            timeline_version = timeline_version + 1
        WHERE id = ?
          AND status IN ('completed', 'recovered')
          AND ended_at IS NOT NULL
          AND (processing_state <> 'processing' OR ready_at IS NOT NULL)
      `),
      setSessionReadiness: this.db.prepare(`
        UPDATE sessions
        SET processing_state = @processingState,
            ready_at = @readyAt,
            timeline_version = timeline_version + 1
        WHERE id = @sessionId
          AND (processing_state <> @processingState OR ready_at IS NOT @readyAt)
      `),
      insertPerson: this.db.prepare(`
        INSERT OR IGNORE INTO people (
          id, display_name, is_self, created_at, last_seen_at
        ) VALUES (
          @id, @displayName, 0, @createdAt, @lastSeenAt
        )
      `),
      getSegmentSession: this.db.prepare(`
        SELECT session_id, result_kind, chunk_id, model_version, superseded_by, duplicate_of
        FROM transcript_segments WHERE id = ?
      `),
      upsertSegment: this.db.prepare(`
        INSERT INTO transcript_segments (
          id, session_id, started_at, ended_at, person_id, speaker_label,
          text, confidence, is_stable, track_id, source_type, result_kind, version,
          echo_score
        ) VALUES (
          @id, @sessionId, @startedAt, @endedAt, @personId, @speakerLabel,
          @text, @confidence, @isStable, @trackId, @sourceType, 'provisional', 1,
          @echoScore
        )
        ON CONFLICT(id) DO UPDATE SET
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          person_id = excluded.person_id,
          speaker_label = excluded.speaker_label,
          text = excluded.text,
          confidence = excluded.confidence,
          is_stable = excluded.is_stable,
          track_id = excluded.track_id,
          source_type = excluded.source_type,
          echo_score = CASE
            WHEN excluded.echo_score IS NULL THEN transcript_segments.echo_score
            WHEN transcript_segments.echo_score IS NULL THEN excluded.echo_score
            ELSE MAX(transcript_segments.echo_score, excluded.echo_score)
          END,
          duplicate_of = CASE
            WHEN transcript_segments.started_at <> excluded.started_at
              OR transcript_segments.ended_at <> excluded.ended_at
              OR transcript_segments.source_type <> excluded.source_type
              OR transcript_segments.text <> excluded.text
            THEN NULL
            ELSE transcript_segments.duplicate_of
          END
        WHERE transcript_segments.session_id = excluded.session_id
          AND transcript_segments.result_kind = 'provisional'
          AND transcript_segments.chunk_id IS NULL
          AND transcript_segments.model_version IS NULL
          AND transcript_segments.superseded_by IS NULL
      `),
      listSegments: this.db.prepare(`
        SELECT segment.*, track.application_key, track.application_display_name,
               track.track_kind
        FROM transcript_segments AS segment
        LEFT JOIN audio_tracks AS track ON track.id = segment.track_id
        WHERE segment.session_id = ?
          AND segment.superseded_by IS NULL
          AND segment.duplicate_of IS NULL
          AND segment.projection_state = 'visible'
        ORDER BY segment.started_at ASC, segment.id ASC
      `),
      listTranscriptHistory: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC
      `),
      listPreviewTranscriptContext: this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM transcript_segments
          WHERE session_id = @sessionId
            AND track_id = @trackId
            AND superseded_by IS NULL
            AND duplicate_of IS NULL
            AND projection_state = 'visible'
            AND ended_at > @from
            AND started_at < @to
            AND length(trim(text)) > 0
          ORDER BY started_at DESC, id DESC
          LIMIT @limit
        )
        ORDER BY started_at ASC, id ASC
      `),
      getTranscriptSegment: this.db.prepare("SELECT * FROM transcript_segments WHERE id = ?"),
      listTranscriptPromptSegments: this.db.prepare(`
        SELECT text FROM transcript_segments
        WHERE session_id = ?
          AND superseded_by IS NULL
          AND duplicate_of IS NULL
          AND projection_state = 'visible'
          AND is_stable = 1
          AND length(trim(text)) > 0
        ORDER BY ended_at DESC, id DESC
        LIMIT 16
      `),
      listTranscriptPromptSegmentsByTrack: this.db.prepare(`
        SELECT text FROM transcript_segments
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND superseded_by IS NULL
          AND duplicate_of IS NULL
          AND projection_state = 'visible'
          AND is_stable = 1
          AND length(trim(text)) > 0
        ORDER BY ended_at DESC, id DESC
        LIMIT 16
      `),
      supersedeTranscriptSegment: this.db.prepare(`
        UPDATE transcript_segments
        SET superseded_by = @finalId
        WHERE id = @provisionalId
          AND session_id = @sessionId
          AND result_kind = 'provisional'
          AND superseded_by IS NULL
      `),
      findFinalWinnerForRange: this.db.prepare(`
        SELECT id FROM transcript_segments
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND result_kind = 'final'
          AND started_at < @endedAt
          AND @startedAt < ended_at
        ORDER BY version DESC, completed_at DESC, id ASC
        LIMIT 1
      `),
      supersedeOverlappingProvisionals: this.db.prepare(`
        UPDATE transcript_segments
        SET superseded_by = @finalId
        WHERE session_id = @sessionId
          AND track_id = @trackId
          AND result_kind = 'provisional'
          AND started_at < @endedAt
          AND @startedAt < ended_at
          AND superseded_by IS NOT @finalId
      `),
      mergeTranscriptEchoScore: this.db.prepare(`
        UPDATE transcript_segments
        SET echo_score = CASE
          WHEN echo_score IS NULL THEN @echoScore
          ELSE MAX(echo_score, @echoScore)
        END
        WHERE id = @finalId AND result_kind = 'final'
      `),
      listTranscriptDedupeCandidates: this.db.prepare(`
        SELECT
          segment.*,
          track.track_kind,
          track.application_key,
          track.application_display_name,
          track.attribution_state,
          track.capture_generation
        FROM transcript_segments AS segment
        JOIN audio_tracks AS track ON track.id = segment.track_id
        WHERE segment.session_id = ?
          AND segment.superseded_by IS NULL
          AND segment.duplicate_of IS NULL
        ORDER BY segment.started_at ASC, segment.id ASC
      `),
      markTranscriptDuplicate: this.db.prepare(`
        UPDATE transcript_segments
        SET duplicate_of = @masterId
        WHERE id = @duplicateId
          AND session_id = @sessionId
          AND superseded_by IS NULL
          AND duplicate_of IS NULL
      `),
      bumpSessionTimelineVersion: this.db.prepare(`
        UPDATE sessions
        SET timeline_version = timeline_version + 1
        WHERE id = ?
      `),
      refreshSystemAuditProjection: this.db.prepare(`
        UPDATE transcript_segments AS segment
        SET projection_state = CASE
              WHEN segment.result_kind = 'final'
                AND segment.superseded_by IS NULL
                AND segment.duplicate_of IS NULL
                AND EXISTS (
                  SELECT 1 FROM audio_tracks AS mixed
                  WHERE mixed.id = segment.track_id
                    AND mixed.track_kind = 'system_mix'
                )
                AND EXISTS (
                  SELECT 1
                  FROM transcript_segments AS application_segment
                  JOIN audio_tracks AS application_track
                    ON application_track.id = application_segment.track_id
                  WHERE application_segment.session_id = segment.session_id
                    AND application_segment.id <> segment.id
                    AND application_segment.result_kind = 'final'
                    AND application_segment.is_stable = 1
                    AND application_segment.superseded_by IS NULL
                    AND application_segment.duplicate_of IS NULL
                    AND application_track.track_kind = 'application'
                    AND application_segment.started_at < segment.ended_at
                    AND segment.started_at < application_segment.ended_at
                    AND min(segment.ended_at, application_segment.ended_at)
                        - max(segment.started_at, application_segment.started_at)
                        >= (segment.ended_at - segment.started_at) * 0.5
                )
              THEN 'audit_hidden'
              ELSE 'visible'
            END,
            projection_reason = CASE
              WHEN segment.result_kind = 'final'
                AND segment.superseded_by IS NULL
                AND segment.duplicate_of IS NULL
                AND EXISTS (
                  SELECT 1 FROM audio_tracks AS mixed
                  WHERE mixed.id = segment.track_id
                    AND mixed.track_kind = 'system_mix'
                )
                AND EXISTS (
                  SELECT 1
                  FROM transcript_segments AS application_segment
                  JOIN audio_tracks AS application_track
                    ON application_track.id = application_segment.track_id
                  WHERE application_segment.session_id = segment.session_id
                    AND application_segment.id <> segment.id
                    AND application_segment.result_kind = 'final'
                    AND application_segment.is_stable = 1
                    AND application_segment.superseded_by IS NULL
                    AND application_segment.duplicate_of IS NULL
                    AND application_track.track_kind = 'application'
                    AND application_segment.started_at < segment.ended_at
                    AND segment.started_at < application_segment.ended_at
                    AND min(segment.ended_at, application_segment.ended_at)
                        - max(segment.started_at, application_segment.started_at)
                        >= (segment.ended_at - segment.started_at) * 0.5
                )
              THEN 'exact_application_primary'
              ELSE NULL
            END
        WHERE segment.session_id = @sessionId
          AND (
            segment.projection_state <> CASE
              WHEN segment.result_kind = 'final'
                AND segment.superseded_by IS NULL
                AND segment.duplicate_of IS NULL
                AND EXISTS (
                  SELECT 1 FROM audio_tracks AS mixed
                  WHERE mixed.id = segment.track_id AND mixed.track_kind = 'system_mix'
                )
                AND EXISTS (
                  SELECT 1
                  FROM transcript_segments AS application_segment
                  JOIN audio_tracks AS application_track
                    ON application_track.id = application_segment.track_id
                  WHERE application_segment.session_id = segment.session_id
                    AND application_segment.id <> segment.id
                    AND application_segment.result_kind = 'final'
                    AND application_segment.is_stable = 1
                    AND application_segment.superseded_by IS NULL
                    AND application_segment.duplicate_of IS NULL
                    AND application_track.track_kind = 'application'
                    AND application_segment.started_at < segment.ended_at
                    AND segment.started_at < application_segment.ended_at
                    AND min(segment.ended_at, application_segment.ended_at)
                        - max(segment.started_at, application_segment.started_at)
                        >= (segment.ended_at - segment.started_at) * 0.5
                )
              THEN 'audit_hidden' ELSE 'visible' END
            OR segment.projection_reason IS NOT CASE
              WHEN segment.result_kind = 'final'
                AND segment.superseded_by IS NULL
                AND segment.duplicate_of IS NULL
                AND EXISTS (
                  SELECT 1 FROM audio_tracks AS mixed
                  WHERE mixed.id = segment.track_id AND mixed.track_kind = 'system_mix'
                )
                AND EXISTS (
                  SELECT 1
                  FROM transcript_segments AS application_segment
                  JOIN audio_tracks AS application_track
                    ON application_track.id = application_segment.track_id
                  WHERE application_segment.session_id = segment.session_id
                    AND application_segment.id <> segment.id
                    AND application_segment.result_kind = 'final'
                    AND application_segment.is_stable = 1
                    AND application_segment.superseded_by IS NULL
                    AND application_segment.duplicate_of IS NULL
                    AND application_track.track_kind = 'application'
                    AND application_segment.started_at < segment.ended_at
                    AND segment.started_at < application_segment.ended_at
                    AND min(segment.ended_at, application_segment.ended_at)
                        - max(segment.started_at, application_segment.started_at)
                        >= (segment.ended_at - segment.started_at) * 0.5
                )
              THEN 'exact_application_primary' ELSE NULL END
          )
      `),
      getChunkForTranscriptCommit: this.db.prepare(`
        SELECT * FROM audio_chunks WHERE id = ?
      `),
      getFinalChunkTranscript: this.db.prepare(`
        SELECT * FROM transcript_segments
        WHERE chunk_id = ? AND result_kind = 'final' AND model_version = ?
      `),
      insertFinalChunkTranscript: this.db.prepare(`
        INSERT OR IGNORE INTO transcript_segments (
          id, session_id, started_at, ended_at, person_id, speaker_label,
          text, confidence, is_stable, analysis_state, track_id, chunk_id,
          source_type, result_kind, version, model_version, completed_at
        ) VALUES (
          @id, @sessionId, @startedAt, @endedAt, NULL, @speakerLabel,
          @text, @confidence, 1, 'pending', @trackId, @chunkId,
          @sourceType, 'final', 1, @modelVersion, @completedAt
        )
      `),
      deleteTranscriptWords: this.db.prepare(`
        DELETE FROM transcript_words WHERE transcript_segment_id = ?
      `),
      insertTranscriptWord: this.db.prepare(`
        INSERT INTO transcript_words (
          id, transcript_segment_id, chunk_id, ordinal, word,
          started_at, ended_at, probability, created_at
        ) VALUES (
          @id, @transcriptSegmentId, @chunkId, @ordinal, @word,
          @startedAt, @endedAt, @probability, @createdAt
        )
      `),
      listTranscriptWordsBySegment: this.db.prepare(`
        SELECT * FROM transcript_words
        WHERE transcript_segment_id = ?
        ORDER BY ordinal
      `),
      listSessionTranscriptWords: this.db.prepare(`
        SELECT word.*
        FROM transcript_words AS word
        JOIN transcript_segments AS segment ON segment.id = word.transcript_segment_id
        WHERE segment.session_id = ?
        ORDER BY word.started_at, word.ended_at, word.ordinal, word.id
      `),
      setChunkTranscriptionStatus: this.db.prepare(`
        UPDATE audio_chunks
        SET transcription_status = @status
        WHERE id = @chunkId AND write_state = 'committed' AND deleted_at IS NULL
      `),
      clearSelf: this.db.prepare("UPDATE people SET is_self = 0 WHERE is_self <> 0"),
      listSelfProfileModels: this.db.prepare(`
        SELECT DISTINCT sample.model_id
        FROM voice_profile_samples AS sample
        JOIN people AS person ON person.id = sample.person_id
        WHERE person.is_self = 1
        ORDER BY sample.model_id
      `),
      listPersonProfileModels: this.db.prepare(`
        SELECT DISTINCT model_id FROM voice_profile_samples
        WHERE person_id = ? ORDER BY model_id
      `),
      countOtherSelfPeople: this.db.prepare(`
        SELECT count(*) AS count FROM people WHERE is_self = 1 AND id <> ?
      `),
      renamePerson: this.db.prepare(`
        INSERT INTO people (
          id, display_name, is_self, voice_profile_id, created_at, last_seen_at
        ) VALUES (
          @personId, @displayName, @isSelf, @voiceProfileId, @now, @now
        )
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          is_self = excluded.is_self,
          voice_profile_id = excluded.voice_profile_id,
          last_seen_at = excluded.last_seen_at
      `),
      getPerson: this.db.prepare("SELECT * FROM people WHERE id = ?"),
      listPeople: this.db.prepare(`
        SELECT * FROM people
        ORDER BY is_self DESC, display_name COLLATE NOCASE ASC, id ASC
      `),
      insertAudioChunk: this.db.prepare(`
        INSERT INTO audio_chunks (
          id, session_id, path, started_at, ended_at, duration_ms,
          sha256, expires_at, transcription_status
        ) VALUES (
          @id, @sessionId, @path, @startedAt, @endedAt, @durationMs,
          @sha256, @expiresAt, @transcriptionStatus
        )
      `),
      getAudioChunk: this.db.prepare("SELECT * FROM audio_chunks WHERE id = ?"),
      listAudioChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC
      `),
      listSessionTimelineTracks: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE session_id = @sessionId
        ORDER BY CASE track_kind
          WHEN 'mic' THEN 0
          WHEN 'application' THEN 1
          ELSE 2
        END, application_key ASC, started_at ASC, id ASC
        LIMIT @limit OFFSET @offset
      `),
      countSessionTimelineTracks: this.db.prepare(`
        SELECT count(*) AS count FROM audio_tracks WHERE session_id = ?
      `),
      listSessionApplicationAudioIntervals: this.db.prepare(`
        SELECT * FROM application_audio_intervals
        WHERE session_id = @sessionId
        ORDER BY started_at ASC, id ASC
        LIMIT @limit OFFSET @offset
      `),
      countSessionApplicationAudioIntervals: this.db.prepare(`
        SELECT count(*) AS count FROM application_audio_intervals WHERE session_id = ?
      `),
      summarizeSessionApplicationAudio: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN attribution_state = 'exact'
            THEN ended_at - started_at ELSE 0 END), 0) AS exact_duration_ms,
          COALESCE(SUM(CASE WHEN attribution_state = 'mixed_unknown'
            THEN ended_at - started_at ELSE 0 END), 0) AS fallback_duration_ms,
          COALESCE(SUM(CASE WHEN attribution_state = 'mixed_unknown' THEN 1 ELSE 0 END), 0)
            AS degraded_interval_count
        FROM application_audio_intervals
        WHERE session_id = ?
          AND ended_at IS NOT NULL
          AND ended_at > started_at
      `),
      countSessionApplicationRecoveries: this.db.prepare(`
        SELECT count(DISTINCT exact.started_at) AS count
        FROM application_audio_intervals AS exact
        JOIN application_audio_intervals AS fallback
          ON fallback.session_id = exact.session_id
         AND fallback.capture_generation = exact.capture_generation
         AND fallback.ended_at = exact.started_at
         AND fallback.attribution_state = 'mixed_unknown'
        WHERE exact.session_id = ?
          AND exact.attribution_state = 'exact'
      `),
      getSessionApplicationTrack: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE session_id = @sessionId
          AND track_kind = 'application'
          AND application_key = @applicationKey
        ORDER BY capture_generation DESC, started_at DESC, id DESC
        LIMIT 1
      `),
      listSessionTimelineGaps: this.db.prepare(`
        SELECT gap.* FROM audio_gaps AS gap
        JOIN audio_tracks AS track ON track.id = gap.track_id
        WHERE track.session_id = ?
        ORDER BY gap.started_at ASC, gap.id ASC
      `),
      listSessionTimelineChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND write_state = 'committed'
        ORDER BY started_at ASC,
          CASE source_type WHEN 'mic' THEN 0 ELSE 1 END,
          sequence_number ASC, id ASC
      `),
      getSessionProcessingCounts: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS leased,
          COALESCE(SUM(CASE WHEN state = 'retry' THEN 1 ELSE 0 END), 0) AS retry,
          COALESCE(SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
          COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COUNT(*) AS total
        FROM processing_jobs
        WHERE session_id = ? AND state <> 'superseded'
      `),
      listRuntimeProcessingGroups: this.db.prepare(`
        SELECT
          job_type,
          state,
          priority,
          blocked_reason,
          COUNT(*) AS count,
          MIN(next_retry_at) AS next_retry_at
        FROM processing_jobs
        WHERE state NOT IN ('completed', 'superseded', 'audio_expired_before_processing')
        GROUP BY job_type, state, priority, blocked_reason
        ORDER BY job_type ASC, state ASC, priority ASC, blocked_reason ASC
      `),
      getRuntimeTranscriptionBacklog: this.db.prepare(`
        SELECT COALESCE(SUM(chunk.duration_ms), 0) AS backlog_ms
        FROM audio_chunks AS chunk
        WHERE chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM processing_jobs AS job
            WHERE job.chunk_id = chunk.id
              AND job.job_type = 'transcribe_chunk'
              AND job.state NOT IN ('completed', 'superseded', 'audio_expired_before_processing')
          )
      `),
      getRuntimeOldestProcessingJob: this.db.prepare(`
        SELECT MIN(created_at) AS oldest_created_at
        FROM processing_jobs
        WHERE state NOT IN ('completed', 'superseded', 'audio_expired_before_processing')
      `),
      getActiveProcessingExecutionDevice: this.db.prepare(`
        SELECT execution_device
        FROM processing_jobs
        WHERE state = 'running' AND execution_device IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      getRuntimeFinalCoverage: this.db.prepare(`
        SELECT
          COALESCE(SUM(chunk.duration_ms), 0) AS total_ms,
          COALESCE(SUM(CASE WHEN EXISTS (
            SELECT 1 FROM processing_jobs AS job
            WHERE job.chunk_id = chunk.id
              AND job.job_type = 'transcribe_chunk'
              AND job.state = 'completed'
              AND job.id = (
                SELECT current.id
                FROM processing_jobs AS current
                WHERE current.chunk_id = chunk.id
                  AND current.job_type = 'transcribe_chunk'
                  AND current.state <> 'superseded'
                ORDER BY current.created_at DESC, current.id DESC
                LIMIT 1
              )
              AND (
                chunk.transcription_status = 'no_speech'
                OR (
                  chunk.transcription_status = 'completed'
                  AND EXISTS (
                    SELECT 1 FROM transcript_segments AS segment
                    WHERE segment.chunk_id = chunk.id
                      AND segment.result_kind = 'final'
                      AND segment.model_version = job.model_version
                      AND segment.started_at <= chunk.started_at
                      AND segment.ended_at >= chunk.ended_at
                  )
                )
              )
          ) THEN chunk.duration_ms ELSE 0 END), 0) AS final_ms
        FROM audio_chunks AS chunk
        WHERE chunk.write_state = 'committed' AND chunk.deleted_at IS NULL
      `),
      listRuntimeProvisionalCoverageRanges: this.db.prepare(`
        SELECT
          chunk.id AS chunk_id,
          MAX(segment.started_at, chunk.started_at) AS started_at,
          MIN(segment.ended_at, chunk.ended_at) AS ended_at
        FROM transcript_segments AS segment
        JOIN audio_chunks AS chunk
          ON chunk.session_id = segment.session_id
          AND chunk.source_type = segment.source_type
          AND (segment.track_id IS NULL OR chunk.track_id = segment.track_id)
          AND segment.started_at < chunk.ended_at
          AND chunk.started_at < segment.ended_at
        WHERE segment.result_kind = 'provisional'
          AND segment.superseded_by IS NULL
          AND segment.duplicate_of IS NULL
          AND chunk.write_state = 'committed'
          AND chunk.deleted_at IS NULL
        ORDER BY chunk.id ASC, started_at ASC, ended_at ASC
      `),
      listExpiredAudioChunks: this.db.prepare(`
        SELECT chunk.* FROM audio_chunks AS chunk
        WHERE chunk.expires_at <= ? AND chunk.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pinned_speaker_evidence AS pinned
            JOIN transcript_segments AS segment
              ON segment.id = pinned.transcript_segment_id
            WHERE segment.session_id = chunk.session_id
              AND segment.started_at < chunk.ended_at
              AND chunk.started_at < segment.ended_at
              AND (
                segment.track_id = chunk.track_id
                OR (
                  segment.track_id IS NULL
                  AND segment.source_type = chunk.source_type
                )
              )
          )
        ORDER BY chunk.expires_at ASC, chunk.id ASC
      `),
      getSessionSourceTrack: this.db.prepare(`
        SELECT * FROM audio_tracks
        WHERE session_id = ? AND source_type = ?
        ORDER BY CASE track_kind
          WHEN 'mic' THEN 0
          WHEN 'system_mix' THEN 1
          ELSE 2
        END, application_key, id
        LIMIT 1
      `),
      insertLegacyMicTrack: this.db.prepare(`
        INSERT INTO audio_tracks (
          id, session_id, source_type, device_id, device_label, strategy,
          sample_rate, channels, started_at, ended_at, state
        ) VALUES (
          @id, @sessionId, 'mic', NULL, NULL, 'legacy_backfill',
          24000, 1, @startedAt, @endedAt, @state
        )
      `),
      listUntrackedAudioChunks: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE session_id = ? AND track_id IS NULL AND deleted_at IS NULL
        ORDER BY started_at ASC, ended_at ASC, id ASC
      `),
      getUntrackedAudioChunk: this.db.prepare(`
        SELECT * FROM audio_chunks
        WHERE id = ? AND session_id = ? AND track_id IS NULL AND deleted_at IS NULL
      `),
      getLastTrackSequence: this.db.prepare(`
        SELECT COALESCE(MAX(sequence_number), -1) AS sequence_number
        FROM audio_chunks WHERE track_id = ?
      `),
      linkLegacyAudioChunk: this.db.prepare(`
        UPDATE audio_chunks
        SET track_id = @trackId, source_type = 'mic', sequence_number = @sequenceNumber
        WHERE id = @id AND session_id = @sessionId
          AND track_id IS NULL AND deleted_at IS NULL
      `),
      syncChunkJobTrack: this.db.prepare(`
        UPDATE processing_jobs SET track_id = @trackId
        WHERE chunk_id = @chunkId
      `),
      listChunkJobsForLegacyLink: this.db.prepare(`
        SELECT id, session_id, track_id, state
        FROM processing_jobs
        WHERE chunk_id = ?
        ORDER BY id
      `),
      getLegacyChunkTranscriptionJob: this.db.prepare(`
        SELECT * FROM processing_jobs
        WHERE job_type = 'transcribe_chunk'
          AND chunk_id = @chunkId
          AND input_hash = @inputHash
          AND input_version = 1
          AND model_version = ''
      `),
      insertLegacyChunkTranscriptionJob: this.db.prepare(`
        INSERT INTO processing_jobs (
          id, session_id, track_id, chunk_id, job_type, state,
          input_hash, input_version, model_version, created_at
        ) VALUES (
          @id, @sessionId, @trackId, @chunkId, 'transcribe_chunk', 'pending',
          @inputHash, 1, '', @createdAt
        )
      `),
      listOpenSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('recording', 'paused', 'finalizing')
        ORDER BY started_at ASC, id ASC
      `),
      getStorageUsageSince: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'wav_written' THEN bytes ELSE 0 END), 0)
            AS written_bytes,
          COALESCE(SUM(CASE WHEN kind = 'flac_written' THEN bytes ELSE 0 END), 0)
            AS compressed_bytes,
          COALESCE(SUM(delta_bytes), 0) AS net_growth_bytes
        FROM storage_usage_events
        WHERE occurred_at >= ?
      `),
      listSessionTracksForRecovery: this.db.prepare(
        "SELECT id FROM audio_tracks WHERE session_id = ? ORDER BY id"
      ),
      getCloudBudgetSettings: this.db.prepare(
        "SELECT provider, monthly_limit_microusd, enabled, updated_at FROM cloud_budget_settings WHERE provider = 'openai'"
      ),
      setCloudBudgetSettings: this.db.prepare(`
        UPDATE cloud_budget_settings
        SET monthly_limit_microusd = @monthlyLimitMicrousd,
            enabled = @enabled,
            updated_at = @at
        WHERE provider = 'openai'
      `),
      getCloudUsageTotals: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_microusd ELSE 0 END), 0) AS spent,
          COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_microusd ELSE 0 END), 0) AS reserved,
          COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count
        FROM cloud_usage
        WHERE provider = 'openai' AND month_utc = ?
      `),
      insertCloudUsage: this.db.prepare(`
        INSERT INTO cloud_usage (
          id, month_utc, provider, model, audio_ms, input_tokens, output_tokens,
          price_version, reserved_microusd, actual_microusd, status, created_at, settled_at
        ) VALUES (
          @id, @monthUtc, 'openai', @model, @audioMs, 0, 0,
          @priceVersion, @reservedMicrousd, 0, 'reserved', @createdAt, NULL
        )
      `),
      getCloudUsage: this.db.prepare("SELECT * FROM cloud_usage WHERE id = ?"),
      settleCloudUsage: this.db.prepare(`
        UPDATE cloud_usage
        SET input_tokens = @inputTokens,
            output_tokens = @outputTokens,
            actual_microusd = @actualMicrousd,
            reserved_microusd = 0,
            status = 'settled',
            settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      releaseCloudUsage: this.db.prepare(`
        UPDATE cloud_usage
        SET reserved_microusd = 0, status = 'released', settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      markCloudUsageUnknown: this.db.prepare(`
        UPDATE cloud_usage
        SET reserved_microusd = 0, status = 'unknown', settled_at = @settledAt
        WHERE id = @id AND status = 'reserved'
      `),
      findSegmentForRevision: this.db.prepare(`
        SELECT person_id, speaker_label
        FROM transcript_segments
        WHERE session_id = @sessionId AND started_at = @startedAt AND text = @originalText
        ORDER BY id ASC
        LIMIT 1
      `),
      insertTranscriptRevision: this.db.prepare(`
        INSERT INTO transcript_revisions (
          id, session_id, started_at, audio_source, person_id, speaker_label,
          original_text, current_text, source, confidence, reason, corrected_at
        ) VALUES (
          @id, @sessionId, @startedAt, @audioSource, @personId, @speakerLabel,
          @originalText, @currentText, 'openai_correction', @confidence, @reason, @correctedAt
        )
      `),
      getTranscriptRevision: this.db.prepare("SELECT * FROM transcript_revisions WHERE id = ?"),
    };

    const writeTranscriptSegments = (sessionId, segments) => {
      for (const segment of segments) {
        const segmentId = assertId(segment.id, "segmentId");
        const existing = this.statements.getSegmentSession.get(segmentId);
        if (existing && existing.session_id !== sessionId) {
          throw new Error(SEGMENT_SESSION_MISMATCH_MESSAGE);
        }
        const mutableSnapshotRow =
          !existing ||
          (existing.result_kind === "provisional" &&
            existing.chunk_id === null &&
            existing.model_version === null &&
            existing.superseded_by === null);
        if (!mutableSnapshotRow) continue;

        const sourceType = segment.sourceType ?? "mic";
        if (sourceType !== "mic" && sourceType !== "system") {
          throw new TypeError("segment sourceType must be mic or system");
        }
        const echoScore = segment.echoScore ?? null;
        if (
          echoScore !== null &&
          (typeof echoScore !== "number" ||
            !Number.isFinite(echoScore) ||
            echoScore < 0 ||
            echoScore > 1)
        ) {
          throw new RangeError("segment echoScore must be null or between zero and one");
        }
        if (sourceType !== "mic" && echoScore !== null) {
          throw new TypeError("segment echoScore is only valid for mic evidence");
        }
        const sourceTrack = this.statements.getSessionSourceTrack.get(sessionId, sourceType);

        if (segment.personId !== null && segment.personId !== undefined) {
          const personId = assertId(segment.personId, "personId");
          this.statements.insertPerson.run({
            id: personId,
            displayName: segment.speakerLabel,
            createdAt: segment.startedAt,
            lastSeenAt: segment.endedAt,
          });
        }

        this.statements.upsertSegment.run({
          id: segmentId,
          sessionId,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          personId: segment.personId ?? null,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          confidence: segment.confidence,
          isStable: segment.isStable ? 1 : 0,
          trackId: sourceTrack?.id ?? null,
          sourceType,
          echoScore,
        });
        const finalWinner = sourceTrack
          ? this.statements.findFinalWinnerForRange.get({
              sessionId,
              trackId: sourceTrack.id,
              startedAt: segment.startedAt,
              endedAt: segment.endedAt,
            })
          : null;
        if (finalWinner) {
          this.statements.supersedeTranscriptSegment.run({
            sessionId,
            provisionalId: segmentId,
            finalId: finalWinner.id,
          });
        }
      }
    };

    this._upsertTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
    });

    this._syncTranscriptSegments = this.db.transaction((sessionId, segments) => {
      writeTranscriptSegments(sessionId, segments);
      if (segments.length === 0) {
        this.db
          .prepare(
            `
          DELETE FROM transcript_segments
          WHERE session_id = ?
            AND result_kind = 'provisional'
            AND chunk_id IS NULL
            AND model_version IS NULL
            AND superseded_by IS NULL
        `
          )
          .run(sessionId);
        return;
      }
      const placeholders = segments.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM transcript_segments
           WHERE session_id = ?
             AND result_kind = 'provisional'
             AND chunk_id IS NULL
             AND model_version IS NULL
             AND superseded_by IS NULL
             AND id NOT IN (${placeholders})`
        )
        .run(sessionId, ...segments.map((segment) => segment.id));
    });

    this._reconcileTranscript = this.db.transaction((sessionId, reconcile) => {
      const history = this.statements.listTranscriptHistory.all(sessionId);
      const provisional = history.filter((row) => row.result_kind === "provisional");
      const final = history.filter((row) => row.result_kind === "final");
      const assignments = reconcile({ provisional, final });
      if (!Array.isArray(assignments)) {
        throw new TypeError("transcript reconciliation must return an array");
      }

      const rowsById = new Map(history.map((row) => [row.id, row]));
      const assigned = new Set();
      let superseded = 0;
      for (const assignment of assignments) {
        const provisionalId = assertId(assignment?.provisionalId, "provisionalSegmentId");
        const finalId = assertId(assignment?.finalId, "finalSegmentId");
        if (assigned.has(provisionalId)) {
          throw new Error("provisional segment has multiple supersession assignments");
        }
        assigned.add(provisionalId);
        const provisionalRow = rowsById.get(provisionalId);
        const finalRow = rowsById.get(finalId);
        if (
          !provisionalRow ||
          provisionalRow.result_kind !== "provisional" ||
          (provisionalRow.superseded_by !== null && provisionalRow.superseded_by !== finalId) ||
          !finalRow ||
          finalRow.result_kind !== "final" ||
          provisionalRow.session_id !== finalRow.session_id ||
          provisionalRow.track_id !== finalRow.track_id ||
          !(provisionalRow.started_at < finalRow.ended_at) ||
          !(finalRow.started_at < provisionalRow.ended_at)
        ) {
          throw new Error("invalid transcript supersession assignment");
        }
        if (provisionalRow.echo_score !== null) {
          this.statements.mergeTranscriptEchoScore.run({
            finalId,
            echoScore: provisionalRow.echo_score,
          });
        }
        if (provisionalRow.superseded_by === null) {
          superseded += this.statements.supersedeTranscriptSegment.run({
            sessionId,
            provisionalId,
            finalId,
          }).changes;
        }
      }
      return {
        inserted: 0,
        superseded,
        unchanged: provisional.length - superseded,
      };
    });
    this._reconcileTranscript = this._reconcileTranscript.immediate;

    this._dedupeTranscript = this.db.transaction((sessionId, selectDuplicates) => {
      const rows = this.statements.listTranscriptDedupeCandidates.all(sessionId);
      const assignments = selectDuplicates(rows);
      if (!Array.isArray(assignments)) {
        throw new TypeError("transcript dedupe must return an array");
      }

      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const assigned = new Set();
      let duplicatesMarked = 0;
      for (const assignment of assignments) {
        const duplicateId = assertId(assignment?.duplicateId, "duplicateSegmentId");
        const masterId = assertId(assignment?.masterId, "masterSegmentId");
        if (assigned.has(duplicateId)) {
          throw new Error("transcript segment has multiple duplicate assignments");
        }
        assigned.add(duplicateId);
        const duplicate = rowsById.get(duplicateId);
        const master = rowsById.get(masterId);
        const isMicEcho =
          duplicate?.source_type === "mic" &&
          duplicate?.track_kind === "mic" &&
          duplicate?.echo_score !== null &&
          duplicate?.echo_score >= 0.8 &&
          new Set(["system_mix", "application"]).has(master?.track_kind);
        const isMixedSystemCopy =
          duplicate?.source_type === "system" &&
          duplicate?.track_kind === "system_mix" &&
          master?.track_kind === "application";
        if (
          !duplicate ||
          !master ||
          master.source_type !== "system" ||
          duplicate.session_id !== master.session_id ||
          (!isMicEcho && !isMixedSystemCopy) ||
          !(duplicate.started_at < master.ended_at) ||
          !(master.started_at < duplicate.ended_at)
        ) {
          throw new Error("invalid transcript duplicate assignment");
        }
        duplicatesMarked += this.statements.markTranscriptDuplicate.run({
          sessionId,
          duplicateId,
          masterId,
        }).changes;
      }
      if (duplicatesMarked > 0) {
        this.statements.refreshSystemAuditProjection.run({ sessionId });
        this.statements.bumpSessionTimelineVersion.run(sessionId);
      }
      return { duplicatesMarked };
    });
    this._dedupeTranscript = this._dedupeTranscript.immediate;

    this._renamePerson = this.db.transaction((input) => {
      if (input.isSelf) this.statements.clearSelf.run();
      this.statements.renamePerson.run(input);
      if (input.wakeModelIds.length > 0) {
        this.speakerIdentityRepository.wakeSessionsForModels(input.wakeModelIds);
      }
    });

    this._rejectSpeakerSuggestion = this.db.transaction((input) => {
      const { cluster, rejection } =
        this.speakerIdentityRepository.rejectSuggestionWithResolution(input);
      if (rejection) {
        const inputHash = buildIdentityResolutionJobKey({
          sessionId: rejection.sessionId,
          diarizationRevision: rejection.diarizationRevision,
          profileRevision: rejection.profileRevision,
          policyId: rejection.policyId,
        });
        this.statements.requeueIdentityResolutionJob.run({
          inputHash,
          policyId: rejection.policyId,
        });
        this.statements.markSessionProcessing.run(rejection.sessionId);
      }
      return cluster;
    });

    this._recoverOpenSessions = this.db.transaction((at) => {
      const openSessions = this.statements.listOpenSessions.all();
      for (const session of openSessions) {
        if (
          session.status === "paused" &&
          session.stop_reason === "capture_stopped_low_disk" &&
          Number.isSafeInteger(session.durable_boundary_at)
        ) {
          continue;
        }
        const sources = this.statements.listSessionTracksForRecovery
          .all(session.id)
          .map((track) => ({ trackId: track.id, gapId: null }));
        this.captureEvidenceStore.finalizeCapture({
          sessionId: session.id,
          sources,
          trackState: "recovered",
          sessionStatus: "recovered",
          at,
        });
      }
      return openSessions.map((session) => this.statements.getSession.get(session.id));
    });

    this._rotateCaptureAtLocalDate = this.db.transaction((input) => {
      const existing = this.statements.getSessionContinuation.get(input);
      if (existing) return { continuation: existing, rollback: null };
      const session = this.statements.getSession.get(input.sourceSessionId);
      if (!session) throw new Error(`session ${input.sourceSessionId} does not exist`);
      const tracks = this.statements.listRotationTracks.all(input.sourceSessionId);
      const gaps = this.statements.listRotationGaps.all(input.sourceSessionId);
      this.captureEvidenceStore.finalizeCapture({
        sessionId: input.sourceSessionId,
        sources: tracks.map((track) => ({
          trackId: track.id,
          gapId: gaps.find((gap) => gap.track_id === track.id)?.id ?? null,
        })),
        trackState: "ended",
        sessionStatus: "completed",
        at: input.boundaryAt,
      });
      this.createSession(input.destinationSession);
      const continuation = this.createSessionContinuation(input);
      return { continuation, rollback: { session, tracks, gaps } };
    });

    this._rollbackCaptureAtLocalDate = this.db.transaction((input) => {
      const continuation = this.statements.getSessionContinuation.get(input);
      if (continuation && continuation.destination_session_id !== input.destinationSessionId) {
        throw new Error("local-date continuation destination changed before rollback");
      }
      this.statements.deleteRotationDestination.run(input.destinationSessionId);
      const restoredSession = this.statements.restoreRotationSession.run(input.rollback.session);
      if (restoredSession.changes !== 1) {
        throw new Error(`session ${input.sourceSessionId} could not be restored`);
      }
      for (const track of input.rollback.tracks) {
        if (this.statements.restoreRotationTrack.run(track).changes !== 1) {
          throw new Error(`track ${track.id} could not be restored`);
        }
      }
      for (const gap of input.rollback.gaps) {
        if (this.statements.restoreRotationGap.run(gap).changes !== 1) {
          throw new Error(`gap ${gap.id} could not be restored`);
        }
      }
      return this.statements.getSession.get(input.sourceSessionId);
    });

    this._commitChunkTranscript = this.db.transaction(
      ({ chunk, result, modelVersion, completedAt }) => {
        const current = this.statements.getChunkForTranscriptCommit.get(chunk.id);
        if (
          !current ||
          current.deleted_at !== null ||
          current.write_state !== "committed" ||
          !current.path ||
          current.path.startsWith("tombstone:") ||
          current.session_id !== chunk.session_id ||
          current.track_id !== chunk.track_id ||
          current.source_type !== chunk.source_type ||
          current.sha256 !== chunk.sha256
        ) {
          throw codedError("AUDIO_UNAVAILABLE");
        }

        if (result.noSpeech === true) {
          const updated = this.statements.setChunkTranscriptionStatus.run({
            chunkId: current.id,
            status: "no_speech",
          });
          if (updated.changes !== 1) throw codedError("AUDIO_UNAVAILABLE");
          return null;
        }

        let segment = this.statements.getFinalChunkTranscript.get(current.id, modelVersion);
        if (!segment) {
          const id = derivedId(
            "chunk_transcript",
            current.session_id,
            current.track_id ?? "",
            current.id,
            current.sha256,
            modelVersion
          );
          this.statements.insertFinalChunkTranscript.run({
            id,
            sessionId: current.session_id,
            startedAt: current.started_at,
            endedAt: current.ended_at,
            speakerLabel: current.source_type,
            text: result.text,
            confidence: result.confidence,
            trackId: current.track_id,
            chunkId: current.id,
            sourceType: current.source_type,
            modelVersion,
            completedAt,
          });
          segment = this.statements.getFinalChunkTranscript.get(current.id, modelVersion);
        }
        if (!segment) throw codedError("TRANSCRIPT_COMMIT_FAILED");
        if (Array.isArray(result.words)) {
          this.statements.deleteTranscriptWords.run(segment.id);
          let ordinal = 0;
          for (const word of result.words) {
            const startedAt = Math.max(
              current.started_at,
              Math.min(current.ended_at - 1, current.started_at + word.startedAtMs)
            );
            const endedAt = Math.max(
              startedAt + 1,
              Math.min(current.ended_at, current.started_at + word.endedAtMs)
            );
            if (endedAt <= startedAt) continue;
            this.statements.insertTranscriptWord.run({
              id: derivedId("transcript_word", segment.id, ordinal, word.word, startedAt, endedAt),
              transcriptSegmentId: segment.id,
              chunkId: current.id,
              ordinal,
              word: word.word,
              startedAt,
              endedAt,
              probability: word.probability,
              createdAt: completedAt,
            });
            ordinal += 1;
          }
        }
        const finalWinner = this.statements.findFinalWinnerForRange.get({
          sessionId: current.session_id,
          trackId: current.track_id,
          startedAt: current.started_at,
          endedAt: current.ended_at,
        });
        if (!finalWinner) throw codedError("TRANSCRIPT_COMMIT_FAILED");
        this.statements.supersedeOverlappingProvisionals.run({
          sessionId: current.session_id,
          trackId: current.track_id,
          startedAt: current.started_at,
          endedAt: current.ended_at,
          finalId: finalWinner.id,
        });
        const updated = this.statements.setChunkTranscriptionStatus.run({
          chunkId: current.id,
          status: "completed",
        });
        if (updated.changes !== 1) throw codedError("AUDIO_UNAVAILABLE");
        const projectionChanges = this.statements.refreshSystemAuditProjection.run({
          sessionId: current.session_id,
        }).changes;
        if (projectionChanges > 0) {
          this.statements.bumpSessionTimelineVersion.run(current.session_id);
        }
        return segment;
      }
    );

    this._inspectSessionTranscriptReadiness = (sessionId) => {
      const session = this.statements.getSession.get(sessionId);
      if (!session) throw new Error(`session ${sessionId} does not exist`);
      const isFinalized =
        (session.status === "completed" || session.status === "recovered") &&
        Number.isSafeInteger(session.ended_at);
      const tracks = this.statements.listSessionReadinessTracks.all(sessionId);
      const chunks = this.statements.listSessionReadinessChunks.all(sessionId);
      const jobs = this.statements.listSessionTranscriptionJobs.all(sessionId);
      const coverage = this.statements.listSessionFinalCoverage.all(sessionId);
      const tracksById = new Map(tracks.map((track) => [track.id, track]));
      const jobsByChunk = new Map();
      for (const job of jobs) {
        const rows = jobsByChunk.get(job.chunk_id) ?? [];
        rows.push(job);
        jobsByChunk.set(job.chunk_id, rows);
      }
      const coverageByChunk = new Map();
      for (const segment of coverage) {
        const rows = coverageByChunk.get(segment.chunk_id) ?? [];
        rows.push(segment);
        coverageByChunk.set(segment.chunk_id, rows);
      }

      const complete =
        isFinalized &&
        chunks.every((chunk) => {
          const track = tracksById.get(chunk.track_id);
          if (
            !track ||
            track.session_id !== sessionId ||
            track.source_type !== chunk.source_type ||
            !["completed", "no_speech"].includes(chunk.transcription_status)
          ) {
            return false;
          }
          const chunkJobs = jobsByChunk.get(chunk.id) ?? [];
          if (
            chunkJobs.length === 0 ||
            chunkJobs.some((job) => !["completed", "superseded"].includes(job.state))
          ) {
            return false;
          }
          if (chunk.transcription_status === "no_speech") return true;
          return (coverageByChunk.get(chunk.id) ?? []).some(
            (segment) =>
              segment.track_id === chunk.track_id &&
              segment.source_type === chunk.source_type &&
              segment.started_at <= chunk.started_at &&
              segment.ended_at >= chunk.ended_at
          );
        });
      return { session, complete, isFinalized };
    };

    this._refreshSessionReadiness = this.db.transaction(
      (sessionId, at, diarizationPolicy = SESSION_DIARIZATION_POLICY) => {
        const { session, complete, isFinalized } =
          this._inspectSessionTranscriptReadiness(sessionId);
        let fullyProcessed = complete;
        if (complete && this.statements.countSessionDiarizationJobs.get(sessionId).count > 0) {
          const snapshot = this.getSpeakerIdentityResolutionSnapshot({
            sessionId,
            at,
            policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
            diarizationPolicy,
          });
          fullyProcessed = false;
          if (snapshot.eligible) {
            const inputHash = buildIdentityResolutionJobKey({
              sessionId,
              diarizationRevision: snapshot.diarizationRevision,
              profileRevision: snapshot.profileRevision,
              policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
            });
            const job = this.statements.getIdentityResolutionJob.get({
              inputHash,
              policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
            });
            const run = this.statements.getIdentityResolutionRun.get({
              sessionId,
              diarizationRevision: snapshot.diarizationRevision,
              profileRevision: snapshot.profileRevision,
              policyId: SPEAKER_IDENTITY_RESOLUTION_POLICY.id,
            });
            fullyProcessed =
              (job?.state === "completed" &&
                Boolean(run) &&
                this.statements.countIdentityResolutionSystemResults.get(run.id).count ===
                  run.expected_cluster_count) ||
              job?.state === "blocked";
          } else {
            // A terminal diarization failure must remain visible in processing details,
            // but it must not hold an otherwise complete transcript in "processing"
            // forever. There is no useful identity job to enqueue until new evidence is
            // created, so expose the session as ready with degraded speaker evidence.
            fullyProcessed =
              this.statements.countOpenSessionDiarizationJobs.get(sessionId).count === 0;
          }
        }
        const processingState = fullyProcessed ? "ready" : isFinalized ? "processing" : "pending";
        const readyAt = fullyProcessed ? (session.ready_at ?? at) : null;
        this.statements.setSessionReadiness.run({ sessionId, processingState, readyAt });
        return this.statements.getSession.get(sessionId);
      }
    );

    this._commitDiarizationRun = this.db.transaction((input) => {
      const existing = this.statements.getDiarizationRun.get({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        transcriptRevision: input.expectedRevision,
        policyId: input.run.policyId,
      });
      if (existing) return { status: "already_completed", runId: existing.id };

      const priorSpeakerEvidence =
        input.run.inputVersion > 1
          ? this.statements.getPriorDiarizationSpeakerCount.get({
              sessionId: input.run.sessionId,
              trackId: input.run.trackId,
              inputVersion: input.run.inputVersion,
            })
          : null;

      const current = this.getDiarizationEvidenceSnapshot({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        at: input.validatedAt,
        speakerProcessingPolicy: input.speakerProcessingPolicy,
      });
      if (!current.eligible || current.evidenceRevision !== input.expectedRevision) {
        throw codedError("DIARIZATION_STALE_INPUT");
      }
      const commitSequence = this.statements.nextDiarizationCommitSequence.get().value;
      this.statements.insertDiarizationRun.run({
        ...input.run,
        transcriptRevision: input.run.evidenceRevision,
        commitSequence,
      });
      const persistedClusterIds = new Map();
      const stableCandidates = this.statements.listDiarizationStableClusters.all({
        sessionId: input.run.sessionId,
        trackId: input.run.trackId,
        modelId: input.run.embeddingModelId,
      });
      const reusableCandidates = stableCandidates
        .filter((candidate) => candidate.embedding !== null && candidate.identity_eligible === 1)
        .map((candidate) => ({
          ...candidate,
          normalizedEmbedding: l2NormalizeEmbedding(
            this.speakerIdentityRepository.decodeStoredEmbedding(candidate.embedding, 512)
          ),
        }))
        .filter((candidate) => candidate.normalizedEmbedding !== null);
      const incomingWithVoice = input.clusters
        .filter((cluster) => cluster.embedding !== null && cluster.identityEligible)
        .map((cluster) => ({
          ...cluster,
          normalizedEmbedding: l2NormalizeEmbedding(
            this.speakerIdentityRepository.decodeStoredEmbedding(cluster.embedding, 512)
          ),
        }))
        .filter((cluster) => cluster.normalizedEmbedding !== null);
      const pairs = [];
      for (const cluster of incomingWithVoice) {
        for (const candidate of reusableCandidates) {
          const score = cosineSimilarity(
            cluster.normalizedEmbedding,
            candidate.normalizedEmbedding
          );
          pairs.push({ cluster, candidate, score });
        }
      }
      const comparePairs = (left, right) =>
        right.score - left.score ||
        left.cluster.firstAppearanceAt - right.cluster.firstAppearanceAt ||
        compareStableIds(left.cluster.localLabel, right.cluster.localLabel) ||
        compareStableIds(left.candidate.id, right.candidate.id);
      const pairsByIncoming = new Map();
      const pairsByStable = new Map();
      for (const pair of pairs) {
        const incomingPairs = pairsByIncoming.get(pair.cluster.id) ?? [];
        incomingPairs.push(pair);
        pairsByIncoming.set(pair.cluster.id, incomingPairs);
        const stablePairs = pairsByStable.get(pair.candidate.id) ?? [];
        stablePairs.push(pair);
        pairsByStable.set(pair.candidate.id, stablePairs);
      }
      for (const ranked of pairsByIncoming.values()) ranked.sort(comparePairs);
      for (const ranked of pairsByStable.values()) ranked.sort(comparePairs);
      const eligiblePairs = [];
      for (const rankedIncoming of pairsByIncoming.values()) {
        const best = rankedIncoming[0];
        if (best.score < STABLE_CLUSTER_REUSE_THRESHOLD || !hasStableReuseMargin(rankedIncoming)) {
          continue;
        }
        const rankedStable = pairsByStable.get(best.candidate.id);
        if (rankedStable[0].cluster.id !== best.cluster.id || !hasStableReuseMargin(rankedStable)) {
          continue;
        }
        eligiblePairs.push(best);
      }
      eligiblePairs.sort(
        (left, right) =>
          right.score - left.score ||
          left.cluster.firstAppearanceAt - right.cluster.firstAppearanceAt ||
          compareStableIds(left.cluster.localLabel, right.cluster.localLabel) ||
          compareStableIds(left.candidate.id, right.candidate.id)
      );
      const assignedIncoming = new Set();
      const assignedStable = new Set();
      for (const pair of eligiblePairs) {
        if (assignedIncoming.has(pair.cluster.id) || assignedStable.has(pair.candidate.id))
          continue;
        assignedIncoming.add(pair.cluster.id);
        assignedStable.add(pair.candidate.id);
        persistedClusterIds.set(pair.cluster.id, pair.candidate.id);
      }

      const usedStableIds = new Set(stableCandidates.map((cluster) => cluster.id));
      const usedStableLabels = new Set(stableCandidates.map((cluster) => cluster.local_label));
      for (const cluster of input.clusters) {
        const storedEmbedding =
          cluster.embedding === null
            ? null
            : this.speakerIdentityRepository.protectEncodedEmbedding(cluster.embedding, 512);
        let stableId = persistedClusterIds.get(cluster.id) ?? null;
        if (!stableId) {
          stableId = cluster.id;
          if (usedStableIds.has(stableId)) {
            stableId = derivedId("speaker_cluster", input.run.id, cluster.id);
          }
          let stableLabel = cluster.localLabel;
          if (usedStableLabels.has(stableLabel)) {
            const base = `${cluster.localLabel}__${derivedId("revision", input.run.id).slice(-12)}`;
            stableLabel = base;
            let suffix = 1;
            while (usedStableLabels.has(stableLabel)) {
              suffix += 1;
              stableLabel = `${base}_${suffix}`;
            }
          }
          this.statements.insertDiarizationStableCluster.run({
            id: stableId,
            sessionId: input.run.sessionId,
            trackId: input.run.trackId,
            localLabel: stableLabel,
            modelId: input.run.embeddingModelId,
            embedding: storedEmbedding,
            speechMs: cluster.speechMs,
            windowCount: cluster.windowCount,
            qualityScore: cluster.qualityScore,
            identityEligible: cluster.identityEligible ? 1 : 0,
            qualityGateReason: cluster.qualityGateReason,
            at: input.run.completedAt,
          });
          usedStableIds.add(stableId);
          usedStableLabels.add(stableLabel);
          persistedClusterIds.set(cluster.id, stableId);
        }
        const stable = this.db.prepare("SELECT * FROM speaker_clusters WHERE id = ?").get(stableId);
        if (!stable || stable.model_id !== input.run.embeddingModelId) {
          throw codedError("DIARIZATION_CLUSTER_MODEL_MISMATCH");
        }
        this.statements.insertDiarizationRunCluster.run({
          runId: input.run.id,
          clusterId: stable.id,
          localLabel: cluster.localLabel,
          embedding: storedEmbedding,
          speechMs: cluster.speechMs,
          windowCount: cluster.windowCount,
          qualityScore: cluster.qualityScore,
          firstAppearanceAt: cluster.firstAppearanceAt,
          identityEligible: cluster.identityEligible ? 1 : 0,
          qualityGateReason: cluster.qualityGateReason,
        });
      }

      const chunks = new Map(
        current.chunks.map((entry) => [entry.audioChunk.id, entry.audioChunk])
      );
      const segmentIdsByChunk = new Map(
        current.chunks.map((entry) => [
          entry.audioChunk.id,
          new Set(entry.transcriptSegments.map((segment) => segment.id)),
        ])
      );
      const segmentIds = new Set(
        current.chunks.flatMap((entry) => entry.transcriptSegments.map((segment) => segment.id))
      );
      for (const turn of input.turns) {
        const chunk = chunks.get(turn.chunkId);
        const clusterId = persistedClusterIds.get(turn.clusterId);
        if (
          !chunk ||
          !clusterId ||
          turn.startedAt < chunk.started_at ||
          turn.endedAt > chunk.ended_at ||
          (turn.transcriptSegmentId !== null &&
            !segmentIdsByChunk.get(turn.chunkId)?.has(turn.transcriptSegmentId))
        ) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        this.statements.insertSpeakerTurn.run({
          ...turn,
          runId: input.run.id,
          clusterId,
          embedding: this.speakerIdentityRepository.protectEncodedEmbedding(turn.embedding, 512),
          excludedFromCentroid: turn.excludedFromCentroid ? 1 : 0,
          createdAt: input.run.completedAt,
        });
      }
      for (const link of input.segmentLinks) {
        const clusterId = persistedClusterIds.get(link.clusterId);
        if (!clusterId || !segmentIds.has(link.transcriptSegmentId)) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        this.statements.insertDiarizationSegmentLink.run({
          clusterId,
          transcriptSegmentId: link.transcriptSegmentId,
        });
        this.statements.insertDiarizationRunSegmentLink.run({
          runId: input.run.id,
          clusterId,
          transcriptSegmentId: link.transcriptSegmentId,
        });
      }
      const persistedCannotLinks = new Set();
      for (const link of input.cannotLinks) {
        const rawLeft = persistedClusterIds.get(link.leftClusterId);
        const rawRight = persistedClusterIds.get(link.rightClusterId);
        if (!rawLeft || !rawRight || rawLeft === rawRight) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        const [leftClusterId, rightClusterId] = [rawLeft, rawRight].sort();
        const key = `${leftClusterId}\0${rightClusterId}`;
        if (persistedCannotLinks.has(key)) continue;
        persistedCannotLinks.add(key);
        this.statements.insertSpeakerClusterCannotLink.run({
          runId: input.run.id,
          leftClusterId,
          rightClusterId,
          reason: link.reason,
          createdAt: input.run.completedAt,
        });
      }

      for (const stem of input.overlapStems) {
        const chunk = chunks.get(stem.chunkId);
        const clusterId = persistedClusterIds.get(stem.clusterId);
        if (
          !chunk ||
          !clusterId ||
          stem.startedAt < chunk.started_at ||
          stem.endedAt > chunk.ended_at ||
          stem.endedAt <= stem.startedAt
        ) {
          throw codedError("DIARIZATION_INVALID_COMMIT");
        }
        this.statements.insertOverlapStemEvidence.run({
          ...stem,
          runId: input.run.id,
          clusterId,
          createdAt: input.run.completedAt,
        });
        if (stem.transcriptText) {
          const utteranceId = derivedId("speaker_stem_utterance", input.run.id, stem.id);
          this.statements.insertSpeakerUtterance.run({
            id: utteranceId,
            sessionId: input.run.sessionId,
            runId: input.run.id,
            chunkId: stem.chunkId,
            clusterId,
            sourceSegmentId: null,
            stemId: stem.id,
            startedAt: stem.startedAt,
            endedAt: stem.endedAt,
            text: stem.transcriptText,
            confidence: stem.confidence,
            overlapState: "overlap",
            evidenceKind: "separated_stem",
            createdAt: input.run.completedAt,
          });
        }
      }

      const persistedTurns = input.turns.map((turn) => ({
        ...turn,
        clusterId: persistedClusterIds.get(turn.clusterId),
      }));
      for (const entry of current.chunks) {
        for (const segment of entry.transcriptSegments) {
          const words = this.statements.listTranscriptWordsForDiarizationSegment.all(segment.id);
          if (words.length === 0) continue;
          const segmentTurns = persistedTurns.filter(
            (turn) =>
              turn.chunkId === entry.audioChunk.id &&
              turn.transcriptSegmentId === segment.id &&
              turn.startedAt < segment.ended_at &&
              segment.started_at < turn.endedAt
          );
          for (const turn of segmentTurns) {
            const matchedWords = words.filter((word) => {
              const midpoint = (word.started_at + word.ended_at) / 2;
              return midpoint >= turn.startedAt && midpoint < turn.endedAt;
            });
            if (matchedWords.length === 0) continue;
            const text = matchedWords
              .map((word) => word.word)
              .join("")
              .replace(/\s+/gu, " ")
              .trim();
            if (!text) continue;
            const startedAt = Math.max(
              turn.startedAt,
              Math.min(...matchedWords.map((word) => word.started_at))
            );
            const endedAt = Math.min(
              turn.endedAt,
              Math.max(...matchedWords.map((word) => word.ended_at))
            );
            if (endedAt <= startedAt) continue;
            const overlapState = persistedTurns.some(
              (candidate) =>
                candidate.id !== turn.id &&
                candidate.clusterId !== turn.clusterId &&
                candidate.startedAt < endedAt &&
                startedAt < candidate.endedAt
            )
              ? "overlap"
              : "single";
            const probabilities = matchedWords
              .map((word) => word.probability)
              .filter((value) => typeof value === "number");
            const confidence =
              probabilities.length > 0
                ? probabilities.reduce((total, value) => total + value, 0) /
                  probabilities.length
                : segment.confidence;
            const utteranceId = derivedId(
              "speaker_utterance",
              input.run.id,
              turn.id,
              segment.id,
              startedAt,
              endedAt
            );
            this.statements.insertSpeakerUtterance.run({
              id: utteranceId,
              sessionId: input.run.sessionId,
              runId: input.run.id,
              chunkId: entry.audioChunk.id,
              clusterId: turn.clusterId,
              sourceSegmentId: segment.id,
              stemId: null,
              startedAt,
              endedAt,
              text,
              confidence,
              overlapState,
              evidenceKind: "word_alignment",
              createdAt: input.run.completedAt,
            });
            matchedWords.forEach((word, ordinal) => {
              this.statements.insertSpeakerUtteranceWord.run({
                utteranceId,
                transcriptWordId: word.id,
                ordinal,
              });
            });
          }
        }
      }
      if (input.run.inputVersion === 2 && priorSpeakerEvidence) {
        const hasSummary =
          this.statements.sessionHasRetainedSummary.get(input.run.sessionId, input.run.sessionId)
            ?.value === 1;
        if (hasSummary) {
          const changed = priorSpeakerEvidence.speaker_count !== input.clusters.length;
          this.statements.upsertSummaryRefreshState.run({
            sessionId: input.run.sessionId,
            basisPolicyId: priorSpeakerEvidence.policy_id,
            latestPolicyId: input.run.policyId,
            recommended: changed ? 1 : 0,
            reason: changed ? "speaker_count_changed" : null,
            at: input.run.completedAt,
          });
        }
      }
      return { status: "completed", runId: input.run.id };
    });
    this._commitDiarizationRun = this._commitDiarizationRun.immediate;

    this._backfillLegacyMicChunks = this.db.transaction(
      ({ sessionId, deterministicTrackId, chunkIds, createdAt }) => {
        const session = this.statements.getSession.get(sessionId);
        if (!session) throw new Error(`session ${sessionId} does not exist`);
        const semanticBaselines = computeSessionSemanticHashes(this.db, sessionId);

        let track = this.statements.getSessionSourceTrack.get(sessionId, "mic");
        if (!track) {
          const lifecycle = legacyTrackLifecycle(session);
          this.statements.insertLegacyMicTrack.run({
            id: deterministicTrackId,
            sessionId,
            startedAt: session.started_at,
            endedAt: lifecycle.endedAt,
            state: lifecycle.state,
          });
          track = this.statements.getSessionSourceTrack.get(sessionId, "mic");
        }

        const chunks = chunkIds
          .map((id) => this.statements.getUntrackedAudioChunk.get(id, sessionId))
          .filter(Boolean)
          .filter((chunk) => chunk.source_type === "mic")
          .sort(
            (left, right) =>
              left.started_at - right.started_at ||
              left.ended_at - right.ended_at ||
              compareStableIds(left.id, right.id)
          );
        let sequenceNumber = this.statements.getLastTrackSequence.get(track.id).sequence_number + 1;
        let linked = 0;
        let jobsCreated = 0;
        for (const chunk of chunks) {
          const existingJobs = this.statements.listChunkJobsForLegacyLink.all(chunk.id);
          if (existingJobs.some((job) => job.session_id !== sessionId)) {
            throw new Error("processing job session does not match legacy chunk session");
          }
          const link = this.statements.linkLegacyAudioChunk.run({
            id: chunk.id,
            sessionId,
            trackId: track.id,
            sequenceNumber,
          });
          if (link.changes !== 1) continue;
          sequenceNumber += 1;
          linked += 1;
          this.statements.syncChunkJobTrack.run({ chunkId: chunk.id, trackId: track.id });
          const jobInput = { chunkId: chunk.id, inputHash: chunk.sha256 };
          if (!this.statements.getLegacyChunkTranscriptionJob.get(jobInput)) {
            this.statements.insertLegacyChunkTranscriptionJob.run({
              id: `job_${crypto.randomUUID().replaceAll("-", "")}`,
              sessionId,
              trackId: track.id,
              ...jobInput,
              createdAt,
            });
            jobsCreated += 1;
          }
        }
        if (linked > 0 && new Set(["completed", "recovered"]).has(session.status)) {
          this.statements.upsertHistoricalReprocessingState.run({
            sessionId,
            policyId: SESSION_DIARIZATION_POLICY.policyId,
            at: createdAt,
            ...semanticBaselines,
          });
        }
        return { linked, jobsCreated, trackId: track.id };
      }
    );

    this._reserveCloudUsage = this.db.transaction((input) => {
      const settings = this.statements.getCloudBudgetSettings.get();
      const totals = this.statements.getCloudUsageTotals.get(input.monthUtc);
      if (totals.unknown_count > 0) {
        return { ok: false, reason: "usage_unknown" };
      }
      if (!settings.enabled) {
        return { ok: false, reason: "cloud_disabled" };
      }
      if (
        totals.spent + totals.reserved + input.reservedMicrousd >
        settings.monthly_limit_microusd
      ) {
        return { ok: false, reason: "budget_protected" };
      }
      this.statements.insertCloudUsage.run(input);
      return { ok: true, reservationId: input.id };
    });
  }

  createSession({
    id,
    startedAt,
    micDeviceId,
    language = "zh",
    captureMode = "mic",
    retentionMode = RETENTION_MODES.SPEECH_TRIGGERED,
    capturePolicy,
  }) {
    const sessionId = assertId(id, "sessionId");
    assertInteger(startedAt, "startedAt");
    const mode = assertCaptureMode(captureMode);
    const safeRetentionMode = assertRetentionMode(retentionMode);
    const safeCapturePolicy = normalizeCapturePolicy(capturePolicy);
    if (micDeviceId !== null && micDeviceId !== undefined && typeof micDeviceId !== "string") {
      throw new TypeError("micDeviceId must be a string or null");
    }
    if (mode === "system" && micDeviceId !== null && micDeviceId !== undefined) {
      throw new TypeError("system capture cannot persist a microphone device id");
    }
    if (typeof language !== "string" || language.length === 0 || language.length > 32) {
      throw new TypeError("language must be a non-empty string of at most 32 characters");
    }

    this.statements.createSession.run({
      id: sessionId,
      startedAt,
      micDeviceId: micDeviceId ?? null,
      language,
      createdAt: Date.now(),
      captureMode: mode,
      retentionMode: safeRetentionMode,
      capturePolicyJson: JSON.stringify(safeCapturePolicy),
    });
    return this.getSession(sessionId);
  }

  createSessionContinuation({
    sourceSessionId,
    destinationSessionId,
    boundaryAt,
    destinationLocalDate,
  }) {
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSessionId, "destinationSessionId"),
      boundaryAt: assertInteger(boundaryAt, "boundaryAt"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    if (input.sourceSessionId === input.destinationSessionId) {
      throw new TypeError("continuation sessions must be different");
    }
    this.statements.insertSessionContinuation.run(input);
    const continuation = this.statements.getSessionContinuation.get(input);
    if (!continuation) throw new Error("session continuation could not be persisted");
    return continuation;
  }

  getSessionContinuation(sourceSessionId, destinationLocalDate) {
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    return this.statements.getSessionContinuation.get(input) ?? null;
  }

  listSessionContinuations(sourceSessionId) {
    return this.statements.listSessionContinuations.all(
      assertId(sourceSessionId, "sourceSessionId")
    );
  }

  rotateCaptureAtLocalDate({
    sourceSessionId,
    destinationSession,
    boundaryAt,
    destinationLocalDate,
  }) {
    if (!destinationSession || typeof destinationSession !== "object") {
      throw new TypeError("destinationSession is required");
    }
    const input = {
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSession.id, "destinationSessionId"),
      destinationSession,
      boundaryAt: assertInteger(boundaryAt, "boundaryAt"),
      destinationLocalDate,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(destinationLocalDate)) {
      throw new TypeError("destinationLocalDate must be YYYY-MM-DD");
    }
    return this._rotateCaptureAtLocalDate(input);
  }

  rollbackCaptureAtLocalDate({
    sourceSessionId,
    destinationSessionId,
    destinationLocalDate,
    rollback,
  }) {
    if (!rollback || typeof rollback !== "object") {
      throw new TypeError("rotation rollback evidence is required");
    }
    return this._rollbackCaptureAtLocalDate({
      sourceSessionId: assertId(sourceSessionId, "sourceSessionId"),
      destinationSessionId: assertId(destinationSessionId, "destinationSessionId"),
      destinationLocalDate,
      rollback,
    });
  }

  setSessionRetention(id, retentionMode, capturePolicy) {
    const sessionId = assertId(id, "sessionId");
    const safeRetentionMode = assertRetentionMode(retentionMode);
    const safeCapturePolicy = normalizeCapturePolicy(capturePolicy);
    const result = this.statements.setSessionRetention.run({
      id: sessionId,
      retentionMode: safeRetentionMode,
      capturePolicyJson: JSON.stringify(safeCapturePolicy),
    });
    if (result.changes !== 1) throw new Error(`session ${sessionId} does not exist`);
    return this.getSession(sessionId);
  }

  setSessionStatus(id, status, at = Date.now()) {
    const sessionId = assertId(id, "sessionId");
    const sessionStatus = assertSessionStatus(status);
    assertInteger(at, "at");
    this.statements.setSessionStatus.run({
      id: sessionId,
      status: sessionStatus,
      endedAt: TERMINAL_SESSION_STATUSES.has(sessionStatus) ? at : null,
    });
    return this.getSession(sessionId);
  }

  getSession(id) {
    return this.statements.getSession.get(assertId(id, "sessionId")) ?? null;
  }

  listSessions({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
    assertInteger(from, "from");
    assertInteger(to, "to");
    assertInteger(limit, "limit");
    if (from > to) throw new RangeError("from must not be greater than to");
    if (limit < 1 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
    return this.statements.listSessions.all({ from, to, limit });
  }

  listProcessingSessions({ after = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError("processing session limit must be between 1 and 1000");
    }
    let afterSortAt = null;
    let afterId = null;
    if (after !== null) {
      if (!after || typeof after !== "object" || Array.isArray(after)) {
        throw new TypeError("processing session cursor must be an object or null");
      }
      afterSortAt = assertInteger(after.sortAt, "processing session cursor sortAt");
      afterId = assertId(after.id, "processing session cursor id");
    }
    return this.statements.listProcessingSessions.all({ afterSortAt, afterId, limit });
  }

  listPendingJobs(sessionId) {
    return this.statements.listPendingJobs.all(assertId(sessionId, "sessionId"));
  }

  refreshLogicalApplicationTracks(sessionId, at = Date.now()) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "at");
    const tracks = this.statements.listSessionIdentityTracks
      .all(safeSessionId)
      .filter((track) => track.track_kind === "application" && track.application_key);
    const byApplication = new Map();
    for (const track of tracks) {
      const members = byApplication.get(track.application_key) ?? [];
      members.push(track);
      byApplication.set(track.application_key, members);
    }
    const refresh = this.db.transaction(() => {
      const logicalTracks = [];
      for (const [applicationKey, unsortedMembers] of byApplication) {
        const members = [...unsortedMembers].sort(
          (left, right) =>
            (left.capture_generation ?? 0) - (right.capture_generation ?? 0) ||
            (left.started_at ?? 0) - (right.started_at ?? 0) ||
            left.id.localeCompare(right.id)
        );
        const canonical = members[0];
        const startedAt = Math.min(...members.map((member) => member.started_at));
        const latestEndedAt = members.some((member) => member.ended_at === null)
          ? null
          : Math.max(...members.map((member) => member.ended_at));
        const endedAt = latestEndedAt !== null && latestEndedAt > startedAt ? latestEndedAt : null;
        this.statements.upsertLogicalApplicationTrack.run({
          id: derivedId("logical_application_track", safeSessionId, applicationKey),
          sessionId: safeSessionId,
          canonicalTrackId: canonical.id,
          applicationKey,
          applicationDisplayName: canonical.application_display_name,
          startedAt,
          endedAt,
          generationCount: members.length,
          at: safeAt,
        });
        const logical = this.statements.getLogicalApplicationTrack.get({
          sessionId: safeSessionId,
          applicationKey,
        });
        if (!logical) throw new Error("logical application track was not persisted");
        this.statements.deleteLogicalApplicationMembers.run(logical.id);
        members.forEach((member, memberIndex) => {
          this.statements.insertLogicalApplicationMember.run({
            logicalTrackId: logical.id,
            trackId: member.id,
            captureGeneration: member.capture_generation ?? 0,
            memberIndex,
          });
        });
        logicalTracks.push({ ...logical, memberTrackIds: members.map((member) => member.id) });
      }
      return logicalTracks;
    });
    return this.db.inTransaction ? refresh() : refresh.immediate();
  }

  getDiarizationTrackEvidence({ sessionId, trackId, observedAt = Date.now() } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(trackId, "trackId");
    const safeObservedAt = assertNonNegativeInteger(observedAt, "observedAt");
    const session = this.statements.getSession.get(safeSessionId);
    const physicalTrack = this.statements.getDiarizationTrack.get({
      sessionId: safeSessionId,
      trackId: safeTrackId,
    });
    const logical = this.statements.getLogicalApplicationTrackByCanonical.get({
      sessionId: safeSessionId,
      trackId: safeTrackId,
    });
    const track =
      physicalTrack && logical
        ? {
            ...physicalTrack,
            started_at: logical.started_at,
            ended_at: logical.ended_at,
            logical_track_id: logical.id,
            logical_generation_count: logical.generation_count,
          }
        : physicalTrack;
    const rawChunks = logical
      ? this.statements.listLogicalDiarizationChunks.all({
          sessionId: safeSessionId,
          logicalTrackId: logical.id,
        })
      : this.statements.listDiarizationChunks.all({
          sessionId: safeSessionId,
          trackId: safeTrackId,
        });
    const chunks = selectLogicalAudioChunks(rawChunks).map((audioChunk, sequenceNumber) => ({
      ...audioChunk,
      physical_track_id: audioChunk.track_id,
      track_id: safeTrackId,
      sequence_number: sequenceNumber,
    }));
    return deepFreeze({
      observedAt: safeObservedAt,
      session: session ?? null,
      track: track ?? null,
      chunks: chunks.map((audioChunk) => ({
        audioChunk,
        latestTranscriptionJob: (() => {
          const job = this.statements.getLatestChunkTranscriptionJob.get(audioChunk.id) ?? null;
          return job ? { ...job, physical_track_id: job.track_id, track_id: safeTrackId } : null;
        })(),
        transcriptSegments: this.statements.listDiarizationSegments
          .all(audioChunk.id)
          .map((segment) => ({
            ...segment,
            physical_track_id: segment.track_id,
            track_id: safeTrackId,
          })),
      })),
    });
  }

  getDiarizationEvidenceSnapshot({
    sessionId,
    trackId,
    at = Date.now(),
    speakerProcessingPolicy,
  } = {}) {
    if (!speakerProcessingPolicy || typeof speakerProcessingPolicy.evaluate !== "function") {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    return speakerProcessingPolicy.evaluate(
      this.getDiarizationTrackEvidence({ sessionId, trackId, observedAt: at })
    );
  }

  getDiarizationRun({ sessionId, trackId, evidenceRevision, policyId } = {}) {
    if (typeof evidenceRevision !== "string" || !/^[0-9a-f]{64}$/.test(evidenceRevision)) {
      throw new TypeError("evidenceRevision must be a lowercase SHA-256 digest");
    }
    return (
      this.statements.getDiarizationRun.get({
        sessionId: assertId(sessionId, "sessionId"),
        trackId: assertId(trackId, "trackId"),
        transcriptRevision: evidenceRevision,
        policyId: assertId(policyId, "policyId"),
      }) ?? null
    );
  }

  listDiarizationRuns(sessionId) {
    return this.statements.listDiarizationRuns.all(assertId(sessionId, "sessionId"));
  }

  markSessionSummaryRefreshRecommended(sessionId, reason, at = Date.now()) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (!SUMMARY_REFRESH_REASONS.has(reason)) {
      throw new TypeError("summary refresh reason is invalid");
    }
    const safeAt = assertNonNegativeInteger(at, "at");
    const mark = this.db.transaction(() => {
      const hasSummary =
        this.statements.sessionHasRetainedSummary.get(safeSessionId, safeSessionId)?.value === 1;
      if (!hasSummary) return null;
      const latestPolicyId =
        this.statements.listDiarizationRuns.all(safeSessionId).at(-1)?.policy_id ??
        SESSION_DIARIZATION_POLICY.policyId;
      this.statements.upsertSummaryRefreshState.run({
        sessionId: safeSessionId,
        basisPolicyId: null,
        latestPolicyId,
        recommended: 1,
        reason,
        at: safeAt,
      });
      return this.statements.getSummaryRefreshState.get(safeSessionId) ?? null;
    });
    return mark.immediate();
  }

  getSessionSpeakerProcessing(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const allRuns = this.statements.listDiarizationRuns.all(safeSessionId);
    const preferredInputVersion = allRuns.some((run) => run.input_version === 2) ? 2 : 1;
    const latestByTrack = new Map();
    for (const run of allRuns) {
      if (run.input_version !== preferredInputVersion) continue;
      const previous = latestByTrack.get(run.track_id);
      if (!previous || previous.commit_sequence < run.commit_sequence) {
        latestByTrack.set(run.track_id, run);
      }
    }
    const latestRuns = [...latestByTrack.values()].sort(
      (left, right) => left.commit_sequence - right.commit_sequence
    );
    const latestRunClusters = latestRuns.flatMap((run) =>
      this.statements.listIdentityResolutionRunClusters.all(run.id)
    );
    const clusterIds = new Set(latestRunClusters.map((cluster) => cluster.cluster_id));
    const confirmedClusterIds = new Set(
      this.speakerIdentityRepository.listConfirmedSessionClusterIds(safeSessionId)
    );
    const publicClusterIds = new Set(
      latestRunClusters
        .filter(
          (cluster) =>
            confirmedClusterIds.has(cluster.cluster_id) ||
            (cluster.speech_ms >= PUBLIC_SPEAKER_MIN_SPEECH_MS &&
              cluster.window_count >= PUBLIC_SPEAKER_MIN_WINDOWS)
        )
        .map((cluster) => cluster.cluster_id)
    );
    for (const clusterId of confirmedClusterIds) {
      publicClusterIds.add(clusterId);
    }
    const speakerEvidence = new Map();
    const clusterReviewOverrides = new Map(
      this.db
        .prepare(
          `SELECT cluster_id, group_ref, disposition, source_event_id, updated_at
           FROM speaker_cluster_review_overrides WHERE session_id = ?`
        )
        .all(safeSessionId)
        .map((row) => [
          row.cluster_id,
          {
            groupRef: row.group_ref,
            disposition: row.disposition,
            sourceEventId: row.source_event_id,
            updatedAt: row.updated_at,
          },
        ])
    );
    const segmentReviewOverrides = new Map(
      this.db
        .prepare(
          `SELECT transcript_segment_id, cluster_id, group_ref, disposition,
            source_event_id, updated_at
           FROM speaker_segment_review_overrides WHERE session_id = ?`
        )
        .all(safeSessionId)
        .map((row) => [
          row.transcript_segment_id,
          {
            clusterId: row.cluster_id,
            groupRef: row.group_ref,
            disposition: row.disposition,
            sourceEventId: row.source_event_id,
            updatedAt: row.updated_at,
          },
        ])
    );
    const pinnedSegmentIds = new Set(
      this.db
        .prepare("SELECT transcript_segment_id FROM pinned_speaker_evidence WHERE session_id = ?")
        .all(safeSessionId)
        .map((row) => row.transcript_segment_id)
    );
    for (const clusterId of clusterReviewOverrides.keys()) publicClusterIds.add(clusterId);
    for (const override of segmentReviewOverrides.values()) {
      publicClusterIds.add(override.clusterId);
    }
    const speakers = [...publicClusterIds]
      .sort()
      .map((clusterId) => {
        const cluster = this.speakerIdentityRepository.getCluster(clusterId);
        const view = this.speakerIdentityRepository.getClusterView(clusterId);
        if (cluster && view) speakerEvidence.set(clusterId, cluster);
        return view;
      })
      .filter(Boolean);
    const evidenceSegmentsByCluster = new Map();
    for (const segment of this.statements.listSessionSpeakerEvidenceSegments.all(safeSessionId)) {
      if (!publicClusterIds.has(segment.cluster_id)) continue;
      const entries = evidenceSegmentsByCluster.get(segment.cluster_id) ?? [];
      entries.push({
        id: segment.id,
        started_at: segment.started_at,
        ended_at: segment.ended_at,
        text: segment.text,
        confidence: segment.confidence,
        track_id: segment.track_id,
        source_type: segment.source_type,
        result_kind: segment.result_kind,
        duplicate_of: segment.duplicate_of,
        pinned: pinnedSegmentIds.has(segment.id),
      });
      evidenceSegmentsByCluster.set(segment.cluster_id, entries);
    }
    const projectionClusters = speakers.flatMap((speaker) => {
      const evidenceSegments = evidenceSegmentsByCluster.get(speaker.id) ?? [];
      const reviewedGroups = new Map();
      const baseSegments = [];
      for (const segment of evidenceSegments) {
        const override = segmentReviewOverrides.get(segment.id);
        if (!override || override.clusterId !== speaker.id) {
          baseSegments.push(segment);
          continue;
        }
        const entry = reviewedGroups.get(override.groupRef) ?? {
          override,
          segments: [],
        };
        entry.segments.push(segment);
        reviewedGroups.set(override.groupRef, entry);
      }
      const clusterBase = {
        ...speaker,
        _embedding: speakerEvidence.get(speaker.id)?.embedding ?? null,
        baseClusterId: speaker.id,
      };
      if (reviewedGroups.size === 0) {
        return [
          {
            ...clusterBase,
            evidenceSegments,
            reviewOverride: clusterReviewOverrides.get(speaker.id) ?? null,
          },
        ];
      }
      const expanded = [];
      if (baseSegments.length > 0) {
        expanded.push({
          ...clusterBase,
          projectionRef: `${speaker.id}:base`,
          evidenceSegments: baseSegments,
          reviewOverride: clusterReviewOverrides.get(speaker.id) ?? null,
        });
      }
      for (const [groupRef, entry] of reviewedGroups) {
        expanded.push({
          ...clusterBase,
          projectionRef: `${speaker.id}:segment:${groupRef}`,
          linkState: "unknown",
          person: null,
          candidatePersonRef: null,
          reason: "user_segment_review",
          speechMs: entry.segments.reduce(
            (total, segment) => total + Math.max(0, segment.ended_at - segment.started_at),
            0
          ),
          windowCount: entry.segments.length,
          evidenceSegments: entry.segments,
          reviewOverride: {
            groupRef,
            disposition: entry.override.disposition,
            sourceEventId: entry.override.sourceEventId,
            updatedAt: entry.override.updatedAt,
          },
        });
      }
      return expanded;
    });
    const participantProjection = projectSessionParticipants({
      clusters: projectionClusters,
      tracks: this.statements.listSessionReadinessTracks.all(safeSessionId),
      activityClassifications:
        this.activityClassificationRepository.listSessionEffective(safeSessionId),
    });
    const persistedSummaryRefresh =
      this.db
        .prepare("SELECT * FROM session_summary_refresh_state WHERE session_id = ?")
        .get(safeSessionId) ?? null;
    const latestSummary = this.db
      .prepare(
        `SELECT completeness, created_at
         FROM session_summary_revisions
         WHERE session_id = ? AND lifecycle = 'active'
         ORDER BY revision DESC LIMIT 1`
      )
      .get(safeSessionId);
    const summaryRefresh =
      latestSummary?.completeness === "incremental" && persistedSummaryRefresh?.recommended !== 1
        ? {
            basis_policy_id: persistedSummaryRefresh?.basis_policy_id ?? null,
            latest_policy_id: latestRuns.at(-1)?.policy_id ?? SESSION_DIARIZATION_POLICY.policyId,
            recommended: 1,
            reason: "summary_incomplete",
            updated_at: latestSummary.created_at,
          }
        : persistedSummaryRefresh;
    const reprocessing = this.statements.getSessionReprocessingState.get(safeSessionId) ?? null;
    return {
      preferredInputVersion,
      latestRuns: latestRuns.map(projectDiarizationRun),
      history: allRuns.map(projectDiarizationRun),
      speakers,
      participants: participantProjection,
      participantSnapshot: (() => {
        const snapshot = this.getLatestParticipantSnapshot(safeSessionId);
        return snapshot
          ? {
              id: snapshot.id,
              revision: snapshot.revision,
              sourceHash: snapshot.sourceHash,
              createdAt: snapshot.createdAt,
            }
          : null;
      })(),
      fragmentedEvidenceCount: Math.max(0, clusterIds.size - publicClusterIds.size),
      summaryRefresh,
      reprocessing,
    };
  }

  getLatestParticipantSnapshot(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const row = this.db
      .prepare(
        `SELECT id, session_id, revision, projector_version, source_hash,
          payload_json, created_at
         FROM session_participant_snapshots
         WHERE session_id = ? ORDER BY revision DESC LIMIT 1`
      )
      .get(safeSessionId);
    if (!row) return null;
    let projection;
    try {
      projection = JSON.parse(row.payload_json);
    } catch {
      throw codedError("PARTICIPANT_SNAPSHOT_INVALID");
    }
    const memberships = this.db
      .prepare(
        `SELECT participant_ref, cluster_id, membership_kind
         FROM session_participant_snapshot_clusters
         WHERE snapshot_id = ?
         ORDER BY participant_ref, cluster_id`
      )
      .all(row.id)
      .map((membership) => ({
        participantRef: membership.participant_ref,
        clusterId: membership.cluster_id,
        membershipKind: membership.membership_kind,
      }));
    return {
      id: row.id,
      sessionId: row.session_id,
      revision: row.revision,
      projectorVersion: row.projector_version,
      sourceHash: row.source_hash,
      payload: projection,
      projection,
      memberships,
      createdAt: row.created_at,
    };
  }

  refreshSessionParticipantSnapshot(sessionId, { at = this.memoryDependencies.now() } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "participantSnapshotAt");
    const processing = this.getSessionSpeakerProcessing(safeSessionId);
    const activities = this.activityClassificationRepository
      .listSessionEffective(safeSessionId)
      .map((activity) => ({
        id: activity.id,
        category: activity.category,
        confidence: activity.confidence,
        startedAt: activity.started_at ?? activity.startedAt,
        endedAt: activity.ended_at ?? activity.endedAt,
        updatedAt: activity.updated_at ?? activity.updatedAt ?? null,
      }))
      .sort(
        (left, right) =>
          (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
          String(left.id).localeCompare(String(right.id))
      );
    const reviewHead =
      this.db
        .prepare(
          `SELECT id, action, created_at
           FROM participant_review_events
           WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(safeSessionId) ?? null;
    const causalState = {
      projectorVersion: PROJECTOR_VERSION,
      latestRuns: processing.latestRuns.map((run) => ({
        id: run.id,
        commitSequence: run.commitSequence,
        policyId: run.policyId,
      })),
      speakers: processing.speakers
        .map((speaker) => ({
          id: speaker.id,
          personId: speaker.person?.id ?? null,
          personName: speaker.person?.displayName ?? null,
          isSelf: speaker.person?.isSelf ?? false,
          linkState: speaker.linkState,
          reason: speaker.reason,
          updatedAt: speaker.updatedAt,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      activities,
      reviewHead,
      projection: processing.participants,
    };
    const sourceHash = crypto.createHash("sha256").update(canonicalJson(causalState)).digest("hex");
    const existing = this.db
      .prepare(
        `SELECT id FROM session_participant_snapshots
         WHERE session_id = ? AND source_hash = ?`
      )
      .get(safeSessionId, sourceHash);
    if (existing) return this.getLatestParticipantSnapshot(safeSessionId);

    const snapshotId = derivedId("participant-snapshot", safeSessionId, sourceHash);
    const projection = processing.participants;
    const persist = this.db.transaction(() => {
      const revision = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
           FROM session_participant_snapshots WHERE session_id = ?`
        )
        .get(safeSessionId).revision;
      this.db
        .prepare(
          `INSERT INTO session_participant_snapshots (
            id, session_id, revision, projector_version, source_hash,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshotId,
          safeSessionId,
          revision,
          PROJECTOR_VERSION,
          sourceHash,
          canonicalJson(projection),
          safeAt
        );
      const insertMembership = this.db.prepare(
        `INSERT INTO session_participant_snapshot_clusters (
          snapshot_id, participant_ref, cluster_id, membership_kind
        ) VALUES (?, ?, ?, ?)`
      );
      for (const participant of [...projection.participants, ...projection.mediaVoices]) {
        const participantRef = `participant:${participant.kind}:${crypto
          .createHash("sha256")
          .update(
            canonicalJson({
              id: participant.id,
              clusterIds: [...participant.clusterIds].sort(),
              segmentIds: [...(participant.segmentIds ?? [])].sort(),
            })
          )
          .digest("hex")
          .slice(0, 40)}`;
        for (const clusterId of [...new Set(participant.clusterIds)].sort()) {
          insertMembership.run(snapshotId, participantRef, clusterId, participant.kind);
        }
      }
      return revision;
    });
    persist.immediate();
    return this.getLatestParticipantSnapshot(safeSessionId);
  }

  beginParticipantReviewBackfillBatch({
    scope = "recent_audio",
    limit = 4,
    at = this.memoryDependencies.now(),
  } = {}) {
    const validScopes = new Set(["recent_audio", "all_retained_audio", "metadata_cleanup"]);
    if (!validScopes.has(scope)) {
      throw new RangeError("participant review backfill scope is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("participant review backfill limit must be between 1 and 100");
    }
    const safeAt = assertNonNegativeInteger(at, "participantReviewBackfillAt");
    const audioPredicate =
      scope === "metadata_cleanup"
        ? `NOT EXISTS (
            SELECT 1 FROM audio_chunks AS chunk
            WHERE chunk.session_id = session.id
              AND chunk.write_state = 'committed'
              AND chunk.deleted_at IS NULL
              AND chunk.expires_at > @at
          )`
        : `EXISTS (
            SELECT 1 FROM audio_chunks AS chunk
            WHERE chunk.session_id = session.id
              AND chunk.write_state = 'committed'
              AND chunk.deleted_at IS NULL
              AND chunk.expires_at > @at
          )`;
    const sessionIds = this.db
      .prepare(
        `SELECT session.id
         FROM sessions AS session
         WHERE session.status IN ('completed','recovered','failed')
           AND session.ended_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_participant_snapshots AS snapshot
             WHERE snapshot.session_id = session.id
           )
           AND ${audioPredicate}
         ORDER BY COALESCE(session.finalized_at, session.ended_at) DESC, session.id DESC
         LIMIT @limit`
      )
      .all({ at: safeAt, limit })
      .map((row) => row.id);
    const batchId = this.memoryDependencies.createId("participant-backfill");
    const state = sessionIds.length === 0 ? "completed" : "running";
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE participant_review_backfill_batches
           SET state = 'cancelled', error_code = 'startup_interrupted',
               completed_at = @at
           WHERE state IN ('queued','running')`
        )
        .run({ at: safeAt });
      this.db
        .prepare(
          `INSERT INTO participant_review_backfill_batches (
             id, scope, state, session_count, processed_count, changed_count,
             error_code, created_at, started_at, completed_at
           ) VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, ?)`
        )
        .run(
          batchId,
          scope,
          state,
          sessionIds.length,
          safeAt,
          sessionIds.length > 0 ? safeAt : null,
          sessionIds.length > 0 ? null : safeAt
        );
    });
    create.immediate();
    return {
      ...this.getParticipantReviewBackfillBatch(batchId),
      sessionIds,
    };
  }

  getParticipantReviewBackfillBatch(batchId) {
    const safeBatchId = assertId(batchId, "participantReviewBackfillBatchId");
    const row = this.db
      .prepare("SELECT * FROM participant_review_backfill_batches WHERE id = ?")
      .get(safeBatchId);
    if (!row) return null;
    return {
      id: row.id,
      scope: row.scope,
      state: row.state,
      sessionCount: row.session_count,
      processedCount: row.processed_count,
      changedCount: row.changed_count,
      errorCode: row.error_code,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  recordParticipantReviewBackfillProgress(batchId, { changed = false, errorCode = null } = {}) {
    const safeBatchId = assertId(batchId, "participantReviewBackfillBatchId");
    if (typeof changed !== "boolean") {
      throw new TypeError("participant review backfill changed must be a boolean");
    }
    if (
      errorCode !== null &&
      (typeof errorCode !== "string" || errorCode.length === 0 || errorCode.length > 200)
    ) {
      throw new TypeError("participant review backfill errorCode is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE participant_review_backfill_batches
         SET processed_count = processed_count + 1,
             changed_count = changed_count + @changed,
             error_code = COALESCE(error_code, @errorCode)
         WHERE id = @id
           AND state = 'running'
           AND processed_count < session_count`
      )
      .run({
        id: safeBatchId,
        changed: changed ? 1 : 0,
        errorCode,
      });
    if (result.changes !== 1) {
      throw codedError("PARTICIPANT_BACKFILL_BATCH_NOT_RUNNING");
    }
    return this.getParticipantReviewBackfillBatch(safeBatchId);
  }

  finishParticipantReviewBackfillBatch(
    batchId,
    { state = "completed", errorCode = null, at = this.memoryDependencies.now() } = {}
  ) {
    const safeBatchId = assertId(batchId, "participantReviewBackfillBatchId");
    if (!new Set(["completed", "failed", "cancelled"]).has(state)) {
      throw new RangeError("participant review backfill terminal state is invalid");
    }
    if (
      errorCode !== null &&
      (typeof errorCode !== "string" || errorCode.length === 0 || errorCode.length > 200)
    ) {
      throw new TypeError("participant review backfill errorCode is invalid");
    }
    const safeAt = assertNonNegativeInteger(at, "participantReviewBackfillCompletedAt");
    const result = this.db
      .prepare(
        `UPDATE participant_review_backfill_batches
         SET state = @state,
             error_code = COALESCE(@errorCode, error_code),
             completed_at = @at
         WHERE id = @id
           AND state = 'running'
           AND (@state <> 'completed' OR processed_count = session_count)`
      )
      .run({
        id: safeBatchId,
        state,
        errorCode,
        at: safeAt,
      });
    if (result.changes !== 1) {
      const current = this.getParticipantReviewBackfillBatch(safeBatchId);
      if (current?.state === "completed" && current.sessionCount === 0 && state === "completed") {
        return current;
      }
      throw codedError("PARTICIPANT_BACKFILL_BATCH_NOT_RUNNING");
    }
    return this.getParticipantReviewBackfillBatch(safeBatchId);
  }

  listDiarizationEchoCandidates({ sessionId, excludeTrackId, policyId } = {}) {
    return this.statements.listDiarizationEchoCandidates
      .all({
        sessionId: assertId(sessionId, "sessionId"),
        excludeTrackId: assertId(excludeTrackId, "excludeTrackId"),
        policyId: assertId(policyId, "policyId"),
      })
      .map((row) => ({
        ...row,
        embedding: this.speakerIdentityRepository.decodeStoredEmbedding(row.embedding, 512),
      }));
  }

  listSpeakerIdentityAudioWindows({ sessionId, evidenceRunId, clusterId } = {}) {
    return this.statements.listSpeakerIdentityAudioWindows
      .all({
        sessionId: assertId(sessionId, "sessionId"),
        evidenceRunId: assertId(evidenceRunId, "evidenceRunId"),
        clusterId: assertId(clusterId, "clusterId"),
      })
      .map((row) => ({
        id: row.id,
        startMs: row.started_at,
        endMs: row.ended_at,
        trackKind: row.track_kind,
        attributionState: row.attribution_state,
        overlapDetected: row.overlap_detected === 1,
        echoDetected: row.echo_state !== "none" || row.duplicate_of_turn_id !== null,
        excludedFromCentroid: row.excluded_from_centroid === 1,
        chunk: this.statements.getAudioChunk.get(row.chunk_id) ?? null,
      }))
      .filter((row) => row.chunk !== null);
  }

  getHistoricalVoiceTurn(turnId) {
    const row = this.statements.getHistoricalVoiceTurn.get(
      assertId(turnId, "historicalVoiceTurnId")
    );
    if (!row) return null;
    return {
      id: row.turn_id,
      clusterId: row.cluster_id,
      startMs: row.turn_started_at,
      endMs: row.turn_ended_at,
      overlapDetected: row.overlap_detected === 1,
      echoDetected: row.echo_state !== "none" || row.duplicate_of_turn_id !== null,
      excludedFromCentroid: row.excluded_from_centroid === 1,
      sourceType: row.source_type,
      micDeviceId: row.mic_device_id,
      chunk: {
        id: row.chunk_id,
        path: row.chunk_path,
        started_at: row.chunk_started_at,
        ended_at: row.chunk_ended_at,
        duration_ms: row.chunk_duration_ms,
        sha256: row.chunk_sha256,
        expires_at: row.chunk_expires_at,
        source_type: row.source_type,
        write_state: row.write_state,
        deleted_at: row.deleted_at,
        format: row.format,
        file_sha256: row.file_sha256,
        sample_rate: row.sample_rate,
        channels: row.channels,
      },
    };
  }

  replaceSpeakerClusterModelEmbeddings(input) {
    return this.speakerIdentityRepository.replaceClusterModelEmbeddings(input);
  }

  listSpeakerClusterModelEmbeddings(clusterId) {
    return this.speakerIdentityRepository.listClusterModelEmbeddings(clusterId);
  }

  enqueueDiarizationJobs(sessionId, { at = Date.now(), policy, speakerProcessingPolicy } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "at");
    if (
      !policy ||
      typeof policy !== "object" ||
      typeof policy.policyId !== "string" ||
      !new Set([1, 2]).has(policy.inputVersion)
    ) {
      throw new TypeError("a versioned diarization policy is required");
    }
    if (!speakerProcessingPolicy || typeof speakerProcessingPolicy.evaluate !== "function") {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    this.refreshLogicalApplicationTracks(safeSessionId, safeAt);
    const tracks = this.statements.listSessionIdentityTracks.all(safeSessionId);
    const chunks = this.statements.listSessionReadinessChunks.all(safeSessionId);
    const {
      preferred: preferredTracks,
      coverageBySystemTrack,
      audioMsByTrack,
    } = preferredSpeakerEvidenceTracks(tracks, chunks);
    const preferredTrackIds = new Set(preferredTracks.map((track) => track.id));
    const jobs = [];
    const skipped = [];
    let enqueued = 0;
    const enqueue = this.db.transaction(() => {
      this.statements.reprioritizeDiarizationJobs.run({ sessionId: safeSessionId });
      for (const track of tracks) {
        if (
          track.track_kind === "application" &&
          ApplicationAudioPolicy.isVirtualAudioInfrastructure({
            applicationKey: track.application_key,
            applicationDisplayName: track.application_display_name,
          })
        ) {
          this.statements.supersedeShortApplicationDiarizationJobs.run({
            sessionId: safeSessionId,
            trackId: track.id,
            at: safeAt,
          });
          skipped.push({ trackId: track.id, reason: "virtual_audio_infrastructure" });
          continue;
        }
        if (
          track.track_kind === "application" &&
          (audioMsByTrack.get(track.id) ?? 0) < MIN_APPLICATION_DIARIZATION_AUDIO_MS
        ) {
          this.statements.supersedeShortApplicationDiarizationJobs.run({
            sessionId: safeSessionId,
            trackId: track.id,
            at: safeAt,
          });
          skipped.push({ trackId: track.id, reason: "speaker_audio_too_short" });
          continue;
        }
        if (!preferredTrackIds.has(track.id)) {
          if (track.track_kind === "application") {
            this.statements.supersedeNonPrimaryApplicationDiarizationJobs.run({
              sessionId: safeSessionId,
              trackId: track.id,
              at: safeAt,
            });
            skipped.push({
              trackId: track.id,
              reason: "application_track_not_primary",
            });
            continue;
          }
          this.statements.supersedeCoveredSystemMixDiarizationJobs.run({
            sessionId: safeSessionId,
            trackId: track.id,
            at: safeAt,
          });
          skipped.push({
            trackId: track.id,
            reason: "covered_by_exact_application",
            coverage: coverageBySystemTrack.get(track.id) ?? 0,
          });
          continue;
        }
        const snapshot = this.getDiarizationEvidenceSnapshot({
          sessionId: safeSessionId,
          trackId: track.id,
          at: safeAt,
          speakerProcessingPolicy,
        });
        if (!snapshot.eligible) {
          skipped.push({ trackId: track.id, reason: snapshot.reason });
          continue;
        }
        const audioMs = snapshot.chunks.reduce(
          (total, entry) => total + (entry.audioChunk?.duration_ms ?? 0),
          0
        );
        if (
          track.track_kind === "application" &&
          ApplicationAudioPolicy.isVirtualAudioInfrastructure({
            applicationKey: track.application_key,
            applicationDisplayName: track.application_display_name,
          })
        ) {
          this.statements.supersedeShortApplicationDiarizationJobs.run({
            sessionId: safeSessionId,
            trackId: track.id,
            at: safeAt,
          });
          skipped.push({ trackId: track.id, reason: "virtual_audio_infrastructure" });
          continue;
        }
        if (track.track_kind === "application" && audioMs < MIN_APPLICATION_DIARIZATION_AUDIO_MS) {
          this.statements.supersedeShortApplicationDiarizationJobs.run({
            sessionId: safeSessionId,
            trackId: track.id,
            at: safeAt,
          });
          skipped.push({ trackId: track.id, reason: "speaker_audio_too_short" });
          continue;
        }
        const inputHash = buildDiarizationJobKey({
          sessionId: safeSessionId,
          trackId: track.id,
          evidenceRevision: snapshot.evidenceRevision,
          policyId: policy.policyId,
        });
        const identity = {
          sessionId: safeSessionId,
          trackId: track.id,
          inputHash,
          inputVersion: policy.inputVersion,
          modelVersion: policy.policyId,
        };
        this.statements.supersedePriorDiarizationJobs.run({
          ...identity,
          at: safeAt,
        });
        const result = this.statements.insertDiarizationJob.run({
          id: derivedId("job_diarize", inputHash),
          ...identity,
          priority: DIARIZATION_PRIORITY[track.track_kind] ?? DIARIZATION_PRIORITY.application,
          createdAt: safeAt,
        });
        enqueued += result.changes;
        const job = this.statements.getDiarizationJobByIdentity.get(identity);
        if (!job) throw new Error("diarization job insert was not durable");
        jobs.push(job);
      }
    });
    if (this.db.inTransaction) enqueue();
    else enqueue.immediate();
    return { enqueued, jobs, skipped };
  }

  listHistoricalHybridCandidates({ at = Date.now(), policy, limit = 25 } = {}) {
    const safeAt = assertNonNegativeInteger(at, "at");
    if (!policy || policy.inputVersion !== 2 || typeof policy.policyId !== "string") {
      throw new TypeError("the v2 hybrid diarization policy is required");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("historical hybrid candidate limit must be between 1 and 100");
    }
    return this.statements.listHistoricalHybridCandidates.all({
      at: safeAt,
      policyId: policy.policyId,
      limit,
    });
  }

  enqueueHistoricalHybridReprocessing(
    sessionId,
    { at = Date.now(), policy, speakerProcessingPolicy } = {}
  ) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "at");
    if (!policy || policy.inputVersion !== 2 || typeof policy.policyId !== "string") {
      throw new TypeError("the v2 hybrid diarization policy is required");
    }
    const operation = this.db.transaction(() => {
      const semanticBaselines = computeSessionSemanticHashes(this.db, safeSessionId);
      this.statements.upsertHistoricalReprocessingState.run({
        sessionId: safeSessionId,
        policyId: policy.policyId,
        at: safeAt,
        ...semanticBaselines,
      });
      const result = this.enqueueDiarizationJobs(safeSessionId, {
        at: safeAt,
        policy,
        speakerProcessingPolicy,
      });
      if (result.enqueued > 0) {
        this.statements.markSessionProcessing.run(safeSessionId);
      }
      return result;
    });
    return operation.immediate();
  }

  isHistoricalLocalOnlyReprocessing(sessionId) {
    const row = this.statements.getSessionReprocessingState.get(assertId(sessionId, "sessionId"));
    return Boolean(
      row &&
      row.mode === "historical_local_only" &&
      new Set(["queued", "processing"]).has(row.state)
    );
  }

  startHistoricalLocalOnlyReprocessing(sessionId, at = Date.now()) {
    const safeSessionId = assertId(sessionId, "sessionId");
    assertNonNegativeInteger(at, "at");
    const current = this.statements.getSessionReprocessingState.get(safeSessionId);
    if (!current || current.mode !== "historical_local_only") {
      throw new Error("historical local-only reprocessing state is unavailable");
    }
    if (current.state === "completed") return current;
    this.statements.startHistoricalReprocessingState.run({
      sessionId: safeSessionId,
    });
    return this.statements.getSessionReprocessingState.get(safeSessionId) ?? null;
  }

  finalizeHistoricalLocalOnlyReprocessing(sessionId, at = Date.now()) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAt = assertNonNegativeInteger(at, "at");
    const finalize = this.db.transaction(() => {
      const current = this.statements.getSessionReprocessingState.get(safeSessionId);
      if (!current || current.mode !== "historical_local_only") {
        throw new Error("historical local-only reprocessing state is unavailable");
      }
      if (current.state === "completed") return current;
      if (current.state !== "processing") {
        throw new Error("historical local-only reprocessing has not started");
      }
      const latest = computeSessionSemanticHashes(this.db, safeSessionId);
      const reason =
        latest.contentSha256 !== current.baseline_content_sha256
          ? "transcript_changed"
          : latest.identitySha256 !== current.baseline_identity_sha256
            ? "speaker_identity_changed"
            : latest.classificationSha256 !== current.baseline_classification_sha256
              ? "activity_classification_changed"
              : null;
      const hasSummary =
        this.statements.sessionHasRetainedSummary.get(safeSessionId, safeSessionId)?.value === 1;
      if (hasSummary) {
        const priorRefresh = this.db
          .prepare("SELECT basis_policy_id FROM session_summary_refresh_state WHERE session_id = ?")
          .get(safeSessionId);
        this.statements.replaceSummaryRefreshState.run({
          sessionId: safeSessionId,
          basisPolicyId: priorRefresh?.basis_policy_id ?? null,
          latestPolicyId: current.policy_id,
          recommended: reason === null ? 0 : 1,
          reason,
          at: safeAt,
        });
      }
      this.statements.completeHistoricalReprocessingState.run({
        sessionId: safeSessionId,
        at: safeAt,
      });
      return this.statements.getSessionReprocessingState.get(safeSessionId);
    });
    return finalize.immediate();
  }

  getSpeakerIdentityResolutionSnapshot({
    sessionId,
    at = Date.now(),
    policy = SPEAKER_IDENTITY_RESOLUTION_POLICY,
    diarizationPolicy = SESSION_DIARIZATION_POLICY,
  } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    assertNonNegativeInteger(at, "at");
    assertExactIdentityResolutionPolicy(policy);
    const session = this.statements.getSession.get(safeSessionId);
    if (!session || !TERMINAL_SESSION_STATUSES.has(session.status)) {
      return { eligible: false, reason: "session_not_terminal" };
    }
    this.refreshLogicalApplicationTracks(safeSessionId, at);
    const candidateTracks = this.statements.listSessionIdentityTracks.all(safeSessionId);
    const chunks = this.statements.listSessionReadinessChunks.all(safeSessionId);
    const completedApplicationTrackIds = new Set(
      this.statements.listSessionIdentityResolutionTracks
        .all(safeSessionId)
        .filter((track) => track.track_kind === "application")
        .map((track) => track.id)
    );
    const { preferred, qualifiedApplicationTrackIds } = preferredSpeakerEvidenceTracks(
      candidateTracks,
      chunks,
      { completedApplicationTrackIds }
    );
    const tracks = preferred.filter(
      (track) =>
        track.track_kind !== "application" ||
        qualifiedApplicationTrackIds.has(track.id) ||
        completedApplicationTrackIds.has(track.id)
    );
    if (tracks.length === 0) return { eligible: false, reason: "no_tracks" };
    const evidenceRuns = [];
    const clusters = [];
    for (const track of tracks) {
      const primaryTrack = new Set(["mic", "application", "system_mix"]).has(track.track_kind);
      const run = this.statements.getLatestIdentityDiarizationRun.get({
        sessionId: safeSessionId,
        trackId: track.id,
        policyId: diarizationPolicy.policyId,
        modelId: policy.modelId,
      });
      if (!run) {
        if (primaryTrack) return { eligible: false, reason: "diarization_incomplete" };
        continue;
      }
      const inputHash = buildDiarizationJobKey({
        sessionId: safeSessionId,
        trackId: track.id,
        evidenceRevision: run.transcript_revision,
        policyId: diarizationPolicy.policyId,
      });
      const job = this.statements.getIdentityDiarizationJobByIdentity.get({
        sessionId: safeSessionId,
        trackId: track.id,
        inputHash,
        inputVersion: diarizationPolicy.inputVersion,
        modelVersion: diarizationPolicy.policyId,
      });
      if (!job || job.state !== "completed") {
        if (primaryTrack) return { eligible: false, reason: "diarization_incomplete" };
        continue;
      }
      const unfinished = this.statements.listIdentityDiarizationJobs
        .all({ sessionId: safeSessionId, trackId: track.id })
        .some(
          (candidate) =>
            candidate.job_sequence > job.job_sequence && candidate.state !== "completed"
        );
      if (unfinished && primaryTrack) {
        return { eligible: false, reason: "diarization_incomplete" };
      }
      if (run.embedding_model_id !== policy.modelId) {
        if (primaryTrack) return { eligible: false, reason: "diarization_model_mismatch" };
        continue;
      }
      const runClusters = this.statements.listIdentityResolutionRunClusters.all(run.id);
      evidenceRuns.push({
        id: run.id,
        trackId: track.id,
        evidenceRevision: run.transcript_revision,
        policyId: run.policy_id,
        embeddingModelId: run.embedding_model_id,
        modelArtifactSha256: run.model_artifact_sha256,
        clusters: runClusters.map((cluster) => ({
          clusterId: cluster.cluster_id,
          embeddingSha256:
            cluster.embedding === null
              ? null
              : crypto.createHash("sha256").update(cluster.embedding).digest("hex"),
          speechMs: cluster.speech_ms,
          windowCount: cluster.window_count,
          qualityScore: cluster.quality_score,
        })),
      });
      for (const cluster of runClusters) {
        let embedding = null;
        try {
          embedding =
            cluster.embedding === null
              ? null
              : this.speakerIdentityRepository.decodeStoredEmbedding(cluster.embedding, 512);
        } catch {
          embedding = null;
        }
        clusters.push({
          evidenceRunId: run.id,
          clusterId: cluster.cluster_id,
          trackId: track.id,
          trackKind:
            track.source_type === "mic"
              ? "mic"
              : track.application_key
                ? "application"
                : "system_mix",
          applicationKey: track.application_key ?? null,
          applicationDisplayName: track.application_display_name ?? null,
          captureGeneration: track.capture_generation ?? 0,
          modelId: run.embedding_model_id,
          embedding,
          speechMs: cluster.speech_ms,
          windowCount: cluster.window_count,
          qualityScore: cluster.quality_score,
        });
      }
    }
    if (evidenceRuns.length === 0) {
      return { eligible: false, reason: "diarization_incomplete" };
    }
    evidenceRuns.sort((left, right) => left.trackId.localeCompare(right.trackId));
    clusters.sort(
      (left, right) =>
        left.evidenceRunId.localeCompare(right.evidenceRunId) ||
        left.clusterId.localeCompare(right.clusterId)
    );
    const diarizationRevision = crypto
      .createHash("sha256")
      .update(JSON.stringify(evidenceRuns))
      .digest("hex");
    const rawProfiles = this.statements.listIdentityResolutionProfilesAll
      .all()
      .filter((sample) => IDENTITY_PROFILE_DIMENSIONS.has(sample.model_id));
    const rawAnonymousProfiles = this.statements.listAnonymousIdentityResolutionProfiles
      .all({ sessionId: safeSessionId })
      .filter((sample) => IDENTITY_PROFILE_DIMENSIONS.has(sample.model_id));
    const profileRevisionInput = [
      ...rawProfiles.map((sample) => ({
        id: sample.id,
        personId: sample.person_id,
        candidatePersonRef: sample.person_id,
        isSelf: sample.is_self === 1,
        modelId: sample.model_id,
        embeddingSha256: crypto.createHash("sha256").update(sample.embedding).digest("hex"),
        sourceClusterId: sample.source_cluster_id,
        sourceKind: sample.source_kind,
        speechMs: sample.speech_ms,
        windowCount: sample.window_count,
        createdAt: sample.created_at,
      })),
      ...rawAnonymousProfiles.map((sample) => ({
        id: `${sample.candidate_person_ref}:${sample.cluster_id}:${sample.model_id}`,
        personId: null,
        candidatePersonRef: sample.candidate_person_ref,
        isSelf: false,
        modelId: sample.model_id,
        embeddingSha256: crypto.createHash("sha256").update(sample.embedding).digest("hex"),
        sourceClusterId: sample.cluster_id,
        sourceKind: "system_anonymous",
        speechMs: sample.speech_ms,
        windowCount: sample.window_count,
        createdAt: sample.created_at,
      })),
    ];
    const profileRevision = crypto
      .createHash("sha256")
      .update(JSON.stringify(profileRevisionInput))
      .digest("hex");
    const samples = rawProfiles.map((sample) => {
      let embedding = null;
      try {
        embedding = this.speakerIdentityRepository.decodeStoredEmbedding(
          sample.embedding,
          IDENTITY_PROFILE_DIMENSIONS.get(sample.model_id)
        );
      } catch {
        embedding = null;
      }
      return {
        id: sample.id,
        personId: sample.person_id,
        candidatePersonRef: sample.person_id,
        isSelf: sample.is_self === 1,
        modelId: sample.model_id,
        sourceKind: sample.source_kind,
        speechMs: sample.speech_ms,
        windowCount: sample.window_count,
        embedding,
      };
    });
    for (const sample of rawAnonymousProfiles) {
      let embedding = null;
      try {
        embedding = this.speakerIdentityRepository.decodeStoredEmbedding(
          sample.embedding,
          IDENTITY_PROFILE_DIMENSIONS.get(sample.model_id)
        );
      } catch {
        embedding = null;
      }
      samples.push({
        id: `${sample.candidate_person_ref}:${sample.cluster_id}:${sample.model_id}`,
        personId: null,
        candidatePersonRef: sample.candidate_person_ref,
        isSelf: false,
        modelId: sample.model_id,
        sourceKind: "system_anonymous",
        speechMs: sample.speech_ms,
        windowCount: sample.window_count,
        embedding,
      });
    }
    return {
      eligible: true,
      reason: null,
      sessionId: safeSessionId,
      diarizationRevision,
      profileRevision,
      evidenceRunIds: evidenceRuns.map((run) => run.id),
      clusters,
      samples,
    };
  }

  enqueueSpeakerIdentityResolutionJob(
    sessionId,
    {
      at = Date.now(),
      policy = SPEAKER_IDENTITY_RESOLUTION_POLICY,
      diarizationPolicy = SESSION_DIARIZATION_POLICY,
    } = {}
  ) {
    const safeAt = assertNonNegativeInteger(at, "at");
    assertExactIdentityResolutionPolicy(policy);
    const snapshot = this.getSpeakerIdentityResolutionSnapshot({
      sessionId,
      at: safeAt,
      policy,
      diarizationPolicy,
    });
    if (!snapshot.eligible) return { enqueued: 0, job: null, reason: snapshot.reason };
    const inputHash = buildIdentityResolutionJobKey({
      sessionId: snapshot.sessionId,
      diarizationRevision: snapshot.diarizationRevision,
      profileRevision: snapshot.profileRevision,
      policyId: policy.id,
    });
    const values = {
      id: derivedId("job_resolve_identities", inputHash),
      sessionId: snapshot.sessionId,
      inputHash,
      policyId: policy.id,
      createdAt: safeAt,
    };
    const inserted = this.statements.insertIdentityResolutionJob.run(values).changes;
    const job = this.statements.getIdentityResolutionJob.get(values);
    if (!job) throw new Error("identity resolution job insert was not durable");
    return { enqueued: inserted, job, reason: null, snapshot };
  }

  commitDiarizationRun(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("diarization commit input is required");
    }
    if (
      typeof input.expectedRevision !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.expectedRevision)
    ) {
      throw new TypeError("expectedRevision must be a lowercase SHA-256 digest");
    }
    const validatedAt = assertNonNegativeInteger(input.validatedAt, "validatedAt");
    if (
      !input.speakerProcessingPolicy ||
      typeof input.speakerProcessingPolicy.evaluate !== "function"
    ) {
      throw new TypeError("speakerProcessingPolicy.evaluate is required");
    }
    const run = input.run;
    if (!run || typeof run !== "object" || Array.isArray(run)) {
      throw new TypeError("diarization run is required");
    }
    const normalizedRun = {
      id: assertId(run.id, "run.id"),
      sessionId: assertId(run.sessionId, "run.sessionId"),
      trackId: assertId(run.trackId, "run.trackId"),
      evidenceRevision: run.evidenceRevision,
      policyId: assertId(run.policyId, "run.policyId"),
      diarizerModelId: assertDiarizationModelId(run.diarizerModelId, "run.diarizerModelId"),
      embeddingModelId: assertDiarizationModelId(run.embeddingModelId, "run.embeddingModelId"),
      modelArtifactSha256: run.modelArtifactSha256,
      embeddingDimension: run.embeddingDimension,
      sampleRate: run.sampleRate,
      inputVersion: run.inputVersion,
      executionDevice: run.executionDevice,
      pipelineMetadataJson: normalizeDiarizationPipelineMetadata(
        run.pipelineMetadata,
        run.inputVersion
      ),
      speakerCountMin: assertSpeakerCount(run.speakerCount?.minimum, "run.speakerCount.minimum"),
      speakerCountMax: assertSpeakerCount(run.speakerCount?.maximum, "run.speakerCount.maximum"),
      speakerCountConfidence: assertOptionalUnitScore(
        run.speakerCount?.confidence,
        "run.speakerCount.confidence"
      ),
      overlapMs: assertNonNegativeInteger(run.overlapMs ?? 0, "run.overlapMs"),
      overlapSeparationState: run.overlapSeparationState ?? "not_needed",
      modelPackVersion: run.modelPackVersion ?? null,
      createdAt: assertNonNegativeInteger(run.createdAt, "run.createdAt"),
      completedAt: assertNonNegativeInteger(run.completedAt, "run.completedAt"),
    };
    if (
      normalizedRun.evidenceRevision !== input.expectedRevision ||
      !/^[0-9a-f]{64}$/.test(normalizedRun.evidenceRevision) ||
      !/^[0-9a-f]{64}$/.test(normalizedRun.modelArtifactSha256) ||
      normalizedRun.embeddingDimension !== 512 ||
      normalizedRun.sampleRate !== 16_000 ||
      !new Set([1, 2]).has(normalizedRun.inputVersion) ||
      normalizedRun.executionDevice !== (normalizedRun.inputVersion === 2 ? "cuda" : "cpu") ||
      (normalizedRun.speakerCountMin === null) !== (normalizedRun.speakerCountMax === null) ||
      (normalizedRun.speakerCountMin !== null &&
        normalizedRun.speakerCountMin > normalizedRun.speakerCountMax) ||
      !new Set(["not_needed", "completed", "partial", "failed"]).has(
        normalizedRun.overlapSeparationState
      ) ||
      (normalizedRun.modelPackVersion !== null &&
        (typeof normalizedRun.modelPackVersion !== "string" ||
          !/^[A-Za-z0-9_.-]{1,200}$/.test(normalizedRun.modelPackVersion))) ||
      (normalizedRun.inputVersion === 2 && normalizedRun.modelPackVersion === null) ||
      normalizedRun.completedAt < normalizedRun.createdAt
    ) {
      throw new TypeError("invalid diarization run metadata");
    }
    if (!Array.isArray(input.clusters) || !Array.isArray(input.turns)) {
      throw new TypeError("diarization clusters and turns must be arrays");
    }
    const voicedClusterCount = input.clusters.filter(
      (cluster) => Number.isSafeInteger(cluster?.windowCount) && cluster.windowCount > 0
    ).length;
    if (
      normalizedRun.speakerCountMax !== null &&
      voicedClusterCount > normalizedRun.speakerCountMax
    ) {
      throw new TypeError("diarization cluster count exceeds the validated speaker count");
    }
    if (input.clusters.length === 0 && input.turns.length > 0) {
      throw new TypeError("diarization turns require clusters");
    }
    const clusterLabels = new Map();
    const clusters = input.clusters.map((cluster) => {
      const id = assertId(cluster?.id, "cluster.id");
      const localLabel = assertId(cluster?.localLabel, "cluster.localLabel");
      const speechMs = assertNonNegativeInteger(cluster.speechMs, "cluster.speechMs");
      const windowCount = assertNonNegativeInteger(cluster.windowCount, "cluster.windowCount");
      const qualityScore = assertOptionalUnitScore(cluster.qualityScore, "cluster.qualityScore");
      const identityEligible = cluster.identityEligible !== false;
      const qualityGateReason = cluster.qualityGateReason ?? null;
      if (
        typeof identityEligible !== "boolean" ||
        (identityEligible && qualityGateReason !== null) ||
        (!identityEligible &&
          (typeof qualityGateReason !== "string" ||
            !qualityGateReason.trim() ||
            qualityGateReason.length > 128))
      ) {
        throw new TypeError("diarization cluster identity gate is invalid");
      }
      const embedding =
        cluster.embedding === null ? null : encodeDiarizationEmbedding(cluster.embedding);
      if (
        (windowCount === 0 && (speechMs !== 0 || embedding !== null || qualityScore !== null)) ||
        (windowCount > 0 && (embedding === null || qualityScore === null))
      ) {
        throw new TypeError("diarization cluster aggregate is inconsistent");
      }
      const normalized = {
        id,
        localLabel,
        embedding,
        speechMs,
        windowCount,
        qualityScore,
        identityEligible,
        qualityGateReason,
        firstAppearanceAt: assertNonNegativeInteger(
          cluster.firstAppearanceAt,
          "cluster.firstAppearanceAt"
        ),
      };
      if (clusterLabels.has(id) || [...clusterLabels.values()].includes(localLabel)) {
        throw new TypeError("diarization clusters must be unique");
      }
      clusterLabels.set(id, localLabel);
      return normalized;
    });
    const turnIds = new Set();
    const turns = input.turns.map((turn) => {
      const id = assertId(turn?.id, "turn.id");
      const clusterId = assertId(turn?.clusterId, "turn.clusterId");
      const localLabel = assertId(turn?.localLabel, "turn.localLabel");
      if (turnIds.has(id) || clusterLabels.get(clusterId) !== localLabel) {
        throw new TypeError("turn cluster identity is invalid");
      }
      turnIds.add(id);
      if (!new Set(["none", "possible", "confirmed"]).has(turn.echoState)) {
        throw new TypeError("invalid turn echo state");
      }
      if ((turn.echoState === "confirmed") !== (turn.excludedFromCentroid === true)) {
        throw new TypeError("confirmed echo must be excluded from the centroid exactly");
      }
      return {
        id,
        clusterId,
        chunkId: assertId(turn.chunkId, "turn.chunkId"),
        transcriptSegmentId:
          turn.transcriptSegmentId === null
            ? null
            : assertId(turn.transcriptSegmentId, "turn.transcriptSegmentId"),
        turnIndex: assertNonNegativeInteger(turn.turnIndex, "turn.turnIndex"),
        rawLabel: assertId(turn.rawLabel, "turn.rawLabel"),
        startedAt: assertNonNegativeInteger(turn.startedAt, "turn.startedAt"),
        endedAt: assertNonNegativeInteger(turn.endedAt, "turn.endedAt"),
        embedding: encodeDiarizationEmbedding(turn.embedding),
        echoState: turn.echoState,
        duplicateOfTurnId:
          turn.duplicateOfTurnId === null
            ? null
            : assertId(turn.duplicateOfTurnId, "turn.duplicateOfTurnId"),
        excludedFromCentroid: turn.excludedFromCentroid === true,
      };
    });
    const rawLinks = input.segmentLinks ?? [];
    if (!Array.isArray(rawLinks)) throw new TypeError("segmentLinks must be an array");
    const segmentLinks = rawLinks.map((link) => ({
      clusterId: assertId(link?.clusterId, "link.clusterId"),
      transcriptSegmentId: assertId(link?.transcriptSegmentId, "link.transcriptSegmentId"),
    }));
    const rawCannotLinks = input.cannotLinks ?? [];
    if (!Array.isArray(rawCannotLinks)) throw new TypeError("cannotLinks must be an array");
    const cannotLinks = rawCannotLinks.map((link) => {
      const rawLeft = assertId(link?.leftClusterId, "cannotLink.leftClusterId");
      const rawRight = assertId(link?.rightClusterId, "cannotLink.rightClusterId");
      if (rawLeft === rawRight || !clusterLabels.has(rawLeft) || !clusterLabels.has(rawRight)) {
        throw new TypeError("cannot-link clusters are invalid");
      }
      const [leftClusterId, rightClusterId] = [rawLeft, rawRight].sort();
      if (!new Set(["simultaneous_turns", "separated_overlap_stems", "user_split"]).has(link.reason)) {
        throw new TypeError("cannot-link reason is invalid");
      }
      return { leftClusterId, rightClusterId, reason: link.reason };
    });
    const rawOverlapStems = input.overlapStems ?? [];
    if (!Array.isArray(rawOverlapStems)) throw new TypeError("overlapStems must be an array");
    const overlapStems = rawOverlapStems.map((stem) => {
      const transcriptText = stem?.transcriptText ?? null;
      const confidence = assertOptionalUnitScore(stem?.confidence ?? null, "stem.confidence");
      if (
        !clusterLabels.has(stem?.clusterId) ||
        typeof stem?.path !== "string" ||
        !path.isAbsolute(stem.path) ||
        !/^[0-9a-f]{64}$/.test(stem?.fileSha256 ?? "") ||
        !/^[0-9a-f]{64}$/.test(stem?.pcmSha256 ?? "") ||
        stem?.sampleRate !== 16_000 ||
        stem?.channels !== 1 ||
        typeof stem?.rms !== "number" ||
        !Number.isFinite(stem.rms) ||
        stem.rms < 0 ||
        (transcriptText !== null &&
          (typeof transcriptText !== "string" || !transcriptText.trim())) ||
        (transcriptText === null && confidence !== null)
      ) {
        throw new TypeError("overlap stem evidence is invalid");
      }
      return {
        id: assertId(stem.id, "stem.id"),
        chunkId: assertId(stem.chunkId, "stem.chunkId"),
        clusterId: assertId(stem.clusterId, "stem.clusterId"),
        windowIndex: assertNonNegativeInteger(stem.windowIndex, "stem.windowIndex"),
        stemIndex: assertNonNegativeInteger(stem.stemIndex, "stem.stemIndex"),
        startedAt: assertNonNegativeInteger(stem.startedAt, "stem.startedAt"),
        endedAt: assertNonNegativeInteger(stem.endedAt, "stem.endedAt"),
        path: path.resolve(stem.path),
        fileSha256: stem.fileSha256,
        pcmSha256: stem.pcmSha256,
        sampleRate: stem.sampleRate,
        channels: stem.channels,
        rms: stem.rms,
        expiresAt: assertNonNegativeInteger(stem.expiresAt, "stem.expiresAt"),
        transcriptText: transcriptText?.trim() ?? null,
        confidence,
      };
    });
    return this._commitDiarizationRun({
      expectedRevision: input.expectedRevision,
      validatedAt,
      speakerProcessingPolicy: input.speakerProcessingPolicy,
      run: normalizedRun,
      clusters,
      turns,
      segmentLinks,
      cannotLinks,
      overlapStems,
    });
  }

  isSessionReadyForPostProcessing(sessionId) {
    return this._inspectSessionTranscriptReadiness(assertId(sessionId, "sessionId")).complete;
  }

  markSessionProcessing(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    this.statements.markSessionProcessing.run(safeSessionId);
    return this.getSession(safeSessionId);
  }

  refreshSessionReadiness(
    sessionId,
    at = Date.now(),
    { diarizationPolicy = SESSION_DIARIZATION_POLICY } = {}
  ) {
    return this._refreshSessionReadiness(
      assertId(sessionId, "sessionId"),
      assertInteger(at, "at"),
      diarizationPolicy
    );
  }

  reconcileHistoricalSpeakerReadiness(
    at = Date.now(),
    { diarizationPolicy = SESSION_DIARIZATION_POLICY } = {}
  ) {
    const safeAt = assertNonNegativeInteger(at, "at");
    const rows = this.statements.listHistoricalDiarizedSessionIds.all();
    const result = {
      inspected: rows.length,
      woken: 0,
      ready: 0,
      processing: 0,
    };
    for (const row of rows) {
      const before = this.statements.getSession.get(row.id);
      const after = this._refreshSessionReadiness(row.id, safeAt, diarizationPolicy);
      if (before?.processing_state === "ready" && after?.processing_state === "processing") {
        result.woken += 1;
      }
      if (after?.processing_state === "ready") result.ready += 1;
      if (after?.processing_state === "processing") result.processing += 1;
    }
    return result;
  }

  upsertTranscriptSegments(sessionId, segments) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
    this._upsertTranscriptSegments(safeSessionId, segments);
    return this.listTranscriptSegments(safeSessionId);
  }

  syncTranscriptSegments(sessionId, segments) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
    this._syncTranscriptSegments(safeSessionId, segments);
    return this.listTranscriptSegments(safeSessionId);
  }

  listTranscriptSegments(sessionId) {
    return this.statements.listSegments.all(assertId(sessionId, "sessionId"));
  }

  getVisibleTranscript(sessionId) {
    return this.listTranscriptSegments(sessionId);
  }

  listTranscriptHistory(sessionId) {
    return this.statements.listTranscriptHistory.all(assertId(sessionId, "sessionId"));
  }

  listPreviewTranscriptContext({ sessionId, trackId, from, to, limit = 16 } = {}) {
    const safeFrom = assertNonNegativeInteger(from, "from");
    const safeTo = assertNonNegativeInteger(to, "to");
    const safeLimit = assertNonNegativeInteger(limit, "limit");
    if (safeTo <= safeFrom) throw new RangeError("preview context requires from < to");
    if (safeLimit < 1 || safeLimit > 64) {
      throw new RangeError("preview context limit must be between 1 and 64");
    }
    return this.statements.listPreviewTranscriptContext.all({
      sessionId: assertId(sessionId, "sessionId"),
      trackId: assertId(trackId, "trackId"),
      from: safeFrom,
      to: safeTo,
      limit: safeLimit,
    });
  }

  listAllTranscriptSegments(sessionId) {
    return this.listTranscriptHistory(sessionId);
  }

  getTranscriptSegment(segmentId) {
    return this.statements.getTranscriptSegment.get(assertId(segmentId, "segmentId")) ?? null;
  }

  listTranscriptDedupeCandidates(sessionId) {
    return this.statements.listTranscriptDedupeCandidates.all(assertId(sessionId, "sessionId"));
  }

  reconcileTranscriptTransaction(sessionId, reconcile) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof reconcile !== "function") throw new TypeError("reconcile must be a function");
    return this._reconcileTranscript(safeSessionId, reconcile);
  }

  dedupeTranscriptTransaction(sessionId, selectDuplicates) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof selectDuplicates !== "function") {
      throw new TypeError("selectDuplicates must be a function");
    }
    return this._dedupeTranscript(safeSessionId, selectDuplicates);
  }

  getTranscriptPrompt(sessionId, trackId = null) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = trackId === null ? null : assertId(trackId, "trackId");
    const rows =
      safeTrackId === null
        ? this.statements.listTranscriptPromptSegments.all(safeSessionId)
        : this.statements.listTranscriptPromptSegmentsByTrack.all({
            sessionId: safeSessionId,
            trackId: safeTrackId,
          });
    const chronological = rows
      .reverse()
      .map((row) => sanitizeTranscriptPromptText(row.text))
      .filter(Boolean)
      .join(" ");
    const context = takeCodePointTail(chronological, TRANSCRIPT_CONTEXT_CODE_POINT_LIMIT);
    return takeCodePointTail(buildBilingualPrompt(context), TRANSCRIPT_PROMPT_CODE_POINT_LIMIT);
  }

  commitChunkTranscript({ chunk, result, modelVersion, completedAt }) {
    if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
    assertId(chunk.id, "audioChunkId");
    if (!result || typeof result !== "object") throw new TypeError("result is required");
    if (result.noSpeech !== true) {
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new TypeError("transcript text is required");
      }
      if (result.words !== undefined && !Array.isArray(result.words)) {
        throw new TypeError("transcript words must be an array when provided");
      }
      if (
        typeof result.confidence !== "number" ||
        !Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 1
      ) {
        throw new RangeError("transcript confidence must be between zero and one");
      }
    }
    if (typeof modelVersion !== "string" || !modelVersion.trim() || modelVersion.length > 128) {
      throw new TypeError("modelVersion must be a non-empty string of at most 128 characters");
    }
    assertInteger(completedAt, "completedAt");
    return this._commitChunkTranscript({
      chunk,
      result:
        result.noSpeech === true
          ? { noSpeech: true }
          : {
              text: result.text.trim(),
              confidence: result.confidence,
              words: result.words ?? [],
            },
      modelVersion: modelVersion.trim(),
      completedAt,
    });
  }

  listTranscriptWords(sessionId) {
    return this.statements.listSessionTranscriptWords.all(assertId(sessionId, "sessionId"));
  }

  listTranscriptWordsForSegment(segmentId) {
    return this.statements.listTranscriptWordsBySegment.all(
      assertId(segmentId, "transcriptSegmentId")
    );
  }

  renamePerson(input) {
    if (!input || typeof input !== "object") throw new TypeError("person update is required");
    const safePersonId = assertId(input.personId, "personId");
    const existing = this.statements.getPerson.get(safePersonId) ?? null;
    const hasDisplayName = Object.prototype.hasOwnProperty.call(input, "displayName");
    const hasIsSelf = Object.prototype.hasOwnProperty.call(input, "isSelf");
    const hasVoiceProfileId = Object.prototype.hasOwnProperty.call(input, "voiceProfileId");

    const displayName = hasDisplayName ? normalizeSpeakerName(input.displayName) : null;
    if (!hasDisplayName && !existing) {
      throw new TypeError("displayName is required when creating a person");
    }
    if (hasIsSelf && typeof input.isSelf !== "boolean") {
      throw new TypeError("isSelf must be a boolean");
    }
    if (
      hasVoiceProfileId &&
      input.voiceProfileId !== null &&
      !Number.isSafeInteger(input.voiceProfileId)
    ) {
      throw new TypeError("voiceProfileId must be a safe integer or null");
    }

    const update = {
      personId: safePersonId,
      displayName: hasDisplayName ? displayName : existing.display_name,
      isSelf: hasIsSelf ? (input.isSelf ? 1 : 0) : (existing?.is_self ?? 0),
      voiceProfileId: hasVoiceProfileId
        ? (input.voiceProfileId ?? null)
        : (existing?.voice_profile_id ?? null),
      now: Date.now(),
    };
    let wakeModelIds = [];
    if (hasIsSelf) {
      const selfActuallyChanges = input.isSelf
        ? existing?.is_self !== 1 ||
          this.statements.countOtherSelfPeople.get(safePersonId).count > 0
        : existing?.is_self === 1;
      if (selfActuallyChanges) {
        const models = new Set(
          this.statements.listPersonProfileModels.all(safePersonId).map((row) => row.model_id)
        );
        if (input.isSelf) {
          for (const row of this.statements.listSelfProfileModels.all()) models.add(row.model_id);
        }
        wakeModelIds = [...models].sort();
      }
    }
    this._renamePerson({ ...update, wakeModelIds });
    return this.statements.getPerson.get(safePersonId);
  }

  listPeople() {
    return this.statements.listPeople.all();
  }

  applyAnalysisResult(input) {
    if (!input || typeof input !== "object") throw new TypeError("analysis input is required");
    const safe = {
      runId: assertId(input.runId, "analysisRunId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      kind: input.kind,
      inputHash: normalizeDerivedText(input.inputHash, "inputHash"),
      model: normalizeDerivedText(input.model, "model"),
      windowStart: assertInteger(input.windowStart, "windowStart"),
      windowEnd: assertInteger(input.windowEnd, "windowEnd"),
      completedAt: assertInteger(input.completedAt, "completedAt"),
      result: input.result,
    };
    if (safe.kind !== "incremental" && safe.kind !== "final") {
      throw new TypeError("analysis kind must be incremental or final");
    }
    if (!safe.result || typeof safe.result !== "object" || Array.isArray(safe.result)) {
      throw new TypeError("analysis result is required");
    }
    const summary = normalizeDerivedText(safe.result.summary, "summary");
    const arrays = {};
    for (const key of ["topics", "todos", "memories", "decisions", "suggestions"]) {
      if (!Array.isArray(safe.result[key])) throw new TypeError(`${key} must be an array`);
      if (safe.result[key].length > 100) throw new RangeError(`${key} has too many items`);
      arrays[key] = safe.result[key];
    }

    const transaction = this.db.transaction(() => {
      if (!this.getSession(safe.sessionId)) throw new Error("analysis session does not exist");
      const existingRun = this.db
        .prepare("SELECT * FROM analysis_runs WHERE session_id = ? AND kind = ? AND input_hash = ?")
        .get(safe.sessionId, safe.kind, safe.inputHash);
      if (existingRun?.status === "completed") {
        this.memoryRepository.importLegacyAnalysis();
        return this.getSessionDetail(safe.sessionId);
      }

      const allowedSegments = new Set(
        this.listTranscriptSegments(safe.sessionId).map((segment) => segment.id)
      );
      const evidenceFor = (item) => {
        if (!Array.isArray(item.evidenceSegmentIds) || item.evidenceSegmentIds.length === 0) {
          throw new TypeError("analysis item requires evidence segment ids");
        }
        const ids = item.evidenceSegmentIds.map((id) => assertId(id, "evidenceSegmentId"));
        for (const id of ids) {
          if (!allowedSegments.has(id)) throw new Error(`evidence segment ${id} is not in session`);
        }
        return [...new Set(ids)];
      };

      for (const topic of arrays.topics) {
        normalizeDerivedText(topic.title, "topic title");
        normalizeDerivedText(topic.description, "topic description");
        evidenceFor(topic);
      }
      for (const todo of arrays.todos) {
        normalizeDerivedText(todo.content, "todo content");
        evidenceFor(todo);
      }
      for (const memory of arrays.memories) {
        if (!["fact", "decision", "commitment", "opinion"].includes(memory.type)) {
          throw new TypeError("unsupported memory type");
        }
        normalizeDerivedText(memory.content, "memory content");
        if (
          typeof memory.confidence !== "number" ||
          !Number.isFinite(memory.confidence) ||
          memory.confidence < 0 ||
          memory.confidence > 1
        ) {
          throw new RangeError("memory confidence must be between 0 and 1");
        }
        evidenceFor(memory);
      }

      this.db
        .prepare(
          `
        INSERT INTO analysis_runs (
          id, session_id, kind, window_start, window_end, input_hash, model,
          status, attempt_count, response_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?)
        ON CONFLICT(session_id, kind, input_hash) DO UPDATE SET
          status = 'completed', response_json = excluded.response_json,
          completed_at = excluded.completed_at, error_code = NULL
      `
        )
        .run(
          safe.runId,
          safe.sessionId,
          safe.kind,
          safe.windowStart,
          safe.windowEnd,
          safe.inputHash,
          safe.model,
          JSON.stringify(safe.result),
          safe.completedAt,
          safe.completedAt
        );

      const persistedRun = this.db
        .prepare(
          "SELECT id FROM analysis_runs WHERE session_id = ? AND kind = ? AND input_hash = ?"
        )
        .get(safe.sessionId, safe.kind, safe.inputHash);
      const runId = persistedRun.id;

      this.db
        .prepare(
          `
        INSERT INTO session_summaries (
          session_id, summary, decisions_json, suggestions_json,
          analysis_run_id, updated_at, is_final
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary = excluded.summary,
          decisions_json = excluded.decisions_json,
          suggestions_json = excluded.suggestions_json,
          analysis_run_id = excluded.analysis_run_id,
          updated_at = excluded.updated_at,
          is_final = MAX(session_summaries.is_final, excluded.is_final)
      `
        )
        .run(
          safe.sessionId,
          summary,
          JSON.stringify(arrays.decisions),
          JSON.stringify(arrays.suggestions),
          runId,
          safe.completedAt,
          safe.kind === "final" ? 1 : 0
        );

      const topicIds = new Map();
      for (const topic of arrays.topics) {
        const title = normalizeDerivedText(topic.title, "topic title");
        const key = normalizedKey(title);
        const id = derivedId("topic", key);
        this.db
          .prepare(
            `
          INSERT INTO topics (
            id, canonical_title, normalized_title, description, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(normalized_title) DO UPDATE SET
            description = excluded.description, last_seen_at = excluded.last_seen_at
        `
          )
          .run(
            id,
            title,
            key,
            normalizeDerivedText(topic.description, "topic description"),
            safe.completedAt,
            safe.completedAt
          );
        const persistedTopic = this.db
          .prepare("SELECT id FROM topics WHERE normalized_title = ?")
          .get(key);
        topicIds.set(key, persistedTopic.id);
        this.db
          .prepare(
            `
          INSERT INTO session_topics (session_id, topic_id, analysis_run_id)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id, topic_id) DO UPDATE SET analysis_run_id = excluded.analysis_run_id
        `
          )
          .run(safe.sessionId, persistedTopic.id, runId);
      }

      const resolveTopicId = (title) => {
        if (typeof title !== "string" || !title.trim()) return null;
        const key = normalizedKey(title);
        if (topicIds.has(key)) return topicIds.get(key);
        return (
          this.db.prepare("SELECT id FROM topics WHERE normalized_title = ?").get(key)?.id ?? null
        );
      };
      const resolvePersonId = (personRef) => {
        if (typeof personRef !== "string" || !personRef) return null;
        return this.statements.getPerson.get(personRef)?.id ?? null;
      };

      for (const todo of arrays.todos) {
        const content = normalizeDerivedText(todo.content, "todo content");
        const ownerId = resolvePersonId(todo.ownerRef);
        const topicId = resolveTopicId(todo.topicRef);
        const evidence = evidenceFor(todo);
        let dueAt = null;
        if (todo.dueDate !== null && todo.dueDate !== undefined && todo.dueDate !== "") {
          if (typeof todo.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(todo.dueDate)) {
            throw new TypeError("todo dueDate must be YYYY-MM-DD or null");
          }
          dueAt = Date.parse(`${todo.dueDate}T00:00:00.000Z`);
          if (!Number.isSafeInteger(dueAt)) throw new TypeError("todo dueDate is invalid");
        }
        const key = normalizedKey(content);
        const id = derivedId("todo", safe.sessionId, key, ownerId ?? "", topicId ?? "");
        this.db
          .prepare(
            `
          INSERT INTO todos (
            id, content, normalized_content, owner_person_id, topic_id, due_at,
            created_at, updated_at, source_session_id, source_segment_id, analysis_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content, due_at = COALESCE(excluded.due_at, todos.due_at),
            updated_at = excluded.updated_at, analysis_run_id = excluded.analysis_run_id
        `
          )
          .run(
            id,
            content,
            key,
            ownerId,
            topicId,
            dueAt,
            safe.completedAt,
            safe.completedAt,
            safe.sessionId,
            evidence[0],
            runId
          );
      }

      for (const memory of arrays.memories) {
        const content = normalizeDerivedText(memory.content, "memory content");
        const personId = resolvePersonId(memory.personRef);
        const topicId = resolveTopicId(memory.topicRef);
        const key = normalizedKey(content);
        const id = derivedId("memory", memory.type, key, personId ?? "", topicId ?? "");
        this.db
          .prepare(
            `
          INSERT INTO memories (
            id, type, content, normalized_content, person_id, topic_id, confidence,
            first_seen_at, last_seen_at, needs_confirmation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence = MAX(memories.confidence, excluded.confidence),
            last_seen_at = excluded.last_seen_at,
            occurrence_count = memories.occurrence_count + 1,
            needs_confirmation = MIN(memories.needs_confirmation, excluded.needs_confirmation)
        `
          )
          .run(
            id,
            memory.type,
            content,
            key,
            personId,
            topicId,
            memory.confidence,
            safe.completedAt,
            safe.completedAt,
            memory.confidence < 0.7 ? 1 : 0
          );
        for (const segmentId of evidenceFor(memory)) {
          this.db
            .prepare(
              `
            INSERT OR IGNORE INTO memory_evidence (memory_id, segment_id, analysis_run_id)
            VALUES (?, ?, ?)
          `
            )
            .run(id, segmentId, runId);
        }
      }
      this.memoryRepository.importLegacyAnalysis();
      return this.getSessionDetail(safe.sessionId);
    });
    return transaction.immediate();
  }

  getSessionDetail(id, { includeAudioChunks = true } = {}) {
    const sessionId = assertId(id, "sessionId");
    if (typeof includeAudioChunks !== "boolean") {
      throw new TypeError("includeAudioChunks must be a boolean");
    }
    const session = this.getSession(sessionId);
    if (!session) return null;
    const legacySummary = this.db
      .prepare("SELECT * FROM session_summaries WHERE session_id = ?")
      .get(sessionId);
    const summary =
      legacySummary ??
      projectSessionSummaryRevision(
        this.db
          .prepare(
            `SELECT content_json, completeness, created_at
             FROM session_summary_revisions
             WHERE session_id = ? AND lifecycle = 'active'
             ORDER BY revision DESC LIMIT 1`
          )
          .get(sessionId),
        sessionId
      );
    return {
      session,
      summary,
      segments: this.listTranscriptSegments(sessionId),
      speakerUtterances: this.statements.listSessionSpeakerUtterances.all(sessionId),
      audioChunks: includeAudioChunks ? this.listAudioChunks(sessionId) : [],
      topics: this.db
        .prepare(
          `
        SELECT t.* FROM topics t JOIN session_topics st ON st.topic_id = t.id
        WHERE st.session_id = ? ORDER BY t.last_seen_at DESC, t.canonical_title
      `
        )
        .all(sessionId),
      todos: this.db
        .prepare(
          `
        SELECT td.*, p.display_name AS owner_name, t.canonical_title AS topic_title
        FROM todos td LEFT JOIN people p ON p.id = td.owner_person_id
        LEFT JOIN topics t ON t.id = td.topic_id
        WHERE td.source_session_id = ? ORDER BY td.updated_at DESC
      `
        )
        .all(sessionId),
      memories: this.db
        .prepare(
          `
        SELECT DISTINCT m.*, p.display_name AS person_name, t.canonical_title AS topic_title
        FROM memories m JOIN memory_evidence me ON me.memory_id = m.id
        JOIN transcript_segments ts ON ts.id = me.segment_id
        LEFT JOIN people p ON p.id = m.person_id LEFT JOIN topics t ON t.id = m.topic_id
        WHERE ts.session_id = ? ORDER BY m.last_seen_at DESC
      `
        )
        .all(sessionId),
      speakerProcessing: this.getSessionSpeakerProcessing(sessionId),
    };
  }

  getSpeakerUtteranceAudioEvidence(utteranceId) {
    return (
      this.statements.getSpeakerUtteranceAudioEvidence.get(
        assertId(utteranceId, "speakerUtteranceId")
      ) ?? null
    );
  }

  listPeopleOverview() {
    return this.db
      .prepare(
        `
      SELECT p.*,
        COUNT(DISTINCT ts.session_id) AS session_count,
        COUNT(DISTINCT CASE WHEN td.status = 'open' THEN td.id END) AS open_todo_count,
        MAX(ts.ended_at) AS last_interaction_at
      FROM people p
      LEFT JOIN transcript_segments ts ON ts.person_id = p.id
      LEFT JOIN todos td ON td.owner_person_id = p.id
      LEFT JOIN speaker_identity_review_overrides forgotten
        ON forgotten.person_id = p.id AND forgotten.state = 'forgotten'
      WHERE forgotten.person_id IS NULL
      GROUP BY p.id
      ORDER BY p.is_self DESC, COALESCE(last_interaction_at, p.last_seen_at) DESC, p.display_name
    `
      )
      .all();
  }

  listPeopleReviewOverview() {
    const rows = this.db
      .prepare(
        `
      WITH ranked_resolution AS (
        SELECT resolution.cluster_id, resolution.candidate_person_ref, resolution.reason,
          ROW_NUMBER() OVER (
            PARTITION BY resolution.cluster_id
            ORDER BY run.commit_sequence DESC, resolution.rowid DESC
          ) AS rank
        FROM speaker_identity_resolutions AS resolution
        JOIN speaker_identity_resolution_runs AS run
          ON run.id = resolution.resolution_run_id
        WHERE resolution.actor = 'system'
          AND resolution.projection_applied = 1
      )
      SELECT sc.id, sc.session_id, sc.track_id, sc.speech_ms, sc.window_count,
        sc.quality_score, sc.updated_at, s.started_at AS session_started_at,
        track.source_type, track.application_key, track.application_display_name,
        resolution.candidate_person_ref, resolution.reason
      FROM speaker_clusters sc
      JOIN sessions s ON s.id = sc.session_id
      LEFT JOIN audio_tracks track ON track.id = sc.track_id
      LEFT JOIN ranked_resolution AS resolution
        ON resolution.cluster_id = sc.id AND resolution.rank = 1
      WHERE sc.person_id IS NULL
        AND sc.link_state = 'unknown'
        AND (sc.speech_ms >= 5000 OR sc.window_count >= 3)
      ORDER BY sc.updated_at DESC, sc.id
      LIMIT 500
    `
      )
      .all();
    const applicationPolicy = new ApplicationAudioPolicy();
    const candidates = rows
      .map((row) => {
        const applicationClass = applicationPolicy.classify(row.application_key);
        const socialSource = row.source_type === "mic" || applicationClass === "communication";
        if (!socialSource) return null;
        return {
          row,
          sourceName:
            row.application_display_name ||
            (row.source_type === "mic" ? "麦克风" : "系统音频·应用未知"),
        };
      })
      .filter(Boolean);

    const candidateByClusterId = new Map(
      candidates.map((candidate) => [candidate.row.id, candidate])
    );
    const sessionIds = [...new Set(candidates.map((candidate) => candidate.row.session_id))];
    const anonymousGroups = new Map();
    const needsReview = [];
    for (const sessionId of sessionIds) {
      let projection;
      try {
        projection = this.getSessionSpeakerProcessing(sessionId).participants;
      } catch {
        continue;
      }
      if (projection.excluded.anomaly) continue;
      for (const participant of projection.participants) {
        const members = participant.clusterIds
          .map((clusterId) => candidateByClusterId.get(clusterId))
          .filter(Boolean);
        if (members.length === 0) continue;
        const lastSeenAt = Math.max(...members.map((member) => member.row.updated_at));
        const sourceNames = [...new Set(members.map((member) => member.sourceName))];
        if (participant.kind === "anonymous" || participant.kind === "reviewed") {
          const group = anonymousGroups.get(participant.id) ?? [];
          group.push({
            participant,
            sessionId,
            sessionStartedAt: members[0].row.session_started_at,
            lastSeenAt,
            sourceNames,
          });
          anonymousGroups.set(participant.id, group);
          continue;
        }
        if (participant.kind !== "temporary") continue;
        needsReview.push({
          id: derivedId("session-review", sessionId, participant.id),
          sessionId,
          sessionStartedAt: members[0].row.session_started_at,
          minimumCount: participant.minimumCount,
          maximumCount: participant.maximumCount,
          clusterCount: participant.clusterCount,
          speechMs: participant.speechMs,
          sourceNames,
          representativeCluster: participant.representativeCluster,
        });
      }
    }

    const anonymous = [...anonymousGroups.entries()]
      .map(([id, members]) => {
        const representative = [...members].sort(
          (left, right) =>
            right.participant.speechMs - left.participant.speechMs ||
            right.lastSeenAt - left.lastSeenAt
        )[0];
        return {
          id,
          displayName: "",
          sessionCount: new Set(members.map((member) => member.sessionId)).size,
          clusterCount: members.reduce(
            (total, member) => total + member.participant.clusterCount,
            0
          ),
          speechMs: members.reduce((total, member) => total + member.participant.speechMs, 0),
          lastSeenAt: Math.max(...members.map((member) => member.lastSeenAt)),
          sourceNames: [...new Set(members.flatMap((member) => member.sourceNames))],
          representativeCluster: representative.participant.representativeCluster,
        };
      })
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id))
      .map((entry, index) => ({
        ...entry,
        displayName: `未命名人物 ${index + 1}`,
      }));

    needsReview.sort(
      (left, right) =>
        right.sessionStartedAt - left.sessionStartedAt || left.id.localeCompare(right.id)
    );

    return { anonymous, needsReview: needsReview.slice(0, 50) };
  }

  previewParticipantReview(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("participant review input is required");
    }
    const sessionId = assertId(input.sessionId, "sessionId");
    const action = input.action;
    if (
      !new Set([
        "split",
        "merge",
        "mark_media",
        "restore_social",
        "forget_identity",
        "pin_evidence",
        "unpin_evidence",
      ]).has(action)
    ) {
      throw new TypeError("unsupported participant review action");
    }
    const clusterIds = Array.isArray(input.clusterIds)
      ? [...new Set(input.clusterIds.map((id) => assertId(id, "clusterId")))]
      : [];
    const segmentIds = Array.isArray(input.segmentIds)
      ? [...new Set(input.segmentIds.map((id) => assertId(id, "transcriptSegmentId")))]
      : [];
    if (clusterIds.length > 64)
      throw new RangeError("participant review affects too many clusters");
    if (segmentIds.length > 64)
      throw new RangeError("participant review affects too many segments");
    if (action === "merge" && (clusterIds.length < 2 || segmentIds.length > 0)) {
      throw new TypeError("merge requires at least two clusters");
    }
    if (action === "split" && (clusterIds.length !== 1 || segmentIds.length === 0)) {
      throw new TypeError("split requires one cluster and selected segments");
    }
    if (new Set(["mark_media", "restore_social"]).has(action) && clusterIds.length === 0) {
      throw new TypeError(`${action} requires selected clusters`);
    }
    if (new Set(["pin_evidence", "unpin_evidence"]).has(action) && segmentIds.length !== 1) {
      throw new TypeError(`${action} requires one evidence segment`);
    }
    if (
      action === "pin_evidence" &&
      input.label !== undefined &&
      (typeof input.label !== "string" ||
        !input.label.trim() ||
        Array.from(input.label.trim()).length > 200)
    ) {
      throw new TypeError("evidence label must contain 1 to 200 characters");
    }

    if (action === "forget_identity") {
      const personId = assertId(input.personId, "personId");
      const person = this.db.prepare("SELECT id, is_self FROM people WHERE id = ?").get(personId);
      if (!person) throw new Error("participant identity does not exist");
      if (person.is_self === 1) throw new Error("SELF identity cannot be forgotten");
      const impactedClusters = this.db
        .prepare(
          `SELECT id, session_id FROM speaker_clusters
           WHERE person_id = ? ORDER BY session_id, id`
        )
        .all(personId);
      const impactedSegments = this.db
        .prepare(
          `SELECT id, session_id FROM transcript_segments
           WHERE person_id = ? ORDER BY session_id, id`
        )
        .all(personId);
      const affectedSessionIds = [
        ...new Set([
          ...impactedClusters.map((row) => row.session_id),
          ...impactedSegments.map((row) => row.session_id),
        ]),
      ].sort();
      return {
        sessionId,
        action,
        clusterIds: impactedClusters.map((row) => row.id),
        segmentIds: impactedSegments.map((row) => row.id),
        affectedClusterCount: impactedClusters.length,
        affectedSegmentCount: impactedSegments.length,
        affectedPersonIds: [personId],
        affectedSessionIds,
        historyImpact: {
          sessionCount: affectedSessionIds.length,
          clusterCount: impactedClusters.length,
          segmentCount: impactedSegments.length,
          sessionIds: affectedSessionIds,
        },
        canUndo: true,
      };
    }

    const clusterPlaceholders = clusterIds.map(() => "?").join(",");
    const clusters =
      clusterIds.length === 0
        ? []
        : this.db
            .prepare(
              `SELECT id, session_id, person_id, link_state, speech_ms, window_count
               FROM speaker_clusters
               WHERE id IN (${clusterPlaceholders}) ORDER BY id`
            )
            .all(...clusterIds);
    if (
      clusters.length !== clusterIds.length ||
      clusters.some((cluster) => cluster.session_id !== sessionId)
    ) {
      throw new Error("participant review clusters must belong to the selected session");
    }
    const segmentPlaceholders = segmentIds.map(() => "?").join(",");
    const segmentLinks =
      segmentIds.length === 0
        ? []
        : this.db
            .prepare(
              `SELECT segment.id, segment.session_id, link.cluster_id
               FROM transcript_segments AS segment
               JOIN speaker_cluster_segments AS link
                 ON link.transcript_segment_id = segment.id
               WHERE segment.id IN (${segmentPlaceholders})
               ORDER BY segment.id, link.cluster_id`
            )
            .all(...segmentIds);
    for (const segmentId of segmentIds) {
      const links = segmentLinks.filter((row) => row.id === segmentId);
      if (
        links.length === 0 ||
        links.some((row) => row.session_id !== sessionId) ||
        (clusterIds.length > 0 && !links.some((row) => clusterIds.includes(row.cluster_id)))
      ) {
        throw new Error("participant review segments must belong to selected clusters");
      }
    }
    const resolvedClusterIds =
      clusterIds.length > 0 ? clusterIds : [...new Set(segmentLinks.map((row) => row.cluster_id))];
    const resolvedClusters =
      clusters.length > 0
        ? clusters
        : this.db
            .prepare(
              `SELECT id, session_id, person_id, link_state, speech_ms, window_count
               FROM speaker_clusters
               WHERE id IN (${resolvedClusterIds.map(() => "?").join(",")})
               ORDER BY id`
            )
            .all(...resolvedClusterIds);
    const segmentCount =
      segmentIds.length > 0
        ? segmentIds.length
        : this.db
            .prepare(
              `SELECT count(DISTINCT transcript_segment_id) AS count
               FROM speaker_cluster_segments
               WHERE cluster_id IN (${clusterPlaceholders})`
            )
            .get(...clusterIds).count;
    return {
      sessionId,
      action,
      clusterIds: resolvedClusterIds,
      segmentIds,
      affectedClusterCount: resolvedClusters.length,
      affectedSegmentCount: segmentCount,
      affectedPersonIds: [
        ...new Set(resolvedClusters.map((cluster) => cluster.person_id).filter(Boolean)),
      ],
      affectedSessionIds: [sessionId],
      canUndo: true,
    };
  }

  applyParticipantReview(input) {
    const preview = this.previewParticipantReview(input);
    const at = assertNonNegativeInteger(
      input.at ?? this.memoryDependencies.now(),
      "participantReviewAt"
    );
    const eventId = this.memoryDependencies.createId("participant-review");
    const clusterPlaceholders = preview.clusterIds.map(() => "?").join(",");
    const segmentPlaceholders = preview.segmentIds.map(() => "?").join(",");
    const groupRef = new Set(["merge", "split"]).has(preview.action)
      ? `manual-group-${crypto
          .createHash("sha256")
          .update(`${eventId}\0${preview.clusterIds.join("\0")}\0${preview.segmentIds.join("\0")}`)
          .digest("hex")
          .slice(0, 32)}`
      : null;
    let previousState;
    let nextState;
    if (new Set(["merge", "mark_media", "restore_social"]).has(preview.action)) {
      const previousRows = this.db
        .prepare(
          `SELECT cluster_id, group_ref, disposition
           FROM speaker_cluster_review_overrides
           WHERE cluster_id IN (${clusterPlaceholders}) ORDER BY cluster_id`
        )
        .all(...preview.clusterIds);
      const nextRows = preview.clusterIds.map((clusterId) => ({
        clusterId,
        groupRef,
        disposition: preview.action === "mark_media" ? "media" : "social",
      }));
      previousState = {
        overrides: previousRows.map((row) => ({
          clusterId: row.cluster_id,
          groupRef: row.group_ref,
          disposition: row.disposition,
        })),
      };
      nextState = { overrides: nextRows };
    } else if (preview.action === "split") {
      const previousRows = this.db
        .prepare(
          `SELECT transcript_segment_id, cluster_id, group_ref, disposition
           FROM speaker_segment_review_overrides
           WHERE transcript_segment_id IN (${segmentPlaceholders})
           ORDER BY transcript_segment_id`
        )
        .all(...preview.segmentIds);
      previousState = {
        segmentOverrides: previousRows.map((row) => ({
          segmentId: row.transcript_segment_id,
          clusterId: row.cluster_id,
          groupRef: row.group_ref,
          disposition: row.disposition,
        })),
      };
      nextState = {
        segmentOverrides: preview.segmentIds.map((segmentId) => ({
          segmentId,
          clusterId: preview.clusterIds[0],
          groupRef,
          disposition: "social",
        })),
      };
    } else if (new Set(["pin_evidence", "unpin_evidence"]).has(preview.action)) {
      const previousRows = this.db
        .prepare(
          `SELECT transcript_segment_id, cluster_id, session_id, label
           FROM pinned_speaker_evidence
           WHERE transcript_segment_id IN (${segmentPlaceholders})
           ORDER BY transcript_segment_id`
        )
        .all(...preview.segmentIds);
      previousState = {
        pinnedEvidence: previousRows.map((row) => ({
          segmentId: row.transcript_segment_id,
          clusterId: row.cluster_id,
          sessionId: row.session_id,
          label: row.label,
        })),
      };
      nextState = {
        pinnedEvidence:
          preview.action === "pin_evidence"
            ? [
                {
                  segmentId: preview.segmentIds[0],
                  clusterId: preview.clusterIds[0],
                  sessionId: preview.sessionId,
                  label: typeof input.label === "string" ? input.label.trim() : null,
                },
              ]
            : [],
      };
    } else {
      const personId = assertId(input.personId, "personId");
      const identityOverride =
        this.db
          .prepare(
            `SELECT person_id, state FROM speaker_identity_review_overrides
             WHERE person_id = ?`
          )
          .get(personId) ?? null;
      const clusters = this.db
        .prepare(
          `SELECT id, session_id, person_id, link_state
           FROM speaker_clusters WHERE person_id = ? ORDER BY session_id, id`
        )
        .all(personId);
      const segments = this.db
        .prepare(
          `SELECT id, session_id, person_id, speaker_label
           FROM transcript_segments WHERE person_id = ? ORDER BY session_id, id`
        )
        .all(personId);
      previousState = {
        identityOverride: identityOverride
          ? { personId: identityOverride.person_id, state: identityOverride.state }
          : null,
        clusters: clusters.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          personId: row.person_id,
          linkState: row.link_state,
        })),
        segments: segments.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          personId: row.person_id,
          speakerLabel: row.speaker_label,
        })),
      };
      nextState = {
        identityOverride: { personId, state: "forgotten" },
        clusters: clusters.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          personId: null,
          linkState: "unknown",
        })),
        segments: segments.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          personId: null,
          speakerLabel: row.speaker_label,
        })),
      };
    }
    const subjectRef =
      input.personId ??
      preview.segmentIds[0] ??
      (preview.clusterIds.join(",").length <= 256
        ? preview.clusterIds.join(",")
        : derivedId("participant-review-subject", ...preview.clusterIds));
    const event = {
      id: eventId,
      sessionId: preview.sessionId,
      action: preview.action,
      subjectRef,
      payloadJson: JSON.stringify({
        clusterIds: preview.clusterIds,
        segmentIds: preview.segmentIds,
        personId: input.personId ?? null,
        groupRef,
      }),
      previousStateJson: JSON.stringify(previousState),
      nextStateJson: JSON.stringify(nextState),
      actor: "user",
      createdAt: at,
    };
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO participant_review_events (
            id, session_id, action, subject_ref, payload_json,
            previous_state_json, next_state_json, reverts_event_id, actor, created_at
          ) VALUES (
            @id, @sessionId, @action, @subjectRef, @payloadJson,
            @previousStateJson, @nextStateJson, NULL, @actor, @createdAt
          )`
        )
        .run(event);
      if (Array.isArray(nextState.overrides)) {
        const upsert = this.db.prepare(
          `INSERT INTO speaker_cluster_review_overrides (
            cluster_id, session_id, group_ref, disposition, source_event_id, updated_at
          ) VALUES (@clusterId, @sessionId, @groupRef, @disposition, @eventId, @updatedAt)
          ON CONFLICT(cluster_id) DO UPDATE SET
            session_id = excluded.session_id,
            group_ref = excluded.group_ref,
            disposition = excluded.disposition,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`
        );
        for (const row of nextState.overrides) {
          upsert.run({
            ...row,
            sessionId: preview.sessionId,
            eventId,
            updatedAt: at,
          });
        }
      } else if (Array.isArray(nextState.segmentOverrides)) {
        const upsert = this.db.prepare(
          `INSERT INTO speaker_segment_review_overrides (
            transcript_segment_id, cluster_id, session_id, group_ref,
            disposition, source_event_id, updated_at
          ) VALUES (
            @segmentId, @clusterId, @sessionId, @groupRef,
            @disposition, @eventId, @updatedAt
          )
          ON CONFLICT(transcript_segment_id) DO UPDATE SET
            cluster_id = excluded.cluster_id,
            session_id = excluded.session_id,
            group_ref = excluded.group_ref,
            disposition = excluded.disposition,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`
        );
        for (const row of nextState.segmentOverrides) {
          upsert.run({
            ...row,
            sessionId: preview.sessionId,
            eventId,
            updatedAt: at,
          });
        }
      } else if (Array.isArray(nextState.pinnedEvidence)) {
        if (preview.segmentIds.length > 0) {
          this.db
            .prepare(
              `DELETE FROM pinned_speaker_evidence
               WHERE transcript_segment_id IN (${segmentPlaceholders})`
            )
            .run(...preview.segmentIds);
        }
        const insert = this.db.prepare(
          `INSERT INTO pinned_speaker_evidence (
            transcript_segment_id, cluster_id, session_id, label,
            source_event_id, pinned_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const row of nextState.pinnedEvidence) {
          insert.run(row.segmentId, row.clusterId, row.sessionId, row.label, eventId, at);
        }
      } else if (nextState.identityOverride) {
        const personId = nextState.identityOverride.personId;
        this.db
          .prepare(
            `INSERT INTO speaker_identity_review_overrides (
              person_id, state, source_event_id, updated_at
            ) VALUES (?, 'forgotten', ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET
              state = 'forgotten',
              source_event_id = excluded.source_event_id,
              updated_at = excluded.updated_at`
          )
          .run(personId, eventId, at);
        this.db
          .prepare(
            `UPDATE speaker_clusters
             SET person_id = NULL, link_state = 'unknown', updated_at = ?
             WHERE person_id = ?`
          )
          .run(at, personId);
        this.db
          .prepare(
            `UPDATE transcript_segments
             SET person_id = NULL
             WHERE person_id = ?`
          )
          .run(personId);
      }
      return event;
    });
    const applied = apply.immediate();
    for (const affectedSessionId of preview.affectedSessionIds) {
      try {
        this.refreshSessionParticipantSnapshot(affectedSessionId, { at });
      } catch {
        // The durable review event remains authoritative. A later reconciliation can rematerialize.
      }
    }
    return {
      event: {
        id: applied.id,
        sessionId: applied.sessionId,
        action: applied.action,
        createdAt: applied.createdAt,
        canUndo: true,
      },
      preview,
      speakerProcessing: this.getSessionSpeakerProcessing(preview.sessionId),
    };
  }

  undoParticipantReview(eventId, at = this.memoryDependencies.now()) {
    const safeEventId = assertId(eventId, "participantReviewEventId");
    const safeAt = assertNonNegativeInteger(at, "participantReviewUndoAt");
    const original = this.db
      .prepare("SELECT * FROM participant_review_events WHERE id = ?")
      .get(safeEventId);
    if (!original || original.action === "undo") {
      throw new Error("participant review event is not undoable");
    }
    const existingUndo = this.db
      .prepare("SELECT id FROM participant_review_events WHERE reverts_event_id = ?")
      .get(safeEventId);
    if (existingUndo) throw new Error("participant review event was already undone");
    let previousState;
    let nextState;
    try {
      previousState = JSON.parse(original.previous_state_json);
      nextState = JSON.parse(original.next_state_json);
    } catch {
      throw new Error("participant review event state is invalid");
    }
    const undoId = this.memoryDependencies.createId("participant-review-undo");
    const undo = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO participant_review_events (
            id, session_id, action, subject_ref, payload_json,
            previous_state_json, next_state_json, reverts_event_id, actor, created_at
          ) VALUES (?, ?, 'undo', ?, ?, ?, ?, ?, 'user', ?)`
        )
        .run(
          undoId,
          original.session_id,
          original.subject_ref,
          JSON.stringify({ revertedEventId: safeEventId }),
          JSON.stringify(nextState),
          JSON.stringify(previousState),
          safeEventId,
          safeAt
        );
      if (Array.isArray(nextState?.overrides)) {
        const clusterIds = nextState.overrides.map((row) => assertId(row.clusterId, "clusterId"));
        const placeholders = clusterIds.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM speaker_cluster_review_overrides
             WHERE cluster_id IN (${placeholders})`
          )
          .run(...clusterIds);
        const restore = this.db.prepare(
          `INSERT INTO speaker_cluster_review_overrides (
            cluster_id, session_id, group_ref, disposition, source_event_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const row of previousState.overrides ?? []) {
          restore.run(
            assertId(row.clusterId, "clusterId"),
            original.session_id,
            row.groupRef ?? null,
            row.disposition,
            undoId,
            safeAt
          );
        }
      } else if (Array.isArray(nextState?.segmentOverrides)) {
        const segmentIds = nextState.segmentOverrides.map((row) =>
          assertId(row.segmentId, "transcriptSegmentId")
        );
        if (segmentIds.length > 0) {
          this.db
            .prepare(
              `DELETE FROM speaker_segment_review_overrides
               WHERE transcript_segment_id IN (${segmentIds.map(() => "?").join(",")})`
            )
            .run(...segmentIds);
        }
        const restore = this.db.prepare(
          `INSERT INTO speaker_segment_review_overrides (
            transcript_segment_id, cluster_id, session_id, group_ref,
            disposition, source_event_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const row of previousState.segmentOverrides ?? []) {
          restore.run(
            row.segmentId,
            row.clusterId,
            original.session_id,
            row.groupRef,
            row.disposition,
            undoId,
            safeAt
          );
        }
      } else if (Array.isArray(nextState?.pinnedEvidence)) {
        const segmentIds = new Set([
          ...(nextState.pinnedEvidence ?? []).map((row) => row.segmentId),
          ...(previousState.pinnedEvidence ?? []).map((row) => row.segmentId),
        ]);
        if (segmentIds.size > 0) {
          this.db
            .prepare(
              `DELETE FROM pinned_speaker_evidence
               WHERE transcript_segment_id IN (${[...segmentIds].map(() => "?").join(",")})`
            )
            .run(...segmentIds);
        }
        const restore = this.db.prepare(
          `INSERT INTO pinned_speaker_evidence (
            transcript_segment_id, cluster_id, session_id, label,
            source_event_id, pinned_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const row of previousState.pinnedEvidence ?? []) {
          restore.run(row.segmentId, row.clusterId, row.sessionId, row.label, undoId, safeAt);
        }
      } else if (nextState?.identityOverride) {
        const personId = assertId(nextState.identityOverride.personId, "personId");
        this.db
          .prepare("DELETE FROM speaker_identity_review_overrides WHERE person_id = ?")
          .run(personId);
        if (previousState.identityOverride) {
          this.db
            .prepare(
              `INSERT INTO speaker_identity_review_overrides (
                person_id, state, source_event_id, updated_at
              ) VALUES (?, ?, ?, ?)`
            )
            .run(personId, previousState.identityOverride.state, undoId, safeAt);
        }
        const restoreCluster = this.db.prepare(
          `UPDATE speaker_clusters
           SET person_id = ?, link_state = ?, updated_at = ?
           WHERE id = ?`
        );
        for (const row of previousState.clusters ?? []) {
          restoreCluster.run(row.personId, row.linkState, safeAt, row.id);
        }
        const restoreSegment = this.db.prepare(
          `UPDATE transcript_segments
           SET person_id = ?, speaker_label = ?
           WHERE id = ?`
        );
        for (const row of previousState.segments ?? []) {
          restoreSegment.run(row.personId, row.speakerLabel, row.id);
        }
      }
      return {
        id: undoId,
        sessionId: original.session_id,
        action: "undo",
        createdAt: safeAt,
        canUndo: false,
      };
    });
    const affectedSessionIds = [
      ...new Set(
        original.action === "forget_identity"
          ? [
              ...(previousState.clusters ?? []).map((row) => row.sessionId),
              ...(previousState.segments ?? []).map((row) => row.sessionId),
            ]
          : [original.session_id]
      ),
    ];
    const event = undo.immediate();
    for (const affectedSessionId of affectedSessionIds) {
      try {
        this.refreshSessionParticipantSnapshot(affectedSessionId, { at: safeAt });
      } catch {
        // Keep undo durable even when a derived snapshot needs later reconciliation.
      }
    }
    return {
      event,
      speakerProcessing: this.getSessionSpeakerProcessing(original.session_id),
    };
  }

  listParticipantReviewHistory(sessionId) {
    return this.db
      .prepare(
        `SELECT id, session_id, action, subject_ref, payload_json,
          reverts_event_id, actor, created_at
         FROM participant_review_events
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`
      )
      .all(assertId(sessionId, "sessionId"))
      .map((row) => {
        const state = this.db
          .prepare(
            `SELECT previous_state_json, next_state_json
             FROM participant_review_events WHERE id = ?`
          )
          .get(row.id);
        return {
          id: row.id,
          sessionId: row.session_id,
          action: row.action,
          subjectRef: row.subject_ref,
          payload: JSON.parse(row.payload_json),
          previousState: JSON.parse(state.previous_state_json),
          nextState: JSON.parse(state.next_state_json),
          revertsEventId: row.reverts_event_id,
          actor: row.actor,
          createdAt: row.created_at,
          canUndo:
            row.action !== "undo" &&
            !this.db
              .prepare("SELECT 1 FROM participant_review_events WHERE reverts_event_id = ? LIMIT 1")
              .get(row.id),
        };
      });
  }

  getPersonDetail(id) {
    const personId = assertId(id, "personId");
    const person = this.db
      .prepare(
        `SELECT person.* FROM people AS person
         LEFT JOIN speaker_identity_review_overrides AS forgotten
           ON forgotten.person_id = person.id AND forgotten.state = 'forgotten'
         WHERE person.id = ? AND forgotten.person_id IS NULL`
      )
      .get(personId);
    if (!person) return null;
    return {
      person,
      sessions: this.db
        .prepare(
          `
        SELECT DISTINCT s.* FROM sessions s JOIN transcript_segments ts ON ts.session_id = s.id
        WHERE ts.person_id = ? ORDER BY s.started_at DESC
      `
        )
        .all(personId),
      todos: this.db
        .prepare("SELECT * FROM todos WHERE owner_person_id = ? ORDER BY updated_at DESC")
        .all(personId),
      memories: this.db
        .prepare("SELECT * FROM memories WHERE person_id = ? ORDER BY last_seen_at DESC")
        .all(personId),
      topics: this.db
        .prepare(
          `
        SELECT DISTINCT t.* FROM topics t JOIN session_topics st ON st.topic_id = t.id
        JOIN transcript_segments ts ON ts.session_id = st.session_id
        WHERE ts.person_id = ? ORDER BY t.last_seen_at DESC
      `
        )
        .all(personId),
      identity: this.speakerIdentityRepository.getPersonIdentityDetail(personId),
    };
  }

  listTopics() {
    return this.db
      .prepare(
        `
      SELECT t.*, COUNT(DISTINCT st.session_id) AS session_count,
        COUNT(DISTINCT CASE WHEN td.status = 'open' THEN td.id END) AS open_todo_count
      FROM topics t LEFT JOIN session_topics st ON st.topic_id = t.id
      LEFT JOIN todos td ON td.topic_id = t.id
      GROUP BY t.id ORDER BY t.last_seen_at DESC, t.canonical_title
    `
      )
      .all();
  }

  getTopicDetail(id) {
    const topicId = assertId(id, "topicId");
    const topic = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
    if (!topic) return null;
    const decisionRows = this.db
      .prepare(
        `SELECT summary.session_id, summary.decisions_json
         FROM session_summaries AS summary
         JOIN session_topics AS link ON link.session_id = summary.session_id
         JOIN sessions AS capture_session ON capture_session.id = summary.session_id
         WHERE link.topic_id = ?
         ORDER BY capture_session.started_at DESC, summary.updated_at DESC, summary.session_id`
      )
      .all(topicId);
    return {
      topic,
      people: this.db
        .prepare(
          `SELECT person.*
           FROM people AS person
           WHERE NOT EXISTS (
             SELECT 1 FROM speaker_identity_review_overrides AS forgotten
             WHERE forgotten.person_id = person.id AND forgotten.state = 'forgotten'
           )
           AND (
             EXISTS (
               SELECT 1
               FROM session_topics AS link
               JOIN transcript_segments AS segment ON segment.session_id = link.session_id
               WHERE link.topic_id = ? AND segment.person_id = person.id
             )
             OR EXISTS (
               SELECT 1 FROM todos AS todo
               WHERE todo.topic_id = ? AND todo.owner_person_id = person.id
             )
             OR EXISTS (
               SELECT 1 FROM memories AS memory
               WHERE memory.topic_id = ? AND memory.person_id = person.id
             )
           )
           ORDER BY person.is_self DESC, person.last_seen_at DESC,
             person.display_name, person.id`
        )
        .all(topicId, topicId, topicId),
      sessions: this.db
        .prepare(
          `SELECT s.* FROM sessions s JOIN session_topics st ON st.session_id=s.id WHERE st.topic_id=? ORDER BY s.started_at DESC`
        )
        .all(topicId),
      decisions: parseTopicDecisions(decisionRows),
      todos: this.db
        .prepare(
          `SELECT todo.*, person.display_name AS owner_name,
             topic.canonical_title AS topic_title
           FROM todos AS todo
           LEFT JOIN people AS person ON person.id = todo.owner_person_id
           LEFT JOIN topics AS topic ON topic.id = todo.topic_id
           WHERE todo.topic_id = ?
           ORDER BY todo.updated_at DESC, todo.id`
        )
        .all(topicId),
      memories: this.db
        .prepare(
          `SELECT memory.*, person.display_name AS person_name,
             topic.canonical_title AS topic_title
           FROM memories AS memory
           LEFT JOIN people AS person ON person.id = memory.person_id
           LEFT JOIN topics AS topic ON topic.id = memory.topic_id
           WHERE memory.topic_id = ?
           ORDER BY memory.last_seen_at DESC, memory.id`
        )
        .all(topicId),
    };
  }

  renameTopic(id, title, at = Date.now()) {
    const topicId = assertId(id, "topicId");
    const canonical = normalizeDerivedText(title, "topic title");
    this.db
      .prepare(`UPDATE topics SET canonical_title=?, normalized_title=?, last_seen_at=? WHERE id=?`)
      .run(canonical, normalizedKey(canonical), assertInteger(at, "at"), topicId);
    return this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) ?? null;
  }

  listTodos(status = null) {
    if (status !== null && status !== "open" && status !== "completed")
      throw new TypeError("invalid todo status");
    return this.db
      .prepare(
        `
      SELECT td.*, p.display_name AS owner_name, t.canonical_title AS topic_title
      FROM todos td LEFT JOIN people p ON p.id=td.owner_person_id
      LEFT JOIN topics t ON t.id=td.topic_id
      WHERE (? IS NULL OR td.status = ?)
      ORDER BY CASE td.status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(td.due_at, 9223372036854775807), td.updated_at DESC
    `
      )
      .all(status, status);
  }

  setTodoStatus(id, status, at = Date.now()) {
    const todoId = assertId(id, "todoId");
    if (status !== "open" && status !== "completed") throw new TypeError("invalid todo status");
    const when = assertInteger(at, "at");
    this.db
      .prepare(`UPDATE todos SET status=?, updated_at=?, completed_at=? WHERE id=?`)
      .run(status, when, status === "completed" ? when : null, todoId);
    return this.db.prepare("SELECT * FROM todos WHERE id = ?").get(todoId) ?? null;
  }

  listMemories(limit = 200) {
    assertInteger(limit, "limit");
    return this.db
      .prepare(
        `
      SELECT m.*, p.display_name AS person_name, t.canonical_title AS topic_title
      FROM memories m LEFT JOIN people p ON p.id=m.person_id LEFT JOIN topics t ON t.id=m.topic_id
      ORDER BY m.last_seen_at DESC LIMIT ?
    `
      )
      .all(limit);
  }

  searchMemory(query, limit = 100) {
    const term = normalizeDerivedText(query, "query");
    assertInteger(limit, "limit");
    if (limit < 1 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db
      .prepare(
        `
      SELECT DISTINCT s.* FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id=s.id
      WHERE ss.summary LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM session_summary_revisions sr
          WHERE sr.session_id = s.id
            AND sr.lifecycle = 'active'
            AND (
              json_extract(sr.content_json, '$.title') LIKE ? ESCAPE '\\'
              OR json_extract(sr.content_json, '$.summary') LIKE ? ESCAPE '\\'
            )
        )
        OR EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.session_id=s.id AND ts.text LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM session_topics st JOIN topics t ON t.id=st.topic_id WHERE st.session_id=s.id AND (t.canonical_title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM transcript_segments ts JOIN people p ON p.id=ts.person_id WHERE ts.session_id=s.id AND p.display_name LIKE ? ESCAPE '\\')
      ORDER BY s.started_at DESC LIMIT ?
    `
      )
      .all(like, like, like, like, like, like, like, limit);
  }

  getTodayInsights(sessionId) {
    const detail = this.getSessionDetail(sessionId);
    if (!detail) return null;
    return {
      summary: detail.summary,
      topics: detail.topics,
      todos: detail.todos,
      memories: detail.memories,
    };
  }

  getCloudBudgetSettings() {
    return this.statements.getCloudBudgetSettings.get();
  }

  setCloudBudgetSettings({ enabled, monthlyLimitMicrousd, at = Date.now() }) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    assertInteger(monthlyLimitMicrousd, "monthlyLimitMicrousd");
    if (
      monthlyLimitMicrousd < MIN_CLOUD_LIMIT_MICROUSD ||
      monthlyLimitMicrousd > MAX_CLOUD_LIMIT_MICROUSD
    ) {
      throw new RangeError("monthlyLimitMicrousd must be between 5000000 and 10000000");
    }
    assertInteger(at, "at");
    this.statements.setCloudBudgetSettings.run({
      enabled: enabled ? 1 : 0,
      monthlyLimitMicrousd,
      at,
    });
    return this.getCloudBudgetSettings();
  }

  getCloudBudgetStatus(at = Date.now()) {
    const monthUtc = monthUtcFromTimestamp(at);
    const settings = this.getCloudBudgetSettings();
    const totals = this.statements.getCloudUsageTotals.get(monthUtc);
    const remaining = Math.max(0, settings.monthly_limit_microusd - totals.spent - totals.reserved);
    let blockedReason = null;
    if (totals.unknown_count > 0) blockedReason = "usage_unknown";
    else if (!settings.enabled) blockedReason = "cloud_disabled";
    else if (remaining < CLOUD_RESERVATION_MICROUSD) blockedReason = "budget_protected";
    return {
      monthUtc,
      enabled: settings.enabled === 1,
      monthlyLimitMicrousd: settings.monthly_limit_microusd,
      spentMicrousd: totals.spent,
      reservedMicrousd: totals.reserved,
      remainingMicrousd: remaining,
      blockedReason,
    };
  }

  reserveCloudUsage(input) {
    const safe = {
      id: assertId(input.id, "cloudUsageId"),
      monthUtc: assertMonthUtc(input.monthUtc),
      model: input.model,
      audioMs: assertNonNegativeInteger(input.audioMs, "audioMs"),
      reservedMicrousd: assertNonNegativeInteger(input.reservedMicrousd, "reservedMicrousd"),
      priceVersion: input.priceVersion,
      createdAt: assertInteger(input.createdAt, "createdAt"),
    };
    if (typeof safe.model !== "string" || !safe.model) throw new TypeError("model is required");
    if (typeof safe.priceVersion !== "string" || !safe.priceVersion) {
      throw new TypeError("priceVersion is required");
    }
    return this._reserveCloudUsage(safe);
  }

  settleCloudUsage({ id, inputTokens, outputTokens, actualMicrousd, settledAt = Date.now() }) {
    const safe = {
      id: assertId(id, "cloudUsageId"),
      inputTokens: assertNonNegativeInteger(inputTokens, "inputTokens"),
      outputTokens: assertNonNegativeInteger(outputTokens, "outputTokens"),
      actualMicrousd: assertNonNegativeInteger(actualMicrousd, "actualMicrousd"),
      settledAt: assertInteger(settledAt, "settledAt"),
    };
    if (safe.actualMicrousd > CLOUD_RESERVATION_MICROUSD) {
      throw new RangeError("actualMicrousd exceeds the reserved request maximum");
    }
    this.statements.settleCloudUsage.run(safe);
    return this.statements.getCloudUsage.get(safe.id) ?? null;
  }

  releaseCloudUsage({ id, settledAt = Date.now() }) {
    const safeId = assertId(id, "cloudUsageId");
    this.statements.releaseCloudUsage.run({
      id: safeId,
      settledAt: assertInteger(settledAt, "settledAt"),
    });
    return this.statements.getCloudUsage.get(safeId) ?? null;
  }

  markCloudUsageUnknown({ id, settledAt = Date.now() }) {
    const safeId = assertId(id, "cloudUsageId");
    this.statements.markCloudUsageUnknown.run({
      id: safeId,
      settledAt: assertInteger(settledAt, "settledAt"),
    });
    return this.statements.getCloudUsage.get(safeId) ?? null;
  }

  addTranscriptRevision(input) {
    const safe = {
      id: assertId(input.id, "revisionId"),
      sessionId: assertId(input.sessionId, "sessionId"),
      startedAt: assertInteger(input.startedAt, "startedAt"),
      audioSource: input.source,
      originalText: input.originalText,
      currentText: input.currentText,
      confidence: input.confidence,
      reason: input.reason,
      correctedAt: assertInteger(input.correctedAt, "correctedAt"),
    };
    if (safe.audioSource !== "mic" && safe.audioSource !== "system") {
      throw new TypeError("source must be mic or system");
    }
    for (const [name, value] of [
      ["originalText", safe.originalText],
      ["currentText", safe.currentText],
      ["reason", safe.reason],
    ]) {
      if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
    }
    if (
      typeof safe.confidence !== "number" ||
      !Number.isFinite(safe.confidence) ||
      safe.confidence < 0 ||
      safe.confidence > 1
    ) {
      throw new RangeError("confidence must be between 0 and 1");
    }
    const segment = this.statements.findSegmentForRevision.get(safe);
    if (!segment) return null;
    this.statements.insertTranscriptRevision.run({
      ...safe,
      personId: segment.person_id,
      speakerLabel: segment.speaker_label,
    });
    return this.statements.getTranscriptRevision.get(safe.id);
  }

  createTrack(track) {
    return this.captureEvidenceStore.createTrack(track);
  }

  createTracks(tracks) {
    return this.captureEvidenceStore.createTracks(tracks);
  }

  createApplicationAudioInterval(interval) {
    return this.captureEvidenceStore.createApplicationAudioInterval(interval);
  }

  closeApplicationAudioInterval(id, endedAt) {
    return this.captureEvidenceStore.closeApplicationAudioInterval(id, endedAt);
  }

  listApplicationAudioIntervals(sessionId) {
    return this.captureEvidenceStore.listApplicationAudioIntervals(sessionId);
  }

  getSessionApplicationTrack(sessionId, applicationKey) {
    const safeSessionId = assertId(sessionId, "sessionId");
    if (typeof applicationKey !== "string" || !/^[a-z0-9._-]{1,64}$/.test(applicationKey)) {
      throw new TypeError("applicationKey must be a canonical lowercase identifier");
    }
    return (
      this.statements.getSessionApplicationTrack.get({
        sessionId: safeSessionId,
        applicationKey,
      }) ?? null
    );
  }

  setTrackState(id, state, endedAt, failureCode = null) {
    return this.captureEvidenceStore.setTrackState(id, state, endedAt, failureCode);
  }

  openGap(gap) {
    return this.captureEvidenceStore.openGap(gap);
  }

  recordEvidenceGap(gap) {
    return this.captureEvidenceStore.recordEvidenceGap(gap);
  }

  interruptTrack(input) {
    return this.captureEvidenceStore.interruptTrack(input);
  }

  closeGap(id, endedAt, recoveryAttempts) {
    return this.captureEvidenceStore.closeGap(id, endedAt, recoveryAttempts);
  }

  restoreTrack(input) {
    return this.captureEvidenceStore.restoreTrack(input);
  }

  pauseCapture(input) {
    return this.captureEvidenceStore.pauseCapture(input);
  }

  pauseCaptureForLowDisk(input) {
    return this.captureEvidenceStore.pauseCaptureForLowDisk(input);
  }

  suspendCaptureForPower(input) {
    return this.captureEvidenceStore.suspendCaptureForPower(input);
  }

  resumeCaptureAfterPower(input) {
    return this.captureEvidenceStore.resumeCaptureAfterPower(input);
  }

  confirmPowerRestorations(input) {
    return this.captureEvidenceStore.confirmPowerRestorations(input);
  }

  resumeCapture(input) {
    return this.captureEvidenceStore.resumeCapture(input);
  }

  finalizeCapture(input) {
    return this.captureEvidenceStore.finalizeCapture(input);
  }

  commitChunk(chunk) {
    return this.captureEvidenceStore.commitChunk(chunk);
  }

  tombstoneChunk(id, deletedAt = Date.now(), { storageDeleted = false } = {}) {
    if (typeof storageDeleted !== "boolean") throw new TypeError("storageDeleted must be boolean");
    return this.captureEvidenceStore.tombstoneChunk(
      assertId(id, "audioChunkId"),
      assertInteger(deletedAt, "deletedAt"),
      { storageDeleted }
    );
  }

  promoteSoonExpiringAudioJobs(after, before) {
    return this.captureEvidenceStore.promoteSoonExpiringAudioJobs(
      assertInteger(after, "after"),
      assertInteger(before, "before")
    );
  }

  promoteCompressionJobsForStoragePressure(at = Date.now()) {
    return this.captureEvidenceStore.promoteCompressionJobsForStoragePressure(
      assertInteger(at, "at")
    );
  }

  enqueueChunkTranscription(chunk) {
    return this.captureEvidenceStore.enqueueChunkTranscription(chunk);
  }

  enqueueCurrentModelTranscriptionJobs(input) {
    return this.captureEvidenceStore.enqueueCurrentModelTranscriptionJobs(input);
  }

  insertAudioChunk(chunk) {
    const input = {
      id: assertId(chunk.id, "audioChunkId"),
      sessionId: assertId(chunk.sessionId, "sessionId"),
      path: chunk.path,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      durationMs: chunk.durationMs,
      sha256: chunk.sha256,
      expiresAt: chunk.expiresAt,
      transcriptionStatus: chunk.transcriptionStatus ?? "pending",
    };
    this.statements.insertAudioChunk.run(input);
    return toPublicAudioChunk(this.statements.getAudioChunk.get(input.id));
  }

  listAudioChunks(sessionId) {
    return this.statements.listAudioChunks
      .all(assertId(sessionId, "sessionId"))
      .map(toPublicAudioChunk);
  }

  listUntrackedAudioChunks(sessionId) {
    return this.statements.listUntrackedAudioChunks
      .all(assertId(sessionId, "sessionId"))
      .map(toPublicAudioChunk);
  }

  backfillLegacyMicChunks({ sessionId, deterministicTrackId, chunkIds, createdAt = Date.now() }) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(deterministicTrackId, "deterministicTrackId");
    if (!Array.isArray(chunkIds)) throw new TypeError("chunkIds must be an array");
    const safeChunkIds = [...new Set(chunkIds.map((id) => assertId(id, "audioChunkId")))];
    return this._backfillLegacyMicChunks({
      sessionId: safeSessionId,
      deterministicTrackId: safeTrackId,
      chunkIds: safeChunkIds,
      createdAt: assertInteger(createdAt, "createdAt"),
    });
  }

  getAudioChunk(id) {
    const row = this.statements.getAudioChunk.get(assertId(id, "audioChunkId"));
    return row ? toPublicAudioChunk(row) : null;
  }

  listExpiredAudioChunks(now = Date.now()) {
    return this.statements.listExpiredAudioChunks
      .all(assertInteger(now, "now"))
      .map(toPublicAudioChunk);
  }

  listRetiredArtifactBacklog() {
    return this.captureEvidenceStore.listRetiredArtifactBacklog();
  }

  recoverOpenSessions(at = Date.now()) {
    return this._recoverOpenSessions(assertInteger(at, "at"));
  }

  getStorageUsageSince(since) {
    const row = this.statements.getStorageUsageSince.get(assertInteger(since, "since"));
    return {
      writtenBytes24h: row.written_bytes,
      compressedBytes24h: row.compressed_bytes,
      netGrowthBytes24h: row.net_growth_bytes,
    };
  }

  getSessionTimeline(id, page = {}) {
    const sessionId = assertId(id, "sessionId");
    const trackOffset = Number.isSafeInteger(page?.trackOffset) ? page.trackOffset : 0;
    const trackLimit = Number.isSafeInteger(page?.trackLimit) ? page.trackLimit : 100;
    const intervalOffset = Number.isSafeInteger(page?.intervalOffset) ? page.intervalOffset : 0;
    const intervalLimit = Number.isSafeInteger(page?.intervalLimit) ? page.intervalLimit : 200;
    if (
      trackOffset < 0 ||
      intervalOffset < 0 ||
      trackLimit < 1 ||
      trackLimit > 200 ||
      intervalLimit < 1 ||
      intervalLimit > 500
    ) {
      throw new RangeError("session timeline page is outside the supported bounds");
    }
    const session = this.getSession(sessionId);
    if (!session) return null;
    const gaps = this.statements.listSessionTimelineGaps.all(sessionId);
    const gapsByTrack = new Map();
    for (const gap of gaps) {
      const trackGaps = gapsByTrack.get(gap.track_id) ?? [];
      trackGaps.push(gap);
      gapsByTrack.set(gap.track_id, trackGaps);
    }
    const tracks = this.statements.listSessionTimelineTracks
      .all({ sessionId, offset: trackOffset, limit: trackLimit })
      .map((track) => ({ ...track, gaps: gapsByTrack.get(track.id) ?? [] }));
    const trackIds = new Set(tracks.map((track) => track.id));
    const intervals = this.statements.listSessionApplicationAudioIntervals.all({
      sessionId,
      offset: intervalOffset,
      limit: intervalLimit,
    });
    const applicationCapture = this.statements.summarizeSessionApplicationAudio.get(sessionId);
    const exactDurationMs = Number(applicationCapture?.exact_duration_ms ?? 0);
    const fallbackDurationMs = Number(applicationCapture?.fallback_duration_ms ?? 0);
    const captureDurationMs = exactDurationMs + fallbackDurationMs;
    return {
      session_id: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      status: session.status,
      processing_state: session.processing_state,
      timeline_version: session.timeline_version,
      finalized_at: session.finalized_at,
      ready_at: session.ready_at,
      tracks,
      application_audio_intervals: intervals,
      application_capture: {
        exact_duration_ms: exactDurationMs,
        fallback_duration_ms: fallbackDurationMs,
        exact_coverage_pct:
          captureDurationMs === 0
            ? null
            : Math.round((exactDurationMs * 10_000) / captureDurationMs) / 100,
        degraded_interval_count: Number(applicationCapture?.degraded_interval_count ?? 0),
        recovery_count: Number(
          this.statements.countSessionApplicationRecoveries.get(sessionId)?.count ?? 0
        ),
      },
      evidence_page: {
        tracks: {
          offset: trackOffset,
          limit: trackLimit,
          total: Number(this.statements.countSessionTimelineTracks.get(sessionId)?.count ?? 0),
        },
        intervals: {
          offset: intervalOffset,
          limit: intervalLimit,
          total: Number(
            this.statements.countSessionApplicationAudioIntervals.get(sessionId)?.count ?? 0
          ),
        },
      },
      gaps: gaps.filter((gap) => trackIds.has(gap.track_id)),
      chunks: this.statements.listSessionTimelineChunks.all(sessionId).map(toPublicAudioChunk),
      segments: this.listTranscriptSegments(sessionId),
      processing_counts: this.statements.getSessionProcessingCounts.get(sessionId),
    };
  }

  getSessionTimelineStatus(id) {
    const sessionId = assertId(id, "sessionId");
    const session = this.getSession(sessionId);
    if (!session) return null;
    return {
      session_id: session.id,
      status: session.status,
      processing_state: session.processing_state,
      timeline_version: session.timeline_version,
      finalized_at: session.finalized_at,
      ready_at: session.ready_at,
      processing_counts: this.statements.getSessionProcessingCounts.get(sessionId),
    };
  }

  getRuntimeProcessingStatus() {
    const totals = emptyRuntimeCounts();
    const stages = new Map();
    const deferralGroups = new Map();
    for (const row of this.statements.listRuntimeProcessingGroups.all()) {
      const count = Number(row.count);
      const state = runtimeQueueState(row.state);
      const stage = runtimeJobStage(row);
      const stageCounts = stages.get(stage) ?? emptyRuntimeCounts();
      totals[state] += count;
      totals.total += count;
      stageCounts[state] += count;
      stageCounts.total += count;
      stages.set(stage, stageCounts);

      const reason = typeof row.blocked_reason === "string" ? row.blocked_reason.trim() : "";
      if ((row.state === "retry" || row.state === "blocked") && reason) {
        const key = JSON.stringify([stage, row.job_type, row.state, reason]);
        const existing = deferralGroups.get(key);
        const nextRetryAt = row.next_retry_at === null ? null : Number(row.next_retry_at);
        if (existing) {
          existing.count += count;
          if (
            nextRetryAt !== null &&
            (existing.nextRetryAt === null || nextRetryAt < existing.nextRetryAt)
          ) {
            existing.nextRetryAt = nextRetryAt;
          }
        } else {
          deferralGroups.set(key, {
            stage,
            jobType: row.job_type,
            state: row.state,
            reason,
            count,
            nextRetryAt,
          });
        }
      }
    }
    const byStage = Object.fromEntries(
      [...stages.entries()].sort(([left], [right]) => compareStableIds(left, right))
    );
    const deferrals = [...deferralGroups.values()].sort((left, right) => {
      for (const key of ["stage", "jobType", "reason", "state"]) {
        const result = compareStableIds(left[key], right[key]);
        if (result !== 0) return result;
      }
      return 0;
    });
    const backlog = this.statements.getRuntimeTranscriptionBacklog.get();
    const oldest = this.statements.getRuntimeOldestProcessingJob.get();
    const active = this.statements.getActiveProcessingExecutionDevice.get();
    const coverage = this.statements.getRuntimeFinalCoverage.get();
    const totalMs = Number(coverage.total_ms);
    const provisionalMs = coveredDurationMs(
      this.statements.listRuntimeProvisionalCoverageRanges.all(),
      "chunk_id"
    );
    return {
      ...totals,
      byStage,
      deferrals,
      backlogMs: Number(backlog.backlog_ms),
      oldestCreatedAt: oldest.oldest_created_at ?? null,
      activeExecutionDevice: active?.execution_device ?? null,
      finalCoveragePct:
        totalMs > 0 ? Math.round((Number(coverage.final_ms) / totalMs) * 100) : null,
      provisionalCoveragePct:
        totalMs > 0 ? Math.min(100, Math.round((provisionalMs / totalMs) * 100)) : null,
    };
  }

  checkpointForMigration() {
    if (!this.db?.open) throw new Error("repository is closed");
    if (this.dbPath === ":memory:") return { busy: 0, log: 0, checkpointed: 0 };
    const result = this.db.pragma("wal_checkpoint(TRUNCATE)")[0] ?? {};
    if (Number(result.busy) !== 0) throw new Error("repository WAL checkpoint is busy");
    return result;
  }

  relocateDataRoot({ fromRecordingsRoot, toRecordingsRoot }) {
    if (
      typeof fromRecordingsRoot !== "string" ||
      !path.isAbsolute(fromRecordingsRoot) ||
      typeof toRecordingsRoot !== "string" ||
      !path.isAbsolute(toRecordingsRoot)
    ) {
      throw new TypeError("recordings roots must be absolute");
    }
    const sourceRoot = path.resolve(fromRecordingsRoot);
    const targetRoot = path.resolve(toRecordingsRoot);
    const relativeInside = (root, candidate) => {
      const relative = path.relative(root, candidate);
      return relative !== "" &&
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
        ? relative
        : null;
    };
    const relocate = (locator) => {
      if (locator === null || locator === undefined) return null;
      if (typeof locator !== "string" || !path.isAbsolute(locator)) {
        throw new Error("audio locator escapes the previous recordings root");
      }
      const canonical = path.resolve(locator);
      if (relativeInside(targetRoot, canonical) !== null) return canonical;
      const relative = relativeInside(sourceRoot, canonical);
      if (relative === null) {
        throw new Error("audio locator escapes the previous recordings root");
      }
      return path.resolve(targetRoot, relative);
    };
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, path, retired_path FROM audio_chunks").all();
      const updates = rows.map((row) => ({
        id: row.id,
        path: row.path.startsWith("tombstone:") ? row.path : relocate(row.path),
        retiredPath: relocate(row.retired_path),
      }));
      const update = this.db.prepare(
        "UPDATE audio_chunks SET path = @path, retired_path = @retiredPath WHERE id = @id"
      );
      for (const row of updates) update.run(row);
      return { relocated: updates.length };
    })();
  }

  createSpeakerCluster(input) {
    return this.speakerIdentityRepository.createCluster(input);
  }

  replaceSpeakerClusterSegments(clusterId, transcriptSegmentIds) {
    return this.speakerIdentityRepository.replaceClusterSegments(clusterId, transcriptSegmentIds);
  }

  getSpeakerCluster(clusterId) {
    return this.speakerIdentityRepository.getCluster(clusterId);
  }

  getSpeakerClusterView(clusterId) {
    return this.speakerIdentityRepository.getClusterView(clusterId);
  }

  listSessionSpeakerClusters(sessionId) {
    return this.speakerIdentityRepository.listSessionClusters(sessionId);
  }

  listSessionSpeakerClusterViews(sessionId) {
    return this.speakerIdentityRepository.listSessionClusterViews(sessionId);
  }

  listVoiceProfiles(modelId) {
    return this.speakerIdentityRepository.listProfiles(modelId);
  }

  addVoiceProfileSample(input) {
    return this.speakerIdentityRepository.addProfileSample(input);
  }

  getVoiceProfileAggregate(personId, modelId) {
    return this.speakerIdentityRepository.getProfileAggregate(personId, modelId);
  }

  replaceVoiceEnrollmentSamples(input) {
    return this.speakerIdentityRepository.replaceEnrollmentSamples(input);
  }

  replaceVoiceEnrollmentSampleSets(input) {
    return this.speakerIdentityRepository.replaceEnrollmentSampleSets(input);
  }

  importLegacyVoiceProfile(input) {
    return this.speakerIdentityRepository.importLegacyProfile(input);
  }

  hasVoiceProfileImportMarker(markerKey) {
    return this.speakerIdentityRepository.hasImportMarker(markerKey);
  }

  confirmSpeakerLink(input) {
    this.confirmSpeakerLinkWithOutcome(input);
    return this.speakerIdentityRepository.getCluster(input?.clusterId);
  }

  confirmSpeakerLinkWithOutcome(input) {
    const previous = this.speakerIdentityRepository.getCluster(input?.clusterId);
    const result = this.speakerIdentityRepository.confirmLinkWithOutcome(input);
    const cluster = this.speakerIdentityRepository.getCluster(input?.clusterId);
    if (input?.scope === "persistent" && input?.actor === "user") {
      const correction = this.speakerIdentityRepository
        .listCorrections(input.clusterId)
        .find((entry) => entry.undoneAt === null && entry.correctionKind === "link");
      if (correction) {
        try {
          this.personalizationFeedbackRepository.recordPersonCorrection({
            clusterId: input.clusterId,
            originalPersonId: previous?.personId ?? null,
            correctedPersonId: input.personId,
            action: "confirmed",
            sourceKind: this._speakerFeedbackSourceKind(previous),
            scope: "persistent",
            occurredAt: correction.createdAt,
            eventId: correction.id,
          });
        } catch {}
      }
    }
    if (cluster?.sessionId) {
      try {
        this.refreshSessionParticipantSnapshot(cluster.sessionId);
      } catch {}
    }
    return result;
  }

  runSpeakerCorrectionTransaction(work) {
    if (typeof work !== "function")
      throw new TypeError("speaker correction work must be a function");
    return this.db.transaction(work).immediate();
  }

  rejectSpeakerSuggestion(input) {
    return this._rejectSpeakerSuggestion.immediate(input);
  }

  applySystemSpeakerResolution(input) {
    return this.speakerIdentityRepository.applySystemResolution(input);
  }

  applySystemSpeakerResolutions(input) {
    const result = this.speakerIdentityRepository.applySystemResolutions(input);
    try {
      this.refreshSessionParticipantSnapshot(input.sessionId, { at: input.at });
    } catch {}
    return result;
  }

  listRejectedSpeakerPersonIds(clusterId, revision) {
    return this.speakerIdentityRepository.listRejectedPersonIds(clusterId, revision);
  }

  listSpeakerResolutionHistory(clusterId) {
    return this.speakerIdentityRepository.listResolutionHistory(clusterId);
  }

  listSpeakerResolutionModelEvidence(resolutionId) {
    return this.speakerIdentityRepository.listResolutionModelEvidence(resolutionId);
  }

  saveActivityClassificationBatch(input) {
    const result = this.activityClassificationRepository.saveBatch(input);
    try {
      this.refreshSessionParticipantSnapshot(input.sessionId, {
        at: input.createdAt,
      });
    } catch {}
    return result;
  }

  listSessionActivityClassificationHistory(sessionId) {
    return this.activityClassificationRepository.listSessionHistory(sessionId);
  }

  listSessionActivityClassifications(sessionId) {
    return this.activityClassificationRepository.listSessionEffective(sessionId);
  }

  correctActivityClassification(input) {
    const result = this.activityClassificationRepository.recordUserCorrection(input);
    const sessionId = result?.classification?.sessionId;
    try {
      this.refreshSessionParticipantSnapshot(sessionId, {
        at: input.correctedAt,
      });
    } catch (error) {
      const errorCode =
        typeof error?.code === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(error.code)
          ? error.code
          : "PARTICIPANT_SNAPSHOT_REFRESH_FAILED";
      try {
        this.memoryDependencies.log({
          phase: "activity_correction_participant_refresh",
          state: "deferred",
          sessionId,
          errorCode,
        });
      } catch {
        // The user correction is already durable; diagnostics must not reverse it.
      }
    }
    return result;
  }

  recordSuggestionDismissalFeedback(input) {
    return this.activityClassificationRepository.recordSuggestionDismissal(input);
  }

  getSuggestionPersonalizationPenalty(summary) {
    return this.activityClassificationRepository.suggestionPenalty(summary);
  }

  listPersonalizationRules() {
    return this.activityClassificationRepository.listPersonalizationRules();
  }

  decidePersonalizationRule(input) {
    return this.activityClassificationRepository.decidePersonalizationRule(input);
  }

  resetPersonalizationRules(input) {
    return this.activityClassificationRepository.resetPersonalizationRules(input);
  }

  createLearningGoal(input) {
    return this.learningGoalRepository.create(input);
  }

  listLearningGoals() {
    return this.learningGoalRepository.list();
  }

  listConfirmedLearningGoals() {
    return this.learningGoalRepository.listConfirmed();
  }

  decideLearningGoal(input) {
    return this.learningGoalRepository.decide(input);
  }

  editLearningGoal(input) {
    return this.learningGoalRepository.decide({ ...input, action: "edit" });
  }

  archiveLearningGoal(input) {
    return this.learningGoalRepository.decide({ ...input, action: "archive" });
  }

  restoreLearningGoal(input) {
    return this.learningGoalRepository.decide({ ...input, action: "restore" });
  }

  deleteLearningGoal(input) {
    return this.learningGoalRepository.decide({ ...input, action: "delete" });
  }

  getNotificationPreferences() {
    return this.activityClassificationRepository.getNotificationPreferences();
  }

  setNotificationPreferences(input) {
    return this.activityClassificationRepository.setNotificationPreferences(input);
  }

  getTodoReminder(todoId) {
    return this.todoReminderRepository.get(todoId);
  }

  setTodoReminder(input) {
    return this.todoReminderRepository.set(input);
  }

  listDueTodoReminders(at, limit) {
    return this.todoReminderRepository.listDue(at, limit);
  }

  getNextTodoReminderAt(after) {
    return this.todoReminderRepository.nextScheduledAt(after);
  }

  reconcileTodoReminders(at) {
    return this.todoReminderRepository.reconcile(at);
  }

  deferTodoReminders(items, reason, at) {
    return this.todoReminderRepository.defer(items, reason, at);
  }

  claimTodoReminderDelivery(items, at) {
    return this.todoReminderRepository.claimDelivery(items, at);
  }

  releaseTodoReminderDelivery(items, options) {
    return this.todoReminderRepository.releaseDelivery(items, options);
  }

  undoSpeakerCorrection(clusterId) {
    const cluster = this.speakerIdentityRepository.getCluster(clusterId);
    const correction = this.speakerIdentityRepository
      .listCorrections(clusterId)
      .find((entry) => entry.undoneAt === null && entry.correctionKind === "link");
    const result = this.speakerIdentityRepository.undoLastCorrection(clusterId);
    if (correction?.scope === "persistent" && correction.actor === "user") {
      const correctedPersonId = correction.nextPersonRef ?? correction.nextPersonId;
      if (correctedPersonId) {
        try {
          this.personalizationFeedbackRepository.recordPersonCorrection({
            clusterId,
            originalPersonId: correction.previousPersonRef ?? correction.previousPersonId,
            correctedPersonId,
            action: "undone",
            sourceKind: this._speakerFeedbackSourceKind(cluster),
            scope: "persistent",
            occurredAt: this.memoryDependencies.now(),
            eventState: "retracted",
            eventId: `undo:${correction.id}`,
          });
        } catch {}
      }
    }
    const restoredCluster = this.speakerIdentityRepository.getCluster(clusterId);
    if (restoredCluster?.sessionId) {
      try {
        this.refreshSessionParticipantSnapshot(restoredCluster.sessionId);
      } catch {}
    }
    return result;
  }

  mergeSpeakerPeople(input) {
    const result = this.speakerIdentityRepository.mergePeople(input);
    if ((input?.actor ?? "user") === "user") {
      try {
        this.personalizationFeedbackRepository.recordPersonMerge({
          sourcePersonId: input.sourcePersonId,
          targetPersonId: input.targetPersonId,
          occurredAt: this.memoryDependencies.now(),
          eventId: this.memoryDependencies.createId("person-feedback-merge"),
        });
      } catch {}
    }
    return result;
  }

  _speakerFeedbackSourceKind(cluster) {
    if (!cluster?.trackId) return "unknown";
    const track = this.db
      .prepare("SELECT track_kind, source_type FROM audio_tracks WHERE id = ?")
      .get(cluster.trackId);
    return track?.track_kind ?? track?.source_type ?? "unknown";
  }

  listSpeakerCorrections(clusterId) {
    return this.speakerIdentityRepository.listCorrections(clusterId);
  }

  close() {
    if (this.db.open) this.db.close();
  }
}

module.exports = JarvisRepository;
module.exports.isPublicSpeakerCluster = isPublicSpeakerCluster;
