# Jarvis Memory changelog

All user-visible Jarvis changes are recorded here. Versions follow Semantic Versioning and use
Jarvis-prefixed Git tags so they cannot be confused with upstream OpenWhispr releases.

## Unreleased

### Planned for 0.2.0

- Evidence-gated Todos, suggestions, and local personalization.
- Progressive Finish & Summarize session page and a compact home Action Center.

## 0.2.0-alpha.28 - 2026-07-28

- Verify SQLite integrity before any startup write, use full WAL durability for Jarvis data, and
  migrate safely to schema v46 after repairing the live recording database.
- Stop immutable Daily Review snapshots from multiplying as individual background jobs finish;
  prune 767 obsolete, unpaid snapshots and compact the live database by about 660 MB.
- Keep application tracks released after confirmed silence until Windows reports audible output
  again, preventing repeated 60-second KOOK, DOTA 2, and browser track restarts.
- Project only the latest durable speaker run into memory, preserve verified SELF identity, and
  collapse unresolved per-application track churn without inventing cross-session people.
- Exclude virtual audio infrastructure such as audiodg and SteelSeries Sonar from semantic
  application evidence while retaining the mixed system track as the safety fallback.
- Cover a typical multi-hour transcript completely in one grounded MiniMax analysis input and
  offer an explicit paid refresh when an older summary used only partial timeline evidence.
- Preserve grounded MiniMax summaries when optional collections are malformed or oversized, and
  persist a safe schema-specific reason when a paid response still cannot be accepted.
- Ship AI model pack 2026.07.4 and release the high-memory overlap separator after every completed
  job so an idle Jarvis does not keep its model allocation indefinitely.

## 0.2.0-alpha.27 - 2026-07-27

- Process the physical microphone first, then exact application tracks, and use the mixed system
  track only as a safety fallback for speaker analysis.
- Retire a mixed-system diarization job when exact application audio covers at least 80 percent of
  it, preventing Tencent Meeting or KOOK speech from being counted again as hundreds of people.
- Persist only durable long-session speaker clusters and reject internally inconsistent runs,
  while allowing completed short application evidence to join a later identity revision without
  blocking the primary microphone and meeting tracks.
- Wake speaker jobs deferred only by GPU, fullscreen, or recovery resource gates after upgrade,
  while leaving deterministic validation and database failures terminal.

## 0.2.0-alpha.26 - 2026-07-27

- Keep short and one-window speaker fragments out of MiniMax summaries unless the exact segment is
  attached to a confirmed person; durable anonymous evidence still remains eligible.
- Select cloud-summary evidence across the beginning, middle, and end of long recordings instead
  of filling the payload only from the first transcript window.
- Compare unnamed speakers locally with both CAM++ and ERes2NetV2, require conservative dual-model
  agreement, and reuse one anonymous label when the same voice appears on different exact tracks.
  Voice vectors and real application details remain local.

## 0.2.0-alpha.25 - 2026-07-27

- Keep crash-safe FLAC recovery, but skip expensive FFmpeg decoding for healthy completed audio
  that has no partial, temporary, duplicate-WAV, or other crash artifact. This prevents thousands
  of already-verified Memory chunks from blocking lease recovery and new-session processing after
  every restart.

## 0.2.0-alpha.24 - 2026-07-27

- Keep short, duplicate, and overlap-only diarization fragments auditable but hide them from the
  Memory people list, so hundreds of raw cluster rows are no longer presented as real people.
- Tell local Whisper to preserve colloquial speech and profanity verbatim without translating,
  euphemizing, censoring, or replacing it with homophones; prevent MiniMax from interpreting raw
  diarization labels as verified participant or language counts.
- Normalize Memory playback non-destructively, boosting quiet microphone PCM by up to 12 dB while
  leaving confirmed silence and already-loud audio unchanged.

## 0.2.0-alpha.23 - 2026-07-26

- Preserve the selected v3 hybrid speaker-readiness policy during startup reconciliation, so
  sessions already verified as ready are not temporarily downgraded by legacy defaults.
- Accept exact canonical omission ranges that overlap selected segments on independent microphone
  and application tracks, allowing long multi-track recordings to reach MiniMax analysis without
  weakening segment scope, pseudonym, or redaction validation.

