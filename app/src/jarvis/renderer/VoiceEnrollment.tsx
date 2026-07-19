import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic2, Save, Square, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { getSettings } from "../../stores/settingsStore";
import type {
  JarvisVoiceEnrollmentPayload,
  JarvisVoiceEnrollmentOutcome,
  JarvisVoiceEnrollmentSession,
  JarvisVoiceEnrollmentStatus,
} from "../types";

const RECORDING_SECONDS = 32;
const WINDOW_SECONDS = 10;
const WORKLET_CHUNK_SIZE = 2_400;
const MIN_READY_SECONDS = 30;
const MAX_CAPTURE_SECONDS = 34;

type EnrollmentState =
  "idle" | "setup" | "recording" | "stopping" | "ready" | "saving" | "saved" | "error";

function createEnrollmentWorkletUrl(): string {
  const code = `
const CHUNK_SIZE = ${WORKLET_CHUNK_SIZE};
class JarvisEnrollmentProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SIZE);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data !== "stop") return;
      if (this.offset > 0) {
        const partial = this.buffer.slice(0, this.offset);
        this.port.postMessage(partial.buffer, [partial.buffer]);
      }
      this.stopped = true;
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i += 1) {
      this.buffer[this.offset++] = input[i];
      if (this.offset === CHUNK_SIZE) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(CHUNK_SIZE);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("jarvis-enrollment-processor", JarvisEnrollmentProcessor);
`;
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

function formatCountdown(seconds: number): string {
  return `00:${Math.max(0, seconds).toString().padStart(2, "0")}`;
}

export default function VoiceEnrollment() {
  const { t } = useTranslation();
  const [state, setState] = useState<EnrollmentState>("idle");
  const [secondsLeft, setSecondsLeft] = useState(RECORDING_SECONDS);
  const [level, setLevel] = useState(0);
  const [profileStatus, setProfileStatus] = useState<JarvisVoiceEnrollmentStatus | null>(null);
  const [errorOutcome, setErrorOutcome] = useState<Exclude<
    JarvisVoiceEnrollmentOutcome,
    "accepted"
  > | null>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const chunksRef = useRef<Float32Array[]>([]);
  const sessionRef = useRef<JarvisVoiceEnrollmentSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const deadlineRef = useRef(0);
  const capturedSampleCountRef = useRef(0);
  const microphoneSourceRef = useRef<JarvisVoiceEnrollmentPayload["source"] | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const refreshProfileStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.jarvis.getVoiceEnrollmentStatus();
      if (mountedRef.current) setProfileStatus(status);
    } catch {
      if (mountedRef.current) setProfileStatus(null);
    }
  }, []);

  const dropChunks = useCallback(() => {
    for (const chunk of chunksRef.current) chunk.fill(0);
    chunksRef.current = [];
    capturedSampleCountRef.current = 0;
    microphoneSourceRef.current = null;
  }, []);

  const cancelPendingSession = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    try {
      await window.electronAPI.jarvis.cancelVoiceEnrollment(session.sessionId);
    } catch {
      // The main process may already have consumed or expired this one-time session.
    }
  }, []);

  const cleanupCapture = useCallback(
    async ({ cancelSession, flush }: { cancelSession: boolean; flush: boolean }) => {
      clearTimer();
      const processor = processorRef.current;
      const source = sourceRef.current;
      const stream = streamRef.current;
      const context = contextRef.current;
      processorRef.current = null;
      sourceRef.current = null;
      streamRef.current = null;
      contextRef.current = null;

      if (flush && processor) {
        try {
          processor.port.postMessage("stop");
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        } catch {}
      }
      if (processor) {
        processor.port.onmessage = null;
        try {
          processor.disconnect();
        } catch {}
      }
      if (source) {
        try {
          source.disconnect();
        } catch {}
      }
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") {
        try {
          await context.close();
        } catch {}
      }
      if (workletUrlRef.current) {
        URL.revokeObjectURL(workletUrlRef.current);
        workletUrlRef.current = null;
      }
      setLevelIfMounted(0);
      if (cancelSession) await cancelPendingSession();
    },
    [cancelPendingSession, clearTimer]
  );

  const setLevelIfMounted = (nextLevel: number) => {
    if (mountedRef.current) setLevel(nextLevel);
  };

  const stopForReview = useCallback(async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    if (mountedRef.current) setState("stopping");
    await cleanupCapture({ cancelSession: false, flush: true });
    const totalSamples = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
    const sampleRate = sessionRef.current?.sampleRate ?? 24_000;
    if (totalSamples < sampleRate * MIN_READY_SECONDS) {
      dropChunks();
      await cancelPendingSession();
      if (mountedRef.current) setState("error");
    } else if (mountedRef.current) {
      setState("ready");
    }
    operationRef.current = false;
  }, [cancelPendingSession, cleanupCapture, dropChunks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      void cleanupCapture({ cancelSession: true, flush: false });
      dropChunks();
    };
  }, [cleanupCapture, clearTimer, dropChunks]);

  useEffect(() => {
    void refreshProfileStatus();
  }, [refreshProfileStatus]);

  const start = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setState("setup");
    setErrorOutcome(null);
    setLevel(0);
    setSecondsLeft(RECORDING_SECONDS);
    dropChunks();

    try {
      const session = await window.electronAPI.jarvis.beginVoiceEnrollment();
      sessionRef.current = session;
      if (!mountedRef.current) {
        await cancelPendingSession();
        return;
      }
      const selectedId = getSettings().selectedMicDeviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedId && selectedId !== "default" ? { deviceId: { exact: selectedId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: session.channels,
        },
      });
      streamRef.current = stream;
      const microphoneTrack = stream.getAudioTracks()[0];
      const microphoneSettings = microphoneTrack?.getSettings?.();
      const microphoneLabel = microphoneTrack?.label?.trim() ?? "";
      const microphoneDeviceId =
        microphoneSettings?.deviceId?.trim() ||
        (selectedId && selectedId !== "default" ? selectedId : "");
      if (!microphoneTrack || !microphoneLabel || !microphoneDeviceId) {
        throw new Error("physical microphone identity is unavailable");
      }
      microphoneSourceRef.current = {
        kind: "microphone",
        deviceId: microphoneDeviceId,
        label: microphoneLabel,
      };
      if (!mountedRef.current) throw new Error("enrollment view closed");

      const context = new AudioContext({ sampleRate: session.sampleRate });
      contextRef.current = context;
      if (context.state === "suspended") await context.resume();
      if (!mountedRef.current) throw new Error("enrollment view closed");

      const workletUrl = createEnrollmentWorkletUrl();
      workletUrlRef.current = workletUrl;
      await context.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      workletUrlRef.current = null;

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = new AudioWorkletNode(context, "jarvis-enrollment-processor");
      processorRef.current = processor;
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const chunk = new Float32Array(event.data);
        const maxSamples = session.sampleRate * MAX_CAPTURE_SECONDS;
        const remaining = maxSamples - capturedSampleCountRef.current;
        if (remaining <= 0) {
          chunk.fill(0);
          return;
        }
        const retained = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        if (retained !== chunk) chunk.fill(0);
        chunksRef.current.push(retained);
        capturedSampleCountRef.current += retained.length;
        let energy = 0;
        for (const sample of retained) energy += sample * sample;
        setLevelIfMounted(Math.min(1, Math.sqrt(energy / retained.length) * 4));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      deadlineRef.current = Date.now() + session.targetDurationSeconds * 1_000;
      if (mountedRef.current) setState("recording");
      timerRef.current = window.setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1_000));
        if (mountedRef.current) setSecondsLeft(remaining);
        if (remaining === 0) void stopForReview();
      }, 250);
    } catch {
      await cleanupCapture({ cancelSession: true, flush: false });
      dropChunks();
      if (mountedRef.current) setState("error");
    } finally {
      operationRef.current = false;
    }
  };

  const cancel = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    await cleanupCapture({ cancelSession: true, flush: false });
    dropChunks();
    if (mountedRef.current) {
      setSecondsLeft(RECORDING_SECONDS);
      setErrorOutcome(null);
      setState("idle");
    }
    operationRef.current = false;
  };

  const save = async () => {
    const session = sessionRef.current;
    if (state !== "ready" || operationRef.current || !session) return;
    operationRef.current = true;
    setState("saving");
    const totalLength = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const windowSamples = session.sampleRate * WINDOW_SECONDS;
    const microphoneSource = microphoneSourceRef.current;
    if (!microphoneSource) {
      setState("error");
      operationRef.current = false;
      return;
    }
    const payload: JarvisVoiceEnrollmentPayload = {
      sampleRate: session.sampleRate,
      channels: session.channels,
      format: session.format,
      recordedSampleCount: samples.length,
      source: microphoneSource,
      windows: [0, 1, 2].map((index) => {
        const startSample = index * windowSamples;
        const endSample = startSample + windowSamples;
        return { startSample, endSample, samples: samples.slice(startSample, endSample) };
      }),
    };
    try {
      const enrollment = await window.electronAPI.jarvis.completeVoiceEnrollment(
        session.sessionId,
        payload
      );
      sessionRef.current = null;
      if (mountedRef.current && enrollment.status === "accepted") {
        setState("saved");
        await refreshProfileStatus();
      } else if (mountedRef.current) {
        setErrorOutcome(enrollment.status === "accepted" ? null : enrollment.status);
        setState("error");
      }
    } catch {
      await cleanupCapture({ cancelSession: true, flush: false });
      if (mountedRef.current) setState("error");
    } finally {
      for (const entry of payload.windows) entry.samples.fill(0);
      samples.fill(0);
      dropChunks();
      operationRef.current = false;
    }
  };

  const startEnabled = state === "idle" || state === "error" || state === "saved";
  const cancelEnabled = state === "recording" || state === "ready";
  const micLevel = Math.max(0, Math.min(1, level));
  const pending = state === "setup" || state === "stopping" || state === "saving";
  const guidedWindow = Math.min(
    3,
    Math.max(1, Math.floor((RECORDING_SECONDS - secondsLeft) / WINDOW_SECONDS) + 1)
  );

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/70 p-4"
      aria-labelledby="voice-enrollment-title"
      aria-busy={pending}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Mic2 aria-hidden="true" />
        </div>
        <div>
          <h2 id="voice-enrollment-title" className="text-sm font-semibold text-foreground">
            {t("jarvis.voiceEnrollment")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("jarvis.voiceEnrollmentInstruction")}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t("jarvis.voiceEnrollmentPrivacy")}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <span className="font-mono text-lg tabular-nums text-foreground">
          {formatCountdown(secondsLeft)}
        </span>
        <meter
          aria-label={t("jarvis.audioLevel")}
          min={0}
          max={1}
          value={micLevel}
          className="h-2 min-w-0 flex-1"
        />
      </div>
      {state === "recording" && (
        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
          {t("jarvis.voiceEnrollmentWindowProgress", { current: guidedWindow, total: 3 })}
        </p>
      )}
      {profileStatus && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          <span className="font-medium text-foreground">
            {profileStatus.enrolled
              ? t("jarvis.voiceEnrollmentEnrolled")
              : t("jarvis.voiceEnrollmentNotEnrolled")}
          </span>
          {profileStatus.enrolled && profileStatus.updatedAt
            ? ` · ${t("jarvis.voiceEnrollmentUpdatedAt", { value: profileStatus.updatedAt })}`
            : null}
        </p>
      )}
      {state === "error" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {errorOutcome
            ? t(`jarvis.voiceEnrollmentOutcome.${errorOutcome}`)
            : t("jarvis.voiceEnrollmentError")}
        </p>
      )}
      {state === "saved" && (
        <p role="status" className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
          {t("jarvis.voiceEnrollmentSaved")}
        </p>
      )}
      {pending && (
        <p role="status" aria-live="polite" className="sr-only">
          {t("jarvis.voiceEnrollmentPending")}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!startEnabled} onClick={() => void start()}>
          <Mic2 aria-hidden="true" />
          {profileStatus?.enrolled
            ? t("jarvis.voiceEnrollmentRestart")
            : t("jarvis.voiceEnrollmentStart")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!cancelEnabled}
          onClick={() => void cancel()}
        >
          {state === "recording" ? <Square aria-hidden="true" /> : <X aria-hidden="true" />}
          {t("jarvis.voiceEnrollmentCancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state !== "ready"}
          onClick={() => void save()}
        >
          <Save aria-hidden="true" />
          {t("jarvis.voiceEnrollmentSave")}
        </Button>
      </div>
    </section>
  );
}
