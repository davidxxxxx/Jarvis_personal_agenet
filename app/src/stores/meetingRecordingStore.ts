import { create } from "zustand";
import { getSettings, selectResolvedMeetingTranscription } from "./settingsStore";
import { useStreamingProvidersStore } from "./streamingProvidersStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { getBaseLanguageCode } from "../utils/languageSupport";
import type { SystemAudioAccessResult, SystemAudioStrategy } from "../types/electron";
import {
  DEFAULT_SYSTEM_AUDIO_ACCESS,
  getDisplayCaptureModeForStrategy,
  getFallbackSystemAudioAccess,
  isRendererSystemAudioStrategy,
} from "../utils/systemAudioAccess";
import {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} from "../constants/speakerDetection.json";
import logger from "../utils/logger";
import {
  lockTranscriptSpeaker,
  normalizeTranscriptSegment,
  type TranscriptSpeakerLockSource,
  type TranscriptSpeakerStatus,
} from "../utils/transcriptSpeakerState";
import {
  buildMeetingPrepareOptions,
  shouldAwaitRendererPrepare,
  type MeetingPrepareCaptureOptions,
} from "../jarvis/renderer/meetingPreparation";
import { createMeetingStopCoordinator, type SharedStopOptions } from "./meetingStopCoordinator";
import { reacquireIfDead } from "../helpers/micTrackHealth";
import {
  getMicrophoneRecoveryDelay,
  isDeniedAutomaticMicrophone,
  orderMicrophoneRecoveryCandidates,
  type MicrophoneRecoveryCandidate,
} from "../jarvis/renderer/microphoneRecoveryPolicy";
import type {
  JarvisCaptureSourceStates,
  JarvisPowerResumeRestorations,
  JarvisSourceInterruptionInput,
  JarvisSourceRestorationInput,
} from "../jarvis/types";

export interface TranscriptSegment {
  id: string;
  text: string;
  source: "mic" | "system";
  timestamp?: number;
  startedAt?: number;
  endedAt?: number;
  confidence?: number;
  echoScore?: number | null;
  speaker?: string;
  speakerName?: string;
  speakerIsPlaceholder?: boolean;
  suggestedName?: string;
  suggestedProfileId?: number;
  speakerStatus?: TranscriptSpeakerStatus;
  speakerLocked?: boolean;
  speakerLockSource?: TranscriptSpeakerLockSource;
  revisionSource?: "openai_correction";
  originalText?: string;
}

export interface MeetingFinalSegment {
  text: string;
  source: "mic" | "system";
  timestamp?: number;
  startedAt?: number;
  endedAt?: number;
  confidence?: number;
  echoScore?: number | null;
}

export const SIDE_PANEL_BREAKPOINT_PX = 1024;

interface SpeakerIdentification {
  speakerId: string;
  displayName?: string | null;
  startTime: number;
  endTime: number;
}

interface RecentSystemSpeaker {
  speakerId: string;
  speakerName: string | null;
  speakerIsPlaceholder: boolean;
  updatedAt: number;
}

interface MeetingRecordingState {
  isRecording: boolean;
  isTranscribing: boolean;
  recordingNoteId: number | null;
  recordingNoteTitle: string | null;
  recordingFolderId: number | null;
  segments: TranscriptSegment[];
  transcript: string;
  micPartial: string;
  systemPartial: string;
  systemPartialSpeakerId: string | null;
  systemPartialSpeakerName: string | null;
  diarizationSessionId: string | null;
  sessionDiarizationEnabled: boolean;
  sessionExpectedCount: number;
  userTouchedStepper: boolean;
  error: string | null;
  currentMicLevel: number;
  currentSystemLevel: number;
  activeMicLabel: string | null;
  micFallbackActive: boolean;
  micRecoveryStatus: "idle" | "reconnecting" | "restored";
  micRecoveryAttempt: number;
  windowWidth: number;
  captureSourceStates: JarvisCaptureSourceStates;
}

export class CaptureSourcesUnavailableError extends Error {
  readonly sourceStates: JarvisCaptureSourceStates;

  constructor(sourceStates: JarvisCaptureSourceStates) {
    super("capture_source_unavailable");
    this.name = "CaptureSourcesUnavailableError";
    this.sourceStates = sourceStates;
  }
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;
const MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

const SPEAKER_IDENTIFICATION_RETENTION_MS = 30_000;
const SYSTEM_SPEAKER_CARRY_FORWARD_MS = 8_000;

const buildTranscriptText = (segments: TranscriptSegment[]) =>
  segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

const getSpeakerNumericIndex = (speakerId?: string): number | null => {
  if (!speakerId) return null;
  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) : null;
};

const isSegmentWithinIdentificationWindow = (
  segment: TranscriptSegment,
  identification: SpeakerIdentification
) => {
  if (segment.source !== "system" || segment.timestamp == null) return false;
  return (
    segment.timestamp >= identification.startTime && segment.timestamp <= identification.endTime
  );
};

const getMeetingTranscriptionOptions = (
  forceLocalTranscription = false,
  overrides: Pick<
    StartRecordingArgs,
    "localModelOverride" | "localLanguageOverride" | "localPromptMode"
  > = {}
) => {
  const state = getSettings();
  const resolved = selectResolvedMeetingTranscription(state);
  const language = getBaseLanguageCode(state.preferredLanguage);

  if (forceLocalTranscription || resolved.useLocalWhisper) {
    return {
      provider: "local" as const,
      localProvider: resolved.localTranscriptionProvider,
      localModel:
        resolved.localTranscriptionProvider === "nvidia"
          ? resolved.parakeetModel || "parakeet-tdt-0.6b-v3"
          : overrides.localModelOverride || resolved.whisperModel || "base",
      language:
        overrides.localLanguageOverride === null
          ? null
          : overrides.localLanguageOverride || language,
      ...(overrides.localPromptMode ? { localPromptMode: overrides.localPromptMode } : {}),
    };
  }

  // Corti (BYOK) streams over its own WSS — independent of the server-driven catalog.
  const selectedProvider =
    state.meetingCloudTranscriptionProvider || state.cloudTranscriptionProvider;
  if (resolved.cloudTranscriptionMode === "byok" && selectedProvider === "corti") {
    return {
      provider: "corti-realtime" as const,
      model: "corti-transcribe",
      mode: "byok" as const,
      language,
      environment: state.cortiEnvironment,
      tenant: state.cortiTenant,
      keyterms: (state.customDictionary ?? []).filter(Boolean),
    };
  }

  const catalog = useStreamingProvidersStore.getState().providers;
  const provider =
    catalog?.find((p) => p.id === resolved.cloudTranscriptionProvider) ?? catalog?.[0];
  const byokKeyAvailable = provider?.id === "openai" ? !!state.openaiApiKey : true;
  const mode =
    resolved.cloudTranscriptionMode === "byok" && byokKeyAvailable ? "byok" : "openwhispr";
  if (!provider) {
    logger.debug(
      "Streaming providers catalog not loaded, falling back to OpenAI default",
      {},
      "meeting"
    );
    return { provider: "openai-realtime" as const, model: "gpt-4o-mini-transcribe", mode };
  }
  const model =
    provider.models.find((m) => m.id === resolved.cloudTranscriptionModel)?.id ??
    provider.models.find((m) => m.default)?.id ??
    provider.models[0]?.id;
  return { provider: `${provider.id}-realtime` as const, model, mode };
};

const stoppedMediaStreams = new WeakSet<MediaStream>();
const stopMediaStream = (stream: MediaStream | null) => {
  if (!stream || stoppedMediaStreams.has(stream)) return;
  stoppedMediaStreams.add(stream);
  try {
    stream.getTracks().forEach((track) => track.stop());
  } catch {}
};

const closingAudioContexts = new WeakMap<AudioContext, Promise<void>>();
const closeAudioContextOnce = (context: AudioContext | null): Promise<void> => {
  if (!context) return Promise.resolve();
  const existing = closingAudioContexts.get(context);
  if (existing) return existing;
  const closing = context.close().catch(() => undefined);
  closingAudioContexts.set(context, closing);
  return closing;
};

const getDisplayCaptureOptions = (mode: "loopback" | "portal") => {
  if (mode === "loopback") {
    return { video: true, audio: true };
  }

  return {
    video: true,
    audio: true,
    systemAudio: "include",
    windowAudio: "system",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions & {
    systemAudio?: "include";
    windowAudio?: "system";
    selfBrowserSurface?: "exclude";
  };
};

const requestSystemAudioDisplayStream = async (mode: "loopback" | "portal") => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayCaptureOptions(mode));
    const audioTrack = stream.getAudioTracks()[0];

    if (!audioTrack) {
      stopMediaStream(stream);
      return { stream: null, error: new Error("No system-audio track was returned.") };
    }

    stream.getVideoTracks().forEach((track) => track.stop());
    return { stream, error: null };
  } catch (error) {
    return { stream: null, error: error as Error };
  }
};

const prepareMeetingSystemAudioCapture = (initialSystemAudioAccess: SystemAudioAccessResult) => {
  const initialSystemAudioStrategy = initialSystemAudioAccess.strategy ?? "unsupported";
  const initialDisplayCaptureStrategy = isRendererSystemAudioStrategy(initialSystemAudioStrategy)
    ? initialSystemAudioStrategy
    : null;
  const systemCapturePromise = initialDisplayCaptureStrategy
    ? requestSystemAudioDisplayStream(
        getDisplayCaptureModeForStrategy(initialDisplayCaptureStrategy)
      )
    : Promise.resolve({ stream: null, error: null });

  return {
    initialSystemAudioStrategy,
    initialDisplayCaptureStrategy,
    systemCapturePromise,
  };
};

const ensureRendererSystemAudioCapture = async ({
  initialDisplayCaptureStrategy,
  systemAudioStrategy,
  systemCaptureResult,
}: {
  initialDisplayCaptureStrategy: "loopback" | null;
  systemAudioStrategy: SystemAudioStrategy;
  systemCaptureResult: { stream: MediaStream | null; error: Error | null };
}) => {
  if (
    systemCaptureResult.stream ||
    systemCaptureResult.error ||
    !isRendererSystemAudioStrategy(systemAudioStrategy) ||
    initialDisplayCaptureStrategy
  ) {
    return systemCaptureResult;
  }

  return requestSystemAudioDisplayStream(getDisplayCaptureModeForStrategy(systemAudioStrategy));
};

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = `
const BUFFER_SIZE = ${MEETING_AUDIO_BUFFER_SIZE};
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
`;

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return blobUrl;
  };
})();

export const primeMeetingWorklet = () => {
  getMeetingWorkletBlobUrl();
};

const getMeetingMicConstraints = async (
  deviceIdOverride: string | null | undefined = undefined
): Promise<MediaStreamConstraints> => {
  if (deviceIdOverride !== undefined) {
    return deviceIdOverride && deviceIdOverride !== "default"
      ? {
          audio: {
            deviceId: { exact: deviceIdOverride },
            ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
          },
        }
      : { audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS };
  }
  const { preferBuiltInMic, selectedMicDeviceId } = getSettings();

  if (preferBuiltInMic) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtInMic = devices.find(
        (device) => device.kind === "audioinput" && isBuiltInMicrophone(device.label)
      );

      if (builtInMic?.deviceId) {
        return {
          audio: {
            deviceId: { exact: builtInMic.deviceId },
            ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
          },
        };
      }
    } catch (err) {
      logger.debug(
        "Failed to enumerate microphones for meeting transcription",
        { error: (err as Error).message },
        "meeting"
      );
    }
  }

  if (selectedMicDeviceId && selectedMicDeviceId !== "default") {
    return {
      audio: {
        deviceId: { exact: selectedMicDeviceId },
        ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
      },
    };
  }

  return { audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS };
};