## 0.2.0-alpha.22 - 2026-07-26

- Treat retained chunks shorter than the speaker model's minimum embedding window as verified empty
  speaker evidence, preventing deterministic insufficient-audio jobs from retrying forever and
  repeatedly loading the large diarization sidecar.
- Periodically recover sessions that become ready after asynchronous speaker and identity work,
  while preserving the existing fail-closed MiniMax budget startup gate.
- Keep Whisper rolling context isolated to the current audio track so microphone, KOOK, games,
  browsers, and the mixed system fallback cannot contaminate one another's bilingual transcript.

## 0.2.0-alpha.21 - 2026-07-26

- Carry the selected v3 hybrid diarization policy into identity-resolution scheduling and session
  readiness, so completed CAM++ evidence can advance to SELF matching, anonymous people, activity
  classification, and summaries instead of remaining permanently "processing".
- Add regression coverage for both repository enqueueing and runtime lifecycle policy propagation.

## 0.2.0-alpha.20 - 2026-07-26

- Apply long-session speaker evidence gating to the production repository snapshot shape, where
  each admitted chunk wraps its durable audio metadata. This prevents a correct durable-candidate
  count from being displayed as the unfiltered raw cluster range.
- Add a production-shaped regression fixture so packaged runs cannot silently regress to inflated
  person counts while still reporting the correct candidate breakdown.

## 0.2.0-alpha.19 - 2026-07-26

- Gate long-session speaker counts on durable evidence: at least five seconds of speech and
  three embedding windows. Brief fragments and overlap-only placeholders remain auditable but
  no longer inflate the displayed person count or create formal identities.
- Persist a compact candidate breakdown alongside the trusted count so the UI and later review
  can distinguish durable speakers, brief candidates, and overlap-only evidence.

## 0.2.0-alpha.18 - 2026-07-26

- Namespace durable speaker-turn identifiers by diarization policy so a retained recording can
  migrate from v2 to v3 without colliding with the earlier run's primary keys.
- Keep the resulting deterministic database failure terminal while allowing the corrected v3
  task to be explicitly restored and reprocessed from the retained audio.

## 0.2.0-alpha.17 - 2026-07-25

- Stop deterministic diarization validation failures instead of retrying them forever.
- Consolidate chunk-local speaker fragments with a final global centroid pass and invalidate
  stale v2 speaker results so retained sessions are recomputed with the v3 policy.
- Exclude Windows `audiodg` and SteelSeries Sonar virtual-audio infrastructure from the dynamic
  application track pool.
- Treat unexpected Japanese and Korean scripts like other Whisper hallucinations, retry the
  affected clip with Chinese-first bilingual decoding, and keep those fragments out of rolling
  prompt context.

## 0.2.0-alpha.16 - 2026-07-25

- Start the dynamic per-application Windows audio pool even when mixed system capture falls back from native WASAPI to Chromium loopback.
- Detect unexpected writing systems and repeated Whisper hallucinations, then retry only suspicious local final-transcription clips with Chinese as the primary language while preserving English terms.
- Remove unsupported-script fragments and repeated hallucinations from Whisper's rolling context so an older bad segment cannot contaminate later chunks.

## 0.2.0-alpha.15 - 2026-07-25

- Validate the first application-capture fallback and suspicious-transcript retry fixes in a packaged runtime before adding prompt-context isolation.

## 0.2.0-alpha.14 - 2026-07-25

- Auto-correct pyannote fragment boundaries that drift by up to 2 ms at the audio tail instead of invalidating a completed long-track result.
- Drop only padding-only turns that begin beyond the authoritative WAV duration while preserving every valid speaker turn from the same recording.

## 0.2.0-alpha.13 - 2026-07-24

- Preserve valid sub-millisecond pyannote turns by expanding millisecond-rounding collapses to a bounded 1 ms interval instead of rejecting an entire long recording.
- Generate corrected boundaries in future AI model packs while retaining strict rejection for inverted bounds and malformed speaker labels.

## 0.2.0-alpha.12 - 2026-07-24

- Treat free-VRAM admission as a pre-load check for CUDA diarization; once the models are resident, their own allocation no longer preempts the track.
- Preserve direct CUDA out-of-memory errors, fullscreen yielding, and device-unavailable handling as runtime safety paths.

