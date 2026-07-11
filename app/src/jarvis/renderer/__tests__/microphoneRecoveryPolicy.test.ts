import { describe, expect, it } from "vitest";
import {
  getMicrophoneRecoveryDelay,
  isDeniedAutomaticMicrophone,
  orderMicrophoneRecoveryCandidates,
} from "../microphoneRecoveryPolicy";

const input = (deviceId: string, label: string) =>
  ({ kind: "audioinput", deviceId, label }) as MediaDeviceInfo;

describe("microphoneRecoveryPolicy", () => {
  it.each(["SteelSeries SONAR", "VoiceMeeter Output", "Steam Streaming Mic", "YY AI Voice"])(
    "denies virtual input %s",
    (label) => expect(isDeniedAutomaticMicrophone(label)).toBe(true)
  );

  it.each(["Microphone (5- Shure MV7)", "Microphone (6- Arctis Nova Pro)"])(
    "allows physical input %s",
    (label) => expect(isDeniedAutomaticMicrophone(label)).toBe(false)
  );

  it("orders the saved physical device first and removes unsafe candidates", () => {
    const devices = [
      input("default", "SteelSeries Sonar - Microphone"),
      input("shure", "Microphone (5- Shure MV7)"),
      input("arctis", "Microphone (6- Arctis Nova Pro)"),
      input("hidden", ""),
      input("shure", "Microphone (5- Shure MV7)"),
      input("duplicate-label", "Microphone (5- Shure MV7)"),
    ];

    expect(orderMicrophoneRecoveryCandidates(devices, "arctis")).toEqual([
      { deviceId: "arctis", label: "Microphone (6- Arctis Nova Pro)" },
      { deviceId: "shure", label: "Microphone (5- Shure MV7)" },
    ]);
  });

  it("backs off to a stable ten-second retry interval", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => getMicrophoneRecoveryDelay(attempt))).toEqual([
      0, 500, 1000, 2000, 5000, 10000, 10000, 10000,
    ]);
  });
});
