import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import MiniMaxAgentSettingsCard from "../MiniMaxAgentSettingsCard";

const DEFAULT_CONFIG = {
  keyConfigured: false,
  model: "MiniMax-M2.7" as const,
  modelStatus: "not_configured" as const,
  fallbackUsed: false,
  checkedAt: null,
};
const READY_CONFIG = {
  ...DEFAULT_CONFIG,
  keyConfigured: true,
  modelStatus: "ready" as const,
  checkedAt: 1_000,
};
const DEFAULT_BUDGET = {
  mode: "capped" as const,
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
    setMiniMaxKey: vi.fn().mockResolvedValue(READY_CONFIG),
    clearMiniMaxKey: vi.fn().mockResolvedValue(DEFAULT_CONFIG),
    getAnalysisBudget: vi.fn().mockResolvedValue(DEFAULT_BUDGET),
    setAnalysisBudget: vi.fn().mockImplementation(async (input) => ({
      ...DEFAULT_BUDGET,
      ...input,
      remainingMicrousd:
        input.mode === "unlimited"
          ? null
          : Math.max(
              0,
              input.monthlyLimitMicrousd -
                DEFAULT_BUDGET.spentMicrousd -
                DEFAULT_BUDGET.reservedMicrousd
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
    expect(screen.getByLabelText("MiniMax budget mode")).toHaveValue("capped");
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

  it.each([
    [READY_CONFIG, "MiniMax model availability confirmed."],
    [
      { ...READY_CONFIG, modelStatus: "unavailable" as const },
      "MiniMax model availability could not be checked. Local recording is unaffected.",
    ],
    [
      { ...READY_CONFIG, modelStatus: "model_unavailable" as const },
      "MiniMax-M2.7 is not available for this key. Cloud analysis remains paused.",
    ],
    [
      { ...READY_CONFIG, fallbackUsed: true },
      "The configured model was unavailable. Jarvis will use MiniMax-M2.7.",
    ],
  ])("reports MiniMax model discovery without exposing provider details", async (next, copy) => {
    installElectronApi({ getMiniMaxConfig: vi.fn().mockResolvedValue(next) });
    render(<MiniMaxAgentSettingsCard />);

    expect(await screen.findByText(copy)).toBeVisible();
  });

  it("applies a two-hundred-dollar cap and an explicit no-limit mode", async () => {
    const jarvis = installElectronApi();
    render(<MiniMaxAgentSettingsCard />);
    const input = await screen.findByLabelText("MiniMax monthly hard limit (USD)");

    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    await waitFor(() =>
      expect(jarvis.setAnalysisBudget).toHaveBeenLastCalledWith({
        mode: "capped",
        monthlyLimitMicrousd: 200_000_000,
        timezone: "Asia/Shanghai",
      })
    );
    fireEvent.change(screen.getByLabelText("MiniMax budget mode"), {
      target: { value: "unlimited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply MiniMax budget" }));
    await waitFor(() =>
      expect(jarvis.setAnalysisBudget).toHaveBeenLastCalledWith({
        mode: "unlimited",
        monthlyLimitMicrousd: 200_000_000,
        timezone: "Asia/Shanghai",
      })
    );
    expect(await screen.findByText(/No limit may create ongoing charges/)).toBeVisible();
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
      getMiniMaxConfig: vi.fn().mockResolvedValue(READY_CONFIG),
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