## 0.2.0-alpha.11 - 2026-07-24

- Prevent an already admitted CUDA diarization run from discarding long-track progress when an external GPU workload appears after model load.
- Keep insufficient VRAM, fullscreen activity, and device failure as preemptive safety boundaries.

## 0.2.0-alpha.10 - 2026-07-24

- Keep an admitted CUDA diarization run alive through its own GPU utilization and transient telemetry noise, so long tracks are not discarded and restarted.
- Preserve pre-start yielding for external GPU pressure, insufficient VRAM, and fullscreen activity.

## 0.2.0-alpha.9 - 2026-07-24

This prerelease completes long-session speaker analysis without letting an optional native
speaker-count verifier discard the primary CUDA result.

### Fixed

- A Windows access violation in the optional Sherpa speaker-count verifier now opens a local
  circuit breaker and records a primary-only result instead of restarting the full track.
- Application fragments shorter than one minute are retired from high-cost speaker processing;
  their audio and transcription remain available through the mixed-system and application
  evidence paths.
- Identity resolution now runs immediately after microphone and mixed-system diarization, ahead
  of lower-value application speaker jobs.
- Database v40 wakes interrupted speaker work, migrates identity jobs to the new priority, and
  retires existing sub-minute application fragments without deleting recordings or transcripts.

## 0.2.0-alpha.8 - 2026-07-24

This prerelease unblocks high-accuracy speaker analysis for retained historical recordings.

### Fixed

- Runtime-status polling no longer performs an unindexed per-chunk scan of the entire processing
  queue. The new v38 index reduces long-history coverage and backlog reads from tens of seconds to
  indexed lookups, preventing Electron's main thread from freezing on navigation.
- Memory detail avoids serializing the same audio-chunk collection twice and polls background
  status every five seconds while visible or fifteen seconds while hidden.
- Memory session detail now places the complete summary, speakers and voiceprints, topics, Todos,
  and expanded background progress above audio playback and the full transcript.
- Transient Windows audio-session inactive events retain the current application capture
  generation for a grace period, and quiet application tracks remain sticky for one minute,
  preventing short KOOK, game, and system-audio track storms.
- Windows resource governance now backs GPU-pressure probes off to one sample per minute and caches
  slow-changing power status for five minutes, reducing WMI amplification from process-monitoring
  software while a game is running.
- CUDA runtime integrity performs a complete hash check once per process and again whenever its
  pointer or file metadata changes; routine resource polling now uses a cheap file fingerprint
  instead of synchronously rehashing roughly one gigabyte of runtime files.
- Historical hybrid diarization now uses revision-scoped cluster identifiers, preventing v2
  reprocessing from colliding with speaker clusters created by the legacy policy.
- Verified 24 kHz recordings are converted to a private 16 kHz mono model lease before final
  diarization, allowing overlap separation to finish without modifying the original evidence.
- Final speaker evidence now tolerates up to two milliseconds of capture-boundary overlap, so
  harmless recorder timestamp jitter cannot reject an otherwise complete microphone track.
- Microphone and mixed-system diarization now form a hard primary lane: application speaker work
  cannot claim a worker until the session's primary work finishes. Application fragments shorter
  than fifteen seconds are retired instead of loading the high-accuracy speaker stack.
- Once a primary diarization job is running on CUDA, its own short CPU spike or recovery
  hysteresis no longer cancels and restarts the entire recording. Full-screen games, external GPU
  use, device changes, and other real yield conditions remain preemptive.
- Long recordings now persist bounded per-chunk pipeline diagnostics plus complete aggregate
  speaker evidence, preventing hundreds of chunk metadata rows from exceeding the durable run
  limit after expensive CUDA processing has already finished.
- Equal-priority speaker jobs now process the newest completed session first, so a requested
  reprocessing run finishes its microphone and system-mix lanes before older historical backlog.
- Local transcription and speaker queues now begin before slow cloud/daily-review crash recovery;
  MiniMax dispatch remains locked until paid-request reconciliation completes.

### Database

- Database target advanced to v39 with a migration-safe processing-job index and speaker queue
  repair. Existing recordings, transcripts, people, and queued work are preserved; primary speaker
  jobs are woken and obsolete short application jobs are superseded.

## 0.2.0-alpha.7 - 2026-07-23

