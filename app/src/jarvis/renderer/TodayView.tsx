import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JarvisMiniMaxConfig } from "../types";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import DailyReviewView from "./DailyReviewView";
import LiveTranscript from "./LiveTranscript";
import RecordingControls from "./RecordingControls";
import TranscriptionQualityCard from "./TranscriptionQualityCard";
import VoiceEnrollment from "./VoiceEnrollment";

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
}

export default function TodayView({ recording }: TodayViewProps) {
  const { t } = useTranslation();
  const [miniMax, setMiniMax] = useState<JarvisMiniMaxConfig | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window.electronAPI?.jarvis?.getMiniMaxConfig !== "function") return;
    void window.electronAPI.jarvis
      .getMiniMaxConfig()
      .then(setMiniMax)
      .catch(() => setMiniMax(null));
  }, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    setMessage(null);
    try {
      setMiniMax(await window.electronAPI.jarvis.setMiniMaxKey(key.trim()));
      setKey("");
      setMessage(
        t("jarvis.miniMax.connected", { defaultValue: "MiniMax connected / MiniMax 已连接" })
      );
    } catch {
      setMessage(
        t("jarvis.miniMax.saveFailed", {
          defaultValue: "Could not save MiniMax Key / MiniMax Key 保存失败",
        })
      );
    }
  };

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
          <section className="rounded-xl border border-border/50 bg-card/70 p-4">
            <h2 className="text-sm font-semibold">
              {t("jarvis.miniMax.title", { defaultValue: "MiniMax analysis / MiniMax 分析" })}
            </h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {miniMax?.keyConfigured
                ? t("jarvis.miniMax.configured", {
                    defaultValue: "Configured / 已配置 · {{model}}",
                    model: miniMax.model,
                  })
                : t("jarvis.miniMax.notConfigured", {
                    defaultValue:
                      "Not configured; local audio and transcripts still work / 未配置时仍会保存本地录音和转写",
                  })}
            </p>
            {!miniMax?.keyConfigured && (
              <div className="mt-3 space-y-2">
                <input
                  type="password"
                  aria-label="MiniMax Token Plan Key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="sk-cp…"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => void saveKey()}
                  className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                >
                  {t("jarvis.miniMax.save", { defaultValue: "Save Key securely / 安全保存 Key" })}
                </button>
              </div>
            )}
            {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
          </section>
          <TranscriptionQualityCard />
          <VoiceEnrollment />
        </div>
      </aside>
    </>
  );
}
