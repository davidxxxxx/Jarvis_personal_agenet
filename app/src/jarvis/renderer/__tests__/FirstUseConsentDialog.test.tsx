import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import RecordingControls from "../RecordingControls";

const start = vi.fn().mockResolvedValue(undefined);

const idleRecording = {
  session: {
    id: null,
    status: "idle" as const,
    startedAt: null,
    activeSince: null,
    accumulatedMs: 0,
    errorCode: null,
  },
  segments: [],
  partialText: "",
  micLevel: 0,
  error: null,
  operation: null,
  start,
  pause: vi.fn(),
  resume: vi.fn(),
  finish: vi.fn(),
  setRetentionMode: vi.fn(),
  renameSpeaker: vi.fn(),
};

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("first-use recording consent", () => {
  beforeEach(() => {
    localStorage.clear();
    start.mockClear();
  });

  it("blocks recording until the user gives explicit consent, then starts once", async () => {
    render(<RecordingControls recording={idleRecording} />);

    fireEvent.click(screen.getByRole("button", { name: "开始监听" }));
    expect(start).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: "确认并开始" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/音频文件保留 7 天/)).toBeInTheDocument();
    expect(screen.getByText(/转写、总结和记忆内容将长期保留/)).toBeInTheDocument();
    expect(screen.getByText(/你有责任确保已获得合法授权/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "我确认仅在有权录音并已履行必要告知的场景中使用",
      })
    );
    fireEvent.click(confirm);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("jarvisRecordingConsentVersion")).toBe("1");
  });

  it("starts directly after persisted consent", async () => {
    localStorage.setItem("jarvisRecordingConsentVersion", "1");
    render(<RecordingControls recording={idleRecording} />);

    fireEvent.click(screen.getByRole("button", { name: "开始监听" }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables controls and ignores rapid clicks while a command is pending", async () => {
    localStorage.setItem("jarvisRecordingConsentVersion", "1");
    let release!: () => void;
    const command = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    function Harness() {
      const [operation, setOperation] = useState<"start" | null>(null);
      return (
        <RecordingControls
          recording={{
            ...idleRecording,
            operation,
            start: async () => {
              setOperation("start");
              await command();
              setOperation(null);
            },
          }}
        />
      );
    }

    render(<Harness />);
    const button = screen.getByRole("button", { name: "开始监听" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);

    expect(command).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("catches rejected commands and surfaces an accessible error", async () => {
    localStorage.setItem("jarvisRecordingConsentVersion", "1");
    render(
      <RecordingControls
        recording={{
          ...idleRecording,
          operation: null,
          start: vi.fn().mockRejectedValue(new Error("microphone denied")),
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "开始监听" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败，请重试");
  });

  it("reports microphone level semantics and refreshes its label on device change", async () => {
    const mediaDevices = new EventTarget() as EventTarget & {
      enumerateDevices: ReturnType<typeof vi.fn>;
    };
    mediaDevices.enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([{ kind: "audioinput", deviceId: "default", label: "" }])
      .mockResolvedValue([{ kind: "audioinput", deviceId: "default", label: "会议麦克风" }]);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    render(<RecordingControls recording={{ ...idleRecording, operation: null, micLevel: 0.42 }} />);

    const meter = screen.getByRole("meter", { name: "麦克风电平" });
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuenow", "42");

    mediaDevices.dispatchEvent(new Event("devicechange"));
    expect(await screen.findByText("会议麦克风")).toBeInTheDocument();
  });
});
