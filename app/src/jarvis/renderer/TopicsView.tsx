import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

export default function TopicsView() {
  const { t } = useTranslation();
  const [topics, setTopics] = useState<JarvisKnowledgeOverview["topics"]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const selected = topics.find((topic) => topic.id === selectedId) ?? null;
  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">{t("jarvis.topics")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("jarvis.knowledge.topicsDescription", {
          defaultValue:
            "Related conversations are grouped into durable topics / 相同事情会归入长期主题",
        })}
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t("jarvis.knowledge.loadFailed", {
            defaultValue: "Could not load saved knowledge / 读取失败",
          })}
        </p>
      )}
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {topics.map((topic) => {
          const latest = topic.revisions.at(-1);
          return (
            <button
              type="button"
              key={topic.id}
              aria-label={`${topic.name} · ${topic.revisions.length}`}
              onClick={() => setSelectedId(topic.id)}
              className="rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
            >
              <p className="font-medium">{topic.name}</p>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{latest?.summary}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                v{latest?.revision ?? 0} · {topic.occurrences.length} evidence / 条证据
              </p>
            </button>
          );
        })}
      </div>
      {!topics.length && !error && (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("jarvis.knowledge.noTopics", {
            defaultValue: "No saved topics yet / 还没有已保存主题",
          })}
        </p>
      )}
      {selected && (
        <section className="mt-6 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex justify-between gap-4">
            <h2 className="text-lg font-semibold">{selected.name}</h2>
            <button type="button" onClick={() => setSelectedId(null)} className="text-xs">
              {t("common.close", { defaultValue: "Close / 关闭" })}
            </button>
          </div>
          <h3 className="mt-5 text-sm font-semibold">
            {t("jarvis.knowledge.revisions", { defaultValue: "Revision history / 版本历史" })}
          </h3>
          <ol className="mt-2 space-y-2">
            {[...selected.revisions].reverse().map((revision) => (
              <li key={revision.id} className="rounded-lg bg-muted/30 p-3 text-sm">
                <span className="text-xs text-muted-foreground">v{revision.revision}</span>
                <p className="mt-1">{revision.summary}</p>
              </li>
            ))}
          </ol>
          <h3 className="mt-5 text-sm font-semibold">
            {t("jarvis.knowledge.evidence", { defaultValue: "Evidence / 来源证据" })}
          </h3>
          <ul className="mt-2 space-y-2">
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
        </section>
      )}
    </main>
  );
}
