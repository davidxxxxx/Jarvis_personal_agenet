import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingStopCoordinator } from "../../../stores/meetingStopCoordinator";
import {
  CaptureSourcesUnavailableError,
  type StopRecordingResult,
  type TranscriptSegment,
} from "../../../stores/meetingRecordingStore";
import type { SessionState, SessionStatus } from "../sessionMachine";
import {
  createRecordingController,
  recordingArgs,
  resolveJarvisWhisperModel,
  routeJarvisControl,
  type RecordingController,
  type RecordingDependencies,
} from "../useJarvisRecording";
import type { JarvisCaptureMode } from "../../types";

describe("Jarvis local Whisper model", () => {
  it("defaults Jarvis to turbo without inheriting the global base default", () => {
    expect(resolveJarvisWhisperModel({ meetingWhisperModel: "", whisperModel: "base" })).toBe(
      "turbo"
    );
  });

  it("preserves an explicit meeting model selection", () => {
    expect(resolveJarvisWhisperModel({ meetingWhisperModel: "small", whisperModel: "base" })).toBe(
      "small"
    );
  });
});

describe("Jarvis capture argument mapping", () => {
  it.each([
    ["mic", false, true, true],
    ["system", true, false, false],
    ["dual", true, true, false],
  ] as Array<[JarvisCaptureMode, boolean, boolean, boolean]>)(
    "maps %s without silently changing its sources",
    (mode, captureSystemAudio, captureMicrophone, micOnly) => {
      expect(recordingArgs("session-1", mode)).toMatchObject({
        captureSystemAudio,
        captureMicrophone,
        micOnly,
        requireAllSources: true,
      });
    }
  );
});

