import { fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("../CurrentSessionResultView", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <main data-testid="current-session-result">finished session {sessionId}</main>
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("TodayView settings drawer", () => {
  const idleRecording = {
    session: { id: null },
    segments: [],
    partialText: "",
  } as UseJarvisRecordingResult;

  it("keeps the right column concise and opens all advanced settings on demand", () => {
    render(
      <TodayView onOpenSession={() => {}} onViewAllTodos={() => {}} recording={idleRecording} />
    );

    expect(screen.getByText("daily review")).toBeInTheDocument();
    expect(screen.queryByText("MiniMax settings")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Open assistant settings" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Assistant settings" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("MiniMax settings")).toBeInTheDocument();
    expect(screen.getByText("transcription quality")).toBeInTheDocument();
    expect(screen.getByText("voice enrollment")).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close assistant settings" });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    const buttons = within(dialog)
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("disabled"));
    const last = buttons.at(-1) as HTMLButtonElement;
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Assistant settings" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss assistant settings" }));
    expect(screen.queryByRole("dialog", { name: "Assistant settings" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("exposes insights as an accessible narrow-screen drawer and restores trigger focus", () => {
    render(
      <TodayView onOpenSession={() => {}} onViewAllTodos={() => {}} recording={idleRecording} />
    );

    const trigger = screen.getByRole("button", { name: "Insights" });
    const closedPanel = screen.getByRole("complementary", { name: "Insights" });
    expect(trigger).toHaveAttribute("aria-controls", "jarvis-insights-panel");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(closedPanel).toHaveClass("hidden", "lg:block");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Insights" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: "Close Insights" });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    const buttons = within(dialog)
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("disabled"));
    const last = buttons.at(-1) as HTMLButtonElement;
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Insights" }));

    expect(screen.queryByRole("dialog", { name: "Insights" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("dismisses the insights drawer with Escape", () => {
    render(
      <TodayView onOpenSession={() => {}} onViewAllTodos={() => {}} recording={idleRecording} />
    );

    const trigger = screen.getByRole("button", { name: "Insights" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Insights" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Insights" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps Escape dismissal for the existing settings drawer", () => {
    render(
      <TodayView onOpenSession={() => {}} onViewAllTodos={() => {}} recording={idleRecording} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open assistant settings" }));
    expect(screen.getByRole("dialog", { name: "Assistant settings" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Assistant settings" })).not.toBeInTheDocument();
  });

  it("returns settings focus to the visible Insights trigger on narrow screens", () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(max-width: 1023px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    try {
      render(
        <TodayView onOpenSession={() => {}} onViewAllTodos={() => {}} recording={idleRecording} />
      );
      const insightsTrigger = screen.getByRole("button", { name: "Insights" });
      fireEvent.click(insightsTrigger);
      fireEvent.click(screen.getByRole("button", { name: "Open assistant settings" }));

      expect(screen.getByRole("button", { name: "Close assistant settings" })).toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("dialog", { name: "Assistant settings" })).not.toBeInTheDocument();
      expect(insightsTrigger).toHaveFocus();
      expect(document.body.style.overflow).toBe("");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });

  it("switches to the finished session immediately and returns to live capture for a new start", () => {
    const baseRecording = {
      segments: [],
      partialText: "",
    } as unknown as UseJarvisRecordingResult;
    const { rerender } = render(
      <TodayView
        onOpenSession={() => {}}
        onViewAllTodos={() => {}}
        recording={{
          ...baseRecording,
          session: {
            id: "session-finished",
            status: "finalizing",
            startedAt: 1,
            activeSince: null,
            accumulatedMs: 12_000,
            errorCode: null,
          },
        }}
      />
    );

    expect(screen.getByTestId("current-session-result")).toHaveTextContent(
      "finished session session-finished"
    );
    expect(screen.queryByText("recording controls")).not.toBeInTheDocument();
    expect(screen.queryByText("live transcript")).not.toBeInTheDocument();

    rerender(
      <TodayView
        onOpenSession={() => {}}
        onViewAllTodos={() => {}}
        recording={{
          ...baseRecording,
          session: {
            id: "session-new",
            status: "starting",
            startedAt: 2,
            activeSince: null,
            accumulatedMs: 0,
            errorCode: null,
          },
        }}
      />
    );

    expect(screen.queryByTestId("current-session-result")).not.toBeInTheDocument();
    expect(screen.getByText("recording controls")).toBeInTheDocument();
    expect(screen.getByText("live transcript")).toBeInTheDocument();
  });

  it("shows only today's recent sessions below the live area and opens Memory detail", () => {
    const now = new Date();
    const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30).getTime();
    const yesterdayAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      17,
      0
    ).getTime();
    const onOpenSession = vi.fn();
    const recording = {
      ...idleRecording,
      session: {
        id: "session-current",
        status: "recording",
        startedAt: todayAt + 10_000,
        activeSince: todayAt + 10_000,
        accumulatedMs: 0,
        errorCode: null,
      },
      sessions: [
        {
          id: "session-current",
          started_at: todayAt + 10_000,
          ended_at: null,
          status: "recording",
          language: "zh",
          created_at: todayAt + 10_000,
          capture_mode: "mic",
        },
        {
          id: "session-today",
          started_at: todayAt,
          ended_at: todayAt + 25 * 60_000,
          status: "completed",
          language: "zh",
          created_at: todayAt,
          capture_mode: "dual",
        },
        {
          id: "session-yesterday",
          started_at: yesterdayAt,
          ended_at: yesterdayAt + 5 * 60_000,
          status: "completed",
          language: "zh",
          created_at: yesterdayAt,
          capture_mode: "mic",
        },
      ],
    } as UseJarvisRecordingResult;

    render(
      <TodayView onOpenSession={onOpenSession} onViewAllTodos={() => {}} recording={recording} />
    );

    expect(screen.getByRole("heading", { name: "Today's recent sessions" })).toBeInTheDocument();
    expect(screen.getByText("25:00")).toBeInTheDocument();
    expect(screen.queryByText("5:00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open session.*09:30/i }));
    expect(onOpenSession).toHaveBeenCalledWith("session-today");
  });
});
