import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import type { JarvisSessionDetail } from "../../types";
import SessionSummaryPanel from "../SessionSummaryPanel";

const getSessionDetail = vi.fn();
const getAnalysisStatus = vi.fn();
const analyzeSession = vi.fn();

function detailWithSummary(): JarvisSessionDetail {
  return {
    session: {
      id: "session-1",
      started_at: 1_000,
      ended_at: 2_000,
      status: "completed",
      language: "zh",
      created_at: 1_000,
      capture_mode: "mic",
    },
    summary: {
      session_id: "session-1",
      summary: "Discussed the launch plan and agreed on Friday.",
      decisions_json: JSON.stringify(["Ship the MVP on Friday"]),
      suggestions_json: JSON.stringify([
        { content: "Confirm the demo owner", reason: "No owner was assigned" },
      ]),
      updated_at: 2_100,
      is_final: 1,
    },
    segments: [],
    audioChunks: [],
    topics: [
      {
        id: "topic-1",
        canonical_title: "Project Atlas",
        normalized_title: "project atlas",
        description: "Launch scope and delivery timing",
        status: "active",
        created_at: 1_000,
        last_seen_at: 2_000,
      },
    ],
    todos: [
      {
        id: "todo-1",
        content: "Prepare the demo",
        owner_person_id: null,
        topic_id: null,
        due_at: null,
        status: "open",
        updated_at: 2_100,
        completed_at: null,
        source_session_id: "session-1",
        source_segment_id: null,
      },
    ],
    memories: [],
    speakerProcessing: null,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SessionSummaryPanel", () => {
  beforeEach(() => {
    getSessionDetail.mockReset();
    getAnalysisStatus.mockReset();
    analyzeSession.mockReset();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getSessionDetail,
          getAnalysisStatus,
          analyzeSession,
        },
      },
    });
  });

  it("shows the persisted summary in Today after finish", async () => {
    getSessionDetail.mockResolvedValue(detailWithSummary());

    render(<SessionSummaryPanel sessionId="session-1" sessionStatus="completed" />);

    expect(
      await screen.findByText("Discussed the launch plan and agreed on Friday.")
    ).toBeInTheDocument();
    expect(screen.getByText("Ship the MVP on Friday")).toBeInTheDocument();
    expect(screen.getByText(/Prepare the demo/)).toBeInTheDocument();
    expect(screen.getByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByText("Launch scope and delivery timing")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it.each([
    ["blocked", "offline", "Offline"],
    ["quota_limited", "budget_exceeded", "Quota limited"],
    ["retry_needed", "rate_limit", "Retry needed"],
  ] as const)("shows the explicit %s analysis outcome", async (state, errorCode, label) => {
    getSessionDetail.mockResolvedValue({
      ...detailWithSummary(),
      summary: null,
    });
    getAnalysisStatus.mockResolvedValue({
      sessionId: "session-1",
      state,
      errorCode,
      updatedAt: 2_100,
    });

    render(<SessionSummaryPanel sessionId="session-1" sessionStatus="completed" />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry summary" })).toBeInTheDocument();
  });

  it("offers an in-place retry when final analysis is blocked", async () => {
    getSessionDetail.mockResolvedValue({
      ...detailWithSummary(),
      summary: null,
    });
    getAnalysisStatus.mockResolvedValue({
      sessionId: "session-1",
      state: "blocked",
      errorCode: "offline",
      updatedAt: 2_100,
    });
    analyzeSession.mockResolvedValue({
      sessionId: "session-1",
      state: "ready",
      errorCode: null,
      updatedAt: 2_200,
    });

    render(<SessionSummaryPanel sessionId="session-1" sessionStatus="completed" />);

    const retry = await screen.findByRole("button", { name: "Retry summary" });
    expect(screen.getByText(/recording and transcript are saved/i)).toBeInTheDocument();

    getSessionDetail.mockResolvedValue(detailWithSummary());
    fireEvent.click(retry);

    await waitFor(() => expect(analyzeSession).toHaveBeenCalledWith("session-1", "final"));
    expect(
      await screen.findByText("Discussed the launch plan and agreed on Friday.")
    ).toBeInTheDocument();
  });
});
