import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import {
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../../stores/meetingRecordingStore";
import LiveTranscript from "../LiveTranscript";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("LiveTranscript", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          renamePerson: vi.fn(async (input) => ({
            id: input.personId,
            display_name: input.displayName ?? "张三",
            is_self: input.isSelf ? 1 : 0,
          })),
        },
      },
    });
  });

  afterEach(() => {
    useMeetingRecordingStore.setState({ segments: [] });
  });

  it("sorts stable rows by timestamp and renders partial text separately", () => {
    render(
      <LiveTranscript
        segments={[
          { id: "late", text: "后一句", source: "mic", timestamp: 2_000 },
          { id: "early", text: "前一句", source: "mic", timestamp: 1_000 },
        ]}
        partialText="临时内容"
      />
    );

    const rows = screen.getAllByTestId("stable-transcript-row");
    expect(rows[0]).toHaveTextContent("前一句");
    expect(rows[1]).toHaveTextContent("后一句");
    expect(screen.getByLabelText("临时转写")).toHaveTextContent("临时内容");
    expect(screen.getByLabelText("临时转写")).toHaveClass("opacity-50");
  });

  it("refreshes every low-confidence row after one manual speaker correction", async () => {
    const segments: TranscriptSegment[] = [
      {
        id: "first",
        text: "第一句",
        source: "system",
        timestamp: 1_000,
        speaker: "p2",
        speakerName: "说话人 2",
        confidence: 0.4,
      },
      {
        id: "second",
        text: "第二句",
        source: "system",
        timestamp: 2_000,
        speaker: "p2",
        speakerName: "说话人 2",
        confidence: 0.5,
      },
    ];
    useMeetingRecordingStore.setState({ segments });

    function StoreTranscript() {
      const current = useMeetingRecordingStore((state) => state.segments);
      return <LiveTranscript segments={current} partialText="" />;
    }

    render(<StoreTranscript />);
    expect(screen.getAllByRole("button", { name: "待确认" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "待确认" })[0]);
    fireEvent.change(screen.getByLabelText("说话人姓名"), { target: { value: "张三" } });
    fireEvent.click(screen.getByRole("button", { name: "保存姓名" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "张三" })).toHaveLength(2);
    });
    expect(screen.queryByRole("button", { name: "待确认" })).not.toBeInTheDocument();
  });
});
