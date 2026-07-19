import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Gamepad2, Gauge, Scale, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type {
  JarvisApplicationAudioStatus,
  JarvisResourceGovernanceProfile,
  JarvisResourceGovernanceSettings,
} from "../types";

const PRESETS: Record<JarvisResourceGovernanceProfile, JarvisResourceGovernanceSettings> = {
  game_priority: {
    profile: "game_priority",
    externalGpuThresholdPct: 20,
    recoveryWaitMs: 120_000,
  },
  balanced: {
    profile: "balanced",
    externalGpuThresholdPct: 45,
    recoveryWaitMs: 60_000,
  },
  processing_priority: {
    profile: "processing_priority",
    externalGpuThresholdPct: 75,
    recoveryWaitMs: 15_000,
  },
};

const PROFILE_ICONS = {
  game_priority: Gamepad2,
  balanced: Scale,
  processing_priority: Zap,
} as const;

export default function ResourceGovernanceSettingsCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<JarvisResourceGovernanceSettings | null>(null);
  const [draft, setDraft] = useState<JarvisResourceGovernanceSettings>(PRESETS.balanced);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applicationAudio, setApplicationAudio] =
    useState<JarvisApplicationAudioStatus | null>(null);
  const [applicationSaving, setApplicationSaving] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const current = await window.electronAPI.jarvis.getResourceGovernance();
      setSettings(current);
      setDraft(current);
      try {
        setApplicationAudio(await window.electronAPI.jarvis.getApplicationAudioSettings());
      } catch {
        // Resource governance remains usable when app-audio discovery is unavailable
        // (including during a rolling upgrade from an older main process).
        setApplicationAudio(null);
      }
    } catch {
      setError(true);
    }
  }, []);

  const persistApplicationAudio = useCallback(
    async (enabled: boolean, trackLimit: number) => {
      setApplicationSaving(true);
      setSaved(false);
      setError(false);
      try {
        const current = await window.electronAPI.jarvis.setApplicationAudioSettings({
          enabled,
          trackLimit,
        });
        setApplicationAudio(current);
        setSaved(true);
      } catch {
        setError(true);
      } finally {
        setApplicationSaving(false);
      }
    },
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async (next: JarvisResourceGovernanceSettings) => {
    setSaving(true);
    setSaved(false);
    setError(false);
    try {
      const current = await window.electronAPI.jarvis.setResourceGovernance(next);
      setSettings(current);
      setDraft(current);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }, []);

  const customized = useMemo(() => {
    if (!settings) return false;
    const preset = PRESETS[settings.profile];
    return (
      preset.externalGpuThresholdPct !== settings.externalGpuThresholdPct ||
      preset.recoveryWaitMs !== settings.recoveryWaitMs
    );
  }, [settings]);

  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Gauge className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t("jarvis.resourceGovernance.title")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("jarvis.resourceGovernance.description")}
          </p>
        </div>
      </div>

      {!settings && !error ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {t("jarvis.resourceGovernance.loading")}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group">
            {(["game_priority", "balanced", "processing_priority"] as const).map((profile) => {
              const Icon = PROFILE_ICONS[profile];
              const selected = settings?.profile === profile;
              return (
                <button
                  key={profile}
                  type="button"
                  aria-pressed={selected}
                  disabled={saving}
                  onClick={() => void persist(PRESETS[profile])}
                  className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/60 bg-background/60 text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  <Icon className="mb-2 size-4" aria-hidden="true" />
                  <span className="block text-xs font-semibold">
                    {t(`jarvis.resourceGovernance.profiles.${profile}.title`)}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug">
                    {t(`jarvis.resourceGovernance.profiles.${profile}.description`)}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("jarvis.resourceGovernance.fullscreenGuarantee")}
          </p>

          {applicationAudio && (
            <div className="rounded-lg border border-border/60 bg-background/50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-2.5">
                  <AudioLines className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {t("jarvis.resourceGovernance.applicationAudio.title")}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {t("jarvis.resourceGovernance.applicationAudio.description")}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={applicationAudio.enabled}
                  disabled={applicationSaving}
                  onClick={() =>
                    void persistApplicationAudio(
                      !applicationAudio.enabled,
                      applicationAudio.trackLimit
                    )
                  }
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    applicationAudio.enabled ? "bg-primary" : "bg-muted"
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${
                      applicationAudio.enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <label
                  htmlFor="jarvis-application-track-limit"
                  className="text-[11px] text-muted-foreground"
                >
                  {t("jarvis.resourceGovernance.applicationAudio.trackLimit")}
                </label>
                <select
                  id="jarvis-application-track-limit"
                  disabled={applicationSaving || !applicationAudio.enabled}
                  value={applicationAudio.trackLimit}
                  onChange={(event) =>
                    void persistApplicationAudio(
                      applicationAudio.enabled,
                      Number(event.target.value)
                    )
                  }
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                >
                  {Array.from({ length: 8 }, (_, index) => index + 1).map((limit) => (
                    <option key={limit} value={limit}>
                      {limit}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {applicationAudio.runtime.running
                  ? t("jarvis.resourceGovernance.applicationAudio.runtime", {
                      active: applicationAudio.runtime.activeTracks.length,
                      limit: applicationAudio.runtime.effectiveLimit,
                      fallback: applicationAudio.runtime.fallbacks.length,
                    })
                  : t("jarvis.resourceGovernance.applicationAudio.idle")}
              </p>
            </div>
          )}

          <details className="rounded-lg border border-border/60 bg-background/50">
            <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-medium text-foreground">
              {t("jarvis.resourceGovernance.advanced")}
              {customized ? ` · ${t("jarvis.resourceGovernance.customized")}` : ""}
            </summary>
            <div className="space-y-4 border-t border-border/50 px-3 py-3">
              <div>
                <label
                  htmlFor="jarvis-resource-gpu-threshold"
                  className="block text-xs font-medium text-foreground"
                >
                  {t("jarvis.resourceGovernance.gpuThreshold")}
                </label>
                <input
                  id="jarvis-resource-gpu-threshold"
                  aria-describedby="jarvis-resource-gpu-threshold-help"
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  type="number"
                  min={10}
                  max={85}
                  step={5}
                  value={draft.externalGpuThresholdPct}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      externalGpuThresholdPct: Number(event.target.value),
                    }))
                  }
                />
                <p
                  id="jarvis-resource-gpu-threshold-help"
                  className="mt-1 text-[11px] font-normal text-muted-foreground"
                >
                  {t("jarvis.resourceGovernance.gpuThresholdHelp")}
                </p>
              </div>

              <div>
                <label
                  htmlFor="jarvis-resource-recovery-wait"
                  className="block text-xs font-medium text-foreground"
                >
                  {t("jarvis.resourceGovernance.recoveryWait")}
                </label>
                <input
                  id="jarvis-resource-recovery-wait"
                  aria-describedby="jarvis-resource-recovery-wait-help"
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  type="number"
                  min={15}
                  max={300}
                  step={15}
                  value={draft.recoveryWaitMs / 1_000}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      recoveryWaitMs: Number(event.target.value) * 1_000,
                    }))
                  }
                />
                <p
                  id="jarvis-resource-recovery-wait-help"
                  className="mt-1 text-[11px] font-normal text-muted-foreground"
                >
                  {t("jarvis.resourceGovernance.recoveryWaitHelp")}
                </p>
              </div>

              <Button
                type="button"
                className="w-full"
                disabled={
                  saving ||
                  !Number.isInteger(draft.externalGpuThresholdPct) ||
                  draft.externalGpuThresholdPct < 10 ||
                  draft.externalGpuThresholdPct > 85 ||
                  !Number.isInteger(draft.recoveryWaitMs) ||
                  draft.recoveryWaitMs < 15_000 ||
                  draft.recoveryWaitMs > 300_000
                }
                onClick={() => void persist(draft)}
              >
                {saving
                  ? t("jarvis.resourceGovernance.saving")
                  : t("jarvis.resourceGovernance.applyAdvanced")}
              </Button>
            </div>
          </details>

          {saved && (
            <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("jarvis.resourceGovernance.saved")}
            </p>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-destructive">
                {t("jarvis.resourceGovernance.error")}
              </p>
              {!settings && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void load()}
                >
                  {t("jarvis.resourceGovernance.retry")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
