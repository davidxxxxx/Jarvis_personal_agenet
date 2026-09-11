import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TodoReminderControl, { type TodoReminderSnapshot } from "../TodoReminderControl";

const scheduled: TodoReminderSnapshot = {
  reminderAt: new Date("2030-08-05T09:30").getTime(),
  reminderSource: "user",
  state: "scheduled",
  deferredReason: null,
  deliveredAt: null,
};

function renderControl(reminder: TodoReminderSnapshot | null = scheduled) {
  const onReminderChange = vi.fn();
  const result = render(
    <TodoReminderControl
      todoId="todo-1"
      todoTitle="提交版本"
      todoStatus="open"
      verificationState="confirmed"
      reminder={reminder}
      onReminderChange={onReminderChange}
    />
  );
  return { ...result, onReminderChange };
}

describe("TodoReminderControl", () => {
  it("keeps the previous reminder visible when a modification fails", async () => {
    const setTodoReminder = vi.fn().mockRejectedValue(new Error("offline"));
    window.electronAPI = {
      jarvis: {
        getTodoReminder: vi.fn().mockResolvedValue({
          todoId: "todo-1",
          ...scheduled,
          updatedAt: 1,
        }),
        setTodoReminder,
      },
    } as unknown as typeof window.electronAPI;

    const { onReminderChange } = renderControl();
    const previousStatus = screen.getByText(/将于 .* 提醒/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "修改提醒 提交版本" }));
    const input = await screen.findByLabelText("提醒时间 提交版本");
    fireEvent.change(input, { target: { value: "2030-08-08T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存提醒" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "提醒没有保存，原来的提醒状态保持不变。"
    );
    expect(screen.getByText(previousStatus as string)).toBeVisible();
    expect(onReminderChange).toHaveBeenCalledTimes(1);
    expect(onReminderChange).toHaveBeenLastCalledWith(scheduled);
  });

  it("labels deferred, delivered, and cancelled reminder states explicitly", async () => {
    window.electronAPI = {
      jarvis: {
        getTodoReminder: vi.fn(),
        setTodoReminder: vi.fn(),
      },
    } as unknown as typeof window.electronAPI;
    const view = renderControl({
      ...scheduled,
      state: "deferred",
      deferredReason: "active_focus_context",
    });
    expect(screen.getByText(/提醒已延迟 · 游戏、会议或演示正在进行/)).toBeVisible();

    view.rerender(
      <TodoReminderControl
        todoId="todo-1"
        todoTitle="提交版本"
        todoStatus="open"
        verificationState="confirmed"
        reminder={{
          ...scheduled,
          state: "delivered",
          deliveredAt: scheduled.reminderAt + 1_000,
        }}
        compact
        onReminderChange={view.onReminderChange}
      />
    );
    expect(screen.getByRole("button", { name: "设置提醒 提交版本" })).toHaveTextContent("已提醒");

    view.rerender(
      <TodoReminderControl
        todoId="todo-1"
        todoTitle="提交版本"
        todoStatus="open"
        verificationState="confirmed"
        reminder={{ ...scheduled, state: "cancelled" }}
        compact
        onReminderChange={view.onReminderChange}
      />
    );
    expect(screen.getByRole("button", { name: "设置提醒 提交版本" })).toHaveTextContent(
      "提醒已取消"
    );
  });

  it("does not expose an editor for an unconfirmed todo", () => {
    window.electronAPI = {
      jarvis: {
        getTodoReminder: vi.fn(),
        setTodoReminder: vi.fn(),
      },
    } as unknown as typeof window.electronAPI;
    render(
      <TodoReminderControl
        todoId="todo-pending"
        todoTitle="待确认任务"
        todoStatus="open"
        verificationState="pending_confirmation"
        reminder={null}
        onReminderChange={() => {}}
      />
    );

    expect(screen.getByText("确认成为正式待办后才能设置提醒。")).toBeVisible();
    expect(screen.getByRole("button", { name: "设置提醒 待确认任务" })).toBeDisabled();
  });
});
