const NO_SPEECH_MARKER = /^\[\s*(?:blank_audio|silence|inaudible)\s*\]$/iu;
const NO_SPEECH_MESSAGE = /(?:no\s+audio|no\s+speech|blank_audio|silence)/iu;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw codedError("TRANSCRIPTION_INVALID_RESULT");
  }
  if (result.noSpeech === true) {
    if (typeof result.text === "string" && result.text.trim()) {
      throw codedError("TRANSCRIPTION_INVALID_RESULT");
    }
    return { noSpeech: true };
  }
  if (result.success === false) {
    const diagnostic = [result.message, result.reason].filter((value) => typeof value === "string");
    if (diagnostic.some((value) => NO_SPEECH_MESSAGE.test(value))) return { noSpeech: true };
    throw codedError("TRANSCRIPTION_FAILED");
  }
  if (typeof result.text !== "string") {
    throw codedError("TRANSCRIPTION_INVALID_RESULT");
  }
  const text = result.text.replace(/\s+/gu, " ").trim();
  if (!text || NO_SPEECH_MARKER.test(text)) return { noSpeech: true };
  const confidence = result.confidence ?? 0;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw codedError("TRANSCRIPTION_INVALID_RESULT");
  }
  return { text, confidence, noSpeech: false };
}

class JarvisTranscriptionWorker {
  constructor({
    repository,
    audioEvidenceReader,
    transcribeWav,
    inputVersion,
    modelVersion,
    now = Date.now,
  }) {
    if (!repository || typeof repository.getAudioChunk !== "function") {
      throw new TypeError("repository.getAudioChunk must be a function");
    }
    if (
      typeof repository.getTranscriptPrompt !== "function" ||
      typeof repository.commitChunkTranscript !== "function"
    ) {
      throw new TypeError("repository transcript APIs are required");
    }
    if (!audioEvidenceReader || typeof audioEvidenceReader.withVerifiedWav !== "function") {
      throw new TypeError("audioEvidenceReader.withVerifiedWav must be a function");
    }
    if (typeof transcribeWav !== "function") {
      throw new TypeError("transcribeWav must be a function");
    }
    if (!Number.isSafeInteger(inputVersion) || inputVersion < 1) {
      throw new TypeError("inputVersion must be a positive safe integer");
    }
    if (typeof modelVersion !== "string" || !modelVersion.trim() || modelVersion.length > 128) {
      throw new TypeError("modelVersion must be a non-empty string of at most 128 characters");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.repository = repository;
    this.audioEvidenceReader = audioEvidenceReader;
    this.transcribeWav = transcribeWav;
    this.inputVersion = inputVersion;
    this.modelVersion = modelVersion.trim();
    this.now = now;
  }

  async handle(job, executionContext = null) {
    const resourceContext = executionContext?.device ? executionContext : null;
    if (job?.input_version !== this.inputVersion || job?.model_version !== this.modelVersion) {
      throw codedError("TRANSCRIPTION_LINEAGE_MISMATCH");
    }
    const chunkId = job?.chunk_id;
    let chunk;
    try {
      chunk = this.repository.getAudioChunk(chunkId);
    } catch {
      throw codedError("AUDIO_UNAVAILABLE");
    }
    if (chunk && job.input_hash !== chunk.sha256) {
      throw codedError("TRANSCRIPTION_LINEAGE_MISMATCH");
    }
    const at = this.now();
    if (
      !chunk ||
      chunk.deleted_at !== null ||
      chunk.write_state !== "committed" ||
      !chunk.path ||
      chunk.path.startsWith("tombstone:") ||
      !["wav", "flac"].includes(chunk.format) ||
      (Number.isFinite(chunk.expires_at) && at >= chunk.expires_at)
    ) {
      throw codedError("AUDIO_UNAVAILABLE");
    }

    const initialPrompt = this.repository.getTranscriptPrompt(chunk.session_id, chunk.track_id);
    let transcriptionStarted = false;
    let rawResult;
    try {
      rawResult = await this.audioEvidenceReader.withVerifiedWav(chunk, (verifiedPath) => {
        transcriptionStarted = true;
        return this.transcribeWav({
          path: verifiedPath,
          language: null,
          initialPrompt,
          executionContext: resourceContext,
        });
      });
    } catch (error) {
      if (!transcriptionStarted || error?.code === "audio_expired") {
        throw codedError("AUDIO_UNAVAILABLE");
      }
      if (
        error?.code === "TRANSCRIPTION_FAILED" ||
        error?.code === "TRANSCRIPTION_INVALID_RESULT" ||
        error?.code === "EXECUTION_DEVICE_MISMATCH"
      ) {
        throw error;
      }
      throw codedError("TRANSCRIPTION_FAILED");
    }

    if (resourceContext && rawResult?.executionDevice !== resourceContext.device) {
      throw codedError("EXECUTION_DEVICE_MISMATCH");
    }
    const result = normalizeResult(rawResult);
    this.repository.commitChunkTranscript({
      chunk,
      result,
      modelVersion: this.modelVersion,
      completedAt: this.now(),
    });
    return resourceContext ? { executionDevice: rawResult.executionDevice } : undefined;
  }
}

module.exports = JarvisTranscriptionWorker;
module.exports.normalizeResult = normalizeResult;
