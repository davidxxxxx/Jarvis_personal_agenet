import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import TranscriptionQualityCard from "../TranscriptionQualityCard";

const DEFAULT_STATUS = {
  monthUtc: "2026-07",
  enabled: false,
  keyConfigured: false,
  monthlyLimitMicrousd: 5_000_000,
  spentMicrousd: 0,
  reservedMicrousd: 0,
  remainingMicrousd: 5_000_000,
  blockedReason: "cloud_disabled" as const,
};

function installElectronApi(overrides = {}) {
  const jarvis = {
    getCloudBudget: vi.fn().mockResolvedValue(DEFAULT_STATUS),
    setCloudBudget: vi.fn().mockImplementation(async (input) => ({
      ...DEFAULT_STATUS,
      ...input,
      blockedReason: input.enabled ? null : "cloud_disabled",
    })),
    ...overrides,
  };
  const saveOpenAIKey = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { jarvis, saveOpenAIKey },
  });
  return { jarvis, saveOpenAIKey };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  installElectronApi();
});

describe("TranscriptionQualityCard", () => {
  it("shows the local bilingual defaults and the disabled five-dollar guard", async () => {
    render(<TranscriptionQualityCard />);

    expect(screen.getByText("Turbo bilingual")).toBeInTheDocument();
    expect(screen.getByText("12 s stable windows · 2 s overlap")).toBeInTheDocument();
    expect(await screen.findByText("Cloud correction off")).toBeInTheDocument();
    expect(screen.getByLabelText("Monthly hard limit (USD)")).toHaveValue(5);
    expect(screen.getByText("Spent $0.00 · Reserved $0.00 · Remaining $5.00")).toBeInTheDocument();
  });

  it("saves a project key without reading it back into the renderer", async () => {
    const { jarvis, saveOpenAIKey } = installElectronApi();
    render(<TranscriptionQualityCard />);

    const keyInput = await screen.findByLabelText("OpenAI project key");
    fireEvent.change(keyInput, { target: { value: "sk-project-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(saveOpenAIKey).toHaveBeenCalledWith("sk-project-secret"));
    expect(keyInput).toHaveValue("");
    expect(jarvis.getCloudBudget).toHaveBeenCalledTimes(2);
  });

  it("enables cloud correction with a ten-dollar hard limit", async () => {
    const { jarvis } = installElectronApi({
      getCloudBudget: vi.fn().mockResolvedValue({ ...DEFAULT_STATUS, keyConfigured: true }),
    });
    render(<TranscriptionQualityCard />);

    const limit = await screen.findByLabelText("Monthly hard limit (USD)");
    fireEvent.change(limit, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable cloud correction" }));

    await waitFor(() =>
      expect(jarvis.setCloudBudget).toHaveBeenCalledWith({
        enabled: true,
        monthlyLimitMicrousd: 10_000_000,
      })
    );
    expect(await screen.findByText("Cloud correction on")).toBeInTheDocument();
  });
});
