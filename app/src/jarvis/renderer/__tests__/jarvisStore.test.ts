import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisSpeakerClusterView } from "../../types";
import { useJarvisStore } from "../jarvisStore";

function cluster(
  sessionId: string,
  id: string,
  updatedAt: number,
  localLabel = "speaker_1"
): JarvisSpeakerClusterView {
  return {
    id,
    sessionId,
    trackId: null,
    localLabel,
    linkState: "unknown",
    person: null,
    suggestedPerson: null,
    lastRejectedPerson: null,
    score: null,
    margin: null,
    candidatePersonRef: null,
    speechMs: 0,
    windowCount: 0,
    qualityScore: null,
    reason: "unresolved",
    policyId: "unresolved",
    diarizationRevision: "",
    profileRevision: "",
    evidenceSegmentIds: [`${sessionId}-segment`],
    canUndo: false,
    updatedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("jarvisStore speaker correction state", () => {
  beforeEach(() => {
    useJarvisStore.setState({
      clustersBySession: {},
      speakerCorrectionBusyClusterId: null,
      speakerCorrectionError: null,
      speakerCorrectionErrorClusterId: null,
      speakerCorrectionCandidates: [],
      speakerCorrectionCandidateClusterId: null,
      people: [],
    });
  });

  it("keys same local labels by session and ignores a stale load after a mutation", async () => {
    const late = deferred<JarvisSpeakerClusterView[]>();
    const listSessionSpeakerClusters = vi
      .fn()
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValueOnce([cluster("session-b", "cluster-b", 2)]);
    const confirmed = {
      ...cluster("session-a", "cluster-a", 5),
      linkState: "confirmed" as const,
      person: { id: "p1", displayName: "Alice", isSelf: false },
      canUndo: true,
    };
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          listSessionSpeakerClusters,
          confirmSpeaker: vi.fn(async () => ({
            cluster: confirmed,
            profileSampleAdded: false,
            profileSampleReason: "session_scope",
            createdPerson: false,
          })),
        },
      },
    });

    const loadA = useJarvisStore.getState().loadSessionClusters("session-a");
    await useJarvisStore.getState().loadSessionClusters("session-b");
    await useJarvisStore.getState().confirmSpeaker({
      clusterId: "cluster-a",
      personId: "p1",
      scope: "session",
    });
    late.resolve([cluster("session-a", "cluster-a", 1)]);
    await loadA;

    expect(useJarvisStore.getState().clustersBySession).toEqual({
      "session-a": [confirmed],
      "session-b": [cluster("session-b", "cluster-b", 2)],
    });
  });

  it("keeps authoritative state on failure and suppresses concurrent double submit", async () => {
    const pending = deferred<{
      cluster: JarvisSpeakerClusterView;
      profileSampleAdded: boolean;
      profileSampleReason: "session_scope";
      createdPerson: boolean;
    }>();
    const before = cluster("session-a", "cluster-a", 1);
    const confirmSpeaker = vi.fn(() => pending.promise);
    Object.assign(window, {
      electronAPI: { jarvis: { confirmSpeaker } },
    });
    useJarvisStore.setState({ clustersBySession: { "session-a": [before] } });

    const first = useJarvisStore.getState().confirmSpeaker({
      clusterId: "cluster-a",
      personId: "p1",
      scope: "session",
    });
    const second = useJarvisStore.getState().confirmSpeaker({
      clusterId: "cluster-a",
      personId: "p1",
      scope: "session",
    });
    expect(confirmSpeaker).toHaveBeenCalledTimes(1);
    const after = { ...before, updatedAt: 2 };
    pending.resolve({
      cluster: after,
      profileSampleAdded: false,
      profileSampleReason: "session_scope",
      createdPerson: false,
    });
    await act(async () => Promise.all([first, second]));
    expect(useJarvisStore.getState().clustersBySession["session-a"]).toEqual([after]);

    confirmSpeaker.mockRejectedValueOnce(new Error("x".repeat(500)));
    await expect(
      useJarvisStore.getState().confirmSpeaker({
        clusterId: "cluster-a",
        personId: "p2",
        scope: "session",
      })
    ).rejects.toThrow();
    expect(useJarvisStore.getState().clustersBySession["session-a"]).toEqual([after]);
    expect(useJarvisStore.getState().speakerCorrectionError?.length).toBeLessThanOrEqual(240);
    expect(
      (
        useJarvisStore.getState() as unknown as {
          speakerCorrectionErrorClusterId?: string | null;
        }
      ).speakerCorrectionErrorClusterId
    ).toBe("cluster-a");
  });

  it("forces a post-merge cluster reload instead of reusing a pre-merge in-flight list", async () => {
    const stale = deferred<JarvisSpeakerClusterView[]>();
    const before = {
      ...cluster("session-a", "cluster-a", 1),
      linkState: "confirmed" as const,
      person: { id: "p-source", displayName: "Source", isSelf: false },
    };
    const after = {
      ...before,
      person: { id: "p-target", displayName: "Target", isSelf: false },
      updatedAt: 2,
    };
    const listSessionSpeakerClusters = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce([after]);
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          listSessionSpeakerClusters,
          mergePeople: vi.fn(async () => ({})),
          listPeople: vi.fn(async () => []),
        },
      },
    });
    useJarvisStore.setState({ clustersBySession: { "session-a": [before] } });

    const preMergeLoad = useJarvisStore.getState().loadSessionClusters("session-a");
    const merge = useJarvisStore.getState().mergePeople("p-source", "p-target");

    await vi.waitFor(() => expect(listSessionSpeakerClusters).toHaveBeenCalledTimes(2));
    await merge;
    stale.resolve([before]);
    await preMergeLoad;

    expect(useJarvisStore.getState().clustersBySession["session-a"]).toEqual([after]);
  });
});
