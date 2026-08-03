import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import JarvisShell from "../JarvisShell";
import { useJarvisStore } from "../jarvisStore";

vi.mock("../../../components/WindowControls", () => ({
  default: () => <div data-testid="jarvis-window-controls">controls</div>,
}));

vi.mock("../../../components/MeetingRecordingMount", () => ({
  default: () => <div data-testid="jarvis-microphone-level-sampler" />,
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
    systemLevel: 0,
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

beforeEach(() => {
  useJarvisStore.setState({
    captureMode: "mic",
    sourceStates: { mic: "recording", system: "idle" },
    selectedView: "today",
    selectedSessionId: null,
    evidenceNavigation: { phase: "idle", requestId: 0 },
  });
});

describe("JarvisShell", () => {
  it("mounts the microphone level sampler for standalone Jarvis capture", () => {
    render(<JarvisShell />);

    expect(screen.getByTestId("jarvis-microphone-level-sampler")).toBeInTheDocument();
  });

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
    expect(screen.getByRole("heading", { name: /每日回顾/ })).toBeInTheDocument();
    expect(screen.queryByText(/MiniMax 个人助手分析/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开助手设置" }));
    expect(screen.getByText(/MiniMax 个人助手分析/)).toBeInTheDocument();
  });

  it("enables every memory navigation destination", () => {
    render(<JarvisShell />);

    for (const name of [/^人物$/, /^主题$/, /^待办$/, /^记忆库$/]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.queryByText("完成首次分析后启用")).not.toBeInTheDocument();
  });

  it("shows a dismissible error instead of silently dropping failed evidence navigation", () => {
    useJarvisStore.setState({
      evidenceNavigation: {
        phase: "failed",
        requestId: 3,
        code: "evidence_navigation_failed",
      },
    });

    render(<JarvisShell />);

    expect(screen.getByText("无法打开这条来源").closest('[role="alert"]')).toHaveTextContent(
      "已保存的数据不会丢失"
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭来源导航错误" }));
    expect(screen.queryByText("无法打开这条来源")).not.toBeInTheDocument();
    expect(useJarvisStore.getState().evidenceNavigation.phase).toBe("idle");
  });

  it("uses a wider desktop insights column and a drawer trigger below the breakpoint", () => {
    render(<JarvisShell />);

    expect(screen.getByTestId("jarvis-shell")).toHaveClass("grid-cols-1");
    expect(screen.getByTestId("jarvis-shell")).toHaveClass(
      "lg:grid-cols-[176px_minmax(420px,1fr)_380px]"
    );
    expect(screen.getByRole("complementary", { name: "洞察" })).toHaveClass("hidden", "lg:block");
    expect(screen.getByRole("button", { name: "洞察" })).toHaveAttribute(
      "aria-controls",
      "jarvis-insights-panel"
    );
  });

  it("opens the narrow insights drawer with modal focus and restores the trigger on Escape", async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width"),
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
      render(<JarvisShell />);
      const trigger = screen.getByRole("button", { name: "洞察" });
      fireEvent.click(trigger);

      expect(screen.getByRole("dialog", { name: "洞察" })).toBeVisible();
      expect(screen.getByRole("button", { name: "关闭 洞察" })).toHaveFocus();
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "洞察" })).toBeNull());
      expect(trigger).toHaveFocus();
      expect(document.body.style.overflow).toBe("");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });
});
