# Jarvis offline AI model component

The Windows release treats the application core and the offline diarization models as two
versioned components while keeping one installer entry. The generated component is placed in
`resources/ai-model-pack/prebuilt` for Electron Builder and is adopted atomically into
`JARVIS_DATA_ROOT/models/ai-model-pack` on first launch. No runtime model or cache is written to
the Windows system drive.

Release inputs are intentionally predownloaded. In particular, the build machine must already
have access to the gated `pyannote/speaker-diarization-community-1` repository; access tokens are
never passed to the pack builder or included in the output.

Use `scripts/prepare-ai-model-pack.ps1` with a self-contained Python 3.11 x64 runtime, the pinned
Community-1 snapshot, the complete `alibabasglab/MossFormer2_SS_16K` snapshot directory, and the
downloaded sherpa/CAM++/ERes2NetV2/Silero directory. The script stages and caches only on G:, pins
the CUDA runtime dependencies, builds a per-file SHA-256 manifest, and performs a real CUDA,
pyannote, and MossFormer load test before the application is packaged.
