import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import JarvisShell from "../JarvisShell";

vi.mock("../../../components/WindowControls", () => ({
  default: () => <div data-testid="jarvis-window-controls">controls</div>,
}));

vi.mock("../useJarvisRecording", () => ({
  useJarvisRecording: () => ({
    session: {
      status: "recording",
      id: "s1",
      startedAt: 0,
      activeSince: 0,
      accumulatedMs: 42_000,
      errorCode: null,
    },
    segments: [
      {
        id: "seg1",
        text: "下一版先把支付流程跑通",
        source: "mic",
        speaker: "self",
        speakerName: "我",
        timestamp: 1_000,
        confidence: 0.98,
      },
    ],
    partialText: "",
    micLevel: 0.4,
    error: null,
    operation: null,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    finish: vi.fn(),
    renameSpeaker: vi.fn(),
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("JarvisShell", () => {
  it("provides a draggable titlebar without making window controls draggable", () => {
    render(<JarvisShell />);

    expect(screen.getByTestId("jarvis-drag-region")).toHaveAttribute("data-app-region", "drag");
    expect(screen.getByTestId("jarvis-window-controls").parentElement).toHaveAttribute(
      "data-app-region",
      "no-drag"
    );
  });

  it("shows the approved Today command-center hierarchy", () => {
    render(<JarvisShell />);

    expect(screen.getByRole("heading", { name: "今天" })).toBeInTheDocument();
    expect(screen.getByText("实时对话")).toBeInTheDocument();
    expect(screen.getByText("正在监听")).toBeInTheDocument();
    expect(screen.getByText("当前主题")).toBeInTheDocument();
    expect(screen.getByText("AI 建议")).toBeInTheDocument();
  });

  it("enables every memory navigation destination", () => {
    render(<JarvisShell />);

    for (const name of [/人物/, /主题/, /待办/, /记忆/]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.queryByText("完成首次分析后启用")).not.toBeInTheDocument();
  });

  it("has a single-column fallback below the desktop layout breakpoint", () => {
    render(<JarvisShell />);

    expect(screen.getByTestId("jarvis-shell")).toHaveClass("grid-cols-1");
    expect(screen.getByTestId("jarvis-shell")).toHaveClass(
      "lg:grid-cols-[176px_minmax(420px,1fr)_320px]"
    );
    expect(screen.getByRole("complementary", { name: "洞察" })).not.toHaveClass("hidden");
  });
});
