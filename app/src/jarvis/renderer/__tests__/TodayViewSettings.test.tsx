import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import TodayView from "../TodayView";
import type { UseJarvisRecordingResult } from "../useJarvisRecording";

vi.mock("../RecordingControls", () => ({ default: () => <div>recording controls</div> }));
vi.mock("../LiveTranscript", () => ({ default: () => <div>live transcript</div> }));
vi.mock("../DailyReviewView", () => ({ default: () => <div>daily review</div> }));
vi.mock("../MiniMaxAgentSettingsCard", () => ({ default: () => <div>MiniMax settings</div> }));
vi.mock("../TranscriptionQualityCard", () => ({
  default: () => <div>transcription quality</div>,
}));
vi.mock("../VoiceEnrollment", () => ({ default: () => <div>voice enrollment</div> }));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("TodayView settings drawer", () => {
  it("keeps the right column concise and opens all advanced settings on demand", () => {
    render(
      <TodayView
        onViewAllTodos={() => {}}
        recording={
          {
            session: { id: null },
            segments: [],
            partialText: "",
          } as UseJarvisRecordingResult
        }
      />
    );

    expect(screen.getByText("daily review")).toBeInTheDocument();
    expect(screen.queryByText("MiniMax settings")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open assistant settings" }));

    expect(screen.getByRole("dialog", { name: "Assistant settings" })).toBeInTheDocument();
    expect(screen.getByText("MiniMax settings")).toBeInTheDocument();
    expect(screen.getByText("transcription quality")).toBeInTheDocument();
    expect(screen.getByText("voice enrollment")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close assistant settings" }));
    expect(screen.queryByRole("dialog", { name: "Assistant settings" })).not.toBeInTheDocument();
  });
});
