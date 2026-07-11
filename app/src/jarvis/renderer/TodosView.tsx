import { useCallback, useEffect, useState } from "react";
import type { JarvisTodo } from "../types";

export default function TodosView() {
  const [todos, setTodos] = useState<JarvisTodo[]>([]);
  const [filter, setFilter] = useState<"open" | "completed" | null>("open");
  const [error, setError] = useState(false);
  const refresh = useCallback(
    () =>
      window.electronAPI.jarvis
        .listTodos(filter)
        .then(setTodos)
        .catch(() => setError(true)),
    [filter]
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const toggle = async (todo: JarvisTodo) => {
    await window.electronAPI.jarvis.setTodoStatus(
      todo.id,
      todo.status === "open" ? "completed" : "open"
    );
    await refresh();
  };
  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">待办</h1>
      <p className="mt-1 text-sm text-muted-foreground">从对话中提取，并始终保留来源证据。</p>
      <div className="mt-5 flex gap-2">
        {[
          ["open", "未完成"],
          ["completed", "已完成"],
          [null, "全部"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={String(value)}
            onClick={() => setFilter(value as "open" | "completed" | null)}
            className={`rounded-full px-3 py-1.5 text-xs ${filter === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="mt-4 text-sm text-destructive">待办读取失败。</p>}
      <div className="mt-5 space-y-2">
        {todos.map((todo) => (
          <article
            key={todo.id}
            className="flex items-start gap-3 rounded-xl border border-border/50 bg-card p-4"
          >
            <button
              type="button"
              aria-label={todo.status === "open" ? "标记完成" : "重新打开"}
              onClick={() => void toggle(todo)}
              className={`mt-0.5 grid size-5 place-items-center rounded border ${todo.status === "completed" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            >
              {todo.status === "completed" ? "✓" : ""}
            </button>
            <div className="min-w-0">
              <p
                className={
                  todo.status === "completed"
                    ? "text-muted-foreground line-through"
                    : "text-foreground"
                }
              >
                {todo.content}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {todo.owner_name || "未指定负责人"}
                {todo.topic_title ? ` · ${todo.topic_title}` : ""}
                {todo.due_at ? ` · ${new Date(todo.due_at).toLocaleDateString("zh-CN")}` : ""}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                来源：{new Date(todo.updated_at).toLocaleString("zh-CN")}
              </p>
            </div>
          </article>
        ))}
      </div>
      {!todos.length && !error && (
        <p className="mt-8 text-sm text-muted-foreground">当前没有待办。</p>
      )}
    </main>
  );
}
