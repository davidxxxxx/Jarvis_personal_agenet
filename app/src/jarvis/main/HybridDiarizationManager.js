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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTurn(turn) {
  const speaker = turn?.speaker ?? turn?.label;
  const startMs = Math.round(turn?.startMs ?? turn?.start * 1_000);
  const endMs = Math.round(turn?.endMs ?? turn?.end * 1_000);
  if (
    typeof speaker !== "string" ||
    !SAFE_SPEAKER.test(speaker) ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs
  ) {
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
    const turns = result.turns.map(normalizeTurn);
    const primaryCount = new Set(turns.map((turn) => turn.speaker)).size;
    let verifierCount = result.verifierCount ?? null;
    if (verifierCount === null && this.verifierDiarizer !== null) {
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
      ...this.modelRuntime.status(),
    });
  }

  ownedPids() {
    return this.modelRuntime.ownedPids?.() ?? [];
  }

  dispose() {
    return this.modelRuntime.dispose();
  }
}

module.exports = HybridDiarizationManager;
module.exports.normalizeTurn = normalizeTurn;
