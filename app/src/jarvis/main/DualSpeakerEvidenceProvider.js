const {
  SPEAKER_MODEL_KEYS,
  getSpeakerModelManifest,
} = require("./SpeakerModelManifest");

const REQUIRED_WINDOWS = 3;
const MINIMUM_SPEECH_MS = 12_000;

function normalize(value, manifest) {
  if (!(value instanceof Float32Array) || value.length !== manifest.embeddingDimension) {
    return null;
  }
  let squared = 0;
  for (const item of value) {
    if (!Number.isFinite(item)) return null;
    squared += item * item;
  }
  if (!Number.isFinite(squared) || squared <= 0) return null;
  const norm = Math.sqrt(squared);
  return Float32Array.from(value, (item) => item / norm);
}

function centroid(embeddings, manifest) {
  const sum = new Float32Array(manifest.embeddingDimension);
  for (const embedding of embeddings) {
    for (let index = 0; index < sum.length; index += 1) sum[index] += embedding[index];
  }
  const result = normalize(sum, manifest);
  sum.fill(0);
  return result;
}

function cosine(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return Math.max(-1, Math.min(1, value));
}

function selectWindows(windows) {
  return windows
    .filter(
      (entry) =>
        entry &&
        entry.attributionState === "exact" &&
        entry.overlapDetected !== true &&
        entry.echoDetected !== true &&
        entry.excludedFromCentroid !== true &&
        Number.isSafeInteger(entry.startMs) &&
        Number.isSafeInteger(entry.endMs) &&
        entry.endMs > entry.startMs &&
        entry.chunk
    )
    .sort(
      (left, right) =>
        right.endMs - right.startMs - (left.endMs - left.startMs) ||
        left.startMs - right.startMs ||
        String(left.id).localeCompare(String(right.id), "en")
    )
    .slice(0, REQUIRED_WINDOWS)
    .sort((left, right) => left.startMs - right.startMs);
}

class DualSpeakerEvidenceProvider {
  constructor({
    repository,
    audioEvidenceReader,
    primaryEmbeddings,
    reviewEmbeddings,
    primaryManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY),
    reviewManifest = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW),
  } = {}) {
    if (
      !repository ||
      typeof repository.listSpeakerIdentityAudioWindows !== "function" ||
      typeof repository.replaceSpeakerClusterModelEmbeddings !== "function"
    ) {
      throw new TypeError("repository must provide dual speaker evidence persistence");
    }
    if (!audioEvidenceReader || typeof audioEvidenceReader.withVerifiedWav !== "function") {
      throw new TypeError("audioEvidenceReader.withVerifiedWav is required");
    }
    for (const [label, runtime] of [
      ["primary", primaryEmbeddings],
      ["review", reviewEmbeddings],
    ]) {
      if (!runtime || typeof runtime.extractEmbedding !== "function") {
        throw new TypeError(`${label} speaker embedding runtime is required`);
      }
    }
    this.repository = repository;
    this.audioEvidenceReader = audioEvidenceReader;
    this.primaryEmbeddings = primaryEmbeddings;
    this.reviewEmbeddings = reviewEmbeddings;
    this.primaryManifest = primaryManifest;
    this.reviewManifest = reviewManifest;
  }

  async buildClusterEvidence({ sessionId, evidenceRunId, clusterId, createdAt } = {}) {
    const allWindows = this.repository.listSpeakerIdentityAudioWindows({
      sessionId,
      evidenceRunId,
      clusterId,
    });
    const windows = selectWindows(allWindows);
    const source = allWindows[0] ?? null;
    if (source?.attributionState !== "exact") {
      return { eligible: false, reason: "source_unknown" };
    }
    if (windows.length < REQUIRED_WINDOWS) {
      return {
        eligible: false,
        reason: allWindows.some((entry) => entry.overlapDetected)
          ? "overlapping_speech"
          : "insufficient_windows",
      };
    }
    const modelEntries = [
      {
        role: "primary",
        manifest: this.primaryManifest,
        runtime: this.primaryEmbeddings,
        embeddings: [],
      },
      {
        role: "review",
        manifest: this.reviewManifest,
        runtime: this.reviewEmbeddings,
        embeddings: [],
      },
    ];
    try {
      for (const window of windows) {
        const relativeStartSec = (window.startMs - window.chunk.started_at) / 1_000;
        const relativeEndSec = (window.endMs - window.chunk.started_at) / 1_000;
        await this.audioEvidenceReader.withVerifiedWav(window.chunk, async (wavPath) => {
          for (const entry of modelEntries) {
            const raw = await entry.runtime.extractEmbedding(
              wavPath,
              relativeStartSec,
              relativeEndSec
            );
            if (raw === null || raw === undefined) continue;
            try {
              const normalized = normalize(raw, entry.manifest);
              if (normalized) entry.embeddings.push(normalized);
            } finally {
              raw.fill(0);
            }
          }
        });
      }
      if (modelEntries.some((entry) => entry.embeddings.length < REQUIRED_WINDOWS)) {
        return { eligible: false, reason: "dual_embedding_missing" };
      }
      const speechMs = windows.reduce(
        (total, entry) => total + entry.endMs - entry.startMs,
        0
      );
      if (speechMs < MINIMUM_SPEECH_MS) {
        return { eligible: false, reason: "insufficient_speech" };
      }
      const models = {};
      for (const entry of modelEntries) {
        const modelCentroid = centroid(entry.embeddings, entry.manifest);
        if (!modelCentroid) return { eligible: false, reason: "dual_embedding_invalid" };
        const qualityScore = Math.min(
          ...entry.embeddings.map((embedding) => cosine(embedding, modelCentroid))
        );
        models[entry.role] = {
          modelId: entry.manifest.modelId,
          artifactVersion: entry.manifest.artifactVersion,
          embeddingSpace: entry.manifest.embeddingSpace,
          embedding: modelCentroid,
          qualityScore,
        };
      }
      const qualityScore = Math.min(models.primary.qualityScore, models.review.qualityScore);
      const persisted = this.repository.replaceSpeakerClusterModelEmbeddings({
        clusterId,
        sourceKind: source.trackKind,
        attributionState: source.attributionState,
        overlapDetected: false,
        echoDetected: false,
        speechMs,
        windowCount: REQUIRED_WINDOWS,
        qualityScore,
        createdAt,
        models: Object.values(models),
      });
      return {
        eligible: true,
        reason: null,
        attributionState: source.attributionState,
        overlapDetected: false,
        echoDetected: false,
        speechMs,
        windowCount: REQUIRED_WINDOWS,
        qualityScore,
        models,
        persisted,
      };
    } finally {
      for (const entry of modelEntries) {
        for (const embedding of entry.embeddings) embedding.fill(0);
      }
    }
  }
}

module.exports = DualSpeakerEvidenceProvider;
module.exports.selectWindows = selectWindows;
