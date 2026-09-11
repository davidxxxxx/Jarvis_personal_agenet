const { JarvisProcessingRuntime } = require("./ProcessingRuntime");

const ProcessingJobRunner = require("../ProcessingJobRunner");

const JarvisTranscriptionWorker = require("../JarvisTranscriptionWorker");

const SessionDiarizationWorker = require("../SessionDiarizationWorker");

const SpeakerProcessingPolicy = require("../SpeakerProcessingPolicy");

const SpeakerIdentityResolutionWorker = require("../SpeakerIdentityResolutionWorker");

const DualSpeakerVerifier = require("../DualSpeakerVerifier");

const DualSpeakerEvidenceProvider = require("../DualSpeakerEvidenceProvider");

const DualSpeakerIdentityResolver = require("../DualSpeakerIdentityResolver");

const TranscriptReconciler = require("../TranscriptReconciler");

const DualTrackTranscriptDeduper = require("../DualTrackTranscriptDeduper");

const ApplicationMixAcousticMatcher = require("../ApplicationMixAcousticMatcher");

const ResourceGovernor = require("../ResourceGovernor");

const { JOB_PRIORITY } = ResourceGovernor;

const HeavyJobGate = require("../HeavyJobGate");

const PreviewTranscriptionScheduler = require("../PreviewTranscriptionScheduler");

const { createCommittedAudioPreviewExecutor } = require("./CommittedAudioPreview");
const { createHash } = require("node:crypto");

const { SESSION_DIARIZATION_POLICY } = require("../SessionDiarizationPolicy");

const { HYBRID_DIARIZATION_POLICY } = require("../HybridDiarizationPolicy");

const HybridDiarizationManager = require("../HybridDiarizationManager");

const HistoricalDiarizationBackfillService = require("../HistoricalDiarizationBackfillService");

const defaultSpeakerEmbeddingHelper = require("../../../helpers/speakerEmbeddings");

const { SpeakerEmbeddings } = require("../../../helpers/speakerEmbeddings");

const { SPEAKER_MODEL_KEYS } = require("../SpeakerModelManifest");

const OVERLAP_SEPARATION_APPLICATION_KEYS = new Set([
  "discord",
  "kook",
  "qq",
  "skype",
  "teams",
  "telegram",
  "tencent_meeting",
  "wechat",
  "wecom",
  "zoom",
]);

function shouldEnableOverlapSeparation(track) {
  if (track?.source_type === "mic") return true;
  return (
    typeof track?.application_key === "string" &&
    OVERLAP_SEPARATION_APPLICATION_KEYS.has(track.application_key)
  );
}

