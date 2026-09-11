import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Flag,
  Lightbulb,
  ListTodo,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  JarvisActivityCategory,
  JarvisKnowledgeCardContext,
  JarvisKnowledgeDismissReason,
  JarvisKnowledgeOverview,
} from "../types";
import ActionEvidenceDetails from "./ActionEvidenceDetails";
import {
  createKnowledgeActionId,
  IgnoreReasonDialog,
  TodoComposerDialog,
} from "./KnowledgeActionDialogs";
import TodoReminderControl, { type TodoReminderSnapshot } from "./TodoReminderControl";
import useAccessibleDrawer from "./useAccessibleDrawer";

type Todo = JarvisKnowledgeOverview["todos"][number];
type Suggestion = JarvisKnowledgeOverview["suggestions"][number];
type Filter = "actionable" | "pending" | "suggestions" | "completed" | "dismissed" | null;
type KnowledgeLoadState = "loading" | "ready" | "failed";

type ComposerState =
  | { kind: "manual"; commandId: string; todoId: string }
  | { kind: "edit"; commandId: string; todo: Todo }
  | { kind: "suggestion"; commandId: string; todoId: string; suggestion: Suggestion };

type IgnoreState =
  | { kind: "todo"; commandId: string; todo: Todo }
  | { kind: "suggestion"; commandId: string; suggestion: Suggestion };

type TodoMutationAction = "confirm" | "complete" | "reopen";
type FailedTodoMutation =
  | {
      kind: "lifecycle";
      entityId: string;
      action: TodoMutationAction;
      previousTodo: Todo;
    }
  | {
      kind: "dismiss";
      entityId: string;
      commandId: string;
      reasonCode: JarvisKnowledgeDismissReason;
      localNote: string | null;
      previousTodo: Todo;
    };

const TODO_WATERMARK_VISIBLE_POLL_MS = 10_000;
const TODO_WATERMARK_HIDDEN_POLL_MS = 60_000;
const COMPACT_TODO_DETAIL_QUERY = "(max-width: 1023px)";

