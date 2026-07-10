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
  label = "Test microphone";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = vi.fn(() => ({ deviceId: "test-mic", sampleRate: 24_000 }));
}

class FakeAudioWorkletNode extends FakeAudioNode {
  port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null,
    postMessage: vi.fn(),
  };
}

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

  beforeEach(() => {
    track = new FakeTrack();
    segmentListener = null;
    segmentListenerDetached = false;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:meeting-worklet"),
    });

    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
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
