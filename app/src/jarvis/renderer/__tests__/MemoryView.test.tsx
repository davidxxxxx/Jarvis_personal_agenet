import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type {
  JarvisSession,
  JarvisSessionDetail,
  JarvisParticipantReviewEvent,
  JarvisParticipantReviewInput,
  JarvisRuntimeStatus,
  JarvisSessionParticipant,
  JarvisSessionParticipantProjection,
  JarvisSessionSpeakerProcessing,
  JarvisSessionTimeline,
  JarvisSpeakerClusterView,
  JarvisTranscriptSegment,
} from "../../types";
import MemoryView, { groupConfirmedSpeakerPeople } from "../MemoryView";
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
    speakerProcessing: null,
  };
}

function reviewCluster(
  id: string,
  localLabel: string,
  options: Partial<JarvisSpeakerClusterView> = {}
): JarvisSpeakerClusterView {
  return {
    id,
    sessionId: session.id,
    trackId: "mic-track",
    localLabel,
    linkState: "unknown",
    person: null,
    suggestedPerson: null,
    lastRejectedPerson: null,
    score: null,
    margin: null,
    candidatePersonRef: null,
    speechMs: 12_000,
    windowCount: 4,
    qualityScore: 0.86,
    reason: "no_candidate",
    policyId: "hybrid-v2",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    evidenceSegmentIds: [],
    canUndo: false,
    updatedAt: 4_000,
    ...options,
  };
}

function reviewParticipant(
  cluster: JarvisSpeakerClusterView,
  displayName: string,
  options: Partial<JarvisSessionParticipant> = {}
): JarvisSessionParticipant {
  return {
    id: `temporary:${cluster.id}`,
    kind: "temporary",
    displayName,
    person: null,
    candidatePersonRef: null,
    reviewState: "needs_review",
    durable: false,
    speechMs: cluster.speechMs,
    segmentCount: cluster.evidenceSegmentIds.length,
    clusterCount: 1,
    clusterIds: [cluster.id],
    segmentIds: [...cluster.evidenceSegmentIds],
    sourceNames: ["麦克风"],
    minimumCount: 1,
    maximumCount: 1,
    score: cluster.score,
    representativeSegments: cluster.evidenceSegmentIds.map((segmentId, index) => ({
      clusterId: cluster.id,
      id: segmentId,
      started_at: 1_200 + index * 500,
      ended_at: 1_500 + index * 500,
      text: `${displayName} 的代表片段 ${index + 1}`,
      confidence: 0.92,
      track_id: cluster.trackId,
      source_type: "mic",
      result_kind: "final",
      duplicate_of: null,
      sourceName: "麦克风",
    })),
    representativeCluster: cluster,
    ...options,
  };
}

function reviewProjection(
  participants: JarvisSessionParticipant[],
  mediaVoices: JarvisSessionParticipant[] = []
): JarvisSessionParticipantProjection {
  return {
    count: {
      minimum: participants.reduce((sum, participant) => sum + participant.minimumCount, 0),
      maximum: participants.reduce((sum, participant) => sum + participant.maximumCount, 0),
      confirmed: participants.filter((participant) => participant.reviewState === "confirmed")
        .length,
      needsReview: participants.filter((participant) => participant.reviewState === "needs_review")
        .length,
      selfIncluded: participants.some((participant) => participant.kind === "self"),
    },
    participants,
    mediaVoices,
    excluded: {
      fragmented: 0,
      shadowedSystemMix: 0,
      anomaly: false,
    },
  };
}

function reviewSpeakerProcessing(
  participants: JarvisSessionParticipant[],
  mediaVoices: JarvisSessionParticipant[] = []
): JarvisSessionSpeakerProcessing {
  const speakers = [...participants, ...mediaVoices].flatMap((participant) =>
    participant.clusterIds.includes(participant.representativeCluster.id)
      ? [participant.representativeCluster]
      : []
  );
  return {
    preferredInputVersion: 2,
    latestRuns: [],
    history: [],
    speakers,
    participants: reviewProjection(participants, mediaVoices),
    participantSnapshot: null,
    fragmentedEvidenceCount: 0,
    summaryRefresh: null,
    reprocessing: null,
  };
}

