import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JarvisSessionTimeline } from "../../types";
import ProcessingStatus from "../ProcessingStatus";

function timeline(overrides: Partial<JarvisSessionTimeline> = {}): JarvisSessionTimeline {
  return {
    session_id: "session-1",
    started_at: 1_000,
    ended_at: 2_000,
    status: "completed",
    processing_state: "processing",
    timeline_version: 1,
    finalized_at: 2_000,
    ready_at: null,
    tracks: [],
    gaps: [],
    chunks: [],
    segments: [],
    processing_counts: {
      pending: 0,
      leased: 0,
      retry: 0,
      blocked: 0,
      completed: 0,
      total: 0,
    },
    ...overrides,
  };
}

describe("ProcessingStatus", () => {
  it.each([
    ["recording", "正在录音"],
    ["paused", "录音已暂停"],
    ["finalizing", "正在完成录音"],
  ] as const)("shows capture state for an open %s session", (status, label) => {
    render(<ProcessingStatus timeline={timeline({ status, processing_state: "ready" })} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("处理完成")).not.toBeInTheDocument();
  });

  it("shows only persisted ready as complete", () => {
    render(
      <ProcessingStatus
        timeline={timeline({ processing_state: "ready", ready_at: 2_500 })}
      />
    );

    expect(screen.getByText("处理完成")).toBeInTheDocument();
  });

  it("shows pending, leased, and retry work as processing", () => {
    render(
      <ProcessingStatus
        timeline={timeline({
          processing_counts: {
            pending: 2,
            leased: 1,
            retry: 3,
            blocked: 0,
            completed: 4,
            total: 10,
          },
        })}
      />
    );

    expect(screen.getByText("正在处理")).toBeInTheDocument();
    expect(screen.getByText(/待处理 2/)).toBeInTheDocument();
    expect(screen.getByText(/处理中 1/)).toBeInTheDocument();
    expect(screen.getByText(/等待重试 3/)).toBeInTheDocument();
  });

  it("shows blocked work as an actionable error instead of complete", () => {
    render(
      <ProcessingStatus
        timeline={timeline({
          processing_state: "ready",
          ready_at: 2_500,
          processing_counts: {
            pending: 0,
            leased: 0,
            retry: 0,
            blocked: 2,
            completed: 4,
            total: 6,
          },
        })}
      />
    );

    expect(screen.getByText("处理受阻")).toBeInTheDocument();
    expect(screen.getByText(/2 个任务/)).toBeInTheDocument();
    expect(screen.getByText(/检查本地模型或存储/)).toBeInTheDocument();
    expect(screen.queryByText("处理完成")).not.toBeInTheDocument();
  });
});
