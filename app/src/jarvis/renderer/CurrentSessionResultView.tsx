import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  CloudCog,
  FileAudio2,
  LoaderCircle,
  Mic,
  RotateCcw,
  Tags,
  UsersRound,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import type {
  JarvisActivityCategory,
  JarvisActivityClassification,
  JarvisAnalysisStatus,
  JarvisRuntimeStatus,
  JarvisSessionDetail,
  JarvisSessionTimeline,
  JarvisTranscriptSegment,
} from "../types";
import ProcessingStatus from "./ProcessingStatus";
import type { SessionStatus } from "./sessionMachine";
import TranscriptTodoButton from "./TranscriptTodoButton";
import SpeakerUtteranceTimeline from "./SpeakerUtteranceTimeline";

type ResultTab = "summary" | "transcript" | "processing";
type ProgressState = "complete" | "running" | "blocked" | "waiting";
type RetryableLocalReadSource = "detail" | "timeline" | "activity" | "runtime";

interface LocalReadRetryState {
  attempts: number;
  retryAt: number | null;
}

interface CurrentSessionResultViewProps {
  sessionId: string;
  sessionStatus: SessionStatus;
  startedAt: number | null;
  durationMs: number;
  onStartNewRecording: () => Promise<void> | void;
  onDurableResultChange: () => void;
}

interface ProgressItem {
  id: string;
  label: string;
  detail: string;
  state: ProgressState;
}

const TERMINAL_ANALYSIS_STATES = new Set<JarvisAnalysisStatus["state"]>([
  "quota_limited",
  "retry_needed",
  "blocked",
]);

const LOCAL_READ_RETRY_BASE_MS = 3_000;
const LOCAL_READ_RETRY_MAX_MS = 30_000;
const MINIMUM_POLL_DELAY_MS = 250;
const RETRYABLE_LOCAL_READ_SOURCES: RetryableLocalReadSource[] = [
  "detail",
  "timeline",
  "activity",
  "runtime",
];

function localReadRetryDelay(attempts: number): number {
  return Math.min(
    LOCAL_READ_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempts - 1), 4),
    LOCAL_READ_RETRY_MAX_MS
  );
}

const CATEGORY_LABELS: Record<JarvisActivityCategory, string> = {
  work_meeting: "工作会议",
  learning: "学习",
  social_call: "社交通话",
  in_person_conversation: "面对面对话",
  entertainment: "娱乐",
  gaming: "游戏",
  other: "其他",
  unknown: "未确定",
};