function participantReviewEvent(
  id: string,
  action:
    | JarvisParticipantReviewEvent["action"]
    | "split"
    | "forget_identity"
    | "pin_evidence"
    | "unpin_evidence"
): JarvisParticipantReviewEvent {
  return {
    id,
    sessionId: session.id,
    action: action as JarvisParticipantReviewEvent["action"],
    createdAt: 5_000,
    canUndo: action !== "undo",
  };
}

function installParticipantReviewApi(
  speakerProcessing: JarvisSessionSpeakerProcessing,
  overrides: Record<string, unknown> = {}
) {
  const api = {
    getSessionDetail: vi.fn(async () => ({
      ...detailFor(session),
      summary: {
        session_id: session.id,
        summary: "人物复核测试总结",
        decisions_json: "[]",
        suggestions_json: "[]",
        updated_at: 4_000,
        is_final: 1,
      },
      segments: [visibleSegment],
      speakerProcessing,
    })),
    getSessionTimeline: vi.fn(async () => ({
      ...timeline,
      processing_state: "ready" as const,
      ready_at: 4_000,
      segments: [visibleSegment],
    })),
    listSessionSpeakerClusters: vi.fn(async () => speakerProcessing.speakers),
    previewParticipantReview: vi.fn(),
    applyParticipantReview: vi.fn(),
    undoParticipantReview: vi.fn(),
    listParticipantReviewHistory: vi.fn(async () => []),
    readAudioChunk: vi.fn(),
    searchMemory: vi.fn(),
    analyzeSession: vi.fn(),
    ...overrides,
  };
  Object.assign(window, { electronAPI: { jarvis: api } });
  return api;
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

describe("MemoryView speaker people projection", () => {
  it("shows one person row for multiple confirmed clusters linked to the same person", () => {
    const base: JarvisSpeakerClusterView = {
      id: "cluster-self-1",
      sessionId: session.id,
      trackId: "mic-track",
      localLabel: "说话人 1",
      linkState: "confirmed",
      person: { id: "self", displayName: "我", isSelf: true },
      suggestedPerson: null,
      lastRejectedPerson: null,
      score: null,
      margin: null,
      candidatePersonRef: null,
      speechMs: 8_000,
      windowCount: 3,
      qualityScore: 0.9,
      reason: "user_confirmed",
      policyId: "hybrid-v2",
      diarizationRevision: "a".repeat(64),
      profileRevision: "b".repeat(64),
      evidenceSegmentIds: ["segment-1"],
      canUndo: true,
      updatedAt: 4_000,
    };

    const groups = groupConfirmedSpeakerPeople([
      base,
      {
        ...base,
        id: "cluster-self-2",
        localLabel: "说话人 2",
        evidenceSegmentIds: ["segment-2"],
        updatedAt: 5_000,
      },
      {
        ...base,
        id: "cluster-unknown",
        localLabel: "说话人 3",
        linkState: "unknown",
        person: null,
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: "person:self",
      clusterCount: 2,
      localLabels: ["说话人 1", "说话人 2"],
    });
    expect(groups[1]).toMatchObject({
      key: "cluster:cluster-unknown",
      clusterCount: 1,
      localLabels: ["说话人 3"],
    });
  });
});

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
        if (delay === 5_000) {
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
    expect(screen.getByRole("heading", { name: "完整总结" }).closest("section")).toHaveClass(
      "order-1"
    );
    expect(screen.getByRole("heading", { name: "说话人与声纹" }).closest("section")).toHaveClass(
      "order-2"
    );
    expect(screen.getByRole("heading", { name: "录音与转写" }).closest("section")).toHaveClass(
      "order-5"
    );
    const processingDetails = screen.getByText("处理详情与后台进度").closest("details");
    expect(processingDetails).toHaveClass("order-4");
    expect(processingDetails).toHaveAttribute("open");
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5_000));

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

  it("polls compact session status without reloading the paged timeline", async () => {
    const getSessionTimeline = vi.fn(async () => timeline);
    const getSessionTimelineStatus = vi.fn(async () => ({
      session_id: session.id,
      status: session.status,
      processing_state: "processing" as const,
      timeline_version: 2,
      finalized_at: 2_000,
      ready_at: null,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 1,
        blocked: 0,
        completed: 0,
        total: 1,
      },
    }));
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => detailFor(session)),
          getSessionTimeline,
          getSessionTimelineStatus,
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

    await act(async () => {
      poll?.();
      await Promise.resolve();
    });

    expect(getSessionTimelineStatus).toHaveBeenCalledTimes(1);
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/等待重试 1/)).toBeInTheDocument();
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

  it("ignores a late source-page response after opening another session", async () => {
    const sessionB: JarvisSession = {
      ...session,
      id: "session-2",
      started_at: 2_000_000,
      ended_at: 2_001_000,
    };
    const pageA = deferred<JarvisSessionTimeline>();
    const timelineA: JarvisSessionTimeline = {
      ...timeline,
      tracks: [
        {
          id: "track-a",
          session_id: session.id,
          source_type: "system",
          track_kind: "application",
          application_key: "chrome",
          application_display_name: "会话 A 音轨",
          attribution_state: "exact",
          capture_generation: 1,
          sample_rate: 24_000,
          channels: 1,
          started_at: session.started_at,
          ended_at: session.ended_at,
          state: "ended",
          gaps: [],
        },
      ],
      evidence_page: {
        tracks: { total: 2, offset: 0, limit: 1 },
        intervals: { total: 0, offset: 0, limit: 200 },
      },
    };
    const timelineB: JarvisSessionTimeline = {
      ...timeline,
      session_id: sessionB.id,
      started_at: sessionB.started_at,
      ended_at: sessionB.ended_at,
      tracks: [
        {
          ...timelineA.tracks[0],
          id: "track-b",
          session_id: sessionB.id,
          application_key: "kook",
          application_display_name: "会话 B 音轨",
          started_at: sessionB.started_at,
          ended_at: sessionB.ended_at,
        },
      ],
      evidence_page: {
        tracks: { total: 1, offset: 0, limit: 1 },
        intervals: { total: 0, offset: 0, limit: 200 },
      },
    };
    const stalePageA: JarvisSessionTimeline = {
      ...timelineA,
      tracks: [
        {
          ...timelineA.tracks[0],
          id: "track-a-stale",
          application_display_name: "过期的 A 音轨",
        },
      ],
      evidence_page: {
        tracks: { total: 2, offset: 1, limit: 1 },
        intervals: { total: 0, offset: 0, limit: 200 },
      },
    };
    const getSessionTimeline = vi.fn((sessionId: string, page?: { trackOffset?: number }) => {
      if (sessionId === session.id && page) return pageA.promise;
      return Promise.resolve(sessionId === session.id ? timelineA : timelineB);
    });
    useJarvisStore.setState({ sessions: [session, sessionB] });
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async (sessionId: string) =>
            detailFor(sessionId === session.id ? session : sessionB)
          ),
          getSessionTimeline,
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    let recordingButtons = screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("的录音"));
    fireEvent.click(recordingButtons[0]);
    expect(await screen.findByText("会话 A 音轨")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(getSessionTimeline).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ trackOffset: 1 })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "返回记忆库" }));
    recordingButtons = screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("的录音"));
    fireEvent.click(recordingButtons[1]);
    expect(await screen.findByText("会话 B 音轨")).toBeInTheDocument();

    await act(async () => {
      pageA.resolve(stalePageA);
      await Promise.resolve();
    });

    expect(screen.getByText("会话 B 音轨")).toBeInTheDocument();
    expect(screen.queryByText("过期的 A 音轨")).not.toBeInTheDocument();
  });

  it("polls hidden runtime status at most once per 15 seconds and never overlaps IPC", async () => {
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
      if (delay === 15_000) {
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
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);

      act(() => runtimePoll?.());
      act(() => runtimePoll?.());
      expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingPoll.resolve({ ...runtimeStatus, observedAt: 102_000 });
        await Promise.resolve();
      });
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 15_000);

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

  it("shows final speaker count, SELF status, local naming entry, and opt-in paid refresh", async () => {
    const speakers: JarvisSpeakerClusterView[] = [
      {
        id: "cluster-self",
        sessionId: session.id,
        trackId: "mic-track",
        localLabel: "说话人 1",
        linkState: "confirmed" as const,
        person: { id: "self", displayName: "我", isSelf: true },
        suggestedPerson: null,
        lastRejectedPerson: null,
        score: 0.97,
        margin: 0.25,
        candidatePersonRef: null,
        speechMs: 30_000,
        windowCount: 12,
        qualityScore: 0.94,
        reason: "dual_model_match",
        policyId: "hybrid-v2",
        diarizationRevision: "a".repeat(64),
        profileRevision: "b".repeat(64),
        evidenceSegmentIds: [visibleSegment.id],
        canUndo: false,
        updatedAt: 4_000,
      },
      {
        id: "cluster-unknown",
        sessionId: session.id,
        trackId: "mic-track",
        localLabel: "说话人 2",
        linkState: "unknown" as const,
        person: null,
        suggestedPerson: null,
        lastRejectedPerson: null,
        score: null,
        margin: null,
        candidatePersonRef: null,
        speechMs: 8_000,
        windowCount: 3,
        qualityScore: 0.76,
        reason: "no_candidate",
        policyId: "hybrid-v2",
        diarizationRevision: "c".repeat(64),
        profileRevision: "d".repeat(64),
        evidenceSegmentIds: [],
        canUndo: false,
        updatedAt: 4_000,
      },
    ];
    const completedDetail: JarvisSessionDetail = {
      ...detailFor(session),
      segments: [visibleSegment],
      speakerProcessing: {
        preferredInputVersion: 2,
        latestRuns: [
          {
            id: "run-v2",
            trackId: "mic-track",
            policyId: "hybrid-v2",
            inputVersion: 2,
            executionDevice: "cuda",
            speakerCount: {
              minimum: 2,
              maximum: 3,
              preferred: 2,
              confidence: 0.82,
              state: "models_disagree",
            },
            overlapMs: 900,
            overlapSeparationState: "completed",
            modelPackVersion: "jarvis-ai-model-pack-2026.07.1",
            models: ["pyannote/speaker-diarization-community-1"],
            commitSequence: 2,
            completedAt: 4_000,
          },
        ],
        history: [],
        speakers,
        participants: {
          count: {
            minimum: 2,
            maximum: 2,
            confirmed: 1,
            needsReview: 1,
            selfIncluded: true,
          },
          participants: [
            {
              id: "self",
              kind: "self",
              displayName: "我",
              person: speakers[0].person,
              candidatePersonRef: null,
              reviewState: "confirmed",
              durable: true,
              speechMs: 30_000,
              segmentCount: 1,
              clusterCount: 1,
              clusterIds: [speakers[0].id],
              segmentIds: [visibleSegment.id],
              sourceNames: ["麦克风"],
              minimumCount: 1,
              maximumCount: 1,
              score: 0.97,
              representativeSegments: [],
              representativeCluster: speakers[0],
            },
            {
              id: "temporary:cluster-unknown",
              kind: "temporary",
              displayName: "人物 B",
              person: null,
              candidatePersonRef: null,
              reviewState: "needs_review",
              durable: false,
              speechMs: 8_000,
              segmentCount: 0,
              clusterCount: 1,
              clusterIds: [speakers[1].id],
              segmentIds: [],
              sourceNames: ["麦克风"],
              minimumCount: 1,
              maximumCount: 1,
              score: null,
              representativeSegments: [],
              representativeCluster: speakers[1],
            },
          ],
          mediaVoices: [],
          excluded: {
            fragmented: 0,
            shadowedSystemMix: 0,
            anomaly: false,
          },
        },
        participantSnapshot: null,
        fragmentedEvidenceCount: 229,
        summaryRefresh: {
          basis_policy_id: "legacy-v1",
          latest_policy_id: "hybrid-v2",
          recommended: 1,
          reason: "speaker_count_changed",
          updated_at: 4_000,
        },
        reprocessing: {
          policy_id: "hybrid-v2",
          mode: "historical_local_only",
          state: "completed",
          started_at: 3_000,
          completed_at: 4_000,
        },
      },
    };
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => completedDetail),
          getSessionTimeline: vi.fn(async () => ({
            ...timeline,
            processing_state: "ready",
            ready_at: 4_000,
            tracks: [
              {
                id: "mic-track",
                session_id: session.id,
                source_type: "mic",
                track_kind: "mic",
                application_key: null,
                application_display_name: null,
                attribution_state: "exact",
                capture_generation: 0,
                sample_rate: 16_000,
                channels: 1,
                started_at: session.started_at,
                ended_at: session.ended_at,
                state: "completed",
                gaps: [],
              },
            ],
            segments: [visibleSegment],
          })),
          listSessionSpeakerClusters: vi.fn(async () => speakers),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect(await screen.findByText("预计 2 人；我 + 1 位其他参与者")).toBeInTheDocument();
    expect(screen.getByText("已确认 1")).toBeInTheDocument();
    expect(screen.getByText("待复核 1")).toBeInTheDocument();
    expect(screen.getByText(/本人声纹已确认/)).toBeInTheDocument();
    expect(screen.getByText("人物 B")).toBeInTheDocument();
    expect(screen.getByText(/已隐藏 229 个过短或重复的声纹碎片/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未知说话人" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "付费刷新总结" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("处理详情与后台进度"));
    expect(screen.getByText("CUDA")).toBeInTheDocument();
    expect(screen.getByText("重叠分离：completed")).toBeInTheDocument();
  });

  it("shows a review warning instead of an implausible range for anomalous legacy clusters", async () => {
    const cluster = reviewCluster("cluster-anomalous", "说话人 1");
    const participant = reviewParticipant(cluster, "人物 A", {
      maximumCount: 46,
    });
    const processing = reviewSpeakerProcessing([participant]);
    processing.participants.excluded.anomaly = true;
    const completedTimeline: JarvisSessionTimeline = {
      ...timeline,
      processing_state: "ready",
      ready_at: 4_000,
      processing_counts: {
        pending: 0,
        leased: 0,
        retry: 0,
        blocked: 0,
        completed: 1,
        total: 1,
      },
    };
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail: vi.fn(async () => ({
            ...detailFor(session),
            speakerProcessing: processing,
          })),
          getSessionTimeline: vi.fn(async () => completedTimeline),
          listSessionSpeakerClusters: vi.fn(async () => [cluster]),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));

    expect(
      await screen.findByText("历史声纹异常，人数需重新复核")
    ).toBeInTheDocument();
    expect(screen.queryByText(/预计 1–46 人/)).not.toBeInTheDocument();
  });
});

