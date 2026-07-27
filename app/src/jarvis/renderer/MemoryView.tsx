import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, BrainCircuit, Clock3, Cpu, History, Search, Users } from "lucide-react";
import type {
  JarvisRuntimeStatus,
  JarvisSession,
  JarvisSessionDetail,
  JarvisSessionTimeline,
} from "../types";
import { useJarvisStore } from "./jarvisStore";
import ContinuousSessionPlayer from "./ContinuousSessionPlayer";
import KnowledgeMemoryPanel from "./KnowledgeMemoryPanel";
import ProcessingStatus from "./ProcessingStatus";
import SpeakerChip from "./SpeakerChip";

function duration(session: JarvisSession): string {
  const ms = Math.max(0, (session.ended_at ?? Date.now()) - session.started_at);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function dateLabel(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(at);
}

function speakerCountLabel(minimum: number, maximum: number): string {
  return minimum === maximum ? `${minimum} 人` : `${minimum}–${maximum} 人`;
}

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

interface LegacySuggestion {
  content: string;
  reason: string;
}

function safeLegacySuggestions(value: string | null | undefined): LegacySuggestion[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is LegacySuggestion =>
          item !== null &&
          typeof item === "object" &&
          "content" in item &&
          typeof item.content === "string" &&
          "reason" in item &&
          typeof item.reason === "string"
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

function analysisErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /MEMORY_OWNER_OUT_OF_SCOPE|MEMORY_INPUT_(?:EMPTY|STALE)|analysis_input_(?:empty|invalid)/iu.test(
      message
    )
  ) {
    return "最终转写和说话人识别尚未完成，完成后会自动生成总结。";
  }
  if (/rate.?limit|quota|budget|预算|额度/iu.test(message)) {
    return "MiniMax 云端额度或预算暂不可用，请检查云预算后重试。";
  }
  if (/unauthorized|forbidden|invalid.?key|api.?key|401|403/iu.test(message)) {
    return "MiniMax Key 无效或未配置，请在设置中检查后重试。";
  }
  if (/analysis_runtime_not_ready|offline/iu.test(message)) {
    return "云端分析暂不可用，恢复连接后会自动重试。";
  }
  if (/usage_unknown/iu.test(message)) {
    return "上次云端请求的用量无法确认。有限预算模式已停止自动重试，避免重复计费；可切换为不设上限后手动重试。";
  }
  if (/invalid_response/iu.test(message)) {
    return "MiniMax 返回的数据格式无效，请稍后重试。";
  }
  return "总结未能加入后台队列，请稍后重试。";
}

