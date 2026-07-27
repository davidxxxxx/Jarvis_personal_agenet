import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JarvisKnowledgeOverview } from "../types";
import EvidenceLink from "./EvidenceLink";

type Todo = JarvisKnowledgeOverview["todos"][number];
type Filter = "actionable" | "pending" | "completed" | null;

export default function TodosView() {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<Filter>("actionable");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    if (
      busyId ||
      todo.status !== "open" ||
      todo.verificationState !== "confirmed"
    ) {
      return;
    }
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

  const decide = async (todo: Todo, action: "confirm" | "dismiss" | "reopen") => {
    if (busyId) return;
    setBusyId(todo.id);
    try {
      const result = await window.electronAPI.jarvis.decideKnowledgeTodo(todo.id, action);
      setTodos((current) =>
        current.map((item) => {
          if (item.id !== todo.id) return item;
          if (action === "confirm") {
            return {
              ...item,
              verificationState: "confirmed",
              verificationReason: "user_confirmed",
              verificationActor: "user",
            };
          }
          if (action === "dismiss") {
            return {
              ...item,
              status: "dismissed",
              dismissedAt: result.decidedAt,
              verificationState: "dismissed",
              verificationReason: "user_dismissed",
              verificationActor: "user",
            };
          }
          return { ...item, status: "open", completedAt: null };
        })
      );
      setError(false);
    } catch {
      setError(true);
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
        (todo) =>
          todo.status === "open" && todo.verificationState === "pending_confirmation"
      ).length,
      completed: todos.filter((todo) => todo.status === "completed").length,
      all: todos.length,
    }),
    [todos]
  );
  const visible = todos.filter((todo) => {
    if (filter === null) return true;
    if (filter === "completed") return todo.status === "completed";
    if (filter === "pending") {
      return todo.status === "open" && todo.verificationState === "pending_confirmation";
    }
    return todo.status === "open" && todo.verificationState === "confirmed";
  });
  const selected = todos.find((todo) => todo.id === selectedId) ?? null;
  const selectedEvidence = selected
    ? selected.occurrences.flatMap((occurrence) => occurrence.evidence)
    : [];

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">待办 Todos</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            这里只保留你明确承诺、接受或手动创建的事项。视频、直播和游戏里的命令不会直接变成待办。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary">
            {counts.actionable} 项正式待办
          </span>
          {counts.pending > 0 && (
            <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
              待确认 {counts.pending}
            </span>
          )}
        </div>
      </header>

      <div className="mt-5 flex flex-wrap gap-2">
        {(
          [
            ["actionable", `现在要做 ${counts.actionable}`],
            ["pending", `待你确认 ${counts.pending}`],
            ["completed", `已完成 ${counts.completed}`],
            [null, `全部 ${counts.all}`],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={String(value)}
            onClick={() => setFilter(value)}
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

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t("jarvis.knowledge.actionFailed", { defaultValue: "Action failed / 操作失败" })}
        </p>
      )}

      {!visible.length && !error ? (
        <section className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <CheckCircle2 className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 font-medium">
            {filter === "completed"
              ? "还没有已完成事项"
              : filter === "pending"
                ? "当前没有待确认事项"
                : "当前没有需要处理的正式待办"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {filter === "pending"
              ? "旧版分析或归属证据不足的事项会保留在这里，但不会触发提醒。"
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
                  className={`flex gap-3 rounded-xl border bg-card p-4 transition-colors ${
                    active ? "border-primary/40" : "border-border/50"
                  }`}
                >
                  {todo.status === "open" &&
                  todo.verificationState === "confirmed" ? (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      aria-label={`Complete / 完成 ${todo.title}`}
                      onClick={() => void complete(todo)}
                      className="mt-0.5 size-5 shrink-0 rounded border border-border hover:border-primary disabled:opacity-50"
                    />
                  ) : todo.status === "completed" ? (
                    <span aria-label="Completed / 已完成" className="mt-0.5 shrink-0 text-primary">
                      ✓
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
                    onClick={() => setSelectedId(todo.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p
                      className={
                        todo.status === "completed" ? "text-muted-foreground line-through" : ""
                      }
                    >
                      {todo.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {todo.verificationState === "pending_confirmation"
                        ? todo.verificationReason === "assigned_and_accepted"
                          ? "他人分配且 SELF 已接受 · 待你确认"
                          : "自动分析 · 尚未确认归属"
                        : (todo.ownerLabel ?? "负责人未填写")}
                      {latest?.dueText ? ` · ${latest.dueText}` : " · 未设置日期"}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {todo.occurrences.length} 条来源记录 · 点击查看依据
                    </p>
                  </button>
                </article>
              );
            })}
          </section>

          <section className="rounded-xl border border-border/50 bg-card p-5 lg:sticky lg:top-0">
            {selected ? (
              <>
                <p className="text-xs font-medium text-primary">待办详情</p>
                <h2 className="mt-1 text-xl font-semibold">{selected.title}</h2>
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
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void decide(selected, "confirm")}
                          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                          aria-label={`Confirm / 确认 ${selected.title}`}
                        >
                          确认成为正式待办
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void decide(selected, "dismiss")}
                          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
                          aria-label={`Dismiss / 忽略 ${selected.title}`}
                        >
                          忽略
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
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
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
                </dl>
                <details className="mt-5 rounded-lg border border-border/50 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    查看来源依据（{selectedEvidence.length}）
                  </summary>
                  <div className="mt-3 space-y-2">
                    {selectedEvidence.length ? (
                      selectedEvidence.map((evidence) => (
                        <EvidenceLink
                          key={evidence.handle?.evidenceId ?? evidence.segmentId}
                          handle={evidence.handle}
                          quote={evidence.quote}
                          startedAt={evidence.startedAt}
                          audioState={evidence.audioState}
                        />
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">这条待办没有可显示的历史证据。</p>
                    )}
                  </div>
                </details>
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
    </main>
  );
}
