import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import JarvisStorageSettings from "../JarvisStorageSettings";

const getStorageStatus = vi.fn();
const migrateStorage = vi.fn();

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  getStorageStatus.mockReset().mockResolvedValue({
    state: "warning",
    volumeBytes: 1000,
    freeBytes: 500,
    warningBytes: 600,
    stopBytes: 100,
    writtenBytes24h: 140,
    compressedBytes24h: 40,
    projectedDailyGrowthBytes: 140,
    remainingDays: 3,
    currentRoot: "C:\\Jarvis",
    progress: null,
    recoveryAction: "Free disk space or migrate the Jarvis data directory.",
  });
  migrateStorage.mockReset().mockResolvedValue({ switched: true, canDeleteOldRoot: true });
  Object.assign(window, {
    electronAPI: {
      jarvis: { getStorageStatus, migrateStorage },
    },
  });
});

describe("JarvisStorageSettings", () => {
  it("renders real storage metrics and the current root", async () => {
    render(<JarvisStorageSettings captureActive={false} />);

    expect(await screen.findByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("C:\\Jarvis")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(
      screen.getByText("Free disk space or migrate the Jarvis data directory.")
    ).toBeInTheDocument();
  });

  it("migrates only while capture is inactive", async () => {
    const { rerender } = render(<JarvisStorageSettings captureActive />);
    expect(await screen.findByRole("button", { name: "Migrate data" })).toBeDisabled();
    expect(screen.getByText("Finish or cancel capture before migrating data.")).toBeInTheDocument();

    rerender(<JarvisStorageSettings captureActive={false} />);
    fireEvent.change(screen.getByLabelText("New data directory"), {
      target: { value: "D:\\Jarvis" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Migrate data" }));
    await waitFor(() => expect(migrateStorage).toHaveBeenCalledWith({ to: "D:\\Jarvis" }));
  });
});
