import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TodoComposerDialog } from "../KnowledgeActionDialogs";

describe("KnowledgeActionDialogs", () => {
  it("traps focus, blocks dismissal while submitting, and restores the opener on close", async () => {
    let resolveSubmission: (() => void) | null = null;
    const submission = new Promise<void>((resolve) => {
      resolveSubmission = resolve;
    });
    const cancel = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开编辑器
          </button>
          {open && (
            <TodoComposerDialog
              heading="测试待办"
              description="测试弹窗"
              confirmLabel="创建待办"
              onCancel={() => {
                cancel();
                setOpen(false);
              }}
              onConfirm={async () => {
                await submission;
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开编辑器" });
    opener.focus();
    fireEvent.click(opener);

    const title = screen.getByLabelText("待办标题");
    const submit = screen.getByRole("button", { name: "创建待办" });
    const close = screen.getByRole("button", { name: "关闭 测试待办" });
    expect(title).toHaveFocus();
    expect(submit).toBeDisabled();

    fireEvent.change(title, { target: { value: "明确填写的标题" } });
    expect(submit).toBeEnabled();
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();

    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(close).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("knowledge-dialog-backdrop"));
    fireEvent.click(close);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();

    await act(async () => {
      resolveSubmission?.();
      await submission;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
