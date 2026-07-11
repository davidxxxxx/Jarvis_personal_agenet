import { useEffect, useState } from "react";
import type { JarvisTopic, JarvisTopicDetail } from "../types";

export default function TopicsView() {
  const [topics, setTopics] = useState<JarvisTopic[]>([]);
  const [detail, setDetail] = useState<JarvisTopicDetail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void window.electronAPI.jarvis
      .listTopics()
      .then(setTopics)
      .catch(() => setError(true));
  }, []);
  const open = (id: string) =>
    void window.electronAPI.jarvis
      .getTopicDetail(id)
      .then(setDetail)
      .catch(() => setError(true));
  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2">
      <h1 className="text-2xl font-semibold">主题</h1>
      <p className="mt-1 text-sm text-muted-foreground">把多次对话中的相同事情放在一起。</p>
      {error && <p className="mt-4 text-sm text-destructive">主题数据读取失败。</p>}
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {topics.map((topic) => (
          <button
            type="button"
            key={topic.id}
            onClick={() => open(topic.id)}
            className="rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
          >
            <p className="font-medium">{topic.canonical_title}</p>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{topic.description}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              {topic.session_count ?? 0} 次对话 · {topic.open_todo_count ?? 0} 个开放待办
            </p>
          </button>
        ))}
      </div>
      {!topics.length && !error && (
        <p className="mt-8 text-sm text-muted-foreground">MiniMax 完成分析后，主题会显示在这里。</p>
      )}
      {detail && (
        <section className="mt-6 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex justify-between">
            <h2 className="text-lg font-semibold">{detail.topic.canonical_title}</h2>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-muted-foreground"
            >
              关闭
            </button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{detail.topic.description}</p>
          <h3 className="mt-5 text-sm font-semibold">相关记忆</h3>
          <div className="mt-2 space-y-2">
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
