import type { JarvisSessionTimeline } from "../types";

export default function ProcessingStatus({ timeline }: { timeline: JarvisSessionTimeline }) {
  const counts = timeline.processing_counts;
  const captureLabel =
    timeline.status === "recording"
      ? "正在录音"
      : timeline.status === "paused"
        ? "录音已暂停"
        : timeline.status === "finalizing"
          ? "正在完成录音"
          : null;
  const blockedAlert =
    counts.blocked > 0 ? (
      <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        <p className="font-medium">处理受阻</p>
        <p>{counts.blocked} 个任务无法继续，请检查本地模型或存储后重试。</p>
      </div>
    ) : null;
  if (captureLabel) {
    return (
      <div className="space-y-2">
        <p role="status">{captureLabel}</p>
        {blockedAlert}
      </div>
    );
  }
  if (blockedAlert) return blockedAlert;
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