This prerelease makes first-run speech-model preparation visible instead of appearing to leave
Start Listening stuck at an idle audio meter.

### Fixed

- Start Listening now reports Whisper model download progress with a determinate progress bar.
- The startup panel explicitly remains in a not-recording state until audio capture really starts,
  avoiding both the misleading **Waiting to record** meter and a false recording indicator.
- Progress events are scoped to the exact Whisper model requested by Jarvis, so unrelated model
  downloads cannot overwrite recording startup state.

## 0.2.0-alpha.6 - 2026-07-23

This prerelease fixes the packaged recording controls discovered during the first isolated
real-data canary and makes the Windows package self-contained for local text embeddings.

### Fixed

- Clicking **Finish & Summarize** immediately enters the finalizing state and freezes the elapsed
  timer while microphone and system-audio sources finish flushing safely in the background.
- The standalone Jarvis window now mounts the existing microphone analyser sampler, so captured
  microphone PCM drives the live waveform instead of leaving it at zero.
- Windows builds now bundle the MiniLM ONNX embedding model and tokenizer instead of attempting a
  first-run download.

## 0.2.0-alpha.5 - 2026-07-22

This prerelease stabilizes application-aware capture and makes large Memory sessions responsive
while ensuring continuous audio completes speaker identity work first.

### Changed

- Dynamic application-audio selection is sticky, process-affine, and debounced to prevent rapid
  capture-generation churn when several equal-priority applications are audible.
- Microphone and mixed-system tracks run diarization before application tracks; application shards
  under three seconds are retired instead of repeatedly entering the high-accuracy speaker queue.
- SELF and anonymous-person resolution advances as soon as continuous primary tracks complete, then
  incorporates application-track evidence in a later immutable revision.
- Memory uses a virtualized session list, paged source evidence, progressive transcript rendering,
  and a compact five-second processing poll instead of repeatedly loading the full timeline.
- Source lanes and transcript rows show normalized application names, and bounded native capture
  failure codes remain available in processing details.
- The installed AI model pack and hybrid diarization policy now share one version source.

### Database

- Database target advanced to v37. Existing short application diarization jobs are safely
  superseded, continuous-track priorities are repaired, and application recovery lookups are
  indexed without deleting historical recordings.

## 0.2.0-alpha.4 - 2026-07-22

This prerelease makes the preinstalled high-accuracy speaker models deliverable through one
Windows setup entry without forcing the 5+ GiB model tree into NSIS's 32-bit archive process.

### Added

- A separately updateable `Jarvis AI Model Pack` sibling archive generated by a pinned 7-Zip
  build dependency and published next to Setup.
- Installer-time SHA-512 verification followed by Jarvis's existing per-file SHA-256 verification
  and atomic adoption under the configured non-system data root.
- Manifest-whitelisted archiving so Python caches or other post-validation files cannot enter the
  release component.

### Changed

- Windows packaging now emits one assisted Setup plus its required model component instead of a
  multi-gigabyte embedded NSIS executable and a model-less portable target.
- NSIS is pinned to the current 3.12 toolset, avoiding the large-memory-map failure in legacy
  32-bit packaging.
- Application version advanced to `0.2.0-alpha.4`.

## 0.2.0-alpha.3 - 2026-07-21

This prerelease adds the high-accuracy, offline, post-recording speaker pipeline and safe
historical reprocessing foundation.

### Added

- GPU-idle pyannote Community-1 final diarization with a second local diarizer for conservative
  speaker-count consensus.
- MossFormer2 overlap-window review that protects long-term voice profiles from mixed speech.
- Five-minute on-demand model lifetime, exact selected-GPU binding, real CUDA inference checks,
  and immediate release when the active GPU changes.
- A separately versioned, per-file SHA-256 verified offline AI model component that is adopted
  atomically under `JARVIS_DATA_ROOT` and never installed on the Windows system drive.
- Local-only historical backfill for every retained completed session, including sessions that
  never had legacy speaker results.
- Memory speaker-processing detail showing final speaker count, SELF status, anonymous people,
  overlap review, CUDA state, and a paid-summary-refresh action when evidence changed.

### Changed

- Historical reprocessing reuses paid summaries and does not enqueue MiniMax analysis or daily
  review. A refresh is recommended only when durable speaker evidence materially changes.