function createJarvisProcessingRuntime({
  repository,
  service,
  ipcHandlers,
  model,
  owner = `jarvis-${process.pid}`,
  now = Date.now,
  log = () => {},
  governor = null,
  heavyGate = null,
  telemetryProvider,
  cpuProvider,
  powerProvider,
  ownedPidsProvider = null,
  foregroundActivityProvider,
  onResourceSnapshot = () => {},
  resourceSettings,
  previewEnabled = true,
  previewExecutor = null,
  previewPersist = null,
  previewScheduler = null,
  whisperController = null,
  prepareTranscriptionJobs = undefined,
  sessionDiarizationWorker = null,
  diarizationPolicy = null,
  hybridDiarizationManager = null,
  historicalBackfillService = null,
  speakerIdentityResolutionWorker = null,
  speakerEmbeddingHelper = defaultSpeakerEmbeddingHelper,
  primarySpeakerEmbeddingHelper = null,
  reviewSpeakerEmbeddingHelper = null,
  dualSpeakerVerifier = null,
  dualSpeakerVerificationEnabled = true,
  speakerIdentityReleaseEvidence = null,
  cloudCompositionFactory = null,
  ...runtimeOptions
} = {}) {
  if (!repository?.captureEvidenceStore) {
    throw new TypeError("repository.captureEvidenceStore is required");
  }
  if (!service?.audioEvidenceReader || !service?.flacCompressionWorker) {
    throw new TypeError("current Jarvis service processing workers are required");
  }
  if (!ipcHandlers || typeof ipcHandlers.createJarvisTranscribeWavAdapter !== "function") {
    throw new TypeError("ipcHandlers transcription adapter is required");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("configured Jarvis Whisper model is required");
  }
  if (sessionDiarizationWorker !== null && typeof sessionDiarizationWorker?.run !== "function") {
    throw new TypeError("sessionDiarizationWorker.run must be a function");
  }
  if (
    hybridDiarizationManager !== null &&
    (typeof hybridDiarizationManager.diarizeStrict !== "function" ||
      typeof hybridDiarizationManager.getModelArtifactSha256 !== "function" ||
      typeof hybridDiarizationManager.isAvailable !== "function" ||
      typeof hybridDiarizationManager.dispose !== "function")
  ) {
    throw new TypeError("hybridDiarizationManager must implement the hybrid runtime interface");
  }
  if (
    speakerIdentityResolutionWorker !== null &&
    typeof speakerIdentityResolutionWorker?.run !== "function"
  ) {
    throw new TypeError("speakerIdentityResolutionWorker.run must be a function");
  }
  if (cloudCompositionFactory !== null && typeof cloudCompositionFactory !== "function") {
    throw new TypeError("cloudCompositionFactory must be a function or null");
  }
  if (typeof dualSpeakerVerificationEnabled !== "boolean") {
    throw new TypeError("dualSpeakerVerificationEnabled must be a boolean");
  }
  if (ownedPidsProvider !== null && typeof ownedPidsProvider !== "function") {
    throw new TypeError("ownedPidsProvider must be a function or null");
  }
  const configuredModel = model.trim();
  if (typeof service.configureTranscriptionModelVersion !== "function") {
    throw new TypeError("service.configureTranscriptionModelVersion must be a function");
  }
  if (typeof service.configureTranscriptionInputVersion !== "function") {
    throw new TypeError("service.configureTranscriptionInputVersion must be a function");
  }
  service.configureTranscriptionInputVersion(2);
  service.configureTranscriptionModelVersion(configuredModel);
  if (service.transcriptionModelVersion !== configuredModel) {
    throw new Error("Jarvis service transcription model does not match processing runtime");
  }
  const speakerProcessingPolicy = new SpeakerProcessingPolicy({
    transcriptionInputVersion: 2,
    transcriptionModelVersion: configuredModel,
  });
  const transcribeWav = ipcHandlers.createJarvisTranscribeWavAdapter({ model: configuredModel });
  const whisperManager = ipcHandlers.whisperManager || null;
  const cudaManager = ipcHandlers.whisperCudaManager || null;
  const legacyDiarizationManager = ipcHandlers.diarizationManager || null;
  let discoveredHybridManager = hybridDiarizationManager;
  if (discoveredHybridManager === null && typeof process.env.JARVIS_DATA_ROOT === "string") {
    try {
      const candidate = new HybridDiarizationManager({
        verifierDiarizer: legacyDiarizationManager,
        log,
      });
      if (candidate.isAvailable()) discoveredHybridManager = candidate;
    } catch (error) {
      log({ phase: "hybrid_diarization_discovery", error });
    }
  }
  const selectedDiarizationPolicy =
    diarizationPolicy ??
    (discoveredHybridManager?.isAvailable?.() === true
      ? HYBRID_DIARIZATION_POLICY
      : SESSION_DIARIZATION_POLICY);
  const diarizationManager =
    selectedDiarizationPolicy.inputVersion === 2
      ? discoveredHybridManager
      : legacyDiarizationManager;
  const canBuildDiarizationWorker = Boolean(
    diarizationManager &&
    typeof diarizationManager.diarizeStrict === "function" &&
    typeof diarizationManager.getModelArtifactSha256 === "function" &&
    speakerEmbeddingHelper &&
    typeof speakerEmbeddingHelper.extractEmbedding === "function" &&
    typeof speakerEmbeddingHelper.getModelArtifactSha256 === "function"
  );
  let combinedDiarizationArtifactHashPromise = null;
  const combinedDiarizationArtifactHash = () => {
    if (combinedDiarizationArtifactHashPromise) return combinedDiarizationArtifactHashPromise;
    combinedDiarizationArtifactHashPromise = Promise.all([
      diarizationManager.getModelArtifactSha256(),
      speakerEmbeddingHelper.getModelArtifactSha256(),
    ])
      .then(([managerHash, speakerHash]) => {
        if (!/^[0-9a-f]{64}$/.test(managerHash) || !/^[0-9a-f]{64}$/.test(speakerHash)) {
          const error = new Error("DIARIZATION_MODEL_ARTIFACT_INVALID");
          error.code = "DIARIZATION_MODEL_ARTIFACT_INVALID";
          throw error;
        }
        return createHash("sha256")
          .update(`diarization-manager\0${managerHash}\0`)
          .update(`speaker-embedding-helper\0${speakerHash}\0`)
          .digest("hex");
      })
      .catch((error) => {
        combinedDiarizationArtifactHashPromise = null;
        throw error;
      });
    return combinedDiarizationArtifactHashPromise;
  };
  const effectiveDiarizationWorker =
    sessionDiarizationWorker ??
    (canBuildDiarizationWorker
      ? new SessionDiarizationWorker({
          repository,
          audioEvidenceReader: service.audioEvidenceReader,
          diarizeAudio: ({ wavPath, executionContext, track, chunk, releaseHighMemoryResources }) =>
            diarizationManager.diarizeStrict(wavPath, {
              executionContext,
              enableOverlapSeparation: shouldEnableOverlapSeparation(track),
              releaseHighMemoryResources,
              artifactKey: `stem_${createHash("sha256")
                .update(`${chunk.session_id}\0${chunk.id}`)
                .digest("hex")}`,
            }),
          embedWindow: ({ wavPath, turn }) =>
            speakerEmbeddingHelper.extractEmbedding(
              wavPath,
              turn.embeddingStartMs / 1_000,
              turn.embeddingEndMs / 1_000
            ),
          transcribeStem: (input) => transcribeWav(input),
          modelArtifactSha256: combinedDiarizationArtifactHash,
          policy: selectedDiarizationPolicy,
          speakerProcessingPolicy,
          releaseResources:
            selectedDiarizationPolicy.inputVersion === 2
              ? () => discoveredHybridManager?.dispose?.()
              : null,
          clock: now,
        })
      : null);
  const canBuildIdentityResolutionWorker = [
    "getSpeakerIdentityResolutionSnapshot",
    "listRejectedSpeakerPersonIds",
    "applySystemSpeakerResolutions",
  ].every((method) => typeof repository[method] === "function");
  const diarizationCapability = () => {
    if (sessionDiarizationWorker !== null) {
      return { executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu" };
    }
    if (!canBuildDiarizationWorker) {
      return {
        executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu",
        available: false,
        unavailableReason: "diarization_runtime_unavailable",
      };
    }
    let available = false;
    try {
      available =
        diarizationManager.isAvailable?.() === true &&
        speakerEmbeddingHelper.isAvailable?.() === true;
    } catch {
      available = false;
    }
    return {
      executionDevice: selectedDiarizationPolicy.executionDevice ?? "cpu",
      available,
      ...(available ? {} : { unavailableReason: "diarization_model_unavailable" }),
    };
  };
  const effectiveGovernor =
    governor ??
    new ResourceGovernor({
      now,
      ...(telemetryProvider ? { telemetryProvider } : {}),
      ...(cpuProvider ? { cpuProvider } : {}),
      ...(powerProvider ? { powerProvider } : {}),
      ...(foregroundActivityProvider ? { foregroundActivityProvider } : {}),
      ...(resourceSettings ? { resourceSettings } : {}),
      previewEnabled,
      ownedPidsProvider:
        ownedPidsProvider ??
        (() =>
          [
            process.pid,
            whisperManager?.serverManager?.process?.pid,
            ...(discoveredHybridManager?.ownedPids?.() ?? []),
          ].filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
      cudaProvider: async () => {
        const startOptions = cudaManager?.getVerifiedStartOptions?.() ?? {
          useCuda: false,
          gpuUuid: null,
        };
        const status = cudaManager?.getStatus?.({ gpuUuid: startOptions.gpuUuid }) ?? null;
        return {
          installed: status?.present === true || status?.downloaded === true,
          verified: startOptions.useCuda === true && status?.verified === true,
          quarantined: /quarantin/iu.test(status?.reason || ""),
          gpuUuid: startOptions.useCuda ? startOptions.gpuUuid : null,
          peakVramMb: status?.verification?.peakVramMb ?? null,
        };
      },
    });
  const effectiveGate = heavyGate ?? new HeavyJobGate();
  const effectivePrimarySpeakerEmbeddingHelper = dualSpeakerVerificationEnabled
    ? (primarySpeakerEmbeddingHelper ??
      new SpeakerEmbeddings({ modelKey: SPEAKER_MODEL_KEYS.PRIMARY }))
    : null;
  const effectiveReviewSpeakerEmbeddingHelper = dualSpeakerVerificationEnabled
    ? (reviewSpeakerEmbeddingHelper ??
      new SpeakerEmbeddings({ modelKey: SPEAKER_MODEL_KEYS.REVIEW }))
    : null;
  const effectiveDualSpeakerVerifier = dualSpeakerVerificationEnabled
    ? (dualSpeakerVerifier ??
      new DualSpeakerVerifier({
        primaryEmbeddings: effectivePrimarySpeakerEmbeddingHelper,
        reviewEmbeddings: effectiveReviewSpeakerEmbeddingHelper,
        resourceGovernor: effectiveGovernor,
        releaseEvidence: speakerIdentityReleaseEvidence,
      }))
    : null;
  const canBuildDualIdentityResolutionWorker =
    dualSpeakerVerificationEnabled &&
    canBuildIdentityResolutionWorker &&
    typeof repository.listSpeakerIdentityAudioWindows === "function" &&
    typeof repository.replaceSpeakerClusterModelEmbeddings === "function" &&
    typeof effectivePrimarySpeakerEmbeddingHelper?.extractEmbedding === "function" &&
    typeof effectiveReviewSpeakerEmbeddingHelper?.extractEmbedding === "function";
  const effectiveIdentityResolutionWorker =
    speakerIdentityResolutionWorker ??
    (canBuildIdentityResolutionWorker
      ? new SpeakerIdentityResolutionWorker({
          repository,
          clock: now,
          diarizationPolicy: selectedDiarizationPolicy,
          ...(canBuildDualIdentityResolutionWorker
            ? {
                dualEvidenceProvider: new DualSpeakerEvidenceProvider({
                  repository,
                  audioEvidenceReader: service.audioEvidenceReader,
                  primaryEmbeddings: effectivePrimarySpeakerEmbeddingHelper,
                  reviewEmbeddings: effectiveReviewSpeakerEmbeddingHelper,
                }),
                dualResolver: new DualSpeakerIdentityResolver({
                  releaseEvidence: speakerIdentityReleaseEvidence,
                }),
              }
            : {}),
        })
      : null);
  if (previewExecutor !== null && typeof previewExecutor !== "function") {
    throw new TypeError("previewExecutor must be a function or null");
  }
  if (previewPersist !== null && typeof previewPersist !== "function") {
    throw new TypeError("previewPersist must be a function or null");
  }
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner,
    now,
    governor: effectiveGovernor,
    heavyGate: effectiveGate,
    log,
    classifyCapability: (job) =>
      job.job_type === "diarize_track"
        ? diarizationCapability()
        : job.job_type === "resolve_identities"
          ? { executionDevice: "cpu" }
          : undefined,
  });
  const effectivePreviewScheduler =
    previewScheduler ??
    new PreviewTranscriptionScheduler({
      executePreview:
        previewExecutor ??
        createCommittedAudioPreviewExecutor({
          repository,
          previewAudioRing: service.previewAudioRing,
          transcribeWav,
        }),
      persistProvisional:
        previewPersist ??
        (({ sessionId, segments }) => repository.upsertTranscriptSegments(sessionId, segments)),
      heavyGate: effectiveGate,
      beforePreviewStart: (permit) =>
        runner.drainHigherPriorityWithinPermit(permit, {
          priorityBefore: JOB_PRIORITY.preview,
        }),
      now,
    });
  const effectiveWhisperController =
    whisperController ??
    (whisperManager
      ? {
          isIdle: () => whisperManager._transcribing !== true,
          stop: () => whisperManager.stopServer(),
        }
      : null);
  const cloudComposition =
    cloudCompositionFactory?.({
      repository,
      governor: effectiveGovernor,
      previewScheduler: effectivePreviewScheduler,
      owner,
      now,
    }) ?? null;
  const worker = new JarvisTranscriptionWorker({
    repository,
    audioEvidenceReader: service.audioEvidenceReader,
    transcribeWav,
    inputVersion: speakerProcessingPolicy.transcriptionInputVersion,
    modelVersion: configuredModel,
    now,
  });
  runner.register("transcribe_chunk", (job, context) => worker.handle(job, context));
  runner.register("diarize_track", (job, context) => {
    if (effectiveDiarizationWorker) return effectiveDiarizationWorker.run(job, context);
    const error = new Error("DIARIZATION_RUNTIME_UNAVAILABLE");
    error.code = "DIARIZATION_RUNTIME_UNAVAILABLE";
    throw error;
  });
  runner.register("resolve_identities", (job, context) => {
    if (effectiveIdentityResolutionWorker)
      return effectiveIdentityResolutionWorker.run(job, context);
    const error = new Error("IDENTITY_RESOLUTION_RUNTIME_UNAVAILABLE");
    error.code = "IDENTITY_RESOLUTION_RUNTIME_UNAVAILABLE";
    throw error;
  });
  runner.register("compress_chunk", async (job) => {
    await service.flacCompressionWorker.run(job, { owner });
    return { executionDevice: "cpu" };
  });
  const startupBarrier =
    runtimeOptions.startupBarrier ?? service.waitForCompressionRecovery?.() ?? null;
  const effectivePrepareTranscriptionJobs =
    prepareTranscriptionJobs ??
    (() =>
      repository.enqueueCurrentModelTranscriptionJobs({
        inputVersion: speakerProcessingPolicy.transcriptionInputVersion,
        modelVersion: speakerProcessingPolicy.transcriptionModelVersion,
        at: now(),
      }));
  const effectiveHistoricalBackfillService =
    historicalBackfillService ??
    (selectedDiarizationPolicy.inputVersion === 2 &&
    typeof repository.listHistoricalHybridCandidates === "function" &&
    typeof repository.enqueueHistoricalHybridReprocessing === "function"
      ? new HistoricalDiarizationBackfillService({
          repository,
          speakerProcessingPolicy,
          policy: selectedDiarizationPolicy,
          now,
          log,
        })
      : null);
  return new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: new TranscriptReconciler({ repository }),
    deduper: new DualTrackTranscriptDeduper({
      repository,
      acousticMatcher:
        typeof service.audioEvidenceReader.readVerifiedPcm === "function"
          ? new ApplicationMixAcousticMatcher({
              audioEvidenceReader: service.audioEvidenceReader,
              getAudioChunk: (chunkId) => repository.getAudioChunk(chunkId),
              log,
            })
          : null,
      acousticAdmission: async () => {
        try {
          const snapshot = await effectiveGovernor.sample();
          const decision = effectiveGovernor.admit?.("maintenance", snapshot);
          return decision?.action === "run_cpu";
        } catch (error) {
          log({ phase: "application_mix_acoustic_admission", error });
          return false;
        }
      },
    }),
    now,
    log,
    governor: effectiveGovernor,
    onResourceSnapshot,
    whisperController: effectiveWhisperController,
    previewScheduler: effectivePreviewScheduler,
    speakerProcessingPolicy,
    diarizationPolicy: selectedDiarizationPolicy,
    diarizationRuntime:
      selectedDiarizationPolicy.inputVersion === 2 ? discoveredHybridManager : null,
    historicalBackfillService: effectiveHistoricalBackfillService,
    dualSpeakerVerifier: effectiveDualSpeakerVerifier,
    prepareTranscriptionJobs: effectivePrepareTranscriptionJobs,
    ...runtimeOptions,
    ...(cloudComposition ?? {}),
    startupBarrier,
  });
}

module.exports = { createJarvisProcessingRuntime, shouldEnableOverlapSeparation };
