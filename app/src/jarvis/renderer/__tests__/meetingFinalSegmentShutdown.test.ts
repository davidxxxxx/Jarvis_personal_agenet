import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../../stores/meetingRecordingStore";
import { useSettingsStore } from "../../../stores/settingsStore";
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
  return Object.assign(stream, {
    getAudioTracks: () => [streamTrack],
    getVideoTracks: () => [],
    getTracks: () => [streamTrack],
  }) as unknown as MediaStream;
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
    audioContexts.push(this);
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
        confidence?: number;
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
        state: "unavailable";
        reason: "system-capture-error";
        inputGeneration: string;
      }) => void)
    | null;
  let sourceStateListeners: Array<NonNullable<typeof sourceStateListener>>;

  beforeEach(() => {
    audioContexts.length = 0;
    audioWorkletNodes.length = 0;
    workletChunksOnAttach.length = 0;
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

  it("marks only renderer loopback unavailable when its active track ends", async () => {
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

    expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
      mic: "recording",
      system: "unavailable",
    });
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
    track.end();

    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState().captureSourceStates).toEqual({
        mic: "recovering",
        system: "recording",
      });
    });
    replacementCapture.resolve(streamFor(replacementTrack));

    await vi.waitFor(() => {
      expect(useMeetingRecordingStore.getState()).toMatchObject({
        isRecording: true,
        activeMicLabel: "Replacement microphone",
        micRecoveryStatus: "restored",
        captureSourceStates: { mic: "recording", system: "recording" },
      });
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
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
      confidence: 0.92,
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
    expect(syncSegments.mock.calls[0][1][0]).toMatchObject({ text: finalSegment.text });
    expect(lifecycle).toEqual(["sync", "ack"]);
  });
});
