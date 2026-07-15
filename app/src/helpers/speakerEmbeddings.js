const fs = require("fs");
const crypto = require("node:crypto");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const onnxWorkerClient = require("./onnxWorkerClient");

const SAMPLE_RATE = 16000;
const EMBEDDING_DIM = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE * MIN_SEGMENT_SECONDS;
const MAX_EMBEDDING_SECONDS = 10;
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SPEAKER_EMBEDDING_MODEL_ID = "3dspeaker-campplus-voxceleb-16k-v1";

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

class SpeakerEmbeddings {
  constructor({ workerClient = onnxWorkerClient, resampleImpl = resampleLinear } = {}) {
    if (!workerClient || typeof workerClient.request !== "function") {
      throw new TypeError("workerClient.request must be a function");
    }
    if (typeof resampleImpl !== "function") throw new TypeError("resampleImpl must be a function");
    this.workerClient = workerClient;
    this.resampleImpl = resampleImpl;
    this.loadPromise = null;
    this.artifactHashPromise = null;
  }

  getModelPath() {
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "bin", "diarization-models", MODEL_FILE);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), MODEL_FILE);
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
      .request("speaker.load", { modelPath })
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
      const { embeddingBuffer } = await this.workerClient.request("speaker.extract", {
        samplesBuffer,
      });

      if (!embeddingBuffer) return null;
      return new Float32Array(embeddingBuffer);
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
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;

    const buf = fs.readFileSync(wavPath);
    const { sampleRate, dataOffset } = this._parseWavHeader(buf);

    const cappedSeconds = Math.min(endSec - startSec, MAX_EMBEDDING_SECONDS);
    const cappedStartSec = endSec - cappedSeconds;
    const startSample = Math.floor(cappedStartSec * sampleRate);
    const endSample = Math.floor(endSec * sampleRate);
    const numSamples = endSample - startSample;

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
    if (embeddings.length === 0) return new Float32Array(EMBEDDING_DIM);

    const centroid = new Float32Array(EMBEDDING_DIM);
    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
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
module.exports.MAX_EMBEDDING_SECONDS = MAX_EMBEDDING_SECONDS;
module.exports.SPEAKER_EMBEDDING_MODEL_ID = SPEAKER_EMBEDDING_MODEL_ID;
module.exports.resampleLinear = resampleLinear;
