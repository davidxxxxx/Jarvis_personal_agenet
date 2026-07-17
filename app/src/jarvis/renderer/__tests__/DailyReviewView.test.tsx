import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisDailyDigestReadResult } from "../../types";
import DailyReviewView from "../DailyReviewView";

const savedResult: JarvisDailyDigestReadResult = {
  digest: {
    localDate: "2026-07-17",
    revision: 2,
    completeness: "partial",
    content: {
      schemaVersion: "jarvis-daily-digest-v1",
      sections: {
        today: [{ text: "Completed project plan", evidenceSegmentIds: ["segment_1"] }],
        interactions: [
          { subjectRef: "person_1", text: "Aligned release scope", evidenceSegmentIds: [] },
        ],
        topicsAndDecisions: [
          { text: "Use the local-first design", evidenceSegmentIds: ["segment_1"] },
        ],
        commitmentsAndTodos: [{ text: "Prepare the build", evidenceSegmentIds: [] }],
        worthRemembering: [{ text: "GPU work yields during capture", evidenceSegmentIds: [] }],
        tomorrowSuggestions: [
          {
            text: "Review the release checklist",
            rationale: "The build is approaching release.",
            evidenceSegmentIds: [],
            allowedActions: ["accept", "dismiss", "convert_to_todo"],
          },
        ],
      },
      processing: {
        completeness: "partial",
        missingStages: ["speaker_identity"],
        transcriptCoverage: {
          selectedSegmentCount: 8,
          incompleteSegmentCount: 1,
          sessionCount: 2,
          startsAt: 1,
          endsAt: 2,
        },
      },
    },
    evidence: [
      {
        sessionId: "session_1",
        segmentId: "segment_1",
        startedAt: 10,
        endedAt: 20,
        quote: "Keep private data local.",
        audioState: "available",
      },
    ],
    createdAt: 100,
    updatedAt: 200,
  },
  status: {
    state: "retry_needed",
    retryable: true,
    errorCode: "offline",
    nextRetryAt: 300,
    attemptCount: 2,
  },
};

describe("DailyReviewView", () => {
  beforeEach(() => {
    window.electronAPI = {
      jarvis: {
        getDailyDigest: vi.fn().mockResolvedValue(savedResult),
        regenerateDailyDigest: vi.fn().mockResolvedValue({
          ...savedResult.status,
          state: "queued",
          errorCode: null,
        }),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a saved partial digest visible beside retry state", async () => {
    render(<DailyReviewView localDate="2026-07-17" />);

    expect(await screen.findByText("Completed project plan")).toBeVisible();
    expect(screen.getByText("Use the local-first design")).toBeVisible();
    expect(screen.getByText("Review the release checklist")).toBeVisible();
    expect(screen.getByText(/Partial|部分/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/retry|重试/i);
  });

  it("regenerates by local date only without clearing saved content", async () => {
    render(<DailyReviewView localDate="2026-07-17" />);
    expect(await screen.findByText("Completed project plan")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /regenerate|重新生成/i }));

    await waitFor(() =>
      expect(window.electronAPI.jarvis.regenerateDailyDigest).toHaveBeenCalledWith("2026-07-17")
    );
    expect(screen.getByText("Completed project plan")).toBeVisible();
  });

  it("uses a truthful empty state and never prints raw failures", async () => {
    vi.mocked(window.electronAPI.jarvis.getDailyDigest).mockRejectedValue(
      new Error("C:\\secret\\jarvis.db MiniMax payload")
    );
    render(<DailyReviewView localDate="2026-07-17" />);

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText(/secret|MiniMax payload/)).not.toBeInTheDocument();
  });

  it("polls a visible queued review until the saved digest is ready and then stops", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.mocked(window.electronAPI.jarvis.getDailyDigest)
      .mockReset()
      .mockResolvedValueOnce({
        digest: null,
        status: {
          state: "queued",
          retryable: false,
          errorCode: null,
          nextRetryAt: null,
          attemptCount: 0,
        },
      })
      .mockResolvedValue({
        ...savedResult,
        status: {
          ...savedResult.status,
          state: "ready",
          retryable: false,
          errorCode: null,
        },
      });

    render(<DailyReviewView localDate="2026-07-17" />);
    await act(async () => Promise.resolve());
    expect(window.electronAPI.jarvis.getDailyDigest).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Completed project plan")).toBeVisible();
    expect(window.electronAPI.jarvis.getDailyDigest).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(window.electronAPI.jarvis.getDailyDigest).toHaveBeenCalledTimes(2);
  });
});
