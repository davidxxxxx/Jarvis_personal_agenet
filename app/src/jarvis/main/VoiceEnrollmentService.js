const SAMPLE_RATE = 16_000;
const REQUIRED_WINDOWS = 3;
const MIN_TOTAL_SECONDS = 24;

function assertWindow(window, index) {
  if (!window || typeof window !== "object") {
    throw new TypeError(`sample window ${index + 1} is required`);
  }
  const { startSample, endSample, samples } = window;
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)) {
    throw new TypeError("sample window boundaries must be safe integers");
  }
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError("sample window samples must be a non-empty Float32Array");
  }
  if (startSample < 0 || endSample <= startSample || endSample - startSample !== samples.length) {
    throw new TypeError("sample window boundaries must match its samples");
  }
  return { startSample, endSample, samples };
}

class VoiceEnrollmentService {
  constructor({ speakerEmbeddings, databaseManager, repository }) {
    if (
      !speakerEmbeddings ||
      typeof speakerEmbeddings.extractEmbeddingFromSamples !== "function" ||
      typeof speakerEmbeddings.computeCentroid !== "function"
    ) {
      throw new TypeError("speakerEmbeddings is required");
    }
    if (!databaseManager || typeof databaseManager.upsertSpeakerProfile !== "function") {
      throw new TypeError("databaseManager is required");
    }
    if (!repository || typeof repository.renamePerson !== "function") {
      throw new TypeError("repository is required");
    }
    this.speakerEmbeddings = speakerEmbeddings;
    this.databaseManager = databaseManager;
    this.repository = repository;
  }

  async enroll(sampleWindows) {
    if (!Array.isArray(sampleWindows) || sampleWindows.length !== REQUIRED_WINDOWS) {
      throw new TypeError("voice enrollment requires exactly three sample windows");
    }

    const windows = sampleWindows.map(assertWindow).sort((a, b) => a.startSample - b.startSample);
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index].startSample < windows[index - 1].endSample) {
        throw new TypeError("voice enrollment sample windows must not overlap");
      }
    }
    const totalSamples = windows.reduce((sum, window) => sum + window.samples.length, 0);
    if (totalSamples < SAMPLE_RATE * MIN_TOTAL_SECONDS) {
      throw new TypeError("voice enrollment requires at least 24 seconds of speech");
    }

    const embeddings = [];
    for (const window of windows) {
      const embedding = await this.speakerEmbeddings.extractEmbeddingFromSamples(window.samples);
      if (embedding instanceof Float32Array && embedding.length > 0) embeddings.push(embedding);
    }
    if (embeddings.length !== REQUIRED_WINDOWS) {
      throw new Error("voice enrollment requires three valid speech samples");
    }

    const centroid = this.speakerEmbeddings.computeCentroid(embeddings);
    if (!(centroid instanceof Float32Array) || centroid.length === 0) {
      throw new Error("voice enrollment could not create a speaker profile");
    }
    const profile = this.databaseManager.upsertSpeakerProfile(
      "我",
      null,
      Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength)
    );
    await this.repository.renamePerson({
      personId: "self",
      displayName: "我",
      isSelf: true,
      voiceProfileId: profile.id,
    });

    return { profileId: profile.id };
  }
}

module.exports = VoiceEnrollmentService;
module.exports.SAMPLE_RATE = SAMPLE_RATE;
