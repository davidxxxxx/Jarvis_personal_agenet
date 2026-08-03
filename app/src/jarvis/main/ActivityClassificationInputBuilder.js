"use strict";

const crypto = require("node:crypto");
const { compileRedactionTerms } = require("./AnalysisInputBuilder");

const INPUT_CONTRACT_VERSION = "jarvis-activity-classification-input-v1";
const DEFAULT_MAX_PAYLOAD_BYTES = 96 * 1024;
const MAX_ACTIVITIES_PER_BATCH = 32;
const MAX_SEGMENTS_PER_ACTIVITY = 256;
const MAX_SOURCE_SEGMENTS_PER_ACTIVITY = 10_000;
const MAX_TRANSCRIPT_CODE_POINTS = 12_000;
const ANONYMOUS_SPEAKER_PATTERN = /^(?:SELF|P[1-9][0-9]*)$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_ATTRIBUTIONS = new Set([
  "application",
  "microphone",
  "application_and_microphone",
  "mixed_unknown",
]);

const NORMALIZED_APPLICATIONS = Object.freeze({
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  kook: "KOOK",
  discord: "Discord",
  wechat: "WeChat",
  qq: "QQ",
  telegram: "Telegram",
  teams: "Teams",
  zoom: "Zoom",
  google_meet: "Google Meet",
  webex: "Webex",
  feishu: "Feishu",
  dingtalk: "DingTalk",
  tencent_meeting: "Tencent Meeting",
  dota2: "DOTA 2",
  steam: "Steam",
  cs2: "Counter-Strike 2",
  valorant: "VALORANT",
  league_of_legends: "League of Legends",
  bilibili: "Bilibili",
  youtube: "YouTube",
  netflix: "Netflix",
  spotify: "Spotify",
  vlc: "VLC",
  potplayer: "PotPlayer",
  anki: "Anki",
  coursera: "Coursera",
  edx: "edX",
  duolingo: "Duolingo",
  obsidian: "Obsidian",
  notion: "Notion",
  vscode: "Visual Studio Code",
  visual_studio: "Visual Studio",
  intellij: "IntelliJ IDEA",
  pycharm: "PyCharm",
  powerpoint: "PowerPoint",
  word: "Word",
  excel: "Excel",
});

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
    throw new TypeError(`${name} contains unsupported fields`);
  }
  return value;
}

