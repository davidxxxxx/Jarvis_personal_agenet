import type {
  JarvisPreviewStatus,
  JarvisRuntimeDeferral,
  JarvisRuntimeRecoveryAction,
  JarvisRuntimeStatus,
  JarvisSessionTimeline,
} from "../types";

function previewLabel(status: JarvisPreviewStatus | null | undefined) {
  if (!status) return null;
  if (status.mode === "paused") return "实时预览已暂停，录音继续";
  const seconds = Math.max(1, Math.round((status.cadenceMs ?? 0) / 1_000));
  if (status.mode === "degraded") {
    return `实时预览已降频（每 ${seconds} 秒），录音继续`;
  }
  return `实时预览每 ${seconds} 秒更新，录音继续`;
}

const ACTION_LABELS: Record<JarvisRuntimeRecoveryAction, string> = {
  wait_for_gpu: "等待 GPU",
  check_cuda: "检查 CUDA",
  free_disk: "释放磁盘",
  restore_microphone: "检查麦克风",
  retry_jobs: "重试任务",
};

const STAGE_LABELS: Record<string, string> = {
  retention_urgent: "保留保护",
  storage_recovery_compress: "磁盘恢复",
  preview: "实时预览",
  final_transcription: "最终转写",
  compression: "音频压缩",
  speaker: "说话人",
  analysis: "分析",
};

const SPEAKER_DEFERRAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  external_gpu_busy: "其他 GPU 重任务正在运行，说话人处理已让路",
  battery_saver: "节电模式已暂停说话人处理",
  cpu_load_high: "CPU 负载较高，等待系统负载降低",
  telemetry_unavailable: "正在等待可信的资源状态",
  diarization_runtime_unavailable: "本地说话人运行时不可用",
  diarization_model_unavailable: "本地说话人模型不可用",
  resources_constrained: "资源受限，说话人处理已延后（resources_constrained）",
});

const SPEAKER_JOB_LABELS: Readonly<Record<string, string>> = Object.freeze({
  speaker: "说话人处理",
  diarize_track: "说话人分段",
  resolve_identities: "说话人身份解析",
});

function speakerDeferralLabel(reason: string) {
  return SPEAKER_DEFERRAL_LABELS[reason] ?? `说话人处理已延后（${reason}）`;
}

function speakerRetryLabel(deferral: JarvisRuntimeDeferral, observedAt: number) {
  if (deferral.nextRetryAt === null) return null;
  const waitMs = Math.max(0, deferral.nextRetryAt - observedAt);
  if (waitMs === 0) return "等待重新调度";
  return `${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后重试`;
}

function primaryRuntimeLabel(status: JarvisRuntimeStatus) {
  const capture = status.capture;
  if (capture.status === "degraded") return "正在恢复麦克风";
  if (capture.status === "paused") return "已暂停";
  if (capture.status === "finalizing") return "正在保存语音";
  if (capture.status === "recording") {
    return capture.retentionMode === "continuous" ? "重要会议" : "正在监听";
  }
  if (capture.status === "failed") return "需要处理";
  if (
    status.queue.blocked > 0 ||
    status.disk.state === "critical" ||
    status.disk.state === "stopped"
  ) {
    return "需要处理";
  }
  if (status.queue.total > 0) return "后台处理中";
  return "处理完成";
}

function activeWorkLabel(status: JarvisRuntimeStatus) {
  if (status.resources.state === "busy") return "GPU 忙，已让路";
  if (status.preview?.running && status.preview.executionDevice === "cuda") {
    return "GPU 预览处理中";
  }
  if (status.queue.total > 0) return "后台处理中";
  return null;
}

function formatMinutes(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function RuntimeProcessingStatus({ status }: { status: JarvisRuntimeStatus }) {
  const primary = primaryRuntimeLabel(status);
  const work = activeWorkLabel(status);
  const recordingContinues =
    status.capture.status === "recording" || status.capture.status === "degraded";
  const backend =
    status.backend.actualBackend === "cuda"
      ? "CUDA"
      : status.backend.actualBackend === "cpu"
        ? "CPU"
        : status.backend.actualBackend === "cloud"
          ? "云端"
          : "尚未运行";
  const coverage = `${
    status.queue.provisionalCoveragePct === null
      ? "临时覆盖 --"
      : `临时覆盖 ${status.queue.provisionalCoveragePct}%`
  } · ${
    status.queue.finalCoveragePct === null
      ? "最终覆盖 --"
      : `最终覆盖 ${status.queue.finalCoveragePct}%`
  }`;
  const stageRows = Object.entries(status.queue.byStage).filter(([, counts]) => counts.total > 0);
  const speakerDeferrals = status.queue.deferrals.filter(({ stage }) => stage === "speaker");
  const action = status.nextRecoveryAction ? ACTION_LABELS[status.nextRecoveryAction] : null;
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p role="status" className="font-medium text-foreground">
          {primary}
        </p>
        {work && <p className="text-muted-foreground">{work}</p>}
        {recordingContinues && work && <p className="text-muted-foreground">录音继续安全保存</p>}
      </div>
      <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
        <p>
          后端 {backend}
          {status.backend.actualBackend === "cuda" && status.backend.cudaGpuUuid
            ? ` · ${status.backend.cudaGpuUuid}`
            : null}
        </p>
        <p>
          资源 {status.resources.state} · {status.resources.reason}
        </p>
        <p>
          积压 {formatMinutes(status.queue.backlogMinutes)} 分钟
          {status.queue.oldestJobAgeMs === null
            ? null
            : ` · 最久 ${formatMinutes(status.queue.oldestJobAgeMs / 60_000)} 分钟`}
        </p>
        <p>{coverage}</p>
        <p>
          {status.preview?.cadenceMs
            ? `预览延迟约 ${Math.max(1, Math.round(status.preview.cadenceMs / 1_000))} 秒`
            : status.preview?.mode === "paused"
              ? "预览已暂停"
              : "预览尚无数据"}
        </p>
        <p>
          磁盘 {status.disk.state}
          {status.disk.remainingDays === null ? null : ` · 预计 ${status.disk.remainingDays} 天`}
        </p>
      </div>
      {stageRows.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stageRows.map(([stage, counts]) => (
            <li key={stage}>
              {STAGE_LABELS[stage] ?? stage}：待 {counts.pending} / 运行 {counts.running} / 重试{" "}
              {counts.retry} / 受阻 {counts.blocked}
            </li>
          ))}
        </ul>
      )}
      {speakerDeferrals.length > 0 && (
        <ul aria-label="说话人处理等待原因" className="space-y-1 text-xs text-muted-foreground">
          {speakerDeferrals.map((deferral) => {
            const retry = speakerRetryLabel(deferral, status.observedAt);
            return (
              <li key={`${deferral.jobType}:${deferral.reason}:${deferral.state}`}>
                {SPEAKER_JOB_LABELS[deferral.jobType] ?? deferral.jobType}：
                {speakerDeferralLabel(deferral.reason)}
                {deferral.count > 1 ? ` · ${deferral.count} 个任务` : null}
                {retry ? ` · ${retry}` : null}
              </li>
            );
          })}
        </ul>
      )}
      {action && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-primary">
          建议操作：<span className="font-medium">{action}</span>
        </p>
      )}
    </div>
  );
}

export default function ProcessingStatus({
  timeline,
  runtimeStatus,
}: {
  timeline: JarvisSessionTimeline;
  runtimeStatus?: JarvisRuntimeStatus | null;
}) {
  if (runtimeStatus) return <RuntimeProcessingStatus status={runtimeStatus} />;
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
