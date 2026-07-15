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
  applyRecordingRetentionMode,
  mapStableSegments,
  recordingArgs,
  resolveJarvisWhisperModel,
  routeJarvisControl,
  routePowerLifecycleRequest,
  selectPowerResumeDevices,
  type RecordingController,
  type RecordingDependencies,
} from "../useJarvisRecording";
import { useJarvisStore } from "../jarvisStore";
import type { JarvisCaptureMode, JarvisRetentionMode } from "../../types";

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

describe("power resume device enumeration", () => {
  const token = {
    sessionId: "session-day-1",
    sources: {
      mic: {
        sourceType: "mic" as const,
        deviceId: "stale-mic",
        deviceLabel: "Old Mic",
        strategy: "physical",
      },
      system: {
        sourceType: "system" as const,
        deviceId: null,
        deviceLabel: "System",
        strategy: "wasapi-loopback",
      },
    },
  };

  it("returns newly enumerated physical metadata instead of the suspend token", () => {
    const devices = [
      {
        kind: "audioinput",
        deviceId: "fresh-mic",
        label: "Microphone (Shure MV7)",
      } as MediaDeviceInfo,
    ];

    expect(selectPowerResumeDevices(token, devices)).toEqual({
      mic: {
        deviceId: "fresh-mic",
        deviceLabel: "Microphone (Shure MV7)",
        strategy: "physical",
      },
      system: {
        deviceId: null,
        deviceLabel: "System",
        strategy: "wasapi-loopback",
      },
    });
  });

  it("refuses a virtual-only default instead of silently binding Sonar", () => {
    const devices = [
      {
        kind: "audioinput",
        deviceId: "default",
        label: "SteelSeries Sonar - Microphone",
      } as MediaDeviceInfo,
    ];

    expect(() => selectPowerResumeDevices(token, devices)).toThrow(/No safe microphone/);
  });

  it("falls back to a safe system-default microphone when no physical device is available", () => {
    const devices = [
      {
        kind: "audioinput",
        deviceId: "default",
        label: "Default Microphone",
      } as MediaDeviceInfo,
    ];

    expect(selectPowerResumeDevices(token, devices).mic).toEqual({
      deviceId: null,
      deviceLabel: "Default Microphone",
      strategy: "system-default",
    });
  });

  it("routes a suspend request only to upstream teardown", async () => {
    const suspendUpstream = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    const enumerateDevices = vi.fn().mockResolvedValue([]);

    await expect(
      routePowerLifecycleRequest(
        { id: "power-1", kind: "suspend", token },
        { suspendUpstream, resume, enumerateDevices }
      )
    ).resolves.toBeNull();

    expect(suspendUpstream).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("passes fresh restoration choices to the recorder and acknowledges actual bindings", async () => {
    const desired = {
      mic: { deviceId: "fresh-mic", deviceLabel: "Fresh MV7", strategy: "physical" },
    };
    const actual = {
      mic: { deviceId: "actual-mic", deviceLabel: "Actual MV7", strategy: "physical" },
    };
    const resume = vi.fn(async () => actual);

    await expect(
      routePowerLifecycleRequest(
        { id: "power-2", kind: "resume", token: { ...token, restorations: desired } },
        { suspendUpstream: vi.fn(), resume, enumerateDevices: vi.fn() }
      )
    ).resolves.toEqual(actual);
    expect(resume).toHaveBeenCalledWith(desired);
  });

  it("routes each midnight transaction phase to the renderer controller", async () => {
    const rotateAtLocalDate = vi.fn(async () => {});

    for (const phase of ["prepare", "activate", "commit", "abort"] as const) {
      await expect(
        routePowerLifecycleRequest(
          {
            id: `rotate-${phase}`,
            kind: "rotate",
            token: {
              phase,
              previousSessionId: "s1",
              sessionId: "s2",
              startedAt: 2_000,
              sources: {},
            },
          },
          {
            suspendUpstream: vi.fn(),
            resume: vi.fn(),
            rotateAtLocalDate,
            enumerateDevices: vi.fn(),
          }
        )
      ).resolves.toBeNull();
    }

    expect(rotateAtLocalDate.mock.calls).toEqual(
      ["prepare", "activate", "commit", "abort"].map((phase) => [
        { phase, previousSessionId: "s1", sessionId: "s2", startedAt: 2_000 },
      ])
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

describe("Jarvis provisional transcript intervals", () => {
  it("never persists temporary diarization labels as durable person ids", () => {
    expect(
      mapStableSegments(
        "session-1",
        [
          {
            id: "temporary-speaker",
            text: "hello",
            source: "system",
            speaker: "speaker_1",
            speakerName: "Local speaker 1",
          },
        ],
        1_000
      )[0]
    ).toMatchObject({
      personId: null,
      speakerLabel: "Local speaker 1",
    });
  });

  it("keeps a one millisecond safe-integer interval at the maximum timestamp", () => {
    expect(
      mapStableSegments(
        "session-1",
        [{ id: "max", text: "tail", source: "mic", timestamp: Number.MAX_SAFE_INTEGER }],
        0
      )[0]
    ).toMatchObject({
      startedAt: Number.MAX_SAFE_INTEGER - 1,
      endedAt: Number.MAX_SAFE_INTEGER,
      sourceType: "mic",
    });
  });

  it("preserves live acoustic echo evidence and the measured speech interval", () => {
    expect(
      mapStableSegments(
        "session-1",
        [
          {
            id: "echo",
            text: "周五交付",
            source: "mic",
            timestamp: 2_000,
            startedAt: 1_200,
            endedAt: 2_000,
            echoScore: 0.8,
          },
        ],
        0
      )[0]
    ).toMatchObject({
      startedAt: 1_200,
      endedAt: 2_000,
      sourceType: "mic",
      echoScore: 0.8,
    });
  });
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
  retentionMode = "speech_triggered" as JarvisRetentionMode,
}: {
  status?: SessionStatus;
  segments?: TranscriptSegment[];
  hasConsent?: boolean;
  captureMode?: JarvisCaptureMode;
  micDeviceId?: string | null;
  retentionMode?: JarvisRetentionMode;
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
    setRetentionMode: vi.fn(async (id, mode, at = 1_000) => ({
      sessionId: id,
      status: "recording" as const,
      startedAt: 1_000,
      elapsedMs: at - 1_000,
      errorCode: null,
      retentionMode: mode,
      effectiveRetentionMode: mode,
      retentionDegradedReason: null,
    })),
    sourceInterrupted: vi.fn<RecordingDependencies["jarvis"]["sourceInterrupted"]>(async (id) => ({
      sessionId: id,
      status: "degraded",
      startedAt: 1_000,
      elapsedMs: 0,
      errorCode: null,
    })),
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
  const rebindUpstreamSession = vi.fn<RecordingDependencies["rebindUpstreamSession"]>();
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
    rebindUpstreamSession,
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
    getRetentionMode: () => retentionMode,
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
    rebindUpstreamSession,
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
  it("resumes with the enumerated microphone override and returns the actual recorder binding", async () => {
    const harness = createHarness({ status: "paused", captureMode: "mic" });
    const actual = {
      mic: { deviceId: "actual-mic", deviceLabel: "Actual MV7", strategy: "physical" },
    };
    harness.startRecording.mockImplementationOnce(async (args) => {
      harness.calls.push("upstream:start");
      harness.setMeeting({ isRecording: true });
      expect(args.micDeviceIdOverride).toBe("fresh-mic");
      return actual;
    });
    const controller = createRecordingController(harness.deps);

    await expect(
      controller.resume({
        mic: { deviceId: "fresh-mic", deviceLabel: "Fresh MV7", strategy: "physical" },
      })
    ).resolves.toEqual(actual);
  });

  it("leaves power-resume compensation to the main lifecycle when upstream activation fails", async () => {
    const harness = createHarness({ status: "paused", captureMode: "mic" });
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setMeeting({ isRecording: false, error: "MIC_DISCONNECTED" });
    });
    const controller = createRecordingController(harness.deps);

    await expect(
      controller.resumeForPower({
        mic: { deviceId: "fresh-mic", deviceLabel: "Fresh MV7", strategy: "physical" },
      })
    ).rejects.toThrow("microphone capture failed");

    expect(harness.jarvis.resumeCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.failCapture).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "paused" });
  });

  it("rotates renderer persistence to the next day without restarting audio", async () => {
    vi.useFakeTimers();
    const oldSegment: TranscriptSegment = {
      id: "old",
      text: "before",
      source: "mic",
      timestamp: 1_500,
    };
    const newSegment: TranscriptSegment = {
      id: "new",
      text: "after",
      source: "mic",
      timestamp: 2_100,
    };
    const harness = createHarness({ status: "recording", segments: [oldSegment] });
    const controller = createRecordingController(harness.deps);
    controller.handleSegmentsChanged([oldSegment]);

    await controller.rotateAtLocalDate({
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    harness.setMeeting({ segments: [oldSegment, newSegment] });
    controller.handleSegmentsChanged([oldSegment, newSegment]);
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.stopRecording).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({
      id: "s2",
      status: "recording",
      startedAt: 2_000,
    });
    expect(harness.jarvis.syncSegments).toHaveBeenNthCalledWith(1, "s1", expect.any(Array));
    expect(harness.jarvis.upsertSegments).toHaveBeenNthCalledWith(
      1,
      "s2",
      expect.arrayContaining([expect.objectContaining({ text: "after" })])
    );
    expect(vi.mocked(harness.jarvis.upsertSegments).mock.calls[0][1]).toHaveLength(1);

    await controller.rotateAtLocalDate({
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    expect(harness.jarvis.syncSegments).toHaveBeenCalledTimes(1);
    expect(harness.jarvis.upsertSegments).toHaveBeenCalledTimes(1);
  });

  it("prepares midnight persistence before switching sessions and commits buffered segments once", async () => {
    vi.useFakeTimers();
    const oldSegment: TranscriptSegment = {
      id: "old",
      text: "before",
      source: "mic",
      timestamp: 1_500,
      endedAt: 1_900,
    };
    const newSegment: TranscriptSegment = {
      id: "new",
      text: "after",
      source: "mic",
      timestamp: 2_100,
      endedAt: 2_300,
    };
    const harness = createHarness({ status: "recording", segments: [oldSegment] });
    const controller = createRecordingController(harness.deps);
    controller.handleSegmentsChanged([oldSegment]);

    await controller.rotateAtLocalDate({
      phase: "prepare",
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });

    harness.setMeeting({ segments: [oldSegment, newSegment] });
    controller.handleSegmentsChanged([oldSegment, newSegment]);
    await controller.rotateAtLocalDate({
      phase: "activate",
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "recording" });
    expect(harness.rebindUpstreamSession).toHaveBeenCalledOnce();
    expect(harness.rebindUpstreamSession).toHaveBeenCalledWith("s1", "s2");

    await controller.rotateAtLocalDate({
      phase: "commit",
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.getSession()).toMatchObject({ id: "s2", status: "recording" });
    expect(harness.rebindUpstreamSession).toHaveBeenCalledOnce();
    const s2Calls = vi
      .mocked(harness.jarvis.upsertSegments)
      .mock.calls.filter(([sessionId]) => sessionId === "s2");
    expect(s2Calls).toHaveLength(1);
    expect(s2Calls[0][1]).toEqual([expect.objectContaining({ text: "after" })]);

    await controller.rotateAtLocalDate({
      phase: "commit",
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });
    expect(
      vi
        .mocked(harness.jarvis.upsertSegments)
        .mock.calls.filter(([sessionId]) => sessionId === "s2")
    ).toHaveLength(1);
  });

  it("replaces a stale prepared renderer rotation after main aborted with a new destination", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.rotateAtLocalDate({
      phase: "prepare",
      previousSessionId: "s1",
      sessionId: "stale-s2",
      startedAt: 2_000,
    });
    await controller.rotateAtLocalDate({
      phase: "prepare",
      previousSessionId: "s1",
      sessionId: "fresh-s2",
      startedAt: 2_100,
    });
    await controller.rotateAtLocalDate({
      phase: "commit",
      previousSessionId: "s1",
      sessionId: "fresh-s2",
      startedAt: 2_100,
    });

    expect(harness.getSession()).toMatchObject({ id: "fresh-s2", status: "recording" });
    expect(harness.rebindUpstreamSession).toHaveBeenCalledWith("s1", "fresh-s2");
  });

  it("blocks user lifecycle commands while a midnight transaction is prepared", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.rotateAtLocalDate({
      phase: "prepare",
      previousSessionId: "s1",
      sessionId: "s2",
      startedAt: 2_000,
    });

    await expect(controller.pause()).rejects.toThrow("midnight rotation");
    await expect(controller.setRetentionMode("continuous")).rejects.toThrow("midnight rotation");
    expect(harness.stopRecording).not.toHaveBeenCalled();
    expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
    expect(harness.jarvis.setRetentionMode).not.toHaveBeenCalled();
  });

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
      retentionMode: "speech_triggered",
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
        retentionMode: "speech_triggered",
      });
      expect(harness.jarvis.startCapture).toHaveBeenCalledWith({
        sessionId: "s1",
        startedAt: 1_000,
        micDeviceId: expectedMicDeviceId,
        captureMode,
        retentionMode: "speech_triggered",
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

  it("persists important-meeting retention before starting capture", async () => {
    const harness = createHarness({ retentionMode: "continuous" });
    const controller = createRecordingController(harness.deps);

    await controller.start();

    expect(harness.jarvis.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ retentionMode: "continuous" })
    );
    expect(harness.jarvis.startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ retentionMode: "continuous" })
    );
  });

  it.each(["recording", "paused"] as const)(
    "switches an active %s session retention mode through authoritative IPC",
    async (status) => {
      const harness = createHarness({ status });
      const controller = createRecordingController(harness.deps);

      const continuous = await controller.setRetentionMode("continuous");
      const speechTriggered = await controller.setRetentionMode("speech_triggered");

      expect(harness.jarvis.setRetentionMode).toHaveBeenNthCalledWith(1, "s1", "continuous", 1_000);
      expect(harness.jarvis.setRetentionMode).toHaveBeenNthCalledWith(
        2,
        "s1",
        "speech_triggered",
        1_000
      );
      expect(continuous).toMatchObject({
        retentionMode: "continuous",
        effectiveRetentionMode: "continuous",
      });
      expect(speechTriggered).toMatchObject({
        retentionMode: "speech_triggered",
        effectiveRetentionMode: "speech_triggered",
      });
    }
  );

  it.each(["recording", "paused"] as const)(
    "applies the authoritative active %s retention runtime to the shared store",
    async (status) => {
      const harness = createHarness({ status });
      vi.mocked(harness.jarvis.setRetentionMode).mockResolvedValueOnce({
        sessionId: "s1",
        status,
        startedAt: 1_000,
        elapsedMs: 500,
        errorCode: null,
        retentionMode: "continuous",
        effectiveRetentionMode: "continuous_fallback",
        retentionDegradedReason: "vad_unavailable",
      });
      useJarvisStore.setState({
        session: sessionFor(status),
        retentionMode: "speech_triggered",
        effectiveRetentionMode: "speech_triggered",
        retentionDegradedReason: null,
      });

      await applyRecordingRetentionMode(createRecordingController(harness.deps), "continuous");

      expect(harness.jarvis.setRetentionMode).toHaveBeenCalledWith("s1", "continuous", 1_000);
      expect(useJarvisStore.getState()).toMatchObject({
        retentionMode: "continuous",
        effectiveRetentionMode: "continuous_fallback",
        retentionDegradedReason: "vad_unavailable",
      });
    }
  );

  it("stops upstream recording before pausing the main writer", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.pause();

    expect(harness.calls).toEqual(["upstream:stop", "jarvis:pause"]);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "paused" });
  });

  it("stops only the renderer upstream for a durable main-process power suspend", async () => {
    const harness = createHarness({ status: "recording" });
    const controller = createRecordingController(harness.deps);

    await controller.suspendUpstreamForPower();

    expect(harness.calls).toEqual(["upstream:stop"]);
    expect(harness.jarvis.pauseCapture).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "paused" });
  });

  it.each([
    ["pause", "pauseCapture", "recording"],
    ["finish", "finishCapture", "degraded"],
  ] as const)(
    "%s rejects an active main-process result instead of inventing a terminal renderer state",
    async (action, method, returnedStatus) => {
      const harness = createHarness({ status: "recording" });
      vi.mocked(harness.jarvis[method]).mockResolvedValueOnce({
        sessionId: "s1",
        status: returnedStatus,
        startedAt: 1_000,
        elapsedMs: 500,
        errorCode: null,
      });
      const controller = createRecordingController(harness.deps);

      await expect(controller[action]()).rejects.toThrow(/main process.*status/i);

      expect(harness.getSession()).toMatchObject({ id: "s1", status: "failed" });
      const expectedCode = `capture_${action}_failed`;
      expect(harness.jarvis.failCapture).toHaveBeenCalledWith("s1", expectedCode, 1_000);
      expect(harness.deps.onError).toHaveBeenCalledWith(expectedCode);
      expect(
        vi.mocked(harness.deps.onError).mock.calls.filter(([code]) => code === expectedCode)
      ).toHaveLength(1);
    }
  );

  it.each([
    ["pause", "pauseCapture"],
    ["finish", "finishCapture"],
  ] as const)("%s mirrors an authoritative failed main-process result", async (action, method) => {
    const harness = createHarness({ status: "recording" });
    vi.mocked(harness.jarvis[method]).mockResolvedValueOnce({
      sessionId: "s1",
      status: "failed",
      startedAt: 1_000,
      elapsedMs: 500,
      errorCode: "AUDIO_WRITE_FAILED",
    });
    const controller = createRecordingController(harness.deps);

    await expect(controller[action]()).rejects.toThrow(/AUDIO_WRITE_FAILED/);

    expect(harness.getSession()).toMatchObject({
      id: "s1",
      status: "failed",
      errorCode: "AUDIO_WRITE_FAILED",
    });
    expect(harness.deps.onError).toHaveBeenCalledWith("AUDIO_WRITE_FAILED");
    expect(
      vi.mocked(harness.deps.onError).mock.calls.filter(([code]) => code === "AUDIO_WRITE_FAILED")
    ).toHaveLength(1);
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
        endedAt: 1_251,
        personId: "self",
        speakerLabel: "Me",
        sourceType: "mic",
        text: "Ship the capture foundation",
        confidence: 0.5,
        isStable: true,
      },
    ]);
    expect(harness.getSession()).toMatchObject({ id: "s1", status: "completed" });
  });

  it("forgets terminal-session fingerprints after the final sync", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    await controller.finish();
    harness.deps.setSessionState({
      id: "s1",
      status: "recording",
      startedAt: 1_000,
      activeSince: 1_000,
      accumulatedMs: 0,
      errorCode: null,
    });
    controller.handleSegmentsChanged([stableSegment]);
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.jarvis.upsertSegments).toHaveBeenCalledWith("s1", [
      expect.objectContaining({ id: "s1__seg-1" }),
    ]);
  });

  it("debounces and upserts only changed stable segment ids during live recording", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ status: "recording", segments: [stableSegment] });
    const controller = createRecordingController(harness.deps);

    controller.handleSegmentsChanged([stableSegment]);
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.jarvis.upsertSegments).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.jarvis.upsertSegments).toHaveBeenCalledTimes(1);
    expect(harness.jarvis.upsertSegments).toHaveBeenLastCalledWith("s1", [
      expect.objectContaining({ id: "s1__seg-1", text: "Ship the capture foundation" }),
    ]);

    const added = { ...stableSegment, id: "seg-2", text: "Only the new stable row" };
    controller.handleSegmentsChanged([stableSegment, added]);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.jarvis.upsertSegments).toHaveBeenCalledTimes(2);
    expect(harness.jarvis.upsertSegments).toHaveBeenLastCalledWith("s1", [
      expect.objectContaining({ id: "s1__seg-2", text: "Only the new stable row" }),
    ]);

    controller.handleSegmentsChanged([{ ...stableSegment, text: "Corrected by stable id" }, added]);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.jarvis.upsertSegments).toHaveBeenCalledTimes(3);
    expect(harness.jarvis.upsertSegments).toHaveBeenLastCalledWith("s1", [
      expect.objectContaining({ id: "s1__seg-1", text: "Corrected by stable id" }),
    ]);

    controller.handleSegmentsChanged([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.jarvis.upsertSegments).toHaveBeenCalledTimes(3);
    expect(harness.jarvis.syncSegments).not.toHaveBeenCalled();
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
