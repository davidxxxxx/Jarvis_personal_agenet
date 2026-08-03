import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Flag,
  Lightbulb,
  ListTodo,
  Pin,
  Undo2,
  X,
} from "lucide-react";
import type {
  JarvisActivityCategory,
  JarvisActionCenterDelta,
  JarvisKnowledgeDismissReason,
  JarvisKnowledgeCardContext,
  JarvisKnowledgeOverview,
} from "../types";
import ActionEvidenceDetails from "./ActionEvidenceDetails";
import {
  createKnowledgeActionId,
  IgnoreReasonDialog,
  TodoComposerDialog,
} from "./KnowledgeActionDialogs";
import TodoReminderControl, { type TodoReminderSnapshot } from "./TodoReminderControl";

type Todo = JarvisKnowledgeOverview["todos"][number];
type Suggestion = JarvisKnowledgeOverview["suggestions"][number];
type ActionCenterLoadState = "loading" | "ready" | "failed";

type TodoLifecycleAction = "confirm" | "dismiss" | "complete" | "reopen";

type FailedAction =
  | {
      kind: "todo_lifecycle";
      entityId: string;
      title: string;
      action: Exclude<TodoLifecycleAction, "dismiss">;
      previousTodo: Todo;
    }
  | {
      kind: "todo_dismiss";
      entityId: string;
      title: string;
      commandId: string;
      reasonCode: JarvisKnowledgeDismissReason;
      localNote: string | null;
      previousTodo: Todo;
    }
  | {
      kind: "suggestion_dismiss";
      entityId: string;
      title: string;
      commandId: string;
      reasonCode: JarvisKnowledgeDismissReason;
      previousSuggestion: Suggestion;
    }
  | {
      kind: "suggestion_accept";
      entityId: string;
      title: string;
      commandId: string;
      todoId: string;
      todoTitle: string;
      dueText: string | null;
      previousSuggestion: Suggestion;
      optimisticTodo: Todo;
    };

const ACTION_WATERMARK_VISIBLE_POLL_MS = 10_000;
const ACTION_WATERMARK_HIDDEN_POLL_MS = 60_000;

interface ActionCenterProps {
  sessionId: string | null;
  sessionStatus: string;
  refreshKey?: number;
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
  if (todo.pinned) return "now";
  const dueText = todo.revisions.at(-1)?.dueText?.trim();
  if (!dueText) return "later";
  if (/^(?:today|今天|今日)$/iu.test(dueText)) return "now";
  const matched = dueText.match(/\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\b/u);
  if (!matched) return "later";
  const due = `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}`;
  return due <= localDateKey(now) ? "now" : "later";
}

function dueSortValue(todo: Todo, now: number): number {
  const dueText = todo.revisions.at(-1)?.dueText?.trim();
  if (!dueText) return Number.POSITIVE_INFINITY;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (/^(?:today|今天|今日)$/iu.test(dueText)) return startOfToday.getTime();
  const matched = dueText.match(/\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\b/u);
  if (!matched) return Number.POSITIVE_INFINITY;
  const parsed = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : Number.POSITIVE_INFINITY;
}

export function compareActionPriority(left: Todo, right: Todo, now: number): number {
  const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
  if (pinned !== 0) return pinned;
  const urgent = Number(right.urgency === "urgent") - Number(left.urgency === "urgent");
  if (urgent !== 0) return urgent;
  const due = dueSortValue(left, now) - dueSortValue(right, now);
  if (Number.isFinite(due) && due !== 0) return due;
  return left.id.localeCompare(right.id);
}

