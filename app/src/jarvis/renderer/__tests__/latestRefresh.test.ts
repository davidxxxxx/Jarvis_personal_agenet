import { describe, expect, it, vi } from "vitest";
import { createLatestRefresh } from "../useJarvisRecording";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("latest refresh coordinator", () => {
  it("does not let a stale initial response overwrite a newer lifecycle refresh", async () => {
    const initial = deferred<string[]>();
    const lifecycle = deferred<string[]>();
    const commit = vi.fn();
    const refresh = createLatestRefresh(commit, vi.fn());

    const initialRequest = refresh.run(() => initial.promise);
    const lifecycleRequest = refresh.run(() => lifecycle.promise);
    lifecycle.resolve(["new lifecycle state"]);
    await lifecycleRequest;
    initial.resolve(["stale initial state"]);
    await initialRequest;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(["new lifecycle state"]);
  });
});
