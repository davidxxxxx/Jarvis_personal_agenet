import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightOpen, SlidersHorizontal, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { JarvisRolloutFlags, JarvisSession } from "../types";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import DailyReviewView from "./DailyReviewView";
import LiveTranscript from "./LiveTranscript";
import MiniMaxAgentSettingsCard from "./MiniMaxAgentSettingsCard";
import RecordingControls from "./RecordingControls";
import ResourceGovernanceSettingsCard from "./ResourceGovernanceSettingsCard";
import SessionSummaryPanel from "./SessionSummaryPanel";
import TranscriptionQualityCard from "./TranscriptionQualityCard";
import VoiceEnrollment from "./VoiceEnrollment";
import ActionCenter from "./ActionCenter";
import ActivityClassificationPanel from "./ActivityClassificationPanel";
import PersonalizationSettingsCard from "./PersonalizationSettingsCard";
import CurrentSessionResultView from "./CurrentSessionResultView";
import useAccessibleDrawer from "./useAccessibleDrawer";

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
  onOpenSession: (sessionId: string) => void;
  onViewAllTodos: () => void;
}

function formatDuration(session: JarvisSession): string {
  const durationMs = Math.max(0, (session.ended_at ?? session.started_at) - session.started_at);
  const totalSeconds = Math.floor(durationMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds.toString().padStart(2, "0")}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function sessionStatusLabel(status: JarvisSession["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export default function TodayView({ recording, onOpenSession, onViewAllTodos }: TodayViewProps) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [actionRefreshKey, setActionRefreshKey] = useState(0);
  const [rolloutFlags, setRolloutFlags] = useState<JarvisRolloutFlags | null>(null);
  const insightsTriggerRef = useRef<HTMLButtonElement>(null);
  const insightsCloseRef = useRef<HTMLButtonElement>(null);
  const insightsPanelRef = useRef<HTMLElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const refreshActions = useCallback(() => {
    setActionRefreshKey((current) => current + 1);
  }, []);
  const closeInsights = useCallback(() => {
    setInsightsOpen(false);
  }, []);
  const openSettings = useCallback(() => {
    const narrowLayout =
      typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023px)").matches;
    settingsReturnFocusRef.current = narrowLayout
      ? insightsTriggerRef.current
      : settingsTriggerRef.current;
    setInsightsOpen(false);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const showCurrentSessionResult =
    recording.session.id !== null &&
    (recording.session.status === "finalizing" || recording.session.status === "completed");
  const recentSessions = useMemo(() => {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    return [...(recording.sessions ?? [])]
      .filter(
        (session) =>
          session.id !== recording.session.id &&
          session.started_at >= dayStart &&
          session.started_at < dayEnd
      )
      .sort((left, right) => right.started_at - left.started_at || right.id.localeCompare(left.id))
      .slice(0, 5);
  }, [recording.session.id, recording.sessions]);

  useEffect(() => {
    const getRolloutFlags = window.electronAPI?.jarvis?.getRolloutFlags;
    if (typeof getRolloutFlags !== "function") return;
    let active = true;
    void getRolloutFlags()
      .then((flags) => {
        if (active) setRolloutFlags(flags);
      })
      .catch(() => {
        // A rolling upgrade from an older main process keeps the release defaults.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktopLayout = window.matchMedia("(min-width: 1024px)");
    const leaveDrawerMode = (event: MediaQueryListEvent) => {
      if (event.matches) setInsightsOpen(false);
    };
    desktopLayout.addEventListener("change", leaveDrawerMode);
    return () => desktopLayout.removeEventListener("change", leaveDrawerMode);
  }, []);

  useAccessibleDrawer({
    open: insightsOpen,
    containerRef: insightsPanelRef,
    initialFocusRef: insightsCloseRef,
    returnFocusRef: insightsTriggerRef,
    onDismiss: closeInsights,
  });
  useAccessibleDrawer({
    open: settingsOpen,
    containerRef: settingsPanelRef,
    initialFocusRef: settingsCloseRef,
    returnFocusRef: settingsReturnFocusRef,
    onDismiss: closeSettings,
  });

  return (
    <>
      {showCurrentSessionResult ? (
        <CurrentSessionResultView
          sessionId={recording.session.id as string}
          sessionStatus={recording.session.status}
          startedAt={recording.session.startedAt}
          durationMs={recording.session.accumulatedMs}
          onStartNewRecording={recording.start}
          onDurableResultChange={refreshActions}
        />
      ) : (
        <main className="min-w-0 flex flex-col overflow-hidden">
          <div className="px-6 pt-6">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {t("jarvis.today")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("jarvis.todayDescription")}</p>
          </div>
          <RecordingControls recording={recording} />
          <LiveTranscript
            sessionId={recording.session.id}
            segments={recording.segments}
            partialText={recording.partialText}
          />
          <section className="shrink-0 px-6 pb-6" aria-labelledby="today-recent-sessions-title">
            <div className="rounded-2xl border border-border/50 bg-card/70 p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 id="today-recent-sessions-title" className="text-sm font-semibold">
                  {t("jarvis.todayRecentSessions.title", {
                    defaultValue: "Today's recent sessions",
                  })}
                </h2>
                <span className="text-xs text-muted-foreground">{recentSessions.length}/5</span>
              </div>
              {recentSessions.length > 0 ? (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {recentSessions.map((session) => {
                    const timeLabel = new Date(session.started_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    const statusLabel = sessionStatusLabel(session.status);
                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          aria-label={`Open session ${timeLabel} ${statusLabel}`}
                          onClick={() => onOpenSession(session.id)}
                          className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/70 px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <span>
                            <time
                              dateTime={new Date(session.started_at).toISOString()}
                              className="block text-sm font-medium tabular-nums"
                            >
                              {timeLabel}
                            </time>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {statusLabel}
                            </span>
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatDuration(session)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("jarvis.todayRecentSessions.empty", {
                    defaultValue: "No earlier sessions today.",
                  })}
                </p>
              )}
            </div>
          </section>
        </main>
      )}
      <Button
        ref={insightsTriggerRef}
        type="button"
        className="fixed bottom-4 right-4 z-30 gap-2 shadow-lg lg:hidden"
        onClick={() => setInsightsOpen(true)}
        aria-controls="jarvis-insights-panel"
        aria-expanded={insightsOpen}
      >
        <PanelRightOpen aria-hidden="true" />
        {t("jarvis.insights")}
      </Button>
      {insightsOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/35 lg:hidden"
          aria-label={`${t("common.dismiss")} ${t("jarvis.insights")}`}
          onClick={closeInsights}
        />
      )}
      <aside
        ref={insightsPanelRef}
        id="jarvis-insights-panel"
        role={insightsOpen ? "dialog" : undefined}
        aria-modal={insightsOpen || undefined}
        tabIndex={-1}
        className={`${insightsOpen ? "block" : "hidden"} fixed inset-y-0 right-0 z-50 w-full max-w-[380px] overflow-y-auto border-l border-border/40 bg-background shadow-2xl lg:static lg:z-auto lg:block lg:max-w-none lg:bg-muted/10 lg:shadow-none`}
        aria-label={t("jarvis.insights")}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background px-4 py-3 lg:hidden">
          <h2 className="text-base font-semibold text-foreground">{t("jarvis.insights")}</h2>
          <Button
            ref={insightsCloseRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${t("common.close")} ${t("jarvis.insights")}`}
            onClick={closeInsights}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="space-y-3 p-4">
          {!showCurrentSessionResult && (
            <SessionSummaryPanel
              sessionId={recording.session.id}
              sessionStatus={recording.session.status}
            />
          )}
          <ActivityClassificationPanel
            sessionId={recording.session.id}
            sessionStatus={recording.session.status}
          />
          {(rolloutFlags?.actionCenterV1 ?? true) && (
            <ActionCenter
              sessionId={recording.session.id}
              sessionStatus={recording.session.status}
              refreshKey={actionRefreshKey}
              onViewAll={onViewAllTodos}
            />
          )}
          <DailyReviewView />
          <div className="rounded-xl border border-border/50 bg-card/70 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <SlidersHorizontal className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {t("jarvis.settingsDrawer.title")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("jarvis.settingsDrawer.description")}
                </p>
              </div>
            </div>
            <Button
              ref={settingsTriggerRef}
              type="button"
              variant="outline"
              className="mt-3 w-full"
              onClick={openSettings}
              aria-label={t("jarvis.settingsDrawer.open")}
            >
              <SlidersHorizontal aria-hidden="true" />
              {t("jarvis.settingsDrawer.open")}
            </Button>
          </div>
        </div>
      </aside>
      {settingsOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/35"
            aria-label={t("jarvis.settingsDrawer.dismiss")}
            onClick={closeSettings}
          />
          <aside
            ref={settingsPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("jarvis.settingsDrawer.title")}
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {t("jarvis.settingsDrawer.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("jarvis.settingsDrawer.description")}
                </p>
              </div>
              <Button
                ref={settingsCloseRef}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("jarvis.settingsDrawer.close")}
                onClick={closeSettings}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <ResourceGovernanceSettingsCard />
              <PersonalizationSettingsCard />
              <MiniMaxAgentSettingsCard />
              <TranscriptionQualityCard />
              <VoiceEnrollment />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
