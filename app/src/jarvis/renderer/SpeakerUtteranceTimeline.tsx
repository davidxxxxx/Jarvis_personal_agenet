import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Pause, Play, UsersRound } from "lucide-react";
import type { JarvisAudioChunk, JarvisSpeakerUtterance } from "../types";
import { normalizeWavForPlayback } from "./playbackLoudness";
import { groupSpeakerUtterances } from "./speakerUtteranceGrouping";

interface SpeakerUtteranceTimelineProps {
  utterances: JarvisSpeakerUtterance[];
  chunks: JarvisAudioChunk[];
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  readIsolatedAudio?: (utteranceId: string) => Promise<Uint8Array | null>;
  onOpenSpeakerReview?: (clusterId: string) => void;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function sourceLabel(utterance: JarvisSpeakerUtterance): string {
  if (utterance.track_kind === "mic") return "实体麦克风";
  if (utterance.track_kind === "application") {
    return utterance.application_display_name || utterance.application_key || "应用音频";
  }
  return "系统音频 · 应用未知";
}

function displayName(utterance: JarvisSpeakerUtterance): string {
  return utterance.person_display_name || utterance.local_label || "说话人未知";
}

export default function SpeakerUtteranceTimeline({
  utterances,
  chunks,
  readChunk,
  readIsolatedAudio,
  onOpenSpeakerReview,
}: SpeakerUtteranceTimelineProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const chunkById = useMemo(() => new Map(chunks.map((chunk) => [chunk.id, chunk])), [chunks]);
  const groups = useMemo(() => groupSpeakerUtterances(utterances), [utterances]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setActiveId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback(
    async (utterance: JarvisSpeakerUtterance) => {
      if (activeId === utterance.id) {
        stop();
        return;
      }
      stop();
      const generation = generationRef.current;
      const chunk = chunkById.get(utterance.chunk_id);
      let bytes: Uint8Array | null = null;
      let isolated = false;
      try {
        if (utterance.has_isolated_audio && readIsolatedAudio) {
          bytes = await readIsolatedAudio(utterance.id);
          isolated = Boolean(bytes);
        }
        if (!bytes && chunk) bytes = await readChunk(chunk.id);
      } catch {
        bytes = null;
      }
      if (generation !== generationRef.current) return;
      if (!bytes || !chunk) {
        setWarning("这句话对应的音频已过期或暂时不可用。");
        return;
      }
      const normalized = normalizeWavForPlayback(bytes, chunk.source_type);
      const copy = new Uint8Array(normalized.bytes.byteLength);
      copy.set(normalized.bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: "audio/wav" }));
      const audio = new Audio(url);
      const startedAtSeconds = isolated
        ? 0
        : Math.max(0, (utterance.started_at - chunk.started_at) / 1_000);
      const durationSeconds = Math.max(0.05, (utterance.ended_at - utterance.started_at) / 1_000);
      audio.currentTime = startedAtSeconds;
      audioRef.current = audio;
      urlRef.current = url;
      setWarning(null);
      setActiveId(utterance.id);
      const finish = () => {
        if (generation !== generationRef.current) return;
        stop();
      };
      audio.ontimeupdate = () => {
        if (audio.currentTime >= startedAtSeconds + durationSeconds - 0.02) finish();
      };
      audio.onended = finish;
      try {
        await audio.play();
        timerRef.current = window.setTimeout(finish, Math.ceil(durationSeconds * 1_000) + 150);
      } catch {
        stop();
        setWarning("无法播放这段音频。");
      }
    },
    [activeId, chunkById, readChunk, readIsolatedAudio, stop]
  );

  if (utterances.length === 0) return null;

  return (
    <section aria-labelledby="speaker-utterance-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="speaker-utterance-heading" className="font-semibold">
            按人拆分的逐句话语
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            同一时间多人说话会并排显示；分离声道可单独试听。
          </p>
        </div>
        {onOpenSpeakerReview && (
          <button
            type="button"
            onClick={() => onOpenSpeakerReview(utterances[0].cluster_id)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            拆分、合并、命名与撤销
          </button>
        )}
      </div>
      {warning && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          {warning}
        </p>
      )}
      <div className="space-y-2">
        {groups.map((group) => (
          <article
            key={group.id}
            className={`rounded-xl border p-3 ${
              group.overlapping
                ? "border-violet-500/35 bg-violet-500/5"
                : "border-border/50 bg-card"
            }`}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <time>
                {timeLabel(group.startedAt)} – {timeLabel(group.endedAt)}
              </time>
              {group.overlapping && (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 font-medium text-violet-700 dark:text-violet-200">
                  <UsersRound className="size-3" aria-hidden="true" />
                  重叠说话 · {new Set(group.utterances.map((item) => item.cluster_id)).size} 人
                </span>
              )}
            </div>
            <div className={`grid gap-2 ${group.overlapping ? "md:grid-cols-2" : ""}`}>
              {group.utterances.map((utterance) => {
                const active = activeId === utterance.id;
                return (
                  <div
                    key={utterance.id}
                    className="rounded-lg border border-border/50 bg-background/75 p-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <button
                        type="button"
                        onClick={() => void play(utterance)}
                        aria-label={`${active ? "停止" : "播放"} ${displayName(utterance)} 的话语`}
                        className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground"
                      >
                        {active ? (
                          <Pause className="size-3.5 fill-current" aria-hidden="true" />
                        ) : (
                          <Play className="ml-0.5 size-3.5 fill-current" aria-hidden="true" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="font-semibold text-foreground">
                            {displayName(utterance)}
                          </span>
                          <span className="text-muted-foreground">{sourceLabel(utterance)}</span>
                          {utterance.has_isolated_audio && (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                              <AudioLines className="size-3" aria-hidden="true" />
                              已分离声道
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 select-text text-sm leading-6 text-foreground/90">
                          {utterance.text}
                        </p>
                        {onOpenSpeakerReview && (
                          <button
                            type="button"
                            onClick={() => onOpenSpeakerReview(utterance.cluster_id)}
                            className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            复核这个人
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
