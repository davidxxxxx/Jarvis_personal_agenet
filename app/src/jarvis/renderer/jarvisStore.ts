import { create } from "zustand";
import type {
  JarvisCaptureMode,
  JarvisCaptureSourceState,
  JarvisCaptureSourceStates,
  JarvisControlAction,
  JarvisPerson,
  JarvisPersonDetail,
  JarvisRetentionMode,
  JarvisEffectiveRetentionMode,
  JarvisSession,
  JarvisConfirmSpeakerInput,
  JarvisSpeakerClusterView,
  JarvisSpeakerConfirmationResult,
  JarvisSpeakerPersonSummary,
} from "../types";
import { initialSessionState, type SessionState } from "./sessionMachine";

export type JarvisView = "today" | "people" | "topics" | "todos" | "memory" | "storage";

const speakerClusterLoads = new Map<string, Promise<void>>();
const speakerClusterMutations = new Map<string, Promise<unknown>>();

function boundedCorrectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240);
}

function publicAmbiguousCandidates(error: unknown): JarvisSpeakerPersonSummary[] {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "ambiguous_duplicate_name" ||
    !("candidates" in error) ||
    !Array.isArray(error.candidates)
  ) {
    return [];
  }
  return error.candidates.filter(
    (candidate): candidate is JarvisSpeakerPersonSummary =>
      candidate !== null &&
      typeof candidate === "object" &&
      "id" in candidate &&
      typeof candidate.id === "string" &&
      "displayName" in candidate &&
      typeof candidate.displayName === "string" &&
      "isSelf" in candidate &&
      typeof candidate.isSelf === "boolean"
  );
}

