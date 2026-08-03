import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bell, BellOff, LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import type { JarvisTodoReminder } from "../types";

export type TodoReminderSnapshot = Omit<JarvisTodoReminder, "todoId" | "updatedAt">;

interface TodoReminderControlProps {
  todoId: string;
  todoTitle: string;
  todoStatus: "open" | "completed" | "dismissed";
  verificationState: "confirmed" | "pending_confirmation" | "dismissed";
  reminder?: TodoReminderSnapshot | null;
  compact?: boolean;
  disabled?: boolean;
  onReminderChange: (reminder: TodoReminderSnapshot | null) => void;
}

const DEFERRED_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  focus_mode: "专注模式开启",
  temporarily_muted: "提醒暂时静音",
  active_focus_context: "游戏、会议或演示正在进行",
  delivery_failed: "Windows 通知暂时发送失败",
  os_notifications_unavailable: "Windows 通知当前不可用",
});

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateTimeInput(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function fromLocalDateTimeInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const parsed = new Date(value).getTime();
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function defaultReminderAt(reminder: TodoReminderSnapshot | null | undefined): number {
  if (reminder && reminder.state !== "cancelled" && reminder.reminderAt >= Date.now()) {
    return reminder.reminderAt;
  }
  const fiveMinutes = 5 * 60_000;
  return Math.ceil((Date.now() + 60 * 60_000) / fiveMinutes) * fiveMinutes;
}

function formatReminderTime(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

function reminderStatusLabel(reminder: TodoReminderSnapshot | null | undefined): string {
  if (!reminder) return "未设置提醒";
  if (reminder.state === "cancelled") return "提醒已取消";
  if (reminder.state === "delivered") {
    return `已提醒 · ${formatReminderTime(reminder.deliveredAt ?? reminder.reminderAt)}`;
  }
  if (reminder.state === "deferred") {
    const reason = reminder.deferredReason
      ? (DEFERRED_REASON_LABELS[reminder.deferredReason] ?? reminder.deferredReason)
      : "等待合适时机";
    return `提醒已延迟 · ${reason} · 原定 ${formatReminderTime(reminder.reminderAt)}`;
  }
  return `将于 ${formatReminderTime(reminder.reminderAt)} 提醒`;
}

function toSnapshot(reminder: JarvisTodoReminder | null): TodoReminderSnapshot | null {
  if (!reminder) return null;
  return {
    reminderAt: reminder.reminderAt,
    reminderSource: "user",
    state: reminder.state,
    deferredReason: reminder.deferredReason,
    deliveredAt: reminder.deliveredAt,
  };
}

function errorLabel(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (/CONFIRMATION_REQUIRED/iu.test(code)) return "只有已确认的正式待办才能设置提醒。";
  if (/NOT_OPEN/iu.test(code)) return "这条待办已不是进行中状态，不能设置提醒。";
  if (/NOT_FOUND/iu.test(code)) return "这条待办已不存在，请刷新后重试。";
  return "提醒没有保存，原来的提醒状态保持不变。";
}

export default function TodoReminderControl({
  todoId,
  todoTitle,
  todoStatus,
  verificationState,
  reminder = null,
  compact = false,
  disabled = false,
  onReminderChange,
}: TodoReminderControlProps) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toLocalDateTimeInput(defaultReminderAt(reminder)));
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequest = useRef(0);
  const eligible = todoStatus === "open" && verificationState === "confirmed";
  const hasActiveReminder = reminder?.state === "scheduled" || reminder?.state === "deferred";
  const statusLabel = useMemo(() => reminderStatusLabel(reminder), [reminder]);

  useEffect(() => {
    if (!open && !saving) setDraft(toLocalDateTimeInput(defaultReminderAt(reminder)));
  }, [open, reminder, saving]);

  useEffect(
    () => () => {
      refreshRequest.current += 1;
    },
    []
  );

  const changeOpen = (nextOpen: boolean) => {
    if (!eligible || disabled || saving) return;
    setOpen(nextOpen);
    setError(null);
    if (!nextOpen) {
      refreshRequest.current += 1;
      setRefreshing(false);
      return;
    }
    setDraft(toLocalDateTimeInput(defaultReminderAt(reminder)));
    const getReminder = window.electronAPI?.jarvis?.getTodoReminder;
    if (typeof getReminder !== "function") return;
    const request = ++refreshRequest.current;
    setRefreshing(true);
    void getReminder(todoId)
      .then((latest) => {
        if (refreshRequest.current !== request) return;
        const snapshot = toSnapshot(latest);
        onReminderChange(snapshot);
        setDraft(toLocalDateTimeInput(defaultReminderAt(snapshot)));
      })
      .catch(() => {
        if (refreshRequest.current !== request) return;
        setError("无法刷新最新提醒状态；当前显示保持不变，你仍可重试保存。");
      })
      .finally(() => {
        if (refreshRequest.current === request) setRefreshing(false);
      });
  };

  const save = async () => {
    const reminderAt = fromLocalDateTimeInput(draft);
    if (reminderAt === null) {
      setError("请选择有效的提醒日期和时间。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await window.electronAPI.jarvis.setTodoReminder(todoId, reminderAt);
      if (!next) throw new Error("todo reminder was not returned");
      onReminderChange(toSnapshot(next));
      setOpen(false);
    } catch (saveError) {
      setError(errorLabel(saveError));
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await window.electronAPI.jarvis.setTodoReminder(todoId, null);
      onReminderChange(toSnapshot(next));
      setOpen(false);
    } catch (cancelError) {
      setError(errorLabel(cancelError));
    } finally {
      setSaving(false);
    }
  };

  const triggerLabel = hasActiveReminder ? `修改提醒 ${todoTitle}` : `设置提醒 ${todoTitle}`;
  const editor = (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline-flat"
          size="sm"
          disabled={!eligible || disabled}
          aria-label={triggerLabel}
          className={compact ? "h-7 max-w-full px-2 text-[11px]" : undefined}
        >
          {hasActiveReminder ? (
            <Bell className="size-3.5 text-primary" aria-hidden="true" />
          ) : (
            <BellOff className="size-3.5" aria-hidden="true" />
          )}
          {compact
            ? reminder?.state === "deferred"
              ? "提醒已延迟"
              : reminder?.state === "delivered"
                ? "已提醒"
                : reminder?.state === "cancelled"
                  ? "提醒已取消"
                  : hasActiveReminder
                    ? `提醒 ${formatReminderTime(reminder.reminderAt)}`
                    : "设置提醒"
            : hasActiveReminder
              ? "修改提醒"
              : "设置提醒"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={compact ? "end" : "start"} className="w-72 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">提醒时间</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{todoTitle}</p>
          </div>
          {refreshing && (
            <LoaderCircle className="size-4 animate-spin text-primary" aria-label="正在刷新提醒" />
          )}
        </div>
        <label htmlFor={inputId} className="mt-3 block text-xs font-medium text-foreground">
          日期和时间
        </label>
        <Input
          id={inputId}
          type="datetime-local"
          step={60}
          value={draft}
          disabled={refreshing || saving}
          aria-label={`提醒时间 ${todoTitle}`}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
          className="mt-1"
        />
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          只有你明确设置的正式待办才会发送 Windows 通知；游戏、会议或专注模式下会自动延迟并合并。
        </p>
        {error && (
          <p
            role="alert"
            className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {hasActiveReminder && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing || saving}
              onClick={() => void cancel()}
            >
              取消提醒
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={refreshing || saving || !draft}
            onClick={() => void save()}
          >
            {saving && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            保存提醒
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );

  if (compact) return editor;

  return (
    <section className="rounded-lg bg-muted/30 p-3" aria-label={`待办提醒 ${todoTitle}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">提醒</p>
          <p className="mt-1 text-sm font-medium text-foreground">{statusLabel}</p>
          {!eligible && todoStatus === "open" && (
            <p className="mt-1 text-xs text-muted-foreground">确认成为正式待办后才能设置提醒。</p>
          )}
          {!eligible && todoStatus !== "open" && (
            <p className="mt-1 text-xs text-muted-foreground">只有进行中的正式待办可以设置提醒。</p>
          )}
        </div>
        {editor}
      </div>
    </section>
  );
}