const stableSegment: TranscriptSegment = {
  id: "seg-1",
  text: "Ship the capture foundation",
  source: "mic",
  timestamp: 1_250,
  speaker: "self",
  speakerName: "Me",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sessionFor(status: SessionStatus): SessionState {
  if (status === "idle") {
    return {
      id: null,
      status,
      startedAt: null,
      activeSince: null,
      accumulatedMs: 0,
      errorCode: null,
    };
  }
  return {
    id: "s1",
    status,
    startedAt: 1_000,
    activeSince: status === "recording" ? 1_000 : null,
    accumulatedMs: status === "paused" ? 500 : 0,
    errorCode: null,
  };
}

function createHarness({
  status = "idle",
  segments = [] as TranscriptSegment[],
  hasConsent = true,
  captureMode = "mic" as JarvisCaptureMode,
  micDeviceId = null as string | null,
}: {
  status?: SessionStatus;
  segments?: TranscriptSegment[];
  hasConsent?: boolean;
  captureMode?: JarvisCaptureMode;
  micDeviceId?: string | null;
} = {}) {
  const calls: string[] = [];
  let session = sessionFor(status);
  let meeting = {
    segments,
    isRecording: status === "recording",
    error: null as string | null,
  };

  const jarvis: RecordingDependencies["jarvis"] = {
    createSession: vi.fn<RecordingDependencies["jarvis"]["createSession"]>(async (input) => {
      calls.push("jarvis:create");
      return {
        id: input.id,
        started_at: input.startedAt,
        ended_at: null,
        status: "recording",
        mic_device_id: input.micDeviceId,
        language: input.language ?? "zh",
        created_at: input.startedAt,
        capture_mode: input.captureMode ?? "mic",
      };
    }),
    setSessionStatus: vi.fn(async () => null),
    listSessions: vi.fn<RecordingDependencies["jarvis"]["listSessions"]>(async () => [
      {
        id: "s1",
        started_at: 1_000,
        ended_at: null,
        status: "recording",
        mic_device_id: null,
        language: "zh",
        created_at: 1_000,
        capture_mode: "mic",
      },
    ]),
    startCapture: vi.fn<RecordingDependencies["jarvis"]["startCapture"]>(async (input) => {
      calls.push("jarvis:start");
      return {
        sessionId: input.sessionId,
        status: "recording",
        startedAt: input.startedAt,
        elapsedMs: 0,
        errorCode: null,
      };
    }),
    sourceInterrupted: vi.fn<RecordingDependencies["jarvis"]["sourceInterrupted"]>(
      async (id) => ({
        sessionId: id,
        status: "degraded",
        startedAt: 1_000,
        elapsedMs: 0,
        errorCode: null,
      })
    ),
    sourceRestored: vi.fn<RecordingDependencies["jarvis"]["sourceRestored"]>(async (id) => ({
      sessionId: id,
      status: "recording",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    })),
    pauseCapture: vi.fn<RecordingDependencies["jarvis"]["pauseCapture"]>(async (id, at = 1_500) => {
      calls.push("jarvis:pause");
      return {
        sessionId: id,
        status: "paused",
        startedAt: 1_000,
        elapsedMs: at - 1_000,
        errorCode: null,
      };
    }),
    resumeCapture: vi.fn<RecordingDependencies["jarvis"]["resumeCapture"]>(
      async (id, at = 1_500) => {
        calls.push("jarvis:resume");
        return {
          sessionId: id,
          status: "recording",
          startedAt: 1_000,
          elapsedMs: 500,
          errorCode: null,
        };
      }
    ),
    finishCapture: vi.fn<RecordingDependencies["jarvis"]["finishCapture"]>(async (id) => {
      calls.push("jarvis:finish");
      return {
        sessionId: id,
        status: "completed",
        startedAt: 1_000,
        elapsedMs: 500,
        errorCode: null,
      };
    }),
    failCapture: vi.fn(async (id, code, at = 1_000) => ({
      sessionId: id,
      status: "failed" as const,
      startedAt: 1_000,
      elapsedMs: at - 1_000,
      errorCode: code,
    })),
    upsertSegments: vi.fn(async (_id, mapped) => {
      calls.push("jarvis:persist");
      return mapped.map((segment) => ({
        id: segment.id,
        session_id: "s1",
        started_at: segment.startedAt,
        ended_at: segment.endedAt,
        person_id: segment.personId,
        speaker_label: segment.speakerLabel,
        text: segment.text,
        confidence: segment.confidence,
        is_stable: segment.isStable ? 1 : 0,
        analysis_state: "pending",
      }));
    }),
    syncSegments: vi.fn(async (_id, mapped) => {
      calls.push("jarvis:sync");
      return mapped.map((segment) => ({
        id: segment.id,
        session_id: "s1",
        started_at: segment.startedAt,
        ended_at: segment.endedAt,
        person_id: segment.personId,
        speaker_label: segment.speakerLabel,
        text: segment.text,
        confidence: segment.confidence,
        is_stable: segment.isStable ? 1 : 0,
        analysis_state: "pending",
      }));
    }),
    renamePerson: vi.fn(async (input) => ({
      id: input.personId,
      display_name: input.displayName,
      is_self: input.isSelf ? 1 : 0,
      voice_profile_id: input.voiceProfileId ?? null,
      voice_confidence: null,
      created_at: 1_000,
      last_seen_at: 1_000,
    })),
    listPeople: vi.fn(async () => []),
  };

  const startRecording = vi.fn<RecordingDependencies["startRecording"]>(async (args) => {
    calls.push("upstream:start");
    meeting = { ...meeting, segments: args.seedSegments ?? [], isRecording: true, error: null };
  });
  const stopRecording = vi.fn<RecordingDependencies["stopRecording"]>(async () => {
    calls.push("upstream:stop");
    meeting = { ...meeting, isRecording: false };
    return { diarizationSessionId: null, success: true };
  });
  const setSessions = vi.fn();
  const createId = vi.fn(() => "s1");
  const setPeople = vi.fn();
  const refreshSessions = vi.fn(async () => {
    setSessions(await jarvis.listSessions());
  });
  const refreshPeople = vi.fn(async () => {
    setPeople(await jarvis.listPeople());
  });
  const onOperationChange = vi.fn();
  const ensureTranscriptionReady = vi.fn(async () => {
    calls.push("transcription:ready");
  });

  const deps: RecordingDependencies = {
    jarvis,
    ensureTranscriptionReady,
    startRecording,
    stopRecording,
    lockSpeaker: vi.fn(),
    getMeetingSnapshot: () => meeting,
    getSessionState: () => session,
    setSessionState: (next: SessionState) => {
      session = next;
    },
    refreshSessions,
    refreshPeople,
    createId,
    now: () => 1_000,
    getMicDeviceId: () => micDeviceId,
    getLanguage: () => "zh",
    getCaptureMode: () => captureMode,
    hasRecordingConsent: () => hasConsent,
    onError: vi.fn(),
    onOperationChange,
  };

  return {
    calls,
    deps,
    jarvis,
    startRecording,
    stopRecording,
    setSessions,
    createId,
    onOperationChange,
    ensureTranscriptionReady,
    getSession: () => session,
    setMeeting: (next: Partial<typeof meeting>) => {
      meeting = { ...meeting, ...next };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Jarvis recording controller", () => {
  it("publishes pending operation truth until the command settles", async () => {
    const gate = deferred<void>();
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(async () => {
      await gate.promise;
      harness.setMeeting({ isRecording: true });
    });
    const controller = createRecordingController(harness.deps);

    const pending = controller.start();
    await vi.waitFor(() => expect(harness.startRecording).toHaveBeenCalledTimes(1));
    expect(harness.onOperationChange).toHaveBeenLastCalledWith("start");

    gate.resolve();
    await pending;
    expect(harness.onOperationChange).toHaveBeenLastCalledWith(null);
  });
  it("rejects a direct start without consent before allocating or persisting a session", async () => {
    const harness = createHarness({ hasConsent: false });
    const controller = createRecordingController(harness.deps);

    await expect(controller.start()).rejects.toThrow("recording consent is required");

    expect(harness.createId).not.toHaveBeenCalled();
    expect(harness.jarvis.createSession).not.toHaveBeenCalled();
    expect(harness.jarvis.startCapture).not.toHaveBeenCalled();
    expect(harness.startRecording).not.toHaveBeenCalled();
    expect(harness.getSession()).toEqual(sessionFor("idle"));
  });
  it("starts one UUID session through the mic-only Jarvis path", async () => {
    const harness = createHarness();
    const controller = createRecordingController(harness.deps);

    await controller.start();

    expect(harness.calls).toEqual([
      "transcription:ready",
      "jarvis:create",
      "jarvis:start",
      "upstream:start",
    ]);
    expect(harness.jarvis.startCapture).toHaveBeenCalledWith({
      sessionId: "s1",
      startedAt: 1_000,
      micDeviceId: null,
      captureMode: "mic",
      sources: [
        {
          sourceType: "mic",
          deviceId: null,
          deviceLabel: null,
          strategy: "web-audio",
        },
      ],
    });
    expect(harness.startRecording).toHaveBeenCalledWith({
      noteId: null,
      noteTitle: "今日记录",
      folderId: null,
      captureSystemAudio: false,
      captureMicrophone: true,
      micOnly: true,
      requireAllSources: true,
      jarvisSessionId: "s1",
      diarizationEnabled: true,
      forceLocalTranscription: true,
      localModelOverride: "turbo",
      localLanguageOverride: null,
      localPromptMode: "bilingual-context",
    });
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });
  });

  it.each([
    [
      "mic",
      [
        {
          sourceType: "mic",
          deviceId: "physical-mic",
          deviceLabel: null,
          strategy: "web-audio",
        },
      ],
    ],
    [
      "system",
      [
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: null,
          strategy: null,
        },
      ],
    ],
    [
      "dual",
      [
        {
          sourceType: "mic",
          deviceId: "physical-mic",
          deviceLabel: null,
          strategy: "web-audio",
        },
        {
          sourceType: "system",
          deviceId: null,
          deviceLabel: null,
          strategy: null,
        },
      ],
    ],
  ] as const)(
    "persists and starts the selected %s mode with exactly its requested sources",
    async (captureMode, sources) => {
      const harness = createHarness({ captureMode, micDeviceId: "physical-mic" });
      const controller = createRecordingController(harness.deps);
      const expectedMicDeviceId = captureMode === "system" ? null : "physical-mic";

      await controller.start();

      expect(harness.jarvis.createSession).toHaveBeenCalledWith({
        id: "s1",
        startedAt: 1_000,
        micDeviceId: expectedMicDeviceId,
        language: "zh",
        captureMode,
      });
      expect(harness.jarvis.startCapture).toHaveBeenCalledWith({
        sessionId: "s1",
        startedAt: 1_000,
        micDeviceId: expectedMicDeviceId,
        captureMode,
        sources,
      });
      expect(harness.startRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          captureSystemAudio: captureMode !== "mic",
          captureMicrophone: captureMode !== "system",
          micOnly: captureMode === "mic",
          requireAllSources: true,
        })
      );
    }
  );

  it("stops upstream recording before pausing the main writer", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.pause();

    expect(harness.calls).toEqual(["upstream:stop", "jarvis:pause"]);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "paused" });
  });

  it("resumes the same session id with the current stable segments as seed", async () => {
    const harness = createHarness({ status: "paused", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    await controller.resume();

    expect(harness.calls).toEqual(["jarvis:resume", "upstream:start"]);
    expect(harness.jarvis.resumeCapture).toHaveBeenCalledWith("s1", 1_000);
    expect(harness.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        captureSystemAudio: false,
        jarvisSessionId: "s1",
        seedSegments: [stableSegment],
      })
    );
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });
  });

  it("drains and invalidates an in-flight resume before shutdown acknowledges", async () => {
    const resumeGate = deferred<void>();
    const harness = createHarness({ status: "paused", segments: [stableSegment] });
    vi.mocked(harness.jarvis.resumeCapture).mockImplementationOnce(async (id, at = 1_000) => {
      harness.calls.push("jarvis:resume");
      await resumeGate.promise;
      return {
        sessionId: id,
        status: "recording",
        startedAt: 1_000,
        elapsedMs: at - 1_000,
        errorCode: null,
      };
    });
    const controller = createRecordingController(harness.deps);

    const pendingResume = controller.resume();
    await vi.waitFor(() => expect(harness.jarvis.resumeCapture).toHaveBeenCalledOnce());

    const shutdownSettled = vi.fn();
    const pendingShutdown = controller.shutdown().then(shutdownSettled);
    await Promise.resolve();
    await Promise.resolve();
    const shutdownSettledBeforeResume = shutdownSettled.mock.calls.length;

    resumeGate.resolve();
    await expect(pendingResume).resolves.toBeUndefined();
    await pendingShutdown;

    expect(shutdownSettledBeforeResume).toBe(0);
    expect(harness.startRecording).not.toHaveBeenCalled();
    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "paused" });
  });

  it("stops upstream and persists stable segments before finishing capture", async () => {
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    await controller.finish();

    expect(harness.calls).toEqual(["upstream:stop", "jarvis:sync", "jarvis:finish"]);
    expect(harness.jarvis.syncSegments).toHaveBeenCalledWith("s1", [
      {
        id: "s1__seg-1",
        startedAt: 1_250,
        endedAt: 1_250,
        personId: "self",
        speakerLabel: "Me",
        text: "Ship the capture foundation",
        confidence: 0.5,
        isStable: true,
      },
    ]);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "completed" });
  });

  it("debounces stable-segment persistence by 500 ms", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    controller.handleSegmentsChanged([stableSegment]);
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.jarvis.syncSegments).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.jarvis.syncSegments).toHaveBeenCalledTimes(1);

    controller.handleSegmentsChanged([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.jarvis.syncSegments).toHaveBeenLastCalledWith("s1", []);
    controller.dispose();
  });

  it("flushes a pending debounce immediately and never persists it twice", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    controller.handleSegmentsChanged([stableSegment]);
    await controller.flushPendingPersistence();
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.jarvis.syncSegments).toHaveBeenCalledTimes(1);
  });

  it("shutdown stops the producer, accepts its final segment, then persists the frozen snapshot", async () => {
    const stopGate = deferred<void>();
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    harness.stopRecording.mockImplementationOnce(async () => {
      harness.calls.push("upstream:stop");
      await stopGate.promise;
      harness.setMeeting({ isRecording: false });
      return { diarizationSessionId: null, success: true };
    });
    const controller = createRecordingController(harness.deps);
    controller.handleSegmentsChanged([stableSegment]);

    const firstShutdown = controller.shutdown();
    const secondShutdown = controller.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await vi.waitFor(() => expect(harness.stopRecording).toHaveBeenCalledTimes(1));
    expect(harness.jarvis.syncSegments).not.toHaveBeenCalled();

    const finalSegment = { ...stableSegment, id: "seg-2", text: "Last words" };
    harness.setMeeting({ segments: [stableSegment, finalSegment] });
    controller.handleSegmentsChanged([stableSegment, finalSegment]);
    stopGate.resolve();
    await firstShutdown;

    expect(harness.stopRecording).toHaveBeenCalledWith({ throwOnError: false });
    expect(harness.calls).toEqual(["upstream:stop", "jarvis:sync"]);
    expect(harness.jarvis.syncSegments).toHaveBeenCalledTimes(1);
    expect(harness.jarvis.syncSegments).toHaveBeenCalledWith(
      "s1",
      expect.arrayContaining([
        expect.objectContaining({ id: "s1__seg-1" }),
        expect.objectContaining({ id: "s1__seg-2", text: "Last words" }),
      ])
    );
  });

  it("stops a pending producer start before draining its activation", async () => {
    const startGate = deferred<void>();
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(async () => {
      harness.calls.push("upstream:start");
      harness.setMeeting({ isRecording: true });
      await startGate.promise;
    });
    harness.stopRecording.mockImplementationOnce(async () => {
      harness.calls.push("upstream:stop");
      harness.setMeeting({ isRecording: false });
      startGate.resolve();
      return { diarizationSessionId: null, success: true };
    });
    const controller = createRecordingController(harness.deps);

    const pendingStart = controller.start();
    await vi.waitFor(() => expect(harness.startRecording).toHaveBeenCalledOnce());

    const pendingShutdown = controller.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    const stopCallsBeforeManualRelease = harness.stopRecording.mock.calls.length;
    if (stopCallsBeforeManualRelease === 0) startGate.resolve();

    await expect(pendingStart).resolves.toBeUndefined();
    await pendingShutdown;

    expect(stopCallsBeforeManualRelease).toBe(1);
    expect(harness.stopRecording).toHaveBeenCalledWith({ throwOnError: false });
    expect(harness.stopRecording).toHaveBeenCalledTimes(1);
    expect(harness.getSession()).toEqual(sessionFor("idle"));
  });

  it("drains and invalidates an in-flight start before shutdown acknowledges", async () => {
    const readyGate = deferred<void>();
    const harness = createHarness();
    harness.ensureTranscriptionReady.mockImplementationOnce(() => readyGate.promise);
    const controller = createRecordingController(harness.deps);

    const pendingStart = controller.start();
    await vi.waitFor(() => expect(harness.ensureTranscriptionReady).toHaveBeenCalledTimes(1));

    const shutdownSettled = vi.fn();
    const pendingShutdown = controller.shutdown().then(shutdownSettled);
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownSettled).not.toHaveBeenCalled();

    readyGate.resolve();
    await expect(pendingStart).resolves.toBeUndefined();
    await pendingShutdown;

    expect(harness.jarvis.createSession).not.toHaveBeenCalled();
    expect(harness.jarvis.startCapture).not.toHaveBeenCalled();
    expect(harness.startRecording).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight start when the controller is disposed", async () => {
    const readyGate = deferred<void>();
    const harness = createHarness();
    harness.ensureTranscriptionReady.mockImplementationOnce(() => readyGate.promise);
    const controller = createRecordingController(harness.deps);

    const pendingStart = controller.start();
    await vi.waitFor(() => expect(harness.ensureTranscriptionReady).toHaveBeenCalledTimes(1));
    controller.dispose();
    readyGate.resolve();
    await expect(pendingStart).resolves.toBeUndefined();

    expect(harness.jarvis.createSession).not.toHaveBeenCalled();
    expect(harness.jarvis.startCapture).not.toHaveBeenCalled();
    expect(harness.startRecording).not.toHaveBeenCalled();
  });

  it("rejects re-entry without issuing duplicate commands", async () => {
    let releaseStart!: () => void;
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = () => {
            harness.setMeeting({ isRecording: true });
            resolve();
          };
        })
    );
    const controller = createRecordingController(harness.deps);

    const firstStart = controller.start();
    await vi.waitFor(() => expect(harness.startRecording).toHaveBeenCalledTimes(1));
    await expect(controller.start()).rejects.toThrow("cannot start from starting");
    releaseStart();
    await firstStart;

    expect(harness.jarvis.createSession).toHaveBeenCalledTimes(1);
    expect(harness.jarvis.startCapture).toHaveBeenCalledTimes(1);
  });

  it("does not leave the controller busy after an impossible transition", async () => {
    const harness = createHarness();
    const controller = createRecordingController(harness.deps);

    await expect(controller.pause()).rejects.toThrow("cannot pause from idle");
    await controller.start();

    expect(harness.jarvis.createSession).toHaveBeenCalledTimes(1);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });
  });

  it("refreshes persisted sessions after a lifecycle change", async () => {
    const harness = createHarness();
    const controller = createRecordingController(harness.deps);

    await controller.start();

    expect(harness.jarvis.listSessions).toHaveBeenCalledTimes(1);
    expect(harness.setSessions).toHaveBeenCalledWith([
      expect.objectContaining({ id: "s1", status: "recording" }),
    ]);
  });

  it.each(["starting", "recording", "paused", "finalizing"] as const)(
    "rejects start from %s without changing the existing session or resources",
    async (status) => {
      const harness = createHarness({ status });
      const previous = harness.getSession();
      const controller = createRecordingController(harness.deps);

      await expect(controller.start()).rejects.toThrow();

      expect(harness.getSession()).toEqual(previous);
      expect(harness.createId).not.toHaveBeenCalled();
      expect(harness.jarvis.createSession).not.toHaveBeenCalled();
      expect(harness.jarvis.startCapture).not.toHaveBeenCalled();
      expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
      expect(harness.jarvis.setSessionStatus).not.toHaveBeenCalled();
    }
  );

  it("rejects an upstream-active start before allocating a session id", async () => {
    const harness = createHarness();
    harness.setMeeting({ isRecording: true });
    const previous = harness.getSession();
    const controller = createRecordingController(harness.deps);

    await expect(controller.start()).rejects.toThrow("another recording is active");

    expect(harness.getSession()).toEqual(previous);
    expect(harness.createId).not.toHaveBeenCalled();
    expect(harness.jarvis.createSession).not.toHaveBeenCalled();
  });

  it("keeps a recording recoverable when upstream stop fails during pause", async () => {
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const previous = harness.getSession();
    harness.stopRecording.mockRejectedValueOnce(new Error("upstream stop failed"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.pause()).rejects.toThrow("upstream stop failed");

    expect(harness.stopRecording).toHaveBeenCalledWith({ throwOnError: true });
    expect(harness.getSession()).toEqual(previous);
    expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.setSessionStatus).not.toHaveBeenCalled();
  });

  it("keeps a recording recoverable when upstream stop fails during finish", async () => {
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const previous = harness.getSession();
    harness.stopRecording.mockRejectedValueOnce(new Error("upstream stop failed"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.finish()).rejects.toThrow("upstream stop failed");

    expect(harness.stopRecording).toHaveBeenCalledWith({ throwOnError: true });
    expect(harness.getSession()).toEqual(previous);
    expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.syncSegments).not.toHaveBeenCalled();
    expect(harness.jarvis.setSessionStatus).not.toHaveBeenCalled();
  });

  it.each(["pause", "finish"] as const)(
    "does not %s main capture when a strict stop shares a default caller's failure",
    async (action) => {
      const harness = createHarness({ status: "recording", segments: [stableSegment] });
      const previous = harness.getSession();
      const gate = deferred<void>();
      const teardown = vi.fn(async () => {
        await gate.promise;
        return {
          diarizationSessionId: null,
          success: false,
          error: "shared stop failed",
        };
      });
      const coordinator = createMeetingStopCoordinator<StopRecordingResult>((error) => ({
        diarizationSessionId: null,
        success: false,
        error: error instanceof Error ? error.message : "shared stop failed",
      }));
      harness.stopRecording.mockImplementation((options) => coordinator.stop(teardown, options));
      const normalStop = harness.stopRecording();
      const controller = createRecordingController(harness.deps);
      const controllerAction = controller[action]();
      const controllerFailure = expect(controllerAction).rejects.toThrow("shared stop failed");

      await Promise.resolve();
      gate.resolve();
      await expect(normalStop).resolves.toMatchObject({ success: false });
      await controllerFailure;

      expect(teardown).toHaveBeenCalledTimes(1);
      expect(harness.getSession()).toEqual(previous);
      expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
      expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
      expect(harness.jarvis.syncSegments).not.toHaveBeenCalled();
    }
  );

  it.each(["start", "pause", "resume", "finish"] as const)(
    "routes tray %s through the matching renderer controller method",
    async (action) => {
      const controller = {
        start: vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
      } as unknown as RecordingController;

      await routeJarvisControl(controller, action);

      expect(controller[action]).toHaveBeenCalledTimes(1);
    }
  );

  it("pauses both pipelines with a visible error when the active microphone disconnects", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.pauseForError("MIC_DISCONNECTED");

    expect(harness.stopRecording).toHaveBeenCalledWith({ throwOnError: true });
    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000, "MIC_DISCONNECTED");
    expect(harness.getSession()).toMatchObject({ status: "paused" });
    expect(harness.deps.onError).toHaveBeenLastCalledWith("MIC_DISCONNECTED");
  });

  it("still pauses main capture when microphone-loss upstream teardown fails", async () => {
    const harness = createHarness({ status: "recording" });
    harness.stopRecording.mockRejectedValueOnce(new Error("device disappeared during stop"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.pauseForError("MIC_DISCONNECTED")).resolves.toBeUndefined();

    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000, "MIC_DISCONNECTED");
    expect(harness.getSession()).toMatchObject({ status: "paused" });
    expect(harness.deps.onError).toHaveBeenLastCalledWith("MIC_DISCONNECTED");
  });

  it("preserves the microphone error when both error-pause teardown steps fail", async () => {
    const harness = createHarness({ status: "recording" });
    harness.stopRecording.mockRejectedValueOnce(new Error("device disappeared during stop"));
    vi.mocked(harness.jarvis.pauseCapture).mockRejectedValueOnce(new Error("main pause failed"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.pauseForError("MIC_DISCONNECTED")).rejects.toThrow("main pause failed");

    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000, "MIC_DISCONNECTED");
    expect(harness.jarvis.failCapture).toHaveBeenCalledWith("s1", "MIC_DISCONNECTED", 1_000);
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({
      status: "failed",
      errorCode: "MIC_DISCONNECTED",
    });
    expect(harness.deps.onError).toHaveBeenLastCalledWith("MIC_DISCONNECTED");
  });

  it("authoritatively fails main capture when resume MIC pause cannot be persisted", async () => {
    const harness = createHarness({ status: "paused" });
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setMeeting({ isRecording: false, error: "MIC_PERMISSION" });
    });
    vi.mocked(harness.jarvis.pauseCapture).mockRejectedValueOnce(new Error("pause failed"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.resume()).rejects.toThrow("microphone capture failed");

    expect(harness.jarvis.failCapture).toHaveBeenCalledWith("s1", "MIC_PERMISSION", 1_000);
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({ status: "failed", errorCode: "MIC_PERMISSION" });
  });

  it("authoritatively fails main capture when initial MIC pause cannot be persisted", async () => {
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setMeeting({ isRecording: false, error: "MIC_PERMISSION" });
    });
    vi.mocked(harness.jarvis.pauseCapture).mockRejectedValueOnce(new Error("pause failed"));
    const controller = createRecordingController(harness.deps);

    await expect(controller.start()).rejects.toThrow("microphone capture failed");

    expect(harness.jarvis.failCapture).toHaveBeenCalledWith("s1", "MIC_PERMISSION", 1_000);
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({ status: "failed", errorCode: "MIC_PERMISSION" });
  });

  it("classifies a microphone resume failure like a microphone start failure", async () => {
    const harness = createHarness({ status: "paused" });
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setMeeting({ isRecording: false, error: "MIC_PERMISSION" });
    });
    const controller = createRecordingController(harness.deps);

    await expect(controller.resume()).rejects.toThrow("microphone capture failed");

    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000, "MIC_PERMISSION");
    expect(harness.getSession()).toMatchObject({ status: "failed", errorCode: "MIC_PERMISSION" });
    expect(harness.deps.onError).toHaveBeenLastCalledWith("MIC_PERMISSION");
  });

  it("maps a mic permission start failure to an error pause instead of finishing audio", async () => {
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setMeeting({ isRecording: false, error: "MIC_PERMISSION" });
    });
    const controller = createRecordingController(harness.deps);

    await expect(controller.start()).rejects.toThrow("microphone capture failed");

    expect(harness.jarvis.pauseCapture).toHaveBeenCalledWith("s1", 1_000, "MIC_PERMISSION");
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.setSessionStatus).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({ status: "failed", errorCode: "MIC_PERMISSION" });
  });

  it("atomically fails required system capture without completing its tracks", async () => {
    const harness = createHarness({ captureMode: "system" });
    harness.startRecording.mockRejectedValueOnce(
      new CaptureSourcesUnavailableError({ mic: "idle", system: "unavailable" })
    );
    const controller = createRecordingController(harness.deps);

    await expect(controller.start()).rejects.toThrow("capture_source_unavailable");

    expect(harness.jarvis.failCapture).toHaveBeenCalledWith(
      "s1",
      "capture_source_unavailable",
      1_000
    );
    expect(harness.jarvis.finishCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.setSessionStatus).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({
      status: "failed",
      errorCode: "capture_source_unavailable",
    });
    expect(harness.deps.onError).toHaveBeenLastCalledWith("capture_source_unavailable");
  });
});
