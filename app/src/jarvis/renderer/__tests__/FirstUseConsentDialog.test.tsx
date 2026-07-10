import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  start,
  pause: vi.fn(),
  resume: vi.fn(),
  finish: vi.fn(),
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
});
