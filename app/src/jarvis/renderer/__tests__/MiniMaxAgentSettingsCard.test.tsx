import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import MiniMaxAgentSettingsCard from "../MiniMaxAgentSettingsCard";

const DEFAULT_CONFIG = { keyConfigured: false, model: "MiniMax-M2.7" };
const DEFAULT_BUDGET = {
  monthKey: "2026-07",
  timezone: "Asia/Shanghai",
  currency: "USD" as const,
  monthlyLimitMicrousd: 5_000_000,
  spentMicrousd: 1_000_000,
  reservedMicrousd: 500_000,
  remainingMicrousd: 3_500_000,
  blockedReason: null,
};

function installElectronApi(overrides = {}) {
  const jarvis = {
    getMiniMaxConfig: vi.fn().mockResolvedValue(DEFAULT_CONFIG),
    setMiniMaxKey: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG, keyConfigured: true }),
    clearMiniMaxKey: vi.fn().mockResolvedValue(DEFAULT_CONFIG),
    getAnalysisBudget: vi.fn().mockResolvedValue(DEFAULT_BUDGET),
    setAnalysisBudget: vi.fn().mockImplementation(async (input) => ({
      ...DEFAULT_BUDGET,
      ...input,
      remainingMicrousd: Math.max(
        0,
        input.monthlyLimitMicrousd - DEFAULT_BUDGET.spentMicrousd - DEFAULT_BUDGET.reservedMicrousd
      ),
    })),
    ...overrides,
  };
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { jarvis },
  });
  return jarvis;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  installElectronApi();
});

describe("MiniMaxAgentSettingsCard", () => {
  it("loads MiniMax configuration and the independent analysis budget", async () => {
    render(<MiniMaxAgentSettingsCard />);

    expect(await screen.findByText("MiniMax key not configured")).toBeVisible();
    expect(screen.getByText("Model: MiniMax-M2.7")).toBeVisible();
    expect(screen.getByLabelText("MiniMax monthly hard limit (USD)")).toHaveValue(5);
    expect(screen.getByText("2026-07 · Asia/Shanghai")).toBeVisible();
    expect(screen.getByText("Spent $1.00 · Reserved $0.50 · Remaining $3.50")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  });

  it("saves and clears the key without ever rendering the secret", async () => {
    const jarvis = installElectronApi();
    render(<MiniMaxAgentSettingsCard />);

    const input = await screen.findByLabelText("MiniMax subscription key");
    fireEvent.change(input, { target: { value: "sk-cp-super-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MiniMax key" }));

    await waitFor(() => expect(jarvis.setMiniMaxKey).toHaveBeenCalledWith("sk-cp-super-secret"));
    expect(input).toHaveValue("");
    expect(document.body.textContent).not.toContain("sk-cp-super-secret");
    expect(await screen.findByText("MiniMax key configured")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove MiniMax key" }));
    await waitFor(() => expect(jarvis.clearMiniMaxKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("MiniMax key not configured")).toBeVisible();
  });

  it("applies zero and ten dollar hard limits but rejects out-of-range input", async () => {
    const jarvis = installElectronApi();
    render(<MiniMaxAgentSettingsCard />);
    const input = await screen.findByLabelText("MiniMax monthly hard limit (USD)");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    await waitFor(() =>
      expect(jarvis.setAnalysisBudget).toHaveBeenLastCalledWith({
        monthlyLimitMicrousd: 0,
        timezone: "Asia/Shanghai",
      })
    );
    expect(
      await screen.findByText("MiniMax cloud analysis is disabled by the $0 limit.")
    ).toBeVisible();

    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    await waitFor(() =>
      expect(jarvis.setAnalysisBudget).toHaveBeenLastCalledWith({
        monthlyLimitMicrousd: 10_000_000,
        timezone: "Asia/Shanghai",
      })
    );

    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a monthly limit from $0 to $10."
    );
    expect(jarvis.setAnalysisBudget).toHaveBeenCalledTimes(2);

    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a monthly limit from $0 to $10."
    );
    expect(jarvis.setAnalysisBudget).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["usage_unknown", "Usage could not be verified. MiniMax analysis is blocked for this month."],
    ["over_limit", "The saved limit is below this month's committed usage."],
    ["budget_exceeded", "The MiniMax monthly hard limit has been reached."],
  ])("renders the %s fail-closed state", async (blockedReason, message) => {
    installElectronApi({
      getAnalysisBudget: vi.fn().mockResolvedValue({ ...DEFAULT_BUDGET, blockedReason }),
    });
    render(<MiniMaxAgentSettingsCard />);
    expect(await screen.findByText(message)).toBeVisible();
  });

  it("masks raw key and database errors from the renderer", async () => {
    installElectronApi({
      getMiniMaxConfig: vi.fn().mockRejectedValue(new Error("C:\\secret\\jarvis.db sk-cp-private")),
    });
    render(<MiniMaxAgentSettingsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MiniMax settings are temporarily unavailable."
    );
    expect(document.body.textContent).not.toMatch(/jarvis\.db|sk-cp-private/);
  });

  it("keeps a successful key state visible when the independent budget load fails", async () => {
    const getAnalysisBudget = vi
      .fn()
      .mockRejectedValueOnce(new Error("budget unavailable"))
      .mockResolvedValue(DEFAULT_BUDGET);
    installElectronApi({
      getMiniMaxConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG, keyConfigured: true }),
      getAnalysisBudget,
    });

    render(<MiniMaxAgentSettingsCard />);

    expect(await screen.findByText("MiniMax key configured")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove MiniMax key" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "MiniMax settings are temporarily unavailable."
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry MiniMax settings" }));
    expect(await screen.findByLabelText("MiniMax monthly hard limit (USD)")).toHaveValue(5);
    await waitFor(() => expect(getAnalysisBudget).toHaveBeenCalledTimes(2));
  });

  it("does not let a stale startup response overwrite a newly saved key", async () => {
    let resolveInitialConfig!: (value: typeof DEFAULT_CONFIG) => void;
    const initialConfig = new Promise<typeof DEFAULT_CONFIG>((resolve) => {
      resolveInitialConfig = resolve;
    });
    installElectronApi({
      getMiniMaxConfig: vi.fn().mockReturnValue(initialConfig),
    });

    render(<MiniMaxAgentSettingsCard />);
    const input = await screen.findByLabelText("MiniMax subscription key");
    fireEvent.change(input, { target: { value: "sk-cp-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MiniMax key" }));
    expect(await screen.findByText("MiniMax key configured")).toBeVisible();

    resolveInitialConfig(DEFAULT_CONFIG);
    await Promise.resolve();
    expect(screen.getByText("MiniMax key configured")).toBeVisible();
  });

  it("stays renderable while the desktop bridge is unavailable", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });

    render(<MiniMaxAgentSettingsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MiniMax settings are temporarily unavailable."
    );
  });
});
