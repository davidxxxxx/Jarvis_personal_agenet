const { createHash } = require("node:crypto");

const PREVIEW_CONTEXT_ROW_LIMIT = 16;

const PREVIEW_PROMPT_CODE_POINT_LIMIT = 1_024;

function previewBoundary(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeTimestampAdd(base, relative, name) {
  const result = base + relative;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} safe integer overflow`);
  return result;
}

function takeCodePointTail(value, limit) {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join("");
}

function createCommittedAudioPreviewExecutor({ repository, previewAudioRing, transcribeWav }) {
  if (
    typeof repository?.getSession !== "function" ||
    typeof repository?.listPreviewTranscriptContext !== "function"
  ) {
    throw new TypeError("repository preview context APIs are required");
  }
  if (!previewAudioRing || typeof previewAudioRing.withPreviewWav !== "function") {
    throw new TypeError("previewAudioRing.withPreviewWav must be a function");
  }
  if (typeof transcribeWav !== "function") throw new TypeError("transcribeWav must be a function");
  return async ({
    sessionId,
    trackId,
    fromMs,
    throughMs,
    executionDevice,
    selectedGpuUuid,
    cpuThreads,
    lowPriority,
  }) => {
    const safeFromMs = previewBoundary(fromMs, "fromMs");
    const safeThroughMs = previewBoundary(throughMs, "throughMs");
    if (safeThroughMs <= safeFromMs) throw new RangeError("preview requires fromMs < throughMs");
    const session = repository.getSession(sessionId);
    if (!session) throw new Error("preview session is unavailable");
    const sessionStartedAt = previewBoundary(session.started_at, "session.started_at");
    const absoluteFrom = safeTimestampAdd(sessionStartedAt, safeFromMs, "preview from");
    const absoluteThrough = safeTimestampAdd(sessionStartedAt, safeThroughMs, "preview through");
    const contextRows = repository.listPreviewTranscriptContext({
      sessionId,
      trackId,
      from: absoluteFrom,
      to: absoluteThrough,
      limit: PREVIEW_CONTEXT_ROW_LIMIT,
    });
    if (!Array.isArray(contextRows)) throw new TypeError("preview context rows must be an array");
    const prompt = takeCodePointTail(
      contextRows
        .slice(-PREVIEW_CONTEXT_ROW_LIMIT)
        .map((segment) =>
          typeof segment?.text === "string" ? segment.text.replace(/\s+/gu, " ").trim() : ""
        )
        .filter(Boolean)
        .join(" "),
      PREVIEW_PROMPT_CODE_POINT_LIMIT
    );
    const segment = await previewAudioRing.withPreviewWav(
      { sessionId, trackId, fromMs: safeFromMs, throughMs: safeThroughMs },
      async (snapshot) => {
        const raw = await transcribeWav({
          path: snapshot.path,
          language: null,
          initialPrompt: prompt,
          executionContext: {
            device: executionDevice,
            selectedGpuUuid: executionDevice === "cuda" ? selectedGpuUuid : null,
            cpuThreads,
            lowPriority,
          },
        });
        if (raw?.executionDevice !== executionDevice) {
          throw new Error("EXECUTION_DEVICE_MISMATCH");
        }
        if (raw?.noSpeech === true) return null;
        if (raw?.success === false || typeof raw?.text !== "string") {
          throw new Error("TRANSCRIPTION_INVALID_RESULT");
        }
        const text = raw.text.replace(/\s+/gu, " ").trim();
        if (!text) return null;
        const confidence = raw.confidence ?? 0;
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error("TRANSCRIPTION_INVALID_RESULT");
        }
        const startedAt = session.started_at + snapshot.fromMs;
        const endedAt = session.started_at + snapshot.throughMs;
        const id = `preview_${createHash("sha256")
          .update(`${sessionId}\u0000${trackId}\u0000${snapshot.sha256}\u0000${throughMs}`)
          .digest("hex")
          .slice(0, 32)}`;
        return {
          id,
          startedAt,
          endedAt,
          personId: null,
          speakerLabel: snapshot.sourceType,
          sourceType: snapshot.sourceType,
          text,
          confidence,
          isStable: false,
        };
      }
    );
    return { segments: segment ? [segment] : [] };
  };
}

module.exports = { createCommittedAudioPreviewExecutor };
