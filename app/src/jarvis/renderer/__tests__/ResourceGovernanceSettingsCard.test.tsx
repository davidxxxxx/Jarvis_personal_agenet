import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type { JarvisApplicationAudioSettings, JarvisApplicationAudioStatus } from "../../types";
import ResourceGovernanceSettingsCard from "../ResourceGovernanceSettingsCard";

const BALANCED = {
  profile: "balanced" as const,
  externalGpuThresholdPct: 45,
  recoveryWaitMs: 60_000,
};

function installElectronApi(overrides = {}) {
  const jarvis = {
    getResourceGovernance: vi.fn().mockResolvedValue(BALANCED),
    setResourceGovernance: vi.fn().mockImplementation(async (input) => input),
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

describe("ResourceGovernanceSettingsCard", () => {
  it("loads balanced defaults and switches to the game-priority preset", async () => {
    const jarvis = installElectronApi();
    render(<ResourceGovernanceSettingsCard />);

    expect(await screen.findByRole("button", { name: /Balanced/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: /Game priority/ }));

    await waitFor(() =>
      expect(jarvis.setResourceGovernance).toHaveBeenCalledWith({
        profile: "game_priority",
        externalGpuThresholdPct: 20,
        recoveryWaitMs: 120_000,
      })
    );
    expect(screen.getByRole("button", { name: /Game priority/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Resource priority updated.")).toBeVisible();
  });

  it("persists bounded advanced threshold and recovery overrides", async () => {
    const jarvis = installElectronApi();
    render(<ResourceGovernanceSettingsCard />);

    await screen.findByRole("button", { name: /Balanced/ });
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByLabelText("External GPU busy threshold (%)"), {
      target: { value: "55" },
    });
    fireEvent.change(screen.getByLabelText("Recovery wait (seconds)"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply advanced settings" }));

    await waitFor(() =>
      expect(jarvis.setResourceGovernance).toHaveBeenCalledWith({
        profile: "balanced",
        externalGpuThresholdPct: 55,
        recoveryWaitMs: 90_000,
      })
    );
    expect(screen.getByText(/Customized/)).toBeVisible();
  });

  it("masks raw desktop errors", async () => {
    installElectronApi({
      getResourceGovernance: vi
        .fn()
        .mockRejectedValue(new Error("C:\\private\\resource.json raw failure")),
    });
    render(<ResourceGovernanceSettingsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resource settings are temporarily unavailable."
    );
    expect(document.body.textContent).not.toContain("resource.json");
  });

  it("switches fallback policy without dropping enabled or trackLimit", async () => {
    let current: JarvisApplicationAudioStatus = {
      enabled: true,
      trackLimit: 4,
      fallbackPolicy: "conservative",
      runtime: {
        running: true,
        configuredLimit: 4,
        effectiveLimit: 4,
        fullscreen: false,
        activeTracks: [],
        fallbacks: [],
      },
    };
    const setApplicationAudioSettings = vi.fn(async (input: JarvisApplicationAudioSettings) => {
      current = { ...current, ...input };
      return current;
    });
    installElectronApi({
      getApplicationAudioSettings: vi.fn(async () => current),
      setApplicationAudioSettings,
    });
    render(<ResourceGovernanceSettingsCard />);

    const transcriptOnly = await screen.findByRole("radio", { name: /Transcript only/i });
    fireEvent.click(transcriptOnly);

    await waitFor(() =>
      expect(setApplicationAudioSettings).toHaveBeenLastCalledWith({
        enabled: true,
        trackLimit: 4,
        fallbackPolicy: "transcript_only",
      })
    );
    await waitFor(() => expect(transcriptOnly).toHaveAttribute("aria-checked", "true"));

    fireEvent.change(screen.getByLabelText("Maximum simultaneous app tracks"), {
      target: { value: "6" },
    });
    await waitFor(() =>
      expect(setApplicationAudioSettings).toHaveBeenLastCalledWith({
        enabled: true,
        trackLimit: 6,
        fallbackPolicy: "transcript_only",
      })
    );

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(setApplicationAudioSettings).toHaveBeenLastCalledWith({
        enabled: false,
        trackLimit: 6,
        fallbackPolicy: "transcript_only",
      })
    );
  });
});