const createAudioPipeline = async ({
  stream,
  context,
  onChunk,
  cancellation,
  isCancelled,
}: {
  stream: MediaStream;
  context: AudioContext;
  onChunk: (chunk: ArrayBuffer) => void;
  cancellation?: Promise<void>;
  isCancelled?: () => boolean;
}) => {
  const awaitPipelineStep = async (step: Promise<unknown>): Promise<void> => {
    if (isCancelled?.()) throw new Error("MIC_RECOVERY_CANCELLED");
    if (cancellation) {
      await Promise.race([step, cancellation]);
    } else {
      await step;
    }
    if (isCancelled?.()) throw new Error("MIC_RECOVERY_CANCELLED");
  };
  if (context.state === "suspended") {
    await awaitPipelineStep(context.resume());
  }

  await awaitPipelineStep(context.audioWorklet.addModule(getMeetingWorkletBlobUrl()));

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor");
  const silentGain = context.createGain();
  silentGain.gain.value = 0;

  processor.port.onmessage = (event) => {
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;
    onChunk(chunk);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  return { source, processor };
};

// Detach the AudioContext from hardware output — when BT headphones switch to
// HFP, the default-output context can stall on the sample-rate mismatch.
const detachFromOutputDevice = async (ctx: AudioContext) => {
  if ("setSinkId" in ctx) {
    try {
      await (ctx as unknown as { setSinkId: (cfg: { type: string }) => Promise<void> }).setSinkId({
        type: "none",
      });
    } catch {}
  }
};

const flushAndDisconnectProcessor = async (processor: AudioWorkletNode | null) => {
  if (!processor) return;

  try {
    processor.port.postMessage("stop");
    await new Promise((resolve) => {
      window.setTimeout(resolve, MEETING_STOP_FLUSH_TIMEOUT_MS);
    });
  } catch {}

  processor.port.onmessage = null;
  processor.disconnect();
};

let segmentCounter = 0;

// Pipeline lives in module scope — not on React refs — so it survives
// view changes and re-mounts of the consumer view.
let micContext: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micProcessor: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let micAnalyser: AnalyserNode | null = null;
let systemContext: AudioContext | null = null;
let systemSource: MediaStreamAudioSourceNode | null = null;
let systemProcessor: AudioWorkletNode | null = null;
let systemStream: MediaStream | null = null;
let isRecordingFlag = false;
let isStartingFlag = false;
let captureAttemptGeneration = 0;
let meetingInputRejected = false;
let activeMeetingInputGeneration: string | null = null;
let activeJarvisSessionBinding: { sessionId: string } | null = null;
let isPrepared = false;
let preparedMicOnly: boolean | null = null;
let segmentsRefValue: TranscriptSegment[] = [];
let preparePromise: Promise<void> | null = null;
let prepareMicOnly: boolean | null = null;
let prepareGeneration = 0;
let ipcCleanups: Array<() => void> = [];
let systemAudioLevelDecayTimer: ReturnType<typeof setTimeout> | null = null;
let speakerIdentifications: SpeakerIdentification[] = [];
let nextPlaceholderSpeakerIndex = 0;
let systemPartialSpeakerIdValue: string | null = null;
let recentSystemSpeaker: RecentSystemSpeaker | null = null;
let speakerLocks: Map<string, string> = new Map();
let pushConfigTimeout: ReturnType<typeof setTimeout> | null = null;
let cancelActiveMicRecovery: (() => void) | null = null;
let cancelPendingCaptureSetup: (() => void) | null = null;
let cancelPendingMicrophoneCapture: (() => void) | null = null;
let cancelPendingRendererSystemCapture: (() => void) | null = null;
let cancelActiveRendererSystemInterruptionPersistence: (() => void) | null = null;
let cancelActiveRendererSystemRecovery: (() => void) | null = null;

export const useMeetingRecordingStore = create<MeetingRecordingState>()(() => ({
  isRecording: false,
  isTranscribing: false,
  recordingNoteId: null,
  recordingNoteTitle: null,
  recordingFolderId: null,
  segments: [],
  transcript: "",
  micPartial: "",
  systemPartial: "",
  systemPartialSpeakerId: null,
  systemPartialSpeakerName: null,
  diarizationSessionId: null,
  sessionDiarizationEnabled:
    (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ?? true,
  sessionExpectedCount: DEFAULT_EXPECTED_SPEAKER_COUNT,
  userTouchedStepper: false,
  error: null,
  currentMicLevel: 0,
  currentSystemLevel: 0,
  activeMicLabel: null,
  micFallbackActive: false,
  micRecoveryStatus: "idle",
  micRecoveryAttempt: 0,
  windowWidth: typeof window !== "undefined" ? window.innerWidth : SIDE_PANEL_BREAKPOINT_PX,
  captureSourceStates: { mic: "idle", system: "idle" },
}));

export const getMicAnalyser = (): AnalyserNode | null => micAnalyser;

function pushConfig(enabled: boolean, expectedCount: number) {
  if (pushConfigTimeout) clearTimeout(pushConfigTimeout);
  pushConfigTimeout = setTimeout(() => {
    (
      window.electronAPI as unknown as {
        setMeetingSessionSpeakerConfig?: (config: {
          enabled: boolean;
          expectedCount: number;
        }) => void;
      }
    )?.setMeetingSessionSpeakerConfig?.({ enabled, expectedCount });
  }, 150);
}

export function setSessionDiarizationEnabled(enabled: boolean): void {
  useMeetingRecordingStore.setState({ sessionDiarizationEnabled: enabled });
  pushConfig(enabled, useMeetingRecordingStore.getState().sessionExpectedCount);
  const noteId = useMeetingRecordingStore.getState().recordingNoteId;
  if (noteId != null) {
    window.electronAPI?.updateNote?.(noteId, { diarization_enabled: enabled ? 1 : 0 });
  }
}

export function setSessionExpectedCount(count: number): void {
  const clamped = Math.max(1, Math.min(MAX_SPEAKER_COUNT, count));
  useMeetingRecordingStore.setState({
    sessionExpectedCount: clamped,
    userTouchedStepper: true,
  });
  pushConfig(useMeetingRecordingStore.getState().sessionDiarizationEnabled, clamped);
  const noteId = useMeetingRecordingStore.getState().recordingNoteId;
  if (noteId != null) {
    window.electronAPI?.updateNote?.(noteId, { expected_speaker_count: clamped });
  }
}

function setSystemPartialSpeakerIdentity(speakerId: string | null, speakerName: string | null) {
  systemPartialSpeakerIdValue = speakerId;
  useMeetingRecordingStore.setState({
    systemPartialSpeakerId: speakerId,
    systemPartialSpeakerName: speakerName,
  });
}

function applySpeakerIdentification(
  segment: TranscriptSegment,
  identification: SpeakerIdentification
): TranscriptSegment {
  if (
    segment.source !== "system" ||
    !isSegmentWithinIdentificationWindow(segment, identification) ||
    (segment.speaker && !segment.speakerIsPlaceholder && segment.speakerStatus !== "provisional") ||
    segment.speakerLocked
  ) {
    return segment;
  }

  return normalizeTranscriptSegment({
    ...segment,
    speaker: identification.speakerId,
    speakerName: identification.displayName ?? segment.speakerName,
    speakerIsPlaceholder: false,
    speakerStatus: "confirmed",
  });
}

function rememberSystemSpeaker(
  speakerId: string | null,
  speakerName: string | null,
  speakerIsPlaceholder: boolean,
  updatedAt = Date.now()
) {
  recentSystemSpeaker = speakerId
    ? {
        speakerId,
        speakerName,
        speakerIsPlaceholder,
        updatedAt,
      }
    : null;
}

function getRecentSystemSpeaker(nowMs: number) {
  if (!recentSystemSpeaker) return null;
  return nowMs - recentSystemSpeaker.updatedAt <= SYSTEM_SPEAKER_CARRY_FORWARD_MS
    ? recentSystemSpeaker
    : null;
}

function reserveSpeakerIndex(speakerId?: string) {
  const idx = getSpeakerNumericIndex(speakerId);
  if (idx == null) return;
  nextPlaceholderSpeakerIndex = Math.max(nextPlaceholderSpeakerIndex, idx + 1);
}

// Other-speaker cap is expectedCount - 1 (the mic track is "you"); mirrors the
// backend cap so live labels can't climb past the count the user expects.
function mintPlaceholderSpeakerId(): string {
  const expected = useMeetingRecordingStore.getState().sessionExpectedCount;
  const cap = Math.max(1, expected - 1);
  const index = Math.min(nextPlaceholderSpeakerIndex, cap - 1);
  nextPlaceholderSpeakerIndex = Math.max(nextPlaceholderSpeakerIndex, index + 1);
  return `speaker_${index}`;
}

function assignProvisionalSpeaker(segment: TranscriptSegment): TranscriptSegment {
  if (segment.source !== "system" || segment.speaker) return segment;

  const nowMs = segment.timestamp ?? Date.now();
  if (systemPartialSpeakerIdValue) {
    reserveSpeakerIndex(systemPartialSpeakerIdValue);
    return normalizeTranscriptSegment({
      ...segment,
      speaker: systemPartialSpeakerIdValue,
      speakerIsPlaceholder: true,
      speakerStatus: "provisional",
    });
  }

  const recent = getRecentSystemSpeaker(nowMs);
  if (recent?.speakerId) {
    reserveSpeakerIndex(recent.speakerId);
    return normalizeTranscriptSegment({
      ...segment,
      speaker: recent.speakerId,
      speakerName: recent.speakerName ?? undefined,
      speakerIsPlaceholder: recent.speakerIsPlaceholder,
      speakerStatus: "provisional",
    });
  }

  const previousSystemSegment = [...segmentsRefValue]
    .reverse()
    .find(
      (candidate) =>
        candidate.source === "system" &&
        candidate.speaker &&
        candidate.timestamp != null &&
        nowMs - candidate.timestamp <= SYSTEM_SPEAKER_CARRY_FORWARD_MS
    );

  if (previousSystemSegment?.speaker) {
    reserveSpeakerIndex(previousSystemSegment.speaker);
    return normalizeTranscriptSegment({
      ...segment,
      speaker: previousSystemSegment.speaker,
      speakerName: previousSystemSegment.speakerName,
      speakerIsPlaceholder: true,
      speakerStatus: "provisional",
    });
  }

  const speakerId = mintPlaceholderSpeakerId();

  return normalizeTranscriptSegment({
    ...segment,
    speaker: speakerId,
    speakerIsPlaceholder: true,
    speakerStatus: "provisional",
  });
}

function commitFinalSegment(data: MeetingFinalSegment): void {
  if (!data.text || (data.source !== "mic" && data.source !== "system")) return;
  const prev = useMeetingRecordingStore.getState().segments;
  if (
    prev.some(
      (segment) =>
        segment.source === data.source &&
        segment.timestamp === data.timestamp &&
        segment.text === data.text
    )
  ) {
    return;
  }

  let rawSegment: TranscriptSegment = normalizeTranscriptSegment({
    id: `seg-${++segmentCounter}`,
    text: data.text,
    source: data.source,
    timestamp: data.timestamp,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    confidence: data.confidence,
    echoScore: data.echoScore,
  });

  for (let index = speakerIdentifications.length - 1; index >= 0; index -= 1) {
    rawSegment = applySpeakerIdentification(rawSegment, speakerIdentifications[index]);
  }

  const provisional = assignProvisionalSpeaker(rawSegment);
  reserveSpeakerIndex(provisional.speaker);
  const lockedName = provisional.speaker ? speakerLocks.get(provisional.speaker) : undefined;
  const segment = lockedName
    ? lockTranscriptSpeaker(provisional, {
        speakerName: lockedName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      })
    : provisional;

  const timestamp = segment.timestamp ?? Infinity;
  let insertionIndex = prev.length;
  while (insertionIndex > 0 && (prev[insertionIndex - 1].timestamp ?? 0) > timestamp) {
    insertionIndex -= 1;
  }
  const next =
    insertionIndex === prev.length
      ? [...prev, segment]
      : [...prev.slice(0, insertionIndex), segment, ...prev.slice(insertionIndex)];
  segmentsRefValue = next;
  const partialPatch = data.source === "mic" ? { micPartial: "" } : { systemPartial: "" };
  useMeetingRecordingStore.setState({
    segments: next,
    transcript: buildTranscriptText(next),
    ...partialPatch,
  });
  if (data.source === "system" && segment.speaker) {
    rememberSystemSpeaker(
      segment.speaker,
      segment.speakerName ?? null,
      !!segment.speakerIsPlaceholder,
      segment.timestamp ?? Date.now()
    );
  }
  if (data.source === "system") setSystemPartialSpeakerIdentity(null, null);
}

function mergeFinalSegments(finalSegments: MeetingFinalSegment[] | undefined): void {
  if (!Array.isArray(finalSegments)) return;
  for (const segment of finalSegments) commitFinalSegment(segment);
}

interface CaptureCleanupOptions {
  preserveStarting?: boolean;
}

async function cleanupCaptureSources(options: CaptureCleanupOptions = {}): Promise<void> {
  captureAttemptGeneration += 1;
  activeMeetingInputGeneration = null;
  activeJarvisSessionBinding = null;
  if (systemAudioLevelDecayTimer) {
    clearTimeout(systemAudioLevelDecayTimer);
    systemAudioLevelDecayTimer = null;
  }
  useMeetingRecordingStore.setState({ currentSystemLevel: 0 });
  if (preparePromise) {
    prepareGeneration += 1;
    preparePromise = null;
    prepareMicOnly = null;
    isPrepared = false;
    preparedMicOnly = null;
    try {
      const cancellation = window.electronAPI?.meetingTranscriptionCancel?.();
      void cancellation?.catch(() => undefined);
    } catch {}
  }
  cancelPendingCaptureSetup?.();
  cancelPendingCaptureSetup = null;
  cancelPendingMicrophoneCapture?.();
  cancelPendingMicrophoneCapture = null;
  cancelPendingRendererSystemCapture?.();
  cancelPendingRendererSystemCapture = null;
  cancelActiveMicRecovery?.();
  cancelActiveMicRecovery = null;
  cancelActiveRendererSystemInterruptionPersistence?.();
  cancelActiveRendererSystemInterruptionPersistence = null;
  cancelActiveRendererSystemRecovery?.();
  cancelActiveRendererSystemRecovery = null;

  await flushAndDisconnectProcessor(micProcessor);
  micProcessor = null;

  micSource?.disconnect();
  micSource = null;

  micAnalyser?.disconnect();
  micAnalyser = null;

  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  micStream = null;

  try {
    await micContext?.close();
  } catch {}
  micContext = null;

  await flushAndDisconnectProcessor(systemProcessor);
  systemProcessor = null;

  systemSource?.disconnect();
  systemSource = null;

  stopMediaStream(systemStream);
  systemStream = null;

  try {
    await systemContext?.close();
  } catch {}
  systemContext = null;

  isPrepared = false;
  preparedMicOnly = null;
  isRecordingFlag = false;
  if (!options.preserveStarting) isStartingFlag = false;
}

function detachMeetingListeners(): void {
  ipcCleanups.forEach((fn) => fn());
  ipcCleanups = [];
}

async function cleanup(options: CaptureCleanupOptions = {}): Promise<void> {
  await cleanupCaptureSources(options);
  detachMeetingListeners();
}

export async function prepareTranscription(
  captureOptions: MeetingPrepareCaptureOptions = {}
): Promise<void> {
  const micOnly = captureOptions.captureSystemAudio === false;
  if ((isPrepared && preparedMicOnly === micOnly) || isRecordingFlag || isStartingFlag) return;
  if (preparePromise) {
    if (prepareMicOnly === micOnly) return preparePromise;
    prepareGeneration += 1;
    preparePromise = null;
    prepareMicOnly = null;
    isPrepared = false;
    preparedMicOnly = null;
  }

  logger.info("Meeting transcription preparing (pre-warming WebSockets)...", {}, "meeting");

  const generation = ++prepareGeneration;
  const promise = (async () => {
    try {
      const result = await window.electronAPI?.meetingTranscriptionPrepare?.(
        buildMeetingPrepareOptions(getMeetingTranscriptionOptions(), captureOptions)
      );

      if (generation !== prepareGeneration) return;
      if (result?.success) {
        isPrepared = true;
        preparedMicOnly = micOnly;
        logger.info(
          "Meeting transcription prepared",
          { alreadyPrepared: result.alreadyPrepared },
          "meeting"
        );
      } else {
        logger.error("Meeting transcription prepare failed", { error: result?.error }, "meeting");
      }
    } catch (err) {
      if (generation !== prepareGeneration) return;
      logger.error(
        "Meeting transcription prepare error",
        { error: (err as Error).message },
        "meeting"
      );
    } finally {
      if (generation === prepareGeneration) {
        preparePromise = null;
        prepareMicOnly = null;
      }
    }
  })();

  preparePromise = promise;
  prepareMicOnly = micOnly;
  await promise;
}

export interface StartRecordingArgs {
  noteId: number | null;
  noteTitle: string | null;
  folderId: number | null;
  captureSystemAudio?: boolean;
  captureMicrophone?: boolean;
  micOnly?: boolean;
  requireAllSources?: boolean;
  jarvisSessionId?: string | null;
  seedSegments?: TranscriptSegment[];
  diarizationEnabled?: boolean | null;
  expectedCount?: number | null;
  forceLocalTranscription?: boolean;
  localModelOverride?: string;
  localLanguageOverride?: string | null;
  localPromptMode?: "bilingual-context";
  micDeviceIdOverride?: string | null;
  powerRestorations?: JarvisPowerResumeRestorations;
}

export function rebindActiveMeetingJarvisSession(
  previousSessionId: string,
  nextSessionId: string
): void {
  if (!activeJarvisSessionBinding) {
    throw new Error("active Jarvis recording session is unavailable");
  }
  if (activeJarvisSessionBinding.sessionId === nextSessionId) return;
  if (activeJarvisSessionBinding.sessionId !== previousSessionId) {
    throw new Error("active Jarvis recording session does not match midnight source");
  }
  activeJarvisSessionBinding.sessionId = nextSessionId;
}

export async function startRecording(
  args: StartRecordingArgs
): Promise<JarvisPowerResumeRestorations | void> {
  if (isRecordingFlag || isStartingFlag || meetingStopCoordinator.hasPendingStop()) return;
  const captureAttempt = ++captureAttemptGeneration;
  const jarvisSessionBinding = args.jarvisSessionId ? { sessionId: args.jarvisSessionId } : null;
  const isCurrentCaptureAttempt = () => captureAttemptGeneration === captureAttempt;
  let rejectCaptureSetupCancellation!: (reason: Error) => void;
  const captureSetupCancellation = new Promise<never>((_resolve, reject) => {
    rejectCaptureSetupCancellation = reject;
  });
  const cancelThisCaptureSetup = () => {
    rejectCaptureSetupCancellation(new Error("CAPTURE_SETUP_CANCELLED"));
  };
  const awaitCaptureSetupStep = async (step: Promise<unknown>): Promise<void> => {
    await Promise.race([step, captureSetupCancellation]);
    if (!isCurrentCaptureAttempt()) throw new Error("CAPTURE_SETUP_CANCELLED");
  };
  cancelPendingCaptureSetup = cancelThisCaptureSetup;
  isStartingFlag = true;
  activeMeetingInputGeneration = null;
  let acceptedMainInputGeneration: string | null = null;
  let pendingMicrophoneStream: MediaStream | null = null;
  let pendingMicrophoneContext: AudioContext | null = null;
  let pendingMicrophoneOwnershipOpen = true;
  const releasedPendingMicrophoneStreams = new WeakSet<MediaStream>();
  const stopPendingMicrophoneStream = (stream: MediaStream | null) => {
    if (!stream || releasedPendingMicrophoneStreams.has(stream)) return;
    releasedPendingMicrophoneStreams.add(stream);
    stopMediaStream(stream);
  };
  const releasePendingMicrophoneStream = () => {
    const stream = pendingMicrophoneStream;
    pendingMicrophoneStream = null;
    stopPendingMicrophoneStream(stream);
  };
  const releasePendingMicrophoneContext = (): Promise<void> => {
    const context = pendingMicrophoneContext;
    pendingMicrophoneContext = null;
    return closeAudioContextOnce(context);
  };
  const claimPendingMicrophoneStream = (stream: MediaStream | null) => {
    if (!stream) return;
    if (!pendingMicrophoneOwnershipOpen) {
      stopPendingMicrophoneStream(stream);
      return;
    }
    if (pendingMicrophoneStream && pendingMicrophoneStream !== stream) {
      stopPendingMicrophoneStream(pendingMicrophoneStream);
    }
    pendingMicrophoneStream = stream;
  };
  const claimPendingMicrophoneContext = (context: AudioContext) => {
    if (!pendingMicrophoneOwnershipOpen) {
      void closeAudioContextOnce(context);
      return;
    }
    if (pendingMicrophoneContext && pendingMicrophoneContext !== context) {
      void closeAudioContextOnce(pendingMicrophoneContext);
    }
    pendingMicrophoneContext = context;
  };
  const transferPendingMicrophoneCapture = (stream: MediaStream, context: AudioContext) => {
    if (
      !pendingMicrophoneOwnershipOpen ||
      pendingMicrophoneStream !== stream ||
      pendingMicrophoneContext !== context
    ) {
      return false;
    }
    if (pendingMicrophoneStream === stream) pendingMicrophoneStream = null;
    if (pendingMicrophoneContext === context) pendingMicrophoneContext = null;
    return true;
  };
  const closePendingMicrophoneOwnership = () => {
    pendingMicrophoneOwnershipOpen = false;
    releasePendingMicrophoneStream();
    void releasePendingMicrophoneContext();
  };
  cancelPendingMicrophoneCapture = closePendingMicrophoneOwnership;
  let pendingRendererSystemStream: MediaStream | null = null;
  let pendingRendererSystemContext: AudioContext | null = null;
  let pendingRendererSystemOwnershipOpen = true;
  const releasedPendingRendererSystemStreams = new WeakSet<MediaStream>();
  const stopPendingRendererSystemStream = (stream: MediaStream | null) => {
    if (!stream || releasedPendingRendererSystemStreams.has(stream)) return;
    releasedPendingRendererSystemStreams.add(stream);
    stopMediaStream(stream);
  };
  const releasePendingRendererSystemStream = () => {
    const stream = pendingRendererSystemStream;
    pendingRendererSystemStream = null;
    stopPendingRendererSystemStream(stream);
  };
  const releasePendingRendererSystemContext = (): Promise<void> => {
    const context = pendingRendererSystemContext;
    pendingRendererSystemContext = null;
    return closeAudioContextOnce(context);
  };
  const claimPendingRendererSystemStream = (stream: MediaStream | null) => {
    if (!stream) return;
    if (!pendingRendererSystemOwnershipOpen) {
      stopPendingRendererSystemStream(stream);
      return;
    }
    if (pendingRendererSystemStream && pendingRendererSystemStream !== stream) {
      stopPendingRendererSystemStream(pendingRendererSystemStream);
    }
    pendingRendererSystemStream = stream;
  };
  const claimPendingRendererSystemContext = (context: AudioContext) => {
    if (!pendingRendererSystemOwnershipOpen) {
      void closeAudioContextOnce(context);
      return;
    }
    if (pendingRendererSystemContext && pendingRendererSystemContext !== context) {
      void closeAudioContextOnce(pendingRendererSystemContext);
    }
    pendingRendererSystemContext = context;
  };
  const transferPendingRendererSystemCapture = (
    stream: MediaStream,
    context: AudioContext
  ): boolean => {
    if (
      !pendingRendererSystemOwnershipOpen ||
      pendingRendererSystemStream !== stream ||
      pendingRendererSystemContext !== context
    ) {
      return false;
    }
    pendingRendererSystemStream = null;
    pendingRendererSystemContext = null;
    return true;
  };
  const closePendingRendererSystemOwnership = () => {
    pendingRendererSystemOwnershipOpen = false;
    releasePendingRendererSystemStream();
    void releasePendingRendererSystemContext();
  };
  cancelPendingRendererSystemCapture = closePendingRendererSystemOwnership;
  const captureMicrophone = args.captureMicrophone !== false;
  const captureSystemAudio = args.captureSystemAudio !== false;
  const micOnly = args.micOnly ?? !captureSystemAudio;

  const initialEnabled =
    args.diarizationEnabled ??
    (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ??
    true;
  const initialCount = Math.max(
    1,
    Math.min(MAX_SPEAKER_COUNT, args.expectedCount ?? DEFAULT_EXPECTED_SPEAKER_COUNT)
  );

  const systemAudioAccessPromise = !captureSystemAudio
    ? Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS)
    : (window.electronAPI?.checkSystemAudioAccess?.() ??
      Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS));

  logger.info("Meeting transcription starting...", {}, "meeting");
  const seed = args.seedSegments ?? [];
  const locks = new Map<string, string>();
  let maxSpeakerIndex = -1;
  for (const s of seed) {
    const idx = getSpeakerNumericIndex(s.speaker);
    if (idx != null && idx > maxSpeakerIndex) maxSpeakerIndex = idx;
    if (s.speakerLocked && s.speaker && s.speakerName) {
      locks.set(s.speaker, s.speakerName);
    }
  }

  segmentsRefValue = seed;
  speakerIdentifications = [];
  nextPlaceholderSpeakerIndex = maxSpeakerIndex + 1;
  recentSystemSpeaker = null;
  speakerLocks = locks;
  systemPartialSpeakerIdValue = null;

  useMeetingRecordingStore.setState({
    isRecording: true,
    isTranscribing: true,
    recordingNoteId: args.noteId,
    recordingNoteTitle: args.noteTitle,
    recordingFolderId: args.folderId,
    sessionDiarizationEnabled: initialEnabled,
    sessionExpectedCount: initialCount,
    userTouchedStepper: args.expectedCount != null,
    segments: seed,
    transcript: buildTranscriptText(seed),
    micPartial: "",
    systemPartial: "",
    systemPartialSpeakerId: null,
    systemPartialSpeakerName: null,
    diarizationSessionId: null,
    error: null,
    currentMicLevel: 0,
    currentSystemLevel: 0,
    activeMicLabel: null,
    micFallbackActive: false,
    micRecoveryStatus: "idle",
    micRecoveryAttempt: 0,
    captureSourceStates: {
      mic: captureMicrophone ? "checking" : "idle",
      system: captureSystemAudio ? "checking" : "idle",
    },
  });

  isRecordingFlag = true;
  meetingInputRejected = false;

  if (preparePromise) {
    if (
      shouldAwaitRendererPrepare({
        startMicOnly: micOnly,
        prepareMicOnly,
      })
    ) {
      logger.debug("Waiting for compatible in-flight prepare to finish...", {}, "meeting");
      try {
        await Promise.race([preparePromise, captureSetupCancellation]);
      } catch (error) {
        if (isCurrentCaptureAttempt()) throw error;
        return;
      }
      if (!isCurrentCaptureAttempt()) return;
    } else {
      prepareGeneration += 1;
      preparePromise = null;
      prepareMicOnly = null;
      isPrepared = false;
      preparedMicOnly = null;
    }
  }
  if (micOnly && preparedMicOnly !== true) {
    isPrepared = false;
  }

  type MainManagedSystemStateEvent = {
    source: "system";
    state: "unavailable" | "recording";
    reason:
      | "system-capture-error"
      | "system-capture-restored"
      | "system-recovery-buffer-overflow"
      | "system-recovery-delivery-failed";
    inputGeneration: string;
  };
  let acceptedSourceStateGeneration: string | null = null;
  let sourceStateHandledInMain: boolean | null = null;
  const pendingMainManagedSystemStates = new Map<string, MainManagedSystemStateEvent>();
  let mainManagedSystemUnavailable = false;
  const applyMainManagedSystemState = (payload: MainManagedSystemStateEvent) => {
    if (
      sourceStateHandledInMain !== true ||
      payload.inputGeneration !== acceptedSourceStateGeneration ||
      !isCurrentCaptureAttempt() ||
      !isRecordingFlag
    ) {
      return;
    }
    const currentState = useMeetingRecordingStore.getState();
    if (payload.state === "recording") {
      mainManagedSystemUnavailable = false;
      useMeetingRecordingStore.setState({
        error: currentState.error === "System audio capture stopped." ? null : currentState.error,
        captureSourceStates: {
          ...currentState.captureSourceStates,
          system: "recording",
        },
      });
      return;
    }
    mainManagedSystemUnavailable = true;
    useMeetingRecordingStore.setState({
      error: "System audio capture stopped.",
      currentSystemLevel: 0,
      captureSourceStates: {
        ...currentState.captureSourceStates,
        system: "unavailable",
      },
    });
  };
  const earlySourceStateCleanup = window.electronAPI?.onMeetingTranscriptionSourceState?.(
    (payload) => {
      if (
        payload.source !== "system" ||
        (payload.state !== "unavailable" && payload.state !== "recording") ||
        !isCurrentCaptureAttempt() ||
        !isRecordingFlag
      ) {
        return;
      }
      if (acceptedSourceStateGeneration === null || sourceStateHandledInMain === null) {
        pendingMainManagedSystemStates.set(payload.inputGeneration, payload);
        if (pendingMainManagedSystemStates.size > 8) {
          const oldestGeneration = pendingMainManagedSystemStates.keys().next().value;
          if (oldestGeneration !== undefined) {
            pendingMainManagedSystemStates.delete(oldestGeneration);
          }
        }
        return;
      }
      applyMainManagedSystemState(payload);
    }
  );
  let sourceStateCleanupTransferred = false;

  try {
    const startTime = performance.now();
    const resolvedSystemAudioAccess = await Promise.race([
      systemAudioAccessPromise,
      captureSetupCancellation,
    ]);
    if (!isCurrentCaptureAttempt()) return;
    const initialSystemAudioAccess = resolvedSystemAudioAccess ?? getFallbackSystemAudioAccess();
    const { initialSystemAudioStrategy, initialDisplayCaptureStrategy, systemCapturePromise } =
      !captureSystemAudio
        ? {
            initialSystemAudioStrategy: "unsupported" as const,
            initialDisplayCaptureStrategy: null,
            systemCapturePromise: Promise.resolve({ stream: null, error: null }),
          }
        : prepareMeetingSystemAudioCapture(initialSystemAudioAccess);
    const trackedSystemCapturePromise = systemCapturePromise.then((result) => {
      claimPendingRendererSystemStream(result.stream);
      return result;
    });
    let micFailureCode: "MIC_PERMISSION" | "MIC_DISCONNECTED" | null = null;
    let usedDefaultMicFallback = false;
    let actualMicStrategy: string | null =
      args.micDeviceIdOverride === null
        ? "system-default"
        : (args.powerRestorations?.mic?.strategy ?? "physical");

    const [startResult, micResult, initialSystemCaptureResult] = await Promise.race([
      Promise.all([
        window.electronAPI?.meetingTranscriptionStart?.({
          ...getMeetingTranscriptionOptions(args.forceLocalTranscription === true, args),
          noteId: args.noteId ?? null,
          micOnly,
          jarvisSessionId: args.jarvisSessionId ?? null,
        }),
        (captureMicrophone
          ? getMeetingMicConstraints(args.micDeviceIdOverride).then(async (constraints) => {
              if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
              try {
                const initialMicStream = await navigator.mediaDevices.getUserMedia(constraints);
                if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
                  stopMediaStream(initialMicStream);
                  return null;
                }
                if (!micOnly) return initialMicStream;

                const recoveredMicStream = await reacquireIfDead(
                  initialMicStream,
                  () => Promise.resolve(constraints),
                  logger
                );
                if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
                  stopMediaStream(recoveredMicStream);
                  return null;
                }
                const recoveredTrack = recoveredMicStream.getAudioTracks()[0];
                if (
                  !recoveredTrack ||
                  recoveredTrack.readyState === "ended" ||
                  recoveredTrack.muted
                ) {
                  micFailureCode = "MIC_DISCONNECTED";
                  stopMediaStream(recoveredMicStream);
                  return null;
                }
                return recoveredMicStream;
              } catch (err) {
                if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
                const hasExactDevice =
                  typeof constraints.audio === "object" &&
                  constraints.audio !== null &&
                  "deviceId" in constraints.audio;
                if (hasExactDevice && micOnly) {
                  if (["NotAllowedError", "SecurityError"].includes((err as Error).name)) {
                    micFailureCode = "MIC_PERMISSION";
                    return null;
                  }

                  const selectedDeviceId =
                    args.micDeviceIdOverride !== undefined
                      ? args.micDeviceIdOverride
                      : getSettings().selectedMicDeviceId || null;
                  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
                  if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
                  const candidates = orderMicrophoneRecoveryCandidates(
                    devices,
                    selectedDeviceId
                  ).filter((candidate) => candidate.deviceId !== selectedDeviceId);
                  for (const candidate of candidates) {
                    if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
                    try {
                      const candidateStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                          deviceId: { exact: candidate.deviceId },
                          ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
                        },
                      });
                      if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
                        stopMediaStream(candidateStream);
                        return null;
                      }
                      const candidateTrack = candidateStream.getAudioTracks()[0];
                      if (
                        candidateTrack &&
                        candidateTrack.readyState === "live" &&
                        !candidateTrack.muted &&
                        !isDeniedAutomaticMicrophone(candidateTrack.label)
                      ) {
                        usedDefaultMicFallback = true;
                        actualMicStrategy = "physical";
                        logger.info(
                          "Selected Jarvis microphone unavailable; using physical fallback",
                          { label: candidate.label },
                          "meeting"
                        );
                        return candidateStream;
                      }
                      stopMediaStream(candidateStream);
                    } catch (candidateError) {
                      logger.info(
                        "Initial Jarvis physical microphone fallback unavailable",
                        {
                          candidateLabel: candidate.label,
                          errorName:
                            candidateError instanceof Error ? candidateError.name : "UnknownError",
                        },
                        "meeting"
                      );
                    }
                  }

                  try {
                    if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
                    const fallbackStream = await navigator.mediaDevices.getUserMedia({
                      audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
                    });
                    if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
                      stopMediaStream(fallbackStream);
                      return null;
                    }
                    const fallbackTrack = fallbackStream.getAudioTracks()[0];
                    if (
                      !fallbackTrack ||
                      fallbackTrack.readyState !== "live" ||
                      fallbackTrack.muted ||
                      isDeniedAutomaticMicrophone(fallbackTrack.label)
                    ) {
                      stopMediaStream(fallbackStream);
                      micFailureCode = "MIC_DISCONNECTED";
                      return null;
                    }
                    usedDefaultMicFallback = true;
                    actualMicStrategy = "system-default";
                    logger.info(
                      "Selected Jarvis microphone unavailable; using system default",
                      { errorCode: "MIC_DISCONNECTED" },
                      "meeting"
                    );
                    return fallbackStream;
                  } catch {
                    micFailureCode = "MIC_DISCONNECTED";
                    return null;
                  }
                }
                if (hasExactDevice) {
                  try {
                    if (!isCurrentCaptureAttempt() || !isRecordingFlag) return null;
                    const fallbackStream = await navigator.mediaDevices.getUserMedia({
                      audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
                    });
                    if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
                      stopMediaStream(fallbackStream);
                      return null;
                    }
                    logger.info(
                      "Meeting mic capture recovered using default device",
                      { error: (err as Error).message },
                      "meeting"
                    );
                    return fallbackStream;
                  } catch (fallbackErr) {
                    logger.error(
                      "Meeting mic capture failed, continuing with system audio only",
                      { error: (fallbackErr as Error).message },
                      "meeting"
                    );
                    return null;
                  }
                }
                logger.error(
                  "Meeting mic capture failed, continuing with system audio only",
                  { error: (err as Error).message, constraints },
                  "meeting"
                );
                if (micOnly) {
                  micFailureCode = ["NotAllowedError", "SecurityError"].includes(
                    (err as Error).name
                  )
                    ? "MIC_PERMISSION"
                    : "MIC_DISCONNECTED";
                }
                return null;
              }
            })
          : Promise.resolve(null)
        ).then((stream) => {
          claimPendingMicrophoneStream(stream);
          return stream;
        }),
        trackedSystemCapturePromise,
      ]),
      captureSetupCancellation,
    ]);
    let systemCaptureResult = initialSystemCaptureResult;

    const streamsMs = performance.now() - startTime;
    if (!isCurrentCaptureAttempt() || !isRecordingFlag) {
      logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
      stopMediaStream(micResult);
      releasePendingRendererSystemStream();
      return;
    }

    if (
      !startResult?.success ||
      typeof startResult.inputGeneration !== "string" ||
      startResult.inputGeneration.length === 0
    ) {
      logger.error(
        "Meeting transcription IPC start failed",
        { error: startResult?.error ?? "Missing meeting input generation" },
        "meeting"
      );
      useMeetingRecordingStore.setState({
        error:
          startResult?.error ||
          (startResult?.success
            ? "Meeting transcription input binding failed"
            : "Failed to start meeting transcription"),
        isRecording: false,
        isTranscribing: false,
      });
      stopMediaStream(micResult);
      releasePendingRendererSystemStream();
      isRecordingFlag = false;
      isStartingFlag = false;
      return;
    }
    const inputGeneration = startResult.inputGeneration;
    acceptedMainInputGeneration = inputGeneration;
    activeMeetingInputGeneration = inputGeneration;
    activeJarvisSessionBinding = jarvisSessionBinding;
    acceptedSourceStateGeneration = inputGeneration;
    const isCurrentInput = () =>
      isCurrentCaptureAttempt() &&
      isRecordingFlag &&
      !meetingInputRejected &&
      activeMeetingInputGeneration === inputGeneration;

    const systemAudioMode = startResult.systemAudioMode || initialSystemAudioAccess.mode;
    const systemAudioStrategy = startResult.systemAudioStrategy || initialSystemAudioStrategy;
    systemCaptureResult = await ensureRendererSystemAudioCapture({
      initialDisplayCaptureStrategy,
      systemAudioStrategy,
      systemCaptureResult,
    });
    claimPendingRendererSystemStream(systemCaptureResult.stream);
    if (
      !isCurrentCaptureAttempt() ||
      !isRecordingFlag ||
      activeMeetingInputGeneration !== inputGeneration
    ) {
      stopMediaStream(micResult);
      releasePendingRendererSystemStream();
      return;
    }
    const systemAudioHandledInMain =
      systemAudioMode !== "unsupported" && !isRendererSystemAudioStrategy(systemAudioStrategy);
    if (systemAudioHandledInMain && systemCaptureResult.stream) {
      releasePendingRendererSystemStream();
      systemCaptureResult = { stream: null, error: null };
    }
    const systemCaptureError = systemAudioHandledInMain ? null : systemCaptureResult.error;

    const sourceStates: JarvisCaptureSourceStates = {
      mic: captureMicrophone ? (micResult ? "ready" : "unavailable") : "idle",
      system: captureSystemAudio
        ? systemAudioHandledInMain || systemCaptureResult.stream
          ? "ready"
          : "unavailable"
        : "idle",
    };
    useMeetingRecordingStore.setState({ captureSourceStates: sourceStates });
    sourceStateHandledInMain = systemAudioHandledInMain;
    const pendingState = pendingMainManagedSystemStates.get(inputGeneration);
    pendingMainManagedSystemStates.clear();
    if (pendingState) {
      applyMainManagedSystemState(pendingState);
    }
    if (mainManagedSystemUnavailable) sourceStates.system = "unavailable";

    const missingRequiredSource =
      (captureMicrophone && !micResult) ||
      (captureSystemAudio &&
        (systemAudioHandledInMain ? mainManagedSystemUnavailable : !systemCaptureResult.stream));
    if (args.requireAllSources && missingRequiredSource) {
      logger.warn("Meeting transcription required capture source unavailable", {}, "meeting");
      activeMeetingInputGeneration = null;
      isRecordingFlag = false;
      stopMediaStream(micResult);
      releasePendingRendererSystemStream();
      useMeetingRecordingStore.setState({
        error: "capture_source_unavailable",
        isRecording: false,
        isTranscribing: false,
      });
      throw new CaptureSourcesUnavailableError(sourceStates);
    }

    if (
      captureMicrophone &&
      !micResult &&
      (systemAudioHandledInMain || systemCaptureResult.stream)
    ) {
      useMeetingRecordingStore.setState({
        error: "Microphone capture failed. Continuing with system audio only.",
      });
    }

    if (
      !micResult &&
      !systemCaptureResult.stream &&
      (!systemAudioHandledInMain || mainManagedSystemUnavailable)
    ) {
      logger.error("Meeting transcription has no available audio source", {}, "meeting");
      useMeetingRecordingStore.setState({
        error:
          micFailureCode ??
          (systemAudioMode === "unsupported"
            ? "No microphone is available and system audio capture is unsupported on this device."
            : systemCaptureError?.message ||
              "No microphone is available and system audio capture could not be started."),
        isRecording: false,
        isTranscribing: false,
      });
      await window.electronAPI?.meetingTranscriptionStop?.();
      isRecordingFlag = false;
      isStartingFlag = false;
      return;
    }

    if (earlySourceStateCleanup) {
      ipcCleanups.push(earlySourceStateCleanup);
      sourceStateCleanupTransferred = true;
    }

    const segmentCleanup = window.electronAPI?.onMeetingTranscriptionSegment?.(
      (data: {
        text: string;
        source: "mic" | "system";
        type: "partial" | "final" | "retract" | "correction";
        originalText?: string;
        timestamp?: number;
        startedAt?: number;
        endedAt?: number;
        confidence?: number;
        echoScore?: number | null;
      }) => {
        if (data.type === "correction") {
          const current = useMeetingRecordingStore.getState().segments;
          let changed = false;
          const next = current.map((segment) => {
            if (
              segment.source !== data.source ||
              segment.timestamp !== data.timestamp ||
              segment.text !== data.originalText
            ) {
              return segment;
            }
            changed = true;
            return normalizeTranscriptSegment({
              ...segment,
              originalText: segment.text,
              text: data.text,
              confidence: data.confidence ?? segment.confidence,
              revisionSource: "openai_correction",
            });
          });
          if (changed) {
            segmentsRefValue = next;
            useMeetingRecordingStore.setState({
              segments: next,
              transcript: buildTranscriptText(next),
            });
          }
          return;
        }

        if (data.type === "retract") {
          const next = useMeetingRecordingStore
            .getState()
            .segments.filter(
              (seg) =>
                !(
                  seg.source === data.source &&
                  seg.timestamp === data.timestamp &&
                  seg.text === data.text
                )
            );
          segmentsRefValue = next;
          useMeetingRecordingStore.setState({
            segments: next,
            transcript: buildTranscriptText(next),
          });
          return;
        }

        if (data.type === "partial") {
          if (data.source === "mic") {
            useMeetingRecordingStore.setState({ micPartial: data.text });
          } else {
            useMeetingRecordingStore.setState({ systemPartial: data.text });
            if (!systemPartialSpeakerIdValue) {
              // Reuse the recent system speaker before minting — the partial id is
              // cleared after every final, so always minting spawned one per utterance.
              const carried = getRecentSystemSpeaker(Date.now());
              setSystemPartialSpeakerIdentity(
                carried?.speakerId ?? mintPlaceholderSpeakerId(),
                carried?.speakerName ?? null
              );
            }
          }
          return;
        }

        commitFinalSegment(data);
      }
    );
    if (segmentCleanup) ipcCleanups.push(segmentCleanup);

    const speakerCleanup = window.electronAPI?.onMeetingSpeakerIdentified?.((data) => {
      reserveSpeakerIndex(data.speakerId);
      setSystemPartialSpeakerIdentity(data.speakerId, data.displayName ?? null);
      rememberSystemSpeaker(data.speakerId, data.displayName ?? null, false, data.endTime);
      speakerIdentifications = [
        ...speakerIdentifications.filter(
          (id) => id.endTime >= data.endTime - SPEAKER_IDENTIFICATION_RETENTION_MS
        ),
        data,
      ];
      const next = useMeetingRecordingStore
        .getState()
        .segments.map((segment) => applySpeakerIdentification(segment, data));
      segmentsRefValue = next;
      useMeetingRecordingStore.setState({ segments: next });
    });
    if (speakerCleanup) ipcCleanups.push(speakerCleanup);

    const mergeCleanup = window.electronAPI?.onMeetingSpeakersMerged?.((merges) => {
      let next = useMeetingRecordingStore.getState().segments;
      for (const { keep, remove, displayName } of merges) {
        next = next.map((seg) => {
          if (seg.speaker !== remove || seg.speakerLocked) return seg;
          return normalizeTranscriptSegment({
            ...seg,
            speaker: keep,
            speakerName: displayName ?? seg.speakerName,
          });
        });
      }
      segmentsRefValue = next;
      useMeetingRecordingStore.setState({ segments: next });

      for (const { keep, remove, displayName } of merges) {
        if (recentSystemSpeaker?.speakerId === remove) {
          recentSystemSpeaker.speakerId = keep;
          if (displayName) recentSystemSpeaker.speakerName = displayName;
        }

        for (const id of speakerIdentifications) {
          if (id.speakerId === remove) id.speakerId = keep;
        }

        const lockedName = speakerLocks.get(remove);
        if (lockedName) {
          speakerLocks.set(keep, lockedName);
          speakerLocks.delete(remove);
        }
      }
    });
    if (mergeCleanup) ipcCleanups.push(mergeCleanup);

    const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
      useMeetingRecordingStore.setState({ error: err });
      logger.error("Meeting transcription stream error", { error: err }, "meeting");
    });
    if (errorCleanup) ipcCleanups.push(errorCleanup);

    const inputRejectedCleanup = window.electronAPI?.onMeetingTranscriptionInputRejected?.(
      ({ source, reason, inputGeneration: rejectedGeneration }) => {
        if (
          !isRecordingFlag ||
          meetingInputRejected ||
          activeMeetingInputGeneration !== inputGeneration ||
          rejectedGeneration !== inputGeneration
        ) {
          return;
        }
        meetingInputRejected = true;
        useMeetingRecordingStore.setState({
          error: "Jarvis stopped accepting audio evidence.",
        });
        logger.error("Meeting audio input rejected", { source, reason }, "meeting");
        void stopRecording({ throwOnError: false });
      }
    );
    if (inputRejectedCleanup) ipcCleanups.push(inputRejectedCleanup);

    const audioLevelCleanup = window.electronAPI?.onMeetingTranscriptionAudioLevel?.(
      ({ source, level, inputGeneration: levelGeneration }) => {
        if (
          source !== "system" ||
          levelGeneration !== inputGeneration ||
          activeMeetingInputGeneration !== inputGeneration ||
          !isCurrentInput()
        ) {
          return;
        }
        const normalizedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        useMeetingRecordingStore.setState({ currentSystemLevel: normalizedLevel });
        if (systemAudioLevelDecayTimer) clearTimeout(systemAudioLevelDecayTimer);
        systemAudioLevelDecayTimer = setTimeout(() => {
          systemAudioLevelDecayTimer = null;
          if (
            activeMeetingInputGeneration === inputGeneration &&
            isCurrentInput() &&
            useMeetingRecordingStore.getState().currentSystemLevel !== 0
          ) {
            useMeetingRecordingStore.setState({ currentSystemLevel: 0 });
          }
        }, 600);
      }
    );
    if (audioLevelCleanup) ipcCleanups.push(audioLevelCleanup);

    if (startResult.oneOnOneAttendee) {
      const synthetic: SpeakerIdentification = {
        speakerId: "speaker_0",
        displayName: startResult.oneOnOneAttendee.displayName,
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
      };
      reserveSpeakerIndex(synthetic.speakerId);
      setSystemPartialSpeakerIdentity(synthetic.speakerId, synthetic.displayName);
      rememberSystemSpeaker(synthetic.speakerId, synthetic.displayName, false, Date.now());
      speakerIdentifications.push(synthetic);
    }

    const pendingMicChunks: ArrayBuffer[] = [];
    const pendingSystemChunks: ArrayBuffer[] = [];
    let socketReady = false;

    const selectedMicDeviceId = getSettings().selectedMicDeviceId || null;
    let recoveryGeneration = 0;
    let recoveryPromise: Promise<void> | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveRecoveryDelay: (() => void) | null = null;
    let micEvidenceInterrupted = false;
    let pendingMicInterruption: JarvisSourceInterruptionInput | null = null;
    type MicRecoveryCandidateOwner = {
      stream: MediaStream;
      context: AudioContext | null;
      released: boolean;
      transferred: boolean;
      cancellation: Promise<void>;
      cancel: () => void;
      closePromise: Promise<void> | null;
    };
    let pendingMicRecoveryCandidate: MicRecoveryCandidateOwner | null = null;
    const closeMicRecoveryCandidateContext = (owner: MicRecoveryCandidateOwner): Promise<void> => {
      if (!owner.context) return Promise.resolve();
      if (!owner.closePromise) {
        owner.closePromise = closeAudioContextOnce(owner.context);
      }
      return owner.closePromise;
    };
    const releaseMicRecoveryCandidate = (
      owner: MicRecoveryCandidateOwner | null = pendingMicRecoveryCandidate
    ): Promise<void> => {
      if (!owner || owner.transferred) return Promise.resolve();
      if (!owner.released) {
        owner.released = true;
        owner.cancel();
        stopMediaStream(owner.stream);
      }
      if (pendingMicRecoveryCandidate === owner) pendingMicRecoveryCandidate = null;
      return closeMicRecoveryCandidateContext(owner);
    };
    const createMicRecoveryCandidate = (stream: MediaStream): MicRecoveryCandidateOwner => {
      void releaseMicRecoveryCandidate();
      let cancel!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const owner: MicRecoveryCandidateOwner = {
        stream,
        context: null,
        released: false,
        transferred: false,
        cancellation,
        cancel,
        closePromise: null,
      };
      pendingMicRecoveryCandidate = owner;
      return owner;
    };
    const transferMicRecoveryCandidate = (owner: MicRecoveryCandidateOwner): boolean => {
      if (owner.released || owner.transferred) return false;
      owner.transferred = true;
      if (pendingMicRecoveryCandidate === owner) pendingMicRecoveryCandidate = null;
      return true;
    };
    let rendererSystemInterrupted = false;
    let rendererSystemPersistenceGeneration = 0;
    let rendererSystemPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveRendererSystemPersistenceDelay: (() => void) | null = null;
    let rendererSystemPersistencePromise: Promise<boolean> | null = null;
    let beginRendererSystemRecovery: () => void = () => {};
    const notifySourceInterrupted = async (
      sourceType: "mic" | "system",
      reason: string,
      at = Date.now()
    ): Promise<boolean> => {
      if (!isCurrentInput()) return false;
      const jarvisSessionId = jarvisSessionBinding?.sessionId ?? null;
      if (!jarvisSessionId) return true;
      try {
        await window.electronAPI.jarvis.sourceInterrupted(jarvisSessionId, sourceType, {
          at,
          reason,
        });
        return isCurrentInput();
      } catch {
        logger.info("Jarvis source interruption persistence will retry", { sourceType }, "meeting");
        return false;
      }
    };
    const persistMicInterruption = async (reason: string): Promise<boolean> => {
      const payload = pendingMicInterruption ?? { at: Date.now(), reason };
      pendingMicInterruption = payload;
      const persisted = await notifySourceInterrupted("mic", payload.reason, payload.at);
      if (persisted) pendingMicInterruption = null;
      return persisted;
    };
    const waitForRendererSystemPersistenceDelay = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        resolveRendererSystemPersistenceDelay = resolve;
        rendererSystemPersistenceTimer = setTimeout(() => {
          rendererSystemPersistenceTimer = null;
          resolveRendererSystemPersistenceDelay = null;
          resolve();
        }, delayMs);
      });
    const cancelRendererSystemInterruptionPersistence = () => {
      rendererSystemPersistenceGeneration += 1;
      if (rendererSystemPersistenceTimer) clearTimeout(rendererSystemPersistenceTimer);
      rendererSystemPersistenceTimer = null;
      resolveRendererSystemPersistenceDelay?.();
      resolveRendererSystemPersistenceDelay = null;
    };
    cancelActiveRendererSystemInterruptionPersistence = cancelRendererSystemInterruptionPersistence;
    const persistRendererSystemInterruption = (reason: string): Promise<boolean> => {
      if (rendererSystemPersistencePromise) return rendererSystemPersistencePromise;
      if (rendererSystemInterrupted) return Promise.resolve(true);
      rendererSystemInterrupted = true;
      const generation = rendererSystemPersistenceGeneration;
      const interruptedAt = Date.now();
      const persistencePromise = (async () => {
        for (
          let attempt = 0;
          isCurrentInput() && generation === rendererSystemPersistenceGeneration;
          attempt += 1
        ) {
          if (attempt > 0) {
            await waitForRendererSystemPersistenceDelay(getMicrophoneRecoveryDelay(attempt));
          }
          if (!isCurrentInput() || generation !== rendererSystemPersistenceGeneration) return false;
          if (await notifySourceInterrupted("system", reason, interruptedAt)) return true;
        }
        return false;
      })();
      const trackedPersistencePromise = persistencePromise.finally(() => {
        if (rendererSystemPersistencePromise === trackedPersistencePromise) {
          rendererSystemPersistencePromise = null;
        }
      });
      rendererSystemPersistencePromise = trackedPersistencePromise;
      return rendererSystemPersistencePromise;
    };
    const notifyMicRestored = async (payload: JarvisSourceRestorationInput): Promise<boolean> => {
      if (!isCurrentInput()) return false;
      const jarvisSessionId = jarvisSessionBinding?.sessionId ?? null;
      if (!jarvisSessionId) return true;
      try {
        await window.electronAPI.jarvis.sourceRestored(jarvisSessionId, "mic", payload);
        return isCurrentInput();
      } catch {
        logger.info("Jarvis microphone restoration persistence will retry", {}, "meeting");
        return false;
      }
    };
    const sendMeetingChunk = (chunk: ArrayBuffer, source: "mic" | "system"): boolean => {
      if (
        !isRecordingFlag ||
        meetingInputRejected ||
        activeMeetingInputGeneration !== inputGeneration
      ) {
        return false;
      }
      window.electronAPI?.meetingTranscriptionSend?.(chunk, source, inputGeneration);
      return true;
    };
    const onMicChunk = (chunk: ArrayBuffer) => {
      if (!isRecordingFlag || meetingInputRejected) return;
      if (socketReady) {
        sendMeetingChunk(chunk, "mic");
        return;
      }
      pendingMicChunks.push(chunk.slice(0));
    };
    const onSystemChunk = (chunk: ArrayBuffer) => {
      if (!isCurrentInput()) return;
      if (socketReady) {
        sendMeetingChunk(chunk, "system");
        return;
      }
      pendingSystemChunks.push(chunk.slice(0));
    };

    let attachMicPipeline: (
      stream: MediaStream,
      fallbackActive: boolean,
      expectedRecoveryGeneration: number
    ) => Promise<boolean>;

    const activeMicLabel = (stream: MediaStream): string =>
      stream.getAudioTracks()[0]?.label?.trim() || "";
    const isUsableMicStream = (stream: MediaStream): boolean => {
      const streamTrack = stream.getAudioTracks()[0];
      return Boolean(streamTrack && streamTrack.readyState === "live" && !streamTrack.muted);
    };
    const isUsableSystemStream = (stream: MediaStream): boolean => {
      const streamTrack = stream.getAudioTracks()[0];
      return Boolean(
        streamTrack &&
        streamTrack.readyState === "live" &&
        !streamTrack.muted &&
        stream.active !== false
      );
    };
    type RendererSystemRecoveryCandidate = {
      stream: MediaStream;
      context: AudioContext | null;
      source: MediaStreamAudioSourceNode | null;
      processor: AudioWorkletNode | null;
      cancelled: boolean;
      transferred: boolean;
      cancellation: Promise<void>;
      cancel: () => void;
    };
    let rendererSystemRecoveryGeneration = 0;
    let rendererSystemRecoveryPromise: Promise<void> | null = null;
    let rendererSystemRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveRendererSystemRecoveryDelay: (() => void) | null = null;
    let rendererSystemRecoveryCandidate: RendererSystemRecoveryCandidate | null = null;
    const releaseRendererSystemRecoveryCandidate = async (
      candidate: RendererSystemRecoveryCandidate | null = rendererSystemRecoveryCandidate
    ): Promise<void> => {
      if (!candidate || candidate.transferred) return;
      if (!candidate.cancelled) {
        candidate.cancelled = true;
        candidate.cancel();
        candidate.processor && (candidate.processor.port.onmessage = null);
        candidate.processor?.disconnect();
        candidate.source?.disconnect();
        stopMediaStream(candidate.stream);
      }
      if (rendererSystemRecoveryCandidate === candidate) {
        rendererSystemRecoveryCandidate = null;
      }
      await closeAudioContextOnce(candidate.context);
    };
    const createRendererSystemRecoveryCandidate = (
      stream: MediaStream
    ): RendererSystemRecoveryCandidate => {
      void releaseRendererSystemRecoveryCandidate();
      let cancel!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const candidate: RendererSystemRecoveryCandidate = {
        stream,
        context: null,
        source: null,
        processor: null,
        cancelled: false,
        transferred: false,
        cancellation,
        cancel,
      };
      rendererSystemRecoveryCandidate = candidate;
      return candidate;
    };
    const waitForRendererSystemRecoveryDelay = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        if (delayMs === 0) {
          resolve();
          return;
        }
        resolveRendererSystemRecoveryDelay = resolve;
        rendererSystemRecoveryTimer = setTimeout(() => {
          rendererSystemRecoveryTimer = null;
          resolveRendererSystemRecoveryDelay = null;
          resolve();
        }, delayMs);
      });
    const cancelRendererSystemRecovery = () => {
      rendererSystemRecoveryGeneration += 1;
      if (rendererSystemRecoveryTimer) clearTimeout(rendererSystemRecoveryTimer);
      rendererSystemRecoveryTimer = null;
      resolveRendererSystemRecoveryDelay?.();
      resolveRendererSystemRecoveryDelay = null;
      void releaseRendererSystemRecoveryCandidate();
    };
    cancelActiveRendererSystemRecovery = cancelRendererSystemRecovery;
    const rendererSystemRecoveryIsCurrent = (generation: number) =>
      generation === rendererSystemRecoveryGeneration && isCurrentInput();
    const notifyRendererSystemRestored = async (
      payload: JarvisSourceRestorationInput,
      generation: number
    ): Promise<boolean> => {
      if (!rendererSystemRecoveryIsCurrent(generation)) return false;
      const jarvisSessionId = jarvisSessionBinding?.sessionId ?? null;
      if (!jarvisSessionId) return true;
      try {
        await window.electronAPI.jarvis.sourceRestored(jarvisSessionId, "system", payload);
        return rendererSystemRecoveryIsCurrent(generation);
      } catch {
        logger.info("Jarvis system restoration persistence will retry", {}, "meeting");
        return false;
      }
    };
    let rendererSystemLifecycleCleanup: (() => void) | null = null;
    const releaseRendererSystemLifecycle = () => {
      const cleanup = rendererSystemLifecycleCleanup;
      rendererSystemLifecycleCleanup = null;
      cleanup?.();
    };
    ipcCleanups.push(releaseRendererSystemLifecycle);
    const bindRendererSystemLifecycle = (stream: MediaStream) => {
      releaseRendererSystemLifecycle();
      const track = stream.getAudioTracks()[0];
      const markRendererSystemUnavailable = () => {
        if (!isCurrentInput() || systemStream !== stream) return;
        useMeetingRecordingStore.setState({
          error: "System audio capture stopped. Reconnecting.",
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            system: "recovering",
          },
        });
        void persistRendererSystemInterruption("system-renderer-ended").then((persisted) => {
          if (persisted && isCurrentInput()) beginRendererSystemRecovery();
        });
      };
      track?.addEventListener("ended", markRendererSystemUnavailable);
      stream.addEventListener("inactive", markRendererSystemUnavailable);
      let released = false;
      rendererSystemLifecycleCleanup = () => {
        if (released) return;
        released = true;
        track?.removeEventListener("ended", markRendererSystemUnavailable);
        stream.removeEventListener("inactive", markRendererSystemUnavailable);
      };
    };
    const recoverRendererSystemOnce = async (generation: number): Promise<boolean> => {
      if (!isRendererSystemAudioStrategy(systemAudioStrategy)) return true;
      const displayMode = getDisplayCaptureModeForStrategy(systemAudioStrategy);
      const result = await requestSystemAudioDisplayStream(displayMode);
      if (!rendererSystemRecoveryIsCurrent(generation)) {
        stopMediaStream(result.stream);
        return true;
      }
      if (!result.stream || !isUsableSystemStream(result.stream)) {
        stopMediaStream(result.stream);
        return false;
      }

      const candidate = createRendererSystemRecoveryCandidate(result.stream);
      const candidateTrack = candidate.stream.getAudioTracks()[0];
      const restorationPayload: JarvisSourceRestorationInput = {
        at: Date.now(),
        deviceId: candidateTrack?.getSettings().deviceId || null,
        deviceLabel: candidateTrack?.label?.trim() || null,
        strategy: systemAudioStrategy,
      };
      let restored = false;
      for (
        let persistenceAttempt = 0;
        rendererSystemRecoveryIsCurrent(generation) && !candidate.cancelled;
        persistenceAttempt += 1
      ) {
        if (persistenceAttempt > 0) {
          await waitForRendererSystemRecoveryDelay(getMicrophoneRecoveryDelay(persistenceAttempt));
        }
        if (
          !rendererSystemRecoveryIsCurrent(generation) ||
          candidate.cancelled ||
          !isUsableSystemStream(candidate.stream)
        ) {
          break;
        }
        restored = await notifyRendererSystemRestored(restorationPayload, generation);
        if (restored) break;
      }
      if (!restored) {
        await releaseRendererSystemRecoveryCandidate(candidate);
        return !rendererSystemRecoveryIsCurrent(generation);
      }

      const candidateChunks: ArrayBuffer[] = [];
      let candidateCommitted = false;
      try {
        const context = new AudioContext({ sampleRate: 24000 });
        candidate.context = context;
        await Promise.race([detachFromOutputDevice(context), candidate.cancellation]);
        if (candidate.cancelled || !rendererSystemRecoveryIsCurrent(generation)) {
          await releaseRendererSystemRecoveryCandidate(candidate);
          return true;
        }
        const { source, processor } = await createAudioPipeline({
          stream: candidate.stream,
          context,
          onChunk: (chunk) => {
            if (candidateCommitted) onSystemChunk(chunk);
            else candidateChunks.push(chunk);
          },
          cancellation: candidate.cancellation,
          isCancelled: () => candidate.cancelled || !rendererSystemRecoveryIsCurrent(generation),
        });
        candidate.source = source;
        candidate.processor = processor;
        if (
          candidate.cancelled ||
          !rendererSystemRecoveryIsCurrent(generation) ||
          !isUsableSystemStream(candidate.stream)
        ) {
          throw new Error("SYSTEM_RECOVERY_PIPELINE_UNAVAILABLE");
        }

        const oldProcessor = systemProcessor;
        const oldSource = systemSource;
        const oldStream = systemStream;
        const oldContext = systemContext;
        releaseRendererSystemLifecycle();
        await flushAndDisconnectProcessor(oldProcessor);
        oldSource?.disconnect();
        if (oldStream && oldStream !== candidate.stream) stopMediaStream(oldStream);
        if (oldContext && oldContext !== context) await closeAudioContextOnce(oldContext);

        if (
          candidate.cancelled ||
          !rendererSystemRecoveryIsCurrent(generation) ||
          !isUsableSystemStream(candidate.stream)
        ) {
          throw new Error("SYSTEM_RECOVERY_PIPELINE_UNAVAILABLE");
        }
        candidate.transferred = true;
        if (rendererSystemRecoveryCandidate === candidate) rendererSystemRecoveryCandidate = null;
        systemStream = candidate.stream;
        systemContext = context;
        systemSource = source;
        systemProcessor = processor;
        bindRendererSystemLifecycle(candidate.stream);
        for (const chunk of candidateChunks) onSystemChunk(chunk);
        candidateChunks.length = 0;
        candidateCommitted = true;
        rendererSystemInterrupted = false;
        useMeetingRecordingStore.setState({
          error: null,
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            system: "recording",
          },
        });
        return true;
      } catch (error) {
        candidateChunks.length = 0;
        await releaseRendererSystemRecoveryCandidate(candidate);
        if (!rendererSystemRecoveryIsCurrent(generation)) return true;
        rendererSystemInterrupted = false;
        const interrupted = await persistRendererSystemInterruption(
          "system-renderer-pipeline-attach-failed"
        );
        logger.info(
          "Jarvis system recovery pipeline unavailable",
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "meeting"
        );
        return !interrupted;
      }
    };
    beginRendererSystemRecovery = () => {
      if (!isCurrentInput() || rendererSystemRecoveryPromise) return;
      const generation = rendererSystemRecoveryGeneration;
      const recoveryPromise = (async () => {
        for (let attempt = 0; rendererSystemRecoveryIsCurrent(generation); attempt += 1) {
          await waitForRendererSystemRecoveryDelay(getMicrophoneRecoveryDelay(attempt));
          if (!rendererSystemRecoveryIsCurrent(generation)) return;
          if (await recoverRendererSystemOnce(generation)) return;
        }
      })();
      const trackedRecoveryPromise = recoveryPromise.finally(() => {
        if (rendererSystemRecoveryPromise === trackedRecoveryPromise) {
          rendererSystemRecoveryPromise = null;
        }
      });
      rendererSystemRecoveryPromise = trackedRecoveryPromise;
    };
    const recoveryLog = (error: unknown, candidate?: MicrophoneRecoveryCandidate) => ({
      attempt: useMeetingRecordingStore.getState().micRecoveryAttempt,
      candidateLabel: candidate?.label ?? "system-default",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    const waitForRecoveryDelay = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        if (delayMs === 0) {
          resolve();
          return;
        }
        resolveRecoveryDelay = resolve;
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          resolveRecoveryDelay = null;
          resolve();
        }, delayMs);
      });
    const cancelRecovery = () => {
      recoveryGeneration += 1;
      void releaseMicRecoveryCandidate();
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      resolveRecoveryDelay?.();
      resolveRecoveryDelay = null;
      useMeetingRecordingStore.setState({
        micRecoveryStatus: "idle",
        micRecoveryAttempt: 0,
      });
    };
    cancelActiveMicRecovery = cancelRecovery;

    const acquireRecoveryStream = async (
      expectedRecoveryGeneration: number
    ): Promise<MediaStream | null> => {
      const recoveryIsCurrent = () =>
        isRecordingFlag && expectedRecoveryGeneration === recoveryGeneration && isCurrentInput();
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!recoveryIsCurrent()) return null;
      const candidates = orderMicrophoneRecoveryCandidates(devices, selectedMicDeviceId);
      for (const candidate of candidates) {
        if (!recoveryIsCurrent()) return null;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: candidate.deviceId },
              ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
            },
          });
          if (!recoveryIsCurrent()) {
            stopMediaStream(stream);
            return null;
          }
          if (isUsableMicStream(stream) && !isDeniedAutomaticMicrophone(activeMicLabel(stream))) {
            return stream;
          }
          stopMediaStream(stream);
        } catch (error) {
          logger.info(
            "Jarvis microphone recovery candidate unavailable",
            recoveryLog(error, candidate),
            "meeting"
          );
        }
      }

      try {
        if (!recoveryIsCurrent()) return null;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
        });
        if (!recoveryIsCurrent()) {
          stopMediaStream(stream);
          return null;
        }
        if (isUsableMicStream(stream) && !isDeniedAutomaticMicrophone(activeMicLabel(stream))) {
          return stream;
        }
        stopMediaStream(stream);
      } catch (error) {
        logger.info(
          "Jarvis default microphone recovery unavailable",
          recoveryLog(error),
          "meeting"
        );
      }
      return null;
    };

    const beginMicRecovery = () => {
      if (!isRecordingFlag || recoveryPromise) return;
      const generation = recoveryGeneration;
      recoveryPromise = (async () => {
        for (let attempt = 0; isRecordingFlag && generation === recoveryGeneration; attempt += 1) {
          useMeetingRecordingStore.setState({
            activeMicLabel: null,
            currentMicLevel: 0,
            error: null,
            micFallbackActive: true,
            micRecoveryStatus: "reconnecting",
            micRecoveryAttempt: attempt + 1,
            captureSourceStates: {
              ...useMeetingRecordingStore.getState().captureSourceStates,
              mic: "recovering",
            },
          });
          if (!micEvidenceInterrupted) {
            micEvidenceInterrupted = await persistMicInterruption("mic-track-ended");
            if (!micEvidenceInterrupted) {
              await waitForRecoveryDelay(getMicrophoneRecoveryDelay(attempt));
              continue;
            }
          }
          await waitForRecoveryDelay(getMicrophoneRecoveryDelay(attempt));
          if (!isRecordingFlag || generation !== recoveryGeneration) return;

          const replacement = await acquireRecoveryStream(generation);
          if (!replacement) continue;
          if (!isRecordingFlag || generation !== recoveryGeneration) {
            stopMediaStream(replacement);
            return;
          }
          const recoveryOwner = createMicRecoveryCandidate(replacement);

          try {
            const replacementTrack = replacement.getAudioTracks()[0];
            if (!replacementTrack) {
              stopMediaStream(replacement);
              continue;
            }
            const replacementDeviceId = replacementTrack.getSettings().deviceId || null;
            const restorationPayload: JarvisSourceRestorationInput = {
              at: Date.now(),
              deviceId: replacementDeviceId,
              deviceLabel: replacementTrack.label?.trim() || null,
              strategy: "web-audio",
            };
            let restorationPersisted = false;
            for (
              let persistenceAttempt = 0;
              isRecordingFlag && generation === recoveryGeneration && isCurrentInput();
              persistenceAttempt += 1
            ) {
              if (persistenceAttempt > 0) {
                await waitForRecoveryDelay(getMicrophoneRecoveryDelay(persistenceAttempt));
              }
              if (!isRecordingFlag || generation !== recoveryGeneration || !isCurrentInput()) break;
              restorationPersisted = await notifyMicRestored(restorationPayload);
              if (restorationPersisted) break;
            }
            if (!restorationPersisted) {
              await releaseMicRecoveryCandidate(recoveryOwner);
              return;
            }
            micEvidenceInterrupted = false;
            const attached = await attachMicPipeline(
              replacement,
              !selectedMicDeviceId || replacementDeviceId !== selectedMicDeviceId,
              generation
            );
            if (!attached) return;
            if (
              generation !== recoveryGeneration ||
              !isCurrentInput() ||
              micStream !== replacement
            ) {
              if (micStream === replacement) stopMediaStream(replacement);
              return;
            }
            useMeetingRecordingStore.setState({
              micRecoveryStatus: "restored",
              micRecoveryAttempt: 0,
              captureSourceStates: {
                ...useMeetingRecordingStore.getState().captureSourceStates,
                mic: "recording",
              },
            });
            logger.info(
              "Jarvis microphone recovered",
              { label: activeMicLabel(replacement) },
              "meeting"
            );
            return;
          } catch (error) {
            await releaseMicRecoveryCandidate(recoveryOwner);
            micEvidenceInterrupted = await persistMicInterruption("mic-pipeline-attach-failed");
            logger.info(
              "Jarvis microphone recovery pipeline unavailable",
              recoveryLog(error),
              "meeting"
            );
          }
        }
      })().finally(() => {
        recoveryPromise = null;
        if (
          isRecordingFlag &&
          micStream?.getAudioTracks()[0]?.readyState === "ended" &&
          recoveryGeneration === generation
        ) {
          beginMicRecovery();
        }
      });
    };

    attachMicPipeline = async (stream, fallbackActive, expectedRecoveryGeneration) => {
      const track = stream.getAudioTracks()[0];
      const recoveryOwner =
        pendingMicRecoveryCandidate?.stream === stream ? pendingMicRecoveryCandidate : null;
      const initialOwner = !recoveryOwner && pendingMicrophoneStream === stream;
      if (!isUsableMicStream(stream)) {
        if (recoveryOwner) {
          await releaseMicRecoveryCandidate(recoveryOwner);
        } else {
          stopMediaStream(stream);
        }
        throw new Error("MIC_DISCONNECTED");
      }

      const candidateChunks: ArrayBuffer[] = [];
      let candidateCommitted = false;
      const onCandidateChunk = (chunk: ArrayBuffer) => {
        if (candidateCommitted) {
          onMicChunk(chunk);
          return;
        }
        candidateChunks.push(chunk);
      };
      let ctx: AudioContext | null = null;
      let pipeline: {
        source: MediaStreamAudioSourceNode;
        processor: AudioWorkletNode;
        analyser: AnalyserNode;
      } | null = null;
      try {
        ctx = new AudioContext({ sampleRate: 24000 });
        if (recoveryOwner) recoveryOwner.context = ctx;
        if (initialOwner) claimPendingMicrophoneContext(ctx);
        const detachPromise = detachFromOutputDevice(ctx);
        if (recoveryOwner) {
          await Promise.race([detachPromise, recoveryOwner.cancellation]);
          if (recoveryOwner.released) throw new Error("MIC_RECOVERY_CANCELLED");
        } else if (initialOwner) {
          await awaitCaptureSetupStep(detachPromise);
        } else {
          await detachPromise;
        }
        const { source, processor } = await createAudioPipeline({
          stream,
          context: ctx,
          onChunk: onCandidateChunk,
          cancellation:
            recoveryOwner?.cancellation ?? (initialOwner ? captureSetupCancellation : undefined),
          isCancelled: recoveryOwner
            ? () => recoveryOwner.released
            : initialOwner
              ? () => !isCurrentCaptureAttempt()
              : undefined,
        });
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.4;
        const analyserSink = ctx.createGain();
        analyserSink.gain.value = 0;
        source.connect(analyser);
        analyser.connect(analyserSink);
        analyserSink.connect(ctx.destination);
        pipeline = { source, processor, analyser };
      } catch (error) {
        candidateChunks.length = 0;
        if (recoveryOwner) {
          await releaseMicRecoveryCandidate(recoveryOwner);
        } else {
          stopMediaStream(stream);
          await closeAudioContextOnce(ctx);
        }
        throw error;
      }
      if (!ctx || !pipeline) {
        if (recoveryOwner) {
          await releaseMicRecoveryCandidate(recoveryOwner);
        } else {
          stopMediaStream(stream);
          await closeAudioContextOnce(ctx);
        }
        throw new Error("MIC_PIPELINE_UNAVAILABLE");
      }
      const candidateContext = ctx;
      const { source, processor, analyser } = pipeline;
      const cleanupCandidate = async () => {
        await flushAndDisconnectProcessor(processor);
        candidateChunks.length = 0;
        source.disconnect();
        analyser.disconnect();
        if (recoveryOwner) {
          await releaseMicRecoveryCandidate(recoveryOwner);
        } else {
          stopMediaStream(stream);
          await closeAudioContextOnce(candidateContext);
        }
      };
      const recoveryIsCurrent = () =>
        expectedRecoveryGeneration === recoveryGeneration && isCurrentInput();
      let candidateIsUsable = isUsableMicStream(stream);
      if (!recoveryIsCurrent() || !candidateIsUsable) {
        await cleanupCandidate();
        if (!candidateIsUsable && recoveryIsCurrent()) throw new Error("MIC_DISCONNECTED");
        return false;
      }

      const oldProcessor = micProcessor;
      const oldSource = micSource;
      const oldAnalyser = micAnalyser;
      const oldStream = micStream;
      const oldContext = micContext;

      await flushAndDisconnectProcessor(oldProcessor);
      oldSource?.disconnect();
      oldAnalyser?.disconnect();
      if (oldStream && oldStream !== stream) stopMediaStream(oldStream);
      if (oldContext && oldContext !== candidateContext) {
        await oldContext.close().catch(() => undefined);
      }

      candidateIsUsable = isUsableMicStream(stream);
      if (!recoveryIsCurrent() || !candidateIsUsable) {
        await cleanupCandidate();
        if (!candidateIsUsable && recoveryIsCurrent()) throw new Error("MIC_DISCONNECTED");
        return false;
      }

      if (recoveryOwner && !transferMicRecoveryCandidate(recoveryOwner)) {
        await cleanupCandidate();
        return false;
      }
      if (initialOwner && !transferPendingMicrophoneCapture(stream, candidateContext)) {
        await cleanupCandidate();
        return false;
      }

      micProcessor = processor;
      micSource = source;
      micAnalyser = analyser;
      micStream = stream;
      micContext = candidateContext;

      useMeetingRecordingStore.setState({
        activeMicLabel: track?.label || null,
        micFallbackActive: fallbackActive,
        error: null,
      });

      if (captureMicrophone && track) {
        const onJarvisMicEnded = () => {
          if (!isCurrentInput() || micStream !== stream) return;
          beginMicRecovery();
        };
        track.addEventListener("ended", onJarvisMicEnded);
        ipcCleanups.push(() => track.removeEventListener("ended", onJarvisMicEnded));
      }

      for (const chunk of candidateChunks) onMicChunk(chunk);
      candidateChunks.length = 0;
      candidateCommitted = true;

      logger.info(
        "Mic capture started for meeting transcription",
        { fallbackActive, sampleRate: track?.getSettings().sampleRate ?? null },
        "meeting"
      );
      return true;
    };

    const throwPipelineFailure = (source: "mic" | "system", error: unknown): never => {
      const failedStates: JarvisCaptureSourceStates = {
        ...useMeetingRecordingStore.getState().captureSourceStates,
        [source]: "unavailable",
      };
      useMeetingRecordingStore.setState({ captureSourceStates: failedStates });
      if (args.requireAllSources) {
        useMeetingRecordingStore.setState({
          error: "capture_source_unavailable",
          isRecording: false,
          isTranscribing: false,
        });
        throw new CaptureSourcesUnavailableError(failedStates);
      }
      throw error;
    };

    let initialMicNeedsRecovery = false;
    if (micResult) {
      const initialMicRecoveryGeneration = recoveryGeneration;
      try {
        const attached = await attachMicPipeline(
          micResult,
          usedDefaultMicFallback,
          initialMicRecoveryGeneration
        );
        if (
          !attached ||
          initialMicRecoveryGeneration !== recoveryGeneration ||
          !isCurrentInput() ||
          micStream !== micResult
        ) {
          return;
        }
      } catch (error) {
        if (!isCurrentInput()) return;
        const canContinueWithSystem =
          !args.requireAllSources &&
          (systemAudioHandledInMain || Boolean(systemCaptureResult.stream));
        if (
          error instanceof Error &&
          error.message === "MIC_DISCONNECTED" &&
          canContinueWithSystem
        ) {
          const interrupted = await notifySourceInterrupted("mic", "mic-pipeline-attach-failed");
          if (!interrupted || !isCurrentInput()) {
            if (!isCurrentInput()) return;
            throwPipelineFailure("mic", error);
          }
          micEvidenceInterrupted = true;
          initialMicNeedsRecovery = true;
          useMeetingRecordingStore.setState({
            activeMicLabel: null,
            currentMicLevel: 0,
            micFallbackActive: true,
            micRecoveryStatus: "reconnecting",
            micRecoveryAttempt: 0,
            error: "Microphone capture failed. Continuing with system audio only.",
            captureSourceStates: {
              ...useMeetingRecordingStore.getState().captureSourceStates,
              mic: "recovering",
            },
          });
        } else {
          throwPipelineFailure("mic", error);
        }
      }
      if (!initialMicNeedsRecovery) {
        useMeetingRecordingStore.setState({
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            mic: "recording",
          },
        });
      }
    }

    if (captureSystemAudio && systemAudioHandledInMain) {
      if (mainManagedSystemUnavailable) {
        const hasSurvivingMic =
          !initialMicNeedsRecovery && micStream !== null && isUsableMicStream(micStream);
        if (args.requireAllSources || !hasSurvivingMic) {
          throwPipelineFailure("system", new Error("SYSTEM_DISCONNECTED"));
        }
        useMeetingRecordingStore.setState({
          error: "System audio capture stopped.",
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            system: "unavailable",
          },
        });
      } else {
        useMeetingRecordingStore.setState({
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            system: "recording",
          },
        });
      }
    }

    if (systemCaptureResult.stream) {
      const stream = systemCaptureResult.stream;
      let attached = false;
      let candidateContext: AudioContext | null = null;
      let candidateSource: MediaStreamAudioSourceNode | null = null;
      let candidateProcessor: AudioWorkletNode | null = null;
      let candidateCleaned = false;
      const candidateChunks: ArrayBuffer[] = [];
      let candidateCommitted = false;
      let unavailableButContinuing = false;
      const onSystemCandidateChunk = (chunk: ArrayBuffer) => {
        if (candidateCommitted) {
          onSystemChunk(chunk);
          return;
        }
        candidateChunks.push(chunk);
      };
      const cleanupSystemCandidate = async () => {
        if (candidateCleaned) return;
        candidateCleaned = true;
        await flushAndDisconnectProcessor(candidateProcessor);
        candidateChunks.length = 0;
        candidateSource?.disconnect();
        if (pendingRendererSystemStream === stream) {
          releasePendingRendererSystemStream();
        } else {
          stopPendingRendererSystemStream(stream);
        }
        await closeAudioContextOnce(candidateContext);
      };
      try {
        const ctx = new AudioContext({ sampleRate: 24000 });
        candidateContext = ctx;
        claimPendingRendererSystemContext(ctx);
        await awaitCaptureSetupStep(detachFromOutputDevice(ctx));

        const { source, processor } = await createAudioPipeline({
          stream,
          context: ctx,
          onChunk: onSystemCandidateChunk,
          cancellation: captureSetupCancellation,
          isCancelled: () => !isCurrentCaptureAttempt(),
        });
        candidateSource = source;
        candidateProcessor = processor;

        if (!isCurrentInput()) {
          await cleanupSystemCandidate();
          return;
        }

        if (!isUsableSystemStream(stream)) {
          await cleanupSystemCandidate();
          if (!isCurrentInput()) return;

          const hasSurvivingMic =
            !initialMicNeedsRecovery && micStream !== null && isUsableMicStream(micStream);
          if (args.requireAllSources || !hasSurvivingMic) {
            throw new Error("SYSTEM_DISCONNECTED");
          }

          const interrupted = await notifySourceInterrupted("system", "system-renderer-ended");
          if (!interrupted || !isCurrentInput()) {
            if (!isCurrentInput()) return;
            throw new Error("SYSTEM_INTERRUPTION_PERSIST_FAILED");
          }
          rendererSystemInterrupted = true;
          unavailableButContinuing = true;
          useMeetingRecordingStore.setState({
            error: "System audio capture failed. Continuing with microphone only.",
            captureSourceStates: {
              ...useMeetingRecordingStore.getState().captureSourceStates,
              system: "unavailable",
            },
          });
        } else {
          if (!transferPendingRendererSystemCapture(stream, ctx)) {
            await cleanupSystemCandidate();
            return;
          }
          systemStream = stream;
          systemContext = ctx;
          systemSource = source;
          systemProcessor = processor;
          attached = true;

          bindRendererSystemLifecycle(stream);

          for (const chunk of candidateChunks) onSystemChunk(chunk);
          candidateChunks.length = 0;
          candidateCommitted = true;
        }
      } catch (error) {
        if (!attached) {
          await cleanupSystemCandidate();
        }
        if (!isCurrentInput()) return;
        throwPipelineFailure("system", error);
      }
      if (!unavailableButContinuing) {
        if (!attached || !isCurrentInput() || systemStream !== stream) return;
        useMeetingRecordingStore.setState({
          captureSourceStates: {
            ...useMeetingRecordingStore.getState().captureSourceStates,
            system: "recording",
          },
        });
      }
    } else if (systemCaptureError) {
      if (systemAudioStrategy === "loopback") {
        logger.warn(
          "System audio loopback failed, continuing with mic only",
          { error: systemCaptureError.message },
          "meeting"
        );
        if (micResult) {
          useMeetingRecordingStore.setState({
            error: "System audio capture failed. Continuing with microphone only.",
          });
        }
      }
    }

    if (initialMicNeedsRecovery && isCurrentInput()) {
      beginMicRecovery();
    }

    if (!isCurrentInput()) {
      logger.info(
        "Meeting transcription aborted during pipeline setup (stop called)",
        {},
        "meeting"
      );
      return;
    }

    isStartingFlag = false;
    socketReady = true;

    for (const chunk of pendingMicChunks) {
      if (!sendMeetingChunk(chunk, "mic")) break;
    }
    for (const chunk of pendingSystemChunks) {
      if (!sendMeetingChunk(chunk, "system")) break;
    }

    const totalMs = performance.now() - startTime;
    logger.info(
      "Meeting transcription started successfully",
      {
        systemAudioMode,
        systemAudioStrategy,
        bufferedChunks: pendingMicChunks.length,
        bufferedSystemChunks: pendingSystemChunks.length,
        streamsMs: Math.round(streamsMs),
        totalMs: Math.round(totalMs),
        wasPrepared: isPrepared,
      },
      "meeting"
    );
    const bindings: JarvisPowerResumeRestorations = {};
    if (captureMicrophone && micStream) {
      const track = micStream.getAudioTracks()[0];
      bindings.mic = {
        deviceId: track?.getSettings().deviceId || null,
        deviceLabel: track?.label?.trim() || null,
        strategy: actualMicStrategy,
      };
    }
    if (captureSystemAudio) {
      const track = systemStream?.getAudioTracks()[0];
      const desired = args.powerRestorations?.system;
      bindings.system = {
        deviceId: track?.getSettings().deviceId || desired?.deviceId || null,
        deviceLabel: track?.label?.trim() || desired?.deviceLabel || null,
        strategy: systemAudioStrategy || desired?.strategy || null,
      };
    }
    return bindings;
  } catch (err) {
    if (!isCurrentCaptureAttempt()) return;
    if (err instanceof CaptureSourcesUnavailableError) {
      const shouldAbortAcceptedMainStart = acceptedMainInputGeneration !== null;
      activeMeetingInputGeneration = null;
      isRecordingFlag = false;
      try {
        if (shouldAbortAcceptedMainStart) {
          await window.electronAPI?.meetingTranscriptionStop?.();
        }
      } catch (stopError) {
        logger.error(
          "Meeting transcription main cleanup failed after required source rejection",
          { error: stopError instanceof Error ? stopError.message : "UnknownError" },
          "meeting"
        );
      } finally {
        try {
          await cleanup({ preserveStarting: true });
        } finally {
          isStartingFlag = false;
        }
      }
      throw err;
    }
    const shouldAbortAcceptedMainStart = acceptedMainInputGeneration !== null;
    activeMeetingInputGeneration = null;
    isRecordingFlag = false;
    logger.error(
      "Meeting transcription setup failed",
      { error: (err as Error).message },
      "meeting"
    );
    useMeetingRecordingStore.setState({
      error: (err as Error).message,
      isRecording: false,
      isTranscribing: false,
    });
    try {
      if (shouldAbortAcceptedMainStart) {
        await window.electronAPI?.meetingTranscriptionStop?.();
      }
    } catch (stopError) {
      logger.error(
        "Meeting transcription main cleanup failed after renderer setup error",
        { error: (stopError as Error).message },
        "meeting"
      );
    } finally {
      try {
        await cleanup({ preserveStarting: true });
      } finally {
        isStartingFlag = false;
      }
    }
  } finally {
    if (!sourceStateCleanupTransferred) {
      earlySourceStateCleanup?.();
    }
    if (cancelPendingRendererSystemCapture === closePendingRendererSystemOwnership) {
      cancelPendingRendererSystemCapture = null;
    }
    if (cancelPendingCaptureSetup === cancelThisCaptureSetup) {
      cancelPendingCaptureSetup = null;
    }
    if (cancelPendingMicrophoneCapture === closePendingMicrophoneOwnership) {
      cancelPendingMicrophoneCapture = null;
    }
    closePendingMicrophoneOwnership();
    closePendingRendererSystemOwnership();
  }
}

