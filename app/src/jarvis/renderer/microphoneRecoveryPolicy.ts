const DENIED_AUTOMATIC_MICROPHONE_TOKENS = ["sonar", "voicemeeter", "steam", "yy"];
const RECOVERY_DELAYS_MS = [0, 500, 1000, 2000, 5000, 10000] as const;

export interface MicrophoneRecoveryCandidate {
  deviceId: string;
  label: string;
}

export function isDeniedAutomaticMicrophone(label: string): boolean {
  const normalized = label.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    DENIED_AUTOMATIC_MICROPHONE_TOKENS.some((token) => normalized.includes(token))
  );
}

export function orderMicrophoneRecoveryCandidates(
  devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  selectedDeviceId: string | null | undefined
): MicrophoneRecoveryCandidate[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const allowed = devices
    .filter((device) => device.kind === "audioinput")
    .filter((device) => device.deviceId !== "default")
    .filter((device) => !isDeniedAutomaticMicrophone(device.label))
    .filter((device) => {
      const normalizedLabel = device.label.trim().toLocaleLowerCase();
      if (seenIds.has(device.deviceId) || seenLabels.has(normalizedLabel)) return false;
      seenIds.add(device.deviceId);
      seenLabels.add(normalizedLabel);
      return true;
    })
    .map(({ deviceId, label }) => ({ deviceId, label }));

  return [
    ...allowed.filter((candidate) => candidate.deviceId === selectedDeviceId),
    ...allowed.filter((candidate) => candidate.deviceId !== selectedDeviceId),
  ];
}

export function getMicrophoneRecoveryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), RECOVERY_DELAYS_MS.length - 1);
  return RECOVERY_DELAYS_MS[index];
}
