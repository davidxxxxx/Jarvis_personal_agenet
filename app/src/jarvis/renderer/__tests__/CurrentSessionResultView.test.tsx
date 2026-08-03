import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisActivityClassification,
  JarvisAnalysisStatus,
  JarvisKnowledgeActionInput,
  JarvisSessionDetail,
  JarvisSessionTimeline,
} from "../../types";
import CurrentSessionResultView from "../CurrentSessionResultView";

vi.mock("../ProcessingStatus", () => ({
  default: () => <div>durable processing status</div>,
}));

const SESSION_ID = "session-result";

function detail(): JarvisSessionDetail {
  return {
    session: {
      id: SESSION_ID,
      started_at: 1_700_000_000_000,
      ended_at: 1_700_000_060_000,
      status: "completed",
      language: "zh",
      created_at: 1_700_000_000_000,
      capture_mode: "dual",
      processing_state: "processing",
    },
    summary: null,
    segments: [
      {
        id: "segment-1",
        session_id: SESSION_ID,
        started_at: 1_700_000_001_000,
        ended_at: 1_700_000_004_000,
        person_id: null,
        speaker_label: "SELF",
        text: "这是一段已经安全保存的最终转写。",
        confidence: 0.96,
        is_stable: 1,
        analysis_state: "ready",
        track_id: "track-chrome",
        source_type: "system",
        result_kind: "final",
        version: 2,
      },
    ],
    audioChunks: [],
    topics: [
      {
        id: "topic-1",
        canonical_title: "项目复盘",
        normalized_title: "项目复盘",
        description: "",
        status: "active",
        created_at: 1,
        last_seen_at: 2,
      },
    ],
    todos: [],
    memories: [
      {
        id: "memory-1",
        type: "fact",
        content: "用户正在复盘项目。",
        person_id: null,
        topic_id: "topic-1",
        confidence: 0.9,
        last_seen_at: 2,
        occurrence_count: 1,
        needs_confirmation: 0,
      },
    ],
    speakerProcessing: {
      preferredInputVersion: 2,
      latestRuns: [],
      history: [],
      speakers: [],
      participants: {
        count: {
          minimum: 1,
          maximum: 1,
          confirmed: 1,
          needsReview: 0,
          selfIncluded: true,
        },
        participants: [],
        mediaVoices: [],
        excluded: { fragmented: 0, shadowedSystemMix: 0, anomaly: false },
      },
      participantSnapshot: {
        id: "snapshot-1",
        revision: 1,
        sourceHash: "hash",
        createdAt: 2,
      },
      fragmentedEvidenceCount: 0,
      summaryRefresh: null,
      reprocessing: null,
    },
  };
}

function timeline(): JarvisSessionTimeline {
  return {
    session_id: SESSION_ID,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_060_000,
    status: "completed",
    processing_state: "processing",
    timeline_version: 3,
    finalized_at: 1_700_000_060_000,
    ready_at: null,
    tracks: [
      {
        id: "track-chrome",
        session_id: SESSION_ID,
        source_type: "system",
        track_kind: "application",
        application_key: "chrome",
        application_display_name: "Chrome",
        attribution_state: "exact",
        capture_generation: 1,
        sample_rate: 16_000,
        channels: 1,
        started_at: 1_700_000_000_000,
        ended_at: 1_700_000_060_000,
        state: "completed",
        gaps: [],
      },
    ],
    application_audio_intervals: [],
    application_capture: {
      exact_duration_ms: 55_000,
      fallback_duration_ms: 5_000,
      exact_coverage_pct: 92,
      degraded_intervals: [],
      recovery_points: [],
      degraded_interval_count: 1,
      recovery_count: 1,
    },
    gaps: [],
    chunks: [],
    segments: detail().segments,
    processing_counts: {
      pending: 1,
      leased: 0,
      retry: 0,
      blocked: 0,
      completed: 4,
      total: 5,
    },
  };
}

