import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

type Todo = JarvisKnowledgeOverview["todos"][number];

export default function TodosView() {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<"open" | "completed" | null>("open");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    void window.electronAPI.jarvis
      .getKnowledgeOverview()
      .then((overview) => {
        if (generation.current === request) {
          setTodos(overview.todos);
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

  const complete = async (todo: Todo) => {
    if (busyId || todo.status !== "open") return;
    setBusyId(todo.id);
    try {
      const result = await window.electronAPI.jarvis.completeKnowledgeTodo(todo.id);
      setTodos((current) =>
        current.map((item) =>
          item.id === todo.id
            ? { ...item, status: "completed", completedAt: result.completedAt }
            : item
        )
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  const visible = todos.filter((todo) => filter === null || todo.status === filter);
  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">{t("jarvis.todos")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("jarvis.knowledge.todosDescription", {
          defaultValue: "Conversation commitments with durable evidence / 从对话提取并保留来源证据",
        })}
      </p>
      <div className="mt-5 flex gap-2">
        {(
          [
            ["open", "Open / 未完成"],
            ["completed", "Completed / 已完成"],
            [null, "All / 全部"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={String(value)}
            onClick={() => setFilter(value)}
            className={`rounded-full px-3 py-1.5 text-xs ${filter === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t("jarvis.knowledge.actionFailed", { defaultValue: "Action failed / 操作失败" })}
        </p>
      )}
      <div className="mt-5 space-y-2">
        {visible.map((todo) => {
          const latest = todo.revisions.at(-1);
          return (
            <article
              key={todo.id}
              className="flex gap-3 rounded-xl border border-border/50 bg-card p-4"
            >
              {todo.status === "open" ? (
                <button
                  type="button"
                  disabled={busyId !== null}
                  aria-label={`Complete / 完成 ${todo.title}`}
                  onClick={() => void complete(todo)}
                  className="mt-0.5 size-5 rounded border border-border disabled:opacity-50"
                />
              ) : (
                <span aria-label="Completed / 已完成" className="mt-0.5 text-primary">
                  ✓
                </span>
              )}
              <div className="min-w-0">
                <p
                  className={
                    todo.status === "completed" ? "text-muted-foreground line-through" : ""
                  }
                >
                  {todo.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {todo.ownerLabel ??
                    t("jarvis.knowledge.unassigned", { defaultValue: "Unassigned / 未指定" })}
                  {latest?.dueText ? ` · ${latest.dueText}` : ""}
                  {` · v${latest?.revision ?? 0}`}
                </p>
                <div className="mt-2 space-y-2">
                  {todo.occurrences
                    .flatMap((occurrence) => occurrence.evidence)
                    .map((evidence) => (
                      <EvidenceLink
                        key={evidence.handle?.evidenceId ?? evidence.segmentId}
                        handle={evidence.handle}
                        quote={evidence.quote}
                        startedAt={evidence.startedAt}
                        audioState={evidence.audioState}
                      />
                    ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length && !error && (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("jarvis.knowledge.noTodos", { defaultValue: "No todos in this view / 当前没有待办" })}
        </p>
      )}
    </main>
  );
}
