import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  BrainCircuit,
  Pencil,
  Plus,
  Target,
  Trash2,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import type {
  JarvisActivityCategory,
  JarvisLearningGoal,
  JarvisLearningGoalResult,
  JarvisNotificationPreferences,
  JarvisPersonalizationRule,
  JarvisPersonalizationRuleEdit,
  JarvisPersonalizationSettings,
} from "../types";

type RuleDraft = {
  label: string;
  targetValue: JarvisActivityCategory;
  applicationKeys: string;
  selfParticipated: boolean;
  speakerCountBucket: "none" | "one" | "multiple";
  timeBucket: "night" | "morning" | "afternoon" | "evening";
};

const CATEGORY_LABELS: Array<[JarvisActivityCategory, string]> = [
  ["work_meeting", "工作会议"],
  ["learning", "学习"],
  ["social_call", "社交通话"],
  ["in_person_conversation", "面对面对话"],
  ["entertainment", "娱乐"],
  ["gaming", "游戏"],
  ["other", "其他"],
  ["unknown", "未确定"],
];

function draftFor(rule: JarvisPersonalizationRule): RuleDraft {
  return {
    label: rule.label,
    targetValue: rule.targetValue as JarvisActivityCategory,
    applicationKeys: rule.conditions.applicationKeys.join(", "),
    selfParticipated: rule.conditions.selfParticipated,
    speakerCountBucket: rule.conditions.speakerCountBucket,
    timeBucket: rule.conditions.timeBucket === "unknown" ? "evening" : rule.conditions.timeBucket,
  };
}

function editFor(draft: RuleDraft): JarvisPersonalizationRuleEdit {
  const applicationKeys = [
    ...new Set(
      draft.applicationKeys
        .split(/[，,]/u)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
  if (applicationKeys.some((entry) => !/^[a-z][a-z0-9_]{0,63}$/u.test(entry))) {
    throw new TypeError("应用键格式无效");
  }
  return {
    label: draft.label.trim(),
    targetValue: draft.targetValue,
    conditions: {
      applicationKeys,
      selfParticipated: draft.selfParticipated,
      speakerCountBucket: draft.speakerCountBucket,
      timeBucket: draft.timeBucket,
    },
  };
}

function muteLabel(preferences: JarvisNotificationPreferences) {
  if (preferences.focusMode) return "专注模式已开启";
  if (preferences.mutedUntil && preferences.mutedUntil > Date.now()) {
    return `静音至 ${new Date(preferences.mutedUntil).toLocaleString()}`;
  }
  return "仅已确认且由你设置时间的提醒可发送 Windows 通知";
}

const LEARNING_GOAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function normalizedGoalTitle(value: string): string {
  const title = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    Array.from(title).length < 1 ||
    Array.from(title).length > 500 ||
    LEARNING_GOAL_CONTROL_CHARACTERS.test(title)
  ) {
    throw new RangeError("学习目标必须包含 1–500 个安全字符");
  }
  return title;
}

function learningGoalLength(value: string): number {
  return Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " ")).length;
}

