import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisKnowledgeOverview } from "../../types";
import KnowledgeMemoryPanel from "../KnowledgeMemoryPanel";
import TodosView from "../TodosView";
import TopicsView from "../TopicsView";

const overview: JarvisKnowledgeOverview = {
  memories: [
    {
      id: "memory_1",
      kind: "decision",
      title: "Deployment choice",
      body: "Use local-first storage.",
      confidence: 0.9,
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 2,
      occurrences: [
        {
          id: "memory_occurrence_1",
          sessionId: "session_1",
          startedAt: 10,
          endedAt: 20,
          confidence: 0.9,
          createdAt: 20,
          evidence: [
            {
              sessionId: "session_1",
              segmentId: "segment_1",
              startedAt: 10,
              endedAt: 20,
              quote: "Keep it local.",
              audioState: "available",
            },
          ],
        },
      ],
    },
  ],
  topics: [
    {
      id: "topic_1",
      name: "Project Atlas",
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 2,
      revisions: [
        { id: "topic_revision_1", revision: 1, summary: "Initial plan", createdAt: 1 },
        { id: "topic_revision_2", revision: 2, summary: "Release plan", createdAt: 2 },
      ],
      occurrences: [
        {
          id: "topic_occurrence_1",
          sessionId: "session_1",
          revisionId: "topic_revision_2",
          createdAt: 2,
          evidence: [
            {
              sessionId: "session_1",
              segmentId: "segment_1",
              startedAt: 10,
              endedAt: 20,
              quote: "Ship Atlas Friday.",
              audioState: "expired",
            },
          ],
        },
      ],
    },
  ],
  todos: [
    {
      id: "todo_open",
      title: "Prepare release build",
      ownerLabel: "我",
      status: "open",
      completedAt: null,
      dismissedAt: null,
      createdAt: 1,
      updatedAt: 2,
      revisions: [
        {
          id: "todo_revision_1",
          revision: 1,
          title: "Prepare release build",
          dueText: "Friday",
          createdAt: 1,
        },
      ],
      occurrences: [],
      transitions: [{ id: "transition_1", fromStatus: null, toStatus: "open", occurredAt: 1 }],
    },
    {
      id: "todo_done",
      title: "Review design",
      ownerLabel: null,
      status: "completed",
      completedAt: 3,
      dismissedAt: null,
      createdAt: 1,
      updatedAt: 3,
      revisions: [],
      occurrences: [],
      transitions: [],
    },
  ],
  suggestions: [
    {
      id: "suggestion_1",
      title: "Review tomorrow",
      rationale: "Catch regressions early.",
      state: "proposed",
      decidedAt: null,
      createdAt: 1,
      updatedAt: 1,
      occurrences: [],
    },
  ],
  conflicts: [
    {
      id: "conflict_1",
      episode: 1,
      state: "open",
      selectedMemoryItemId: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      members: [
        {
          memoryItemId: "memory_1",
          title: "Deployment choice",
          body: "Use local-first storage.",
          lifecycle: "conflict",
          selected: false,
        },
      ],
    },
  ],
  truncated: false,
};

describe("durable knowledge views", () => {
  beforeEach(() => {
    window.electronAPI = {
      jarvis: {
        getKnowledgeOverview: vi.fn().mockResolvedValue(overview),
        completeKnowledgeTodo: vi.fn().mockResolvedValue({
          status: "completed",
          todoId: "todo_open",
          completedAt: 4,
        }),
        decideKnowledgeSuggestion: vi.fn().mockResolvedValue({
          status: "accepted",
          suggestionId: "suggestion_1",
          decidedAt: 4,
        }),
        resolveKnowledgeConflict: vi.fn().mockResolvedValue({
          status: "resolved",
          conflictGroupId: "conflict_1",
          selectedMemoryItemId: "memory_1",
        }),
        listTopics: vi.fn(),
        listTodos: vi.fn(),
      },
    } as unknown as typeof window.electronAPI;
  });

  it("renders v2 topic revisions and retained transcript evidence", async () => {
    render(<TopicsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Project Atlas/ }));

    expect(screen.getAllByText("Release plan")).not.toHaveLength(0);
    expect(screen.getByText("Initial plan")).toBeVisible();
    expect(
      screen.getByText((_, element) =>
        Boolean(element?.tagName === "LI" && element.textContent?.includes("Ship Atlas Friday."))
      )
    ).toBeVisible();
    expect(window.electronAPI.jarvis.listTopics).not.toHaveBeenCalled();
  });

  it("allows only forward completion for v2 todos", async () => {
    render(<TodosView />);
    const complete = await screen.findByRole("button", {
      name: "Complete / 完成 Prepare release build",
    });
    expect(screen.getByText("Prepare release build")).toBeVisible();
    expect(screen.getByText(/Friday/)).toBeVisible();
    fireEvent.click(complete);

    await waitFor(() =>
      expect(window.electronAPI.jarvis.completeKnowledgeTodo).toHaveBeenCalledWith("todo_open")
    );
    expect(screen.queryByRole("button", { name: /reopen|重新打开/i })).not.toBeInTheDocument();
    expect(window.electronAPI.jarvis.listTodos).not.toHaveBeenCalled();
  });

  it("keeps suggestions and conflicts explicit user decisions", async () => {
    render(<KnowledgeMemoryPanel />);
    expect((await screen.findAllByText("Use local-first storage.")).length).toBeGreaterThan(0);
    expect(screen.getByText("Keep it local.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /accept|接受/i }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeSuggestion).toHaveBeenCalledWith(
        "suggestion_1",
        "accept"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: /choose|选择/i }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.resolveKnowledgeConflict).toHaveBeenCalledWith(
        "conflict_1",
        "memory_1"
      )
    );
  });
});
