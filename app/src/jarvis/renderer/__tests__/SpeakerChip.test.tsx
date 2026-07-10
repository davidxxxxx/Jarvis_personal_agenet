import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import SpeakerChip from "../SpeakerChip";

const lockSpeaker = vi.fn();

vi.mock("../../../stores/meetingRecordingStore", () => ({
  lockSpeaker: (...args: unknown[]) => lockSpeaker(...args),
}));

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("SpeakerChip", () => {
  beforeEach(() => {
    lockSpeaker.mockReset();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          renamePerson: vi.fn().mockResolvedValue({ id: "p2", display_name: "张三" }),
        },
      },
    });
  });

  it("renames a speaker locally and locks every current-session row", async () => {
    render(<SpeakerChip personId="p2" displayName="说话人 2" confidence={0.9} />);

    fireEvent.click(screen.getByRole("button", { name: "说话人 2" }));
    fireEvent.change(screen.getByLabelText("说话人姓名"), { target: { value: "张三" } });
    fireEvent.click(screen.getByRole("button", { name: "保存姓名" }));

    await waitFor(() => {
      expect(window.electronAPI.jarvis.renamePerson).toHaveBeenCalledWith({
        personId: "p2",
        displayName: "张三",
      });
    });
    expect(lockSpeaker).toHaveBeenCalledWith("p2", "张三");
  });

  it("marks a speaker as self without overwriting their existing profile name", async () => {
    render(<SpeakerChip personId="p2" displayName="张三" confidence={0.9} />);

    fireEvent.click(screen.getByRole("button", { name: "张三" }));
    fireEvent.click(screen.getByRole("button", { name: "标记为我" }));

    await waitFor(() => {
      expect(window.electronAPI.jarvis.renamePerson).toHaveBeenCalledWith({
        personId: "p2",
        isSelf: true,
      });
    });
    expect(lockSpeaker).toHaveBeenCalledWith("p2", "张三");
  });

  it("shows low-confidence stable speakers as needing confirmation", () => {
    render(<SpeakerChip personId="p2" displayName="说话人 2" confidence={0.64} />);

    expect(screen.getByRole("button", { name: "待确认" })).toBeInTheDocument();
  });
});
