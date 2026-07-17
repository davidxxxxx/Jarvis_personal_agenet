import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type { JarvisPersonDetail, JarvisPersonOverview } from "../../types";
import PeopleView from "../PeopleView";
import { useJarvisStore } from "../jarvisStore";

function person(id: string, name: string, isSelf = false): JarvisPersonOverview {
  return {
    id,
    display_name: name,
    is_self: isSelf ? 1 : 0,
    voice_profile_id: null,
    voice_confidence: null,
    created_at: 1,
    last_seen_at: 1,
    session_count: 1,
    open_todo_count: 0,
    last_interaction_at: 2,
  };
}

function detail(value: JarvisPersonOverview): JarvisPersonDetail {
  return {
    person: value,
    sessions: [],
    todos: [],
    memories: [],
    topics: [],
    identity: {
      samples: [
        {
          id: "sample-1",
          modelId: "campplus-v1",
          sourceKind: "user_confirmed",
          sourceClusterId: "cluster-1",
          speechMs: 18_000,
          windowCount: 4,
          createdAt: 3,
        },
      ],
      appearances: [
        {
          clusterId: "cluster-1",
          sessionId: "session-1",
          localLabel: "speaker_1",
          linkState: "confirmed",
          score: 0.84,
          margin: 0.17,
          updatedAt: 4,
        },
      ],
      corrections: [
        {
          id: "correction-1",
          clusterId: "cluster-1",
          previousPersonId: null,
          nextPersonId: value.id,
          previousPersonRef: null,
          nextPersonRef: value.id,
          previousState: "unknown",
          nextState: "confirmed",
          scope: "persistent",
          actor: "user",
          correctionKind: "link",
          createdAt: 4,
          undoneAt: 5,
        },
        {
          id: "correction-2",
          clusterId: "cluster-1",
          previousPersonId: value.id,
          nextPersonId: value.id,
          previousPersonRef: value.id,
          nextPersonRef: value.id,
          previousState: "confirmed",
          nextState: "confirmed",
          scope: "session",
          actor: "system",
          correctionKind: "merge",
          createdAt: 6,
          undoneAt: null,
        },
      ],
    },
  };
}

