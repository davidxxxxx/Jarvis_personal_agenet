import { create } from "zustand";
import type {
  JarvisCaptureMode,
  JarvisCaptureSourceState,
  JarvisCaptureSourceStates,
  JarvisControlAction,
  JarvisPerson,
  JarvisRetentionMode,
  JarvisEffectiveRetentionMode,
  JarvisSession,
} from "../types";
import { initialSessionState, type SessionState } from "./sessionMachine";

export type JarvisView = "today" | "people" | "topics" | "todos" | "memory";

interface JarvisRendererState {
  session: SessionState;
  sessions: JarvisSession[];
  people: JarvisPerson[];
  selectedView: JarvisView;
  operation: JarvisControlAction | null;
  error: string | null;
  captureMode: JarvisCaptureMode;
  retentionMode: JarvisRetentionMode;
  effectiveRetentionMode: JarvisEffectiveRetentionMode | null;
  retentionDegradedReason: string | null;
  sourceStates: JarvisCaptureSourceStates;
  setSession: (session: SessionState) => void;
  setSessions: (sessions: JarvisSession[]) => void;
  setPeople: (people: JarvisPerson[]) => void;
  setSelectedView: (view: JarvisView) => void;
  setOperation: (operation: JarvisControlAction | null) => void;
  setError: (error: string | null) => void;
  setCaptureMode: (captureMode: JarvisCaptureMode) => void;
  setRetentionMode: (retentionMode: JarvisRetentionMode) => void;
  setRetentionRuntime: (
    effectiveRetentionMode: JarvisEffectiveRetentionMode | null,
    retentionDegradedReason: string | null
  ) => void;
  setSourceStates: (sourceStates: JarvisCaptureSourceStates) => void;
  setSourceState: (source: "mic" | "system", state: JarvisCaptureSourceState) => void;
}

export const useJarvisStore = create<JarvisRendererState>()((set) => ({
  session: initialSessionState,
  sessions: [],
  people: [],
  selectedView: "today",
  operation: null,
  error: null,
  captureMode: "mic",
  retentionMode: "speech_triggered",
  effectiveRetentionMode: null,
  retentionDegradedReason: null,
  sourceStates: { mic: "idle", system: "idle" },
  setSession: (session) => set({ session }),
  setSessions: (sessions) => set({ sessions }),
  setPeople: (people) => set({ people }),
  setSelectedView: (selectedView) => set({ selectedView }),
  setOperation: (operation) => set({ operation }),
  setError: (error) => set({ error }),
  setCaptureMode: (captureMode) => set({ captureMode }),
  setRetentionMode: (retentionMode) => set({ retentionMode }),
  setRetentionRuntime: (effectiveRetentionMode, retentionDegradedReason) =>
    set({ effectiveRetentionMode, retentionDegradedReason }),
  setSourceStates: (sourceStates) => set({ sourceStates }),
  setSourceState: (source, state) =>
    set((current) => ({ sourceStates: { ...current.sourceStates, [source]: state } })),
}));
