import type { JarvisSessionTimeline } from "../types";

export default function ProcessingStatus({ timeline }: { timeline: JarvisSessionTimeline }) {
  const counts = timeline.processing_counts;
  if (timeline.status === "recording") return <p role="status">正在录音</p>;
  if (timeline.status === "paused") return <p role="status">录音已暂停</p>;
  if (timeline.status === "finalizing") return <p role="status">正在完成录音</p>;
  if (counts.blocked > 0) {
    return (
      <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        <p className="font-medium">处理受阻</p>
        <p>{counts.blocked} 个任务无法继续，请检查本地模型或存储后重试。</p>
      </div>
    );
  }
  if (timeline.processing_state === "ready") return <p role="status">处理完成</p>;
  return (
    <div role="status" className="text-sm text-muted-foreground">
      <p className="font-medium text-foreground">正在处理</p>
      <p>
        待处理 {counts.pending} · 处理中 {counts.leased} · 等待重试 {counts.retry} · 已完成{" "}
        {counts.completed}/{counts.total}
      </p>
    </div>
  );
}
