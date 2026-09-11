import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisKnowledgeActionResult,
  JarvisKnowledgeOverview,
  JarvisKnowledgeTodoCompletionResult,
  JarvisKnowledgeTodoDecisionResult,
  JarvisTopicDetail,
} from "../../types";
import KnowledgeMemoryPanel from "../KnowledgeMemoryPanel";
import TodosView from "../TodosView";
import TopicsView from "../TopicsView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const unknownCardContext = {
  sessionId: null,
  startedAt: null,
  applicationName: null,
  activityCategory: null,
  activityConfidence: null,
  sourceAttribution: "mixed_unknown" as const,
};

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
      verificationState: "confirmed",
      trustSnapshot: null,
      cardContext: unknownCardContext,
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
      occurrences: [
        {
          id: "todo_occurrence_1",
          sessionId: "session_1",
          revisionId: "todo_revision_1",
          startedAt: 30,
          endedAt: 40,
          createdAt: 2,
          evidence: [
            {
              sessionId: "session_1",
              segmentId: "todo_segment_1",
              startedAt: 30,
              endedAt: 40,
              quote: "I will prepare the release build.",
              audioState: "available",
            },
          ],
        },
      ],
      transitions: [{ id: "transition_1", fromStatus: null, toStatus: "open", occurredAt: 1 }],
    },
    {
      id: "todo_pending",
      title: "Review game commentary",
      ownerLabel: null,
      status: "open",
      completedAt: null,
      dismissedAt: null,
      verificationState: "pending_confirmation",
      trustSnapshot: null,
      cardContext: unknownCardContext,
      createdAt: 1,
      updatedAt: 2,
      revisions: [],
      occurrences: [],
      transitions: [],
    },
    {
      id: "todo_done",
      title: "Review design",
      ownerLabel: null,
      status: "completed",
      completedAt: 3,
      dismissedAt: null,
      verificationState: "confirmed",
      trustSnapshot: null,
      cardContext: unknownCardContext,
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
      cardContext: unknownCardContext,
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

const topicDetail: JarvisTopicDetail = {
  topic: {
    id: "topic_1",
    canonical_title: "Project Atlas",
    normalized_title: "project atlas",
    description: "Launch scope and delivery timing",
    status: "active",
    created_at: 1,
    last_seen_at: 2,
  },
  people: [
    {
      id: "person_alice",
      display_name: "Alice",
      is_self: 0,
      voice_profile_id: null,
      voice_confidence: null,
      created_at: 1,
      last_seen_at: 2,
    },
  ],
  sessions: [
    {
      id: "session_1",
      started_at: 1_700_000_000_000,
      ended_at: 1_700_000_600_000,
      status: "completed",
      language: "zh",
      created_at: 1_700_000_000_000,
      capture_mode: "dual",
    },
  ],
  decisions: [{ sessionId: "session_1", content: "Ship Atlas on Friday" }],
  todos: [
    {
      id: "topic_todo",
      content: "Prepare the Atlas release",
      owner_person_id: "person_alice",
      owner_name: "Alice",
      topic_id: "topic_1",
      topic_title: "Project Atlas",
      due_at: null,
      status: "open",
      updated_at: 2,
      completed_at: null,
      source_session_id: "session_1",
      source_segment_id: "segment_1",
    },
  ],
  memories: [
    {
      id: "topic_memory",
      type: "fact",
      content: "Atlas uses local-first storage",
      person_id: "person_alice",
      person_name: "Alice",
      topic_id: "topic_1",
      topic_title: "Project Atlas",
      confidence: 0.9,
      last_seen_at: 2,
      occurrence_count: 1,
      needs_confirmation: 0,
    },
  ],
};

let currentTodoReminder: Awaited<ReturnType<typeof window.electronAPI.jarvis.getTodoReminder>> =
  null;

describe("durable knowledge views", () => {
  beforeEach(() => {
    currentTodoReminder = null;
    window.electronAPI = {
      jarvis: {
        getKnowledgeOverview: vi.fn().mockResolvedValue(overview),
        getActionCenterWatermark: vi.fn().mockResolvedValue({
          revision: "1".repeat(64),
          todoCount: overview.todos.length,
          suggestionCount: overview.suggestions.length,
          updatedAt: 3,
        }),
        getActionCenterDelta: vi.fn().mockResolvedValue({
          throughSequence: 0,
          lastSeenSequence: 0,
          confirmedTodoCount: 0,
          pendingTodoCount: 0,
          suggestionCount: 0,
          total: 0,
          sessions: [],
        }),
        markActionCenterRead: vi.fn().mockResolvedValue({
          lastSeenSequence: 0,
          markedAt: 3,
        }),
        completeKnowledgeTodo: vi.fn().mockResolvedValue({
          status: "completed",
          todoId: "todo_open",
          completedAt: 4,
        }),
        decideKnowledgeTodo: vi.fn().mockResolvedValue({
          status: "confirmed",
          todoId: "todo_pending",
          decidedAt: 4,
        }),
        decideKnowledgeSuggestion: vi.fn().mockResolvedValue({
          status: "accepted",
          suggestionId: "suggestion_1",
          decidedAt: 4,
        }),
        applyKnowledgeAction: vi.fn().mockResolvedValue({
          status: "applied",
          commandId: "command-result",
          type: "suggestion_accept",
          entityKind: "suggestion",
          entityId: "suggestion_1",
          occurredAt: 4,
          todoId: "todo-result",
        }),
        resolveKnowledgeConflict: vi.fn().mockResolvedValue({
          status: "resolved",
          conflictGroupId: "conflict_1",
          selectedMemoryItemId: "memory_1",
        }),
        getTopicDetail: vi.fn().mockResolvedValue(topicDetail),
        renameTopic: vi.fn(async (_topicId: string, title: string) => ({
          ...topicDetail.topic,
          canonical_title: title,
          normalized_title: title.toLocaleLowerCase(),
        })),
        listTopics: vi.fn(),
        listTodos: vi.fn(),
        getTodoReminder: vi.fn(async () => currentTodoReminder),
        setTodoReminder: vi.fn(async (todoId: string, reminderAt: number | null) => {
          if (reminderAt === null) {
            currentTodoReminder = currentTodoReminder
              ? {
                  ...currentTodoReminder,
                  state: "cancelled",
                  deferredReason: null,
                  deliveredAt: null,
                  updatedAt: 5,
                }
              : null;
          } else {
            currentTodoReminder = {
              todoId,
              reminderAt,
              reminderSource: "user",
              state: "scheduled",
              deferredReason: null,
              deliveredAt: null,
              updatedAt: 5,
            };
          }
          return currentTodoReminder;
        }),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not present Todos loading or failure as an empty data set and retries in place", async () => {
    const pendingOverview = deferred<JarvisKnowledgeOverview>();
    window.electronAPI.jarvis.getKnowledgeOverview = vi
      .fn()
      .mockReturnValueOnce(pendingOverview.promise)
      .mockResolvedValue(overview);

    render(<TodosView />);

    expect(await screen.findByText("正在读取待办和候选建议…")).toBeVisible();
    expect(screen.queryByText("当前没有需要处理的正式待办")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "现在要做 0" })).not.toBeInTheDocument();

    await act(async () => {
      pendingOverview.reject(new Error("offline"));
      await pendingOverview.promise.catch(() => undefined);
    });

    expect(screen.getByText("待办暂时无法读取；已有录音和数据不会受影响。")).toBeVisible();
    expect(screen.queryByText("当前没有需要处理的正式待办")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "现在要做 1" })).toBeVisible();
    expect(window.electronAPI.jarvis.getKnowledgeOverview).toHaveBeenCalledTimes(2);
  });

  it("renders v2 topic revisions and retained transcript evidence", async () => {
    render(<TopicsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Project Atlas/ }));

    expect(screen.getAllByText("Release plan")).not.toHaveLength(0);
    fireEvent.click(screen.getByText("查看版本历史"));
    expect(screen.getByText("Initial plan")).toBeVisible();
    fireEvent.click(screen.getByText(/查看来源证据/));
    expect(
      screen.getByText((_, element) =>
        Boolean(element?.tagName === "LI" && element.textContent?.includes("Ship Atlas Friday."))
      )
    ).toBeVisible();
    expect(window.electronAPI.jarvis.listTopics).not.toHaveBeenCalled();
  });

  it("shows durable topic relationships, opens a related session, and renames locally", async () => {
    const onOpenSession = vi.fn();
    render(<TopicsView onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: /Project Atlas/ }));

    expect(await screen.findByText("Alice")).toBeVisible();
    expect(screen.getByText("Ship Atlas on Friday")).toBeVisible();
    expect(screen.getByText("Prepare the Atlas release")).toBeVisible();
    expect(screen.getByText("Atlas uses local-first storage")).toBeVisible();
    expect(window.electronAPI.jarvis.getTopicDetail).toHaveBeenCalledWith("topic_1");

    fireEvent.click(screen.getByRole("button", { name: /打开会话/ }));
    expect(onOpenSession).toHaveBeenCalledWith("session_1");

    fireEvent.click(screen.getByRole("button", { name: "重命名主题" }));
    fireEvent.change(screen.getByRole("textbox", { name: "主题名称" }), {
      target: { value: "Atlas Launch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存主题名称" }));

    await waitFor(() =>
      expect(window.electronAPI.jarvis.renameTopic).toHaveBeenCalledWith("topic_1", "Atlas Launch")
    );
    expect(await screen.findByRole("heading", { name: "Atlas Launch" })).toBeVisible();
  });

  it("completes confirmed todos and allows undo from completed history", async () => {
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
    expect(window.electronAPI.jarvis.listTodos).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /已完成/ }));
    fireEvent.click(screen.getByRole("button", { name: /查看待办 Review design/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reopen|撤销完成/ }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeTodo).toHaveBeenCalledWith(
        "todo_done",
        "reopen"
      )
    );
  });

  it("shows persisted application, activity, and session context without guessing missing data", async () => {
    const sessionStartedAt = new Date(2026, 7, 3, 9, 15).getTime();
    const contextualOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: overview.todos.map((todo) =>
        todo.id === "todo_open"
          ? {
              ...todo,
              cardContext: {
                sessionId: "session-kook",
                startedAt: sessionStartedAt,
                applicationName: "KOOK",
                activityCategory: "social_call",
                activityConfidence: 0.93,
                sourceAttribution: "application_and_microphone",
              },
            }
          : todo
      ),
      suggestions: overview.suggestions.map((suggestion) => ({
        ...suggestion,
        cardContext: {
          sessionId: "session-chrome",
          startedAt: sessionStartedAt,
          applicationName: "Chrome",
          activityCategory: "learning",
          activityConfidence: 0.88,
          sourceAttribution: "application",
        },
      })),
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(contextualOverview);

    render(<TodosView />);

    const expectedTime = new Date(sessionStartedAt).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const todoSummary = await screen.findByLabelText("来源摘要 Prepare release build");
    expect(todoSummary).toHaveTextContent("KOOK + 麦克风");
    expect(todoSummary).toHaveTextContent("场景 社交通话");
    expect(todoSummary).toHaveTextContent(`会话 ${expectedTime}`);
    const suggestionSummary = screen.getByLabelText("来源摘要 Review tomorrow");
    expect(suggestionSummary).toHaveTextContent("Chrome");
    expect(suggestionSummary).toHaveTextContent("场景 学习");

    fireEvent.click(screen.getByRole("button", { name: "待你确认 1" }));
    const unknownSummary = screen.getByLabelText("来源摘要 Review game commentary");
    expect(unknownSummary).toHaveTextContent("应用未知");
    expect(unknownSummary).toHaveTextContent("场景未确定");
    expect(unknownSummary).toHaveTextContent("会话时间未知");
  });

  it("optimistically completes a todo, rolls back only its card, and retries locally", async () => {
    const firstAttempt = deferred<JarvisKnowledgeTodoCompletionResult>();
    const retryAttempt = deferred<JarvisKnowledgeTodoCompletionResult>();
    window.electronAPI.jarvis.completeKnowledgeTodo = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<TodosView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete / 完成 Prepare release build" })
    );

    expect(screen.getByRole("button", { name: "现在要做 0" })).toBeVisible();
    expect(screen.queryByText("Prepare release build")).not.toBeInTheDocument();

    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByText("Prepare release build")).toBeVisible();
    expect(screen.getByText("操作未保存，已恢复原状态。")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry action / 重试 Prepare release build" })
    );
    expect(screen.getByRole("button", { name: "现在要做 0" })).toBeVisible();
    expect(window.electronAPI.jarvis.completeKnowledgeTodo).toHaveBeenCalledTimes(2);

    await act(async () => {
      retryAttempt.resolve({ status: "completed", todoId: "todo_open", completedAt: 4 });
      await retryAttempt.promise;
    });
  });

  it("optimistically confirms a pending todo and restores its selected detail on failure", async () => {
    const firstAttempt = deferred<JarvisKnowledgeTodoDecisionResult>();
    const retryAttempt = deferred<JarvisKnowledgeTodoDecisionResult>();
    window.electronAPI.jarvis.decideKnowledgeTodo = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<TodosView />);
    fireEvent.click(await screen.findByRole("button", { name: "待你确认 1" }));
    fireEvent.click(screen.getByRole("button", { name: "查看待办 Review game commentary" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm / 确认 Review game commentary" }));

    expect(screen.getByRole("button", { name: "待你确认 0" })).toBeVisible();
    expect(screen.queryByText("Review game commentary")).not.toBeInTheDocument();

    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("heading", { name: "Review game commentary" })).toBeVisible();
    expect(screen.getByText("操作未保存，已恢复原状态。")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry action / 重试 Review game commentary" })
    );
    expect(screen.getByRole("button", { name: "待你确认 0" })).toBeVisible();
    await act(async () => {
      retryAttempt.resolve({ status: "confirmed", todoId: "todo_pending", decidedAt: 4 });
      await retryAttempt.promise;
    });
  });

  it("optimistically reopens a completed todo and rolls back its selected detail on failure", async () => {
    const firstAttempt = deferred<JarvisKnowledgeTodoDecisionResult>();
    const retryAttempt = deferred<JarvisKnowledgeTodoDecisionResult>();
    window.electronAPI.jarvis.decideKnowledgeTodo = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<TodosView />);
    fireEvent.click(await screen.findByRole("button", { name: "已完成 1" }));
    fireEvent.click(screen.getByRole("button", { name: "查看待办 Review design" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen / 撤销完成 Review design" }));

    expect(screen.getByRole("button", { name: "已完成 0" })).toBeVisible();
    expect(screen.queryByText("Review design")).not.toBeInTheDocument();

    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("heading", { name: "Review design" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry action / 重试 Review design" }));
    expect(screen.getByRole("button", { name: "已完成 0" })).toBeVisible();

    await act(async () => {
      retryAttempt.resolve({ status: "reopened", todoId: "todo_done", decidedAt: 4 });
      await retryAttempt.promise;
    });
  });

  it("optimistically marks a card as not a todo and reuses its command id on retry", async () => {
    const firstAttempt = deferred<JarvisKnowledgeActionResult>();
    const retryAttempt = deferred<JarvisKnowledgeActionResult>();
    window.electronAPI.jarvis.applyKnowledgeAction = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<TodosView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quick not a todo / 快速标记这不是待办 Prepare release build",
      })
    );
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "wrong_context" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));

    expect(screen.getByRole("button", { name: "现在要做 0" })).toBeVisible();
    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByText("Prepare release build")).toBeVisible();
    const firstInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[0][0];

    fireEvent.click(
      screen.getByRole("button", { name: "Retry action / 重试 Prepare release build" })
    );
    expect(screen.getByRole("button", { name: "现在要做 0" })).toBeVisible();
    const retryInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[1][0];
    expect(retryInput).toMatchObject({
      type: "todo_dismiss",
      todoId: "todo_open",
      commandId: firstInput.commandId,
      reasonCode: "wrong_context",
    });

    await act(async () => {
      retryAttempt.resolve({
        status: "applied",
        commandId: firstInput.commandId,
        type: "todo_dismiss",
        entityKind: "todo",
        entityId: "todo_open",
        occurredAt: 4,
        todoId: "todo_open",
      });
      await retryAttempt.promise;
    });
  });

  it("opens todo details as a keyboard-dismissible drawer on narrow screens", async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    try {
      render(<TodosView />);
      const trigger = await screen.findByRole("button", {
        name: "查看待办 Prepare release build",
      });
      trigger.focus();
      fireEvent.click(trigger);

      const dialog = screen.getByRole("dialog", { name: "Prepare release build" });
      expect(dialog).toHaveClass("fixed", "inset-y-0", "right-0");
      const close = screen.getByRole("button", {
        name: "关闭待办详情 Prepare release build",
      });
      expect(close).toHaveFocus();
      expect(document.body.style.overflow).toBe("hidden");

      const buttons = within(dialog)
        .getAllByRole("button")
        .filter((button) => !button.hasAttribute("disabled"));
      const first = buttons[0];
      const last = buttons.at(-1) as HTMLButtonElement;
      first.focus();
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
      last.focus();
      fireEvent.keyDown(window, { key: "Tab" });
      expect(first).toHaveFocus();

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(document.body.style.overflow).toBe("");

      fireEvent.click(trigger);
      expect(screen.getByRole("dialog", { name: "Prepare release build" })).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "关闭待办详情面板 Prepare release build" })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(document.body.style.overflow).toBe("");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });

  it("keeps the desktop Todo detail as a non-modal split pane", async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    try {
      render(<TodosView />);
      fireEvent.click(
        await screen.findByRole("button", { name: "查看待办 Prepare release build" })
      );

      const detail = document.getElementById("jarvis-todo-detail");
      expect(detail).not.toBeNull();
      expect(detail).not.toHaveAttribute("aria-modal");
      expect(screen.queryByRole("dialog", { name: "Prepare release build" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Prepare release build" })).toBeVisible();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });

  it("lets the user mark an evidence-backed extraction as not a Todo from its evidence", async () => {
    render(<TodosView />);
    fireEvent.click(await screen.findByRole("button", { name: "查看待办 Prepare release build" }));
    fireEvent.click(screen.getByRole("button", { name: /查看来源依据/u }));
    fireEvent.click(screen.getByRole("button", { name: "这不是待办" }));
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "wrong_context" },
    });
    fireEvent.change(screen.getByLabelText("本地备注（可选）"), {
      target: { value: "这是媒体或课程里的内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));

    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "todo_dismiss",
          todoId: "todo_open",
          reasonCode: "wrong_context",
          localNote: "这是媒体或课程里的内容",
        })
      )
    );
  });

  it("supports manual creation, editing, priority controls, and reasoned dismissal", async () => {
    render(<TodosView />);

    fireEvent.click(await screen.findByRole("button", { name: "新建待办" }));
    fireEvent.change(screen.getByLabelText("待办标题"), {
      target: { value: "手动整理周报" },
    });
    fireEvent.change(screen.getByLabelText("日期或时间（可选）"), {
      target: { value: "周五" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "manual_create",
          commandId: expect.stringMatching(/^command-[A-Za-z0-9_-]+$/),
          todoId: expect.stringMatching(/^todo-[A-Za-z0-9_-]+$/),
          title: "手动整理周报",
          dueText: "周五",
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "查看待办 Prepare release build" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit / 编辑 Prepare release build" }));
    fireEvent.change(screen.getByLabelText("待办标题"), {
      target: { value: "Prepare signed release build" },
    });
    fireEvent.change(screen.getByLabelText("日期或时间（可选）"), {
      target: { value: "Monday" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "title_due_edit",
          todoId: "todo_open",
          title: "Prepare signed release build",
          dueText: "Monday",
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin / 置顶 Prepare release build" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: "todo_pin", todoId: "todo_open" })
      )
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set urgent / 设为紧急 Prepare release build" })
    );
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "urgency_set",
          todoId: "todo_open",
          urgency: "urgent",
        })
      )
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Not a todo / 这不是待办 Prepare release build",
      })
    );
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "wrong_context" },
    });
    fireEvent.change(screen.getByLabelText("本地备注（可选）"), {
      target: { value: "这是视频里的任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "todo_dismiss",
          todoId: "todo_open",
          reasonCode: "wrong_context",
          localNote: "这是视频里的任务",
        })
      )
    );
  });

  it("keeps dismissed and accepted actions visible for restore or safe undo", async () => {
    const lifecycleOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        {
          ...overview.todos[0],
          id: "dismissed-todo",
          title: "被忽略的待办",
          status: "dismissed",
          dismissedAt: 5,
          verificationState: "dismissed",
          dismissReasonCode: "not_mine",
        },
      ],
      suggestions: [
        {
          ...overview.suggestions[0],
          id: "dismissed-suggestion",
          title: "被忽略的建议",
          state: "dismissed",
          dismissReasonCode: "low_value",
          decidedAt: 5,
        },
        {
          ...overview.suggestions[0],
          id: "accepted-suggestion",
          title: "已接受的建议",
          state: "accepted",
          convertedTodoId: "converted-todo",
          acceptanceUndone: false,
          decidedAt: 5,
        },
      ],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(lifecycleOverview);

    render(<TodosView />);
    fireEvent.click(await screen.findByRole("button", { name: "已忽略 1" }));
    fireEvent.click(screen.getByRole("button", { name: "查看待办 被忽略的待办" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore / 恢复 被忽略的待办" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: "todo_restore", todoId: "dismissed-todo" })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "建议与历史 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore suggestion / 恢复建议 被忽略的建议" })
    );
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suggestion_restore",
          suggestionId: "dismissed-suggestion",
        })
      )
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Undo accepted suggestion / 撤销接受 已接受的建议",
      })
    );
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suggestion_accept_undo",
          suggestionId: "accepted-suggestion",
        })
      )
    );
  });

  it("marks the durable action delta read when the Todo page is entered", async () => {
    window.electronAPI.jarvis.getActionCenterDelta = vi.fn().mockResolvedValue({
      throughSequence: 9,
      lastSeenSequence: 4,
      confirmedTodoCount: 1,
      pendingTodoCount: 1,
      suggestionCount: 1,
      total: 3,
      sessions: [
        {
          sessionId: "session_1",
          confirmedTodoCount: 1,
          pendingTodoCount: 1,
          suggestionCount: 1,
          total: 3,
        },
      ],
    });

    render(<TodosView />);

    expect(await screen.findByText("Prepare release build")).toBeVisible();
    await waitFor(() =>
      expect(window.electronAPI.jarvis.markActionCenterRead).toHaveBeenCalledWith(9)
    );
    expect(
      vi.mocked(window.electronAPI.jarvis.getActionCenterWatermark).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(window.electronAPI.jarvis.getActionCenterDelta).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(window.electronAPI.jarvis.getActionCenterDelta).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(window.electronAPI.jarvis.getKnowledgeOverview).mock.invocationCallOrder[0]
    );
  });

  it("sets, modifies, and cancels an explicit reminder from todo details", async () => {
    render(<TodosView />);
    await screen.findByText("Prepare release build");
    fireEvent.click(screen.getByRole("button", { name: /查看待办 Prepare release build/ }));

    fireEvent.click(screen.getByRole("button", { name: "设置提醒 Prepare release build" }));
    const input = await screen.findByLabelText("提醒时间 Prepare release build");
    fireEvent.change(input, { target: { value: "2030-08-06T10:45" } });
    fireEvent.click(screen.getByRole("button", { name: "保存提醒" }));

    const firstReminderAt = new Date("2030-08-06T10:45").getTime();
    await waitFor(() =>
      expect(window.electronAPI.jarvis.setTodoReminder).toHaveBeenCalledWith(
        "todo_open",
        firstReminderAt
      )
    );
    expect(await screen.findByText(/将于 .* 提醒/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "修改提醒 Prepare release build" }));
    const changedInput = await screen.findByLabelText("提醒时间 Prepare release build");
    fireEvent.change(changedInput, { target: { value: "2030-08-07T11:15" } });
    fireEvent.click(screen.getByRole("button", { name: "保存提醒" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.setTodoReminder).toHaveBeenCalledWith(
        "todo_open",
        new Date("2030-08-07T11:15").getTime()
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "修改提醒 Prepare release build" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消提醒" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.setTodoReminder).toHaveBeenLastCalledWith("todo_open", null)
    );
    expect(await screen.findByText("提醒已取消")).toBeVisible();
  });

  it("replaces a scheduled reminder snapshot when its todo is completed", async () => {
    const scheduledOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: overview.todos.map((todo) =>
        todo.id === "todo_open"
          ? {
              ...todo,
              reminder: {
                reminderAt: new Date("2030-08-06T10:45").getTime(),
                reminderSource: "user",
                state: "scheduled",
                deferredReason: null,
                deliveredAt: null,
              },
            }
          : todo
      ),
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(scheduledOverview);

    render(<TodosView />);
    await screen.findByText("Prepare release build");
    fireEvent.click(screen.getByRole("button", { name: /查看待办 Prepare release build/ }));
    expect(screen.getByText(/将于 .* 提醒/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Complete / 完成 Prepare release build" }));

    fireEvent.click(await screen.findByRole("button", { name: /已完成 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /查看待办 Prepare release build/ }));
    expect(await screen.findByText("提醒已取消")).toBeVisible();
  });

  it("refreshes scheduler-driven reminder state through the lightweight watermark", async () => {
    vi.useFakeTimers();
    const reminderAt = new Date("2030-08-06T10:45").getTime();
    const scheduledOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: overview.todos.map((todo) =>
        todo.id === "todo_open"
          ? {
              ...todo,
              reminder: {
                reminderAt,
                reminderSource: "user",
                state: "scheduled",
                deferredReason: null,
                deliveredAt: null,
              },
            }
          : todo
      ),
    };
    const deliveredOverview: JarvisKnowledgeOverview = {
      ...scheduledOverview,
      todos: scheduledOverview.todos.map((todo) =>
        todo.id === "todo_open" && todo.reminder
          ? {
              ...todo,
              reminder: {
                ...todo.reminder,
                state: "delivered",
                deliveredAt: reminderAt,
              },
            }
          : todo
      ),
    };
    window.electronAPI.jarvis.getActionCenterWatermark = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "1".repeat(64),
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: 3,
      })
      .mockResolvedValue({
        revision: "2".repeat(64),
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: reminderAt,
      });
    window.electronAPI.jarvis.getKnowledgeOverview = vi
      .fn()
      .mockResolvedValueOnce(scheduledOverview)
      .mockResolvedValue(deliveredOverview);

    render(<TodosView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /查看待办 Prepare release build/ }));
    expect(screen.getByText(/将于 .* 提醒/)).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/已提醒/)).toBeVisible();
    expect(window.electronAPI.jarvis.getKnowledgeOverview).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electronAPI.jarvis.getKnowledgeOverview).toHaveBeenCalledTimes(2);
  });

  it("keeps todo evidence out of the overview until the user opens the item", async () => {
    render(<TodosView />);
    await screen.findByText("Prepare release build");
    expect(screen.queryByText("I will prepare the release build.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看待办 Prepare release build/ }));
    fireEvent.click(screen.getByText(/查看来源依据/));
    const loadedEvidence = await screen.findAllByText("I will prepare the release build.");
    expect(loadedEvidence.length).toBeGreaterThan(0);
    expect(loadedEvidence[0]).toBeVisible();
  });

  it("searches todo content and candidate rationale, then accepts or dismisses suggestions", async () => {
    const candidateOverview: JarvisKnowledgeOverview = {
      ...overview,
      suggestions: [
        {
          ...overview.suggestions[0],
          occurrences: [
            {
              id: "suggestion_occurrence_1",
              sessionId: "session_1",
              createdAt: 2,
              evidence: [
                {
                  sessionId: "session_1",
                  segmentId: "suggestion_segment_1",
                  startedAt: 50,
                  endedAt: 60,
                  quote: "Review the regression list tomorrow.",
                  audioState: "available",
                },
              ],
            },
          ],
        },
        {
          id: "suggestion_2",
          title: "Protect quiet hours",
          rationale: "Reduce low-value interruptions after work.",
          state: "proposed",
          decidedAt: null,
          createdAt: 2,
          updatedAt: 2,
          cardContext: unknownCardContext,
          occurrences: [],
        },
      ],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(candidateOverview);

    render(<TodosView />);

    expect(await screen.findByText("Review tomorrow")).toBeVisible();
    const search = screen.getByRole("searchbox", { name: "搜索待办和候选建议" });

    fireEvent.change(search, { target: { value: "I will prepare" } });
    expect(screen.getByText("Prepare release build")).toBeVisible();
    expect(screen.queryByText("Review tomorrow")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "regressions" } });
    expect(screen.getByText("Review tomorrow")).toBeVisible();
    expect(screen.getByText("Catch regressions early.")).toBeVisible();
    fireEvent.click(screen.getByText(/查看来源依据/));
    const suggestionEvidence = await screen.findAllByText("Review the regression list tomorrow.");
    expect(suggestionEvidence[0]).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Accept suggestion / 接受建议 Review tomorrow" })
    );
    expect(screen.getByRole("dialog", { name: "接受候选建议" })).toBeVisible();
    expect(screen.getByLabelText("待办标题")).toHaveValue("Review tomorrow");
    fireEvent.change(screen.getByLabelText("日期或时间（可选）"), {
      target: { value: "明天" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: expect.stringMatching(/^command-[A-Za-z0-9_-]+$/),
          type: "suggestion_accept",
          suggestionId: "suggestion_1",
          todoId: expect.stringMatching(/^todo-[A-Za-z0-9_-]+$/),
          title: "Review tomorrow",
          dueText: "明天",
        })
      )
    );

    fireEvent.change(search, { target: { value: "quiet hours" } });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Dismiss suggestion / 忽略建议 Protect quiet hours",
      })
    );
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "low_value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suggestion_dismiss",
          suggestionId: "suggestion_2",
          reasonCode: "low_value",
        })
      )
    );
  });

  it("keeps unverified analysis out of formal todos and explains the pending state", async () => {
    render(<TodosView />);
    expect(await screen.findByText("现在要做 1")).toBeVisible();
    expect(screen.queryByText("Review game commentary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "待你确认 1" }));
    expect(screen.getByText("Review game commentary")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Complete / 完成 Review game commentary" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看待办 Review game commentary/ }));
    expect(screen.getByText(/归属证据还不足/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm / 确认 Review game commentary",
      })
    );
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeTodo).toHaveBeenCalledWith(
        "todo_pending",
        "confirm"
      )
    );
  });

  it("keeps suggestions and conflicts explicit user decisions", async () => {
    render(<KnowledgeMemoryPanel />);
    expect((await screen.findAllByText("Use local-first storage.")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /查看长期记忆 Deployment choice/ }));
    fireEvent.click(screen.getByText(/查看来源证据/));
    expect(screen.getByText("Keep it local.")).toBeVisible();

    fireEvent.click(screen.getByText(/候选建议/));
    fireEvent.click(screen.getByRole("button", { name: /accept|接受/i }));
    expect(screen.getByRole("dialog", { name: "接受候选建议" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: expect.stringMatching(/^command-[A-Za-z0-9_-]+$/),
          type: "suggestion_accept",
          suggestionId: "suggestion_1",
          todoId: expect.stringMatching(/^todo-[A-Za-z0-9_-]+$/),
          title: "Review tomorrow",
          dueText: null,
        })
      )
    );
    expect(window.electronAPI.jarvis.decideKnowledgeSuggestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/待确认冲突/));
    fireEvent.click(screen.getByRole("button", { name: /choose|选择/i }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.resolveKnowledgeConflict).toHaveBeenCalledWith(
        "conflict_1",
        "memory_1"
      )
    );
  });

  it("routes Memory suggestion dismissal through the reversible action lifecycle", async () => {
    render(<KnowledgeMemoryPanel />);
    fireEvent.click(await screen.findByText(/候选建议/));
    fireEvent.click(screen.getByRole("button", { name: /dismiss|忽略/i }));
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "low_value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));

    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: expect.stringMatching(/^command-[A-Za-z0-9_-]+$/),
          type: "suggestion_dismiss",
          suggestionId: "suggestion_1",
          reasonCode: "low_value",
        })
      )
    );
    expect(window.electronAPI.jarvis.decideKnowledgeSuggestion).not.toHaveBeenCalled();
  });
});
