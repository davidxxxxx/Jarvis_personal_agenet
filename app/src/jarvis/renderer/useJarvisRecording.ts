import { useCallback, useEffect, useRef } from "react";
import {
  CaptureSourcesUnavailableError,
  lockSpeaker,
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
  type StartRecordingArgs,
  type StopRecordingOptions,
  type StopRecordingResult,
  type TranscriptSegment,
} from "../../stores/meetingRecordingStore";
import { getSettings } from "../../stores/settingsStore";
import type {
  JarvisControlAction,
  JarvisCaptureFailureCode,
  JarvisCaptureInput,
  JarvisCaptureMode,
  JarvisCaptureSourceInput,
  JarvisPerson,
  JarvisRenamePersonInput,
  JarvisRetentionMode,
  JarvisRuntimeState,
  JarvisSession,
  JarvisSessionInput,
  JarvisSourceInterruptionInput,
  JarvisSourceRestorationInput,
  JarvisTranscriptSegment,
  JarvisTranscriptSegmentInput,
} from "../types";
import { createStableSegmentId } from "../shared/segmentIds";
import { createJarvisControlReceiver } from "./controlDelivery";
import { useJarvisStore } from "./jarvisStore";
import { hasRecordingConsent } from "./recordingConsent";
import { reduceSession, type SessionEvent, type SessionState } from "./sessionMachine";

const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_NOTE_TITLE = "今日记录";

export function resolveJarvisWhisperModel(settings: {
  meetingWhisperModel?: string;
  whisperModel?: string;
}): string {
  const meetingModel = settings.meetingWhisperModel?.trim();
  return meetingModel || "turbo";
}

export interface RecordingJarvisApi {
  createSession: (input: JarvisSessionInput) => Promise<JarvisSession>;
  setSessionStatus: (id: string, status: "failed", at?: number) => Promise<JarvisSession | null>;
  listSessions: () => Promise<JarvisSession[]>;
  startCapture: (input: JarvisCaptureInput) => Promise<JarvisRuntimeState>;
  setRetentionMode: (
    id: string,
    retentionMode: JarvisRetentionMode,
    at?: number
  ) => Promise<JarvisRuntimeState>;
  sourceInterrupted: (
    id: string,
    sourceType: "mic" | "system",
    input: JarvisSourceInterruptionInput
  ) => Promise<JarvisRuntimeState>;
  sourceRestored: (
    id: string,
    sourceType: "mic" | "system",
    input: JarvisSourceRestorationInput
  ) => Promise<JarvisRuntimeState>;
  pauseCapture: (id: string, at?: number, errorCode?: string | null) => Promise<JarvisRuntimeState>;
  resumeCapture: (id: string, at?: number) => Promise<JarvisRuntimeState>;
  finishCapture: (id: string, at?: number) => Promise<JarvisRuntimeState>;
  failCapture: (
    id: string,
    errorCode: JarvisCaptureFailureCode,
    at?: number
  ) => Promise<JarvisRuntimeState>;
  upsertSegments: (
    sessionId: string,
    segments: JarvisTranscriptSegmentInput[]
  ) => Promise<JarvisTranscriptSegment[]>;
  syncSegments: (
    sessionId: string,
    segments: JarvisTranscriptSegmentInput[]
  ) => Promise<JarvisTranscriptSegment[]>;
  renamePerson: (input: JarvisRenamePersonInput) => Promise<JarvisPerson>;
  listPeople: () => Promise<JarvisPerson[]>;
}

export interface RecordingMeetingSnapshot {
  segments: TranscriptSegment[];
  isRecording: boolean;
  error: string | null;
}

export interface LatestRefresh<T> {
  run: (load: () => Promise<T>) => Promise<void>;
  invalidate: () => void;
}

export function createLatestRefresh<T>(
  commit: (value: T) => void,
  onError: () => void
): LatestRefresh<T> {
  let generation = 0;
  return {
    run: async (load) => {
      const requestGeneration = ++generation;
      try {
        const value = await load();
        if (requestGeneration === generation) commit(value);
      } catch {
        if (requestGeneration === generation) onError();
      }
    },
    invalidate: () => {
      generation += 1;
    },
  };
}

export interface RecordingDependencies {
  jarvis: RecordingJarvisApi;
  ensureTranscriptionReady: () => Promise<void>;
  startRecording: (args: StartRecordingArgs) => Promise<void>;
  stopRecording: (options?: StopRecordingOptions) => Promise<StopRecordingResult>;
  lockSpeaker: (speakerId: string, displayName: string) => void;
  getMeetingSnapshot: () => RecordingMeetingSnapshot;
  getSessionState: () => SessionState;
  setSessionState: (state: SessionState) => void;
  refreshSessions: () => Promise<void>;
  refreshPeople: () => Promise<void>;
  createId: () => string;
  now: () => number;
  getMicDeviceId: () => string | null;
  getLanguage: () => string;
  getCaptureMode?: () => JarvisCaptureMode;
  getRetentionMode?: () => JarvisRetentionMode;
  hasRecordingConsent: () => boolean;
  onOperationChange: (operation: JarvisControlAction | null) => void;
  onError: (code: string | null) => void;
}

