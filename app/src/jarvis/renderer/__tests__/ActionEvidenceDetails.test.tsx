import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JarvisEvidenceContext,
  JarvisKnowledgeEvidence,
  JarvisTodoTrustSnapshot,
} from "../../types";
import ActionEvidenceDetails from "../ActionEvidenceDetails";
import { useJarvisStore } from "../jarvisStore";

const evidence: JarvisKnowledgeEvidence = {
  sessionId: "session-1",
  segmentId: "segment-1",
  startedAt: 1_000,
  endedAt: 2_000,
  quote: "我来处理这个任务",
  audioState: "available",
  handle: { ownerType: "todo_instance", ownerId: "todo-1", evidenceId: "evidence-1" },
};

function context(): JarvisEvidenceContext {
  return {
    ...evidence.handle!,
    sessionId: "session-1",
    sessionStartedAt: 0,
    sessionEndedAt: 3_000,
    transcriptSegmentId: "segment-1",
    transcriptState: "available",
    trackId: "track-kook",
    sourceType: "system",
    startedAt: 1_000,
    endedAt: 2_000,
    quoteText: evidence.quote,
    audioState: "available",
    transcriptContext: [
      {
        segmentId: "segment-before",
        startedAt: 200,
        endedAt: 900,
        text: "这个任务谁来处理？",
        speakerRelation: "P1",
        applicationName: "KOOK",
        isEvidence: false,
      },
      {
        segmentId: "segment-1",
        startedAt: 1_000,
        endedAt: 2_000,
        text: evidence.quote,
        speakerRelation: "SELF",
        applicationName: "KOOK",
        isEvidence: true,
      },
      {
        segmentId: "segment-after",
        startedAt: 2_100,
        endedAt: 2_900,
        text: "好，那就交给你。",
        speakerRelation: "P1",
        applicationName: "KOOK",
        isEvidence: false,
      },
    ],
    actionAttribution: {
      basis: "current_local_state",
      applicationKey: "kook",
      applicationName: "KOOK",
      sourceAttribution: "application_and_microphone",
      speakerRelation: "SELF",
      semanticConfidence: 0.96,
      voiceConfidence: 0.94,
      transcriptConfidence: 0.91,
      activityClassification: {
        id: "classification-1",
        category: "social_call",
        confidence: 0.93,
        decision: "adopted",
        source: "minimax",
        reason: "active call with SELF participation",
      },
    },
  };
}

const trustSnapshot: JarvisTodoTrustSnapshot = {
  policyId: "todo-attribution-v1",
  state: "captured",
  applicationEvidence: [
    {
      segmentId: "segment-1",
      applicationKey: "kook",
      sourceAttribution: "application_and_microphone",
      speakerRelation: "SELF",
    },
  ],
  activityEvidence: [
    {
      segmentId: "segment-1",
      category: "social_call",
      confidence: 0.93,
      decision: "adopted",
    },
  ],
  semanticConfidence: 0.96,
  voiceprintConfidence: 0.94,
  sceneConfidence: 0.93,
  transcriptContextConfidence: 0.91,
  speakerEvidenceVerified: true,
  overlapDetected: false,
  automaticEligible: true,
};

describe("ActionEvidenceDetails", () => {
  beforeEach(() => {
    useJarvisStore.setState({
      selectedView: "today",
      selectedSessionId: null,
      evidenceNavigation: { phase: "idle", requestId: 0 },
    });
    Object.assign(window, {
      electronAPI: {
        jarvis: {
          getEvidenceContext: vi.fn(async () => context()),
          correctActivityClassification: vi.fn(async () => ({ classification: {} })),
        },
      },
    });
  });

  it("loads the privacy-safe source only after the user expands the evidence", async () => {
    render(<ActionEvidenceDetails evidence={[evidence]} />);

    expect(window.electronAPI.jarvis.getEvidenceContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查看来源依据/u }));

    await screen.findByText(/KOOK \+ 麦克风/u);
    expect(screen.getByText("SELF")).toBeInTheDocument();
    expect(screen.getByText(/社交通话 · 场景 93%/u)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.includes("语义 96%") === true &&
          element.textContent.includes("声纹 94%") &&
          element.textContent.includes("转写 91%")
      )
    ).toBeInTheDocument();
    expect(window.electronAPI.jarvis.getEvidenceContext).toHaveBeenCalledTimes(1);
    expect(screen.getByText("前后文")).toBeVisible();
    expect(screen.getByText("这个任务谁来处理？")).toBeVisible();
    expect(screen.getByText("好，那就交给你。")).toBeVisible();
  });

  it("lets the user correct the activity category without exposing identity data", async () => {
    render(<ActionEvidenceDetails evidence={[evidence]} defaultOpen />);
    await screen.findByText(/KOOK \+ 麦克风/u);

    fireEvent.change(screen.getByLabelText("更正活动分类 classification-1"), {
      target: { value: "work_meeting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存分类" }));

    await waitFor(() =>
      expect(window.electronAPI.jarvis.correctActivityClassification).toHaveBeenCalledWith(
        "classification-1",
        "work_meeting"
      )
    );
  });

  it("offers an explicit speaker-error review entry at the cited audio", async () => {
    render(<ActionEvidenceDetails evidence={[evidence]} defaultOpen />);
    await screen.findByText(/KOOK \+ 麦克风/u);

    fireEvent.click(screen.getByRole("button", { name: "复核说话人 segment-1" }));

    await waitFor(() => {
      expect(useJarvisStore.getState().selectedView).toBe("memory");
      expect(useJarvisStore.getState().selectedSessionId).toBe("session-1");
      expect(useJarvisStore.getState().evidenceNavigation.phase).toBe("opening_session");
    });
  });

  it("offers an explicit evidence-level correction when an extracted item is not a Todo", async () => {
    const onNotTodo = vi.fn();
    render(<ActionEvidenceDetails evidence={[evidence]} defaultOpen onNotTodo={onNotTodo} />);

    fireEvent.click(screen.getByRole("button", { name: "这不是待办" }));

    expect(onNotTodo).toHaveBeenCalledTimes(1);
  });

  it("labels immutable creation evidence and hides the mutable classification control", async () => {
    const captured = context();
    captured.actionAttribution = {
      ...captured.actionAttribution!,
      basis: "captured_todo_snapshot",
      activityClassification: {
        ...captured.actionAttribution!.activityClassification!,
        id: null,
        source: "captured_snapshot",
        reason: null,
      },
    };
    vi.mocked(window.electronAPI.jarvis.getEvidenceContext).mockResolvedValue(captured);

    render(
      <ActionEvidenceDetails evidence={[evidence]} trustSnapshot={trustSnapshot} defaultOpen />
    );

    await screen.findByText("创建时门禁依据");
    expect(screen.getByText(/满足自动确认门禁/u)).toBeInTheDocument();
    expect(screen.getByText(/创建时不可变快照/u)).toBeInTheDocument();
    expect(screen.getByText("创建后不可修改")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存分类" })).not.toBeInTheDocument();
  });
});
