import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, Mic, MonitorSpeaker, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { getSettings } from "../../stores/settingsStore";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import FirstUseConsentDialog from "./FirstUseConsentDialog";
import InputLevelWave from "./InputLevelWave";
import JarvisMicrophoneSelector from "./JarvisMicrophoneSelector";
import JarvisCaptureModeSelector from "./JarvisCaptureModeSelector";
import { useJarvisStore } from "./jarvisStore";
import { hasRecordingConsent } from "./recordingConsent";
import type { JarvisCaptureMode, JarvisCaptureSourceState, JarvisRetentionMode } from "../types";

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

function useMicrophoneName(refreshKey: string, enabled: boolean): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setName(null);
      return;
    }
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
  }, [enabled, refreshKey]);

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
  const captureMode = useJarvisStore((state) => state.captureMode);
  const setCaptureMode = useJarvisStore((state) => state.setCaptureMode);
  const retentionMode = useJarvisStore((state) => state.retentionMode);
  const effectiveRetentionMode = useJarvisStore((state) => state.effectiveRetentionMode);
  const retentionDegradedReason = useJarvisStore((state) => state.retentionDegradedReason);
  const sourceStates = useJarvisStore((state) => state.sourceStates);
  const isSystemOnly = captureMode === "system";
  const microphoneName = useMicrophoneName(session.status, !isSystemOnly);
  const isRecording = session.status === "recording";
  const isPaused = session.status === "paused";
  const isBusy = session.status === "starting" || session.status === "finalizing";
  const showsRetentionRuntime = ["recording", "paused", "finalizing"].includes(session.status);
  const commandPending = recording.operation !== null || invoking;
  const sourceSemanticsLocked =
    !["idle", "completed", "failed"].includes(session.status) || commandPending;
  const retentionSemanticsLocked = isBusy || commandPending;

  const sourceLabel = (state: JarvisCaptureSourceState): string =>
    t(`jarvis.capture.status.${state}`);
  const micRequired = captureMode !== "system";
  const systemRequired = captureMode !== "mic";
  const hasRequiredSourceFailure =
    (micRequired && sourceStates.mic === "unavailable") ||
    (systemRequired && sourceStates.system === "unavailable");
  const isAvailable = (state: JarvisCaptureSourceState): boolean =>
    state === "ready" || state === "recording";
  const selectedSourceStates =
    captureMode === "mic"
      ? [sourceStates.mic]
      : captureMode === "system"
        ? [sourceStates.system]
        : [sourceStates.mic, sourceStates.system];
  const hasActiveCaptureSource = selectedSourceStates.some(isAvailable);
  const hasRecoveringCaptureSource =
    selectedSourceStates.some((state) => state === "recovering") ||
    (micRequired && recording.micRecoveryStatus === "reconnecting");
  const isRecordingWithoutActiveSource = isRecording && !hasActiveCaptureSource;
  const isActivelyListening = isRecording && hasActiveCaptureSource;
  const availableCaptureMode: JarvisCaptureMode | null =
    isAvailable(sourceStates.mic) && isAvailable(sourceStates.system)
      ? "dual"
      : isAvailable(sourceStates.mic)
        ? "mic"
        : isAvailable(sourceStates.system)
          ? "system"
          : null;

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const elapsed = useMemo(() => formatDuration(activeElapsedMs(recording, now)), [now, recording]);
  const statusLabel = isRecordingWithoutActiveSource
    ? t(
        hasRecoveringCaptureSource
          ? "jarvis.capture.restoringSources"
          : "jarvis.capture.noActiveSource"
      )
    : isRecording
      ? t(
          retentionMode === "continuous"
            ? "jarvis.retention.importantMeeting"
            : "jarvis.retention.listening"
        )
      : isPaused
        ? t("jarvis.paused")
        : session.status === "starting" && recording.preparationStage
          ? t(`jarvis.preparation.${recording.preparationStage}`)
          : t(`jarvis.status.${session.status}`);
  const computerAudioLabel = t("jarvis.capture.sources.system");
  const microphoneLabel = t("jarvis.capture.sources.mic");
  const monitoredLevel =
    captureMode === "mic"
      ? recording.micLevel
      : captureMode === "system"
        ? recording.systemLevel
        : Math.max(recording.micLevel, recording.systemLevel);
  const monitoredSourceLabel =
    captureMode === "mic"
      ? microphoneLabel
      : captureMode === "system"
        ? computerAudioLabel
        : recording.systemLevel > recording.micLevel
          ? computerAudioLabel
          : microphoneLabel;
  const recordingErrorKey =
    recording.error === "capture_source_unavailable"
      ? `jarvis.capture.unavailable.${captureMode}`
      : "jarvis.recordingError";

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

  const retryCaptureSources = () => {
    if (sourceSemanticsLocked) return;
    void run(recording.start);
  };

  const continueWithAvailableSource = () => {
    if (sourceSemanticsLocked || !availableCaptureMode) return;
    setCaptureMode(availableCaptureMode);
    void run(recording.start);
  };

  return (
    <header className="px-6 py-5">
      <div
        className={`rounded-2xl border p-4 shadow-sm transition-colors ${
          isActivelyListening
            ? "border-red-500/40 bg-red-500/[0.06]"
            : isPaused || isRecordingWithoutActiveSource
              ? "border-amber-500/40 bg-amber-500/[0.06]"
              : "border-border/50 bg-card/70"
        }`}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              role={isSystemOnly ? "img" : undefined}
              aria-label={isSystemOnly ? computerAudioLabel : undefined}
              className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                isActivelyListening
                  ? "bg-red-500 text-white"
                  : isRecordingWithoutActiveSource
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isSystemOnly ? <MonitorSpeaker aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full ${
                    isActivelyListening
                      ? "animate-pulse bg-red-500"
                      : isPaused || isRecordingWithoutActiveSource
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
                {isSystemOnly
                  ? computerAudioLabel
                  : recording.activeMicLabel || microphoneName || t("jarvis.defaultMicrophone")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
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
        <div className="mt-4">
          <InputLevelWave
            level={monitoredLevel}
            label={t("jarvis.audioLevel")}
            active={isActivelyListening}
            idleLabel={t("jarvis.micLevelState.idle")}
            quietLabel={t("jarvis.micLevelState.quiet")}
            audibleLabel={t("jarvis.micLevelState.audible")}
            sourceLabel={monitoredSourceLabel}
          />
        </div>
        {(recording.error || actionError) && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {t(actionError ? "jarvis.operationError" : recordingErrorKey)}
          </p>
        )}
        {showsRetentionRuntime &&
          effectiveRetentionMode === "continuous_fallback" &&
          retentionDegradedReason && (
            <p
              role="status"
              className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {t("jarvis.retention.degraded")}
            </p>
          )}
        <div aria-live="polite" className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            {t("jarvis.capture.sourceStatus", {
              source: t("jarvis.capture.sources.mic"),
              status: sourceLabel(sourceStates.mic),
            })}
          </span>
          <span>
            {t("jarvis.capture.sourceStatus", {
              source: computerAudioLabel,
              status: sourceLabel(sourceStates.system),
            })}
          </span>
        </div>
        {hasRequiredSourceFailure && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={sourceSemanticsLocked}
              onClick={retryCaptureSources}
            >
              {t("jarvis.capture.retry")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={sourceSemanticsLocked || availableCaptureMode === null}
              onClick={continueWithAvailableSource}
            >
              {t("jarvis.capture.continueWithAvailableSource")}
            </Button>
          </div>
        )}
        {!isSystemOnly && recording.micRecoveryStatus === "reconnecting" ? (
          <p
            aria-live="polite"
            className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            {t("jarvis.micReconnecting", { count: recording.micRecoveryAttempt ?? 1 })}
          </p>
        ) : !isSystemOnly &&
          recording.micRecoveryStatus === "restored" &&
          recording.activeMicLabel ? (
          <p
            aria-live="polite"
            className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
          >
            {t("jarvis.micRestored", { device: recording.activeMicLabel })}
          </p>
        ) : recording.micFallbackActive ? (
          <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("jarvis.micFallback", {
              device: recording.activeMicLabel || t("jarvis.defaultMicrophone"),
            })}
          </p>
        ) : null}
        <div className="mt-4 grid gap-1.5">
          <label className="text-xs font-medium text-foreground" htmlFor="jarvis-retention-mode">
            {t("jarvis.retention.groupLabel")}
          </label>
          <select
            id="jarvis-retention-mode"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            value={retentionMode}
            disabled={retentionSemanticsLocked}
            onChange={(event) =>
              void run(() =>
                recording.setRetentionMode(event.currentTarget.value as JarvisRetentionMode)
              )
            }
          >
            <option value="speech_triggered">{t("jarvis.retention.speechTriggered")}</option>
            <option value="continuous">{t("jarvis.retention.importantMeeting")}</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {t(
              retentionMode === "continuous"
                ? "jarvis.retention.continuousDescription"
                : "jarvis.retention.speechTriggeredDescription"
            )}
          </p>
        </div>
        <JarvisCaptureModeSelector
          value={captureMode}
          onChange={setCaptureMode}
          disabled={sourceSemanticsLocked}
        />
        {captureMode !== "system" && <JarvisMicrophoneSelector disabled={sourceSemanticsLocked} />}
      </div>
      <FirstUseConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        onConsent={() => run(recording.start)}
      />
    </header>
  );
}
