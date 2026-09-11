import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { JarvisKnowledgeDismissReason } from "../types";

const DISMISS_REASONS: Array<{
  value: JarvisKnowledgeDismissReason;
  label: string;
}> = [
  { value: "not_relevant", label: "与我无关" },
  { value: "already_done", label: "已经完成" },
  { value: "not_mine", label: "不是我的事项" },
  { value: "wrong_context", label: "场景判断错误" },
  { value: "low_value", label: "价值较低" },
  { value: "other", label: "其他" },
];

function randomToken(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createKnowledgeActionId(prefix: "command" | "todo"): string {
  const token = randomToken().replace(/[^A-Za-z0-9_-]/g, "");
  return `${prefix}-${token}`;
}

function ModalFrame({
  title,
  description,
  onCancel,
  initialFocusRef,
  locked,
  children,
}: {
  title: string;
  description: string;
  onCancel: () => void;
  initialFocusRef: React.RefObject<HTMLElement | null>;
  locked: boolean;
  children: ReactNode;
}) {
  const titleId = useRef(`knowledge-dialog-title-${randomToken()}`);
  const descriptionId = useRef(`knowledge-dialog-description-${randomToken()}`);
  const dialogRef = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);
  const lockedRef = useRef(locked);

  useEffect(() => {
    onCancelRef.current = onCancel;
    lockedRef.current = locked;
  }, [locked, onCancel]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    initialFocusRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!lockedRef.current) onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusable[nextIndex].focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusRef]);

  return (
    <div
      data-testid="knowledge-dialog-backdrop"
      className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !lockedRef.current) onCancelRef.current();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={locked || undefined}
        aria-labelledby={titleId.current}
        aria-describedby={descriptionId.current}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId.current} className="text-lg font-semibold">
              {title}
            </h2>
            <p id={descriptionId.current} className="mt-1 text-sm text-muted-foreground">
              {description}
            </p>
          </div>
          <button
            type="button"
            disabled={locked}
            onClick={onCancel}
            aria-label={`关闭 ${title}`}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function TodoComposerDialog({
  heading,
  description,
  confirmLabel,
  initialTitle = "",
  initialDueText = "",
  onCancel,
  onConfirm,
}: {
  heading: string;
  description: string;
  confirmLabel: string;
  initialTitle?: string;
  initialDueText?: string | null;
  onCancel: () => void;
  onConfirm: (value: { title: string; dueText: string | null }) => Promise<void> | void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [dueText, setDueText] = useState(initialDueText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError("请填写待办标题。");
      titleRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        title: normalizedTitle,
        dueText: dueText.trim() || null,
      });
    } catch {
      setError("操作没有保存，请稍后重试。");
      setSubmitting(false);
    }
  };

  return (
    <ModalFrame
      title={heading}
      description={description}
      onCancel={onCancel}
      initialFocusRef={titleRef}
      locked={submitting}
    >
      <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm font-medium">
          待办标题
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="待办标题"
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </label>
        <label className="block text-sm font-medium">
          日期或时间（可选）
          <input
            type="text"
            value={dueText}
            onChange={(event) => setDueText(event.target.value)}
            aria-label="日期或时间（可选）"
            placeholder="例如：今天、周五或 2026-08-10"
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "正在保存…" : confirmLabel}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export function IgnoreReasonDialog({
  entityTitle,
  allowLocalNote,
  onCancel,
  onConfirm,
}: {
  entityTitle: string;
  allowLocalNote: boolean;
  onCancel: () => void;
  onConfirm: (
    reasonCode: JarvisKnowledgeDismissReason,
    localNote: string | null
  ) => Promise<void> | void;
}) {
  const [reasonCode, setReasonCode] = useState<JarvisKnowledgeDismissReason | "">("");
  const [localNote, setLocalNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reasonCode) {
      setError("请选择忽略原因。");
      reasonRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reasonCode, allowLocalNote ? localNote.trim() || null : null);
    } catch {
      setError("操作没有保存，请稍后重试。");
      setSubmitting(false);
    }
  };

  return (
    <ModalFrame
      title="选择忽略原因"
      description={`“${entityTitle}”会保留在历史中，可随时恢复。`}
      onCancel={onCancel}
      initialFocusRef={reasonRef}
      locked={submitting}
    >
      <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm font-medium">
          忽略原因
          <select
            ref={reasonRef}
            value={reasonCode}
            onChange={(event) =>
              setReasonCode(event.target.value as JarvisKnowledgeDismissReason | "")
            }
            aria-label="忽略原因"
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          >
            <option value="">请选择</option>
            {DISMISS_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
        </label>
        {allowLocalNote && (
          <label className="block text-sm font-medium">
            本地备注（可选）
            <textarea
              value={localNote}
              onChange={(event) => setLocalNote(event.target.value)}
              aria-label="本地备注（可选）"
              rows={3}
              className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "正在保存…" : "确认忽略"}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
