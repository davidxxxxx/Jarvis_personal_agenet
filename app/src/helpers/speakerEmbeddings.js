const fs = require("fs");
const crypto = require("node:crypto");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const onnxWorkerClient = require("./onnxWorkerClient");
const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("../jarvis/main/SpeakerModelManifest");

const SAMPLE_RATE = 16000;
const EMBEDDING_DIM = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_MS = MIN_SEGMENT_SECONDS * 1_000;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE * MIN_SEGMENT_SECONDS;
const MAX_EMBEDDING_SECONDS = 10;
const MAX_EMBEDDING_MS = MAX_EMBEDDING_SECONDS * 1_000;
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SPEAKER_EMBEDDING_MODEL_ID = "3dspeaker-campplus-voxceleb-16k-v1";
const LEGACY_MODEL_KEY = "legacy_campplus_voxceleb_v1";
const LEGACY_MODEL = Object.freeze({
  key: LEGACY_MODEL_KEY,
  modelId: SPEAKER_EMBEDDING_MODEL_ID,
  fileName: MODEL_FILE,
  embeddingDimension: EMBEDDING_DIM,
  maximumEmbeddingSeconds: 8,
});

function resampleLinear(samples, inputSampleRate, outputSampleRate = SAMPLE_RATE) {
  if (!(samples instanceof Float32Array)) throw new TypeError("samples must be Float32Array");
  if (!Number.isSafeInteger(inputSampleRate) || inputSampleRate <= 0) {
    throw new RangeError("inputSampleRate must be a positive safe integer");
  }
  if (!Number.isSafeInteger(outputSampleRate) || outputSampleRate <= 0) {
    throw new RangeError("outputSampleRate must be a positive safe integer");
  }
  if (inputSampleRate === outputSampleRate) return samples;
  const outputLength = Math.round((samples.length * outputSampleRate) / inputSampleRate);
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / outputSampleRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    output[index] = samples[leftIndex] * (1 - fraction) + samples[rightIndex] * fraction;
  }
  return output;
}

function decodeEmbeddingBuffer(value) {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
    return new Float32Array(value);
  }
  if (value instanceof Float32Array) return Float32Array.from(value);
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const privateCopy = new Uint8Array(value.byteLength);
    privateCopy.set(bytes);
    return new Float32Array(privateCopy.buffer);
  }
  return null;
}

class SpeakerEmbeddings {
  constructor({
    workerClient = onnxWorkerClient,
    resampleImpl = resampleLinear,
    modelKey = null,
  } = {}) {
    if (!workerClient || typeof workerClient.request !== "function") {
      throw new TypeError("workerClient.request must be a function");
    }
    if (typeof resampleImpl !== "function") throw new TypeError("resampleImpl must be a function");
    this.workerClient = workerClient;
    this.resampleImpl = resampleImpl;
    this.model =
      modelKey === null || modelKey === LEGACY_MODEL_KEY
        ? LEGACY_MODEL
        : getSpeakerModelManifest(modelKey);
    this.modelKey = this.model.key;
    this.loadPromise = null;
    this.artifactHashPromise = null;
  }

