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
  JarvisContinuousSeekResult,
  JarvisEvidenceContext,
  JarvisEvidenceHandle,
  JarvisEvidenceNavigationState,
} from "../types";
import { initialSessionState, type SessionState } from "./sessionMachine";

export type JarvisView = "today" | "people" | "topics" | "todos" | "memory" | "storage";

const speakerClusterLoads = new Map<string, Promise<void>>();
const speakerClusterMutations = new Map<string, Promise<unknown>>();

function safeCorrectionError(): string {
  return "speaker_correction_failed";
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
  speakerCorrectionErrorClusterId: string | null;
  speakerCorrectionCandidates: JarvisSpeakerPersonSummary[];
  speakerCorrectionCandidateClusterId: string | null;
  selectedView: JarvisView;
  selectedSessionId: string | null;
  evidenceNavigation: JarvisEvidenceNavigationState;
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
  openEvidence: (handle: JarvisEvidenceHandle) => Promise<void>;
  markEvidenceSessionOpened: (requestId: number) => void;
  failEvidenceSession: (requestId: number) => void;
  acknowledgeEvidencePlayback: (requestId: number, result: JarvisContinuousSeekResult) => void;
  clearEvidenceNavigation: () => void;
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
  speakerCorrectionErrorClusterId: null,
  speakerCorrectionCandidates: [],
  speakerCorrectionCandidateClusterId: null,
  selectedView: "today",
  selectedSessionId: null,
  evidenceNavigation: { phase: "idle", requestId: 0 },
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
  setSelectedView: (selectedView) =>
    set((current) =>
      selectedView !== "memory" && current.evidenceNavigation.phase !== "idle"
        ? {
            selectedView,
            selectedSessionId: null,
            evidenceNavigation: {
              phase: "idle" as const,
              requestId: current.evidenceNavigation.requestId + 1,
            },
          }
        : { selectedView }
    ),
  openEvidence: async (handle) => {
    const requestId = get().evidenceNavigation.requestId + 1;
    set({ evidenceNavigation: { phase: "resolving", requestId, handle } });
    try {
      const api = window.electronAPI?.jarvis as unknown as {
        getEvidenceContext?: (value: JarvisEvidenceHandle) => Promise<JarvisEvidenceContext | null>;
      };
      if (typeof api.getEvidenceContext !== "function") throw new Error("unavailable");
      const context = await api.getEvidenceContext(handle);
      if (get().evidenceNavigation.requestId !== requestId) return;
      if (!context) {
        set({
          evidenceNavigation: { phase: "failed", requestId, code: "evidence_not_found" },
        });
        return;
      }
      set({
        selectedView: "memory",
        selectedSessionId: context.sessionId,
        evidenceNavigation: { phase: "opening_session", requestId, context },
      });
    } catch {
      if (get().evidenceNavigation.requestId !== requestId) return;
      set({
        evidenceNavigation: { phase: "failed", requestId, code: "evidence_navigation_failed" },
      });
    }
  },
  markEvidenceSessionOpened: (requestId) =>
    set((current) => {
      const navigation = current.evidenceNavigation;
      if (navigation.requestId !== requestId || navigation.phase !== "opening_session") return {};
      if (navigation.context.audioState === "expired") {
        return {
          evidenceNavigation: {
            phase: "transcript_only" as const,
            requestId,
            context: navigation.context,
            reason: "audio_expired" as const,
          },
        };
      }
      if (navigation.context.audioState === "missing") {
        return {
          evidenceNavigation: {
            phase: "transcript_only" as const,
            requestId,
            context: navigation.context,
            reason: "audio_missing" as const,
          },
        };
      }
      return {
        evidenceNavigation: {
          phase: "seeking" as const,
          requestId,
          context: navigation.context,
        },
      };
    }),
  failEvidenceSession: (requestId) =>
    set((current) =>
      current.evidenceNavigation.requestId === requestId
        ? {
            evidenceNavigation: {
              phase: "failed" as const,
              requestId,
              code: "session_unavailable" as const,
            },
          }
        : {}
    ),
  acknowledgeEvidencePlayback: (requestId, result) =>
    set((current) => {
      const navigation = current.evidenceNavigation;
      if (navigation.requestId !== requestId || navigation.phase !== "seeking") return {};
      return result === "playing"
        ? {
            evidenceNavigation: {
              phase: "playing" as const,
              requestId,
              context: navigation.context,
            },
          }
        : {
            evidenceNavigation: {
              phase: "transcript_only" as const,
              requestId,
              context: navigation.context,
              reason: "audio_became_unavailable" as const,
            },
          };
    }),
  clearEvidenceNavigation: () =>
    set((current) => ({
      selectedSessionId: null,
      evidenceNavigation: { phase: "idle", requestId: current.evidenceNavigation.requestId + 1 },
    })),
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
        set({
          speakerCorrectionError: safeCorrectionError(),
          speakerCorrectionErrorClusterId: null,
        });
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
        speakerCorrectionErrorClusterId: null,
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
          speakerCorrectionError: safeCorrectionError(),
          speakerCorrectionErrorClusterId: input.clusterId,
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
        speakerCorrectionErrorClusterId: null,
        speakerCorrectionCandidates: [],
        speakerCorrectionCandidateClusterId: null,
      });
      try {
        const cluster = await window.electronAPI.jarvis.rejectSpeaker(clusterId, personId);
        get().applyClusterView(cluster);
        return cluster;
      } catch (error) {
        set({
          speakerCorrectionError: safeCorrectionError(),
          speakerCorrectionErrorClusterId: clusterId,
        });
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
        speakerCorrectionErrorClusterId: null,
        speakerCorrectionCandidates: [],
        speakerCorrectionCandidateClusterId: null,
      });
      try {
        const cluster = await window.electronAPI.jarvis.undoSpeakerCorrection(clusterId);
        get().applyClusterView(cluster);
        return cluster;
      } catch (error) {
        set({
          speakerCorrectionError: safeCorrectionError(),
          speakerCorrectionErrorClusterId: clusterId,
        });
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
      speakerCorrectionErrorClusterId: null,
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
      set({
        speakerCorrectionError: safeCorrectionError(),
        speakerCorrectionErrorClusterId: null,
      });
      throw error;
    }
  },
}));