function compactTodoDetailMatches(): boolean {
  return (
    typeof window.matchMedia === "function" && window.matchMedia(COMPACT_TODO_DETAIL_QUERY).matches
  );
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function todoSearchText(todo: Todo) {
  return [
    todo.title,
    todo.ownerLabel,
    ...todo.revisions.flatMap((revision) => [revision.title, revision.dueText]),
    ...todo.occurrences.flatMap((occurrence) =>
      occurrence.evidence.map((evidence) => evidence.quote)
    ),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function suggestionSearchText(suggestion: Suggestion) {
  return [
    suggestion.title,
    suggestion.rationale,
    ...suggestion.occurrences.flatMap((occurrence) =>
      occurrence.evidence.map((evidence) => evidence.quote)
    ),
  ].join("\n");
}

function todoSourceLabel(todo: Todo): string {
  if (todo.sourceKind === "manual") return "手动创建";
  if (todo.sourceKind === "transcript") return "从转写创建";
  if (todo.sourceKind === "suggestion" || todo.sourceSuggestionId) return "由候选建议转为待办";
  if (todo.verificationReason === "strict_self_commitment") return "SELF 明确承诺 · 自动提取";
  if (todo.verificationReason === "assigned_and_accepted") return "他人分配且 SELF 已接受";
  return todo.occurrences.some((occurrence) => occurrence.sessionId) ? "来自录音" : "历史待办";
}

const ACTIVITY_LABELS: Record<JarvisActivityCategory, string> = {
  work_meeting: "工作会议",
  learning: "学习",
  social_call: "社交通话",
  in_person_conversation: "面对面对话",
  entertainment: "娱乐",
  gaming: "游戏",
  other: "其他",
  unknown: "未确定",
};

function cardApplicationLabel(context: JarvisKnowledgeCardContext) {
  if (context.sourceAttribution === "microphone") return "麦克风";
  if (context.sourceAttribution === "mixed_unknown" || !context.applicationName) {
    return "应用未知";
  }
  return context.sourceAttribution === "application_and_microphone"
    ? `${context.applicationName} + 麦克风`
    : context.applicationName;
}

function cardActivityLabel(context: JarvisKnowledgeCardContext) {
  if (!context.activityCategory || context.activityCategory === "unknown") return "场景未确定";
  return `场景 ${ACTIVITY_LABELS[context.activityCategory]}`;
}

function cardSessionTime(context: JarvisKnowledgeCardContext) {
  if (context.startedAt === null) return "会话时间未知";
  return `会话 ${new Date(context.startedAt).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function CardContextSummary({
  context,
  title,
}: {
  context: JarvisKnowledgeCardContext;
  title: string;
}) {
  return (
    <p
      aria-label={`来源摘要 ${title}`}
      className="mt-1 flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground"
    >
      <span>{cardApplicationLabel(context)}</span>
      <span aria-hidden="true">·</span>
      <span>{cardActivityLabel(context)}</span>
      <span aria-hidden="true">·</span>
      <span>{cardSessionTime(context)}</span>
    </p>
  );
}

function TodoMutationFailure({
  title,
  busy,
  onRetry,
}: {
  title: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
    >
      <span>操作未保存，已恢复原状态。</span>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        aria-label={`Retry action / 重试 ${title}`}
        className="rounded-md border border-destructive/30 px-2 py-1 font-medium disabled:opacity-50"
      >
        {busy ? "正在重试…" : "重试"}
      </button>
    </div>
  );
}

export default function TodosView() {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [filter, setFilter] = useState<Filter>("actionable");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedMutations, setFailedMutations] = useState<Record<string, FailedTodoMutation>>({});
  const [error, setError] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<IgnoreState | null>(null);
  const [compactDetail, setCompactDetail] = useState(compactTodoDetailMatches);
  const [loadState, setLoadState] = useState<KnowledgeLoadState>("loading");
  const generation = useRef(0);
  const mutationInFlight = useRef(false);
  const hasSnapshot = useRef(false);
  const watermarkRevision = useRef<string | null>(null);
  const watermarkCheckInFlight = useRef(false);
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailCloseRef = useRef<HTMLButtonElement | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const watermark = await window.electronAPI.jarvis.getActionCenterWatermark();
      const delta = await window.electronAPI.jarvis.getActionCenterDelta();
      // Read the durable unread boundary first so markActionCenterRead can never
      // acknowledge an action that was not yet present in the overview shown here.
      const overview = await window.electronAPI.jarvis.getKnowledgeOverview();
      if (generation.current !== request) return;
      if (mutationInFlight.current) return;
      let readFailed = false;
      if (delta.throughSequence > delta.lastSeenSequence) {
        try {
          await window.electronAPI.jarvis.markActionCenterRead(delta.throughSequence);
        } catch {
          readFailed = true;
        }
      }
      if (generation.current !== request) return;
      watermarkRevision.current = watermark.revision;
      setTodos(overview.todos);
      setSuggestions(overview.suggestions);
      hasSnapshot.current = true;
      setLoadState("ready");
      setError(readFailed);
    } catch {
      if (generation.current === request) {
        setError(true);
        if (!hasSnapshot.current) setLoadState("failed");
      }
    }
  }, []);

  const retryLoad = useCallback(() => {
    setError(false);
    if (!hasSnapshot.current) setLoadState("loading");
    void load();
  }, [load]);

  const refreshWhenTodosChange = useCallback(async () => {
    if (watermarkCheckInFlight.current) return;
    watermarkCheckInFlight.current = true;
    try {
      const watermark = await window.electronAPI.jarvis.getActionCenterWatermark();
      if (watermarkRevision.current === null || watermark.revision !== watermarkRevision.current) {
        await load();
      }
    } catch {
      // Keep the durable snapshot visible and retry on the next lightweight poll.
    } finally {
      watermarkCheckInFlight.current = false;
    }
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshWhenTodosChange();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [refreshWhenTodosChange]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      const delay =
        document.visibilityState === "visible"
          ? TODO_WATERMARK_VISIBLE_POLL_MS
          : TODO_WATERMARK_HIDDEN_POLL_MS;
      timer = window.setTimeout(async () => {
        await refreshWhenTodosChange();
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshWhenTodosChange]);

  const applyOptimisticMutation = useCallback((mutation: FailedTodoMutation) => {
    const occurredAt = Date.now();
    setTodos((current) =>
      current.map((todo) => {
        if (todo.id !== mutation.entityId) return todo;
        if (mutation.kind === "dismiss") {
          return {
            ...todo,
            status: "dismissed",
            dismissedAt: occurredAt,
            verificationState: "dismissed",
            verificationReason: "user_dismissed",
            verificationActor: "user",
            dismissReasonCode: mutation.reasonCode,
            updatedAt: occurredAt,
          };
        }
        if (mutation.action === "confirm") {
          return {
            ...todo,
            verificationState: "confirmed",
            verificationReason: "user_confirmed",
            verificationActor: "user",
            updatedAt: occurredAt,
          };
        }
        if (mutation.action === "reopen") {
          return { ...todo, status: "open", completedAt: null, updatedAt: occurredAt };
        }
        return {
          ...todo,
          status: "completed",
          completedAt: occurredAt,
          updatedAt: occurredAt,
          reminder:
            todo.reminder?.state === "scheduled" || todo.reminder?.state === "deferred"
              ? {
                  ...todo.reminder,
                  state: "cancelled",
                  deferredReason: null,
                  deliveredAt: null,
                }
              : todo.reminder,
        };
      })
    );
  }, []);

  const rollbackMutation = useCallback((mutation: FailedTodoMutation) => {
    setTodos((current) =>
      current.some((todo) => todo.id === mutation.previousTodo.id)
        ? current.map((todo) =>
            todo.id === mutation.previousTodo.id ? mutation.previousTodo : todo
          )
        : [...current, mutation.previousTodo]
    );
  }, []);

  const executeMutation = useCallback(
    async (mutation: FailedTodoMutation) => {
      if (mutationInFlight.current || busyId) return;
      mutationInFlight.current = true;
      setBusyId(mutation.entityId);
      setFailedMutations((current) => {
        if (!(mutation.entityId in current)) return current;
        const next = { ...current };
        delete next[mutation.entityId];
        return next;
      });
      applyOptimisticMutation(mutation);
      try {
        if (mutation.kind === "dismiss") {
          await window.electronAPI.jarvis.applyKnowledgeAction({
            commandId: mutation.commandId,
            type: "todo_dismiss",
            todoId: mutation.entityId,
            reasonCode: mutation.reasonCode,
            localNote: mutation.localNote,
          });
        } else if (mutation.action === "complete") {
          const result = await window.electronAPI.jarvis.completeKnowledgeTodo(mutation.entityId);
          setTodos((current) =>
            current.map((todo) =>
              todo.id === mutation.entityId ? { ...todo, completedAt: result.completedAt } : todo
            )
          );
        } else {
          await window.electronAPI.jarvis.decideKnowledgeTodo(mutation.entityId, mutation.action);
        }
        setFailedMutations((current) => {
          if (!(mutation.entityId in current)) return current;
          const next = { ...current };
          delete next[mutation.entityId];
          return next;
        });
      } catch {
        rollbackMutation(mutation);
        setFailedMutations((current) => ({ ...current, [mutation.entityId]: mutation }));
      } finally {
        mutationInFlight.current = false;
        setBusyId(null);
      }
    },
    [applyOptimisticMutation, busyId, rollbackMutation]
  );

  const complete = (todo: Todo) => {
    if (todo.status !== "open" || todo.verificationState !== "confirmed") return;
    void executeMutation({
      kind: "lifecycle",
      entityId: todo.id,
      action: "complete",
      previousTodo: todo,
    });
  };

  const decide = (todo: Todo, action: "confirm" | "reopen") => {
    void executeMutation({
      kind: "lifecycle",
      entityId: todo.id,
      action,
      previousTodo: todo,
    });
  };

  const applyInstantAction = async (
    entityId: string,
    input: Parameters<typeof window.electronAPI.jarvis.applyKnowledgeAction>[0]
  ) => {
    if (busyId) return;
    setBusyId(entityId);
    try {
      await window.electronAPI.jarvis.applyKnowledgeAction(input);
      await load();
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  };

  const submitComposer = async (value: { title: string; dueText: string | null }) => {
    if (!composer || busyId) return;
    const entityId = composer.kind === "suggestion" ? composer.suggestion.id : composer.kind;
    setBusyId(entityId);
    try {
      if (composer.kind === "manual") {
        await window.electronAPI.jarvis.applyKnowledgeAction({
          commandId: composer.commandId,
          type: "manual_create",
          todoId: composer.todoId,
          ...value,
        });
      } else if (composer.kind === "edit") {
        const previousDueText = composer.todo.revisions.at(-1)?.dueText?.trim() || null;
        if (composer.todo.title.trim() === value.title && previousDueText === value.dueText) {
          setComposer(null);
          return;
        }
        await window.electronAPI.jarvis.applyKnowledgeAction({
          commandId: composer.commandId,
          type: "title_due_edit",
          todoId: composer.todo.id,
          title: value.title,
          dueText: value.dueText,
        });
      } else {
        await window.electronAPI.jarvis.applyKnowledgeAction({
          commandId: composer.commandId,
          type: "suggestion_accept",
          suggestionId: composer.suggestion.id,
          todoId: composer.todoId,
          ...value,
        });
      }
      setComposer(null);
      await load();
      setError(false);
    } catch (caught) {
      setError(true);
      throw caught;
    } finally {
      setBusyId(null);
    }
  };

  const submitIgnore = async (
    reasonCode: JarvisKnowledgeDismissReason,
    localNote: string | null
  ) => {
    if (!ignoreTarget || busyId) return;
    const target = ignoreTarget;
    if (target.kind === "todo") {
      setIgnoreTarget(null);
      void executeMutation({
        kind: "dismiss",
        entityId: target.todo.id,
        commandId: target.commandId,
        reasonCode,
        localNote,
        previousTodo: target.todo,
      });
      return;
    }

    setBusyId(target.suggestion.id);
    try {
      await window.electronAPI.jarvis.applyKnowledgeAction({
        commandId: target.commandId,
        type: "suggestion_dismiss",
        suggestionId: target.suggestion.id,
        reasonCode,
      });
      setIgnoreTarget(null);
      await load();
      setError(false);
    } catch (caught) {
      setError(true);
      throw caught;
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(
    () => ({
      actionable: todos.filter(
        (todo) => todo.status === "open" && todo.verificationState === "confirmed"
      ).length,
      pending: todos.filter(
        (todo) => todo.status === "open" && todo.verificationState === "pending_confirmation"
      ).length,
      completed: todos.filter((todo) => todo.status === "completed").length,
      dismissed: todos.filter((todo) => todo.status === "dismissed").length,
      suggestions: suggestions.filter((suggestion) => suggestion.state === "proposed").length,
      suggestionHistory: suggestions.length,
      all: todos.length + suggestions.length,
    }),
    [suggestions, todos]
  );
  const normalizedSearchQuery = useMemo(
    () => normalizeSearchText(searchQuery.trim()),
    [searchQuery]
  );
  const visible = useMemo(
    () =>
      todos.filter((todo) => {
        if (
          normalizedSearchQuery &&
          !normalizeSearchText(todoSearchText(todo)).includes(normalizedSearchQuery)
        ) {
          return false;
        }
        if (filter === null) return true;
        if (filter === "completed") return todo.status === "completed";
        if (filter === "dismissed") return todo.status === "dismissed";
        if (filter === "pending") {
          return todo.status === "open" && todo.verificationState === "pending_confirmation";
        }
        if (filter === "suggestions") return false;
        return todo.status === "open" && todo.verificationState === "confirmed";
      }),
    [filter, normalizedSearchQuery, todos]
  );
  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter((suggestion) => {
        if (
          normalizedSearchQuery &&
          !normalizeSearchText(suggestionSearchText(suggestion)).includes(normalizedSearchQuery)
        ) {
          return false;
        }
        if (filter === "suggestions" || filter === null) return true;
        return filter === "actionable" && suggestion.state === "proposed";
      }),
    [filter, normalizedSearchQuery, suggestions]
  );
  const hasVisibleResults = visible.length > 0 || visibleSuggestions.length > 0;
  const selected = todos.find((todo) => todo.id === selectedId) ?? null;
  const selectedEvidence = selected
    ? selected.occurrences.flatMap((occurrence) => occurrence.evidence)
    : [];
  const closeSelected = useCallback(() => {
    const trigger = selectedTriggerRef.current;
    setSelectedId(null);
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(COMPACT_TODO_DETAIL_QUERY);
    const update = () => setCompactDetail(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener?.(update);
    return () => media.removeListener?.(update);
  }, []);

  useAccessibleDrawer({
    open: Boolean(selected && compactDetail),
    containerRef: detailPanelRef,
    initialFocusRef: detailCloseRef,
    returnFocusRef: selectedTriggerRef,
    onDismiss: closeSelected,
  });
  const updateReminder = (todoId: string, reminder: TodoReminderSnapshot | null) => {
    setTodos((current) =>
      current.map((todo) => (todo.id === todoId ? { ...todo, reminder } : todo))
    );
  };

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">待办 Todos</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            这里只保留你明确承诺、接受或手动创建的事项。视频、直播和游戏里的命令不会直接变成待办。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
          {loadState === "loading" ? (
            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
              正在加载待办…
            </span>
          ) : loadState === "failed" ? (
            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">尚未读取</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary">
                {counts.actionable} 项正式待办
              </span>
              {counts.pending > 0 && (
                <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
                  待确认 {counts.pending}
                </span>
              )}
              {counts.suggestions > 0 && (
                <span className="rounded-full bg-sky-100 px-3 py-1 font-medium text-sky-800">
                  候选建议 {counts.suggestions}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              setComposer({
                kind: "manual",
                commandId: createKnowledgeActionId("command"),
                todoId: createKnowledgeActionId("todo"),
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" aria-hidden="true" />
            新建待办
          </button>
        </div>
      </header>

      {loadState === "ready" && (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            {(
              [
                ["actionable", `现在要做 ${counts.actionable}`],
                ["pending", `待你确认 ${counts.pending}`],
                ["suggestions", `建议与历史 ${counts.suggestionHistory}`],
                ["completed", `已完成 ${counts.completed}`],
                ["dismissed", `已忽略 ${counts.dismissed}`],
                [null, `全部 ${counts.all}`],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={String(value)}
                onClick={() => {
                  setFilter(value);
                  setSearchQuery("");
                  setSelectedId(null);
                }}
                className={`rounded-full px-3 py-1.5 text-xs ${
                  filter === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative mt-4 max-w-xl">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (event.target.value.trim()) setFilter(null);
              }}
              aria-label="搜索待办和候选建议"
              placeholder="搜索标题、内容或建议理由"
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清除搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span>
            {loadState === "failed"
              ? "待办暂时无法读取；已有录音和数据不会受影响。"
              : t("jarvis.knowledge.actionFailed", {
                  defaultValue: "Action failed / 操作失败",
                })}
          </span>
          <button
            type="button"
            onClick={retryLoad}
            className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium"
          >
            重试
          </button>
        </div>
      )}

      {loadState === "loading" ? (
        <section
          role="status"
          aria-live="polite"
          className="mt-6 rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground"
        >
          正在读取待办和候选建议…
        </section>
      ) : loadState === "failed" ? null : !hasVisibleResults ? (
        <section className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <CheckCircle2 className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 font-medium">
            {normalizedSearchQuery
              ? "没有找到匹配内容"
              : filter === "completed"
                ? "还没有已完成事项"
                : filter === "dismissed"
                  ? "还没有已忽略事项"
                  : filter === "pending"
                    ? "当前没有待确认事项"
                    : filter === "suggestions"
                      ? "当前没有候选建议"
                      : "当前没有需要处理的正式待办"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {normalizedSearchQuery
              ? "可以搜索待办标题、来源文字或候选建议的判断理由。"
              : filter === "pending"
                ? "旧版分析或归属证据不足的事项会保留在这里，但不会触发提醒。"
                : filter === "dismissed"
                  ? "忽略的事项会保留在历史中，你可以随时恢复。"
                  : filter === "suggestions"
                    ? "AI 建议只会保留为候选，接受后才会成为正式待办。"
                    : "新提取的低置信度事项会先进入“待确认”，不会在这里冒充正式任务。"}
          </p>
        </section>
      ) : (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)]">
          <section className="space-y-2">
            {visible.map((todo) => {
              const latest = todo.revisions.at(-1);
              const active = selectedId === todo.id;
              return (
                <article
                  key={todo.id}
                  className={`rounded-xl border bg-card p-4 transition-colors ${
                    active ? "border-primary/40" : "border-border/50"
                  }`}
                >
                  <div className="flex gap-3">
                    {todo.status === "open" && todo.verificationState === "confirmed" ? (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        aria-label={`Complete / 完成 ${todo.title}`}
                        onClick={() => void complete(todo)}
                        className="mt-0.5 size-5 shrink-0 rounded border border-border hover:border-primary disabled:opacity-50"
                      />
                    ) : todo.status === "completed" ? (
                      <span
                        aria-label="Completed / 已完成"
                        className="mt-0.5 shrink-0 text-primary"
                      >
                        ✓
                      </span>
                    ) : todo.status === "dismissed" ? (
                      <span
                        aria-label="Dismissed / 已忽略"
                        className="mt-0.5 shrink-0 text-muted-foreground"
                      >
                        ×
                      </span>
                    ) : (
                      <span
                        aria-label="Pending confirmation / 待确认"
                        className="mt-0.5 size-5 shrink-0 rounded-full border-2 border-amber-400"
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`查看待办 ${todo.title}`}
                      aria-controls="jarvis-todo-detail"
                      aria-expanded={active}
                      onClick={(event) => {
                        selectedTriggerRef.current = event.currentTarget;
                        setSelectedId(todo.id);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p
                          className={
                            todo.status === "completed" || todo.status === "dismissed"
                              ? "text-muted-foreground line-through"
                              : ""
                          }
                        >
                          {todo.title}
                        </p>
                        {todo.pinned && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <Pin className="size-2.5" aria-hidden="true" />
                            置顶
                          </span>
                        )}
                        {todo.urgency === "urgent" && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                            <Flag className="size-2.5" aria-hidden="true" />
                            紧急
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {todo.status === "dismissed"
                          ? "已忽略 · 可在详情中恢复"
                          : todo.verificationState === "pending_confirmation"
                            ? todo.verificationReason === "assigned_and_accepted"
                              ? "他人分配且 SELF 已接受 · 待你确认"
                              : "自动分析 · 尚未确认归属"
                            : (todo.ownerLabel ?? "负责人未填写")}
                        {latest?.dueText ? ` · ${latest.dueText}` : " · 未设置日期"}
                      </p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {todoSourceLabel(todo)} · {todo.occurrences.length} 条来源记录 ·
                        点击查看依据
                      </p>
                      <CardContextSummary context={todo.cardContext} title={todo.title} />
                    </button>
                    {todo.status === "open" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() =>
                          setIgnoreTarget({
                            kind: "todo",
                            commandId: createKnowledgeActionId("command"),
                            todo,
                          })
                        }
                        aria-label={`Quick not a todo / 快速标记这不是待办 ${todo.title}`}
                        className="h-fit shrink-0 rounded-md border border-destructive/25 px-2 py-1 text-[11px] text-destructive disabled:opacity-50"
                      >
                        这不是待办
                      </button>
                    )}
                  </div>
                  {!active && failedMutations[todo.id] && (
                    <TodoMutationFailure
                      title={todo.title}
                      busy={busyId !== null}
                      onRetry={() => void executeMutation(failedMutations[todo.id])}
                    />
                  )}
                </article>
              );
            })}

            {visibleSuggestions.length > 0 && (
              <section
                aria-labelledby="todos-candidate-suggestions"
                className="mt-4 rounded-xl border border-sky-200/70 bg-sky-50/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2
                    id="todos-candidate-suggestions"
                    className="flex items-center gap-1.5 text-sm font-semibold"
                  >
                    <Lightbulb className="size-4 text-amber-600" aria-hidden="true" />
                    候选建议
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {visibleSuggestions.length} 条
                  </span>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  建议不会触发提醒；只有你接受后，它才会转为正式待办。
                </p>
                <div className="space-y-2">
                  {visibleSuggestions.map((suggestion) => (
                    <article
                      key={suggestion.id}
                      className="rounded-lg border border-border/50 bg-background/90 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">{suggestion.title}</p>
                        {suggestion.state !== "proposed" && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {suggestion.state === "dismissed" ? "已忽略" : "已转为待办"}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {suggestion.rationale}
                      </p>
                      <CardContextSummary
                        context={suggestion.cardContext}
                        title={suggestion.title}
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        {suggestion.state === "proposed" && (
                          <>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() =>
                                setComposer({
                                  kind: "suggestion",
                                  commandId: createKnowledgeActionId("command"),
                                  todoId: createKnowledgeActionId("todo"),
                                  suggestion,
                                })
                              }
                              className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                              aria-label={`Accept suggestion / 接受建议 ${suggestion.title}`}
                            >
                              接受为待办
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() =>
                                setIgnoreTarget({
                                  kind: "suggestion",
                                  commandId: createKnowledgeActionId("command"),
                                  suggestion,
                                })
                              }
                              className="rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                              aria-label={`Dismiss suggestion / 忽略建议 ${suggestion.title}`}
                            >
                              忽略
                            </button>
                          </>
                        )}
                        {suggestion.state === "dismissed" && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() =>
                              void applyInstantAction(suggestion.id, {
                                commandId: createKnowledgeActionId("command"),
                                type: "suggestion_restore",
                                suggestionId: suggestion.id,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                            aria-label={`Restore suggestion / 恢复建议 ${suggestion.title}`}
                          >
                            <RotateCcw className="size-3" aria-hidden="true" />
                            恢复建议
                          </button>
                        )}
                        {suggestion.state === "accepted" && !suggestion.acceptanceUndone && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() =>
                              void applyInstantAction(suggestion.id, {
                                commandId: createKnowledgeActionId("command"),
                                type: "suggestion_accept_undo",
                                suggestionId: suggestion.id,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                            aria-label={`Undo accepted suggestion / 撤销接受 ${suggestion.title}`}
                          >
                            <RotateCcw className="size-3" aria-hidden="true" />
                            撤销接受
                          </button>
                        )}
                      </div>
                      <ActionEvidenceDetails
                        evidence={suggestion.occurrences.flatMap(
                          (occurrence) => occurrence.evidence
                        )}
                        onCorrected={load}
                      />
                    </article>
                  ))}
                </div>
              </section>
            )}
          </section>

          {selected && compactDetail && (
            <button
              type="button"
              className="fixed inset-0 z-40 bg-black/35 lg:hidden"
              aria-label={`关闭待办详情面板 ${selected.title}`}
              onClick={closeSelected}
            />
          )}

          <section
            ref={detailPanelRef}
            id="jarvis-todo-detail"
            role={selected && compactDetail ? "dialog" : undefined}
            aria-modal={selected && compactDetail ? true : undefined}
            aria-labelledby={selected ? "jarvis-todo-detail-title" : undefined}
            tabIndex={-1}
            className={`rounded-xl border border-border/50 bg-card p-5 ${
              selected
                ? "fixed inset-y-0 right-0 z-50 w-full max-w-[520px] overflow-y-auto rounded-none shadow-2xl lg:sticky lg:top-0 lg:z-auto lg:w-auto lg:max-w-none lg:rounded-xl lg:shadow-none"
                : "hidden lg:sticky lg:top-0 lg:block"
            }`}
          >
            {selected ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-primary">待办详情</p>
                    <h2 id="jarvis-todo-detail-title" className="mt-1 text-xl font-semibold">
                      {selected.title}
                    </h2>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {selected.status === "open" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        aria-label={`Edit / 编辑 ${selected.title}`}
                        onClick={() =>
                          setComposer({
                            kind: "edit",
                            commandId: createKnowledgeActionId("command"),
                            todo: selected,
                          })
                        }
                        className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      ref={detailCloseRef}
                      type="button"
                      aria-label={`关闭待办详情 ${selected.title}`}
                      onClick={closeSelected}
                      className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {selected.verificationState === "pending_confirmation" && (
                  <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    {selected.verificationReason === "assigned_and_accepted"
                      ? "检测到他人把任务交给 SELF，且 SELF 表示接受。请确认后再加入正式待办。"
                      : "这条内容来自自动分析，但归属证据还不足。它不会触发提醒；原始记录仍完整保留。"}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {selected.status === "open" &&
                    selected.verificationState === "pending_confirmation" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void decide(selected, "confirm")}
                        className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                        aria-label={`Confirm / 确认 ${selected.title}`}
                      >
                        确认成为正式待办
                      </button>
                    )}
                  {selected.status === "open" && (
                    <>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() =>
                          setIgnoreTarget({
                            kind: "todo",
                            commandId: createKnowledgeActionId("command"),
                            todo: selected,
                          })
                        }
                        className="rounded-lg border border-destructive/25 px-3 py-2 text-sm text-destructive disabled:opacity-50"
                        aria-label={`Not a todo / 这不是待办 ${selected.title}`}
                      >
                        这不是待办
                      </button>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() =>
                          void applyInstantAction(selected.id, {
                            commandId: createKnowledgeActionId("command"),
                            type: selected.pinned ? "todo_unpin" : "todo_pin",
                            todoId: selected.id,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
                        aria-label={`${selected.pinned ? "Unpin / 取消置顶" : "Pin / 置顶"} ${selected.title}`}
                      >
                        <Pin className="size-3.5" aria-hidden="true" />
                        {selected.pinned ? "取消置顶" : "置顶"}
                      </button>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() =>
                          void applyInstantAction(selected.id, {
                            commandId: createKnowledgeActionId("command"),
                            type: "urgency_set",
                            todoId: selected.id,
                            urgency: selected.urgency === "urgent" ? "normal" : "urgent",
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
                        aria-label={`${selected.urgency === "urgent" ? "Set normal / 设为普通" : "Set urgent / 设为紧急"} ${selected.title}`}
                      >
                        <Flag className="size-3.5" aria-hidden="true" />
                        {selected.urgency === "urgent" ? "设为普通" : "设为紧急"}
                      </button>
                    </>
                  )}
                  {selected.status === "completed" && (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void decide(selected, "reopen")}
                      className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
                      aria-label={`Reopen / 撤销完成 ${selected.title}`}
                    >
                      撤销完成
                    </button>
                  )}
                  {selected.status === "dismissed" && (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() =>
                        void applyInstantAction(selected.id, {
                          commandId: createKnowledgeActionId("command"),
                          type: "todo_restore",
                          todoId: selected.id,
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                      aria-label={`Restore / 恢复 ${selected.title}`}
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      恢复待办
                    </button>
                  )}
                </div>
                {failedMutations[selected.id] && (
                  <TodoMutationFailure
                    title={selected.title}
                    busy={busyId !== null}
                    onRetry={() => void executeMutation(failedMutations[selected.id])}
                  />
                )}
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                  <div className="rounded-lg bg-muted/30 p-3">
                    <dt className="text-xs text-muted-foreground">负责人</dt>
                    <dd className="mt-1 font-medium">{selected.ownerLabel ?? "尚未确认"}</dd>
                  </div>
                  <div className="rounded-lg bg-muted/30 p-3">
                    <dt className="text-xs text-muted-foreground">日期</dt>
                    <dd className="mt-1 font-medium">
                      {selected.revisions.at(-1)?.dueText ?? "未设置"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-muted/30 p-3">
                    <dt className="text-xs text-muted-foreground">来源</dt>
                    <dd className="mt-1 font-medium">{todoSourceLabel(selected)}</dd>
                  </div>
                </dl>
                <CardContextSummary context={selected.cardContext} title={selected.title} />
                <div className="mt-3">
                  <TodoReminderControl
                    todoId={selected.id}
                    todoTitle={selected.title}
                    todoStatus={selected.status}
                    verificationState={selected.verificationState}
                    reminder={selected.reminder}
                    disabled={busyId !== null}
                    onReminderChange={(reminder) => updateReminder(selected.id, reminder)}
                  />
                </div>
                <div className="mt-5 rounded-lg border border-border/50 p-3">
                  {selectedEvidence.length ? (
                    <ActionEvidenceDetails
                      evidence={selectedEvidence}
                      trustSnapshot={selected.trustSnapshot}
                      onCorrected={load}
                      onNotTodo={
                        selected.status === "open"
                          ? () =>
                              setIgnoreTarget({
                                kind: "todo",
                                commandId: createKnowledgeActionId("command"),
                                todo: selected,
                              })
                          : undefined
                      }
                      notTodoDisabled={busyId !== null}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">这条待办没有可显示的历史证据。</p>
                  )}
                </div>
              </>
            ) : (
              <div className="py-16 text-center">
                <ListTodo className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                <h2 className="mt-3 font-medium">选择一条待办</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  来源证据默认收起，需要时再查看，主列表不会再铺满整段转写。
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      {composer && (
        <TodoComposerDialog
          heading={
            composer.kind === "manual"
              ? "新建待办"
              : composer.kind === "edit"
                ? "编辑待办"
                : "接受候选建议"
          }
          description={
            composer.kind === "manual"
              ? "手动创建的事项会直接成为正式待办。"
              : composer.kind === "edit"
                ? "修改会保留为一条可追溯的本地修订。"
                : "确认标题和日期后，建议才会转为正式待办。"
          }
          confirmLabel={composer.kind === "edit" ? "保存修改" : "创建待办"}
          initialTitle={
            composer.kind === "edit"
              ? composer.todo.title
              : composer.kind === "suggestion"
                ? composer.suggestion.title
                : ""
          }
          initialDueText={composer.kind === "edit" ? composer.todo.revisions.at(-1)?.dueText : null}
          onCancel={() => setComposer(null)}
          onConfirm={submitComposer}
        />
      )}
      {ignoreTarget && (
        <IgnoreReasonDialog
          entityTitle={
            ignoreTarget.kind === "todo" ? ignoreTarget.todo.title : ignoreTarget.suggestion.title
          }
          allowLocalNote={ignoreTarget.kind === "todo"}
          onCancel={() => setIgnoreTarget(null)}
          onConfirm={submitIgnore}
        />
      )}
    </main>
  );
}
