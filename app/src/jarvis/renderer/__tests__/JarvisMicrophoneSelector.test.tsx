import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../stores/settingsStore";
import JarvisMicrophoneSelector from "../JarvisMicrophoneSelector";

describe("JarvisMicrophoneSelector", () => {
  beforeEach(() => {
    useSettingsStore.getState().setSelectedMicDeviceId("");
    useSettingsStore.getState().setPreferBuiltInMic(true);
    const devices = [
      {
        kind: "audioinput",
        deviceId: "default",
        label: "Default",
        groupId: "g0",
        toJSON: () => ({}),
      },
      {
        kind: "audioinput",
        deviceId: "shure",
        label: "Microphone (Shure MV7)",
        groupId: "g1",
        toJSON: () => ({}),
      },
      {
        kind: "audioinput",
        deviceId: "sonar",
        label: "SteelSeries Sonar - Microphone",
        groupId: "g2",
        toJSON: () => ({}),
      },
    ] as MediaDeviceInfo[];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue(devices),
        getUserMedia: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it("pins an exact physical microphone and disables built-in preference", async () => {
    render(<JarvisMicrophoneSelector disabled={false} />);
    const select = await screen.findByLabelText("麦克风");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microphone (Shure MV7)" })).toBeInTheDocument()
    );
    fireEvent.change(select, { target: { value: "shure" } });
    expect(useSettingsStore.getState().selectedMicDeviceId).toBe("shure");
    expect(useSettingsStore.getState().preferBuiltInMic).toBe(false);
  });

  it("is locked while recording", () => {
    render(<JarvisMicrophoneSelector disabled />);
    expect(screen.getByLabelText("麦克风")).toBeDisabled();
  });
});
