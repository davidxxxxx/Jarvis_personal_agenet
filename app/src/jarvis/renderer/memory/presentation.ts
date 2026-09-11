import type {
  JarvisSession,
  JarvisSessionParticipant,
  JarvisSessionParticipantProjection,
  JarvisParticipantReviewEvent,
  JarvisSpeakerClusterView,
} from "../../types";

export function duration(session: JarvisSession): string {
  const ms = Math.max(0, (session.ended_at ?? Date.now()) - session.started_at);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function dateLabel(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(at);
}

export function speakerCountLabel(minimum: number, maximum: number): string {
  return minimum === maximum ? `${minimum} 人` : `${minimum}–${maximum} 人`;
}

export function participantCountSummary(projection: JarvisSessionParticipantProjection): string {
  if (projection.excluded.anomaly) {
    return "历史声纹异常，人数需重新复核";
  }
  const { count } = projection;
  const minimumOthers = Math.max(0, count.minimum - (count.selfIncluded ? 1 : 0));
  const maximumOthers = Math.max(0, count.maximum - (count.selfIncluded ? 1 : 0));
  const people = speakerCountLabel(count.minimum, count.maximum);
  if (!count.selfIncluded) {
    return `预计 ${people}；未检测到本人发言`;
  }
  return `预计 ${people}；我 + ${speakerCountLabel(minimumOthers, maximumOthers).replace(" 人", "")} 位其他参与者`;
}

export function speechDurationLabel(speechMs: number): string {
  const seconds = Math.max(0, Math.round(speechMs / 1_000));
  if (seconds < 60) return `${seconds} 秒有效语音`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes} 分 ${remaining} 秒有效语音` : `${minutes} 分钟有效语音`;
}

export function summaryRefreshMessage(reason: string | null): string {
  const suffix = "原总结已保留；只有点击上方按钮才会调用 MiniMax 重新总结。";
  switch (reason) {
    case "summary_incomplete":
      return "本次长录音的旧总结只覆盖了部分转写。原总结已保留；只有点击上方按钮才会按完整多窗口转写调用 MiniMax 重新总结。";
    case "transcript_changed":
      return `本地重处理发现转写内容发生变化。${suffix}`;
    case "speaker_identity_changed":
      return `本地重处理发现说话人身份归属发生变化。${suffix}`;
    case "activity_classification_changed":
      return `本地重处理发现活动分类发生变化。${suffix}`;
    case "application_source_changed":
      return `本地重处理发现应用来源发生变化。${suffix}`;
    case "manual_request":
      return `你已请求重新生成总结。${suffix}`;
    default:
      return `高精度复核发现说话人数发生变化。${suffix}`;
  }
}

export function participantStateLabel(participant: JarvisSessionParticipant): string {
  if (participant.kind === "self") return "本人声纹已确认";
  if (participant.kind === "known") return "已命名人物";
  if (participant.kind === "anonymous") {
    return participant.durable ? "匿名人物已跨会话关联" : "未命名人物";
  }
  return "待复核，人数可能调整";
}

export function participantReviewActionLabel(
  action: JarvisParticipantReviewEvent["action"]
): string {
  const labels: Record<JarvisParticipantReviewEvent["action"], string> = {
    split: "拆分人物片段",
    merge: "合并人物",
    mark_media: "标记为媒体声音",
    restore_social: "恢复为互动人物",
    forget_identity: "忘记人物身份",
    pin_evidence: "固定证据",
    unpin_evidence: "取消固定证据",
    undo: "撤销人物修正",
  };
  return labels[action];
}

export interface JarvisVisibleSpeakerGroup {
  key: string;
  representative: JarvisSpeakerClusterView;
  clusterCount: number;
  localLabels: string[];
}

export function groupConfirmedSpeakerPeople(
  clusters: JarvisSpeakerClusterView[]
): JarvisVisibleSpeakerGroup[] {
  const groups: JarvisVisibleSpeakerGroup[] = [];
  const groupIndexByKey = new Map<string, number>();

  for (const cluster of clusters) {
    const personId =
      cluster.linkState === "confirmed" && cluster.person?.id ? cluster.person.id : null;
    const key = personId ? `person:${personId}` : `cluster:${cluster.id}`;
    const existingIndex = groupIndexByKey.get(key);
    if (existingIndex === undefined) {
      groupIndexByKey.set(key, groups.length);
      groups.push({
        key,
        representative: cluster,
        clusterCount: 1,
        localLabels: [cluster.localLabel],
      });
      continue;
    }

    const existing = groups[existingIndex];
    groups[existingIndex] = {
      ...existing,
      representative:
        cluster.updatedAt > existing.representative.updatedAt ? cluster : existing.representative,
      clusterCount: existing.clusterCount + 1,
      localLabels: [...existing.localLabels, cluster.localLabel],
    };
  }

  return groups;
}

export function safeStringArray(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

export interface LegacySuggestion {
  content: string;
  reason: string;
}

export function safeLegacySuggestions(value: string | null | undefined): LegacySuggestion[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is LegacySuggestion =>
          item !== null &&
          typeof item === "object" &&
          "content" in item &&
          typeof item.content === "string" &&
          "reason" in item &&
          typeof item.reason === "string"
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function analysisErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /MEMORY_OWNER_OUT_OF_SCOPE|MEMORY_INPUT_(?:EMPTY|STALE)|analysis_input_(?:empty|invalid)/iu.test(
      message
    )
  ) {
    return "最终转写和说话人识别尚未完成，完成后会自动生成总结。";
  }
  if (/rate.?limit|quota|budget|预算|额度/iu.test(message)) {
    return "MiniMax 云端额度或预算暂不可用，请检查云预算后重试。";
  }
  if (/unauthorized|forbidden|invalid.?key|api.?key|401|403/iu.test(message)) {
    return "MiniMax Key 无效或未配置，请在设置中检查后重试。";
  }
  if (/analysis_runtime_not_ready|offline/iu.test(message)) {
    return "云端分析暂不可用，恢复连接后会自动重试。";
  }
  if (/usage_unknown/iu.test(message)) {
    return "上次云端请求的用量无法确认。有限预算模式已停止自动重试，避免重复计费；可切换为不设上限后手动重试。";
  }
  if (/invalid_response/iu.test(message)) {
    return "MiniMax 返回的数据格式无效，请稍后重试。";
  }
  return "总结未能加入后台队列，请稍后重试。";
}
