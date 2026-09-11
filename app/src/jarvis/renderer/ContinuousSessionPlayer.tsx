import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Mic2, MonitorSpeaker, Pause, Play, Radio } from "lucide-react";
import type {
  JarvisAudioChunk,
  JarvisContinuousSeekRequest,
  JarvisContinuousSeekResult,
  JarvisSessionTimeline,
  JarvisSpeakerUtterance,
  JarvisSpeakerClusterView,
  JarvisTranscriptSegment,
} from "../types";
import SpeakerChip from "./SpeakerChip";
import { useJarvisStore } from "./jarvisStore";
import { normalizeWavForPlayback } from "./playbackLoudness";
import TranscriptTodoButton from "./TranscriptTodoButton";
import SpeakerUtteranceTimeline from "./SpeakerUtteranceTimeline";

type PlaybackMode = "mix" | "mic" | "system";

interface ContinuousSessionPlayerProps {
  timeline: JarvisSessionTimeline;
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  seekRequest?: JarvisContinuousSeekRequest | null;
  onSeekResult?: (requestId: number, result: JarvisContinuousSeekResult) => void;
  focusSegmentId?: string | null;
  focusRequestId?: number | null;
  onTrackPageChange?: (offset: number) => void;
  speakerUtterances?: JarvisSpeakerUtterance[];
  readSpeakerUtteranceAudio?: (utteranceId: string) => Promise<Uint8Array | null>;
  onOpenSpeakerReview?: (clusterId: string) => void;
}

interface SegmentBoundary {
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
}

const EMPTY_CLUSTERS: JarvisSpeakerClusterView[] = [];

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

function overlapMs(left: JarvisAudioChunk, right: JarvisAudioChunk): number {
  return Math.max(
    0,
    Math.min(left.ended_at, right.ended_at) - Math.max(left.started_at, right.started_at)
  );
}

export function preferredSystemChunks(
  chunks: JarvisAudioChunk[],
  timeline: JarvisSessionTimeline
): JarvisAudioChunk[] {
  const trackById = new Map(timeline.tracks.map((track) => [track.id, track]));
  const applicationChunks = chunks.filter(
    (chunk) =>
      trackById.get(chunk.track_id ?? "")?.track_kind === "application" &&
      trackById.get(chunk.track_id ?? "")?.attribution_state === "exact"
  );
  return chunks.filter((chunk) => {
    if (chunk.source_type !== "system") return false;
    if (trackById.get(chunk.track_id ?? "")?.track_kind !== "system_mix") return true;
    const duration = Math.max(1, chunk.ended_at - chunk.started_at);
    const covered = applicationChunks
      .filter((candidate) => overlapMs(chunk, candidate) > 0)
      .map(
        (candidate) =>
          [
            Math.max(chunk.started_at, candidate.started_at),
            Math.min(chunk.ended_at, candidate.ended_at),
          ] as const
      )
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
      .reduce(
        (state, range) => {
          const last = state.ranges[state.ranges.length - 1];
          if (!last || range[0] > last[1]) {
            state.ranges.push([range[0], range[1]]);
          } else {
            last[1] = Math.max(last[1], range[1]);
          }
          return state;
        },
        { ranges: [] as Array<[number, number]> }
      )
      .ranges.reduce((total, range) => total + range[1] - range[0], 0);
    return covered / duration < 0.8;
  });
}