describe("MemoryView participant review actions", () => {
  beforeEach(() => {
    useJarvisStore.setState({
      sessions: [session],
      clustersBySession: {},
      selectedSessionId: null,
      evidenceNavigation: { phase: "idle", requestId: 0 },
    });
  });

  it("previews, applies, and undoes a merge while replacing the visible participant projection", async () => {
    const firstCluster = reviewCluster("cluster-a", "说话人 1", {
      evidenceSegmentIds: ["evidence-a"],
    });
    const secondCluster = reviewCluster("cluster-b", "说话人 2", {
      evidenceSegmentIds: ["evidence-b"],
    });
    const firstParticipant = reviewParticipant(firstCluster, "人物 A");
    const secondParticipant = reviewParticipant(secondCluster, "人物 B");
    const initialProcessing = reviewSpeakerProcessing([firstParticipant, secondParticipant]);
    const mergedCluster = reviewCluster("cluster-a", "人物 3", {
      evidenceSegmentIds: ["evidence-a", "evidence-b"],
      speechMs: 24_000,
      windowCount: 8,
    });
    const mergedParticipant = reviewParticipant(mergedCluster, "人物 3", {
      id: "anonymous:person-3",
      kind: "anonymous",
      reviewState: "confirmed",
      durable: true,
      speechMs: 24_000,
      segmentCount: 2,
      clusterCount: 2,
      clusterIds: [firstCluster.id, secondCluster.id],
      representativeSegments: [
        ...firstParticipant.representativeSegments,
        ...secondParticipant.representativeSegments,
      ],
    });
    const mergedProcessing = reviewSpeakerProcessing([mergedParticipant]);
    const input: JarvisParticipantReviewInput = {
      sessionId: session.id,
      action: "merge",
      clusterIds: [firstCluster.id, secondCluster.id],
    };
    const previewParticipantReview = vi.fn(async () => ({
      sessionId: session.id,
      action: "merge" as const,
      clusterIds: input.clusterIds,
      affectedClusterCount: 2,
      affectedSegmentCount: 2,
      affectedPersonIds: [],
      canUndo: true,
    }));
    const applyParticipantReview = vi.fn(async () => ({
      event: participantReviewEvent("review-merge", "merge"),
      speakerProcessing: mergedProcessing,
    }));
    const undoParticipantReview = vi.fn(async () => ({
      event: participantReviewEvent("review-merge-undo", "undo"),
      speakerProcessing: initialProcessing,
    }));
    installParticipantReviewApi(initialProcessing, {
      previewParticipantReview,
      applyParticipantReview,
      undoParticipantReview,
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByText("人物 A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择合并 人物 A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择合并 人物 B" }));
    fireEvent.click(screen.getByRole("button", { name: "确认是同一人" }));

    await waitFor(() => expect(previewParticipantReview).toHaveBeenCalledWith(input));
    expect(await screen.findByText("确认人物修正")).toBeInTheDocument();
    expect(screen.getByText(/影响 2 个声纹簇和 2 条转写证据/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));

    await waitFor(() => expect(applyParticipantReview).toHaveBeenCalledWith(input));
    expect(await screen.findByText("人物 3")).toBeInTheDocument();
    expect(screen.queryByText("人物 B")).not.toBeInTheDocument();
    expect(screen.getByText("人物修正已保存；会话人数和媒体排除已重新计算。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(undoParticipantReview).toHaveBeenCalledWith("review-merge"));
    expect(await screen.findByText("人物 B")).toBeInTheDocument();
    expect(
      screen.queryByText("人物修正已保存；会话人数和媒体排除已重新计算。")
    ).not.toBeInTheDocument();
  });

  it("marks a participant as media and can restore it to the social participant list", async () => {
    const cluster = reviewCluster("cluster-media", "说话人 1", {
      evidenceSegmentIds: ["evidence-media"],
    });
    const socialParticipant = reviewParticipant(cluster, "人物 A");
    const mediaParticipant = reviewParticipant(cluster, "媒体声音 1", {
      id: `media:${cluster.id}`,
      kind: "media",
      reviewState: "media",
    });
    const initialProcessing = reviewSpeakerProcessing([socialParticipant]);
    const mediaProcessing = reviewSpeakerProcessing([], [mediaParticipant]);
    const previewParticipantReview = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: session.id,
        action: "mark_media",
        clusterIds: [cluster.id],
        affectedClusterCount: 1,
        affectedSegmentCount: 1,
        affectedPersonIds: [],
        canUndo: true,
      })
      .mockResolvedValueOnce({
        sessionId: session.id,
        action: "restore_social",
        clusterIds: [cluster.id],
        affectedClusterCount: 1,
        affectedSegmentCount: 1,
        affectedPersonIds: [],
        canUndo: true,
      });
    const applyParticipantReview = vi
      .fn()
      .mockResolvedValueOnce({
        event: participantReviewEvent("review-media", "mark_media"),
        speakerProcessing: mediaProcessing,
      })
      .mockResolvedValueOnce({
        event: participantReviewEvent("review-restore", "restore_social"),
        speakerProcessing: initialProcessing,
      });
    installParticipantReviewApi(initialProcessing, {
      previewParticipantReview,
      applyParticipantReview,
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByText("人物 A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "标记为媒体声音" }));
    await waitFor(() =>
      expect(previewParticipantReview).toHaveBeenNthCalledWith(1, {
        sessionId: session.id,
        action: "mark_media",
        clusterIds: [cluster.id],
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认并保存" }));

    await waitFor(() =>
      expect(applyParticipantReview).toHaveBeenNthCalledWith(1, {
        sessionId: session.id,
        action: "mark_media",
        clusterIds: [cluster.id],
      })
    );
    expect(await screen.findByText("已排除 1 组媒体声音")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看已排除的媒体声音（1）"));
    fireEvent.click(screen.getByRole("button", { name: "改为互动人物" }));

    await waitFor(() =>
      expect(previewParticipantReview).toHaveBeenNthCalledWith(2, {
        sessionId: session.id,
        action: "restore_social",
        clusterIds: [cluster.id],
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认并保存" }));

    await waitFor(() =>
      expect(applyParticipantReview).toHaveBeenNthCalledWith(2, {
        sessionId: session.id,
        action: "restore_social",
        clusterIds: [cluster.id],
      })
    );
    expect(await screen.findByText("人物 A")).toBeInTheDocument();
    expect(screen.queryByText("已排除 1 组媒体声音")).not.toBeInTheDocument();
  });

  it("splits a selected transcript segment into a new participant after impact confirmation", async () => {
    const cluster = reviewCluster("cluster-split", "说话人 1", {
      evidenceSegmentIds: ["evidence-split"],
    });
    const participant = reviewParticipant(cluster, "人物 A");
    const initialProcessing = reviewSpeakerProcessing([participant]);
    const splitCluster = reviewCluster("cluster-split-new", "人物 B", {
      evidenceSegmentIds: ["evidence-split"],
    });
    const splitParticipant = reviewParticipant(splitCluster, "人物 B");
    const splitProcessing = reviewSpeakerProcessing([
      reviewParticipant(cluster, "人物 A", {
        representativeSegments: [],
        segmentCount: 0,
      }),
      splitParticipant,
    ]);
    const input = {
      sessionId: session.id,
      action: "split",
      clusterIds: [cluster.id],
      segmentIds: ["evidence-split"],
    } as unknown as JarvisParticipantReviewInput;
    const previewParticipantReview = vi.fn(async () => ({
      sessionId: session.id,
      action: "split",
      clusterIds: [cluster.id],
      segmentIds: ["evidence-split"],
      affectedClusterCount: 1,
      affectedSegmentCount: 1,
      affectedPersonIds: [],
      canUndo: true,
    }));
    const applyParticipantReview = vi.fn(async () => ({
      event: participantReviewEvent("review-split", "split"),
      speakerProcessing: splitProcessing,
    }));
    installParticipantReviewApi(initialProcessing, {
      previewParticipantReview,
      applyParticipantReview,
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByRole("button", { name: "播放 人物 A 证据 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "拆分为新人物" }));
    await waitFor(() => expect(previewParticipantReview).toHaveBeenCalledWith(input));
    expect(screen.getByText(/影响 1 个声纹簇和 1 条转写证据/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));

    await waitFor(() => expect(applyParticipantReview).toHaveBeenCalledWith(input));
    expect(await screen.findByText("人物 B")).toBeInTheDocument();
    expect(screen.getByText("预计 2 人；未检测到本人发言")).toBeInTheDocument();
  });

  it("forgets a confirmed identity without deleting the session participant evidence", async () => {
    const cluster = reviewCluster("cluster-known", "说话人 1", {
      linkState: "confirmed",
      person: { id: "person-alice", displayName: "张三", isSelf: false },
      evidenceSegmentIds: ["evidence-known"],
    });
    const knownParticipant = reviewParticipant(cluster, "张三", {
      id: "known:person-alice",
      kind: "known",
      person: cluster.person,
      reviewState: "confirmed",
      durable: true,
    });
    const forgottenParticipant = reviewParticipant(
      reviewCluster("cluster-known", "说话人 1", {
        evidenceSegmentIds: ["evidence-known"],
      }),
      "未命名人物"
    );
    const initialProcessing = reviewSpeakerProcessing([knownParticipant]);
    const forgottenProcessing = reviewSpeakerProcessing([forgottenParticipant]);
    const input = {
      sessionId: session.id,
      action: "forget_identity",
      clusterIds: [cluster.id],
      personId: "person-alice",
    } as unknown as JarvisParticipantReviewInput;
    const previewParticipantReview = vi.fn(async () => ({
      sessionId: session.id,
      action: "forget_identity",
      clusterIds: [cluster.id],
      affectedClusterCount: 1,
      affectedSegmentCount: 1,
      affectedPersonIds: ["person-alice"],
      canUndo: true,
    }));
    const applyParticipantReview = vi.fn(async () => ({
      event: participantReviewEvent("review-forget", "forget_identity"),
      speakerProcessing: forgottenProcessing,
    }));
    installParticipantReviewApi(initialProcessing, {
      previewParticipantReview,
      applyParticipantReview,
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByText("张三")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "忘记此身份" }));
    await waitFor(() => expect(previewParticipantReview).toHaveBeenCalledWith(input));
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));

    await waitFor(() => expect(applyParticipantReview).toHaveBeenCalledWith(input));
    expect(await screen.findByText("未命名人物")).toBeInTheDocument();
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放 未命名人物 证据 1" })).toBeInTheDocument();
  });

  it("pins and unpins representative evidence through explicit retention-impact confirmation", async () => {
    const cluster = reviewCluster("cluster-pin", "说话人 1", {
      evidenceSegmentIds: ["evidence-pin"],
    });
    const participant = reviewParticipant(cluster, "人物 A");
    const withPinnedState = (
      value: JarvisSessionParticipant,
      pinned: boolean
    ): JarvisSessionParticipant => ({
      ...value,
      representativeSegments: value.representativeSegments.map((segment) => ({
        ...segment,
        pinned,
      })),
    });
    const unpinnedProcessing = reviewSpeakerProcessing([withPinnedState(participant, false)]);
    const pinnedProcessing = reviewSpeakerProcessing([withPinnedState(participant, true)]);
    const pinInput = {
      sessionId: session.id,
      action: "pin_evidence",
      clusterIds: [cluster.id],
      segmentIds: ["evidence-pin"],
    } as unknown as JarvisParticipantReviewInput;
    const unpinInput = {
      sessionId: session.id,
      action: "unpin_evidence",
      clusterIds: [cluster.id],
      segmentIds: ["evidence-pin"],
    } as unknown as JarvisParticipantReviewInput;
    const previewParticipantReview = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: session.id,
        action: "pin_evidence",
        clusterIds: [cluster.id],
        segmentIds: ["evidence-pin"],
        affectedClusterCount: 1,
        affectedSegmentCount: 1,
        affectedPersonIds: [],
        canUndo: true,
      })
      .mockResolvedValueOnce({
        sessionId: session.id,
        action: "unpin_evidence",
        clusterIds: [cluster.id],
        segmentIds: ["evidence-pin"],
        affectedClusterCount: 1,
        affectedSegmentCount: 1,
        affectedPersonIds: [],
        canUndo: true,
      });
    const applyParticipantReview = vi
      .fn()
      .mockResolvedValueOnce({
        event: participantReviewEvent("review-pin", "pin_evidence"),
        speakerProcessing: pinnedProcessing,
      })
      .mockResolvedValueOnce({
        event: participantReviewEvent("review-unpin", "unpin_evidence"),
        speakerProcessing: unpinnedProcessing,
      });
    installParticipantReviewApi(unpinnedProcessing, {
      previewParticipantReview,
      applyParticipantReview,
    });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    fireEvent.click(await screen.findByRole("button", { name: "固定证据" }));

    await waitFor(() => expect(previewParticipantReview).toHaveBeenCalledWith(pinInput));
    expect(screen.getByText(/固定后将不再按 7 天规则自动删除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(applyParticipantReview).toHaveBeenCalledWith(pinInput));

    fireEvent.click(await screen.findByRole("button", { name: "取消固定" }));
    await waitFor(() => expect(previewParticipantReview).toHaveBeenCalledWith(unpinInput));
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(applyParticipantReview).toHaveBeenCalledWith(unpinInput));
    expect(await screen.findByRole("button", { name: "固定证据" })).toBeInTheDocument();
  });

  it("loads an understandable immutable review history for the current session", async () => {
    const cluster = reviewCluster("cluster-history", "说话人 1");
    const processing = reviewSpeakerProcessing([reviewParticipant(cluster, "人物 A")]);
    const listParticipantReviewHistory = vi.fn(async () => [
      participantReviewEvent("review-history-2", "undo"),
      {
        ...participantReviewEvent("review-history-1", "merge"),
        canUndo: false,
      },
    ]);
    installParticipantReviewApi(processing, { listParticipantReviewHistory });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /的录音/ }));
    expect(await screen.findByText("人物 A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复核历史" }));

    await waitFor(() =>
      expect(listParticipantReviewHistory).toHaveBeenCalledWith(session.id)
    );
    expect(await screen.findByText("合并人物")).toBeInTheDocument();
    expect(screen.getByText("撤销人物修正")).toBeInTheDocument();
    expect(screen.queryByText("speaker_1")).not.toBeInTheDocument();
  });
});
