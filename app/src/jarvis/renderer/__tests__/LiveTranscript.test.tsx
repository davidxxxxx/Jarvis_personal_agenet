import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import { createStableSegmentId } from "../../shared/segmentIds";
import type { JarvisSpeakerClusterView } from "../../types";
import LiveTranscript from "../LiveTranscript";
import { useJarvisStore } from "../jarvisStore";

function suggestedCluster(
  sessionId: string,
  id: string,
  evidenceSegmentId: string,
  name: string
): JarvisSpeakerClusterView {
  return {
    id,
    sessionId,
    trackId: null,
    localLabel: "speaker_1",
    linkState: "suggested",
    person: null,
    suggestedPerson: { id: `${id}-person`, displayName: name, isSelf: false },
    lastRejectedPerson: null,
    score: 0.8,
    margin: 0.1,
    reason: "candidate",
    policyId: "policy",
    diarizationRevision: "a".repeat(64),
    profileRevision: "b".repeat(64),
    evidenceSegmentIds: [evidenceSegmentId],
    canUndo: false,
    updatedAt: 1,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("LiveTranscript", () => {
  beforeEach(() => {
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          listSessionSpeakerClusters: vi.fn(async () => []),
          confirmSpeaker: vi.fn(),
          rejectSpeaker: vi.fn(),
          undoSpeakerCorrection: vi.fn(),
        },
      },
    });
    useJarvisStore.setState({ clustersBySession: {}, people: [] });
  });

  it("sorts stable rows by timestamp and renders partial text separately", () => {
    render(
      <LiveTranscript
        segments={[
          { id: "late", text: "Later", source: "mic", timestamp: 2_000 },
          { id: "early", text: "Earlier", source: "mic", timestamp: 1_000 },
        ]}
        partialText="Partial"
      />
    );

    const rows = screen.getAllByTestId("stable-transcript-row");
    expect(rows[0]).toHaveTextContent("Earlier");
    expect(rows[1]).toHaveTextContent("Later");
    expect(screen.getByLabelText("Partial transcript")).toHaveTextContent("Partial");
  });

  it("resolves a final row by durable evidence identity and never by repeated local label", () => {
    const evidenceA = createStableSegmentId("session-a", "row-1");
    const evidenceB = createStableSegmentId("session-b", "row-1");
    useJarvisStore.setState({
      clustersBySession: {
        "session-a": [suggestedCluster("session-a", "cluster-a", evidenceA, "Alice")],
        "session-b": [suggestedCluster("session-b", "cluster-b", evidenceB, "Bob")],
      },
    });

    render(
      <LiveTranscript
        sessionId="session-a"
        segments={[
          {
            id: "row-1",
            text: "Hello",
            source: "system",
            timestamp: 1_000,
            speaker: "speaker_1",
            speakerName: "speaker_1",
          },
        ]}
        partialText=""
      />
    );

    expect(screen.getByRole("button", { name: "Possibly Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Possibly Bob" })).not.toBeInTheDocument();
  });

  it("keeps a temporary preview local and non-actionable without durable cluster evidence", () => {
    render(
      <LiveTranscript
        segments={[
          {
            id: "preview",
            text: "Preview",
            source: "system",
            timestamp: 1_000,
            speaker: "speaker_1",
            speakerName: "Local speaker 1",
          },
        ]}
        partialText=""
      />
    );

    expect(screen.getByText("Local speaker 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Local speaker 1" })).not.toBeInTheDocument();
  });

  it("autoscrolls when the last stable row content is replaced in place", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const { rerender } = render(
      <LiveTranscript
        segments={[{ id: "stable", text: "Old", source: "mic", timestamp: 1_000 }]}
        partialText=""
      />
    );
    const initialCalls = scrollIntoView.mock.calls.length;

    rerender(
      <LiveTranscript
        segments={[{ id: "stable", text: "New", source: "mic", timestamp: 1_000 }]}
        partialText=""
      />
    );

    expect(scrollIntoView.mock.calls.length).toBe(initialCalls + 1);
  });
});
