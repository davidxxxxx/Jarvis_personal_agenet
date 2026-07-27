import { useCallback, useEffect, useState } from "react";
import { Tags } from "lucide-react";
import type {
  JarvisActivityCategory,
  JarvisActivityClassification,
  JarvisPersonalizationRule,
} from "../types";

const CATEGORIES: Array<{ value: JarvisActivityCategory; label: string }> = [
  { value: "work_meeting", label: "工作会议" },
  { value: "learning", label: "学习" },
  { value: "social_call", label: "社交通话" },
  { value: "in_person_conversation", label: "面对面对话" },
  { value: "entertainment", label: "娱乐" },
  { value: "gaming", label: "游戏" },
  { value: "other", label: "其他" },
  { value: "unknown", label: "未确定" },
];

function categoryLabel(value: string) {
  return CATEGORIES.find((entry) => entry.value === value)?.label ?? value;
}

interface ActivityClassificationPanelProps {
  sessionId: string | null;
  sessionStatus: string;
}

export default function ActivityClassificationPanel({
  sessionId,
  sessionStatus,
}: ActivityClassificationPanelProps) {
  const [items, setItems] = useState<JarvisActivityClassification[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [proposedRule, setProposedRule] = useState<JarvisPersonalizationRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setItems([]);
      return;
    }
    try {
      const result = await window.electronAPI.jarvis.listActivityClassifications(sessionId);
      setItems(result);
      setError(null);
    } catch {
      setError("活动分类暂时不可用");
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload, sessionStatus]);

  const correct = async (item: JarvisActivityClassification, category: JarvisActivityCategory) => {
    if (category === item.category) return;
    setBusyId(item.id);
    setError(null);
    try {
      const result = await window.electronAPI.jarvis.correctActivityClassification(
        item.id,
        category
      );
      setProposedRule(result.proposedRule);
      await reload();
    } catch {
      setError("没有保存这次纠正，请重试");
    } finally {
      setBusyId(null);
    }
  };

  if (!sessionId || (items.length === 0 && !error)) return null;

  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Tags className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">活动分类</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            分类错误时直接改正；同类纠正重复出现后，Jarvis 才会提出个人规则。
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-lg border border-border/40 bg-background/60 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {item.applications.length > 0
                    ? item.applications.join(" · ")
                    : "麦克风 / 来源未知"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.source === "user" ? "你已纠正" : `置信度 ${Math.round(item.confidence * 100)}%`}
                </p>
              </div>
              <select
                value={item.category}
                disabled={busyId === item.id}
                aria-label={`修改活动分类 ${categoryLabel(item.category)}`}
                onChange={(event) =>
                  void correct(item, event.target.value as JarvisActivityCategory)
                }
                className="max-w-32 rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                {CATEGORIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
      {proposedRule && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          已形成待确认规则：“{proposedRule.label}”。请在设置 → 个性化规则中决定是否启用。
        </p>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </section>
  );
}
