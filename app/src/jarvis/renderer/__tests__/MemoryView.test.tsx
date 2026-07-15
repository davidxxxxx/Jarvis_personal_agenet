import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type {
  JarvisSession,
  JarvisSessionDetail,
  JarvisRuntimeStatus,
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

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

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

const runtimeStatus: JarvisRuntimeStatus = {
  observedAt: 100_000,
  capture: {
    sessionId: session.id,
    status: "recording",
    captureMode: "mic",
    retentionMode: "speech_triggered",
    errorCode: null,
  },
  backend: { actualBackend: "cuda", cudaGpuUuid: "GPU-verified" },
  resources: {
    sampledAt: 99_000,
    state: "busy",
    reason: "external_gpu_busy",
    cudaInstalled: true,
    cudaVerified: true,
    cudaQuarantined: false,
  },
  queue: {
    pending: 1,
    running: 0,
    retry: 0,
    blocked: 0,
    total: 1,
    byStage: {
      final_transcription: { pending: 1, running: 0, retry: 0, blocked: 0, total: 1 },
    },
    deferrals: [],
    backlogMinutes: 1,
    oldestJobAgeMs: 30_000,
    finalCoveragePct: 50,
    provisionalCoveragePct: null,
  },
  preview: {
    mode: "paused",
    cadenceMs: null,
    pending: 1,
    running: 0,
    pausedReason: "gpu_busy",
    executionDevice: null,
    lastError: null,
    recordingContinues: true,
  },
  disk: { state: "ok", freeBytes: 10_000, remainingDays: 10, recoveryAction: null },
  nextRecoveryAction: "wait_for_gpu",
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
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 2_500) {
          poll = callback as () => void;
          return 7 as unknown as ReturnType<typeof window.setInterval>;
        }
        return originalSetInterval(callback, delay, ...args);
      });
    clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((timer) => {
      if (timer !== 7) originalClearInterval(timer);
    });
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
    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2_500));

    const unrelatedTimer = window.setInterval(() => undefined, 50);

    act(() => poll?.());
    act(() => poll?.());
    window.clearInterval(unrelatedTimer);
    expect(getSessionTimeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePoll?.({ ...timeline, timeline_version: 2 });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "返回记忆库" }));

    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(7));
    act(() => poll?.());
    expect(getSessionTimeline).toHaveBeenCalledTimes(2);
  });

  it("contains a failed refresh and allows the next poll to retry", async () => {
    const failedRefresh = deferred<JarvisSessionTimeline>();
    const getSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce(timeline)
      .mockImplementationOnce(() => failedRefresh.promise)
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
    await waitFor(() => expect(poll).not.toBeNull());

    act(() => poll?.());
    expect(getSessionTimeline).toHaveBeenCalledTimes(2);
    await act(async () => {
      failedRefresh.reject(new Error("temporary IPC failure"));
      await failedRefresh.promise.catch(() => undefined);
    });
    act(() => poll?.());

    await waitFor(() => expect(getSessionTimeline).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("处理完成")).toBeInTheDocument();
  });

  it("opens memory detail when the optional runtime status request fails", async () => {
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detailFor(session)),
          getSessionTimeline: vi.fn(async () => timeline),
          getRuntimeStatus: vi.fn(async () => {
            throw new Error("temporary runtime status failure");
          }),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect(await screen.findByText("正在处理")).toBeInTheDocument();
    expect(screen.queryByText("无法读取这次录音。")).not.toBeInTheDocument();
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
    await waitFor(() => expect(poll).not.toBeNull());

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

  it("polls hidden runtime status at no more than 2 Hz and never overlaps IPC", async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const pendingPoll = deferred<JarvisRuntimeStatus>();
    const getRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce(runtimeStatus)
      .mockImplementationOnce(() => pendingPoll.promise);
    let runtimePoll: (() => void) | null = null;
    const originalSetTimeout = window.setTimeout.bind(window);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation((callback, delay) => {
      if (delay === 2_000) {
        runtimePoll = callback as () => void;
        return 9 as unknown as ReturnType<typeof window.setTimeout>;
      }
      return originalSetTimeout(callback, delay);
    });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detailFor(session)),
          getSessionTimeline: vi.fn(async () => timeline),
          getRuntimeStatus,
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    try {
      render(<MemoryView />);
      fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

      expect(await screen.findByText("正在监听")).toBeInTheDocument();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);

      act(() => runtimePoll?.());
      act(() => runtimePoll?.());
      expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingPoll.resolve({ ...runtimeStatus, observedAt: 102_000 });
        await Promise.resolve();
      });
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_000);

      fireEvent.click(screen.getByRole("button", { name: "返回记忆库" }));
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    }
  });

  it("keeps completed-session speaker corrections reachable through durable evidence", async () => {
    const completedDetail = { ...detailFor(session), segments: [visibleSegment] };
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => completedDetail),
          getSessionTimeline: vi.fn(async () => ({
            ...timeline,
            processing_state: "ready",
            ready_at: 3_000,
            segments: [visibleSegment],
          })),
          getRuntimeStatus: vi.fn(async () => runtimeStatus),
          listSessionSpeakerClusters: vi.fn(async () => [
            {
              id: "cluster-1",
              sessionId: session.id,
              trackId: null,
              localLabel: "speaker_1",
              linkState: "suggested",
              person: null,
              suggestedPerson: { id: "p1", displayName: "Alice", isSelf: false },
              lastRejectedPerson: null,
              score: 0.8,
              margin: 0.1,
              reason: "candidate",
              policyId: "policy",
              diarizationRevision: "a".repeat(64),
              profileRevision: "b".repeat(64),
              evidenceSegmentIds: [visibleSegment.id],
              canUndo: false,
              updatedAt: 1,
            },
          ]),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect((await screen.findAllByText(visibleSegment.text)).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: /Alice/ })).toBeInTheDocument();
  });
});
