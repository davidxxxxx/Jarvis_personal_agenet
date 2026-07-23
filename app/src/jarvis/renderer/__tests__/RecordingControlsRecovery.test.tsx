import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import RecordingControls from "../RecordingControls";
import type { UseJarvisRecordingResult } from "../useJarvisRecording";
import { useJarvisStore } from "../jarvisStore";

function fakeRecording(
  overrides: Partial<UseJarvisRecordingResult> = {}
): UseJarvisRecordingResult {
  return {
    session: {
      id: "session-1",
      status: "recording",
      startedAt: 1_000,
      activeSince: 1_000,
      accumulatedMs: 0,
      errorCode: null,
    },
    segments: [],
    partialText: "",
    micLevel: 0,
    systemLevel: 0,
    activeMicLabel: "Microphone (5- Shure MV7)",
    micFallbackActive: false,
    preparationStage: null,
    operation: null,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    setRetentionMode: vi.fn().mockResolvedValue(undefined),
    renameSpeaker: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("RecordingControls microphone recovery", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    localStorage.setItem("jarvisRecordingConsentVersion", "1");
    useJarvisStore.setState({
      captureMode: "mic",
      sourceStates: { mic: "idle", system: "idle" },
      retentionMode: "speech_triggered",
      effectiveRetentionMode: null,
      retentionDegradedReason: null,
    });
    const mediaDevices = new EventTarget() as EventTarget & {
      enumerateDevices: ReturnType<typeof vi.fn>;
    };
    mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      {
        kind: "audioinput",
        deviceId: "shure",
        label: "Microphone (5- Shure MV7)",
      },
    ]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
  });

  it("shows the concrete startup stage instead of an indefinite generic status", async () => {
    await i18n.changeLanguage("en");
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "starting",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: null,
          },
          operation: "start",
          preparationStage: "checking_microphone",
        })}
      />
    );

    expect(screen.getByText("Checking microphone…")).toBeInTheDocument();
    expect(screen.queryByText("Starting…")).not.toBeInTheDocument();
  });

  it("shows first-run model progress without claiming that recording has started", async () => {
    await i18n.changeLanguage("en");
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "starting",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: null,
          },
          operation: "start",
          preparationStage: "downloading_model",
          preparationProgress: {
            percentage: 73,
            downloadedBytes: 1_186_000_000,
            totalBytes: 1_624_555_275,
          },
        })}
      />
    );

    expect(screen.getByText("Downloading speech model… 73%")).toBeInTheDocument();
    expect(screen.getByText("Not recording")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "73");
    expect(screen.queryByText("Waiting to record")).not.toBeInTheDocument();
  });

  it("localizes system-only source status and unavailable recovery actions in English", async () => {
    await i18n.changeLanguage("en");
    useJarvisStore.setState({
      captureMode: "system",
      sourceStates: { mic: "idle", system: "unavailable" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "failed",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: "capture_source_unavailable",
          },
          error: "capture_source_unavailable",
        })}
      />
    );

    expect(screen.getByRole("img", { name: "Computer audio" })).toBeInTheDocument();
    expect(screen.getByText("Microphone: Not enabled")).toBeInTheDocument();
    expect(screen.getByText("Computer audio: Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Computer audio is unavailable. Retry or choose another source."
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with available source" })).toBeDisabled();
  });

  it("shows a non-fatal reconnecting notice while controls remain available", () => {
    render(
      <RecordingControls
        recording={fakeRecording({
          micRecoveryStatus: "reconnecting",
          micRecoveryAttempt: 7,
          activeMicLabel: null,
          error: null,
        })}
      />
    );

    expect(screen.getByText("麦克风已断开，正在重连（第 7 次）…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "结束并总结" })).toBeEnabled();
  });

  it.each([
    ["recovering", { mic: "recovering", system: "unavailable" }, "Restoring audio sources…"],
    ["unavailable", { mic: "unavailable", system: "unavailable" }, "No active audio source"],
  ] as const)(
    "shows %s instead of Listening while durable recording has no active source",
    async (_case, sourceStates, expectedStatus) => {
      await i18n.changeLanguage("en");
      const pause = vi.fn().mockResolvedValue(undefined);
      useJarvisStore.setState({ captureMode: "dual", sourceStates });

      render(<RecordingControls recording={fakeRecording({ pause })} />);

      expect(screen.queryByText("Listening")).not.toBeInTheDocument();
      const status = screen.getByText(expectedStatus);
      expect(status).toBeInTheDocument();
      expect(status.parentElement?.querySelector(".animate-pulse")).toBeNull();
      const pauseButton = screen.getByRole("button", { name: "Pause" });
      expect(pauseButton).toBeEnabled();

      fireEvent.click(pauseButton);
      await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    }
  );

  it("shows the restored physical microphone", () => {
    render(
      <RecordingControls
        recording={fakeRecording({
          micRecoveryStatus: "restored",
          activeMicLabel: "Microphone (5- Shure MV7)",
        })}
      />
    );

    expect(screen.getByText("麦克风已恢复：Microphone (5- Shure MV7)")).toBeInTheDocument();
  });

  it("shows independent source status and requires an explicit retry or narrowing action", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    useJarvisStore.setState({
      captureMode: "dual",
      sourceStates: { mic: "unavailable", system: "ready" },
    });
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "failed",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: "capture_source_unavailable",
          },
          start,
          error: "capture_source_unavailable",
        })}
      />
    );

    expect(screen.getByText("麦克风：不可用")).toBeInTheDocument();
    expect(screen.getByText("电脑声音：已就绪")).toBeInTheDocument();
    expect(useJarvisStore.getState().captureMode).toBe("dual");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(useJarvisStore.getState().captureMode).toBe("dual");

    fireEvent.click(screen.getByRole("button", { name: "使用可用音源继续" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(useJarvisStore.getState().captureMode).toBe("system");
  });

  it("does not offer continuation when none of the selected sources is available", () => {
    useJarvisStore.setState({
      captureMode: "system",
      sourceStates: { mic: "idle", system: "unavailable" },
    });
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "failed",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: "capture_source_unavailable",
          },
          error: "capture_source_unavailable",
        })}
      />
    );

    expect(screen.getByRole("button", { name: "使用可用音源继续" })).toBeDisabled();
    expect(useJarvisStore.getState().captureMode).toBe("system");
  });

  it("explicitly narrows dual capture to mic when computer audio is unavailable", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    useJarvisStore.setState({
      captureMode: "dual",
      sourceStates: { mic: "ready", system: "unavailable" },
    });
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "failed",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: "capture_source_unavailable",
          },
          start,
          error: "capture_source_unavailable",
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "使用可用音源继续" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(useJarvisStore.getState().captureMode).toBe("mic");
  });

  it("locks capture mode while a paused session still owns its source semantics", () => {
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "session-1",
            status: "paused",
            startedAt: 1_000,
            activeSince: null,
            accumulatedMs: 500,
            errorCode: null,
          },
        })}
      />
    );

    expect(screen.getByRole("radio", { name: "仅麦克风" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "仅电脑声音" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "麦克风和电脑声音" })).toBeDisabled();
  });

  it("uses computer-audio visuals and its recorded level in system-only mode", () => {
    useJarvisStore.setState({
      captureMode: "system",
      sourceStates: { mic: "idle", system: "recording" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          activeMicLabel: "Private microphone name",
          micLevel: 0.75,
          systemLevel: 0.08,
        })}
      />
    );

    expect(screen.getByRole("img", { name: "电脑声音" })).toBeInTheDocument();
    expect(screen.getByText("电脑声音", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Private microphone name")).not.toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: "音频电平" });
    expect(meter).toHaveAttribute("data-audio-state", "audible");
    expect(screen.getByText("· 电脑声音")).toBeInTheDocument();
  });

  it("shows computer audio when it is the active signal in dual-source mode", () => {
    useJarvisStore.setState({
      captureMode: "dual",
      sourceStates: { mic: "recording", system: "recording" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          micLevel: 0,
          systemLevel: 0.05,
        })}
      />
    );

    const meter = screen.getByRole("meter", { name: "音频电平" });
    expect(meter).toHaveAttribute("data-audio-state", "audible");
    expect(screen.getByText("· 电脑声音")).toBeInTheDocument();
  });

  it("does not let runtime source loss change an active session capture mode", () => {
    const start = vi.fn().mockResolvedValue(undefined);
    useJarvisStore.setState({
      captureMode: "dual",
      sourceStates: { mic: "recording", system: "unavailable" },
    });

    render(<RecordingControls recording={fakeRecording({ start })} />);

    const retry = screen.getByRole("button", { name: "重试" });
    const continueButton = screen.getByRole("button", { name: "使用可用音源继续" });
    expect(retry).toBeDisabled();
    expect(continueButton).toBeDisabled();

    fireEvent.click(retry);
    fireEvent.click(continueButton);

    expect(start).not.toHaveBeenCalled();
    expect(useJarvisStore.getState().captureMode).toBe("dual");
  });

  it.each(["recording", "paused"] as const)(
    "allows retention changes during %s while capture source semantics stay locked",
    async (status) => {
      await i18n.changeLanguage("en");
      const setRetentionMode = vi.fn(async (mode: "speech_triggered" | "continuous") => {
        useJarvisStore.getState().setRetentionMode(mode);
      });
      useJarvisStore.setState({
        retentionMode: "speech_triggered",
        effectiveRetentionMode: "speech_triggered",
        retentionDegradedReason: null,
        sourceStates: { mic: "recording", system: "idle" },
      });

      render(
        <RecordingControls
          recording={fakeRecording({
            session: {
              id: "session-1",
              status,
              startedAt: 1_000,
              activeSince: status === "recording" ? 1_000 : null,
              accumulatedMs: status === "paused" ? 500 : 0,
              errorCode: null,
            },
            setRetentionMode,
          })}
        />
      );

      const retention = screen.getByRole("combobox", { name: "Retention mode" });
      expect(retention).toBeEnabled();
      expect(screen.getByRole("radio", { name: "Microphone only" })).toBeDisabled();

      fireEvent.change(retention, { target: { value: "continuous" } });
      await waitFor(() => expect(setRetentionMode).toHaveBeenCalledWith("continuous"));
      expect(retention).toHaveValue("continuous");
      fireEvent.change(retention, { target: { value: "speech_triggered" } });
      await waitFor(() => expect(setRetentionMode).toHaveBeenCalledWith("speech_triggered"));
    }
  );

  it("allows choosing Important meeting before capture starts", async () => {
    await i18n.changeLanguage("en");
    const setRetentionMode = vi.fn().mockResolvedValue(undefined);
    useJarvisStore.setState({
      retentionMode: "speech_triggered",
      effectiveRetentionMode: null,
      retentionDegradedReason: null,
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: null,
            status: "idle",
            startedAt: null,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: null,
          },
          setRetentionMode,
        })}
      />
    );

    const selector = screen.getByRole("combobox", { name: "Retention mode" });
    expect(selector).toBeEnabled();
    fireEvent.change(selector, { target: { value: "continuous" } });
    await waitFor(() => expect(setRetentionMode).toHaveBeenCalledWith("continuous"));
  });

  it("does not show stale VAD degradation after the session is terminal", async () => {
    await i18n.changeLanguage("en");
    useJarvisStore.setState({
      retentionMode: "speech_triggered",
      effectiveRetentionMode: "continuous_fallback",
      retentionDegradedReason: "vad_unavailable",
      sourceStates: { mic: "idle", system: "idle" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "s1",
            status: "completed",
            startedAt: 0,
            activeSince: null,
            accumulatedMs: 100,
            errorCode: null,
          },
        })}
      />
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the visible fail-open VAD degradation state", async () => {
    await i18n.changeLanguage("en");
    useJarvisStore.setState({
      retentionMode: "speech_triggered",
      effectiveRetentionMode: "continuous_fallback",
      retentionDegradedReason: "vad_unavailable",
      sourceStates: { mic: "recording", system: "idle" },
    });

    render(<RecordingControls recording={fakeRecording()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Voice activity detection is unavailable. Audio is being kept continuously."
    );
  });

  it("shows transcription suspension as non-fatal while recording continues", async () => {
    await i18n.changeLanguage("en");
    useJarvisStore.setState({
      sourceStates: { mic: "recording", system: "idle" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          transcriptionWarning: "Whisper is paused for fullscreen yield",
        })}
      />
    );

    expect(
      screen.getByText(
        "Live transcription is paused. Audio is still being saved and will be completed later."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Recording could not continue. Check the microphone and try again.")
    ).not.toBeInTheDocument();
  });

  it("does not retain a transcription warning after a recording is completed", async () => {
    await i18n.changeLanguage("en");
    render(
      <RecordingControls
        recording={fakeRecording({
          session: {
            id: "s1",
            status: "completed",
            startedAt: 0,
            activeSince: null,
            accumulatedMs: 100,
            errorCode: null,
          },
          transcriptionWarning: "Whisper is paused for fullscreen yield",
        })}
      />
    );

    expect(
      screen.queryByText(
        "Live transcription is paused. Audio is still being saved and will be completed later."
      )
    ).not.toBeInTheDocument();
  });
});
