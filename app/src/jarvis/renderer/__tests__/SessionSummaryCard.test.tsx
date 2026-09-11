import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SessionSummaryCard from "../memory/SessionSummaryCard";

describe("SessionSummaryCard", () => {
  const defaults = {
    summary: null,
    refresh: null,
    loading: false,
    summaryInputReady: false,
    decisions: [],
    suggestions: [],
    onAnalyze: vi.fn(),
  };
  it("keeps pending processing distinct from ready without summary", () => {
    const { rerender } = render(<SessionSummaryCard {...defaults} />);
    expect(screen.getByText(/正在完成最终转写和说话人识别/)).toBeInTheDocument();
    rerender(<SessionSummaryCard {...defaults} summaryInputReady />);
    expect(screen.getByText(/尚未生成总结。录音和转写已安全保存/)).toBeInTheDocument();
  });
  it("never starts a paid refresh on render; only explicit click invokes it", () => {
    const onAnalyze = vi.fn();
    const { rerender } = render(
      <SessionSummaryCard
        {...defaults}
        onAnalyze={onAnalyze}
        refresh={{ recommended: 1, reason: "speaker_identity_changed" }}
      />
    );
    expect(onAnalyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "付费刷新总结" }));
    expect(onAnalyze).toHaveBeenCalledTimes(1);
    rerender(
      <SessionSummaryCard
        {...defaults}
        onAnalyze={onAnalyze}
        refresh={{ recommended: 1, reason: "speaker_identity_changed" }}
        loading
      />
    );
    expect(screen.getByRole("button", { name: "正在刷新…" })).toBeDisabled();
  });
});
