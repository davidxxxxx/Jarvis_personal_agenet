import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, Mic, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { getSettings } from "../../stores/settingsStore";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import FirstUseConsentDialog from "./FirstUseConsentDialog";
import { hasRecordingConsent } from "./recordingConsent";

interface RecordingControlsProps {
  recording: UseJarvisRecordingResult;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function activeElapsedMs(recording: UseJarvisRecordingResult, now: number): number {
  const { session } = recording;
  if (session.status !== "recording" || session.activeSince === null) {
    return session.accumulatedMs;
  }
  return session.accumulatedMs + Math.max(0, now - session.activeSince);
}

function useMicrophoneName(refreshKey: string): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const selectedId = getSettings().selectedMicDeviceId;
        const microphone =
          devices.find(
            (device) => device.kind === "audioinput" && device.deviceId === selectedId
          ) ||
          devices.find((device) => device.kind === "audioinput" && device.deviceId === "default") ||
          devices.find((device) => device.kind === "audioinput");
        if (active && microphone?.label) setName(microphone.label);
      } catch {
        // The generic label remains truthful when device enumeration is unavailable.
      }
    };
    void load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, [refreshKey]);

  return name;
}

export default function RecordingControls({ recording }: RecordingControlsProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const [consentOpen, setConsentOpen] = useState(false);
  const [invoking, setInvoking] = useState(false);
  const [actionError, setActionError] = useState(false);
  const invocationRef = useRef(false);
  const { session } = recording;
  const microphoneName = useMicrophoneName(session.status);
  const isRecording = session.status === "recording";
  const isPaused = session.status === "paused";
  const isBusy = session.status === "starting" || session.status === "finalizing";
  const commandPending = recording.operation !== null || invoking;

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const elapsed = useMemo(() => formatDuration(activeElapsedMs(recording, now)), [now, recording]);
  const micPercent = Math.round(Math.max(0, Math.min(1, recording.micLevel)) * 100);
  const statusLabel = isRecording
    ? t("jarvis.listening")
    : isPaused
      ? t("jarvis.paused")
      : t(`jarvis.status.${session.status}`);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (invocationRef.current || recording.operation !== null) return;
    invocationRef.current = true;
    setInvoking(true);
    setActionError(false);
    try {
      await action();
    } catch {
      setActionError(true);
    } finally {
      invocationRef.current = false;
      setInvoking(false);
    }
  };

  const requestStart = () => {
    if (hasRecordingConsent()) {
      void run(recording.start);
      return;
    }
    setConsentOpen(true);
  };

  return (
    <header className="px-6 py-5">
      <div
        className={`rounded-2xl border p-4 shadow-sm transition-colors ${
          isRecording
            ? "border-red-500/40 bg-red-500/[0.06]"
            : isPaused
              ? "border-amber-500/40 bg-amber-500/[0.06]"
              : "border-border/50 bg-card/70"
        }`}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                isRecording ? "bg-red-500 text-white" : "bg-muted text-muted-foreground"
              }`}
            >
              <Mic aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full ${
                    isRecording
                      ? "animate-pulse bg-red-500"
                      : isPaused
                        ? "bg-amber-500"
                        : "bg-muted-foreground/40"
                  }`}
                  aria-hidden="true"
                />
                <p className="text-sm font-semibold text-foreground" aria-live="polite">
                  {statusLabel}
                </p>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {microphoneName || t("jarvis.defaultMicrophone")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div
              role="meter"
              aria-label={t("jarvis.micLevel")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={micPercent}
              className="w-24"
            >
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-[width] duration-100 ${
                    isRecording ? "bg-red-500" : "bg-primary"
                  }`}
                  style={{ width: `${micPercent}%` }}
                />
              </div>
            </div>
            <time className="w-14 text-right font-mono text-sm tabular-nums text-foreground">
              {elapsed}
            </time>
          </div>

          {isRecording ? (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={commandPending}
                onClick={() => void run(recording.pause)}
              >
                <Pause aria-hidden="true" />
                {t("jarvis.pause")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={commandPending}
                onClick={() => void run(recording.finish)}
              >
                <CircleStop aria-hidden="true" />
                {t("jarvis.finish")}
              </Button>
            </div>
          ) : isPaused ? (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={commandPending}
                onClick={() => void run(recording.resume)}
              >
                <RotateCcw aria-hidden="true" />
                {t("jarvis.resume")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={commandPending}
                onClick={() => void run(recording.finish)}
              >
                <CircleStop aria-hidden="true" />
                {t("jarvis.finish")}
              </Button>
            </div>
          ) : (
            <Button type="button" disabled={isBusy || commandPending} onClick={requestStart}>
              <Play aria-hidden="true" />
              {t("jarvis.start")}
            </Button>
          )}
        </div>
        {(recording.error || actionError) && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {t(actionError ? "jarvis.operationError" : "jarvis.recordingError")}
          </p>
        )}
      </div>
      <FirstUseConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        onConsent={() => run(recording.start)}
      />
    </header>
  );
}
