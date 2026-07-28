"use strict";

const crypto = require("node:crypto");
const {
  NORMALIZED_APPLICATIONS,
} = require("./ActivityClassificationInputBuilder");

function stableActivityId(sessionId, trackId, startedAt, endedAt) {
  return `activity_${crypto
    .createHash("sha256")
    .update(`${sessionId}\0${trackId}\0${startedAt}\0${endedAt}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function overlaps(left, right) {
  return left.started_at < right.ended_at && right.started_at < left.ended_at;
}

class SessionActivityBuilder {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") {
      throw new TypeError("an open better-sqlite3 database is required");
    }
    this.db = db;
    this.listTracks = db.prepare(`
      SELECT
        audio_tracks.*,
        CASE
          WHEN source_type = 'mic' THEN 'mic'
          WHEN application_key IS NOT NULL THEN 'application'
          ELSE 'system_mix'
        END AS track_kind,
        CASE
          WHEN source_type = 'system' AND application_key IS NULL THEN 'mixed_unknown'
          ELSE 'exact'
        END AS attribution_state
      FROM audio_tracks
      WHERE session_id = ?
      ORDER BY CASE
        WHEN application_key IS NOT NULL THEN 0
        WHEN source_type = 'system' THEN 1
        ELSE 2
      END,
        started_at, id
    `);
    this.listSegments = db.prepare(`
      SELECT segment.*, person.is_self
      FROM transcript_segments AS segment
      LEFT JOIN people AS person ON person.id = segment.person_id
      WHERE segment.session_id = ?
        AND segment.result_kind = 'final'
        AND segment.is_stable = 1
        AND segment.superseded_by IS NULL
        AND segment.duplicate_of IS NULL
        AND length(trim(segment.text)) > 0
      ORDER BY segment.started_at, segment.ended_at, segment.id
    `);
    this.listRedactionPeople = db.prepare(`
      SELECT id, display_name, is_self
      FROM people
      WHERE length(trim(display_name)) > 0
      ORDER BY is_self DESC, id
    `);
  }

  build(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    const tracks = this.listTracks.all(sessionId);
    const segments = this.listSegments.all(sessionId);
    if (tracks.length === 0 || segments.length === 0) {
      return {
        activities: [],
        redactionTerms: { participants: [], otherPeople: [], deviceLabels: [] },
      };
    }
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const micSegments = segments.filter(
      (segment) => trackById.get(segment.track_id)?.track_kind === "mic"
    );
    const consumedMic = new Set();
    const speakerKey = (segment) =>
      segment.is_self === 1
        ? "SELF"
        : `other:${segment.person_id ?? segment.speaker_label ?? "unknown"}`;
    const otherLabels = new Map();
    const labelFor = (segment) => {
      const key = speakerKey(segment);
      if (key === "SELF") return key;
      if (!otherLabels.has(key)) otherLabels.set(key, `P${otherLabels.size + 1}`);
      return otherLabels.get(key);
    };
    const activities = [];
    const classifiedTracks = tracks.filter((track) => track.track_kind !== "mic");
    for (const track of classifiedTracks) {
      const own = segments.filter((segment) => segment.track_id === track.id);
      if (own.length === 0) continue;
      const startedAt = own[0].started_at;
      const endedAt = Math.max(...own.map((segment) => segment.ended_at));
      const relatedMic =
        track.attribution_state === "exact"
          ? micSegments.filter((segment) =>
              own.some((candidate) => overlaps(segment, candidate))
            )
          : [];
      for (const segment of relatedMic) consumedMic.add(segment.id);
      const activitySegments = [...own, ...relatedMic].sort(
        (left, right) =>
          left.started_at - right.started_at ||
          left.ended_at - right.ended_at ||
          left.id.localeCompare(right.id)
      );
      activities.push(
        this._activity({
          sessionId,
          track,
          segments: activitySegments,
          startedAt,
          endedAt,
          labelFor,
          microphoneParticipated: relatedMic.length > 0,
        })
      );
    }
    const remainingMic = micSegments.filter((segment) => !consumedMic.has(segment.id));
    if (remainingMic.length > 0) {
      const micTrack = trackById.get(remainingMic[0].track_id);
      activities.push(
        this._activity({
          sessionId,
          track: micTrack,
          segments: remainingMic,
          startedAt: remainingMic[0].started_at,
          endedAt: Math.max(...remainingMic.map((segment) => segment.ended_at)),
          labelFor,
          microphoneParticipated: true,
        })
      );
    }
    const people = this.listRedactionPeople.all();
    const participantNames = new Map();
    for (const person of people) {
      const label =
        person.is_self === 1
          ? "SELF"
          : otherLabels.get(`other:${person.id}`);
      if (!label) continue;
      const names = participantNames.get(label) ?? [];
      names.push(person.display_name);
      participantNames.set(label, names);
    }
    return {
      activities,
      redactionTerms: {
        participants: [...participantNames].map(([label, names]) => ({ label, names })),
        otherPeople: people
          .filter(
            (person) =>
              person.is_self !== 1 && !otherLabels.has(`other:${person.id}`)
          )
          .map((person) => person.display_name),
        deviceLabels: tracks
          .map((track) => track.device_label)
          .filter((label) => typeof label === "string" && label.trim()),
      },
    };
  }

  _activity({
    sessionId,
    track,
    segments,
    startedAt,
    endedAt,
    labelFor,
    microphoneParticipated,
  }) {
    const labels = [];
    const cloudSegments = segments.map((segment) => {
      const speakerLabel = labelFor(segment);
      if (!labels.includes(speakerLabel)) labels.push(speakerLabel);
      return {
        segmentId: segment.id,
        startedAt: segment.started_at,
        endedAt: segment.ended_at,
        speakerLabel,
        text: segment.text,
      };
    });
    const applications =
      track.track_kind === "application" &&
      Object.prototype.hasOwnProperty.call(NORMALIZED_APPLICATIONS, track.application_key)
        ? [track.application_key]
        : [];
    const sourceAttribution =
      track.attribution_state === "mixed_unknown"
        ? "mixed_unknown"
        : track.track_kind === "mic"
          ? "microphone"
          : microphoneParticipated
            ? "application_and_microphone"
            : "application";
    let transitions = 0;
    for (let index = 1; index < cloudSegments.length; index += 1) {
      if (cloudSegments[index].speakerLabel !== cloudSegments[index - 1].speakerLabel) {
        transitions += 1;
      }
    }
    return {
      activityId: stableActivityId(sessionId, track.id, startedAt, endedAt),
      startedAt,
      endedAt,
      applications,
      sourceAttribution,
      speakerLabels: labels.length > 0 ? labels : ["P1"],
      segments: cloudSegments,
      statistics: {
        durationMs: endedAt - startedAt,
        microphoneParticipated,
        selfDetected: labels.includes("SELF"),
        speakerCount: Math.max(1, labels.length),
        turnCount: cloudSegments.length,
        turnTakingScore:
          cloudSegments.length <= 1 ? 0 : transitions / (cloudSegments.length - 1),
        foregroundAppKey: applications[0] ?? null,
      },
      topicHints: [],
      calendarBlockKind: "none",
    };
  }
}

module.exports = SessionActivityBuilder;