function laneLabel(source: "mic" | "system"): string {
  return source === "mic" ? "麦克风" : "系统音频·安全兜底";
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function segmentDuration(segment: JarvisTranscriptSegment): string {
  const seconds = Math.max(0, segment.ended_at - segment.started_at) / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}

export default function ContinuousSessionPlayer({
  timeline,
  readChunk,
  seekRequest = null,
  onSeekResult,
  focusSegmentId = null,
  focusRequestId = null,
  onTrackPageChange,
  speakerUtterances = [],
  readSpeakerUtteranceAudio,
  onOpenSpeakerReview,
}: ContinuousSessionPlayerProps) {
  const [mode, setMode] = useState<PlaybackMode>("mix");
  const [playing, setPlaying] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [segmentProgress, setSegmentProgress] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const [visibleSegmentLimit, setVisibleSegmentLimit] = useState(200);
  const clusters = useJarvisStore(
    (state) => state.clustersBySession[timeline.session_id] ?? EMPTY_CLUSTERS
  );
  const loadSessionClusters = useJarvisStore((state) => state.loadSessionClusters);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const consumedSeekRequestRef = useRef<number | null>(null);
  const onSeekResultRef = useRef(onSeekResult);
  const focusedSegmentRef = useRef<HTMLElement | null>(null);
  const focusedRequestRef = useRef<number | null>(null);

  useEffect(() => {
    onSeekResultRef.current = onSeekResult;
  }, [onSeekResult]);

  useEffect(() => {
    if (typeof window.electronAPI?.jarvis?.listSessionSpeakerClusters !== "function") return;
    void loadSessionClusters(timeline.session_id).catch(() => undefined);
  }, [loadSessionClusters, timeline.session_id]);

  useEffect(() => {
    if (
      !focusSegmentId ||
      focusRequestId === null ||
      focusedRequestRef.current === focusRequestId
    ) {
      return;
    }
    const element = focusedSegmentRef.current;
    if (!element) return;
    focusedRequestRef.current = focusRequestId;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.focus({ preventScroll: true });
  }, [focusRequestId, focusSegmentId, timeline.segments, visibleSegmentLimit]);

  const releaseAudio = useCallback(() => {
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.ontimeupdate = null;
      audioRef.current.onended = null;
      audioRef.current.pause();
    }
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    releaseAudio();
    setPlaying(false);
    setActiveSegmentId(null);
    setSegmentProgress(0);
  }, [releaseAudio]);

  useEffect(() => {
    stop();
    setWarning(null);
    setVisibleSegmentLimit(200);
  }, [mode, stop, timeline.session_id]);

  useEffect(() => {
    if (!focusSegmentId) return;
    const index = timeline.segments.findIndex((segment) => segment.id === focusSegmentId);
    if (index >= visibleSegmentLimit) {
      setVisibleSegmentLimit(Math.ceil((index + 1) / 200) * 200);
    }
  }, [focusSegmentId, timeline.segments, visibleSegmentLimit]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      releaseAudio();
    },
    [releaseAudio]
  );

  const allPlayable = useMemo(() => orderedChunks(timeline.chunks), [timeline.chunks]);
  const systemPlayable = useMemo(
    () => preferredSystemChunks(allPlayable, timeline),
    [allPlayable, timeline]
  );
  const playableChunkIds = useMemo(
    () => new Set(allPlayable.map((chunk) => chunk.id)),
    [allPlayable]
  );
  const chunksById = useMemo(
    () => new Map(allPlayable.map((chunk) => [chunk.id, chunk])),
    [allPlayable]
  );
  const queue = useMemo(() => {
    if (mode === "mic") {
      return allPlayable.filter((chunk) => chunk.source_type === "mic");
    }
    if (mode === "system") return systemPlayable;
    return orderedChunks([
      ...allPlayable.filter((chunk) => chunk.source_type === "mic"),
      ...systemPlayable,
    ]);
  }, [allPlayable, mode, systemPlayable]);
  const intervalFailures = useMemo(() => {
    const seen = new Set<string>();
    return timeline.application_audio_intervals.filter((interval) => {
      if (!interval.failure_code) return false;
      const key = `${interval.application_key ?? "unknown"}\u0000${interval.failure_code}\u0000${interval.reason ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [timeline.application_audio_intervals]);

  const playAt = useCallback(
    async (
      playbackQueue: JarvisAudioChunk[],
      initialIndex: number,
      initialSeekSeconds: number,
      generation: number,
      controlledRequestId: number | null = null,
      boundary: SegmentBoundary | null = null
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
            setActiveSegmentId(null);
            onSeekResultRef.current?.(controlledRequestId, "audio_unavailable");
            return;
          }
          if (boundary) {
            setWarning("这条转写对应的音频已过期或暂时无法播放。");
            setPlaying(false);
            setActiveSegmentId(null);
            setSegmentProgress(0);
            return;
          }
          skipped += 1;
          setWarning(`已跳过 ${skipped} 段不可用音频。时间线中的缺口仍会保留。`);
          continue;
        }
        const normalized = normalizeWavForPlayback(bytes, chunk.source_type);
        const copy = new Uint8Array(normalized.bytes.byteLength);
        copy.set(normalized.bytes);
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

        const finishSegment = () => {
          if (generation !== generationRef.current) return;
          generationRef.current += 1;
          releaseAudio();
          setPlaying(false);
          setActiveSegmentId(null);
          setSegmentProgress(0);
        };

        if (boundary) {
          const playbackDuration = Math.max(0.05, boundary.endSeconds - boundary.startSeconds);
          audio.ontimeupdate = () => {
            if (generation !== generationRef.current) return;
            const elapsed = Math.max(0, audio.currentTime - boundary.startSeconds);
            setSegmentProgress(Math.min(100, (elapsed / playbackDuration) * 100));
            if (audio.currentTime >= boundary.endSeconds - 0.02) finishSegment();
          };
          audio.onended = finishSegment;
        } else {
          audio.onended = () => {
            if (generation !== generationRef.current) return;
            releaseAudio();
            void playAt(playbackQueue, index + 1, 0, generation);
          };
        }
        try {
          await audio.play();
          if (generation !== generationRef.current) return;
          if (boundary) {
            segmentTimerRef.current = window.setTimeout(
              finishSegment,
              Math.ceil((boundary.endSeconds - boundary.startSeconds) * 1_000) + 120
            );
          }
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
          if (boundary) {
            setWarning("无法开始播放这条转写，请稍后重试。");
            setPlaying(false);
            setActiveSegmentId(null);
            setSegmentProgress(0);
            return;
          }
          skipped += 1;
          setWarning(`已跳过 ${skipped} 段不可用音频。时间线中的缺口仍会保留。`);
        }
      }
      if (generation === generationRef.current) {
        setPlaying(false);
        setActiveSegmentId(null);
      }
    },
    [readChunk, releaseAudio]
  );

  const start = useCallback(
    (
      playbackQueue: JarvisAudioChunk[],
      index = 0,
      seekSeconds = 0,
      boundary: SegmentBoundary | null = null
    ) => {
      stop();
      setWarning(null);
      if (playbackQueue.length === 0 || !playbackQueue[index]) {
        setWarning("当前模式没有可播放的音频。");
        return;
      }
      const generation = ++generationRef.current;
      setPlaying(true);
      setActiveSegmentId(boundary?.segmentId ?? null);
      setSegmentProgress(0);
      void playAt(playbackQueue, index, seekSeconds, generation, null, boundary);
    },
    [playAt, stop]
  );

  const playSegment = useCallback(
    (segment: JarvisTranscriptSegment) => {
      if (activeSegmentId === segment.id && playing) {
        stop();
        return;
      }
      const chunk = segment.chunk_id ? chunksById.get(segment.chunk_id) : undefined;
      if (!chunk) {
        setWarning("这条转写对应的音频已过期或暂时无法播放。");
        return;
      }
      const startSeconds = Math.max(0, segment.started_at - chunk.started_at) / 1_000;
      const chunkDurationSeconds = Math.max(0, chunk.ended_at - chunk.started_at) / 1_000;
      const endSeconds = Math.min(
        chunkDurationSeconds,
        Math.max(startSeconds + 0.05, (segment.ended_at - chunk.started_at) / 1_000)
      );
      start([chunk], 0, startSeconds, {
        segmentId: segment.id,
        startSeconds,
        endSeconds,
      });
    },
    [activeSegmentId, chunksById, playing, start, stop]
  );

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
      setActiveSegmentId(null);
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
      <div className="sticky top-0 z-20 rounded-xl border border-border/70 bg-card/95 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-label="连续播放音轨">
            {(["mix", "mic", "system"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  mode === value
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {value === "mix" ? "全部声音" : laneLabel(value)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => (playing ? stop() : start(queue))}
            disabled={!allPlayable.length}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4 fill-current" />}
            {playing ? "停止播放" : "连续播放"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          点击任意一条转写，从该句起点播放，并在该句结束时间自动停止。播放时会自动统一响度，
          原始录音不会被修改。
        </p>
      </div>

      {!allPlayable.length && (
        <div
          role="status"
          className="flex gap-3 rounded-xl border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>本次录音的音频已按保留策略删除；转写和总结仍可永久查看。</p>
        </div>
      )}
      {warning && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {warning}
        </p>
      )}

      <details className="rounded-xl border border-border/50 bg-muted/10">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          音轨状态与录音缺口
        </summary>
        <div className="grid gap-3 border-t border-border/50 p-3 md:grid-cols-2">
          {timeline.tracks.map((track) => (
            <section
              key={track.id}
              data-testid={`source-lane-${track.source_type}`}
              className="rounded-lg border border-border/60 bg-card p-3"
            >
              <h3 className="flex items-center gap-2 text-sm font-medium">
                {track.source_type === "mic" ? (
                  <Mic2 className="size-4" aria-hidden="true" />
                ) : (
                  <MonitorSpeaker className="size-4" aria-hidden="true" />
                )}
                {track.application_display_name || laneLabel(track.source_type)}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">{track.state}</p>
              {track.failure_code && (
                <p className="mt-1 break-all text-xs text-amber-700">
                  原始失败码：{track.failure_code}
                </p>
              )}
              <div className="mt-2 space-y-1">
                {track.gaps.map((gap) => {
                  const missingSeconds =
                    Math.max(0, (gap.ended_at ?? Date.now()) - gap.started_at) / 1_000;
                  return (
                    <p
                      key={gap.id}
                      className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800"
                    >
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
        {intervalFailures.length > 0 && (
          <section
            data-testid="application-capture-failures"
            className="border-t border-border/50 p-3"
          >
            <h3 className="text-sm font-medium">应用采集降级记录</h3>
            <div className="mt-2 space-y-2">
              {intervalFailures.map((interval) => (
                <p
                  key={`${interval.id}:${interval.failure_code}`}
                  className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  系统音频·应用未知 · 原始失败码：
                  <span className="break-all font-mono">{interval.failure_code}</span>
                  {interval.reason ? ` · ${interval.reason}` : ""}
                </p>
              ))}
            </div>
          </section>
        )}
        {timeline.evidence_page &&
          timeline.evidence_page.tracks.total > timeline.evidence_page.tracks.limit && (
            <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <span>
                音轨 {timeline.evidence_page.tracks.offset + 1}–
                {Math.min(
                  timeline.evidence_page.tracks.total,
                  timeline.evidence_page.tracks.offset + timeline.tracks.length
                )}
                ，共 {timeline.evidence_page.tracks.total}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={timeline.evidence_page.tracks.offset === 0}
                  onClick={() =>
                    onTrackPageChange?.(
                      Math.max(
                        0,
                        timeline.evidence_page!.tracks.offset - timeline.evidence_page!.tracks.limit
                      )
                    )
                  }
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={
                    timeline.evidence_page.tracks.offset + timeline.evidence_page.tracks.limit >=
                    timeline.evidence_page.tracks.total
                  }
                  onClick={() =>
                    onTrackPageChange?.(
                      timeline.evidence_page!.tracks.offset + timeline.evidence_page!.tracks.limit
                    )
                  }
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            </div>
          )}
      </details>

      <SpeakerUtteranceTimeline
        utterances={speakerUtterances}
        chunks={timeline.chunks}
        readChunk={readChunk}
        readIsolatedAudio={readSpeakerUtteranceAudio}
        onOpenSpeakerReview={onOpenSpeakerReview}
      />

      <section aria-labelledby="session-transcript-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 id="session-transcript-heading" className="font-semibold">
              完整转写
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {timeline.segments.length} 条 · 每条都可单独播放或停止
            </p>
          </div>
          {playing && activeSegmentId && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
              <Radio className="size-3.5 animate-pulse" aria-hidden="true" />
              正在播放选中内容
            </span>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {timeline.segments.length ? (
            timeline.segments.slice(0, visibleSegmentLimit).map((segment) => {
              const isActive = activeSegmentId === segment.id && playing;
              const isFocused = segment.id === focusSegmentId;
              const hasAudio = Boolean(segment.chunk_id && playableChunkIds.has(segment.chunk_id));
              const cluster =
                clusters.find((candidate) => candidate.evidenceSegmentIds.includes(segment.id)) ??
                null;
              const source =
                segment.source_type ??
                (segment.chunk_id ? chunksById.get(segment.chunk_id)?.source_type : undefined);
              return (
                <article
                  key={segment.id}
                  ref={isFocused ? focusedSegmentRef : undefined}
                  tabIndex={isFocused ? -1 : undefined}
                  data-testid={`transcript-segment-${segment.id}`}
                  data-evidence-focus={isFocused ? "true" : undefined}
                  className={`group relative overflow-hidden rounded-xl border outline-none transition-all ${
                    isActive
                      ? "border-primary/50 bg-primary/10 shadow-sm ring-1 ring-primary/20"
                      : isFocused
                        ? "border-primary/50 bg-primary/5 ring-2 ring-primary/50"
                        : "border-border/50 bg-card hover:border-primary/30 hover:bg-muted/20"
                  }`}
                >
                  <div className="flex items-start gap-3 p-3">
                    <button
                      type="button"
                      onClick={() => playSegment(segment)}
                      disabled={!hasAudio}
                      aria-label={isActive ? "停止该条录音" : "播放该条录音"}
                      className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-full ${
                        hasAudio
                          ? isActive
                            ? "bg-primary text-primary-foreground"
                            : "bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground"
                          : "bg-muted text-muted-foreground/60"
                      } disabled:cursor-not-allowed`}
                    >
                      {isActive ? (
                        <Pause className="size-4 fill-current" aria-hidden="true" />
                      ) : (
                        <Play className="ml-0.5 size-4 fill-current" aria-hidden="true" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <SpeakerChip cluster={cluster} localLabel={segment.speaker_label} />
                        <time className="text-xs font-medium tabular-nums text-muted-foreground">
                          {timeLabel(segment.started_at)} – {timeLabel(segment.ended_at)}
                        </time>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {segmentDuration(segment)}
                        </span>
                        {source && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            {source === "mic" ? (
                              <Mic2 className="size-3" aria-hidden="true" />
                            ) : (
                              <MonitorSpeaker className="size-3" aria-hidden="true" />
                            )}
                            {segment.application_display_name || laneLabel(source)}
                          </span>
                        )}
                        {!hasAudio && (
                          <span className="text-[11px] text-amber-700">音频已过期</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => playSegment(segment)}
                        disabled={!hasAudio}
                        aria-label={
                          isActive
                            ? `停止这条转写：${segment.text}`
                            : `播放这条转写：${segment.text}`
                        }
                        className="mt-2 block w-full text-left text-sm leading-6 text-foreground/90 disabled:cursor-not-allowed"
                      >
                        {segment.text}
                      </button>
                      <div className="mt-2 flex justify-end">
                        <TranscriptTodoButton sessionId={timeline.session_id} segment={segment} />
                      </div>
                    </div>
                  </div>
                  {isActive && (
                    <span
                      className="absolute inset-x-0 bottom-0 h-1 bg-primary/15"
                      aria-hidden="true"
                    >
                      <span
                        className="block h-full bg-primary transition-[width] duration-100"
                        style={{ width: `${segmentProgress}%` }}
                      />
                    </span>
                  )}
                </article>
              );
            })
          ) : (
            <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
              没有可用转写。
            </p>
          )}
        </div>
        {visibleSegmentLimit < timeline.segments.length && (
          <button
            type="button"
            onClick={() => setVisibleSegmentLimit((current) => current + 200)}
            className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50"
          >
            再显示 {Math.min(200, timeline.segments.length - visibleSegmentLimit)} 条转写
          </button>
        )}
      </section>
    </div>
  );
}
