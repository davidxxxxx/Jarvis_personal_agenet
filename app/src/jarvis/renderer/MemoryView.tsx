import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clock3, FileAudio, Search } from "lucide-react";
import type { JarvisSession, JarvisSessionDetail } from "../types";
import { useJarvisStore } from "./jarvisStore";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => setSessions(storedSessions), [storedSessions]);
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    []
  );

  const playAudio = async (chunkId: string) => {
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    if (playingId === chunkId) {
      setPlayingId(null);
      return;
    }
    try {
      const bytes = await window.electronAPI.jarvis.readAudioChunk(chunkId);
      if (!bytes) throw new Error("missing");
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: "audio/wav" }));
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      setPlayingId(chunkId);
      audio.onended = () => setPlayingId(null);
      await audio.play();
    } catch {
      setPlayingId(null);
      setError("音频文件已过期或暂时无法播放。");
    }
  };

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
    setLoading(true);
    setError(null);
    try {
      setDetail(await window.electronAPI.jarvis.getSessionDetail(sessionId));
    } catch {
      setError("无法读取这次录音。");
    } finally {
      setLoading(false);
    }
  };

  const analyze = async () => {
    if (!detail) return;
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.jarvis.analyzeSession(detail.session.id, "final");
      setDetail(await window.electronAPI.jarvis.getSessionDetail(detail.session.id));
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
          onClick={() => setDetail(null)}
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
          {!detail.summary && detail.segments.length > 0 && (
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
          <h2 className="flex items-center gap-2 font-semibold">
            <FileAudio className="size-4" />
            本地音频
          </h2>
          <div className="mt-3 space-y-2">
            {detail.audioChunks.length ? (
              detail.audioChunks.map((chunk) => (
                <div
                  key={chunk.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-xs"
                >
                  <span>{Math.round(chunk.duration_ms / 1000)} 秒音频</span>
                  <span className="ml-auto text-muted-foreground">
                    {chunk.expires_at > Date.now()
                      ? `${new Date(chunk.expires_at).toLocaleDateString("zh-CN")} 自动删除`
                      : "已到期"}
                  </span>
                  <button
                    type="button"
                    disabled={chunk.expires_at <= Date.now()}
                    onClick={() => void playAudio(chunk.id)}
                    className="rounded bg-background px-2 py-1 text-foreground disabled:opacity-40"
                  >
                    {playingId === chunk.id ? "停止" : "播放"}
                  </button>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">音频已过期或本次没有写入音频。</p>
            )}
          </div>
        </section>
        <section className="mt-4 rounded-xl border border-border/50 bg-card p-5">
          <h2 className="font-semibold">完整转写</h2>
          <div className="mt-4 space-y-3">
            {detail.segments.length ? (
              detail.segments.map((segment) => (
                <article key={segment.id} className="rounded-lg bg-muted/30 p-3">
                  <div className="mb-1 text-xs font-medium text-primary">
                    {segment.speaker_label} ·{" "}
                    {new Date(segment.started_at).toLocaleTimeString("zh-CN")}
                  </div>
                  <p className="text-sm leading-6">{segment.text}</p>
                </article>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">没有可用转写。</p>
            )}
          </div>
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
