import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JarvisCaptureModeSelector from "../JarvisCaptureModeSelector";
import { useJarvisStore } from "../jarvisStore";

describe("JarvisCaptureModeSelector", () => {
  beforeEach(() => {
    useJarvisStore.setState({
      captureMode: "mic",
      sourceStates: { mic: "idle", system: "idle" },
    });
  });

  it("exposes the three approved capture choices as an accessible radio group", () => {
    const onChange = vi.fn();
    render(<JarvisCaptureModeSelector value="dual" onChange={onChange} disabled={false} />);

    expect(screen.getByRole("group", { name: "采集声音" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "仅麦克风" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "仅电脑声音" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "麦克风和电脑声音" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "仅电脑声音" }));
    expect(onChange).toHaveBeenCalledWith("system");
  });

  it("disables every mode while session source semantics are locked", () => {
    render(<JarvisCaptureModeSelector value="mic" onChange={vi.fn()} disabled />);

    expect(screen.getByRole("radio", { name: "仅麦克风" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "仅电脑声音" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "麦克风和电脑声音" })).toBeDisabled();
  });

  it("updates one source state without overwriting the other", () => {
    useJarvisStore.getState().setSourceState("mic", "recording");
    useJarvisStore.getState().setSourceState("system", "unavailable");
    expect(useJarvisStore.getState().sourceStates).toEqual({
      mic: "recording",
      system: "unavailable",
    });

    useJarvisStore.getState().setSourceState("mic", "recovering");
    expect(useJarvisStore.getState().sourceStates).toEqual({
      mic: "recovering",
      system: "unavailable",
    });
  });
});