describe("PeopleView durable identity detail", () => {
  const source = person("p-source", "Source Person");
  const target = person("p-target", "Target Person");
  const self = person("self", "Me", true);
  const mergePeople = vi.fn();
  const listPeople = vi.fn();
  const listSessionSpeakerClusters = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mergePeople.mockReset();
    listPeople.mockReset();
    listPeople.mockResolvedValue([source, target, self]);
    listSessionSpeakerClusters.mockReset();
    listSessionSpeakerClusters.mockResolvedValue([]);
    useJarvisStore.setState({ clustersBySession: {}, people: [] });
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          listPeopleOverview: vi.fn(async () => [source, target, self]),
          getPersonDetail: vi.fn(async (id: string) =>
            detail([source, target, self].find((entry) => entry.id === id) ?? source)
          ),
          mergePeople,
          listPeople,
          listSessionSpeakerClusters,
        },
      },
    });
  });

  it("renders localized identity metadata and complete correction provenance without private data", async () => {
    render(<PeopleView />);
    fireEvent.click(await screen.findByRole("button", { name: /Source Person/ }));

    expect(await screen.findByText("campplus-v1")).toBeInTheDocument();
    expect(screen.getByText(/18,000 ms/)).toBeInTheDocument();
    expect(screen.getByText(/session-1/)).toBeInTheDocument();
    expect(screen.getByText(/User-confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/speaker_1.*Confirmed/)).toBeInTheDocument();
    expect(screen.getByText("Unknown → Confirmed")).toBeInTheDocument();
    expect(screen.getByText("Confirmed → Confirmed")).toBeInTheDocument();
    expect(screen.getByText(/Persistent.*User.*Link/)).toBeInTheDocument();
    expect(screen.getByText(/Session.*System.*Merge/)).toBeInTheDocument();
    expect(screen.getAllByText(/Created/)).toHaveLength(2);
    expect(screen.getByText(/Undone/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("user_confirmed");
    expect(document.body.textContent).not.toContain("persistent · user · link");
    expect(document.body.textContent).not.toMatch(/embedding|\.wav|[A-Z]:\\/i);
  });

  it("summarizes only durably attributed person sources and keeps suggestions separate", async () => {
    const attributed = detail(source);
    attributed.sessions = [
      {
        id: "session-1",
        started_at: Date.UTC(2026, 6, 11, 1, 0),
        ended_at: Date.UTC(2026, 6, 11, 1, 30),
        status: "completed",
        mic_device_id: null,
        language: "zh",
        created_at: Date.UTC(2026, 6, 11, 1, 0),
        capture_mode: "mic",
      },
    ];
    attributed.memories = [
      {
        id: "memory-person-1",
        type: "fact",
        content: "Budget stays local.",
        person_id: source.id,
        topic_id: null,
        confidence: 0.9,
        last_seen_at: Date.UTC(2026, 6, 11, 1, 10),
        occurrence_count: 2,
        needs_confirmation: 0,
      },
    ];
    attributed.identity.appearances.push({
      clusterId: "cluster-suggested",
      sessionId: "session-suggested",
      localLabel: "speaker_2",
      linkState: "suggested",
      score: 0.72,
      margin: 0.04,
      updatedAt: 7,
    });
    const getKnowledgeOverview = vi.fn(async () => ({
      memories: [
        {
          id: "unattributed",
          title: "Must not be joined by renderer",
          body: "Unrelated knowledge quote",
        },
      ],
    }));
    window.electronAPI.jarvis.getPersonDetail = vi.fn(async () => attributed);
    window.electronAPI.jarvis.getKnowledgeOverview = getKnowledgeOverview as never;

    render(<PeopleView />);
    fireEvent.click(await screen.findByRole("button", { name: /Source Person/ }));

    expect(await screen.findByRole("heading", { name: /Persistent source summary/ })).toBeVisible();
    expect(screen.getByText(/1 confirmed speaker source/)).toBeVisible();
    expect(screen.getByText(/1 suggested match \(not confirmed\)/)).toBeVisible();
    expect(screen.getByText(/1 saved memory/)).toBeVisible();
    expect(screen.getByText("Budget stays local.")).toBeVisible();
    expect(screen.getByText(/2 supporting occurrences/)).toBeVisible();
    expect(screen.queryByText("Unrelated knowledge quote")).not.toBeInTheDocument();
    expect(getKnowledgeOverview).not.toHaveBeenCalled();
  });

  it("cancels without IPC and confirms an explicitly irreversible merge once", async () => {
    const cachedCluster = {
      id: "cluster-cached",
      sessionId: "session-cached",
      trackId: null,
      localLabel: "speaker_1",
      linkState: "confirmed" as const,
      person: { id: source.id, displayName: source.display_name, isSelf: false },
      suggestedPerson: null,
      lastRejectedPerson: null,
      score: 0.9,
      margin: 0.2,
      reason: "confirmed",
      policyId: "policy",
      diarizationRevision: "a".repeat(64),
      profileRevision: "b".repeat(64),
      evidenceSegmentIds: ["segment-1"],
      canUndo: false,
      updatedAt: 1,
    };
    useJarvisStore.setState({
      clustersBySession: { "session-cached": [cachedCluster] },
    });
    listSessionSpeakerClusters.mockResolvedValue([
      {
        ...cachedCluster,
        person: { id: target.id, displayName: target.display_name, isSelf: false },
        updatedAt: 2,
      },
    ]);
    mergePeople.mockResolvedValue(detail(target));
    render(<PeopleView />);
    fireEvent.click(await screen.findByRole("button", { name: /Source Person/ }));
    await screen.findByText("campplus-v1");
    fireEvent.change(screen.getByLabelText("Merge into"), { target: { value: "p-target" } });
    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));

    expect(
      screen.getByText(/Merge Source Person into Target Person.*cannot be undone/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mergePeople).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge people" }));
    await waitFor(() => expect(mergePeople).toHaveBeenCalledTimes(1));
    expect(mergePeople).toHaveBeenCalledWith("p-source", "p-target");
    await waitFor(() => expect(listSessionSpeakerClusters).toHaveBeenCalledWith("session-cached"));
    expect(useJarvisStore.getState().clustersBySession["session-cached"][0].person?.id).toBe(
      "p-target"
    );
  });

  it("does not offer self as a merge source", async () => {
    render(<PeopleView />);
    fireEvent.click(await screen.findByRole("button", { name: /Me/ }));
    await screen.findByText("campplus-v1");
    expect(screen.queryByLabelText("Merge into")).not.toBeInTheDocument();
  });
});
