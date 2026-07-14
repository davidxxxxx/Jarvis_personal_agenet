import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareTranscription,
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../../stores/meetingRecordingStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";
import { createRecordingController, type RecordingDependencies } from "../useJarvisRecording";
import type { SessionState } from "../sessionMachine";

class FakeAudioNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  muted = false;
  label: string;
  private readonly deviceId: string;

  constructor(label = "Test microphone", deviceId = "test-mic") {
    super();
    this.label = label;
    this.deviceId = deviceId;
  }

  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = vi.fn(() => ({ deviceId: this.deviceId, sampleRate: 24_000 }));

  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

const streamFor = (streamTrack: FakeTrack) => {
  const stream = new EventTarget();
  const mediaStream = Object.assign(stream, {
    getAudioTracks: () => [streamTrack],
    getVideoTracks: () => [],
    getTracks: () => [streamTrack],
  });
  Object.defineProperty(mediaStream, "active", {
    configurable: true,
    get: () => streamTrack.readyState === "live",
  });
  return mediaStream as unknown as MediaStream;
};

const inputDevice = (deviceId: string, label: string) =>
  ({ kind: "audioinput", deviceId, label }) as MediaDeviceInfo;

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeAudioWorkletNode extends FakeAudioNode {
  port: {
    onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };

  constructor() {
    super();
    const chunksOnAttach = workletChunksOnAttach.shift() ?? [];
    let onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
    this.port = {
      get onmessage() {
        return onmessage;
      },
      set onmessage(value) {
        onmessage = value;
        if (!value) return;
        for (const chunk of chunksOnAttach) {
          value({ data: chunk } as MessageEvent<ArrayBuffer>);
        }
      },
      postMessage: vi.fn(),
    };
    audioWorkletNodes.push(this);
  }
}

const audioContexts: FakeAudioContext[] = [];
const audioWorkletNodes: FakeAudioWorkletNode[] = [];
const workletChunksOnAttach: Array<ArrayBuffer[]> = [];
let onAudioContextCreated: ((context: FakeAudioContext, index: number) => void) | null = null;

class FakeAudioContext {
  state: AudioContextState = "running";
  destination = new FakeAudioNode();
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => new FakeAudioNode());
  createGain = vi.fn(() => Object.assign(new FakeAudioNode(), { gain: { value: 1 } }));
  createAnalyser = vi.fn(() =>
    Object.assign(new FakeAudioNode(), {
      fftSize: 0,
      smoothingTimeConstant: 0,
    })
  );
  close = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  setSinkId = vi.fn(async () => {});

  constructor() {
    const index = audioContexts.length;
    audioContexts.push(this);
    onAudioContextCreated?.(this, index);
  }
}

