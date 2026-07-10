export interface MeetingPrepareCaptureOptions {
  captureSystemAudio?: boolean;
  jarvisSessionId?: string | null;
}

export function buildMeetingPrepareOptions<T extends Record<string, unknown>>(
  transcriptionOptions: T,
  captureOptions: MeetingPrepareCaptureOptions = {}
): T & { micOnly: boolean; jarvisSessionId: string | null } {
  return {
    ...transcriptionOptions,
    micOnly: captureOptions.captureSystemAudio === false,
    jarvisSessionId: captureOptions.jarvisSessionId ?? null,
  };
}

export function shouldAwaitRendererPrepare({
  startMicOnly,
  prepareMicOnly,
}: {
  startMicOnly: boolean;
  prepareMicOnly: boolean | null;
}): boolean {
  return !startMicOnly || prepareMicOnly === true;
}
