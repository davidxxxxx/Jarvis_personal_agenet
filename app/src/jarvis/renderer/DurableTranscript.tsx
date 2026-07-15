import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { JarvisSpeakerClusterView, JarvisTranscriptSegment } from "../types";
import SpeakerChip from "./SpeakerChip";
import { useJarvisStore } from "./jarvisStore";

interface DurableTranscriptProps {
  sessionId: string;
  segments: JarvisTranscriptSegment[];
}

const EMPTY_CLUSTERS: JarvisSpeakerClusterView[] = [];

export default function DurableTranscript({ sessionId, segments }: DurableTranscriptProps) {
  const { t } = useTranslation();
  const clusters = useJarvisStore((state) => state.clustersBySession[sessionId] ?? EMPTY_CLUSTERS);
  const loadSessionClusters = useJarvisStore((state) => state.loadSessionClusters);

  useEffect(() => {
    if (typeof window.electronAPI?.jarvis?.listSessionSpeakerClusters !== "function") return;
    void loadSessionClusters(sessionId).catch(() => undefined);
  }, [loadSessionClusters, sessionId]);

  return (
    <section className="mt-4 rounded-xl border border-border/50 bg-card p-5">
      <h2 className="font-semibold">{t("jarvis.durableTranscript")}</h2>
      <div className="mt-3 space-y-3">
        {segments.map((segment) => {
          const cluster =
            clusters.find((candidate) => candidate.evidenceSegmentIds.includes(segment.id)) ?? null;
          return (
            <article key={segment.id} className="rounded-lg bg-muted/20 p-3">
              <div className="mb-2 flex items-center gap-2">
                <SpeakerChip cluster={cluster} localLabel={segment.speaker_label} />
                <time className="text-xs text-muted-foreground">
                  {new Date(segment.started_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="text-sm leading-6">{segment.text}</p>
            </article>
          );
        })}
        {!segments.length && (
          <p className="text-sm text-muted-foreground">{t("jarvis.durableTranscriptEmpty")}</p>
        )}
      </div>
    </section>
  );
}
