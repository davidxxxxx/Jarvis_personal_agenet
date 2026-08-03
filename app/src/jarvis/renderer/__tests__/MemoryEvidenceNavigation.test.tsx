import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisEvidenceContext,
  JarvisEvidenceHandle,
  JarvisSession,
  JarvisSessionDetail,
  JarvisSessionTimeline,
  JarvisTranscriptSegment,
} from "../../types";
import MemoryView from "../MemoryView";
import { useJarvisStore } from "../jarvisStore";

const session: JarvisSession = {
  id: "session-evidence",
  started_at: 1_000,
  ended_at: 4_000,
  status: "completed",
  mic_device_id: null,
  language: "zh",
  created_at: 1_000,
  capture_mode: "mic",
};

const segment: JarvisTranscriptSegment = {
  id: "segment-evidence",
  session_id: session.id,
  started_at: 2_000,
  ended_at: 2_500,
  person_id: null,
  speaker_label: "Speaker 1",
  text: "Durable evidence transcript",
  confidence: 0.9,
  is_stable: 1,
  analysis_state: "ready",
  track_id: "track-mic",
  chunk_id: "chunk-1",
  source_type: "mic",
};

function detail(summary: JarvisSessionDetail["summary"] = null): JarvisSessionDetail {
  return {
    session,
    summary,
    segments: [segment],
    audioChunks: [],
    topics: [],
    todos: [],
    memories: [],
    speakerProcessing: null,
  };
}

function timeline(): JarvisSessionTimeline {
  return {
    session_id: session.id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    status: "completed",
    processing_state: "ready",
    timeline_version: 1,
    finalized_at: 4_000,
    ready_at: 4_100,
    tracks: [],
    application_audio_intervals: [],
    gaps: [],
    chunks: [],
    segments: [segment],
    processing_counts: { pending: 0, leased: 0, retry: 0, blocked: 0, completed: 1, total: 1 },
  };
}

function evidenceContext(audioState: "available" | "expired" | "missing"): JarvisEvidenceContext {
  return {
    ownerType: "memory_value",
    ownerId: "memory-1",
    evidenceId: "evidence-1",
    sessionId: session.id,
    sessionStartedAt: 1_000,
    sessionEndedAt: 4_000,
    transcriptSegmentId: segment.id,
    transcriptState: "available",
    trackId: "track-mic",
    sourceType: "mic",
    startedAt: segment.started_at,
    endedAt: segment.ended_at,
    quoteText: segment.text,
    audioState,
    actionAttribution: null,
  };
}

const handle: JarvisEvidenceHandle = {
  ownerType: "memory_value",
  ownerId: "memory-1",
  evidenceId: "evidence-1",
};

describe("MemoryView evidence navigation", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    useJarvisStore.setState({
      sessions: [],
      selectedSessionId: null,
      evidenceNavigation: { phase: "idle", requestId: 0 },
    });
  });

  it("opens a recent session selected directly from Today", async () => {
    const getSessionDetail = vi.fn(async () => detail());
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => timeline()),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(async () => []),
          analyzeSession: vi.fn(),
        },
      },
    });
    useJarvisStore.getState().openSession(session.id);

    render(<MemoryView />);

    await waitFor(() => expect(getSessionDetail).toHaveBeenCalledWith(session.id));
    expect(await screen.findByText("Durable evidence transcript")).toBeInTheDocument();
    expect(useJarvisStore.getState().evidenceNavigation.phase).toBe("idle");
  });

  it("opens an authoritative session absent from the list and stays transcript-only after expiry", async () => {
    const readAudioChunk = vi.fn();
    const getSessionDetail = vi.fn(async () => detail());
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getEvidenceContext: vi.fn(async () => evidenceContext("expired")),
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => timeline()),
          readAudioChunk,
          searchMemory: vi.fn(async () => []),
          analyzeSession: vi.fn(),
        },
      },
    });

    render(<MemoryView />);
    await act(async () => useJarvisStore.getState().openEvidence(handle));

    await waitFor(() => expect(getSessionDetail).toHaveBeenCalledWith(session.id));
    const focused = await screen.findByTestId(`transcript-segment-${segment.id}`);
    await waitFor(() => expect(focused).toHaveFocus());
    expect(screen.getByText(/audio was removed by the retention policy/i)).toBeInTheDocument();
    expect(readAudioChunk).not.toHaveBeenCalled();
    expect(useJarvisStore.getState().evidenceNavigation).toMatchObject({
      phase: "transcript_only",
      reason: "audio_expired",
    });
  });

  it("contains malformed legacy summary JSON and never renders a raw analysis error", async () => {
    const getSessionDetail = vi
      .fn()
      .mockResolvedValueOnce(
        detail({
          session_id: session.id,
          summary: "Saved summary",
          decisions_json: "not-json",
          suggestions_json: "{}",
          updated_at: 4_000,
          is_final: 1,
        })
      )
      .mockResolvedValue(detail());
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getSessionDetail,
          getSessionTimeline: vi.fn(async () => timeline()),
          readAudioChunk: vi.fn(),
          searchMemory: vi.fn(async () => []),
          analyzeSession: vi.fn(async () => {
            throw new Error("secret-provider-response-body");
          }),
        },
      },
    });
    useJarvisStore.setState({ sessions: [session] });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /录音/ }));
    expect(await screen.findByText("Saved summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /返回记忆库/ }));
    fireEvent.click(screen.getByRole("button", { name: /录音/ }));
    fireEvent.click(await screen.findByRole("button", { name: /生成总结/ }));

    expect(await screen.findByText("总结未能加入后台队列，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText(/secret-provider-response-body/)).not.toBeInTheDocument();
  });
});
