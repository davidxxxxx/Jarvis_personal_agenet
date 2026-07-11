import { useCallback, useEffect, useState } from "react";
import { Cloud, KeyRound, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { JarvisCloudBudgetStatus } from "../types";

function dollars(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

export default function TranscriptionQualityCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JarvisCloudBudgetStatus | null>(null);
  const [limitDollars, setLimitDollars] = useState(5);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI.jarvis.getCloudBudget();
    setStatus(next);
    setLimitDollars(next.monthlyLimitMicrousd / 1_000_000);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await window.electronAPI.jarvis.getCloudBudget();
        if (!active) return;
        setStatus(next);
        setLimitDollars(next.monthlyLimitMicrousd / 1_000_000);
      } catch {
        if (active) setMessage(t("jarvis.operationError"));
      }
    })();
    return () => {
      active = false;
    };
  }, [t]);

  const updateBudget = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await window.electronAPI.jarvis.setCloudBudget({
        enabled,
        monthlyLimitMicrousd: Math.round(Math.min(10, Math.max(5, limitDollars)) * 1_000_000),
      });
      setStatus(next);
    } catch {
      setMessage(t("jarvis.operationError"));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.saveOpenAIKey(key.trim());
      setKey("");
      if (!result?.success) throw new Error("key save failed");
      await refresh();
      setMessage(t("jarvis.cloudKeySaved"));
    } catch {
      setMessage(t("jarvis.operationError"));
    } finally {
      setBusy(false);
    }
  };

  const blockedCopy =
    status?.blockedReason === "usage_unknown"
      ? t("jarvis.cloudUsageUnknown")
      : status?.blockedReason === "budget_protected"
        ? t("jarvis.cloudBudgetProtected")
        : null;
  const usedPercent = status
    ? Math.min(
        100,
        Math.round(
          ((status.spentMicrousd + status.reservedMicrousd) /
            status.monthlyLimitMicrousd) *
            100
        )
      )
    : 0;

  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">
          {t("jarvis.transcriptionQuality")}
        </h2>
      </div>

      <div className="mt-3 rounded-lg bg-muted/40 p-3">
        <p className="text-sm font-medium text-foreground">{t("jarvis.localBilingualMode")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("jarvis.localWindowDetails")}</p>
      </div>

      <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Cloud className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">
              {status?.enabled ? t("jarvis.cloudCorrectionOn") : t("jarvis.cloudCorrectionOff")}
            </span>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              aria-label={t("jarvis.enableCloudCorrection")}
              checked={status?.enabled ?? false}
              disabled={busy || !status?.keyConfigured}
              onChange={(event) => void updateBudget(event.target.checked)}
            />
          </label>
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          {t("jarvis.cloudAudioConsent")}
        </p>

        <label className="block text-xs text-muted-foreground">
          {t("jarvis.monthlyHardLimit")}
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            type="number"
            min={5}
            max={10}
            step={1}
            value={limitDollars}
            disabled={busy}
            onChange={(event) => setLimitDollars(Number(event.target.value))}
            onBlur={() => status?.enabled && void updateBudget(true)}
          />
        </label>

        {status && (
          <div className="space-y-1.5">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usedPercent}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("jarvis.cloudUsageSummary", {
                spent: dollars(status.spentMicrousd),
                reserved: dollars(status.reservedMicrousd),
                remaining: dollars(status.remainingMicrousd),
              })}
            </p>
          </div>
        )}
        {blockedCopy && <p className="text-xs leading-5 text-amber-600">{blockedCopy}</p>}

        <div className="space-y-2 rounded-lg border border-border/40 p-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" aria-hidden="true" />
            <span>
              {status?.keyConfigured
                ? t("jarvis.cloudKeyConfigured")
                : t("jarvis.cloudKeyNotConfigured")}
            </span>
          </div>
          <label className="sr-only" htmlFor="jarvis-openai-key">
            {t("jarvis.openAIProjectKey")}
          </label>
          <div className="flex gap-2">
            <input
              id="jarvis-openai-key"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              type="password"
              autoComplete="off"
              placeholder="sk-proj-…"
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button size="sm" variant="outline" disabled={busy || !key.trim()} onClick={saveKey}>
              {t("jarvis.saveCloudKey")}
            </Button>
          </div>
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </section>
  );
}
