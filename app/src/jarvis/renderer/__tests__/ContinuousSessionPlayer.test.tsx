import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisSessionTimeline } from "../../types";
import ContinuousSessionPlayer from "../ContinuousSessionPlayer";

class FakeAudio {
  currentTime = 0;
  onended: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();

  constructor(readonly src: string) {}
}

const createdAudio: FakeAudio[] = [];
const createObjectURL = vi.fn(() => `blob:audio-${createObjectURL.mock.calls.length}`);
const revokeObjectURL = vi.fn();

function chunk(
  id: string,
  source_type: "mic" | "system",
  started_at: number,
  sequence_number: number
) {
  return {
    id,
    session_id: "session-1",
    path: `${id}.flac`,
    started_at,
    ended_at: started_at + 1_000,
    duration_ms: 1_000,
    sha256: id,
    expires_at: 99_999,
    transcription_status: "completed",
    track_id: `track-${source_type}`,
    source_type,
    sequence_number,
    write_state: "committed",
    deleted_at: null,
    format: "flac",
  } as const;
}

function timeline(overrides: Partial<JarvisSessionTimeline> = {}): JarvisSessionTimeline {
  return {
    session_id: "session-1",
    started_at: 1_000,
    ended_at: 5_000,
    status: "completed",
    processing_state: "ready",
    timeline_version: 1,
    finalized_at: 5_000,
    ready_at: 5_100,
    tracks: [
      {
        id: "track-mic",
        session_id: "session-1",
        source_type: "mic",
        sample_rate: 24_000,
        channels: 1,
        started_at: 1_000,
        ended_at: 5_000,
        state: "completed",
        gaps: [
          {
            id: "gap-mic",
            track_id: "track-mic",
            started_at: 2_200,
            ended_at: 2_700,
            reason: "device_interrupted",
            recovery_attempts: 2,
          },
        ],
      },
      {
        id: "track-system",
        session_id: "session-1",
        source_type: "system",
        sample_rate: 24_000,
        channels: 1,
        started_at: 1_000,
        ended_at: 5_000,
        state: "completed",
        gaps: [],
      },
    ],
    gaps: [
      {
        id: "gap-mic",
        track_id: "track-mic",
        started_at: 2_200,
        ended_at: 2_700,
        reason: "device_interrupted",
        recovery_attempts: 2,
      },
    ],
    chunks: [chunk("mic-1", "mic", 1_000, 0), chunk("system-1", "system", 1_500, 0)],
    segments: [
      {
        id: "segment-system",
        session_id: "session-1",
        started_at: 1_750,
        ended_at: 1_900,
        person_id: null,
        speaker_label: "其他说话人",
        text: "点击定位到这句话",
        confidence: 0.9,
        is_stable: 1,
        analysis_state: "pending",
        track_id: "track-system",
        chunk_id: "system-1",
        source_type: "system",
        result_kind: "final",
      },
    ],
    processing_counts: {
      pending: 0,
      leased: 0,
      retry: 0,
      blocked: 0,
      completed: 2,
      total: 2,
    },
    ...overrides,
  };
}

beforeEach(() => {
  createdAudio.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal(
    "Audio",
    vi.fn((src: string) => {
      const audio = new FakeAudio(src);
      createdAudio.push(audio);
      return audio;
    })
  );
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
});

