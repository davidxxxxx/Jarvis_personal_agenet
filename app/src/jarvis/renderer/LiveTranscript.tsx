import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";
import type { JarvisSpeakerClusterView } from "../types";
import { createStableSegmentId } from "../shared/segmentIds";
import SpeakerChip from "./SpeakerChip";
import { useJarvisStore } from "./jarvisStore";

interface LiveTranscriptProps {
  segments: TranscriptSegment[];
  partialText: string;
  sessionId?: string | null;
}

const EMPTY_CLUSTERS: JarvisSpeakerClusterView[] = [];

function segmentTime(segment: TranscriptSegment): number {
  return Number.isFinite(segment.timestamp) ? (segment.timestamp as number) : 0;
}

export default function LiveTranscript({
  segments,
  partialText,
  sessionId = null,
}: LiveTranscriptProps) {
  const { t } = useTranslation();
  const clusters = useJarvisStore((state) =>
    sessionId ? (state.clustersBySession[sessionId] ?? EMPTY_CLUSTERS) : EMPTY_CLUSTERS
  );
  const loadSessionClusters = useJarvisStore((state) => state.loadSessionClusters);
  const tailRef = useRef<HTMLDivElement>(null);
  const orderedSegments = useMemo(
    () =>
      [...segments].sort(
        (left, right) => segmentTime(left) - segmentTime(right) || left.id.localeCompare(right.id)
      ),
    [segments]
  );
  const lastSegment = orderedSegments.at(-1);
  const lastEvidenceId =
    lastSegment && sessionId ? createStableSegmentId(sessionId, lastSegment.id) : null;
  const lastCluster = lastEvidenceId
    ? clusters.find((cluster) => cluster.evidenceSegmentIds.includes(lastEvidenceId))
    : null;
  const tailSignature = lastSegment
    ? [
        lastSegment.id,
        lastSegment.text,
        lastSegment.speaker,
        lastSegment.speakerName,
        lastSegment.confidence,
        lastSegment.speakerLocked,
        lastSegment.timestamp,
        lastCluster?.updatedAt,
      ].join("\u0000")
    : "";

  useEffect(() => {
    if (sessionId && typeof window.electronAPI?.jarvis?.listSessionSpeakerClusters === "function") {
      void loadSessionClusters(sessionId).catch(() => undefined);
    }
  }, [loadSessionClusters, sessionId]);

  useEffect(() => {
    const tail = tailRef.current;
    if (tail && typeof tail.scrollIntoView === "function") {
      tail.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [tailSignature, partialText]);

  return (
    <section className="min-h-0 flex-1 px-6 pb-6" aria-labelledby="live-transcript-title">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/70 shadow-sm">
        <div className="border-b border-border/40 px-5 py-4">
          <h2 id="live-transcript-title" className="text-sm font-semibold text-foreground">
            {t("jarvis.liveConversation")}
          </h2>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3" aria-live="polite">
          {orderedSegments.length === 0 && !partialText && (
            <div className="grid h-full min-h-52 place-items-center px-8 text-center">
              <div>
                <p className="text-sm font-medium text-foreground">{t("jarvis.transcriptEmpty")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("jarvis.transcriptEmptyDescription")}
                </p>
              </div>
            </div>
          )}
          {orderedSegments.map((segment) => {
            const timestamp = new Date(segmentTime(segment));
            const evidenceSegmentId = sessionId
              ? createStableSegmentId(sessionId, segment.id)
              : null;
            const cluster = evidenceSegmentId
              ? (clusters.find((candidate) =>
                  candidate.evidenceSegmentIds.includes(evidenceSegmentId)
                ) ?? null)
              : null;
            return (
              <article
                key={segment.id}
                data-testid="stable-transcript-row"
                className="rounded-xl px-3 py-3 transition-colors hover:bg-muted/30"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  {segment.speaker && (
                    <SpeakerChip
                      cluster={cluster}
                      localLabel={segment.speakerName || segment.speaker}
                    />
                  )}
                  {segment.timestamp != null && (
                    <time
                      className="text-[11px] tabular-nums text-muted-foreground"
                      dateTime={timestamp.toISOString()}
                    >
                      {timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  )}
                </div>
                <p className="select-text text-sm leading-6 text-foreground">{segment.text}</p>
              </article>
            );
          })}
          {partialText && (
            <p
              aria-label={t("jarvis.partialTranscript")}
              className="pointer-events-none select-none rounded-xl px-3 py-3 text-sm leading-6 text-foreground opacity-50"
            >
              {partialText}
            </p>
          )}
          <div ref={tailRef} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
