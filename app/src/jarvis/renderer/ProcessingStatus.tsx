import type { JarvisPreviewStatus, JarvisSessionTimeline } from "../types";

function previewLabel(status: JarvisPreviewStatus | null | undefined) {
  if (!status) return null;
  if (status.mode === "paused") return "实时预览已暂停，录音继续";
  const seconds = Math.max(1, Math.round((status.cadenceMs ?? 0) / 1_000));
  if (status.mode === "degraded") {
    return `实时预览已降频（每 ${seconds} 秒），录音继续`;
  }
  return `实时预览每 ${seconds} 秒更新，录音继续`;
}

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
  const previewText = previewLabel(
    timeline.status === "recording" ? timeline.preview_status : null
  );
  const preview = previewText ? (
    <p className="text-sm text-muted-foreground">
      {previewText}
      {timeline.preview_status?.lastError ? "；上次预览失败，将自动重试" : null}
    </p>
  ) : null;
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
        {preview}
        {blockedAlert}
      </div>
    );
  }
  if (blockedAlert) {
    return (
      <div className="space-y-2">
        {preview}
        {blockedAlert}
      </div>
    );
  }
  if (timeline.processing_state === "ready") {
    return (
      <div className="space-y-2">
        <p role="status">处理完成</p>
        {preview}
      </div>
    );
  }
  return (
    <div role="status" className="text-sm text-muted-foreground">
      <p className="font-medium text-foreground">正在处理</p>
      <p>
        待处理 {counts.pending} · 处理中 {counts.leased} · 等待重试 {counts.retry} · 已完成{" "}
        {counts.completed}/{counts.total}
      </p>
      {preview}
    </div>
  );
}
