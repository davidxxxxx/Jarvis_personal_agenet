import { useEffect, useState } from "react";
import { BellOff, BrainCircuit, Pencil, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import type {
  JarvisNotificationPreferences,
  JarvisPersonalizationRule,
  JarvisPersonalizationSettings,
} from "../types";

function muteLabel(preferences: JarvisNotificationPreferences) {
  if (preferences.focusMode) return "专注模式已开启";
  if (preferences.mutedUntil && preferences.mutedUntil > Date.now()) {
    return `静音至 ${new Date(preferences.mutedUntil).toLocaleString()}`;
  }
  return "仅已确认且由你设置时间的提醒可发送 Windows 通知";
}

export default function PersonalizationSettingsCard() {
  const [settings, setSettings] = useState<JarvisPersonalizationSettings | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const decide = async (
    rule: JarvisPersonalizationRule,
    action: "enable" | "disable" | "delete" | "edit"
  ) => {
    setBusy(true);
    try {
      await window.electronAPI.jarvis.decidePersonalizationRule(
        rule.id,
        action,
        action === "edit" ? label : undefined
      );
      setEditing(null);
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
                <div className="flex gap-2">
                  <input
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    aria-label="编辑个性化规则"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !label.trim()}
                    onClick={() => void decide(rule, "edit")}
                  >
                    保存
                  </Button>
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
                        setLabel(rule.label);
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
              onClick={() =>
                void updateNotifications(false, Date.now() + 60 * 60 * 1000)
              }
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