function sourceLabel(todo: Todo) {
  if (todo.sourceSuggestionId || todo.provenance === "suggestion") return "由候选建议转为待办";
  if (todo.verificationReason === "strict_self_commitment") return "SELF 明确承诺 · 自动提取";
  if (todo.verificationReason === "assigned_and_accepted") return "他人分配且 SELF 已接受";
  if (todo.verificationActor === "user") return "你已确认";
  return todo.occurrences.at(-1)?.sessionId ? "来自录音" : "手动创建";
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

function formatCardContextTime(startedAt: number | null) {
  if (startedAt === null) return "会话时间未知";
  return `会话 ${new Date(startedAt).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function ActionSourceSummary({
  context,
  title,
}: {
  context: JarvisKnowledgeCardContext;
  title: string;
}) {
  return (
    <p
      aria-label={`来源摘要 ${title}`}
      className="mt-1 flex flex-wrap gap-x-1.5 text-[10px] leading-4 text-muted-foreground"
    >
      <span>{cardApplicationLabel(context)}</span>
      <span aria-hidden="true">·</span>
      <span>{cardActivityLabel(context)}</span>
      <span aria-hidden="true">·</span>
      <span>{formatCardContextTime(context.startedAt)}</span>
    </p>
  );
}

function ActionFailureNotice({
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
      className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
    >
      <span>操作未保存，已恢复原状态。</span>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        aria-label={`Retry action / 重试 ${title}`}
        className="rounded border border-destructive/30 px-1.5 py-0.5 font-medium disabled:opacity-50"
      >
        {busy ? "正在重试…" : "重试"}
      </button>
    </div>
  );
}

interface SessionActionSummary {
  confirmedTodos: number;
  pendingTodos: number;
  suggestions: number;
  total: number;
  label: string;
}

function actionSummaryLabel(
  prefix: string,
  counts: Pick<
    JarvisActionCenterDelta,
    "confirmedTodoCount" | "pendingTodoCount" | "suggestionCount"
  >
) {
  const parts = [
    counts.confirmedTodoCount > 0 ? `${counts.confirmedTodoCount} 个正式待办` : null,
    counts.pendingTodoCount > 0 ? `${counts.pendingTodoCount} 个待确认` : null,
    counts.suggestionCount > 0 ? `${counts.suggestionCount} 条候选建议` : null,
  ].filter((part): part is string => part !== null);
  return `${prefix}${parts.join("、")}`;
}

function wasFirstCreatedBySession(
  entity: Pick<Todo, "createdAt" | "occurrences"> | Pick<Suggestion, "createdAt" | "occurrences">,
  sessionId: string
) {
  if (entity.occurrences.length === 0) return false;
  const earliestCreatedAt = Math.min(
    ...entity.occurrences.map((occurrence) => occurrence.createdAt)
  );
  if (!Number.isFinite(earliestCreatedAt) || entity.createdAt !== earliestCreatedAt) return false;
  const earliestOccurrences = entity.occurrences.filter(
    (occurrence) => occurrence.createdAt === earliestCreatedAt
  );
  return earliestOccurrences.every((occurrence) => occurrence.sessionId === sessionId);
}

function buildSessionActionSummary(
  overview: JarvisKnowledgeOverview | null,
  sessionId: string | null,
  sessionStatus: string
): SessionActionSummary | null {
  if (!overview || !sessionId || !["finalizing", "completed"].includes(sessionStatus)) return null;

  const seenTodoIds = new Set<string>();
  let confirmedTodos = 0;
  let pendingTodos = 0;
  for (const todo of overview.todos) {
    if (seenTodoIds.has(todo.id) || !wasFirstCreatedBySession(todo, sessionId)) continue;
    seenTodoIds.add(todo.id);
    if (todo.verificationState === "confirmed") confirmedTodos += 1;
    if (todo.verificationState === "pending_confirmation") pendingTodos += 1;
  }

  const seenSuggestionIds = new Set<string>();
  let suggestions = 0;
  for (const suggestion of overview.suggestions) {
    if (
      suggestion.state !== "proposed" ||
      seenSuggestionIds.has(suggestion.id) ||
      !wasFirstCreatedBySession(suggestion, sessionId)
    ) {
      continue;
    }
    seenSuggestionIds.add(suggestion.id);
    suggestions += 1;
  }

  const total = confirmedTodos + pendingTodos + suggestions;
  if (total === 0) return null;
  return {
    confirmedTodos,
    pendingTodos,
    suggestions,
    total,
    label: actionSummaryLabel("本次新增 ", {
      confirmedTodoCount: confirmedTodos,
      pendingTodoCount: pendingTodos,
      suggestionCount: suggestions,
    }),
  };
}

function TodoRow({
  todo,
  busy,
  failure,
  onAction,
  onRetry,
  onReminderChange,
  onEvidenceCorrected,
  compact = false,
}: {
  todo: Todo;
  busy: boolean;
  failure: FailedAction | null;
  onAction: (todo: Todo, action: TodoLifecycleAction) => void;
  onRetry: (failure: FailedAction) => void;
  onReminderChange: (todoId: string, reminder: TodoReminderSnapshot | null) => void;
  onEvidenceCorrected: () => void | Promise<void>;
  compact?: boolean;
}) {
  const dueText = todo.revisions.at(-1)?.dueText;
  const evidence = todo.occurrences.flatMap((occurrence) => occurrence.evidence);
  return (
    <article className="rounded-lg border border-border/50 bg-background/70 p-3">
      <div className="flex items-start gap-2">
        {todo.status === "completed" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
        ) : (
          <Clock3 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium leading-5 text-foreground">{todo.title}</p>
            {todo.pinned && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                <Pin className="size-2.5" aria-hidden="true" />
                置顶
              </span>
            )}
            {todo.urgency === "urgent" && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-medium text-rose-700">
                <Flag className="size-2.5" aria-hidden="true" />
                紧急
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {sourceLabel(todo)}
            {dueText ? ` · ${dueText}` : ""}
          </p>
          <ActionSourceSummary context={todo.cardContext} title={todo.title} />
        </div>
      </div>
      {!compact && (
        <>
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
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/25 px-2 py-1 text-[11px] text-destructive disabled:opacity-50"
                  aria-label={`Not a todo / 这不是待办 ${todo.title}`}
                >
                  <X className="size-3" aria-hidden="true" />
                  这不是待办
                </button>
              </>
            )}
            {todo.status === "open" && todo.verificationState === "confirmed" && (
              <>
                <TodoReminderControl
                  todoId={todo.id}
                  todoTitle={todo.title}
                  todoStatus={todo.status}
                  verificationState={todo.verificationState}
                  reminder={todo.reminder}
                  compact
                  disabled={busy}
                  onReminderChange={(reminder) => onReminderChange(todo.id, reminder)}
                />
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
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(todo, "dismiss")}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/25 px-2 py-1 text-[11px] text-destructive disabled:opacity-50"
                  aria-label={`Not a todo / 这不是待办 ${todo.title}`}
                >
                  <X className="size-3" aria-hidden="true" />
                  这不是待办
                </button>
              </>
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
          <ActionEvidenceDetails
            evidence={evidence}
            trustSnapshot={todo.trustSnapshot}
            onCorrected={onEvidenceCorrected}
            onNotTodo={() => onAction(todo, "dismiss")}
            notTodoDisabled={busy}
          />
          {failure && (
            <ActionFailureNotice title={todo.title} busy={busy} onRetry={() => onRetry(failure)} />
          )}
        </>
      )}
    </article>
  );
}

function CollapsibleSection({
  title,
  count,
  open,
  onToggle,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          if (count > 0) onToggle();
        }}
        className="flex w-full items-center justify-between py-1 text-left text-xs font-medium text-muted-foreground"
        aria-expanded={count > 0 ? open : false}
        aria-disabled={count === 0 || undefined}
      >
        <span>
          {title} ({count})
        </span>
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
      </button>
      {count === 0 ? (
        <p className="mt-1.5 rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        open && <div className="mt-1.5 space-y-2">{children}</div>
      )}
    </section>
  );
}

function optimisticTodoForSuggestion(
  suggestion: Suggestion,
  todoId: string,
  title: string,
  dueText: string | null,
  occurredAt: number
): Todo {
  const revisionId = `${todoId}-optimistic-r1`;
  return {
    id: todoId,
    title,
    ownerLabel: "我",
    status: "open",
    completedAt: null,
    dismissedAt: null,
    verificationState: "confirmed",
    verificationReason: "user_confirmed",
    verificationActor: "user",
    trustSnapshot: null,
    cardContext: suggestion.cardContext,
    sourceKind: "suggestion",
    sourceSessionId: suggestion.occurrences.at(-1)?.sessionId ?? null,
    pinned: false,
    urgency: "normal",
    userModified: true,
    provenance: "suggestion",
    sourceSuggestionId: suggestion.id,
    reminder: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    revisions: [
      {
        id: revisionId,
        revision: 1,
        title,
        dueText,
        createdAt: occurredAt,
      },
    ],
    occurrences: suggestion.occurrences.map((occurrence) => ({
      id: `${todoId}-${occurrence.id}`,
      sessionId: occurrence.sessionId,
      revisionId,
      startedAt: occurrence.evidence.at(0)?.startedAt ?? null,
      endedAt: occurrence.evidence.at(-1)?.endedAt ?? null,
      createdAt: occurrence.createdAt,
      evidence: occurrence.evidence,
    })),
    transitions: [
      {
        id: `${todoId}-optimistic-open`,
        fromStatus: null,
        toStatus: "open",
        reason: "suggestion_accept",
        actor: "user",
        occurredAt,
      },
    ],
  };
}

export default function ActionCenter({
  sessionId,
  sessionStatus,
  refreshKey = 0,
  onViewAll,
}: ActionCenterProps) {
  const [overview, setOverview] = useState<JarvisKnowledgeOverview | null>(null);
  const [loadState, setLoadState] = useState<ActionCenterLoadState>("loading");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedActions, setFailedActions] = useState<Record<string, FailedAction>>({});
  const [error, setError] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [arrivalDelta, setArrivalDelta] = useState<JarvisActionCenterDelta | null>(null);
  const [suggestionComposer, setSuggestionComposer] = useState<{
    suggestion: Suggestion;
    commandId: string;
    todoId: string;
  } | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<
    | { kind: "todo"; todo: Todo; commandId: string }
    | { kind: "suggestion"; suggestion: Suggestion; commandId: string }
    | null
  >(null);
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  const hasSnapshot = useRef(false);
  const watermarkRevision = useRef<string | null>(null);
  const watermarkCheckInFlight = useRef(false);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const watermark = await window.electronAPI.jarvis.getActionCenterWatermark();
      const delta = await window.electronAPI.jarvis.getActionCenterDelta();
      // Freeze the durable unread boundary before reading the overview. Every event
      // acknowledged below is therefore guaranteed to have existed when the newer
      // overview was read. Actions arriving after this boundary remain unread and
      // are picked up by the watermark poll instead of being acknowledged unseen.
      const next = await window.electronAPI.jarvis.getKnowledgeOverview();
      if (generation.current !== request) return;
      // A poll that started before a local action must not overwrite the optimistic
      // entity with a stale snapshot. The successful action performs an explicit
      // refresh after its durable write has completed.
      if (actionInFlight.current) return;
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
      setOverview(next);
      hasSnapshot.current = true;
      setLoadState("ready");
      setArrivalDelta(delta.total > 0 ? delta : null);
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

  const refreshWhenActionsChange = useCallback(async () => {
    if (watermarkCheckInFlight.current) return;
    watermarkCheckInFlight.current = true;
    try {
      const watermark = await window.electronAPI.jarvis.getActionCenterWatermark();
      if (watermarkRevision.current === null || watermark.revision !== watermarkRevision.current) {
        await load();
      }
    } catch {
      // Keep the last durable overview visible and retry on the next lightweight poll.
    } finally {
      watermarkCheckInFlight.current = false;
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, refreshKey, sessionId, sessionStatus]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshWhenActionsChange();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      generation.current += 1;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshWhenActionsChange]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      const delay =
        document.visibilityState === "visible"
          ? ACTION_WATERMARK_VISIBLE_POLL_MS
          : ACTION_WATERMARK_HIDDEN_POLL_MS;
      timer = window.setTimeout(async () => {
        await refreshWhenActionsChange();
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshWhenActionsChange]);

  const now = Date.now();
  const partitions = useMemo(() => {
    const todos = overview?.todos ?? [];
    const actionable = todos.filter(
      (todo) => todo.status === "open" && todo.verificationState === "confirmed"
    );
    return {
      now: actionable
        .filter((todo) => dueBucket(todo, now) === "now")
        .sort((left, right) => compareActionPriority(left, right, now)),
      pending: todos
        .filter(
          (todo) => todo.status === "open" && todo.verificationState === "pending_confirmation"
        )
        .sort((left, right) => compareActionPriority(left, right, now)),
      later: actionable
        .filter((todo) => dueBucket(todo, now) === "later")
        .sort((left, right) => compareActionPriority(left, right, now)),
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
  const sessionActionSummary = useMemo(
    () => buildSessionActionSummary(overview, sessionId, sessionStatus),
    [overview, sessionId, sessionStatus]
  );
  const arrivalSummaryLabel =
    arrivalDelta && arrivalDelta.total > 0
      ? actionSummaryLabel("上次查看后新增 ", arrivalDelta)
      : null;
  const visibleActionSummary = sessionActionSummary?.label ?? arrivalSummaryLabel;
  const visibleActionSummaryIsSession = sessionActionSummary !== null;

  const applyOptimisticAction = useCallback((action: FailedAction) => {
    const occurredAt = Date.now();
    setOverview((current) => {
      if (!current) return current;
      if (action.kind === "suggestion_accept") {
        return {
          ...current,
          todos: [
            ...current.todos.filter((todo) => todo.id !== action.optimisticTodo.id),
            action.optimisticTodo,
          ],
          suggestions: current.suggestions.map((suggestion) =>
            suggestion.id === action.entityId
              ? {
                  ...suggestion,
                  state: "accepted",
                  convertedTodoId: action.todoId,
                  acceptanceUndone: false,
                  decidedAt: occurredAt,
                  updatedAt: occurredAt,
                }
              : suggestion
          ),
        };
      }
      if (action.kind === "suggestion_dismiss") {
        return {
          ...current,
          suggestions: current.suggestions.map((suggestion) =>
            suggestion.id === action.entityId
              ? {
                  ...suggestion,
                  state: "dismissed",
                  dismissReasonCode: action.reasonCode,
                  decidedAt: occurredAt,
                  updatedAt: occurredAt,
                }
              : suggestion
          ),
        };
      }

      return {
        ...current,
        todos: current.todos.map((todo) => {
          if (todo.id !== action.entityId) return todo;
          if (action.kind === "todo_dismiss") {
            return {
              ...todo,
              status: "dismissed",
              dismissedAt: occurredAt,
              verificationState: "dismissed",
              verificationReason: "user_dismissed",
              verificationActor: "user",
              dismissReasonCode: action.reasonCode,
              updatedAt: occurredAt,
            };
          }
          if (action.action === "confirm") {
            return {
              ...todo,
              verificationState: "confirmed",
              verificationReason: "user_confirmed",
              verificationActor: "user",
              updatedAt: occurredAt,
            };
          }
          if (action.action === "complete") {
            return { ...todo, status: "completed", completedAt: occurredAt, updatedAt: occurredAt };
          }
          return { ...todo, status: "open", completedAt: null, updatedAt: occurredAt };
        }),
      };
    });
  }, []);

  const rollbackAction = useCallback((action: FailedAction) => {
    setOverview((current) => {
      if (!current) return current;
      if (action.kind === "suggestion_accept") {
        return {
          ...current,
          todos: current.todos.filter((todo) => todo.id !== action.todoId),
          suggestions: current.suggestions.some(
            (suggestion) => suggestion.id === action.previousSuggestion.id
          )
            ? current.suggestions.map((suggestion) =>
                suggestion.id === action.previousSuggestion.id
                  ? action.previousSuggestion
                  : suggestion
              )
            : [...current.suggestions, action.previousSuggestion],
        };
      }
      if (action.kind === "suggestion_dismiss") {
        return {
          ...current,
          suggestions: current.suggestions.some(
            (suggestion) => suggestion.id === action.previousSuggestion.id
          )
            ? current.suggestions.map((suggestion) =>
                suggestion.id === action.previousSuggestion.id
                  ? action.previousSuggestion
                  : suggestion
              )
            : [...current.suggestions, action.previousSuggestion],
        };
      }
      return {
        ...current,
        todos: current.todos.some((todo) => todo.id === action.previousTodo.id)
          ? current.todos.map((todo) =>
              todo.id === action.previousTodo.id ? action.previousTodo : todo
            )
          : [...current.todos, action.previousTodo],
      };
    });
  }, []);

  const executeAction = useCallback(
    async (action: FailedAction) => {
      if (actionInFlight.current || busyId) return;
      actionInFlight.current = true;
      setBusyId(action.entityId);
      setFailedActions((current) => {
        if (!(action.entityId in current)) return current;
        const next = { ...current };
        delete next[action.entityId];
        return next;
      });
      applyOptimisticAction(action);
      try {
        if (action.kind === "todo_lifecycle") {
          if (action.action === "complete") {
            await window.electronAPI.jarvis.completeKnowledgeTodo(action.entityId);
          } else {
            await window.electronAPI.jarvis.decideKnowledgeTodo(action.entityId, action.action);
          }
        } else if (action.kind === "todo_dismiss") {
          await window.electronAPI.jarvis.applyKnowledgeAction({
            commandId: action.commandId,
            type: "todo_dismiss",
            todoId: action.entityId,
            reasonCode: action.reasonCode,
            localNote: action.localNote,
          });
        } else if (action.kind === "suggestion_dismiss") {
          await window.electronAPI.jarvis.applyKnowledgeAction({
            commandId: action.commandId,
            type: "suggestion_dismiss",
            suggestionId: action.entityId,
            reasonCode: action.reasonCode,
          });
        } else {
          await window.electronAPI.jarvis.applyKnowledgeAction({
            commandId: action.commandId,
            type: "suggestion_accept",
            suggestionId: action.entityId,
            todoId: action.todoId,
            title: action.todoTitle,
            dueText: action.dueText,
          });
        }
        setFailedActions((current) => {
          if (!(action.entityId in current)) return current;
          const next = { ...current };
          delete next[action.entityId];
          return next;
        });
        actionInFlight.current = false;
        await load();
      } catch {
        actionInFlight.current = false;
        rollbackAction(action);
        setFailedActions((current) => ({ ...current, [action.entityId]: action }));
      } finally {
        actionInFlight.current = false;
        setBusyId(null);
      }
    },
    [applyOptimisticAction, busyId, load, rollbackAction]
  );

  const todoAction = (todo: Todo, action: TodoLifecycleAction) => {
    if (busyId) return;
    if (action === "dismiss") {
      setIgnoreTarget({
        kind: "todo",
        todo,
        commandId: createKnowledgeActionId("command"),
      });
      return;
    }
    void executeAction({
      kind: "todo_lifecycle",
      entityId: todo.id,
      title: todo.title,
      action,
      previousTodo: todo,
    });
  };

  const suggestionAction = (suggestion: Suggestion, action: "accept" | "dismiss") => {
    if (busyId) return;
    if (action === "accept") {
      setSuggestionComposer({
        suggestion,
        commandId: createKnowledgeActionId("command"),
        todoId: createKnowledgeActionId("todo"),
      });
      return;
    }
    setIgnoreTarget({
      kind: "suggestion",
      suggestion,
      commandId: createKnowledgeActionId("command"),
    });
  };

  const acceptSuggestion = async (value: { title: string; dueText: string | null }) => {
    if (!suggestionComposer || busyId) return;
    const target = suggestionComposer;
    const action: FailedAction = {
      kind: "suggestion_accept",
      entityId: target.suggestion.id,
      title: target.suggestion.title,
      commandId: target.commandId,
      todoId: target.todoId,
      todoTitle: value.title,
      dueText: value.dueText,
      previousSuggestion: target.suggestion,
      optimisticTodo: optimisticTodoForSuggestion(
        target.suggestion,
        target.todoId,
        value.title,
        value.dueText,
        Date.now()
      ),
    };
    setSuggestionComposer(null);
    void executeAction(action);
  };

  const dismissWithReason = async (
    reasonCode: JarvisKnowledgeDismissReason,
    localNote: string | null
  ) => {
    if (!ignoreTarget || busyId) return;
    const action: FailedAction =
      ignoreTarget.kind === "todo"
        ? {
            kind: "todo_dismiss",
            entityId: ignoreTarget.todo.id,
            title: ignoreTarget.todo.title,
            commandId: ignoreTarget.commandId,
            reasonCode,
            localNote,
            previousTodo: ignoreTarget.todo,
          }
        : {
            kind: "suggestion_dismiss",
            entityId: ignoreTarget.suggestion.id,
            title: ignoreTarget.suggestion.title,
            commandId: ignoreTarget.commandId,
            reasonCode,
            previousSuggestion: ignoreTarget.suggestion,
          };
    setIgnoreTarget(null);
    void executeAction(action);
  };

  const updateReminder = useCallback((todoId: string, reminder: TodoReminderSnapshot | null) => {
    setOverview((current) =>
      current
        ? {
            ...current,
            todos: current.todos.map((todo) => (todo.id === todoId ? { ...todo, reminder } : todo)),
          }
        : current
    );
  }, []);

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm"
      aria-labelledby="action-center-title"
      aria-busy={loadState === "loading" || undefined}
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
        <div className="flex flex-wrap justify-end gap-1.5">
          {sessionActionSummary && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              本次新增 {sessionActionSummary.total}
            </span>
          )}
          {arrivalDelta && arrivalDelta.total > 0 && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
              新内容 {arrivalDelta.total}
            </span>
          )}
          {partitions.pending.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              待确认 {partitions.pending.length}
            </span>
          )}
        </div>
      </header>

      {visibleActionSummary && (
        <p
          role="status"
          aria-live="polite"
          aria-label={visibleActionSummary}
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${
            visibleActionSummaryIsSession
              ? "border border-primary/15 bg-primary/5 text-foreground"
              : "border border-emerald-200/70 bg-emerald-50/70 text-emerald-900"
          }`}
        >
          {visibleActionSummary}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span>
            {overview
              ? "行动中心未能刷新；下面仍显示上次成功读取的内容。"
              : "行动数据暂时无法读取；已有录音和数据不会受影响。"}
          </span>
          <button
            type="button"
            onClick={retryLoad}
            className="rounded-md border border-destructive/30 px-2 py-1 font-medium"
          >
            重试
          </button>
        </div>
      )}

      {loadState === "loading" && overview === null && (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
        >
          正在读取今日行动…
        </p>
      )}

      {overview && (
        <div className="mt-4 space-y-3">
          <section>
            <h3 className="text-xs font-semibold text-foreground">
              现在要做 ({partitions.now.length})
            </h3>
            <div className="mt-1.5 space-y-2">
              {partitions.now.length > 0 ? (
                partitions.now.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    busy={busyId !== null}
                    failure={failedActions[todo.id] ?? null}
                    onAction={(item, action) => void todoAction(item, action)}
                    onRetry={(action) => void executeAction(action)}
                    onReminderChange={updateReminder}
                    onEvidenceCorrected={load}
                  />
                ))
              ) : (
                <p className="rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                  今天没有到期或逾期的正式待办。
                </p>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-amber-800">
              待你确认 ({partitions.pending.length})
            </h3>
            <div className="mt-1.5 space-y-2">
              {partitions.pending.length > 0 ? (
                partitions.pending.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    busy={busyId !== null}
                    failure={failedActions[todo.id] ?? null}
                    onAction={(item, action) => void todoAction(item, action)}
                    onRetry={(action) => void executeAction(action)}
                    onReminderChange={updateReminder}
                    onEvidenceCorrected={load}
                  />
                ))
              ) : (
                <p className="rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                  当前没有需要你确认的事项。
                </p>
              )}
            </div>
          </section>

          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Lightbulb className="size-3.5 text-amber-600" aria-hidden="true" />
              候选建议 ({partitions.suggestions.length})
            </h3>
            <div className="mt-1.5 space-y-2">
              {partitions.suggestions.length > 0 ? (
                <>
                  {partitions.suggestions.slice(0, 3).map((suggestion) => (
                    <article
                      key={suggestion.id}
                      className="rounded-lg border border-border/50 bg-background/70 p-3"
                    >
                      <p className="text-sm font-medium">{suggestion.title}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                        {suggestion.rationale}
                      </p>
                      <ActionSourceSummary
                        context={suggestion.cardContext}
                        title={suggestion.title}
                      />
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
                      <ActionEvidenceDetails
                        evidence={suggestion.occurrences.flatMap(
                          (occurrence) => occurrence.evidence
                        )}
                        onCorrected={load}
                      />
                      {failedActions[suggestion.id] && (
                        <ActionFailureNotice
                          title={suggestion.title}
                          busy={busyId !== null}
                          onRetry={() => void executeAction(failedActions[suggestion.id])}
                        />
                      )}
                    </article>
                  ))}
                  {partitions.suggestions.length > 3 && (
                    <p className="text-center text-[11px] text-muted-foreground">
                      其余 {partitions.suggestions.length - 3} 条可在完整 Todo 页面搜索、接受或忽略
                    </p>
                  )}
                </>
              ) : (
                <p className="rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                  当前没有候选建议；AI 建议不会自动成为待办。
                </p>
              )}
            </div>
          </section>

          <CollapsibleSection
            title="稍后"
            count={partitions.later.length}
            open={laterOpen}
            onToggle={() => setLaterOpen((value) => !value)}
            emptyLabel="当前没有未来日期或未设置日期的正式待办。"
          >
            {partitions.later.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                busy={busyId !== null}
                failure={failedActions[todo.id] ?? null}
                onAction={(item, action) => void todoAction(item, action)}
                onRetry={(action) => void executeAction(action)}
                onReminderChange={updateReminder}
                onEvidenceCorrected={load}
              />
            ))}
          </CollapsibleSection>

          <CollapsibleSection
            title="今日已完成"
            count={partitions.completed.length}
            open={completedOpen}
            onToggle={() => setCompletedOpen((value) => !value)}
            emptyLabel="今天还没有已完成事项。"
          >
            {partitions.completed.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                busy={busyId !== null}
                failure={failedActions[todo.id] ?? null}
                onAction={(item, action) => void todoAction(item, action)}
                onRetry={(action) => void executeAction(action)}
                onReminderChange={updateReminder}
                onEvidenceCorrected={load}
              />
            ))}
          </CollapsibleSection>
        </div>
      )}

      <button
        type="button"
        onClick={onViewAll}
        className="mt-4 w-full rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        查看全部待办与历史
      </button>
      {suggestionComposer && (
        <TodoComposerDialog
          heading="接受候选建议"
          description="确认标题和日期后，建议才会转为正式待办。"
          confirmLabel="创建待办"
          initialTitle={suggestionComposer.suggestion.title}
          onCancel={() => setSuggestionComposer(null)}
          onConfirm={acceptSuggestion}
        />
      )}
      {ignoreTarget && (
        <IgnoreReasonDialog
          entityTitle={
            ignoreTarget.kind === "todo" ? ignoreTarget.todo.title : ignoreTarget.suggestion.title
          }
          allowLocalNote={ignoreTarget.kind === "todo"}
          onCancel={() => setIgnoreTarget(null)}
          onConfirm={dismissWithReason}
        />
      )}
    </section>
  );
}
