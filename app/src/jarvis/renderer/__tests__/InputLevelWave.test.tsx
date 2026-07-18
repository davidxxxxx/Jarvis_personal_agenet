import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InputLevelWave from "../InputLevelWave";

describe("InputLevelWave", () => {
  it("renders one accessible meter from the existing input level", () => {
    render(<InputLevelWave level={0.64} label="Microphone input level" active />);

    const meter = screen.getByRole("meter", { name: "Microphone input level" });
    expect(meter).toHaveAttribute("aria-valuenow", "64");
    expect(meter.querySelectorAll("[data-wave-bar]")).toHaveLength(24);
  });

  it("clamps invalid levels and keeps a visible quiet baseline", () => {
    const { rerender } = render(<InputLevelWave level={-2} label="Input" active={false} />);
    const meter = screen.getByRole("meter", { name: "Input" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(meter.querySelector("[data-wave-bar]")).toHaveStyle({ height: "3px" });

    rerender(<InputLevelWave level={3} label="Input" active />);
    expect(meter).toHaveAttribute("aria-valuenow", "100");
  });
});
