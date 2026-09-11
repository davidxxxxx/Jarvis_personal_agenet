import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisAudioChunk, JarvisSpeakerUtterance } from "../../types";
import SpeakerUtteranceTimeline from "../SpeakerUtteranceTimeline";
import { groupSpeakerUtterances } from "../speakerUtteranceGrouping";

class FakeAudio {
  currentTime = 0;
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();

  constructor(readonly src: string) {}
}

const chunk: JarvisAudioChunk = {
  id: "chunk-1",
  session_id: "session-1",
  started_at: 1_000,
  ended_at: 3_000,
  duration_ms: 2_000,
  transcription_status: "completed",
  track_id: "track-kook",
  source_type: "system",
  sequence_number: 0,
  write_state: "committed",
  deleted_at: null,
  format: "flac",
};

function utterance(
  id: string,
  clusterId: string,
  name: string,
  startedAt: number,
  endedAt: number,
  isolated = false
): JarvisSpeakerUtterance {
  return {
    id,
    session_id: "session-1",
    chunk_id: chunk.id,
    cluster_id: clusterId,
    source_segment_id: "segment-1",
    stem_id: isolated ? `stem-${id}` : null,
    started_at: startedAt,
    ended_at: endedAt,
    text: `${name} 的话`,
    confidence: 0.9,
    overlap_state: "overlap",
    evidence_kind: isolated ? "separated_stem" : "word_alignment",
    local_label: name,
    person_id: null,
    link_state: "unknown",
    person_display_name: name,
    application_key: "kook",
    application_display_name: "KOOK",
    track_kind: "application",
    has_isolated_audio: isolated,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "Audio",
    vi.fn((src: string) => new FakeAudio(src))
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:speaker"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("SpeakerUtteranceTimeline", () => {
  it("groups simultaneous people into one explicitly overlapping time range", () => {
    const grouped = groupSpeakerUtterances([
      utterance("u1", "c1", "人物 1", 1_100, 2_100),
      utterance("u2", "c2", "人物 2", 1_500, 2_500),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].overlapping).toBe(true);
    expect(grouped[0].utterances.map((item) => item.cluster_id)).toEqual(["c1", "c2"]);
  });

  it("plays a separated stem independently and routes review controls to the cluster", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const readIsolatedAudio = vi.fn(async () => new Uint8Array([4, 5, 6]));
    const onOpenSpeakerReview = vi.fn();
    render(
      <SpeakerUtteranceTimeline
        utterances={[
          utterance("u1", "c1", "人物 1", 1_100, 2_100, true),
          utterance("u2", "c2", "人物 2", 1_500, 2_500),
        ]}
        chunks={[chunk]}
        readChunk={readChunk}
        readIsolatedAudio={readIsolatedAudio}
        onOpenSpeakerReview={onOpenSpeakerReview}
      />
    );

    expect(screen.getByText("重叠说话 · 2 人")).toBeInTheDocument();
    expect(screen.getByText("已分离声道")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "播放 人物 1 的话语" }));
    await waitFor(() => expect(readIsolatedAudio).toHaveBeenCalledWith("u1"));
    expect(readChunk).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "复核这个人" })[1]);
    expect(onOpenSpeakerReview).toHaveBeenCalledWith("c2");
  });
});
