export type SessionStatus =
  "idle" | "starting" | "recording" | "paused" | "finalizing" | "completed" | "failed";

export type SessionState = {
  id: string | null;
  status: SessionStatus;
  startedAt: number | null;
  activeSince: number | null;
  accumulatedMs: number;
  errorCode: string | null;
};

export type SessionEvent =
  | { type: "STARTING"; id: string; at: number }
  | { type: "STARTED"; id: string; at: number }
  | { type: "PAUSED"; at: number }
  | { type: "RESUMED"; at: number }
  | { type: "ROTATED"; id: string; at: number }
  | { type: "FINISHED"; at: number }
  | { type: "COMPLETED" }
  | { type: "FAILED"; code: string };

export const initialSessionState: SessionState = {
  id: null,
  status: "idle",
  startedAt: null,
  activeSince: null,
  accumulatedMs: 0,
  errorCode: null,
};

const EVENT_ACTION: Record<SessionEvent["type"], string> = {
  STARTING: "start",
  STARTED: "start",
  PAUSED: "pause",
  RESUMED: "resume",
  ROTATED: "rotate",
  FINISHED: "finish",
  COMPLETED: "complete",
  FAILED: "fail",
};

function impossible(state: SessionState, event: SessionEvent): never {
  throw new Error(`cannot ${EVENT_ACTION[event.type]} from ${state.status}`);
}

function assertId(id: string): void {
  if (!id) throw new TypeError("session id must not be empty");
}

function assertTime(at: number): void {
  if (!Number.isSafeInteger(at)) throw new TypeError("session time must be a safe integer");
}

function addActiveTime(state: SessionState, at: number): number {
  if (state.activeSince === null) throw new Error("recording session has no active start time");
  return state.accumulatedMs + Math.max(0, at - state.activeSince);
}

export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "STARTING": {
      if (!(["idle", "completed", "failed"] as SessionStatus[]).includes(state.status)) {
        return impossible(state, event);
      }
      assertId(event.id);
      assertTime(event.at);
      return {
        id: event.id,
        status: "starting",
        startedAt: event.at,
        activeSince: null,
        accumulatedMs: 0,
        errorCode: null,
      };
    }
    case "STARTED": {
      if (state.status !== "idle" && state.status !== "starting") return impossible(state, event);
      assertId(event.id);
      assertTime(event.at);
      if (state.status === "starting" && state.id !== event.id) {
        throw new Error("cannot start a different session while starting");
      }
      return {
        id: event.id,
        status: "recording",
        startedAt: state.status === "starting" ? state.startedAt : event.at,
        activeSince: event.at,
        accumulatedMs: 0,
        errorCode: null,
      };
    }
    case "PAUSED": {
      if (state.status !== "recording") return impossible(state, event);
      assertTime(event.at);
      return {
        ...state,
        status: "paused",
        activeSince: null,
        accumulatedMs: addActiveTime(state, event.at),
      };
    }
    case "RESUMED": {
      if (state.status !== "paused") return impossible(state, event);
      assertTime(event.at);
      return { ...state, status: "recording", activeSince: event.at, errorCode: null };
    }
    case "ROTATED": {
      if (state.status !== "recording") return impossible(state, event);
      assertId(event.id);
      assertTime(event.at);
      return {
        id: event.id,
        status: "recording",
        startedAt: event.at,
        activeSince: event.at,
        accumulatedMs: 0,
        errorCode: null,
      };
    }
    case "FINISHED": {
      if (state.status !== "recording" && state.status !== "paused") {
        return impossible(state, event);
      }
      assertTime(event.at);
      return {
        ...state,
        status: "finalizing",
        activeSince: null,
        accumulatedMs:
          state.status === "recording" ? addActiveTime(state, event.at) : state.accumulatedMs,
      };
    }
    case "COMPLETED":
      if (state.status !== "finalizing") return impossible(state, event);
      return { ...state, status: "completed", activeSince: null, errorCode: null };
    case "FAILED":
      if (
        !(["starting", "recording", "paused", "finalizing"] as SessionStatus[]).includes(
          state.status
        )
      ) {
        return impossible(state, event);
      }
      if (!event.code) throw new TypeError("error code must not be empty");
      return { ...state, status: "failed", activeSince: null, errorCode: event.code };
  }
}
