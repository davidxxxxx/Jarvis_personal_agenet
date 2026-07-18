import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InputLevelWave from "../InputLevelWave";

describe("InputLevelWave", () => {
  const labels = {
    idleLabel: "Waiting to record",
    quietLabel: "No sound detected",
    audibleLabel: "Sound detected",
  };

  it("renders a player-style audible waveform from the existing input level", () => {
    render(<InputLevelWave level={0.08} label="Microphone input level" active {...labels} />);

    const meter = screen.getByRole("meter", { name: "Microphone input level" });
    expect(meter).toHaveAttribute("aria-valuenow", "8");
    expect(meter).toHaveAttribute("data-audio-state", "audible");
    expect(meter).toHaveAttribute("aria-valuetext", "Sound detected, 8%");
    expect(screen.getByText("Sound detected")).toBeInTheDocument();
    expect(meter.querySelectorAll("[data-wave-bar]")).toHaveLength(40);
    expect(meter.querySelector("[data-wave-bar]")).not.toHaveStyle({ height: "2px" });
  });

  it("uses a flat baseline and distinct labels for idle and quiet input", () => {
    const { rerender } = render(
      <InputLevelWave level={-2} label="Input" active={false} {...labels} />
    );
    const meter = screen.getByRole("meter", { name: "Input" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(meter).toHaveAttribute("data-audio-state", "idle");
    expect(screen.getByText("Waiting to record")).toBeInTheDocument();
    expect(meter.querySelector("[data-wave-bar]")).toHaveStyle({ height: "2px" });

    rerender(<InputLevelWave level={0.01} label="Input" active {...labels} />);
    expect(meter).toHaveAttribute("data-audio-state", "quiet");
    expect(screen.getByText("No sound detected")).toBeInTheDocument();
    expect(meter.querySelector("[data-wave-bar]")).toHaveStyle({ height: "2px" });

    rerender(<InputLevelWave level={3} label="Input" active {...labels} />);
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("data-audio-state", "audible");
  });
});