export interface RecordingController {
  start: () => Promise<void>;
  setRetentionMode: (retentionMode: JarvisRetentionMode) => Promise<JarvisRuntimeState>;
  pause: () => Promise<void>;
  pauseForError: (code: "MIC_PERMISSION" | "MIC_DISCONNECTED") => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  renameSpeaker: (personId: string, displayName: string, isSelf?: boolean) => Promise<JarvisPerson>;
  handleSegmentsChanged: (segments: TranscriptSegment[]) => void;
  flushPendingPersistence: () => Promise<void>;
  shutdown: () => Promise<void>;
  dispose: () => void;
}

export function routeJarvisControl(
  controller: RecordingController,
  action: JarvisControlAction
): Promise<void> {
  return controller[action]();
}

class RecordingOperationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RecordingOperationError";
  }
}

class RecordingActivationCancelledError extends Error {
  constructor() {
    super("capture activation was cancelled");
    this.name = "RecordingActivationCancelledError";
  }
}

function safeTimestamp(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value as number) : fallback;
}

function safePersonId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function mapStableSegments(
  sessionId: string,
  segments: TranscriptSegment[],
  fallbackTimestamp: number
): JarvisTranscriptSegmentInput[] {
  return segments.map((segment) => {
    const timestamp = safeTimestamp(segment.timestamp, fallbackTimestamp);
    const startedAt = Math.min(timestamp, Number.MAX_SAFE_INTEGER - 1);
    const personId = safePersonId(segment.speaker);
    return {
      id: createStableSegmentId(sessionId, segment.id),
      startedAt,
      endedAt: startedAt + 1,
      personId,
      speakerLabel: segment.speakerName ?? segment.speaker ?? segment.source,
      sourceType: segment.source,
      text: segment.text,
      confidence:
        typeof segment.confidence === "number" && Number.isFinite(segment.confidence)
          ? segment.confidence
          : DEFAULT_CONFIDENCE,
      isStable: true,
    };
  });
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof CaptureSourcesUnavailableError) return "capture_source_unavailable";
  return error instanceof RecordingOperationError ? error.code : fallback;
}

function captureFailureCode(code: string): JarvisCaptureFailureCode {
  switch (code) {
    case "MIC_PERMISSION":
    case "MIC_DISCONNECTED":
    case "capture_source_unavailable":
    case "capture_start_failed":
    case "upstream_start_failed":
    case "capture_activation_cancelled":
      return code;
    default:
      return "capture_start_failed";
  }
}

export function recordingArgs(
  id: string,
  captureMode: JarvisCaptureMode = "mic",
  seedSegments?: TranscriptSegment[]
): StartRecordingArgs {
  const settings = getSettings();
  return {
    noteId: null,
    noteTitle: DEFAULT_NOTE_TITLE,
    folderId: null,
    captureSystemAudio: captureMode !== "mic",
    captureMicrophone: captureMode !== "system",
    micOnly: captureMode === "mic",
    requireAllSources: true,
    jarvisSessionId: id,
    diarizationEnabled: true,
    forceLocalTranscription: true,
    localModelOverride: resolveJarvisWhisperModel(settings),
    localLanguageOverride: null,
    localPromptMode: "bilingual-context",
    ...(seedSegments ? { seedSegments } : {}),
  };
}

function captureSources(
  captureMode: JarvisCaptureMode,
  micDeviceId: string | null
): JarvisCaptureSourceInput[] {
  const sources: JarvisCaptureSourceInput[] = [];
  if (captureMode !== "system") {
    sources.push({
      sourceType: "mic",
      deviceId: micDeviceId,
      deviceLabel: null,
      strategy: "web-audio",
    });
  }
  if (captureMode !== "mic") {
    sources.push({
      sourceType: "system",
      deviceId: null,
      deviceLabel: null,
      strategy: null,
    });
  }
  return sources;
}