export default function PersonalizationSettingsCard() {
  const learningGoalApiAvailable = Boolean(window.electronAPI?.jarvis?.listLearningGoals);
  const [settings, setSettings] = useState<JarvisPersonalizationSettings | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [learningGoals, setLearningGoals] = useState<JarvisLearningGoal[]>([]);
  const [goalLoading, setGoalLoading] = useState(true);
  const [goalBusyId, setGoalBusyId] = useState<string | null>(null);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [editingGoal, setEditingGoal] = useState<{ id: string; title: string } | null>(null);

  const reload = async () => {
    try {
      setSettings(await window.electronAPI.jarvis.getPersonalizationSettings());
      setError(null);
    } catch {
      setError("个性化设置暂时不可用");
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const jarvis = window.electronAPI?.jarvis;
    if (!jarvis?.listLearningGoals) {
      setGoalError("学习目标暂时不可用，请稍后重试");
      setGoalLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void jarvis
      .listLearningGoals()
      .then((goals) => {
        if (cancelled) return;
        setLearningGoals(goals.filter((goal) => goal.state !== "deleted"));
        setGoalError(null);
      })
      .catch(() => {
        if (!cancelled) setGoalError("学习目标暂时不可用，请稍后重试");
      })
      .finally(() => {
        if (!cancelled) setGoalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyGoalResult = (result: JarvisLearningGoalResult) => {
    setLearningGoals((current) => {
      if (result.goal.state === "deleted") {
        return current.filter((goal) => goal.id !== result.goal.id);
      }
      const exists = current.some((goal) => goal.id === result.goal.id);
      return exists
        ? current.map((goal) => (goal.id === result.goal.id ? result.goal : goal))
        : [result.goal, ...current];
    });
  };

  const runGoalAction = async (
    busyId: string,
    failureMessage: string,
    request: () => Promise<JarvisLearningGoalResult>
  ) => {
    if (goalBusyId !== null) return false;
    setGoalBusyId(busyId);
    setGoalError(null);
    try {
      applyGoalResult(await request());
      return true;
    } catch {
      setGoalError(failureMessage);
      return false;
    } finally {
      setGoalBusyId(null);
    }
  };

  const createGoal = async () => {
    let title: string;
    try {
      title = normalizedGoalTitle(newGoalTitle);
    } catch {
      setGoalError("学习目标必须包含 1–500 个字符");
      return;
    }
    const saved = await runGoalAction("create", "没有创建学习目标，请重试", () =>
      window.electronAPI.jarvis.createLearningGoal(title)
    );
    if (saved) setNewGoalTitle("");
  };

  const saveGoalEdit = async (goal: JarvisLearningGoal) => {
    if (editingGoal?.id !== goal.id) return;
    let title: string;
    try {
      title = normalizedGoalTitle(editingGoal.title);
    } catch {
      setGoalError("学习目标必须包含 1–500 个字符");
      return;
    }
    if (title === goal.title) {
      setEditingGoal(null);
      return;
    }
    const saved = await runGoalAction(goal.id, "没有保存学习目标修改，请重试", () =>
      window.electronAPI.jarvis.editLearningGoal(goal.id, title)
    );
    if (saved) setEditingGoal(null);
  };

  const archiveGoal = async (goal: JarvisLearningGoal) => {
    await runGoalAction(goal.id, "没有归档学习目标，请重试", () =>
      window.electronAPI.jarvis.archiveLearningGoal(goal.id)
    );
  };

  const restoreGoal = async (goal: JarvisLearningGoal) => {
    await runGoalAction(goal.id, "没有恢复学习目标，请重试", () =>
      window.electronAPI.jarvis.restoreLearningGoal(goal.id)
    );
  };

  const deleteGoal = async (goal: JarvisLearningGoal) => {
    if (!window.confirm(`永久删除学习目标“${goal.title}”？此操作无法撤销。`)) return;
    const deleted = await runGoalAction(goal.id, "没有删除学习目标，请重试", () =>
      window.electronAPI.jarvis.deleteLearningGoal(goal.id)
    );
    if (deleted && editingGoal?.id === goal.id) setEditingGoal(null);
  };

  const confirmedGoals = learningGoals.filter((goal) => goal.state === "confirmed");
  const archivedGoals = learningGoals.filter((goal) => goal.state === "archived");

  const renderGoal = (goal: JarvisLearningGoal) => {
    const isEditing = editingGoal?.id === goal.id;
    const actionInProgress = goalBusyId !== null;
    const draftTitle = isEditing ? editingGoal.title : "";
    const draftLength = learningGoalLength(draftTitle);
    const validDraft =
      draftLength >= 1 && draftLength <= 500 && !LEARNING_GOAL_CONTROL_CHARACTERS.test(draftTitle);

    return (
      <li key={goal.id} className="rounded-lg border border-border/40 bg-background/40 p-3">
        {isEditing ? (
          <div className="space-y-2">
            <input
              value={editingGoal.title}
              onChange={(event) => setEditingGoal({ id: goal.id, title: event.target.value })}
              aria-label={`编辑学习目标 ${goal.title}`}
              disabled={goalBusyId === goal.id}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">{draftLength}/500</span>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  disabled={actionInProgress || !validDraft}
                  aria-label={`保存学习目标 ${goal.title}`}
                  onClick={() => void saveGoalEdit(goal)}
                >
                  {goalBusyId === goal.id ? "保存中…" : "保存"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={goalBusyId === goal.id}
                  aria-label={`取消编辑学习目标 ${goal.title}`}
                  onClick={() => setEditingGoal(null)}
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs font-medium text-foreground">{goal.title}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {goal.state === "confirmed" ? "可绑定学习类建议" : "已停止用于新建议"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={actionInProgress}
                aria-label={`编辑学习目标 ${goal.title}`}
                title="编辑"
                onClick={() => setEditingGoal({ id: goal.id, title: goal.title })}
              >
                <Pencil className="size-3.5" aria-hidden="true" />
              </Button>
              {goal.state === "confirmed" ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={actionInProgress}
                  aria-label={`归档学习目标 ${goal.title}`}
                  title="归档"
                  onClick={() => void archiveGoal(goal)}
                >
                  <Archive className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={actionInProgress}
                  aria-label={`恢复学习目标 ${goal.title}`}
                  title="恢复"
                  onClick={() => void restoreGoal(goal)}
                >
                  <ArchiveRestore className="size-3.5" aria-hidden="true" />
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={actionInProgress}
                aria-label={`删除学习目标 ${goal.title}`}
                title="永久删除"
                onClick={() => void deleteGoal(goal)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </li>
    );
  };

  const decide = async (
    rule: JarvisPersonalizationRule,
    action: "enable" | "disable" | "delete" | "edit"
  ) => {
    setBusy(true);
    try {
      await window.electronAPI.jarvis.decidePersonalizationRule(
        rule.id,
        action,
        action === "edit" && draft ? editFor(draft) : undefined
      );
      setEditing(null);
      setDraft(null);
      await reload();
    } catch {
      setError("没有保存规则修改，请重试");
    } finally {
      setBusy(false);
    }
  };

  const updateNotifications = async (focusMode: boolean, mutedUntil: number | null) => {
    setBusy(true);
    try {
      const notifications = await window.electronAPI.jarvis.setNotificationPreferences(
        focusMode,
        mutedUntil
      );
      setSettings((current) => (current ? { ...current, notifications } : current));
      setError(null);
    } catch {
      setError("没有保存通知设置，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <BrainCircuit className="size-4" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">个性化规则</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            全部规则和纠正记录只保存在本地。一次纠正不会改变全局行为。
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {settings?.rules.length ? (
          settings.rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-border/40 p-3">
              {editing === rule.id ? (
                <div className="space-y-2">
                  <input
                    value={draft?.label ?? ""}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, label: event.target.value } : current
                      )
                    }
                    aria-label="规则名称"
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-muted-foreground">
                      目标分类
                      <select
                        aria-label="规则目标分类"
                        value={draft?.targetValue ?? "unknown"}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  targetValue: event.target.value as JarvisActivityCategory,
                                }
                              : current
                          )
                        }
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      >
                        {CATEGORY_LABELS.map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] text-muted-foreground">
                      时间段
                      <select
                        aria-label="规则时间段"
                        value={draft?.timeBucket ?? "evening"}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  timeBucket: event.target.value as RuleDraft["timeBucket"],
                                }
                              : current
                          )
                        }
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      >
                        <option value="morning">上午</option>
                        <option value="afternoon">下午</option>
                        <option value="evening">晚间</option>
                        <option value="night">深夜</option>
                      </select>
                    </label>
                  </div>
                  <label className="block text-[11px] text-muted-foreground">
                    应用键（逗号分隔）
                    <input
                      value={draft?.applicationKeys ?? ""}
                      onChange={(event) =>
                        setDraft((current) =>
                          current ? { ...current, applicationKeys: event.target.value } : current
                        )
                      }
                      aria-label="规则应用键"
                      placeholder="chrome, kook"
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-muted-foreground">
                      说话人数
                      <select
                        aria-label="规则说话人数"
                        value={draft?.speakerCountBucket ?? "none"}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  speakerCountBucket: event.target
                                    .value as RuleDraft["speakerCountBucket"],
                                }
                              : current
                          )
                        }
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      >
                        <option value="none">无</option>
                        <option value="one">1 人</option>
                        <option value="multiple">多人</option>
                      </select>
                    </label>
                    <label className="mt-5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={draft?.selfParticipated ?? false}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, selfParticipated: event.target.checked }
                              : current
                          )
                        }
                      />
                      本人参与
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !draft?.label.trim()}
                      onClick={() => void decide(rule, "edit")}
                    >
                      保存规则
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null);
                        setDraft(null);
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium">{rule.label}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {rule.supportCount} 次相似纠正 ·{" "}
                        {rule.state === "proposed"
                          ? "待你确认"
                          : rule.state === "enabled"
                            ? "已启用"
                            : "已关闭"}
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                      {rule.targetValue}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant={rule.state === "enabled" ? "outline" : "default"}
                      disabled={busy}
                      onClick={() =>
                        void decide(rule, rule.state === "enabled" ? "disable" : "enable")
                      }
                    >
                      {rule.state === "enabled" ? "关闭" : "启用"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(rule.id);
                        setDraft(draftFor(rule));
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      编辑
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void decide(rule, "delete")}
                    >
                      <Trash2 aria-hidden="true" />
                      删除
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))
        ) : (
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            暂无长期规则。相似纠正至少出现 3 次后才会在这里提议。
          </p>
        )}
      </div>

      {settings && settings.rules.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="mt-3"
          onClick={async () => {
            if (!window.confirm("删除全部个性化规则？纠正历史会保留用于审计。")) return;
            setBusy(true);
            try {
              await window.electronAPI.jarvis.resetPersonalizationRules();
              await reload();
            } finally {
              setBusy(false);
            }
          }}
        >
          重置全部规则
        </Button>
      )}

      <div className="mt-4 border-t border-border/50 pt-4">
        <div className="flex items-start gap-2">
          <Target className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold">学习目标</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              学习类建议只允许绑定已确认目标。学习目标仅保存在本地。
            </p>
          </div>
        </div>

        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createGoal();
          }}
        >
          <div className="flex gap-2">
            <input
              value={newGoalTitle}
              onChange={(event) => setNewGoalTitle(event.target.value)}
              aria-label="新学习目标"
              disabled={!learningGoalApiAvailable || goalBusyId !== null}
              placeholder="例如：完成 CUDA 性能优化课程"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            />
            <Button
              type="submit"
              size="sm"
              disabled={
                goalBusyId !== null ||
                !learningGoalApiAvailable ||
                learningGoalLength(newGoalTitle) < 1 ||
                learningGoalLength(newGoalTitle) > 500 ||
                LEARNING_GOAL_CONTROL_CHARACTERS.test(newGoalTitle)
              }
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {goalBusyId === "create" ? "创建中…" : "添加"}
            </Button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              目标确认后，学习场景中的候选建议才能与它关联。
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {learningGoalLength(newGoalTitle)}/500
            </span>
          </div>
        </form>

        {goalError && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {goalError}
          </p>
        )}

        {goalLoading ? (
          <p className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            正在读取学习目标…
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <section aria-labelledby="confirmed-learning-goals-heading">
              <div className="flex items-center justify-between gap-2">
                <h4 id="confirmed-learning-goals-heading" className="text-xs font-medium">
                  已确认
                </h4>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                  {confirmedGoals.length}
                </span>
              </div>
              {confirmedGoals.length > 0 ? (
                <ul className="mt-2 space-y-2">{confirmedGoals.map(renderGoal)}</ul>
              ) : (
                <p className="mt-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  暂无已确认目标。
                </p>
              )}
            </section>

            <section aria-labelledby="archived-learning-goals-heading">
              <div className="flex items-center justify-between gap-2">
                <h4 id="archived-learning-goals-heading" className="text-xs font-medium">
                  已归档
                </h4>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {archivedGoals.length}
                </span>
              </div>
              {archivedGoals.length > 0 ? (
                <ul className="mt-2 space-y-2">{archivedGoals.map(renderGoal)}</ul>
              ) : (
                <p className="mt-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  暂无已归档目标。
                </p>
              )}
            </section>
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-border/50 pt-4">
        <div className="flex items-center gap-2">
          <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">克制通知</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {settings ? muteLabel(settings.notifications) : "正在读取通知设置…"}
        </p>
        {settings && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={settings.notifications.focusMode ? "default" : "outline"}
              disabled={busy}
              onClick={() =>
                void updateNotifications(
                  !settings.notifications.focusMode,
                  settings.notifications.mutedUntil
                )
              }
            >
              专注模式
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void updateNotifications(false, Date.now() + 60 * 60 * 1000)}
            >
              静音 1 小时
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void updateNotifications(false, null)}
            >
              取消静音
            </Button>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </section>
  );
}
