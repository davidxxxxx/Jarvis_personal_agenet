import { describe, expect, it, vi } from "vitest";
import { createJarvisControlReceiver } from "../controlDelivery";

describe("Jarvis renderer control delivery", () => {
  it("routes a command effectively once and acknowledges duplicate delivery", async () => {
    const route = vi.fn(async () => {});
    const acknowledge = vi.fn(async () => {});
    const receiver = createJarvisControlReceiver({ route, acknowledge, now: () => 1_000 });
    const envelope = { id: "control-1", action: "start" as const, expiresAt: 2_000 };

    await receiver.handle(envelope);
    await receiver.handle(envelope);

    expect(route).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenNthCalledWith(1, "control-1", "ok");
    expect(acknowledge).toHaveBeenNthCalledWith(2, "control-1", "duplicate");
  });

  it("acknowledges expired and failed commands without replaying them", async () => {
    const route = vi.fn(async () => {
      throw new Error("cannot pause from idle");
    });
    const acknowledge = vi.fn(async () => {});
    const receiver = createJarvisControlReceiver({ route, acknowledge, now: () => 2_001 });

    await receiver.handle({ id: "expired", action: "start", expiresAt: 2_000 });
    await receiver.handle({ id: "failed", action: "pause", expiresAt: 3_000 });
    await receiver.handle({ id: "failed", action: "pause", expiresAt: 3_000 });

    expect(route).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenNthCalledWith(1, "expired", "expired");
    expect(acknowledge).toHaveBeenNthCalledWith(2, "failed", "error");
    expect(acknowledge).toHaveBeenNthCalledWith(3, "failed", "duplicate");
  });
});