function safeStringArray(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function analysisFailureLabel(errorCode: JarvisAnalysisStatus["errorCode"]): string {
  if (errorCode === "budget_exceeded" || errorCode === "over_limit") {
    return "MiniMax 月度预算已到上限。本地转写和人物结果仍已保留。";
  }
  if (errorCode === "usage_unknown") {
    return "上次 MiniMax 请求的计费状态无法确认。本地结果不受影响。";
  }
  if (errorCode === "offline" || errorCode === "analysis_runtime_not_ready") {
    return "MiniMax 暂时不可用。本地转写和人物结果仍可查看。";
  }
  if (errorCode === "invalid_response") {
    return "MiniMax 返回的数据格式无效。本地转写和人物结果仍已保留。";
  }
  return "云端总结暂时失败。本地转写、活动分类和人物结果仍已保留。";
}

function mergeSegments(
  detail: JarvisSessionDetail | null,
  timeline: JarvisSessionTimeline | null
): JarvisTranscriptSegment[] {
  const candidates = [...(detail?.segments ?? []), ...(timeline?.segments ?? [])];
  // A mixed old/new snapshot can contain a stale copy without superseded_by
  // alongside a newer copy that marks the same id as superseded. Collect those
  // ids first so iteration order can never re-introduce obsolete text/actions.
  const supersededIds = new Set(
    candidates.filter((segment) => Boolean(segment.superseded_by)).map((segment) => segment.id)
  );
  const byId = new Map<string, JarvisTranscriptSegment>();
  for (const segment of candidates) {
    if (supersededIds.has(segment.id)) continue;
    const current = byId.get(segment.id);
    const currentVersion = current?.version ?? 0;
    const nextVersion = segment.version ?? 0;
    if (
      !current ||
      nextVersion > currentVersion ||
      (segment.result_kind === "final" && current.result_kind !== "final")
    ) {
      byId.set(segment.id, segment);
    }
  }
  return [...byId.values()].sort(
    (left, right) => left.started_at - right.started_at || left.id.localeCompare(right.id)
  );
}

function ProgressIcon({ state }: { state: ProgressState }) {
  if (state === "complete") {
    return <CheckCircle2 className="size-4 text-emerald-500" aria-hidden="true" />;
  }
  if (state === "blocked") {
    return <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />;
  }
  if (state === "running") {
    return <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />;
  }
  return <Circle className="size-4 text-muted-foreground/60" aria-hidden="true" />;
}

export default function CurrentSessionResultView({
  sessionId,
  sessionStatus,
  startedAt,
  durationMs,
  onStartNewRecording,
  onDurableResultChange,
}: CurrentSessionResultViewProps) {
  const [activeTab, setActiveTab] = useState<ResultTab>("summary");
  const tabRefs = useRef<Record<ResultTab, HTMLButtonElement | null>>({
    summary: null,
    transcript: null,
    processing: null,
  });
  const [detail, setDetail] = useState<JarvisSessionDetail | null>(null);
  const [timeline, setTimeline] = useState<JarvisSessionTimeline | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<JarvisAnalysisStatus | null>(null);
  const [activities, setActivities] = useState<JarvisActivityClassification[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<JarvisRuntimeStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [retryConfirmationOpen, setRetryConfirmationOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [startingNewRecording, setStartingNewRecording] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const snapshotRef = useRef({
    timelineVersion: -1,
    timelineReady: false,
    summaryReady: false,
    summaryPartial: false,
    analysisState: null as JarvisAnalysisStatus["state"] | null,
    analysisUpdatedAt: null as number | null,
    durableSignature: null as string | null,
  });

  useEffect(() => {
    setActiveTab("summary");
    setDetail(null);
    setTimeline(null);
    setAnalysisStatus(null);
    setActivities([]);
    setRuntimeStatus(null);
    setReadError(null);
    setRetryConfirmationOpen(false);
    setRetrying(false);
    setRetryError(null);
    setStartingNewRecording(false);
    setStartError(null);
    snapshotRef.current = {
      timelineVersion: -1,
      timelineReady: false,
      summaryReady: false,
      summaryPartial: false,
      analysisState: null,
      analysisUpdatedAt: null,
      durableSignature: null,
    };
  }, [sessionId]);

  useEffect(() => {
    const api = window.electronAPI?.jarvis;
    if (!api) {
      setReadError("无法连接 Jarvis 后台；录音页会在后台恢复后重新读取本地结果。");
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    const localReadRetries: Record<RetryableLocalReadSource, LocalReadRetryState> = {
      detail: { attempts: 0, retryAt: null },
      timeline: { attempts: 0, retryAt: null },
      activity: { attempts: 0, retryAt: null },
      runtime: { attempts: 0, retryAt: null },
    };

    const markLocalReadSucceeded = (source: RetryableLocalReadSource) => {
      localReadRetries[source] = { attempts: 0, retryAt: null };
    };

    const markLocalReadFailed = (source: RetryableLocalReadSource) => {
      const attempts = localReadRetries[source].attempts + 1;
      localReadRetries[source] = {
        attempts,
        retryAt: Date.now() + localReadRetryDelay(attempts),
      };
    };

    const updateReadError = () => {
      if (cancelled) return;
      const hasFailedLocalRead = RETRYABLE_LOCAL_READ_SOURCES.some(
        (source) => localReadRetries[source].retryAt !== null
      );
      setReadError(
        hasFailedLocalRead
          ? "本地结果暂时读取失败，Jarvis 会继续在后台保存和处理；此页面将自动重试。"
          : null
      );
    };

    const applyDetail = (next: JarvisSessionDetail | null) => {
      if (!next || next.session.id !== sessionId || cancelled) return;
      setDetail(next);
      snapshotRef.current.summaryReady = next.summary?.is_final === 1;
      snapshotRef.current.summaryPartial = next.summary?.is_final === 0;
      const durableSignature = JSON.stringify([
        next.summary?.updated_at ?? null,
        next.summary?.is_final ?? null,
        next.speakerProcessing?.participantSnapshot?.revision ?? null,
        next.todos.map((todo) => [todo.id, todo.status, todo.updated_at]),
      ]);
      if (snapshotRef.current.durableSignature !== durableSignature) {
        snapshotRef.current.durableSignature = durableSignature;
        onDurableResultChange();
      }
    };

    const applyTimeline = (next: JarvisSessionTimeline | null) => {
      if (!next || next.session_id !== sessionId || cancelled) return;
      setTimeline(next);
      snapshotRef.current.timelineVersion = next.timeline_version;
      snapshotRef.current.timelineReady = next.processing_state === "ready";
    };

    const loadFullSnapshot = async () => {
      const runtimePromise =
        typeof api.getRuntimeStatus === "function"
          ? api.getRuntimeStatus()
          : Promise.resolve<JarvisRuntimeStatus | null>(null);
      const results = await Promise.allSettled([
        api.getSessionDetail(sessionId),
        api.getSessionTimeline(sessionId),
        api.getAnalysisStatus(sessionId),
        api.listActivityClassifications(sessionId),
        runtimePromise,
      ]);
      if (cancelled) return;
      const [detailResult, timelineResult, analysisResult, activityResult, runtimeResult] = results;
      if (detailResult.status === "fulfilled") {
        applyDetail(detailResult.value);
        markLocalReadSucceeded("detail");
      } else {
        markLocalReadFailed("detail");
      }
      if (timelineResult.status === "fulfilled") {
        applyTimeline(timelineResult.value);
        markLocalReadSucceeded("timeline");
      } else {
        markLocalReadFailed("timeline");
      }
      if (analysisResult.status === "fulfilled") {
        setAnalysisStatus(analysisResult.value);
        snapshotRef.current.analysisState = analysisResult.value.state;
        snapshotRef.current.analysisUpdatedAt = analysisResult.value.updatedAt;
      }
      if (activityResult.status === "fulfilled") {
        setActivities(activityResult.value);
        markLocalReadSucceeded("activity");
      } else {
        markLocalReadFailed("activity");
      }
      if (runtimeResult.status === "fulfilled") {
        setRuntimeStatus(runtimeResult.value);
        markLocalReadSucceeded("runtime");
      } else {
        markLocalReadFailed("runtime");
      }
      updateReadError();
    };

    const retryLocalRead = async (source: RetryableLocalReadSource) => {
      try {
        if (source === "detail") {
          applyDetail(await api.getSessionDetail(sessionId));
        } else if (source === "timeline") {
          applyTimeline(await api.getSessionTimeline(sessionId));
        } else if (source === "activity") {
          setActivities(await api.listActivityClassifications(sessionId));
        } else if (typeof api.getRuntimeStatus === "function") {
          setRuntimeStatus(await api.getRuntimeStatus());
        }
        markLocalReadSucceeded(source);
      } catch {
        markLocalReadFailed(source);
      }
    };

    const retryFailedLocalReads = async () => {
      const now = Date.now();
      const dueSources = RETRYABLE_LOCAL_READ_SOURCES.filter((source) => {
        const retryAt = localReadRetries[source].retryAt;
        return retryAt !== null && retryAt <= now;
      });
      if (dueSources.length === 0) return;
      await Promise.all(dueSources.map((source) => retryLocalRead(source)));
      updateReadError();
    };

    const shouldPollProcessing = () => {
      const analysisTerminal =
        snapshotRef.current.summaryReady ||
        (snapshotRef.current.summaryPartial && snapshotRef.current.analysisState === "ready") ||
        (snapshotRef.current.analysisState !== null &&
          TERMINAL_ANALYSIS_STATES.has(snapshotRef.current.analysisState));
      return (
        sessionStatus === "finalizing" || !snapshotRef.current.timelineReady || !analysisTerminal
      );
    };

    const nextLocalRetryAt = () =>
      RETRYABLE_LOCAL_READ_SOURCES.reduce<number | null>((earliest, source) => {
        const retryAt = localReadRetries[source].retryAt;
        if (retryAt === null) return earliest;
        return earliest === null ? retryAt : Math.min(earliest, retryAt);
      }, null);

    const poll = async (initial = false) => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        if (initial) {
          await loadFullSnapshot();
        } else if (shouldPollProcessing()) {
          const statusPromise =
            snapshotRef.current.timelineVersion < 0
              ? Promise.resolve(null)
              : typeof api.getSessionTimelineStatus === "function"
                ? api.getSessionTimelineStatus(sessionId)
                : api.getSessionTimeline(sessionId);
          const [timelineStatusResult, analysisResult] = await Promise.allSettled([
            statusPromise,
            api.getAnalysisStatus(sessionId),
          ]);
          if (cancelled) return;

          let durableStateChanged = false;
          if (timelineStatusResult.status === "fulfilled" && timelineStatusResult.value) {
            const next = timelineStatusResult.value;
            durableStateChanged =
              next.timeline_version !== snapshotRef.current.timelineVersion ||
              (next.processing_state === "ready") !== snapshotRef.current.timelineReady;
          }
          if (analysisResult.status === "fulfilled") {
            const next = analysisResult.value;
            durableStateChanged ||=
              next.state !== snapshotRef.current.analysisState ||
              next.updatedAt !== snapshotRef.current.analysisUpdatedAt;
            setAnalysisStatus(next);
            snapshotRef.current.analysisState = next.state;
            snapshotRef.current.analysisUpdatedAt = next.updatedAt;
          }

          if (durableStateChanged) await loadFullSnapshot();
        }
        await retryFailedLocalReads();
      } catch {
        if (!cancelled) {
          setReadError("本地结果暂时读取失败，Jarvis 会继续在后台保存和处理；此页面将自动重试。");
        }
      } finally {
        inFlight = false;
      }

      if (cancelled) return;
      const continueProcessing = shouldPollProcessing();
      const retryAt = nextLocalRetryAt();
      if (continueProcessing || retryAt !== null) {
        const background = document.hidden || !document.hasFocus();
        const processingDelay = continueProcessing ? (background ? 12_000 : 3_000) : Infinity;
        const localRetryDelay = retryAt === null ? Infinity : Math.max(0, retryAt - Date.now());
        const delay = Math.max(MINIMUM_POLL_DELAY_MS, Math.min(processingDelay, localRetryDelay));
        timer = window.setTimeout(() => void poll(), delay);
      }
    };

    void poll(true);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [onDurableResultChange, refreshGeneration, sessionId, sessionStatus]);

  const retryAnalysis = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const status = await window.electronAPI.jarvis.analyzeSession(sessionId, "final");
      setAnalysisStatus(status);
      snapshotRef.current.analysisState = status.state;
      if (TERMINAL_ANALYSIS_STATES.has(status.state)) {
        setRetryError(analysisFailureLabel(status.errorCode));
      }
      setRetryConfirmationOpen(false);
      setRefreshGeneration((generation) => generation + 1);
    } catch {
      setRetryError("没有提交新的 MiniMax 请求；本地结果仍已保留，请稍后重试。");
    } finally {
      setRetrying(false);
    }
  }, [sessionId]);

  const startNewRecording = useCallback(async () => {
    if (startingNewRecording) return;
    setStartingNewRecording(true);
    setStartError(null);
    try {
      await onStartNewRecording();
    } catch {
      setStartError("没有开始新的录音，请检查麦克风或系统音频后重试。");
    } finally {
      setStartingNewRecording(false);
    }
  }, [onStartNewRecording, startingNewRecording]);

  const transcript = useMemo(() => mergeSegments(detail, timeline), [detail, timeline]);
  const finalSegmentCount = transcript.filter((segment) => segment.result_kind === "final").length;
  const participants = useMemo(
    () => detail?.speakerProcessing?.participants.participants ?? [],
    [detail?.speakerProcessing?.participants.participants]
  );
  const participantBySegmentId = useMemo(() => {
    const result = new Map<string, string>();
    for (const participant of participants) {
      for (const segmentId of participant.segmentIds)
        result.set(segmentId, participant.displayName);
    }
    return result;
  }, [participants]);
  const tracksById = useMemo(
    () => new Map((timeline?.tracks ?? []).map((track) => [track.id, track])),
    [timeline?.tracks]
  );
  const decisions = safeStringArray(detail?.summary?.decisions_json);
  const audioSaved =
    sessionStatus === "completed" ||
    detail?.session.status === "completed" ||
    detail?.session.status === "recovered";
  const transcriptReady =
    audioSaved &&
    timeline !== null &&
    timeline.chunks.every((chunk) =>
      ["completed", "no_speech"].includes(chunk.transcription_status ?? "")
    );
  const analysisBlocked =
    analysisStatus !== null && TERMINAL_ANALYSIS_STATES.has(analysisStatus.state);
  const summaryFinal = detail?.summary?.is_final === 1;
  const summaryPartial = detail?.summary?.is_final === 0;
  const summaryPartialReady = summaryPartial && analysisStatus?.state === "ready";
  const summaryNeedsManualRefresh = !summaryFinal && (analysisBlocked || summaryPartialReady);
  const speakerReady = Boolean(detail?.speakerProcessing?.participantSnapshot);
  const localProcessingBlocked = (timeline?.processing_counts.blocked ?? 0) > 0;

  const progressItems: ProgressItem[] = [
    {
      id: "audio",
      label: audioSaved ? "音频已安全保存" : "正在安全保存音频",
      detail: audioSaved ? "本地录音不会等待云端总结" : "正在关闭音轨并写入最后一段音频",
      state: audioSaved ? "complete" : "running",
    },
    {
      id: "transcript",
      label: transcriptReady ? "最终转写已完成" : "最终转写处理中",
      detail: transcriptReady
        ? finalSegmentCount > 0
          ? `已完成 ${finalSegmentCount} 段最终文字；说话人复核可继续在后台运行`
          : "本次音频已全部确认无可转写语音"
        : finalSegmentCount > 0
          ? `已显示 ${finalSegmentCount} 段最终文字，其他分片会继续补齐`
          : "完成的文字会立即出现在“完整转写”中",
      state: transcriptReady ? "complete" : "running",
    },
    {
      id: "speaker",
      label: speakerReady ? "说话人复核已完成" : "说话人复核中",
      detail: speakerReady
        ? `预计 ${detail?.speakerProcessing?.participants.count.minimum ?? 0}–${detail?.speakerProcessing?.participants.count.maximum ?? 0} 人，待复核项会保守标记`
        : "GPU 空闲后补齐 SELF 与匿名人物关联",
      state: speakerReady ? "complete" : localProcessingBlocked ? "blocked" : "running",
    },
    {
      id: "summary",
      label: summaryFinal
        ? "MiniMax 总结已完成"
        : summaryPartialReady
          ? "MiniMax 阶段性总结已保存"
          : analysisBlocked
            ? "MiniMax 最终总结需要处理"
            : detail?.summary
              ? "MiniMax 最终总结处理中"
              : "MiniMax 总结处理中",
      detail: summaryFinal
        ? "最终总结已长期保存到 Memory"
        : summaryPartialReady
          ? "当前总结覆盖不完整；已停止自动轮询，需要时可付费刷新最终总结"
          : analysisBlocked
            ? `${detail?.summary ? "增量总结已保留。" : ""}${analysisFailureLabel(analysisStatus.errorCode)}`
            : detail?.summary
              ? "当前显示阶段性总结，后台正在生成最终版本"
              : "本地结果先显示，云端总结完成后自动出现",
      state: summaryFinal
        ? "complete"
        : analysisBlocked
          ? "blocked"
          : summaryPartialReady
            ? "waiting"
            : "running",
    },
  ];

  const tabItems: Array<{ id: ResultTab; label: string }> = [
    { id: "summary", label: "总结" },
    {
      id: "transcript",
      label: `完整转写${transcript.length > 0 ? ` (${transcript.length})` : ""}`,
    },
    { id: "processing", label: "处理详情" },
  ];
  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % tabItems.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + tabItems.length) % tabItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabItems.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabItems[nextIndex];
    setActiveTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-4 sm:p-6">
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">本次会话</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {startedAt
                ? new Date(startedAt).toLocaleString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "刚刚结束的录音"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              时长 {formatDuration(durationMs)} · 已自动切换到本次总结
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              {audioSaved ? <Check className="size-3.5" aria-hidden="true" /> : null}
              {audioSaved ? "录音已保存" : "正在完成录音"}
            </span>
            {audioSaved && sessionStatus === "completed" && (
              <Button
                type="button"
                size="sm"
                disabled={startingNewRecording}
                onClick={() => void startNewRecording()}
                aria-label="开始下一次录音"
              >
                {startingNewRecording ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Mic aria-hidden="true" />
                )}
                {startingNewRecording ? "正在开始…" : "开始下一次录音"}
              </Button>
            )}
          </div>
        </header>

        {startError && (
          <p
            role="alert"
            className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
          >
            {startError}
          </p>
        )}

        <section
          aria-label="本次会话处理进度"
          className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
        >
          {progressItems.map((item) => (
            <div
              key={item.id}
              className={`rounded-xl border p-3 ${
                item.state === "blocked"
                  ? "border-amber-500/35 bg-amber-500/5"
                  : "border-border/60 bg-card/80"
              }`}
            >
              <div className="flex items-center gap-2">
                <ProgressIcon state={item.state} />
                <p className="text-xs font-semibold text-foreground">{item.label}</p>
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{item.detail}</p>
            </div>
          ))}
        </section>

        {readError && (
          <p
            role="status"
            className="mt-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
          >
            {readError}
          </p>
        )}

        <div className="mt-5 border-b border-border/60">
          <div role="tablist" aria-label="本次会话内容" className="flex gap-1 overflow-x-auto">
            {tabItems.map((tab, index) => (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                tabIndex={activeTab === tab.id ? 0 : -1}
                aria-controls={`current-session-${tab.id}`}
                id={`current-session-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => moveTabFocus(event, index)}
                className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeTab === "summary" && (
          <section
            role="tabpanel"
            id="current-session-summary"
            aria-labelledby="current-session-tab-summary"
            tabIndex={0}
            className="space-y-4 py-5"
          >
            <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <CloudCog className="size-4 text-primary" aria-hidden="true" />
                <h2 className="font-semibold text-foreground">
                  {summaryFinal ? "完整总结" : summaryPartial ? "阶段性总结（覆盖不完整）" : "总结"}
                </h2>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/85">
                {detail?.summary?.summary ??
                  "本地结果会先逐步显示。最终转写和人物复核完成后，MiniMax 总结会自动加入这里。"}
              </p>

              {summaryNeedsManualRefresh && (
                <div className="mt-4 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3">
                  <p
                    role={analysisBlocked ? "alert" : "status"}
                    className="text-sm text-amber-900 dark:text-amber-100"
                  >
                    {analysisBlocked
                      ? analysisFailureLabel(analysisStatus.errorCode)
                      : "当前阶段性总结只覆盖已采用的转写与人物结果，不代表完整最终总结。Jarvis 已停止自动轮询。"}
                  </p>
                  {!retryConfirmationOpen ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3"
                      onClick={() => setRetryConfirmationOpen(true)}
                    >
                      <RotateCcw aria-hidden="true" />
                      {summaryPartialReady ? "付费刷新最终总结" : "付费重试 MiniMax 总结"}
                    </Button>
                  ) : (
                    <div className="mt-3 rounded-lg bg-background/70 p-3">
                      <p className="text-xs leading-5 text-muted-foreground">
                        这会提交一次新的 MiniMax 请求，可能再次产生费用。原始音频和声纹不会上传。
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          onClick={() => void retryAnalysis()}
                          disabled={retrying}
                        >
                          {retrying ? (
                            <LoaderCircle className="animate-spin" aria-hidden="true" />
                          ) : (
                            <RotateCcw aria-hidden="true" />
                          )}
                          确认付费重试
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={retrying}
                          onClick={() => setRetryConfirmationOpen(false)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                  {retryError && <p className="mt-2 text-xs text-destructive">{retryError}</p>}
                </div>
              )}

              {decisions.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm font-medium text-foreground">关键决定</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {decisions.map((decision) => (
                      <li key={decision}>{decision}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-xl border border-border/60 bg-card p-4">
                <div className="flex items-center gap-2">
                  <Tags className="size-4 text-primary" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">主题与活动</h2>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(detail?.topics ?? []).map((topic) => (
                    <span
                      key={topic.id}
                      className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                    >
                      {topic.canonical_title}
                    </span>
                  ))}
                  {activities.map((activity) => (
                    <span
                      key={activity.id}
                      className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {CATEGORY_LABELS[activity.category]} · {Math.round(activity.confidence * 100)}
                      %
                    </span>
                  ))}
                  {(detail?.topics.length ?? 0) === 0 && activities.length === 0 && (
                    <p className="text-sm text-muted-foreground">活动分类完成后会逐步显示。</p>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-border/60 bg-card p-4">
                <div className="flex items-center gap-2">
                  <UsersRound className="size-4 text-primary" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">涉及人物</h2>
                </div>
                <div className="mt-3 space-y-2">
                  {participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="truncate text-foreground">{participant.displayName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {participant.reviewState === "confirmed" ? "已确认" : "待复核"}
                      </span>
                    </div>
                  ))}
                  {participants.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      说话人复核完成后会显示 SELF 和匿名人物；媒体声音不会进入 People。
                    </p>
                  )}
                </div>
              </section>
            </div>

            {(detail?.memories.length ?? 0) > 0 && (
              <section className="rounded-xl border border-border/60 bg-card p-4">
                <h2 className="text-sm font-semibold">重要信息</h2>
                <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                  {detail?.memories.slice(0, 12).map((memory) => (
                    <li key={memory.id} className="rounded-lg bg-muted/30 px-3 py-2">
                      {memory.content}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </section>
        )}

        {activeTab === "transcript" && (
          <section
            role="tabpanel"
            id="current-session-transcript"
            aria-labelledby="current-session-tab-transcript"
            tabIndex={0}
            className="py-5"
          >
            <div className="rounded-2xl border border-border/60 bg-card p-3 sm:p-4">
              <div className="mb-3 flex items-center gap-2 px-2">
                <FileAudio2 className="size-4 text-primary" aria-hidden="true" />
                <h2 className="font-semibold">按来源、说话人和时间排列</h2>
              </div>
              {detail && timeline && (detail.speakerUtterances?.length ?? 0) > 0 && (
                <div className="mb-5 px-2">
                  <SpeakerUtteranceTimeline
                    utterances={detail.speakerUtterances ?? []}
                    chunks={timeline.chunks}
                    readChunk={window.electronAPI.jarvis.readAudioChunk}
                    readIsolatedAudio={window.electronAPI.jarvis.readSpeakerUtteranceAudio}
                  />
                </div>
              )}
              {(detail?.speakerUtterances?.length ?? 0) > 0 && (
                <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">
                  原始转写（审计）
                </p>
              )}
              <div className="space-y-1">
                {transcript.map((segment) => {
                  const track = segment.track_id ? tracksById.get(segment.track_id) : null;
                  const sourceName =
                    track?.track_kind === "application"
                      ? track.application_display_name || track.application_key || "应用音频"
                      : track?.source_type === "mic" || segment.source_type === "mic"
                        ? "实体麦克风"
                        : "系统音频 · 应用未知";
                  const speakerName =
                    participantBySegmentId.get(segment.id) || segment.speaker_label || "说话人未知";
                  return (
                    <article key={segment.id} className="rounded-xl px-3 py-3 hover:bg-muted/30">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                          {sourceName}
                        </span>
                        <span>{speakerName}</span>
                        <time dateTime={new Date(segment.started_at).toISOString()}>
                          {new Date(segment.started_at).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                        {segment.result_kind !== "final" && <span>临时文字</span>}
                      </div>
                      <p className="mt-1.5 select-text text-sm leading-6 text-foreground">
                        {segment.text}
                      </p>
                      <div className="mt-2 flex justify-end">
                        <TranscriptTodoButton
                          sessionId={sessionId}
                          segment={segment}
                          onCreated={onDurableResultChange}
                        />
                      </div>
                    </article>
                  );
                })}
                {transcript.length === 0 && (
                  <div className="grid min-h-48 place-items-center px-6 text-center">
                    <div>
                      <LoaderCircle
                        className="mx-auto size-5 animate-spin text-primary"
                        aria-hidden="true"
                      />
                      <p className="mt-3 text-sm font-medium">最终转写正在补齐</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        已保存的音频不会丢失，完成的文字会自动出现在这里。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {activeTab === "processing" && (
          <section
            role="tabpanel"
            id="current-session-processing"
            aria-labelledby="current-session-tab-processing"
            tabIndex={0}
            className="space-y-4 py-5"
          >
            <div className="rounded-2xl border border-border/60 bg-card p-5">
              <h2 className="font-semibold">处理详情与后台进度</h2>
              <div className="mt-4">
                {timeline ? (
                  <ProcessingStatus timeline={timeline} runtimeStatus={runtimeStatus} />
                ) : (
                  <p className="text-sm text-muted-foreground">正在读取本地处理状态…</p>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-xl border border-border/60 bg-card p-4">
                <h2 className="text-sm font-semibold">应用级采集</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {timeline?.application_capture?.exact_coverage_pct == null
                    ? "覆盖率尚未生成"
                    : `精确应用来源覆盖 ${timeline.application_capture.exact_coverage_pct}%`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  降级时段{" "}
                  {timeline?.application_capture?.degraded_interval_count ??
                    timeline?.application_capture?.degraded_intervals.length ??
                    0}{" "}
                  · 恢复点{" "}
                  {timeline?.application_capture?.recovery_count ??
                    timeline?.application_capture?.recovery_points.length ??
                    0}
                </p>
              </section>
              <section className="rounded-xl border border-border/60 bg-card p-4">
                <h2 className="text-sm font-semibold">说话人与失败重试</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {speakerReady
                    ? `已确认 ${detail?.speakerProcessing?.participants.count.confirmed ?? 0} · 待复核 ${detail?.speakerProcessing?.participants.count.needsReview ?? 0}`
                    : "说话人处理尚未完成"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  等待 {timeline?.processing_counts.pending ?? 0} · 运行{" "}
                  {timeline?.processing_counts.leased ?? 0} · 重试{" "}
                  {timeline?.processing_counts.retry ?? 0} · 受阻{" "}
                  {timeline?.processing_counts.blocked ?? 0}
                </p>
              </section>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