function mergeAuthoritativeCluster(
  current: JarvisSpeakerClusterView[],
  next: JarvisSpeakerClusterView
): JarvisSpeakerClusterView[] {
  const existing = current.find((cluster) => cluster.id === next.id);
  if (existing && existing.updatedAt > next.updatedAt) return current;
  return [...current.filter((cluster) => cluster.id !== next.id), next].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

interface JarvisRendererState {
  session: SessionState;
  sessions: JarvisSession[];
  people: JarvisPerson[];
  clustersBySession: Record<string, JarvisSpeakerClusterView[]>;
  speakerCorrectionBusyClusterId: string | null;
  speakerCorrectionError: string | null;
  speakerCorrectionCandidates: JarvisSpeakerPersonSummary[];
  speakerCorrectionCandidateClusterId: string | null;
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
  loadSessionClusters: (sessionId: string) => Promise<void>;
  applyClusterView: (view: JarvisSpeakerClusterView) => void;
  confirmSpeaker: (input: JarvisConfirmSpeakerInput) => Promise<JarvisSpeakerConfirmationResult>;
  rejectSpeaker: (clusterId: string, personId: string) => Promise<JarvisSpeakerClusterView>;
  undoSpeaker: (clusterId: string) => Promise<JarvisSpeakerClusterView>;
  refreshPeople: () => Promise<void>;
  mergePeople: (sourcePersonId: string, targetPersonId: string) => Promise<JarvisPersonDetail>;
}

export const useJarvisStore = create<JarvisRendererState>()((set, get) => ({
  session: initialSessionState,
  sessions: [],
  people: [],
  clustersBySession: {},
  speakerCorrectionBusyClusterId: null,
  speakerCorrectionError: null,
  speakerCorrectionCandidates: [],
  speakerCorrectionCandidateClusterId: null,
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
  loadSessionClusters: (sessionId) => {
    const existing = speakerClusterLoads.get(sessionId);
    if (existing) return existing;
    const request = window.electronAPI.jarvis
      .listSessionSpeakerClusters(sessionId)
      .then((clusters) => {
        set((current) => ({
          clustersBySession: {
            ...current.clustersBySession,
            [sessionId]: clusters.reduce(
              (merged, cluster) => mergeAuthoritativeCluster(merged, cluster),
              current.clustersBySession[sessionId] ?? []
            ),
          },
        }));
      })
      .catch((error) => {
        set({ speakerCorrectionError: boundedCorrectionError(error) });
        throw error;
      })
      .finally(() => {
        if (speakerClusterLoads.get(sessionId) === request) {
          speakerClusterLoads.delete(sessionId);
        }
      });
    speakerClusterLoads.set(sessionId, request);
    return request;
  },
  applyClusterView: (view) =>
    set((current) => ({
      clustersBySession: {
        ...current.clustersBySession,
        [view.sessionId]: mergeAuthoritativeCluster(
          current.clustersBySession[view.sessionId] ?? [],
          view
        ),
      },
    })),
  confirmSpeaker: (input) => {
    const existing = speakerClusterMutations.get(input.clusterId);
    if (existing) return existing as Promise<JarvisSpeakerConfirmationResult>;
    const request = (async () => {
      set({
        speakerCorrectionBusyClusterId: input.clusterId,
        speakerCorrectionError: null,
        speakerCorrectionCandidates: [],
        speakerCorrectionCandidateClusterId: null,
      });
      try {
        const result = await window.electronAPI.jarvis.confirmSpeaker(input);
        get().applyClusterView(result.cluster);
        return result;
      } catch (error) {
        const candidates = publicAmbiguousCandidates(error);
        set({
          speakerCorrectionError: boundedCorrectionError(error),
          speakerCorrectionCandidates: candidates,
          speakerCorrectionCandidateClusterId: candidates.length > 0 ? input.clusterId : null,
        });
        throw error;
      } finally {
        speakerClusterMutations.delete(input.clusterId);
        if (get().speakerCorrectionBusyClusterId === input.clusterId) {
          set({ speakerCorrectionBusyClusterId: null });
        }
      }
    })();
    speakerClusterMutations.set(input.clusterId, request);
    return request;
  },
  rejectSpeaker: (clusterId, personId) => {
    const existing = speakerClusterMutations.get(clusterId);
    if (existing) return existing as Promise<JarvisSpeakerClusterView>;
    const request = (async () => {
      set({
        speakerCorrectionBusyClusterId: clusterId,
        speakerCorrectionError: null,
        speakerCorrectionCandidates: [],
        speakerCorrectionCandidateClusterId: null,
      });
      try {
        const cluster = await window.electronAPI.jarvis.rejectSpeaker(clusterId, personId);
        get().applyClusterView(cluster);
        return cluster;
      } catch (error) {
        set({ speakerCorrectionError: boundedCorrectionError(error) });
        throw error;
      } finally {
        speakerClusterMutations.delete(clusterId);
        if (get().speakerCorrectionBusyClusterId === clusterId) {
          set({ speakerCorrectionBusyClusterId: null });
        }
      }
    })();
    speakerClusterMutations.set(clusterId, request);
    return request;
  },
  undoSpeaker: (clusterId) => {
    const existing = speakerClusterMutations.get(clusterId);
    if (existing) return existing as Promise<JarvisSpeakerClusterView>;
    const request = (async () => {
      set({
        speakerCorrectionBusyClusterId: clusterId,
        speakerCorrectionError: null,
        speakerCorrectionCandidates: [],
        speakerCorrectionCandidateClusterId: null,
      });
      try {
        const cluster = await window.electronAPI.jarvis.undoSpeakerCorrection(clusterId);
        get().applyClusterView(cluster);
        return cluster;
      } catch (error) {
        set({ speakerCorrectionError: boundedCorrectionError(error) });
        throw error;
      } finally {
        speakerClusterMutations.delete(clusterId);
        if (get().speakerCorrectionBusyClusterId === clusterId) {
          set({ speakerCorrectionBusyClusterId: null });
        }
      }
    })();
    speakerClusterMutations.set(clusterId, request);
    return request;
  },
  refreshPeople: async () => {
    set({ people: await window.electronAPI.jarvis.listPeople() });
  },
  mergePeople: async (sourcePersonId, targetPersonId) => {
    set({
      speakerCorrectionError: null,
      speakerCorrectionCandidates: [],
      speakerCorrectionCandidateClusterId: null,
    });
    try {
      const detail = await window.electronAPI.jarvis.mergePeople(sourcePersonId, targetPersonId);
      await get().refreshPeople();
      const cachedSessionIds = Object.keys(get().clustersBySession);
      for (const sessionId of cachedSessionIds) speakerClusterLoads.delete(sessionId);
      await Promise.all(cachedSessionIds.map((sessionId) => get().loadSessionClusters(sessionId)));
      return detail;
    } catch (error) {
      set({ speakerCorrectionError: boundedCorrectionError(error) });
      throw error;
    }
  },
}));
