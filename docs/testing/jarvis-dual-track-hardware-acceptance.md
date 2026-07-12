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
| Full Jarvis, typecheck, lint, i18n, and renderer build gates | `PASS` | Fresh Task 8.1 verification ran `npm run test:jarvis`, `npm run typecheck`, `npm run lint`, `npm run i18n:check`, and `npm run build:renderer`; each exited 0. Node reported 382 passed/1 Windows symlink skip; renderer reported 180 passed |

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

## Observed result

`PARTIAL` - deterministic automated tests exercised real repository transactions, WAV evidence
writers, capture-mode persistence, dual-source lifecycle transitions, microphone replacement ordering,
durable interruption recording, sidecar reconciliation, startup recovery, and simulated same-session
renderer/main-managed system-source recovery. No physical Shure MV7, real Windows helper interruption,
output-device change, force-close acceptance run, or two-hour soak was observed in this implementation
turn.

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