export interface StopRecordingResult {
  diarizationSessionId: string | null;
  success: boolean;
  error?: string;
  finalSegments?: MeetingFinalSegment[];
}

export type StopRecordingOptions = SharedStopOptions;

const meetingStopCoordinator = createMeetingStopCoordinator<StopRecordingResult>((error) => {
  const stopError =
    error instanceof Error ? error : new Error("Failed to stop meeting transcription");
  return publishStopFailure(stopError);
});

function resetStoppedMeetingState(): void {
  useMeetingRecordingStore.setState({
    micPartial: "",
    systemPartial: "",
    systemPartialSpeakerId: null,
    systemPartialSpeakerName: null,
    currentMicLevel: 0,
    currentSystemLevel: 0,
    activeMicLabel: null,
    micFallbackActive: false,
    micRecoveryStatus: "idle",
    micRecoveryAttempt: 0,
    captureSourceStates: { mic: "idle", system: "idle" },
  });
}

function publishStopFailure(
  stopError: Error,
  diarizationSessionId: string | null = null
): StopRecordingResult {
  useMeetingRecordingStore.setState({ error: stopError.message });
  logger.error(
    "Meeting transcription stop failed",
    { errorCode: "meeting_stop_failed" },
    "meeting"
  );
  resetStoppedMeetingState();
  return { diarizationSessionId, success: false, error: stopError.message };
}

