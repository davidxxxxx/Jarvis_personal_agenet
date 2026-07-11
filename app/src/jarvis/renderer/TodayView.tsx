import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import type { JarvisMiniMaxConfig, JarvisTodayInsights } from "../types";
import type { UseJarvisRecordingResult } from "./useJarvisRecording";
import LiveTranscript from "./LiveTranscript";
import RecordingControls from "./RecordingControls";
import VoiceEnrollment from "./VoiceEnrollment";
import TranscriptionQualityCard from "./TranscriptionQualityCard";

interface TodayViewProps {
  recording: UseJarvisRecordingResult;
}

function InsightCard({ title, children }: { title: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="mt-3 text-xs leading-5 text-muted-foreground">
        {children ?? t("jarvis.waitingForAnalysis")}
      </div>
    </section>
  );
}

export default function TodayView({ recording }: TodayViewProps) {
  const { t } = useTranslation();
  const [insights, setInsights] = useState<JarvisTodayInsights | null>(null);
  const [miniMax, setMiniMax] = useState<JarvisMiniMaxConfig | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refreshInsights = useCallback(async () => {
    const sessionId = recording.session.id;
    if (!sessionId || typeof window.electronAPI?.jarvis?.getTodayInsights !== "function") return;
    try {
      setInsights(await window.electronAPI.jarvis.getTodayInsights(sessionId));
    } catch {
      // Recording remains usable when derived data cannot be queried.
    }
  }, [recording.session.id]);

  useEffect(() => {
    void refreshInsights();
  }, [refreshInsights, recording.segments.length]);
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
      setMessage("MiniMax 已连接");
    } catch {
      setMessage("MiniMax Key 保存失败");
    }
  };

  const decisions = insights?.summary
    ? (JSON.parse(insights.summary.decisions_json || "[]") as string[])
    : [];
  const suggestions = insights?.summary
    ? (JSON.parse(insights.summary.suggestions_json || "[]") as Array<{
        content: string;
        reason: string;
      }>)
    : [];
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
          <InsightCard title={t("jarvis.currentTopic")}>
            {insights?.topics.length ? (
              <ul className="space-y-2">
                {insights.topics.slice(0, 4).map((topic) => (
                  <li key={topic.id}>
                    <span className="font-medium text-foreground">{topic.canonical_title}</span>
                    <br />
                    {topic.description}
                  </li>
                ))}
              </ul>
            ) : undefined}
          </InsightCard>
          <InsightCard title={t("jarvis.newTodos")}>
            {insights?.todos.length ? (
              <ul className="space-y-1">
                {insights.todos
                  .filter((todo) => todo.status === "open")
                  .slice(0, 5)
                  .map((todo) => (
                    <li key={todo.id}>○ {todo.content}</li>
                  ))}
              </ul>
            ) : undefined}
          </InsightCard>
          <InsightCard title={t("jarvis.aiAdvice")}>
            {suggestions.length || decisions.length ? (
              <div className="space-y-2">
                {decisions.map((decision) => (
                  <p key={decision}>
                    <span className="font-medium text-foreground">决定：</span>
                    {decision}
                  </p>
                ))}
                {suggestions.map((suggestion) => (
                  <p key={suggestion.content}>
                    <span className="font-medium text-foreground">建议：</span>
                    {suggestion.content}
                  </p>
                ))}
              </div>
            ) : undefined}
          </InsightCard>
          <section className="rounded-xl border border-border/50 bg-card/70 p-4">
            <h2 className="text-sm font-semibold">MiniMax 分析</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {miniMax?.keyConfigured
                ? `已配置 · ${miniMax.model}`
                : "未配置，只会保存本地录音和转写"}
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
                  安全保存 Key
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
