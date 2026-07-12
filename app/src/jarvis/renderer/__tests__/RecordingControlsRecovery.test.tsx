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
    activeMicLabel: "Microphone (5- Shure MV7)",
    micFallbackActive: false,
    operation: null,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    renameSpeaker: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("RecordingControls microphone recovery", () => {
  beforeEach(() => {
    localStorage.setItem("jarvisRecordingConsentVersion", "1");
    useJarvisStore.setState({
      captureMode: "mic",
      sourceStates: { mic: "idle", system: "idle" },
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

  it("uses computer-audio visuals without a microphone identity or meter in system-only mode", () => {
    useJarvisStore.setState({
      captureMode: "system",
      sourceStates: { mic: "idle", system: "recording" },
    });

    render(
      <RecordingControls
        recording={fakeRecording({
          activeMicLabel: "Private microphone name",
          micLevel: 0.75,
        })}
      />
    );

    expect(screen.getByRole("img", { name: "电脑声音" })).toBeInTheDocument();
    expect(screen.getByText("电脑声音", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Private microphone name")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
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
});