async function performMeetingStop(): Promise<StopRecordingResult> {
  let diarizationSessionId: string | null = null;
  try {
    if (isRecordingFlag || isStartingFlag) {
      useMeetingRecordingStore.setState({ isRecording: false, isTranscribing: false });
      await cleanupCaptureSources();
    }

    const result = await window.electronAPI?.meetingTranscriptionStop?.();
    if (result?.diarizationSessionId) {
      diarizationSessionId = result.diarizationSessionId;
      useMeetingRecordingStore.setState({ diarizationSessionId });
    }
    if (result?.success && result.transcript) {
      useMeetingRecordingStore.setState({ transcript: result.transcript });
    }
    if (result?.success) mergeFinalSegments(result.finalSegments);
    if (result?.success === false || result?.error) {
      return publishStopFailure(
        new Error(result.error || "Failed to stop meeting transcription"),
        diarizationSessionId
      );
    }
  } catch (err) {
    const stopError =
      err instanceof Error ? err : new Error("Failed to stop meeting transcription");
    return publishStopFailure(stopError, diarizationSessionId);
  } finally {
    detachMeetingListeners();
  }

  resetStoppedMeetingState();
  logger.info("Meeting transcription stopped", {}, "meeting");
  return {
    diarizationSessionId,
    success: true,
    finalSegments: useMeetingRecordingStore.getState().segments.slice(),
  };
}