const blockedAnalysis: JarvisAnalysisStatus = {
  sessionId: SESSION_ID,
  state: "blocked",
  errorCode: "invalid_response",
  updatedAt: 1_700_000_061_000,
};

const activity: JarvisActivityClassification = {
  id: "activity-1",
  sessionId: SESSION_ID,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  category: "work_meeting",
  confidence: 0.91,
  decision: "adopted",
  source: "minimax",
  reason: "project discussion",
  sourceAttribution: "application_and_microphone",
  applications: ["Chrome"],
  allowSummary: true,
  allowSuggestions: true,
  allowTodos: true,
  evidenceSegmentIds: ["segment-1"],
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CurrentSessionResultView", () => {
  it("keeps local results visible across three tabs and requires confirmation for a paid retry", async () => {
    const analyzeSession = vi.fn(async () => ({
      ...blockedAnalysis,
      state: "queued" as const,
      errorCode: null,
    }));
    const startNewRecording = vi.fn(async () => {});
    const applyKnowledgeAction = vi.fn(async (input: JarvisKnowledgeActionInput) => ({
      status: "applied" as const,
      commandId: input.commandId,
      type: input.type,
      entityKind: "todo" as const,
      entityId: "todo-created",
      occurredAt: Date.now(),
      todoId: "todo-created",
    }));
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detail()),
          getSessionTimeline: vi.fn(async () => timeline()),
          getSessionTimelineStatus: vi.fn(async () => ({
            session_id: SESSION_ID,
            status: "completed" as const,
            processing_state: "processing" as const,
            timeline_version: 3,
            finalized_at: 1_700_000_060_000,
            ready_at: null,
            processing_counts: timeline().processing_counts,
          })),
          getAnalysisStatus: vi.fn(async () => blockedAnalysis),
          listActivityClassifications: vi.fn(async () => [activity]),
          analyzeSession,
          applyKnowledgeAction,
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="completed"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={startNewRecording}
        onDurableResultChange={vi.fn()}
      />
    );

    expect(screen.getByText("音频已安全保存")).toBeInTheDocument();
    expect(await screen.findByText("最终转写已完成")).toBeInTheDocument();
    expect(await screen.findByText("项目复盘")).toBeInTheDocument();
    expect(
      screen.getAllByText("MiniMax 返回的数据格式无效。本地转写和人物结果仍已保留。")
    ).not.toHaveLength(0);

    const summaryTab = screen.getByRole("tab", { name: "总结" });
    const transcriptTab = screen.getByRole("tab", { name: /完整转写/ });
    const processingTab = screen.getByRole("tab", { name: "处理详情" });
    expect(summaryTab).toHaveAttribute("tabindex", "0");
    expect(transcriptTab).toHaveAttribute("tabindex", "-1");
    summaryTab.focus();
    fireEvent.keyDown(summaryTab, { key: "ArrowRight" });
    expect(transcriptTab).toHaveFocus();
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(transcriptTab, { key: "End" });
    expect(processingTab).toHaveFocus();
    fireEvent.keyDown(processingTab, { key: "Home" });
    expect(summaryTab).toHaveFocus();

    fireEvent.click(transcriptTab);
    expect(screen.getByText("Chrome")).toBeInTheDocument();
    expect(screen.getByText("SELF")).toBeInTheDocument();
    expect(screen.getByText("这是一段已经安全保存的最终转写。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "从该转写创建 Todo" }));
    expect(screen.getByLabelText("待办标题")).toHaveValue("");
    expect(screen.getByRole("button", { name: "创建待办" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("待办标题"), {
      target: { value: "整理本次复盘" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(applyKnowledgeAction).toHaveBeenCalledTimes(1));
    const transcriptAction = applyKnowledgeAction.mock.calls[0][0];
    expect(transcriptAction).toEqual(
      expect.objectContaining({
        type: "transcript_create",
        sessionId: SESSION_ID,
        segmentIds: ["segment-1"],
        title: "整理本次复盘",
        dueText: null,
      })
    );
    expect(transcriptAction).not.toHaveProperty("quote");
    expect(transcriptAction).not.toHaveProperty("evidence");
    expect(transcriptAction).not.toHaveProperty("text");

    fireEvent.click(screen.getByRole("tab", { name: "处理详情" }));
    expect(screen.getByText("durable processing status")).toBeInTheDocument();
    expect(screen.getByText(/精确应用来源覆盖 92%/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "总结" }));
    fireEvent.click(screen.getByRole("button", { name: "付费重试 MiniMax 总结" }));
    expect(screen.getByText(/可能再次产生费用/)).toBeInTheDocument();
    expect(analyzeSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认付费重试" }));
    await waitFor(() => expect(analyzeSession).toHaveBeenCalledWith(SESSION_ID, "final"));

    fireEvent.click(screen.getByRole("button", { name: "开始下一次录音" }));
    await waitFor(() => expect(startNewRecording).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "开始下一次录音" })).toBeEnabled();
    view.unmount();
  });

  it("removes superseded segments across mixed old and new snapshots", async () => {
    const staleDetail = detail();
    const staleSegment = {
      ...staleDetail.segments[0],
      id: "segment-stale",
      text: "这段过期文字绝不能显示",
      version: 1,
      superseded_by: null,
    };
    staleDetail.segments = [staleSegment];
    const mixedTimeline = {
      ...timeline(),
      processing_state: "ready" as const,
      ready_at: 1_700_000_061_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 5,
        total: 5,
      },
      segments: [
        {
          ...staleSegment,
          version: 2,
          superseded_by: "segment-current",
        },
        {
          ...staleSegment,
          id: "segment-current",
          text: "这是唯一有效的新转写",
          version: 3,
          superseded_by: null,
        },
      ],
    };
    const readyAnalysis: JarvisAnalysisStatus = {
      sessionId: SESSION_ID,
      state: "ready",
      errorCode: null,
      updatedAt: 1_700_000_061_000,
    };
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail: vi.fn(async () => staleDetail),
          getSessionTimeline: vi.fn(async () => mixedTimeline),
          getSessionTimelineStatus: vi.fn(async () => ({
            session_id: SESSION_ID,
            status: "completed" as const,
            processing_state: "ready" as const,
            timeline_version: mixedTimeline.timeline_version,
            finalized_at: mixedTimeline.finalized_at,
            ready_at: mixedTimeline.ready_at,
            processing_counts: mixedTimeline.processing_counts,
          })),
          getAnalysisStatus: vi.fn(async () => readyAnalysis),
          listActivityClassifications: vi.fn(async () => []),
          analyzeSession: vi.fn(async () => readyAnalysis),
          applyKnowledgeAction: vi.fn(),
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="completed"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={vi.fn()}
        onDurableResultChange={vi.fn()}
      />
    );
    await screen.findByText("最终转写已完成");
    fireEvent.click(screen.getByRole("tab", { name: /完整转写/ }));
    expect(screen.queryByText("这段过期文字绝不能显示")).not.toBeInTheDocument();
    expect(screen.getByText("这是唯一有效的新转写")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "从该转写创建 Todo" })).toHaveLength(1);
    view.unmount();
  });

  it("treats a ready incremental summary as a stable partial result until paid refresh", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const partialDetail = detail();
    partialDetail.summary = {
      session_id: SESSION_ID,
      summary: "这是仍会继续更新的增量总结。",
      decisions_json: "[]",
      suggestions_json: "[]",
      updated_at: 1_700_000_061_000,
      is_final: 0,
    };
    const readyTimeline = {
      ...timeline(),
      processing_state: "ready" as const,
      ready_at: 1_700_000_061_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 5,
        total: 5,
      },
    };
    const statusPoll = vi.fn(async () => ({
      session_id: SESSION_ID,
      status: "completed" as const,
      processing_state: "ready" as const,
      timeline_version: readyTimeline.timeline_version,
      finalized_at: readyTimeline.finalized_at,
      ready_at: readyTimeline.ready_at,
      processing_counts: readyTimeline.processing_counts,
    }));
    const getSessionDetail = vi.fn<() => Promise<JarvisSessionDetail>>(async () => partialDetail);
    const stableStatus: JarvisAnalysisStatus = {
      sessionId: SESSION_ID,
      state: "ready",
      errorCode: null,
      updatedAt: 1_700_000_061_000,
    };
    const queuedStatus: JarvisAnalysisStatus = {
      ...stableStatus,
      state: "queued",
      updatedAt: 1_700_000_062_000,
    };
    const getAnalysisStatus = vi.fn<() => Promise<JarvisAnalysisStatus>>(async () => stableStatus);
    const analyzeSession = vi.fn(async () => queuedStatus);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => readyTimeline),
          getSessionTimelineStatus: statusPoll,
          getAnalysisStatus,
          listActivityClassifications: vi.fn(async () => []),
          analyzeSession,
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="completed"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={vi.fn()}
        onDurableResultChange={vi.fn()}
      />
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("这是仍会继续更新的增量总结。")).toBeVisible();
    expect(screen.getByText("MiniMax 阶段性总结已保存")).toBeVisible();
    expect(screen.getByRole("heading", { name: "阶段性总结（覆盖不完整）" })).toBeVisible();
    expect(screen.getByText(/不代表完整最终总结/)).toBeVisible();
    expect(screen.getByRole("button", { name: "付费刷新最终总结" })).toBeEnabled();
    expect(getSessionDetail).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(statusPoll).not.toHaveBeenCalled();
    expect(getAnalysisStatus).toHaveBeenCalledTimes(1);
    expect(getSessionDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "付费刷新最终总结" }));
    expect(screen.getByText(/可能再次产生费用/)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认付费重试" }));
    });
    expect(analyzeSession).toHaveBeenCalledWith(SESSION_ID, "final");
    view.unmount();
  });

  it("continues polling a finalizing session with a temporarily ready incremental summary", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const partialDetail = detail();
    partialDetail.summary = {
      session_id: SESSION_ID,
      summary: "这是关闭录音期间的阶段性总结。",
      decisions_json: "[]",
      suggestions_json: "[]",
      updated_at: 1_700_000_061_000,
      is_final: 0,
    };
    const readyTimeline = {
      ...timeline(),
      processing_state: "ready" as const,
      ready_at: 1_700_000_061_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 5,
        total: 5,
      },
    };
    const statusPoll = vi.fn(async () => ({
      session_id: SESSION_ID,
      status: "completed" as const,
      processing_state: "ready" as const,
      timeline_version: readyTimeline.timeline_version,
      finalized_at: readyTimeline.finalized_at,
      ready_at: readyTimeline.ready_at,
      processing_counts: readyTimeline.processing_counts,
    }));
    const readyStatus: JarvisAnalysisStatus = {
      sessionId: SESSION_ID,
      state: "ready",
      errorCode: null,
      updatedAt: 1_700_000_061_000,
    };
    const getAnalysisStatus = vi.fn(async () => readyStatus);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail: vi.fn(async () => partialDetail),
          getSessionTimeline: vi.fn(async () => readyTimeline),
          getSessionTimelineStatus: statusPoll,
          getAnalysisStatus,
          listActivityClassifications: vi.fn(async () => []),
          analyzeSession: vi.fn(),
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="finalizing"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={vi.fn()}
        onDurableResultChange={vi.fn()}
      />
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("MiniMax 阶段性总结已保存")).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(statusPoll).toHaveBeenCalledTimes(1);
    expect(getAnalysisStatus).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("retries a failed detail read even when the durable timeline and analysis are unchanged", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const readyTimeline = {
      ...timeline(),
      processing_state: "ready" as const,
      ready_at: 1_700_000_061_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 5,
        total: 5,
      },
    };
    const getSessionDetail = vi
      .fn<() => Promise<JarvisSessionDetail>>()
      .mockRejectedValueOnce(new Error("temporary detail read failure"))
      .mockResolvedValue(detail());
    const getSessionTimeline = vi.fn(async () => readyTimeline);
    const getSessionTimelineStatus = vi.fn();
    const getAnalysisStatus = vi.fn(async () => blockedAnalysis);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline,
          getSessionTimelineStatus,
          getAnalysisStatus,
          listActivityClassifications: vi.fn(async () => []),
          analyzeSession: vi.fn(),
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="completed"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={vi.fn()}
        onDurableResultChange={vi.fn()}
      />
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getSessionDetail).toHaveBeenCalledTimes(1);
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/本地结果暂时读取失败/)).toBeVisible();
    expect(screen.queryByText("项目复盘")).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(getSessionDetail).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(getSessionDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByText("项目复盘")).toBeVisible();
    expect(screen.queryByText(/本地结果暂时读取失败/)).not.toBeInTheDocument();
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    expect(getSessionTimelineStatus).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(getSessionDetail).toHaveBeenCalledTimes(2);
    expect(getAnalysisStatus).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("retries activity and runtime reads independently with capped backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const readyTimeline = {
      ...timeline(),
      processing_state: "ready" as const,
      ready_at: 1_700_000_061_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 5,
        total: 5,
      },
    };
    const listActivityClassifications = vi
      .fn<() => Promise<JarvisActivityClassification[]>>()
      .mockRejectedValueOnce(new Error("activity read 1"))
      .mockRejectedValueOnce(new Error("activity read 2"))
      .mockRejectedValueOnce(new Error("activity read 3"))
      .mockRejectedValueOnce(new Error("activity read 4"))
      .mockRejectedValueOnce(new Error("activity read 5"))
      .mockRejectedValueOnce(new Error("activity read 6"))
      .mockResolvedValue([activity]);
    const getRuntimeStatus = vi
      .fn<() => Promise<null>>()
      .mockRejectedValueOnce(new Error("runtime read failure"))
      .mockResolvedValue(null);
    const getSessionTimeline = vi.fn(async () => readyTimeline);
    const getSessionTimelineStatus = vi.fn();
    const getAnalysisStatus = vi.fn(async () => blockedAnalysis);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detail()),
          getSessionTimeline,
          getSessionTimelineStatus,
          getAnalysisStatus,
          listActivityClassifications,
          getRuntimeStatus,
          analyzeSession: vi.fn(),
        },
      },
    });

    const view = render(
      <CurrentSessionResultView
        sessionId={SESSION_ID}
        sessionStatus="completed"
        startedAt={1_700_000_000_000}
        durationMs={60_000}
        onStartNewRecording={vi.fn()}
        onDurableResultChange={vi.fn()}
      />
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("项目复盘")).toBeVisible();
    expect(listActivityClassifications).toHaveBeenCalledTimes(1);
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(listActivityClassifications).toHaveBeenCalledTimes(2);
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("项目复盘")).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(listActivityClassifications).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(listActivityClassifications).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(24_000));
    expect(listActivityClassifications).toHaveBeenCalledTimes(5);

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(listActivityClassifications).toHaveBeenCalledTimes(5);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(listActivityClassifications).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(listActivityClassifications).toHaveBeenCalledTimes(7);
    expect(screen.getByText(/工作会议 · 91%/)).toBeVisible();
    expect(screen.queryByText(/本地结果暂时读取失败/)).not.toBeInTheDocument();
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    expect(getSessionTimelineStatus).not.toHaveBeenCalled();
    expect(getAnalysisStatus).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