export function createRecordingController(deps: RecordingDependencies): RecordingController {
  let activeOperation: JarvisControlAction | null = null;
  let retentionChangeActive = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceTail: Promise<void> = Promise.resolve();
  let pendingPersistence: {
    sessionId: string;
    sessionStartedAt: number;
    segments: TranscriptSegment[];
  } | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let segmentsFrozen = false;
  let disposed = false;
  let sessionCaptureMode: JarvisCaptureMode | null = null;
  let activationGeneration = 0;
  let activeActivationSettled: Promise<void> | null = null;

  const transition = (event: SessionEvent): SessionState => {
    const next = reduceSession(deps.getSessionState(), event);
    deps.setSessionState(next);
    return next;
  };

  const begin = (operation: NonNullable<typeof activeOperation>): void => {
    if (activeOperation || retentionChangeActive) {
      const pending = activeOperation ?? "retention change";
      throw new Error(`cannot ${operation} while ${pending} is in progress`);
    }
    activeOperation = operation;
    deps.onOperationChange(operation);
    deps.onError(null);
  };

  const end = (): void => {
    activeOperation = null;
    deps.onOperationChange(null);
  };

  const trackActivation = () => {
    const generation = ++activationGeneration;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    activeActivationSettled = settled;
    return {
      assertCurrent: (): void => {
        if (disposed || generation !== activationGeneration) {
          throw new RecordingActivationCancelledError();
        }
      },
      settle: (): void => {
        if (activeActivationSettled === settled) activeActivationSettled = null;
        resolveSettled();
      },
    };
  };

  const clearPersistTimer = (): void => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };

  const persistSnapshot = (
    sessionId: string,
    sessionStartedAt: number,
    segments: TranscriptSegment[]
  ): Promise<void> => {
    const persist = async () => {
      await deps.jarvis.syncSegments(
        sessionId,
        mapStableSegments(sessionId, segments, sessionStartedAt)
      );
    };
    const result = persistenceTail.then(persist, persist);
    persistenceTail = result.catch(() => undefined);
    return result;
  };

  const failCurrentSession = (code: string): void => {
    const state = deps.getSessionState();
    if (["starting", "recording", "paused", "finalizing"].includes(state.status)) {
      deps.setSessionState(reduceSession(state, { type: "FAILED", code }));
    }
    deps.onError(code);
  };

  const markPersistedSessionFailed = async (id: string): Promise<void> => {
    try {
      await deps.jarvis.setSessionStatus(id, "failed", deps.now());
    } catch {
      // Failure state is already represented in the renderer; do not leak error details.
    }
  };

  const finishMainCapture = async (id: string): Promise<void> => {
    try {
      await deps.jarvis.finishCapture(id, deps.now());
    } catch {
      // Best-effort cleanup for a partially started capture.
    }
  };

  const failMainCapture = async (id: string, code: JarvisCaptureFailureCode): Promise<void> => {
    try {
      await deps.jarvis.failCapture(id, code, deps.now());
    } catch {
      // Do not synthesize a failed session after completing its tracks. If the
      // authoritative transaction is unavailable, startup recovery keeps the
      // still-open capture truthful and can reconcile it on the next launch.
    }
  };

  const refreshSessions = async (): Promise<void> => {
    try {
      await deps.refreshSessions();
    } catch {
      deps.onError("jarvis_query_failed");
    }
  };

  const stopUpstream = async (): Promise<void> => {
    const result = await deps.stopRecording({ throwOnError: true });
    if (result.success === false) {
      throw new RecordingOperationError(
        "upstream_stop_failed",
        result.error || "upstream recording did not stop"
      );
    }
  };

  const start = async (): Promise<void> => {
    if (disposed || shutdownPromise) {
      throw new Error("recording controller is shutting down");
    }
    const state = deps.getSessionState();
    if (!["idle", "completed", "failed"].includes(state.status)) {
      throw new Error(`cannot start from ${state.status}`);
    }
    if (!deps.hasRecordingConsent()) {
      const error = new RecordingOperationError(
        "recording_consent_required",
        "recording consent is required"
      );
      deps.onError(error.code);
      throw error;
    }
    if (deps.getMeetingSnapshot().isRecording) {
      throw new RecordingOperationError(
        "upstream_recording_active",
        "cannot start Jarvis while another recording is active"
      );
    }
    const id = deps.createId();
    const startedAt = deps.now();
    const starting = reduceSession(state, { type: "STARTING", id, at: startedAt });
    begin("start");
    const activation = trackActivation();
    deps.setSessionState(starting);
    let sessionCreated = false;
    let captureStarted = false;
    const captureMode = deps.getCaptureMode?.() ?? "mic";
    const retentionMode = deps.getRetentionMode?.() ?? "speech_triggered";
    sessionCaptureMode = captureMode;

    try {
      await deps.ensureTranscriptionReady();
      activation.assertCurrent();
      const micDeviceId = captureMode === "system" ? null : deps.getMicDeviceId();
      await deps.jarvis.createSession({
        id,
        startedAt,
        micDeviceId,
        language: deps.getLanguage(),
        captureMode,
        retentionMode,
      });
      sessionCreated = true;
      activation.assertCurrent();
      await deps.jarvis.startCapture({
        sessionId: id,
        startedAt,
        micDeviceId,
        captureMode,
        retentionMode,
        sources: captureSources(captureMode, micDeviceId),
      });
      captureStarted = true;
      activation.assertCurrent();
      await deps.startRecording(recordingArgs(id, captureMode));
      activation.assertCurrent();
      const meetingSnapshot = deps.getMeetingSnapshot();
      if (!meetingSnapshot.isRecording) {
        const code = ["MIC_PERMISSION", "MIC_DISCONNECTED"].includes(meetingSnapshot.error ?? "")
          ? (meetingSnapshot.error as string)
          : "upstream_start_failed";
        throw new RecordingOperationError(
          code,
          code.startsWith("MIC_") ? "microphone capture failed" : "upstream recording did not start"
        );
      }
      transition({ type: "STARTED", id, at: startedAt });
      await refreshSessions();
      activation.assertCurrent();
    } catch (error) {
      if (error instanceof RecordingActivationCancelledError) {
        if (deps.getMeetingSnapshot().isRecording) {
          try {
            await deps.stopRecording({ throwOnError: false });
          } catch {
            // Cancellation still closes the main writer even if producer cleanup fails.
          }
        }
        if (captureStarted) {
          await failMainCapture(id, "capture_activation_cancelled");
        } else if (sessionCreated) {
          await markPersistedSessionFailed(id);
        }
        const current = deps.getSessionState();
        if (current.id === id && ["starting", "recording"].includes(current.status)) {
          deps.setSessionState(state);
        }
        return;
      }
      const code = errorCode(error, "capture_start_failed");
      const isMicError = code === "MIC_PERMISSION" || code === "MIC_DISCONNECTED";
      if (captureStarted && isMicError) {
        try {
          await stopUpstream();
        } catch {
          // Main capture still pauses even if the already-failing upstream cannot stop cleanly.
        }
        try {
          await deps.jarvis.pauseCapture(id, deps.now(), code);
        } catch {
          await failMainCapture(id, captureFailureCode(code));
        }
      } else {
        if (captureStarted) {
          if (deps.getMeetingSnapshot().isRecording) {
            try {
              await deps.stopRecording({ throwOnError: false });
            } catch {
              // The authoritative main failure remains the terminal source of truth.
            }
          }
          await failMainCapture(id, captureFailureCode(code));
        } else if (sessionCreated) {
          await markPersistedSessionFailed(id);
        }
      }
      failCurrentSession(code);
      throw error;
    } finally {
      end();
      activation.settle();
    }
  };

  const pauseCapture = async (reportedError: string | null): Promise<void> => {
    const state = deps.getSessionState();
    const at = deps.now();
    const paused = reduceSession(state, { type: "PAUSED", at });
    begin("pause");
    let upstreamStopped = false;
    let authoritativeStateHandled = false;

    try {
      if (reportedError) {
        try {
          await stopUpstream();
          upstreamStopped = true;
        } catch {
          // A microphone-loss pause must still stop the handle-bound main writer.
        }
      } else {
        await stopUpstream();
        upstreamStopped = true;
      }
      const runtime = await deps.jarvis.pauseCapture(state.id as string, at, reportedError);
      if (runtime.status !== "paused") {
        if (runtime.status === "failed") {
          const code = runtime.errorCode || "capture_pause_failed";
          authoritativeStateHandled = true;
          failCurrentSession(code);
          throw new RecordingOperationError(code, `main process pause failed: ${code}`);
        }
        const failed = await deps.jarvis.failCapture(
          state.id as string,
          "capture_pause_failed",
          deps.now()
        );
        const code = failed.errorCode || "capture_pause_failed";
        authoritativeStateHandled = true;
        failCurrentSession(code);
        throw new RecordingOperationError(
          code,
          `main process returned ${runtime.status} status after pause`
        );
      }
      deps.setSessionState(paused);
      await refreshSessions();
      if (reportedError) deps.onError(reportedError);
    } catch (error) {
      if (authoritativeStateHandled) throw error;
      const code =
        reportedError ??
        errorCode(error, upstreamStopped ? "capture_pause_failed" : "upstream_stop_failed");
      if (!upstreamStopped && !reportedError) {
        deps.setSessionState(state);
        deps.onError(code);
        throw error;
      }
      if (state.id) {
        if (reportedError === "MIC_PERMISSION" || reportedError === "MIC_DISCONNECTED") {
          await failMainCapture(state.id, reportedError);
        } else {
          await finishMainCapture(state.id);
          await markPersistedSessionFailed(state.id);
        }
      }
      failCurrentSession(code);
      throw error;
    } finally {
      end();
    }
  };

  const pause = (): Promise<void> => pauseCapture(null);

  const pauseForError = (code: "MIC_PERMISSION" | "MIC_DISCONNECTED"): Promise<void> => {
    if (code !== "MIC_PERMISSION" && code !== "MIC_DISCONNECTED") {
      throw new TypeError("unsupported microphone error code");
    }
    return pauseCapture(code);
  };

  const resume = async (): Promise<void> => {
    if (disposed || shutdownPromise) {
      throw new Error("recording controller is shutting down");
    }
    const state = deps.getSessionState();
    const at = deps.now();
    const resumed = reduceSession(state, { type: "RESUMED", at });
    begin("resume");
    const activation = trackActivation();
    let mainResumed = false;

    try {
      if (deps.getMeetingSnapshot().isRecording) {
        throw new RecordingOperationError(
          "upstream_recording_active",
          "cannot resume Jarvis while another recording is active"
        );
      }
      await deps.jarvis.resumeCapture(state.id as string, at);
      mainResumed = true;
      activation.assertCurrent();
      const seedSegments = deps.getMeetingSnapshot().segments;
      await deps.startRecording(
        recordingArgs(
          state.id as string,
          sessionCaptureMode ?? deps.getCaptureMode?.() ?? "mic",
          seedSegments
        )
      );
      activation.assertCurrent();
      const meetingSnapshot = deps.getMeetingSnapshot();
      if (!meetingSnapshot.isRecording) {
        const code = ["MIC_PERMISSION", "MIC_DISCONNECTED"].includes(meetingSnapshot.error ?? "")
          ? (meetingSnapshot.error as string)
          : "upstream_resume_failed";
        throw new RecordingOperationError(
          code,
          code.startsWith("MIC_")
            ? "microphone capture failed"
            : "upstream recording did not resume"
        );
      }
      deps.setSessionState(resumed);
      await refreshSessions();
      activation.assertCurrent();
    } catch (error) {
      if (error instanceof RecordingActivationCancelledError) {
        if (deps.getMeetingSnapshot().isRecording) {
          try {
            await deps.stopRecording({ throwOnError: false });
          } catch {
            // Main capture still returns to a non-recording state when teardown fails.
          }
        }
        if (mainResumed && state.id) {
          try {
            await deps.jarvis.pauseCapture(state.id, deps.now());
          } catch {
            await failMainCapture(state.id, "capture_activation_cancelled");
          }
        }
        const current = deps.getSessionState();
        if (current.id === state.id && current.status === "recording") {
          deps.setSessionState(state);
        }
        return;
      }
      const code = errorCode(error, "capture_resume_failed");
      if (mainResumed && state.id) {
        const isMicError = code === "MIC_PERMISSION" || code === "MIC_DISCONNECTED";
        if (isMicError) {
          try {
            await stopUpstream();
          } catch {
            // Main capture must still pause when the upstream microphone path is broken.
          }
        }
        try {
          await deps.jarvis.pauseCapture(state.id, deps.now(), isMicError ? code : null);
          if (isMicError) failCurrentSession(code);
        } catch {
          if (isMicError) {
            await failMainCapture(state.id, code as "MIC_PERMISSION" | "MIC_DISCONNECTED");
          } else {
            await finishMainCapture(state.id);
            await markPersistedSessionFailed(state.id);
          }
          failCurrentSession(code);
        }
      }
      deps.onError(code);
      throw error;
    } finally {
      end();
      activation.settle();
    }
  };

  const finish = async (): Promise<void> => {
    const state = deps.getSessionState();
    const at = deps.now();
    const finalizing = reduceSession(state, { type: "FINISHED", at });
    begin("finish");
    let upstreamStopped = state.status === "paused";
    let mainFinished = false;
    let authoritativeStateHandled = false;

    try {
      if (state.status === "recording") {
        await stopUpstream();
        upstreamStopped = true;
      }
      clearPersistTimer();
      deps.setSessionState(finalizing);
      const stableSegments = deps.getMeetingSnapshot().segments;
      await persistSnapshot(state.id as string, state.startedAt ?? at, stableSegments);
      const runtime = await deps.jarvis.finishCapture(state.id as string, deps.now());
      if (runtime.status !== "completed") {
        if (runtime.status === "failed") {
          const code = runtime.errorCode || "capture_finish_failed";
          authoritativeStateHandled = true;
          failCurrentSession(code);
          throw new RecordingOperationError(code, `main process finish failed: ${code}`);
        }
        const failed = await deps.jarvis.failCapture(
          state.id as string,
          "capture_finish_failed",
          deps.now()
        );
        const code = failed.errorCode || "capture_finish_failed";
        authoritativeStateHandled = true;
        failCurrentSession(code);
        throw new RecordingOperationError(
          code,
          `main process returned ${runtime.status} status after finish`
        );
      }
      mainFinished = true;
      transition({ type: "COMPLETED" });
      await refreshSessions();
    } catch (error) {
      if (authoritativeStateHandled) throw error;
      const code = errorCode(
        error,
        upstreamStopped ? "capture_finish_failed" : "upstream_stop_failed"
      );
      if (!upstreamStopped) {
        deps.setSessionState(state);
        deps.onError(code);
        throw error;
      }
      if (!mainFinished && state.id) {
        try {
          if (state.status === "recording") {
            await deps.jarvis.pauseCapture(state.id, deps.now());
            deps.setSessionState(reduceSession(state, { type: "PAUSED", at }));
          } else {
            deps.setSessionState(state);
          }
        } catch {
          await finishMainCapture(state.id);
          await markPersistedSessionFailed(state.id);
          failCurrentSession(code);
        }
      }
      deps.onError(code);
      throw error;
    } finally {
      end();
    }
  };

  const handleSegmentsChanged = (segments: TranscriptSegment[]): void => {
    if (disposed || segmentsFrozen) return;
    clearPersistTimer();
    const state = deps.getSessionState();
    if (!state.id || state.startedAt === null || !["recording", "paused"].includes(state.status)) {
      return;
    }
    const snapshot = segments.slice();
    pendingPersistence = {
      sessionId: state.id,
      sessionStartedAt: state.startedAt,
      segments: snapshot,
    };
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const pending = pendingPersistence;
      pendingPersistence = null;
      if (!pending) return;
      void persistSnapshot(pending.sessionId, pending.sessionStartedAt, pending.segments).catch(
        () => {
          deps.onError("segment_persist_failed");
        }
      );
    }, PERSIST_DEBOUNCE_MS);
  };

  const flushPendingPersistence = async (): Promise<void> => {
    clearPersistTimer();
    const pending = pendingPersistence;
    pendingPersistence = null;
    if (pending) {
      await persistSnapshot(pending.sessionId, pending.sessionStartedAt, pending.segments);
    }
    await persistenceTail;
  };

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      activationGeneration += 1;
      const activationToDrain = activeActivationSettled;
      shutdownPromise = (async () => {
        let stopError: unknown = null;
        const stopActiveProducer = async (): Promise<void> => {
          if (!deps.getMeetingSnapshot().isRecording) return;
          try {
            await deps.stopRecording({ throwOnError: false });
          } catch (error) {
            stopError ??= error;
          }
        };
        await stopActiveProducer();
        if (activationToDrain) await activationToDrain;
        await stopActiveProducer();
        segmentsFrozen = true;
        clearPersistTimer();
        pendingPersistence = null;
        const state = deps.getSessionState();
        try {
          if (
            state.id &&
            state.startedAt !== null &&
            ["recording", "paused"].includes(state.status)
          ) {
            await persistSnapshot(
              state.id,
              state.startedAt,
              deps.getMeetingSnapshot().segments.slice()
            );
          } else {
            await persistenceTail;
          }
        } finally {
          disposed = true;
        }
        if (stopError) throw stopError;
      })();
    }
    return shutdownPromise;
  };

  const renameSpeaker = async (
    personId: string,
    displayName: string,
    isSelf?: boolean
  ): Promise<JarvisPerson> => {
    const person = await deps.jarvis.renamePerson({
      personId,
      displayName,
      ...(isSelf === undefined ? {} : { isSelf }),
    });
    deps.lockSpeaker(personId, displayName);
    await deps.refreshPeople();
    return person;
  };

  const setRetentionMode = async (
    retentionMode: JarvisRetentionMode
  ): Promise<JarvisRuntimeState> => {
    if (disposed || shutdownPromise) {
      throw new Error("recording controller is shutting down");
    }
    if (activeOperation || retentionChangeActive) {
      const pending = activeOperation ?? "retention change";
      throw new Error(`cannot change retention while ${pending} is in progress`);
    }
    const state = deps.getSessionState();
    if (!state.id || !["recording", "paused"].includes(state.status)) {
      throw new Error(`cannot change retention from ${state.status}`);
    }
    retentionChangeActive = true;
    deps.onError(null);
    try {
      const runtime = await deps.jarvis.setRetentionMode(state.id, retentionMode, deps.now());
      if (runtime.errorCode) deps.onError(runtime.errorCode);
      return runtime;
    } catch (error) {
      deps.onError(errorCode(error, "retention_mode_failed"));
      throw error;
    } finally {
      retentionChangeActive = false;
    }
  };

  return {
    start,
    setRetentionMode,
    pause,
    pauseForError,
    resume,
    finish,
    renameSpeaker,
    handleSegmentsChanged,
    flushPendingPersistence,
    shutdown,
    dispose: () => {
      activationGeneration += 1;
      disposed = true;
      pendingPersistence = null;
      clearPersistTimer();
    },
  };
}

