import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisSessionTimeline } from "../../types";
import MemoryView from "../MemoryView";
import { useJarvisStore } from "../jarvisStore";

const session = {
  id: "session-1",
  started_at: 1_000,
  ended_at: 2_000,
  status: "completed" as const,
  mic_device_id: "mic-1",
  language: "zh",
  created_at: 1_000,
  capture_mode: "mic" as const,
};

const timeline: JarvisSessionTimeline = {
  session_id: session.id,
  started_at: session.started_at,
  ended_at: session.ended_at,
  status: session.status,
  processing_state: "processing",
  timeline_version: 1,
  finalized_at: 2_000,
  ready_at: null,
  tracks: [],
  gaps: [],
  chunks: [],
  segments: [],
  processing_counts: {
    pending: 1,
    leased: 0,
    retry: 0,
    blocked: 0,
    completed: 0,
    total: 1,
  },
};

describe("MemoryView processing timeline", () => {
  let poll: (() => void) | null;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    poll = null;
    setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = callback as () => void;
      return 7 as unknown as ReturnType<typeof window.setInterval>;
    });
    clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    useJarvisStore.setState({ sessions: [session] });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("loads detail with its timeline, prevents overlapping polls, and cleans polling on close", async () => {
    let resolvePoll: ((value: JarvisSessionTimeline) => void) | null = null;
    const getSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce(timeline)
      .mockImplementationOnce(
        () =>
          new Promise<JarvisSessionTimeline>((resolve) => {
            resolvePoll = resolve;
          })
      );
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => ({
            session,
            summary: null,
            segments: [],
            audioChunks: [],
            topics: [],
            todos: [],
            memories: [],
          })),
          getSessionTimeline,
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect(await screen.findByText("正在处理")).toBeInTheDocument();
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2_500);

    act(() => poll?.());
    act(() => poll?.());
    expect(getSessionTimeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePoll?.({ ...timeline, timeline_version: 2 });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "返回记忆库" }));

    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalled());
    act(() => poll?.());
    expect(getSessionTimeline).toHaveBeenCalledTimes(2);
  });

  it("contains a failed refresh and allows the next poll to retry", async () => {
    const getSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce(timeline)
      .mockRejectedValueOnce(new Error("temporary IPC failure"))
      .mockResolvedValueOnce({ ...timeline, processing_state: "ready", ready_at: 3_000 });
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => ({
            session,
            summary: null,
            segments: [],
            audioChunks: [],
            topics: [],
            todos: [],
            memories: [],
          })),
          getSessionTimeline,
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByText("正在处理")).toBeInTheDocument();

    act(() => poll?.());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => poll?.());

    await waitFor(() => expect(getSessionTimeline).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("处理完成")).toBeInTheDocument();
  });
});
