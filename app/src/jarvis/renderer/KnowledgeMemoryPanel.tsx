import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

export default function KnowledgeMemoryPanel() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<JarvisKnowledgeOverview | null>(null);
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

  if (!overview && !error) return null;
  return (
    <section className="mb-6 rounded-xl border border-border/50 bg-card/70 p-4">
      <h2 className="text-lg font-semibold">
        {t("jarvis.knowledge.longTerm", { defaultValue: "Long-term memory / 长期记忆" })}
      </h2>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t("jarvis.knowledge.loadFailed", {
            defaultValue: "Could not load saved knowledge / 读取失败",
          })}
        </p>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {overview?.memories.map((memory) => (
          <article key={memory.id} className="rounded-lg bg-muted/30 p-3">
            <div className="flex justify-between gap-2">
              <h3 className="text-sm font-medium">{memory.title}</h3>
              <span className="text-[10px] text-muted-foreground">{memory.lifecycle}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{memory.body}</p>
            {memory.occurrences
              .flatMap((occurrence) => occurrence.evidence)
              .map((evidence) => (
                <div
                  key={evidence.handle?.evidenceId ?? evidence.segmentId}
                  className="mt-2 text-xs"
                >
                  <EvidenceLink
                    handle={evidence.handle}
                    quote={evidence.quote}
                    startedAt={evidence.startedAt}
                    audioState={evidence.audioState}
                  />
                </div>
              ))}
          </article>
        ))}
      </div>
      {overview?.suggestions.some((item) => item.state === "proposed") && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Suggestions / 建议</h3>
          {overview.suggestions
            .filter((item) => item.state === "proposed")
            .map((suggestion) => (
              <article key={suggestion.id} className="mt-2 rounded-lg border border-border/50 p-3">
                <p className="text-sm font-medium">{suggestion.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{suggestion.rationale}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void decide(suggestion.id, "accept")}
                  >
                    Accept / 接受
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void decide(suggestion.id, "dismiss")}
                  >
                    Dismiss / 忽略
                  </button>
                </div>
              </article>
            ))}
        </div>
      )}
      {overview?.conflicts.some((item) => item.state === "open") && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Conflicts / 待确认冲突</h3>
          {overview.conflicts
            .filter((item) => item.state === "open")
            .map((conflict) => (
              <div key={conflict.id} className="mt-2 space-y-2">
                {conflict.members.map((member) => (
                  <article
                    key={member.memoryItemId}
                    className="rounded-lg border border-border/50 p-3"
                  >
                    <p className="text-sm font-medium">{member.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{member.body}</p>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void resolve(conflict.id, member.memoryItemId)}
                      className="mt-2 text-xs"
                    >
                      Choose / 选择这一项
                    </button>
                  </article>
                ))}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