const rendererJarvisApi: RecordingJarvisApi = {
  createSession: (input) => window.electronAPI.jarvis.createSession(input),
  setSessionStatus: (id, status, at) => window.electronAPI.jarvis.setSessionStatus(id, status, at),
  listSessions: () => window.electronAPI.jarvis.listSessions(),
  startCapture: (input) => window.electronAPI.jarvis.startCapture(input),
  setRetentionMode: (id, retentionMode, at) =>
    window.electronAPI.jarvis.setRetentionMode(id, retentionMode, at),
  sourceInterrupted: (id, sourceType, input) =>
    window.electronAPI.jarvis.sourceInterrupted(id, sourceType, input),
  sourceRestored: (id, sourceType, input) =>
    window.electronAPI.jarvis.sourceRestored(id, sourceType, input),
  pauseCapture: (id, at, errorCode) => window.electronAPI.jarvis.pauseCapture(id, at, errorCode),
  resumeCapture: (id, at) => window.electronAPI.jarvis.resumeCapture(id, at),
  finishCapture: (id, at) => window.electronAPI.jarvis.finishCapture(id, at),
  failCapture: (id, errorCode, at) => window.electronAPI.jarvis.failCapture(id, errorCode, at),
  upsertSegments: (sessionId, segments) =>
    window.electronAPI.jarvis.upsertSegments(sessionId, segments),
  syncSegments: (sessionId, segments) =>
    window.electronAPI.jarvis.syncSegments(sessionId, segments),
  renamePerson: (input) => window.electronAPI.jarvis.renamePerson(input),
  listPeople: () => window.electronAPI.jarvis.listPeople(),
};

