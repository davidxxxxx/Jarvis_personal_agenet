import { create } from "zustand";
import type { JarvisPerson, JarvisSession } from "../types";
import { initialSessionState, type SessionState } from "./sessionMachine";

export type JarvisView = "today" | "people" | "topics" | "todos" | "memory";

interface JarvisRendererState {
  session: SessionState;
  sessions: JarvisSession[];
  people: JarvisPerson[];
  selectedView: JarvisView;
  error: string | null;
  setSession: (session: SessionState) => void;
  setSessions: (sessions: JarvisSession[]) => void;
  setPeople: (people: JarvisPerson[]) => void;
  setSelectedView: (view: JarvisView) => void;
  setError: (error: string | null) => void;
}

export const useJarvisStore = create<JarvisRendererState>()((set) => ({
  session: initialSessionState,
  sessions: [],
  people: [],
  selectedView: "today",
  error: null,
  setSession: (session) => set({ session }),
  setSessions: (sessions) => set({ sessions }),
  setPeople: (people) => set({ people }),
  setSelectedView: (selectedView) => set({ selectedView }),
  setError: (error) => set({ error }),
}));
