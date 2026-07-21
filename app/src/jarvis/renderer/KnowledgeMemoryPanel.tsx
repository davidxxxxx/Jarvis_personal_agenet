import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BrainCircuit, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

export default function KnowledgeMemoryPanel() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<JarvisKnowledgeOverview | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (typeof window.electronAPI?.jarvis?.getKnowledgeOverview !== "function") return;
    const request = ++generation.current;
    try {
      const next = await window.electronAPI.jarvis.getKnowledgeOverview();
      if (generation.current === request) {
        setOverview(next);
        setError(false);
      }
    } catch {
      if (generation.current === request) setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const decide = async (suggestionId: string, action: "accept" | "dismiss") => {
    if (busyId) return;
    setBusyId(suggestionId);
    try {
      const result = await window.electronAPI.jarvis.decideKnowledgeSuggestion(
        suggestionId,
        action
      );
      setOverview((current) =>
        current
          ? {
              ...current,
              suggestions: current.suggestions.map((item) =>
                item.id === suggestionId
                  ? {
                      ...item,
                      state: action === "accept" ? "accepted" : "dismissed",
                      decidedAt: result.decidedAt,
                    }
                  : item
              ),
            }
          : current
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  const resolve = async (conflictGroupId: string, selectedMemoryItemId: string) => {
    if (busyId) return;
    setBusyId(conflictGroupId);
    try {
      await window.electronAPI.jarvis.resolveKnowledgeConflict(
        conflictGroupId,
        selectedMemoryItemId
      );
      setOverview((current) =>
        current
          ? {
              ...current,
              conflicts: current.conflicts.map((conflict) =>
                conflict.id === conflictGroupId
                  ? {
                      ...conflict,
                      state: "resolved",
                      selectedMemoryItemId,
                      members: conflict.members.map((member) => ({
                        ...member,
                        selected: member.memoryItemId === selectedMemoryItemId,
                      })),
                    }
                  : conflict
              ),
            }
          : current
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  const proposedSuggestions = overview?.suggestions.filter((item) => item.state === "proposed") ?? [];
  const openConflicts = overview?.conflicts.filter((item) => item.state === "open") ?? [];
  const selectedMemory =
    overview?.memories.find((memory) => memory.id === selectedMemoryId) ?? null;
  const selectedEvidence = useMemo(
    () =>
      selectedMemory?.occurrences.flatMap((occurrence) => occurrence.evidence) ?? [],
    [selectedMemory]
  );
  const visibleMemories = showAll ? overview?.memories ?? [] : overview?.memories.slice(0, 6) ?? [];

  if (!overview && !error) {
    return <p className="text-sm text-muted-foreground">正在读取长期记忆…</p>;
  }

  return (
    <section aria-labelledby="long-term-memory-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="long-term-memory-title" className="text-lg font-semibold">
            长期记忆
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            系统从多次对话中保留下来的事实、决定和偏好。点击一条后再查看原始依据。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-2.5 py-1">
            {overview?.memories.length ?? 0} 条记忆
          </span>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">
            {proposedSuggestions.length} 条建议
          </span>
        </div>
      </header>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t("jarvis.knowledge.loadFailed", {
            defaultValue: "Could not load saved knowledge / 读取失败",
          })}
        </p>
      )}

      {!overview?.memories.length && !error ? (
        <div className="mt-5 rounded-xl border border-dashed border-border p-8 text-center">
          <BrainCircuit className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 font-medium">还没有长期记忆</p>
          <p className="mt-1 text-sm text-muted-foreground">
            当同一事实、决定或偏好在可靠场景中出现后，系统会逐步保存到这里。
          </p>
        </div>
      ) : (
        <div className="mt-5 grid items-start gap-4 lg:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-2">
            {visibleMemories.map((memory) => (
              <button
                type="button"
                key={memory.id}
                aria-label={`查看长期记忆 ${memory.title}`}
                onClick={() => setSelectedMemoryId(memory.id)}
                className={`w-full rounded-xl border bg-card p-4 text-left ${
                  selectedMemoryId === memory.id
                    ? "border-primary/40"
                    : "border-border/50 hover:border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-medium">{memory.title}</h3>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {memory.lifecycle}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">
                  {memory.body}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {memory.occurrences.length} 次相关记录
                </p>
              </button>
            ))}
            {(overview?.memories.length ?? 0) > 6 && (
              <button
                type="button"
                onClick={() => setShowAll((current) => !current)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                {showAll ? "收起" : `显示全部 ${overview?.memories.length ?? 0} 条`}
              </button>
            )}
          </div>

          <div className="rounded-xl border border-border/50 bg-card p-5 lg:sticky lg:top-0">
            {selectedMemory ? (
              <>
                <p className="text-xs font-medium text-primary">记忆详情</p>
                <h3 className="mt-1 text-lg font-semibold">{selectedMemory.title}</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                  {selectedMemory.body}
                </p>
                <details className="mt-5 rounded-lg border border-border/50 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    查看来源证据（{selectedEvidence.length}）
                  </summary>
                  <div className="mt-3 space-y-2">
                    {selectedEvidence.map((evidence) => (
                      <EvidenceLink
                        key={evidence.handle?.evidenceId ?? evidence.segmentId}
                        handle={evidence.handle}
                        quote={evidence.quote}
                        startedAt={evidence.startedAt}
                        audioState={evidence.audioState}
                      />
                    ))}
                  </div>
                </details>
              </>
            ) : (
              <div className="py-12 text-center">
                <BrainCircuit className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 font-medium">选择一条长期记忆</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  原始转写和音频证据默认收起，不会再全部铺开。
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {proposedSuggestions.length > 0 && (
        <details className="mt-5 rounded-xl border border-border/50 bg-card p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <Lightbulb className="size-4 text-amber-600" aria-hidden="true" />
            候选建议（{proposedSuggestions.length}）
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            建议不会自动成为待办，也不会通过系统弹窗打扰你。
          </p>
          <div className="mt-3 space-y-2">
            {proposedSuggestions.map((suggestion) => (
              <article key={suggestion.id} className="rounded-lg border border-border/50 p-3">
                <p className="text-sm font-medium">{suggestion.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{suggestion.rationale}</p>
                <div className="mt-3 flex gap-2 text-xs">
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void decide(suggestion.id, "accept")}
                    className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
                  >
                    Accept / 接受
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void decide(suggestion.id, "dismiss")}
                    className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-50"
                  >
                    Dismiss / 忽略
                  </button>
                </div>
              </article>
            ))}
          </div>
        </details>
      )}

      {openConflicts.length > 0 && (
        <details className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50/50 p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 text-amber-700" aria-hidden="true" />
            待确认冲突（{openConflicts.length}）
          </summary>
          <div className="mt-3 space-y-4">
            {openConflicts.map((conflict) => (
              <div key={conflict.id} className="space-y-2">
                {conflict.members.map((member) => (
                  <article key={member.memoryItemId} className="rounded-lg bg-background p-3">
                    <p className="text-sm font-medium">{member.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{member.body}</p>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void resolve(conflict.id, member.memoryItemId)}
                      className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      Choose / 选择这一项
                    </button>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
