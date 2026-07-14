import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisSession,
  JarvisSessionDetail,
  JarvisSessionTimeline,
  JarvisTranscriptSegment,
} from "../../types";
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

const visibleSegment: JarvisTranscriptSegment = {
  id: "segment-1",
  session_id: session.id,
  started_at: 1_200,
  ended_at: 1_500,
  person_id: null,
  speaker_label: "其他说话人",
  text: "轮询后出现的最终转写",
  confidence: 0.9,
  is_stable: 1,
  analysis_state: "pending",
  track_id: null,
  chunk_id: null,
  source_type: "mic",
  result_kind: "final",
};

function detailFor(value: JarvisSession): JarvisSessionDetail {
  return {
    session: value,
    summary: null,
    segments: [],
    audioChunks: [],
    topics: [],
    todos: [],
    memories: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("offers summary generation when polling publishes visible transcript segments", async () => {
    const readyTimeline = {
      ...timeline,
      processing_state: "ready" as const,
      ready_at: 3_000,
      segments: [visibleSegment],
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 1,
        total: 1,
      },
    };
    const getSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce(timeline)
      .mockResolvedValueOnce(readyTimeline);
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detailFor(session)),
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
    expect(screen.queryByRole("button", { name: "生成总结" })).not.toBeInTheDocument();

    act(() => poll?.());

    expect(await screen.findByRole("button", { name: "生成总结" })).toBeInTheDocument();
  });

  it("keeps the latest session when an earlier detail request resolves last", async () => {
    const sessionB: JarvisSession = {
      ...session,
      id: "session-2",
      started_at: 2_000_000,
      ended_at: 2_001_000,
    };
    const detailA = deferred<JarvisSessionDetail>();
    const detailB = deferred<JarvisSessionDetail>();
    const timelineA = deferred<JarvisSessionTimeline>();
    const timelineB = deferred<JarvisSessionTimeline>();
    useJarvisStore.setState({ sessions: [session, sessionB] });
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn((sessionId: string) =>
            sessionId === session.id ? detailA.promise : detailB.promise
          ),
          getSessionTimeline: vi.fn((sessionId: string) =>
            sessionId === session.id ? timelineA.promise : timelineB.promise
          ),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    const recordingButtons = screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("的录音"));
    fireEvent.click(recordingButtons[0]);
    fireEvent.click(recordingButtons[1]);

    await act(async () => {
      detailB.resolve(detailFor(sessionB));
      timelineB.resolve({ ...timeline, session_id: sessionB.id, started_at: sessionB.started_at });
      await Promise.resolve();
    });
    const sessionBHeading = new Date(sessionB.started_at).toLocaleString("zh-CN");
    expect(await screen.findByRole("heading", { name: sessionBHeading })).toBeInTheDocument();

    await act(async () => {
      detailA.resolve(detailFor(session));
      timelineA.resolve(timeline);
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: sessionBHeading })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: new Date(session.started_at).toLocaleString("zh-CN") })
    ).not.toBeInTheDocument();
  });
});
