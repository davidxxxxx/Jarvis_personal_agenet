"use strict";

const fs = require("node:fs");
const { computeSpeakerIdentityMetrics } = require("./SpeakerIdentityMetrics");

function codedError(code) {
  const error = new Error(`Speaker evaluation failed (${code}).`);
  error.code = code;
  return error;
}

function assertInference(inference) {
  for (const method of ["diarizeAudio", "embedAudio", "computeCentroid", "cosineSimilarity"]) {
    if (typeof inference?.[method] !== "function")
      throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
  }
}

function finiteEmbedding(value) {
  if (!(value instanceof Float32Array) && !(value instanceof Float64Array)) return false;
  if (value.length !== 512) return false;
  let norm = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) return false;
    norm += component * component;
  }
  return norm > 0 && Number.isFinite(norm);
}

function normalizeTurn(raw, durationMs) {
  const clusterId = raw?.clusterId ?? raw?.speaker ?? raw?.label;
  const startMs = raw?.startMs ?? raw?.start * 1_000;
  const endMs = raw?.endMs ?? raw?.end * 1_000;
  if (
    typeof clusterId !== "string" ||
    !clusterId ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > durationMs
  ) {
    throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
  }
  const roundedStart = Math.round(startMs);
  const roundedEnd = Math.round(endMs);
  if (roundedEnd <= roundedStart || roundedEnd > durationMs) {
    throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
  }
  return { clusterId, startMs: roundedStart, endMs: roundedEnd };
}

async function evaluatePreparedSpeakerFixtures({ prepared, inference, resolver, policy } = {}) {
  if (prepared?.status !== "ready") throw codedError("SPEAKER_EVAL_NOT_READY");
  assertInference(inference);
  if (!resolver || typeof resolver.resolveCluster !== "function") {
    throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
  }
  if (!policy || typeof policy.modelId !== "string") {
    throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
  }

  const sensitiveVectors = new Set();
  try {
    const samples = [];
    const personKinds = new Map();
    for (const profile of prepared.manifest.profiles) {
      personKinds.set(profile.personId, profile.kind);
      for (let index = 0; index < profile.audio.length; index += 1) {
        const audio = prepared.audioFiles.get(profile.audio[index]);
        if (!audio) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
        let embedding;
        try {
          embedding = await inference.embedAudio({
            audioPath: audio.path,
            startSec: 0,
            endSec: audio.durationMs / 1_000,
          });
        } catch {
          throw codedError("SPEAKER_EVAL_INFERENCE_FAILED");
        }
        if (!finiteEmbedding(embedding)) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
        sensitiveVectors.add(embedding);
        samples.push({
          id: `${profile.personId}-${String(index + 1).padStart(2, "0")}`,
          personId: profile.personId,
          modelId: policy.modelId,
          embedding,
        });
      }
    }

    const metricCases = [];
    for (const evaluationCase of prepared.manifest.cases) {
      const audio = prepared.audioFiles.get(evaluationCase.audio);
      if (!audio) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
      let rawTurns;
      try {
        rawTurns = await inference.diarizeAudio({
          audioPath: audio.path,
          numSpeakers: evaluationCase.speakers.length,
        });
      } catch {
        throw codedError("SPEAKER_EVAL_INFERENCE_FAILED");
      }
      if (!Array.isArray(rawTurns)) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
      const predictedTurns = rawTurns
        .map((turn) => normalizeTurn(turn, audio.durationMs))
        .sort(
          (left, right) =>
            left.startMs - right.startMs ||
            left.endMs - right.endMs ||
            left.clusterId.localeCompare(right.clusterId, "en")
        );

      const turnsByCluster = new Map();
      for (const turn of predictedTurns) {
        const entries = turnsByCluster.get(turn.clusterId) ?? [];
        entries.push(turn);
        turnsByCluster.set(turn.clusterId, entries);
      }

      const decisions = [];
      for (const [clusterId, turns] of [...turnsByCluster].sort(([left], [right]) =>
        left.localeCompare(right, "en")
      )) {
        const embeddings = [];
        for (const turn of turns) {
          let embedding;
          try {
            embedding = await inference.embedAudio({
              audioPath: audio.path,
              startSec: turn.startMs / 1_000,
              endSec: turn.endMs / 1_000,
            });
          } catch {
            throw codedError("SPEAKER_EVAL_INFERENCE_FAILED");
          }
          if (embedding === null) continue;
          if (!finiteEmbedding(embedding)) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
          sensitiveVectors.add(embedding);
          embeddings.push(embedding);
        }

        let decision;
        if (embeddings.length === 0) {
          decision = {
            state: "unknown",
            candidatePersonId: null,
            score: null,
            margin: null,
            reason: "insufficient_windows",
          };
        } else {
          const centroid = inference.computeCentroid(embeddings);
          if (!finiteEmbedding(centroid)) throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
          sensitiveVectors.add(centroid);
          const qualities = embeddings.map((embedding) =>
            inference.cosineSimilarity(embedding, centroid)
          );
          if (qualities.some((quality) => !Number.isFinite(quality))) {
            throw codedError("SPEAKER_EVAL_INFERENCE_INVALID");
          }
          decision = resolver.resolveCluster({
            cluster: {
              speechMs: turns.reduce((total, turn) => total + turn.endMs - turn.startMs, 0),
              windowCount: embeddings.length,
              qualityScore: Math.min(...qualities),
              modelId: policy.modelId,
              embedding: centroid,
            },
            samples,
            rejectedPersonIds: [],
          });
        }
        decisions.push({
          clusterId,
          state: decision.state,
          candidatePersonId: decision.candidatePersonId ?? null,
          candidateKind: personKinds.get(decision.candidatePersonId) ?? null,
          score: decision.score ?? null,
          margin: decision.margin ?? null,
        });
      }

      metricCases.push({
        caseId: evaluationCase.id,
        truthSpeakers: evaluationCase.speakers.map((speaker) => ({
          speakerId: speaker.speakerId,
          kind: speaker.kind,
          personId: speaker.kind === "unknown" ? null : speaker.speakerId,
        })),
        truthSegments: evaluationCase.segments,
        predictedTurns,
        decisions,
      });
    }

    return computeSpeakerIdentityMetrics({ cases: metricCases, policy });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("SPEAKER_EVAL_")) {
      throw error;
    }
    throw codedError("SPEAKER_EVAL_INFERENCE_FAILED");
  } finally {
    for (const vector of sensitiveVectors) vector.fill(0);
  }
}

function assertRegularLocalFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw codedError("SPEAKER_EVAL_RUNTIME_MISSING");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw codedError("SPEAKER_EVAL_RUNTIME_INVALID");
  }
}

function createProductionSpeakerRuntime() {
  const SpeakerIdentityResolver = require("../../../src/jarvis/main/SpeakerIdentityResolver");
  const {
    SPEAKER_IDENTITY_RESOLUTION_POLICY,
  } = require("../../../src/jarvis/main/SpeakerIdentityResolutionPolicy");
  let localInference = null;

  const ensureLocalInference = () => {
    if (localInference) return localInference;
    // Model-bearing helpers are loaded lazily: assertAvailable is invoked by
    // the gate only after consent and WAV validation. No network API is used.
    const DiarizationManager = require("../../../src/helpers/diarization");
    const speakerEmbeddings = require("../../../src/helpers/speakerEmbeddings");
    localInference = {
      diarizer: new DiarizationManager(),
      speakerEmbeddings,
    };
    return localInference;
  };

  return {
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    resolver: new SpeakerIdentityResolver({ policy: SPEAKER_IDENTITY_RESOLUTION_POLICY }),
    runtime: {
      async assertAvailable() {
        try {
          const { diarizer, speakerEmbeddings } = ensureLocalInference();
          if (!diarizer.isAvailable() || !speakerEmbeddings.isAvailable()) {
            throw codedError("SPEAKER_EVAL_RUNTIME_MISSING");
          }
          assertRegularLocalFile(diarizer.getBinaryPath());
          for (const artifact of diarizer.getModelArtifacts())
            assertRegularLocalFile(artifact.path);
          assertRegularLocalFile(speakerEmbeddings.getModelPath());
          const [diarizerHash, embeddingHash] = await Promise.all([
            diarizer.getModelArtifactSha256(),
            speakerEmbeddings.getModelArtifactSha256(),
          ]);
          return { diarizerHash, embeddingHash };
        } catch (error) {
          if (error?.code?.startsWith("SPEAKER_EVAL_")) throw error;
          throw codedError("SPEAKER_EVAL_RUNTIME_INVALID");
        }
      },
    },
    inference: {
      diarizeAudio: ({ audioPath, numSpeakers }) => {
        const { diarizer } = ensureLocalInference();
        return diarizer.diarizeStrict(audioPath, { numSpeakers });
      },
      embedAudio: ({ audioPath, startSec, endSec }) => {
        const { speakerEmbeddings } = ensureLocalInference();
        return speakerEmbeddings.extractEmbedding(audioPath, startSec, endSec);
      },
      computeCentroid: (embeddings) =>
        ensureLocalInference().speakerEmbeddings.computeCentroid(embeddings),
      cosineSimilarity: (left, right) =>
        ensureLocalInference().speakerEmbeddings.cosineSimilarity(left, right),
    },
  };
}

async function withPrivateLoggingSuppressed(work) {
  const debugLogger = require("../../../src/helpers/debugLogger");
  const originalWrite = debugLogger.write;
  debugLogger.write = () => {};
  try {
    return await work();
  } finally {
    debugLogger.write = originalWrite;
  }
}

module.exports = {
  evaluatePreparedSpeakerFixtures,
  createProductionSpeakerRuntime,
  withPrivateLoggingSuppressed,
};
