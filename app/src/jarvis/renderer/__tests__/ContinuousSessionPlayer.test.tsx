import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisKnowledgeActionInput, JarvisSessionTimeline } from "../../types";
import ContinuousSessionPlayer from "../ContinuousSessionPlayer";

class FakeAudio {
  currentTime = 0;
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
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
        track_kind: "mic",
        application_key: null,
        application_display_name: null,
        attribution_state: "exact",
        capture_generation: 0,
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
        track_kind: "system_mix",
        application_key: null,
        application_display_name: null,
        attribution_state: "mixed_unknown",
        capture_generation: 0,
        sample_rate: 24_000,
        channels: 1,
        started_at: 1_000,
        ended_at: 5_000,
        state: "completed",
        gaps: [],
      },
    ],
    application_audio_intervals: [],
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

    fireEvent.click(screen.getByRole("button", { name: "系统音频·安全兜底" }));
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
    fireEvent.click(screen.getByRole("button", { name: "系统音频·安全兜底" }));
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
    expect(screen.getByTestId("source-lane-system")).toHaveTextContent("系统音频·安全兜底");
    expect(screen.getByText(/缺失 0.5 秒/)).toBeInTheDocument();
    expect(screen.getByText(/device_interrupted/)).toBeInTheDocument();
  });

  it("shows the normalized application name on its source lane and transcript", () => {
    const sourceTimeline = timeline();
    const applicationTrack = {
      ...sourceTimeline.tracks[1],
      id: "track-kook",
      track_kind: "application" as const,
      application_key: "kook",
      application_display_name: "KOOK",
      attribution_state: "exact" as const,
    };
    const applicationSegment = {
      ...sourceTimeline.segments[0],
      track_id: "track-kook",
      application_key: "kook",
      application_display_name: "KOOK",
      track_kind: "application" as const,
    };

    render(
      <ContinuousSessionPlayer
        timeline={timeline({
          tracks: [sourceTimeline.tracks[0], applicationTrack],
          segments: [applicationSegment],
        })}
        readChunk={vi.fn()}
      />
    );

    expect(screen.getAllByText("KOOK")).toHaveLength(2);
  });

  it("shows a raw interval failure code when application capture falls back before a track starts", () => {
    render(
      <ContinuousSessionPlayer
        timeline={timeline({
          application_audio_intervals: [
            {
              id: "fallback-1",
              session_id: "session-1",
              track_id: "track-system",
              interval_kind: "mixed_fallback",
              application_key: null,
              attribution_state: "mixed_unknown",
              capture_generation: 1,
              started_at: 1_500,
              ended_at: 2_500,
              reason: "capture_start_failed",
              failure_code: "application_native_start_E_ACCESSDENIED",
            },
          ],
        })}
        readChunk={vi.fn()}
      />
    );

    const failures = screen.getByTestId("application-capture-failures");
    expect(failures).toHaveTextContent("系统音频·应用未知");
    expect(failures).toHaveTextContent("application_native_start_E_ACCESSDENIED");
  });

  it("requests the next bounded source page", () => {
    const onTrackPageChange = vi.fn();
    render(
      <ContinuousSessionPlayer
        timeline={timeline({
          evidence_page: {
            tracks: { total: 250, offset: 0, limit: 100 },
            intervals: { total: 0, offset: 0, limit: 200 },
          },
        })}
        readChunk={vi.fn()}
        onTrackPageChange={onTrackPageChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onTrackPageChange).toHaveBeenCalledWith(100);
  });

  it("plays only the selected transcript time range and then stops", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1]));
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: /点击定位到这句话/ }));

    await waitFor(() => expect(readChunk).toHaveBeenCalledWith("system-1"));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    expect(createdAudio[0].currentTime).toBe(0.25);
    expect(
      screen.getByRole("button", { name: /停止这条转写：点击定位到这句话/ })
    ).toBeInTheDocument();

    createdAudio[0].currentTime = 0.4;
    createdAudio[0].ontimeupdate?.();

    await waitFor(() => expect(createdAudio[0].pause).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: /播放这条转写：点击定位到这句话/ })
    ).toBeInTheDocument();
  });

  it("lets the transcript row stop its own playback immediately", async () => {
    const readChunk = vi.fn(async () => new Uint8Array([1]));
    render(<ContinuousSessionPlayer timeline={timeline()} readChunk={readChunk} />);

    fireEvent.click(screen.getByRole("button", { name: /播放这条转写/ }));
    await waitFor(() => expect(createdAudio).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /停止这条转写/ }));

    expect(createdAudio[0].pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /播放这条转写/ })).toBeInTheDocument();
  });

  it("creates a Todo from final transcript references without copying raw evidence", async () => {
    const applyKnowledgeAction = vi
      .fn<(input: JarvisKnowledgeActionInput) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementation(async (input) => ({
        status: "applied" as const,
        commandId: input.commandId,
        type: input.type,
        entityKind: "todo" as const,
        entityId: "todo-created",
        occurredAt: Date.now(),
        todoId: "todo-created",
      }));
    window.electronAPI = {
      jarvis: { applyKnowledgeAction },
    } as unknown as typeof window.electronAPI;

    const view = render(<ContinuousSessionPlayer timeline={timeline()} readChunk={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "从该转写创建 Todo" }));
    expect(screen.getByLabelText("待办标题")).toHaveValue("");
    expect(screen.getByRole("button", { name: "创建待办" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("待办标题"), {
      target: { value: "整理这段讨论" },
    });
    fireEvent.change(screen.getByLabelText("日期或时间（可选）"), {
      target: { value: "周五" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));

    await waitFor(() => expect(applyKnowledgeAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("操作没有保存，请稍后重试。")).toBeVisible();
    const firstInput = applyKnowledgeAction.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(applyKnowledgeAction).toHaveBeenCalledTimes(2));
    const input = applyKnowledgeAction.mock.calls[1][0];
    expect(firstInput.type).toBe("transcript_create");
    expect(input.type).toBe("transcript_create");
    expect(input.commandId).toBe(firstInput.commandId);
    if (firstInput.type !== "transcript_create" || input.type !== "transcript_create") {
      throw new Error("expected transcript_create actions");
    }
    expect(input.todoId).toBe(firstInput.todoId);
    expect(input).toEqual(
      expect.objectContaining({
        type: "transcript_create",
        sessionId: "session-1",
        segmentIds: ["segment-system"],
        title: "整理这段讨论",
        dueText: "周五",
      })
    );
    expect(input).not.toHaveProperty("quote");
    expect(input).not.toHaveProperty("evidence");
    expect(input).not.toHaveProperty("text");

    view.unmount();
    render(
      <ContinuousSessionPlayer
        timeline={timeline({
          segments: [{ ...timeline().segments[0], result_kind: "provisional" }],
        })}
        readChunk={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "从该转写创建 Todo" })).not.toBeInTheDocument();
  });
});
