import { describe, expect, it } from "vitest";
import { initialSessionState, reduceSession } from "../sessionMachine";

describe("Jarvis session machine", () => {
  it("keeps one session id across pause and resume", () => {
    const recording = reduceSession(initialSessionState, { type: "STARTED", id: "s1", at: 1000 });
    const paused = reduceSession(recording, { type: "PAUSED", at: 2000 });
    const resumed = reduceSession(paused, { type: "RESUMED", at: 3000 });

    expect(resumed).toMatchObject({
      id: "s1",
      status: "recording",
      accumulatedMs: 1000,
      activeSince: 3000,
    });
  });

  it("tracks starting and finalizing as explicit lifecycle states", () => {
    const starting = reduceSession(initialSessionState, { type: "STARTING", id: "s1", at: 1000 });
    const recording = reduceSession(starting, { type: "STARTED", id: "s1", at: 1100 });
    const finalizing = reduceSession(recording, { type: "FINISHED", at: 2100 });
    const completed = reduceSession(finalizing, { type: "COMPLETED" });

    expect(starting).toMatchObject({ id: "s1", status: "starting", startedAt: 1000 });
    expect(finalizing).toMatchObject({
      id: "s1",
      status: "finalizing",
      accumulatedMs: 1000,
      activeSince: null,
    });
    expect(completed.status).toBe("completed");
  });

  it("finishes a paused session without adding paused time", () => {
    const recording = reduceSession(initialSessionState, { type: "STARTED", id: "s1", at: 1000 });
    const paused = reduceSession(recording, { type: "PAUSED", at: 2000 });

    expect(reduceSession(paused, { type: "FINISHED", at: 5000 })).toMatchObject({
      status: "finalizing",
      accumulatedMs: 1000,
    });
  });

  it("records a safe error code when an active lifecycle fails", () => {
    const starting = reduceSession(initialSessionState, { type: "STARTING", id: "s1", at: 1000 });

    expect(reduceSession(starting, { type: "FAILED", code: "capture_start_failed" })).toMatchObject(
      {
        id: "s1",
        status: "failed",
        errorCode: "capture_start_failed",
      }
    );
  });

  it("rejects impossible transitions", () => {
    expect(() => reduceSession(initialSessionState, { type: "FINISHED", at: 1000 })).toThrow(
      "cannot finish from idle"
    );
    expect(() => reduceSession(initialSessionState, { type: "PAUSED", at: 1000 })).toThrow(
      "cannot pause from idle"
    );
  });
});
