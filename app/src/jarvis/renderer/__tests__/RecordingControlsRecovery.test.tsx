import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import RecordingControls from "../RecordingControls";
import type { UseJarvisRecordingResult } from "../useJarvisRecording";

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
});
