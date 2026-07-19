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
  application_audio_intervals: [],
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
  let originalClearIntervalSpy: ReturnType<typeof vi.fn>;
  let timelinePollHandle: ReturnType<typeof window.setInterval>;

  beforeEach(() => {
    poll = null;
    timelinePollHandle = Symbol("timeline-poll") as unknown as ReturnType<
      typeof window.setInterval
    >;
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    originalClearIntervalSpy = vi.fn(originalClearInterval);
    setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 2_500) {
          poll = callback as () => void;
          return timelinePollHandle;
        }
        return originalSetInterval(callback, delay, ...args);
      });
    clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((timer) => {
      if (timer !== timelinePollHandle) originalClearIntervalSpy(timer);
    });
    useJarvisStore.setState({ sessions: [session] });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("forwards a real timer clear even when its numeric id collides with the poll handle", () => {
    window.clearInterval(7 as unknown as ReturnType<typeof window.setInterval>);
    expect(originalClearIntervalSpy).toHaveBeenCalledWith(7);
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

    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(timelinePollHandle));
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

  it("does not offer summary generation until final transcription and speaker processing are ready", async () => {
    const getSessionTimeline = vi.fn(async () => ({
      ...timeline,
      segments: [visibleSegment],
    }));
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => ({
            ...detailFor(session),
            segments: [visibleSegment],
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

    expect(await screen.findByText("处理完成后自动生成总结")).toBeInTheDocument();
    expect(screen.getByText(/录音已完成 · 后台处理中/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成总结" })).not.toBeInTheDocument();
    expect(window.electronAPI.jarvis.analyzeSession).not.toHaveBeenCalled();
  });

  it("reports incomplete speaker processing instead of blaming MiniMax", async () => {
    const incompleteError = new Error(
      "Error invoking remote method 'jarvis:analysis:run': Error: MEMORY_OWNER_OUT_OF_SCOPE"
    );
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => ({
            ...detailFor(session),
            segments: [visibleSegment],
          })),
          getSessionTimeline: vi.fn(async () => ({
            ...timeline,
            processing_state: "ready",
            ready_at: 3_000,
            segments: [visibleSegment],
          })),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(async () => {
            throw incompleteError;
          }),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    fireEvent.click(await screen.findByRole("button", { name: "生成总结" }));

    expect(
      await screen.findByText("最终转写和说话人识别尚未完成，完成后会自动生成总结。")
    ).toBeInTheDocument();
    expect(screen.queryByText(/请检查 MiniMax 设置/)).not.toBeInTheDocument();
  });

  it("waits for queued cloud analysis and renders the completed summary in the current view", async () => {
    const completedDetail = {
      ...detailFor(session),
      segments: [visibleSegment],
      summary: {
        id: "summary-1",
        session_id: session.id,
        title: "完成的总结",
        summary: "这是后台完成后自动刷新的完整总结。",
        decisions_json: "[]",
        suggestions_json: "[]",
        created_at: 4_000,
      },
    };
    const getSessionDetail = vi
      .fn()
      .mockResolvedValueOnce({ ...detailFor(session), segments: [visibleSegment] })
      .mockResolvedValueOnce(completedDetail);
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => ({
            ...timeline,
            processing_state: "ready",
            ready_at: 3_000,
            segments: [visibleSegment],
          })),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(async () => ({
            sessionId: session.id,
            state: "queued",
            errorCode: null,
            updatedAt: 3_000,
          })),
          getAnalysisStatus: vi.fn(async () => ({
            sessionId: session.id,
            state: "ready",
            errorCode: null,
            updatedAt: 4_000,
          })),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    fireEvent.click(await screen.findByRole("button", { name: "生成总结" }));

    expect(await screen.findByText("这是后台完成后自动刷新的完整总结。")).toBeInTheDocument();
    expect(getSessionDetail).toHaveBeenCalledTimes(2);
  });

  it("refreshes a summary that finishes after the ready session detail first opens", async () => {
    const completedDetail = {
      ...detailFor(session),
      segments: [visibleSegment],
      summary: {
        session_id: session.id,
        summary: "后台恢复完成后，当前详情页自动显示这份总结。",
        decisions_json: "[]",
        suggestions_json: "[]",
        updated_at: 4_000,
        is_final: 1,
      },
    };
    const getSessionDetail = vi
      .fn()
      .mockResolvedValueOnce({ ...detailFor(session), segments: [visibleSegment] })
      .mockResolvedValueOnce(completedDetail);
    const getAnalysisStatus = vi.fn(async () => ({
      sessionId: session.id,
      state: "ready" as const,
      errorCode: null,
      updatedAt: 4_000,
    }));
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => ({
            ...timeline,
            processing_state: "ready",
            ready_at: 3_000,
            segments: [visibleSegment],
          })),
          getAnalysisStatus,
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect(await screen.findByText("尚未生成总结。录音和转写已安全保存。")).toBeInTheDocument();
    expect(
      await screen.findByText("后台恢复完成后，当前详情页自动显示这份总结。", undefined, {
        timeout: 3_000,
      })
    ).toBeInTheDocument();
    expect(getAnalysisStatus).toHaveBeenCalledWith(session.id);
    expect(getSessionDetail).toHaveBeenCalledTimes(2);
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