export default function MemoryView() {
  const storedSessions = useJarvisStore((state) => state.sessions);
  const selectedSessionId = useJarvisStore((state) => state.selectedSessionId);
  const evidenceNavigation = useJarvisStore((state) => state.evidenceNavigation);
  const markEvidenceSessionOpened = useJarvisStore((state) => state.markEvidenceSessionOpened);
  const failEvidenceSession = useJarvisStore((state) => state.failEvidenceSession);
  const acknowledgeEvidencePlayback = useJarvisStore((state) => state.acknowledgeEvidencePlayback);
  const clearEvidenceNavigation = useJarvisStore((state) => state.clearEvidenceNavigation);
  const clustersBySession = useJarvisStore((state) => state.clustersBySession);
  const loadSessionClusters = useJarvisStore((state) => state.loadSessionClusters);
  const [sessions, setSessions] = useState(storedSessions);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<JarvisSessionDetail | null>(null);
  const [timeline, setTimeline] = useState<JarvisSessionTimeline | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<JarvisRuntimeStatus | null>(null);
  const [memoryMode, setMemoryMode] = useState<"sessions" | "knowledge">("sessions");
  const [loading, setLoading] = useState(false);
  const [sourcePageLoading, setSourcePageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRequestGeneration = useRef(0);
  const sourcePageRequestGeneration = useRef(0);
  const timelineRef = useRef<JarvisSessionTimeline | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSessions(storedSessions), [storedSessions]);

  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  useEffect(
    () => () => {
      detailRequestGeneration.current += 1;
      sourcePageRequestGeneration.current += 1;
    },
    []
  );

  const timelineProcessingState = timeline?.processing_state;

  useEffect(() => {
    const sessionId = detail?.session.id;
    if (!sessionId || !timelineProcessingState || timelineProcessingState === "ready") return;
    let cancelled = false;
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight || cancelled) return;
      requestInFlight = true;
      try {
        const getStatus = window.electronAPI.jarvis.getSessionTimelineStatus;
        if (typeof getStatus === "function") {
          const nextStatus = await getStatus(sessionId);
          if (!cancelled && nextStatus) {
            const currentTimeline = timelineRef.current;
            const becameReady =
              currentTimeline?.processing_state !== "ready" &&
              nextStatus.processing_state === "ready";
            if (becameReady) {
              const currentPage = currentTimeline?.evidence_page?.tracks;
              const next = await window.electronAPI.jarvis.getSessionTimeline(sessionId, {
                trackOffset: currentPage?.offset ?? 0,
                trackLimit: currentPage?.limit ?? 100,
              });
              if (!cancelled) setTimeline(next);
            } else {
              setTimeline((current) =>
                current && current.session_id === nextStatus.session_id
                  ? { ...current, ...nextStatus }
                  : current
              );
            }
          }
        } else {
          const next = await window.electronAPI.jarvis.getSessionTimeline(sessionId);
          if (!cancelled) setTimeline(next);
        }
      } catch {
        // A transient IPC failure must not stop the next scheduled refresh.
      } finally {
        requestInFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.session.id, timelineProcessingState]);

  useEffect(() => {
    const sessionId = detail?.session.id;
    if (!sessionId || detail.summary || timeline?.processing_state !== "ready") return;
    let cancelled = false;
    let requestInFlight = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (cancelled || requestInFlight || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      if (cancelled || requestInFlight) return;
      requestInFlight = true;
      let summaryLoaded = false;
      try {
        const status = await window.electronAPI.jarvis.getAnalysisStatus(sessionId);
        if (status.state === "ready") {
          const nextDetail = await window.electronAPI.jarvis.getSessionDetail(sessionId);
          if (!cancelled && nextDetail?.summary) {
            summaryLoaded = true;
            setDetail(nextDetail);
          }
        }
      } catch {
        // Summary completion is durable. A transient read failure can safely retry locally.
      } finally {
        requestInFlight = false;
        if (!summaryLoaded) schedule(2_500);
      }
    };
    schedule(500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [detail?.session.id, detail?.summary, timeline?.processing_state]);

  useEffect(() => {
    const sessionId = detail?.session.id;
    const getRuntimeStatus = window.electronAPI?.jarvis?.getRuntimeStatus;
    if (!sessionId || typeof getRuntimeStatus !== "function") return;
    let cancelled = false;
    let requestInFlight = false;
    let timer: number | null = null;
    const delay = () => (document.hidden || !document.hasFocus() ? 15_000 : 5_000);
    const schedule = () => {
      if (cancelled || requestInFlight || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, delay());
    };
    const refresh = async () => {
      if (cancelled || requestInFlight) return;
      requestInFlight = true;
      try {
        const next = await getRuntimeStatus();
        if (!cancelled) setRuntimeStatus(next);
      } catch {
        // A transient IPC failure must not disable later status refreshes.
      } finally {
        requestInFlight = false;
        schedule();
      }
    };
    const reschedule = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", reschedule);
    window.addEventListener("focus", reschedule);
    window.addEventListener("blur", reschedule);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", reschedule);
      window.removeEventListener("focus", reschedule);
      window.removeEventListener("blur", reschedule);
    };
  }, [detail?.session.id]);

  useEffect(() => {
    if (
      !detail?.session.id ||
      typeof window.electronAPI?.jarvis?.listSessionSpeakerClusters !== "function"
    ) {
      return;
    }
    void loadSessionClusters(detail.session.id).catch(() => undefined);
  }, [detail?.session.id, loadSessionClusters]);

  const sessionRows = useMemo(() => {
    const rows: Array<
      | { type: "day"; key: string; label: string }
      | { type: "session"; key: string; session: JarvisSession }
    > = [];
    let previousDay = "";
    for (const session of sessions) {
      const day = dateLabel(session.started_at);
      if (day !== previousDay) {
        rows.push({ type: "day", key: `day:${day}`, label: day });
        previousDay = day;
      }
      rows.push({ type: "session", key: `session:${session.id}`, session });
    }
    return rows;
  }, [sessions]);

  const sessionVirtualizer = useVirtualizer({
    count: sessionRows.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => (sessionRows[index]?.type === "day" ? 36 : 82),
    getItemKey: (index) => sessionRows[index]?.key ?? index,
    overscan: 8,
    initialRect: { width: 800, height: 640 },
  });
  const measuredSessionRows = sessionVirtualizer.getVirtualItems();
  const visibleSessionRows = useMemo(() => {
    if (measuredSessionRows.length > 0) return measuredSessionRows;
    let start = 0;
    return sessionRows.slice(0, 12).map((row, index) => {
      const item = { index, start };
      start += row.type === "day" ? 36 : 82;
      return item;
    });
  }, [measuredSessionRows, sessionRows]);

  const search = async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await window.electronAPI.jarvis.searchMemory(query, 200));
    } catch {
      setError("无法搜索记忆库，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  const open = useCallback(
    async (sessionId: string, evidenceRequestId?: number) => {
      const generation = ++detailRequestGeneration.current;
      sourcePageRequestGeneration.current += 1;
      setSourcePageLoading(false);
      setLoading(true);
      setError(null);
      try {
        const runtimeRequest =
          typeof window.electronAPI?.jarvis?.getRuntimeStatus === "function"
            ? window.electronAPI.jarvis.getRuntimeStatus().catch(() => null)
            : Promise.resolve(null);
        const [nextDetail, nextTimeline, nextRuntimeStatus] = await Promise.all([
          window.electronAPI.jarvis.getSessionDetail(sessionId),
          window.electronAPI.jarvis.getSessionTimeline(sessionId),
          runtimeRequest,
        ]);
        if (generation !== detailRequestGeneration.current) return;
        setDetail(nextDetail);
        setTimeline(nextTimeline);
        setRuntimeStatus(nextRuntimeStatus);
        if (evidenceRequestId !== undefined) markEvidenceSessionOpened(evidenceRequestId);
      } catch {
        if (generation !== detailRequestGeneration.current) return;
        setError("无法读取这次录音。");
        if (evidenceRequestId !== undefined) failEvidenceSession(evidenceRequestId);
      } finally {
        if (generation === detailRequestGeneration.current) setLoading(false);
      }
    },
    [failEvidenceSession, markEvidenceSessionOpened]
  );

  const loadTrackPage = useCallback(
    async (trackOffset: number) => {
      const sessionId = detail?.session.id;
      if (!sessionId || !timeline || sourcePageLoading) return;
      const requestGeneration = ++sourcePageRequestGeneration.current;
      setSourcePageLoading(true);
      try {
        const page = timeline.evidence_page;
        const next = await window.electronAPI.jarvis.getSessionTimeline(sessionId, {
          trackOffset,
          trackLimit: page?.tracks.limit ?? 100,
          intervalOffset: page?.intervals.offset ?? 0,
          intervalLimit: page?.intervals.limit ?? 200,
        });
        if (
          requestGeneration === sourcePageRequestGeneration.current &&
          next?.session_id === sessionId
        ) {
          setTimeline((current) => (current?.session_id === sessionId ? next : current));
        }
      } catch {
        if (requestGeneration === sourcePageRequestGeneration.current) {
          setError("无法读取下一页音轨信息。");
        }
      } finally {
        if (requestGeneration === sourcePageRequestGeneration.current) {
          setSourcePageLoading(false);
        }
      }
    },
    [detail?.session.id, sourcePageLoading, timeline]
  );

  useEffect(() => {
    if (
      evidenceNavigation.phase !== "opening_session" ||
      selectedSessionId !== evidenceNavigation.context.sessionId
    ) {
      return;
    }
    if (
      detail?.session.id === evidenceNavigation.context.sessionId &&
      timeline?.session_id === evidenceNavigation.context.sessionId
    ) {
      markEvidenceSessionOpened(evidenceNavigation.requestId);
      return;
    }
    void open(evidenceNavigation.context.sessionId, evidenceNavigation.requestId);
  }, [
    detail?.session.id,
    evidenceNavigation,
    markEvidenceSessionOpened,
    open,
    selectedSessionId,
    timeline?.session_id,
  ]);

  const analyze = async () => {
    if (!detail) return;
    const sessionId = detail.session.id;
    const generation = detailRequestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      let status = await window.electronAPI.jarvis.analyzeSession(sessionId, "final");
      if (["blocked", "quota_limited", "retry_needed"].includes(status.state)) {
        setError(analysisErrorMessage(status.errorCode));
        return;
      }
      for (
        let attempt = 0;
        attempt < 180 && ["queued", "analyzing"].includes(status.state);
        attempt += 1
      ) {
        if (generation !== detailRequestGeneration.current) return;
        try {
          status = await window.electronAPI.jarvis.getAnalysisStatus(sessionId);
        } catch {
          // A transient status read must not abandon a running cloud analysis.
        }
        if (!["queued", "analyzing"].includes(status.state)) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
      }
      if (generation !== detailRequestGeneration.current) return;
      if (["blocked", "quota_limited", "retry_needed"].includes(status.state)) {
        setError(analysisErrorMessage(status.errorCode));
        return;
      }
      if (status.state !== "ready") {
        setError("总结仍在后台处理中，请稍后重新打开这次录音查看。");
        return;
      }
      const [nextDetail, nextTimeline] = await Promise.all([
        window.electronAPI.jarvis.getSessionDetail(sessionId),
        window.electronAPI.jarvis.getSessionTimeline(sessionId),
      ]);
      if (generation !== detailRequestGeneration.current) return;
      setDetail(nextDetail);
      setTimeline(nextTimeline);
    } catch (analysisError) {
      setError(analysisErrorMessage(analysisError));
    } finally {
      setLoading(false);
    }
  };

  if (detail) {
    const decisions = safeStringArray(detail.summary?.decisions_json);
    const suggestions = safeLegacySuggestions(detail.summary?.suggestions_json);
    const hasVisibleTranscript = detail.segments.length > 0 || (timeline?.segments.length ?? 0) > 0;
    const summaryInputReady = timeline?.processing_state === "ready";
    const speakerProcessing = detail.speakerProcessing;
    const latestSpeakerRuns = speakerProcessing?.latestRuns ?? [];
    const microphoneTrackIds = new Set(
      (timeline?.tracks ?? [])
        .filter((track) => track.source_type === "mic")
        .map((track) => track.id)
    );
    const headlineSpeakerRun =
      latestSpeakerRuns.find((run) => microphoneTrackIds.has(run.trackId)) ??
      latestSpeakerRuns[0] ??
      null;
    const storedClusterUpdates = new Map(
      (clustersBySession[detail.session.id] ?? []).map((cluster) => [cluster.id, cluster])
    );
    const visibleSpeakers = (speakerProcessing?.speakers ?? []).map(
      (cluster) => storedClusterUpdates.get(cluster.id) ?? cluster
    );
    const sessionStatusLabel =
      detail.session.status === "completed" && !summaryInputReady
        ? "录音已完成 · 后台处理中"
        : summaryInputReady
          ? "处理完成"
          : detail.session.status;
    const evidenceContext =
      "context" in evidenceNavigation && evidenceNavigation.context.sessionId === detail.session.id
        ? evidenceNavigation.context
        : null;
    const focusRequestId = evidenceContext ? evidenceNavigation.requestId : null;
    const seekRequest =
      evidenceNavigation.phase === "seeking" && evidenceContext
        ? {
            requestId: evidenceNavigation.requestId,
            trackId: evidenceContext.trackId,
            sourceType: evidenceContext.sourceType,
            startedAt: evidenceContext.startedAt,
          }
        : null;
    return (
      <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
        <button
          type="button"
          onClick={() => {
            detailRequestGeneration.current += 1;
            sourcePageRequestGeneration.current += 1;
            clearEvidenceNavigation();
            setLoading(false);
            setSourcePageLoading(false);
            setDetail(null);
            setTimeline(null);
            setRuntimeStatus(null);
          }}
          className="mb-5 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回记忆库
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {new Date(detail.session.started_at).toLocaleString("zh-CN")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              时长 {duration(detail.session)} · {sessionStatusLabel}
            </p>
          </div>
          {!detail.summary &&
            hasVisibleTranscript &&
            (summaryInputReady ? (
              <button
                type="button"
                onClick={() => void analyze()}
                disabled={loading}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {loading ? "正在分析…" : "生成总结"}
              </button>
            ) : (
              <p className="max-w-xs rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
                处理完成后自动生成总结
              </p>
            ))}
        </div>
        {error && (
          <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}
        <div className="flex flex-col">
          <section className="order-5 mt-5 rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:p-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">录音与转写</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  播放控制已放到每条转写上，点击文字或左侧按钮即可播放该句。
                </p>
              </div>
              <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                {timeline?.segments.length ?? detail.segments.length} 条转写
              </span>
            </div>
            {timeline ? (
              <ContinuousSessionPlayer
                timeline={timeline}
                readChunk={window.electronAPI.jarvis.readAudioChunk}
                seekRequest={seekRequest}
                onSeekResult={acknowledgeEvidencePlayback}
                focusSegmentId={evidenceContext?.transcriptSegmentId}
                focusRequestId={focusRequestId}
                onTrackPageChange={(offset) => void loadTrackPage(offset)}
              />
            ) : (
              <p className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">
                正在读取音频时间线…
              </p>
            )}
          </section>
          {evidenceNavigation.phase === "transcript_only" && evidenceContext && (
            <p
              role="status"
              className="order-6 mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"
            >
              {evidenceNavigation.reason === "audio_expired"
                ? "Audio was removed by the retention policy. "
                : evidenceNavigation.reason === "audio_missing"
                  ? "Audio is unavailable. "
                  : "Audio became unavailable. "}
              {evidenceContext.transcriptState === "available"
                ? "Transcript evidence remains."
                : "Transcript evidence is unavailable."}
            </p>
          )}
          <section className="order-2 mt-6 rounded-xl border border-border/50 bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Users className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="font-semibold">说话人与声纹</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {headlineSpeakerRun?.speakerCount
                      ? `本次识别到 ${speakerCountLabel(
                          headlineSpeakerRun.speakerCount.minimum,
                          headlineSpeakerRun.speakerCount.maximum
                        )}`
                      : timeline?.processing_state === "ready"
                        ? "本次没有可用的说话人结果"
                        : "正在后台复核人数和声纹"}
                  </p>
                </div>
              </div>
              {headlineSpeakerRun && (
                <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                  {headlineSpeakerRun.inputVersion === 2
                    ? headlineSpeakerRun.speakerCount?.state === "models_agree"
                      ? "双模型一致"
                      : "高精度复核"
                    : "基础识别"}
                </span>
              )}
            </div>
            {visibleSpeakers.length > 0 ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {visibleSpeakers.map((cluster) => (
                  <div
                    key={cluster.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {cluster.localLabel}
                        </span>
                        <SpeakerChip cluster={cluster} localLabel={cluster.localLabel} />
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {cluster.person?.isSelf
                          ? "本人声纹已确认"
                          : cluster.linkState === "confirmed"
                            ? "已加入长期人物档案"
                            : cluster.suggestedPerson
                              ? `可能是 ${cluster.suggestedPerson.displayName}`
                              : "点击标签可指定姓名并选择是否长期学习"}
                      </p>
                    </div>
                    {typeof cluster.score === "number" && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {Math.round(cluster.score * 100)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                {timeline?.processing_state === "ready"
                  ? "没有提取到可命名的声纹。纯系统音频或重叠不清的片段不会强行建立人物档案。"
                  : "录音已安全保存；GPU 空闲后会自动补齐说话人分离和跨会话关联。"}
                </p>
              )}
            {(speakerProcessing?.fragmentedEvidenceCount ?? 0) > 0 && (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                已隐藏 {speakerProcessing?.fragmentedEvidenceCount} 个过短或重复的声纹碎片；它们只是算法证据，
                不计作真实人物。
              </p>
            )}
          </section>
          <section className="order-1 mt-6 rounded-xl border border-border/50 bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">完整总结</h2>
              {speakerProcessing?.summaryRefresh?.recommended === 1 && (
                <button
                  type="button"
                  onClick={() => void analyze()}
                  disabled={loading}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:opacity-50 dark:text-amber-200"
                >
                  {loading ? "正在刷新…" : "付费刷新总结"}
                </button>
              )}
            </div>
            {speakerProcessing?.summaryRefresh?.recommended === 1 && (
              <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                高精度复核发现说话人数发生变化。原总结已保留；只有点击上方按钮才会调用 MiniMax
                重新总结。
              </p>
            )}
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
              {detail.summary?.summary ??
                (summaryInputReady
                  ? "尚未生成总结。录音和转写已安全保存。"
                  : "正在完成最终转写和说话人识别，完成后会自动生成总结。")}
            </p>
            {decisions.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium">关键决定</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {decisions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium">AI 建议</h3>
                <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                  {suggestions.map((item) => (
                    <li key={item.content}>
                      <span className="text-foreground">{item.content}</span> — {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <div className="order-3 mt-4 grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-border/50 bg-card p-5">
              <h2 className="font-semibold">主题</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.topics.length ? (
                  detail.topics.map((topic) => (
                    <span
                      key={topic.id}
                      className="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary"
                    >
                      {topic.canonical_title}
                    </span>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">暂无主题</p>
                )}
              </div>
            </section>
            <section className="rounded-xl border border-border/50 bg-card p-5">
              <h2 className="font-semibold">待办</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {detail.todos.length ? (
                  detail.todos.map((todo) => (
                    <li key={todo.id} className="flex gap-2">
                      <span>{todo.status === "completed" ? "✓" : "○"}</span>
                      <span>{todo.content}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-muted-foreground">暂无待办</li>
                )}
              </ul>
            </section>
          </div>
          {timeline && (
            <details
              className="order-4 mt-4 rounded-xl border border-border/50 bg-card"
              open={timeline.processing_state !== "ready"}
            >
              <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">
                处理详情与后台进度
              </summary>
              <div className="border-t border-border/50 p-4">
                {latestSpeakerRuns.length > 0 && (
                  <div className="mb-4 rounded-lg border border-border/50 bg-muted/20 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Cpu className="size-4" aria-hidden="true" />
                      说话人处理
                    </div>
                    <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                      {latestSpeakerRuns.map((run) => {
                        const track = timeline.tracks.find((item) => item.id === run.trackId);
                        const source =
                          track?.application_display_name ||
                          (track?.source_type === "mic" ? "麦克风" : "系统音频·安全兜底");
                        return (
                          <li key={run.id} className="flex flex-wrap gap-x-2 gap-y-1">
                            <span className="font-medium text-foreground">{source}</span>
                            <span>{run.executionDevice.toUpperCase()}</span>
                            <span>
                              {run.speakerCount
                                ? speakerCountLabel(
                                    run.speakerCount.minimum,
                                    run.speakerCount.maximum
                                  )
                                : "人数未知"}
                            </span>
                            <span>重叠分离：{run.overlapSeparationState}</span>
                            {run.modelPackVersion && <span>{run.modelPackVersion}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <ProcessingStatus timeline={timeline} runtimeStatus={runtimeStatus} />
              </div>
            </details>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">记忆 Memory</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            “会话记录”保存每次录音和转写；“长期记忆”只保留跨多次对话仍然有用的信息。
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          {sessions.length} 次会话
        </span>
      </header>

      <div className="mt-5 inline-flex rounded-lg bg-muted p-1" aria-label="记忆内容类型">
        <button
          type="button"
          onClick={() => setMemoryMode("sessions")}
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
            memoryMode === "sessions"
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          <History className="size-4" aria-hidden="true" />
          会话记录
        </button>
        <button
          type="button"
          onClick={() => setMemoryMode("knowledge")}
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
            memoryMode === "knowledge"
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          <BrainCircuit className="size-4" aria-hidden="true" />
          长期记忆
        </button>
      </div>

      {memoryMode === "knowledge" ? (
        <div className="mt-6">
          <KnowledgeMemoryPanel />
        </div>
      ) : (
        <>
          <form
            className="mt-6 flex max-w-2xl gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <label className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3">
              <Search className="size-4 text-muted-foreground" aria-hidden="true" />
              <input
                aria-label="搜索记忆"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话、转写或总结"
                className="w-full bg-transparent py-2.5 text-sm outline-none"
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              搜索
            </button>
          </form>
          {error && (
            <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {loading && !detail && <p className="mt-6 text-sm text-muted-foreground">正在读取…</p>}
          <div className="mt-6">
            {sessionRows.length ? (
              <div
                ref={sessionListRef}
                aria-label="会话记录列表"
                className="jarvis-scroll-region h-[min(65vh,42rem)] min-h-80 overflow-y-auto pr-2"
              >
                <div
                  className="relative w-full"
                  style={{ height: `${sessionVirtualizer.getTotalSize()}px` }}
                >
                  {visibleSessionRows.map((virtualRow) => {
                    const row = sessionRows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.key}
                        className="absolute left-0 top-0 w-full pb-2"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        {row.type === "day" ? (
                          <h2 className="px-1 pt-2 text-sm font-semibold text-muted-foreground">
                            {row.label}
                          </h2>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              clearEvidenceNavigation();
                              void open(row.session.id);
                            }}
                            className="flex w-full items-center justify-between rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
                          >
                            <div>
                              <p className="font-medium">
                                {new Date(row.session.started_at).toLocaleTimeString("zh-CN", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}{" "}
                                的录音
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {row.session.status} · {row.session.language}
                              </p>
                            </div>
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock3 className="size-3.5" aria-hidden="true" />
                              {duration(row.session)}
                            </span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                还没有符合条件的会话记录。
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}
