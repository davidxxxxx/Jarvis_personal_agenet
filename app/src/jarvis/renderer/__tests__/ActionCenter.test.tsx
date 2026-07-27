import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisKnowledgeOverview } from "../../types";
import ActionCenter from "../ActionCenter";

const now = Date.now();
const baseTodo = {
  ownerLabel: "我",
  completedAt: null,
  dismissedAt: null,
  createdAt: now,
  updatedAt: now,
  occurrences: [],
  transitions: [],
};

const overview: JarvisKnowledgeOverview = {
  memories: [],
  topics: [],
  todos: [
    {
      ...baseTodo,
      id: "today",
      title: "今天提交版本",
      status: "open",
      verificationState: "confirmed",
      verificationReason: "strict_self_commitment",
      verificationActor: "system",
      provenance: "evidence_linked",
      sourceSuggestionId: null,
      revisions: [
        {
          id: "today-r1",
          revision: 1,
          title: "今天提交版本",
          dueText: "今天",
          createdAt: now,
        },
      ],
    },
    {
      ...baseTodo,
      id: "pending",
      title: "确认别人交给我的事项",
      status: "open",
      verificationState: "pending_confirmation",
      verificationReason: "assigned_and_accepted",
      verificationActor: "system",
      provenance: "evidence_linked",
      sourceSuggestionId: null,
      revisions: [],
    },
    {
      ...baseTodo,
      id: "later",
      title: "没有日期的事项",
      status: "open",
      verificationState: "confirmed",
      verificationReason: "user_confirmed",
      verificationActor: "user",
      provenance: "evidence_linked",
      sourceSuggestionId: null,
      revisions: [],
    },
    {
      ...baseTodo,
      id: "done",
      title: "已经完成",
      status: "completed",
      completedAt: now,
      verificationState: "confirmed",
      verificationReason: "user_confirmed",
      verificationActor: "user",
      provenance: "evidence_linked",
      sourceSuggestionId: null,
      revisions: [],
    },
  ],
  suggestions: [
    {
      id: "suggestion",
      title: "复盘发布",
      rationale: "这是候选建议，不会主动通知。",
      state: "proposed",
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
      occurrences: [],
    },
  ],
  conflicts: [],
  truncated: false,
};

describe("ActionCenter", () => {
  const onViewAll = vi.fn();

  beforeEach(() => {
    onViewAll.mockReset();
    window.electronAPI = {
      jarvis: {
        getKnowledgeOverview: vi.fn().mockResolvedValue(overview),
        completeKnowledgeTodo: vi.fn().mockResolvedValue({
          status: "completed",
          todoId: "today",
          completedAt: now,
        }),
        decideKnowledgeTodo: vi.fn().mockResolvedValue({
          status: "confirmed",
          todoId: "pending",
          decidedAt: now,
        }),
        decideKnowledgeSuggestion: vi.fn().mockResolvedValue({
          status: "accepted",
          suggestionId: "suggestion",
          decidedAt: now,
          todoId: "accepted-todo",
        }),
      },
    } as unknown as typeof window.electronAPI;
  });

  it("partitions actions and exposes only explicit lifecycle operations", async () => {
    render(
      <ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />
    );

    expect(await screen.findByText("今天提交版本")).toBeVisible();
    expect(screen.getByText("待你确认 (1)")).toBeVisible();
    expect(screen.getByText("复盘发布")).toBeVisible();
    expect(screen.queryByText("没有日期的事项")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /稍后/ }));
    expect(screen.getByText("没有日期的事项")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /今日已完成/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reopen|撤销完成/ }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeTodo).toHaveBeenCalledWith(
        "done",
        "reopen"
      )
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm / 确认 确认别人交给我的事项",
      })
    );
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeTodo).toHaveBeenCalledWith(
        "pending",
        "confirm"
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Accept suggestion|接受建议/ }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeSuggestion).toHaveBeenCalledWith(
        "suggestion",
        "accept"
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "查看全部待办与历史" }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });
});