- Overlapped turns remain transcribed but are excluded from durable SELF/person centroid learning.
- Windows release preparation now fails closed unless the preinstalled offline model component
  passes a complete digest and dependency verification.
- Database target advanced to v36 and the application version to `0.2.0-alpha.3`.

## 0.2.0-alpha.2 - 2026-07-20

Phase 2 adds private local speaker identity and evidence-gated activity classification.

### Added

- Guided SELF enrollment using three ten-second physical-microphone samples.
- Two isolated 192-dimensional local speaker models: CAM++ Chinese for primary matching and
  ERes2NetV2 Chinese for idle-time review.
- Encrypted local storage for enrollment, cluster, and confirmed-person voice embeddings.
- Cross-session anonymous people linkage that requires both models to agree; names remain
  user-confirmed only.
- Strict speaker-learning gates: SELF learns only from exact physical-microphone evidence, while
  mixed system audio, overlap, echo, and unsafe application evidence never update SELF.
- Eight-category local activity classification with conservative 80%/55% decision thresholds.
- Optional MiniMax semantic review using normalized application names, anonymous speaker labels,
  transcript text, and non-biometric statistics only.
- Durable schema v34 history for dual-model evidence and activity classifications.
- A safe renderer IPC projection for classifications that excludes paths, titles, hashes, names,
  raw audio, and voice embeddings.

### Changed

- Activity classification shares the existing durable MiniMax hard-budget ledger.
- Finished sessions schedule classification in the background without blocking safe audio
  finalization.
- The main-process test command now excludes renderer-only TypeScript suites and helper fixtures.

### Version governance

- Added a local and GitHub version gate that requires `package.json`, `package-lock.json`, the
  Jarvis changelog, and `jarvis-v*` Git tags to agree.
- Added automatic immutable draft GitHub Releases for verified Jarvis tags.

### Verification

- Main-process, database, privacy, native-helper, and three-hour virtual soak tests: 1,922 passed,
  0 failed, 3 skipped by design.
- Renderer tests: 329 passed, 0 failed.
- ESLint, TypeScript typecheck, locale-key consistency, and production renderer build passed.
- App version: `0.2.0-alpha.2`; database target: `v34`.

### Conservative release state

- Automatic long-term speaker association remains candidate-only until a private held-out
  evaluation demonstrates at least 95% precision and no more than 5% false-positive rate for both
  model spaces. Manual confirmation and naming are fully available.

## 0.2.0-alpha.1 - 2026-07-20

Phase 1 establishes the application-source and durable evidence foundation for the personal agent.

### Added

- Native Windows audio-session discovery and process-specific loopback capture.
- A bounded dynamic application-audio pool: four tracks by default, configurable from one to
  eight, reduced to two during full-screen games.
- Conservative mixed-system fallback with explicit degraded intervals and recovery points; unknown
  source is retained without guessing an application.
- Durable application tracks and attribution intervals in database schema v32.
- Cross-track duplicate lineage, application-source public projections, coverage reporting, and
  database-enforced evidence direction in schema v33.
- Resource settings for enabling app-aware audio and choosing the simultaneous track limit.

### Fixed

- Reinstalled analysis-manifest immutability triggers after the v33 transcript-table rebuild.
- Required a fresh migration destination when a live SQLite source changes after an interrupted
  data-directory migration.
- Kept resource-priority controls usable when app-audio discovery is temporarily unavailable or an
  older main process is still running.
- Prevented mixed-system fallback evidence from persisting a guessed application key.

### Verification

- Main-process, database, native-helper, migration, and three-hour virtual soak tests:
  1,860 passed, 0 failed, 3 skipped by design.
- Renderer tests: 329 passed, 0 failed.
- TypeScript typecheck, locale-key consistency, and production renderer build passed.
- App version: `0.2.0-alpha.1`; database target: `v33`.
- Git commit and GitHub release: pending creation of a user-owned `origin`; never push this branch
  to the upstream `openwhispr` remote.

## 0.1.0 - 2026-07-17

- Established the Windows desktop Jarvis MVP baseline.
- Added durable microphone/system recording, final transcription, memory, MiniMax analysis,
  resource governance, CUDA verification, and Phase 4 release acceptance evidence.
