# Jarvis Dual-Track Windows Hardware Acceptance

This record separates deterministic automated evidence from physical Windows hardware evidence.
Automated simulation does not approve a physical device, driver, helper, or two-hour soak.

## Environment

| Field | Recorded value |
| --- | --- |
| Date and time | `NOT RUN` - record the local start and end time of the physical gate |
| App commit and build | `NOT RUN` - record the installed build commit and artifact name |
| Windows version | `NOT RUN` - record edition, version, and OS build |
| GPU | `NOT RUN` - record model and driver version |
| Input device | `NOT RUN` - required release target: Shure MV7; record the exact Windows label |
| Output device | `NOT RUN` - record the exact Windows playback-device label |
| System-audio helper/provider | `NOT RUN` - record WASAPI Loopback or the actual fallback provider and version |
| Tester | `NOT RUN` - record tester name or initials |

## Automated evidence

| Evidence | Result | Notes |
| --- | --- | --- |
| Real SQLite/WAV dual-track interruption and restart integration | `PASS` | `node --test test/jarvis/DualTrackRecovery.test.js test/jarvis/meetingPipelineIntegration.test.js`; both source-failure orders passed in the Task 8 working tree |
| Exact mic/system PCM routed through the production evidence-first function | `PASS` | The focused integration gate verifies persisted bytes, source identity, and persist-before-derived ordering |
| Capture-mode production entry and persistence | `PASS` | Focused controller/repository tests verify mic-only, system-only, and dual modes reach capture startup and SQLite unchanged; system-only persists no microphone device ID |
| Crash-window WAV sidecar reconciliation | `PASS` | Startup recovery validates controlled direct-child sidecars, commits missing chunk/job rows transactionally, removes only reconciled sidecars, retains invalid/conflicting evidence for inspection, and is idempotent |
| Source lifecycle IPC, start isolation, and recovery ordering | `PASS` | Strict IPC/preload tests plus renderer lifecycle tests verify one interruption, indefinite physical-microphone retry, durable restoration before replacement PCM, stale-callback suppression, renderer loopback attachment retry, stop-invalidated candidates, and post-worklet liveness checks that prevent dead candidates from being published |
| Same-session system-source recovery | `PASS` | Task 8.1 automated tests cover renderer loopback re-acquisition and main-managed WASAPI restart, restoration-before-first-replacement-PCM ordering, uninterrupted microphone ingress, bounded pre-restoration buffering, visible overflow, delivery-failure retry, and scheduled/in-flight cancellation on stop or input-generation replacement |
| Localized capture controls | `PASS` | Focused renderer tests passed for exact Simplified Chinese accessible labels and natural English labels |
| Locale key and placeholder alignment | `PASS` | `npm run i18n:check` passed; English and Simplified Chinese are translated, while the other aligned locale additions are explicit English fallbacks pending native translation |
| Full Jarvis, typecheck, lint, i18n, and renderer build gates | `PASS` | Fresh Task 12 verification ran `npm run test:jarvis`, `npm run typecheck`, `npm run lint`, `npm run i18n:check`, and `npm run build:renderer`; each exited 0. Node reported 630 passed/2 Windows capability skips; renderer reported 197 passed. |
| Deterministic three-hour all-day durability simulation | `PASS` | `npm run test:jarvis:capture-soak` exited 0 on 2026-07-14. One test advanced exactly 3 virtual hours through the production capture service in 24.96 seconds and reported 18% speech duty, 12 independent source failures, 224 verified chunks, 448 durable jobs, 192,000-byte peak/expected dual-source ring storage, a 48,000-byte peak VAD queue, zero corrupt or orphaned chunks, one peak safe-delete helper process, and zero helper-process leftovers. It also asserts exact 2-second pre-roll/3-second post-roll, a merged speech range across a 3-second gap, VAD fail-open and recovery, continuous-mode quiet PCM, accepted pending PCM committed at low disk, interrupted-FLAC restart recovery, interrupted migration restart, and seven-day retention. This is automated evidence only, not a physical or wall-clock soak. |

## Manual procedure

Do not perform device disconnects or Windows routing changes without the tester coordinating the
physical action. Capture the session ID and timestamps without copying transcript or audio content
into this document.

