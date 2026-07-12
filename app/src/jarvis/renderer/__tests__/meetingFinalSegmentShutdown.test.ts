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

const streamFor = (streamTrack: FakeTrack) =>
  ({
    getAudioTracks: () => [streamTrack],
    getVideoTracks: () => [],
    getTracks: () => [streamTrack],
  }) as unknown as MediaStream;

const inputDevice = (deviceId: string, label: string) =>
  ({ kind: "audioinput", deviceId, label }) as MediaDeviceInfo;

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

  beforeEach(() => {
    audioContexts.length = 0;
    audioWorkletNodes.length = 0;
    workletChunksOnAttach.length = 0;
    track = new FakeTrack();
    segmentListener = null;
    segmentListenerDetached = false;
    inputRejectedListener = null;
    inputRejectedListeners = [];
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
      jarvisSessionId: "s-dual",
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

  it("releases the stream and AudioContext when microphone pipeline setup fails", async () => {
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new Error("worklet setup failed");
        }
      }
    );

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
