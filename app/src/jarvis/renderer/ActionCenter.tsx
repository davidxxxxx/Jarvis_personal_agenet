import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Lightbulb,
  ListTodo,
  Undo2,
  X,
} from "lucide-react";
import type { JarvisKnowledgeOverview } from "../types";

type Todo = JarvisKnowledgeOverview["todos"][number];
type Suggestion = JarvisKnowledgeOverview["suggestions"][number];

interface ActionCenterProps {
  sessionId: string | null;
  sessionStatus: string;
  onViewAll: () => void;
}

function localDateKey(at: number) {
  const value = new Date(at);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dueBucket(todo: Todo, now: number): "now" | "later" {
  const dueText = todo.revisions.at(-1)?.dueText?.trim();
  if (!dueText) return "later";
  if (/^(?:today|今天|今日)$/iu.test(dueText)) return "now";
  const matched = dueText.match(/\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\b/u);
  if (!matched) return "later";
  const due = `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}`;
  return due <= localDateKey(now) ? "now" : "later";
}

function sourceLabel(todo: Todo) {
  if (todo.sourceSuggestionId || todo.provenance === "suggestion") return "由候选建议转为待办";
  if (todo.verificationReason === "strict_self_commitment") return "SELF 明确承诺 · 自动提取";
  if (todo.verificationReason === "assigned_and_accepted") return "他人分配且 SELF 已接受";
  if (todo.verificationActor === "user") return "你已确认";
  return todo.occurrences.at(-1)?.sessionId ? "来自录音" : "手动创建";
}

function TodoRow({
  todo,
  busy,
  onAction,
  compact = false,
}: {
  todo: Todo;
  busy: boolean;
  onAction: (todo: Todo, action: "confirm" | "dismiss" | "complete" | "reopen") => void;
  compact?: boolean;
}) {
  const dueText = todo.revisions.at(-1)?.dueText;
  return (
    <article className="rounded-lg border border-border/50 bg-background/70 p-3">
      <div className="flex items-start gap-2">
        {todo.status === "completed" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
        ) : (
          <Clock3 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5 text-foreground">{todo.title}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {sourceLabel(todo)}
            {dueText ? ` · ${dueText}` : ""}
          </p>
        </div>
      </div>
      {!compact && (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {todo.status === "open" && todo.verificationState === "pending_confirmation" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction(todo, "confirm")}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
                aria-label={`Confirm / 确认 ${todo.title}`}
              >
                <Check className="size-3" aria-hidden="true" />
                确认
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction(todo, "dismiss")}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
                aria-label={`Dismiss / 忽略 ${todo.title}`}
              >
                <X className="size-3" aria-hidden="true" />
                忽略
              </button>
            </>
          )}
          {todo.status === "open" && todo.verificationState === "confirmed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(todo, "complete")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
              aria-label={`Complete / 完成 ${todo.title}`}
            >
              <Check className="size-3" aria-hidden="true" />
              完成
            </button>
          )}
          {todo.status === "completed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(todo, "reopen")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
              aria-label={`Reopen / 撤销完成 ${todo.title}`}
            >
              <Undo2 className="size-3" aria-hidden="true" />
              撤销完成
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function CollapsibleSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between py-1 text-left text-xs font-medium text-muted-foreground"
        aria-expanded={open}
      >
        <span>
          {title} {count > 0 ? `(${count})` : ""}
        </span>
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
      </button>
      {open && <div className="mt-1.5 space-y-2">{children}</div>}
    </section>
  );
}

export default function ActionCenter({
  sessionId,
  sessionStatus,
  onViewAll,
}: ActionCenterProps) {
  const [overview, setOverview] = useState<JarvisKnowledgeOverview | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await window.electronAPI.jarvis.getKnowledgeOverview();
      if (generation.current !== request) return;
      setOverview(next);
      setError(false);
    } catch {
      if (generation.current === request) setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, sessionId, sessionStatus]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      generation.current += 1;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load]);

  const now = Date.now();
  const partitions = useMemo(() => {
    const todos = overview?.todos ?? [];
    const actionable = todos.filter(
      (todo) => todo.status === "open" && todo.verificationState === "confirmed"
    );
    return {
      now: actionable.filter((todo) => dueBucket(todo, now) === "now"),
      pending: todos.filter(
        (todo) =>
          todo.status === "open" && todo.verificationState === "pending_confirmation"
      ),
      later: actionable.filter((todo) => dueBucket(todo, now) === "later"),
      completed: todos.filter(
        (todo) =>
          todo.status === "completed" &&
          todo.completedAt !== null &&
          localDateKey(todo.completedAt) === localDateKey(now)
      ),
      suggestions: (overview?.suggestions ?? []).filter(
        (suggestion) => suggestion.state === "proposed"
      ),
    };
  }, [overview, now]);

  const todoAction = async (
    todo: Todo,
    action: "confirm" | "dismiss" | "complete" | "reopen"
  ) => {
    if (busyId) return;
    setBusyId(todo.id);
    try {
      if (action === "complete") {
        await window.electronAPI.jarvis.completeKnowledgeTodo(todo.id);
      } else {
        await window.electronAPI.jarvis.decideKnowledgeTodo(todo.id, action);
      }
      await load();
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  const suggestionAction = async (
    suggestion: Suggestion,
    action: "accept" | "dismiss"
  ) => {
    if (busyId) return;
    setBusyId(suggestion.id);
    try {
      await window.electronAPI.jarvis.decideKnowledgeSuggestion(suggestion.id, action);
      await load();
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm"
      aria-labelledby="action-center-title"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <ListTodo className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h2 id="action-center-title" className="text-sm font-semibold">
              行动中心
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              只显示与你明确相关的待办和候选建议
            </p>
          </div>
        </div>
        {partitions.pending.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            待确认 {partitions.pending.length}
          </span>
        )}
      </header>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          行动数据暂时不可用，请稍后重试。
        </p>
      )}

      <div className="mt-4 space-y-3">
        <section>
          <h3 className="text-xs font-semibold text-foreground">现在要做</h3>
          <div className="mt-1.5 space-y-2">
            {partitions.now.length > 0 ? (
              partitions.now.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  busy={busyId !== null}
                  onAction={(item, action) => void todoAction(item, action)}
                />
              ))
            ) : (
              <p className="rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                今天没有到期或逾期的正式待办。
              </p>
            )}
          </div>
        </section>

        {partitions.pending.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-amber-800">
              待你确认 ({partitions.pending.length})
            </h3>
            <div className="mt-1.5 space-y-2">
              {partitions.pending.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  busy={busyId !== null}
                  onAction={(item, action) => void todoAction(item, action)}
                />
              ))}
            </div>
          </section>
        )}

        {partitions.suggestions.length > 0 && (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Lightbulb className="size-3.5 text-amber-600" aria-hidden="true" />
              候选建议
            </h3>
            <div className="mt-1.5 space-y-2">
              {partitions.suggestions.slice(0, 3).map((suggestion) => (
                <article
                  key={suggestion.id}
                  className="rounded-lg border border-border/50 bg-background/70 p-3"
                >
                  <p className="text-sm font-medium">{suggestion.title}</p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {suggestion.rationale}
                  </p>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void suggestionAction(suggestion, "accept")}
                      className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
                      aria-label={`Accept suggestion / 接受建议 ${suggestion.title}`}
                    >
                      接受为待办
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void suggestionAction(suggestion, "dismiss")}
                      className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
                      aria-label={`Dismiss suggestion / 忽略建议 ${suggestion.title}`}
                    >
                      忽略
                    </button>
                  </div>
                </article>
              ))}
              {partitions.suggestions.length > 3 && (
                <p className="text-center text-[11px] text-muted-foreground">
                  其余 {partitions.suggestions.length - 3} 条请在 Todo 页面查看
                </p>
              )}
            </div>
          </section>
        )}

        <CollapsibleSection
          title="稍后"
          count={partitions.later.length}
          open={laterOpen}
          onToggle={() => setLaterOpen((value) => !value)}
        >
          {partitions.later.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              busy={busyId !== null}
              onAction={(item, action) => void todoAction(item, action)}
            />
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          title="今日已完成"
          count={partitions.completed.length}
          open={completedOpen}
          onToggle={() => setCompletedOpen((value) => !value)}
        >
          {partitions.completed.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              busy={busyId !== null}
              onAction={(item, action) => void todoAction(item, action)}
            />
          ))}
        </CollapsibleSection>
      </div>

      <button
        type="button"
        onClick={onViewAll}
        className="mt-4 w-full rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        查看全部待办与历史
      </button>
    </section>
  );
}
