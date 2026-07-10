import type { JarvisControlAction, JarvisControlEnvelope } from "../types";

export type JarvisControlOutcome = "ok" | "duplicate" | "expired" | "error";

export function createJarvisControlReceiver({
  route,
  acknowledge,
  now = Date.now,
  maxSeen = 128,
}: {
  route: (action: JarvisControlAction) => Promise<void>;
  acknowledge: (id: string, outcome: JarvisControlOutcome) => void | Promise<void>;
  now?: () => number;
  maxSeen?: number;
}) {
  const seen = new Map<string, true>();
  const remember = (id: string) => {
    seen.delete(id);
    seen.set(id, true);
    while (seen.size > maxSeen) seen.delete(seen.keys().next().value as string);
  };

  return {
    handle: async (envelope: JarvisControlEnvelope): Promise<void> => {
      if (seen.has(envelope.id)) {
        await acknowledge(envelope.id, "duplicate");
        return;
      }
      remember(envelope.id);
      if (envelope.expiresAt < now()) {
        await acknowledge(envelope.id, "expired");
        return;
      }
      try {
        await route(envelope.action);
        await acknowledge(envelope.id, "ok");
      } catch {
        await acknowledge(envelope.id, "error");
      }
    },
  };
}
