import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingStopCoordinator } from "../../../stores/meetingStopCoordinator";
import type { StopRecordingResult, TranscriptSegment } from "../../../stores/meetingRecordingStore";
import type { SessionState, SessionStatus } from "../sessionMachine";
import { createRecordingController, type RecordingDependencies } from "../useJarvisRecording";

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
}: {
  status?: SessionStatus;
  segments?: TranscriptSegment[];
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

  const deps: RecordingDependencies = {
    jarvis,
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
    getMicDeviceId: () => null,
    getLanguage: () => "zh",
    onError: vi.fn(),
  };

  return {
    calls,
    deps,
    jarvis,
    startRecording,
    stopRecording,
    setSessions,
    createId,
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
  it("starts one UUID session through the mic-only Jarvis path", async () => {
    const harness = createHarness();
    const controller = createRecordingController(harness.deps);

    await controller.start();

    expect(harness.calls).toEqual(["jarvis:create", "jarvis:start", "upstream:start"]);
    expect(harness.jarvis.startCapture).toHaveBeenCalledWith({
      sessionId: "s1",
      startedAt: 1_000,
      micDeviceId: null,
    });
    expect(harness.startRecording).toHaveBeenCalledWith({
      noteId: null,
      noteTitle: "今日记录",
      folderId: null,
      captureSystemAudio: false,
      jarvisSessionId: "s1",
      diarizationEnabled: true,
    });
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });
  });

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
});
