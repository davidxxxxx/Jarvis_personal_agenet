import { useTranslation } from "react-i18next";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import DailyReviewView from "./DailyReviewView";
import LiveTranscript from "./LiveTranscript";
import MiniMaxAgentSettingsCard from "./MiniMaxAgentSettingsCard";
import RecordingControls from "./RecordingControls";
import TranscriptionQualityCard from "./TranscriptionQualityCard";
import VoiceEnrollment from "./VoiceEnrollment";

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
}

export default function TodayView({ recording }: TodayViewProps) {
  const { t } = useTranslation();

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
          <DailyReviewView />
          <MiniMaxAgentSettingsCard />
          <TranscriptionQualityCard />
          <VoiceEnrollment />
        </div>
      </aside>
    </>
  );
}
