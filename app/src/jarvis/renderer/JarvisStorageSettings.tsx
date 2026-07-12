import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Database, HardDrive, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JarvisStorageStatus } from "../types";

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value / 1024 ** unit
  )} ${units[unit]}`;
}

export default function JarvisStorageSettings({ captureActive }: { captureActive: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JarvisStorageStatus | null>(null);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await window.electronAPI.jarvis.getStorageStatus());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const migrate = async () => {
    if (captureActive || busy || !destination.trim()) return;
    setBusy(true);
    setError(false);
    try {
      await window.electronAPI.jarvis.migrateStorage({ to: destination.trim() });
      setDestination("");
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-w-0 overflow-y-auto p-6 lg:col-span-2" aria-labelledby="storage-title">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <HardDrive className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 id="storage-title" className="text-2xl font-semibold">
            {t("jarvis.storage.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("jarvis.storage.description")}</p>
        </div>
      </div>

      {status && (
        <>
          <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-live="polite">
            {[
              ["free", bytes(status.freeBytes)],
              ["written24h", bytes(status.writtenBytes24h)],
              ["compressed24h", bytes(status.compressedBytes24h)],
              ["projectedDaily", bytes(status.projectedDailyGrowthBytes)],
              [
                "remaining",
                status.remainingDays === null
                  ? t("jarvis.storage.notAvailable")
                  : t("jarvis.storage.days", { count: status.remainingDays }),
              ],
            ].map(([key, value]) => (
              <div key={key} className="rounded-xl border border-border/50 bg-card p-4">
                <p className="text-xs text-muted-foreground">{t(`jarvis.storage.${key}`)}</p>
                <p className="mt-2 text-lg font-semibold">{value}</p>
              </div>
            ))}
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("jarvis.storage.state")}</p>
              <p className="mt-2 text-lg font-semibold">
                {t(`jarvis.storage.states.${status.state}`)}
              </p>
            </div>
          </section>
          <section className="mt-4 rounded-xl border border-border/50 bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Database className="size-4" aria-hidden="true" />
              {t("jarvis.storage.currentRoot")}
            </div>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
              {status.currentRoot}
            </p>
            {status.recoveryAction && (
              <p className="mt-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {status.recoveryAction}
              </p>
            )}
            {status.progress && (
              <p className="mt-3 text-sm" role="status">
                {t("jarvis.storage.progress", {
                  completed: status.progress.completedFiles,
                  total: status.progress.totalFiles,
                })}
              </p>
            )}
          </section>
        </>
      )}

      <section className="mt-4 rounded-xl border border-border/50 bg-card p-4">
        <label htmlFor="jarvis-storage-target" className="text-sm font-medium">
          {t("jarvis.storage.newRoot")}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="jarvis-storage-target"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <button
            type="button"
            disabled={captureActive || busy || !destination.trim()}
            onClick={() => void migrate()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
            {t("jarvis.storage.migrate")}
          </button>
        </div>
        {captureActive && (
          <p className="mt-2 text-xs text-muted-foreground">{t("jarvis.storage.captureActive")}</p>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{t("jarvis.storage.error")}</p>}
      </section>
    </main>
  );
}
