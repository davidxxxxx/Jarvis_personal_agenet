import { describe, expect, it } from "vitest";
import { buildMeetingPrepareOptions, shouldAwaitRendererPrepare } from "../meetingPreparation";

describe("meeting preparation", () => {
  it("forwards mic-only and Jarvis session context to main prepare", () => {
    expect(
      buildMeetingPrepareOptions(
        { provider: "openai-realtime", model: "transcribe", language: "zh" },
        { captureSystemAudio: false, jarvisSessionId: "s1" }
      )
    ).toEqual({
      provider: "openai-realtime",
      model: "transcribe",
      language: "zh",
      micOnly: true,
      jarvisSessionId: "s1",
    });
  });

  it("does not await an incompatible non-mic prepare before mic-only start", () => {
    expect(shouldAwaitRendererPrepare({ startMicOnly: true, prepareMicOnly: false })).toBe(false);
    expect(shouldAwaitRendererPrepare({ startMicOnly: true, prepareMicOnly: true })).toBe(true);
    expect(shouldAwaitRendererPrepare({ startMicOnly: false, prepareMicOnly: false })).toBe(true);
  });
});
