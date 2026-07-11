import type { JarvisControlAction, JarvisControlEnvelope } from "../types";

export type JarvisControlOutcome = "ok" | "error";
export type JarvisControlClaim = {
  status: "claimed" | "not_ready" | "duplicate" | "expired" | "failed" | "in_flight" | "unknown";
};

export function createJarvisControlReceiver({
  claim,
  route,
  acknowledge,
  maxSeen = 128,
}: {
  claim: (id: string) => Promise<JarvisControlClaim>;
  route: (action: JarvisControlAction) => Promise<void>;
  acknowledge: (id: string, outcome: JarvisControlOutcome) => void | Promise<void>;
  maxSeen?: number;
}) {
  const completed = new Map<string, true>();
  const inFlight = new Map<string, Promise<void>>();
  const remember = (id: string) => {
    completed.delete(id);
    completed.set(id, true);
    while (completed.size > maxSeen) completed.delete(completed.keys().next().value as string);
  };

  return {
    handle(envelope: JarvisControlEnvelope): Promise<void> {
      if (completed.has(envelope.id)) return Promise.resolve();
      const existing = inFlight.get(envelope.id);
      if (existing) return existing;

      const execution = (async () => {
        const result = await claim(envelope.id);
        if (result.status !== "claimed") return;
        try {
          await route(envelope.action);
          await acknowledge(envelope.id, "ok");
        } catch {
          await acknowledge(envelope.id, "error");
        }
      })().finally(() => {
        inFlight.delete(envelope.id);
        remember(envelope.id);
      });
      inFlight.set(envelope.id, execution);
      return execution;
    },
  };
}
