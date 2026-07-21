import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpenText, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

export default function TopicsView() {
  const { t } = useTranslation();
  const [topics, setTopics] = useState<JarvisKnowledgeOverview["topics"]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    void window.electronAPI.jarvis
      .getKnowledgeOverview()
      .then((overview) => {
        if (generation.current === request) {
          setTopics(overview.topics);
          setError(false);
        }
      })
      .catch(() => {
        if (generation.current === request) setError(true);
      });
    return () => {
      generation.current += 1;
    };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return topics;
    return topics.filter((topic) => {
      const latest = topic.revisions.at(-1);
      return `${topic.name}\n${latest?.summary ?? ""}`.toLocaleLowerCase().includes(normalized);
    });
  }, [query, topics]);
  const selected = topics.find((topic) => topic.id === selectedId) ?? null;
  const evidenceCount = selected
    ? selected.occurrences.reduce((total, occurrence) => total + occurrence.evidence.length, 0)
    : 0;

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">主题 Topics</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            相同事情会持续归入同一个主题。左侧只显示概览，选择后再查看总结、版本和来源。
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          {topics.length} 个主题
        </span>
      </header>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t("jarvis.knowledge.loadFailed", {
            defaultValue: "Could not load saved knowledge / 读取失败",
          })}
        </p>
      )}

      {!topics.length && !error ? (
        <section className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <BookOpenText className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 font-medium">还没有长期主题</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            完成录音和总结后，相似的工作、学习、社交或娱乐内容会自动归到这里。
          </p>
        </section>
      ) : (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <section className="rounded-xl border border-border/50 bg-card p-3">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3">
              <Search className="size-4 text-muted-foreground" aria-hidden="true" />
              <input
                aria-label="搜索主题"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索主题"
                className="w-full bg-transparent py-2.5 text-sm outline-none"
              />
            </label>
            <div className="mt-3 space-y-1.5">
              {filtered.map((topic) => {
                const latest = topic.revisions.at(-1);
                const active = topic.id === selectedId;
                return (
                  <button
                    type="button"
                    key={topic.id}
                    aria-label={`打开主题 ${topic.name}`}
                    onClick={() => setSelectedId(topic.id)}
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                      active
                        ? "border-primary/40 bg-primary/10"
                        : "border-transparent hover:border-border hover:bg-muted/40"
                    }`}
                  >
                    <p className="font-medium">{topic.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {latest?.summary || "尚无主题摘要"}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {topic.occurrences.length} 条记录 · 更新 {topic.revisions.length} 次
                    </p>
                  </button>
                );
              })}
              {!filtered.length && (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的主题</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border/50 bg-card p-5 lg:sticky lg:top-0">
            {selected ? (
              <>
                <p className="text-xs font-medium text-primary">主题详情</p>
                <h2 className="mt-1 text-xl font-semibold">{selected.name}</h2>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                  {selected.revisions.at(-1)?.summary || "尚无主题摘要"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {selected.occurrences.length} 条相关记录
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1">{evidenceCount} 条证据</span>
                </div>

                <details className="mt-5 rounded-lg border border-border/50 p-3">
                  <summary className="cursor-pointer text-sm font-medium">查看版本历史</summary>
                  <ol className="mt-3 space-y-2">
                    {[...selected.revisions].reverse().map((revision) => (
                      <li key={revision.id} className="rounded-lg bg-muted/30 p-3 text-sm">
                        <span className="text-xs text-muted-foreground">v{revision.revision}</span>
                        <p className="mt-1">{revision.summary}</p>
                      </li>
                    ))}
                  </ol>
                </details>

                <details className="mt-3 rounded-lg border border-border/50 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    查看来源证据（{evidenceCount}）
                  </summary>
                  <ul className="mt-3 space-y-2">
                    {selected.occurrences.flatMap((occurrence) =>
                      occurrence.evidence.map((evidence) => (
                        <li key={`${occurrence.id}:${evidence.segmentId}`} className="text-sm">
                          <EvidenceLink
                            handle={evidence.handle}
                            quote={evidence.quote}
                            startedAt={evidence.startedAt}
                            audioState={evidence.audioState}
                          />
                        </li>
                      ))
                    )}
                  </ul>
                </details>
              </>
            ) : (
              <div className="py-16 text-center">
                <BookOpenText className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                <h2 className="mt-3 font-medium">选择一个主题</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  这里会显示简明总结；版本历史和原始证据默认收起。
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
