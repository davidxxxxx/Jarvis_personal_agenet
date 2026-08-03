import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisLearningGoal, JarvisLearningGoalResultStatus } from "../../types";
import PersonalizationSettingsCard from "../PersonalizationSettingsCard";

const NOTIFICATIONS = {
  focusMode: false,
  mutedUntil: null,
  updatedAt: 1,
  effectiveMuted: false,
};

const RULE = {
  id: "rule-1",
  domain: "activity_classification" as const,
  targetValue: "learning",
  label: "Chrome 中的课程通常属于学习",
  supportCount: 3,
  state: "proposed" as const,
  conditions: {
    applicationKeys: ["chrome"],
    selfParticipated: false,
    speakerCountBucket: "one" as const,
    timeBucket: "evening" as const,
  },
  createdAt: 1,
  updatedAt: 1,
};

function goal(
  id: string,
  title: string,
  state: JarvisLearningGoal["state"] = "confirmed"
): JarvisLearningGoal {
  return {
    id,
    title,
    state,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    archivedAt: state === "archived" ? 2 : null,
  };
}

function installElectronApi(
  initialGoals: JarvisLearningGoal[] = [],
  overrides: Record<string, unknown> = {}
) {
  let goals = [...initialGoals];
  const update = (
    id: string,
    status: JarvisLearningGoalResultStatus,
    changes: Partial<JarvisLearningGoal>
  ) => {
    const current = goals.find((entry) => entry.id === id);
    if (!current) throw new Error("missing test goal");
    const changed = { ...current, ...changes, updatedAt: current.updatedAt + 1 };
    goals =
      changed.state === "deleted"
        ? goals.filter((entry) => entry.id !== id)
        : goals.map((entry) => (entry.id === id ? changed : entry));
    return { status, goal: changed };
  };

  const jarvis = {
    getPersonalizationSettings: vi.fn().mockResolvedValue({
      rules: [],
      notifications: NOTIFICATIONS,
    }),
    decidePersonalizationRule: vi.fn().mockResolvedValue(undefined),
    resetPersonalizationRules: vi.fn().mockResolvedValue(undefined),
    setNotificationPreferences: vi.fn().mockImplementation(async (focusMode, mutedUntil) => ({
      ...NOTIFICATIONS,
      focusMode,
      mutedUntil,
      effectiveMuted: focusMode || mutedUntil !== null,
    })),
    listLearningGoals: vi.fn().mockImplementation(async () => [...goals]),
    createLearningGoal: vi.fn().mockImplementation(async (title: string) => {
      const created = goal(`goal-${goals.length + 1}`, title);
      goals = [created, ...goals];
      return { status: "created" as const, goal: created };
    }),
    editLearningGoal: vi
      .fn()
      .mockImplementation(async (id: string, title: string) => update(id, "edited", { title })),
    archiveLearningGoal: vi
      .fn()
      .mockImplementation(async (id: string) =>
        update(id, "archived", { state: "archived", archivedAt: 2 })
      ),
    restoreLearningGoal: vi
      .fn()
      .mockImplementation(async (id: string) =>
        update(id, "restored", { state: "confirmed", archivedAt: null })
      ),
    deleteLearningGoal: vi
      .fn()
      .mockImplementation(async (id: string) => update(id, "deleted", { state: "deleted" })),
    ...overrides,
  };
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { jarvis },
  });
  return jarvis;
}

beforeEach(() => {
  vi.restoreAllMocks();
  installElectronApi();
});