export async function applyRecordingRetentionMode(
  controller: RecordingController,
  retentionMode: JarvisRetentionMode
): Promise<void> {
  const current = useJarvisStore.getState();
  if (["recording", "paused"].includes(current.session.status)) {
    const runtime = await controller.setRetentionMode(retentionMode);
    const latest = useJarvisStore.getState();
    if (runtime.retentionMode) latest.setRetentionMode(runtime.retentionMode);
    latest.setRetentionRuntime(
      runtime.effectiveRetentionMode ?? null,
      runtime.retentionDegradedReason ?? null
    );
    if (runtime.status === "failed") {
      const session = latest.session;
      if (session.id === runtime.sessionId && ["recording", "paused"].includes(session.status)) {
        latest.setSession(
          reduceSession(session, {
            type: "FAILED",
            code: runtime.errorCode || "retention_mode_failed",
          })
        );
      }
    }
    if (runtime.errorCode) latest.setError(runtime.errorCode);
    return;
  }
  if (["starting", "finalizing"].includes(current.session.status)) {
    throw new Error("retention mode is locked during a lifecycle transition");
  }
  current.setRetentionMode(retentionMode);
  current.setRetentionRuntime(null, null);
}

export interface UseJarvisRecordingResult {
  session: SessionState;
  segments: TranscriptSegment[];
  partialText: string;
  micLevel: number;
  activeMicLabel?: string | null;
  micFallbackActive?: boolean;
  micRecoveryStatus?: "idle" | "reconnecting" | "restored";
  micRecoveryAttempt?: number;
  operation: JarvisControlAction | null;
  error: string | null;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  setRetentionMode: (retentionMode: JarvisRetentionMode) => Promise<void>;
  renameSpeaker: (personId: string, displayName: string, isSelf?: boolean) => Promise<JarvisPerson>;
}