function identifier(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function ratio(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function speakerLabel(value, name) {
  if (typeof value !== "string" || !ANONYMOUS_SPEAKER_PATTERN.test(value)) {
    throw new TypeError(`${name} must be SELF or an anonymous P-number`);
  }
  return value;
}

function normalizeApplications(applications) {
  if (!Array.isArray(applications) || applications.length > 8) {
    throw new TypeError("applications must be an array with at most 8 normalized keys");
  }
  const seen = new Set();
  return applications.map((key) => {
    if (
      typeof key !== "string" ||
      !Object.prototype.hasOwnProperty.call(NORMALIZED_APPLICATIONS, key) ||
      seen.has(key)
    ) {
      throw new TypeError("applications contains an unsupported or duplicate key");
    }
    seen.add(key);
    return Object.freeze({ key, name: NORMALIZED_APPLICATIONS[key] });
  });
}

function validateRedactionTerms(redactionTerms) {
  const terms = redactionTerms ?? { participants: [], otherPeople: [], deviceLabels: [] };
  exactKeys(terms, ["participants", "otherPeople", "deviceLabels"], "redactionTerms");
  if (
    !Array.isArray(terms.participants) ||
    !Array.isArray(terms.otherPeople) ||
    !Array.isArray(terms.deviceLabels)
  ) {
    throw new TypeError("redactionTerms collections must be arrays");
  }
  for (const participant of terms.participants) {
    exactKeys(participant, ["label", "names"], "redaction participant");
    speakerLabel(participant.label, "redaction participant label");
    if (
      !Array.isArray(participant.names) ||
      participant.names.some((name) => typeof name !== "string" || !name.trim())
    ) {
      throw new TypeError("redaction participant names are invalid");
    }
  }
  for (const collection of [terms.otherPeople, terms.deviceLabels]) {
    if (collection.some((value) => typeof value !== "string" || !value.trim())) {
      throw new TypeError("redaction terms must be non-empty strings");
    }
  }
  return terms;
}

function normalizeStatistics(statistics, applications) {
  exactKeys(
    statistics,
    [
      "durationMs",
      "microphoneParticipated",
      "selfDetected",
      "speakerCount",
      "turnCount",
      "turnTakingScore",
      "foregroundAppKey",
    ],
    "activity statistics"
  );
  const foregroundAppKey =
    statistics.foregroundAppKey === null
      ? null
      : identifier(statistics.foregroundAppKey, "foregroundAppKey");
  const applicationKeys = new Set(applications.map((application) => application.key));
  if (foregroundAppKey !== null && !applicationKeys.has(foregroundAppKey)) {
    throw new TypeError("foregroundAppKey must identify a supplied normalized application");
  }
  return {
    durationMs: integer(statistics.durationMs, "durationMs"),
    microphoneParticipated: boolean(statistics.microphoneParticipated, "microphoneParticipated"),
    selfDetected: boolean(statistics.selfDetected, "selfDetected"),
    speakerCount: integer(statistics.speakerCount, "speakerCount", { maximum: 128 }),
    turnCount: integer(statistics.turnCount, "turnCount", { maximum: 100_000 }),
    turnTakingScore: ratio(statistics.turnTakingScore, "turnTakingScore"),
    foregroundApplication:
      foregroundAppKey === null ? null : NORMALIZED_APPLICATIONS[foregroundAppKey],
  };
}

function normalizeSegments(segments, allowedSpeakerLabels, redact) {
  if (!Array.isArray(segments) || segments.length > MAX_SOURCE_SEGMENTS_PER_ACTIVITY) {
    throw new TypeError(
      `segments must be an array with at most ${MAX_SOURCE_SEGMENTS_PER_ACTIVITY} entries`
    );
  }
  const segmentIds = new Set();
  let previousStart = -1;
  return segments.map((segment) => {
    exactKeys(
      segment,
      ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"],
      "activity segment"
    );
    const segmentId = identifier(segment.segmentId, "segmentId");
    if (segmentIds.has(segmentId)) throw new TypeError("segmentId must be unique");
    segmentIds.add(segmentId);
    const startedAt = integer(segment.startedAt, "segment startedAt");
    const endedAt = integer(segment.endedAt, "segment endedAt", { minimum: startedAt + 1 });
    if (startedAt < previousStart) throw new TypeError("segments must be time ordered");
    previousStart = startedAt;
    const label = speakerLabel(segment.speakerLabel, "segment speakerLabel");
    if (!allowedSpeakerLabels.has(label)) {
      throw new TypeError("segment speakerLabel is not declared by the activity");
    }
    if (typeof segment.text !== "string" || !segment.text.trim()) {
      throw new TypeError("segment text must be non-empty");
    }
    const text = redact(segment.text.trim());
    if (Array.from(text).length > MAX_TRANSCRIPT_CODE_POINTS) {
      throw new TypeError("segment text is too long");
    }
    return {
      segmentId,
      startedAt,
      endedAt,
      speakerLabel: label,
      text,
    };
  });
}

function representativeSegments(segments, limit) {
  if (segments.length <= limit) return segments;
  if (limit === 1) return [segments[Math.floor((segments.length - 1) / 2)]];
  const selected = [];
  let previousIndex = -1;
  for (let slot = 0; slot < limit; slot += 1) {
    const index = Math.round((slot * (segments.length - 1)) / (limit - 1));
    if (index === previousIndex) continue;
    selected.push(segments[index]);
    previousIndex = index;
  }
  return selected;
}

function boundedActivities(activities, maxPayloadBytes) {
  const payloadWithLimit = (limit) => ({
    inputVersion: INPUT_CONTRACT_VERSION,
    activities: activities.map((activity) => ({
      ...activity,
      segments: representativeSegments(
        activity.segments,
        Math.min(limit, MAX_SEGMENTS_PER_ACTIVITY)
      ),
    })),
  });
  let low = 1;
  let high = MAX_SEGMENTS_PER_ACTIVITY;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = payloadWithLimit(middle);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxPayloadBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function normalizeActivity(activity, redact) {
  exactKeys(
    activity,
    ["activityId", "applications", "sourceAttribution", "speakerLabels", "segments", "statistics"],
    "activity"
  );
  const activityId = identifier(activity.activityId, "activityId");
  if (!SOURCE_ATTRIBUTIONS.has(activity.sourceAttribution)) {
    throw new TypeError("sourceAttribution is invalid");
  }
  const applications = normalizeApplications(activity.applications);
  if (activity.sourceAttribution === "mixed_unknown" && applications.length > 0) {
    throw new TypeError("mixed_unknown sources cannot claim an application");
  }
  if (
    !Array.isArray(activity.speakerLabels) ||
    activity.speakerLabels.length > 128 ||
    activity.speakerLabels.length === 0
  ) {
    throw new TypeError("speakerLabels must be a non-empty array");
  }
  const speakerLabels = activity.speakerLabels.map((label) => speakerLabel(label, "speaker label"));
  if (new Set(speakerLabels).size !== speakerLabels.length) {
    throw new TypeError("speakerLabels must be unique");
  }
  const statistics = normalizeStatistics(activity.statistics, applications);
  if (statistics.selfDetected !== speakerLabels.includes("SELF")) {
    throw new TypeError("selfDetected must agree with the anonymous speaker labels");
  }
  if (statistics.speakerCount !== speakerLabels.length) {
    throw new TypeError("speakerCount must agree with the anonymous speaker labels");
  }
  return {
    activityId,
    applications,
    sourceAttribution: activity.sourceAttribution,
    speakerLabels,
    segments: normalizeSegments(activity.segments, new Set(speakerLabels), redact),
    statistics,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function validationContextFor(activities) {
  return {
    activityIds: activities.map((activity) => activity.activityId),
    sourceAttributionByActivity: Object.fromEntries(
      activities.map((activity) => [activity.activityId, activity.sourceAttribution])
    ),
    selfParticipationByActivity: Object.fromEntries(
      activities.map((activity) => [
        activity.activityId,
        activity.statistics.selfDetected === true ||
          activity.statistics.microphoneParticipated === true,
      ])
    ),
    segmentIdsByActivity: Object.fromEntries(
      activities.map((activity) => [
        activity.activityId,
        activity.segments.map((segment) => segment.segmentId),
      ])
    ),
  };
}

function normalizeCloudPayload(payload) {
  exactKeys(payload, ["inputVersion", "activities"], "cloud payload");
  if (
    payload.inputVersion !== INPUT_CONTRACT_VERSION ||
    !Array.isArray(payload.activities) ||
    payload.activities.length === 0 ||
    payload.activities.length > MAX_ACTIVITIES_PER_BATCH
  ) {
    throw new TypeError("cloud payload contract is invalid");
  }
  const activityIds = new Set();
  for (const activity of payload.activities) {
    exactKeys(
      activity,
      [
        "activityId",
        "applications",
        "sourceAttribution",
        "speakerLabels",
        "segments",
        "statistics",
      ],
      "cloud activity"
    );
    identifier(activity.activityId, "activityId");
    if (activityIds.has(activity.activityId)) throw new TypeError("activityId must be unique");
    activityIds.add(activity.activityId);
    if (!SOURCE_ATTRIBUTIONS.has(activity.sourceAttribution)) {
      throw new TypeError("sourceAttribution is invalid");
    }
    const applicationKeys = new Set();
    if (
      !Array.isArray(activity.applications) ||
      activity.applications.length > 8 ||
      activity.applications.some((application) => {
        try {
          exactKeys(application, ["key", "name"], "cloud application");
          if (
            NORMALIZED_APPLICATIONS[application.key] !== application.name ||
            typeof application.key !== "string" ||
            applicationKeys.has(application.key)
          ) {
            return true;
          }
          applicationKeys.add(application.key);
          return false;
        } catch {
          return true;
        }
      })
    ) {
      throw new TypeError("cloud applications are invalid");
    }
    if (activity.sourceAttribution === "mixed_unknown" && activity.applications.length > 0) {
      throw new TypeError("mixed_unknown sources cannot claim an application");
    }
    if (
      !Array.isArray(activity.speakerLabels) ||
      activity.speakerLabels.length === 0 ||
      activity.speakerLabels.some((label) => !ANONYMOUS_SPEAKER_PATTERN.test(label))
    ) {
      throw new TypeError("cloud speaker labels are invalid");
    }
    const labels = new Set(activity.speakerLabels);
    if (labels.size !== activity.speakerLabels.length) {
      throw new TypeError("cloud speaker labels must be unique");
    }
    if (!Array.isArray(activity.segments) || activity.segments.length > MAX_SEGMENTS_PER_ACTIVITY) {
      throw new TypeError("cloud activity segments are invalid");
    }
    const segmentIds = new Set();
    let previousStart = -1;
    for (const segment of activity.segments) {
      exactKeys(
        segment,
        ["segmentId", "startedAt", "endedAt", "speakerLabel", "text"],
        "cloud segment"
      );
      identifier(segment.segmentId, "segmentId");
      integer(segment.startedAt, "segment startedAt");
      integer(segment.endedAt, "segment endedAt", { minimum: segment.startedAt + 1 });
      if (
        segmentIds.has(segment.segmentId) ||
        segment.startedAt < previousStart ||
        !labels.has(segment.speakerLabel) ||
        typeof segment.text !== "string" ||
        !segment.text ||
        Array.from(segment.text).length > MAX_TRANSCRIPT_CODE_POINTS
      ) {
        throw new TypeError("cloud segment is invalid");
      }
      segmentIds.add(segment.segmentId);
      previousStart = segment.startedAt;
    }
    exactKeys(
      activity.statistics,
      [
        "durationMs",
        "microphoneParticipated",
        "selfDetected",
        "speakerCount",
        "turnCount",
        "turnTakingScore",
        "foregroundApplication",
      ],
      "cloud activity statistics"
    );
    integer(activity.statistics.durationMs, "durationMs");
    boolean(activity.statistics.microphoneParticipated, "microphoneParticipated");
    boolean(activity.statistics.selfDetected, "selfDetected");
    integer(activity.statistics.speakerCount, "speakerCount", { maximum: 128 });
    integer(activity.statistics.turnCount, "turnCount", { maximum: 100_000 });
    ratio(activity.statistics.turnTakingScore, "turnTakingScore");
    if (
      activity.statistics.selfDetected !== labels.has("SELF") ||
      activity.statistics.speakerCount !== labels.size
    ) {
      throw new TypeError("cloud speaker statistics are inconsistent");
    }
    if (
      activity.statistics.foregroundApplication !== null &&
      !activity.applications.some(
        (application) => application.name === activity.statistics.foregroundApplication
      )
    ) {
      throw new TypeError("foregroundApplication is invalid");
    }
  }
  return payload;
}

class ActivityClassificationInputBuilder {
  constructor({ maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 512) {
      throw new TypeError("maxPayloadBytes must be a safe integer of at least 512");
    }
    this.maxPayloadBytes = maxPayloadBytes;
  }

  build(input) {
    exactKeys(input, ["activities", "redactionTerms"], "classification input");
    if (
      !Array.isArray(input.activities) ||
      input.activities.length === 0 ||
      input.activities.length > MAX_ACTIVITIES_PER_BATCH
    ) {
      throw new TypeError(
        `activities must contain between 1 and ${MAX_ACTIVITIES_PER_BATCH} entries`
      );
    }
    const redactionTerms = validateRedactionTerms(input.redactionTerms);
    const redact = compileRedactionTerms(redactionTerms);
    const activities = input.activities.map((activity) => normalizeActivity(activity, redact));
    if (new Set(activities.map((activity) => activity.activityId)).size !== activities.length) {
      throw new TypeError("activityId must be unique within a batch");
    }
    const cloudPayload = boundedActivities(activities, this.maxPayloadBytes);
    if (cloudPayload === null) {
      throw new RangeError("activity classification payload exceeds the byte limit");
    }
    const cloudPayloadJson = JSON.stringify(cloudPayload);
    const inputBytes = Buffer.byteLength(cloudPayloadJson, "utf8");
    return {
      inputContractVersion: INPUT_CONTRACT_VERSION,
      cloudPayload,
      cloudPayloadJson,
      inputHash: sha256(cloudPayloadJson),
      inputBytes,
      validationContext: validationContextFor(cloudPayload.activities),
    };
  }

  verifyCloudPayload(payload) {
    try {
      normalizeCloudPayload(payload);
      return Buffer.byteLength(JSON.stringify(payload), "utf8") <= this.maxPayloadBytes;
    } catch {
      return false;
    }
  }
}

module.exports = ActivityClassificationInputBuilder;
module.exports.INPUT_CONTRACT_VERSION = INPUT_CONTRACT_VERSION;
module.exports.DEFAULT_MAX_PAYLOAD_BYTES = DEFAULT_MAX_PAYLOAD_BYTES;
module.exports.MAX_ACTIVITIES_PER_BATCH = MAX_ACTIVITIES_PER_BATCH;
module.exports.NORMALIZED_APPLICATIONS = NORMALIZED_APPLICATIONS;
module.exports.SOURCE_ATTRIBUTIONS = SOURCE_ATTRIBUTIONS;
module.exports.ANONYMOUS_SPEAKER_PATTERN = ANONYMOUS_SPEAKER_PATTERN;
module.exports.normalizeCloudPayload = normalizeCloudPayload;
