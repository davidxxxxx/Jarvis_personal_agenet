import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  JarvisActivityCategory,
  JarvisEvidenceContext,
  JarvisKnowledgeEvidence,
  JarvisTodoTrustSnapshot,
} from "../types";
import EvidenceLink from "./EvidenceLink";
import { useJarvisStore } from "./jarvisStore";

const CATEGORY_OPTIONS: Array<{ value: JarvisActivityCategory; label: string }> = [
  { value: "work_meeting", label: "工作会议" },
  { value: "learning", label: "学习" },
  { value: "social_call", label: "社交通话" },
  { value: "in_person_conversation", label: "面对面对话" },
  { value: "entertainment", label: "娱乐" },
  { value: "gaming", label: "游戏" },
  { value: "other", label: "其他" },
  { value: "unknown", label: "未确定" },
];

function categoryLabel(category: JarvisActivityCategory) {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label ?? category;
}

function sourceLabel(source: JarvisEvidenceContext["actionAttribution"]) {
  if (!source) return "来源未确定";
  if (source.sourceAttribution === "mixed_unknown") return "系统音频 · 应用未知";
  if (source.sourceAttribution === "application_and_microphone") {
    return `${source.applicationName} + 麦克风`;
  }
  return source.applicationName;
}

function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function evidenceKey(evidence: JarvisKnowledgeEvidence) {
  return evidence.handle?.evidenceId ?? `${evidence.sessionId}:${evidence.segmentId}`;
}

interface ActionEvidenceDetailsProps {
  evidence: JarvisKnowledgeEvidence[];
  trustSnapshot?: JarvisTodoTrustSnapshot | null;
  defaultOpen?: boolean;
  onCorrected?: () => void | Promise<void>;
  onNotTodo?: () => void;
  notTodoDisabled?: boolean;
}

