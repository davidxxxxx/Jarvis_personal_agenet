import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";
import SpeakerChip from "./SpeakerChip";

interface LiveTranscriptProps {
  segments: TranscriptSegment[];
  partialText: string;
}

function segmentTime(segment: TranscriptSegment): number {
  return Number.isFinite(segment.timestamp) ? (segment.timestamp as number) : 0;
}

export default function LiveTranscript({ segments, partialText }: LiveTranscriptProps) {
  const { t } = useTranslation();
  const tailRef = useRef<HTMLDivElement>(null);
  const orderedSegments = useMemo(
    () =>
      [...segments].sort(
        (left, right) => segmentTime(left) - segmentTime(right) || left.id.localeCompare(right.id)
      ),
    [segments]
  );

  useEffect(() => {
    const tail = tailRef.current;
    if (tail && typeof tail.scrollIntoView === "function") {
      tail.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [orderedSegments.length, partialText]);

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
            return (
              <article
                key={segment.id}
                data-testid="stable-transcript-row"
                className="rounded-xl px-3 py-3 transition-colors hover:bg-muted/30"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  {segment.speaker && (
                    <SpeakerChip
                      personId={segment.speaker}
                      displayName={segment.speakerName || segment.speaker}
                      confidence={segment.confidence}
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
