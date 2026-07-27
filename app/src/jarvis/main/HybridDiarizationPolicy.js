const { MODEL_PACK_VERSION } = require("./AiModelPackVersion");

const HYBRID_DIARIZATION_POLICY = Object.freeze({
  policyId: "jarvis-hybrid-diarization-v3",
  diarizerModelId: "pyannote-community-1+sherpa-campplus-verifier+mossformer2-ss-16k",
  embeddingModelId: "3dspeaker-campplus-voxceleb-16k-v1",
  embeddingDimension: 512,
  sampleRate: 16_000,
  minimumEmbeddingMs: 1_500,
  maximumEmbeddingMs: 8_000,
  turnBoundaryToleranceMs: 100,
  inputVersion: 2,
  executionDevice: "cuda",
  modelPackVersion: MODEL_PACK_VERSION,
  clusterSimilarityThreshold: 0.72,
  echoSimilarityThreshold: 0.95,
  minimumSpeakers: 1,
  maximumSpeakers: 8,
  verifierMaximumSpeakers: 8,
  finalWindowMs: 15 * 60_000,
  finalWindowOverlapMs: 45_000,
  overlapPaddingMs: 250,
  unloadDelayMs: 5 * 60_000,
  models: Object.freeze({
    primary: Object.freeze({
      id: "pyannote/speaker-diarization-community-1",
      revision: "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee",
      license: "CC-BY-4.0",
      role: "final_primary",
    }),
    verifier: Object.freeze({
      id: "sherpa-onnx/pyannote-segmentation-3.0+3dspeaker-campplus",
      revision: "k2-fsa-model-bundle-2024-10-14",
      license: "Apache-2.0/MODEL-SPECIFIC",
      role: "windows_native_count_verifier",
    }),
    separator: Object.freeze({
      id: "alibabasglab/MossFormer2_SS_16K",
      revision: "407cb030cd66340918ebb6c8cc63b18f8592cdbe",
      license: "Apache-2.0",
      role: "overlap_only_two_speaker_separation",
    }),
  }),
});

module.exports = {
  HYBRID_DIARIZATION_POLICY,
};
