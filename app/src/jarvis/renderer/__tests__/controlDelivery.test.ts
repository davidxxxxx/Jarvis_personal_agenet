import { describe, expect, it, vi } from "vitest";
import { createJarvisControlReceiver } from "../controlDelivery";

describe("Jarvis renderer control delivery", () => {
  it("shares one in-flight route and emits one final acknowledgement", async () => {
    let releaseRoute!: () => void;
    const route = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        })
    );
    const claim = vi.fn(async () => ({ status: "claimed" as const }));
    const acknowledge = vi.fn(async () => {});
    const receiver = createJarvisControlReceiver({ claim, route, acknowledge });
    const envelope = { id: "control-1", action: "start" as const, expiresAt: 2_000 };

    const first = receiver.handle(envelope);
    const duplicate = receiver.handle(envelope);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
    releaseRoute();
    await Promise.all([first, duplicate]);

    expect(route).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("control-1", "ok");
    await receiver.handle(envelope);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not route or acknowledge a command that main cannot claim", async () => {
    const route = vi.fn(async () => {});
    const claim = vi.fn(async () => ({ status: "expired" as const }));
    const acknowledge = vi.fn(async () => {});
    const receiver = createJarvisControlReceiver({ claim, route, acknowledge });

    await receiver.handle({ id: "expired", action: "start", expiresAt: 2_000 });

    expect(claim).toHaveBeenCalledWith("expired");
    expect(route).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges one route failure after a successful claim", async () => {
    const route = vi.fn(async () => {
      throw new Error("cannot pause from idle");
    });
    const claim = vi.fn(async () => ({ status: "claimed" as const }));
    const acknowledge = vi.fn(async () => {});
    const receiver = createJarvisControlReceiver({ claim, route, acknowledge });

    await receiver.handle({ id: "failed", action: "pause", expiresAt: 3_000 });
    await receiver.handle({ id: "failed", action: "pause", expiresAt: 3_000 });

    expect(route).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("failed", "error");
  });
});
