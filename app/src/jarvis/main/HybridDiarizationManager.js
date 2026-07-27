const fs = require("node:fs");
const path = require("node:path");
const OnDemandModelRuntime = require("./OnDemandModelRuntime");
const DiarizationSidecarClient = require("./DiarizationSidecarClient");
const { HYBRID_DIARIZATION_POLICY } = require("./HybridDiarizationPolicy");
const { buildSpeakerCountConsensus, findOverlapWindows } = require("./DiarizationConsensus");
const {
  isAiModelPackPresent,
  resolveAiModelPackRoot,
  verifyAiModelPack,
} = require("./AiModelPackManifest");

const SAFE_SPEAKER = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_BOUNDARY_DRIFT_MS = 2;
const RECOVERABLE_VERIFIER_ERRORS = new Set([
  "DIARIZATION_BINARY_UNAVAILABLE",
  "DIARIZATION_MODEL_UNAVAILABLE",
  "DIARIZATION_SIDECAR_EXIT_NONZERO",
  "DIARIZATION_SIDECAR_SPAWN_FAILED",
  "DIARIZATION_SIDECAR_TIMEOUT",
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTurn(turn, durationMs = null) {
  const speaker = turn?.speaker ?? turn?.label;
  const rawStartMs = turn?.startMs ?? turn?.start * 1_000;
  const rawEndMs = turn?.endMs ?? turn?.end * 1_000;
  let startMs = Math.round(rawStartMs);
  let endMs = Math.round(rawEndMs);
  const boundedDurationMs =
    Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : null;
  if (
    typeof speaker !== "string" ||
    !SAFE_SPEAKER.test(speaker) ||
    !Number.isFinite(rawStartMs) ||
    !Number.isFinite(rawEndMs) ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs)
  ) {
    throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
  }
  if (startMs < 0) {
    if (startMs < -MAX_BOUNDARY_DRIFT_MS) {
      throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
    }
    startMs = 0;
  }
  if (boundedDurationMs !== null) {
    if (startMs > boundedDurationMs) {
      const tailDriftMs = startMs - boundedDurationMs;
      if (tailDriftMs <= MAX_BOUNDARY_DRIFT_MS) {
        startMs = boundedDurationMs;
      } else {
        // A model may emit a padding-only tail that begins after the
        // authoritative WAV duration. It contains no audio evidence, so omit
        // only that turn rather than rejecting every valid turn from the
        // recording.
        if (endMs <= boundedDurationMs) return null;
        throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
      }
    }
    if (endMs > boundedDurationMs) {
      if (endMs - boundedDurationMs > MAX_BOUNDARY_DRIFT_MS) {
        throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
      }
      endMs = boundedDurationMs;
    }
  }
  if (endMs < startMs) {
    if (startMs - endMs > MAX_BOUNDARY_DRIFT_MS) {
      throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
    }
    const boundaryMs = Math.min(startMs, endMs);
    startMs = Math.max(0, boundaryMs);
    endMs = startMs + 1;
  }
  // Pyannote may emit a positive sub-millisecond segment whose independently
  // rounded boundaries collapse onto the same millisecond. Preserve the
  // evidence as a minimal 1 ms turn instead of discarding the entire long
  // recording. At the audio tail, move the start back so the correction stays
  // within the reported duration.
  if (endMs === startMs) {
    if (boundedDurationMs !== null && startMs >= boundedDurationMs) {
      endMs = boundedDurationMs;
      startMs = Math.max(0, endMs - 1);
    } else {
      endMs = startMs + 1;
    }
  }
  if (boundedDurationMs !== null && endMs > boundedDurationMs) {
    endMs = boundedDurationMs;
  }
  if (endMs <= startMs) {
    throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar returned an invalid turn");
  }
  return Object.freeze({ speaker, startMs, endMs });
}

class HybridDiarizationManager {
  constructor({
    packRoot = resolveAiModelPackRoot(),
    policy = HYBRID_DIARIZATION_POLICY,
    clientFactory = (options) => new DiarizationSidecarClient(options),
    verifyPack = verifyAiModelPack,
    fsImpl = fs,
    log = () => {},
    runtime = null,
    verifierDiarizer = null,
  } = {}) {
    if (typeof packRoot !== "string" || !path.isAbsolute(packRoot)) {
      throw new TypeError("packRoot must be absolute");
    }
    if (!policy || policy.executionDevice !== "cuda" || !Object.isFrozen(policy)) {
      throw new TypeError("immutable CUDA hybrid policy is required");
    }
    if (typeof clientFactory !== "function" || typeof verifyPack !== "function") {
      throw new TypeError("hybrid diarization dependencies are invalid");
    }
    this.packRoot = path.resolve(packRoot);
    this.policy = policy;
    this.verifyPack = verifyPack;
    this.fs = fsImpl;
    this.log = log;
    this.loadedGpuUuid = null;
    if (verifierDiarizer !== null && typeof verifierDiarizer.diarizeStrict !== "function") {
      throw new TypeError("verifierDiarizer.diarizeStrict must be a function");
    }
    this.verifierDiarizer = verifierDiarizer;
    this.verifierCircuitOpen = false;
    this.verifierFailureCode = null;
    this.verifiedPack = null;
    this.modelRuntime =
      runtime ??
      new OnDemandModelRuntime({
        unloadDelayMs: policy.unloadDelayMs,
        load: async (loadContext) => {
          this.verifiedPack = await this.verifyPack({ root: this.packRoot });
          const selectedGpuUuid = loadContext?.selectedGpuUuid ?? null;
          const client = clientFactory({
            packRoot: this.packRoot,
            log: this.log,
            selectedGpuUuid,
          });
          await client.start();
          const selfTest = await client.request("self_test", { loadPrimary: true });
          if (selfTest?.cuda !== true || selfTest?.primaryLoaded !== true) {
            await client.stop().catch(() => {});
            throw codedError(
              "DIARIZATION_CUDA_SELF_TEST_FAILED",
              "offline diarization GPU self-test did not complete"
            );
          }
          this.loadedGpuUuid = selectedGpuUuid;
          return client;
        },
        unload: async (client) => {
          this.loadedGpuUuid = null;
          await client.stop();
        },
      });
  }

  isAvailable() {
    return isAiModelPackPresent({ root: this.packRoot, fsImpl: this.fs });
  }

  async getModelArtifactSha256() {
    this.verifiedPack ??= await this.verifyPack({ root: this.packRoot });
    return this.verifiedPack.manifestSha256;
  }

  async diarizeStrict(wavPath, { executionContext = null } = {}) {
    if (typeof wavPath !== "string" || !path.isAbsolute(wavPath)) {
      throw new TypeError("wavPath must be absolute");
    }
    if (executionContext?.device !== "cuda") {
      throw codedError(
        "DIARIZATION_CUDA_REQUIRED",
        "hybrid final diarization requires CUDA admission"
      );
    }
    const selectedGpuUuid = executionContext.selectedGpuUuid ?? null;
    if (
      this.modelRuntime.status().loaded &&
      this.loadedGpuUuid !== null &&
      selectedGpuUuid !== this.loadedGpuUuid
    ) {
      await this.modelRuntime.dispose();
    }
    const result = await this.modelRuntime.run(
      (client) =>
        client.request("diarize", {
          audioPath: path.resolve(wavPath),
          minimumSpeakers: this.policy.minimumSpeakers,
          maximumSpeakers: this.policy.maximumSpeakers,
          verifierMaximumSpeakers: this.policy.verifierMaximumSpeakers,
          overlapPaddingMs: this.policy.overlapPaddingMs,
          selectedGpuUuid,
        }),
      { selectedGpuUuid }
    );
    if (!result || typeof result !== "object" || !Array.isArray(result.turns)) {
      throw codedError("DIARIZATION_SIDECAR_INVALID_RESULT", "sidecar result is incomplete");
    }
    const turns = result.turns
      .map((turn) => normalizeTurn(turn, result.durationMs))
      .filter((turn) => turn !== null);
    const primaryCount = new Set(turns.map((turn) => turn.speaker)).size;
    let verifierCount = result.verifierCount ?? null;
    let verifierState = verifierCount === null ? "not_run" : "completed";
    if (
      verifierCount === null &&
      this.verifierDiarizer !== null &&
      !this.verifierCircuitOpen
    ) {
      try {
        const verifierTurns = await this.verifierDiarizer.diarizeStrict(wavPath);
        if (!Array.isArray(verifierTurns)) {
          throw codedError(
            "DIARIZATION_VERIFIER_INVALID_RESULT",
            "speaker count verifier returned no turns"
          );
        }
        verifierCount = new Set(
          verifierTurns.map((turn) => turn?.speaker ?? turn?.label ?? turn?.rawLabel).filter(Boolean)
        ).size;
        verifierState = "completed";
      } catch (error) {
        if (!RECOVERABLE_VERIFIER_ERRORS.has(error?.code)) throw error;
        this.verifierCircuitOpen = true;
        this.verifierFailureCode = error.code;
        verifierState = "unavailable";
        this.log({
          phase: "diarization_verifier_degraded",
          error,
        });
      }
    } else if (verifierCount === null && this.verifierCircuitOpen) {
      verifierState = "unavailable";
    }
    const consensus = buildSpeakerCountConsensus({
      primaryCount,
      verifierCount,
      verifierLimit: this.policy.verifierMaximumSpeakers,
    });
    const durationMs = Number.isSafeInteger(result.durationMs) ? result.durationMs : null;
    const overlapWindows = findOverlapWindows(turns, {
      paddingMs: this.policy.overlapPaddingMs,
      durationMs,
    });
    const metadata = Object.freeze({
      schemaVersion: 1,
      stage: "final",
      pipeline: this.policy.policyId,
      executionDevice: "cuda",
      speakerCount: consensus,
      verifierState,
      overlapWindows,
      overlapSeparation: result.overlapSeparation ?? {
        state: overlapWindows.length === 0 ? "not_needed" : "pending",
        processed: 0,
        total: overlapWindows.length,
      },
      models: Object.freeze({
        primary: this.policy.models.primary.id,
        verifier: verifierCount === null ? null : this.policy.models.verifier.id,
        separator: result.overlapSeparation?.processed > 0 ? this.policy.models.separator.id : null,
      }),
    });
    Object.defineProperty(turns, "metadata", {
      value: metadata,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return turns;
  }

  status() {
    return Object.freeze({
      available: this.isAvailable(),
      packRoot: this.packRoot,
      policyId: this.policy.policyId,
      verifierCircuitOpen: this.verifierCircuitOpen,
      verifierFailureCode: this.verifierFailureCode,
      ...this.modelRuntime.status(),
    });
  }

  ownedPids() {
    return this.modelRuntime.ownedPids?.() ?? [];
  }

  async dispose() {
    try {
      return await this.modelRuntime.dispose();
    } finally {
      this.verifierCircuitOpen = false;
      this.verifierFailureCode = null;
    }
  }
}

module.exports = HybridDiarizationManager;
module.exports.normalizeTurn = normalizeTurn;
