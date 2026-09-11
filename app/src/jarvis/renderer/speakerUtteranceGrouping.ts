import type { JarvisSpeakerUtterance } from "../types";

export interface UtteranceGroup {
  id: string;
  startedAt: number;
  endedAt: number;
  utterances: JarvisSpeakerUtterance[];
  overlapping: boolean;
}

export function groupSpeakerUtterances(input: JarvisSpeakerUtterance[]): UtteranceGroup[] {
  const ordered = [...input].sort(
    (left, right) =>
      left.started_at - right.started_at ||
      left.ended_at - right.ended_at ||
      left.id.localeCompare(right.id)
  );
  const groups: UtteranceGroup[] = [];
  for (const utterance of ordered) {
    const previous = groups.at(-1);
    if (previous && utterance.started_at < previous.endedAt) {
      previous.utterances.push(utterance);
      previous.endedAt = Math.max(previous.endedAt, utterance.ended_at);
      previous.overlapping =
        previous.overlapping ||
        utterance.overlap_state === "overlap" ||
        new Set(previous.utterances.map((candidate) => candidate.cluster_id)).size > 1;
      continue;
    }
    groups.push({
      id: utterance.id,
      startedAt: utterance.started_at,
      endedAt: utterance.ended_at,
      utterances: [utterance],
      overlapping: utterance.overlap_state === "overlap",
    });
  }
  return groups;
}
