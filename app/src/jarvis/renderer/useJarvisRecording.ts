import { useCallback, useEffect, useRef } from "react";
import {
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
  JarvisPerson,
  JarvisRenamePersonInput,
  JarvisRuntimeState,
  JarvisSession,
  JarvisSessionInput,
  JarvisTranscriptSegment,
  JarvisTranscriptSegmentInput,
} from "../types";
import { createStableSegmentId } from "../shared/segmentIds";
import { useJarvisStore } from "./jarvisStore";
import { reduceSession, type SessionEvent, type SessionState } from "./sessionMachine";

const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_NOTE_TITLE = "今日记录";

export interface RecordingJarvisApi {
  createSession: (input: JarvisSessionInput) => Promise<JarvisSession>;
  setSessionStatus: (id: string, status: "failed", at?: number) => Promise<JarvisSession | null>;
  listSessions: () => Promise<JarvisSession[]>;
  startCapture: (input: {
    sessionId: string;
    startedAt: number;
    micDeviceId: string | null;
  }) => Promise<JarvisRuntimeState>;
  pauseCapture: (id: string, at?: number) => Promise<JarvisRuntimeState>;
  resumeCapture: (id: string, at?: number) => Promise<JarvisRuntimeState>;
  finishCapture: (id: string, at?: number) => Promise<JarvisRuntimeState>;
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
  onError: (code: string | null) => void;
}

