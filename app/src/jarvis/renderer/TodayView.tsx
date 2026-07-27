import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "../../components/ui/button";
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

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
  onViewAllTodos: () => void;
}

export default function TodayView({ recording, onViewAllTodos }: TodayViewProps) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);

  return (
    <>
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
      </main>
      <aside
        className="overflow-y-visible border-t border-border/40 bg-muted/10 p-4 lg:overflow-y-auto lg:border-l lg:border-t-0"
        aria-label={t("jarvis.insights")}
      >
        <div className="space-y-3">
          <SessionSummaryPanel
            sessionId={recording.session.id}
            sessionStatus={recording.session.status}
          />
          <ActivityClassificationPanel
            sessionId={recording.session.id}
            sessionStatus={recording.session.status}
          />
          <ActionCenter
            sessionId={recording.session.id}
            sessionStatus={recording.session.status}
            onViewAll={onViewAllTodos}
          />
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
              type="button"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => setSettingsOpen(true)}
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
            onClick={() => setSettingsOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t("jarvis.settingsDrawer.title")}
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
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("jarvis.settingsDrawer.close")}
                onClick={() => setSettingsOpen(false)}
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
