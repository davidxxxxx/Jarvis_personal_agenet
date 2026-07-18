import { useEffect, useMemo, useRef, useState } from "react";
import { BrainCircuit, KeyRound, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type {
  JarvisAnalysisBudgetMode,
  JarvisAnalysisBudgetStatus,
  JarvisMiniMaxConfig,
} from "../types";

function dollars(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

type BusyAction = "save-key" | "clear-key" | "budget" | null;

export default function MiniMaxAgentSettingsCard() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<JarvisMiniMaxConfig | null>(null);
  const [budget, setBudget] = useState<JarvisAnalysisBudgetStatus | null>(null);
  const [key, setKey] = useState("");
  const [budgetMode, setBudgetMode] = useState<JarvisAnalysisBudgetMode>("capped");
  const [limitDollars, setLimitDollars] = useState("5");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [invalidBudget, setInvalidBudget] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const configRevision = useRef(0);

  useEffect(() => {
    let active = true;
    const api = window.electronAPI?.jarvis;
    if (
      typeof api?.getMiniMaxConfig !== "function" ||
      typeof api?.getAnalysisBudget !== "function"
    ) {
      setFailed(true);
      return () => {
        active = false;
      };
    }
    const initialConfigRevision = configRevision.current;
    void api
      .getMiniMaxConfig()
      .then((nextConfig) => {
        if (!active || configRevision.current !== initialConfigRevision) return;
        setConfig(nextConfig);
      })
      .catch(() => {
        if (active && configRevision.current === initialConfigRevision) setFailed(true);
      });
    void api
      .getAnalysisBudget()
      .then((nextBudget) => {
        if (!active) return;
        setBudget(nextBudget);
        setBudgetMode(nextBudget.mode);
        setLimitDollars(String(nextBudget.monthlyLimitMicrousd / 1_000_000));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [reloadVersion]);

  const usageSummary = budget
    ? budget.mode === "unlimited"
      ? t("jarvis.miniMaxAgent.usageUnlimitedSummary", {
          spent: dollars(budget.spentMicrousd),
          reserved: dollars(budget.reservedMicrousd),
        })
      : t("jarvis.miniMaxAgent.usageSummary", {
        spent: dollars(budget.spentMicrousd),
        reserved: dollars(budget.reservedMicrousd),
          remaining: dollars(budget.remainingMicrousd ?? 0),
      })
    : "";
  const usedPercent = useMemo(() => {
    if (!budget || budget.mode !== "capped" || budget.monthlyLimitMicrousd === 0) return 0;
    return Math.min(
      100,
      Math.round(
        ((budget.spentMicrousd + budget.reservedMicrousd) / budget.monthlyLimitMicrousd) * 100
      )
    );
  }, [budget]);

  const blockedCopy = budget
    ? budget.mode === "off"
      ? t("jarvis.miniMaxAgent.disabled")
      : budget.mode === "unlimited"
        ? t("jarvis.miniMaxAgent.unlimitedWarning")
      : budget.blockedReason === "usage_unknown"
        ? t("jarvis.miniMaxAgent.usageUnknown")
        : budget.blockedReason === "over_limit"
          ? t("jarvis.miniMaxAgent.overLimit")
          : budget.blockedReason === "budget_exceeded"
            ? t("jarvis.miniMaxAgent.budgetExceeded")
            : null
    : null;

  const saveKey = async () => {
    if (busy || !key.trim()) return;
    setBusy("save-key");
    setMessage(null);
    setFailed(false);
    const revision = ++configRevision.current;
    try {
      const nextConfig = await window.electronAPI.jarvis.setMiniMaxKey(key.trim());
      if (configRevision.current !== revision) return;
      setConfig(nextConfig);
      setKey("");
      setMessage(t("jarvis.miniMaxAgent.keySaved"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    if (busy) return;
    setBusy("clear-key");
    setMessage(null);
    setFailed(false);
    const revision = ++configRevision.current;
    try {
      const nextConfig = await window.electronAPI.jarvis.clearMiniMaxKey();
      if (configRevision.current !== revision) return;
      setConfig(nextConfig);
      setKey("");
      setMessage(t("jarvis.miniMaxAgent.keyRemoved"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const applyBudget = async () => {
    if (busy || !budget) return;
    const parsed = Number(limitDollars);
    const parsedLimitMicrousd = Math.round(parsed * 1_000_000);
    if (budgetMode === "capped" &&
      (
      !Number.isFinite(parsed) ||
      parsed < 0 ||
        parsed > 1_000_000 ||
        !Number.isSafeInteger(parsedLimitMicrousd)
      )) {
      setMessage(null);
      setInvalidBudget(true);
      return;
    }
    const monthlyLimitMicrousd =
      budgetMode === "off"
        ? 0
        : budgetMode === "capped"
          ? parsedLimitMicrousd
          : Number.isSafeInteger(parsedLimitMicrousd) && parsedLimitMicrousd > 0
            ? parsedLimitMicrousd
            : Math.max(5_000_000, budget.monthlyLimitMicrousd);
    setBusy("budget");
    setMessage(null);
    setFailed(false);
    setInvalidBudget(false);
    try {
      const next = await window.electronAPI.jarvis.setAnalysisBudget({
        mode: budgetMode,
        monthlyLimitMicrousd,
        timezone: budget.timezone,
      });
      setBudget(next);
      setBudgetMode(next.mode);
      setLimitDollars(String(next.monthlyLimitMicrousd / 1_000_000));
      setMessage(t("jarvis.miniMaxAgent.budgetSaved"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/70 p-4"
      aria-labelledby="jarvis-minimax-agent-title"
      aria-busy={config === null || budget === null || busy !== null}
    >
      <div className="flex items-center gap-2">
        <BrainCircuit className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="jarvis-minimax-agent-title" className="text-sm font-semibold text-foreground">
          {t("jarvis.miniMaxAgent.title")}
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {t("jarvis.miniMaxAgent.description")}
      </p>

      {(failed || invalidBudget) && (
        <div role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs">
          <p>
            {invalidBudget
              ? t("jarvis.miniMaxAgent.invalidBudget")
              : t("jarvis.miniMaxAgent.settingsError")}
          </p>
          {failed && !invalidBudget && (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => {
                setFailed(false);
                setReloadVersion((version) => version + 1);
              }}
            >
              {t("jarvis.miniMaxAgent.retrySettings")}
            </Button>
          )}
        </div>
      )}
      {message && (
        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
          {message}
        </p>
      )}

      <div className="mt-3 space-y-3 rounded-lg border border-border/40 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5" aria-hidden="true" />
          <span>
            {config
              ? config.keyConfigured
                ? t("jarvis.miniMaxAgent.keyConfigured")
                : t("jarvis.miniMaxAgent.keyNotConfigured")
              : t("jarvis.miniMaxAgent.loading")}
          </span>
        </div>
        {config && (
          <p className="text-[11px] text-muted-foreground">
            {t("jarvis.miniMaxAgent.model", { model: config.model })}
          </p>
        )}
        <label className="sr-only" htmlFor="jarvis-minimax-key">
          {t("jarvis.miniMaxAgent.keyLabel")}
        </label>
        <input
          id="jarvis-minimax-key"
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="sk-cp-…"
          value={key}
          disabled={busy !== null}
          onChange={(event) => setKey(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !key.trim()}
            onClick={() => void saveKey()}
          >
            {t("jarvis.miniMaxAgent.saveKey")}
          </Button>
          {config?.keyConfigured && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void clearKey()}
            >
              {t("jarvis.miniMaxAgent.removeKey")}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <WalletCards className="size-3.5" aria-hidden="true" />
          {t("jarvis.miniMaxAgent.budgetTitle")}
        </div>
        <label className="block text-xs text-muted-foreground" htmlFor="jarvis-minimax-budget">
          {t("jarvis.miniMaxAgent.budgetLabel")}
        </label>
        <select
          id="jarvis-minimax-budget-mode"
          aria-label={t("jarvis.miniMaxAgent.budgetModeLabel")}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          value={budgetMode}
          disabled={busy !== null || budget === null}
          onChange={(event) => {
            setBudgetMode(event.target.value as JarvisAnalysisBudgetMode);
            setFailed(false);
            setInvalidBudget(false);
          }}
        >
          <option value="off">{t("jarvis.miniMaxAgent.modeOff")}</option>
          <option value="capped">{t("jarvis.miniMaxAgent.modeCapped")}</option>
          <option value="unlimited">{t("jarvis.miniMaxAgent.modeUnlimited")}</option>
        </select>
        <div className="flex gap-2">
          {budgetMode === "capped" && (
            <input
              id="jarvis-minimax-budget"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              type="number"
              min={0}
              max={1_000_000}
              step={1}
              value={limitDollars}
              disabled={busy !== null || budget === null}
              onChange={(event) => {
                setLimitDollars(event.target.value);
                setFailed(false);
                setInvalidBudget(false);
              }}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || budget === null}
            onClick={() => void applyBudget()}
          >
            {t("jarvis.miniMaxAgent.applyBudget")}
          </Button>
        </div>
        {budget && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">
              {t("jarvis.miniMaxAgent.period", {
                monthKey: budget.monthKey,
                timezone: budget.timezone,
              })}
            </p>
            {budget.mode === "capped" && (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPercent}
                aria-valuetext={usageSummary}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${usedPercent}%` }}
                />
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">{usageSummary}</p>
          </div>
        )}
        {blockedCopy && <p className="text-xs leading-5 text-amber-600">{blockedCopy}</p>}
      </div>
    </section>
  );
}