export function useJarvisRecording(): UseJarvisRecordingResult {
  const session = useJarvisStore((state) => state.session);
  const controllerError = useJarvisStore((state) => state.error);
  const operation = useJarvisStore((state) => state.operation);
  const segments = useMeetingRecordingStore((state) => state.segments);
  const micPartial = useMeetingRecordingStore((state) => state.micPartial);
  const systemPartial = useMeetingRecordingStore((state) => state.systemPartial);
  const micLevel = useMeetingRecordingStore((state) => state.currentMicLevel);
  const activeMicLabel = useMeetingRecordingStore((state) => state.activeMicLabel);
  const micFallbackActive = useMeetingRecordingStore((state) => state.micFallbackActive);
  const micRecoveryStatus = useMeetingRecordingStore((state) => state.micRecoveryStatus);
  const micRecoveryAttempt = useMeetingRecordingStore((state) => state.micRecoveryAttempt);
  const captureSourceStates = useMeetingRecordingStore((state) => state.captureSourceStates);
  const upstreamError = useMeetingRecordingStore((state) => state.error);
  const sessionsRefreshRef = useRef<LatestRefresh<JarvisSession[]> | null>(null);
  const peopleRefreshRef = useRef<LatestRefresh<JarvisPerson[]> | null>(null);
  const controllerRef = useRef<RecordingController | null>(null);
  const handledMicErrorRef = useRef<string | null>(null);
  const analysisProgressRef = useRef<{ sessionId: string | null; bucket: number; final: boolean }>({
    sessionId: null,
    bucket: 0,
    final: false,
  });

  if (sessionsRefreshRef.current === null) {
    sessionsRefreshRef.current = createLatestRefresh(
      (sessions) => useJarvisStore.getState().setSessions(sessions),
      () => useJarvisStore.getState().setError("jarvis_query_failed")
    );
  }
  if (peopleRefreshRef.current === null) {
    peopleRefreshRef.current = createLatestRefresh(
      (people) => useJarvisStore.getState().setPeople(people),
      () => useJarvisStore.getState().setError("jarvis_query_failed")
    );
  }

  const sessionsRefresh = sessionsRefreshRef.current;
  const peopleRefresh = peopleRefreshRef.current;

  if (controllerRef.current === null) {
    controllerRef.current = createRecordingController({
      jarvis: rendererJarvisApi,
      ensureTranscriptionReady: async () => {
        const settings = getSettings();
        const model = resolveJarvisWhisperModel(settings);
        const status = await window.electronAPI.checkModelStatus(model);
        if (!status.success) {
          throw new RecordingOperationError(
            "local_model_setup_failed",
            status.error || `could not check local Whisper model ${model}`
          );
        }
        if (status.downloaded) return;

        const downloaded = await window.electronAPI.downloadWhisperModel(model);
        if (!downloaded.success || !downloaded.downloaded) {
          throw new RecordingOperationError(
            "local_model_setup_failed",
            downloaded.error || `could not download local Whisper model ${model}`
          );
        }
      },
      startRecording,
      stopRecording,
      lockSpeaker,
      getMeetingSnapshot: () => {
        const state = useMeetingRecordingStore.getState();
        return { segments: state.segments, isRecording: state.isRecording, error: state.error };
      },
      getSessionState: () => useJarvisStore.getState().session,
      setSessionState: (next) => useJarvisStore.getState().setSession(next),
      refreshSessions: () => sessionsRefresh.run(() => rendererJarvisApi.listSessions()),
      refreshPeople: () => peopleRefresh.run(() => rendererJarvisApi.listPeople()),
      createId: () => crypto.randomUUID(),
      now: Date.now,
      getMicDeviceId: () => getSettings().selectedMicDeviceId || null,
      getLanguage: () => getSettings().preferredLanguage || "zh",
      getCaptureMode: () => useJarvisStore.getState().captureMode,
      getRetentionMode: () => useJarvisStore.getState().retentionMode,
      hasRecordingConsent,
      onOperationChange: (operation) => useJarvisStore.getState().setOperation(operation),
      onError: (code) => useJarvisStore.getState().setError(code),
    });
  }

  const controller = controllerRef.current;

  useEffect(() => {
    useJarvisStore.getState().setSourceStates(captureSourceStates);
  }, [captureSourceStates]);

  useEffect(() => {
    controller.handleSegmentsChanged(useMeetingRecordingStore.getState().segments);
    const unsubscribe = useMeetingRecordingStore.subscribe((state, previous) => {
      if (state.segments !== previous.segments) controller.handleSegmentsChanged(state.segments);
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  useEffect(
    () =>
      window.electronAPI.jarvis.onShutdownRequested(({ id }) => {
        void controller.shutdown().then(
          () => window.electronAPI.jarvis.acknowledgeShutdown(id, "ok"),
          () => window.electronAPI.jarvis.acknowledgeShutdown(id, "error")
        );
      }),
    [controller]
  );

  useEffect(() => {
    const rendererId = crypto.randomUUID();
    const receiver = createJarvisControlReceiver({
      claim: (id) => window.electronAPI.jarvis.claimControl(id, rendererId),
      route: (action) => routeJarvisControl(controller, action),
      acknowledge: (id, outcome) =>
        window.electronAPI.jarvis.acknowledgeControl(id, outcome, rendererId),
    });
    const unsubscribe = window.electronAPI.jarvis.onControl((envelope) => {
      void receiver.handle(envelope);
    });
    window.electronAPI.jarvis.controlReady(rendererId);
    return unsubscribe;
  }, [controller]);

  useEffect(
    () =>
      window.electronAPI.jarvis.onStateChanged((state) => {
        if (state.retentionMode) useJarvisStore.getState().setRetentionMode(state.retentionMode);
        useJarvisStore
          .getState()
          .setRetentionRuntime(
            state.effectiveRetentionMode ?? null,
            state.retentionDegradedReason ?? null
          );
        if (state.errorCode) useJarvisStore.getState().setError(state.errorCode);
        if (state.status === "failed") {
          const current = useJarvisStore.getState().session;
          if (
            current.id === state.sessionId &&
            ["starting", "recording", "paused", "finalizing"].includes(current.status)
          ) {
            useJarvisStore.getState().setSession(
              reduceSession(current, {
                type: "FAILED",
                code: state.errorCode || "capture_failed",
              })
            );
          }
          void stopRecording({ throwOnError: false });
        }
      }),
    []
  );

  useEffect(() => {
    const isMicError = upstreamError === "MIC_PERMISSION" || upstreamError === "MIC_DISCONNECTED";
    if (!isMicError) {
      handledMicErrorRef.current = null;
      return;
    }
    if (session.status !== "recording" || handledMicErrorRef.current === upstreamError) return;
    handledMicErrorRef.current = upstreamError;
    void controller.pauseForError(upstreamError).catch(() => {
      useJarvisStore.getState().setError(upstreamError);
    });
  }, [controller, session.status, upstreamError]);

  useEffect(() => {
    void sessionsRefresh.run(() => rendererJarvisApi.listSessions());
    void peopleRefresh.run(() => rendererJarvisApi.listPeople());
    return () => {
      sessionsRefresh.invalidate();
      peopleRefresh.invalidate();
    };
  }, [peopleRefresh, sessionsRefresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof window.electronAPI?.jarvis?.analyzeSession !== "function") return;
      const current = useJarvisStore.getState().session;
      if (!current.id || current.status !== "recording") return;
      if (analysisProgressRef.current.sessionId !== current.id) {
        analysisProgressRef.current = { sessionId: current.id, bucket: 0, final: false };
      }
      const elapsed =
        current.accumulatedMs +
        (current.activeSince ? Math.max(0, Date.now() - current.activeSince) : 0);
      const bucket = Math.floor(elapsed / 600_000);
      if (bucket < 1 || bucket <= analysisProgressRef.current.bucket) return;
      analysisProgressRef.current.bucket = bucket;
      void window.electronAPI.jarvis.analyzeSession(current.id, "incremental").catch(() => {
        // Cloud analysis never interrupts local recording.
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      !session.id ||
      session.status !== "completed" ||
      typeof window.electronAPI?.jarvis?.analyzeSession !== "function"
    )
      return;
    if (analysisProgressRef.current.sessionId !== session.id) {
      analysisProgressRef.current = { sessionId: session.id, bucket: 0, final: false };
    }
    if (analysisProgressRef.current.final) return;
    analysisProgressRef.current.final = true;
    void window.electronAPI.jarvis.analyzeSession(session.id, "final").catch(() => {
      // The completed recording remains available for manual retry from Memory.
    });
  }, [session.id, session.status]);

  const start = useCallback(() => controller.start(), [controller]);
  const pause = useCallback(() => controller.pause(), [controller]);
  const resume = useCallback(() => controller.resume(), [controller]);
  const finish = useCallback(() => controller.finish(), [controller]);
  const setRetentionMode = useCallback(
    (retentionMode: JarvisRetentionMode) => applyRecordingRetentionMode(controller, retentionMode),
    [controller]
  );
  const renameSpeaker = useCallback(
    (personId: string, displayName: string, isSelf?: boolean) =>
      controller.renameSpeaker(personId, displayName, isSelf),
    [controller]
  );

  return {
    session,
    segments,
    partialText: [micPartial, systemPartial].filter(Boolean).join(" "),
    micLevel,
    activeMicLabel,
    micFallbackActive,
    micRecoveryStatus,
    micRecoveryAttempt,
    operation,
    error: upstreamError ?? controllerError,
    start,
    pause,
    resume,
    finish,
    setRetentionMode,
    renameSpeaker,
  };
}