describe("ContinuousSessionPlayer", () => {
  it("honors a controlled evidence seek and continues through the remaining source lane", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1]));
    const onSeekResult = vi.fn();
    const sourceTimeline = timeline({
      chunks: [
        chunk("mic-1", "mic", 1_000, 0),
        chunk("system-1", "system", 1_500, 0),
        chunk("system-2", "system", 2_500, 1),
      ],
    });

    render(
      <ContinuousSessionPlayer
        timeline={sourceTimeline}
        readChunk={readChunk}
        seekRequest={{
          requestId: 7,
          trackId: "track-system",
          sourceType: "system",
          startedAt: 1_750,
        }}
        onSeekResult={onSeekResult}
      />
    );

    await waitFor(() => expect(readChunk).toHaveBeenNthCalledWith(1, "system-1"));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    expect(createdAudio[0].currentTime).toBe(0.25);
    expect(onSeekResult).toHaveBeenCalledWith(7, "playing");

    createdAudio[0].onended?.();
    await waitFor(() => expect(readChunk).toHaveBeenNthCalledWith(2, "system-2"));
    expect(readChunk).not.toHaveBeenCalledWith("mic-1");
  });

  it("reports a retention race without skipping to later audio", async () => {
    const readChunk = vi.fn(async () => null);
    const onSeekResult = vi.fn();
    render(
      <ContinuousSessionPlayer
        timeline={timeline({
          chunks: [chunk("system-1", "system", 1_500, 0), chunk("system-2", "system", 2_500, 1)],
        })}
        readChunk={readChunk}
        seekRequest={{
          requestId: 8,
          trackId: "track-system",
          sourceType: "system",
          startedAt: 1_750,
        }}
        onSeekResult={onSeekResult}
      />
    );

    await waitFor(() => expect(onSeekResult).toHaveBeenCalledWith(8, "audio_unavailable"));
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("plays successive chronological chunks as one session", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1, 2, 3]));
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: "连续播放" }));
    await waitFor(() => expect(readChunk).toHaveBeenNthCalledWith(1, "mic-1"));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    createdAudio[0].onended?.();

    await waitFor(() => expect(readChunk).toHaveBeenNthCalledWith(2, "system-1"));
    expect(screen.queryByText(/秒音频/)).not.toBeInTheDocument();
  });

  it("filters the continuous queue to microphone or system mode", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1]));
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: "电脑声音" }));
    fireEvent.click(screen.getByRole("button", { name: "连续播放" }));

    await waitFor(() => expect(readChunk).toHaveBeenCalledWith("system-1"));
    expect(readChunk).not.toHaveBeenCalledWith("mic-1");
  });

  it("iteratively skips missing chunks and shows a visible warning", async () => {
    const readChunk = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValueOnce(new Uint8Array([3]));
    const skippedTimeline = timeline({
      chunks: [
        chunk("missing-1", "mic", 1_000, 0),
        chunk("missing-2", "mic", 2_000, 1),
        chunk("playable", "mic", 3_000, 2),
      ],
    });
    render(<ContinuousSessionPlayer timeline={skippedTimeline} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: "连续播放" }));

    await waitFor(() => expect(readChunk).toHaveBeenCalledTimes(3));
    expect(screen.getByText(/已跳过 2 段不可用音频/)).toBeInTheDocument();
    expect(createdAudio).toHaveLength(1);
  });

  it("cancels late reads and revokes active URLs on mode change and unmount", async () => {
    let resolveRead: ((value: Uint8Array) => void) | null = null;
    const readChunk = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveRead = resolve;
        })
    );
    const view = render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);
    fireEvent.click(screen.getByRole("button", { name: "连续播放" }));
    fireEvent.click(screen.getByRole("button", { name: "电脑声音" }));
    resolveRead?.(new Uint8Array([1]));
    await Promise.resolve();
    await Promise.resolve();
    expect(createdAudio).toHaveLength(0);

    readChunk.mockResolvedValueOnce(new Uint8Array([2]));
    fireEvent.click(screen.getByRole("button", { name: "连续播放" }));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    view.unmount();

    expect(createdAudio[0].pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith(createdAudio[0].src);
  });

  it("renders both source lanes and explicit recorded gaps", () => {
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={vi.fn()} />);

    expect(screen.getByTestId("source-lane-mic")).toHaveTextContent("麦克风");
    expect(screen.getByTestId("source-lane-system")).toHaveTextContent("电脑声音");
    expect(screen.getByText(/缺失 0.5 秒/)).toBeInTheDocument();
    expect(screen.getByText(/device_interrupted/)).toBeInTheDocument();
  });

  it("starts the matching chunk at the transcript timestamp offset", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1]));
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: /点击定位到这句话/ }));

    await waitFor(() => expect(readChunk).toHaveBeenCalledWith("system-1"));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    expect(createdAudio[0].currentTime).toBe(0.25);
  });
});
