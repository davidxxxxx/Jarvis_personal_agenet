import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import LiveTranscript from "./LiveTranscript";
import RecordingControls from "./RecordingControls";
import VoiceEnrollment from "./VoiceEnrollment";

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
}

function InsightCard({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {t("jarvis.waitingForAnalysis")}
      </p>
    </section>
  );
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
        <LiveTranscript segments={recording.segments} partialText={recording.partialText} />
      </main>
      <aside
        className="overflow-y-visible border-t border-border/40 bg-muted/10 p-4 lg:overflow-y-auto lg:border-l lg:border-t-0"
        aria-label={t("jarvis.insights")}
      >
        <div className="space-y-3">
          <InsightCard title={t("jarvis.currentTopic")} />
          <InsightCard title={t("jarvis.newTodos")} />
          <InsightCard title={t("jarvis.aiAdvice")} />
          <VoiceEnrollment />
        </div>
      </aside>
    </>
  );
}
