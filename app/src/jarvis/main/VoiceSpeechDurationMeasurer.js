const VAD_SAMPLE_RATE = 24_000;
const VAD_WINDOW_MS = 32;
const VAD_WINDOW_SAMPLES = (VAD_SAMPLE_RATE * VAD_WINDOW_MS) / 1_000;
const SPEECH_THRESHOLD = 0.5;

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
    if (typeof this.classifier.isReady === "function" && !this.classifier.isReady()) {
      if (typeof this.classifier.initialize !== "function") {
        throw new Error("Silero VAD is unavailable");
      }
      await this.classifier.initialize();
    }

    const frameCount = Math.ceil(samples.length / VAD_WINDOW_SAMPLES);
    const pcm = Buffer.alloc(frameCount * VAD_WINDOW_SAMPLES * Int16Array.BYTES_PER_ELEMENT);
    const streamId = `${sessionId}:voice-enrollment:${windowIndex}`;
    try {
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        const int16 = value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
        pcm.writeInt16LE(int16, index * Int16Array.BYTES_PER_ELEMENT);
      }
      const details = await this.classifier.classifyDetailed({
        sessionId,
        sourceType: "mic",
        streamId,
        sampleRate,
        pcm,
      });
      if (
        details?.windowCount !== frameCount ||
        !Array.isArray(details?.probabilities) ||
        details.probabilities.length !== frameCount
      ) {
        throw new Error("Silero detailed VAD result does not match the enrollment window");
      }
      let speechMs = 0;
      for (let index = 0; index < frameCount; index += 1) {
        if (details.probabilities[index] < this.speechThreshold) continue;
        const actualSamples = Math.min(
          VAD_WINDOW_SAMPLES,
          samples.length - index * VAD_WINDOW_SAMPLES
        );
        speechMs += Math.round((actualSamples * 1_000) / sampleRate);
      }
      return speechMs;
    } finally {
      pcm.fill(0);
      await this.classifier.reset(streamId);
    }
  }
}

module.exports = VoiceSpeechDurationMeasurer;
module.exports.SPEECH_THRESHOLD = SPEECH_THRESHOLD;
