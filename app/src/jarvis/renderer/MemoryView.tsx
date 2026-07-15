import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clock3, Search } from "lucide-react";
import type {
  JarvisRuntimeStatus,
  JarvisSession,
  JarvisSessionDetail,
  JarvisSessionTimeline,
} from "../types";
import { useJarvisStore } from "./jarvisStore";
import ContinuousSessionPlayer from "./ContinuousSessionPlayer";
import DurableTranscript from "./DurableTranscript";
import ProcessingStatus from "./ProcessingStatus";

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

export default function MemoryView() {
  const storedSessions = useJarvisStore((state) => state.sessions);
  const [sessions, setSessions] = useState(storedSessions);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<JarvisSessionDetail | null>(null);
  const [timeline, setTimeline] = useState<JarvisSessionTimeline | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<JarvisRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRequestGeneration = useRef(0);

  useEffect(() => setSessions(storedSessions), [storedSessions]);

  useEffect(
    () => () => {
      detailRequestGeneration.current += 1;
    },
    []
  );

  useEffect(() => {
    const sessionId = detail?.session.id;
    if (!sessionId || !timeline || timeline.processing_state === "ready") return;
    let cancelled = false;
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight || cancelled) return;
      requestInFlight = true;
      try {
        const next = await window.electronAPI.jarvis.getSessionTimeline(sessionId);
        if (!cancelled) setTimeline(next);
      } catch {
        // A transient IPC failure must not stop the next scheduled refresh.
      } finally {
        requestInFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.session.id, timeline]);

  useEffect(() => {
    const sessionId = detail?.session.id;
    const getRuntimeStatus = window.electronAPI?.jarvis?.getRuntimeStatus;
    if (!sessionId || typeof getRuntimeStatus !== "function") return;
    let cancelled = false;
    let requestInFlight = false;
    let timer: number | null = null;
    const delay = () => (document.hidden || !document.hasFocus() ? 2_000 : 1_000);
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

  const groups = useMemo(() => {
    const map = new Map<string, JarvisSession[]>();
    for (const session of sessions) {
      const key = dateLabel(session.started_at);
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    return [...map.entries()];
  }, [sessions]);

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

  const open = async (sessionId: string) => {
    const generation = ++detailRequestGeneration.current;
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
    } catch {
      if (generation !== detailRequestGeneration.current) return;
      setError("无法读取这次录音。");
    } finally {
      if (generation === detailRequestGeneration.current) setLoading(false);
    }
  };

  const analyze = async () => {
    if (!detail) return;
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.jarvis.analyzeSession(detail.session.id, "final");
      const [nextDetail, nextTimeline] = await Promise.all([
        window.electronAPI.jarvis.getSessionDetail(detail.session.id),
        window.electronAPI.jarvis.getSessionTimeline(detail.session.id),
      ]);
      setDetail(nextDetail);
      setTimeline(nextTimeline);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析失败，请检查 MiniMax 设置。");
    } finally {
      setLoading(false);
    }
  };

  if (detail) {
    const decisions = detail.summary
      ? (JSON.parse(detail.summary.decisions_json || "[]") as string[])
      : [];
    const suggestions = detail.summary
      ? (JSON.parse(detail.summary.suggestions_json || "[]") as Array<{
          content: string;
          reason: string;
        }>)
      : [];
    return (
      <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
        <button
          type="button"
          onClick={() => {
            detailRequestGeneration.current += 1;
            setLoading(false);
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
              时长 {duration(detail.session)} · {detail.session.status}
            </p>
          </div>
          {!detail.summary &&
            (detail.segments.length > 0 || (timeline?.segments.length ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => void analyze()}
                disabled={loading}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {loading ? "正在分析…" : "生成总结"}
              </button>
            )}
        </div>
        {error && (
          <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}
        {timeline && (
          <div className="mt-4 rounded-xl border border-border/50 bg-card p-4">
            <ProcessingStatus timeline={timeline} runtimeStatus={runtimeStatus} />
          </div>
        )}
        <DurableTranscript
          sessionId={detail.session.id}
          segments={timeline?.segments.length ? timeline.segments : detail.segments}
        />
        <section className="mt-6 rounded-xl border border-border/50 bg-card p-5">
          <h2 className="font-semibold">完整总结</h2>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
            {detail.summary?.summary ?? "尚未生成总结。录音和转写已安全保存。"}
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
        <div className="mt-4 grid gap-4 md:grid-cols-2">
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
        <section className="mt-4 rounded-xl border border-border/50 bg-card p-5">
          <h2 className="font-semibold">连续会话</h2>
          {timeline ? (
            <div className="mt-4">
              <ContinuousSessionPlayer
                timeline={timeline}
                readChunk={window.electronAPI.jarvis.readAudioChunk}
              />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">正在读取音频时间线…</p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">记忆库</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        所有录音会话、转写、总结和长期记忆都在这里。
      </p>
      <form
        className="mt-5 flex max-w-2xl gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            aria-label="搜索记忆"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索对话、人物或主题"
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
        <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      {loading && !detail && <p className="mt-6 text-sm text-muted-foreground">正在读取…</p>}
      <div className="mt-6 space-y-7">
        {groups.length ? (
          groups.map(([day, items]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{day}</h2>
              <div className="space-y-2">
                {items.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => void open(session.id)}
                    className="flex w-full items-center justify-between rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
                  >
                    <div>
                      <p className="font-medium">
                        {new Date(session.started_at).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        的录音
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {session.status} · {session.language}
                      </p>
                    </div>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock3 className="size-3.5" />
                      {duration(session)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            还没有符合条件的记忆。
          </div>
        )}
      </div>
    </main>
  );
}
