import { describe, expect, it, vi } from "vitest";
import {
  createMeetingStopCoordinator,
  type SharedStopResult,
} from "../../../stores/meetingStopCoordinator";

interface TestStopResult extends SharedStopResult {
  diarizationSessionId: string | null;
}

const successResult: TestStopResult = { success: true, diarizationSessionId: null };
const failureResult: TestStopResult = {
  success: false,
  error: "shared stop failed",
  diarizationSessionId: null,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness(result: TestStopResult) {
  const gate = deferred();
  const cleanup = vi.fn();
  const ipcStop = vi.fn();
  const attempt = vi.fn(async () => {
    cleanup();
    await gate.promise;
    ipcStop();
    return result;
  });
  return { attempt, cleanup, gate, ipcStop };
}

function createCoordinator() {
  return createMeetingStopCoordinator<TestStopResult>((error) => ({
    success: false,
    error: error instanceof Error ? error.message : "shared stop failed",
    diarizationSessionId: null,
  }));
}

describe("meeting stop coordinator", () => {
  it("shares one successful teardown between overlapping strict callers", async () => {
    const coordinator = createCoordinator();
    const harness = createHarness(successResult);

    const first = coordinator.stop(harness.attempt, { throwOnError: true });
    const second = coordinator.stop(harness.attempt, { throwOnError: true });

    expect(coordinator.hasPendingStop()).toBe(true);
    await Promise.resolve();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    harness.gate.resolve();

    await expect(first).resolves.toEqual(successResult);
    await expect(second).resolves.toEqual(successResult);
    expect(harness.attempt).toHaveBeenCalledTimes(1);
    expect(harness.ipcStop).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPendingStop()).toBe(false);
  });

  it("gives both strict callers the shared failure and permits one retry", async () => {
    const coordinator = createCoordinator();
    const failed = createHarness(failureResult);

    const first = coordinator.stop(failed.attempt, { throwOnError: true });
    const second = coordinator.stop(failed.attempt, { throwOnError: true });
    const firstFailure = expect(first).rejects.toThrow("shared stop failed");
    const secondFailure = expect(second).rejects.toThrow("shared stop failed");
    await Promise.resolve();
    failed.gate.resolve();
    await Promise.all([firstFailure, secondFailure]);

    expect(failed.attempt).toHaveBeenCalledTimes(1);
    expect(failed.cleanup).toHaveBeenCalledTimes(1);
    expect(failed.ipcStop).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPendingStop()).toBe(true);

    const retry = createHarness(successResult);
    const retryResult = coordinator.stop(retry.attempt, { throwOnError: true });
    await Promise.resolve();
    retry.gate.resolve();
    await expect(retryResult).resolves.toEqual(successResult);
    expect(retry.attempt).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPendingStop()).toBe(false);
  });

  it("makes a strict caller await a default caller's shared failure", async () => {
    const coordinator = createCoordinator();
    const harness = createHarness(failureResult);

    const normal = coordinator.stop(harness.attempt);
    const strict = coordinator.stop(harness.attempt, { throwOnError: true });
    const strictFailure = expect(strict).rejects.toThrow("shared stop failed");
    await Promise.resolve();
    harness.gate.resolve();

    await expect(normal).resolves.toEqual(failureResult);
    await strictFailure;
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.ipcStop).toHaveBeenCalledTimes(1);
  });

  it("gives a strict caller the same successful result as the overlapping default caller", async () => {
    const coordinator = createCoordinator();
    const harness = createHarness(successResult);

    const normal = coordinator.stop(harness.attempt);
    const strict = coordinator.stop(harness.attempt, { throwOnError: true });
    await Promise.resolve();
    harness.gate.resolve();

    const [normalResult, strictResult] = await Promise.all([normal, strict]);
    expect(normalResult).toBe(successResult);
    expect(strictResult).toBe(normalResult);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.ipcStop).toHaveBeenCalledTimes(1);
  });

  it("makes a default caller await a strict caller's shared success", async () => {
    const coordinator = createCoordinator();
    const harness = createHarness(successResult);

    const strict = coordinator.stop(harness.attempt, { throwOnError: true });
    const normal = coordinator.stop(harness.attempt);
    await Promise.resolve();
    harness.gate.resolve();

    await expect(strict).resolves.toEqual(successResult);
    await expect(normal).resolves.toEqual(successResult);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.ipcStop).toHaveBeenCalledTimes(1);
  });

  it("gives a default caller the shared failure from an overlapping strict caller", async () => {
    const coordinator = createCoordinator();
    const harness = createHarness(failureResult);

    const strict = coordinator.stop(harness.attempt, { throwOnError: true });
    const normal = coordinator.stop(harness.attempt);
    const strictFailure = expect(strict).rejects.toThrow("shared stop failed");
    await Promise.resolve();
    harness.gate.resolve();

    await expect(normal).resolves.toBe(failureResult);
    await strictFailure;
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.ipcStop).toHaveBeenCalledTimes(1);
  });
});
