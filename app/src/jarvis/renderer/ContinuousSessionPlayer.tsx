import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  JarvisAudioChunk,
  JarvisContinuousSeekRequest,
  JarvisContinuousSeekResult,
  JarvisSessionTimeline,
} from "../types";

type PlaybackMode = "mix" | "mic" | "system";

interface ContinuousSessionPlayerProps {
  timeline: JarvisSessionTimeline;
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  seekRequest?: JarvisContinuousSeekRequest | null;
  onSeekResult?: (requestId: number, result: JarvisContinuousSeekResult) => void;
}

function orderedChunks(chunks: JarvisAudioChunk[]): JarvisAudioChunk[] {
  return chunks
    .filter((chunk) => chunk.write_state === "committed" && chunk.deleted_at === null)
    .sort(
      (left, right) =>
        left.started_at - right.started_at ||
        (left.sequence_number ?? 0) - (right.sequence_number ?? 0) ||
        left.id.localeCompare(right.id)
    );
}

function laneLabel(source: "mic" | "system"): string {
  return source === "mic" ? "麦克风" : "电脑声音";
}

export default function ContinuousSessionPlayer({
  timeline,
  readChunk,
  seekRequest = null,
  onSeekResult,
}: ContinuousSessionPlayerProps) {
  const [mode, setMode] = useState<PlaybackMode>("mix");
  const [playing, setPlaying] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const consumedSeekRequestRef = useRef<number | null>(null);
  const onSeekResultRef = useRef(onSeekResult);

  useEffect(() => {
    onSeekResultRef.current = onSeekResult;
  }, [onSeekResult]);

  const releaseAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    releaseAudio();
    setPlaying(false);
  }, [releaseAudio]);

  useEffect(() => {
    stop();
    setWarning(null);
  }, [mode, stop, timeline.session_id]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      releaseAudio();
    },
    [releaseAudio]
  );

  const allPlayable = useMemo(() => orderedChunks(timeline.chunks), [timeline.chunks]);
  const queue = useMemo(
    () =>
      mode === "mix" ? allPlayable : allPlayable.filter((chunk) => chunk.source_type === mode),
    [allPlayable, mode]
  );

  const playAt = useCallback(
    async (
      playbackQueue: JarvisAudioChunk[],
      initialIndex: number,
      initialSeekSeconds: number,
      generation: number,
      controlledRequestId: number | null = null
    ) => {
      let skipped = 0;
      for (let index = initialIndex; index < playbackQueue.length; index += 1) {
        if (generation !== generationRef.current) return;
        const chunk = playbackQueue[index];
        let bytes: Uint8Array | null = null;
        try {
          bytes = await readChunk(chunk.id);
        } catch {
          bytes = null;
        }
        if (generation !== generationRef.current) return;
        if (!bytes) {
          if (controlledRequestId !== null && index === initialIndex) {
            setWarning("证据音频已不可用，已保留并定位转写内容。");
            setPlaying(false);
            onSeekResultRef.current?.(controlledRequestId, "audio_unavailable");
            return;
          }
          skipped += 1;
          setWarning(`已跳过 ${skipped} 段不可用音频。时间线中的缺口仍会保留。`);
          continue;
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const url = URL.createObjectURL(new Blob([copy], { type: "audio/wav" }));
        if (generation !== generationRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        releaseAudio();
        const audio = new Audio(url);
        audioRef.current = audio;
        urlRef.current = url;
        audio.currentTime = index === initialIndex ? initialSeekSeconds : 0;
        audio.onended = () => {
          if (generation !== generationRef.current) return;
          releaseAudio();
          void playAt(playbackQueue, index + 1, 0, generation);
        };
        try {
          await audio.play();
          if (generation !== generationRef.current) return;
          if (controlledRequestId !== null && index === initialIndex) {
            onSeekResultRef.current?.(controlledRequestId, "playing");
          }
          return;
        } catch {
          if (generation !== generationRef.current) return;
          releaseAudio();
          if (controlledRequestId !== null && index === initialIndex) {
            setWarning("证据音频已不可用，已保留并定位转写内容。");
            setPlaying(false);
            onSeekResultRef.current?.(controlledRequestId, "audio_unavailable");
            return;
          }
          skipped += 1;
          setWarning(`已跳过 ${skipped} 段不可用音频。时间线中的缺口仍会保留。`);
        }
      }
      if (generation === generationRef.current) setPlaying(false);
    },
    [readChunk, releaseAudio]
  );

  const start = useCallback(
    (playbackQueue: JarvisAudioChunk[], index = 0, seekSeconds = 0) => {
      stop();
      setWarning(null);
      if (playbackQueue.length === 0 || !playbackQueue[index]) {
        setWarning("当前模式没有可播放的音频。");
        return;
      }
      const generation = ++generationRef.current;
      setPlaying(true);
      void playAt(playbackQueue, index, seekSeconds, generation);
    },
    [playAt, stop]
  );

  const playSegment = (chunkId: string | null | undefined, startedAt: number) => {
    const chunk = allPlayable.find((candidate) => candidate.id === chunkId);
    if (!chunk) {
      setWarning("这句话对应的音频已过期或暂时无法播放。");
      return;
    }
    start([chunk], 0, Math.max(0, startedAt - chunk.started_at) / 1_000);
  };

  const startControlledSeek = useCallback(
    (request: JarvisContinuousSeekRequest) => {
      stop();
      setWarning(null);
      const lane = request.trackId
        ? allPlayable.filter((chunk) => chunk.track_id === request.trackId)
        : request.sourceType
          ? allPlayable.filter((chunk) => chunk.source_type === request.sourceType)
          : allPlayable;
      const targetIndex = lane.findIndex(
        (chunk) => chunk.started_at <= request.startedAt && request.startedAt < chunk.ended_at
      );
      if (targetIndex < 0) {
        setWarning("无法定位证据对应的音频分片，已保留转写内容。");
        onSeekResultRef.current?.(request.requestId, "seek_target_missing");
        return;
      }
      const generation = ++generationRef.current;
      setPlaying(true);
      void playAt(
        lane,
        targetIndex,
        Math.max(0, request.startedAt - lane[targetIndex].started_at) / 1_000,
        generation,
        request.requestId
      );
    },
    [allPlayable, playAt, stop]
  );

  useEffect(() => {
    if (!seekRequest || consumedSeekRequestRef.current === seekRequest.requestId) return;
    consumedSeekRequestRef.current = seekRequest.requestId;
    startControlledSeek(seekRequest);
  }, [seekRequest, startControlledSeek]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["mix", "mic", "system"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            {value === "mix" ? "混合" : laneLabel(value)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => (playing ? stop() : start(queue))}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground"
        >
          {playing ? "停止播放" : "连续播放"}
        </button>
      </div>
      {warning && (
        <p role="alert" className="text-sm text-amber-700">
          {warning}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {timeline.tracks.map((track) => (
          <section
            key={track.id}
            data-testid={`source-lane-${track.source_type}`}
            className="rounded-lg border border-border/60 p-3"
          >
            <h3 className="text-sm font-medium">{laneLabel(track.source_type)}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{track.state}</p>
            <div className="mt-2 space-y-1">
              {track.gaps.map((gap) => {
                const missingSeconds =
                  Math.max(0, (gap.ended_at ?? Date.now()) - gap.started_at) / 1_000;
                return (
                  <p key={gap.id} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    缺失 {missingSeconds.toFixed(1)} 秒 · {gap.reason}
                  </p>
                );
              })}
              {track.gaps.length === 0 && (
                <p className="text-xs text-muted-foreground">没有已记录缺口</p>
              )}
            </div>
          </section>
        ))}
      </div>
      <section>
        <h3 className="font-medium">完整转写</h3>
        <div className="mt-2 space-y-2">
          {timeline.segments.length ? (
            timeline.segments.map((segment) => (
              <button
                key={segment.id}
                type="button"
                onClick={() => playSegment(segment.chunk_id, segment.started_at)}
                className="block w-full rounded-lg bg-muted/30 p-3 text-left"
              >
                <span className="block text-xs font-medium text-primary">
                  {segment.speaker_label} ·{" "}
                  {new Date(segment.started_at).toLocaleTimeString("zh-CN")}
                </span>
                <span className="mt-1 block text-sm leading-6">{segment.text}</span>
              </button>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">没有可用转写。</p>
          )}
        </div>
      </section>
    </div>
  );
}
