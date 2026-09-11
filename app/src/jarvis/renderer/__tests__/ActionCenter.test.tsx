import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisKnowledgeActionResult,
  JarvisKnowledgeOverview,
  JarvisKnowledgeTodoCompletionResult,
  JarvisKnowledgeTodoDecisionResult,
} from "../../types";
import ActionCenter from "../ActionCenter";

const now = Date.now();
const unknownCardContext = {
  sessionId: null,
  startedAt: null,
  applicationName: null,
  activityCategory: null,
  activityConfidence: null,
  sourceAttribution: "mixed_unknown" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const baseTodo = {
  ownerLabel: "我",
  completedAt: null,
  dismissedAt: null,
  createdAt: now,
  updatedAt: now,
  trustSnapshot: null,
  cardContext: unknownCardContext,
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
      reminder: {
        reminderAt: now + 3_600_000,
        reminderSource: "user",
        state: "scheduled",
        deferredReason: null,
        deliveredAt: null,
      },
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
      cardContext: unknownCardContext,
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
        getActionCenterWatermark: vi.fn().mockResolvedValue({
          revision: "r1",
          todoCount: overview.todos.length,
          suggestionCount: overview.suggestions.length,
          updatedAt: now,
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
          markedAt: now,
        }),
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
        applyKnowledgeAction: vi.fn().mockResolvedValue({
          status: "applied",
          commandId: "command-result",
          type: "suggestion_accept",
          entityKind: "suggestion",
          entityId: "suggestion",
          occurredAt: now,
          todoId: "todo-result",
        }),
        getTodoReminder: vi.fn().mockResolvedValue({
          todoId: "today",
          reminderAt: now + 3_600_000,
          reminderSource: "user",
          state: "scheduled",
          deferredReason: null,
          deliveredAt: null,
          updatedAt: now,
        }),
        setTodoReminder: vi.fn(async (todoId: string, reminderAt: number | null) =>
          reminderAt === null
            ? null
            : {
                todoId,
                reminderAt,
                reminderSource: "user" as const,
                state: "scheduled" as const,
                deferredReason: null,
                deliveredAt: null,
                updatedAt: now,
              }
        ),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps loading distinct from an empty overview and always renders five explicit zones", async () => {
    const pendingOverview = deferred<JarvisKnowledgeOverview>();
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn(() => pendingOverview.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);

    expect(await screen.findByText("正在读取今日行动…")).toBeVisible();
    expect(screen.queryByText("今天没有到期或逾期的正式待办。")).not.toBeInTheDocument();

    await act(async () => {
      pendingOverview.resolve({ ...overview, todos: [], suggestions: [] });
      await pendingOverview.promise;
    });

    expect(screen.getByRole("heading", { name: "现在要做 (0)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "待你确认 (0)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "候选建议 (0)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "稍后 (0)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "今日已完成 (0)" })).toBeVisible();
    expect(screen.getByText("当前没有需要你确认的事项。")).toBeVisible();
    expect(screen.getByText("当前没有候选建议；AI 建议不会自动成为待办。")).toBeVisible();
    expect(screen.getByText("当前没有未来日期或未设置日期的正式待办。")).toBeVisible();
    expect(screen.getByText("今天还没有已完成事项。")).toBeVisible();
  });

  it("shows a truthful first-load failure and retries locally without a false empty state", async () => {
    window.electronAPI.jarvis.getKnowledgeOverview = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...overview, todos: [], suggestions: [] });

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);

    expect(
      await screen.findByText("行动数据暂时无法读取；已有录音和数据不会受影响。")
    ).toBeVisible();
    expect(screen.queryByText("今天没有到期或逾期的正式待办。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("heading", { name: "现在要做 (0)" })).toBeVisible();
    expect(window.electronAPI.jarvis.getKnowledgeOverview).toHaveBeenCalledTimes(2);
  });

  it("partitions actions and exposes only explicit lifecycle operations", async () => {
    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);

    expect(await screen.findByText("今天提交版本")).toBeVisible();
    expect(screen.getByText("待你确认 (1)")).toBeVisible();
    expect(screen.getByText("复盘发布")).toBeVisible();
    expect(screen.queryByText("没有日期的事项")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "修改提醒 今天提交版本",
      })
    );
    const reminderInput = await screen.findByLabelText("提醒时间 今天提交版本");
    fireEvent.change(reminderInput, { target: { value: "2030-08-05T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存提醒" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.setTodoReminder).toHaveBeenCalledWith(
        "today",
        new Date("2030-08-05T09:30").getTime()
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /稍后/ }));
    expect(screen.getByText("没有日期的事项")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /今日已完成/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reopen|撤销完成/ }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.decideKnowledgeTodo).toHaveBeenCalledWith("done", "reopen")
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

    fireEvent.click(
      screen.getByRole("button", {
        name: "Not a todo / 这不是待办 确认别人交给我的事项",
      })
    );
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "not_mine" },
    });
    fireEvent.change(screen.getByLabelText("本地备注（可选）"), {
      target: { value: "分配给了其他人" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "todo_dismiss",
          todoId: "pending",
          reasonCode: "not_mine",
          localNote: "分配给了其他人",
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Accept suggestion|接受建议/ }));
    expect(screen.getByRole("dialog", { name: "接受候选建议" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() =>
      expect(window.electronAPI.jarvis.applyKnowledgeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suggestion_accept",
          suggestionId: "suggestion",
          todoId: expect.stringMatching(/^todo-[A-Za-z0-9_-]+$/),
          title: "复盘发布",
          dueText: null,
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "查看全部待办与历史" }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("shows only persisted application, activity, and session-time evidence on compact cards", async () => {
    const evidenceAt = new Date(2026, 6, 20, 14, 35).getTime();
    const evidence = {
      sessionId: "source-session",
      segmentId: "source-segment",
      startedAt: evidenceAt,
      endedAt: evidenceAt + 8_000,
      quote: "我来整理发布说明。",
      audioState: "available" as const,
      handle: {
        ownerType: "todo_instance" as const,
        ownerId: "today-occurrence",
        evidenceId: "today-evidence",
      },
    };
    const sourceOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: overview.todos.map((todo) =>
        todo.id === "today"
          ? {
              ...todo,
              trustSnapshot: {
                policyId: "todo-attribution-v1",
                state: "captured",
                applicationEvidence: [
                  {
                    segmentId: evidence.segmentId,
                    applicationKey: "kook",
                    sourceAttribution: "application_and_microphone",
                    speakerRelation: "SELF",
                  },
                ],
                activityEvidence: [
                  {
                    segmentId: evidence.segmentId,
                    category: "social_call",
                    confidence: 0.94,
                    decision: "adopted",
                  },
                ],
                semanticConfidence: 0.96,
                voiceprintConfidence: 0.95,
                sceneConfidence: 0.94,
                transcriptContextConfidence: 0.93,
                speakerEvidenceVerified: true,
                overlapDetected: false,
                automaticEligible: true,
              },
              cardContext: {
                sessionId: evidence.sessionId,
                startedAt: evidenceAt,
                applicationName: "KOOK",
                activityCategory: "social_call",
                activityConfidence: 0.94,
                sourceAttribution: "application_and_microphone",
              },
              occurrences: [
                {
                  id: "today-occurrence",
                  sessionId: evidence.sessionId,
                  revisionId: "today-r1",
                  startedAt: evidence.startedAt,
                  endedAt: evidence.endedAt,
                  createdAt: evidenceAt,
                  evidence: [evidence],
                },
              ],
            }
          : todo
      ),
      suggestions: [
        {
          ...overview.suggestions[0],
          cardContext: {
            sessionId: evidence.sessionId,
            startedAt: evidenceAt,
            applicationName: "Chrome",
            activityCategory: "learning",
            activityConfidence: 0.91,
            sourceAttribution: "application",
          },
          occurrences: [
            {
              id: "suggestion-occurrence",
              sessionId: evidence.sessionId,
              createdAt: evidenceAt,
              evidence: [
                {
                  ...evidence,
                  handle: {
                    ownerType: "suggestion",
                    ownerId: "suggestion-occurrence",
                    evidenceId: "suggestion-evidence",
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(sourceOverview);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);

    const expectedTime = new Date(evidenceAt).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const todoSummary = await screen.findByLabelText("来源摘要 今天提交版本");
    expect(todoSummary).toHaveTextContent("KOOK + 麦克风");
    expect(todoSummary).toHaveTextContent("场景 社交通话");
    expect(todoSummary).toHaveTextContent(`会话 ${expectedTime}`);

    const suggestionSummary = screen.getByLabelText("来源摘要 复盘发布");
    expect(suggestionSummary).toHaveTextContent("Chrome");
    expect(suggestionSummary).toHaveTextContent("场景 学习");
    expect(suggestionSummary).toHaveTextContent(`会话 ${expectedTime}`);
    const unknownSummary = screen.getByLabelText("来源摘要 确认别人交给我的事项");
    expect(unknownSummary).toHaveTextContent("应用未知");
    expect(unknownSummary).toHaveTextContent("场景未确定");
    expect(unknownSummary).toHaveTextContent("会话时间未知");
    expect("getEvidenceContext" in window.electronAPI.jarvis).toBe(false);

    const todoArticle = screen.getByText("今天提交版本").closest("article");
    expect(todoArticle).not.toBeNull();
    fireEvent.click(
      within(todoArticle as HTMLElement).getByRole("button", { name: /查看来源依据/ })
    );
    const expandedCorrection = within(todoArticle as HTMLElement).getByRole("button", {
      name: "这不是待办",
    });
    expect(expandedCorrection).toBeVisible();
    fireEvent.click(expandedCorrection);
    expect(screen.getByRole("dialog", { name: "选择忽略原因" })).toBeVisible();
  });

  it("optimistically confirms a pending todo and rolls back only that card on failure", async () => {
    const decision = deferred<JarvisKnowledgeTodoDecisionResult>();
    window.electronAPI.jarvis.decideKnowledgeTodo = vi.fn(() => decision.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirm / 确认 确认别人交给我的事项",
      })
    );

    expect(screen.getByRole("heading", { name: "待你确认 (0)" })).toBeVisible();
    expect(screen.getByText("今天提交版本")).toBeVisible();

    await act(async () => {
      decision.reject(new Error("write failed"));
      await decision.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("heading", { name: "待你确认 (1)" })).toBeVisible();
    expect(screen.getByText("确认别人交给我的事项")).toBeVisible();
    expect(screen.getByText("操作未保存，已恢复原状态。")).toBeVisible();
  });

  it("optimistically completes and retries a failed todo lifecycle operation", async () => {
    const firstAttempt = deferred<JarvisKnowledgeTodoCompletionResult>();
    const retryAttempt = deferred<JarvisKnowledgeTodoCompletionResult>();
    window.electronAPI.jarvis.completeKnowledgeTodo = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete / 完成 今天提交版本" }));
    expect(screen.getByRole("heading", { name: "现在要做 (0)" })).toBeVisible();

    await act(async () => {
      firstAttempt.reject(new Error("disk busy"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("heading", { name: "现在要做 (1)" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry action / 重试 今天提交版本" }));
    expect(screen.getByRole("heading", { name: "现在要做 (0)" })).toBeVisible();
    expect(window.electronAPI.jarvis.completeKnowledgeTodo).toHaveBeenCalledTimes(2);

    await act(async () => {
      retryAttempt.resolve({ status: "completed", todoId: "today", completedAt: now });
      await retryAttempt.promise;
    });
  });

  it("optimistically reopens a completed todo before the IPC resolves", async () => {
    const decision = deferred<JarvisKnowledgeTodoDecisionResult>();
    window.electronAPI.jarvis.decideKnowledgeTodo = vi.fn(() => decision.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    fireEvent.click(await screen.findByRole("button", { name: /今日已完成/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen / 撤销完成 已经完成" }));

    expect(screen.getByRole("button", { name: "今日已完成 (0)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "稍后 (2)" })).toBeVisible();

    await act(async () => {
      decision.resolve({ status: "reopened", todoId: "done", decidedAt: now });
      await decision.promise;
    });
  });

  it("keeps the visible not-a-todo correction optimistic and reuses its command on retry", async () => {
    const firstAttempt = deferred<JarvisKnowledgeActionResult>();
    const retryAttempt = deferred<JarvisKnowledgeActionResult>();
    window.electronAPI.jarvis.applyKnowledgeAction = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    expect(
      await screen.findByRole("button", {
        name: "Not a todo / 这不是待办 今天提交版本",
      })
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Not a todo / 这不是待办 今天提交版本" }));
    fireEvent.change(screen.getByLabelText("忽略原因"), {
      target: { value: "wrong_context" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));

    expect(screen.getByRole("heading", { name: "现在要做 (0)" })).toBeVisible();
    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByText("今天提交版本")).toBeVisible();
    const firstInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[0][0];

    fireEvent.click(screen.getByRole("button", { name: "Retry action / 重试 今天提交版本" }));
    expect(screen.getByRole("heading", { name: "现在要做 (0)" })).toBeVisible();
    const retryInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[1][0];
    expect(retryInput).toMatchObject({
      type: "todo_dismiss",
      todoId: "today",
      commandId: firstInput.commandId,
      reasonCode: "wrong_context",
    });

    await act(async () => {
      retryAttempt.resolve({
        status: "applied",
        commandId: firstInput.commandId,
        type: "todo_dismiss",
        entityKind: "todo",
        entityId: "today",
        occurredAt: now,
        todoId: "today",
      });
      await retryAttempt.promise;
    });
  });

  it("optimistically accepts a suggestion and reuses both command and todo ids after rollback", async () => {
    const firstAttempt = deferred<JarvisKnowledgeActionResult>();
    const retryAttempt = deferred<JarvisKnowledgeActionResult>();
    window.electronAPI.jarvis.applyKnowledgeAction = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Accept suggestion / 接受建议 复盘发布",
      })
    );
    fireEvent.change(screen.getByLabelText("日期或时间（可选）"), {
      target: { value: "今天" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));

    expect(screen.getByRole("heading", { name: "候选建议 (0)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "现在要做 (2)" })).toBeVisible();

    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByText("复盘发布")).toBeVisible();
    const firstInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[0][0];

    fireEvent.click(screen.getByRole("button", { name: "Retry action / 重试 复盘发布" }));
    expect(screen.getByRole("heading", { name: "候选建议 (0)" })).toBeVisible();
    const retryInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[1][0];
    expect(retryInput).toMatchObject({
      type: "suggestion_accept",
      suggestionId: "suggestion",
      commandId: firstInput.commandId,
      todoId: "todoId" in firstInput ? firstInput.todoId : undefined,
      title: "复盘发布",
      dueText: "今天",
    });

    await act(async () => {
      retryAttempt.resolve({
        status: "applied",
        commandId: firstInput.commandId,
        type: "suggestion_accept",
        entityKind: "suggestion",
        entityId: "suggestion",
        occurredAt: now,
        todoId: "todoId" in firstInput ? firstInput.todoId : null,
      });
      await retryAttempt.promise;
    });
  });

  it("optimistically dismisses a suggestion and restores it with a local retry on failure", async () => {
    const firstAttempt = deferred<JarvisKnowledgeActionResult>();
    const retryAttempt = deferred<JarvisKnowledgeActionResult>();
    window.electronAPI.jarvis.applyKnowledgeAction = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => retryAttempt.promise);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Dismiss suggestion / 忽略建议 复盘发布",
      })
    );
    fireEvent.change(screen.getByLabelText("忽略原因"), { target: { value: "low_value" } });
    fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));

    expect(screen.getByRole("heading", { name: "候选建议 (0)" })).toBeVisible();
    await act(async () => {
      firstAttempt.reject(new Error("write failed"));
      await firstAttempt.promise.catch(() => undefined);
    });
    expect(await screen.findByText("复盘发布")).toBeVisible();
    const firstInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[0][0];

    fireEvent.click(screen.getByRole("button", { name: "Retry action / 重试 复盘发布" }));
    const retryInput = vi.mocked(window.electronAPI.jarvis.applyKnowledgeAction).mock.calls[1][0];
    expect(retryInput).toMatchObject({
      type: "suggestion_dismiss",
      suggestionId: "suggestion",
      commandId: firstInput.commandId,
      reasonCode: "low_value",
    });

    await act(async () => {
      retryAttempt.resolve({
        status: "applied",
        commandId: firstInput.commandId,
        type: "suggestion_dismiss",
        entityKind: "suggestion",
        entityId: "suggestion",
        occurredAt: now,
        todoId: null,
      });
      await retryAttempt.promise;
    });
  });

  it("sorts the now section by pin, urgency, due date, and stable id", async () => {
    const prioritizedOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        {
          ...overview.todos[0],
          id: "normal-today",
          title: "普通今日事项",
          pinned: false,
          urgency: "normal",
        },
        {
          ...overview.todos[0],
          id: "urgent-today",
          title: "紧急今日事项",
          pinned: false,
          urgency: "urgent",
        },
        {
          ...overview.todos[2],
          id: "pinned-no-date",
          title: "置顶无日期事项",
          pinned: true,
          urgency: "normal",
        },
      ],
      suggestions: [],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(prioritizedOverview);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);

    const nowHeading = await screen.findByRole("heading", { name: "现在要做 (3)" });
    const nowSection = nowHeading.closest("section");
    expect(nowSection).not.toBeNull();
    const rows = within(nowSection as HTMLElement).getAllByRole("article");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("置顶无日期事项"),
      expect.stringContaining("紧急今日事项"),
      expect.stringContaining("普通今日事项"),
    ]);
  });

  it("directs overflow suggestions to the searchable full Todo page", async () => {
    const overflowOverview: JarvisKnowledgeOverview = {
      ...overview,
      suggestions: Array.from({ length: 5 }, (_, index) => ({
        ...overview.suggestions[0],
        id: `suggestion-${index + 1}`,
        title: `候选建议 ${index + 1}`,
      })),
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(overflowOverview);

    render(<ActionCenter sessionId={null} sessionStatus="idle" onViewAll={onViewAll} />);

    expect(await screen.findByText("候选建议 1")).toBeVisible();
    expect(screen.getByText("候选建议 3")).toBeVisible();
    expect(screen.queryByText("候选建议 4")).not.toBeInTheDocument();
    expect(screen.getByText("其余 2 条可在完整 Todo 页面搜索、接受或忽略")).toBeVisible();
  });

  it("polls a lightweight durable watermark and reloads the overview only after it changes", async () => {
    vi.useFakeTimers();
    const updatedOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        ...overview.todos,
        {
          ...baseTodo,
          id: "background-pending",
          title: "后台新增的待确认事项",
          status: "open",
          verificationState: "pending_confirmation",
          verificationReason: "assigned_and_accepted",
          verificationActor: "system",
          provenance: "evidence_linked",
          sourceSuggestionId: null,
          revisions: [],
        },
      ],
    };
    const getWatermark = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "r1",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        revision: "r1",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        revision: "r2",
        todoCount: updatedOverview.todos.length,
        suggestionCount: updatedOverview.suggestions.length,
        updatedAt: now + 1,
      })
      .mockResolvedValue({
        revision: "r2",
        todoCount: updatedOverview.todos.length,
        suggestionCount: updatedOverview.suggestions.length,
        updatedAt: now + 1,
      });
    const getOverview = vi.fn().mockResolvedValueOnce(overview).mockResolvedValue(updatedOverview);
    window.electronAPI.jarvis.getActionCenterWatermark = getWatermark;
    window.electronAPI.jarvis.getKnowledgeOverview = getOverview;

    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("后台新增的待确认事项")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWatermark).toHaveBeenCalledTimes(2);
    expect(getOverview).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByText("后台新增的待确认事项")).toBeVisible();
  });

  it("refreshes a reminder changed by the scheduler or another window", async () => {
    vi.useFakeTimers();
    const deliveredOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: overview.todos.map((todo) =>
        todo.id === "today"
          ? {
              ...todo,
              reminder: {
                reminderAt: now + 3_600_000,
                reminderSource: "user",
                state: "delivered",
                deferredReason: null,
                deliveredAt: now + 1_000,
              },
            }
          : todo
      ),
    };
    const getWatermark = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "r1",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        revision: "r2",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now + 1_000,
      })
      .mockResolvedValue({
        revision: "r2",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now + 1_000,
      });
    const getOverview = vi
      .fn()
      .mockResolvedValueOnce(overview)
      .mockResolvedValue(deliveredOverview);
    window.electronAPI.jarvis.getActionCenterWatermark = getWatermark;
    window.electronAPI.jarvis.getKnowledgeOverview = getOverview;

    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "修改提醒 今天提交版本" })).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "设置提醒 今天提交版本" })).toHaveTextContent(
      "已提醒"
    );
  });

  it("keeps polling while recording so late actions from an older session still appear", async () => {
    vi.useFakeTimers();
    const lateOverview: JarvisKnowledgeOverview = {
      ...overview,
      suggestions: [
        ...overview.suggestions,
        {
          id: "late-old-session-suggestion",
          title: "旧会话后台补齐的建议",
          rationale: "来自上一段已经结束、刚完成分析的录音。",
          state: "proposed",
          decidedAt: null,
          createdAt: now + 1,
          updatedAt: now + 1,
          cardContext: unknownCardContext,
          occurrences: [
            {
              id: "late-old-session-suggestion-occurrence",
              sessionId: "old-session",
              createdAt: now + 1,
              evidence: [],
            },
          ],
        },
      ],
    };
    const getWatermark = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "r1",
        todoCount: overview.todos.length,
        suggestionCount: overview.suggestions.length,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        revision: "r2",
        todoCount: lateOverview.todos.length,
        suggestionCount: lateOverview.suggestions.length,
        updatedAt: now + 1,
      })
      .mockResolvedValue({
        revision: "r2",
        todoCount: lateOverview.todos.length,
        suggestionCount: lateOverview.suggestions.length,
        updatedAt: now + 1,
      });
    const getOverview = vi.fn().mockResolvedValueOnce(overview).mockResolvedValue(lateOverview);
    window.electronAPI.jarvis.getActionCenterWatermark = getWatermark;
    window.electronAPI.jarvis.getKnowledgeOverview = getOverview;

    render(
      <ActionCenter sessionId="new-session" sessionStatus="recording" onViewAll={onViewAll} />
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("旧会话后台补齐的建议")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByText("旧会话后台补齐的建议")).toBeVisible();
    expect(screen.queryByText(/本次新增/)).not.toBeInTheDocument();
  });

  it("summarizes only durable actions first created by the completed session", async () => {
    const createdAt = now + 10_000;
    const sessionOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        {
          ...baseTodo,
          id: "session-confirmed-1",
          title: "整理会议纪要",
          status: "open",
          verificationState: "confirmed",
          verificationReason: "strict_self_commitment",
          verificationActor: "system",
          provenance: "evidence_linked",
          sourceSuggestionId: null,
          createdAt,
          updatedAt: createdAt,
          revisions: [],
          occurrences: [
            {
              id: "session-confirmed-1-occurrence",
              sessionId: "session-1",
              revisionId: "session-confirmed-1-revision",
              startedAt: null,
              endedAt: null,
              createdAt,
              evidence: [],
            },
          ],
        },
        {
          ...baseTodo,
          id: "session-confirmed-2",
          title: "发送发布说明",
          status: "open",
          verificationState: "confirmed",
          verificationReason: "strict_self_commitment",
          verificationActor: "system",
          provenance: "evidence_linked",
          sourceSuggestionId: null,
          createdAt: createdAt + 1,
          updatedAt: createdAt + 1,
          revisions: [],
          occurrences: [
            {
              id: "session-confirmed-2-occurrence",
              sessionId: "session-1",
              revisionId: "session-confirmed-2-revision",
              startedAt: null,
              endedAt: null,
              createdAt: createdAt + 1,
              evidence: [],
            },
          ],
        },
        {
          ...baseTodo,
          id: "session-pending",
          title: "确认下周演示时间",
          status: "open",
          verificationState: "pending_confirmation",
          verificationReason: "assigned_and_accepted",
          verificationActor: "system",
          provenance: "evidence_linked",
          sourceSuggestionId: null,
          createdAt: createdAt + 2,
          updatedAt: createdAt + 2,
          revisions: [],
          occurrences: [
            {
              id: "session-pending-occurrence",
              sessionId: "session-1",
              revisionId: "session-pending-revision",
              startedAt: null,
              endedAt: null,
              createdAt: createdAt + 2,
              evidence: [],
            },
          ],
        },
      ],
      suggestions: [
        {
          id: "session-suggestion",
          title: "整理演示模板",
          rationale: "会议中反复提到模板不统一。",
          state: "proposed",
          decidedAt: null,
          createdAt: createdAt + 3,
          updatedAt: createdAt + 3,
          cardContext: unknownCardContext,
          occurrences: [
            {
              id: "session-suggestion-occurrence",
              sessionId: "session-1",
              createdAt: createdAt + 3,
              evidence: [],
            },
          ],
        },
      ],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(sessionOverview);

    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);

    expect(
      await screen.findByRole("status", {
        name: "本次新增 2 个正式待办、1 个待确认、1 条候选建议",
      })
    ).toBeVisible();
    expect(screen.getByText("本次新增 4")).toBeVisible();
  });

  it("shows and acknowledges the durable delta that arrived since the previous visit", async () => {
    window.electronAPI.jarvis.getActionCenterDelta = vi.fn().mockResolvedValue({
      throughSequence: 12,
      lastSeenSequence: 8,
      confirmedTodoCount: 1,
      pendingTodoCount: 1,
      suggestionCount: 1,
      total: 3,
      sessions: [
        {
          sessionId: "old-session",
          confirmedTodoCount: 1,
          pendingTodoCount: 1,
          suggestionCount: 1,
          total: 3,
        },
      ],
    });

    render(<ActionCenter sessionId="session-1" sessionStatus="recording" onViewAll={onViewAll} />);

    expect(
      await screen.findByRole("status", {
        name: "上次查看后新增 1 个正式待办、1 个待确认、1 条候选建议",
      })
    ).toBeVisible();
    expect(screen.getByText("新内容 3")).toBeVisible();
    await waitFor(() =>
      expect(window.electronAPI.jarvis.markActionCenterRead).toHaveBeenCalledWith(12)
    );
    expect(
      vi.mocked(window.electronAPI.jarvis.getActionCenterDelta).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(window.electronAPI.jarvis.getKnowledgeOverview).mock.invocationCallOrder[0]
    );
  });

  it("shows one consolidated in-app summary when finish and unread deltas arrive together", async () => {
    const completedOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        {
          ...overview.todos[0],
          occurrences: [
            {
              id: "finish-occurrence",
              sessionId: "session-1",
              revisionId: "today-r1",
              startedAt: null,
              endedAt: null,
              createdAt: now,
              evidence: [],
            },
          ],
        },
      ],
      suggestions: [],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(completedOverview);
    window.electronAPI.jarvis.getActionCenterDelta = vi.fn().mockResolvedValue({
      throughSequence: 12,
      lastSeenSequence: 8,
      confirmedTodoCount: 1,
      pendingTodoCount: 1,
      suggestionCount: 0,
      total: 2,
      sessions: [],
    });

    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);

    expect(await screen.findByRole("status", { name: "本次新增 1 个正式待办" })).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "上次查看后新增 1 个正式待办、1 个待确认" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("clears an acknowledged arrival delta when the next session load reports no new actions", async () => {
    window.electronAPI.jarvis.getActionCenterDelta = vi
      .fn()
      .mockResolvedValueOnce({
        throughSequence: 12,
        lastSeenSequence: 8,
        confirmedTodoCount: 1,
        pendingTodoCount: 0,
        suggestionCount: 0,
        total: 1,
        sessions: [],
      })
      .mockResolvedValue({
        throughSequence: 12,
        lastSeenSequence: 12,
        confirmedTodoCount: 0,
        pendingTodoCount: 0,
        suggestionCount: 0,
        total: 0,
        sessions: [],
      });

    const { rerender } = render(
      <ActionCenter sessionId="session-one" sessionStatus="completed" onViewAll={onViewAll} />
    );
    expect(
      await screen.findByRole("status", { name: "上次查看后新增 1 个正式待办" })
    ).toBeVisible();

    rerender(
      <ActionCenter sessionId="session-two" sessionStatus="completed" onViewAll={onViewAll} />
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "上次查看后新增 1 个正式待办" })
      ).not.toBeInTheDocument()
    );
    expect(screen.queryByText("新内容 1")).not.toBeInTheDocument();
  });

  it("does not count a current-session occurrence of a todo created earlier", async () => {
    const oldCreatedAt = now - 100_000;
    const repeatedOverview: JarvisKnowledgeOverview = {
      ...overview,
      todos: [
        {
          ...baseTodo,
          id: "existing-todo",
          title: "已经存在的待办再次被提到",
          status: "open",
          verificationState: "confirmed",
          verificationReason: "strict_self_commitment",
          verificationActor: "system",
          provenance: "evidence_linked",
          sourceSuggestionId: null,
          createdAt: oldCreatedAt,
          updatedAt: now,
          revisions: [],
          occurrences: [
            {
              id: "existing-todo-old-occurrence",
              sessionId: "old-session",
              revisionId: "existing-todo-old-revision",
              startedAt: null,
              endedAt: null,
              createdAt: oldCreatedAt,
              evidence: [],
            },
            {
              id: "existing-todo-current-occurrence",
              sessionId: "session-1",
              revisionId: "existing-todo-current-revision",
              startedAt: null,
              endedAt: null,
              createdAt: now,
              evidence: [],
            },
          ],
        },
      ],
      suggestions: [],
    };
    window.electronAPI.jarvis.getKnowledgeOverview = vi.fn().mockResolvedValue(repeatedOverview);

    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);

    fireEvent.click(await screen.findByRole("button", { name: /稍后/ }));
    expect(await screen.findByText("已经存在的待办再次被提到")).toBeVisible();
    expect(screen.queryByText(/本次新增/)).not.toBeInTheDocument();
  });

  it("keeps one entity in the session summary when its verification state changes", async () => {
    const createdAt = now + 20_000;
    const pendingTodo: JarvisKnowledgeOverview["todos"][number] = {
      ...baseTodo,
      id: "changing-todo",
      title: "状态会变化的待办",
      status: "open",
      verificationState: "pending_confirmation",
      verificationReason: "assigned_and_accepted",
      verificationActor: "system",
      provenance: "evidence_linked",
      sourceSuggestionId: null,
      createdAt,
      updatedAt: createdAt,
      revisions: [],
      occurrences: [
        {
          id: "changing-todo-occurrence",
          sessionId: "session-1",
          revisionId: "changing-todo-revision",
          startedAt: null,
          endedAt: null,
          createdAt,
          evidence: [],
        },
      ],
    };
    const getOverview = vi
      .fn()
      .mockResolvedValueOnce({ ...overview, todos: [pendingTodo], suggestions: [] })
      .mockResolvedValue({
        ...overview,
        todos: [
          {
            ...pendingTodo,
            verificationState: "confirmed",
            verificationReason: "user_confirmed",
            verificationActor: "user",
            updatedAt: createdAt + 1,
          },
        ],
        suggestions: [],
      });
    window.electronAPI.jarvis.getKnowledgeOverview = getOverview;

    const { rerender } = render(
      <ActionCenter
        sessionId="session-1"
        sessionStatus="finalizing"
        refreshKey={0}
        onViewAll={onViewAll}
      />
    );
    expect(await screen.findByRole("status", { name: "本次新增 1 个待确认" })).toBeVisible();
    expect(screen.getByText("本次新增 1")).toBeVisible();

    rerender(
      <ActionCenter
        sessionId="session-1"
        sessionStatus="completed"
        refreshKey={1}
        onViewAll={onViewAll}
      />
    );

    expect(await screen.findByRole("status", { name: "本次新增 1 个正式待办" })).toBeVisible();
    expect(screen.getByText("本次新增 1")).toBeVisible();
    expect(screen.queryByText("本次新增 2")).not.toBeInTheDocument();
  });

  it("hides the session summary when the completed session created no actions", async () => {
    render(<ActionCenter sessionId="session-1" sessionStatus="completed" onViewAll={onViewAll} />);

    expect(await screen.findByText("今天提交版本")).toBeVisible();
    expect(screen.queryByText(/本次新增/)).not.toBeInTheDocument();
  });
});