  getModelPath() {
    if (process.resourcesPath) {
      const bundledPath = path.join(
        process.resourcesPath,
        "bin",
        "diarization-models",
        this.model.fileName
      );
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), this.model.fileName);
  }

  isAvailable() {
    return fs.existsSync(this.getModelPath());
  }

  getModelArtifactSha256() {
    if (this.artifactHashPromise) return this.artifactHashPromise;
    const modelPath = this.getModelPath();
    this.artifactHashPromise = new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(modelPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    }).catch((error) => {
      this.artifactHashPromise = null;
      throw error;
    });
    return this.artifactHashPromise;
  }

  _ensureLoaded() {
    if (this.loadPromise) return this.loadPromise;
    if (!this.isAvailable()) {
      return Promise.reject(
        new Error(`Speaker embedding model not found at ${this.getModelPath()}`)
      );
    }
    const modelPath = this.getModelPath();
    debugLogger.debug("speaker-embeddings loading model", { modelPath });
    this.loadPromise = this.workerClient
      .request("speaker.load", {
        modelKey: this.modelKey,
        modelId: this.model.modelId,
        modelPath,
        embeddingDimension: this.model.embeddingDimension,
        maximumSamples: SAMPLE_RATE * this.model.maximumEmbeddingSeconds,
      })
      .then(() => debugLogger.debug("speaker-embeddings model loaded"))
      .catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    return this.loadPromise;
  }

  async _extractEmbeddingFromSamples(samples) {
    await this._ensureLoaded();

    const samplesBuffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );

    // No transfer-list: MessagePortMain can't transfer ArrayBuffers, so the samples are cloned.
    try {
      const response = await this.workerClient.request("speaker.extract", {
        modelKey: this.modelKey,
        samplesBuffer,
      });
      let embedding = null;
      if (Array.isArray(response?.embedding)) {
        embedding = Float32Array.from(response.embedding);
      }
      if (response?.embedding === null && response?.reason === "insufficient_samples") {
        return null;
      }
      if (!embedding) embedding = decodeEmbeddingBuffer(response?.embeddingBuffer);
      if (embedding && embedding.length !== this.model.embeddingDimension) {
        const error = new Error("SPEAKER_EMBEDDING_DIMENSION_MISMATCH");
        error.code = "SPEAKER_EMBEDDING_DIMENSION_MISMATCH";
        throw error;
      }
      if (embedding) return embedding;
      const error = new Error("SPEAKER_EMBEDDING_PAYLOAD_INVALID");
      error.code = "SPEAKER_EMBEDDING_PAYLOAD_INVALID";
      throw error;
    } finally {
      new Uint8Array(samplesBuffer).fill(0);
    }
  }

  async extractEmbeddingFromSamples(samples) {
    if (samples.length < MIN_SEGMENT_SAMPLES) return null;
    const capped =
      samples.length > MAX_EMBEDDING_SAMPLES
        ? samples.subarray(samples.length - MAX_EMBEDDING_SAMPLES)
        : samples;
    return this._extractEmbeddingFromSamples(capped);
  }

  async extractEmbedding(wavPath, startSec, endSec) {
    const durationMs = Math.round((endSec - startSec) * 1_000);
    if (durationMs < MIN_SEGMENT_MS) return null;

    const buf = fs.readFileSync(wavPath);
    const { sampleRate, dataOffset } = this._parseWavHeader(buf);

    const cappedDurationMs = Math.min(durationMs, MAX_EMBEDDING_MS);
    const endSample = Math.round(endSec * sampleRate);
    const numSamples = Math.round((cappedDurationMs * sampleRate) / 1_000);
    const startSample = endSample - numSamples;

    const samples = new Float32Array(numSamples);
    let modelSamples = samples;
    const bytesPerSample = 2;
    const offset = dataOffset + startSample * bytesPerSample;

    for (let i = 0; i < numSamples; i++) {
      const bytePos = offset + i * bytesPerSample;
      if (bytePos + 1 >= buf.length) break;
      const int16 = buf.readInt16LE(bytePos);
      samples[i] = int16 / 32768;
    }

    try {
      if (sampleRate !== SAMPLE_RATE) {
        modelSamples = this.resampleImpl(samples, sampleRate, SAMPLE_RATE);
        if (!(modelSamples instanceof Float32Array)) {
          throw new TypeError("resampleImpl must return Float32Array");
        }
      }
      return await this._extractEmbeddingFromSamples(modelSamples);
    } finally {
      if (modelSamples !== samples) modelSamples.fill(0);
      samples.fill(0);
      buf.fill(0);
    }
  }

  _parseWavHeader(buf) {
    let offset = 12;
    let sampleRate = 16000;
    let dataOffset = 44;

    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        sampleRate = buf.readUInt32LE(offset + 12);
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    return { sampleRate, dataOffset };
  }

  computeCentroid(embeddings) {
    const dimension = this.model.embeddingDimension;
    if (embeddings.length === 0) return new Float32Array(dimension);

    const centroid = new Float32Array(dimension);
    for (const emb of embeddings) {
      if (!(emb instanceof Float32Array) || emb.length !== dimension) {
        throw new TypeError("embedding belongs to a different speaker model space");
      }
      for (let i = 0; i < dimension; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < dimension; i++) {
      centroid[i] /= embeddings.length;
    }
    return centroid;
  }

  cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

SpeakerEmbeddings.resampleLinear = resampleLinear;

const instance = new SpeakerEmbeddings();
module.exports = instance;
module.exports.SpeakerEmbeddings = SpeakerEmbeddings;
module.exports.LEGACY_MODEL_KEY = LEGACY_MODEL_KEY;
module.exports.MAX_EMBEDDING_SECONDS = MAX_EMBEDDING_SECONDS;
module.exports.SPEAKER_EMBEDDING_MODEL_ID = SPEAKER_EMBEDDING_MODEL_ID;
module.exports.SPEAKER_MODEL_KEYS = SPEAKER_MODEL_KEYS;
module.exports.decodeEmbeddingBuffer = decodeEmbeddingBuffer;
module.exports.resampleLinear = resampleLinear;
