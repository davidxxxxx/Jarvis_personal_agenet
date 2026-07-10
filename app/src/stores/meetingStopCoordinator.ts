export interface SharedStopResult {
  success: boolean;
  error?: string;
}

export interface SharedStopOptions {
  throwOnError?: boolean;
}

export interface MeetingStopCoordinator<T extends SharedStopResult> {
  stop: (attempt: () => Promise<T>, options?: SharedStopOptions) => Promise<T>;
  hasPendingStop: () => boolean;
}

export function createMeetingStopCoordinator<T extends SharedStopResult>(
  failureResult: (error: unknown) => T
): MeetingStopCoordinator<T> {
  let inFlight: Promise<T> | null = null;
  let retryPending = false;

  const startAttempt = (attempt: () => Promise<T>): Promise<T> => {
    retryPending = true;
    let publishedResult: T | null = null;
    const settled = Promise.resolve()
      .then(attempt)
      .catch((error) => failureResult(error))
      .then((result) => {
        publishedResult = result;
        return result;
      });
    const shared = settled.finally(() => {
      inFlight = null;
      retryPending = publishedResult?.success !== true;
    });
    inFlight = shared;
    return shared;
  };

  return {
    stop: async (attempt, options = {}) => {
      const result = await (inFlight ?? startAttempt(attempt));
      if (!result.success && options.throwOnError) {
        throw new Error(result.error || "Failed to stop meeting transcription");
      }
      return result;
    },
    hasPendingStop: () => retryPending || inFlight !== null,
  };
}
