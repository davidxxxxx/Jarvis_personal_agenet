import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import TodayView from "../TodayView";
import type { JarvisRolloutFlags } from "../../types";
import type { UseJarvisRecordingResult } from "../useJarvisRecording";

vi.mock("../RecordingControls", () => ({ default: () => <div>recording controls</div> }));
vi.mock("../LiveTranscript", () => ({ default: () => <div>live transcript</div> }));
vi.mock("../DailyReviewView", () => ({ default: () => <div>daily review</div> }));
vi.mock("../SessionSummaryPanel", () => ({ default: () => <div>session summary</div> }));
vi.mock("../ActivityClassificationPanel", () => ({ default: () => <div>activity</div> }));
vi.mock("../ActionCenter", () => ({ default: () => <div>action center v1</div> }));
vi.mock("../MiniMaxAgentSettingsCard", () => ({ default: () => null }));
vi.mock("../ResourceGovernanceSettingsCard", () => ({ default: () => null }));
vi.mock("../TranscriptionQualityCard", () => ({ default: () => null }));
vi.mock("../VoiceEnrollment", () => ({ default: () => null }));
vi.mock("../PersonalizationSettingsCard", () => ({ default: () => null }));
vi.mock("../CurrentSessionResultView", () => ({ default: () => null }));

const recording = {
  session: { id: null, status: "idle" },
  sessions: [],
  segments: [],
  partialText: "",
} as unknown as UseJarvisRecordingResult;

const defaults: JarvisRolloutFlags = {
  applicationAudioV1: true,
  dualSpeakerVerificationV1: true,
  activityClassificationV1: true,
  actionCenterV1: true,
};

describe("Today rollout gate", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        jarvis: {
          getRolloutFlags: vi.fn(async () => defaults),
        },
      },
    });
  });

  it("removes only the action center surface when actionCenterV1 is disabled", async () => {
    window.electronAPI.jarvis.getRolloutFlags = vi.fn(async () => ({
      ...defaults,
      actionCenterV1: false,
    }));

    render(<TodayView recording={recording} onOpenSession={() => {}} onViewAllTodos={() => {}} />);

    await waitFor(() => expect(screen.queryByText("action center v1")).not.toBeInTheDocument());
    expect(screen.getByText("activity")).toBeInTheDocument();
    expect(screen.getByText("daily review")).toBeInTheDocument();
  });

  it("keeps the action center enabled for the release rollout", async () => {
    render(<TodayView recording={recording} onOpenSession={() => {}} onViewAllTodos={() => {}} />);

    expect(await screen.findByText("action center v1")).toBeInTheDocument();
  });
});