export default function ActionEvidenceDetails({
  evidence,
  trustSnapshot = null,
  defaultOpen = false,
  onCorrected,
  onNotTodo,
  notTodoDisabled = false,
}: ActionEvidenceDetailsProps) {
  const visibleEvidence = useMemo(() => {
    const seen = new Set<string>();
    return evidence
      .filter((item) => {
        const key = evidenceKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [evidence]);
  const [open, setOpen] = useState(defaultOpen);
  const [contexts, setContexts] = useState<Record<string, JarvisEvidenceContext | null>>({});
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyClassificationId, setBusyClassificationId] = useState<string | null>(null);
  const [draftCategories, setDraftCategories] = useState<Record<string, JarvisActivityCategory>>(
    {}
  );
  const generation = useRef(0);
  const openEvidence = useJarvisStore((state) => state.openEvidence);

  useEffect(() => {
    if (!open) return;
    const request = ++generation.current;
    const load = async () => {
      setLoading(true);
      setLoadFailed(false);
      const entries = await Promise.all(
        visibleEvidence.map(async (item) => {
          const key = evidenceKey(item);
          if (!item.handle) return [key, null] as const;
          try {
            return [key, await window.electronAPI.jarvis.getEvidenceContext(item.handle)] as const;
          } catch {
            return [key, null] as const;
          }
        })
      );
      if (generation.current !== request) return;
      const next = Object.fromEntries(entries);
      setContexts(next);
      setLoadFailed(entries.length > 0 && entries.every(([, context]) => context === null));
      setLoading(false);
    };
    void load();
    return () => {
      generation.current += 1;
    };
  }, [open, visibleEvidence]);

  if (visibleEvidence.length === 0) return null;

  const correctCategory = async (context: JarvisEvidenceContext) => {
    const classification = context.actionAttribution?.activityClassification;
    if (
      !classification?.id ||
      context.actionAttribution?.basis === "captured_todo_snapshot" ||
      busyClassificationId !== null
    ) {
      return;
    }
    const category = draftCategories[classification.id] ?? classification.category;
    if (category === classification.category) return;
    setBusyClassificationId(classification.id);
    try {
      await window.electronAPI.jarvis.correctActivityClassification(classification.id, category);
      const refreshed = await window.electronAPI.jarvis.getEvidenceContext({
        ownerType: context.ownerType,
        ownerId: context.ownerId,
        evidenceId: context.evidenceId,
      });
      setContexts((current) => ({ ...current, [context.evidenceId]: refreshed }));
      await onCorrected?.();
    } catch {
      setLoadFailed(true);
    } finally {
      setBusyClassificationId(null);
    }
  };

  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        查看来源依据 ({visibleEvidence.length})
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {trustSnapshot && (
            <div className="rounded-md border border-border/50 bg-background/70 p-2 text-[10px] text-muted-foreground">
              <div className="font-medium text-foreground">创建时门禁依据</div>
              <div className="mt-1">
                语义 {percent(trustSnapshot.semanticConfidence)} · 声纹{" "}
                {percent(trustSnapshot.voiceprintConfidence)} · 场景{" "}
                {percent(trustSnapshot.sceneConfidence)} · 转写{" "}
                {percent(trustSnapshot.transcriptContextConfidence)}
              </div>
              <div className="mt-1">
                {trustSnapshot.automaticEligible ? "满足自动确认门禁" : "未满足自动确认门禁"}
                {trustSnapshot.state !== "captured" ? " · 历史依据不完整" : ""}
              </div>
            </div>
          )}
          {onNotTodo && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/60 p-2 dark:bg-amber-950/20">
              <p className="text-[10px] leading-4 text-muted-foreground">
                如果这段话只是视频、课程内容，或系统误把它当成你的承诺，请在这里纠正。
              </p>
              <button
                type="button"
                onClick={onNotTodo}
                disabled={notTodoDisabled}
                className="mt-1.5 rounded-md border border-amber-400/70 px-2 py-1 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-950/50"
              >
                这不是待办
              </button>
            </div>
          )}
          {loading && <p className="text-[11px] text-muted-foreground">正在读取本地依据…</p>}
          {loadFailed && (
            <p role="alert" className="text-[11px] text-destructive">
              部分依据暂时无法读取，录音和已有文字仍保留。
            </p>
          )}
          {!loading &&
            visibleEvidence.map((item) => {
              const context = contexts[evidenceKey(item)] ?? null;
              const attribution = context?.actionAttribution ?? null;
              const classification = attribution?.activityClassification ?? null;
              const transcriptContext = context?.transcriptContext ?? [];
              return (
                <div
                  key={evidenceKey(item)}
                  className="rounded-md border border-border/40 bg-muted/20 p-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    <span>{sourceLabel(attribution)}</span>
                    <span>{attribution?.speakerRelation ?? "UNKNOWN"}</span>
                    <span>{new Date(item.startedAt).toLocaleTimeString()}</span>
                    {classification && (
                      <span>
                        {categoryLabel(classification.category)} · 场景{" "}
                        {percent(classification.confidence)}
                      </span>
                    )}
                  </div>
                  {attribution && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      语义 {percent(attribution.semanticConfidence)} · 声纹{" "}
                      {percent(attribution.voiceConfidence)} · 转写{" "}
                      {percent(attribution.transcriptConfidence)}
                      {attribution.basis === "captured_todo_snapshot" ? " · 创建时不可变快照" : ""}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-foreground">
                    {context?.quoteText ?? item.quote}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <EvidenceLink
                      handle={item.handle}
                      quote={item.quote}
                      startedAt={item.startedAt}
                      audioState={item.audioState}
                    />
                    {classification?.id && attribution?.basis !== "captured_todo_snapshot" ? (
                      <div className="flex items-center gap-1">
                        <select
                          aria-label={`更正活动分类 ${classification.id}`}
                          value={draftCategories[classification.id] ?? classification.category}
                          onChange={(event) =>
                            setDraftCategories((current) => ({
                              ...current,
                              [classification.id]: event.target.value as JarvisActivityCategory,
                            }))
                          }
                          className="rounded border border-border bg-background px-1.5 py-1 text-[10px]"
                        >
                          {CATEGORY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void correctCategory(context)}
                          disabled={
                            busyClassificationId !== null ||
                            (draftCategories[classification.id] ?? classification.category) ===
                              classification.category
                          }
                          className="rounded border border-border px-1.5 py-1 text-[10px] disabled:opacity-40"
                        >
                          保存分类
                        </button>
                      </div>
                    ) : attribution?.basis === "captured_todo_snapshot" ? (
                      <span className="text-[10px] text-muted-foreground">创建后不可修改</span>
                    ) : null}
                  </div>
                  {item.handle && context?.transcriptState === "available" && (
                    <button
                      type="button"
                      onClick={() => void openEvidence(item.handle!)}
                      className="mt-1.5 text-[10px] font-medium text-primary hover:underline"
                      aria-label={`复核说话人 ${context.transcriptSegmentId ?? item.segmentId}`}
                    >
                      说话人不对？播放本段并打开复核
                    </button>
                  )}
                  {transcriptContext.length > 1 && (
                    <div className="mt-2 rounded-md bg-background/70 p-2">
                      <p className="text-[10px] font-medium text-foreground">前后文</p>
                      <ol className="mt-1 space-y-1.5">
                        {transcriptContext.map((entry) => (
                          <li
                            key={entry.segmentId}
                            className={entry.isEvidence ? "rounded bg-primary/5 px-1.5 py-1" : ""}
                          >
                            <p className="text-[9px] text-muted-foreground">
                              {entry.applicationName ?? "来源未确定"} · {entry.speakerRelation} ·{" "}
                              {new Date(entry.startedAt).toLocaleTimeString()}
                              {entry.isEvidence ? " · 当前依据" : ""}
                            </p>
                            <p className="mt-0.5 text-[10px] leading-4 text-foreground/90">
                              {entry.text}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {classification?.reason && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      判断依据：{classification.reason}
                    </p>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