| Step | Procedure | Observed result | Pass/Fail | Blockers |
| --- | --- | --- | --- | --- |
| 1 | Select the Shure MV7, select **Microphone and computer audio**, and start one Jarvis session. | `NOT RUN` | `NOT RUN` | Requires the physical Shure MV7 and an installed Task 8 build. |
| 2 | Play browser audio. Verify the MIC and PC status indicators and meters respond independently; verify both evidence tracks remain in the same session. | `NOT RUN` | `NOT RUN` | Requires audible browser playback and inspection of the running app. |
| 3 | Disconnect and reconnect the microphone twice. During each gap, verify PC capture continues. Verify Sonar, VoiceMeeter, Steam, and YY virtual inputs are never auto-selected. | `NOT RUN` | `NOT RUN` | Physical disconnect must be coordinated by the tester; no device was disconnected during automated implementation. |
| 4 | Change the active Windows output device while running a Task 8.1 build. If Windows process-loopback PCM remains continuous, verify there is no false PC gap. If the helper actually interrupts, verify one durable PC gap, uninterrupted microphone capture, and same-session PC recovery. | `NOT RUN` | `NOT RUN` | Requires a second playback device and a coordinated Windows routing change. Continuous process-loopback behavior may be valid and must not be forced into a synthetic gap. |
| 5 | Keep meaningful dual capture running for two continuous hours. Verify each committed chunk has exactly one durable transcription job and no source queue or handle grows without bound. | `NOT RUN` | `NOT RUN` | Two-hour physical soak has not been performed; it is mandatory for release sign-off. |
| 6 | While recording, force-close the app and reopen it. Verify one recovered session, distinct MIC/PC tracks, all gaps closed, and no committed chunk without a transcription job. Run recovery inspection a second time and verify no duplicate chunks or jobs. | `NOT RUN` | `NOT RUN` | Requires a disposable acceptance session and explicit tester approval to force-close it. |
| 7 | In speech-triggered mode, create a quiet period around a short spoken phrase. Inspect the retained MIC and PC evidence ranges and verify exactly 2 seconds of pre-roll and 3 seconds of post-roll, with longer silence represented by durable level-only gaps. | `NOT RUN` | `NOT RUN` | Requires a running Windows build and inspection of runtime evidence; the automated virtual-time result does not perform this physical capture. |
| 8 | Switch the same session to **Important meeting** continuous mode. Keep both sources quiet, then speak and play PC audio; verify all quiet and active audio remains continuous and MIC/PC never merge. | `NOT RUN` | `NOT RUN` | Requires a running Windows build and observed dual-source evidence. |
| 9 | Make the VAD runtime unavailable while capture is active. Verify the visible state changes to continuous fail-open, both tracks continue durably, and verified VAD recovery returns to the requested mode without losing or duplicating PCM. | `NOT RUN` | `NOT RUN` | Requires a controlled runtime fault in an installed build; no live VAD process was interrupted during automated implementation. |
| 10 | Reduce free space through the configured stop threshold while useful PCM is pending. Verify the emergency reserve is released once, the current legal chunks commit, capture pauses with `capture_stopped_low_disk`, and later PCM is rejected until recovery. | `NOT RUN` | `NOT RUN` | Requires a disposable local volume or safe quota harness and coordinated disk manipulation; no physical disk was filled. |
| 11 | Interrupt FLAC conversion after the final rename and before authority promotion, then restart. Verify WAV remains authoritative before restart, startup verifies and promotes FLAC, and no `.partial`, duplicate authority, or helper process remains. | `NOT RUN` | `NOT RUN` | Requires a fault-enabled installed build and restart; the automated test used a deterministic lossless codec boundary, not the physical FFmpeg runtime. |
| 12 | Start a local data-directory migration, interrupt it after verified copies exist, restart the app, and resume. Verify checksums before root activation, the reopened database uses only the new local root, the old root remains available for explicit deletion, and no directory-lease helper remains. | `NOT RUN` | `NOT RUN` | Requires two approved local directories, a restart, and inspection of the configured root. |
| 13 | At the seven-day boundary, verify pending final-transcription jobs first become `retention_urgent`; at expiry verify WAV/FLAC bytes are removed, chunk metadata is tombstoned, and every unfinished audio-dependent job ends as `audio_expired_before_processing`. | `NOT RUN` | `NOT RUN` | Requires time-controlled runtime acceptance or seven elapsed days with disposable evidence; no live seven-day wait was performed. |

## Observed result

`PARTIAL` - deterministic automated tests exercised real repository transactions, WAV evidence
writers, capture-mode persistence, dual-source lifecycle transitions, microphone replacement ordering,
durable interruption recording, sidecar reconciliation, startup recovery, simulated same-session
renderer/main-managed system-source recovery, and a three-hour virtual-time durability lane through the
production speech gate, capture service, SQLite evidence store, compression recovery, storage governor,
data-root migrator, and retention cleaner. No physical Shure MV7, real Windows helper interruption,
output-device change, force-close acceptance run, wall-clock capture soak, installed-runtime fault,
physical low-disk event, migration restart, or seven-day runtime expiry was observed in this
implementation turn.

## Pass/Fail

**Hardware acceptance: `NOT RUN`.**

The Task 8/8.1 automated gates may pass independently, but the phase is not hardware-approved until
every manual row above records an observed result and `PASS`, including the interrupted-helper branch
when a real interruption occurs and the full two-hour soak.

## Blockers

- A tester must provide and select the physical Shure MV7 and a Windows playback device.
- The tester must coordinate two microphone disconnect/reconnect cycles and one output-device change.
- The installed artifact and helper/provider version must be recorded before the run.
- The two-hour release soak and force-close/reopen check remain pending.
- The speech-triggered, important-meeting, VAD, low-disk, FLAC-restart, migration-restart, and seven-day
  runtime rows remain `NOT RUN` until their observed results are recorded against an installed build.