export interface RecordingController {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  renameSpeaker: (personId: string, displayName: string, isSelf?: boolean) => Promise<JarvisPerson>;
  handleSegmentsChanged: (segments: TranscriptSegment[]) => void;
  dispose: () => void;
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
    const personId = safePersonId(segment.speaker);
    return {
      id: createStableSegmentId(sessionId, segment.id),
      startedAt: timestamp,
      endedAt: timestamp,
      personId,
      speakerLabel: segment.speakerName ?? segment.speaker ?? segment.source,
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
  return error instanceof RecordingOperationError ? error.code : fallback;
}

function recordingArgs(id: string, seedSegments?: TranscriptSegment[]): StartRecordingArgs {
  return {
    noteId: null,
    noteTitle: DEFAULT_NOTE_TITLE,
    folderId: null,
    captureSystemAudio: false,
    jarvisSessionId: id,
    diarizationEnabled: true,
    ...(seedSegments ? { seedSegments } : {}),
  };
}

export function createRecordingController(deps: RecordingDependencies): RecordingController {
  let activeOperation: "start" | "pause" | "resume" | "finish" | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceTail: Promise<void> = Promise.resolve();

  const transition = (event: SessionEvent): SessionState => {
    const next = reduceSession(deps.getSessionState(), event);
    deps.setSessionState(next);
    return next;
  };

  const begin = (operation: NonNullable<typeof activeOperation>): void => {
    if (activeOperation) {
      throw new Error(`cannot ${operation} while ${activeOperation} is in progress`);
    }
    activeOperation = operation;
    deps.onError(null);
  };

  const end = (): void => {
    activeOperation = null;
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
    const state = deps.getSessionState();
    if (!["idle", "completed", "failed"].includes(state.status)) {
      throw new Error(`cannot start from ${state.status}`);
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
    deps.setSessionState(starting);
    let sessionCreated = false;
    let captureStarted = false;

    try {
      const micDeviceId = deps.getMicDeviceId();
      await deps.jarvis.createSession({
        id,
        startedAt,
        micDeviceId,
        language: deps.getLanguage(),
      });
      sessionCreated = true;
      await deps.jarvis.startCapture({ sessionId: id, startedAt, micDeviceId });
      captureStarted = true;
      await deps.startRecording(recordingArgs(id));
      if (!deps.getMeetingSnapshot().isRecording) {
        throw new RecordingOperationError(
          "upstream_start_failed",
          "upstream recording did not start"
        );
      }
      transition({ type: "STARTED", id, at: startedAt });
      await refreshSessions();
    } catch (error) {
      const code = errorCode(error, "capture_start_failed");
      if (captureStarted) await finishMainCapture(id);
      if (sessionCreated) await markPersistedSessionFailed(id);
      failCurrentSession(code);
      throw error;
    } finally {
      end();
    }
  };

  const pause = async (): Promise<void> => {
    const state = deps.getSessionState();
    const at = deps.now();
    const paused = reduceSession(state, { type: "PAUSED", at });
    begin("pause");
    let upstreamStopped = false;

    try {
      await stopUpstream();
      upstreamStopped = true;
      await deps.jarvis.pauseCapture(state.id as string, at);
      deps.setSessionState(paused);
      await refreshSessions();
    } catch (error) {
      const code = errorCode(
        error,
        upstreamStopped ? "capture_pause_failed" : "upstream_stop_failed"
      );
      if (!upstreamStopped) {
        deps.setSessionState(state);
        deps.onError(code);
        throw error;
      }
      if (state.id) {
        await finishMainCapture(state.id);
        await markPersistedSessionFailed(state.id);
      }
      failCurrentSession(code);
      throw error;
    } finally {
      end();
    }
  };

  const resume = async (): Promise<void> => {
    const state = deps.getSessionState();
    const at = deps.now();
    const resumed = reduceSession(state, { type: "RESUMED", at });
    begin("resume");
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
      const seedSegments = deps.getMeetingSnapshot().segments;
      await deps.startRecording(recordingArgs(state.id as string, seedSegments));
      if (!deps.getMeetingSnapshot().isRecording) {
        throw new RecordingOperationError(
          "upstream_resume_failed",
          "upstream recording did not resume"
        );
      }
      deps.setSessionState(resumed);
      await refreshSessions();
    } catch (error) {
      const code = errorCode(error, "capture_resume_failed");
      if (mainResumed && state.id) {
        try {
          await deps.jarvis.pauseCapture(state.id, deps.now());
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

  const finish = async (): Promise<void> => {
    const state = deps.getSessionState();
    const at = deps.now();
    const finalizing = reduceSession(state, { type: "FINISHED", at });
    begin("finish");
    let upstreamStopped = state.status === "paused";
    let mainFinished = false;

    try {
      if (state.status === "recording") {
        await stopUpstream();
        upstreamStopped = true;
      }
      clearPersistTimer();
      deps.setSessionState(finalizing);
      const stableSegments = deps.getMeetingSnapshot().segments;
      await persistSnapshot(state.id as string, state.startedAt ?? at, stableSegments);
      await deps.jarvis.finishCapture(state.id as string, deps.now());
      mainFinished = true;
      transition({ type: "COMPLETED" });
      await refreshSessions();
    } catch (error) {
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
    clearPersistTimer();
    const state = deps.getSessionState();
    if (!state.id || state.startedAt === null || !["recording", "paused"].includes(state.status)) {
      return;
    }
    const snapshot = segments.slice();
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistSnapshot(state.id as string, state.startedAt as number, snapshot).catch(() => {
        deps.onError("segment_persist_failed");
      });
    }, PERSIST_DEBOUNCE_MS);
  };

  const renameSpeaker = async (
    personId: string,
    displayName: string,
    isSelf = false
  ): Promise<JarvisPerson> => {
    const person = await deps.jarvis.renamePerson({ personId, displayName, isSelf });
    deps.lockSpeaker(personId, displayName);
    await deps.refreshPeople();
    return person;
  };

  return {
    start,
    pause,
    resume,
    finish,
    renameSpeaker,
    handleSegmentsChanged,
    dispose: clearPersistTimer,
  };
}

const rendererJarvisApi: RecordingJarvisApi = {
  createSession: (input) => window.electronAPI.jarvis.createSession(input),
  setSessionStatus: (id, status, at) => window.electronAPI.jarvis.setSessionStatus(id, status, at),
  listSessions: () => window.electronAPI.jarvis.listSessions(),
  startCapture: (input) => window.electronAPI.jarvis.startCapture(input),
  pauseCapture: (id, at) => window.electronAPI.jarvis.pauseCapture(id, at),
  resumeCapture: (id, at) => window.electronAPI.jarvis.resumeCapture(id, at),
  finishCapture: (id, at) => window.electronAPI.jarvis.finishCapture(id, at),
  upsertSegments: (sessionId, segments) =>
    window.electronAPI.jarvis.upsertSegments(sessionId, segments),
  syncSegments: (sessionId, segments) =>
    window.electronAPI.jarvis.syncSegments(sessionId, segments),
  renamePerson: (input) => window.electronAPI.jarvis.renamePerson(input),
  listPeople: () => window.electronAPI.jarvis.listPeople(),
};

export interface UseJarvisRecordingResult {
  session: SessionState;
  segments: TranscriptSegment[];
  partialText: string;
  micLevel: number;
  error: string | null;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  renameSpeaker: (personId: string, displayName: string, isSelf?: boolean) => Promise<JarvisPerson>;
}

export function useJarvisRecording(): UseJarvisRecordingResult {
  const session = useJarvisStore((state) => state.session);
  const controllerError = useJarvisStore((state) => state.error);
  const segments = useMeetingRecordingStore((state) => state.segments);
  const micPartial = useMeetingRecordingStore((state) => state.micPartial);
  const systemPartial = useMeetingRecordingStore((state) => state.systemPartial);
  const micLevel = useMeetingRecordingStore((state) => state.currentMicLevel);
  const upstreamError = useMeetingRecordingStore((state) => state.error);
  const sessionsRefreshRef = useRef<LatestRefresh<JarvisSession[]> | null>(null);
  const peopleRefreshRef = useRef<LatestRefresh<JarvisPerson[]> | null>(null);
  const controllerRef = useRef<RecordingController | null>(null);

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
      onError: (code) => useJarvisStore.getState().setError(code),
    });
  }

  const controller = controllerRef.current;

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

  useEffect(() => {
    void sessionsRefresh.run(() => rendererJarvisApi.listSessions());
    void peopleRefresh.run(() => rendererJarvisApi.listPeople());
    return () => {
      sessionsRefresh.invalidate();
      peopleRefresh.invalidate();
    };
  }, [peopleRefresh, sessionsRefresh]);

  const start = useCallback(() => controller.start(), [controller]);
  const pause = useCallback(() => controller.pause(), [controller]);
  const resume = useCallback(() => controller.resume(), [controller]);
  const finish = useCallback(() => controller.finish(), [controller]);
  const renameSpeaker = useCallback(
    (personId: string, displayName: string, isSelf = false) =>
      controller.renameSpeaker(personId, displayName, isSelf),
    [controller]
  );

  return {
    session,
    segments,
    partialText: [micPartial, systemPartial].filter(Boolean).join(" "),
    micLevel,
    error: upstreamError ?? controllerError,
    start,
    pause,
    resume,
    finish,
    renameSpeaker,
  };
}