describe("PersonalizationSettingsCard learning goals", () => {
  it("creates a trimmed goal and enforces the 1–500 character gate", async () => {
    const jarvis = installElectronApi();
    render(<PersonalizationSettingsCard />);

    const input = await screen.findByLabelText("新学习目标");
    const add = screen.getByRole("button", { name: "添加" });
    expect(add).toBeDisabled();
    expect(input).not.toHaveAttribute("maxlength");

    fireEvent.change(input, { target: { value: " ".repeat(3) } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "目".repeat(501) } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "📚".repeat(500) } });
    expect(add).toBeEnabled();
    fireEvent.change(input, { target: { value: "目标\u0007" } });
    expect(add).toBeDisabled();
    expect(jarvis.createLearningGoal).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  完成 CUDA 性能优化课程  " } });
    fireEvent.click(add);

    await waitFor(() =>
      expect(jarvis.createLearningGoal).toHaveBeenCalledWith("完成 CUDA 性能优化课程")
    );
    expect(await screen.findByText("完成 CUDA 性能优化课程")).toBeVisible();
    expect(input).toHaveValue("");
  });

  it("edits a confirmed goal with normalized text", async () => {
    const jarvis = installElectronApi([goal("goal-1", "学习 Rust")]);
    render(<PersonalizationSettingsCard />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑学习目标 学习 Rust" }));
    const input = screen.getByRole("textbox", { name: "编辑学习目标 学习 Rust" });
    fireEvent.change(input, { target: { value: "  学习 Rust 异步编程  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存学习目标 学习 Rust" }));

    await waitFor(() =>
      expect(jarvis.editLearningGoal).toHaveBeenCalledWith("goal-1", "学习 Rust 异步编程")
    );
    expect(await screen.findByText("学习 Rust 异步编程")).toBeVisible();
  });

  it("moves goals between confirmed and archived sections", async () => {
    const jarvis = installElectronApi([goal("goal-1", "理解 CUDA streams")]);
    render(<PersonalizationSettingsCard />);

    const confirmed = await screen.findByRole("region", { name: "已确认" });
    expect(within(confirmed).getByText("理解 CUDA streams")).toBeVisible();
    fireEvent.click(
      within(confirmed).getByRole("button", {
        name: "归档学习目标 理解 CUDA streams",
      })
    );

    await waitFor(() => expect(jarvis.archiveLearningGoal).toHaveBeenCalledWith("goal-1"));
    const archived = screen.getByRole("region", { name: "已归档" });
    expect(within(archived).getByText("理解 CUDA streams")).toBeVisible();
    fireEvent.click(
      within(archived).getByRole("button", {
        name: "恢复学习目标 理解 CUDA streams",
      })
    );

    await waitFor(() => expect(jarvis.restoreLearningGoal).toHaveBeenCalledWith("goal-1"));
    expect(
      within(screen.getByRole("region", { name: "已确认" })).getByText("理解 CUDA streams")
    ).toBeVisible();
  });

  it("requires confirmation before permanently deleting a goal", async () => {
    const jarvis = installElectronApi([goal("goal-1", "完成模型评估")]);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<PersonalizationSettingsCard />);

    const deleteButton = await screen.findByRole("button", {
      name: "删除学习目标 完成模型评估",
    });
    fireEvent.click(deleteButton);
    expect(jarvis.deleteLearningGoal).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);

    fireEvent.click(deleteButton);
    await waitFor(() => expect(jarvis.deleteLearningGoal).toHaveBeenCalledWith("goal-1"));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("完成模型评估")).not.toBeInTheDocument();
  });

  it("keeps rule and notification controls usable after a local goal API failure", async () => {
    const jarvis = installElectronApi([], {
      getPersonalizationSettings: vi.fn().mockResolvedValue({
        rules: [RULE],
        notifications: NOTIFICATIONS,
      }),
      createLearningGoal: vi.fn().mockRejectedValue(new Error("private database path")),
    });
    render(<PersonalizationSettingsCard />);

    const input = await screen.findByLabelText("新学习目标");
    fireEvent.change(input, { target: { value: "失败的目标" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("没有创建学习目标，请重试");
    expect(document.body.textContent).not.toContain("private database path");

    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() =>
      expect(jarvis.decidePersonalizationRule).toHaveBeenCalledWith("rule-1", "enable", undefined)
    );
    fireEvent.click(screen.getByRole("button", { name: "专注模式" }));
    await waitFor(() => expect(jarvis.setNotificationPreferences).toHaveBeenCalledWith(true, null));
  });
});