export async function stopRecording(
  options: StopRecordingOptions = {}
): Promise<StopRecordingResult> {
  if (!isRecordingFlag && !meetingStopCoordinator.hasPendingStop()) {
    return { diarizationSessionId: null, success: true };
  }
  return meetingStopCoordinator.stop(performMeetingStop, options);
}

export function lockSpeaker(speakerId: string, displayName: string): void {
  if (!speakerId || !displayName) return;
  speakerLocks.set(speakerId, displayName);
  const next = useMeetingRecordingStore.getState().segments.map((s) =>
    s.speaker === speakerId
      ? lockTranscriptSpeaker(s, {
          speakerName: displayName,
          speakerIsPlaceholder: false,
          suggestedName: undefined,
          suggestedProfileId: undefined,
        })
      : s
  );
  segmentsRefValue = next;
  useMeetingRecordingStore.setState({ segments: next });
  if (recentSystemSpeaker?.speakerId === speakerId) {
    recentSystemSpeaker = {
      ...recentSystemSpeaker,
      speakerName: displayName,
      speakerIsPlaceholder: false,
    };
  }
  if (systemPartialSpeakerIdValue === speakerId) {
    setSystemPartialSpeakerIdentity(speakerId, displayName);
  }
}

export function cancelPreparedTranscription(): void {
  prepareGeneration += 1;
  preparePromise = null;
  prepareMicOnly = null;
  isPrepared = false;
  preparedMicOnly = null;
  window.electronAPI?.meetingTranscriptionCancel?.();
}

// Throttled resize listener — keeps layout reflows during drag from thrashing
// React. Registered once at module load; the store outlives any view.
if (typeof window !== "undefined") {
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimeout) return;
    resizeTimeout = setTimeout(() => {
      resizeTimeout = null;
      useMeetingRecordingStore.setState({ windowWidth: window.innerWidth });
    }, 60);
  });
}

export function useIsNarrowWindow(): boolean {
  const windowWidth = useMeetingRecordingStore((s) => s.windowWidth);
  return windowWidth < SIDE_PANEL_BREAKPOINT_PX;
}

export function useIsMeetingMode(): boolean {
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const isNarrow = useIsNarrowWindow();
  return isRecording && isNarrow;
}
