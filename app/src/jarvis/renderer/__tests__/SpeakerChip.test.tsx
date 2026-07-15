import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type { JarvisSpeakerClusterView } from "../../types";
import SpeakerChip from "../SpeakerChip";
import { useJarvisStore } from "../jarvisStore";

function cluster(overrides: Partial<JarvisSpeakerClusterView> = {}): JarvisSpeakerClusterView {
  return {
    id: "cluster-1",
    sessionId: "session-1",
    trackId: null,
    localLabel: "speaker_1",
    linkState: "unknown",
    person: null,
    suggestedPerson: null,
    lastRejectedPerson: null,
    score: null,
    margin: null,
    reason: "unresolved",
    policyId: "policy-v1",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    evidenceSegmentIds: ["segment-1"],
    canUndo: false,
    updatedAt: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SpeakerChip durable corrections", () => {
  const confirmSpeaker = vi.fn();
  const rejectSpeaker = vi.fn();
  const undoSpeakerCorrection = vi.fn();
  const renamePerson = vi.fn();

  beforeEach(() => {
    confirmSpeaker.mockReset();
    rejectSpeaker.mockReset();
    undoSpeakerCorrection.mockReset();
    renamePerson.mockReset();
    Object.assign(window, {
      electronAPI: {
        jarvis: { confirmSpeaker, rejectSpeaker, undoSpeakerCorrection, renamePerson },
      },
    });
    useJarvisStore.setState({
      clustersBySession: {},
      people: [
        {
          id: "p-other",
          display_name: "Other Person",
          is_self: 0,
          voice_profile_id: null,
          voice_confidence: null,
          created_at: 1,
          last_seen_at: 1,
        },
      ],
      speakerCorrectionBusyClusterId: null,
      speakerCorrectionError: null,
      speakerCorrectionErrorClusterId: null,
      speakerCorrectionCandidates: [],
      speakerCorrectionCandidateClusterId: null,
    });
  });

  it("renders self, confirmed, suggested, rejected and temporary states distinctly", () => {
    const { rerender } = render(
      <SpeakerChip
        cluster={cluster({
          linkState: "confirmed",
          person: { id: "self", displayName: "Me", isSelf: true },
        })}
        localLabel="speaker_1"
      />
    );
    expect(screen.getByRole("button", { name: "Me" })).toBeInTheDocument();

    rerender(
      <SpeakerChip
        cluster={cluster({
          linkState: "confirmed",
          person: { id: "p1", displayName: "Alice", isSelf: false },
        })}
        localLabel="speaker_1"
      />
    );
    expect(screen.getByRole("button", { name: "Alice" })).toBeInTheDocument();

    rerender(
      <SpeakerChip
        cluster={cluster({
          linkState: "suggested",
          suggestedPerson: { id: "p1", displayName: "Alice", isSelf: false },
        })}
        localLabel="speaker_1"
      />
    );
    expect(screen.getByRole("button", { name: "Possibly Alice" })).toBeInTheDocument();

    rerender(
      <SpeakerChip
        cluster={cluster({
          linkState: "rejected",
          lastRejectedPerson: { id: "p1", displayName: "Alice", isSelf: false },
        })}
        localLabel="speaker_1"
      />
    );
    expect(screen.getByRole("button", { name: "Unknown speaker" })).toBeInTheDocument();

    rerender(<SpeakerChip cluster={null} localLabel="speaker_1" />);
    expect(screen.getByText("speaker_1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("accepts or rejects only the current durable suggestion without legacy writes", async () => {
    const suggested = cluster({
      linkState: "suggested",
      suggestedPerson: { id: "p1", displayName: "Alice", isSelf: false },
    });
    confirmSpeaker.mockResolvedValue({
      cluster: { ...suggested, linkState: "confirmed" },
      profileSampleAdded: false,
      profileSampleReason: "session_scope",
      createdPerson: false,
    });
    rejectSpeaker.mockResolvedValue({ ...suggested, linkState: "rejected" });
    render(<SpeakerChip cluster={suggested} localLabel="speaker_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Possibly Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Link for this session" }));
    await waitFor(() =>
      expect(confirmSpeaker).toHaveBeenCalledWith({
        clusterId: "cluster-1",
        personId: "p1",
        scope: "session",
      })
    );
    expect(renamePerson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Possibly Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Link and learn voice" }));
    await waitFor(() =>
      expect(confirmSpeaker).toHaveBeenCalledWith({
        clusterId: "cluster-1",
        personId: "p1",
        scope: "persistent",
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject suggestion" }));
    await waitFor(() => expect(rejectSpeaker).toHaveBeenCalledWith("cluster-1", "p1"));
  });

  it("links an existing or new person with explicit learning scope and truthful outcome", async () => {
    const unknown = cluster();
    confirmSpeaker.mockResolvedValue({
      cluster: unknown,
      profileSampleAdded: true,
      profileSampleReason: "added",
      createdPerson: true,
    });
    render(<SpeakerChip cluster={unknown} localLabel="speaker_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Unknown speaker" }));
    fireEvent.change(screen.getByLabelText("New person name"), {
      target: { value: "New Person" },
    });
    fireEvent.click(screen.getByLabelText("Learn this voice for future sessions"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm speaker" }));

    await waitFor(() =>
      expect(confirmSpeaker).toHaveBeenCalledWith({
        clusterId: "cluster-1",
        newPersonName: "New Person",
        scope: "persistent",
      })
    );
    expect(await screen.findByText("Linked and learned this voice.")).toBeInTheDocument();
  });

  it("directs an ambiguous new name to public candidates and localizes skipped learning", async () => {
    const unknown = cluster();
    confirmSpeaker
      .mockRejectedValueOnce(
        Object.assign(new Error("Choose an existing person"), {
          code: "ambiguous_duplicate_name",
          candidates: [{ id: "p1", displayName: "Alice", isSelf: false }],
        })
      )
      .mockResolvedValueOnce({
        cluster: unknown,
        profileSampleAdded: false,
        profileSampleReason: "missing_embedding",
        createdPerson: false,
      });
    render(<SpeakerChip cluster={unknown} localLabel="speaker_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Unknown speaker" }));
    fireEvent.change(screen.getByLabelText("New person name"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByLabelText("Learn this voice for future sessions"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm speaker" }));

    expect(await screen.findByText(/matches multiple people/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    await waitFor(() =>
      expect(confirmSpeaker).toHaveBeenLastCalledWith({
        clusterId: "cluster-1",
        personId: "p1",
        scope: "persistent",
      })
    );
    expect(
      await screen.findByText("Linked, but did not learn this voice (no usable voice embedding).")
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("missing_embedding");
  });

  it("never offers ambiguous candidates from a different speaker cluster", async () => {
    confirmSpeaker.mockRejectedValue(
      Object.assign(new Error("Choose an existing person"), {
        code: "ambiguous_duplicate_name",
        candidates: [{ id: "p1", displayName: "Alice", isSelf: false }],
      })
    );
    render(
      <>
        <SpeakerChip
          cluster={cluster({
            id: "cluster-a",
            linkState: "confirmed",
            person: { id: "p-a", displayName: "Alpha", isSelf: false },
          })}
          localLabel="speaker_1"
        />
        <SpeakerChip
          cluster={cluster({
            id: "cluster-b",
            linkState: "confirmed",
            person: { id: "p-b", displayName: "Beta", isSelf: false },
          })}
          localLabel="speaker_2"
        />
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.change(screen.getByLabelText("New person name"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm speaker" }));
    expect(await screen.findByText(/matches multiple people/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));

    expect(screen.queryByRole("button", { name: "Alice" })).not.toBeInTheDocument();
  });

  it("shows undo only for an undoable link correction", async () => {
    const confirmed = cluster({
      linkState: "confirmed",
      person: { id: "p1", displayName: "Alice", isSelf: false },
      canUndo: true,
    });
    undoSpeakerCorrection.mockResolvedValue(cluster());
    render(<SpeakerChip cluster={confirmed} localLabel="speaker_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo last link correction" }));
    await waitFor(() => expect(undoSpeakerCorrection).toHaveBeenCalledWith("cluster-1"));
  });

  it.each(["confirm", "reject", "undo"] as const)(
    "contains a failed %s mutation and keeps the correction menu usable",
    async (operation) => {
      const current =
        operation === "reject"
          ? cluster({
              linkState: "suggested",
              suggestedPerson: { id: "p1", displayName: "Alice", isSelf: false },
            })
          : operation === "undo"
            ? cluster({
                linkState: "confirmed",
                person: { id: "p1", displayName: "Alice", isSelf: false },
                canUndo: true,
              })
            : cluster();
      const error = new Error(`${operation} failed`);
      if (operation === "confirm") confirmSpeaker.mockRejectedValue(error);
      if (operation === "reject") rejectSpeaker.mockRejectedValue(error);
      if (operation === "undo") undoSpeakerCorrection.mockRejectedValue(error);
      render(<SpeakerChip cluster={current} localLabel="speaker_1" />);

      fireEvent.click(
        screen.getByRole("button", {
          name:
            operation === "reject"
              ? "Possibly Alice"
              : operation === "undo"
                ? "Alice"
                : "Unknown speaker",
        })
      );
      if (operation === "confirm") {
        fireEvent.change(screen.getByLabelText("New person name"), {
          target: { value: "New Person" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Confirm speaker" }));
      } else {
        fireEvent.click(
          screen.getByRole("button", {
            name: operation === "reject" ? "Reject suggestion" : "Undo last link correction",
          })
        );
      }

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Speaker correction failed. Try again."
      );
      expect(screen.queryByText(`${operation} failed`)).not.toBeInTheDocument();
      expect(screen.getByText("Local label: speaker_1")).toBeInTheDocument();
    }
  );

  it("never shows one cluster's internal correction failure on another cluster", async () => {
    confirmSpeaker.mockRejectedValue(new Error("sensitive internal path C:\\private\\jarvis.db"));
    render(
      <>
        <SpeakerChip cluster={cluster({ id: "cluster-a" })} localLabel="speaker_1" />
        <SpeakerChip cluster={cluster({ id: "cluster-b" })} localLabel="speaker_2" />
      </>
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Unknown speaker" })[0]);
    fireEvent.change(screen.getByLabelText("New person name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm speaker" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Speaker correction failed. Try again."
    );
    expect(document.body.textContent).not.toContain("sensitive internal path");

    fireEvent.click(screen.getAllByRole("button", { name: "Unknown speaker" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Unknown speaker" })[1]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
