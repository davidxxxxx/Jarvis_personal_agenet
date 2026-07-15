const VAD_SAMPLE_RATE = 24_000;
const VAD_WINDOW_MS = 32;
const VAD_WINDOW_SAMPLES = (VAD_SAMPLE_RATE * VAD_WINDOW_MS) / 1_000;
const SPEECH_THRESHOLD = 0.5;

function pcm16FromSamples(samples, startSample, sampleCount) {
  const pcm = Buffer.alloc(sampleCount * Int16Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[startSample + index]));
    const int16 = value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
    pcm.writeInt16LE(int16, index * Int16Array.BYTES_PER_ELEMENT);
  }
  return pcm;
}

function validateDetails(details, expectedWindows) {
  if (
    details?.windowCount !== expectedWindows ||
    !Array.isArray(details?.probabilities) ||
    details.probabilities.length !== expectedWindows
  ) {
    throw new Error("Silero detailed VAD result does not match the enrollment window");
  }
  return details.probabilities;
}

class VoiceSpeechDurationMeasurer {
  constructor({ classifier, speechThreshold = SPEECH_THRESHOLD }) {
    if (
      !classifier ||
      typeof classifier.classifyDetailed !== "function" ||
      typeof classifier.reset !== "function"
    ) {
      throw new TypeError("a detailed VAD classifier is required");
    }
    if (
      typeof speechThreshold !== "number" ||
      !Number.isFinite(speechThreshold) ||
      speechThreshold < 0 ||
      speechThreshold > 1
    ) {
      throw new RangeError("speechThreshold must be between zero and one");
    }
    this.classifier = classifier;
    this.speechThreshold = speechThreshold;
  }

  async measureSpeechMs({ sessionId, windowIndex, sampleRate, samples }) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    if (!Number.isSafeInteger(windowIndex) || windowIndex < 0) {
      throw new TypeError("windowIndex must be a non-negative safe integer");
    }
    if (sampleRate !== VAD_SAMPLE_RATE || !(samples instanceof Float32Array)) {
      throw new TypeError("voice speech measurement requires 24 kHz Float32 PCM");
    }
    if (samples.length < VAD_WINDOW_SAMPLES) {
      throw new RangeError("voice speech measurement requires at least one VAD window");
    }
    if (typeof this.classifier.isReady === "function" && !this.classifier.isReady()) {
      if (typeof this.classifier.initialize !== "function") {
        throw new Error("Silero VAD is unavailable");
      }
      await this.classifier.initialize();
    }

    const fullWindowCount = Math.floor(samples.length / VAD_WINDOW_SAMPLES);
    const fullSampleCount = fullWindowCount * VAD_WINDOW_SAMPLES;
    const tailSampleCount = samples.length - fullSampleCount;
    const mainPcm = pcm16FromSamples(samples, 0, fullSampleCount);
    const tailPcm =
      tailSampleCount > 0
        ? pcm16FromSamples(samples, samples.length - VAD_WINDOW_SAMPLES, VAD_WINDOW_SAMPLES)
        : null;
    const streamPrefix = `${sessionId}:voice-enrollment:${windowIndex}`;
    const mainStreamId = `${streamPrefix}:main`;
    const tailStreamId = `${streamPrefix}:tail`;
    let operationError = null;
    let speechMs = 0;
    let resetErrors = [];
    try {
      const mainDetails = await this.classifier.classifyDetailed({
        sessionId,
        sourceType: "mic",
        streamId: mainStreamId,
        sampleRate,
        pcm: mainPcm,
      });
      const mainProbabilities = validateDetails(mainDetails, fullWindowCount);
      speechMs =
        mainProbabilities.filter((probability) => probability >= this.speechThreshold).length *
        VAD_WINDOW_MS;

      if (tailPcm) {
        const tailDetails = await this.classifier.classifyDetailed({
          sessionId,
          sourceType: "mic",
          streamId: tailStreamId,
          sampleRate,
          pcm: tailPcm,
        });
        const [tailProbability] = validateDetails(tailDetails, 1);
        if (tailProbability >= this.speechThreshold) {
          speechMs += Math.round((tailSampleCount * 1_000) / sampleRate);
        }
      }
    } catch (error) {
      operationError = error;
    } finally {
      mainPcm.fill(0);
      tailPcm?.fill(0);
      const resetResults = await Promise.allSettled([
        Promise.resolve().then(() => this.classifier.reset(mainStreamId)),
        ...(tailPcm ? [Promise.resolve().then(() => this.classifier.reset(tailStreamId))] : []),
      ]);
      resetErrors = resetResults
        .filter((reset) => reset.status === "rejected")
        .map((reset) => reset.reason);
    }
    if (operationError !== null) throw operationError;
    if (resetErrors.length > 0) {
      throw new AggregateError(resetErrors, "voice enrollment VAD stream reset failed");
    }
    return speechMs;
  }
}

module.exports = VoiceSpeechDurationMeasurer;
module.exports.SPEECH_THRESHOLD = SPEECH_THRESHOLD;