describe("Jarvis shutdown final meeting segment integration", () => {
  let track: FakeTrack;
  let segmentListener:
    | ((data: {
        text: string;
        source: "mic" | "system";
        type: "partial" | "final" | "retract" | "correction";
        originalText?: string;
        timestamp?: number;
        startedAt?: number;
        endedAt?: number;
        confidence?: number;
        echoScore?: number | null;
      }) => void)
    | null;
  let segmentListenerDetached: boolean;
  let inputRejectedListener:
    | ((payload: {
        source: "mic" | "system";
        reason: "jarvis-evidence-backpressure";
        inputGeneration: string;
      }) => void)
    | null;
  let inputRejectedListeners: Array<NonNullable<typeof inputRejectedListener>>;
  let sourceStateListener:
    | ((payload: {
        source: "system";
        state: "unavailable" | "recording";
        reason:
          | "system-capture-error"
          | "system-capture-restored"
          | "system-recovery-buffer-overflow"
          | "system-recovery-delivery-failed";
        inputGeneration: string;
      }) => void)
    | null;
  let sourceStateListeners: Array<NonNullable<typeof sourceStateListener>>;

  beforeEach(() => {
    audioContexts.length = 0;
    audioWorkletNodes.length = 0;
    workletChunksOnAttach.length = 0;
    onAudioContextCreated = null;
    track = new FakeTrack();
    segmentListener = null;
    segmentListenerDetached = false;
    inputRejectedListener = null;
    inputRejectedListeners = [];
    sourceStateListener = null;
    sourceStateListeners = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:meeting-worklet"),
    });

    const stream = streamFor(track);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: vi.fn(async () => []),
      },
    });

    window.electronAPI = {
      jarvis: {
        sourceInterrupted: vi.fn(async () => ({
          sessionId: "s1",
          status: "degraded" as const,
          startedAt: 1_000,
          elapsedMs: 0,
          errorCode: null,
        })),
        sourceRestored: vi.fn(async () => ({
          sessionId: "s1",
          status: "recording" as const,
          startedAt: 1_000,
          elapsedMs: 0,
          errorCode: null,
        })),
      },
      meetingTranscriptionStart: vi.fn(async () => ({
        success: true,
        systemAudioMode: "unsupported" as const,
        systemAudioStrategy: "unsupported" as const,
        inputGeneration: "input-generation-1",
      })),
      meetingTranscriptionSend: vi.fn(),
      onMeetingTranscriptionSegment: vi.fn((callback) => {
        segmentListener = callback;
        return () => {
          segmentListenerDetached = true;
          segmentListener = null;
        };
      }),
      onMeetingSpeakerIdentified: vi.fn(() => () => {}),
      onMeetingSpeakersMerged: vi.fn(() => () => {}),
      onMeetingTranscriptionError: vi.fn(() => () => {}),
      onMeetingTranscriptionInputRejected: vi.fn((callback) => {
        inputRejectedListener = callback;
        inputRejectedListeners.push(callback);
        return () => {
          inputRejectedListener = null;
        };
      }),
      onMeetingTranscriptionSourceState: vi.fn((callback) => {
        sourceStateListener = callback;
        sourceStateListeners.push(callback);
        return () => {
          sourceStateListener = null;
        };
      }),
      meetingTranscriptionStop: vi.fn(async () => ({ success: true })),
    } as unknown as Window["electronAPI"];

    useMeetingRecordingStore.setState({
      isRecording: false,
      isTranscribing: false,
      segments: [],
      transcript: "",
      error: null,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopRecording();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, "createObjectURL");
  });

  it("uses local Whisper when a Jarvis recording forces local transcription", async () => {
    useSettingsStore.setState({
      meetingUseLocalWhisper: false,
      meetingTranscriptionMode: "openwhispr",
      meetingLocalTranscriptionProvider: "whisper",
      meetingWhisperModel: "",
      whisperModel: "base",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-local",
      diarizationEnabled: true,
      forceLocalTranscription: true,
    });

    expect(window.electronAPI.meetingTranscriptionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local",
        localProvider: "whisper",
        localModel: "base",
        micOnly: true,
        jarvisSessionId: "s-local",
      })
    );
  });

  it("does not log the microphone device id when capture starts", async () => {
    const info = vi.spyOn(logger, "info");

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-private-device-log",
      diarizationEnabled: true,
    });

    const startLog = info.mock.calls.find(([message]) =>
      String(message).includes("Mic capture started")
    );
    expect(startLog?.[1]).toEqual({ fallbackActive: false, sampleRate: 24_000 });
    expect(JSON.stringify(startLog)).not.toContain("test-mic");
  });

  it("captures true system-only audio without requesting or sending microphone input", async () => {
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-system",
    });

    await startRecording({
      noteId: null,
      noteTitle: "System only",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: false,
      micOnly: false,
      requireAllSources: true,
      jarvisSessionId: "s-system",
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(window.electronAPI.meetingTranscriptionStart).toHaveBeenCalledWith(
      expect.objectContaining({ micOnly: false })
    );
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: null,
      captureSourceStates: { mic: "idle", system: "recording" },
    });
    expect(window.electronAPI.meetingTranscriptionSend).not.toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "mic",
      expect.any(String)
    );
  });

  it("marks only native system audio unavailable for the current generation", async () => {
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-native-state",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Native system state",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: false,
      requireAllSources: true,
      jarvisSessionId: "s-native-state",
    });

    sourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "stale-generation",
    });
    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "idle",
      system: "recording",
    });

    sourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "input-generation-native-state",
    });
    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "idle",
      system: "unavailable",
    });
  });

  it("returns a current native system source to recording after main-managed recovery", async () => {
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-native-recovered",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Native system recovery state",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: false,
      jarvisSessionId: "s-native-recovered",
    });

    sourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "input-generation-native-recovered",
    });
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      error: "System audio capture stopped.",
      captureSourceStates: { mic: "recording", system: "unavailable" },
    });

    sourceStateListener?.({
      source: "system",
      state: "recording",
      reason: "system-capture-restored",
      inputGeneration: "input-generation-native-recovered",
    });
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      error: null,
      captureSourceStates: { mic: "recording", system: "recording" },
    });
  });

  it("accepts a visible main-managed delivery failure source-state reason", async () => {
    type SourceStatePayload = Parameters<
      Parameters<NonNullable<Window["electronAPI"]["onMeetingTranscriptionSourceState"]>>[0]
    >[0];
    const deliveryFailureState: SourceStatePayload = {
      source: "system",
      state: "unavailable",
      reason: "system-recovery-delivery-failed",
      inputGeneration: "input-generation-native-delivery-failed",
    };
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-native-delivery-failed",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Native delivery failure state",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: false,
      jarvisSessionId: "s-native-delivery-failed",
    });
    sourceStateListener?.(deliveryFailureState);

    expect(useMeetingRecordingStore.getState()).toMatchObject({
      error: "System audio capture stopped.",
      captureSourceStates: { mic: "recording", system: "unavailable" },
    });
  });

  it("retains a current native system failure emitted before start IPC settles", async () => {
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockImplementationOnce(async () => {
      sourceStateListener?.({
        source: "system",
        state: "unavailable",
        reason: "system-capture-error",
        inputGeneration: "native-failed-before-start-settled",
      });
      sourceStateListener?.({
        source: "system",
        state: "unavailable",
        reason: "system-capture-error",
        inputGeneration: "stale-native-generation",
      });
      return {
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "wasapi-loopback",
        inputGeneration: "native-failed-before-start-settled",
      };
    });

    await startRecording({
      noteId: null,
      noteTitle: "Native failure before start settles",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-native-failed-before-start-settled",
    });

    expect(window.electronAPI.onMeetingTranscriptionSourceState).toHaveBeenCalledTimes(1);
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: "System audio capture stopped.",
      captureSourceStates: { mic: "recording", system: "unavailable" },
    });
  });

  it("reports truthful source states when a required native source fails before start settles", async () => {
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockImplementationOnce(async () => {
      sourceStateListener?.({
        source: "system",
        state: "unavailable",
        reason: "system-capture-error",
        inputGeneration: "required-native-failed-early",
      });
      return {
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "wasapi-loopback",
        inputGeneration: "required-native-failed-early",
      };
    });

    await expect(
      startRecording({
        noteId: null,
        noteTitle: "Required native source failed early",
        folderId: null,
        captureMicrophone: false,
        captureSystemAudio: true,
        requireAllSources: true,
        jarvisSessionId: "s-required-native-failed-early",
      })
    ).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "idle", system: "unavailable" },
    });
  });

  it("preserves native system unavailability observed during initial mic setup", async () => {
    const initialAddModule = createDeferred<void>();
    class DelayedNativeMicAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedNativeMicAudioContext);
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "native-unavailable-during-mic-generation",
    });

    const start = startRecording({
      noteId: null,
      noteTitle: "Native unavailable during mic setup",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-native-unavailable-during-mic",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    sourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "native-unavailable-during-mic-generation",
    });
    initialAddModule.resolve();
    await start;

    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: "System audio capture stopped.",
      captureSourceStates: { mic: "recording", system: "unavailable" },
    });
  });

  it("fails setup when native system and optional initial mic are both lost", async () => {
    const initialAddModule = createDeferred<void>();
    class DelayedNoSurvivorAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedNoSurvivorAudioContext);
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "native-no-survivor-generation",
    });

    const start = startRecording({
      noteId: null,
      noteTitle: "Native and mic lost during setup",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-native-no-survivor",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    sourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "native-no-survivor-generation",
    });
    track.end();
    initialAddModule.resolve();
    await start;

    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledWith(
      "s-native-no-survivor",
      "mic",
      expect.objectContaining({ reason: "mic-pipeline-attach-failed" })
    );
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      captureSourceStates: { mic: "recovering", system: "unavailable" },
    });
  });

  it("interrupts renderer loopback once when its active track ends and stream becomes inactive", async () => {
    const systemTrack = new FakeTrack("Computer audio", "system-loopback");
    const systemStream = streamFor(systemTrack);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "input-generation-loopback-state",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Dual loopback state",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-loopback-state",
    });
    systemTrack.end();
    systemStream.dispatchEvent(new Event("inactive"));

    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "recovering",
    });
    await vi.waitFor(() => {
      expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    });
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledWith(
      "s-loopback-state",
      "system",
      expect.objectContaining({ reason: "system-renderer-ended" })
    );
  });

  it("recovers renderer loopback before replacement PCM while microphone PCM continues", async () => {
    const micTrack = new FakeTrack("Physical microphone", "mic-survivor");
    const initialSystemTrack = new FakeTrack("Old computer audio", "old-system-loopback");
    const replacementSystemTrack = new FakeTrack(
      "Replacement computer audio",
      "replacement-system-loopback"
    );
    const initialSystemStream = streamFor(initialSystemTrack);
    const replacementSystemStream = streamFor(replacementSystemTrack);
    const restoration = createDeferred<
      Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceRestored"]>>
    >();
    const replacementChunk = new ArrayBuffer(8);
    const survivingMicChunk = new ArrayBuffer(6);
    workletChunksOnAttach.push([], [], [replacementChunk]);
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(streamFor(micTrack));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValueOnce(initialSystemStream)
        .mockResolvedValueOnce(replacementSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "renderer-loopback-recovery-generation",
    });
    vi.mocked(window.electronAPI.jarvis.sourceRestored).mockReturnValueOnce(restoration.promise);

    await startRecording({
      noteId: null,
      noteTitle: "Renderer loopback recovery",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-renderer-loopback-recovery",
    });

    initialSystemTrack.end();
    initialSystemStream.dispatchEvent(new Event("inactive"));

    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
      expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledOnce();
    });
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "recovering",
    });

    audioWorkletNodes[0].port.onmessage?.({ data: survivingMicChunk } as MessageEvent<ArrayBuffer>);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledWith(
      survivingMicChunk,
      "mic",
      "renderer-loopback-recovery-generation"
    );
    expect(
      vi
        .mocked(window.electronAPI.meetingTranscriptionSend!)
        .mock.calls.some(([chunk, source]) => chunk === replacementChunk && source === "system")
    ).toBe(false);

    restoration.resolve({
      sessionId: "s-renderer-loopback-recovery",
      status: "recording",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    });

    await vi.waitFor(() => {
      expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledWith(
        replacementChunk,
        "system",
        "renderer-loopback-recovery-generation"
      );
      expect(useMeetingRecordingStore.getState().captureSourceStates.system).toBe("recording");
    });
    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledWith(
      "s-renderer-loopback-recovery",
      "system",
      expect.objectContaining({
        deviceId: "replacement-system-loopback",
        deviceLabel: "Replacement computer audio",
        strategy: "loopback",
      })
    );
    expect(
      vi.mocked(window.electronAPI.jarvis.sourceRestored).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi
        .mocked(window.electronAPI.meetingTranscriptionSend!)
        .mock.invocationCallOrder.find((_, index) => {
          const [chunk, source] = vi.mocked(window.electronAPI.meetingTranscriptionSend!).mock.calls[
            index
          ];
          return chunk === replacementChunk && source === "system";
        }) as number
    );
  });

  it("reopens the renderer gap and retries when a restored loopback cannot attach", async () => {
    const micTrack = new FakeTrack("Physical microphone", "mic-attach-retry");
    const initialSystemTrack = new FakeTrack("Old computer audio", "old-system-attach-retry");
    const failedReplacementTrack = new FakeTrack(
      "Failed replacement computer audio",
      "failed-system-attach-retry"
    );
    const workingReplacementTrack = new FakeTrack(
      "Working replacement computer audio",
      "working-system-attach-retry"
    );
    const initialSystemStream = streamFor(initialSystemTrack);
    const failedReplacementStream = streamFor(failedReplacementTrack);
    const workingReplacementStream = streamFor(workingReplacementTrack);
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(streamFor(micTrack));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValueOnce(initialSystemStream)
        .mockResolvedValueOnce(failedReplacementStream)
        .mockResolvedValueOnce(workingReplacementStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "renderer-loopback-attach-retry-generation",
    });
    onAudioContextCreated = (context, index) => {
      if (index === 2) {
        context.audioWorklet.addModule = vi.fn(async () => {
          throw new Error("replacement worklet unavailable");
        });
      }
    };

    await startRecording({
      noteId: null,
      noteTitle: "Renderer attach retry",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-renderer-attach-retry",
    });

    initialSystemTrack.end();
    initialSystemStream.dispatchEvent(new Event("inactive"));

    await vi.waitFor(
      () => {
        expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(3);
        expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledTimes(2);
        expect(useMeetingRecordingStore.getState().captureSourceStates.system).toBe("recording");
      },
      { timeout: 2_000 }
    );

    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenNthCalledWith(
      2,
      "s-renderer-attach-retry",
      "system",
      expect.objectContaining({ reason: "system-renderer-pipeline-attach-failed" })
    );
    expect(failedReplacementTrack.stop).toHaveBeenCalledOnce();
    expect(workingReplacementTrack.stop).not.toHaveBeenCalled();
  });

  it("stops a renderer recovery candidate and ignores late restoration after a new generation", async () => {
    const micTrack = new FakeTrack("Physical microphone", "mic-late-system-restore");
    const initialSystemTrack = new FakeTrack("Old computer audio", "old-system-late-restore");
    const replacementSystemTrack = new FakeTrack(
      "Late replacement computer audio",
      "late-system-restore"
    );
    const initialSystemStream = streamFor(initialSystemTrack);
    const replacementSystemStream = streamFor(replacementSystemTrack);
    const restoration = createDeferred<
      Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceRestored"]>>
    >();
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(micTrack))
      .mockResolvedValueOnce(streamFor(new FakeTrack("New microphone", "new-mic-generation")));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValueOnce(initialSystemStream)
        .mockResolvedValueOnce(replacementSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: "loopback",
        inputGeneration: "old-renderer-loopback-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-mic-only-generation",
      });
    vi.mocked(window.electronAPI.jarvis.sourceRestored).mockReturnValueOnce(restoration.promise);

    await startRecording({
      noteId: null,
      noteTitle: "Old renderer recovery",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-old-renderer-recovery",
    });
    initialSystemTrack.end();
    await vi.waitFor(() => {
      expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledOnce();
    });

    await stopRecording();
    expect(replacementSystemTrack.stop).toHaveBeenCalledOnce();
    await startRecording({
      noteId: null,
      noteTitle: "New mic generation",
      folderId: null,
      captureSystemAudio: false,
      captureMicrophone: true,
      jarvisSessionId: "s-new-mic-generation",
    });

    restoration.resolve({
      sessionId: "s-old-renderer-recovery",
      status: "recording",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledOnce();
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      captureSourceStates: { mic: "recording", system: "idle" },
    });
  });

  it("releases each prior renderer system lifecycle owner across repeated recovery", async () => {
    const micTrack = new FakeTrack("Physical microphone", "mic-lifecycle-owner");
    const initialSystemTrack = new FakeTrack("Initial computer audio", "system-owner-initial");
    const firstReplacementTrack = new FakeTrack(
      "First replacement computer audio",
      "system-owner-first"
    );
    const secondReplacementTrack = new FakeTrack(
      "Second replacement computer audio",
      "system-owner-second"
    );
    const initialSystemStream = streamFor(initialSystemTrack);
    const firstReplacementStream = streamFor(firstReplacementTrack);
    const secondReplacementStream = streamFor(secondReplacementTrack);
    const initialTrackRemove = vi.spyOn(initialSystemTrack, "removeEventListener");
    const initialStreamRemove = vi.spyOn(initialSystemStream, "removeEventListener");
    const firstTrackRemove = vi.spyOn(firstReplacementTrack, "removeEventListener");
    const firstStreamRemove = vi.spyOn(firstReplacementStream, "removeEventListener");
    const secondTrackRemove = vi.spyOn(secondReplacementTrack, "removeEventListener");
    const secondStreamRemove = vi.spyOn(secondReplacementStream, "removeEventListener");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(streamFor(micTrack));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValueOnce(initialSystemStream)
        .mockResolvedValueOnce(firstReplacementStream)
        .mockResolvedValueOnce(secondReplacementStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "renderer-lifecycle-owner-generation",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Renderer lifecycle owner",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-renderer-lifecycle-owner",
    });

    initialSystemTrack.end();
    await vi.waitFor(
      () => {
        expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
        expect(useMeetingRecordingStore.getState().captureSourceStates.system).toBe("recording");
      },
      { timeout: 2_000 }
    );
    expect(initialTrackRemove).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(initialStreamRemove).toHaveBeenCalledWith("inactive", expect.any(Function));

    firstReplacementTrack.end();
    await vi.waitFor(
      () => {
        expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(3);
        expect(useMeetingRecordingStore.getState().captureSourceStates.system).toBe("recording");
      },
      { timeout: 2_000 }
    );
    expect(firstTrackRemove).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(firstStreamRemove).toHaveBeenCalledWith("inactive", expect.any(Function));
    expect(secondTrackRemove).not.toHaveBeenCalled();
    expect(secondStreamRemove).not.toHaveBeenCalled();

    initialSystemStream.dispatchEvent(new Event("inactive"));
    firstReplacementStream.dispatchEvent(new Event("inactive"));
    initialSystemTrack.dispatchEvent(new Event("ended"));
    firstReplacementTrack.dispatchEvent(new Event("ended"));
    await Promise.resolve();
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(3);

    await stopRecording();
    expect(secondTrackRemove).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(secondStreamRemove).toHaveBeenCalledWith("inactive", expect.any(Function));
  });

  it("retries renderer system interruption persistence after ended and inactive are exhausted", async () => {
    const systemTrack = new FakeTrack("Computer audio", "system-persistence-retry");
    const systemStream = streamFor(systemTrack);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "renderer-persistence-retry-generation",
    });
    vi.mocked(window.electronAPI.jarvis.sourceInterrupted)
      .mockRejectedValueOnce(new Error("temporary persistence failure"))
      .mockResolvedValue({
        sessionId: "s-renderer-persistence-retry",
        status: "degraded",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      });

    await startRecording({
      noteId: null,
      noteTitle: "Renderer interruption persistence retry",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-renderer-persistence-retry",
    });

    vi.useFakeTimers();
    systemTrack.end();
    systemStream.dispatchEvent(new Event("inactive"));
    await vi.advanceTimersByTimeAsync(0);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);
    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "recovering",
    });
    vi.useRealTimers();
  });

  it("cancels renderer system interruption persistence retry before a new meeting", async () => {
    const oldSystemTrack = new FakeTrack("Old computer audio", "old-system-persistence");
    const oldSystemStream = streamFor(oldSystemTrack);
    const newMicTrack = new FakeTrack("New meeting microphone", "new-after-persistence");
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => oldSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      streamFor(newMicTrack)
    );
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: "loopback",
        inputGeneration: "old-system-persistence-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-after-persistence-generation",
      });
    vi.mocked(window.electronAPI.jarvis.sourceInterrupted).mockRejectedValue(
      new Error("persistent interruption failure")
    );

    await startRecording({
      noteId: null,
      noteTitle: "Old system persistence meeting",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: false,
      requireAllSources: true,
      jarvisSessionId: "s-old-system-persistence",
    });

    vi.useFakeTimers();
    oldSystemTrack.end();
    oldSystemStream.dispatchEvent(new Event("inactive"));
    await vi.advanceTimersByTimeAsync(0);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);

    const stoppedOldMeeting = stopRecording();
    await vi.advanceTimersByTimeAsync(50);
    await stoppedOldMeeting;
    await startRecording({
      noteId: null,
      noteTitle: "New meeting after persistence stop",
      folderId: null,
      captureSystemAudio: false,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-new-after-persistence",
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    expect(newMicTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "New meeting microphone",
      captureSourceStates: { mic: "recording", system: "idle" },
    });
    vi.useRealTimers();
  });

  it("ignores detached loopback and source-state events after a new session starts", async () => {
    const oldSystemTrack = new FakeTrack("Old computer audio", "old-system-loopback");
    const oldSystemStream = streamFor(oldSystemTrack);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => oldSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "input-generation-old-loopback",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Old system-only loopback",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: false,
      requireAllSources: true,
      jarvisSessionId: "s-old-loopback",
    });
    const oldSourceStateListener = sourceStateListeners[0];
    await stopRecording();

    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-new-native",
    });
    await startRecording({
      noteId: null,
      noteTitle: "New dual capture",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-new-native",
    });

    oldSystemTrack.end();
    oldSystemStream.dispatchEvent(new Event("inactive"));
    oldSourceStateListener?.({
      source: "system",
      state: "unavailable",
      reason: "system-capture-error",
      inputGeneration: "input-generation-old-loopback",
    });

    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "recording",
    });
    expect(window.electronAPI.jarvis.sourceInterrupted).not.toHaveBeenCalled();
  });

  it("preserves the required-source diagnosis when main cleanup also fails", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" })
    );
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-cleanup-failure",
    });
    vi.mocked(window.electronAPI.meetingTranscriptionStop!).mockRejectedValueOnce(
      new Error("main stop failed")
    );

    await expect(
      startRecording({
        noteId: null,
        noteTitle: "Dual cleanup failure",
        folderId: null,
        captureSystemAudio: true,
        captureMicrophone: true,
        requireAllSources: true,
        jarvisSessionId: "s-cleanup-failure",
      })
    ).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "unavailable", system: "ready" },
    });
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      error: "capture_source_unavailable",
      isRecording: false,
      captureSourceStates: { mic: "unavailable", system: "ready" },
    });
  });

  it("rejects a dual-source start when mic is unavailable and atomically stops main capture", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" })
    );
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-dual-required",
    });

    await expect(
      startRecording({
        noteId: null,
        noteTitle: "Dual",
        folderId: null,
        captureSystemAudio: true,
        captureMicrophone: true,
        micOnly: false,
        requireAllSources: true,
        jarvisSessionId: "s-dual-required",
      })
    ).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "unavailable", system: "ready" },
    });

    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      captureSourceStates: { mic: "unavailable", system: "ready" },
    });
    expect(audioContexts).toHaveLength(0);
  });

  it("stops the renderer producer after authoritative Jarvis input rejection", async () => {
    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-backpressure",
      diarizationEnabled: true,
    });
    const producer = audioWorkletNodes[0];
    const first = new ArrayBuffer(4);
    producer.port.onmessage?.({ data: first } as MessageEvent<ArrayBuffer>);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenLastCalledWith(
      first,
      "mic",
      "input-generation-1"
    );

    inputRejectedListener?.({
      source: "mic",
      reason: "jarvis-evidence-backpressure",
      inputGeneration: "input-generation-1",
    });
    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        isRecording: false,
        isTranscribing: false,
        error: "Jarvis stopped accepting audio evidence.",
      });
      expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    });

    producer.port.onmessage?.({ data: new ArrayBuffer(4) } as MessageEvent<ArrayBuffer>);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledTimes(1);
  });

  it("ignores an old rejection after a new generation starts", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () =>
      streamFor(new FakeTrack())
    );
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "input-generation-old",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "input-generation-current",
      });

    await startRecording({
      noteId: null,
      noteTitle: "Old",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-old",
    });
    const oldListener = inputRejectedListeners[0];
    await stopRecording();
    await startRecording({
      noteId: null,
      noteTitle: "Current",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-current",
    });

    oldListener({
      source: "mic",
      reason: "jarvis-evidence-backpressure",
      inputGeneration: "input-generation-old",
    });
    await Promise.resolve();

    expect(useMeetingRecordingStore.getState().isRecording).toBe(true);
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledTimes(1);
    const currentProducer = audioWorkletNodes.at(-1)!;
    const currentChunk = new ArrayBuffer(4);
    currentProducer.port.onmessage?.({ data: currentChunk } as MessageEvent<ArrayBuffer>);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenLastCalledWith(
      currentChunk,
      "mic",
      "input-generation-current"
    );
  });

  it("passes the current generation through buffered and immediate mic and system sends", async () => {
    const micPending = new ArrayBuffer(4);
    const systemPending = new ArrayBuffer(6);
    workletChunksOnAttach.push([micPending], [systemPending]);
    const systemTrack = new FakeTrack();
    const systemStream = streamFor(systemTrack);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "input-generation-dual",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Dual",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-dual",
    });

    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "recording",
    });

    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenNthCalledWith(
      1,
      micPending,
      "mic",
      "input-generation-dual"
    );
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenNthCalledWith(
      2,
      systemPending,
      "system",
      "input-generation-dual"
    );

    const micImmediate = new ArrayBuffer(8);
    const systemImmediate = new ArrayBuffer(10);
    audioWorkletNodes[0].port.onmessage?.({ data: micImmediate } as MessageEvent<ArrayBuffer>);
    audioWorkletNodes[1].port.onmessage?.({ data: systemImmediate } as MessageEvent<ArrayBuffer>);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenNthCalledWith(
      3,
      micImmediate,
      "mic",
      "input-generation-dual"
    );
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenNthCalledWith(
      4,
      systemImmediate,
      "system",
      "input-generation-dual"
    );
  });

  it("stops a buffered burst immediately when the current generation is rejected", async () => {
    const first = new ArrayBuffer(4);
    const second = new ArrayBuffer(4);
    workletChunksOnAttach.push([first, second]);
    vi.mocked(window.electronAPI.meetingTranscriptionSend!).mockImplementation(
      (_chunk, _source, inputGeneration) => {
        if (inputGeneration !== "input-generation-1") return;
        inputRejectedListener?.({
          source: "mic",
          reason: "jarvis-evidence-backpressure",
          inputGeneration,
        });
      }
    );

    await startRecording({
      noteId: null,
      noteTitle: "Burst",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-burst",
    });
    await vi.waitFor(() => {
      expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    });

    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledWith(
      first,
      "mic",
      "input-generation-1"
    );
  });

  it("falls back to the system default when the pinned microphone cannot open", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const fallbackTrack = new FakeTrack();
    fallbackTrack.label = "System default microphone";
    const fallbackStream = {
      getAudioTracks: () => [fallbackTrack],
      getTracks: () => [fallbackTrack],
    } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFoundError" }))
      .mockResolvedValueOnce(fallbackStream);

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-fallback-start",
      diarizationEnabled: true,
    });

    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "System default microphone",
      micFallbackActive: true,
      error: null,
    });
  });

  it("hot-swaps to the default microphone without ending the Jarvis session", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const fallbackTrack = new FakeTrack();
    fallbackTrack.label = "System default microphone";
    const fallbackStream = {
      getAudioTracks: () => [fallbackTrack],
      getTracks: () => [fallbackTrack],
    } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream)
      .mockResolvedValueOnce(fallbackStream);

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-hot-swap",
      diarizationEnabled: true,
    });
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));

    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        isRecording: true,
        activeMicLabel: "System default microphone",
        micFallbackActive: true,
        error: null,
      });
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("recovers the microphone in dual mode without overwriting computer-audio state", async () => {
    const replacementTrack = new FakeTrack("Replacement microphone", "replacement-mic");
    const replacementCapture = createDeferred<MediaStream>();
    const restoration = createDeferred<Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceRestored"]>>>();
    vi.mocked(window.electronAPI.jarvis.sourceRestored).mockReturnValueOnce(restoration.promise);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockImplementationOnce(() => replacementCapture.promise);
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "native" as const,
      strategy: "wasapi-loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "wasapi-loopback",
      inputGeneration: "input-generation-dual-recovery",
    });

    await startRecording({
      noteId: null,
      noteTitle: "Dual recovery",
      folderId: null,
      captureSystemAudio: true,
      captureMicrophone: true,
      requireAllSources: true,
      jarvisSessionId: "s-dual-recovery",
    });
    const replacementChunk = new ArrayBuffer(8);
    workletChunksOnAttach.push([replacementChunk]);
    track.end();

    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
        mic: "recovering",
        system: "recording",
      });
    });
    replacementCapture.resolve(streamFor(replacementTrack));
    await vi.waitFor(() => {
      expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledTimes(1);
    });
    expect(window.electronAPI.meetingTranscriptionSend).not.toHaveBeenCalledWith(
      replacementChunk,
      "mic",
      "input-generation-dual-recovery"
    );
    restoration.resolve({
      sessionId: "s-dual-recovery",
      status: "recording",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    });

    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        isRecording: true,
        activeMicLabel: "Replacement microphone",
        micRecoveryStatus: "restored",
        captureSourceStates: { mic: "recording", system: "recording" },
      });
    });
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledWith(
      "s-dual-recovery",
      "mic",
      expect.objectContaining({ reason: "mic-track-ended" })
    );
    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledWith(
      "s-dual-recovery",
      "mic",
      expect.objectContaining({
        deviceId: "replacement-mic",
        deviceLabel: "Replacement microphone",
        strategy: "web-audio",
      })
    );
    expect(
      vi.mocked(window.electronAPI.jarvis.sourceRestored).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(window.electronAPI.meetingTranscriptionSend!).mock.invocationCallOrder.find(
        (_order, index) =>
          vi.mocked(window.electronAPI.meetingTranscriptionSend!).mock.calls[index]?.[0] ===
          replacementChunk
      ) as number
    );
    track.dispatchEvent(new Event("ended"));
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("retries a failed restoration response with the same payload and replacement stream", async () => {
    vi.useFakeTimers();
    const replacementTrack = new FakeTrack("Stable replacement", "stable-replacement");
    const unexpectedTrack = new FakeTrack("Unexpected replacement", "unexpected-replacement");
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(replacementTrack))
      .mockResolvedValueOnce(streamFor(unexpectedTrack));
    vi.mocked(window.electronAPI.jarvis.sourceRestored)
      .mockRejectedValueOnce(new Error("response channel closed after commit"))
      .mockResolvedValueOnce({
        sessionId: "s-restoration-response-retry",
        status: "recording",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      });

    await startRecording({
      noteId: null,
      noteTitle: "Restoration response retry",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-restoration-response-retry",
    });

    track.end();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        activeMicLabel: "Stable replacement",
        micRecoveryStatus: "restored",
      });
    });

    const restorationCalls = vi.mocked(window.electronAPI.jarvis.sourceRestored).mock.calls;
    expect(restorationCalls).toHaveLength(2);
    expect(restorationCalls[1]).toEqual(restorationCalls[0]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(replacementTrack.stop).not.toHaveBeenCalled();
    expect(unexpectedTrack.stop).not.toHaveBeenCalled();
  });

  it("stops a recovery candidate immediately when stop occurs during restoration persistence", async () => {
    const replacementTrack = new FakeTrack("Pending restoration", "pending-restoration");
    const pendingRestoration = createDeferred<
      Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceRestored"]>>
    >();
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(replacementTrack));
    vi.mocked(window.electronAPI.jarvis.sourceRestored).mockReturnValueOnce(
      pendingRestoration.promise
    );

    await startRecording({
      noteId: null,
      noteTitle: "Pending restoration stop",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-pending-restoration-stop",
    });
    track.end();
    await vi.waitFor(() =>
      expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledOnce()
    );

    await stopRecording();
    const stopCallsAtStopCompletion = replacementTrack.stop.mock.calls.length;
    pendingRestoration.resolve({
      sessionId: "s-pending-restoration-stop",
      status: "recording",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    });
    await vi.waitFor(() => expect(replacementTrack.stop).toHaveBeenCalledOnce());

    expect(stopCallsAtStopCompletion).toBe(1);
    expect(audioContexts).toHaveLength(1);
    expect(useMeetingRecordingStore.getState().isRecording).toBe(false);
  });

  it("releases a recovery stream and context immediately when worklet setup is pending", async () => {
    const replacementTrack = new FakeTrack("Pending worklet", "pending-worklet");
    const pendingWorklet = createDeferred<void>();
    class PendingRecoveryWorkletAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 2) {
          this.audioWorklet.addModule = vi.fn(() => pendingWorklet.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", PendingRecoveryWorkletAudioContext);
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(replacementTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Pending worklet stop",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-pending-worklet-stop",
    });
    track.end();
    await vi.waitFor(() => expect(audioContexts).toHaveLength(2));
    await vi.waitFor(() => expect(audioContexts[1].audioWorklet.addModule).toHaveBeenCalledOnce());

    await stopRecording();
    const stopCallsAtStopCompletion = replacementTrack.stop.mock.calls.length;
    const closeCallsAtStopCompletion = audioContexts[1].close.mock.calls.length;
    pendingWorklet.resolve();
    await vi.waitFor(() => expect(replacementTrack.stop).toHaveBeenCalledOnce());

    expect(stopCallsAtStopCompletion).toBe(1);
    expect(closeCallsAtStopCompletion).toBe(1);
    expect(audioContexts[1].close).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState().isRecording).toBe(false);
  });

  it("keeps the original microphone interruption timestamp across persistence retries", async () => {
    vi.useFakeTimers();
    const firstPersistence = createDeferred<
      Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceInterrupted"]>>
    >();
    vi.mocked(window.electronAPI.jarvis.sourceInterrupted)
      .mockReturnValueOnce(firstPersistence.promise)
      .mockResolvedValueOnce({
        sessionId: "s-interruption-payload-retry",
        status: "degraded",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      });

    await startRecording({
      noteId: null,
      noteTitle: "Interruption payload retry",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-interruption-payload-retry",
    });

    track.end();
    await vi.waitFor(() =>
      expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1)
    );
    await vi.advanceTimersByTimeAsync(321);
    firstPersistence.reject(new Error("temporary interruption persistence failure"));
    await vi.waitFor(() =>
      expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2)
    );

    const interruptionCalls = vi.mocked(window.electronAPI.jarvis.sourceInterrupted).mock.calls;
    expect(interruptionCalls[1]).toEqual(interruptionCalls[0]);
    expect(interruptionCalls[0][2]).toMatchObject({ reason: "mic-track-ended" });
  });

  it("keeps an attach-failure interruption reason and timestamp until it is persisted", async () => {
    vi.useFakeTimers();
    const failedTrack = new FakeTrack("Failed replacement", "failed-replacement");
    const attachFailurePersistence = createDeferred<
      Awaited<ReturnType<RecordingDependencies["jarvis"]["sourceInterrupted"]>>
    >();
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(failedTrack));
    vi.mocked(window.electronAPI.jarvis.sourceInterrupted)
      .mockResolvedValueOnce({
        sessionId: "s-attach-interruption-retry",
        status: "degraded",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      })
      .mockReturnValueOnce(attachFailurePersistence.promise)
      .mockResolvedValueOnce({
        sessionId: "s-attach-interruption-retry",
        status: "degraded",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      });

    await startRecording({
      noteId: null,
      noteTitle: "Attach interruption retry",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-attach-interruption-retry",
    });
    class FailingRecoveryAudioContext extends FakeAudioContext {
      createAnalyser = vi.fn(() => {
        throw new Error("replacement analyser failed");
      });
    }
    vi.stubGlobal("AudioContext", FailingRecoveryAudioContext);

    track.end();
    await vi.waitFor(() =>
      expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2)
    );
    await vi.advanceTimersByTimeAsync(321);
    attachFailurePersistence.reject(new Error("temporary attach interruption failure"));
    await vi.waitFor(() =>
      expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(3)
    );

    const interruptionCalls = vi.mocked(window.electronAPI.jarvis.sourceInterrupted).mock.calls;
    expect(interruptionCalls[1][2]).toMatchObject({ reason: "mic-pipeline-attach-failed" });
    expect(interruptionCalls[2]).toEqual(interruptionCalls[1]);
  });

  it("re-interrupts after a restored microphone cannot attach and keeps retrying", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const failedTrack = new FakeTrack("Failed replacement", "failed-mic");
    const goodTrack = new FakeTrack("Good replacement", "good-mic");
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(failedTrack))
      .mockResolvedValueOnce(streamFor(goodTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Attach retry",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-attach-retry",
    });

    let failNextAnalyser = true;
    class FailFirstRecoveryAudioContext extends FakeAudioContext {
      createAnalyser = vi.fn(() => {
        if (failNextAnalyser) {
          failNextAnalyser = false;
          throw new Error("replacement analyser failed");
        }
        return Object.assign(new FakeAudioNode(), {
          fftSize: 0,
          smoothingTimeConstant: 0,
        });
      });
    }
    vi.stubGlobal("AudioContext", FailFirstRecoveryAudioContext);

    track.end();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        activeMicLabel: "Good replacement",
        micRecoveryStatus: "restored",
      });
    });

    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenNthCalledWith(
      2,
      "s-attach-retry",
      "mic",
      expect.objectContaining({ reason: "mic-pipeline-attach-failed" })
    );
    expect(failedTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("re-interrupts and retries when a replacement track ends during worklet setup", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const deadReplacementTrack = new FakeTrack("Dead replacement", "dead-replacement");
    const healthyReplacementTrack = new FakeTrack("Healthy replacement", "healthy-replacement");
    const replacementAddModule = createDeferred<void>();
    class DelayedReplacementAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 2) {
          this.audioWorklet.addModule = vi.fn(() => replacementAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedReplacementAudioContext);
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(deadReplacementTrack))
      .mockResolvedValueOnce(streamFor(healthyReplacementTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Ended during replacement setup",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-ended-replacement",
    });
    track.end();
    await vi.waitFor(() => expect(audioContexts).toHaveLength(2));

    deadReplacementTrack.end();
    replacementAddModule.resolve();

    await vi.waitFor(
      () => {
        expect(useMeetingRecordingStore.getState()).toMatchObject({
          isRecording: true,
          activeMicLabel: "Healthy replacement",
          micRecoveryStatus: "restored",
          captureSourceStates: { mic: "recording", system: "idle" },
        });
      },
      { timeout: 2_000 }
    );
    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenNthCalledWith(
      2,
      "s-ended-replacement",
      "mic",
      expect.objectContaining({ reason: "mic-pipeline-attach-failed" })
    );
    expect(deadReplacementTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("keeps retrying after failed recovery cycles without stopping the session", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFoundError" }));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-unlimited-recovery",
      diarizationEnabled: true,
    });
    track.end();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(5);
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: null,
      micRecoveryStatus: "reconnecting",
      micRecoveryAttempt: 6,
    });
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("rejects a Sonar default stream and later attaches a physical microphone", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ selectedMicDeviceId: "missing-physical", preferBuiltInMic: false });
    const sonarTrack = new FakeTrack("SteelSeries Sonar - Microphone", "sonar");
    const shureTrack = new FakeTrack("Microphone (5- Shure MV7)", "shure");
    vi.mocked(navigator.mediaDevices.enumerateDevices)
      .mockResolvedValueOnce([])
      .mockResolvedValue([inputDevice("shure", shureTrack.label)]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(sonarTrack))
      .mockResolvedValueOnce(streamFor(shureTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-filter-virtual",
      diarizationEnabled: true,
    });
    track.end();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(100);

    expect(sonarTrack.stop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: shureTrack.label,
      micRecoveryStatus: "restored",
      micRecoveryAttempt: 0,
    });
  });

  it("re-enumerates and opens a physical microphone before default on initial fallback", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "missing-physical", preferBuiltInMic: false });
    const shureTrack = new FakeTrack("Microphone (5- Shure MV7)", "shure");
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
      inputDevice("shure", shureTrack.label),
      inputDevice("sonar", "SteelSeries Sonar - Microphone"),
    ]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFoundError" }))
      .mockResolvedValueOnce(streamFor(shureTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-safe-initial-fallback",
      diarizationEnabled: true,
    });

    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.objectContaining({ deviceId: { exact: "shure" } }),
    });
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: shureTrack.label,
      micFallbackActive: true,
      error: null,
    });
  });

  it("recovers again when a replacement track later ends", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "first", preferBuiltInMic: false });
    const firstReplacement = new FakeTrack("Microphone (5- Shure MV7)", "first");
    const secondReplacement = new FakeTrack("Microphone (6- Arctis Nova Pro)", "second");
    vi.mocked(navigator.mediaDevices.enumerateDevices)
      .mockResolvedValueOnce([inputDevice("first", firstReplacement.label)])
      .mockResolvedValueOnce([inputDevice("second", secondReplacement.label)]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(firstReplacement))
      .mockResolvedValueOnce(streamFor(secondReplacement));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-repeat-recovery",
      diarizationEnabled: true,
    });
    track.end();
    await vi.waitFor(() =>
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        activeMicLabel: firstReplacement.label,
        micRecoveryStatus: "restored",
      })
    );
    firstReplacement.end();
    await vi.waitFor(() =>
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        activeMicLabel: secondReplacement.label,
        micRecoveryStatus: "restored",
      })
    );

    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: null,
      micRecoveryStatus: "restored",
    });
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("coalesces duplicate ended events into one recovery cycle", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "shure", preferBuiltInMic: false });
    const shureTrack = new FakeTrack("Microphone (5- Shure MV7)", "shure");
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
      inputDevice("shure", shureTrack.label),
    ]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(shureTrack));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-coalesce-ended",
      diarizationEnabled: true,
    });
    track.end();
    track.dispatchEvent(new Event("ended"));

    await vi.waitFor(() =>
      expect(useMeetingRecordingStore.getState().micRecoveryStatus).toBe("restored")
    );
    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("stops a replacement stream that resolves after recording is stopped", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const lateTrack = new FakeTrack("Microphone (5- Shure MV7)", "shure");
    let resolveLateStream: ((stream: MediaStream) => void) | null = null;
    const lateStream = new Promise<MediaStream>((resolve) => {
      resolveLateStream = resolve;
    });
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockImplementationOnce(() => lateStream);

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-late-replacement",
      diarizationEnabled: true,
    });
    track.end();
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    await stopRecording();
    resolveLateStream?.(streamFor(lateTrack));
    await vi.waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());

    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      activeMicLabel: null,
      micRecoveryStatus: "idle",
    });
  });

  it("does not let a delayed pre-bind start run after stop and a new meeting", async () => {
    const oldTrack = new FakeTrack("Old pre-bind microphone", "old-pre-bind-mic");
    const newTrack = new FakeTrack("New meeting microphone", "new-meeting-mic");
    const oldSystemAccess = createDeferred<{
      granted: boolean;
      status: "unsupported";
      mode: "unsupported";
      strategy: "unsupported";
    }>();
    window.electronAPI.checkSystemAudioAccess = vi.fn(() => oldSystemAccess.promise);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(newTrack))
      .mockResolvedValueOnce(streamFor(oldTrack));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-input-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "stale-old-input-generation",
      });

    const oldStart = startRecording({
      noteId: null,
      noteTitle: "Old pre-bind meeting",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      jarvisSessionId: "s-old-pre-bind",
    });
    await vi.waitFor(() => expect(window.electronAPI.checkSystemAudioAccess).toHaveBeenCalledOnce());

    await stopRecording();
    await startRecording({
      noteId: null,
      noteTitle: "New meeting",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: false,
      jarvisSessionId: "s-new-after-pre-bind",
    });
    expect(useMeetingRecordingStore.getState().activeMicLabel).toBe("New meeting microphone");

    oldSystemAccess.resolve({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      strategy: "unsupported",
    });
    await oldStart;

    expect(window.electronAPI.meetingTranscriptionStart).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(oldTrack.stop).not.toHaveBeenCalled();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "New meeting microphone",
    });
  });

  it("settles a start canceled while a compatible renderer prepare is still pending", async () => {
    const pendingPrepare = createDeferred<{
      success: boolean;
      alreadyPrepared?: boolean;
      error?: string;
    }>();
    window.electronAPI.meetingTranscriptionPrepare = vi.fn(() => pendingPrepare.promise);
    window.electronAPI.meetingTranscriptionCancel = vi.fn(async () => ({ success: true }));

    const prepare = prepareTranscription({ captureSystemAudio: false });
    await vi.waitFor(() => expect(window.electronAPI.meetingTranscriptionPrepare).toHaveBeenCalledOnce());

    const start = startRecording({
      noteId: null,
      noteTitle: "Pending compatible prepare",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: false,
      jarvisSessionId: "s-pending-compatible-prepare",
    });

    await stopRecording();
    const settledBeforePrepare = await Promise.race([
      start.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);

    pendingPrepare.resolve({ success: true });
    await Promise.all([prepare, start]);
    await prepareTranscription({ captureSystemAudio: false });

    expect(settledBeforePrepare).toBe(true);
    expect(window.electronAPI.meetingTranscriptionCancel).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionPrepare).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.meetingTranscriptionStart).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("rejects a required initial microphone that ends during worklet setup", async () => {
    const initialAddModule = createDeferred<void>();
    class DelayedInitialMicAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialMicAudioContext);

    const start = startRecording({
      noteId: null,
      noteTitle: "Initial mic ends during setup",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: false,
      requireAllSources: true,
      jarvisSessionId: "s-initial-mic-ended",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    track.end();
    initialAddModule.resolve();

    await expect(start).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "unavailable", system: "idle" },
    });
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      error: "capture_source_unavailable",
      captureSourceStates: { mic: "unavailable", system: "idle" },
    });
  });

  it("keeps system capture and recovers an optional initial mic that ends during setup", async () => {
    const recoveredMicTrack = new FakeTrack("Recovered microphone", "recovered-mic");
    const systemTrack = new FakeTrack("Computer audio", "system-survivor");
    const systemStream = streamFor(systemTrack);
    const initialMicAddModule = createDeferred<void>();
    workletChunksOnAttach.push([new ArrayBuffer(12)], [], []);
    class DelayedInitialMicAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialMicAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialMicAudioContext);
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(recoveredMicTrack));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "optional-mic-ended-generation",
    });

    const start = startRecording({
      noteId: null,
      noteTitle: "Optional mic ends during setup",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-optional-mic-ended",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    track.end();
    initialMicAddModule.resolve();
    await start;

    await vi.waitFor(
      () => {
        expect(useMeetingRecordingStore.getState()).toMatchObject({
          isRecording: true,
          activeMicLabel: "Recovered microphone",
          micRecoveryStatus: "restored",
          captureSourceStates: { mic: "recording", system: "recording" },
        });
      },
      { timeout: 2_000 }
    );
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledWith(
      "s-optional-mic-ended",
      "mic",
      expect.objectContaining({ reason: "mic-pipeline-attach-failed" })
    );
    expect(window.electronAPI.jarvis.sourceRestored).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionSend).not.toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "mic",
      expect.any(String)
    );
    expect(systemTrack.stop).not.toHaveBeenCalled();
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
  });

  it("persists one system interruption when loopback ends during worklet setup", async () => {
    const systemTrack = new FakeTrack("Computer audio", "system-ended-during-setup");
    const systemStream = streamFor(systemTrack);
    const systemAddModule = createDeferred<void>();
    workletChunksOnAttach.push([], [new ArrayBuffer(10)]);
    class DelayedSystemAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 2) {
          this.audioWorklet.addModule = vi.fn(() => systemAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedSystemAudioContext);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "system-ended-during-setup-generation",
    });

    const start = startRecording({
      noteId: null,
      noteTitle: "System ends during setup",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-system-ended-during-setup",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(2));

    systemTrack.end();
    systemAddModule.resolve();
    await start;

    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledWith(
      "s-system-ended-during-setup",
      "system",
      expect.objectContaining({ reason: "system-renderer-ended" })
    );
    expect(systemTrack.stop).toHaveBeenCalledOnce();
    expect(audioContexts[1].close).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionSend).not.toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "system",
      expect.any(String)
    );
    expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      error: "System audio capture failed. Continuing with microphone only.",
      captureSourceStates: { mic: "recording", system: "unavailable" },
    });
  });

  it("cannot attach an old initial microphone pipeline after a new meeting starts", async () => {
    const oldTrack = new FakeTrack("Old initial microphone", "old-initial-mic");
    const newTrack = new FakeTrack("New meeting microphone", "new-meeting-mic");
    const initialAddModule = createDeferred<void>();
    class DelayedInitialAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialAudioContext);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(oldTrack))
      .mockResolvedValueOnce(streamFor(newTrack));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "old-initial-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-input-generation",
      });

    const oldStart = startRecording({
      noteId: null,
      noteTitle: "Old initial meeting",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-old-initial",
      diarizationEnabled: true,
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));
    expect(audioContexts[0].audioWorklet.addModule).toHaveBeenCalledOnce();

    await stopRecording();
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    await startRecording({
      noteId: null,
      noteTitle: "New meeting",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-new-after-initial",
      diarizationEnabled: true,
    });
    expect(useMeetingRecordingStore.getState().activeMicLabel).toBe("New meeting microphone");

    initialAddModule.resolve();
    await oldStart;
    await vi.waitFor(() => expect(audioContexts[0].close).toHaveBeenCalledOnce());

    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "New meeting microphone",
      micRecoveryStatus: "idle",
    });
  });

  it("releases an unbound old loopback stream when delayed mic setup crosses a new meeting", async () => {
    const oldMicTrack = new FakeTrack("Old dual microphone", "old-dual-mic");
    const newMicTrack = new FakeTrack("New meeting microphone", "new-meeting-mic");
    const oldSystemTrack = new FakeTrack("Old computer audio", "old-system-unbound");
    const oldSystemStream = streamFor(oldSystemTrack);
    const initialAddModule = createDeferred<void>();
    class DelayedInitialDualMicAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialDualMicAudioContext);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(oldMicTrack))
      .mockResolvedValueOnce(streamFor(newMicTrack));
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => oldSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: "loopback",
        inputGeneration: "old-dual-unbound-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-after-unbound-generation",
      });

    const oldStart = startRecording({
      noteId: null,
      noteTitle: "Old dual unbound meeting",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: true,
      jarvisSessionId: "s-old-dual-unbound",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    await stopRecording();
    await startRecording({
      noteId: null,
      noteTitle: "New mic meeting",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: false,
      requireAllSources: true,
      jarvisSessionId: "s-new-after-unbound",
    });

    initialAddModule.resolve();
    await oldStart;

    await vi.waitFor(() => expect(oldMicTrack.stop).toHaveBeenCalledOnce());
    expect(oldSystemTrack.stop).toHaveBeenCalledOnce();
    expect(newMicTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "New meeting microphone",
      captureSourceStates: { mic: "recording", system: "idle" },
    });
  });

  it("releases an unbound loopback stream when initial mic interruption persistence fails", async () => {
    const systemTrack = new FakeTrack("Computer audio", "system-unbound-on-failure");
    const systemStream = streamFor(systemTrack);
    const initialAddModule = createDeferred<void>();
    class DelayedInitialMicPersistenceAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialMicPersistenceAudioContext);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "unbound-persistence-failure-generation",
    });
    vi.mocked(window.electronAPI.jarvis.sourceInterrupted).mockRejectedValueOnce(
      new Error("interruption persistence failed")
    );

    const start = startRecording({
      noteId: null,
      noteTitle: "Initial mic persistence failure",
      folderId: null,
      captureMicrophone: true,
      captureSystemAudio: true,
      requireAllSources: false,
      jarvisSessionId: "s-unbound-persistence-failure",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));

    track.end();
    initialAddModule.resolve();
    await start;

    expect(window.electronAPI.jarvis.sourceInterrupted).toHaveBeenCalledOnce();
    expect(systemTrack.stop).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
    });
  });

  it("cannot replace a new system pipeline when an old initial attach finishes late", async () => {
    const oldSystemTrack = new FakeTrack("Old computer audio", "old-system");
    const newSystemTrack = new FakeTrack("New computer audio", "new-system");
    const oldSystemStream = streamFor(oldSystemTrack);
    const newSystemStream = streamFor(newSystemTrack);
    const initialAddModule = createDeferred<void>();
    class DelayedInitialSystemAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 1) {
          this.audioWorklet.addModule = vi.fn(() => initialAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedInitialSystemAudioContext);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValueOnce(oldSystemStream)
        .mockResolvedValueOnce(newSystemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: "loopback",
        inputGeneration: "old-system-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: "loopback",
        inputGeneration: "new-system-generation",
      });

    const oldStart = startRecording({
      noteId: null,
      noteTitle: "Old system meeting",
      folderId: null,
      captureMicrophone: false,
      captureSystemAudio: true,
      requireAllSources: true,
      jarvisSessionId: "s-old-system",
    });
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));
    expect(audioContexts[0].audioWorklet.addModule).toHaveBeenCalledOnce();

    await stopRecording();
    expect(oldSystemTrack.stop).toHaveBeenCalledOnce();
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    await startRecording({
      noteId: null,
      noteTitle: "New system meeting",
      folderId: null,
      captureMicrophone: false,
      captureSystemAudio: true,
      requireAllSources: true,
      jarvisSessionId: "s-new-system",
    });
    expect(audioWorkletNodes).toHaveLength(1);
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      captureSourceStates: { mic: "idle", system: "recording" },
    });

    initialAddModule.resolve();
    await oldStart;
    expect(audioWorkletNodes).toHaveLength(1);

    expect(oldSystemTrack.stop).toHaveBeenCalledOnce();
    expect(newSystemTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      captureSourceStates: { mic: "idle", system: "recording" },
    });

    await stopRecording();
    expect(audioWorkletNodes[0].port.postMessage).toHaveBeenCalledWith("stop");
    expect(newSystemTrack.stop).toHaveBeenCalledOnce();
  });

  it("cannot attach an old recovery pipeline after a new meeting starts", async () => {
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    const oldReplacementTrack = new FakeTrack("Old replacement microphone", "old-replacement");
    const newTrack = new FakeTrack("New meeting microphone", "new-meeting-mic");
    const recoveryAddModule = createDeferred<void>();
    class DelayedRecoveryAudioContext extends FakeAudioContext {
      constructor() {
        super();
        if (audioContexts.length === 2) {
          this.audioWorklet.addModule = vi.fn(() => recoveryAddModule.promise);
        }
      }
    }
    vi.stubGlobal("AudioContext", DelayedRecoveryAudioContext);
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockResolvedValueOnce(streamFor(oldReplacementTrack))
      .mockResolvedValueOnce(streamFor(newTrack));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "old-input-generation",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "new-input-generation",
      });

    await startRecording({
      noteId: null,
      noteTitle: "Old meeting",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-old-recovery",
      diarizationEnabled: true,
    });
    track.end();
    await vi.waitFor(() => expect(audioContexts).toHaveLength(2));
    await stopRecording();

    await startRecording({
      noteId: null,
      noteTitle: "New meeting",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-new-meeting",
      diarizationEnabled: true,
    });
    expect(useMeetingRecordingStore.getState().activeMicLabel).toBe("New meeting microphone");

    recoveryAddModule.resolve();
    await vi.waitFor(() => expect(audioContexts[1].close).toHaveBeenCalledOnce());

    expect(oldReplacementTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: true,
      activeMicLabel: "New meeting microphone",
      micRecoveryStatus: "idle",
    });
  });

  it("cancels a delayed retry when recording stops", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockResolvedValueOnce(streamFor(track))
      .mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFoundError" }));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-cancel-delay",
      diarizationEnabled: true,
    });
    track.end();
    await vi.advanceTimersByTimeAsync(500);
    const callsBeforeStop = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.length;
    const stopPromise = stopRecording();
    await vi.runAllTimersAsync();
    await stopPromise;
    await vi.runAllTimersAsync();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(callsBeforeStop);
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      micRecoveryStatus: "idle",
      micRecoveryAttempt: 0,
    });
  });

  it("does not request another microphone after recovery enumeration is cancelled", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ selectedMicDeviceId: "physical-mic", preferBuiltInMic: false });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(streamFor(track));

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-cancel-enumeration",
      diarizationEnabled: true,
    });

    const enumeration = createDeferred<MediaDeviceInfo[]>();
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockImplementationOnce(
      () => enumeration.promise
    );
    track.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();

    const callsBeforeStop = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.length;
    const stopping = stopRecording();
    await vi.runAllTimersAsync();
    await stopping;

    enumeration.resolve([inputDevice("physical-mic", "Physical microphone")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it("aborts main exactly once when renderer setup fails after start acceptance", async () => {
    class FailingAudioContext extends FakeAudioContext {
      createAnalyser = vi.fn(() => {
        throw new Error("analyser setup failed");
      });
    }
    vi.stubGlobal("AudioContext", FailingAudioContext);
    vi.mocked(window.electronAPI.meetingTranscriptionStart!)
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "input-generation-failed-setup",
      })
      .mockResolvedValueOnce({
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
        inputGeneration: "input-generation-next",
      });

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-pipeline-failure-cleanup",
      diarizationEnabled: true,
    });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(1);
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState().isRecording).toBe(false);
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();

    const staleProducer = audioWorkletNodes[0];
    const nextTrack = new FakeTrack("Next microphone", "next-mic");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamFor(nextTrack));
    vi.stubGlobal("AudioContext", FakeAudioContext);

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis next",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-pipeline-next",
      diarizationEnabled: true,
    });
    staleProducer.port.onmessage?.({ data: new ArrayBuffer(4) } as MessageEvent<ArrayBuffer>);
    audioWorkletNodes.at(-1)?.port.onmessage?.({
      data: new ArrayBuffer(8),
    } as MessageEvent<ArrayBuffer>);

    expect(window.electronAPI.meetingTranscriptionStart).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.meetingTranscriptionSend).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "mic",
      "input-generation-next"
    );
    expect(useMeetingRecordingStore.getState().isRecording).toBe(true);
  });

  it("stops a late initial microphone stream after main start has already failed", async () => {
    const mainStart = createDeferred<never>();
    const microphone = createDeferred<MediaStream>();
    const lateTrack = new FakeTrack("Late microphone", "late-mic");
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockImplementationOnce(
      () => mainStart.promise
    );
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () => microphone.promise
    );

    const starting = startRecording({
      noteId: null,
      noteTitle: "Late microphone",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-late-mic-after-main-failure",
      diarizationEnabled: true,
    });
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());

    mainStart.reject(new Error("main start failed"));
    await starting;
    expect(lateTrack.stop).not.toHaveBeenCalled();

    microphone.resolve(streamFor(lateTrack));
    await vi.waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());
  });

  it("cancels a pending microphone setup before its permission promise settles", async () => {
    const microphone = createDeferred<MediaStream>();
    const lateTrack = new FakeTrack("Permission microphone", "permission-mic");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () => microphone.promise
    );

    let startSettled = false;
    const starting = startRecording({
      noteId: null,
      noteTitle: "Pending microphone permission",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-pending-mic-permission",
      diarizationEnabled: true,
    }).finally(() => {
      startSettled = true;
    });
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());

    await stopRecording();
    await vi.waitFor(() => expect(startSettled).toBe(true));
    await starting;
    expect(lateTrack.stop).not.toHaveBeenCalled();

    microphone.resolve(streamFor(lateTrack));
    await vi.waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());
  });

  it("stops the initial microphone when AudioContext construction fails", async () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error("AudioContext construction failed");
      }
    }
    vi.stubGlobal("AudioContext", ThrowingAudioContext);

    await startRecording({
      noteId: null,
      noteTitle: "AudioContext constructor failure",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-audio-context-constructor-failure",
      diarizationEnabled: true,
    });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      error: "AudioContext construction failed",
    });
  });

  it("reports a required microphone pipeline failure with truthful state and one cleanup", async () => {
    class FailingMicAudioContext extends FakeAudioContext {
      createAnalyser = vi.fn(() => {
        throw new Error("analyser setup failed");
      });
    }
    vi.stubGlobal("AudioContext", FailingMicAudioContext);

    await expect(
      startRecording({
        noteId: null,
        noteTitle: "Required mic pipeline",
        folderId: null,
        captureSystemAudio: false,
        captureMicrophone: true,
        requireAllSources: true,
        jarvisSessionId: "s-required-mic-pipeline",
      })
    ).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "unavailable", system: "idle" },
    });

    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(1);
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      error: "capture_source_unavailable",
      captureSourceStates: { mic: "unavailable", system: "idle" },
    });
  });

  it("reports a required system pipeline failure with truthful state and one cleanup", async () => {
    class FailingSystemAudioContext extends FakeAudioContext {
      createMediaStreamSource = vi.fn(() => {
        throw new Error("system pipeline creation failed");
      });
    }
    const systemTrack = new FakeTrack("Computer audio", "system-pipeline");
    const systemStream = streamFor(systemTrack);
    Object.assign(navigator.mediaDevices, {
      getDisplayMedia: vi.fn(async () => systemStream),
    });
    window.electronAPI.checkSystemAudioAccess = vi.fn(async () => ({
      granted: true,
      status: "granted" as const,
      mode: "loopback" as const,
      strategy: "loopback" as const,
    }));
    vi.mocked(window.electronAPI.meetingTranscriptionStart!).mockResolvedValueOnce({
      success: true,
      systemAudioMode: "loopback",
      systemAudioStrategy: "loopback",
      inputGeneration: "input-generation-required-system-pipeline",
    });
    vi.stubGlobal("AudioContext", FailingSystemAudioContext);

    await expect(
      startRecording({
        noteId: null,
        noteTitle: "Required system pipeline",
        folderId: null,
        captureSystemAudio: true,
        captureMicrophone: false,
        requireAllSources: true,
        jarvisSessionId: "s-required-system-pipeline",
      })
    ).rejects.toMatchObject({
      name: "CaptureSourcesUnavailableError",
      sourceStates: { mic: "idle", system: "unavailable" },
    });

    expect(window.electronAPI.meetingTranscriptionStop).toHaveBeenCalledOnce();
    expect(systemTrack.stop).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(1);
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      error: "capture_source_unavailable",
      captureSourceStates: { mic: "idle", system: "unavailable" },
    });
  });

  it("keeps concurrent starts gated until failed renderer setup is fully cleaned", async () => {
    class FailingAudioContext extends FakeAudioContext {
      createAnalyser = vi.fn(() => {
        throw new Error("analyser setup failed");
      });
    }
    const stopDeferred = createDeferred<{ success: true }>();
    const mainStart = vi.mocked(window.electronAPI.meetingTranscriptionStart!);
    const mainStop = vi.mocked(window.electronAPI.meetingTranscriptionStop!);
    mainStart.mockReset().mockResolvedValue({
      success: true,
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
      inputGeneration: "input-generation-concurrent",
    });
    mainStart.mockResolvedValueOnce({
      success: true,
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
      inputGeneration: "input-generation-failed-setup",
    });
    mainStop.mockImplementation(() => stopDeferred.promise);
    vi.stubGlobal("AudioContext", FailingAudioContext);

    const failedStart = startRecording({
      noteId: null,
      noteTitle: "Jarvis failed setup",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-failed-setup-gate",
      diarizationEnabled: true,
    });
    await vi.waitFor(() => expect(mainStop).toHaveBeenCalledOnce());

    const concurrentTrack = new FakeTrack("Concurrent microphone", "concurrent-mic");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamFor(concurrentTrack));
    vi.stubGlobal("AudioContext", FakeAudioContext);
    await startRecording({
      noteId: null,
      noteTitle: "Jarvis concurrent",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-concurrent-during-cleanup",
      diarizationEnabled: true,
    });
    const startsBeforeCleanupRelease = mainStart.mock.calls.length;

    stopDeferred.resolve({ success: true });
    await failedStart;

    expect(startsBeforeCleanupRelease).toBe(1);
    expect(mainStop).toHaveBeenCalledOnce();
    expect(useMeetingRecordingStore.getState().isRecording).toBe(false);

    const nextTrack = new FakeTrack("Next microphone", "next-mic-after-cleanup");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamFor(nextTrack));
    mainStart.mockResolvedValue({
      success: true,
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
      inputGeneration: "input-generation-after-cleanup",
    });
    await startRecording({
      noteId: null,
      noteTitle: "Jarvis after cleanup",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-after-failed-setup-cleanup",
      diarizationEnabled: true,
    });

    expect(mainStart).toHaveBeenCalledTimes(2);
    expect(useMeetingRecordingStore.getState().isRecording).toBe(true);
  });

  it("applies a cloud correction to only the matching local segment", async () => {
    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-correction",
      diarizationEnabled: true,
    });

    segmentListener?.({
      type: "final",
      text: "und der die das",
      source: "mic",
      timestamp: 1_900,
    });
    const original = useMeetingRecordingStore.getState().segments[0];
    segmentListener?.({
      type: "correction",
      text: "我们 review 一下 API budget",
      originalText: "und der die das",
      source: "mic",
      timestamp: 1_900,
    });

    expect(useMeetingRecordingStore.getState().segments[0]).toMatchObject({
      id: original.id,
      text: "我们 review 一下 API budget",
      source: "mic",
      timestamp: 1_900,
      revisionSource: "openai_correction",
    });
  });

  it("keeps one corrected segment when stop merges the authoritative main final", async () => {
    const originalText = "und der die das";
    const correctedText = "corrected bilingual transcript";
    const timestamp = 1_900;
    window.electronAPI.meetingTranscriptionStop = vi.fn(async () => {
      segmentListener?.({
        type: "final",
        text: originalText,
        source: "mic",
        timestamp,
        confidence: 0.25,
      });
      segmentListener?.({
        type: "correction",
        text: correctedText,
        originalText,
        source: "mic",
        timestamp,
        confidence: 0.95,
      });
      return {
        success: true,
        transcript: correctedText,
        finalSegments: [
          {
            text: correctedText,
            source: "mic" as const,
            timestamp,
            confidence: 0.25,
          },
        ],
      };
    });

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis corrected stop",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s-corrected-stop",
      diarizationEnabled: true,
    });
    const stopped = await stopRecording();

    expect(stopped.success).toBe(true);
    expect(stopped.finalSegments).toHaveLength(1);
    expect(stopped.finalSegments?.[0]).toMatchObject({
      text: correctedText,
      originalText,
      source: "mic",
      timestamp,
      revisionSource: "openai_correction",
    });
    expect(useMeetingRecordingStore.getState().segments).toHaveLength(1);
  });

  it("keeps listeners through source cleanup and syncs one returned final segment before ack", async () => {
    const finalSegment = {
      text: "Production final words",
      source: "mic" as const,
      timestamp: 1_900,
      startedAt: 1_100,
      endedAt: 1_900,
      confidence: 0.92,
      echoScore: 1,
    };
    window.electronAPI.meetingTranscriptionStop = vi.fn(async () => {
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(segmentListenerDetached).toBe(false);
      segmentListener?.({ ...finalSegment, type: "final" });
      return {
        success: true,
        transcript: finalSegment.text,
        diarizationSessionId: "diar-final",
        finalSegments: [finalSegment],
      };
    });

    await startRecording({
      noteId: null,
      noteTitle: "Jarvis",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s1",
      diarizationEnabled: true,
    });

    let session: SessionState = {
      id: "s1",
      status: "recording",
      startedAt: 1_000,
      activeSince: 1_000,
      accumulatedMs: 0,
      errorCode: null,
    };
    const lifecycle: string[] = [];
    const syncSegments = vi.fn(async (_id: string, segments: TranscriptSegment[]) => {
      lifecycle.push("sync");
      return segments;
    });
    const jarvis = {
      syncSegments,
    } as unknown as RecordingDependencies["jarvis"];
    const controller = createRecordingController({
      jarvis,
      ensureTranscriptionReady: vi.fn(async () => {}),
      startRecording,
      stopRecording,
      lockSpeaker: vi.fn(),
      getMeetingSnapshot: () => {
        const state = useMeetingRecordingStore.getState();
        return { segments: state.segments, isRecording: state.isRecording, error: state.error };
      },
      getSessionState: () => session,
      setSessionState: (next) => {
        session = next;
      },
      refreshSessions: vi.fn(async () => {}),
      refreshPeople: vi.fn(async () => {}),
      createId: () => "s1",
      now: () => 2_000,
      getMicDeviceId: () => null,
      getLanguage: () => "zh",
      hasRecordingConsent: () => true,
      onError: vi.fn(),
      onOperationChange: vi.fn(),
    });

    await controller.shutdown().then(() => lifecycle.push("ack"));

    expect(segmentListenerDetached).toBe(true);
    expect(useMeetingRecordingStore.getState().segments).toHaveLength(1);
    expect(useMeetingRecordingStore.getState().segments[0]).toMatchObject(finalSegment);
    expect(syncSegments).toHaveBeenCalledTimes(1);
    expect(syncSegments.mock.calls[0][1]).toHaveLength(1);
    expect(syncSegments.mock.calls[0][1][0]).toMatchObject({
      text: finalSegment.text,
      startedAt: finalSegment.startedAt,
      endedAt: finalSegment.endedAt,
      echoScore: finalSegment.echoScore,
    });
    expect(lifecycle).toEqual(["sync", "ack"]);
  });
});
