import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisEvidenceContext,
  JarvisEvidenceHandle,
  JarvisTranscriptSegment,
} from "../../types";
import DurableTranscript from "../DurableTranscript";
import EvidenceLink from "../EvidenceLink";
import { useJarvisStore } from "../jarvisStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function handle(id: string): JarvisEvidenceHandle {
  return { ownerType: "memory_value", ownerId: `owner-${id}`, evidenceId: `evidence-${id}` };
}

function context(id: string): JarvisEvidenceContext {
  return {
    ...handle(id),
    sessionId: `session-${id}`,
    sessionStartedAt: 1_000,
    sessionEndedAt: 4_000,
    transcriptSegmentId: `segment-${id}`,
    transcriptState: "available",
    trackId: "track-mic",
    sourceType: "mic",
    startedAt: 2_000,
    endedAt: 2_500,
    quoteText: `quote-${id}`,
    audioState: "available",
    actionAttribution: null,
  };
}

describe("evidence navigation store", () => {
  beforeEach(() => {
    useJarvisStore.setState({
      selectedView: "today",
      selectedSessionId: null,
      evidenceNavigation: { phase: "idle", requestId: 0 },
    });
  });

  it("lets the latest click own session selection when context requests resolve out of order", async () => {
    const first = deferred<JarvisEvidenceContext | null>();
    const second = deferred<JarvisEvidenceContext | null>();
    const getEvidenceContext = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    Object.assign(window, { electronAPI: { jarvis: { getEvidenceContext } } });

    const firstOpen = useJarvisStore.getState().openEvidence(handle("a"));
    const secondOpen = useJarvisStore.getState().openEvidence(handle("b"));
    second.resolve(context("b"));
    await secondOpen;
    first.resolve(context("a"));
    await firstOpen;

    expect(useJarvisStore.getState().selectedView).toBe("memory");
    expect(useJarvisStore.getState().selectedSessionId).toBe("session-b");
    expect(useJarvisStore.getState().evidenceNavigation).toMatchObject({
      phase: "opening_session",
      requestId: 2,
      context: context("b"),
    });
  });

  it("keeps unknown ownership as a closed public failure", async () => {
    Object.assign(window, {
      electronAPI: { jarvis: { getEvidenceContext: vi.fn(async () => null) } },
    });

    await useJarvisStore.getState().openEvidence(handle("missing"));

    expect(useJarvisStore.getState().evidenceNavigation).toEqual({
      phase: "failed",
      requestId: 1,
      code: "evidence_not_found",
    });
    expect(useJarvisStore.getState().selectedSessionId).toBeNull();
  });

  it("opens an already-known session without forging an evidence handle", () => {
    useJarvisStore.setState({
      evidenceNavigation: {
        phase: "failed",
        requestId: 4,
        code: "evidence_navigation_failed",
      },
    });

    useJarvisStore.getState().openSession("session-recent");

    expect(useJarvisStore.getState()).toMatchObject({
      selectedView: "memory",
      selectedSessionId: "session-recent",
      evidenceNavigation: { phase: "idle", requestId: 5 },
    });
  });
});

describe("EvidenceLink", () => {
  it("announces availability and dispatches only an opaque evidence handle", async () => {
    const getEvidenceContext = vi.fn(async () => context("link"));
    Object.assign(window, { electronAPI: { jarvis: { getEvidenceContext } } });
    render(
      <EvidenceLink
        handle={handle("link")}
        quote="Bounded source quote"
        startedAt={2_000}
        audioState="available"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /open evidence.*audio available.*transcript available/i })
    );

    await waitFor(() => expect(getEvidenceContext).toHaveBeenCalledWith(handle("link")));
    expect(getEvidenceContext.mock.calls[0]).toHaveLength(1);
  });

  it("does not expose a fake navigation button without a validated handle", () => {
    render(<EvidenceLink quote="Historical source" startedAt={2_000} audioState="expired" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/audio expired/i)).toBeInTheDocument();
  });
});

describe("DurableTranscript evidence focus", () => {
  it("focuses and highlights by durable segment id instead of quote text", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.assign(window, { electronAPI: { jarvis: {} } });
    const segments: JarvisTranscriptSegment[] = [
      {
        id: "segment-target",
        session_id: "session-a",
        started_at: 2_000,
        ended_at: 2_500,
        person_id: null,
        speaker_label: "Speaker 1",
        text: "Same quote text",
        confidence: 0.9,
        is_stable: 1,
        analysis_state: "ready",
      },
      {
        id: "segment-other",
        session_id: "session-a",
        started_at: 3_000,
        ended_at: 3_500,
        person_id: null,
        speaker_label: "Speaker 2",
        text: "Same quote text",
        confidence: 0.9,
        is_stable: 1,
        analysis_state: "ready",
      },
    ];

    render(
      <DurableTranscript
        sessionId="session-a"
        segments={segments}
        focusSegmentId="segment-target"
        focusRequestId={9}
      />
    );

    const target = await screen.findByTestId("transcript-segment-segment-target");
    await waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute("data-evidence-focus", "true");
    expect(screen.getByTestId("transcript-segment-segment-other")).not.toHaveAttribute(
      "data-evidence-focus",
      "true"
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
