import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic2, Save, Square, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { getSettings } from "../../stores/settingsStore";

const SAMPLE_RATE = 16_000;
const RECORDING_SECONDS = 30;
const WINDOW_SECONDS = 8;
const WORKLET_CHUNK_SIZE = 1_600;

type EnrollmentState = "idle" | "recording" | "ready" | "saving" | "saved" | "error";

function getEnrollmentWorkletUrl(): string {
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
  const chunksRef = useRef<Float32Array[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const deadlineRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stopCapture = async (nextState: EnrollmentState) => {
    clearTimer();
    processorRef.current?.port.postMessage("stop");
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (contextRef.current && contextRef.current.state !== "closed") {
      await contextRef.current.close();
    }
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    contextRef.current = null;
    setLevel(0);
    setState(nextState);
  };

  useEffect(
    () => () => {
      clearTimer();
      processorRef.current?.port.postMessage("stop");
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void contextRef.current?.close();
      chunksRef.current = [];
    },
    []
  );

  const start = async () => {
    setState("idle");
    chunksRef.current = [];
    setSecondsLeft(RECORDING_SECONDS);
    try {
      const selectedId = getSettings().selectedMicDeviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedId && selectedId !== "default" ? { deviceId: { exact: selectedId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      await context.audioWorklet.addModule(getEnrollmentWorkletUrl());
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "jarvis-enrollment-processor");
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const chunk = new Float32Array(event.data);
        chunksRef.current.push(chunk);
        let energy = 0;
        for (const sample of chunk) energy += sample * sample;
        setLevel(Math.min(1, Math.sqrt(energy / chunk.length) * 4));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = source;
      processorRef.current = processor;
      deadlineRef.current = Date.now() + RECORDING_SECONDS * 1_000;
      setState("recording");
      timerRef.current = window.setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1_000));
        setSecondsLeft(remaining);
        if (remaining === 0) void stopCapture("ready");
      }, 250);
    } catch {
      setState("error");
      void stopCapture("error");
    }
  };

  const cancel = async () => {
    await stopCapture("idle");
    chunksRef.current = [];
    setSecondsLeft(RECORDING_SECONDS);
  };

  const save = async () => {
    if (state !== "ready") return;
    setState("saving");
    const totalLength = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const windowSamples = SAMPLE_RATE * WINDOW_SECONDS;
    if (samples.length < windowSamples * 3) {
      setState("error");
      return;
    }
    const windows = [0, 1, 2].map((index) => {
      const startSample = index * windowSamples;
      const endSample = startSample + windowSamples;
      return { startSample, endSample, samples: samples.slice(startSample, endSample) };
    });
    try {
      await window.electronAPI.jarvis.enrollVoice(windows);
      chunksRef.current = [];
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/70 p-4"
      aria-labelledby="voice-enrollment-title"
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
          value={level}
          className="h-2 min-w-0 flex-1"
        />
      </div>
      {state === "error" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("jarvis.voiceEnrollmentError")}
        </p>
      )}
      {state === "saved" && (
        <p role="status" className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
          {t("jarvis.voiceEnrollmentSaved")}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={state === "recording" || state === "saving"}
          onClick={() => void start()}
        >
          <Mic2 aria-hidden="true" />
          {t("jarvis.voiceEnrollmentStart")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state !== "recording"}
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
