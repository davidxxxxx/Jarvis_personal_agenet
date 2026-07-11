import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { JarvisPersonDetail, JarvisPersonOverview } from "../types";

export default function PeopleView() {
  const [people, setPeople] = useState<JarvisPersonOverview[]>([]);
  const [detail, setDetail] = useState<JarvisPersonDetail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void window.electronAPI.jarvis
      .listPeopleOverview()
      .then(setPeople)
      .catch(() => setError(true));
  }, []);
  const open = (id: string) =>
    void window.electronAPI.jarvis
      .getPersonDetail(id)
      .then(setDetail)
      .catch(() => setError(true));
  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">人物</h1>
      <p className="mt-1 text-sm text-muted-foreground">按说话人整理互动、主题、待办和长期记忆。</p>
      {error && <p className="mt-4 text-sm text-destructive">人物数据读取失败。</p>}
      <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {people.map((person) => (
          <button
            type="button"
            key={person.id}
            onClick={() => open(person.id)}
            className="rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
          >
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
                <UserRound className="size-5" />
              </span>
              <div>
                <p className="font-medium">{person.is_self ? "我" : person.display_name}</p>
                <p className="text-xs text-muted-foreground">
                  {person.session_count} 次对话 · {person.open_todo_count} 个待办
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
      {!people.length && !error && (
        <p className="mt-8 text-sm text-muted-foreground">
          完成带说话人标记的录音后，人物会显示在这里。
        </p>
      )}
      {detail && (
        <section className="mt-6 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex justify-between">
            <h2 className="text-lg font-semibold">
              {detail.person.is_self ? "我" : detail.person.display_name}
            </h2>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-muted-foreground"
            >
              关闭
            </button>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">相关会话</p>
              <p className="mt-1 text-xl font-semibold">{detail.sessions.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">相关主题</p>
              <p className="mt-1 text-xl font-semibold">{detail.topics.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">开放待办</p>
              <p className="mt-1 text-xl font-semibold">
                {detail.todos.filter((todo) => todo.status === "open").length}
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-2">
            {detail.memories.map((memory) => (
              <p key={memory.id} className="rounded-lg bg-muted/30 p-3 text-sm">
                {memory.content}
              </p>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
